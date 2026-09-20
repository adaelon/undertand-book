use runtime::observation::{
    DeliveryState, ExecutionState, ObservationCompleteness, ObservationEnvelope, ObservationKind,
    ObservationMetadata, ObservationSurface, PersistenceState, TimingSource, TokenUsage,
    OBSERVATION_SCHEMA_VERSION,
};
use runtime::orchestrator::OuterOutcome;
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone)]
pub struct RunIdentity {
    pub local_run_ref: String,
    pub root_span_id: String,
    pub thread_id: String,
    pub book_ref: String,
    pub observed_at: String,
    pub started_wall: SystemTime,
    pub started: Instant,
}

impl RunIdentity {
    pub fn new(thread_id: String, book_ref: String) -> Self {
        let root_span_id = uuid::Uuid::now_v7().to_string();
        let started_wall = SystemTime::now();
        let started = Instant::now();
        Self {
            local_run_ref: root_span_id.clone(),
            root_span_id,
            thread_id,
            book_ref,
            observed_at: format_system_time(started_wall),
            started_wall,
            started,
        }
    }

    pub fn observed_at_elapsed(&self, elapsed_ms: f64) -> String {
        format_system_time(
            self.started_wall + Duration::from_secs_f64((elapsed_ms.max(0.0)) / 1000.0),
        )
    }
}

fn format_system_time(value: SystemTime) -> String {
    time::OffsetDateTime::from(value)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

pub fn root_started(identity: &RunIdentity) -> ObservationEnvelope {
    ObservationEnvelope {
        schema_version: OBSERVATION_SCHEMA_VERSION.into(),
        local_run_ref: identity.local_run_ref.clone(),
        span_id: identity.root_span_id.clone(),
        parent_span_id: None,
        revision: 1,
        surface: ObservationSurface::Resident,
        kind: ObservationKind::Run,
        observed_at: Some(identity.observed_at.clone()),
        elapsed_ms: Some(0.0),
        duration_ms: None,
        timing_source: TimingSource::RuntimeAnchor,
        execution_state: Some(ExecutionState::Running),
        delivery_state: Some(DeliveryState::Pending),
        persistence_state: Some(PersistenceState::Pending),
        usage: TokenUsage::unknown(),
        completeness: ObservationCompleteness::default(),
        metadata: ObservationMetadata {
            thread_id: Some(identity.thread_id.clone()),
            book_ref: Some(identity.book_ref.clone()),
            purpose: Some("outer".into()),
            ..Default::default()
        },
    }
}

pub fn root_finished(
    identity: &RunIdentity,
    execution_state: ExecutionState,
    delivery_state: DeliveryState,
    persistence_state: PersistenceState,
    incomplete: bool,
    error_code: Option<String>,
    dropped_count: u64,
    answer_first_patch_ms: Option<f64>,
) -> ObservationEnvelope {
    let elapsed_ms = identity.started.elapsed().as_secs_f64() * 1000.0;
    let mut completeness = ObservationCompleteness::default();
    completeness.dropped_count = dropped_count;
    if dropped_count > 0 {
        completeness.coverage = runtime::observation::ObservationCoverage::Partial;
    }
    ObservationEnvelope {
        schema_version: OBSERVATION_SCHEMA_VERSION.into(),
        local_run_ref: identity.local_run_ref.clone(),
        span_id: identity.root_span_id.clone(),
        parent_span_id: None,
        revision: 2,
        surface: ObservationSurface::Resident,
        kind: ObservationKind::Run,
        observed_at: Some(identity.observed_at_elapsed(elapsed_ms)),
        elapsed_ms: Some(elapsed_ms),
        duration_ms: Some(elapsed_ms),
        timing_source: TimingSource::RuntimeAnchor,
        execution_state: Some(execution_state),
        delivery_state: Some(delivery_state),
        persistence_state: Some(persistence_state),
        usage: TokenUsage::unknown(),
        completeness,
        metadata: ObservationMetadata {
            thread_id: Some(identity.thread_id.clone()),
            book_ref: Some(identity.book_ref.clone()),
            purpose: Some("outer".into()),
            error_code,
            incomplete,
            executed: true,
            answer_first_patch_ms,
            ..Default::default()
        },
    }
}

pub(crate) fn delivery_failed(outcome: &OuterOutcome) -> bool {
    outcome
        .delivery_diagnostics
        .as_ref()
        .and_then(|diagnostics| diagnostics.repair.as_ref())
        .is_some_and(|repair| !repair.issues.is_empty())
}

pub fn business_states(
    outcome: Option<&OuterOutcome>,
    cancelled: bool,
    persistence_state: PersistenceState,
) -> (ExecutionState, DeliveryState, bool) {
    if cancelled {
        return (
            ExecutionState::Cancelled,
            DeliveryState::NotDelivered,
            outcome.is_some_and(|value| value.incomplete),
        );
    }
    match outcome {
        Some(outcome) => (
            ExecutionState::Completed,
            if delivery_failed(outcome) {
                DeliveryState::Failed
            } else {
                DeliveryState::Delivered
            },
            outcome.incomplete,
        ),
        None => (
            if persistence_state == PersistenceState::Unknown {
                ExecutionState::Interrupted
            } else {
                ExecutionState::Failed
            },
            DeliveryState::NotDelivered,
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime::orchestrator::{
        AnswerDeliveryAttemptDiagnostics, AnswerDeliveryDiagnostics, AnswerDeliveryIssue,
    };

    fn outcome(incomplete: bool, repair_issues: usize) -> OuterOutcome {
        let mut outcome = OuterOutcome {
            answer: Some("answer".into()),
            answer_view: None,
            incomplete,
            warning: None,
            turns: 1,
            tokens_spent: 1,
            effects: Vec::new(),
            trace: Vec::new(),
            profile_usage: Default::default(),
            memory_updates: Vec::new(),
            source_bindings: Vec::new(),
            delivery_diagnostics: None,
            request_audit: Default::default(),
        };
        outcome.delivery_diagnostics = Some(AnswerDeliveryDiagnostics {
            initial: AnswerDeliveryAttemptDiagnostics::default(),
            repair: Some(AnswerDeliveryAttemptDiagnostics {
                issues: (0..repair_issues)
                    .map(|_| AnswerDeliveryIssue {
                        error_code: "SOURCE_INVALID".into(),
                        start: None,
                        end: None,
                        trigger_value: Some("must-never-export".into()),
                        match_form: "test".into(),
                        source_channels: Vec::new(),
                    })
                    .collect(),
            }),
        });
        outcome
    }

    #[test]
    fn final_repair_not_incomplete_flag_decides_delivery() {
        let repaired = outcome(true, 0);
        assert_eq!(
            business_states(Some(&repaired), false, PersistenceState::Saved),
            (ExecutionState::Completed, DeliveryState::Delivered, true)
        );
        let failed = outcome(false, 1);
        assert_eq!(
            business_states(Some(&failed), false, PersistenceState::Saved).1,
            DeliveryState::Failed
        );
    }
}
