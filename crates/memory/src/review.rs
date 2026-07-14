use crate::global_consolidation::reconcile_global_promotions;
use crate::governance::collection_rules_block;
use crate::profile::{build_profile_fact, reject_excluded_evidence};
use crate::{
    fnv1a, CreateProfileFact, EvidenceRef, FactSource, MemoryStore, ProfileFact, ProfileScope,
    Sensitivity,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewJobStatus {
    Queued,
    Running,
    Retryable,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewJob {
    pub job_id: String,
    pub session_id: String,
    pub book_id: String,
    pub from_turn_exclusive: u64,
    pub to_turn_inclusive: u64,
    pub status: ReviewJobStatus,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GlobalConsolidationJob {
    pub job_id: String,
    pub affected_keys: Vec<String>,
    pub source_revision: u64,
    pub status: ReviewJobStatus,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntentObservation {
    pub observation_id: String,
    pub intent_key: String,
    pub content_profile: String,
    pub evidence: Vec<EvidenceRef>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewFactCandidate {
    pub candidate_id: String,
    pub fact: CreateProfileFact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntentObservationCandidate {
    pub intent_key: String,
    pub content_profile: String,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCommitOutcome {
    pub completed_job: ReviewJob,
    pub added_fact_ids: Vec<String>,
    pub added_observation_ids: Vec<String>,
    pub already_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewErrorState {
    pub error_code: String,
    pub message: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewState {
    #[serde(default)]
    pub historical_baseline_initialized: bool,
    #[serde(default)]
    pub review_jobs: Vec<ReviewJob>,
    #[serde(default)]
    pub historical_backfill_jobs: Vec<crate::HistoricalBackfillJob>,
    #[serde(default)]
    pub consolidation_jobs: Vec<GlobalConsolidationJob>,
    #[serde(default)]
    pub global_promotions: Vec<crate::GlobalPromotionState>,
    #[serde(default)]
    pub intent_observations: Vec<IntentObservation>,
    #[serde(default)]
    pub reviewed_through: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ReviewErrorState>,
}

impl ReviewState {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let mut job_ids = BTreeSet::new();
        let mut session_books = BTreeMap::<&str, &str>::new();
        let mut active_by_session = BTreeMap::<&str, Vec<&ReviewJob>>::new();
        for job in &self.review_jobs {
            job.validate()?;
            if !job_ids.insert(job.job_id.as_str()) {
                return Err(format!("duplicate review job_id: {}", job.job_id));
            }
            match session_books.get(job.session_id.as_str()) {
                Some(book_id) if *book_id != job.book_id => {
                    return Err(format!(
                        "review session {} spans multiple books",
                        job.session_id
                    ));
                }
                Some(_) => {}
                None => {
                    session_books.insert(&job.session_id, &job.book_id);
                }
            }
            let watermark = self
                .reviewed_through
                .get(&job.session_id)
                .copied()
                .unwrap_or(0);
            if job.status == ReviewJobStatus::Completed {
                if job.to_turn_inclusive > watermark {
                    return Err(format!(
                        "completed review job {} exceeds session watermark {}",
                        job.job_id, watermark
                    ));
                }
            } else {
                active_by_session
                    .entry(&job.session_id)
                    .or_default()
                    .push(job);
            }
        }

        for (session_id, jobs) in &mut active_by_session {
            jobs.sort_by(|left, right| {
                left.from_turn_exclusive
                    .cmp(&right.from_turn_exclusive)
                    .then_with(|| left.to_turn_inclusive.cmp(&right.to_turn_inclusive))
                    .then_with(|| left.job_id.cmp(&right.job_id))
            });
            let mut covered_through = self.reviewed_through.get(*session_id).copied().unwrap_or(0);
            for job in jobs {
                if job.from_turn_exclusive != covered_through {
                    return Err(format!(
                        "review jobs for session {session_id} are not contiguous at {covered_through}"
                    ));
                }
                covered_through = job.to_turn_inclusive;
            }
        }

        for session_id in self.reviewed_through.keys() {
            if session_id.trim().is_empty() {
                return Err("reviewed_through session_id must not be empty".into());
            }
        }
        validate_optional_timestamp("last_success_at", self.last_success_at.as_deref())?;
        if let Some(error) = &self.last_error {
            error.validate()?;
        }
        validate_consolidation_jobs(&self.consolidation_jobs)?;
        crate::backfill::validate_historical_backfill_jobs(&self.historical_backfill_jobs)?;
        crate::global_consolidation::validate_promotion_states(&self.global_promotions)?;
        validate_intent_observations(&self.intent_observations)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSessionCursor {
    pub session_id: String,
    pub book_id: String,
    pub latest_user_turn_ordinal: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewReconciliation {
    pub created_job_ids: Vec<String>,
    pub requeued_job_ids: Vec<String>,
}

impl MemoryStore {
    pub fn review_state(&self) -> &ReviewState {
        &self.document.review_state
    }

    pub fn initialize_review_watermark_baseline(
        &mut self,
        sessions: &[ReviewSessionCursor],
        now: &str,
    ) -> Result<Vec<String>, ToolError> {
        validate_required("review baseline timestamp", now)?;
        if self.document.review_state.historical_baseline_initialized {
            return Ok(Vec::new());
        }
        let sessions = normalize_session_cursors(sessions)?;
        let mut candidate = self.document_mutation_candidate()?;
        let state = &mut candidate.review_state;
        let mut baselined = Vec::new();
        if state.review_jobs.is_empty() && state.reviewed_through.is_empty() {
            for cursor in sessions.values() {
                state.reviewed_through.insert(
                    cursor.session_id.clone(),
                    cursor.latest_user_turn_ordinal,
                );
                baselined.push(cursor.session_id.clone());
            }
        }
        state.historical_baseline_initialized = true;
        self.commit_document(candidate)?;
        Ok(baselined)
    }

    pub fn reconcile_review_jobs(
        &mut self,
        sessions: &[ReviewSessionCursor],
        now: &str,
    ) -> Result<ReviewReconciliation, ToolError> {
        self.reconcile_review_jobs_inner(sessions, now, false)
    }

    pub fn resume_review_jobs(
        &mut self,
        sessions: &[ReviewSessionCursor],
        now: &str,
    ) -> Result<ReviewReconciliation, ToolError> {
        self.reconcile_review_jobs_inner(sessions, now, true)
    }

    pub fn claim_review_job(&mut self, job_id: &str, now: &str) -> Result<ReviewJob, ToolError> {
        validate_required("review transition timestamp", now)?;
        let mut state = self.document.review_state.clone();
        let job = find_job_mut(&mut state, job_id)?;
        if !matches!(
            job.status,
            ReviewJobStatus::Queued | ReviewJobStatus::Retryable
        ) {
            return Err(review_state_conflict(format!(
                "cannot claim {:?} review job: {job_id}",
                job.status
            )));
        }
        job.attempts = job
            .attempts
            .checked_add(1)
            .ok_or_else(|| invalid_review_state("review job attempts overflow"))?;
        job.status = ReviewJobStatus::Running;
        job.next_attempt_at = None;
        job.updated_at = now.into();
        let claimed = job.clone();
        self.commit_review_state(state)?;
        Ok(claimed)
    }

    pub fn mark_review_job_retryable(
        &mut self,
        job_id: &str,
        next_attempt_at: &str,
        error: ReviewErrorState,
        now: &str,
    ) -> Result<ReviewJob, ToolError> {
        validate_required("review transition timestamp", now)?;
        validate_required("review next_attempt_at", next_attempt_at)?;
        error.validate().map_err(invalid_review_state)?;
        let mut state = self.document.review_state.clone();
        let job = find_job_mut(&mut state, job_id)?;
        if job.status != ReviewJobStatus::Running {
            return Err(review_state_conflict(format!(
                "cannot retry {:?} review job: {job_id}",
                job.status
            )));
        }
        job.status = ReviewJobStatus::Retryable;
        job.next_attempt_at = Some(next_attempt_at.into());
        job.updated_at = now.into();
        let retryable = job.clone();
        state.last_error = Some(error);
        self.commit_review_state(state)?;
        Ok(retryable)
    }

    pub fn complete_review_job(&mut self, job_id: &str, now: &str) -> Result<ReviewJob, ToolError> {
        validate_required("review transition timestamp", now)?;
        let mut state = self.document.review_state.clone();
        let index = state
            .review_jobs
            .iter()
            .position(|job| job.job_id == job_id)
            .ok_or_else(|| review_job_not_found(job_id))?;
        let current = state.review_jobs[index].clone();
        if current.status == ReviewJobStatus::Completed {
            let watermark = state
                .reviewed_through
                .get(&current.session_id)
                .copied()
                .unwrap_or(0);
            if watermark < current.to_turn_inclusive {
                return Err(invalid_review_state(format!(
                    "completed review job {job_id} exceeds its watermark"
                )));
            }
            return Ok(current);
        }
        if current.status != ReviewJobStatus::Running {
            return Err(review_state_conflict(format!(
                "cannot complete {:?} review job: {job_id}",
                current.status
            )));
        }
        let watermark = state
            .reviewed_through
            .get(&current.session_id)
            .copied()
            .unwrap_or(0);
        if watermark != current.from_turn_exclusive {
            return Err(review_state_conflict(format!(
                "review job {job_id} starts at {}, current watermark is {watermark}",
                current.from_turn_exclusive
            )));
        }

        let job = &mut state.review_jobs[index];
        job.status = ReviewJobStatus::Completed;
        job.next_attempt_at = None;
        job.updated_at = now.into();
        let completed = job.clone();
        state
            .reviewed_through
            .insert(current.session_id, current.to_turn_inclusive);
        state.last_success_at = Some(now.into());
        clear_last_error_if_drained(&mut state);
        self.commit_review_state(state)?;
        Ok(completed)
    }

    pub fn record_review_error(&mut self, error: ReviewErrorState) -> Result<(), ToolError> {
        error.validate().map_err(invalid_review_state)?;
        let mut state = self.document.review_state.clone();
        state.last_error = Some(error);
        self.commit_review_state(state)
    }

    pub fn commit_review_result(
        &mut self,
        job_id: &str,
        eligible_turn_ids: &[String],
        fact_candidates: &[ReviewFactCandidate],
        intent_candidates: &[IntentObservationCandidate],
        now: &str,
    ) -> Result<ReviewCommitOutcome, ToolError> {
        validate_required("review commit timestamp", now)?;
        let current = self
            .document
            .review_state
            .review_jobs
            .iter()
            .find(|job| job.job_id == job_id)
            .cloned()
            .ok_or_else(|| review_job_not_found(job_id))?;
        if current.status == ReviewJobStatus::Completed {
            return Ok(ReviewCommitOutcome {
                completed_job: current,
                added_fact_ids: Vec::new(),
                added_observation_ids: Vec::new(),
                already_completed: true,
            });
        }
        if current.status != ReviewJobStatus::Running {
            return Err(review_state_conflict(format!(
                "cannot commit result for {:?} review job: {job_id}",
                current.status
            )));
        }
        let watermark = self
            .document
            .review_state
            .reviewed_through
            .get(&current.session_id)
            .copied()
            .unwrap_or(0);
        if watermark != current.from_turn_exclusive {
            return Err(review_state_conflict(format!(
                "review job {job_id} starts at {}, current watermark is {watermark}",
                current.from_turn_exclusive
            )));
        }

        let eligible_turn_ids = normalize_eligible_turn_ids(eligible_turn_ids, &current)?;
        let mut facts = Vec::<ProfileFact>::new();
        let mut candidate_ids = BTreeSet::new();
        for candidate in fact_candidates {
            candidate.validate()?;
            if !candidate_ids.insert(candidate.candidate_id.as_str()) {
                return Err(invalid_review_result("duplicate review fact candidate"));
            }
            validate_review_evidence(
                &candidate.fact.evidence,
                &current.session_id,
                &eligible_turn_ids,
            )?;
            if matches!(
                &candidate.fact.scope,
                ProfileScope::Book { book_id } if book_id != &current.book_id
            ) {
                return Err(invalid_review_result(
                    "review fact book scope does not match the review job",
                ));
            }
            reject_excluded_evidence(&self.document.exclusions, &candidate.fact.evidence)?;
            if collection_rules_block(
                self.collection_rules(),
                &candidate.fact.scope,
                &candidate.fact.applicability,
                &candidate.fact.payload,
            ) {
                continue;
            }
            facts.push(build_profile_fact(candidate.fact.clone(), Vec::new(), now)?);
        }
        facts.sort_by(|left, right| left.fact_id.cmp(&right.fact_id));

        let mut observations = Vec::new();
        let mut observation_ids = BTreeSet::<String>::new();
        for candidate in intent_candidates {
            let observation = candidate.build(now)?;
            validate_review_evidence(
                &observation.evidence,
                &current.session_id,
                &eligible_turn_ids,
            )?;
            reject_excluded_evidence(&self.document.exclusions, &observation.evidence)?;
            if !observation_ids.insert(observation.observation_id.clone()) {
                return Err(invalid_review_result(
                    "duplicate review intent observation candidate",
                ));
            }
            observations.push(observation);
        }
        observations.sort_by(|left, right| left.observation_id.cmp(&right.observation_id));

        let existing_fact_ids: BTreeSet<_> = self
            .document
            .profile_facts
            .iter()
            .map(|fact| fact.fact_id.as_str())
            .collect();
        let new_facts: Vec<_> = facts
            .into_iter()
            .filter(|fact| !existing_fact_ids.contains(fact.fact_id.as_str()))
            .collect();
        let existing_observation_ids: BTreeSet<_> = self
            .document
            .review_state
            .intent_observations
            .iter()
            .map(|observation| observation.observation_id.as_str())
            .collect();
        let new_observations: Vec<_> = observations
            .into_iter()
            .filter(|observation| {
                !existing_observation_ids.contains(observation.observation_id.as_str())
            })
            .collect();

        let mut candidate = if new_facts.is_empty() {
            self.document_mutation_candidate()?
        } else {
            self.projection_mutation_candidate()?
        };
        let added_fact_ids: Vec<String> =
            new_facts.iter().map(|fact| fact.fact_id.clone()).collect();
        let affected_keys: Vec<String> = new_facts
            .iter()
            .map(|fact| fact.payload.semantic_key())
            .collect();
        let added_observation_ids: Vec<String> = new_observations
            .iter()
            .map(|observation| observation.observation_id.clone())
            .collect();
        candidate.profile_facts.extend(new_facts);
        candidate
            .review_state
            .intent_observations
            .extend(new_observations);
        let index = candidate
            .review_state
            .review_jobs
            .iter()
            .position(|job| job.job_id == job_id)
            .expect("review job was resolved from the same document");
        let job = &mut candidate.review_state.review_jobs[index];
        job.status = ReviewJobStatus::Completed;
        job.next_attempt_at = None;
        job.updated_at = now.into();
        let completed_job = job.clone();
        candidate
            .review_state
            .reviewed_through
            .insert(current.session_id, current.to_turn_inclusive);
        candidate.review_state.last_success_at = Some(now.into());
        clear_last_error_if_drained(&mut candidate.review_state);
        reconcile_global_promotions(&mut candidate, &affected_keys, now)?;
        self.commit_document(candidate)?;
        if !added_fact_ids.is_empty() {
            let _ = self.write_profile_files();
        }
        Ok(ReviewCommitOutcome {
            completed_job,
            added_fact_ids,
            added_observation_ids,
            already_completed: false,
        })
    }

    fn reconcile_review_jobs_inner(
        &mut self,
        sessions: &[ReviewSessionCursor],
        now: &str,
        recover_running: bool,
    ) -> Result<ReviewReconciliation, ToolError> {
        validate_required("review reconciliation timestamp", now)?;
        let sessions = normalize_session_cursors(sessions)?;
        let original = self.document.review_state.clone();
        let mut state = original.clone();
        let mut outcome = ReviewReconciliation::default();

        if recover_running {
            for job in &mut state.review_jobs {
                if job.status == ReviewJobStatus::Running {
                    job.status = ReviewJobStatus::Queued;
                    job.next_attempt_at = None;
                    job.updated_at = now.into();
                    outcome.requeued_job_ids.push(job.job_id.clone());
                }
            }
        }

        for cursor in sessions.values() {
            reconcile_session(&mut state, cursor, now, &mut outcome)?;
        }
        sort_review_jobs(&mut state.review_jobs);
        state.validate().map_err(invalid_review_state)?;
        outcome.created_job_ids.sort();
        outcome.requeued_job_ids.sort();
        if state == original {
            return Ok(ReviewReconciliation::default());
        }
        self.commit_review_state(state)?;
        Ok(outcome)
    }

    fn commit_review_state(&mut self, state: ReviewState) -> Result<(), ToolError> {
        state.validate().map_err(invalid_review_state)?;
        let mut candidate = self.document_mutation_candidate()?;
        candidate.review_state = state;
        self.commit_document(candidate)
    }
}

impl ReviewJob {
    pub fn stable_id(
        session_id: &str,
        book_id: &str,
        from_turn_exclusive: u64,
        to_turn_inclusive: u64,
    ) -> String {
        #[derive(Serialize)]
        struct Identity<'a> {
            session_id: &'a str,
            book_id: &'a str,
            from_turn_exclusive: u64,
            to_turn_inclusive: u64,
        }
        let canonical = serde_json::to_string(&Identity {
            session_id,
            book_id,
            from_turn_exclusive,
            to_turn_inclusive,
        })
        .expect("review job identity has fixed serializable fields");
        format!("review_{:016x}", fnv1a(&canonical))
    }

    fn validate(&self) -> Result<(), String> {
        if self.session_id.trim().is_empty() || self.book_id.trim().is_empty() {
            return Err("review job session_id/book_id must not be empty".into());
        }
        if self.from_turn_exclusive >= self.to_turn_inclusive {
            return Err(format!(
                "review job {} has an empty turn range",
                self.job_id
            ));
        }
        let expected = Self::stable_id(
            &self.session_id,
            &self.book_id,
            self.from_turn_exclusive,
            self.to_turn_inclusive,
        );
        if self.job_id != expected {
            return Err(format!(
                "review job_id is not content-addressed: {}",
                self.job_id
            ));
        }
        if self.created_at.trim().is_empty() || self.updated_at.trim().is_empty() {
            return Err(format!(
                "review job {} timestamps must not be empty",
                self.job_id
            ));
        }
        if matches!(
            self.status,
            ReviewJobStatus::Running | ReviewJobStatus::Retryable | ReviewJobStatus::Completed
        ) && self.attempts == 0
        {
            return Err(format!(
                "review job {} status {:?} requires an attempt",
                self.job_id, self.status
            ));
        }
        match (self.status, self.next_attempt_at.as_deref()) {
            (ReviewJobStatus::Retryable, Some(value)) if !value.trim().is_empty() => {}
            (ReviewJobStatus::Retryable, _) => {
                return Err(format!(
                    "retryable review job {} requires next_attempt_at",
                    self.job_id
                ));
            }
            (_, None) => {}
            (_, Some(_)) => {
                return Err(format!(
                    "review job {} has next_attempt_at outside retryable state",
                    self.job_id
                ));
            }
        }
        Ok(())
    }
}

impl ReviewErrorState {
    fn validate(&self) -> Result<(), String> {
        if self.error_code.trim().is_empty()
            || self.message.trim().is_empty()
            || self.occurred_at.trim().is_empty()
        {
            return Err("review error code/message/occurred_at must not be empty".into());
        }
        Ok(())
    }
}

impl GlobalConsolidationJob {
    pub fn stable_id(affected_keys: &[String], source_revision: u64) -> String {
        #[derive(Serialize)]
        struct Identity<'a> {
            affected_keys: &'a [String],
            source_revision: u64,
        }
        let affected_keys = normalized_strings(affected_keys);
        let canonical = serde_json::to_string(&Identity {
            affected_keys: &affected_keys,
            source_revision,
        })
        .expect("consolidation job identity has fixed serializable fields");
        format!("consolidation_{:016x}", fnv1a(&canonical))
    }
}

impl IntentObservation {
    pub fn stable_id(intent_key: &str, content_profile: &str, evidence: &[EvidenceRef]) -> String {
        #[derive(Serialize)]
        struct Identity<'a> {
            intent_key: &'a str,
            content_profile: &'a str,
            evidence: &'a [EvidenceRef],
        }
        let mut evidence = evidence.to_vec();
        evidence.sort();
        evidence.dedup();
        let canonical = serde_json::to_string(&Identity {
            intent_key,
            content_profile,
            evidence: &evidence,
        })
        .expect("intent observation identity has fixed serializable fields");
        format!("observation_{:016x}", fnv1a(&canonical))
    }
}

impl ReviewFactCandidate {
    pub fn new(mut fact: CreateProfileFact) -> Result<Self, ToolError> {
        fact.evidence.sort();
        fact.evidence.dedup();
        if !matches!(
            fact.source,
            FactSource::UserStated | FactSource::AgentInferred
        ) {
            return Err(invalid_review_result(
                "review extractor may only emit user-stated or agent-inferred facts",
            ));
        }
        if fact.sensitivity != Sensitivity::Normal {
            return Err(invalid_review_result(
                "background review may not store sensitive profile facts",
            ));
        }
        let built = build_profile_fact(fact.clone(), Vec::new(), "candidate")?;
        Ok(Self {
            candidate_id: built.fact_id.replacen("fact_", "candidate_", 1),
            fact,
        })
    }

    pub(crate) fn validate(&self) -> Result<(), ToolError> {
        if Self::new(self.fact.clone())? != *self {
            return Err(invalid_review_result(
                "review candidate_id is not content-addressed",
            ));
        }
        Ok(())
    }
}

impl IntentObservationCandidate {
    pub fn new(
        intent_key: impl Into<String>,
        content_profile: impl Into<String>,
        mut evidence: Vec<EvidenceRef>,
    ) -> Result<Self, ToolError> {
        let intent_key = intent_key.into();
        let content_profile = content_profile.into();
        evidence.sort();
        evidence.dedup();
        let candidate = Self {
            intent_key,
            content_profile,
            evidence,
        };
        candidate.build("candidate")?;
        Ok(candidate)
    }

    fn build(&self, now: &str) -> Result<IntentObservation, ToolError> {
        validate_required("intent observation timestamp", now)?;
        if self.intent_key.trim().is_empty()
            || self.content_profile.trim().is_empty()
            || self.evidence.is_empty()
        {
            return Err(invalid_review_result(
                "intent observation fields must not be empty",
            ));
        }
        let mut evidence = self.evidence.clone();
        evidence.sort();
        evidence.dedup();
        if evidence != self.evidence {
            return Err(invalid_review_result(
                "intent observation evidence must be normalized",
            ));
        }
        Ok(IntentObservation {
            observation_id: IntentObservation::stable_id(
                &self.intent_key,
                &self.content_profile,
                &evidence,
            ),
            intent_key: self.intent_key.clone(),
            content_profile: self.content_profile.clone(),
            evidence,
            created_at: now.into(),
        })
    }
}

fn normalize_eligible_turn_ids(
    turn_ids: &[String],
    job: &ReviewJob,
) -> Result<BTreeSet<String>, ToolError> {
    let normalized: BTreeSet<_> = turn_ids
        .iter()
        .map(|turn_id| turn_id.trim().to_string())
        .collect();
    let expected = job.to_turn_inclusive - job.from_turn_exclusive;
    if normalized.iter().any(String::is_empty)
        || u64::try_from(normalized.len()).ok() != Some(expected)
    {
        return Err(invalid_review_result(
            "eligible user turn IDs do not cover the review job range",
        ));
    }
    Ok(normalized)
}

fn validate_review_evidence(
    evidence: &[EvidenceRef],
    session_id: &str,
    eligible_turn_ids: &BTreeSet<String>,
) -> Result<(), ToolError> {
    if evidence.is_empty()
        || evidence.iter().any(|evidence| {
            !matches!(
                evidence,
                EvidenceRef::Turn {
                    session_id: evidence_session_id,
                    turn_id,
                } if evidence_session_id == session_id && eligible_turn_ids.contains(turn_id)
            )
        })
    {
        return Err(invalid_review_result(
            "review output must cite eligible resident user turns",
        ));
    }
    Ok(())
}

fn normalize_session_cursors(
    sessions: &[ReviewSessionCursor],
) -> Result<BTreeMap<String, ReviewSessionCursor>, ToolError> {
    let mut normalized = BTreeMap::new();
    for cursor in sessions {
        validate_required("review cursor session_id", &cursor.session_id)?;
        validate_required("review cursor book_id", &cursor.book_id)?;
        match normalized.get(&cursor.session_id) {
            Some(existing) if existing != cursor => {
                return Err(invalid_review_state(format!(
                    "conflicting review cursors for session {}",
                    cursor.session_id
                )));
            }
            Some(_) => {}
            None => {
                normalized.insert(cursor.session_id.clone(), cursor.clone());
            }
        }
    }
    Ok(normalized)
}

fn reconcile_session(
    state: &mut ReviewState,
    cursor: &ReviewSessionCursor,
    now: &str,
    outcome: &mut ReviewReconciliation,
) -> Result<(), ToolError> {
    if let Some(job) = state
        .review_jobs
        .iter()
        .find(|job| job.session_id == cursor.session_id && job.book_id != cursor.book_id)
    {
        return Err(invalid_review_state(format!(
            "review cursor book {} conflicts with job {} book {}",
            cursor.book_id, job.job_id, job.book_id
        )));
    }
    let watermark = state
        .reviewed_through
        .get(&cursor.session_id)
        .copied()
        .unwrap_or(0);
    if cursor.latest_user_turn_ordinal <= watermark {
        return Ok(());
    }

    let mut active_indices: Vec<usize> = state
        .review_jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| {
            job.session_id == cursor.session_id && job.status != ReviewJobStatus::Completed
        })
        .map(|(index, _)| index)
        .collect();
    active_indices.sort_by_key(|index| state.review_jobs[*index].from_turn_exclusive);
    let covered_through = active_indices
        .last()
        .map(|index| state.review_jobs[*index].to_turn_inclusive)
        .unwrap_or(watermark);
    if cursor.latest_user_turn_ordinal <= covered_through {
        return Ok(());
    }

    if let Some(index) = active_indices.last().copied() {
        let previous = &state.review_jobs[index];
        if previous.status == ReviewJobStatus::Queued
            && previous.to_turn_inclusive == covered_through
        {
            let previous = state.review_jobs.remove(index);
            let merged = new_review_job(
                &cursor.session_id,
                &cursor.book_id,
                previous.from_turn_exclusive,
                cursor.latest_user_turn_ordinal,
                previous.attempts,
                &previous.created_at,
                now,
            );
            outcome.created_job_ids.push(merged.job_id.clone());
            state.review_jobs.push(merged);
            return Ok(());
        }
    }

    let job = new_review_job(
        &cursor.session_id,
        &cursor.book_id,
        covered_through,
        cursor.latest_user_turn_ordinal,
        0,
        now,
        now,
    );
    outcome.created_job_ids.push(job.job_id.clone());
    state.review_jobs.push(job);
    Ok(())
}

fn new_review_job(
    session_id: &str,
    book_id: &str,
    from_turn_exclusive: u64,
    to_turn_inclusive: u64,
    attempts: u32,
    created_at: &str,
    updated_at: &str,
) -> ReviewJob {
    ReviewJob {
        job_id: ReviewJob::stable_id(session_id, book_id, from_turn_exclusive, to_turn_inclusive),
        session_id: session_id.into(),
        book_id: book_id.into(),
        from_turn_exclusive,
        to_turn_inclusive,
        status: ReviewJobStatus::Queued,
        attempts,
        next_attempt_at: None,
        created_at: created_at.into(),
        updated_at: updated_at.into(),
    }
}

fn find_job_mut<'a>(
    state: &'a mut ReviewState,
    job_id: &str,
) -> Result<&'a mut ReviewJob, ToolError> {
    state
        .review_jobs
        .iter_mut()
        .find(|job| job.job_id == job_id)
        .ok_or_else(|| review_job_not_found(job_id))
}

fn sort_review_jobs(jobs: &mut [ReviewJob]) {
    jobs.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.from_turn_exclusive.cmp(&right.from_turn_exclusive))
            .then_with(|| left.to_turn_inclusive.cmp(&right.to_turn_inclusive))
            .then_with(|| left.job_id.cmp(&right.job_id))
    });
}

fn clear_last_error_if_drained(state: &mut ReviewState) {
    if state
        .review_jobs
        .iter()
        .all(|job| job.status == ReviewJobStatus::Completed)
    {
        state.last_error = None;
    }
}

fn validate_consolidation_jobs(jobs: &[GlobalConsolidationJob]) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for job in jobs {
        if job.affected_keys.is_empty() || job.affected_keys.iter().any(|key| key.trim().is_empty())
        {
            return Err("invalid global consolidation job".into());
        }
        if job.affected_keys != normalized_strings(&job.affected_keys)
            || job.job_id
                != GlobalConsolidationJob::stable_id(&job.affected_keys, job.source_revision)
        {
            return Err(format!(
                "consolidation job_id is not content-addressed: {}",
                job.job_id
            ));
        }
        if matches!(
            job.status,
            ReviewJobStatus::Running | ReviewJobStatus::Retryable | ReviewJobStatus::Completed
        ) && job.attempts == 0
        {
            return Err(format!(
                "consolidation job {} status {:?} requires an attempt",
                job.job_id, job.status
            ));
        }
        match (job.status, job.next_attempt_at.as_deref()) {
            (ReviewJobStatus::Retryable, Some(value)) if !value.trim().is_empty() => {}
            (ReviewJobStatus::Retryable, _) => {
                return Err(format!(
                    "retryable consolidation job {} requires next_attempt_at",
                    job.job_id
                ));
            }
            (_, None) => {}
            (_, Some(_)) => {
                return Err(format!(
                    "consolidation job {} has next_attempt_at outside retryable state",
                    job.job_id
                ));
            }
        }
        if !ids.insert(job.job_id.as_str()) {
            return Err(format!("duplicate consolidation job_id: {}", job.job_id));
        }
    }
    Ok(())
}

fn validate_intent_observations(observations: &[IntentObservation]) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for observation in observations {
        if observation.intent_key.trim().is_empty()
            || observation.content_profile.trim().is_empty()
            || observation.evidence.is_empty()
            || observation.created_at.trim().is_empty()
        {
            return Err("invalid intent observation".into());
        }
        let mut normalized_evidence = observation.evidence.clone();
        normalized_evidence.sort();
        normalized_evidence.dedup();
        if observation.evidence != normalized_evidence
            || observation.observation_id
                != IntentObservation::stable_id(
                    &observation.intent_key,
                    &observation.content_profile,
                    &observation.evidence,
                )
        {
            return Err(format!(
                "intent observation_id is not content-addressed: {}",
                observation.observation_id
            ));
        }
        if !ids.insert(observation.observation_id.as_str()) {
            return Err(format!(
                "duplicate intent observation_id: {}",
                observation.observation_id
            ));
        }
    }
    Ok(())
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut normalized = values.to_vec();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn validate_optional_timestamp(name: &str, value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|timestamp| timestamp.trim().is_empty()) {
        return Err(format!("{name} must not be empty"));
    }
    Ok(())
}

fn validate_required(name: &str, value: &str) -> Result<(), ToolError> {
    if value.trim().is_empty() {
        return Err(invalid_review_state(format!("{name} must not be empty")));
    }
    Ok(())
}

fn invalid_review_state(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_REVIEW_STATE".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn invalid_review_result(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_REVIEW_RESULT".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn review_job_not_found(job_id: &str) -> ToolError {
    ToolError {
        error_code: "REVIEW_JOB_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("review job does not exist: {job_id}"),
    }
}

fn review_state_conflict(message: String) -> ToolError {
    ToolError {
        error_code: "REVIEW_JOB_STATE_CONFLICT".into(),
        category: "conflict".into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Applicability, Confidence, PreferenceClaim, ProfilePayload};
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-review-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn cursor(latest: u64) -> ReviewSessionCursor {
        ReviewSessionCursor {
            session_id: "session-a".into(),
            book_id: "book-a".into(),
            latest_user_turn_ordinal: latest,
        }
    }

    #[test]
    fn one_time_baseline_skips_pre_upgrade_history_but_not_new_turns() {
        let (path, mut store) = store("historical-baseline");
        let baselined = store
            .initialize_review_watermark_baseline(&[cursor(3)], "baseline")
            .unwrap();
        assert_eq!(baselined, vec!["session-a"]);
        assert!(store.review_state().historical_baseline_initialized);
        assert_eq!(store.review_state().reviewed_through["session-a"], 3);
        assert!(store.review_state().review_jobs.is_empty());
        let revision = store.document_revision();

        assert!(store
            .initialize_review_watermark_baseline(&[cursor(9)], "duplicate")
            .unwrap()
            .is_empty());
        assert_eq!(store.document_revision(), revision);
        assert!(store
            .reconcile_review_jobs(&[cursor(3)], "same-history")
            .unwrap()
            .created_job_ids
            .is_empty());
        let next = store
            .reconcile_review_jobs(&[cursor(4)], "new-turn")
            .unwrap();
        assert_eq!(next.created_job_ids.len(), 1);
        assert_eq!(only_job(&store).from_turn_exclusive, 3);
        assert_eq!(only_job(&store).to_turn_inclusive, 4);

        let reopened = MemoryStore::open(path).unwrap();
        assert!(reopened.review_state().historical_baseline_initialized);
        assert_eq!(reopened.review_state().reviewed_through["session-a"], 3);
    }

    fn only_job(store: &MemoryStore) -> ReviewJob {
        assert_eq!(store.review_state().review_jobs.len(), 1);
        store.review_state().review_jobs[0].clone()
    }

    fn fact_candidate(
        session_id: &str,
        turn_id: &str,
        source: FactSource,
        scope: ProfileScope,
    ) -> ReviewFactCandidate {
        ReviewFactCandidate::new(CreateProfileFact {
            scope,
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: format!("example_order_{turn_id}"),
                value: "worked_examples_first".into(),
            }),
            source,
            evidence: vec![EvidenceRef::Turn {
                session_id: session_id.into(),
                turn_id: turn_id.into(),
            }],
            confidence: (source == FactSource::AgentInferred).then_some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        })
        .unwrap()
    }

    #[test]
    fn resume_requeues_interrupted_running_job() {
        let (_path, mut store) = store("resume-running");
        store
            .reconcile_review_jobs(&[cursor(4)], "2026-07-14T00:00:00Z")
            .unwrap();
        let queued = only_job(&store);
        store
            .claim_review_job(&queued.job_id, "2026-07-14T00:01:00Z")
            .unwrap();

        let outcome = store
            .resume_review_jobs(&[cursor(4)], "2026-07-14T00:02:00Z")
            .unwrap();

        assert_eq!(outcome.requeued_job_ids, vec![queued.job_id.clone()]);
        let recovered = only_job(&store);
        assert_eq!(recovered.status, ReviewJobStatus::Queued);
        assert_eq!(recovered.attempts, 1);
        assert_eq!(recovered.next_attempt_at, None);
    }

    #[test]
    fn repeated_reconciliation_is_idempotent_and_merges_unclaimed_tail() {
        let (_path, mut store) = store("reconcile-idempotent");
        let first = store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:00:00Z")
            .unwrap();
        assert_eq!(first.created_job_ids.len(), 1);
        let first_revision = store.document_revision();
        assert_eq!(store.projection_revision(), 0);

        let duplicate = store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:01:00Z")
            .unwrap();
        assert_eq!(duplicate, ReviewReconciliation::default());
        assert_eq!(store.document_revision(), first_revision);

        store
            .reconcile_review_jobs(&[cursor(5)], "2026-07-14T00:02:00Z")
            .unwrap();
        let merged = only_job(&store);
        assert_eq!(
            (merged.from_turn_exclusive, merged.to_turn_inclusive),
            (0, 5)
        );
        assert_ne!(merged.job_id, first.created_job_ids[0]);
        assert_eq!(store.projection_revision(), 0);
    }

    #[test]
    fn running_job_can_retry_and_is_durable() {
        let (path, mut store) = store("retryable-durable");
        store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:00:00Z")
            .unwrap();
        let queued = only_job(&store);
        store
            .claim_review_job(&queued.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let error = ReviewErrorState {
            error_code: "PROVIDER_FAILED".into(),
            message: "temporary failure".into(),
            occurred_at: "2026-07-14T00:02:00Z".into(),
        };
        let retryable = store
            .mark_review_job_retryable(
                &queued.job_id,
                "2026-07-14T00:10:00Z",
                error.clone(),
                "2026-07-14T00:02:00Z",
            )
            .unwrap();
        assert_eq!(retryable.status, ReviewJobStatus::Retryable);
        assert_eq!(
            retryable.next_attempt_at.as_deref(),
            Some("2026-07-14T00:10:00Z")
        );
        assert_eq!(store.review_state().last_error.as_ref(), Some(&error));
        assert_eq!(store.projection_revision(), 0);

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.review_state(), store.review_state());
    }

    #[test]
    fn completed_job_is_terminal_and_watermark_never_moves_backwards() {
        let (_path, mut store) = store("completed-terminal");
        store
            .reconcile_review_jobs(&[cursor(3)], "2026-07-14T00:00:00Z")
            .unwrap();
        let queued = only_job(&store);
        store
            .claim_review_job(&queued.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let completed = store
            .complete_review_job(&queued.job_id, "2026-07-14T00:02:00Z")
            .unwrap();
        assert_eq!(completed.status, ReviewJobStatus::Completed);
        assert_eq!(store.review_state().reviewed_through["session-a"], 3);
        let revision = store.document_revision();

        let duplicate = store
            .complete_review_job(&queued.job_id, "2026-07-14T00:03:00Z")
            .unwrap();
        assert_eq!(duplicate, completed);
        assert_eq!(store.review_state().reviewed_through["session-a"], 3);
        assert_eq!(store.document_revision(), revision);
        assert!(store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:04:00Z")
            .unwrap()
            .created_job_ids
            .is_empty());
        assert_eq!(store.review_state().reviewed_through["session-a"], 3);
        assert_eq!(
            store
                .claim_review_job(&queued.job_id, "2026-07-14T00:05:00Z")
                .unwrap_err()
                .error_code,
            "REVIEW_JOB_STATE_CONFLICT"
        );
    }

    #[test]
    fn illegal_transitions_are_rejected_without_mutation() {
        let (_path, mut store) = store("illegal-transition");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        let queued = only_job(&store);
        let revision = store.document_revision();
        let error = ReviewErrorState {
            error_code: "PROVIDER_FAILED".into(),
            message: "temporary failure".into(),
            occurred_at: "2026-07-14T00:01:00Z".into(),
        };

        assert_eq!(
            store
                .mark_review_job_retryable(
                    &queued.job_id,
                    "2026-07-14T00:10:00Z",
                    error,
                    "2026-07-14T00:01:00Z",
                )
                .unwrap_err()
                .error_code,
            "REVIEW_JOB_STATE_CONFLICT"
        );
        assert_eq!(
            store
                .complete_review_job(&queued.job_id, "2026-07-14T00:02:00Z")
                .unwrap_err()
                .error_code,
            "REVIEW_JOB_STATE_CONFLICT"
        );
        assert_eq!(store.document_revision(), revision);
        assert_eq!(only_job(&store), queued);
    }

    #[test]
    fn reconciliation_recovers_cross_file_crash_orders_with_one_job() {
        let (path, mut store) = store("cross-file-crash");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        drop(store);

        let mut reopened = MemoryStore::open(&path).unwrap();
        reopened
            .resume_review_jobs(&[cursor(2)], "2026-07-14T00:01:00Z")
            .unwrap();
        let rebuilt = only_job(&reopened);
        assert_eq!(
            (rebuilt.from_turn_exclusive, rebuilt.to_turn_inclusive),
            (0, 2)
        );
        let revision = reopened.document_revision();

        reopened
            .resume_review_jobs(&[cursor(2)], "2026-07-14T00:02:00Z")
            .unwrap();
        assert_eq!(reopened.review_state().review_jobs.len(), 1);
        assert_eq!(reopened.document_revision(), revision);
    }

    #[test]
    fn failed_review_commit_preserves_memory_and_disk() {
        let (path, mut store) = store("failed-commit");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        let job = only_job(&store);
        let before_state = store.review_state().clone();
        let before_revision = store.document_revision();
        let before_disk = std::fs::read_to_string(&path).unwrap();

        let blocker = std::env::temp_dir().join("ub-review-test-parent-blocker");
        let _ = std::fs::remove_file(&blocker);
        let _ = std::fs::remove_dir_all(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();
        store.path = blocker.join("memory.json");

        let error = store
            .claim_review_job(&job.job_id, "2026-07-14T00:01:00Z")
            .unwrap_err();
        assert_eq!(error.category, "internal");
        assert_eq!(store.review_state(), &before_state);
        assert_eq!(store.document_revision(), before_revision);
        assert_eq!(std::fs::read_to_string(path).unwrap(), before_disk);
    }

    #[test]
    fn open_rejects_tampered_job_identity() {
        let (path, mut store) = store("tampered-state");
        store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:00:00Z")
            .unwrap();
        let mut persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        persisted["review_state"]["review_jobs"][0]["job_id"] =
            serde_json::Value::String("review_forged".into());
        std::fs::write(&path, serde_json::to_string_pretty(&persisted).unwrap()).unwrap();
        drop(store);

        let error = MemoryStore::open(path).err().unwrap();
        assert_eq!(error.category, "internal");
        assert!(error.message.contains("not content-addressed"));
    }

    #[test]
    fn open_rejects_completed_job_ahead_of_watermark() {
        let (path, mut store) = store("tampered-watermark");
        store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:00:00Z")
            .unwrap();
        let queued = only_job(&store);
        store
            .claim_review_job(&queued.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        store
            .complete_review_job(&queued.job_id, "2026-07-14T00:02:00Z")
            .unwrap();
        let mut persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        persisted["review_state"]["reviewed_through"]["session-a"] = serde_json::Value::from(1);
        std::fs::write(&path, serde_json::to_string_pretty(&persisted).unwrap()).unwrap();
        drop(store);

        let error = MemoryStore::open(path).err().unwrap();
        assert_eq!(error.category, "internal");
        assert!(error.message.contains("exceeds session watermark"));
    }

    #[test]
    fn review_result_atomically_applies_trust_status_observation_and_watermark() {
        let (path, mut store) = store("atomic-result");
        store
            .reconcile_review_jobs(&[cursor(2)], "2026-07-14T00:00:00Z")
            .unwrap();
        let job = only_job(&store);
        store
            .claim_review_job(&job.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let before_document_revision = store.document_revision();
        let before_projection_revision = store.projection_revision();
        let user_stated = fact_candidate(
            "session-a",
            "turn-1",
            FactSource::UserStated,
            ProfileScope::Book {
                book_id: "book-a".into(),
            },
        );
        let global_inference = fact_candidate(
            "session-a",
            "turn-2",
            FactSource::AgentInferred,
            ProfileScope::Global,
        );
        let observation = IntentObservationCandidate::new(
            "request_diagram",
            "technical_learning",
            vec![EvidenceRef::Turn {
                session_id: "session-a".into(),
                turn_id: "turn-2".into(),
            }],
        )
        .unwrap();

        let outcome = store
            .commit_review_result(
                &job.job_id,
                &["turn-1".into(), "turn-2".into()],
                &[user_stated, global_inference],
                &[observation],
                "2026-07-14T00:02:00Z",
            )
            .unwrap();

        assert!(!outcome.already_completed);
        assert_eq!(outcome.added_fact_ids.len(), 2);
        assert_eq!(outcome.added_observation_ids.len(), 1);
        assert_eq!(store.document_revision(), before_document_revision + 1);
        assert_eq!(store.projection_revision(), before_projection_revision + 1);
        assert_eq!(store.review_state().reviewed_through["session-a"], 2);
        assert_eq!(only_job(&store).status, ReviewJobStatus::Completed);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.source == FactSource::UserStated)
                .unwrap()
                .status,
            crate::FactStatus::Confirmed
        );
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.source == FactSource::AgentInferred)
                .unwrap()
                .status,
            crate::FactStatus::Pending
        );
        assert_eq!(store.review_state().intent_observations.len(), 1);
        assert_eq!(
            store
                .resolve_profile_facts(&crate::ProfileResolutionContext {
                    book_id: Some("book-a".into()),
                    ..Default::default()
                })
                .len(),
            1,
            "pending global inference and intent observations must not enter projection"
        );

        let revision = store.document_revision();
        let duplicate = store
            .commit_review_result(
                &job.job_id,
                &["turn-1".into(), "turn-2".into()],
                &[],
                &[],
                "2026-07-14T00:03:00Z",
            )
            .unwrap();
        assert!(duplicate.already_completed);
        assert_eq!(store.document_revision(), revision);
        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.profile_facts(), store.profile_facts());
        assert_eq!(reopened.review_state(), store.review_state());
    }

    #[test]
    fn observation_only_review_does_not_advance_projection_revision() {
        let (_path, mut store) = store("observation-only");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        let job = only_job(&store);
        store
            .claim_review_job(&job.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let projection_revision = store.projection_revision();
        let observation = IntentObservationCandidate::new(
            "request_diagram",
            "technical_learning",
            vec![EvidenceRef::Turn {
                session_id: "session-a".into(),
                turn_id: "turn-1".into(),
            }],
        )
        .unwrap();

        store
            .commit_review_result(
                &job.job_id,
                &["turn-1".into()],
                &[],
                &[observation],
                "2026-07-14T00:02:00Z",
            )
            .unwrap();

        assert_eq!(store.projection_revision(), projection_revision);
        assert!(store.profile_facts().is_empty());
        assert_eq!(store.review_state().intent_observations.len(), 1);
    }

    #[test]
    fn ineligible_review_evidence_rejects_the_whole_result_without_mutation() {
        let (path, mut store) = store("invalid-evidence-atomic");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        let job = only_job(&store);
        store
            .claim_review_job(&job.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let before_state = store.review_state().clone();
        let before_revision = store.document_revision();
        let before_disk = std::fs::read_to_string(&path).unwrap();
        let invalid = fact_candidate(
            "visitor-session",
            "turn-1",
            FactSource::UserStated,
            ProfileScope::Book {
                book_id: "book-a".into(),
            },
        );

        let error = store
            .commit_review_result(
                &job.job_id,
                &["turn-1".into()],
                &[invalid],
                &[],
                "2026-07-14T00:02:00Z",
            )
            .unwrap_err();

        assert_eq!(error.error_code, "INVALID_REVIEW_RESULT");
        assert_eq!(store.review_state(), &before_state);
        assert!(store.profile_facts().is_empty());
        assert_eq!(store.document_revision(), before_revision);
        assert_eq!(std::fs::read_to_string(path).unwrap(), before_disk);
    }

    #[test]
    fn failed_atomic_result_persistence_keeps_facts_observations_and_watermark_unchanged() {
        let (path, mut store) = store("result-persist-failure");
        store
            .reconcile_review_jobs(&[cursor(1)], "2026-07-14T00:00:00Z")
            .unwrap();
        let job = only_job(&store);
        store
            .claim_review_job(&job.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        let before_state = store.review_state().clone();
        let before_revision = store.document_revision();
        let before_disk = std::fs::read_to_string(&path).unwrap();
        let fact = fact_candidate(
            "session-a",
            "turn-1",
            FactSource::UserStated,
            ProfileScope::Book {
                book_id: "book-a".into(),
            },
        );
        let observation = IntentObservationCandidate::new(
            "request_diagram",
            "technical_learning",
            vec![EvidenceRef::Turn {
                session_id: "session-a".into(),
                turn_id: "turn-1".into(),
            }],
        )
        .unwrap();
        let blocker = std::env::temp_dir().join("ub-review-result-parent-blocker");
        let _ = std::fs::remove_file(&blocker);
        let _ = std::fs::remove_dir_all(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();
        store.path = blocker.join("memory.json");

        let error = store
            .commit_review_result(
                &job.job_id,
                &["turn-1".into()],
                &[fact],
                &[observation],
                "2026-07-14T00:02:00Z",
            )
            .unwrap_err();

        assert_eq!(error.category, "internal");
        assert_eq!(store.review_state(), &before_state);
        assert!(store.profile_facts().is_empty());
        assert_eq!(store.document_revision(), before_revision);
        assert_eq!(std::fs::read_to_string(path).unwrap(), before_disk);
    }
}
