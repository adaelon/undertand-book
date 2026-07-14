use memory::{
    Applicability, BookReadingState, FactSource, FactStatus, ProfileFact, ProfilePayload,
    SnapshotCandidate,
};
use read_tools::MemoryPolicyRef;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const NEUTRAL_MEMORY_POLICY_ID: &str = "neutral";
pub const NEUTRAL_MEMORY_POLICY_VERSION: &str = "neutral_memory_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileStateStatus {
    Current,
    Orphaned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileStateEnvelope {
    pub requested_policy: MemoryPolicyRef,
    pub active_policy: MemoryPolicyRef,
    pub source_revision: u64,
    pub status: ProfileStateStatus,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadingHint {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadingHints {
    pub items: Vec<ReadingHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PolicyFallbackReason {
    MissingPolicy,
    VersionMismatch { available_version: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    pub code: &'static str,
    pub message: String,
}

pub struct PolicyProjectionInput<'a> {
    pub source_revision: u64,
    pub reading_state: &'a BookReadingState,
    pub resolved_facts: &'a [ProfileFact],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryPolicyProjection {
    pub state: ProfileStateEnvelope,
    pub candidates: Vec<SnapshotCandidate>,
    pub hints: ReadingHints,
    pub fallback_reason: Option<PolicyFallbackReason>,
}

pub trait MemoryPolicy: Send + Sync {
    fn policy_ref(&self) -> MemoryPolicyRef;
    fn validate_extension(&self, fact: &ProfileFact) -> Result<(), PolicyError>;
    fn derive_book_state(&self, input: &PolicyProjectionInput<'_>) -> Value;
    fn snapshot_candidates(&self, input: &PolicyProjectionInput<'_>) -> Vec<SnapshotCandidate>;
    fn rank_snapshot_items(&self, candidates: &mut [SnapshotCandidate]);
    fn reading_hints(&self, state: &Value) -> ReadingHints;
}

pub struct MemoryPolicyRegistry {
    policies: BTreeMap<String, Arc<dyn MemoryPolicy>>,
}

impl Default for MemoryPolicyRegistry {
    fn default() -> Self {
        let mut registry = Self {
            policies: BTreeMap::new(),
        };
        registry
            .register(Arc::new(NeutralMemoryPolicy))
            .expect("the built-in neutral policy has a valid unique identity");
        registry
    }
}

impl MemoryPolicyRegistry {
    pub fn register(&mut self, policy: Arc<dyn MemoryPolicy>) -> Result<(), PolicyError> {
        let reference = policy.policy_ref();
        if reference.policy_id.trim().is_empty() || reference.policy_version.trim().is_empty() {
            return Err(PolicyError {
                code: "INVALID_MEMORY_POLICY",
                message: "memory policy id/version must not be empty".into(),
            });
        }
        if self.policies.contains_key(&reference.policy_id) {
            return Err(PolicyError {
                code: "DUPLICATE_MEMORY_POLICY",
                message: format!(
                    "memory policy is already registered: {}",
                    reference.policy_id
                ),
            });
        }
        self.policies.insert(reference.policy_id, policy);
        Ok(())
    }

    pub fn project(
        &self,
        requested_policy: &MemoryPolicyRef,
        input: &PolicyProjectionInput<'_>,
    ) -> MemoryPolicyProjection {
        let registered = self.policies.get(&requested_policy.policy_id);
        let fallback_reason = match registered {
            None => Some(PolicyFallbackReason::MissingPolicy),
            Some(policy)
                if policy.policy_ref().policy_version != requested_policy.policy_version =>
            {
                Some(PolicyFallbackReason::VersionMismatch {
                    available_version: policy.policy_ref().policy_version,
                })
            }
            Some(_) => None,
        };
        let active = if fallback_reason.is_none() {
            registered.expect("an exact policy match was established")
        } else {
            self.policies
                .get(NEUTRAL_MEMORY_POLICY_ID)
                .expect("the neutral fallback is registered")
        };
        let active_policy = active.policy_ref();
        let state = active.derive_book_state(input);
        let mut candidates = active.snapshot_candidates(input);
        active.rank_snapshot_items(&mut candidates);
        let hints = active.reading_hints(&state);

        MemoryPolicyProjection {
            state: ProfileStateEnvelope {
                requested_policy: requested_policy.clone(),
                active_policy,
                source_revision: input.source_revision,
                status: if fallback_reason.is_some() {
                    ProfileStateStatus::Orphaned
                } else {
                    ProfileStateStatus::Current
                },
                state,
            },
            candidates,
            hints,
            fallback_reason,
        }
    }
}

#[derive(Debug)]
pub struct NeutralMemoryPolicy;

impl MemoryPolicy for NeutralMemoryPolicy {
    fn policy_ref(&self) -> MemoryPolicyRef {
        MemoryPolicyRef {
            policy_id: NEUTRAL_MEMORY_POLICY_ID.into(),
            policy_version: NEUTRAL_MEMORY_POLICY_VERSION.into(),
        }
    }

    fn validate_extension(&self, fact: &ProfileFact) -> Result<(), PolicyError> {
        if matches!(fact.payload, ProfilePayload::Extension { .. }) {
            return Err(PolicyError {
                code: "UNSUPPORTED_PROFILE_EXTENSION",
                message: "neutral memory policy does not accept extension facts".into(),
            });
        }
        Ok(())
    }

    fn derive_book_state(&self, input: &PolicyProjectionInput<'_>) -> Value {
        json!({
            "book_id": input.reading_state.book_id,
            "read_lids": input.reading_state.read_lids,
            "activity_by_lid": input.reading_state.engagement_by_lid,
        })
    }

    fn snapshot_candidates(&self, input: &PolicyProjectionInput<'_>) -> Vec<SnapshotCandidate> {
        let mut candidates = Vec::new();
        if !input.reading_state.read_lids.is_empty() {
            let value = serde_json::to_string(&input.reading_state.read_lids)
                .expect("read_lids contain only serializable strings");
            candidates.push(neutral_candidate(
                &input.reading_state.book_id,
                "read_lids",
                value,
                String::new(),
            ));
        }
        for (lid, activity) in &input.reading_state.engagement_by_lid {
            let value = serde_json::to_string(activity)
                .expect("EngagementSignals has fixed serializable fields");
            candidates.push(neutral_candidate(
                &input.reading_state.book_id,
                &format!("activity:{lid}"),
                value,
                activity.last_seen_at.clone().unwrap_or_default(),
            ));
        }
        candidates
    }

    fn rank_snapshot_items(&self, candidates: &mut [SnapshotCandidate]) {
        candidates.sort_by(|left, right| {
            left.key
                .cmp(&right.key)
                .then_with(|| left.fact_id.cmp(&right.fact_id))
        });
    }

    fn reading_hints(&self, _state: &Value) -> ReadingHints {
        ReadingHints::default()
    }
}

fn neutral_candidate(
    book_id: &str,
    key: &str,
    value: String,
    updated_at: String,
) -> SnapshotCandidate {
    let identity = format!("neutral_activity\u{1f}{book_id}\u{1f}{key}\u{1f}{value}");
    SnapshotCandidate {
        fact_id: format!("policy_{:016x}", fnv1a(&identity)),
        status: FactStatus::Confirmed,
        source: FactSource::DeterministicBehavior,
        applicability: Applicability::Any,
        namespace: "neutral_activity".into(),
        key: key.into(),
        value,
        updated_at,
    }
}

fn fnv1a(input: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use memory::{
        CreateProfileFact, EvidenceRef, MemoryStore, PreferenceClaim, ProfileScope, Sensitivity,
        SnapshotContext, SnapshotRequest,
    };
    use read_tools::technical_learning_profile_manifest;
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-memory-policy-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn input<'a>(
        source_revision: u64,
        reading_state: &'a BookReadingState,
        resolved_facts: &'a [ProfileFact],
    ) -> PolicyProjectionInput<'a> {
        PolicyProjectionInput {
            source_revision,
            reading_state,
            resolved_facts,
        }
    }

    #[test]
    fn exact_neutral_policy_projects_only_raw_activity() {
        let reading_state = BookReadingState {
            book_id: "book-a".into(),
            read_lids: vec!["1.1".into()],
            engagement_by_lid: BTreeMap::from([(
                "1.1".into(),
                memory::EngagementSignals {
                    qa_count: 2,
                    note_count: 1,
                    highlight_count: 0,
                    last_seen_at: Some("2026-07-14T00:00:00Z".into()),
                },
            )]),
        };
        let registry = MemoryPolicyRegistry::default();
        let projection = registry.project(
            &MemoryPolicyRef {
                policy_id: NEUTRAL_MEMORY_POLICY_ID.into(),
                policy_version: NEUTRAL_MEMORY_POLICY_VERSION.into(),
            },
            &input(7, &reading_state, &[]),
        );

        assert_eq!(projection.state.status, ProfileStateStatus::Current);
        assert_eq!(projection.state.source_revision, 7);
        assert_eq!(projection.candidates.len(), 2);
        assert!(projection
            .candidates
            .iter()
            .all(|candidate| candidate.status == FactStatus::Confirmed));
        assert!(projection.hints.items.is_empty());
        assert_eq!(projection.state.state["read_lids"][0], "1.1");
        assert_eq!(
            projection.state.state["activity_by_lid"]["1.1"]["qa_count"],
            2
        );
    }

    #[test]
    fn missing_and_mismatched_policies_fall_back_and_mark_state_orphaned() {
        let reading_state = BookReadingState {
            book_id: "book-a".into(),
            read_lids: vec!["1.1".into()],
            engagement_by_lid: BTreeMap::new(),
        };
        let registry = MemoryPolicyRegistry::default();
        let missing = registry.project(
            &MemoryPolicyRef {
                policy_id: "future_profile".into(),
                policy_version: "future_v1".into(),
            },
            &input(1, &reading_state, &[]),
        );
        assert_eq!(missing.state.status, ProfileStateStatus::Orphaned);
        assert_eq!(
            missing.fallback_reason,
            Some(PolicyFallbackReason::MissingPolicy)
        );
        assert_eq!(
            missing.state.active_policy.policy_id,
            NEUTRAL_MEMORY_POLICY_ID
        );

        let mismatch = registry.project(
            &MemoryPolicyRef {
                policy_id: NEUTRAL_MEMORY_POLICY_ID.into(),
                policy_version: "old".into(),
            },
            &input(1, &reading_state, &[]),
        );
        assert_eq!(mismatch.state.status, ProfileStateStatus::Orphaned);
        assert_eq!(
            mismatch.fallback_reason,
            Some(PolicyFallbackReason::VersionMismatch {
                available_version: NEUTRAL_MEMORY_POLICY_VERSION.into(),
            })
        );
    }

    #[test]
    fn fallback_snapshot_keeps_core_facts_and_does_not_mutate_the_ledger() {
        let (_path, mut store) = store("fallback-ledger");
        store
            .mark_read("book-a", "1.1", "2026-07-14T00:00:00Z")
            .unwrap();
        store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "depth".into(),
                        value: "detailed".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-07-14T00:00:01Z",
            )
            .unwrap();
        let revision = store.projection_revision();
        let reading_state = store.derive_book_reading_state("book-a");
        let facts = store.resolve_profile_facts(&memory::ProfileResolutionContext {
            book_id: Some("book-a".into()),
            content_profile: Some("technical_learning".into()),
            ..Default::default()
        });
        let projection = MemoryPolicyRegistry::default().project(
            &technical_learning_profile_manifest().memory_policy,
            &input(revision, &reading_state, &facts),
        );
        let mut request = SnapshotRequest::current(SnapshotContext {
            book_id: Some("book-a".into()),
            content_profile: Some("technical_learning".into()),
            ..Default::default()
        });
        request.profile_candidates = projection.candidates;
        let snapshot = store.project_reader_profile_snapshot(&request);

        assert_eq!(projection.state.status, ProfileStateStatus::Orphaned);
        assert_eq!(snapshot.global_core.len(), 1);
        assert!(snapshot.global_core[0].text.contains("detailed"));
        assert!(snapshot
            .profile_projection
            .iter()
            .any(|item| item.text.contains("read_lids")));
        assert_eq!(store.profile_facts().len(), 1);
        assert_eq!(store.projection_revision(), revision);
    }

    #[test]
    fn neutral_policy_rejects_extension_facts() {
        let fact = ProfileFact {
            fact_id: "fact_extension".into(),
            scope: ProfileScope::Global,
            applicability: Applicability::Any,
            payload: ProfilePayload::Extension {
                namespace: "future".into(),
                key: "state".into(),
                value: json!({"value": true}),
            },
            source: FactSource::UserStated,
            evidence: vec![],
            status: FactStatus::Confirmed,
            confidence: None,
            sensitivity: Sensitivity::Normal,
            created_at: "now".into(),
            updated_at: "now".into(),
            valid_until: None,
            supersedes: vec![],
        };
        let error = NeutralMemoryPolicy.validate_extension(&fact).unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_PROFILE_EXTENSION");
    }
}
