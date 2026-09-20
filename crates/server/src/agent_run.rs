//! One Resident lifecycle per host. Execution never owns AppState's lock.
use super::*;
use crate::agent_stream::{RunDescriptor, RunSnapshot, RunStream};
use runtime::run_context::{CancellableAdapter, CancellationToken, ResidentStatePort, RunContext};
use runtime::run_events::{RunEventSink, RuntimeEvent};
use std::sync::{atomic::AtomicBool, Arc, Condvar, Mutex};

pub(crate) trait AppStatePort {
    fn with_app<R>(&self, operation: impl FnOnce(&mut AppState) -> R) -> R;
}

pub(crate) struct BorrowedAppPort<'a>(pub std::cell::RefCell<&'a mut AppState>);
impl AppStatePort for BorrowedAppPort<'_> {
    fn with_app<R>(&self, operation: impl FnOnce(&mut AppState) -> R) -> R {
        operation(&mut self.0.borrow_mut())
    }
}
impl AppStatePort for Arc<Mutex<AppState>> {
    fn with_app<R>(&self, operation: impl FnOnce(&mut AppState) -> R) -> R {
        operation(&mut self.lock().unwrap_or_else(|error| error.into_inner()))
    }
}

pub(crate) struct RuntimeStatePort<'a, P> {
    pub port: &'a P,
    pub turn_ref: &'a AgentTurnRef,
    pub previewed: std::collections::HashMap<String, std::collections::HashSet<String>>,
}
impl<P: AppStatePort> ResidentStatePort for RuntimeStatePort<'_, P> {
    fn author_presentation(
        &mut self,
        request: runtime::presentation_author::AuthorRequest,
        bindings: &[SourceBinding],
        messages: &[Message],
        cancellation: &CancellationToken,
    ) -> Result<runtime::presentation_author::AuthorResult, ToolError> {
        self.author(request, bindings, messages, cancellation)
    }
    fn with_state<R>(&mut self, operation: impl FnOnce(&mut MemoryStore, &mut Reader) -> R) -> R {
        self.port.with_app(|state| {
            let before = state.reader.revision();
            let result = operation(&mut state.store, &mut state.reader);
            if state.reader.revision() != before {
                if let Some(stream) = state.active_agent_stream.as_ref().and_then(|s| s.upgrade()) {
                    stream.reader_changed(reader_state_response(&state.book, &state.reader));
                }
            }
            result
        })
    }
}

pub(crate) struct RunCheckpointSink<'a, P> {
    pub port: &'a P,
    pub turn_ref: &'a AgentTurnRef,
}
impl<P: AppStatePort> CompactionCheckpointSink for RunCheckpointSink<'_, P> {
    fn install(
        &mut self,
        checkpoint: &CompactionCheckpoint,
        messages: &[Message],
    ) -> Result<(), CompactionError> {
        self.port.with_app(|state| {
            let active = state
                .agent_history
                .sessions
                .iter()
                .find(|session| session.id == self.turn_ref.session_id)
                .and_then(|session| {
                    session
                        .turns
                        .iter()
                        .find(|turn| turn.turn_id == self.turn_ref.turn_id)
                })
                .is_some_and(|turn| turn.status == AgentAssistantStatus::PendingAssistant);
            if !active {
                return Err(CompactionError {
                    error_code: "COMPACTION_FAILED".into(),
                    message: "run is no longer pending".into(),
                });
            }
            ServerAgentCompactionCheckpointSink {
                history_path: &state.history_path,
                agent_history: &mut state.agent_history,
                session_id: &self.turn_ref.session_id,
            }
            .install(checkpoint, messages)
        })
    }
}

pub(crate) struct PreparedAgentChat {
    pub book: Arc<Book>,
    pub turn_ref: AgentTurnRef,
    pub message: String,
    pub agent_message: String,
    pub initial_evidence: Vec<EvidenceRange>,
    pub messages: Vec<Message>,
    pub now: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentRunSummary {
    pub effects: Vec<runtime::orchestrator::AgentEffect>,
    pub trace: Vec<runtime::orchestrator::TraceStep>,
    #[serde(default)]
    pub activities: Option<Vec<runtime::run_events::RunActivity>>,
    #[serde(default)]
    pub last_seq: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UnsavedRun {
    pub book_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub summary: AgentRunSummary,
    pub outcome: Option<OuterOutcome>,
    pub error: AgentTurnError,
}

pub(crate) struct ExecutionReport {
    pub reply: Reply,
    unsaved: Option<UnsavedRun>,
}
impl ExecutionReport {
    fn saved(reply: Reply) -> Self {
        Self {
            reply,
            unsaved: None,
        }
    }
}

pub(crate) fn execute_prepared(
    port: &impl AppStatePort,
    adapter: &dyn ModelAdapter,
    prepared: PreparedAgentChat,
    cancellation: CancellationToken,
) -> ExecutionReport {
    execute_observed(port, adapter, prepared, cancellation, None, None)
}

fn execute_observed(
    port: &impl AppStatePort,
    adapter: &dyn ModelAdapter,
    mut prepared: PreparedAgentChat,
    cancellation: CancellationToken,
    stream: Option<&Arc<RunStream>>,
    observability: Option<&Arc<crate::observability::ObservabilityRuntime>>,
) -> ExecutionReport {
    runtime::presentation_author::redact_history(&mut prepared.messages);
    runtime::tool_exposure::redact_history(&mut prepared.messages);
    let mut context = RunContext::new(
        std::mem::take(&mut prepared.messages),
        OuterConfig::default(),
        adapter.model_runtime_profile(),
    );
    context.cancellation = cancellation.clone();
    let observation_run = observability.and_then(|runtime| {
        runtime.start_run(&prepared.book.base.book_id, &prepared.turn_ref.session_id)
    });
    let observation_sink = observation_run.as_ref().map(|run| run.sink());
    let event_sink: Option<Arc<dyn RunEventSink>> = match (stream, observation_sink) {
        (Some(stream), Some(observation)) => Some(Arc::new(RunEventFanout {
            stream: stream.clone(),
            observation,
        })),
        (Some(stream), None) => Some(stream.clone()),
        (None, Some(observation)) => Some(observation),
        (None, None) => None,
    };
    context.events = runtime::run_events::RunEvents::with_start(
        observation_run
            .as_ref()
            .map(|run| run.event_anchor())
            .unwrap_or_else(std::time::Instant::now),
        event_sink,
    );
    adapter.set_run_cancellation(cancellation.clone());
    let observed = runtime::run_events::ObservedAdapter {
        inner: adapter,
        events: context.events.clone(),
        cancellation: cancellation.clone(),
        runtime_profile: context.runtime_profile.clone(),
    };
    let adapter = CancellableAdapter {
        inner: &observed,
        cancellation: cancellation.clone(),
    };
    let result = run_precommitted_agent_chat(port, &adapter, &prepared, &mut context);
    runtime::presentation_author::redact_history(&mut context.messages);
    runtime::tool_exposure::redact_history(&mut context.messages);
    let cancelled = cancellation.is_cancelled();
    if cancelled {
        context.close_cancelled_tool_calls();
    }
    if let Some(stream) = stream {
        stream.finalizing();
    }
    let last_seq = stream.map(|s| s.snapshot().last_seq + 2);
    let summary = match &result {
        Ok(outcome) => AgentRunSummary {
            effects: outcome.effects.clone(),
            trace: outcome.trace.clone(),
            activities: Some(context.events.activities()),
            last_seq,
        },
        Err(_) => AgentRunSummary {
            effects: runtime::orchestrator::run_effects(context.effects, &context.navigation),
            trace: context.trace,
            activities: Some(context.events.activities()),
            last_seq,
        },
    };
    let result = if cancelled {
        Err(cancellation.check().unwrap_err())
    } else {
        result
    };
    // A provider/protocol failure has no committed assistant answer. Its tool receipts carry
    // run-local state (deferred activations, evidence bindings and candidate
    // handles), so feeding that suffix into the next run makes expired state
    // look reusable. Keep the user's question for an ordinary "retry" follow-up,
    // while retaining the detailed failure trace out of band in run_summary. A
    // cancelled run keeps its synthetic closing receipts so the persisted tool
    // protocol remains balanced, as required by the cancellation contract.
    let persisted_messages = if result.is_ok() || cancelled {
        context.messages.clone()
    } else {
        let mut messages = context.messages.clone();
        if let Some(current_user) = messages
            .iter()
            .rposition(|message| message.role == runtime::Role::User)
        {
            messages.truncate(current_user + 1);
        }
        messages
    };
    let observation_outcome = result.as_ref().ok().cloned();
    let observation_error_code = result
        .as_ref()
        .err()
        .map(|error| error.error_code.clone())
        .or_else(|| {
            observation_outcome
                .as_ref()
                .filter(|outcome| crate::observability::lifecycle::delivery_failed(outcome))
                .map(|_| "ANSWER_DELIVERY_FAILED".into())
        });
    let report = port.with_app(|state| {
        if summary
            .effects
            .iter()
            .any(|effect| matches!(effect, runtime::orchestrator::AgentEffect::Goto { .. }))
        {
            save_session(state, None);
        }
        let (status, outcome, error) = match &result {
            Ok(outcome) => (AgentAssistantStatus::Completed, Some(outcome.clone()), None),
            Err(error) => (
                if cancelled {
                    AgentAssistantStatus::Cancelled
                } else {
                    AgentAssistantStatus::Failed
                },
                None,
                Some(AgentTurnError {
                    error_code: error.error_code.clone(),
                    category: error.category.clone(),
                    message: error.message.clone(),
                }),
            ),
        };
        if let Err(error) = finalize_agent_turn(
            state,
            &prepared.turn_ref,
            status,
            outcome.clone(),
            error,
            Some(summary.clone()),
            &persisted_messages,
            &prepared.now,
        ) {
            return ExecutionReport {
                reply: err_reply(&error),
                unsaved: Some(UnsavedRun {
                    book_id: prepared.book.base.book_id.clone(),
                    session_id: prepared.turn_ref.session_id.clone(),
                    turn_id: prepared.turn_ref.turn_id.clone(),
                    summary,
                    outcome,
                    error: AgentTurnError {
                        error_code: error.error_code,
                        category: error.category,
                        message: error.message,
                    },
                }),
            };
        }
        if state
            .agent_history
            .active_by_book
            .get(&prepared.book.base.book_id)
            == Some(&prepared.turn_ref.session_id)
            && state.book.base.book_id == prepared.book.base.book_id
        {
            state.messages = persisted_messages;
        }
        if let Err(error) = reconcile_agent_history_review_jobs(state, &prepared.now) {
            return ExecutionReport::saved(err_reply(&error));
        }
        ExecutionReport::saved(match result {
            Ok(outcome) => ok_json(&outcome),
            Err(error) => err_reply(&error),
        })
    });
    if let Some(run) = observation_run {
        run.finish(
            observation_outcome.as_ref(),
            cancelled,
            if report.unsaved.is_some() {
                runtime::observation::PersistenceState::Failed
            } else {
                runtime::observation::PersistenceState::Saved
            },
            observation_error_code.as_deref(),
        );
    }
    report
}

struct RunEventFanout {
    stream: Arc<RunStream>,
    observation: Arc<dyn RunEventSink>,
}

impl RunEventSink for RunEventFanout {
    fn emit(&self, event: RuntimeEvent) {
        self.stream.emit(event.clone());
        self.observation.emit(event);
    }

    fn answer_patch(&self, patch: runtime::answer_stream::AnswerPatch) {
        self.stream.answer_patch(patch);
    }

    fn answer_first_patch(&self, elapsed_ms: f64) {
        self.observation.answer_first_patch(elapsed_ms);
    }

    fn evidence_accepted(&self, observation: runtime::run_events::EvidenceObservation) {
        self.observation.evidence_accepted(observation);
    }

    fn source_bindings(&self, bindings: &[runtime::orchestrator::SourceBinding]) {
        self.stream.source_bindings(bindings);
    }

    fn effect_created(&self, step_id: u32, effect: &runtime::orchestrator::AgentEffect) {
        self.stream.effect_created(step_id, effect);
    }
}

struct ActiveRun {
    stream: Arc<RunStream>,
    turn_ref: AgentTurnRef,
    cancellation: CancellationToken,
}
#[derive(Default)]
struct Slot {
    active: Option<ActiveRun>,
    boundary: bool,
    stopping: bool,
}

pub struct RunCoordinator {
    state: Arc<Mutex<AppState>>,
    slot: Mutex<Slot>,
    exited: Condvar,
    host_stop: Arc<AtomicBool>,
    unsaved: Mutex<Option<UnsavedRun>>,
    unsaved_stream: Mutex<Option<Arc<RunStream>>>,
    observability: Arc<crate::observability::ObservabilityRuntime>,
}

impl RunCoordinator {
    pub fn new(
        state: Arc<Mutex<AppState>>,
        host_stop: Arc<AtomicBool>,
        observability: Arc<crate::observability::ObservabilityRuntime>,
    ) -> Self {
        Self {
            state,
            slot: Mutex::new(Slot::default()),
            exited: Condvar::new(),
            host_stop,
            unsaved: Mutex::new(None),
            unsaved_stream: Mutex::new(None),
            observability,
        }
    }
    fn reserve(
        &self,
        body: &str,
        now: &str,
    ) -> Result<(PreparedAgentChat, CancellationToken, Arc<RunStream>), Reply> {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if slot.active.is_some() || slot.boundary || slot.stopping {
            return Err(Reply { status: 409, body: json!({ "error_code": "AGENT_RUN_BUSY", "category": "conflict",
                "message": "A Resident run or context transition is active", "turn_id": slot.active.as_ref().map(|r| &r.turn_ref.turn_id) }).to_string() });
        }
        let prepared = self
            .state
            .with_app(|state| prepare_agent_chat(state, body, now))?;
        let cancellation = CancellationToken::with_host_stop(self.host_stop.clone());
        let stream = RunStream::new(RunDescriptor {
            book_id: prepared.book.base.book_id.clone(),
            session_id: prepared.turn_ref.session_id.clone(),
            turn_id: prepared.turn_ref.turn_id.clone(),
        });
        self.state
            .with_app(|state| state.active_agent_stream = Some(Arc::downgrade(&stream)));
        slot.active = Some(ActiveRun {
            turn_ref: prepared.turn_ref.clone(),
            cancellation: cancellation.clone(),
            stream: stream.clone(),
        });
        Ok((prepared, cancellation, stream))
    }
    fn execute(
        &self,
        prepared: PreparedAgentChat,
        cancellation: CancellationToken,
        stream: Arc<RunStream>,
        adapter: &dyn ModelAdapter,
        on_exit: impl FnOnce(),
    ) -> Reply {
        let _running = RunGuard(self);
        let descriptor = stream.snapshot().descriptor;
        let result = execute_observed(
            &self.state,
            adapter,
            prepared,
            cancellation,
            Some(&stream),
            Some(&self.observability),
        );
        if let Some(unsaved) = result.unsaved {
            stream.finish(None, Some(json!(unsaved.error)));
            *self.unsaved.lock().unwrap() = Some(unsaved);
            *self.unsaved_stream.lock().unwrap() = Some(stream);
        } else {
            let view = self.state.with_app(|state| {
                state
                    .agent_history
                    .sessions
                    .iter()
                    .find(|s| s.id == descriptor.session_id)
                    .and_then(|s| s.turns.iter().find(|t| t.turn_id == descriptor.turn_id))
                    .map(|turn| json!(turn_view(&state.book, turn)))
            });
            stream.finish(view, None);
        }
        on_exit();
        result.reply
    }
    pub fn run(
        &self,
        body: &str,
        now: &str,
        adapter: &dyn ModelAdapter,
        on_started: impl FnOnce(),
        on_exit: impl FnOnce(),
    ) -> Reply {
        let (prepared, cancellation, stream) = match self.reserve(body, now) {
            Ok(run) => run,
            Err(reply) => return reply,
        };
        on_started();
        self.execute(prepared, cancellation, stream, adapter, on_exit)
    }
    pub fn start(
        self: &Arc<Self>,
        body: &str,
        now: &str,
        adapter: Box<dyn ModelAdapter + Send>,
        on_started: impl FnOnce(),
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Reply {
        let (prepared, cancellation, stream) = match self.reserve(body, now) {
            Ok(run) => run,
            Err(reply) => return reply,
        };
        let descriptor = stream.snapshot().descriptor;
        on_started();
        let coordinator = self.clone();
        std::thread::spawn(move || {
            coordinator.execute(prepared, cancellation, stream, adapter.as_ref(), on_exit);
        });
        Reply {
            status: 202,
            body: json!(descriptor).to_string(),
        }
    }
    pub fn stream(&self, turn_id: &str) -> Option<Arc<RunStream>> {
        {
            let slot = self.slot.lock().unwrap();
            if let Some(active) = slot
                .active
                .as_ref()
                .filter(|r| r.turn_ref.turn_id == turn_id)
            {
                return Some(active.stream.clone());
            }
        }
        if let Some(stream) = self
            .unsaved_stream
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.snapshot().descriptor.turn_id == turn_id)
        {
            return Some(stream.clone());
        }
        self.state.with_app(|state| {
            state
                .agent_history
                .sessions
                .iter()
                .filter(|s| s.book_id == state.book.base.book_id)
                .find_map(|session| {
                    session
                        .turns
                        .iter()
                        .find(|t| t.turn_id == turn_id)
                        .map(|turn| {
                            let execution = match turn.status {
                                AgentAssistantStatus::Completed => "completed",
                                AgentAssistantStatus::Cancelled => "cancelled",
                                AgentAssistantStatus::Failed => "failed",
                                AgentAssistantStatus::PendingAssistant => "interrupted",
                            };
                            RunStream::from_snapshot(RunSnapshot {
                                descriptor: RunDescriptor {
                                    book_id: session.book_id.clone(),
                                    session_id: session.id.clone(),
                                    turn_id: turn.turn_id.clone(),
                                },
                                last_seq: turn
                                    .run_summary
                                    .as_ref()
                                    .and_then(|s| s.last_seq)
                                    .unwrap_or(0),
                                execution_state: execution.into(),
                                persistence_state: if turn.status
                                    == AgentAssistantStatus::PendingAssistant
                                {
                                    "failed"
                                } else {
                                    "saved"
                                }
                                .into(),
                                activities: turn
                                    .run_summary
                                    .as_ref()
                                    .and_then(|s| s.activities.clone())
                                    .unwrap_or_default(),
                                reader_state: None,
                                effects: Vec::new(),
                                draft: None,
                                final_view: Some(json!(turn_view(&state.book, turn))),
                                error: None,
                            })
                        })
                })
        })
    }
    pub fn cancel_run(&self, turn_id: &str) -> Option<RunSnapshot> {
        {
            let slot = self.slot.lock().unwrap();
            if let Some(active) = slot
                .active
                .as_ref()
                .filter(|r| r.turn_ref.turn_id == turn_id)
            {
                active.cancellation.cancel();
                active.stream.cancelling();
            }
        }
        self.stream(turn_id).map(|s| s.snapshot())
    }
    pub fn unsaved_run(&self) -> Option<UnsavedRun> {
        self.unsaved
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    /// Requests stop; the slot remains owned until execution AND persistence exit.
    pub fn cancel(&self) -> Option<String> {
        let slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.active.as_ref().map(|active| {
            active.cancellation.cancel();
            active.stream.cancelling();
            active.turn_ref.turn_id.clone()
        })
    }
    pub fn with_boundary<R>(&self, operation: impl FnOnce() -> R) -> R {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        while slot.boundary {
            slot = self
                .exited
                .wait(slot)
                .unwrap_or_else(|error| error.into_inner());
        }
        slot.boundary = true;
        if let Some(active) = &slot.active {
            active.cancellation.cancel();
            active.stream.cancelling();
        }
        self.exited.notify_all();
        while slot.active.is_some() {
            slot = self
                .exited
                .wait(slot)
                .unwrap_or_else(|error| error.into_inner());
        }
        drop(slot);
        let _boundary = BoundaryGuard(self);
        operation()
    }
    #[cfg(test)]
    pub(crate) fn wait_until_cancelling(&self) {
        let slot = self.slot.lock().unwrap();
        let (_slot, result) = self
            .exited
            .wait_timeout_while(slot, std::time::Duration::from_secs(15), |slot| {
                !slot
                    .active
                    .as_ref()
                    .is_some_and(|active| active.cancellation.is_cancelled())
            })
            .unwrap();
        assert!(!result.timed_out(), "boundary never requested cancellation");
    }
    pub fn stop_and_wait(&self) {
        self.slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .stopping = true;
        self.with_boundary(|| ());
    }
    pub(crate) fn deletes_active_session(&self, body: &str) -> bool {
        let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.active.as_ref().is_some_and(|active| {
            value["session_id"].as_str() == Some(active.turn_ref.session_id.as_str())
        })
    }
}
struct RunGuard<'a>(&'a RunCoordinator);
impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.0
            .slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active = None;
        self.0.exited.notify_all();
    }
}
struct BoundaryGuard<'a>(&'a RunCoordinator);
impl Drop for BoundaryGuard<'_> {
    fn drop(&mut self) {
        self.0
            .slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .boundary = false;
        self.0.exited.notify_all();
    }
}

pub(crate) fn recover_pending(
    history: &mut AgentHistory,
    path: &Option<PathBuf>,
) -> Result<(), ToolError> {
    let mut candidate = history.clone();
    let mut changed = false;
    for turn in candidate
        .sessions
        .iter_mut()
        .flat_map(|session| &mut session.turns)
    {
        if turn.status == AgentAssistantStatus::PendingAssistant {
            turn.status = AgentAssistantStatus::Failed;
            turn.error = Some(AgentTurnError {
                error_code: "INTERRUPTED".into(),
                category: "interrupted".into(),
                message: "The previous Reader process stopped before this run finished".into(),
            });
            changed = true;
        }
    }
    if changed {
        save_agent_history_path(path, &candidate)?;
        *history = candidate;
    }
    Ok(())
}
