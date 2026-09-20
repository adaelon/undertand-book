pub mod config;
pub(crate) mod langsmith;
pub(crate) mod lifecycle;
pub(crate) mod mapping;
pub(crate) mod policy;
pub(crate) mod queue;
pub(crate) mod spool;

use config::{ConfigError, ObservabilityConfig};
use langsmith::{HttpLangSmithTransport, LangSmithTransport, TransportResult};
use lifecycle::{business_states, root_finished, root_started, RunIdentity};
use mapping::{export_item, ActivityMapper};
use queue::{BoundedQueue, ExportItem, ExportOperation, QueueLimits};
use runtime::observation::PersistenceState;
use runtime::run_events::{EvidenceObservation, RunEventSink, RuntimeEvent};
use spool::{Spool, SpoolOpenStats};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ObservabilityStatus {
    pub enabled: bool,
    pub mode: String,
    pub project_display_name: Option<String>,
    pub queued: usize,
    pub spool_pending: usize,
    pub spool_bytes: u64,
    pub recovered: u64,
    pub quarantined: u64,
    pub isolated: u64,
    pub sent: u64,
    pub dropped: u64,
    pub coverage: String,
    pub last_error_code: Option<String>,
}

struct RuntimeStats {
    sent: AtomicU64,
    dropped: AtomicU64,
    auth_rejected: AtomicBool,
    recovered: AtomicU64,
    quarantined: AtomicU64,
    isolated: AtomicU64,
    last_error_code: Mutex<Option<String>>,
}

impl RuntimeStats {
    fn new(error: Option<String>) -> Self {
        Self {
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            auth_rejected: AtomicBool::new(false),
            recovered: AtomicU64::new(0),
            quarantined: AtomicU64::new(0),
            isolated: AtomicU64::new(0),
            last_error_code: Mutex::new(error),
        }
    }

    fn error(&self, code: &str) {
        *self
            .last_error_code
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(code.into());
    }
}

pub struct ObservabilityRuntime {
    config: Option<ObservabilityConfig>,
    queue: Option<Arc<BoundedQueue>>,
    stats: Arc<RuntimeStats>,
    worker: Mutex<Option<JoinHandle<()>>>,
    thread_refs: Mutex<HashMap<String, String>>,
    book_refs: Mutex<HashMap<String, String>>,
    trace_drops: Mutex<HashMap<String, u64>>,
    spool: Option<Arc<Mutex<Spool>>>,
}

impl ObservabilityRuntime {
    pub fn from_env() -> Arc<Self> {
        match ObservabilityConfig::from_env() {
            Ok(None) => {
                if let Some(directory) = config::SpoolConfig::directory_from_env() {
                    if Spool::clear_directory(&directory).is_err() {
                        return Self::disabled(Some(ConfigError {
                            code: "OBSERVABILITY_SPOOL_CLEAR_FAILED",
                            message: "failed to clear disabled observability spool".into(),
                        }));
                    }
                }
                Self::disabled(None)
            }
            Err(error) => Self::disabled(Some(error)),
            Ok(Some(config)) => {
                let transport = HttpLangSmithTransport::new(config.clone());
                Self::with_transport(config, Box::new(transport))
            }
        }
    }

    fn disabled(error: Option<ConfigError>) -> Arc<Self> {
        Arc::new(Self {
            config: None,
            queue: None,
            stats: Arc::new(RuntimeStats::new(error.map(|value| value.code.into()))),
            worker: Mutex::new(None),
            thread_refs: Mutex::new(HashMap::new()),
            book_refs: Mutex::new(HashMap::new()),
            trace_drops: Mutex::new(HashMap::new()),
            spool: None,
        })
    }

    pub(crate) fn with_transport(
        config: ObservabilityConfig,
        transport: Box<dyn LangSmithTransport>,
    ) -> Arc<Self> {
        let queue = Arc::new(BoundedQueue::new(QueueLimits {
            max_items: config.queue_items,
            max_bytes: config.queue_bytes,
            max_item_bytes: config.max_item_bytes,
        }));
        let stats = Arc::new(RuntimeStats::new(None));
        let (spool, recovered) = match config.spool.as_ref() {
            Some(_) => match Spool::open(&config) {
                Ok(opened) => {
                    apply_spool_open_stats(&stats, opened.stats);
                    (Some(Arc::new(Mutex::new(opened.spool))), opened.recovered)
                }
                Err(_) => {
                    stats.error("OBSERVABILITY_SPOOL_OPEN_FAILED");
                    (None, Vec::new())
                }
            },
            None => (None, Vec::new()),
        };
        let worker_queue = queue.clone();
        let worker_stats = stats.clone();
        let worker_spool = spool.clone();
        let request_timeout = config.request_timeout;
        let worker = std::thread::spawn(move || {
            export_loop(
                worker_queue,
                worker_stats,
                transport,
                request_timeout,
                worker_spool,
                recovered,
            )
        });
        Arc::new(Self {
            config: Some(config),
            queue: Some(queue),
            stats,
            worker: Mutex::new(Some(worker)),
            thread_refs: Mutex::new(HashMap::new()),
            book_refs: Mutex::new(HashMap::new()),
            trace_drops: Mutex::new(HashMap::new()),
            spool,
        })
    }

    pub fn status(&self) -> ObservabilityStatus {
        let queued = self
            .queue
            .as_ref()
            .map(|queue| queue.pending().0)
            .unwrap_or(0);
        let spool = self
            .spool
            .as_ref()
            .map(|spool| {
                spool
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .status()
            })
            .unwrap_or_default();
        let dropped = self.stats.dropped.load(Ordering::Relaxed);
        let quarantined = self.stats.quarantined.load(Ordering::Relaxed);
        let isolated = self.stats.isolated.load(Ordering::Relaxed);
        ObservabilityStatus {
            enabled: self.config.is_some(),
            mode: self
                .config
                .as_ref()
                .map(|config| config.mode.as_str())
                .unwrap_or("off")
                .into(),
            project_display_name: self.config.as_ref().map(|config| config.project.clone()),
            queued,
            spool_pending: spool.pending,
            spool_bytes: spool.bytes,
            recovered: self.stats.recovered.load(Ordering::Relaxed),
            quarantined,
            isolated,
            sent: self.stats.sent.load(Ordering::Relaxed),
            dropped,
            coverage: if dropped > 0 || quarantined > 0 || isolated > 0 {
                "partial"
            } else if self.config.is_some() {
                "complete"
            } else {
                "unknown"
            }
            .into(),
            last_error_code: self
                .stats
                .last_error_code
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        }
    }

    pub fn start_run(self: &Arc<Self>, book_id: &str, session_id: &str) -> Option<ObservationRun> {
        let config = self.config.as_ref()?;
        let thread_id = opaque_ref(&self.thread_refs, session_id);
        let book_ref = opaque_ref(&self.book_refs, book_id);
        let identity = RunIdentity::new(thread_id, book_ref);
        let root = root_started(&identity);
        let active = self.enqueue(export_item(root, ExportOperation::Create, &config.project));
        Some(ObservationRun {
            inner: Arc::new(ObservationRunInner {
                runtime: self.clone(),
                identity,
                mapper: Mutex::new(ActivityMapper::new(config.max_trace_spans)),
                answer_first_patch_ms: Mutex::new(None),
                active: AtomicBool::new(active),
                finished: AtomicBool::new(false),
            }),
        })
    }

    fn enqueue(&self, item: ExportItem) -> bool {
        let Some(queue) = &self.queue else {
            return false;
        };
        let root_id = item.root_run_id.clone();
        match queue.try_push(item) {
            Ok(()) => true,
            Err(_) => {
                self.note_drop(&root_id, "OBSERVABILITY_QUEUE_DROPPED");
                false
            }
        }
    }

    fn note_drop(&self, root_id: &str, code: &str) {
        self.stats.dropped.fetch_add(1, Ordering::Relaxed);
        self.stats.error(code);
        *self
            .trace_drops
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(root_id.into())
            .or_default() += 1;
    }

    fn trace_drop_count(&self, root_id: &str) -> u64 {
        self.trace_drops
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(root_id)
            .copied()
            .unwrap_or(0)
    }

    pub fn shutdown(&self) {
        let Some(config) = &self.config else {
            return;
        };
        if let Some(queue) = &self.queue {
            queue.begin_shutdown(config.shutdown_timeout);
        }
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for ObservabilityRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn apply_spool_open_stats(stats: &RuntimeStats, opened: SpoolOpenStats) {
    stats.recovered.store(opened.recovered, Ordering::Relaxed);
    stats
        .quarantined
        .store(opened.quarantined, Ordering::Relaxed);
    stats.isolated.store(opened.isolated, Ordering::Relaxed);
    stats.dropped.fetch_add(opened.dropped, Ordering::Relaxed);
    if opened.quarantined > 0 {
        stats.error("OBSERVABILITY_SPOOL_QUARANTINED");
    } else if opened.isolated > 0 {
        stats.error("OBSERVABILITY_SPOOL_TARGET_ISOLATED");
    } else if opened.dropped > 0 {
        stats.error("OBSERVABILITY_SPOOL_PRUNED");
    }
}

fn opaque_ref(map: &Mutex<HashMap<String, String>>, local: &str) -> String {
    map.lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(local.into())
        .or_insert_with(|| uuid::Uuid::now_v7().to_string())
        .clone()
}

#[derive(Clone)]
pub struct ObservationRun {
    inner: Arc<ObservationRunInner>,
}

struct ObservationRunInner {
    runtime: Arc<ObservabilityRuntime>,
    identity: RunIdentity,
    mapper: Mutex<ActivityMapper>,
    answer_first_patch_ms: Mutex<Option<f64>>,
    active: AtomicBool,
    finished: AtomicBool,
}

impl ObservationRun {
    pub fn event_anchor(&self) -> Instant {
        self.inner.identity.started
    }

    pub fn sink(&self) -> Arc<dyn RunEventSink> {
        Arc::new(ActivityObservationSink { run: self.clone() })
    }

    pub fn finish(
        &self,
        outcome: Option<&runtime::orchestrator::OuterOutcome>,
        cancelled: bool,
        persistence_state: PersistenceState,
        error_code: Option<&str>,
    ) {
        if self.inner.finished.swap(true, Ordering::AcqRel)
            || !self.inner.active.load(Ordering::Acquire)
        {
            return;
        }
        let (execution, delivery, incomplete) =
            business_states(outcome, cancelled, persistence_state);
        let error_code = policy::safe_error_code(error_code);
        let dropped = self
            .inner
            .runtime
            .trace_drop_count(&self.inner.identity.root_span_id);
        let mut observation = root_finished(
            &self.inner.identity,
            execution,
            delivery,
            persistence_state,
            incomplete,
            error_code,
            dropped,
            *self
                .inner
                .answer_first_patch_ms
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        if let Some(outcome) = outcome {
            enrich_root_metadata(&mut observation.metadata, outcome);
        }
        let project = &self.inner.runtime.config.as_ref().unwrap().project;
        if !self
            .inner
            .runtime
            .enqueue(export_item(observation, ExportOperation::Update, project))
        {
            self.inner.active.store(false, Ordering::Release);
        }
    }

    fn observe(&self, event: RuntimeEvent) {
        if !self.inner.active.load(Ordering::Acquire) {
            return;
        }
        let mapped = self
            .inner
            .mapper
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .map(&self.inner.identity, event);
        let Some((observation, operation)) = mapped else {
            self.inner.runtime.note_drop(
                &self.inner.identity.root_span_id,
                "OBSERVABILITY_TRACE_LIMIT",
            );
            return;
        };
        let project = &self.inner.runtime.config.as_ref().unwrap().project;
        if !self
            .inner
            .runtime
            .enqueue(export_item(observation, operation, project))
        {
            // A dropped child does not stop the root update; the final root record carries the
            // local dropped count when capacity becomes available.
        }
    }

    fn observe_evidence(&self, evidence: EvidenceObservation) {
        if !self.inner.active.load(Ordering::Acquire) {
            return;
        }
        let mapped = self
            .inner
            .mapper
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .map_evidence(&self.inner.identity, evidence);
        let Some((observation, operation)) = mapped else {
            return;
        };
        let project = &self.inner.runtime.config.as_ref().unwrap().project;
        let _ = self
            .inner
            .runtime
            .enqueue(export_item(observation, operation, project));
    }
}

fn saturating_u32(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn enrich_root_metadata(
    metadata: &mut runtime::observation::ObservationMetadata,
    outcome: &runtime::orchestrator::OuterOutcome,
) {
    metadata.source_refs = outcome
        .source_bindings
        .iter()
        .map(|binding| binding.source_ref_id.clone())
        .take(runtime::observation::MAX_OBSERVATION_SOURCE_REFS)
        .collect();
    metadata.final_source_ref_count = Some(saturating_u32(outcome.source_bindings.len()));

    if let Some(diagnostics) = &outcome.delivery_diagnostics {
        metadata.delivery_initial_issue_count =
            Some(saturating_u32(diagnostics.initial.issues.len()));
        metadata.delivery_repair_issue_count = diagnostics
            .repair
            .as_ref()
            .map(|repair| saturating_u32(repair.issues.len()));
        metadata.delivery_classification = Some(
            match &diagnostics.repair {
                Some(repair) if repair.issues.is_empty() => "repaired_delivered",
                Some(_) => "repair_failed",
                None if diagnostics.initial.issues.is_empty() => "initial_delivered",
                None => "initial_failed",
            }
            .into(),
        );
        let mut codes = diagnostics
            .initial
            .issues
            .iter()
            .chain(
                diagnostics
                    .repair
                    .iter()
                    .flat_map(|repair| repair.issues.iter()),
            )
            .filter_map(|issue| policy::safe_error_code(Some(&issue.error_code)))
            .collect::<Vec<_>>();
        codes.sort();
        codes.dedup();
        codes.truncate(runtime::observation::MAX_OBSERVATION_ERROR_CODES);
        metadata.delivery_error_codes = codes;
    } else {
        metadata.delivery_initial_issue_count = Some(0);
        metadata.delivery_classification = Some("initial_delivered".into());
    }

    let audit = &outcome.request_audit;
    metadata.request_count = Some(saturating_u32(audit.requests.len()));
    metadata.request_message_count = Some(saturating_u32(
        audit
            .requests
            .iter()
            .map(|request| request.messages.len())
            .sum(),
    ));
    metadata.request_tool_schema_count = Some(saturating_u32(
        audit
            .requests
            .iter()
            .map(|request| request.tool_schemas.len())
            .sum(),
    ));
    metadata.request_estimated_input_tokens =
        Some(audit.requests.iter().fold(0_u32, |sum, request| {
            sum.saturating_add(request.active_input_estimated_tokens)
        }));
    if !audit.requests.is_empty() {
        metadata.request_estimate_source = Some("runtime_estimated".into());
    }
}

struct ActivityObservationSink {
    run: ObservationRun,
}

impl RunEventSink for ActivityObservationSink {
    fn emit(&self, event: RuntimeEvent) {
        self.run.observe(event);
    }

    fn answer_first_patch(&self, elapsed_ms: f64) {
        let mut first = self
            .run
            .inner
            .answer_first_patch_ms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if first.is_none() {
            *first = Some(elapsed_ms);
        }
    }

    fn evidence_accepted(&self, observation: EvidenceObservation) {
        self.run.observe_evidence(observation);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CreateState {
    Confirmed,
    Abandoned,
}

fn export_loop(
    queue: Arc<BoundedQueue>,
    stats: Arc<RuntimeStats>,
    mut transport: Box<dyn LangSmithTransport>,
    request_timeout: Duration,
    spool: Option<Arc<Mutex<Spool>>>,
    recovered: Vec<ExportItem>,
) {
    let mut create_states: HashMap<String, CreateState> = HashMap::new();
    let mut revisions: HashMap<String, u32> = HashMap::new();
    let mut run_roots: HashMap<String, String> = HashMap::new();
    let mut recovered = recovered.into_iter();
    loop {
        let item = match recovered.next().or_else(|| queue.pop()) {
            Some(item) => item,
            None => break,
        };
        if let Some(spool) = &spool {
            match spool
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .persist(&item)
            {
                Ok(pruned) => {
                    if pruned > 0 {
                        stats.dropped.fetch_add(pruned, Ordering::Relaxed);
                        stats.error("OBSERVABILITY_SPOOL_PRUNED");
                    }
                }
                Err(_) => {
                    stats.dropped.fetch_add(1, Ordering::Relaxed);
                    stats.error("OBSERVABILITY_SPOOL_WRITE_FAILED");
                    continue;
                }
            }
        }
        if stats.auth_rejected.load(Ordering::Acquire) {
            stats.dropped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        if revisions
            .get(&item.run_id)
            .is_some_and(|revision| *revision >= item.revision)
        {
            continue;
        }
        let dependency_ready = match item.operation {
            ExportOperation::Create => item
                .parent_run_id
                .as_ref()
                .is_none_or(|parent| create_states.get(parent) == Some(&CreateState::Confirmed)),
            ExportOperation::Update => {
                create_states.get(&item.run_id) == Some(&CreateState::Confirmed)
            }
        };
        if !dependency_ready {
            if item.operation == ExportOperation::Create {
                create_states.insert(item.run_id.clone(), CreateState::Abandoned);
            }
            stats.dropped.fetch_add(1, Ordering::Relaxed);
            stats.error("OBSERVABILITY_PARENT_UNCONFIRMED");
            continue;
        }
        let result = send_with_retry(&queue, transport.as_mut(), &item, request_timeout);
        match result {
            TransportResult::Confirmed => {
                if item.operation == ExportOperation::Create {
                    create_states.insert(item.run_id.clone(), CreateState::Confirmed);
                    run_roots.insert(item.run_id.clone(), item.root_run_id.clone());
                }
                revisions.insert(item.run_id.clone(), item.revision);
                stats.sent.fetch_add(1, Ordering::Relaxed);
                if item.operation == ExportOperation::Update && item.run_id == item.root_run_id {
                    if let Some(spool) = &spool {
                        if spool
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .remove_trace(&item.root_run_id)
                            .is_err()
                        {
                            stats.error("OBSERVABILITY_SPOOL_CLEANUP_FAILED");
                        }
                    }
                }
            }
            TransportResult::AuthenticationRejected => {
                if item.operation == ExportOperation::Create {
                    create_states.insert(item.run_id.clone(), CreateState::Abandoned);
                }
                stats.auth_rejected.store(true, Ordering::Release);
                stats.dropped.fetch_add(1, Ordering::Relaxed);
                stats.error("LANGSMITH_AUTH_REJECTED");
            }
            TransportResult::Permanent { code } | TransportResult::Retry { code, .. } => {
                if item.operation == ExportOperation::Create {
                    create_states.insert(item.run_id.clone(), CreateState::Abandoned);
                }
                stats.dropped.fetch_add(1, Ordering::Relaxed);
                stats.error(code);
            }
        }
        if item.operation == ExportOperation::Update && item.run_id == item.root_run_id {
            let completed_root = &item.root_run_id;
            create_states.retain(|run_id, _| {
                run_roots
                    .get(run_id)
                    .is_some_and(|root| root != completed_root)
            });
            revisions.retain(|run_id, _| {
                run_roots
                    .get(run_id)
                    .is_some_and(|root| root != completed_root)
            });
            run_roots.retain(|_, root| root != completed_root);
        }
    }
}

fn send_with_retry(
    queue: &BoundedQueue,
    transport: &mut dyn LangSmithTransport,
    item: &ExportItem,
    request_timeout: Duration,
) -> TransportResult {
    let retry_deadline = Instant::now() + Duration::from_secs(1);
    let mut attempts = 0;
    loop {
        attempts += 1;
        let shutdown_budget = queue.remaining_shutdown_budget();
        if shutdown_budget.is_some_and(|budget| budget.is_zero()) {
            return TransportResult::Permanent {
                code: "OBSERVABILITY_SHUTDOWN_BUDGET_EXHAUSTED",
            };
        }
        let timeout = shutdown_budget
            .map(|budget| request_timeout.min(budget))
            .unwrap_or(request_timeout);
        match transport.send(item, timeout) {
            TransportResult::Retry { after, code } if attempts < 3 => {
                let remaining = retry_deadline.saturating_duration_since(Instant::now());
                let shutdown_remaining = queue.remaining_shutdown_budget().unwrap_or(remaining);
                let budget = remaining.min(shutdown_remaining);
                if after > budget || budget.is_zero() {
                    return TransportResult::Retry { after, code };
                }
                std::thread::sleep(after);
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct RecordingTransport {
        sent: Arc<Mutex<Vec<ExportItem>>>,
        reject_root: bool,
    }

    impl LangSmithTransport for RecordingTransport {
        fn send(&mut self, item: &ExportItem, _timeout: Duration) -> TransportResult {
            self.sent.lock().unwrap().push(item.clone());
            if self.reject_root
                && item.parent_run_id.is_none()
                && item.operation == ExportOperation::Create
            {
                TransportResult::Permanent {
                    code: "ROOT_REJECTED",
                }
            } else {
                TransportResult::Confirmed
            }
        }
    }

    struct AlwaysRetryTransport;

    impl LangSmithTransport for AlwaysRetryTransport {
        fn send(&mut self, _item: &ExportItem, _timeout: Duration) -> TransportResult {
            TransportResult::Retry {
                after: Duration::from_millis(1),
                code: "LANGSMITH_TRANSPORT_ERROR",
            }
        }
    }

    struct SlowTransport {
        delay: Duration,
    }

    impl LangSmithTransport for SlowTransport {
        fn send(&mut self, _item: &ExportItem, _timeout: Duration) -> TransportResult {
            std::thread::sleep(self.delay);
            TransportResult::Confirmed
        }
    }

    fn config() -> ObservabilityConfig {
        ObservabilityConfig {
            mode: config::ObservabilityMode::Metadata,
            api_key: "test-key".into(),
            endpoint: url::Url::parse("http://127.0.0.1:1").unwrap(),
            project: "test-project".into(),
            workspace_id: None,
            request_timeout: Duration::from_millis(50),
            shutdown_timeout: Duration::from_secs(1),
            queue_items: 32,
            queue_bytes: 128 * 1024,
            max_item_bytes: 64 * 1024,
            max_trace_spans: 8,
            spool: None,
        }
    }

    fn config_with_spool(directory: &std::path::Path) -> ObservabilityConfig {
        let mut config = config();
        config.spool = Some(config::SpoolConfig {
            directory: directory.to_path_buf(),
            max_bytes: 128 * 1024,
            max_files: 32,
            retention: Duration::from_secs(60),
            target_change: config::SpoolTargetChange::Isolate,
        });
        config
    }

    #[test]
    fn parent_create_is_confirmed_before_child_and_root_finish() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let runtime = ObservabilityRuntime::with_transport(
            config(),
            Box::new(RecordingTransport {
                sent: sent.clone(),
                reject_root: false,
            }),
        );
        let run = runtime
            .start_run("private-book", "private-session")
            .unwrap();
        run.observe(RuntimeEvent {
            elapsed_ms: 1.0,
            activity: runtime::run_events::RunActivity {
                step_id: 1,
                parent_step_id: None,
                kind: "model".into(),
                name: "outer".into(),
                label: "private-label".into(),
                status: runtime::run_events::ActivityStatus::Running,
                started_ms: Some(1.0),
                duration_ms: None,
                result_count: None,
                error_code: None,
                usage_total_tokens: None,
                usage: None,
                model_first_text_ms: None,
                model_name: Some("configured-model".into()),
                model_name_source: Some("configured".into()),
                accepted_evidence_count: None,
                evidence_refs: Vec::new(),
            },
        });
        run.finish(None, false, PersistenceState::Saved, Some("PROVIDER_ERROR"));
        runtime.shutdown();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 3);
        assert!(sent[0].parent_run_id.is_none());
        assert_eq!(
            sent[1].parent_run_id.as_deref(),
            Some(sent[0].run_id.as_str())
        );
        assert_eq!(sent[2].operation, ExportOperation::Update);
        let serialized =
            serde_json::to_string(&sent.iter().map(|item| &item.payload).collect::<Vec<_>>())
                .unwrap();
        assert!(!serialized.contains("private-book"));
        assert!(!serialized.contains("private-session"));
        assert!(!serialized.contains("private-label"));
        assert!(!serialized.contains("test-key"));
    }

    #[test]
    fn rejected_parent_abandons_children_without_sending_them() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let runtime = ObservabilityRuntime::with_transport(
            config(),
            Box::new(RecordingTransport {
                sent: sent.clone(),
                reject_root: true,
            }),
        );
        let run = runtime.start_run("book", "session").unwrap();
        run.observe(RuntimeEvent {
            elapsed_ms: 1.0,
            activity: runtime::run_events::RunActivity {
                step_id: 1,
                parent_step_id: None,
                kind: "model".into(),
                name: "outer".into(),
                label: "answer".into(),
                status: runtime::run_events::ActivityStatus::Running,
                started_ms: Some(1.0),
                duration_ms: None,
                result_count: None,
                error_code: None,
                usage_total_tokens: None,
                usage: None,
                model_first_text_ms: None,
                model_name: Some("configured-model".into()),
                model_name_source: Some("configured".into()),
                accepted_evidence_count: None,
                evidence_refs: Vec::new(),
            },
        });
        runtime.shutdown();
        assert_eq!(sent.lock().unwrap().len(), 1);
        assert!(runtime.status().dropped >= 1);
    }

    #[test]
    fn durable_spool_replays_open_trace_as_interrupted_without_business_replay() {
        let temp = TempDir::new().unwrap();
        let first = ObservabilityRuntime::with_transport(
            config_with_spool(temp.path()),
            Box::new(AlwaysRetryTransport),
        );
        let run = first.start_run("private-book", "private-session").unwrap();
        first.shutdown();
        assert_eq!(first.status().spool_pending, 1);
        drop(run);
        drop(first);

        let sent = Arc::new(Mutex::new(Vec::new()));
        let second = ObservabilityRuntime::with_transport(
            config_with_spool(temp.path()),
            Box::new(RecordingTransport {
                sent: sent.clone(),
                reject_root: false,
            }),
        );
        second.shutdown();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].operation, ExportOperation::Create);
        assert_eq!(sent[1].operation, ExportOperation::Update);
        assert_eq!(
            sent[1].payload["extra"]["metadata"]["ub_observation"]["execution_state"],
            "interrupted"
        );
        assert_eq!(second.status().recovered, 2);
        assert_eq!(second.status().spool_pending, 0);
    }

    #[test]
    fn slow_exporter_does_not_block_resident_enqueue_path() {
        let runtime = ObservabilityRuntime::with_transport(
            config(),
            Box::new(SlowTransport {
                delay: Duration::from_millis(150),
            }),
        );
        let samples = (0..5)
            .map(|index| {
                let started = Instant::now();
                let run = runtime
                    .start_run("private-book", &format!("private-session-{index}"))
                    .unwrap();
                let elapsed = started.elapsed();
                drop(run);
                elapsed
            })
            .collect::<Vec<_>>();
        let max_enqueue = samples.iter().copied().max().unwrap();
        eprintln!(
            "observability enqueue samples (microseconds): {:?}; synthetic transport delay: 150000",
            samples.iter().map(Duration::as_micros).collect::<Vec<_>>()
        );
        assert!(max_enqueue < Duration::from_millis(50));
        runtime.shutdown();
    }

    #[test]
    fn root_diagnostics_export_counts_codes_and_opaque_refs_only() {
        use runtime::orchestrator::{
            AnswerDeliveryAttemptDiagnostics, AnswerDeliveryDiagnostics, AnswerDeliveryIssue,
            OuterOutcome, SourceBinding,
        };
        let mut request_audit = runtime::agent_request_audit::AgentRequestAudit::default();
        request_audit.begin_request(&[runtime::Message::user("CANARY_PRIVATE_REQUEST")], &[], 0);
        let outcome = OuterOutcome {
            answer: Some("CANARY_PRIVATE_ANSWER".into()),
            answer_view: None,
            incomplete: true,
            warning: None,
            turns: 1,
            tokens_spent: 0,
            effects: Vec::new(),
            trace: Vec::new(),
            profile_usage: Default::default(),
            memory_updates: Vec::new(),
            source_bindings: vec![SourceBinding {
                source_ref_id: "source_ref_safe".into(),
                book_id: "CANARY_PRIVATE_BOOK".into(),
                evidence_range: read_tools::EvidenceRange {
                    start_lid: "1.1".into(),
                    end_lid: "1.1".into(),
                    ranges: Vec::new(),
                },
                evidence_text_digest: "CANARY_PRIVATE_DIGEST".into(),
                label_snapshot: "CANARY_PRIVATE_LABEL".into(),
                preview_snapshot: "CANARY_PRIVATE_PREVIEW".into(),
            }],
            delivery_diagnostics: Some(AnswerDeliveryDiagnostics {
                initial: AnswerDeliveryAttemptDiagnostics {
                    issues: vec![AnswerDeliveryIssue {
                        error_code: "SOURCE_INVALID".into(),
                        start: Some(0),
                        end: Some(1),
                        trigger_value: Some("CANARY_PRIVATE_TRIGGER".into()),
                        match_form: "CANARY_PRIVATE_MATCH".into(),
                        source_channels: vec!["CANARY_PRIVATE_CHANNEL".into()],
                    }],
                },
                repair: Some(AnswerDeliveryAttemptDiagnostics {
                    issues: vec![AnswerDeliveryIssue {
                        error_code: "SOURCE_MISSING".into(),
                        start: None,
                        end: None,
                        trigger_value: Some("CANARY_PRIVATE_REPAIR".into()),
                        match_form: "CANARY_PRIVATE_MATCH".into(),
                        source_channels: Vec::new(),
                    }],
                }),
            }),
            request_audit,
        };
        let mut metadata = runtime::observation::ObservationMetadata::default();
        enrich_root_metadata(&mut metadata, &outcome);
        assert_eq!(metadata.source_refs, vec!["source_ref_safe"]);
        assert_eq!(metadata.delivery_initial_issue_count, Some(1));
        assert_eq!(metadata.delivery_repair_issue_count, Some(1));
        assert_eq!(
            metadata.delivery_classification.as_deref(),
            Some("repair_failed")
        );
        assert_eq!(
            metadata.delivery_error_codes,
            vec!["SOURCE_INVALID", "SOURCE_MISSING"]
        );
        assert_eq!(metadata.request_count, Some(1));
        assert_eq!(
            metadata.request_estimate_source.as_deref(),
            Some("runtime_estimated")
        );
        assert!(!serde_json::to_string(&metadata)
            .unwrap()
            .contains("CANARY_PRIVATE"));
    }
}
