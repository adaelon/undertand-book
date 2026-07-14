use memory::{
    Applicability, EvidenceRef, FactSource, FactStatus, MemoryStore, PendingTurnRef,
    ProfilePayload, ProfileScope, ProfileStatus, ReaderProfileSnapshot, Sensitivity, SnapshotItem,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileMemoryState {
    pub status: ProfileMemoryStatusView,
    pub snapshot: ProfileSnapshotView,
    pub facts: Vec<ProfileFactView>,
    pub evidence: Vec<ProfileEvidenceView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileMemoryStatusView {
    pub document_revision: u64,
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
    pending_sensitive_confirmation: bool,
) -> ProfileMemoryState {
    let mut facts: Vec<_> = store.profile_facts().iter().map(fact_view).collect();
    facts.sort_by(|left, right| left.fact_id.cmp(&right.fact_id));
    let mut evidence: Vec<_> = store
        .profile_facts()
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
    ProfileMemoryState {
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
        evidence,
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

fn sensitivity(value: Sensitivity) -> &'static str {
    match value {
        Sensitivity::Normal => "normal",
        Sensitivity::Sensitive => "sensitive",
    }
}
