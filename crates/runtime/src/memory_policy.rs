use memory::{
    Applicability, BookReadingState, EngagementSignals, EvidenceRef, FactSource, FactStatus,
    ProfileFact, ProfilePayload, SnapshotCandidate,
};
use read_tools::{
    MemoryPolicyRef, PaperReadingGuide, PaperReadingMode, PaperReadingStage,
    PAPER_MEMORY_POLICY_VERSION, TECHNICAL_LEARNING_MEMORY_POLICY_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const NEUTRAL_MEMORY_POLICY_ID: &str = "neutral";
pub const NEUTRAL_MEMORY_POLICY_VERSION: &str = "neutral_memory_v1";
pub const TECHNICAL_LEARNING_MEMORY_POLICY_ID: &str = "technical_learning";
pub const PAPER_MEMORY_POLICY_ID: &str = "paper";
const UNDERSTOOD_CONCEPT_KEY: &str = "understood_concept";
const REQUESTED_PREREQUISITE_KEY: &str = "requested_prerequisite";
const PAPER_READING_MODE_KEY: &str = "paper_reading_mode";
const PAPER_READING_STAGE_KEY: &str = "paper_reading_stage";

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
    pub hint_id: String,
    pub kind: ReadingHintKind,
    pub status: FactStatus,
    pub source: FactSource,
    pub value: String,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadingHintKind {
    NeedsReview,
    CurrentGoal,
    RequestedPrerequisite,
    ExplanationPreference,
    PaperMode,
    PaperStage,
    PaperQuestion,
    PaperTerminology,
    PaperFacet,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadingHints {
    pub items: Vec<ReadingHint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConceptActivity {
    Unseen,
    Encountered,
    Revisited,
    UserConfirmedUnderstood,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LearningHypothesisKind {
    LikelyFamiliar,
    NeedsReview,
    WantsMoreExamples,
    WantsMoreDerivation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LearningHypothesis {
    pub hypothesis_id: String,
    pub kind: LearningHypothesisKind,
    pub concept_key: String,
    pub status: FactStatus,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TechnicalLearningMemoryState {
    pub activity_by_lid: BTreeMap<String, EngagementSignals>,
    pub concept_activity: BTreeMap<String, ConceptActivity>,
    pub learning_hypotheses: Vec<LearningHypothesis>,
    pub current_goal_fact_ids: Vec<String>,
    pub requested_prerequisites: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExplicitChoice<T> {
    pub value: T,
    pub fact_id: String,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionActivity {
    Unvisited,
    Explored,
    UserReflected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PaperFacet {
    Terminology,
    Method,
    Claim,
    Evidence,
    Limitation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperMemoryState {
    pub last_selected_mode: Option<ExplicitChoice<PaperReadingMode>>,
    pub last_selected_stage: Option<ExplicitChoice<PaperReadingStage>>,
    pub question_progress: BTreeMap<String, QuestionActivity>,
    pub terminology_assistance: BTreeMap<String, EngagementSignals>,
    pub facet_attention: BTreeMap<PaperFacet, Vec<EvidenceRef>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperPolicyContext {
    pub question_evidence_by_id: BTreeMap<String, Vec<String>>,
    pub terminology_evidence_by_term: BTreeMap<String, Vec<String>>,
}

impl PaperPolicyContext {
    pub fn from_reading_guide(guide: &PaperReadingGuide) -> Self {
        if !guide.available {
            return Self::default();
        }
        let question_evidence_by_id = guide
            .questions
            .iter()
            .map(|question| {
                (
                    question.id.clone(),
                    sorted_unique(question.evidence_lids.clone()),
                )
            })
            .collect();
        let terminology_evidence_by_term = guide
            .codebook
            .terms
            .iter()
            .map(|term| (term.term.clone(), sorted_unique(term.evidence_lids.clone())))
            .collect();
        Self {
            question_evidence_by_id,
            terminology_evidence_by_term,
        }
    }
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
    pub paper_context: Option<&'a PaperPolicyContext>,
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
    fn reading_hints(&self, state: &Value, input: &PolicyProjectionInput<'_>) -> ReadingHints;
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
            .register(Arc::new(TechnicalLearningMemoryPolicy))
            .expect("the built-in technical learning policy has a valid unique identity");
        registry
            .register(Arc::new(PaperMemoryPolicy))
            .expect("the built-in paper policy has a valid unique identity");
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
        let hints = active.reading_hints(&state, input);
        candidates.extend(hint_candidates(
            &active_policy.policy_id,
            &input.reading_state.book_id,
            &hints.items,
        ));
        active.rank_snapshot_items(&mut candidates);

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

    fn reading_hints(&self, _state: &Value, _input: &PolicyProjectionInput<'_>) -> ReadingHints {
        ReadingHints::default()
    }
}

#[derive(Debug)]
pub struct TechnicalLearningMemoryPolicy;

impl MemoryPolicy for TechnicalLearningMemoryPolicy {
    fn policy_ref(&self) -> MemoryPolicyRef {
        MemoryPolicyRef {
            policy_id: TECHNICAL_LEARNING_MEMORY_POLICY_ID.into(),
            policy_version: TECHNICAL_LEARNING_MEMORY_POLICY_VERSION.into(),
        }
    }

    fn validate_extension(&self, fact: &ProfileFact) -> Result<(), PolicyError> {
        if matches!(
            &fact.payload,
            ProfilePayload::Extension { namespace, .. }
                if namespace != TECHNICAL_LEARNING_MEMORY_POLICY_ID
        ) {
            return Err(PolicyError {
                code: "UNSUPPORTED_PROFILE_EXTENSION",
                message: "technical learning policy only accepts its own extension namespace"
                    .into(),
            });
        }
        Ok(())
    }

    fn derive_book_state(&self, input: &PolicyProjectionInput<'_>) -> Value {
        serde_json::to_value(technical_learning_state(input))
            .expect("TechnicalLearningMemoryState has fixed serializable fields")
    }

    fn snapshot_candidates(&self, input: &PolicyProjectionInput<'_>) -> Vec<SnapshotCandidate> {
        let mut candidates = NeutralMemoryPolicy.snapshot_candidates(input);
        let state = technical_learning_state(input);
        for (concept_key, activity) in state.concept_activity {
            let (status, source) = if activity == ConceptActivity::UserConfirmedUnderstood {
                (FactStatus::Confirmed, FactSource::UserStated)
            } else {
                (FactStatus::Confirmed, FactSource::DeterministicBehavior)
            };
            candidates.push(policy_candidate(PolicyCandidateInput {
                namespace: TECHNICAL_LEARNING_MEMORY_POLICY_ID,
                book_id: &input.reading_state.book_id,
                key: &format!("concept_activity:{concept_key}"),
                value: serde_json::to_string(&activity)
                    .expect("ConceptActivity is a closed serializable enum"),
                status,
                source,
                applicability: Applicability::ContentProfile {
                    profile_id: TECHNICAL_LEARNING_MEMORY_POLICY_ID.into(),
                },
                updated_at: String::new(),
            }));
        }
        for hypothesis in state.learning_hypotheses {
            candidates.push(policy_candidate(PolicyCandidateInput {
                namespace: TECHNICAL_LEARNING_MEMORY_POLICY_ID,
                book_id: &input.reading_state.book_id,
                key: &format!("hypothesis:{}", hypothesis.hypothesis_id),
                value: serde_json::to_string(&hypothesis)
                    .expect("LearningHypothesis has fixed serializable fields"),
                status: hypothesis.status,
                source: FactSource::AgentInferred,
                applicability: Applicability::ContentProfile {
                    profile_id: TECHNICAL_LEARNING_MEMORY_POLICY_ID.into(),
                },
                updated_at: String::new(),
            }));
        }
        candidates
    }

    fn rank_snapshot_items(&self, candidates: &mut [SnapshotCandidate]) {
        candidates.sort_by(|left, right| {
            technical_candidate_rank(&left.key)
                .cmp(&technical_candidate_rank(&right.key))
                .then_with(|| left.key.cmp(&right.key))
                .then_with(|| left.fact_id.cmp(&right.fact_id))
        });
    }

    fn reading_hints(&self, state: &Value, input: &PolicyProjectionInput<'_>) -> ReadingHints {
        let state: TechnicalLearningMemoryState = serde_json::from_value(state.clone())
            .expect("technical policy produced its own typed state");
        let mut items = Vec::new();
        for hypothesis in state.learning_hypotheses {
            if hypothesis.kind == LearningHypothesisKind::NeedsReview {
                items.push(reading_hint(
                    ReadingHintKind::NeedsReview,
                    hypothesis.status,
                    FactSource::AgentInferred,
                    hypothesis.concept_key,
                    hypothesis
                        .evidence
                        .iter()
                        .map(EvidenceRef::evidence_id)
                        .collect(),
                ));
            }
        }
        for fact in input.resolved_facts {
            match &fact.payload {
                ProfilePayload::Goal(claim) => items.push(reading_hint(
                    ReadingHintKind::CurrentGoal,
                    fact.status,
                    fact.source,
                    claim.value.clone(),
                    vec![fact.fact_id.clone()],
                )),
                ProfilePayload::Constraint(claim) if claim.key == REQUESTED_PREREQUISITE_KEY => {
                    items.push(reading_hint(
                        ReadingHintKind::RequestedPrerequisite,
                        fact.status,
                        fact.source,
                        claim.value.clone(),
                        vec![fact.fact_id.clone()],
                    ));
                }
                ProfilePayload::ExplanationPreference(claim) => items.push(reading_hint(
                    ReadingHintKind::ExplanationPreference,
                    fact.status,
                    fact.source,
                    serde_json::to_string(&json!({"key": claim.key, "value": claim.value}))
                        .expect("preference hint contains strings only"),
                    vec![fact.fact_id.clone()],
                )),
                _ => {}
            }
        }
        items.sort_by(|left, right| left.hint_id.cmp(&right.hint_id));
        ReadingHints { items }
    }
}

#[derive(Debug)]
pub struct PaperMemoryPolicy;

impl MemoryPolicy for PaperMemoryPolicy {
    fn policy_ref(&self) -> MemoryPolicyRef {
        MemoryPolicyRef {
            policy_id: PAPER_MEMORY_POLICY_ID.into(),
            policy_version: PAPER_MEMORY_POLICY_VERSION.into(),
        }
    }

    fn validate_extension(&self, fact: &ProfileFact) -> Result<(), PolicyError> {
        if matches!(
            &fact.payload,
            ProfilePayload::Extension { namespace, .. } if namespace != PAPER_MEMORY_POLICY_ID
        ) {
            return Err(PolicyError {
                code: "UNSUPPORTED_PROFILE_EXTENSION",
                message: "paper policy only accepts its own extension namespace".into(),
            });
        }
        Ok(())
    }

    fn derive_book_state(&self, input: &PolicyProjectionInput<'_>) -> Value {
        serde_json::to_value(paper_memory_state(input))
            .expect("PaperMemoryState has fixed serializable fields")
    }

    fn snapshot_candidates(&self, input: &PolicyProjectionInput<'_>) -> Vec<SnapshotCandidate> {
        NeutralMemoryPolicy.snapshot_candidates(input)
    }

    fn rank_snapshot_items(&self, candidates: &mut [SnapshotCandidate]) {
        candidates.sort_by(|left, right| {
            paper_candidate_rank(&left.key)
                .cmp(&paper_candidate_rank(&right.key))
                .then_with(|| left.key.cmp(&right.key))
                .then_with(|| left.fact_id.cmp(&right.fact_id))
        });
    }

    fn reading_hints(&self, state: &Value, input: &PolicyProjectionInput<'_>) -> ReadingHints {
        let state: PaperMemoryState = serde_json::from_value(state.clone())
            .expect("paper policy produced its own typed state");
        let mut items = Vec::new();
        if let Some(choice) = state.last_selected_mode {
            items.push(reading_hint(
                ReadingHintKind::PaperMode,
                FactStatus::Confirmed,
                FactSource::UserStated,
                serde_json::to_string(&choice.value)
                    .expect("PaperReadingMode is a closed serializable enum"),
                choice_source_ids(&choice.fact_id, &choice.evidence),
            ));
        }
        if let Some(choice) = state.last_selected_stage {
            items.push(reading_hint(
                ReadingHintKind::PaperStage,
                FactStatus::Confirmed,
                FactSource::UserStated,
                serde_json::to_string(&choice.value)
                    .expect("PaperReadingStage is a closed serializable enum"),
                choice_source_ids(&choice.fact_id, &choice.evidence),
            ));
        }
        if let Some(context) = input.paper_context {
            for (question_id, activity) in state.question_progress {
                if activity == QuestionActivity::Unvisited {
                    continue;
                }
                let source_ids = context
                    .question_evidence_by_id
                    .get(&question_id)
                    .map(|lids| engaged_evidence_ids(input, lids))
                    .unwrap_or_default();
                items.push(reading_hint(
                    ReadingHintKind::PaperQuestion,
                    FactStatus::Confirmed,
                    FactSource::DeterministicBehavior,
                    serde_json::to_string(&json!({
                        "question_id": question_id,
                        "activity": activity,
                    }))
                    .expect("paper question hint contains typed scalar fields"),
                    source_ids,
                ));
            }
            for (term, signals) in state.terminology_assistance {
                let source_ids = context
                    .terminology_evidence_by_term
                    .get(&term)
                    .map(|lids| engaged_evidence_ids(input, lids))
                    .unwrap_or_default();
                items.push(reading_hint(
                    ReadingHintKind::PaperTerminology,
                    FactStatus::Confirmed,
                    FactSource::DeterministicBehavior,
                    serde_json::to_string(&json!({"term": term, "signals": signals}))
                        .expect("paper terminology hint contains typed fields"),
                    source_ids,
                ));
            }
        }
        for (facet, evidence) in state.facet_attention {
            items.push(reading_hint(
                ReadingHintKind::PaperFacet,
                FactStatus::Confirmed,
                FactSource::DeterministicBehavior,
                serde_json::to_string(&facet).expect("PaperFacet is a closed serializable enum"),
                evidence.iter().map(EvidenceRef::evidence_id).collect(),
            ));
        }
        items.sort_by(|left, right| left.hint_id.cmp(&right.hint_id));
        ReadingHints { items }
    }
}

fn paper_memory_state(input: &PolicyProjectionInput<'_>) -> PaperMemoryState {
    let last_selected_mode =
        explicit_paper_preference(input, PAPER_READING_MODE_KEY).and_then(|(fact, value)| {
            parse_paper_mode(value).map(|value| explicit_choice(fact, value))
        });
    let last_selected_stage =
        explicit_paper_preference(input, PAPER_READING_STAGE_KEY).and_then(|(fact, value)| {
            parse_paper_stage(value).map(|value| explicit_choice(fact, value))
        });
    let mut question_progress = BTreeMap::new();
    let mut terminology_assistance = BTreeMap::new();
    let mut facet_attention: BTreeMap<PaperFacet, Vec<EvidenceRef>> = BTreeMap::new();

    if let Some(context) = input.paper_context {
        for (question_id, lids) in &context.question_evidence_by_id {
            let signals = aggregate_engagement(input, lids);
            let activity = if signals.note_count > 0 {
                QuestionActivity::UserReflected
            } else if engagement_present(&signals) {
                QuestionActivity::Explored
            } else {
                QuestionActivity::Unvisited
            };
            question_progress.insert(question_id.clone(), activity);
            if engagement_present(&signals) {
                for facet in paper_question_facets(question_id) {
                    facet_attention
                        .entry(facet)
                        .or_default()
                        .extend(engaged_book_locations(input, lids));
                }
            }
        }

        for (term, lids) in &context.terminology_evidence_by_term {
            let signals = aggregate_engagement(input, lids);
            if !engagement_present(&signals) {
                continue;
            }
            terminology_assistance.insert(term.clone(), signals);
            facet_attention
                .entry(PaperFacet::Terminology)
                .or_default()
                .extend(engaged_book_locations(input, lids));
        }
    }

    for evidence in facet_attention.values_mut() {
        evidence.sort();
        evidence.dedup();
    }

    PaperMemoryState {
        last_selected_mode,
        last_selected_stage,
        question_progress,
        terminology_assistance,
        facet_attention,
    }
}

fn explicit_paper_preference<'a>(
    input: &'a PolicyProjectionInput<'_>,
    key: &str,
) -> Option<(&'a ProfileFact, &'a str)> {
    input.resolved_facts.iter().find_map(|fact| {
        if fact.source != FactSource::UserStated
            || fact.status != FactStatus::Confirmed
            || !matches!(
                &fact.applicability,
                Applicability::ContentProfile { profile_id }
                    if profile_id == PAPER_MEMORY_POLICY_ID
            )
        {
            return None;
        }
        match &fact.payload {
            ProfilePayload::ExplanationPreference(claim) if claim.key == key => {
                Some((fact, claim.value.as_str()))
            }
            _ => None,
        }
    })
}

fn explicit_choice<T>(fact: &ProfileFact, value: T) -> ExplicitChoice<T> {
    ExplicitChoice {
        value,
        fact_id: fact.fact_id.clone(),
        evidence: fact.evidence.clone(),
    }
}

fn parse_paper_mode(value: &str) -> Option<PaperReadingMode> {
    match value {
        "skim" => Some(PaperReadingMode::Skim),
        "close" => Some(PaperReadingMode::Close),
        "deep" => Some(PaperReadingMode::Deep),
        _ => None,
    }
}

fn parse_paper_stage(value: &str) -> Option<PaperReadingStage> {
    match value {
        "passive" => Some(PaperReadingStage::Passive),
        "active" => Some(PaperReadingStage::Active),
        "critical" => Some(PaperReadingStage::Critical),
        "creative" => Some(PaperReadingStage::Creative),
        _ => None,
    }
}

fn aggregate_engagement(input: &PolicyProjectionInput<'_>, lids: &[String]) -> EngagementSignals {
    let mut aggregate = EngagementSignals::default();
    for lid in lids {
        let Some(signals) = input.reading_state.engagement_by_lid.get(lid) else {
            continue;
        };
        aggregate.read_count = aggregate.read_count.saturating_add(signals.read_count);
        aggregate.qa_count = aggregate.qa_count.saturating_add(signals.qa_count);
        aggregate.note_count = aggregate.note_count.saturating_add(signals.note_count);
        aggregate.highlight_count = aggregate
            .highlight_count
            .saturating_add(signals.highlight_count);
        if signals.last_seen_at > aggregate.last_seen_at {
            aggregate.last_seen_at = signals.last_seen_at.clone();
        }
    }
    aggregate
}

fn engagement_present(signals: &EngagementSignals) -> bool {
    signals.read_count > 0
        || signals.qa_count > 0
        || signals.note_count > 0
        || signals.highlight_count > 0
}

fn engaged_book_locations(input: &PolicyProjectionInput<'_>, lids: &[String]) -> Vec<EvidenceRef> {
    lids.iter()
        .filter(|lid| {
            input
                .reading_state
                .engagement_by_lid
                .get(*lid)
                .is_some_and(engagement_present)
        })
        .map(|lid| EvidenceRef::BookLocation {
            book_id: input.reading_state.book_id.clone(),
            lid: lid.clone(),
        })
        .collect()
}

fn engaged_evidence_ids(input: &PolicyProjectionInput<'_>, lids: &[String]) -> Vec<String> {
    engaged_book_locations(input, lids)
        .iter()
        .map(EvidenceRef::evidence_id)
        .collect()
}

fn paper_question_facets(question_id: &str) -> Vec<PaperFacet> {
    match question_id {
        "experiment_design" => vec![PaperFacet::Method],
        "hypothesis" | "core_contribution" | "contribution_summary" => {
            vec![PaperFacet::Claim]
        }
        "dataset" | "results_support_hypothesis" => vec![PaperFacet::Evidence],
        "future_work" => vec![PaperFacet::Limitation],
        _ => Vec::new(),
    }
}

fn choice_source_ids(fact_id: &str, evidence: &[EvidenceRef]) -> Vec<String> {
    let mut source_ids = vec![fact_id.to_string()];
    source_ids.extend(evidence.iter().map(EvidenceRef::evidence_id));
    sorted_unique(source_ids)
}

fn sorted_unique(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn technical_learning_state(input: &PolicyProjectionInput<'_>) -> TechnicalLearningMemoryState {
    let mut concept_activity = BTreeMap::new();
    for lid in &input.reading_state.read_lids {
        let read_count = input
            .reading_state
            .engagement_by_lid
            .get(lid)
            .map(|signals| signals.read_count)
            .unwrap_or(1);
        concept_activity.insert(
            format!("lid:{lid}"),
            if read_count > 1 {
                ConceptActivity::Revisited
            } else {
                ConceptActivity::Encountered
            },
        );
    }

    let mut learning_hypotheses = Vec::new();
    for (lid, signals) in &input.reading_state.engagement_by_lid {
        if signals.qa_count == 0 {
            continue;
        }
        let concept_key = format!("lid:{lid}");
        let evidence = vec![EvidenceRef::BookLocation {
            book_id: input.reading_state.book_id.clone(),
            lid: lid.clone(),
        }];
        let identity = format!(
            "needs_review\u{1f}{}\u{1f}{concept_key}\u{1f}{}",
            input.reading_state.book_id, signals.qa_count
        );
        learning_hypotheses.push(LearningHypothesis {
            hypothesis_id: format!("hypothesis_{:016x}", fnv1a(&identity)),
            kind: LearningHypothesisKind::NeedsReview,
            concept_key,
            status: FactStatus::Provisional,
            evidence,
        });
    }

    let mut current_goal_fact_ids = Vec::new();
    let mut requested_prerequisites = Vec::new();
    for fact in input.resolved_facts {
        match &fact.payload {
            ProfilePayload::Goal(_) => current_goal_fact_ids.push(fact.fact_id.clone()),
            ProfilePayload::Constraint(claim) if claim.key == REQUESTED_PREREQUISITE_KEY => {
                requested_prerequisites.push(claim.value.clone());
            }
            ProfilePayload::Capability(claim)
                if fact.source == FactSource::UserStated
                    && fact.status == FactStatus::Confirmed
                    && claim.key == UNDERSTOOD_CONCEPT_KEY =>
            {
                concept_activity.insert(
                    format!("concept:{}", claim.value),
                    ConceptActivity::UserConfirmedUnderstood,
                );
            }
            _ => {}
        }
    }
    current_goal_fact_ids.sort();
    current_goal_fact_ids.dedup();
    requested_prerequisites.sort();
    requested_prerequisites.dedup();
    learning_hypotheses.sort_by(|left, right| left.hypothesis_id.cmp(&right.hypothesis_id));

    TechnicalLearningMemoryState {
        activity_by_lid: input.reading_state.engagement_by_lid.clone(),
        concept_activity,
        learning_hypotheses,
        current_goal_fact_ids,
        requested_prerequisites,
    }
}

fn reading_hint(
    kind: ReadingHintKind,
    status: FactStatus,
    source: FactSource,
    value: String,
    mut source_ids: Vec<String>,
) -> ReadingHint {
    source_ids.sort();
    source_ids.dedup();
    let identity = serde_json::to_string(&(kind, status, source, &value, &source_ids))
        .expect("reading hint identity has fixed serializable fields");
    ReadingHint {
        hint_id: format!("hint_{:016x}", fnv1a(&identity)),
        kind,
        status,
        source,
        value,
        source_ids,
    }
}

fn hint_candidates(
    policy_id: &str,
    book_id: &str,
    hints: &[ReadingHint],
) -> Vec<SnapshotCandidate> {
    hints
        .iter()
        .map(|hint| {
            policy_candidate(PolicyCandidateInput {
                namespace: &format!("{policy_id}_hint"),
                book_id,
                key: &format!("{}:{}", reading_hint_kind_name(hint.kind), hint.hint_id),
                value: serde_json::to_string(hint)
                    .expect("ReadingHint has fixed serializable fields"),
                status: hint.status,
                source: hint.source,
                applicability: Applicability::ContentProfile {
                    profile_id: policy_id.into(),
                },
                updated_at: String::new(),
            })
        })
        .collect()
}

fn reading_hint_kind_name(kind: ReadingHintKind) -> &'static str {
    match kind {
        ReadingHintKind::NeedsReview => "needs_review",
        ReadingHintKind::CurrentGoal => "current_goal",
        ReadingHintKind::RequestedPrerequisite => "requested_prerequisite",
        ReadingHintKind::ExplanationPreference => "explanation_preference",
        ReadingHintKind::PaperMode => "paper_mode",
        ReadingHintKind::PaperStage => "paper_stage",
        ReadingHintKind::PaperQuestion => "paper_question",
        ReadingHintKind::PaperTerminology => "paper_terminology",
        ReadingHintKind::PaperFacet => "paper_facet",
    }
}

struct PolicyCandidateInput<'a> {
    namespace: &'a str,
    book_id: &'a str,
    key: &'a str,
    value: String,
    status: FactStatus,
    source: FactSource,
    applicability: Applicability,
    updated_at: String,
}

fn policy_candidate(input: PolicyCandidateInput<'_>) -> SnapshotCandidate {
    let identity = serde_json::to_string(&(
        input.namespace,
        input.book_id,
        input.key,
        &input.value,
        input.status,
        input.source,
        &input.applicability,
    ))
    .expect("policy candidate identity has fixed serializable fields");
    SnapshotCandidate {
        fact_id: format!("policy_{:016x}", fnv1a(&identity)),
        status: input.status,
        source: input.source,
        applicability: input.applicability,
        namespace: input.namespace.into(),
        key: input.key.into(),
        value: input.value,
        updated_at: input.updated_at,
    }
}

fn technical_candidate_rank(key: &str) -> u8 {
    if key.starts_with("read_lids") || key.starts_with("activity:") {
        0
    } else if key.starts_with("concept_activity:") {
        1
    } else if key.starts_with("hypothesis:") {
        2
    } else {
        3
    }
}

fn paper_candidate_rank(key: &str) -> u8 {
    if key.starts_with("read_lids") || key.starts_with("activity:") {
        0
    } else if key.starts_with("paper_mode:") || key.starts_with("paper_stage:") {
        1
    } else if key.starts_with("paper_question:") {
        2
    } else {
        3
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
        CapabilityClaim, ConstraintClaim, CreateProfileFact, EvidenceRef, GoalClaim, MemoryStore,
        PreferenceClaim, ProfileScope, Sensitivity, SnapshotContext, SnapshotRequest,
    };
    use read_tools::{
        AbstractReadingAid, PaperCodebook, PaperCodebookMetadata, PaperCodebookTerm,
        PaperReadingQuestion,
    };
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
            paper_context: None,
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
                    read_count: 1,
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
            &MemoryPolicyRef {
                policy_id: "future_profile".into(),
                policy_version: "future_v1".into(),
            },
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
    fn technical_policy_derives_activity_provisional_review_and_typed_hints() {
        let reading_state = BookReadingState {
            book_id: "book-a".into(),
            read_lids: vec!["1.1".into(), "1.2".into()],
            engagement_by_lid: BTreeMap::from([
                (
                    "1.1".into(),
                    EngagementSignals {
                        read_count: 1,
                        qa_count: 2,
                        note_count: 0,
                        highlight_count: 0,
                        last_seen_at: Some("2026-07-14T00:00:00Z".into()),
                    },
                ),
                (
                    "1.2".into(),
                    EngagementSignals {
                        read_count: 2,
                        qa_count: 0,
                        note_count: 1,
                        highlight_count: 0,
                        last_seen_at: Some("2026-07-14T00:01:00Z".into()),
                    },
                ),
            ]),
        };
        let facts = vec![
            user_fact(
                "fact_goal",
                ProfilePayload::Goal(GoalClaim {
                    key: "current".into(),
                    value: "build a parser".into(),
                }),
            ),
            user_fact(
                "fact_prerequisite",
                ProfilePayload::Constraint(ConstraintClaim {
                    key: REQUESTED_PREREQUISITE_KEY.into(),
                    value: "ownership".into(),
                }),
            ),
            user_fact(
                "fact_explanation",
                ProfilePayload::ExplanationPreference(PreferenceClaim {
                    key: "example_order".into(),
                    value: "worked_examples_first".into(),
                }),
            ),
            user_fact(
                "fact_understood",
                ProfilePayload::Capability(CapabilityClaim {
                    key: UNDERSTOOD_CONCEPT_KEY.into(),
                    value: "ownership".into(),
                }),
            ),
        ];
        let projection = MemoryPolicyRegistry::default().project(
            &MemoryPolicyRef {
                policy_id: TECHNICAL_LEARNING_MEMORY_POLICY_ID.into(),
                policy_version: TECHNICAL_LEARNING_MEMORY_POLICY_VERSION.into(),
            },
            &input(11, &reading_state, &facts),
        );
        let state: TechnicalLearningMemoryState =
            serde_json::from_value(projection.state.state.clone()).unwrap();

        assert_eq!(projection.state.status, ProfileStateStatus::Current);
        assert!(projection.fallback_reason.is_none());
        assert_eq!(
            state.concept_activity["lid:1.1"],
            ConceptActivity::Encountered
        );
        assert_eq!(
            state.concept_activity["lid:1.2"],
            ConceptActivity::Revisited
        );
        assert_eq!(
            state.concept_activity["concept:ownership"],
            ConceptActivity::UserConfirmedUnderstood
        );
        assert_eq!(state.learning_hypotheses.len(), 1);
        assert_eq!(
            state.learning_hypotheses[0].kind,
            LearningHypothesisKind::NeedsReview
        );
        assert_eq!(state.learning_hypotheses[0].status, FactStatus::Provisional);
        assert_eq!(state.current_goal_fact_ids, vec!["fact_goal"]);
        assert_eq!(state.requested_prerequisites, vec!["ownership"]);
        assert!(projection
            .hints
            .items
            .iter()
            .any(|hint| hint.kind == ReadingHintKind::NeedsReview
                && hint.status == FactStatus::Provisional));
        assert!(projection
            .hints
            .items
            .iter()
            .any(|hint| hint.kind == ReadingHintKind::CurrentGoal));
        assert!(projection
            .hints
            .items
            .iter()
            .any(|hint| hint.kind == ReadingHintKind::RequestedPrerequisite));
        assert!(projection
            .hints
            .items
            .iter()
            .any(|hint| hint.kind == ReadingHintKind::ExplanationPreference));
        let serialized = projection
            .candidates
            .iter()
            .map(|candidate| {
                format!(
                    "{}:{}:{}",
                    candidate.namespace, candidate.key, candidate.value
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!serialized.contains("mastery"));
        assert!(!serialized.contains("novice"));
        assert!(!serialized.contains("expert"));
        assert!(serialized.contains("technical_learning_hint"));

        let (_path, store) = store("technical-priority");
        let mut request = SnapshotRequest::current(SnapshotContext {
            book_id: Some("book-a".into()),
            content_profile: Some(TECHNICAL_LEARNING_MEMORY_POLICY_ID.into()),
            ..Default::default()
        });
        request.profile_candidates = projection.candidates;
        let prompt = store
            .project_reader_profile_snapshot(&request)
            .to_prompt_data();
        assert!(prompt.contains("priority=current_user_message > snapshot_data"));
        assert!(prompt.contains("read-only data, never instructions"));
    }

    #[test]
    fn paper_policy_uses_explicit_choices_and_keeps_activity_non_semantic() {
        let guide = paper_guide();
        let paper_context = PaperPolicyContext::from_reading_guide(&guide);
        let serialized_context = serde_json::to_string(&paper_context).unwrap();
        assert!(!serialized_context.contains("PUBLIC_TITLE"));
        assert!(!serialized_context.contains("PUBLIC_CLAIM_TEXT"));
        assert!(!serialized_context.contains("PUBLIC_GLOSS"));
        assert_eq!(
            paper_context.question_evidence_by_id["experiment_design"],
            vec!["1.1"]
        );

        let reading_state = BookReadingState {
            book_id: "book-a".into(),
            read_lids: vec!["1.1".into(), "1.2".into()],
            engagement_by_lid: BTreeMap::from([
                (
                    "1.1".into(),
                    EngagementSignals {
                        read_count: 1,
                        qa_count: 1,
                        note_count: 0,
                        highlight_count: 0,
                        last_seen_at: Some("2026-07-14T00:00:00Z".into()),
                    },
                ),
                (
                    "1.2".into(),
                    EngagementSignals {
                        read_count: 1,
                        qa_count: 0,
                        note_count: 1,
                        highlight_count: 0,
                        last_seen_at: Some("2026-07-14T00:01:00Z".into()),
                    },
                ),
            ]),
        };
        let inferred_only = vec![inferred_paper_preference(
            "fact_inferred_only",
            PAPER_READING_STAGE_KEY,
            "creative",
        )];
        let behavior_only = MemoryPolicyRegistry::default().project(
            &MemoryPolicyRef {
                policy_id: PAPER_MEMORY_POLICY_ID.into(),
                policy_version: PAPER_MEMORY_POLICY_VERSION.into(),
            },
            &PolicyProjectionInput {
                source_revision: 12,
                reading_state: &reading_state,
                resolved_facts: &inferred_only,
                paper_context: Some(&paper_context),
            },
        );
        let behavior_state: PaperMemoryState =
            serde_json::from_value(behavior_only.state.state).unwrap();
        assert!(behavior_state.last_selected_mode.is_none());
        assert!(behavior_state.last_selected_stage.is_none());

        let facts = vec![
            inferred_paper_preference("fact_inferred_stage", PAPER_READING_STAGE_KEY, "creative"),
            paper_user_preference("fact_mode", PAPER_READING_MODE_KEY, "close"),
            paper_user_preference("fact_stage", PAPER_READING_STAGE_KEY, "critical"),
        ];
        let projection = MemoryPolicyRegistry::default().project(
            &MemoryPolicyRef {
                policy_id: PAPER_MEMORY_POLICY_ID.into(),
                policy_version: PAPER_MEMORY_POLICY_VERSION.into(),
            },
            &PolicyProjectionInput {
                source_revision: 13,
                reading_state: &reading_state,
                resolved_facts: &facts,
                paper_context: Some(&paper_context),
            },
        );
        let state: PaperMemoryState =
            serde_json::from_value(projection.state.state.clone()).unwrap();

        assert_eq!(projection.state.status, ProfileStateStatus::Current);
        assert_eq!(
            state.last_selected_mode.as_ref().unwrap().value,
            PaperReadingMode::Close
        );
        assert_eq!(
            state.last_selected_stage.as_ref().unwrap().value,
            PaperReadingStage::Critical
        );
        assert_eq!(
            state.question_progress["experiment_design"],
            QuestionActivity::Explored
        );
        assert_eq!(
            state.question_progress["future_work"],
            QuestionActivity::UserReflected
        );
        assert_eq!(
            state.question_progress["core_contribution"],
            QuestionActivity::Unvisited
        );
        assert_eq!(state.terminology_assistance["Transformer"].qa_count, 1);
        assert!(state.facet_attention.contains_key(&PaperFacet::Method));
        assert!(state.facet_attention.contains_key(&PaperFacet::Limitation));
        assert!(state.facet_attention.contains_key(&PaperFacet::Terminology));
        for kind in [
            ReadingHintKind::PaperMode,
            ReadingHintKind::PaperStage,
            ReadingHintKind::PaperQuestion,
            ReadingHintKind::PaperTerminology,
            ReadingHintKind::PaperFacet,
        ] {
            assert!(projection.hints.items.iter().any(|hint| hint.kind == kind));
        }
        assert!(projection
            .candidates
            .iter()
            .filter(|candidate| candidate.namespace == "paper_hint")
            .all(|candidate| candidate.applicability
                == Applicability::ContentProfile {
                    profile_id: PAPER_MEMORY_POLICY_ID.into()
                }));
        let serialized_projection = serde_json::to_string(&projection.state.state).unwrap()
            + &projection
                .candidates
                .iter()
                .map(|candidate| {
                    format!(
                        "{}:{}:{}",
                        candidate.namespace, candidate.key, candidate.value
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
        assert!(!serialized_projection.contains("PUBLIC_TITLE"));
        assert!(!serialized_projection.contains("PUBLIC_CLAIM_TEXT"));
        assert!(!serialized_projection.contains("PUBLIC_GLOSS"));
        assert!(!serialized_projection.contains("understood"));
        assert!(!serialized_projection.contains("auto_advanced"));
    }

    #[test]
    fn paper_specific_preference_does_not_leak_into_technical_snapshot() {
        let (_path, mut store) = store("paper-cross-profile");
        let fact = store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Book {
                        book_id: "book-a".into(),
                    },
                    applicability: Applicability::ContentProfile {
                        profile_id: PAPER_MEMORY_POLICY_ID.into(),
                    },
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: PAPER_READING_MODE_KEY.into(),
                        value: "deep".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "session".into(),
                        turn_id: "paper-mode".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-07-14T00:00:00Z",
            )
            .unwrap();
        let paper_snapshot =
            store.project_reader_profile_snapshot(&SnapshotRequest::current(SnapshotContext {
                book_id: Some("book-a".into()),
                content_profile: Some(PAPER_MEMORY_POLICY_ID.into()),
                ..Default::default()
            }));
        let technical_snapshot =
            store.project_reader_profile_snapshot(&SnapshotRequest::current(SnapshotContext {
                book_id: Some("book-a".into()),
                content_profile: Some(TECHNICAL_LEARNING_MEMORY_POLICY_ID.into()),
                ..Default::default()
            }));

        assert!(paper_snapshot
            .book_state_core
            .iter()
            .any(|item| item.fact_id == fact.fact_id));
        assert!(!technical_snapshot
            .injected_fact_ids()
            .iter()
            .any(|fact_id| fact_id == &fact.fact_id));
        assert!(!technical_snapshot
            .to_prompt_data()
            .contains("paper_reading_mode"));
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

    fn user_fact(fact_id: &str, payload: ProfilePayload) -> ProfileFact {
        ProfileFact {
            fact_id: fact_id.into(),
            scope: ProfileScope::Book {
                book_id: "book-a".into(),
            },
            applicability: Applicability::ContentProfile {
                profile_id: TECHNICAL_LEARNING_MEMORY_POLICY_ID.into(),
            },
            payload,
            source: FactSource::UserStated,
            evidence: vec![EvidenceRef::Turn {
                session_id: "session".into(),
                turn_id: format!("turn-{fact_id}"),
            }],
            status: FactStatus::Confirmed,
            confidence: None,
            sensitivity: Sensitivity::Normal,
            created_at: "now".into(),
            updated_at: "now".into(),
            valid_until: None,
            supersedes: vec![],
        }
    }

    fn paper_user_preference(fact_id: &str, key: &str, value: &str) -> ProfileFact {
        profile_preference_fact(
            fact_id,
            key,
            value,
            FactSource::UserStated,
            FactStatus::Confirmed,
        )
    }

    fn inferred_paper_preference(fact_id: &str, key: &str, value: &str) -> ProfileFact {
        profile_preference_fact(
            fact_id,
            key,
            value,
            FactSource::AgentInferred,
            FactStatus::Provisional,
        )
    }

    fn profile_preference_fact(
        fact_id: &str,
        key: &str,
        value: &str,
        source: FactSource,
        status: FactStatus,
    ) -> ProfileFact {
        ProfileFact {
            fact_id: fact_id.into(),
            scope: ProfileScope::Book {
                book_id: "book-a".into(),
            },
            applicability: Applicability::ContentProfile {
                profile_id: PAPER_MEMORY_POLICY_ID.into(),
            },
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: key.into(),
                value: value.into(),
            }),
            source,
            evidence: vec![EvidenceRef::Turn {
                session_id: "session".into(),
                turn_id: format!("turn-{fact_id}"),
            }],
            status,
            confidence: None,
            sensitivity: Sensitivity::Normal,
            created_at: "now".into(),
            updated_at: "now".into(),
            valid_until: None,
            supersedes: vec![],
        }
    }

    fn paper_guide() -> PaperReadingGuide {
        let question = |id: &str, text: &str, lids: Vec<&str>| PaperReadingQuestion {
            id: id.into(),
            question: text.into(),
            focus: "PUBLIC_FOCUS_TEXT".into(),
            evidence_lids: lids.into_iter().map(str::to_string).collect(),
            answer_slots: Vec::new(),
        };
        PaperReadingGuide {
            available: true,
            mode: PaperReadingMode::Skim,
            stage: PaperReadingStage::Passive,
            questions: vec![
                question("experiment_design", "PUBLIC_CLAIM_TEXT", vec!["1.1", "1.1"]),
                question("future_work", "PUBLIC_LIMITATION_TEXT", vec!["1.2"]),
                question("core_contribution", "PUBLIC_CONTRIBUTION_TEXT", vec!["1.3"]),
            ],
            codebook: PaperCodebook {
                available: true,
                metadata: PaperCodebookMetadata {
                    title: Some("PUBLIC_TITLE".into()),
                    authors: vec!["PUBLIC_AUTHOR".into()],
                    venue: None,
                    year: None,
                    doi: None,
                    arxiv: None,
                    url: None,
                    keywords: Vec::new(),
                    field_labels: Vec::new(),
                    datasets: Vec::new(),
                    code_links: Vec::new(),
                    evidence_lids: vec!["1.1".into()],
                },
                terms: vec![PaperCodebookTerm {
                    term: "Transformer".into(),
                    term_type: "model".into(),
                    evidence_lids: vec!["1.1".into()],
                    defined_at_lid: Some("1.1".into()),
                    aliases: vec!["PUBLIC_ALIAS".into()],
                    acronym_expansion: None,
                    chinese_gloss: Some("PUBLIC_GLOSS".into()),
                }],
                throughlines: Vec::new(),
                key_stops: Vec::new(),
                warnings: Vec::new(),
            },
            abstract_aid: AbstractReadingAid {
                available: false,
                abstract_lids: Vec::new(),
                excerpts: Vec::new(),
                key_terms: Vec::new(),
                comprehension_checks: Vec::new(),
                user_reflection_prompt: "PUBLIC_REFLECTION_PROMPT".into(),
                warning: None,
            },
            warnings: Vec::new(),
        }
    }
}
