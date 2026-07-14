use crate::global_consolidation::reconcile_global_promotions;
use crate::{
    fnv1a, Applicability, ExplicitProfileFact, FactStatus, MemoryDocument, MemoryOp,
    MemoryOpOutcome, MemoryStore, ProfileFact, ProfilePayload, ProfileScope, Sensitivity,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePayloadKind {
    Background,
    Capability,
    Goal,
    ExplanationPreference,
    Constraint,
    Extension,
}

impl ProfilePayloadKind {
    fn of(payload: &ProfilePayload) -> Self {
        match payload {
            ProfilePayload::Background(_) => Self::Background,
            ProfilePayload::Capability(_) => Self::Capability,
            ProfilePayload::Goal(_) => Self::Goal,
            ProfilePayload::ExplanationPreference(_) => Self::ExplanationPreference,
            ProfilePayload::Constraint(_) => Self::Constraint,
            ProfilePayload::Extension { .. } => Self::Extension,
        }
    }

    fn semantic_prefix(self) -> &'static str {
        match self {
            Self::Background => "background:",
            Self::Capability => "capability:",
            Self::Goal => "goal:",
            Self::ExplanationPreference => "explanation_preference:",
            Self::Constraint => "constraint:",
            Self::Extension => "extension:",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionRuleMatcher {
    pub payload_kind: ProfilePayloadKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ProfileScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applicability: Option<Applicability>,
}

impl CollectionRuleMatcher {
    fn validate(&self) -> Result<(), ToolError> {
        if let Some(semantic_key) = &self.semantic_key {
            let prefix = self.payload_kind.semantic_prefix();
            if semantic_key.trim() != semantic_key
                || !semantic_key.starts_with(prefix)
                || semantic_key.len() == prefix.len()
            {
                return Err(invalid_collection_rule(
                    "semantic_key must be normalized and match payload_kind",
                ));
            }
        }
        if matches!(&self.scope, Some(ProfileScope::Book { book_id }) if book_id.trim().is_empty())
        {
            return Err(invalid_collection_rule("book scope requires book_id"));
        }
        let invalid_applicability = match &self.applicability {
            None | Some(Applicability::Any) => false,
            Some(Applicability::ContentProfile { profile_id }) => profile_id.trim().is_empty(),
            Some(Applicability::PaperSubtype { subtype }) => subtype.trim().is_empty(),
            Some(Applicability::Domain { domain }) => domain.trim().is_empty(),
        };
        if invalid_applicability {
            return Err(invalid_collection_rule(
                "applicability identifier must not be empty",
            ));
        }
        Ok(())
    }

    pub fn matches(
        &self,
        scope: &ProfileScope,
        applicability: &Applicability,
        payload: &ProfilePayload,
    ) -> bool {
        self.payload_kind == ProfilePayloadKind::of(payload)
            && self
                .semantic_key
                .as_ref()
                .is_none_or(|key| key == &payload.semantic_key())
            && self.scope.as_ref().is_none_or(|value| value == scope)
            && self
                .applicability
                .as_ref()
                .is_none_or(|value| value == applicability)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionRule {
    pub rule_id: String,
    pub matcher: CollectionRuleMatcher,
    pub created_at: String,
}

impl CollectionRule {
    fn build(matcher: CollectionRuleMatcher, now: &str) -> Result<Self, ToolError> {
        matcher.validate()?;
        validate_required("collection rule timestamp", now)?;
        Ok(Self {
            rule_id: Self::stable_id(&matcher),
            matcher,
            created_at: now.into(),
        })
    }

    fn stable_id(matcher: &CollectionRuleMatcher) -> String {
        let canonical = serde_json::to_string(matcher)
            .expect("collection rule matcher has fixed serializable fields");
        format!("collection_rule_{:016x}", fnv1a(&canonical))
    }

    fn validate(&self) -> Result<(), String> {
        self.matcher
            .validate()
            .map_err(|error| error.message.clone())?;
        if self.rule_id != Self::stable_id(&self.matcher) || self.created_at.trim().is_empty() {
            return Err(format!("invalid collection rule: {}", self.rule_id));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileGovernanceAction {
    ApplyMemoryOp {
        operation: MemoryOp,
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
        book_id: String,
        scope: ProfileScope,
    },
    AddCollectionRule {
        operation_id: String,
        matcher: CollectionRuleMatcher,
    },
    RemoveCollectionRule {
        operation_id: String,
        rule_id: String,
    },
}

impl ProfileGovernanceAction {
    fn operation_id(&self) -> &str {
        match self {
            Self::ApplyMemoryOp { operation } => memory_operation_id(operation),
            Self::Confirm { operation_id, .. }
            | Self::Reject { operation_id, .. }
            | Self::ChangeScope { operation_id, .. }
            | Self::AddCollectionRule { operation_id, .. }
            | Self::RemoveCollectionRule { operation_id, .. } => operation_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileGovernanceMutation {
    pub expected_document_revision: u64,
    pub action: ProfileGovernanceAction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileGovernanceOutcomeKind {
    Remembered,
    Corrected,
    Forgotten,
    Confirmed,
    Rejected,
    ScopeChanged,
    CollectionRuleAdded,
    CollectionRuleRemoved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileGovernanceOutcome {
    pub operation_id: String,
    pub kind: ProfileGovernanceOutcomeKind,
    pub document_revision: u64,
    pub projection_revision: u64,
    #[serde(default)]
    pub fact_ids: Vec<String>,
    #[serde(default)]
    pub collection_rule_ids: Vec<String>,
    #[serde(default)]
    pub excluded_evidence_ids: Vec<String>,
    #[serde(default)]
    pub removed_dependent_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ProfileMutationReceipt {
    operation_id: String,
    request_fingerprint: String,
    outcome: ProfileGovernanceOutcome,
    created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileGovernanceState {
    #[serde(default)]
    pub collection_rules: Vec<CollectionRule>,
    #[serde(default)]
    pub(crate) receipts: Vec<ProfileMutationReceipt>,
}

impl ProfileGovernanceState {
    pub(crate) fn is_empty(&self) -> bool {
        self.collection_rules.is_empty() && self.receipts.is_empty()
    }

    pub(crate) fn validate(
        &self,
        document_revision: u64,
        projection_revision: u64,
    ) -> Result<(), String> {
        let mut rule_ids = BTreeSet::new();
        for rule in &self.collection_rules {
            rule.validate()?;
            if !rule_ids.insert(rule.rule_id.as_str()) {
                return Err(format!("duplicate collection rule: {}", rule.rule_id));
            }
        }
        let mut operation_ids = BTreeSet::new();
        for receipt in &self.receipts {
            if receipt.operation_id.trim().is_empty()
                || !receipt
                    .request_fingerprint
                    .starts_with("governance_request_")
                || receipt.created_at.trim().is_empty()
                || receipt.outcome.operation_id != receipt.operation_id
                || receipt.outcome.document_revision > document_revision
                || receipt.outcome.projection_revision > projection_revision
                || receipt.outcome.projection_revision > receipt.outcome.document_revision
            {
                return Err(format!(
                    "invalid profile mutation receipt: {}",
                    receipt.operation_id
                ));
            }
            if !operation_ids.insert(receipt.operation_id.as_str()) {
                return Err(format!(
                    "duplicate profile mutation operation_id: {}",
                    receipt.operation_id
                ));
            }
        }
        Ok(())
    }
}

struct ReducedGovernanceAction {
    candidate: Option<MemoryDocument>,
    kind: ProfileGovernanceOutcomeKind,
    fact_ids: Vec<String>,
    collection_rule_ids: Vec<String>,
    excluded_evidence_ids: Vec<String>,
    removed_dependent_fact_ids: Vec<String>,
    refresh_profile_files: bool,
}

impl ReducedGovernanceAction {
    fn unchanged(kind: ProfileGovernanceOutcomeKind) -> Self {
        Self {
            candidate: None,
            kind,
            fact_ids: Vec::new(),
            collection_rule_ids: Vec::new(),
            excluded_evidence_ids: Vec::new(),
            removed_dependent_fact_ids: Vec::new(),
            refresh_profile_files: false,
        }
    }
}

impl MemoryStore {
    pub fn collection_rules(&self) -> &[CollectionRule] {
        &self.document.governance_state.collection_rules
    }

    pub fn apply_profile_governance_mutation(
        &mut self,
        mutation: ProfileGovernanceMutation,
        now: &str,
    ) -> Result<ProfileGovernanceOutcome, ToolError> {
        validate_required("profile governance timestamp", now)?;
        let operation_id = mutation.action.operation_id().to_string();
        validate_required("profile governance operation_id", &operation_id)?;
        let request_fingerprint = action_fingerprint(&mutation.action)?;

        if let Some(receipt) = self
            .document
            .governance_state
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
        {
            if receipt.request_fingerprint == request_fingerprint {
                return Ok(receipt.outcome.clone());
            }
            return Err(governance_conflict(
                "PROFILE_OPERATION_ID_CONFLICT",
                format!("operation_id was reused with different content: {operation_id}"),
            ));
        }
        if mutation.expected_document_revision != self.document.document_revision {
            return Err(governance_conflict(
                "MEMORY_DOCUMENT_REVISION_CONFLICT",
                format!(
                    "expected document_revision {}, current is {}",
                    mutation.expected_document_revision, self.document.document_revision
                ),
            ));
        }

        let reduced = self.reduce_governance_action(mutation.action, now)?;
        let mut candidate = match reduced.candidate {
            Some(candidate) => candidate,
            None => self.document_mutation_candidate()?,
        };
        let outcome = ProfileGovernanceOutcome {
            operation_id: operation_id.clone(),
            kind: reduced.kind,
            document_revision: candidate.document_revision,
            projection_revision: candidate.projection_revision,
            fact_ids: reduced.fact_ids,
            collection_rule_ids: reduced.collection_rule_ids,
            excluded_evidence_ids: reduced.excluded_evidence_ids,
            removed_dependent_fact_ids: reduced.removed_dependent_fact_ids,
        };
        candidate
            .governance_state
            .receipts
            .push(ProfileMutationReceipt {
                operation_id,
                request_fingerprint,
                outcome: outcome.clone(),
                created_at: now.into(),
            });
        self.commit_document(candidate)?;
        if reduced.refresh_profile_files {
            let _ = self.write_profile_files();
        }
        Ok(outcome)
    }

    fn reduce_governance_action(
        &self,
        action: ProfileGovernanceAction,
        now: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        match action {
            ProfileGovernanceAction::ApplyMemoryOp { operation } => {
                let reduced = self.reduce_memory_op(operation, now)?;
                let mut result = match &reduced.outcome {
                    MemoryOpOutcome::Remembered { fact, .. } => {
                        ReducedGovernanceAction::unchanged(ProfileGovernanceOutcomeKind::Remembered)
                            .with_fact(fact.fact_id.clone())
                    }
                    MemoryOpOutcome::Corrected { fact, .. } => {
                        ReducedGovernanceAction::unchanged(ProfileGovernanceOutcomeKind::Corrected)
                            .with_fact(fact.fact_id.clone())
                    }
                    MemoryOpOutcome::Forgotten {
                        forgotten_fact_ids,
                        excluded_evidence_ids,
                        removed_dependent_fact_ids,
                        ..
                    } => ReducedGovernanceAction {
                        candidate: None,
                        kind: ProfileGovernanceOutcomeKind::Forgotten,
                        fact_ids: forgotten_fact_ids.clone(),
                        collection_rule_ids: Vec::new(),
                        excluded_evidence_ids: excluded_evidence_ids.clone(),
                        removed_dependent_fact_ids: removed_dependent_fact_ids.clone(),
                        refresh_profile_files: false,
                    },
                };
                result.candidate = reduced.candidate;
                result.refresh_profile_files = reduced.refresh_profile_files;
                Ok(result)
            }
            ProfileGovernanceAction::Confirm { fact_id, .. } => self.reduce_confirm(&fact_id, now),
            ProfileGovernanceAction::Reject { fact_id, .. } => self.reduce_reject(&fact_id, now),
            ProfileGovernanceAction::ChangeScope {
                operation_id,
                fact_id,
                book_id,
                scope,
            } => self.reduce_scope_change(operation_id, fact_id, book_id, scope, now),
            ProfileGovernanceAction::AddCollectionRule { matcher, .. } => {
                self.reduce_add_collection_rule(matcher, now)
            }
            ProfileGovernanceAction::RemoveCollectionRule { rule_id, .. } => {
                self.reduce_remove_collection_rule(&rule_id)
            }
        }
    }

    fn reduce_confirm(
        &self,
        fact_id: &str,
        now: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        let current = self.profile_fact(fact_id)?;
        if current.status == FactStatus::Confirmed {
            return Ok(
                ReducedGovernanceAction::unchanged(ProfileGovernanceOutcomeKind::Confirmed)
                    .with_fact(fact_id.into()),
            );
        }
        if !matches!(
            current.status,
            FactStatus::Pending | FactStatus::Provisional
        ) {
            return Err(profile_state_conflict(format!(
                "cannot confirm {:?} profile fact: {fact_id}",
                current.status
            )));
        }
        let semantic_key = current.payload.semantic_key();
        let mut candidate = self.projection_mutation_candidate()?;
        let fact = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        fact.status = FactStatus::Confirmed;
        fact.updated_at = now.into();
        reconcile_global_promotions(&mut candidate, &[semantic_key], now)?;
        Ok(ReducedGovernanceAction {
            candidate: Some(candidate),
            kind: ProfileGovernanceOutcomeKind::Confirmed,
            fact_ids: vec![fact_id.into()],
            collection_rule_ids: Vec::new(),
            excluded_evidence_ids: Vec::new(),
            removed_dependent_fact_ids: Vec::new(),
            refresh_profile_files: true,
        })
    }

    fn reduce_reject(
        &self,
        fact_id: &str,
        now: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        let current = self.profile_fact(fact_id)?;
        if current.status != FactStatus::Pending {
            return Err(profile_state_conflict(format!(
                "can only reject pending profile fact: {fact_id}"
            )));
        }
        let semantic_key = current.payload.semantic_key();
        let mut candidate = self.projection_mutation_candidate()?;
        let fact = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        fact.status = FactStatus::Expired;
        fact.updated_at = now.into();
        reconcile_global_promotions(&mut candidate, &[semantic_key], now)?;
        Ok(ReducedGovernanceAction {
            candidate: Some(candidate),
            kind: ProfileGovernanceOutcomeKind::Rejected,
            fact_ids: vec![fact_id.into()],
            collection_rule_ids: Vec::new(),
            excluded_evidence_ids: Vec::new(),
            removed_dependent_fact_ids: Vec::new(),
            refresh_profile_files: true,
        })
    }

    fn reduce_scope_change(
        &self,
        operation_id: String,
        fact_id: String,
        book_id: String,
        scope: ProfileScope,
        now: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        validate_required("scope-change book_id", &book_id)?;
        if matches!(&scope, ProfileScope::Book { book_id: target } if target != &book_id) {
            return Err(invalid_governance(
                "scope-change book target must match current book_id",
            ));
        }
        let current = self.profile_fact(&fact_id)?;
        if current.scope == scope {
            return Err(invalid_governance(
                "profile fact already has requested scope",
            ));
        }
        let operation = MemoryOp::Correct {
            operation_id,
            book_id,
            evidence_text: format!("User changed profile scope for {fact_id}"),
            fact_id,
            replacement: ExplicitProfileFact {
                scope,
                applicability: current.applicability.clone(),
                payload: current.payload.clone(),
                sensitivity: current.sensitivity,
                valid_until: current.valid_until.clone(),
                sensitive_plaintext_acknowledged: current.sensitivity == Sensitivity::Sensitive,
            },
        };
        let reduced = self.reduce_memory_op(operation, now)?;
        let MemoryOpOutcome::Corrected { fact, .. } = &reduced.outcome else {
            unreachable!("scope change always reduces through correction")
        };
        Ok(ReducedGovernanceAction {
            candidate: reduced.candidate,
            kind: ProfileGovernanceOutcomeKind::ScopeChanged,
            fact_ids: vec![fact.fact_id.clone()],
            collection_rule_ids: Vec::new(),
            excluded_evidence_ids: Vec::new(),
            removed_dependent_fact_ids: Vec::new(),
            refresh_profile_files: reduced.refresh_profile_files,
        })
    }

    fn reduce_add_collection_rule(
        &self,
        matcher: CollectionRuleMatcher,
        now: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        let rule = CollectionRule::build(matcher, now)?;
        let mut result =
            ReducedGovernanceAction::unchanged(ProfileGovernanceOutcomeKind::CollectionRuleAdded);
        result.collection_rule_ids.push(rule.rule_id.clone());
        if self
            .document
            .governance_state
            .collection_rules
            .iter()
            .any(|existing| existing.rule_id == rule.rule_id)
        {
            return Ok(result);
        }
        let mut candidate = self.document_mutation_candidate()?;
        candidate.governance_state.collection_rules.push(rule);
        candidate
            .governance_state
            .collection_rules
            .sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
        result.candidate = Some(candidate);
        Ok(result)
    }

    fn reduce_remove_collection_rule(
        &self,
        rule_id: &str,
    ) -> Result<ReducedGovernanceAction, ToolError> {
        validate_required("collection rule_id", rule_id)?;
        if !self
            .document
            .governance_state
            .collection_rules
            .iter()
            .any(|rule| rule.rule_id == rule_id)
        {
            return Err(ToolError {
                error_code: "COLLECTION_RULE_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("collection rule does not exist: {rule_id}"),
            });
        }
        let mut candidate = self.document_mutation_candidate()?;
        candidate
            .governance_state
            .collection_rules
            .retain(|rule| rule.rule_id != rule_id);
        let mut result =
            ReducedGovernanceAction::unchanged(ProfileGovernanceOutcomeKind::CollectionRuleRemoved);
        result.candidate = Some(candidate);
        result.collection_rule_ids.push(rule_id.into());
        Ok(result)
    }

    fn profile_fact(&self, fact_id: &str) -> Result<&ProfileFact, ToolError> {
        self.document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == fact_id)
            .ok_or_else(|| ToolError {
                error_code: "PROFILE_FACT_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("profile fact does not exist: {fact_id}"),
            })
    }
}

impl ReducedGovernanceAction {
    fn with_fact(mut self, fact_id: String) -> Self {
        self.fact_ids.push(fact_id);
        self
    }
}

pub(crate) fn collection_rules_block(
    rules: &[CollectionRule],
    scope: &ProfileScope,
    applicability: &Applicability,
    payload: &ProfilePayload,
) -> bool {
    rules
        .iter()
        .any(|rule| rule.matcher.matches(scope, applicability, payload))
}

fn memory_operation_id(operation: &MemoryOp) -> &str {
    match operation {
        MemoryOp::Remember { operation_id, .. }
        | MemoryOp::Correct { operation_id, .. }
        | MemoryOp::Forget { operation_id, .. } => operation_id,
    }
}

fn action_fingerprint(action: &ProfileGovernanceAction) -> Result<String, ToolError> {
    let canonical = serde_json::to_string(action).map_err(|error| {
        invalid_governance(format!(
            "profile governance action serialization failed: {error}"
        ))
    })?;
    Ok(format!("governance_request_{:016x}", fnv1a(&canonical)))
}

fn validate_required(name: &str, value: &str) -> Result<(), ToolError> {
    if value.trim().is_empty() {
        return Err(invalid_governance(format!("{name} must not be empty")));
    }
    Ok(())
}

fn invalid_collection_rule(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_COLLECTION_RULE".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn invalid_governance(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_PROFILE_GOVERNANCE_MUTATION".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn governance_conflict(error_code: &str, message: String) -> ToolError {
    ToolError {
        error_code: error_code.into(),
        category: "conflict".into(),
        message,
    }
}

fn profile_state_conflict(message: String) -> ToolError {
    ToolError {
        error_code: "PROFILE_FACT_STATE_CONFLICT".into(),
        category: "conflict".into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Confidence, CreateProfileFact, EvidenceRef, FactSource, PreferenceClaim,
        ReviewFactCandidate, ReviewSessionCursor,
    };
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-governance-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn turn(session_id: &str, turn_id: &str) -> EvidenceRef {
        EvidenceRef::Turn {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
        }
    }

    fn fact_input(
        scope: ProfileScope,
        key: &str,
        value: &str,
        source: FactSource,
        evidence: EvidenceRef,
    ) -> CreateProfileFact {
        CreateProfileFact {
            scope,
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: key.into(),
                value: value.into(),
            }),
            source,
            evidence: vec![evidence],
            confidence: (source == FactSource::AgentInferred).then_some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        }
    }

    fn book_scope(book_id: &str) -> ProfileScope {
        ProfileScope::Book {
            book_id: book_id.into(),
        }
    }

    fn pending_global(store: &mut MemoryStore, key: &str) -> ProfileFact {
        store
            .create_profile_fact(
                fact_input(
                    ProfileScope::Global,
                    key,
                    "worked_examples_first",
                    FactSource::AgentInferred,
                    turn("session-a", "turn-a"),
                ),
                "2026-07-14T00:00:00Z",
            )
            .unwrap()
    }

    fn rule_matcher(key: &str) -> CollectionRuleMatcher {
        CollectionRuleMatcher {
            payload_kind: ProfilePayloadKind::ExplanationPreference,
            semantic_key: Some(format!("explanation_preference:{key}")),
            scope: None,
            applicability: None,
        }
    }

    #[test]
    fn stale_unseen_mutation_is_rejected_but_exact_replay_wins_after_revision_advances() {
        let (path, mut store) = store("revision-replay");
        let pending = pending_global(&mut store, "example_order");
        let starting_revision = store.document_revision();
        let request = ProfileGovernanceMutation {
            expected_document_revision: starting_revision,
            action: ProfileGovernanceAction::Confirm {
                operation_id: "confirm-1".into(),
                fact_id: pending.fact_id.clone(),
            },
        };

        let stale = ProfileGovernanceMutation {
            expected_document_revision: starting_revision - 1,
            action: ProfileGovernanceAction::Confirm {
                operation_id: "confirm-stale".into(),
                fact_id: pending.fact_id.clone(),
            },
        };
        let before_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            store
                .apply_profile_governance_mutation(stale, "2026-07-14T00:01:00Z")
                .unwrap_err()
                .error_code,
            "MEMORY_DOCUMENT_REVISION_CONFLICT"
        );
        assert_eq!(store.document_revision(), starting_revision);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before_disk);

        let first = store
            .apply_profile_governance_mutation(request.clone(), "2026-07-14T00:02:00Z")
            .unwrap();
        assert_eq!(first.kind, ProfileGovernanceOutcomeKind::Confirmed);
        assert_eq!(first.document_revision, starting_revision + 1);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == pending.fact_id)
                .unwrap()
                .status,
            FactStatus::Confirmed
        );

        store
            .create_profile_fact(
                fact_input(
                    book_scope("book-b"),
                    "depth",
                    "detailed",
                    FactSource::UserStated,
                    turn("session-b", "turn-b"),
                ),
                "2026-07-14T00:03:00Z",
            )
            .unwrap();
        let advanced_revision = store.document_revision();
        let replayed = store
            .apply_profile_governance_mutation(request.clone(), "2026-07-14T00:04:00Z")
            .unwrap();
        assert_eq!(replayed, first);
        assert_eq!(store.document_revision(), advanced_revision);

        let reused = ProfileGovernanceMutation {
            expected_document_revision: advanced_revision,
            action: ProfileGovernanceAction::Reject {
                operation_id: "confirm-1".into(),
                fact_id: pending.fact_id,
            },
        };
        assert_eq!(
            store
                .apply_profile_governance_mutation(reused, "2026-07-14T00:05:00Z")
                .unwrap_err()
                .error_code,
            "PROFILE_OPERATION_ID_CONFLICT"
        );

        let mut reopened = MemoryStore::open(path).unwrap();
        let reopened_revision = reopened.document_revision();
        assert_eq!(
            reopened
                .apply_profile_governance_mutation(request, "2026-07-14T00:06:00Z")
                .unwrap(),
            first
        );
        assert_eq!(reopened.document_revision(), reopened_revision);
    }

    #[test]
    fn scope_change_creates_user_confirmed_successor_without_in_place_edit() {
        let (_path, mut store) = store("scope-change");
        let original = store
            .create_profile_fact(
                fact_input(
                    book_scope("book-a"),
                    "depth",
                    "detailed",
                    FactSource::AgentInferred,
                    turn("session-a", "turn-a"),
                ),
                "2026-07-14T00:00:00Z",
            )
            .unwrap();
        let outcome = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::ChangeScope {
                        operation_id: "scope-1".into(),
                        fact_id: original.fact_id.clone(),
                        book_id: "book-a".into(),
                        scope: ProfileScope::Global,
                    },
                },
                "2026-07-14T00:01:00Z",
            )
            .unwrap();

        assert_eq!(outcome.kind, ProfileGovernanceOutcomeKind::ScopeChanged);
        let successor = store
            .profile_facts()
            .iter()
            .find(|fact| outcome.fact_ids.contains(&fact.fact_id))
            .unwrap();
        assert_eq!(successor.scope, ProfileScope::Global);
        assert_eq!(successor.source, FactSource::UserStated);
        assert_eq!(successor.status, FactStatus::Confirmed);
        assert_eq!(successor.supersedes, vec![original.fact_id.clone()]);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == original.fact_id)
                .unwrap()
                .status,
            FactStatus::Superseded
        );
    }

    #[test]
    fn collection_rule_blocks_review_and_global_promotion_but_not_explicit_remember() {
        let (_path, mut store) = store("collection-rule");
        let existing = store
            .create_profile_fact(
                fact_input(
                    book_scope("book-old"),
                    "example_order",
                    "worked_examples_first",
                    FactSource::AgentInferred,
                    turn("old-session", "old-turn"),
                ),
                "2026-07-14T00:00:00Z",
            )
            .unwrap();
        let projection_revision = store.projection_revision();
        let added = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::AddCollectionRule {
                        operation_id: "rule-add".into(),
                        matcher: rule_matcher("example_order"),
                    },
                },
                "2026-07-14T00:01:00Z",
            )
            .unwrap();
        assert_eq!(
            added.kind,
            ProfileGovernanceOutcomeKind::CollectionRuleAdded
        );
        assert_eq!(store.projection_revision(), projection_revision);
        assert!(store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == existing.fact_id));

        store
            .reconcile_review_jobs(
                &[ReviewSessionCursor {
                    session_id: "review-session".into(),
                    book_id: "book-review".into(),
                    latest_user_turn_ordinal: 1,
                }],
                "2026-07-14T00:02:00Z",
            )
            .unwrap();
        let job = store.review_state().review_jobs[0].clone();
        store
            .claim_review_job(&job.job_id, "2026-07-14T00:03:00Z")
            .unwrap();
        let blocked = ReviewFactCandidate::new(fact_input(
            book_scope("book-review"),
            "example_order",
            "worked_examples_first",
            FactSource::UserStated,
            turn("review-session", "review-turn"),
        ))
        .unwrap();
        let review = store
            .commit_review_result(
                &job.job_id,
                &["review-turn".into()],
                &[blocked],
                &[],
                "2026-07-14T00:04:00Z",
            )
            .unwrap();
        assert!(review.added_fact_ids.is_empty());
        assert_eq!(store.review_state().reviewed_through["review-session"], 1);

        for (index, (book_id, turn_id)) in [("book-a", "a1"), ("book-a", "a2"), ("book-b", "b1")]
            .into_iter()
            .enumerate()
        {
            store
                .create_profile_fact(
                    fact_input(
                        book_scope(book_id),
                        "example_order",
                        "worked_examples_first",
                        FactSource::AgentInferred,
                        turn(book_id, turn_id),
                    ),
                    &format!("2026-07-14T00:1{index}:00Z"),
                )
                .unwrap();
        }
        assert!(store.review_state().global_promotions.is_empty());

        let explicit = MemoryOp::Remember {
            operation_id: "explicit-exception".into(),
            book_id: "book-explicit".into(),
            evidence_text: "Remember that I prefer worked examples first".into(),
            fact: ExplicitProfileFact {
                scope: book_scope("book-explicit"),
                applicability: Applicability::Any,
                payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                    key: "example_order".into(),
                    value: "worked_examples_first".into(),
                }),
                sensitivity: Sensitivity::Normal,
                valid_until: None,
                sensitive_plaintext_acknowledged: false,
            },
        };
        let explicit_outcome = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::ApplyMemoryOp {
                        operation: explicit,
                    },
                },
                "2026-07-14T00:20:00Z",
            )
            .unwrap();
        assert_eq!(
            explicit_outcome.kind,
            ProfileGovernanceOutcomeKind::Remembered
        );
        assert_eq!(store.collection_rules().len(), 1);
    }

    #[test]
    fn collection_rule_preserves_preexisting_promotion_until_its_evidence_becomes_ineligible() {
        let (_path, mut store) = store("collection-rule-future-only");
        let mut sources = Vec::new();
        for (index, (book_id, turn_id)) in [("book-a", "a1"), ("book-a", "a2"), ("book-b", "b1")]
            .into_iter()
            .enumerate()
        {
            sources.push(
                store
                    .create_profile_fact(
                        fact_input(
                            book_scope(book_id),
                            "example_order",
                            "worked_examples_first",
                            FactSource::AgentInferred,
                            turn(book_id, turn_id),
                        ),
                        &format!("2026-07-14T00:0{index}:00Z"),
                    )
                    .unwrap(),
            );
        }
        let candidate_id = store.review_state().global_promotions[0]
            .candidate_fact_id
            .clone();
        store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::AddCollectionRule {
                        operation_id: "rule-after-promotion".into(),
                        matcher: rule_matcher("example_order"),
                    },
                },
                "2026-07-14T00:03:00Z",
            )
            .unwrap();

        store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::Confirm {
                        operation_id: "confirm-existing-promotion".into(),
                        fact_id: candidate_id.clone(),
                    },
                },
                "2026-07-14T00:04:00Z",
            )
            .unwrap();
        assert_eq!(store.review_state().global_promotions.len(), 1);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == candidate_id)
                .unwrap()
                .status,
            FactStatus::Confirmed
        );

        store
            .expire_profile_fact(&sources[2].fact_id, "2026-07-14T00:05:00Z")
            .unwrap();
        assert!(store.review_state().global_promotions.is_empty());
        assert!(!store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == candidate_id));
    }

    #[test]
    fn hard_forget_receipt_is_content_free_and_replayable() {
        let (path, mut store) = store("forget-receipt");
        let remember = ProfileGovernanceMutation {
            expected_document_revision: 0,
            action: ProfileGovernanceAction::ApplyMemoryOp {
                operation: MemoryOp::Remember {
                    operation_id: "remember-secret-value".into(),
                    book_id: "book-a".into(),
                    evidence_text: "Remember DELETE_GOVERNANCE_SENTINEL".into(),
                    fact: ExplicitProfileFact {
                        scope: book_scope("book-a"),
                        applicability: Applicability::Any,
                        payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                            key: "depth".into(),
                            value: "DELETE_GOVERNANCE_SENTINEL".into(),
                        }),
                        sensitivity: Sensitivity::Normal,
                        valid_until: None,
                        sensitive_plaintext_acknowledged: false,
                    },
                },
            },
        };
        let remembered = store
            .apply_profile_governance_mutation(remember, "2026-07-14T00:00:00Z")
            .unwrap();
        let forget = ProfileGovernanceMutation {
            expected_document_revision: store.document_revision(),
            action: ProfileGovernanceAction::ApplyMemoryOp {
                operation: MemoryOp::Forget {
                    operation_id: "forget-secret-value".into(),
                    fact_id: remembered.fact_ids[0].clone(),
                },
            },
        };
        let forgotten = store
            .apply_profile_governance_mutation(forget.clone(), "2026-07-14T00:01:00Z")
            .unwrap();
        assert_eq!(forgotten.kind, ProfileGovernanceOutcomeKind::Forgotten);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("DELETE_GOVERNANCE_SENTINEL"));

        let revision = store.document_revision();
        assert_eq!(
            store
                .apply_profile_governance_mutation(forget, "2026-07-14T00:02:00Z")
                .unwrap(),
            forgotten
        );
        assert_eq!(store.document_revision(), revision);
    }

    #[test]
    fn reject_and_rule_removal_persist_with_the_correct_revision_semantics() {
        let (path, mut store) = store("reject-remove-rule");
        let pending = pending_global(&mut store, "example_order");
        let rejected = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::Reject {
                        operation_id: "reject-1".into(),
                        fact_id: pending.fact_id.clone(),
                    },
                },
                "2026-07-14T00:01:00Z",
            )
            .unwrap();
        assert_eq!(rejected.kind, ProfileGovernanceOutcomeKind::Rejected);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == pending.fact_id)
                .unwrap()
                .status,
            FactStatus::Expired
        );

        let projection_after_reject = store.projection_revision();
        let added = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::AddCollectionRule {
                        operation_id: "rule-add-1".into(),
                        matcher: rule_matcher("depth"),
                    },
                },
                "2026-07-14T00:02:00Z",
            )
            .unwrap();
        assert_eq!(store.projection_revision(), projection_after_reject);
        let removed = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::RemoveCollectionRule {
                        operation_id: "rule-remove-1".into(),
                        rule_id: added.collection_rule_ids[0].clone(),
                    },
                },
                "2026-07-14T00:03:00Z",
            )
            .unwrap();
        assert_eq!(
            removed.kind,
            ProfileGovernanceOutcomeKind::CollectionRuleRemoved
        );
        assert!(store.collection_rules().is_empty());
        assert_eq!(store.projection_revision(), projection_after_reject);

        let reopened = MemoryStore::open(path).unwrap();
        assert!(reopened.collection_rules().is_empty());
        assert_eq!(reopened.document_revision(), removed.document_revision);
        assert_eq!(reopened.projection_revision(), projection_after_reject);
    }

    #[test]
    fn governance_commit_failure_preserves_fact_receipt_and_disk() {
        let (path, mut store) = store("failed-commit");
        let pending = pending_global(&mut store, "depth");
        let before_revision = store.document_revision();
        let before_disk = std::fs::read_to_string(&path).unwrap();
        let blocker = std::env::temp_dir().join("ub-governance-parent-blocker");
        let _ = std::fs::remove_file(&blocker);
        let _ = std::fs::remove_dir_all(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();
        store.path = blocker.join("memory.json");

        let error = store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: before_revision,
                    action: ProfileGovernanceAction::Confirm {
                        operation_id: "confirm-fails".into(),
                        fact_id: pending.fact_id.clone(),
                    },
                },
                "2026-07-14T00:01:00Z",
            )
            .unwrap_err();
        assert_eq!(error.category, "internal");
        assert_eq!(store.document_revision(), before_revision);
        assert!(store.document.governance_state.receipts.is_empty());
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == pending.fact_id)
                .unwrap()
                .status,
            FactStatus::Pending
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), before_disk);
    }
}
