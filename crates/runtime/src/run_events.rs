//! Execution facts shared by live observers and durable summaries. No model text or arguments.
use crate::{
    provider_stream::ModelUsage, AdapterError, AgentRequestPlan, AssistantTurn, CompletionRequest,
    ModelAdapter, ParsedResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    Running,
    Succeeded,
    NoResult,
    Rejected,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RunActivity {
    pub step_id: u32,
    pub parent_step_id: Option<u32>,
    pub kind: String,
    pub name: String,
    pub label: String,
    pub status: ActivityStatus,
    pub started_ms: Option<f64>,
    pub duration_ms: Option<f64>,
    pub result_count: Option<u32>,
    pub error_code: Option<String>,
    /// Backward-compatible aggregate used by existing budgets and UI projections.
    pub usage_total_tokens: Option<u32>,
    /// Provider-reported cumulative snapshot. It is never added to usage_total_tokens.
    pub usage: Option<ModelUsage>,
    /// Milliseconds from this model activity's start to its first non-empty text delta.
    pub model_first_text_ms: Option<f64>,
    pub model_name: Option<String>,
    pub model_name_source: Option<String>,
    pub accepted_evidence_count: Option<u32>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RuntimeEvent {
    pub elapsed_ms: f64,
    pub activity: RunActivity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceObservation {
    pub step_id: u32,
    pub accepted_count: u32,
    pub evidence_refs: Vec<String>,
}

pub trait RunEventSink: Send + Sync {
    fn emit(&self, event: RuntimeEvent);
    fn answer_patch(&self, _patch: crate::answer_stream::AnswerPatch) {}
    fn answer_first_patch(&self, _elapsed_ms: f64) {}
    fn evidence_accepted(&self, _observation: EvidenceObservation) {}
    fn source_bindings(&self, _bindings: &[crate::orchestrator::SourceBinding]) {}
    fn effect_created(&self, _step_id: u32, _effect: &crate::orchestrator::AgentEffect) {}
}
struct State {
    next: u32,
    answer_id: u32,
    answer_revision: u32,
    activities: Vec<RunActivity>,
    parent: Option<u32>,
    purpose: &'static str,
    answer_first_patch_ms: Option<f64>,
}
#[derive(Clone)]
pub struct RunEvents {
    start: Instant,
    state: Arc<Mutex<State>>,
    sink: Option<Arc<dyn RunEventSink>>,
}
impl Default for RunEvents {
    fn default() -> Self {
        Self::new(None)
    }
}
impl RunEvents {
    pub fn new(sink: Option<Arc<dyn RunEventSink>>) -> Self {
        Self::with_start(Instant::now(), sink)
    }

    pub fn with_start(start: Instant, sink: Option<Arc<dyn RunEventSink>>) -> Self {
        Self {
            start,
            state: Arc::new(Mutex::new(State {
                next: 0,
                answer_id: 0,
                answer_revision: 0,
                activities: Vec::new(),
                parent: None,
                purpose: "outer",
                answer_first_patch_ms: None,
            })),
            sink,
        }
    }
    pub fn answer_identity(&self, repair: bool) -> (u32, u32) {
        let mut state = self.state.lock().unwrap();
        if repair {
            state.answer_revision += 1;
        } else {
            state.answer_id += 1;
            state.answer_revision = 0;
        }
        (state.answer_id, state.answer_revision)
    }
    pub fn answer_patch(&self, patch: crate::answer_stream::AnswerPatch) {
        let first_patch = if patch.view.is_some() {
            let mut state = self.state.lock().unwrap();
            if state.answer_first_patch_ms.is_none() {
                let elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
                state.answer_first_patch_ms = Some(elapsed_ms);
                Some(elapsed_ms)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(sink) = &self.sink {
            if let Some(elapsed_ms) = first_patch {
                sink.answer_first_patch(elapsed_ms);
            }
            sink.answer_patch(patch);
        }
    }
    pub fn answer_first_patch_ms(&self) -> Option<f64> {
        self.state.lock().unwrap().answer_first_patch_ms
    }
    pub fn source_bindings(&self, bindings: &[crate::orchestrator::SourceBinding]) {
        if let Some(sink) = &self.sink {
            sink.source_bindings(bindings);
        }
    }
    pub fn effect_created(&self, step_id: u32, effect: &crate::orchestrator::AgentEffect) {
        if let Some(sink) = &self.sink {
            sink.effect_created(step_id, effect);
        }
    }
    pub fn evidence_accepted(&self, step_id: u32, ranges: &[read_tools::EvidenceRange]) {
        if ranges.is_empty() {
            return;
        }
        let evidence_refs = ranges
            .iter()
            .take(crate::observation::MAX_OBSERVATION_SOURCE_REFS)
            .map(|range| {
                if range.start_lid == range.end_lid {
                    range.start_lid.clone()
                } else {
                    format!("{}..{}", range.start_lid, range.end_lid)
                }
            })
            .collect();
        if let Some(sink) = &self.sink {
            sink.evidence_accepted(EvidenceObservation {
                step_id,
                accepted_count: ranges.len().min(u32::MAX as usize) as u32,
                evidence_refs,
            });
        }
    }
    pub fn activities(&self) -> Vec<RunActivity> {
        self.state.lock().unwrap().activities.clone()
    }
    pub fn scope(&self, parent: Option<u32>, purpose: &'static str) -> EventScope {
        let mut state = self.state.lock().unwrap();
        let previous = (state.parent, state.purpose);
        state.parent = parent;
        state.purpose = purpose;
        EventScope {
            events: self.clone(),
            previous,
        }
    }
    fn publish(&self, activity: RunActivity) {
        if let Some(sink) = &self.sink {
            sink.emit(RuntimeEvent {
                elapsed_ms: self.start.elapsed().as_secs_f64() * 1000.0,
                activity,
            });
        }
    }
    pub fn begin(&self, kind: &str, name: &str, label: &str, started: bool) -> RunActivity {
        let mut state = self.state.lock().unwrap();
        state.next += 1;
        let activity = RunActivity {
            step_id: state.next,
            parent_step_id: state.parent,
            kind: kind.into(),
            name: name.into(),
            label: label.into(),
            status: ActivityStatus::Running,
            started_ms: started.then(|| self.start.elapsed().as_secs_f64() * 1000.0),
            duration_ms: None,
            result_count: None,
            error_code: None,
            usage_total_tokens: None,
            usage: None,
            model_first_text_ms: None,
            model_name: None,
            model_name_source: None,
            accepted_evidence_count: None,
            evidence_refs: Vec::new(),
        };
        state.activities.push(activity.clone());
        drop(state);
        if started {
            self.publish(activity.clone());
        }
        activity
    }
    pub fn finish(
        &self,
        mut activity: RunActivity,
        status: ActivityStatus,
        usage: Option<u32>,
        error: Option<String>,
        count: Option<u32>,
    ) {
        activity.status = status;
        activity.duration_ms = activity
            .started_ms
            .map(|start| (self.start.elapsed().as_secs_f64() * 1000.0 - start).max(0.0));
        activity.usage_total_tokens = usage;
        activity.error_code = error;
        activity.result_count = count;
        self.state.lock().unwrap().activities[(activity.step_id - 1) as usize] = activity.clone();
        self.publish(activity);
    }
    fn finish_model(
        &self,
        mut activity: RunActivity,
        status: ActivityStatus,
        usage: Option<ModelUsage>,
        first_text_elapsed_ms: Option<f64>,
        error: Option<String>,
    ) {
        activity.status = status;
        activity.duration_ms = activity
            .started_ms
            .map(|start| (self.start.elapsed().as_secs_f64() * 1000.0 - start).max(0.0));
        activity.usage_total_tokens = usage.as_ref().and_then(|usage| usage.total_tokens);
        activity.usage = usage;
        activity.model_first_text_ms = activity
            .started_ms
            .zip(first_text_elapsed_ms)
            .map(|(start, first)| (first - start).max(0.0));
        activity.error_code = error;
        self.state.lock().unwrap().activities[(activity.step_id - 1) as usize] = activity.clone();
        self.publish(activity);
    }
    fn model<T>(
        &self,
        cancellation: &crate::run_context::CancellationToken,
        model_name: String,
        call: impl FnOnce() -> Result<T, AdapterError>,
        observation: impl FnOnce(Option<&T>) -> (Option<ModelUsage>, Option<f64>),
    ) -> Result<T, AdapterError> {
        cancellation
            .check()
            .map_err(|e| AdapterError { message: e.message })?;
        let purpose = self.state.lock().unwrap().purpose;
        let label = match purpose {
            "query" => "判断检索证据",
            "synthesize" => "综合原文",
            "selection" => "整理选区回答",
            "profile" => "处理阅读偏好",
            "compaction" => "整理对话上下文",
            "repair" => "整理回答来源",
            _ => "生成回答",
        };
        let mut activity = self.begin("model", purpose, label, true);
        activity.model_name = Some(model_name);
        activity.model_name_source = Some("configured".into());
        self.state.lock().unwrap().activities[(activity.step_id - 1) as usize] = activity.clone();
        let result = call();
        let status = if cancellation.is_cancelled() {
            ActivityStatus::Cancelled
        } else if result.is_ok() {
            ActivityStatus::Succeeded
        } else {
            ActivityStatus::Failed
        };
        let (usage, first_text_elapsed_ms) = observation(result.as_ref().ok());
        self.finish_model(
            activity,
            status,
            usage,
            first_text_elapsed_ms,
            result.as_ref().err().map(|_| "PROVIDER_ERROR".into()),
        );
        result
    }
}
pub struct EventScope {
    events: RunEvents,
    previous: (Option<u32>, &'static str),
}
impl Drop for EventScope {
    fn drop(&mut self) {
        let mut state = self.events.state.lock().unwrap();
        state.parent = self.previous.0;
        state.purpose = self.previous.1;
    }
}
pub fn purpose(adapter: &dyn ModelAdapter, name: &'static str) -> Option<EventScope> {
    adapter.run_events().map(|events| {
        let parent = events.state.lock().unwrap().parent;
        events.scope(parent, name)
    })
}

pub struct ObservedAdapter<'a> {
    pub inner: &'a dyn ModelAdapter,
    pub events: RunEvents,
    pub cancellation: crate::run_context::CancellationToken,
    pub runtime_profile: crate::ModelRuntimeProfile,
}
impl ModelAdapter for ObservedAdapter<'_> {
    fn stream_text_is_structured(&self) -> bool {
        self.inner.stream_text_is_structured()
    }
    fn complete_observed(
        &self,
        req: CompletionRequest,
        observer: &mut dyn crate::provider_stream::ModelObserver,
    ) -> Result<ParsedResponse, AdapterError> {
        let usage = std::cell::RefCell::new(None);
        let first_text_elapsed_ms = std::cell::Cell::new(None);
        let mut forward = |delta: crate::provider_stream::ModelDelta| {
            match &delta {
                crate::provider_stream::ModelDelta::Usage(snapshot) => {
                    usage.replace(Some(snapshot.clone()));
                }
                crate::provider_stream::ModelDelta::Text(text)
                    if !text.is_empty() && first_text_elapsed_ms.get().is_none() =>
                {
                    first_text_elapsed_ms
                        .set(Some(self.events.start.elapsed().as_secs_f64() * 1000.0));
                }
                _ => {}
            }
            observer.observe(delta);
        };
        self.events.model(
            &self.cancellation,
            self.runtime_profile.matched_model.clone(),
            || self.inner.complete_observed(req, &mut forward),
            |_value| (usage.borrow().clone(), first_text_elapsed_ms.get()),
        )
    }

    fn complete_structured_observed(
        &self,
        req: CompletionRequest,
        observer: &mut dyn crate::provider_stream::ModelObserver,
    ) -> Result<serde_json::Value, AdapterError> {
        let usage = std::cell::RefCell::new(None);
        let first_text_elapsed_ms = std::cell::Cell::new(None);
        let mut forward = |delta: crate::provider_stream::ModelDelta| {
            match &delta {
                crate::provider_stream::ModelDelta::Usage(snapshot) => {
                    usage.replace(Some(snapshot.clone()));
                }
                crate::provider_stream::ModelDelta::Text(text)
                    if !text.is_empty() && first_text_elapsed_ms.get().is_none() =>
                {
                    first_text_elapsed_ms
                        .set(Some(self.events.start.elapsed().as_secs_f64() * 1000.0));
                }
                _ => {}
            }
            observer.observe(delta);
        };
        self.events.model(
            &self.cancellation,
            self.runtime_profile.matched_model.clone(),
            || self.inner.complete_structured_observed(req, &mut forward),
            |_value| (usage.borrow().clone(), first_text_elapsed_ms.get()),
        )
    }

    fn chat_observed(
        &self,
        req: &AgentRequestPlan,
        observer: &mut dyn crate::provider_stream::ModelObserver,
    ) -> Result<AssistantTurn, AdapterError> {
        let usage = std::cell::RefCell::new(None);
        let first_text_elapsed_ms = std::cell::Cell::new(None);
        let mut forward = |delta: crate::provider_stream::ModelDelta| {
            match &delta {
                crate::provider_stream::ModelDelta::Usage(snapshot) => {
                    usage.replace(Some(snapshot.clone()));
                }
                crate::provider_stream::ModelDelta::Text(text)
                    if !text.is_empty() && first_text_elapsed_ms.get().is_none() =>
                {
                    first_text_elapsed_ms
                        .set(Some(self.events.start.elapsed().as_secs_f64() * 1000.0));
                }
                _ => {}
            }
            observer.observe(delta);
        };
        self.events.model(
            &self.cancellation,
            self.runtime_profile.matched_model.clone(),
            || self.inner.chat_observed(req, &mut forward),
            |value| {
                let usage = usage.borrow().clone().or_else(|| {
                    value.and_then(|turn| {
                        turn.usage_total_tokens.map(|total_tokens| ModelUsage {
                            total_tokens: Some(total_tokens),
                            ..Default::default()
                        })
                    })
                });
                (usage, first_text_elapsed_ms.get())
            },
        )
    }

    fn run_events(&self) -> Option<RunEvents> {
        Some(self.events.clone())
    }
    fn set_run_cancellation(&self, token: crate::run_context::CancellationToken) {
        self.inner.set_run_cancellation(token);
    }
    fn model_runtime_profile(&self) -> crate::ModelRuntimeProfile {
        self.runtime_profile.clone()
    }
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        self.complete_observed(req, &mut crate::provider_stream::ignore)
    }
    fn complete_structured(
        &self,
        req: CompletionRequest,
    ) -> Result<serde_json::Value, AdapterError> {
        self.complete_structured_observed(req, &mut crate::provider_stream::ignore)
    }
    fn chat(&self, req: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
        self.chat_observed(req, &mut crate::provider_stream::ignore)
    }
}

pub fn tool_result(result: &str) -> (ActivityStatus, Option<String>, Option<u32>) {
    let value: serde_json::Value = serde_json::from_str(result).unwrap_or_default();
    let error = value
        .get("error_code")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let count = [
        "matches",
        "results",
        "items",
        "candidates",
        "sources",
        "evidence",
        "hits",
    ]
    .iter()
    .find_map(|key| {
        value
            .get(key)
            .and_then(|v| v.as_array())
            .map(|v| v.len() as u32)
    })
    .or_else(|| value.as_array().map(|v| v.len() as u32));
    let status = if error.as_deref() == Some("AGENT_RUN_CANCELLED") {
        ActivityStatus::Cancelled
    } else if error.is_some() {
        match value["category"].as_str() {
            Some("validation" | "permission" | "loop") => ActivityStatus::Rejected,
            _ => ActivityStatus::Failed,
        }
    } else if value["status"] == "invalid_plan" {
        ActivityStatus::Rejected
    } else if count == Some(0)
        || value["sufficient"] == false
        || matches!(
            value["status"].as_str(),
            Some("no_result" | "insufficient" | "unresolved" | "ambiguous")
        )
    {
        ActivityStatus::NoResult
    } else {
        ActivityStatus::Succeeded
    };
    (status, error, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Collector(std::sync::mpsc::Sender<RuntimeEvent>);
    impl RunEventSink for Collector {
        fn emit(&self, event: RuntimeEvent) {
            self.0.send(event).unwrap();
        }
    }
    #[test]
    fn model_start_is_observable_before_result_and_finishes_once() {
        let (send, receive) = std::sync::mpsc::channel();
        let events = RunEvents::new(Some(Arc::new(Collector(send))));
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            events
                .model(
                    &Default::default(),
                    "test-model".into(),
                    || {
                        wait.recv().unwrap();
                        Ok(7u32)
                    },
                    |v| {
                        (
                            v.copied().map(|total_tokens| ModelUsage {
                                total_tokens: Some(total_tokens),
                                ..Default::default()
                            }),
                            None,
                        )
                    },
                )
                .unwrap();
            events.activities()
        });
        assert_eq!(
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .activity
                .status,
            ActivityStatus::Running
        );
        assert!(receive.try_recv().is_err());
        release.send(()).unwrap();
        let finished = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(finished.activity.status, ActivityStatus::Succeeded);
        assert_eq!(finished.activity.usage_total_tokens, Some(7));
        assert_eq!(worker.join().unwrap(), vec![finished.activity]);
    }
    #[test]
    fn rejection_has_no_start_or_duration_and_empty_result_is_distinct() {
        let (send, receive) = std::sync::mpsc::channel();
        let events = RunEvents::new(Some(Arc::new(Collector(send))));
        let rejected = events.begin("tool", "book.text", "读取原文", false);
        assert!(receive.try_recv().is_err());
        events.finish(
            rejected,
            ActivityStatus::Rejected,
            None,
            Some("INVALID_RANGE".into()),
            None,
        );
        let finished = receive.recv().unwrap().activity;
        assert_eq!(finished.started_ms, None);
        assert_eq!(finished.duration_ms, None);
        assert_eq!(tool_result(r#"{"results":[]}"#).0, ActivityStatus::NoResult);
    }
    struct RecordingAdapter(std::sync::Mutex<Vec<(String, String)>>);
    impl ModelAdapter for RecordingAdapter {
        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.0.lock().unwrap().push((req.system, req.user));
            Ok(ParsedResponse {
                sufficient: true,
                answer: Some("same answer".into()),
                citations: Vec::new(),
                model_supplement: Vec::new(),
            })
        }

        fn chat(&self, _request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
            unreachable!("this equivalence fixture only exercises complete")
        }
    }

    #[test]
    fn observation_does_not_change_provider_request_or_response() {
        let direct = RecordingAdapter(std::sync::Mutex::new(Vec::new()));
        let observed_inner = RecordingAdapter(std::sync::Mutex::new(Vec::new()));
        let baseline = direct
            .complete(CompletionRequest {
                system: "fixed system".into(),
                user: "fixed user".into(),
            })
            .unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let observed = ObservedAdapter {
            inner: &observed_inner,
            events: RunEvents::new(Some(Arc::new(Collector(send)))),
            cancellation: Default::default(),
            runtime_profile: observed_inner.model_runtime_profile(),
        }
        .complete(CompletionRequest {
            system: "fixed system".into(),
            user: "fixed user".into(),
        })
        .unwrap();
        assert_eq!(*direct.0.lock().unwrap(), *observed_inner.0.lock().unwrap());
        assert_eq!(baseline.sufficient, observed.sufficient);
        assert_eq!(baseline.answer, observed.answer);
        assert_eq!(receive.try_iter().count(), 2);
    }

    struct PartialUsageAdapter;
    impl ModelAdapter for PartialUsageAdapter {
        fn complete_observed(
            &self,
            _req: CompletionRequest,
            observer: &mut dyn crate::provider_stream::ModelObserver,
        ) -> Result<ParsedResponse, AdapterError> {
            observer.observe(crate::provider_stream::ModelDelta::Usage(ModelUsage {
                total_tokens: Some(5),
                ..Default::default()
            }));
            observer.observe(crate::provider_stream::ModelDelta::Text("first".into()));
            observer.observe(crate::provider_stream::ModelDelta::Usage(ModelUsage {
                input_tokens: Some(5),
                output_tokens: Some(2),
                cached_input_tokens: Some(1),
                total_tokens: Some(7),
                ..Default::default()
            }));
            Err(AdapterError {
                message: "truncated".into(),
            })
        }

        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.complete_observed(req, &mut crate::provider_stream::ignore)
        }

        fn chat(&self, _request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
            unreachable!()
        }
    }

    #[test]
    fn model_failure_keeps_latest_usage_snapshot_and_first_text_time() {
        let (send, receive) = std::sync::mpsc::channel();
        let events = RunEvents::new(Some(Arc::new(Collector(send))));
        let observed = ObservedAdapter {
            inner: &PartialUsageAdapter,
            events,
            cancellation: Default::default(),
            runtime_profile: PartialUsageAdapter.model_runtime_profile(),
        };
        assert!(observed
            .complete(CompletionRequest {
                system: "system".into(),
                user: "user".into(),
            })
            .is_err());
        let emitted = receive.try_iter().collect::<Vec<_>>();
        assert_eq!(emitted.len(), 2);
        let finished = &emitted[1].activity;
        assert_eq!(finished.status, ActivityStatus::Failed);
        assert_eq!(finished.usage_total_tokens, Some(7));
        assert_eq!(
            finished.usage.as_ref().unwrap().cached_input_tokens,
            Some(1)
        );
        assert!(finished.model_first_text_ms.is_some());
    }

    #[test]
    fn first_safe_answer_patch_is_timed_once() {
        let events = RunEvents::default();
        let patch = crate::answer_stream::AnswerPatch {
            message_id: 1,
            revision: 0,
            operation: "replace".into(),
            view: Some(crate::orchestrator::AgentAnswerView {
                parts: Vec::new(),
                sources: Vec::new(),
            }),
        };
        events.answer_patch(patch.clone());
        let first = events.answer_first_patch_ms().unwrap();
        events.answer_patch(patch);
        assert_eq!(events.answer_first_patch_ms(), Some(first));
    }

    #[test]
    fn export_activity_types() {
        RunActivity::export_all_to("../../packages/web/src/generated").unwrap();
        RuntimeEvent::export_all_to("../../packages/web/src/generated").unwrap();
    }
}
