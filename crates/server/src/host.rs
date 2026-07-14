use crate::{
    ensure_agent_history_for_book, load_agent_history, load_session, mcp::VisitorSessions, route,
    route_book_asset_file, save_session, select_start_book, AgentAssistantStatus, AppState, Req,
    UnconfiguredAdapter,
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
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Response, Server};

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
}

impl ReviewCoordinator {
    fn new(
        state: Arc<Mutex<AppState>>,
        provider_config: Option<ProviderConfig>,
        factory: Arc<dyn ReviewExecutorFactory>,
    ) -> Self {
        Self {
            state,
            provider_config: Mutex::new(provider_config),
            factory,
            serial_gate: Mutex::new(()),
        }
    }

    fn set_provider_config(&self, config: ProviderConfig) {
        *self
            .provider_config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(config);
    }

    fn run_one(&self, now: &str) -> Result<Option<ReviewRunOutcome>, read_tools::ToolError> {
        let _serial = self
            .serial_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let config = self
            .provider_config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        let (job_id, input) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(job_id) = state
                .store
                .review_state()
                .review_jobs
                .iter()
                .find(|job| {
                    matches!(
                        job.status,
                        ReviewJobStatus::Queued | ReviewJobStatus::Retryable
                    )
                })
                .map(|job| job.job_id.clone())
            else {
                return Ok(None);
            };
            if config.is_none() {
                return Err(review_error(
                    "REVIEW_PROVIDER_UNCONFIGURED",
                    "review provider is not configured",
                ));
            }
            let claimed = state.store.claim_review_job(&job_id, now)?;
            let input = match copy_review_input(&state, &claimed) {
                Ok(input) => input,
                Err(error) => {
                    state.store.mark_review_job_retryable(
                        &job_id,
                        now,
                        ReviewErrorState {
                            error_code: error.error_code.clone(),
                            message: error.message.clone(),
                            occurred_at: now.into(),
                        },
                        now,
                    )?;
                    return Err(error);
                }
            };
            (job_id, input)
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
                    now,
                ) {
                    state.store.mark_review_job_retryable(
                        &job_id,
                        now,
                        ReviewErrorState {
                            error_code: error.error_code.clone(),
                            message: error.message.clone(),
                            occurred_at: now.into(),
                        },
                        now,
                    )?;
                    return Err(error);
                }
                Ok(Some(ReviewRunOutcome { job_id, output }))
            }
            Err(error) => {
                state.store.mark_review_job_retryable(
                    &job_id,
                    now,
                    ReviewErrorState {
                        error_code: "REVIEW_EXECUTOR_FAILED".into(),
                        message: error.message.clone(),
                        occurred_at: now.into(),
                    },
                    now,
                )?;
                Err(review_provider_error(error))
            }
        }
    }
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

    pub fn wait(mut self) {
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
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
    let store = MemoryStore::open(MemoryStore::default_path())
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
    for _ in 0..4 {
        let server = server.clone();
        let state = state.clone();
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
                                    now: &now_ts(),
                                },
                            )
                        };
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .to_string()
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
        ProfileScope, ReviewFactCandidate, ReviewJobStatus, ReviewSessionCursor, Sensitivity,
    };
    use runtime::memory_review::{ReviewExecutor, ReviewExecutorFactory};
    use runtime::orchestrator::new_session;
    use std::collections::BTreeMap;
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

    fn review_provider(model: &str) -> ProviderConfig {
        ProviderConfig::from_values("native", "test-key", "https://example.com", model).unwrap()
    }

    fn review_test_state(name: &str) -> Arc<Mutex<AppState>> {
        let (dir, book, _) = bootstrap_book(None).unwrap();
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let memory_path = std::env::temp_dir().join(format!("ub-review-host-{name}.json"));
        let _ = std::fs::remove_file(&memory_path);
        let mut store = MemoryStore::open(memory_path).unwrap();
        store
            .reconcile_review_jobs(
                &[
                    ReviewSessionCursor {
                        session_id: "review-session-a".into(),
                        book_id: book.base.book_id.clone(),
                        latest_user_turn_ordinal: 1,
                    },
                    ReviewSessionCursor {
                        session_id: "review-session-b".into(),
                        book_id: book.base.book_id.clone(),
                        latest_user_turn_ordinal: 1,
                    },
                ],
                "t0",
            )
            .unwrap();
        let sessions = ["a", "b"]
            .into_iter()
            .map(|suffix| AgentChatSession {
                id: format!("review-session-{suffix}"),
                book_id: book.base.book_id.clone(),
                title: "review".into(),
                created_at: "t0".into(),
                updated_at: "t0".into(),
                turns: vec![AgentChatTurn {
                    turn_id: format!("turn-review-{suffix}"),
                    user_turn_ordinal: 1,
                    user: "I prefer worked examples".into(),
                    status: AgentAssistantStatus::Failed,
                    outcome: None,
                    error: Some(AgentTurnError {
                        error_code: "PROVIDER_ERROR".into(),
                        category: "provider".into(),
                        message: "earlier main-agent failure".into(),
                    }),
                    question_anchor_lid: None,
                    question_quote: None,
                }],
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
                    "review-session-a".into(),
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
}
