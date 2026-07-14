use crate::{fnv1a, MemoryStore};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackgroundClaim {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityClaim {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalClaim {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreferenceClaim {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConstraintClaim {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "claim", rename_all = "snake_case")]
pub enum ProfilePayload {
    Background(BackgroundClaim),
    Capability(CapabilityClaim),
    Goal(GoalClaim),
    ExplanationPreference(PreferenceClaim),
    Constraint(ConstraintClaim),
    Extension {
        namespace: String,
        key: String,
        value: Value,
    },
}

impl ProfilePayload {
    pub fn semantic_key(&self) -> String {
        match self {
            ProfilePayload::Background(claim) => format!("background:{}", claim.key),
            ProfilePayload::Capability(claim) => format!("capability:{}", claim.key),
            ProfilePayload::Goal(claim) => format!("goal:{}", claim.key),
            ProfilePayload::ExplanationPreference(claim) => {
                format!("explanation_preference:{}", claim.key)
            }
            ProfilePayload::Constraint(claim) => format!("constraint:{}", claim.key),
            ProfilePayload::Extension { namespace, key, .. } => {
                format!("extension:{namespace}:{key}")
            }
        }
    }

    fn validate(&self) -> Result<(), ToolError> {
        match self {
            ProfilePayload::Background(claim) => {
                validate_claim("background", &claim.key, &claim.value)
            }
            ProfilePayload::Capability(claim) => {
                validate_claim("capability", &claim.key, &claim.value)
            }
            ProfilePayload::Goal(claim) => validate_claim("goal", &claim.key, &claim.value),
            ProfilePayload::ExplanationPreference(claim) => {
                validate_claim("explanation_preference", &claim.key, &claim.value)
            }
            ProfilePayload::Constraint(claim) => {
                validate_claim("constraint", &claim.key, &claim.value)
            }
            ProfilePayload::Extension { namespace, key, .. } => {
                if namespace.trim().is_empty() || key.trim().is_empty() {
                    return Err(invalid_profile_fact(
                        "extension namespace/key 不得为空".into(),
                    ));
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileScope {
    Global,
    Book { book_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Applicability {
    Any,
    ContentProfile { profile_id: String },
    PaperSubtype { subtype: String },
    Domain { domain: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvidenceRef {
    Turn { session_id: String, turn_id: String },
    MemoryRecord { mem_id: String },
    BookLocation { book_id: String, lid: String },
}

impl EvidenceRef {
    pub fn evidence_id(&self) -> String {
        let canonical = serde_json::to_string(self)
            .expect("EvidenceRef with fixed serializable fields cannot fail");
        format!("evidence_{:016x}", fnv1a(&canonical))
    }

    fn validate(&self) -> Result<(), ToolError> {
        let invalid = match self {
            EvidenceRef::Turn {
                session_id,
                turn_id,
            } => session_id.trim().is_empty() || turn_id.trim().is_empty(),
            EvidenceRef::MemoryRecord { mem_id } => mem_id.trim().is_empty(),
            EvidenceRef::BookLocation { book_id, lid } => {
                book_id.trim().is_empty() || lid.trim().is_empty()
            }
        };
        if invalid {
            return Err(invalid_profile_fact(
                "profile evidence identifier 不得为空".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FactSource {
    DeterministicBehavior,
    UserStated,
    AgentInferred,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FactStatus {
    Confirmed,
    Provisional,
    Pending,
    Superseded,
    Expired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Normal,
    Sensitive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileFact {
    pub fact_id: String,
    pub scope: ProfileScope,
    pub applicability: Applicability,
    pub payload: ProfilePayload,
    pub source: FactSource,
    pub evidence: Vec<EvidenceRef>,
    pub status: FactStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<Confidence>,
    pub sensitivity: Sensitivity,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
}

impl ProfileFact {
    pub(crate) fn validate_persisted(&self) -> Result<(), ToolError> {
        if !self.fact_id.starts_with("fact_") {
            return Err(invalid_profile_fact(format!(
                "非法 profile fact_id: {}",
                self.fact_id
            )));
        }
        validate_scope(&self.scope)?;
        validate_applicability(&self.applicability)?;
        self.payload.validate()?;
        for evidence in &self.evidence {
            evidence.validate()?;
        }
        if self.created_at.trim().is_empty() || self.updated_at.trim().is_empty() {
            return Err(invalid_profile_fact(
                "profile fact created_at/updated_at 不得为空".into(),
            ));
        }
        if self
            .valid_until
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(invalid_profile_fact("valid_until 不得为空字符串".into()));
        }
        validate_source_contract(
            self.source,
            &self.scope,
            self.status,
            self.confidence,
            self.sensitivity,
            self.evidence.is_empty(),
        )?;
        if self
            .supersedes
            .iter()
            .any(|id| id.trim().is_empty() || id == &self.fact_id)
        {
            return Err(invalid_profile_fact(
                "supersedes 必须引用其他非空 fact_id".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CreateProfileFact {
    pub scope: ProfileScope,
    pub applicability: Applicability,
    pub payload: ProfilePayload,
    pub source: FactSource,
    pub evidence: Vec<EvidenceRef>,
    pub confidence: Option<Confidence>,
    pub sensitivity: Sensitivity,
    pub valid_until: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExclusionReason {
    Forgotten,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceExclusion {
    pub evidence_id: String,
    pub reason: ExclusionReason,
    pub created_at: String,
}

impl EvidenceExclusion {
    pub(crate) fn validate(&self) -> Result<(), ToolError> {
        if !self.evidence_id.starts_with("evidence_") || self.created_at.trim().is_empty() {
            return Err(invalid_profile_fact(
                "evidence exclusion id/created_at 非法".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetProfileFactOutcome {
    pub forgotten_fact_id: String,
    pub excluded_evidence_ids: Vec<String>,
    pub removed_dependent_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProfileResolutionContext {
    pub book_id: Option<String>,
    pub content_profile: Option<String>,
    pub paper_subtype: Option<String>,
    pub domain: Option<String>,
    pub now: Option<String>,
}

impl MemoryStore {
    pub fn profile_facts(&self) -> &[ProfileFact] {
        &self.document.profile_facts
    }

    pub fn evidence_exclusions(&self) -> &[EvidenceExclusion] {
        &self.document.exclusions
    }

    pub fn create_profile_fact(
        &mut self,
        input: CreateProfileFact,
        now: &str,
    ) -> Result<ProfileFact, ToolError> {
        let fact = build_profile_fact(input, Vec::new(), now)?;
        reject_excluded_evidence(&self.document.exclusions, &fact.evidence)?;
        if let Some(existing) = self
            .document
            .profile_facts
            .iter()
            .find(|candidate| candidate.fact_id == fact.fact_id)
        {
            return Ok(existing.clone());
        }

        let mut candidate = self.projection_mutation_candidate()?;
        candidate.profile_facts.push(fact.clone());
        self.commit_document(candidate)?;
        Ok(fact)
    }

    pub fn confirm_profile_fact(
        &mut self,
        fact_id: &str,
        now: &str,
    ) -> Result<ProfileFact, ToolError> {
        let current = self
            .document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == fact_id)
            .cloned()
            .ok_or_else(|| profile_fact_not_found(fact_id))?;
        match current.status {
            FactStatus::Confirmed => return Ok(current),
            FactStatus::Pending | FactStatus::Provisional => {}
            FactStatus::Superseded | FactStatus::Expired => {
                return Err(profile_state_conflict(format!(
                    "不能确认 {:?} profile fact: {fact_id}",
                    current.status
                )))
            }
        }
        validate_now(now)?;

        let mut candidate = self.projection_mutation_candidate()?;
        let fact = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        fact.status = FactStatus::Confirmed;
        fact.updated_at = now.to_string();
        let confirmed = fact.clone();
        self.commit_document(candidate)?;
        Ok(confirmed)
    }

    pub fn correct_profile_fact(
        &mut self,
        fact_id: &str,
        replacement: CreateProfileFact,
        now: &str,
    ) -> Result<ProfileFact, ToolError> {
        let current = self
            .document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == fact_id)
            .cloned()
            .ok_or_else(|| profile_fact_not_found(fact_id))?;
        if matches!(current.status, FactStatus::Superseded | FactStatus::Expired) {
            return Err(profile_state_conflict(format!(
                "不能纠正 {:?} profile fact: {fact_id}",
                current.status
            )));
        }
        if replacement.source != FactSource::UserStated {
            return Err(invalid_profile_fact(
                "profile correction 必须由 user_stated 提交".into(),
            ));
        }
        let corrected = build_profile_fact(replacement, vec![fact_id.to_string()], now)?;
        reject_excluded_evidence(&self.document.exclusions, &corrected.evidence)?;
        if self
            .document
            .profile_facts
            .iter()
            .any(|fact| fact.fact_id == corrected.fact_id)
        {
            return Err(profile_state_conflict(format!(
                "profile correction 已存在: {}",
                corrected.fact_id
            )));
        }

        let mut candidate = self.projection_mutation_candidate()?;
        let old = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        old.status = FactStatus::Superseded;
        old.updated_at = now.to_string();
        candidate.profile_facts.push(corrected.clone());
        self.commit_document(candidate)?;
        Ok(corrected)
    }

    pub fn expire_profile_fact(
        &mut self,
        fact_id: &str,
        now: &str,
    ) -> Result<ProfileFact, ToolError> {
        let current = self
            .document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == fact_id)
            .cloned()
            .ok_or_else(|| profile_fact_not_found(fact_id))?;
        match current.status {
            FactStatus::Expired => return Ok(current),
            FactStatus::Superseded => {
                return Err(profile_state_conflict(format!(
                    "不能过期 superseded profile fact: {fact_id}"
                )))
            }
            FactStatus::Confirmed | FactStatus::Pending | FactStatus::Provisional => {}
        }
        validate_now(now)?;

        let mut candidate = self.projection_mutation_candidate()?;
        let fact = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        fact.status = FactStatus::Expired;
        fact.updated_at = now.to_string();
        let expired = fact.clone();
        self.commit_document(candidate)?;
        Ok(expired)
    }

    pub fn forget_profile_fact(
        &mut self,
        fact_id: &str,
        now: &str,
    ) -> Result<ForgetProfileFactOutcome, ToolError> {
        validate_now(now)?;
        let index = self
            .document
            .profile_facts
            .iter()
            .position(|fact| fact.fact_id == fact_id)
            .ok_or_else(|| profile_fact_not_found(fact_id))?;
        let target = self.document.profile_facts[index].clone();
        let mut excluded_evidence_ids: Vec<String> = target
            .evidence
            .iter()
            .map(EvidenceRef::evidence_id)
            .collect();
        excluded_evidence_ids.sort();
        excluded_evidence_ids.dedup();

        let mut candidate = self.projection_mutation_candidate()?;
        candidate.profile_facts.remove(index);
        for evidence_id in &excluded_evidence_ids {
            if !candidate
                .exclusions
                .iter()
                .any(|exclusion| &exclusion.evidence_id == evidence_id)
            {
                candidate.exclusions.push(EvidenceExclusion {
                    evidence_id: evidence_id.clone(),
                    reason: ExclusionReason::Forgotten,
                    created_at: now.to_string(),
                });
            }
        }

        let excluded: BTreeSet<&str> = candidate
            .exclusions
            .iter()
            .map(|exclusion| exclusion.evidence_id.as_str())
            .collect();
        for fact in &mut candidate.profile_facts {
            fact.evidence
                .retain(|evidence| !excluded.contains(evidence.evidence_id().as_str()));
        }
        let mut removed_dependent_fact_ids: Vec<String> = candidate
            .profile_facts
            .iter()
            .filter(|fact| fact.source != FactSource::UserStated && fact.evidence.is_empty())
            .map(|fact| fact.fact_id.clone())
            .collect();
        candidate
            .profile_facts
            .retain(|fact| fact.source == FactSource::UserStated || !fact.evidence.is_empty());
        removed_dependent_fact_ids.sort();
        candidate
            .exclusions
            .sort_by(|a, b| a.evidence_id.cmp(&b.evidence_id));
        self.commit_document(candidate)?;

        Ok(ForgetProfileFactOutcome {
            forgotten_fact_id: fact_id.to_string(),
            excluded_evidence_ids,
            removed_dependent_fact_ids,
        })
    }

    pub fn resolve_profile_facts(&self, context: &ProfileResolutionContext) -> Vec<ProfileFact> {
        let mut winners: BTreeMap<String, &ProfileFact> = BTreeMap::new();
        for fact in &self.document.profile_facts {
            if !fact_is_resolvable(fact, context) {
                continue;
            }
            let key = fact.payload.semantic_key();
            match winners.get(&key) {
                Some(current)
                    if compare_resolution(fact, current, context) != Ordering::Greater => {}
                _ => {
                    winners.insert(key, fact);
                }
            }
        }
        winners.into_values().cloned().collect()
    }
}

#[derive(Serialize)]
struct ProfileFactIdentity<'a> {
    scope: &'a ProfileScope,
    applicability: &'a Applicability,
    payload: &'a ProfilePayload,
    source: FactSource,
    evidence: &'a [EvidenceRef],
    confidence: Option<Confidence>,
    sensitivity: Sensitivity,
    valid_until: &'a Option<String>,
    supersedes: &'a [String],
}

pub(crate) fn build_profile_fact(
    mut input: CreateProfileFact,
    mut supersedes: Vec<String>,
    now: &str,
) -> Result<ProfileFact, ToolError> {
    validate_now(now)?;
    input.evidence.sort();
    input.evidence.dedup();
    supersedes.sort();
    supersedes.dedup();
    validate_create_input(&input)?;
    let status = initial_status(input.source, &input.scope)?;
    let identity = ProfileFactIdentity {
        scope: &input.scope,
        applicability: &input.applicability,
        payload: &input.payload,
        source: input.source,
        evidence: &input.evidence,
        confidence: input.confidence,
        sensitivity: input.sensitivity,
        valid_until: &input.valid_until,
        supersedes: &supersedes,
    };
    let canonical = serde_json::to_string(&identity)
        .map_err(|error| invalid_profile_fact(format!("profile identity 序列化失败: {error}")))?;
    let fact = ProfileFact {
        fact_id: format!("fact_{:016x}", fnv1a(&canonical)),
        scope: input.scope,
        applicability: input.applicability,
        payload: input.payload,
        source: input.source,
        evidence: input.evidence,
        status,
        confidence: input.confidence,
        sensitivity: input.sensitivity,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        valid_until: input.valid_until,
        supersedes,
    };
    fact.validate_persisted()?;
    Ok(fact)
}

fn validate_create_input(input: &CreateProfileFact) -> Result<(), ToolError> {
    validate_scope(&input.scope)?;
    validate_applicability(&input.applicability)?;
    input.payload.validate()?;
    if input.evidence.is_empty() {
        return Err(invalid_profile_fact(
            "新 profile fact 至少需要一条 evidence".into(),
        ));
    }
    for evidence in &input.evidence {
        evidence.validate()?;
    }
    if input
        .valid_until
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(invalid_profile_fact("valid_until 不得为空字符串".into()));
    }
    let status = initial_status(input.source, &input.scope)?;
    validate_source_contract(
        input.source,
        &input.scope,
        status,
        input.confidence,
        input.sensitivity,
        false,
    )
}

fn validate_scope(scope: &ProfileScope) -> Result<(), ToolError> {
    if matches!(scope, ProfileScope::Book { book_id } if book_id.trim().is_empty()) {
        return Err(invalid_profile_fact("book scope 需要 book_id".into()));
    }
    Ok(())
}

fn validate_applicability(applicability: &Applicability) -> Result<(), ToolError> {
    let invalid = match applicability {
        Applicability::Any => false,
        Applicability::ContentProfile { profile_id } => profile_id.trim().is_empty(),
        Applicability::PaperSubtype { subtype } => subtype.trim().is_empty(),
        Applicability::Domain { domain } => domain.trim().is_empty(),
    };
    if invalid {
        return Err(invalid_profile_fact(
            "profile applicability identifier 不得为空".into(),
        ));
    }
    Ok(())
}

fn validate_claim(kind: &str, key: &str, value: &str) -> Result<(), ToolError> {
    if key.trim().is_empty() || value.trim().is_empty() {
        return Err(invalid_profile_fact(format!(
            "{kind} claim key/value 不得为空"
        )));
    }
    Ok(())
}

fn validate_source_contract(
    source: FactSource,
    scope: &ProfileScope,
    status: FactStatus,
    confidence: Option<Confidence>,
    sensitivity: Sensitivity,
    evidence_is_empty: bool,
) -> Result<(), ToolError> {
    if source != FactSource::AgentInferred && confidence.is_some() {
        return Err(invalid_profile_fact(
            "confidence 只允许用于 agent_inferred fact".into(),
        ));
    }
    if sensitivity == Sensitivity::Sensitive && source != FactSource::UserStated {
        return Err(invalid_profile_fact(
            "sensitive profile fact 只允许用户明确陈述".into(),
        ));
    }
    if source == FactSource::DeterministicBehavior && matches!(scope, ProfileScope::Global) {
        return Err(invalid_profile_fact(
            "deterministic behavior 只能写 book scope".into(),
        ));
    }
    if evidence_is_empty && source != FactSource::UserStated {
        return Err(invalid_profile_fact(
            "非 user_stated fact 不得失去全部 evidence".into(),
        ));
    }
    let valid_status = matches!(
        (source, scope, status),
        (_, _, FactStatus::Superseded | FactStatus::Expired)
            | (
                FactSource::DeterministicBehavior,
                ProfileScope::Book { .. },
                FactStatus::Confirmed
            )
            | (FactSource::UserStated, _, FactStatus::Confirmed)
            | (
                FactSource::AgentInferred,
                ProfileScope::Book { .. },
                FactStatus::Provisional
            )
            | (
                FactSource::AgentInferred,
                ProfileScope::Global,
                FactStatus::Pending
            )
            | (FactSource::AgentInferred, _, FactStatus::Confirmed)
    );
    if !valid_status {
        return Err(invalid_profile_fact(format!(
            "source/scope/status 组合非法: {source:?}/{scope:?}/{status:?}"
        )));
    }
    Ok(())
}

fn initial_status(source: FactSource, scope: &ProfileScope) -> Result<FactStatus, ToolError> {
    match (source, scope) {
        (FactSource::DeterministicBehavior, ProfileScope::Book { .. }) => Ok(FactStatus::Confirmed),
        (FactSource::DeterministicBehavior, ProfileScope::Global) => Err(invalid_profile_fact(
            "deterministic behavior 只能写 book scope".into(),
        )),
        (FactSource::UserStated, _) => Ok(FactStatus::Confirmed),
        (FactSource::AgentInferred, ProfileScope::Book { .. }) => Ok(FactStatus::Provisional),
        (FactSource::AgentInferred, ProfileScope::Global) => Ok(FactStatus::Pending),
    }
}

pub(crate) fn reject_excluded_evidence(
    exclusions: &[EvidenceExclusion],
    evidence: &[EvidenceRef],
) -> Result<(), ToolError> {
    let excluded: BTreeSet<&str> = exclusions
        .iter()
        .map(|exclusion| exclusion.evidence_id.as_str())
        .collect();
    if let Some(evidence_id) = evidence
        .iter()
        .map(EvidenceRef::evidence_id)
        .find(|id| excluded.contains(id.as_str()))
    {
        return Err(ToolError {
            error_code: "EVIDENCE_EXCLUDED".into(),
            category: "conflict".into(),
            message: format!("profile evidence 已被排除: {evidence_id}"),
        });
    }
    Ok(())
}

fn fact_is_resolvable(fact: &ProfileFact, context: &ProfileResolutionContext) -> bool {
    if !matches!(fact.status, FactStatus::Confirmed | FactStatus::Provisional) {
        return false;
    }
    if context.now.as_ref().is_some_and(|now| {
        fact.valid_until
            .as_ref()
            .is_some_and(|valid_until| valid_until <= now)
    }) {
        return false;
    }
    let scope_matches = match &fact.scope {
        ProfileScope::Global => true,
        ProfileScope::Book { book_id } => context.book_id.as_ref() == Some(book_id),
    };
    scope_matches && applicability_matches(&fact.applicability, context)
}

fn applicability_matches(
    applicability: &Applicability,
    context: &ProfileResolutionContext,
) -> bool {
    match applicability {
        Applicability::Any => true,
        Applicability::ContentProfile { profile_id } => {
            context.content_profile.as_ref() == Some(profile_id)
        }
        Applicability::PaperSubtype { subtype } => context.paper_subtype.as_ref() == Some(subtype),
        Applicability::Domain { domain } => context.domain.as_ref() == Some(domain),
    }
}

fn compare_resolution(
    left: &ProfileFact,
    right: &ProfileFact,
    _context: &ProfileResolutionContext,
) -> Ordering {
    scope_rank(&left.scope)
        .cmp(&scope_rank(&right.scope))
        .then_with(|| {
            applicability_rank(&left.applicability).cmp(&applicability_rank(&right.applicability))
        })
        .then_with(|| authority_rank(left).cmp(&authority_rank(right)))
        .then_with(|| status_rank(left.status).cmp(&status_rank(right.status)))
        .then_with(|| left.updated_at.cmp(&right.updated_at))
        .then_with(|| left.fact_id.cmp(&right.fact_id))
}

fn scope_rank(scope: &ProfileScope) -> u8 {
    match scope {
        ProfileScope::Global => 0,
        ProfileScope::Book { .. } => 1,
    }
}

fn applicability_rank(applicability: &Applicability) -> u8 {
    match applicability {
        Applicability::Any => 0,
        Applicability::ContentProfile { .. }
        | Applicability::PaperSubtype { .. }
        | Applicability::Domain { .. } => 1,
    }
}

fn authority_rank(fact: &ProfileFact) -> u8 {
    match fact.source {
        FactSource::AgentInferred => 0,
        FactSource::DeterministicBehavior => 1,
        FactSource::UserStated if fact.supersedes.is_empty() => 2,
        FactSource::UserStated => 3,
    }
}

fn status_rank(status: FactStatus) -> u8 {
    match status {
        FactStatus::Provisional => 0,
        FactStatus::Confirmed => 1,
        FactStatus::Pending | FactStatus::Superseded | FactStatus::Expired => 0,
    }
}

fn validate_now(now: &str) -> Result<(), ToolError> {
    if now.trim().is_empty() {
        return Err(invalid_profile_fact(
            "profile mutation timestamp 不得为空".into(),
        ));
    }
    Ok(())
}

fn invalid_profile_fact(message: String) -> ToolError {
    ToolError {
        error_code: "INVALID_PROFILE_FACT".into(),
        category: "validation".into(),
        message,
    }
}

fn profile_fact_not_found(fact_id: &str) -> ToolError {
    ToolError {
        error_code: "PROFILE_FACT_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("profile fact 不存在: {fact_id}"),
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
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-profile-test-{name}"));
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

    fn book_scope(book_id: &str) -> ProfileScope {
        ProfileScope::Book {
            book_id: book_id.into(),
        }
    }

    fn preference_input(
        scope: ProfileScope,
        applicability: Applicability,
        key: &str,
        value: &str,
        source: FactSource,
        evidence: Vec<EvidenceRef>,
    ) -> CreateProfileFact {
        CreateProfileFact {
            scope,
            applicability,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: key.into(),
                value: value.into(),
            }),
            source,
            evidence,
            confidence: (source == FactSource::AgentInferred).then_some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        }
    }

    fn preference_value(fact: &ProfileFact) -> &str {
        match &fact.payload {
            ProfilePayload::ExplanationPreference(claim) => &claim.value,
            payload => panic!("expected explanation preference, got {payload:?}"),
        }
    }

    fn resolved_preference(store: &MemoryStore, context: ProfileResolutionContext) -> String {
        let facts = store.resolve_profile_facts(&context);
        assert_eq!(facts.len(), 1);
        preference_value(&facts[0]).to_string()
    }

    #[test]
    fn trust_matrix_derives_status_and_rejects_invalid_combinations() {
        let (path, mut store) = store("trust-matrix");
        let deterministic = store
            .create_profile_fact(
                preference_input(
                    book_scope("book-a"),
                    Applicability::Any,
                    "deterministic",
                    "observed",
                    FactSource::DeterministicBehavior,
                    vec![EvidenceRef::BookLocation {
                        book_id: "book-a".into(),
                        lid: "1.1".into(),
                    }],
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let user = store
            .create_profile_fact(
                preference_input(
                    ProfileScope::Global,
                    Applicability::Any,
                    "user",
                    "explicit",
                    FactSource::UserStated,
                    vec![turn("s", "u1")],
                ),
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let inferred_book = store
            .create_profile_fact(
                preference_input(
                    book_scope("book-a"),
                    Applicability::Any,
                    "book-inference",
                    "weak",
                    FactSource::AgentInferred,
                    vec![turn("s", "u2")],
                ),
                "2026-01-03T00:00:00Z",
            )
            .unwrap();
        let inferred_global = store
            .create_profile_fact(
                preference_input(
                    ProfileScope::Global,
                    Applicability::Any,
                    "global-inference",
                    "review-first",
                    FactSource::AgentInferred,
                    vec![turn("s", "u3")],
                ),
                "2026-01-04T00:00:00Z",
            )
            .unwrap();

        assert_eq!(deterministic.status, FactStatus::Confirmed);
        assert_eq!(user.status, FactStatus::Confirmed);
        assert_eq!(inferred_book.status, FactStatus::Provisional);
        assert_eq!(inferred_global.status, FactStatus::Pending);
        assert_eq!(
            (store.document_revision(), store.projection_revision()),
            (4, 4)
        );

        let invalid_global_behavior = preference_input(
            ProfileScope::Global,
            Applicability::Any,
            "bad-global-behavior",
            "bad",
            FactSource::DeterministicBehavior,
            vec![turn("s", "u4")],
        );
        assert_eq!(
            store
                .create_profile_fact(invalid_global_behavior, "2026-01-05T00:00:00Z")
                .unwrap_err()
                .error_code,
            "INVALID_PROFILE_FACT"
        );

        let mut invalid_sensitive = preference_input(
            book_scope("book-a"),
            Applicability::Any,
            "sensitive-inference",
            "bad",
            FactSource::AgentInferred,
            vec![turn("s", "u5")],
        );
        invalid_sensitive.sensitivity = Sensitivity::Sensitive;
        assert_eq!(
            store
                .create_profile_fact(invalid_sensitive, "2026-01-06T00:00:00Z")
                .unwrap_err()
                .error_code,
            "INVALID_PROFILE_FACT"
        );

        let mut invalid_confidence = preference_input(
            ProfileScope::Global,
            Applicability::Any,
            "user-confidence",
            "bad",
            FactSource::UserStated,
            vec![turn("s", "u6")],
        );
        invalid_confidence.confidence = Some(Confidence::High);
        assert_eq!(
            store
                .create_profile_fact(invalid_confidence, "2026-01-07T00:00:00Z")
                .unwrap_err()
                .error_code,
            "INVALID_PROFILE_FACT"
        );
        assert_eq!(store.document_revision(), 4);

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.profile_facts().len(), 4);
    }

    #[test]
    fn resolver_prefers_book_scope_specific_applicability_and_authority() {
        let (_path, mut store) = store("resolver-priority");
        let cases = [
            (
                ProfileScope::Global,
                Applicability::Any,
                "global-any",
                FactSource::UserStated,
                "u1",
            ),
            (
                ProfileScope::Global,
                Applicability::ContentProfile {
                    profile_id: "technical_learning".into(),
                },
                "global-technical",
                FactSource::UserStated,
                "u2",
            ),
            (
                book_scope("book-a"),
                Applicability::Any,
                "book-inferred",
                FactSource::AgentInferred,
                "u3",
            ),
            (
                book_scope("book-a"),
                Applicability::Any,
                "book-user",
                FactSource::UserStated,
                "u4",
            ),
        ];
        for (index, (scope, applicability, value, source, turn_id)) in cases.into_iter().enumerate()
        {
            store
                .create_profile_fact(
                    preference_input(
                        scope,
                        applicability,
                        "depth",
                        value,
                        source,
                        vec![turn("s", turn_id)],
                    ),
                    &format!("2026-01-0{}T00:00:00Z", index + 1),
                )
                .unwrap();
        }

        assert_eq!(
            resolved_preference(
                &store,
                ProfileResolutionContext {
                    book_id: Some("book-a".into()),
                    content_profile: Some("technical_learning".into()),
                    ..Default::default()
                }
            ),
            "book-user"
        );
        assert_eq!(
            resolved_preference(
                &store,
                ProfileResolutionContext {
                    book_id: Some("book-b".into()),
                    content_profile: Some("technical_learning".into()),
                    ..Default::default()
                }
            ),
            "global-technical"
        );
        assert_eq!(
            resolved_preference(
                &store,
                ProfileResolutionContext {
                    book_id: Some("book-b".into()),
                    content_profile: Some("paper".into()),
                    ..Default::default()
                }
            ),
            "global-any"
        );
    }

    #[test]
    fn resolver_matches_all_applicability_variants_and_validity_window() {
        let (_path, mut store) = store("resolver-applicability");
        let applicable = [
            (Applicability::Any, "any", "u1"),
            (
                Applicability::ContentProfile {
                    profile_id: "paper".into(),
                },
                "profile",
                "u2",
            ),
            (
                Applicability::PaperSubtype {
                    subtype: "survey".into(),
                },
                "subtype",
                "u3",
            ),
            (
                Applicability::Domain {
                    domain: "cardiology".into(),
                },
                "domain",
                "u4",
            ),
        ];
        for (applicability, key, turn_id) in applicable {
            store
                .create_profile_fact(
                    preference_input(
                        ProfileScope::Global,
                        applicability,
                        key,
                        key,
                        FactSource::UserStated,
                        vec![turn("s", turn_id)],
                    ),
                    "2026-01-01T00:00:00Z",
                )
                .unwrap();
        }
        let mut expiring = preference_input(
            ProfileScope::Global,
            Applicability::Any,
            "temporary",
            "temporary",
            FactSource::UserStated,
            vec![turn("s", "u5")],
        );
        expiring.valid_until = Some("2026-02-01T00:00:00Z".into());
        store
            .create_profile_fact(expiring, "2026-01-01T00:00:00Z")
            .unwrap();

        let matched = store.resolve_profile_facts(&ProfileResolutionContext {
            content_profile: Some("paper".into()),
            paper_subtype: Some("survey".into()),
            domain: Some("cardiology".into()),
            now: Some("2026-02-02T00:00:00Z".into()),
            ..Default::default()
        });
        assert_eq!(matched.len(), 4);
        assert!(!matched
            .iter()
            .any(|fact| fact.payload.semantic_key().ends_with("temporary")));

        let neutral = store.resolve_profile_facts(&ProfileResolutionContext {
            content_profile: Some("technical_learning".into()),
            now: Some("2026-01-15T00:00:00Z".into()),
            ..Default::default()
        });
        assert_eq!(neutral.len(), 2);
        assert!(neutral
            .iter()
            .any(|fact| fact.payload.semantic_key().ends_with("temporary")));
    }

    #[test]
    fn correction_supersedes_old_fact_and_resolver_selects_replacement() {
        let (_path, mut store) = store("correction");
        let original = store
            .create_profile_fact(
                preference_input(
                    ProfileScope::Global,
                    Applicability::Any,
                    "depth",
                    "concise",
                    FactSource::UserStated,
                    vec![turn("s", "u1")],
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let corrected = store
            .correct_profile_fact(
                &original.fact_id,
                preference_input(
                    ProfileScope::Global,
                    Applicability::Any,
                    "depth",
                    "detailed",
                    FactSource::UserStated,
                    vec![turn("s", "u2")],
                ),
                "2026-01-02T00:00:00Z",
            )
            .unwrap();

        assert_eq!(corrected.status, FactStatus::Confirmed);
        assert_eq!(corrected.supersedes, vec![original.fact_id.clone()]);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == original.fact_id)
                .unwrap()
                .status,
            FactStatus::Superseded
        );
        assert_eq!(
            resolved_preference(&store, ProfileResolutionContext::default()),
            "detailed"
        );

        let invalid = preference_input(
            ProfileScope::Global,
            Applicability::Any,
            "depth",
            "agent correction",
            FactSource::AgentInferred,
            vec![turn("s", "u3")],
        );
        assert_eq!(
            store
                .correct_profile_fact(&corrected.fact_id, invalid, "2026-01-03T00:00:00Z")
                .unwrap_err()
                .error_code,
            "INVALID_PROFILE_FACT"
        );
    }

    #[test]
    fn confirm_and_expire_follow_the_fact_state_machine() {
        let (_path, mut store) = store("state-machine");
        let pending = store
            .create_profile_fact(
                preference_input(
                    ProfileScope::Global,
                    Applicability::Any,
                    "depth",
                    "inferred",
                    FactSource::AgentInferred,
                    vec![turn("s", "u1")],
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        assert_eq!(pending.status, FactStatus::Pending);
        assert!(store
            .resolve_profile_facts(&ProfileResolutionContext::default())
            .is_empty());

        let confirmed = store
            .confirm_profile_fact(&pending.fact_id, "2026-01-02T00:00:00Z")
            .unwrap();
        assert_eq!(confirmed.status, FactStatus::Confirmed);
        assert_eq!(
            resolved_preference(&store, ProfileResolutionContext::default()),
            "inferred"
        );

        let expired = store
            .expire_profile_fact(&pending.fact_id, "2026-01-03T00:00:00Z")
            .unwrap();
        assert_eq!(expired.status, FactStatus::Expired);
        assert!(store
            .resolve_profile_facts(&ProfileResolutionContext::default())
            .is_empty());
        assert_eq!(
            store
                .confirm_profile_fact(&pending.fact_id, "2026-01-04T00:00:00Z")
                .unwrap_err()
                .error_code,
            "PROFILE_FACT_STATE_CONFLICT"
        );
    }

    #[test]
    fn hard_forget_deletes_value_excludes_evidence_and_removes_inferred_dependents() {
        let (path, mut store) = store("hard-forget");
        let shared = turn("session-a", "turn-a");
        let target = store
            .create_profile_fact(
                preference_input(
                    book_scope("book-a"),
                    Applicability::Any,
                    "target",
                    "remove-me",
                    FactSource::AgentInferred,
                    vec![shared.clone()],
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let dependent = store
            .create_profile_fact(
                preference_input(
                    book_scope("book-a"),
                    Applicability::Any,
                    "dependent",
                    "dependent-remove",
                    FactSource::AgentInferred,
                    vec![shared.clone()],
                ),
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let retained = store
            .create_profile_fact(
                preference_input(
                    book_scope("book-a"),
                    Applicability::Any,
                    "retained",
                    "keep-conclusion",
                    FactSource::UserStated,
                    vec![shared.clone()],
                ),
                "2026-01-03T00:00:00Z",
            )
            .unwrap();

        let outcome = store
            .forget_profile_fact(&target.fact_id, "2026-01-04T00:00:00Z")
            .unwrap();
        assert_eq!(outcome.forgotten_fact_id, target.fact_id);
        assert_eq!(outcome.excluded_evidence_ids, vec![shared.evidence_id()]);
        assert_eq!(outcome.removed_dependent_fact_ids, vec![dependent.fact_id]);
        assert_eq!(store.evidence_exclusions().len(), 1);
        assert_eq!(
            store.evidence_exclusions()[0].reason,
            ExclusionReason::Forgotten
        );

        let retained_after = store
            .profile_facts()
            .iter()
            .find(|fact| fact.fact_id == retained.fact_id)
            .unwrap();
        assert!(retained_after.evidence.is_empty());
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("remove-me"));
        assert!(!disk.contains("dependent-remove"));
        assert!(disk.contains("keep-conclusion"));

        let retry = preference_input(
            book_scope("book-a"),
            Applicability::Any,
            "retry",
            "must-not-return",
            FactSource::AgentInferred,
            vec![shared],
        );
        assert_eq!(
            store
                .create_profile_fact(retry, "2026-01-05T00:00:00Z")
                .unwrap_err()
                .error_code,
            "EVIDENCE_EXCLUDED"
        );

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.profile_facts().len(), 1);
        assert_eq!(reopened.evidence_exclusions().len(), 1);
    }

    #[test]
    fn stable_fact_id_is_evidence_order_independent_and_create_is_idempotent() {
        let (_path, mut first_store) = store("stable-id-first");
        let evidence_a = turn("session-a", "turn-a");
        let evidence_b = EvidenceRef::BookLocation {
            book_id: "book-a".into(),
            lid: "1.1".into(),
        };
        let first_input = preference_input(
            book_scope("book-a"),
            Applicability::Any,
            "depth",
            "detailed",
            FactSource::AgentInferred,
            vec![evidence_a.clone(), evidence_b.clone()],
        );
        let mut reversed_input = first_input.clone();
        reversed_input.evidence.reverse();

        let first = first_store
            .create_profile_fact(first_input.clone(), "2026-01-01T00:00:00Z")
            .unwrap();
        let duplicate = first_store
            .create_profile_fact(reversed_input, "2026-01-02T00:00:00Z")
            .unwrap();
        assert_eq!(duplicate.fact_id, first.fact_id);
        assert_eq!(duplicate.created_at, first.created_at);
        assert_eq!(first_store.profile_facts().len(), 1);
        assert_eq!(first_store.document_revision(), 1);

        let (_path, mut second_store) = store("stable-id-second");
        let second = second_store
            .create_profile_fact(first_input, "2027-01-01T00:00:00Z")
            .unwrap();
        assert_eq!(second.fact_id, first.fact_id);
        assert_eq!(
            evidence_a.evidence_id(),
            turn("session-a", "turn-a").evidence_id()
        );
        assert_ne!(evidence_a.evidence_id(), evidence_b.evidence_id());
    }
}
