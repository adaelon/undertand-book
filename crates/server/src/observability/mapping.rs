use super::lifecycle::RunIdentity;
use super::policy::{safe_error_code, safe_purpose, safe_tool_name};
use super::queue::{ExportItem, ExportOperation};
use runtime::observation::{
    ExecutionState, ObservationCompleteness, ObservationEnvelope, ObservationKind,
    ObservationMetadata, ObservationSurface, TimingSource, TokenUsage, OBSERVATION_SCHEMA_VERSION,
};
use runtime::run_events::{ActivityStatus, EvidenceObservation, RuntimeEvent};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub struct ActivityMapper {
    ids: HashMap<u32, String>,
    revisions: HashMap<u32, u32>,
    last_events: HashMap<u32, RuntimeEvent>,
    max_spans: usize,
}

impl ActivityMapper {
    pub fn new(max_spans: usize) -> Self {
        Self {
            ids: HashMap::new(),
            revisions: HashMap::new(),
            last_events: HashMap::new(),
            max_spans,
        }
    }

    pub fn map(
        &mut self,
        identity: &RunIdentity,
        event: RuntimeEvent,
    ) -> Option<(ObservationEnvelope, ExportOperation)> {
        let is_new = !self.ids.contains_key(&event.activity.step_id);
        if is_new && self.ids.len() >= self.max_spans {
            return None;
        }
        let span_id = self
            .ids
            .entry(event.activity.step_id)
            .or_insert_with(|| uuid::Uuid::now_v7().to_string())
            .clone();
        let parent_span_id = event
            .activity
            .parent_step_id
            .and_then(|step| self.ids.get(&step).cloned())
            .or_else(|| Some(identity.root_span_id.clone()));
        let revision = self.revisions.entry(event.activity.step_id).or_insert(0);
        *revision += 1;
        let operation = if is_new {
            ExportOperation::Create
        } else {
            ExportOperation::Update
        };
        let kind = match event.activity.kind.as_str() {
            "model" => ObservationKind::Model,
            "tool" => ObservationKind::Tool,
            _ => ObservationKind::Activity,
        };
        let execution_state = match event.activity.status {
            ActivityStatus::Running => ExecutionState::Running,
            ActivityStatus::Succeeded | ActivityStatus::NoResult | ActivityStatus::Rejected => {
                ExecutionState::Completed
            }
            ActivityStatus::Failed => ExecutionState::Failed,
            ActivityStatus::Cancelled => ExecutionState::Cancelled,
        };
        let usage = event
            .activity
            .usage
            .clone()
            .map(|usage| {
                TokenUsage::provider_reported(
                    usage,
                    matches!(event.activity.status, ActivityStatus::Succeeded),
                )
            })
            .unwrap_or_else(TokenUsage::unknown);
        let registered_tool_name =
            (kind == ObservationKind::Tool).then(|| safe_tool_name(&event.activity.name));
        let purpose = (kind == ObservationKind::Model).then(|| safe_purpose(&event.activity.name));
        self.last_events
            .insert(event.activity.step_id, event.clone());
        Some((
            ObservationEnvelope {
                schema_version: OBSERVATION_SCHEMA_VERSION.into(),
                local_run_ref: identity.local_run_ref.clone(),
                span_id,
                parent_span_id,
                revision: *revision,
                surface: ObservationSurface::Resident,
                kind,
                observed_at: Some(identity.observed_at_elapsed(event.elapsed_ms)),
                elapsed_ms: Some(event.elapsed_ms),
                duration_ms: event.activity.duration_ms,
                timing_source: TimingSource::RuntimeAnchor,
                execution_state: Some(execution_state),
                delivery_state: None,
                persistence_state: None,
                usage,
                completeness: ObservationCompleteness::default(),
                metadata: ObservationMetadata {
                    thread_id: Some(identity.thread_id.clone()),
                    book_ref: Some(identity.book_ref.clone()),
                    registered_tool_name,
                    purpose,
                    error_code: safe_error_code(event.activity.error_code.as_deref()),
                    result_count: event.activity.result_count,
                    model_first_text_ms: event.activity.model_first_text_ms,
                    model_first_text_at: event.activity.model_first_text_ms.and_then(|first_ms| {
                        event
                            .activity
                            .started_ms
                            .map(|started_ms| identity.observed_at_elapsed(started_ms + first_ms))
                    }),
                    model_name: event.activity.model_name,
                    model_name_source: event.activity.model_name_source,
                    accepted_evidence_count: event.activity.accepted_evidence_count,
                    evidence_refs: event.activity.evidence_refs,
                    executed: event.activity.started_ms.is_some(),
                    ..Default::default()
                },
            },
            operation,
        ))
    }

    pub fn map_evidence(
        &mut self,
        identity: &RunIdentity,
        evidence: EvidenceObservation,
    ) -> Option<(ObservationEnvelope, ExportOperation)> {
        let mut event = self.last_events.get(&evidence.step_id)?.clone();
        event.activity.accepted_evidence_count = Some(
            event
                .activity
                .accepted_evidence_count
                .unwrap_or(0)
                .saturating_add(evidence.accepted_count),
        );
        for reference in evidence.evidence_refs {
            if event.activity.evidence_refs.len()
                >= runtime::observation::MAX_OBSERVATION_SOURCE_REFS
            {
                break;
            }
            if !event.activity.evidence_refs.contains(&reference) {
                event.activity.evidence_refs.push(reference);
            }
        }
        self.map(identity, event)
    }
}

pub fn export_item(
    observation: ObservationEnvelope,
    operation: ExportOperation,
    project: &str,
) -> ExportItem {
    let root_run_id = observation.local_run_ref.clone();
    let run_id = observation.span_id.clone();
    let parent_run_id = observation.parent_span_id.clone();
    let revision = observation.revision;
    let run_type = match observation.kind {
        ObservationKind::Model => "llm",
        ObservationKind::Tool => "tool",
        ObservationKind::Run | ObservationKind::Activity => "chain",
    };
    let name = observation
        .metadata
        .registered_tool_name
        .clone()
        .or_else(|| observation.metadata.purpose.clone())
        .unwrap_or_else(|| match observation.kind {
            ObservationKind::Run => "resident_run".into(),
            ObservationKind::Activity => "resident_activity".into(),
            ObservationKind::Model => "resident_model".into(),
            ObservationKind::Tool => "unknown_tool".into(),
        });
    let metadata = serde_json::to_value(&observation).unwrap_or(Value::Null);
    let usage_metadata = usage_metadata(&observation.usage);
    let token_event = observation
        .metadata
        .model_first_text_at
        .as_ref()
        .map(|time| json!({"name": "new_token", "time": time}));
    let payload = match operation {
        ExportOperation::Create => {
            let mut value = json!({
                "id": run_id,
                "parent_run_id": parent_run_id,
                "name": name,
                "run_type": run_type,
                "start_time": observation.observed_at.clone(),
                "session_name": project,
                "inputs": {},
                "extra": {
                    "metadata": {
                        "thread_id": observation.metadata.thread_id.clone(),
                        "ls_model_name": observation.metadata.model_name.clone(),
                        "ub_observation": metadata
                    }
                }
            });
            if observation.execution_state != Some(ExecutionState::Running) {
                value["end_time"] = observation
                    .observed_at
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null);
                value["outputs"] = json!({});
                if let Some(code) = &observation.metadata.error_code {
                    value["error"] = Value::String(code.clone());
                }
                if let Some(usage) = usage_metadata.clone() {
                    value["usage_metadata"] = usage;
                }
                if let Some(event) = token_event.clone() {
                    value["events"] = json!([event]);
                }
            }
            value
        }
        ExportOperation::Update => {
            let mut value = Map::new();
            value.insert(
                "end_time".into(),
                observation
                    .observed_at
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            value.insert("outputs".into(), json!({}));
            if let Some(code) = &observation.metadata.error_code {
                value.insert("error".into(), Value::String(code.clone()));
            }
            if let Some(usage) = usage_metadata {
                value.insert("usage_metadata".into(), usage);
            }
            if let Some(event) = token_event {
                value.insert("events".into(), json!([event]));
            }
            value.insert(
                "extra".into(),
                json!({
                    "metadata": {
                        "thread_id": observation.metadata.thread_id.clone(),
                        "ls_model_name": observation.metadata.model_name.clone(),
                        "ub_observation": metadata
                    }
                }),
            );
            Value::Object(value)
        }
    };
    ExportItem::new(
        root_run_id,
        run_id,
        parent_run_id,
        revision,
        operation,
        payload,
    )
}

fn usage_metadata(usage: &TokenUsage) -> Option<Value> {
    if usage.source != runtime::observation::UsageSource::ProviderReported {
        return None;
    }
    let mut value = Map::new();
    if let Some(tokens) = usage.input_tokens {
        value.insert("input_tokens".into(), json!(tokens));
    }
    if let Some(tokens) = usage.output_tokens {
        value.insert("output_tokens".into(), json!(tokens));
    }
    if let Some(tokens) = usage.total_tokens {
        value.insert("total_tokens".into(), json!(tokens));
    }
    let mut input_details = Map::new();
    if let Some(tokens) = usage.cached_input_tokens {
        input_details.insert("cache_read".into(), json!(tokens));
    }
    if let Some(tokens) = usage.cache_creation_input_tokens {
        input_details.insert("cache_creation".into(), json!(tokens));
    }
    if !input_details.is_empty() {
        value.insert("input_token_details".into(), Value::Object(input_details));
    }
    (!value.is_empty()).then_some(Value::Object(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::lifecycle::root_started;
    use runtime::run_events::{RunActivity, RuntimeEvent};

    #[test]
    fn basic_runs_api_payload_omits_trace_id_without_dotted_order() {
        let identity = RunIdentity::new("thread".into(), "book".into());
        let observation = root_started(&identity);
        let create = export_item(observation.clone(), ExportOperation::Create, "dev");
        let update = export_item(observation, ExportOperation::Update, "dev");

        assert!(create.payload.get("trace_id").is_none());
        assert!(create.payload.get("dotted_order").is_none());
        assert!(update.payload.get("trace_id").is_none());
        assert!(update.payload.get("dotted_order").is_none());
    }

    #[test]
    fn mapping_drops_content_canaries_and_preserves_rejection_semantics() {
        let identity = RunIdentity::new("thread".into(), "book".into());
        let mut mapper = ActivityMapper::new(10);
        let (observation, operation) = mapper
            .map(
                &identity,
                RuntimeEvent {
                    elapsed_ms: 4.0,
                    activity: RunActivity {
                        step_id: 1,
                        parent_step_id: None,
                        kind: "tool".into(),
                        name: "CANARY_PRIVATE_ARGUMENT".into(),
                        label: "CANARY_PRIVATE_LABEL".into(),
                        status: ActivityStatus::Rejected,
                        started_ms: None,
                        duration_ms: None,
                        result_count: None,
                        error_code: Some("provider CANARY_PRIVATE_BODY".into()),
                        usage_total_tokens: None,
                        usage: None,
                        model_first_text_ms: None,
                        model_name: None,
                        model_name_source: None,
                        accepted_evidence_count: None,
                        evidence_refs: Vec::new(),
                    },
                },
            )
            .unwrap();
        assert_eq!(operation, ExportOperation::Create);
        assert_eq!(
            observation.metadata.registered_tool_name.as_deref(),
            Some("unknown_tool")
        );
        assert!(!observation.metadata.executed);
        let exported = export_item(observation, operation, "dev");
        assert!(exported.payload["end_time"].is_string());
        assert_eq!(exported.payload["extra"]["metadata"]["thread_id"], "thread");
        let payload = serde_json::to_string(&exported.payload).unwrap();
        assert!(!payload.contains("CANARY_PRIVATE"));
    }

    #[test]
    fn equal_step_numbers_in_different_runs_never_share_span_identity() {
        let mut first_mapper = ActivityMapper::new(10);
        let mut second_mapper = ActivityMapper::new(10);
        let first_identity = RunIdentity::new("thread-a".into(), "book".into());
        let second_identity = RunIdentity::new("thread-b".into(), "book".into());
        let event = || RuntimeEvent {
            elapsed_ms: 1.0,
            activity: RunActivity {
                step_id: 1,
                parent_step_id: None,
                kind: "model".into(),
                name: "outer".into(),
                label: "answer".into(),
                status: ActivityStatus::Running,
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
        };
        let first = first_mapper.map(&first_identity, event()).unwrap().0;
        let second = second_mapper.map(&second_identity, event()).unwrap().0;
        assert_ne!(first.local_run_ref, second.local_run_ref);
        assert_ne!(first.span_id, second.span_id);
        assert_ne!(first.metadata.thread_id, second.metadata.thread_id);
    }

    #[test]
    fn ledger_enrichment_reuses_the_finished_tool_span_without_content() {
        let identity = RunIdentity::new("thread".into(), "book".into());
        let mut mapper = ActivityMapper::new(10);
        let activity = RunActivity {
            step_id: 1,
            parent_step_id: None,
            kind: "tool".into(),
            name: "book.text".into(),
            label: "CANARY_PRIVATE_PREVIEW".into(),
            status: ActivityStatus::Succeeded,
            started_ms: Some(1.0),
            duration_ms: Some(2.0),
            result_count: Some(3),
            error_code: None,
            usage_total_tokens: None,
            usage: None,
            model_first_text_ms: None,
            model_name: None,
            model_name_source: None,
            accepted_evidence_count: None,
            evidence_refs: Vec::new(),
        };
        let (finished, _) = mapper
            .map(
                &identity,
                RuntimeEvent {
                    elapsed_ms: 3.0,
                    activity,
                },
            )
            .unwrap();
        let (enriched, operation) = mapper
            .map_evidence(
                &identity,
                EvidenceObservation {
                    step_id: 1,
                    accepted_count: 1,
                    evidence_refs: vec!["1.1".into()],
                },
            )
            .unwrap();
        assert_eq!(operation, ExportOperation::Update);
        assert_eq!(enriched.span_id, finished.span_id);
        assert_eq!(enriched.revision, finished.revision + 1);
        assert_eq!(enriched.metadata.result_count, Some(3));
        assert_eq!(enriched.metadata.accepted_evidence_count, Some(1));
        assert_eq!(enriched.metadata.evidence_refs, vec!["1.1"]);
        let item = export_item(enriched, operation, "dev");
        assert!(!serde_json::to_string(&item.payload)
            .unwrap()
            .contains("CANARY_PRIVATE"));
    }
}
