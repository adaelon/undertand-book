use crate::{
    agent_history_review_cursors, ensure_agent_history_for_book, load_agent_history, load_session,
    mcp::VisitorSessions, route, route_book_asset_file, save_session, select_start_book,
    AgentAssistantStatus, AppState, Req, UnconfiguredAdapter,
};
use base_schema::{LidNode, NodeKind, ReadOnlyBase, Span};
use memory::{MemoryStore, ReviewErrorState, ReviewJobStatus};
use read_tools::Book;
use reader::{Reader, DEFAULT_RADIUS};
use runtime::memory_review::{
    ProviderReviewExecutorFactory, ReviewExecutionOutput, ReviewExecutorFactory, ReviewInput,
    ReviewTurnInput, ReviewTurnStatus,
};
use runtime::{AdapterError, ModelAdapter, ProviderConfig, ProviderRegistry};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Response, Server};

const REVIEW_IDLE_MS: u64 = 60_000;
const REVIEW_TURN_THRESHOLD: u64 = 8;
const REVIEW_RETRY_BASE_MS: u64 = 1_000;
const REVIEW_RETRY_MAX_MS: u64 = 60_000;
const REVIEW_SCHEDULER_POLL_MS: u64 = 250;
const REVIEW_BOUNDARY_TIMEOUT_MS: u64 = 10_000;

pub struct ServerHostConfig {
    pub book_dir: Option<PathBuf>,
    pub library_root: Option<PathBuf>,
    pub addr: String,
    pub web_dist: PathBuf,
}

impl ServerHostConfig {
    pub fn from_env(book_dir: impl Into<PathBuf>) -> Self {
        Self {
            book_dir: Some(book_dir.into()),
            library_root: None,
            addr: std::env::var("UNDERSTAND_BOOK_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into()),
            web_dist: std::env::var("UNDERSTAND_BOOK_WEB_DIST")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("packages").join("web").join("dist")),
        }
    }

    pub fn desktop(library_root: PathBuf, web_dist: PathBuf) -> Self {
        Self {
            book_dir: None,
            library_root: Some(library_root),
            addr: "127.0.0.1:0".into(),
            web_dist,
        }
    }
}

pub struct RunningServer {
    pub url: String,
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    state: Arc<Mutex<AppState>>,
    review_coordinator: Arc<ReviewCoordinator>,
}

pub struct ReviewRunOutcome {
    pub job_id: String,
    pub output: ReviewExecutionOutput,
}

struct ReviewCoordinator {
    state: Arc<Mutex<AppState>>,
    provider_config: Mutex<Option<ProviderConfig>>,
    factory: Arc<dyn ReviewExecutorFactory>,
    serial_gate: Mutex<()>,
    clock: Arc<dyn ReviewClock>,
    schedule: Mutex<ReviewSchedule>,
    wake: Condvar,
}

trait ReviewClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

struct SystemReviewClock;

impl ReviewClock for SystemReviewClock {
    fn now_millis(&self) -> u64 {
        system_now_millis()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewTrigger {
    Startup,
    TurnThreshold,
    Idle,
    Retry,
}

#[derive(Debug, Default)]
struct ReviewSchedule {
    last_resident_activity_ms: Option<u64>,
    force_after_turn: bool,
    startup_requested: bool,
}

impl ReviewSchedule {
    fn note_resident_activity(&mut self, now_ms: u64, unreviewed_turns: u64) {
        self.last_resident_activity_ms = Some(now_ms);
        self.force_after_turn |= unreviewed_turns >= REVIEW_TURN_THRESHOLD;
    }

    fn request_startup(&mut self) {
        self.startup_requested = true;
    }

    fn take_trigger(
        &mut self,
        now_ms: u64,
        has_ready_job: bool,
        has_due_retry: bool,
    ) -> Option<ReviewTrigger> {
        if !has_ready_job {
            return None;
        }
        if self.startup_requested {
            self.startup_requested = false;
            return Some(ReviewTrigger::Startup);
        }
        if self.force_after_turn {
            self.force_after_turn = false;
            return Some(ReviewTrigger::TurnThreshold);
        }
        if has_due_retry {
            return Some(ReviewTrigger::Retry);
        }
        self.last_resident_activity_ms
            .is_some_and(|last| now_ms.saturating_sub(last) >= REVIEW_IDLE_MS)
            .then_some(ReviewTrigger::Idle)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewDrainStatus {
    Drained,
    TimedOut,
}

enum BoundaryWaitResult<T> {
    Completed(T),
    TimedOut,
    Disconnected,
}

trait BoundaryWaiter {
    fn wait<T>(&self, receiver: Receiver<T>, timeout: Duration) -> BoundaryWaitResult<T>;
}

struct SystemBoundaryWaiter;

impl BoundaryWaiter for SystemBoundaryWaiter {
    fn wait<T>(&self, receiver: Receiver<T>, timeout: Duration) -> BoundaryWaitResult<T> {
        match receiver.recv_timeout(timeout) {
            Ok(value) => BoundaryWaitResult::Completed(value),
            Err(RecvTimeoutError::Timeout) => BoundaryWaitResult::TimedOut,
            Err(RecvTimeoutError::Disconnected) => BoundaryWaitResult::Disconnected,
        }
    }
}

impl ReviewCoordinator {
    fn new(
        state: Arc<Mutex<AppState>>,
        provider_config: Option<ProviderConfig>,
        factory: Arc<dyn ReviewExecutorFactory>,
    ) -> Self {
        Self::new_with_clock(state, provider_config, factory, Arc::new(SystemReviewClock))
    }

    fn new_with_clock(
        state: Arc<Mutex<AppState>>,
        provider_config: Option<ProviderConfig>,
        factory: Arc<dyn ReviewExecutorFactory>,
        clock: Arc<dyn ReviewClock>,
    ) -> Self {
        Self {
            state,
            provider_config: Mutex::new(provider_config),
            factory,
            serial_gate: Mutex::new(()),
            clock,
            schedule: Mutex::new(ReviewSchedule::default()),
            wake: Condvar::new(),
        }
    }

    fn set_provider_config(&self, config: ProviderConfig) {
        *self
            .provider_config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(config);
        self.wake.notify_all();
    }

    fn run_one(&self, now: &str) -> Result<Option<ReviewRunOutcome>, read_tools::ToolError> {
        self.run_one_at(ReviewMoment {
            millis: now.parse().unwrap_or(0),
            timestamp: now.into(),
        })
    }

    fn request_startup_run(&self) {
        self.schedule
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .request_startup();
        self.wake.notify_all();
    }

    fn note_resident_activity(&self) {
        let unreviewed_turns = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            max_unreviewed_turns(&state)
        };
        if unreviewed_turns == 0 {
            return;
        }
        self.schedule
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .note_resident_activity(self.clock.now_millis(), unreviewed_turns);
        self.wake.notify_all();
    }

    fn scheduler_tick(&self) -> Result<usize, read_tools::ToolError> {
        let now_ms = self.clock.now_millis();
        let (has_ready_job, has_due_retry) = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            ready_review_summary(&state, now_ms)
        };
        let trigger = self
            .schedule
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take_trigger(now_ms, has_ready_job, has_due_retry);
        if trigger.is_none() {
            return Ok(0);
        }
        self.run_due_reviews(ReviewMoment::from_millis(now_ms))
    }

    fn wait_for_schedule_signal(&self, timeout: Duration) {
        let schedule = self
            .schedule
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self
            .wake
            .wait_timeout(schedule, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }

    fn run_due_reviews(&self, moment: ReviewMoment) -> Result<usize, read_tools::ToolError> {
        let mut completed = 0;
        let mut first_error = None;
        loop {
            let ready_before = self.ready_review_count(moment.millis);
            if ready_before == 0 {
                break;
            }
            match self.run_one_at(moment.clone()) {
                Ok(Some(_)) => completed += 1,
                Ok(None) => break,
                Err(error) => {
                    first_error.get_or_insert(error);
                    if self.ready_review_count(moment.millis) >= ready_before {
                        break;
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(completed),
        }
    }

    fn ready_review_count(&self, now_ms: u64) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .store
            .review_state()
            .review_jobs
            .iter()
            .filter(|job| review_job_is_ready(job, now_ms))
            .count()
    }

    fn drain_boundary(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<ReviewDrainStatus, read_tools::ToolError> {
        self.drain_boundary_with_waiter(timeout, &SystemBoundaryWaiter)
    }

    fn drain_boundary_with_waiter<W: BoundaryWaiter>(
        self: &Arc<Self>,
        timeout: Duration,
        waiter: &W,
    ) -> Result<ReviewDrainStatus, read_tools::ToolError> {
        let now_ms = self.clock.now_millis();
        let moment = ReviewMoment::from_millis(now_ms);
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let cursors = agent_history_review_cursors(&state.agent_history);
            state
                .store
                .reconcile_review_jobs(&cursors, &moment.timestamp)?;
        }
        let (sender, receiver) = mpsc::channel();
        let coordinator = self.clone();
        thread::spawn(move || {
            let _ = sender.send(coordinator.run_due_reviews(moment));
        });
        match waiter.wait(receiver, timeout) {
            BoundaryWaitResult::Completed(Ok(_)) => Ok(ReviewDrainStatus::Drained),
            BoundaryWaitResult::Completed(Err(error)) => Err(error),
            BoundaryWaitResult::TimedOut => {
                self.record_review_error(
                    "REVIEW_DRAIN_TIMEOUT",
                    "review drain exceeded the boundary time budget",
                    now_ms,
                )?;
                Ok(ReviewDrainStatus::TimedOut)
            }
            BoundaryWaitResult::Disconnected => {
                let error = review_error(
                    "REVIEW_DRAIN_WORKER_FAILED",
                    "review drain worker disconnected before reporting a result",
                );
                self.record_review_error(&error.error_code, &error.message, now_ms)?;
                Err(error)
            }
        }
    }

    fn record_review_error(
        &self,
        error_code: &str,
        message: &str,
        now_ms: u64,
    ) -> Result<(), read_tools::ToolError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.store.record_review_error(ReviewErrorState {
            error_code: error_code.into(),
            message: message.into(),
            occurred_at: now_ms.to_string(),
        })
    }

    fn run_one_at(
        &self,
        moment: ReviewMoment,
    ) -> Result<Option<ReviewRunOutcome>, read_tools::ToolError> {
        let _serial = self
            .serial_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let config = self
            .provider_config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        let (job_id, input, claimed) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(job_id) = state
                .store
                .review_state()
                .review_jobs
                .iter()
                .find(|job| review_job_is_ready(job, moment.millis))
                .map(|job| job.job_id.clone())
            else {
                return Ok(None);
            };
            let claimed = state.store.claim_review_job(&job_id, &moment.timestamp)?;
            if config.is_none() {
                let error = review_error(
                    "REVIEW_PROVIDER_UNCONFIGURED",
                    "review provider is not configured",
                );
                mark_review_retryable(&mut state.store, &claimed, &error, &moment)?;
                return Err(error);
            }
            let input = match copy_review_input(&state, &claimed) {
                Ok(input) => input,
                Err(error) => {
                    mark_review_retryable(&mut state.store, &claimed, &error, &moment)?;
                    return Err(error);
                }
            };
            (job_id, input, claimed)
        };

        let config = config.expect("checked before claim");
        let mut executor = self.factory.create(&config);
        let execution = executor.execute(&input);

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match execution {
            Ok(output) => {
                let eligible_turn_ids: Vec<String> = input
                    .turns
                    .iter()
                    .map(|turn| turn.turn_id.clone())
                    .collect();
                if let Err(error) = state.store.commit_review_result(
                    &job_id,
                    &eligible_turn_ids,
                    &output.fact_candidates,
                    &output.intent_observations,
                    &moment.timestamp,
                ) {
                    mark_review_retryable(&mut state.store, &claimed, &error, &moment)?;
                    return Err(error);
                }
                Ok(Some(ReviewRunOutcome { job_id, output }))
            }
            Err(error) => {
                let provider_error = review_provider_error(error);
                mark_review_retryable(&mut state.store, &claimed, &provider_error, &moment)?;
                Err(provider_error)
            }
        }
    }
}

#[derive(Clone)]
struct ReviewMoment {
    millis: u64,
    timestamp: String,
}

impl ReviewMoment {
    fn from_millis(millis: u64) -> Self {
        Self {
            millis,
            timestamp: millis.to_string(),
        }
    }
}

fn max_unreviewed_turns(state: &AppState) -> u64 {
    state
        .agent_history
        .sessions
        .iter()
        .filter_map(|session| {
            let latest = session.turns.last().map(|turn| turn.user_turn_ordinal)?;
            let watermark = state
                .store
                .review_state()
                .reviewed_through
                .get(&session.id)
                .copied()
                .unwrap_or(0);
            Some(latest.saturating_sub(watermark))
        })
        .max()
        .unwrap_or(0)
}

fn ready_review_summary(state: &AppState, now_ms: u64) -> (bool, bool) {
    let mut has_ready_job = false;
    let mut has_due_retry = false;
    for job in &state.store.review_state().review_jobs {
        if review_job_is_ready(job, now_ms) {
            has_ready_job = true;
            has_due_retry |= job.status == ReviewJobStatus::Retryable;
        }
    }
    (has_ready_job, has_due_retry)
}

fn review_job_is_ready(job: &memory::ReviewJob, now_ms: u64) -> bool {
    match job.status {
        ReviewJobStatus::Queued => true,
        ReviewJobStatus::Retryable => job
            .next_attempt_at
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .is_none_or(|next_attempt_ms| next_attempt_ms <= now_ms),
        ReviewJobStatus::Running | ReviewJobStatus::Completed => false,
    }
}

fn retry_delay_ms(attempts: u32) -> u64 {
    let shift = attempts.saturating_sub(1).min(16);
    REVIEW_RETRY_BASE_MS
        .saturating_mul(1_u64 << shift)
        .min(REVIEW_RETRY_MAX_MS)
}

fn mark_review_retryable(
    store: &mut MemoryStore,
    job: &memory::ReviewJob,
    error: &read_tools::ToolError,
    moment: &ReviewMoment,
) -> Result<(), read_tools::ToolError> {
    let next_attempt_at = moment
        .millis
        .saturating_add(retry_delay_ms(job.attempts))
        .to_string();
    store.mark_review_job_retryable(
        &job.job_id,
        &next_attempt_at,
        ReviewErrorState {
            error_code: error.error_code.clone(),
            message: error.message.clone(),
            occurred_at: moment.timestamp.clone(),
        },
        &moment.timestamp,
    )?;
    Ok(())
}

fn copy_review_input(
    state: &AppState,
    job: &memory::ReviewJob,
) -> Result<ReviewInput, read_tools::ToolError> {
    let session = state
        .agent_history
        .sessions
        .iter()
        .find(|session| session.id == job.session_id && session.book_id == job.book_id)
        .ok_or_else(|| review_error("REVIEW_INPUT_MISSING", "review session does not exist"))?;
    let turns: Vec<ReviewTurnInput> = session
        .turns
        .iter()
        .filter(|turn| {
            turn.user_turn_ordinal > job.from_turn_exclusive
                && turn.user_turn_ordinal <= job.to_turn_inclusive
        })
        .map(|turn| ReviewTurnInput {
            turn_id: turn.turn_id.clone(),
            user_turn_ordinal: turn.user_turn_ordinal,
            user: turn.user.clone(),
            assistant_status: match turn.status {
                AgentAssistantStatus::PendingAssistant => ReviewTurnStatus::PendingAssistant,
                AgentAssistantStatus::Completed => ReviewTurnStatus::Completed,
                AgentAssistantStatus::Failed => ReviewTurnStatus::Failed,
            },
            assistant_answer: turn
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.answer.clone()),
        })
        .collect();
    let expected_len = job.to_turn_inclusive - job.from_turn_exclusive;
    if u64::try_from(turns.len()).ok() != Some(expected_len)
        || turns.iter().enumerate().any(|(index, turn)| {
            u64::try_from(index)
                .ok()
                .and_then(|index| job.from_turn_exclusive.checked_add(index + 1))
                != Some(turn.user_turn_ordinal)
        })
    {
        return Err(review_error(
            "REVIEW_INPUT_GAP",
            "review job turn range is not contiguous in AgentHistory",
        ));
    }
    Ok(ReviewInput {
        job_id: job.job_id.clone(),
        session_id: job.session_id.clone(),
        book_id: job.book_id.clone(),
        content_profile: crate::current_content_profile(&state.book).into(),
        from_turn_exclusive: job.from_turn_exclusive,
        to_turn_inclusive: job.to_turn_inclusive,
        turns,
    })
}

fn review_error(code: &str, message: impl Into<String>) -> read_tools::ToolError {
    read_tools::ToolError {
        error_code: code.into(),
        category: "internal".into(),
        message: message.into(),
    }
}

fn review_provider_error(error: AdapterError) -> read_tools::ToolError {
    read_tools::ToolError {
        error_code: "REVIEW_EXECUTOR_FAILED".into(),
        category: "provider".into(),
        message: error.message,
    }
}

impl RunningServer {
    pub fn set_library_root(&self, library_root: PathBuf) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.library_root = Some(library_root);
    }

    pub fn library_root(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .library_root
            .clone()
    }

    pub fn set_provider_config(&self, config: ProviderConfig) {
        self.review_coordinator.set_provider_config(config.clone());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.adapter = ProviderRegistry::adapter_from_config(config);
    }

    pub fn run_one_review(
        &self,
        now: &str,
    ) -> Result<Option<ReviewRunOutcome>, read_tools::ToolError> {
        self.review_coordinator.run_one(now)
    }

    pub fn drain_review_boundary(&self, timeout: Duration) -> Result<bool, read_tools::ToolError> {
        self.review_coordinator
            .drain_boundary(timeout)
            .map(|status| status == ReviewDrainStatus::Drained)
    }

    pub fn wait(mut self) {
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
        self.review_coordinator.wake.notify_all();
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

pub fn start_server(config: ServerHostConfig) -> Result<RunningServer, String> {
    let session_path = MemoryStore::default_path()
        .parent()
        .map(|p| p.join("session.json"));
    let history_path = MemoryStore::default_path()
        .parent()
        .map(|p| p.join("agent-history.json"));
    let session = load_session(&session_path);
    let (dir, book, saved_top) = match config.book_dir {
        Some(book_dir) => {
            let requested = book_dir.to_string_lossy().into_owned();
            let (dir, saved_top) = select_start_book(requested, session.as_ref());
            let book =
                Book::load(&dir).map_err(|error| format!("failed to load book {dir}: {error}"))?;
            (dir, book, saved_top)
        }
        None => {
            if let Some(saved) = session
                .as_ref()
                .filter(|saved| Path::new(&saved.current_book_dir).is_dir())
            {
                if let Ok(book) = Book::load(&saved.current_book_dir) {
                    let dir = saved.current_book_dir.clone();
                    let top = saved.top_lid_for_dir(&dir).map(str::to_string);
                    (dir, book, top)
                } else {
                    bootstrap_book(config.library_root.as_deref())?
                }
            } else {
                bootstrap_book(config.library_root.as_deref())?
            }
        }
    };
    let mut store = MemoryStore::open(MemoryStore::default_path())
        .map_err(|error| format!("failed to open memory store: {}", error.message))?;
    let mut reader = Reader::new(&book, DEFAULT_RADIUS);
    if let Some(top) = saved_top {
        reader.restore_top_lid(&book, &top);
    }
    crate::restore_saved_paper_minimap_overlay(&mut reader, &book, &session_path)
        .map_err(|error| format!("failed to restore paper minimap overlay: {}", error.message))?;
    let provider_config = ProviderConfig::from_env().ok();
    let adapter: Box<dyn ModelAdapter + Send> = provider_config
        .clone()
        .map(ProviderRegistry::adapter_from_config)
        .unwrap_or_else(|| Box::new(UnconfiguredAdapter));
    let mut agent_history = load_agent_history(&history_path);
    let messages =
        ensure_agent_history_for_book(&mut agent_history, &book.base.book_id, "server-start");
    let startup_now = now_ts();
    store
        .resume_review_jobs(&agent_history_review_cursors(&agent_history), &startup_now)
        .map_err(|error| format!("failed to resume memory review jobs: {}", error.message))?;
    let startup_review_pending = store
        .review_state()
        .review_jobs
        .iter()
        .any(|job| job.status != ReviewJobStatus::Completed);
    let state = Arc::new(Mutex::new(AppState {
        book_dir: PathBuf::from(&dir),
        library_root: config.library_root.clone(),
        book,
        reader,
        store,
        adapter,
        messages,
        session_path,
        history_path,
        agent_history,
        profile_context_cache: runtime::profile_context::ProfileContextCache::default(),
        visitor_sessions: VisitorSessions::default(),
        workbench_loaded_revision: None,
    }));
    let review_coordinator = Arc::new(ReviewCoordinator::new(
        state.clone(),
        provider_config,
        Arc::new(ProviderReviewExecutorFactory),
    ));
    if startup_review_pending {
        review_coordinator.request_startup_run();
    }
    {
        let guard = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !is_bootstrap_dir(&guard.book_dir) {
            let _ = save_session(&guard, Some(dir.as_str()));
        }
    }

    let server = Arc::new(
        Server::http(&config.addr)
            .map_err(|error| format!("failed to bind {}: {error}", config.addr))?,
    );
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "server did not bind an IP address".to_string())?;
    let url = format!("http://{address}");
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    {
        let coordinator = review_coordinator.clone();
        let stop_signal = stop.clone();
        handles.push(thread::spawn(move || {
            while !stop_signal.load(Ordering::Acquire) {
                let _ = coordinator.scheduler_tick();
                coordinator
                    .wait_for_schedule_signal(Duration::from_millis(REVIEW_SCHEDULER_POLL_MS));
            }
        }));
    }
    let boundary_timeout = review_boundary_timeout();
    for _ in 0..4 {
        let server = server.clone();
        let state = state.clone();
        let review_coordinator = review_coordinator.clone();
        let dist = config.web_dist.clone();
        let stop_signal = stop.clone();
        handles.push(thread::spawn(move || {
            while !stop_signal.load(Ordering::Acquire) {
                let Ok(request) = server.recv_timeout(Duration::from_millis(100)) else {
                    break;
                };
                let Some(mut request) = request else { continue };
                let method = request.method().to_string();
                let url = request.url().to_string();
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let response = match static_response(&dist, &method, &url) {
                    Some(reply) => response_from_static(reply),
                    None => {
                        let api_url = normalize_api_url(&url);
                        let request_now = now_ts();
                        if is_review_boundary(&method, &api_url) {
                            let _ = review_coordinator.drain_boundary(boundary_timeout);
                        }
                        if method == "GET" {
                            let asset = {
                                let guard = state
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                route_book_asset_file(&guard.book_dir, &api_url)
                            };
                            if let Some(reply) = asset {
                                let _ = request.respond(response_from_binary(reply));
                                continue;
                            }
                        }
                        let reply = {
                            let mut guard = state
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            route(
                                &mut guard,
                                Req {
                                    method: &method,
                                    url: &api_url,
                                    body: &body,
                                    now: &request_now,
                                },
                            )
                        };
                        if is_resident_turn_request(&method, &api_url)
                            && !matches!(reply.status, 400 | 405)
                        {
                            review_coordinator.note_resident_activity();
                        }
                        response_from_json(reply.status, reply.body)
                    }
                };
                let _ = request.respond(response);
            }
        }));
    }
    Ok(RunningServer {
        url,
        stop,
        handles,
        state,
        review_coordinator,
    })
}

fn bootstrap_book(library_root: Option<&Path>) -> Result<(String, Book, Option<String>), String> {
    let root = library_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".understand-book"));
    let source = "Select or create a book.";
    let base = ReadOnlyBase {
        book_id: "__desktop_bootstrap__".into(),
        lid_nodes: vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Paragraph,
            span: Span {
                start: 0,
                end: source.encode_utf16().count(),
            },
            children: Vec::new(),
        }],
        graph_nodes: Vec::new(),
        graph_edges: Vec::new(),
    };
    Ok((
        root.join("__desktop_bootstrap__")
            .to_string_lossy()
            .into_owned(),
        Book::new(base, source),
        None,
    ))
}

fn is_bootstrap_dir(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("__desktop_bootstrap__")
}

fn now_ts() -> String {
    system_now_millis().to_string()
}

fn system_now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0) as u64
}

fn review_boundary_timeout() -> Duration {
    let millis = std::env::var("UNDERSTAND_BOOK_REVIEW_DRAIN_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(REVIEW_BOUNDARY_TIMEOUT_MS);
    Duration::from_millis(millis)
}

fn is_review_boundary(method: &str, url: &str) -> bool {
    method == "POST"
        && matches!(
            split_url(url).0,
            "/agent/new"
                | "/agent/history/select"
                | "/book/open"
                | "/book/create"
                | "/build_workbench/input.import"
        )
}

fn is_resident_turn_request(method: &str, url: &str) -> bool {
    method == "POST" && split_url(url).0 == "/agent/chat"
}

struct StaticReply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

fn normalize_api_url(url: &str) -> String {
    let (path, query) = split_url(url);
    path.strip_prefix("/api/")
        .map(|rest| format!("/{rest}{query}"))
        .unwrap_or_else(|| url.to_string())
}

fn is_api_url(url: &str) -> bool {
    let (path, _) = split_url(url);
    let path = path.strip_prefix("/api").unwrap_or(path);
    path.starts_with("/book/")
        || path.starts_with("/reader/")
        || path.starts_with("/memory/")
        || path.starts_with("/agent/")
        || path.starts_with("/profile/")
        || path.starts_with("/desktop/")
}

fn static_response(dist: &Path, method: &str, url: &str) -> Option<StaticReply> {
    if method != "GET" || is_api_url(url) {
        return None;
    }
    let (path, _) = split_url(url);
    let requested = static_path(dist, path)?;
    let file = if requested.is_file() {
        requested
    } else {
        dist.join("index.html")
    };
    Some(match std::fs::read(&file) {
        Ok(body) => StaticReply {
            status: 200,
            content_type: mime_for(&file),
            body,
        },
        Err(_) => StaticReply {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            body: format!("web dist not found: {}", dist.display()).into_bytes(),
        },
    })
}

fn static_path(dist: &Path, path: &str) -> Option<PathBuf> {
    if path.contains('\\') {
        return None;
    }
    let mut out = dist.to_path_buf();
    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." || segment.contains(':') {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

fn split_url(url: &str) -> (&str, &str) {
    url.find('?')
        .map(|index| (&url[..index], &url[index..]))
        .unwrap_or((url, ""))
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn response_from_json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .expect("valid content-type header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn response_from_static(reply: StaticReply) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes())
        .expect("valid content-type header");
    Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(header)
}

fn response_from_binary(reply: crate::BinaryReply) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes())
        .expect("valid content-type header");
    Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentChatSession, AgentChatTurn, AgentHistory, AgentTurnError};
    use memory::{
        Applicability, CreateProfileFact, EvidenceRef, FactSource, PreferenceClaim, ProfilePayload,
        ProfileScope, ProfileStatus, ReviewFactCandidate, ReviewJobStatus, ReviewSessionCursor,
        Sensitivity,
    };
    use runtime::memory_review::{ReviewExecutor, ReviewExecutorFactory};
    use runtime::orchestrator::new_session;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::sync::mpsc;
    use std::sync::Condvar;

    #[derive(Default)]
    struct ExecutorControlState {
        entered: usize,
        active: usize,
        max_active: usize,
        release: bool,
        models: Vec<String>,
    }

    struct ExecutorControl {
        state: Mutex<ExecutorControlState>,
        changed: Condvar,
    }

    struct ControlledFactory {
        control: Arc<ExecutorControl>,
    }

    struct ControlledExecutor {
        model: String,
        control: Arc<ExecutorControl>,
    }

    impl ReviewExecutorFactory for ControlledFactory {
        fn create(&self, config: &ProviderConfig) -> Box<dyn ReviewExecutor> {
            Box::new(ControlledExecutor {
                model: config.model.clone(),
                control: self.control.clone(),
            })
        }
    }

    impl ReviewExecutor for ControlledExecutor {
        fn execute(&mut self, input: &ReviewInput) -> Result<ReviewExecutionOutput, AdapterError> {
            let mut state = self.control.state.lock().unwrap();
            state.entered += 1;
            state.active += 1;
            state.max_active = state.max_active.max(state.active);
            state.models.push(self.model.clone());
            self.control.changed.notify_all();
            while !state.release {
                state = self.control.changed.wait(state).unwrap();
            }
            state.active -= 1;
            self.control.changed.notify_all();
            let fact = ReviewFactCandidate::new(CreateProfileFact {
                scope: ProfileScope::Book {
                    book_id: input.book_id.clone(),
                },
                applicability: Applicability::Any,
                payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                    key: "example_order".into(),
                    value: "worked_examples_first".into(),
                }),
                source: FactSource::UserStated,
                evidence: vec![EvidenceRef::Turn {
                    session_id: input.session_id.clone(),
                    turn_id: input.turns[0].turn_id.clone(),
                }],
                confidence: None,
                sensitivity: Sensitivity::Normal,
                valid_until: None,
            })
            .unwrap();
            Ok(ReviewExecutionOutput {
                fact_candidates: vec![fact],
                intent_observations: Vec::new(),
            })
        }
    }

    #[derive(Default)]
    struct FakeClock {
        now_ms: AtomicU64,
    }

    impl FakeClock {
        fn set(&self, now_ms: u64) {
            self.now_ms.store(now_ms, Ordering::SeqCst);
        }
    }

    impl ReviewClock for FakeClock {
        fn now_millis(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }
    }

    struct ImmediateFactory {
        calls: Arc<AtomicUsize>,
    }

    struct ImmediateExecutor {
        calls: Arc<AtomicUsize>,
    }

    impl ReviewExecutorFactory for ImmediateFactory {
        fn create(&self, _config: &ProviderConfig) -> Box<dyn ReviewExecutor> {
            Box::new(ImmediateExecutor {
                calls: self.calls.clone(),
            })
        }
    }

    impl ReviewExecutor for ImmediateExecutor {
        fn execute(&mut self, _input: &ReviewInput) -> Result<ReviewExecutionOutput, AdapterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ReviewExecutionOutput {
                fact_candidates: Vec::new(),
                intent_observations: Vec::new(),
            })
        }
    }

    struct FailingFactory {
        calls: Arc<AtomicUsize>,
    }

    struct FailingExecutor {
        calls: Arc<AtomicUsize>,
    }

    impl ReviewExecutorFactory for FailingFactory {
        fn create(&self, _config: &ProviderConfig) -> Box<dyn ReviewExecutor> {
            Box::new(FailingExecutor {
                calls: self.calls.clone(),
            })
        }
    }

    impl ReviewExecutor for FailingExecutor {
        fn execute(&mut self, _input: &ReviewInput) -> Result<ReviewExecutionOutput, AdapterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(AdapterError {
                message: "temporary review failure".into(),
            })
        }
    }

    struct EnteredTimeoutWaiter {
        control: Arc<ExecutorControl>,
    }

    impl BoundaryWaiter for EnteredTimeoutWaiter {
        fn wait<T>(&self, receiver: Receiver<T>, _timeout: Duration) -> BoundaryWaitResult<T> {
            let mut state = self.control.state.lock().unwrap();
            while state.entered == 0 {
                state = self.control.changed.wait(state).unwrap();
            }
            drop(state);
            drop(receiver);
            BoundaryWaitResult::TimedOut
        }
    }

    struct CompletingWaiter;

    impl BoundaryWaiter for CompletingWaiter {
        fn wait<T>(&self, receiver: Receiver<T>, _timeout: Duration) -> BoundaryWaitResult<T> {
            match receiver.recv() {
                Ok(value) => BoundaryWaitResult::Completed(value),
                Err(_) => BoundaryWaitResult::Disconnected,
            }
        }
    }

    fn review_provider(model: &str) -> ProviderConfig {
        ProviderConfig::from_values("native", "test-key", "https://example.com", model).unwrap()
    }

    fn review_test_state(name: &str) -> Arc<Mutex<AppState>> {
        review_test_state_with(name, 2, 1)
    }

    fn review_test_state_with(
        name: &str,
        session_count: usize,
        turns_per_session: u64,
    ) -> Arc<Mutex<AppState>> {
        let (dir, book, _) = bootstrap_book(None).unwrap();
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let memory_path = std::env::temp_dir().join(format!("ub-review-host-{name}.json"));
        let _ = std::fs::remove_file(&memory_path);
        let mut store = MemoryStore::open(memory_path).unwrap();
        let cursors: Vec<_> = (0..session_count)
            .map(|index| ReviewSessionCursor {
                session_id: format!("review-session-{index}"),
                book_id: book.base.book_id.clone(),
                latest_user_turn_ordinal: turns_per_session,
            })
            .collect();
        store.reconcile_review_jobs(&cursors, "0").unwrap();
        let sessions = (0..session_count)
            .map(|index| AgentChatSession {
                id: format!("review-session-{index}"),
                book_id: book.base.book_id.clone(),
                title: "review".into(),
                created_at: "0".into(),
                updated_at: "0".into(),
                turns: (1..=turns_per_session)
                    .map(|ordinal| AgentChatTurn {
                        turn_id: format!("turn-review-{index}-{ordinal}"),
                        user_turn_ordinal: ordinal,
                        user: format!("I prefer worked examples {ordinal}"),
                        status: AgentAssistantStatus::Failed,
                        outcome: None,
                        error: Some(AgentTurnError {
                            error_code: "PROVIDER_ERROR".into(),
                            category: "provider".into(),
                            message: "earlier main-agent failure".into(),
                        }),
                        question_anchor_lid: None,
                        question_quote: None,
                    })
                    .collect(),
                messages: new_session(),
            })
            .collect();
        Arc::new(Mutex::new(AppState {
            book_dir: PathBuf::from(dir),
            library_root: None,
            book,
            reader,
            store,
            adapter: Box::new(UnconfiguredAdapter),
            messages: new_session(),
            session_path: None,
            history_path: None,
            agent_history: AgentHistory {
                active_by_book: BTreeMap::from([(
                    "__desktop_bootstrap__".into(),
                    "review-session-0".into(),
                )]),
                sessions,
                pending_memory_ops: BTreeMap::new(),
            },
            profile_context_cache: runtime::profile_context::ProfileContextCache::default(),
            visitor_sessions: VisitorSessions::default(),
            workbench_loaded_revision: None,
        }))
    }

    #[test]
    fn desktop_host_uses_random_loopback_address() {
        let config = ServerHostConfig {
            book_dir: Some(PathBuf::from("book")),
            library_root: None,
            addr: "127.0.0.1:0".into(),
            web_dist: PathBuf::from("dist"),
        };
        assert_eq!(config.addr, "127.0.0.1:0");
    }

    #[test]
    fn api_prefix_is_stripped_before_routing() {
        assert_eq!(
            normalize_api_url("/api/book/text?lid=1.1"),
            "/book/text?lid=1.1"
        );
        assert_eq!(
            normalize_api_url("/book/text?lid=1.1"),
            "/book/text?lid=1.1"
        );
    }

    #[test]
    fn api_paths_are_not_static_fallback_candidates() {
        assert!(is_api_url("/api/book/manifest"));
        assert!(is_api_url("/api/profile/manifest"));
        assert!(!is_api_url("/assets/index.js"));
    }

    #[test]
    fn static_path_rejects_traversal() {
        assert!(static_path(Path::new("dist"), "/assets/app.js").is_some());
        assert!(static_path(Path::new("dist"), "/../Cargo.toml").is_none());
        assert!(static_path(Path::new("dist"), "/a\\b").is_none());
    }

    #[test]
    fn review_executor_releases_app_state_serializes_runs_and_uses_hot_config() {
        let state = review_test_state("lock-and-hot-config");
        let control = Arc::new(ExecutorControl {
            state: Mutex::new(ExecutorControlState::default()),
            changed: Condvar::new(),
        });
        let coordinator = Arc::new(ReviewCoordinator::new(
            state.clone(),
            Some(review_provider("model-a")),
            Arc::new(ControlledFactory {
                control: control.clone(),
            }),
        ));

        let first = {
            let coordinator = coordinator.clone();
            thread::spawn(move || coordinator.run_one("t1"))
        };
        {
            let mut observed = control.state.lock().unwrap();
            while observed.entered < 1 {
                observed = control.changed.wait(observed).unwrap();
            }
        }

        let local_reply = {
            let mut state = state.lock().unwrap();
            route(
                &mut state,
                Req {
                    method: "POST",
                    url: "/reader/state",
                    body: "",
                    now: "t1",
                },
            )
        };
        assert_eq!(local_reply.status, 200);

        coordinator.set_provider_config(review_provider("model-b"));
        let (ready_tx, ready_rx) = mpsc::channel();
        let second = {
            let coordinator = coordinator.clone();
            thread::spawn(move || {
                ready_tx.send(()).unwrap();
                coordinator.run_one("t2")
            })
        };
        ready_rx.recv().unwrap();
        assert_eq!(control.state.lock().unwrap().entered, 1);

        {
            let mut observed = control.state.lock().unwrap();
            observed.release = true;
            control.changed.notify_all();
        }
        let first = first.join().unwrap().unwrap().unwrap();
        let second = second.join().unwrap().unwrap().unwrap();
        assert_ne!(first.job_id, second.job_id);
        assert_eq!(first.output.fact_candidates.len(), 1);
        assert_eq!(second.output.fact_candidates.len(), 1);

        let observed = control.state.lock().unwrap();
        assert_eq!(observed.entered, 2);
        assert_eq!(observed.max_active, 1);
        assert_eq!(observed.models, vec!["model-a", "model-b"]);
        drop(observed);
        let state = state.lock().unwrap();
        assert!(state
            .store
            .review_state()
            .review_jobs
            .iter()
            .all(|job| job.status == ReviewJobStatus::Completed));
        assert_eq!(state.store.review_state().reviewed_through.len(), 2);
        assert!(state.store.review_state().last_error.is_none());
        assert_eq!(state.store.profile_facts().len(), 2);
    }

    #[test]
    fn fake_clock_triggers_idle_review_only_after_sixty_seconds() {
        let state = review_test_state_with("idle-trigger", 1, 1);
        let clock = Arc::new(FakeClock::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let coordinator = ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-idle")),
            Arc::new(ImmediateFactory {
                calls: calls.clone(),
            }),
            clock.clone(),
        );
        clock.set(100);
        coordinator.note_resident_activity();

        clock.set(60_099);
        assert_eq!(coordinator.scheduler_tick().unwrap(), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        clock.set(60_100);
        assert_eq!(coordinator.scheduler_tick().unwrap(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let state = state.lock().unwrap();
        assert_eq!(state.store.review_state().reviewed_through.len(), 1);
        assert_eq!(
            state.store.review_state().reviewed_through["review-session-0"],
            1
        );
    }

    #[test]
    fn fake_clock_forces_review_after_eight_unreviewed_turns() {
        let state = review_test_state_with("turn-threshold", 1, 8);
        let clock = Arc::new(FakeClock::default());
        clock.set(500);
        let calls = Arc::new(AtomicUsize::new(0));
        let coordinator = ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-threshold")),
            Arc::new(ImmediateFactory {
                calls: calls.clone(),
            }),
            clock,
        );

        coordinator.note_resident_activity();
        assert_eq!(coordinator.scheduler_tick().unwrap(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            state.lock().unwrap().store.review_state().reviewed_through["review-session-0"],
            8
        );
    }

    #[test]
    fn retry_backoff_is_durable_and_fake_clock_gated() {
        let state = review_test_state_with("retry-backoff", 1, 1);
        let clock = Arc::new(FakeClock::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let coordinator = ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-retry")),
            Arc::new(FailingFactory {
                calls: calls.clone(),
            }),
            clock.clone(),
        );
        coordinator.request_startup_run();

        assert_eq!(
            coordinator.scheduler_tick().unwrap_err().error_code,
            "REVIEW_EXECUTOR_FAILED"
        );
        {
            let state = state.lock().unwrap();
            let job = &state.store.review_state().review_jobs[0];
            assert_eq!(job.status, ReviewJobStatus::Retryable);
            assert_eq!(job.attempts, 1);
            assert_eq!(job.next_attempt_at.as_deref(), Some("1000"));
            assert_eq!(
                state
                    .store
                    .review_state()
                    .last_error
                    .as_ref()
                    .unwrap()
                    .error_code,
                "REVIEW_EXECUTOR_FAILED"
            );
        }

        clock.set(999);
        assert_eq!(coordinator.scheduler_tick().unwrap(), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        clock.set(1_000);
        assert_eq!(
            coordinator.scheduler_tick().unwrap_err().error_code,
            "REVIEW_EXECUTOR_FAILED"
        );
        let state = state.lock().unwrap();
        let job = &state.store.review_state().review_jobs[0];
        assert_eq!(job.attempts, 2);
        assert_eq!(job.next_attempt_at.as_deref(), Some("3000"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn startup_resume_replays_interrupted_job_once_without_duplicate_fact() {
        let name = "startup-crash-recovery";
        let memory_path = std::env::temp_dir().join(format!("ub-review-host-{name}.json"));
        let state = review_test_state_with(name, 1, 1);
        {
            let mut state = state.lock().unwrap();
            let job_id = state.store.review_state().review_jobs[0].job_id.clone();
            state.store.claim_review_job(&job_id, "10").unwrap();
            state.store = MemoryStore::open(&memory_path).unwrap();
            let cursors = crate::agent_history_review_cursors(&state.agent_history);
            state.store.resume_review_jobs(&cursors, "20").unwrap();
            assert_eq!(
                state.store.review_state().review_jobs[0].status,
                ReviewJobStatus::Queued
            );
        }
        let control = Arc::new(ExecutorControl {
            state: Mutex::new(ExecutorControlState {
                release: true,
                ..Default::default()
            }),
            changed: Condvar::new(),
        });
        let clock = Arc::new(FakeClock::default());
        clock.set(20);
        let coordinator = ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-resume")),
            Arc::new(ControlledFactory { control }),
            clock,
        );
        coordinator.request_startup_run();

        assert_eq!(coordinator.scheduler_tick().unwrap(), 1);
        coordinator.request_startup_run();
        assert_eq!(coordinator.scheduler_tick().unwrap(), 0);

        let state = state.lock().unwrap();
        let job = &state.store.review_state().review_jobs[0];
        assert_eq!(job.status, ReviewJobStatus::Completed);
        assert_eq!(job.attempts, 2);
        assert_eq!(
            state.store.review_state().reviewed_through["review-session-0"],
            1
        );
        assert_eq!(state.store.profile_facts().len(), 1);
        let reopened = MemoryStore::open(memory_path).unwrap();
        assert_eq!(reopened.profile_facts().len(), 1);
        assert_eq!(
            reopened.review_state().reviewed_through["review-session-0"],
            1
        );
    }

    #[test]
    fn fake_boundary_timeout_projects_stale_pending_context_and_visible_error() {
        let state = review_test_state_with("boundary-timeout", 1, 1);
        let control = Arc::new(ExecutorControl {
            state: Mutex::new(ExecutorControlState::default()),
            changed: Condvar::new(),
        });
        let clock = Arc::new(FakeClock::default());
        clock.set(42);
        let coordinator = Arc::new(ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-boundary")),
            Arc::new(ControlledFactory {
                control: control.clone(),
            }),
            clock,
        ));
        let waiter = EnteredTimeoutWaiter {
            control: control.clone(),
        };

        let status = coordinator
            .drain_boundary_with_waiter(Duration::from_secs(10), &waiter)
            .unwrap();
        assert_eq!(status, ReviewDrainStatus::TimedOut);
        {
            let mut state = state.lock().unwrap();
            let book_id = state.book.base.book_id.clone();
            let request = crate::profile_snapshot_request(
                &state,
                &book_id,
                crate::current_content_profile(&state.book),
                "42",
            );
            let snapshot = state.store.project_reader_profile_snapshot(&request);
            assert_eq!(snapshot.profile_status, ProfileStatus::Stale);
            assert_eq!(snapshot.pending_context.len(), 1);
            assert_eq!(snapshot.pending_context[0].turn_id, "turn-review-0-1");
            let reply = route(
                &mut state,
                Req {
                    method: "GET",
                    url: "/profile/memory",
                    body: "",
                    now: "42",
                },
            );
            assert_eq!(reply.status, 200);
            let view: serde_json::Value = serde_json::from_str(&reply.body).unwrap();
            assert_eq!(view["status"]["profile_status"], "stale");
            assert_eq!(view["status"]["pending_review_jobs"], 1);
            assert_eq!(
                view["status"]["review_error"]["error_code"],
                "REVIEW_DRAIN_TIMEOUT"
            );
            assert_eq!(
                view["snapshot"]["pending_context"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }

        {
            let mut control_state = control.state.lock().unwrap();
            control_state.release = true;
            control.changed.notify_all();
        }
        assert!(coordinator.run_one("43").unwrap().is_none());
        let state = state.lock().unwrap();
        assert!(state.store.review_state().last_error.is_none());
        assert_eq!(
            state.store.review_state().review_jobs[0].status,
            ReviewJobStatus::Completed
        );
        let request = crate::profile_snapshot_request(
            &state,
            &state.book.base.book_id,
            crate::current_content_profile(&state.book),
            "43",
        );
        assert_eq!(request.profile_status, ProfileStatus::Current);
        assert!(request.pending_context.is_empty());
    }

    #[test]
    fn boundary_reconciles_cross_file_history_gap_before_draining() {
        let state = review_test_state_with("boundary-history-gap", 1, 1);
        {
            let mut state = state.lock().unwrap();
            let empty_path = std::env::temp_dir().join("ub-review-host-boundary-gap-empty.json");
            let _ = std::fs::remove_file(&empty_path);
            state.store = MemoryStore::open(empty_path).unwrap();
            assert!(state.store.review_state().review_jobs.is_empty());
        }
        let clock = Arc::new(FakeClock::default());
        clock.set(77);
        let calls = Arc::new(AtomicUsize::new(0));
        let coordinator = Arc::new(ReviewCoordinator::new_with_clock(
            state.clone(),
            Some(review_provider("model-boundary-gap")),
            Arc::new(ImmediateFactory {
                calls: calls.clone(),
            }),
            clock,
        ));

        let status = coordinator
            .drain_boundary_with_waiter(Duration::from_secs(10), &CompletingWaiter)
            .unwrap();

        assert_eq!(status, ReviewDrainStatus::Drained);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let state = state.lock().unwrap();
        assert_eq!(state.store.review_state().review_jobs.len(), 1);
        assert_eq!(
            state.store.review_state().review_jobs[0].status,
            ReviewJobStatus::Completed
        );
        assert_eq!(
            state.store.review_state().reviewed_through["review-session-0"],
            1
        );
    }

    #[test]
    fn review_boundary_detection_covers_resident_context_switches() {
        for path in [
            "/agent/new",
            "/agent/history/select",
            "/book/open",
            "/book/create",
            "/build_workbench/input.import",
        ] {
            assert!(is_review_boundary("POST", path), "missing {path}");
        }
        assert!(!is_review_boundary("GET", "/book/open"));
        assert!(!is_review_boundary("POST", "/reader/state"));
        assert!(is_resident_turn_request("POST", "/agent/chat"));
        assert!(!is_resident_turn_request("POST", "/book/query"));
    }
}
