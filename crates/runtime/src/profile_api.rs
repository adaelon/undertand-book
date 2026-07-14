use memory::{
    Applicability, CollectionRule, EvidenceRef, FactSource, FactStatus, HistoricalBackfillJob,
    HistoricalBackfillJobStatus, MemoryStore, PendingTurnRef, ProfileFactCapture,
    ProfileGovernanceOutcome, ProfileGovernanceOutcomeKind, ProfilePayload, ProfilePayloadKind,
    ProfileScope, ProfileStatus, ReaderProfileSnapshot, Sensitivity, SnapshotItem,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileMemoryState {
    pub current_book_id: String,
    pub status: ProfileMemoryStatusView,
    pub snapshot: ProfileSnapshotView,
    pub facts: Vec<ProfileFactView>,
    pub pending_candidates: Vec<ProfileFactView>,
    pub evidence: Vec<ProfileEvidenceView>,
    pub collection_rules: Vec<ProfileCollectionRuleView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileCollectionRuleView {
    pub rule_id: String,
    pub payload_kind: String,
    pub semantic_key: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_value: Option<String>,
    pub applicability_kind: Option<String>,
    pub applicability_value: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct HistoricalBackfillSessionView {
    pub session_id: String,
    pub book_id: String,
    pub title: String,
    #[ts(type = "number")]
    pub latest_user_turn_ordinal: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct HistoricalBackfillJobView {
    pub job_id: String,
    pub session_id: String,
    pub book_id: String,
    #[ts(type = "number")]
    pub from_turn_exclusive: u64,
    #[ts(type = "number")]
    pub to_turn_inclusive: u64,
    #[ts(type = "number")]
    pub processed_through: u64,
    #[ts(type = "number")]
    pub completed_turns: u64,
    #[ts(type = "number")]
    pub total_turns: u64,
    pub status: String,
    #[ts(type = "number")]
    pub attempts: u32,
    pub candidate_fact_ids: Vec<String>,
    pub last_error: Option<ProfileReviewErrorView>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct HistoricalBackfillStateView {
    pub sessions: Vec<HistoricalBackfillSessionView>,
    pub jobs: Vec<HistoricalBackfillJobView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(deny_unknown_fields)]
pub struct HistoricalBackfillStartRequest {
    pub session_id: String,
    #[ts(type = "number")]
    pub from_turn_exclusive: u64,
    #[ts(type = "number")]
    pub to_turn_inclusive: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(deny_unknown_fields)]
pub struct HistoricalBackfillJobRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileFactDraftView {
    pub scope_kind: String,
    pub applicability_kind: String,
    pub applicability_value: Option<String>,
    pub payload_kind: String,
    pub payload_key: String,
    pub payload_value: String,
    pub sensitivity: String,
    pub valid_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileCollectionRuleMatcherView {
    pub payload_kind: String,
    pub semantic_key: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_value: Option<String>,
    pub applicability_kind: Option<String>,
    pub applicability_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum ProfileGovernanceActionRequest {
    Remember {
        operation_id: String,
        evidence_text: String,
        fact: ProfileFactDraftView,
    },
    Correct {
        operation_id: String,
        evidence_text: String,
        fact_id: String,
        payload_value: String,
        valid_until: Option<String>,
    },
    Forget {
        operation_id: String,
        fact_id: String,
    },
    Confirm {
        operation_id: String,
        fact_id: String,
    },
    Reject {
        operation_id: String,
        fact_id: String,
    },
    ChangeScope {
        operation_id: String,
        fact_id: String,
        scope_kind: String,
    },
    AddCollectionRule {
        operation_id: String,
        matcher: ProfileCollectionRuleMatcherView,
    },
    RemoveCollectionRule {
        operation_id: String,
        rule_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileGovernanceMutationRequest {
    #[ts(type = "number")]
    pub expected_document_revision: u64,
    pub action: ProfileGovernanceActionRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileGovernanceOutcomeView {
    pub operation_id: String,
    pub kind: String,
    #[ts(type = "number")]
    pub document_revision: u64,
    #[ts(type = "number")]
    pub projection_revision: u64,
    pub fact_ids: Vec<String>,
    pub collection_rule_ids: Vec<String>,
    pub excluded_evidence_ids: Vec<String>,
    pub removed_dependent_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileGovernanceResponseView {
    Applied {
        outcome: ProfileGovernanceOutcomeView,
    },
    NeedsSensitiveConfirmation {
        warning: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileMemoryStatusView {
    #[ts(type = "number")]
    pub document_revision: u64,
    #[ts(type = "number")]
    pub projection_revision: u64,
    pub profile_status: String,
    pub pending_sensitive_confirmation: bool,
    pub pending_review_jobs: u32,
    pub review_error: Option<ProfileReviewErrorView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileReviewErrorView {
    pub error_code: String,
    pub message: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileSnapshotView {
    #[ts(type = "number")]
    pub source_revision: u64,
    pub profile_status: String,
    pub global_core: Vec<ProfileSnapshotItemView>,
    pub applicable_global: Vec<ProfileSnapshotItemView>,
    pub book_state_core: Vec<ProfileSnapshotItemView>,
    pub profile_projection: Vec<ProfileSnapshotItemView>,
    pub pending_context: Vec<ProfilePendingTurnView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileSnapshotItemView {
    pub fact_id: String,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfilePendingTurnView {
    pub session_id: String,
    pub turn_id: String,
    #[ts(type = "number")]
    pub user_turn_ordinal: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileFactView {
    pub fact_id: String,
    pub scope_kind: String,
    pub scope_value: Option<String>,
    pub applicability_kind: String,
    pub applicability_value: Option<String>,
    pub payload_kind: String,
    pub payload_key: String,
    pub payload_value: String,
    pub source: String,
    pub capture: String,
    pub status: String,
    pub sensitivity: String,
    pub evidence_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub valid_until: Option<String>,
    pub supersedes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileEvidenceView {
    pub fact_id: String,
    pub evidence_id: String,
    pub kind: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub mem_id: Option<String>,
    pub book_id: Option<String>,
    pub lid: Option<String>,
    pub text: Option<String>,
}

pub fn build_profile_memory_state(
    store: &MemoryStore,
    snapshot: &ReaderProfileSnapshot,
    current_book_id: &str,
    pending_sensitive_confirmation: bool,
) -> ProfileMemoryState {
    let relevant_facts: Vec<_> = store
        .profile_facts()
        .iter()
        .filter(|fact| fact_is_relevant(fact, current_book_id))
        .collect();
    let mut facts: Vec<_> = relevant_facts
        .iter()
        .filter(|fact| fact.status != FactStatus::Pending)
        .map(|fact| fact_view(fact))
        .collect();
    facts.sort_by(|left, right| left.fact_id.cmp(&right.fact_id));
    let mut pending_candidates: Vec<_> = relevant_facts
        .iter()
        .filter(|fact| fact.status == FactStatus::Pending)
        .map(|fact| fact_view(fact))
        .collect();
    pending_candidates.sort_by(|left, right| left.fact_id.cmp(&right.fact_id));
    let mut evidence: Vec<_> = relevant_facts
        .iter()
        .flat_map(|fact| {
            fact.evidence
                .iter()
                .map(|evidence| evidence_view(store, &fact.fact_id, evidence))
        })
        .collect();
    evidence.sort_by(|left, right| {
        left.fact_id
            .cmp(&right.fact_id)
            .then_with(|| left.evidence_id.cmp(&right.evidence_id))
    });
    let mut collection_rules: Vec<_> = store
        .collection_rules()
        .iter()
        .filter(|rule| collection_rule_is_relevant(rule, current_book_id))
        .map(collection_rule_view)
        .collect();
    collection_rules.sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
    ProfileMemoryState {
        current_book_id: current_book_id.into(),
        status: ProfileMemoryStatusView {
            document_revision: store.document_revision(),
            projection_revision: store.projection_revision(),
            profile_status: profile_status(snapshot.profile_status).into(),
            pending_sensitive_confirmation,
            pending_review_jobs: u32::try_from(
                store
                    .review_state()
                    .review_jobs
                    .iter()
                    .filter(|job| job.status != memory::ReviewJobStatus::Completed)
                    .count(),
            )
            .unwrap_or(u32::MAX),
            review_error: store.review_state().last_error.as_ref().map(|error| {
                ProfileReviewErrorView {
                    error_code: error.error_code.clone(),
                    message: error.message.clone(),
                    occurred_at: error.occurred_at.clone(),
                }
            }),
        },
        snapshot: snapshot_view(snapshot),
        facts,
        pending_candidates,
        evidence,
        collection_rules,
    }
}

pub fn profile_governance_outcome_view(
    outcome: ProfileGovernanceOutcome,
) -> ProfileGovernanceOutcomeView {
    ProfileGovernanceOutcomeView {
        operation_id: outcome.operation_id,
        kind: governance_outcome_kind(outcome.kind).into(),
        document_revision: outcome.document_revision,
        projection_revision: outcome.projection_revision,
        fact_ids: outcome.fact_ids,
        collection_rule_ids: outcome.collection_rule_ids,
        excluded_evidence_ids: outcome.excluded_evidence_ids,
        removed_dependent_fact_ids: outcome.removed_dependent_fact_ids,
    }
}

pub fn historical_backfill_job_view(job: &HistoricalBackfillJob) -> HistoricalBackfillJobView {
    HistoricalBackfillJobView {
        job_id: job.job_id.clone(),
        session_id: job.session_id.clone(),
        book_id: job.book_id.clone(),
        from_turn_exclusive: job.from_turn_exclusive,
        to_turn_inclusive: job.to_turn_inclusive,
        processed_through: job.processed_through,
        completed_turns: job
            .processed_through
            .saturating_sub(job.from_turn_exclusive),
        total_turns: job
            .to_turn_inclusive
            .saturating_sub(job.from_turn_exclusive),
        status: historical_backfill_status(job.status).into(),
        attempts: job.attempts,
        candidate_fact_ids: job.candidate_fact_ids.clone(),
        last_error: job.last_error.as_ref().map(|error| ProfileReviewErrorView {
            error_code: error.error_code.clone(),
            message: error.message.clone(),
            occurred_at: error.occurred_at.clone(),
        }),
        created_at: job.created_at.clone(),
        updated_at: job.updated_at.clone(),
    }
}

fn fact_is_relevant(fact: &memory::ProfileFact, current_book_id: &str) -> bool {
    matches!(fact.scope, ProfileScope::Global)
        || matches!(&fact.scope, ProfileScope::Book { book_id } if book_id == current_book_id)
}

fn collection_rule_is_relevant(rule: &CollectionRule, current_book_id: &str) -> bool {
    rule.matcher.scope.as_ref().is_none_or(|scope| {
        matches!(scope, ProfileScope::Global)
            || matches!(scope, ProfileScope::Book { book_id } if book_id == current_book_id)
    })
}

fn collection_rule_view(rule: &CollectionRule) -> ProfileCollectionRuleView {
    let (scope_kind, scope_value) = rule
        .matcher
        .scope
        .as_ref()
        .map(scope_view)
        .unwrap_or((None, None));
    let (applicability_kind, applicability_value) = rule
        .matcher
        .applicability
        .as_ref()
        .map(applicability_view)
        .unwrap_or((None, None));
    ProfileCollectionRuleView {
        rule_id: rule.rule_id.clone(),
        payload_kind: payload_kind(rule.matcher.payload_kind).into(),
        semantic_key: rule.matcher.semantic_key.clone(),
        scope_kind,
        scope_value,
        applicability_kind,
        applicability_value,
        created_at: rule.created_at.clone(),
    }
}

fn scope_view(scope: &ProfileScope) -> (Option<String>, Option<String>) {
    match scope {
        ProfileScope::Global => (Some("global".into()), None),
        ProfileScope::Book { book_id } => (Some("book".into()), Some(book_id.clone())),
    }
}

fn applicability_view(applicability: &Applicability) -> (Option<String>, Option<String>) {
    match applicability {
        Applicability::Any => (Some("any".into()), None),
        Applicability::ContentProfile { profile_id } => {
            (Some("content_profile".into()), Some(profile_id.clone()))
        }
        Applicability::PaperSubtype { subtype } => {
            (Some("paper_subtype".into()), Some(subtype.clone()))
        }
        Applicability::Domain { domain } => (Some("domain".into()), Some(domain.clone())),
    }
}

fn snapshot_view(snapshot: &ReaderProfileSnapshot) -> ProfileSnapshotView {
    ProfileSnapshotView {
        source_revision: snapshot.source_revision,
        profile_status: profile_status(snapshot.profile_status).into(),
        global_core: snapshot
            .global_core
            .iter()
            .map(snapshot_item_view)
            .collect(),
        applicable_global: snapshot
            .applicable_global
            .iter()
            .map(snapshot_item_view)
            .collect(),
        book_state_core: snapshot
            .book_state_core
            .iter()
            .map(snapshot_item_view)
            .collect(),
        profile_projection: snapshot
            .profile_projection
            .iter()
            .map(snapshot_item_view)
            .collect(),
        pending_context: snapshot
            .pending_context
            .iter()
            .map(pending_turn_view)
            .collect(),
    }
}

fn snapshot_item_view(item: &SnapshotItem) -> ProfileSnapshotItemView {
    ProfileSnapshotItemView {
        fact_id: item.fact_id.clone(),
        status: fact_status(item.status).into(),
        text: item.text.clone(),
    }
}

fn pending_turn_view(pending: &PendingTurnRef) -> ProfilePendingTurnView {
    ProfilePendingTurnView {
        session_id: pending.session_id.clone(),
        turn_id: pending.turn_id.clone(),
        user_turn_ordinal: pending.user_turn_ordinal,
        text: pending.text.clone(),
    }
}

fn fact_view(fact: &memory::ProfileFact) -> ProfileFactView {
    let (scope_kind, scope_value) = match &fact.scope {
        ProfileScope::Global => ("global", None),
        ProfileScope::Book { book_id } => ("book", Some(book_id.clone())),
    };
    let (applicability_kind, applicability_value) = match &fact.applicability {
        Applicability::Any => ("any", None),
        Applicability::ContentProfile { profile_id } => {
            ("content_profile", Some(profile_id.clone()))
        }
        Applicability::PaperSubtype { subtype } => ("paper_subtype", Some(subtype.clone())),
        Applicability::Domain { domain } => ("domain", Some(domain.clone())),
    };
    let (payload_kind, payload_key, payload_value) = payload_view(&fact.payload);
    ProfileFactView {
        fact_id: fact.fact_id.clone(),
        scope_kind: scope_kind.into(),
        scope_value,
        applicability_kind: applicability_kind.into(),
        applicability_value,
        payload_kind,
        payload_key,
        payload_value,
        source: fact_source(fact.source).into(),
        capture: fact_capture(fact.capture).into(),
        status: fact_status(fact.status).into(),
        sensitivity: sensitivity(fact.sensitivity).into(),
        evidence_ids: fact.evidence.iter().map(EvidenceRef::evidence_id).collect(),
        created_at: fact.created_at.clone(),
        updated_at: fact.updated_at.clone(),
        valid_until: fact.valid_until.clone(),
        supersedes: fact.supersedes.clone(),
    }
}

fn payload_view(payload: &ProfilePayload) -> (String, String, String) {
    match payload {
        ProfilePayload::Background(claim) => {
            ("background".into(), claim.key.clone(), claim.value.clone())
        }
        ProfilePayload::Capability(claim) => {
            ("capability".into(), claim.key.clone(), claim.value.clone())
        }
        ProfilePayload::Goal(claim) => ("goal".into(), claim.key.clone(), claim.value.clone()),
        ProfilePayload::ExplanationPreference(claim) => (
            "explanation_preference".into(),
            claim.key.clone(),
            claim.value.clone(),
        ),
        ProfilePayload::Constraint(claim) => {
            ("constraint".into(), claim.key.clone(), claim.value.clone())
        }
        ProfilePayload::Extension {
            namespace,
            key,
            value,
        } => (
            "extension".into(),
            format!("{namespace}:{key}"),
            serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
        ),
    }
}

fn evidence_view(
    store: &MemoryStore,
    fact_id: &str,
    evidence: &EvidenceRef,
) -> ProfileEvidenceView {
    let mut view = ProfileEvidenceView {
        fact_id: fact_id.into(),
        evidence_id: evidence.evidence_id(),
        kind: String::new(),
        session_id: None,
        turn_id: None,
        mem_id: None,
        book_id: None,
        lid: None,
        text: None,
    };
    match evidence {
        EvidenceRef::Turn {
            session_id,
            turn_id,
        } => {
            view.kind = "turn".into();
            view.session_id = Some(session_id.clone());
            view.turn_id = Some(turn_id.clone());
        }
        EvidenceRef::MemoryRecord { mem_id } => {
            view.kind = "memory_record".into();
            view.mem_id = Some(mem_id.clone());
            view.text = store
                .profile_evidence_record(mem_id)
                .map(|record| record.content.clone());
        }
        EvidenceRef::BookLocation { book_id, lid } => {
            view.kind = "book_location".into();
            view.book_id = Some(book_id.clone());
            view.lid = Some(lid.clone());
        }
    }
    view
}

fn profile_status(status: ProfileStatus) -> &'static str {
    match status {
        ProfileStatus::Current => "current",
        ProfileStatus::Stale => "stale",
    }
}

fn fact_status(status: FactStatus) -> &'static str {
    match status {
        FactStatus::Pending => "pending",
        FactStatus::Provisional => "provisional",
        FactStatus::Confirmed => "confirmed",
        FactStatus::Superseded => "superseded",
        FactStatus::Expired => "expired",
    }
}

fn fact_source(source: FactSource) -> &'static str {
    match source {
        FactSource::DeterministicBehavior => "deterministic_behavior",
        FactSource::UserStated => "user_stated",
        FactSource::AgentInferred => "agent_inferred",
    }
}

fn fact_capture(capture: ProfileFactCapture) -> &'static str {
    match capture {
        ProfileFactCapture::CurrentInteraction => "current_interaction",
        ProfileFactCapture::HistoricalBackfill => "historical_backfill",
    }
}

fn historical_backfill_status(status: HistoricalBackfillJobStatus) -> &'static str {
    match status {
        HistoricalBackfillJobStatus::Queued => "queued",
        HistoricalBackfillJobStatus::Running => "running",
        HistoricalBackfillJobStatus::Retryable => "retryable",
        HistoricalBackfillJobStatus::Cancelled => "cancelled",
        HistoricalBackfillJobStatus::Completed => "completed",
    }
}

fn sensitivity(value: Sensitivity) -> &'static str {
    match value {
        Sensitivity::Normal => "normal",
        Sensitivity::Sensitive => "sensitive",
    }
}

fn payload_kind(kind: ProfilePayloadKind) -> &'static str {
    match kind {
        ProfilePayloadKind::Background => "background",
        ProfilePayloadKind::Capability => "capability",
        ProfilePayloadKind::Goal => "goal",
        ProfilePayloadKind::ExplanationPreference => "explanation_preference",
        ProfilePayloadKind::Constraint => "constraint",
        ProfilePayloadKind::Extension => "extension",
    }
}

fn governance_outcome_kind(kind: ProfileGovernanceOutcomeKind) -> &'static str {
    match kind {
        ProfileGovernanceOutcomeKind::Remembered => "remembered",
        ProfileGovernanceOutcomeKind::Corrected => "corrected",
        ProfileGovernanceOutcomeKind::Forgotten => "forgotten",
        ProfileGovernanceOutcomeKind::Confirmed => "confirmed",
        ProfileGovernanceOutcomeKind::Rejected => "rejected",
        ProfileGovernanceOutcomeKind::ScopeChanged => "scope_changed",
        ProfileGovernanceOutcomeKind::CollectionRuleAdded => "collection_rule_added",
        ProfileGovernanceOutcomeKind::CollectionRuleRemoved => "collection_rule_removed",
    }
}
