use crate::global_consolidation::reconcile_global_promotions;
use crate::governance::collection_rules_block;
use crate::profile::{build_profile_fact_with_capture, reject_excluded_evidence};
use crate::{
    fnv1a, EvidenceRef, FactStatus, MemoryStore, ProfileFact, ProfileFactCapture, ProfileScope,
    ReviewErrorState, ReviewFactCandidate,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoricalBackfillRange {
    pub session_id: String,
    pub book_id: String,
    pub from_turn_exclusive: u64,
    pub to_turn_inclusive: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalBackfillJobStatus {
    Queued,
    Running,
    Retryable,
    Cancelled,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoricalBackfillJob {
    pub job_id: String,
    pub session_id: String,
    pub book_id: String,
    pub from_turn_exclusive: u64,
    pub to_turn_inclusive: u64,
    pub processed_through: u64,
    pub status: HistoricalBackfillJobStatus,
    pub attempts: u32,
    #[serde(default)]
    pub candidate_fact_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ReviewErrorState>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalBackfillCommitOutcome {
    pub job: HistoricalBackfillJob,
    pub added_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalBackfillClearOutcome {
    pub cleared_job_id: String,
    pub removed_candidate_fact_ids: Vec<String>,
    pub retained_confirmed_fact_ids: Vec<String>,
}

impl HistoricalBackfillJob {
    pub fn stable_id(range: &HistoricalBackfillRange) -> String {
        let canonical = serde_json::to_string(range)
            .expect("historical backfill range has fixed serializable fields");
        format!("backfill_{:016x}", fnv1a(&canonical))
    }

    pub fn remaining_turns(&self) -> u64 {
        self.to_turn_inclusive
            .saturating_sub(self.processed_through)
    }
}

impl MemoryStore {
    pub fn historical_backfill_jobs(&self) -> &[HistoricalBackfillJob] {
        &self.document.review_state.historical_backfill_jobs
    }

    pub fn start_historical_backfill_job(
        &mut self,
        range: HistoricalBackfillRange,
        now: &str,
    ) -> Result<HistoricalBackfillJob, ToolError> {
        validate_range(&range)?;
        validate_timestamp(now)?;
        let job_id = HistoricalBackfillJob::stable_id(&range);
        if let Some(existing) = self
            .historical_backfill_jobs()
            .iter()
            .find(|job| job.job_id == job_id)
        {
            return Ok(existing.clone());
        }
        if let Some(existing) = self
            .historical_backfill_jobs()
            .iter()
            .find(|job| job.session_id == range.session_id && ranges_overlap(job, &range))
        {
            return Err(backfill_conflict(format!(
                "historical backfill range overlaps job {}",
                existing.job_id
            )));
        }

        let job = HistoricalBackfillJob {
            job_id,
            session_id: range.session_id,
            book_id: range.book_id,
            from_turn_exclusive: range.from_turn_exclusive,
            to_turn_inclusive: range.to_turn_inclusive,
            processed_through: range.from_turn_exclusive,
            status: HistoricalBackfillJobStatus::Queued,
            attempts: 0,
            candidate_fact_ids: Vec::new(),
            last_error: None,
            created_at: now.into(),
            updated_at: now.into(),
        };
        let mut candidate = self.document_mutation_candidate()?;
        candidate
            .review_state
            .historical_backfill_jobs
            .push(job.clone());
        sort_jobs(&mut candidate.review_state.historical_backfill_jobs);
        self.commit_document(candidate)?;
        Ok(job)
    }

    pub fn resume_interrupted_historical_backfill_jobs(
        &mut self,
        now: &str,
    ) -> Result<Vec<String>, ToolError> {
        validate_timestamp(now)?;
        let mut state = self.document.review_state.clone();
        let mut resumed = Vec::new();
        for job in &mut state.historical_backfill_jobs {
            if job.status == HistoricalBackfillJobStatus::Running {
                job.status = HistoricalBackfillJobStatus::Queued;
                job.updated_at = now.into();
                resumed.push(job.job_id.clone());
            }
        }
        if resumed.is_empty() {
            return Ok(resumed);
        }
        let mut candidate = self.document_mutation_candidate()?;
        candidate.review_state = state;
        self.commit_document(candidate)?;
        resumed.sort();
        Ok(resumed)
    }

    pub fn claim_historical_backfill_job(
        &mut self,
        job_id: &str,
        now: &str,
    ) -> Result<HistoricalBackfillJob, ToolError> {
        validate_timestamp(now)?;
        let mut candidate = self.document_mutation_candidate()?;
        let job = find_job_mut(&mut candidate.review_state.historical_backfill_jobs, job_id)?;
        if job.status != HistoricalBackfillJobStatus::Queued {
            return Err(backfill_conflict(format!(
                "cannot claim {:?} historical backfill job: {job_id}",
                job.status
            )));
        }
        job.attempts = job
            .attempts
            .checked_add(1)
            .ok_or_else(|| invalid_backfill("historical backfill attempts overflow"))?;
        job.status = HistoricalBackfillJobStatus::Running;
        job.updated_at = now.into();
        let claimed = job.clone();
        self.commit_document(candidate)?;
        Ok(claimed)
    }

    pub fn mark_historical_backfill_retryable(
        &mut self,
        job_id: &str,
        error: ReviewErrorState,
        now: &str,
    ) -> Result<HistoricalBackfillJob, ToolError> {
        validate_timestamp(now)?;
        validate_error(&error)?;
        let mut candidate = self.document_mutation_candidate()?;
        let job = find_job_mut(&mut candidate.review_state.historical_backfill_jobs, job_id)?;
        if job.status != HistoricalBackfillJobStatus::Running {
            return Err(backfill_conflict(format!(
                "cannot fail {:?} historical backfill job: {job_id}",
                job.status
            )));
        }
        job.status = HistoricalBackfillJobStatus::Retryable;
        job.last_error = Some(error);
        job.updated_at = now.into();
        let failed = job.clone();
        self.commit_document(candidate)?;
        Ok(failed)
    }

    pub fn cancel_historical_backfill_job(
        &mut self,
        job_id: &str,
        now: &str,
    ) -> Result<HistoricalBackfillJob, ToolError> {
        validate_timestamp(now)?;
        let current = find_job(&self.document.review_state.historical_backfill_jobs, job_id)?;
        if current.status == HistoricalBackfillJobStatus::Cancelled {
            return Ok(current.clone());
        }
        if current.status == HistoricalBackfillJobStatus::Completed {
            return Err(backfill_conflict(format!(
                "cannot cancel completed historical backfill job: {job_id}"
            )));
        }
        let mut candidate = self.document_mutation_candidate()?;
        let job = find_job_mut(&mut candidate.review_state.historical_backfill_jobs, job_id)?;
        job.status = HistoricalBackfillJobStatus::Cancelled;
        job.last_error = None;
        job.updated_at = now.into();
        let cancelled = job.clone();
        self.commit_document(candidate)?;
        Ok(cancelled)
    }

    pub fn retry_historical_backfill_job(
        &mut self,
        job_id: &str,
        now: &str,
    ) -> Result<HistoricalBackfillJob, ToolError> {
        validate_timestamp(now)?;
        let current = find_job(&self.document.review_state.historical_backfill_jobs, job_id)?;
        if current.status == HistoricalBackfillJobStatus::Queued {
            return Ok(current.clone());
        }
        if !matches!(
            current.status,
            HistoricalBackfillJobStatus::Retryable | HistoricalBackfillJobStatus::Cancelled
        ) {
            return Err(backfill_conflict(format!(
                "cannot retry {:?} historical backfill job: {job_id}",
                current.status
            )));
        }
        let mut candidate = self.document_mutation_candidate()?;
        let job = find_job_mut(&mut candidate.review_state.historical_backfill_jobs, job_id)?;
        job.status = HistoricalBackfillJobStatus::Queued;
        job.last_error = None;
        job.updated_at = now.into();
        let retried = job.clone();
        self.commit_document(candidate)?;
        Ok(retried)
    }

    pub fn commit_historical_backfill_turn(
        &mut self,
        job_id: &str,
        turn_ordinal: u64,
        turn_id: &str,
        fact_candidates: &[ReviewFactCandidate],
        now: &str,
    ) -> Result<HistoricalBackfillCommitOutcome, ToolError> {
        validate_timestamp(now)?;
        if turn_id.trim().is_empty() {
            return Err(invalid_backfill(
                "historical backfill turn_id must not be empty",
            ));
        }
        let current =
            find_job(&self.document.review_state.historical_backfill_jobs, job_id)?.clone();
        if current.status != HistoricalBackfillJobStatus::Running {
            return Err(backfill_conflict(format!(
                "cannot commit {:?} historical backfill job: {job_id}",
                current.status
            )));
        }
        let expected = current
            .processed_through
            .checked_add(1)
            .ok_or_else(|| invalid_backfill("historical backfill progress overflow"))?;
        if turn_ordinal != expected || turn_ordinal > current.to_turn_inclusive {
            return Err(backfill_conflict(format!(
                "historical backfill job {job_id} expects turn {expected}, got {turn_ordinal}"
            )));
        }

        let mut built = Vec::new();
        let mut candidate_ids = BTreeSet::new();
        for fact_candidate in fact_candidates {
            fact_candidate.validate()?;
            if !candidate_ids.insert(fact_candidate.candidate_id.as_str()) {
                return Err(invalid_backfill("duplicate historical backfill candidate"));
            }
            validate_candidate_evidence(
                &fact_candidate.fact.evidence,
                &current.session_id,
                turn_id,
            )?;
            if matches!(
                &fact_candidate.fact.scope,
                ProfileScope::Book { book_id } if book_id != &current.book_id
            ) {
                return Err(invalid_backfill(
                    "historical backfill fact book scope does not match the job",
                ));
            }
            reject_excluded_evidence(&self.document.exclusions, &fact_candidate.fact.evidence)?;
            if collection_rules_block(
                self.collection_rules(),
                &fact_candidate.fact.scope,
                &fact_candidate.fact.applicability,
                &fact_candidate.fact.payload,
            ) {
                continue;
            }
            built.push(build_profile_fact_with_capture(
                fact_candidate.fact.clone(),
                Vec::new(),
                ProfileFactCapture::HistoricalBackfill,
                now,
            )?);
        }
        built.sort_by(|left, right| left.fact_id.cmp(&right.fact_id));
        let existing_ids: BTreeSet<_> = self
            .document
            .profile_facts
            .iter()
            .map(|fact| fact.fact_id.as_str())
            .collect();
        let new_facts: Vec<_> = built
            .into_iter()
            .filter(|fact| !existing_ids.contains(fact.fact_id.as_str()))
            .collect();
        let added_fact_ids: Vec<_> = new_facts.iter().map(|fact| fact.fact_id.clone()).collect();
        let affected_keys: Vec<_> = new_facts
            .iter()
            .map(|fact| fact.payload.semantic_key())
            .collect();
        let mut candidate = if new_facts.is_empty() {
            self.document_mutation_candidate()?
        } else {
            self.projection_mutation_candidate()?
        };
        candidate.profile_facts.extend(new_facts);
        let job = find_job_mut(&mut candidate.review_state.historical_backfill_jobs, job_id)?;
        job.candidate_fact_ids.extend(added_fact_ids.clone());
        job.candidate_fact_ids.sort();
        job.candidate_fact_ids.dedup();
        job.processed_through = turn_ordinal;
        job.updated_at = now.into();
        job.last_error = None;
        if turn_ordinal == job.to_turn_inclusive {
            job.status = HistoricalBackfillJobStatus::Completed;
        }
        let updated_job = job.clone();
        reconcile_global_promotions(&mut candidate, &affected_keys, now)?;
        self.commit_document(candidate)?;
        if !added_fact_ids.is_empty() {
            let _ = self.write_profile_files();
        }
        Ok(HistoricalBackfillCommitOutcome {
            job: updated_job,
            added_fact_ids,
        })
    }

    pub fn clear_historical_backfill_job(
        &mut self,
        job_id: &str,
        now: &str,
    ) -> Result<HistoricalBackfillClearOutcome, ToolError> {
        validate_timestamp(now)?;
        let job = find_job(&self.document.review_state.historical_backfill_jobs, job_id)?.clone();
        let owned: BTreeSet<_> = job.candidate_fact_ids.iter().map(String::as_str).collect();
        let mut removed = Vec::new();
        let mut retained = Vec::new();
        let mut affected_keys = Vec::new();
        for fact in &self.document.profile_facts {
            if !owned.contains(fact.fact_id.as_str()) {
                continue;
            }
            if matches!(fact.status, FactStatus::Pending | FactStatus::Expired) {
                removed.push(fact.fact_id.clone());
                affected_keys.push(fact.payload.semantic_key());
            } else {
                retained.push(fact.fact_id.clone());
            }
        }
        removed.sort();
        retained.sort();
        let removed_set: BTreeSet<_> = removed.iter().map(String::as_str).collect();
        let mut candidate = if removed.is_empty() {
            self.document_mutation_candidate()?
        } else {
            self.projection_mutation_candidate()?
        };
        candidate
            .review_state
            .historical_backfill_jobs
            .retain(|candidate_job| candidate_job.job_id != job_id);
        candidate
            .profile_facts
            .retain(|fact| !removed_set.contains(fact.fact_id.as_str()));
        reconcile_global_promotions(&mut candidate, &affected_keys, now)?;
        self.commit_document(candidate)?;
        if !removed.is_empty() {
            let _ = self.write_profile_files();
        }
        Ok(HistoricalBackfillClearOutcome {
            cleared_job_id: job_id.into(),
            removed_candidate_fact_ids: removed,
            retained_confirmed_fact_ids: retained,
        })
    }
}

pub(crate) fn remove_historical_backfill_candidate_links(
    jobs: &mut [HistoricalBackfillJob],
    removed_fact_ids: &BTreeSet<String>,
) {
    for job in jobs {
        job.candidate_fact_ids
            .retain(|fact_id| !removed_fact_ids.contains(fact_id));
    }
}

pub(crate) fn validate_historical_backfill_jobs(
    jobs: &[HistoricalBackfillJob],
) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    let mut sessions = BTreeMap::<&str, &str>::new();
    for (index, job) in jobs.iter().enumerate() {
        job.validate()?;
        if !ids.insert(job.job_id.as_str()) {
            return Err(format!(
                "duplicate historical backfill job_id: {}",
                job.job_id
            ));
        }
        match sessions.get(job.session_id.as_str()) {
            Some(book_id) if *book_id != job.book_id => {
                return Err(format!(
                    "historical backfill session {} spans multiple books",
                    job.session_id
                ));
            }
            Some(_) => {}
            None => {
                sessions.insert(&job.session_id, &job.book_id);
            }
        }
        if jobs[..index].iter().any(|other| {
            other.session_id == job.session_id
                && other.from_turn_exclusive < job.to_turn_inclusive
                && job.from_turn_exclusive < other.to_turn_inclusive
        }) {
            return Err(format!(
                "overlapping historical backfill ranges for session {}",
                job.session_id
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_historical_backfill_fact_links(
    jobs: &[HistoricalBackfillJob],
    facts: &[ProfileFact],
) -> Result<(), String> {
    let by_id: BTreeMap<_, _> = facts
        .iter()
        .map(|fact| (fact.fact_id.as_str(), fact))
        .collect();
    let mut linked = BTreeSet::new();
    for job in jobs {
        for fact_id in &job.candidate_fact_ids {
            if !linked.insert(fact_id.as_str()) {
                return Err(format!(
                    "historical backfill candidate linked by multiple jobs: {fact_id}"
                ));
            }
            let fact = by_id.get(fact_id.as_str()).ok_or_else(|| {
                format!("historical backfill candidate fact does not exist: {fact_id}")
            })?;
            if fact.capture != ProfileFactCapture::HistoricalBackfill
                || fact.evidence.is_empty()
                || fact.evidence.iter().any(|evidence| {
                    !matches!(
                        evidence,
                        EvidenceRef::Turn { session_id, .. } if session_id == &job.session_id
                    )
                })
            {
                return Err(format!(
                    "historical backfill candidate fact has invalid provenance: {fact_id}"
                ));
            }
        }
    }
    Ok(())
}

impl HistoricalBackfillJob {
    fn validate(&self) -> Result<(), String> {
        let range = HistoricalBackfillRange {
            session_id: self.session_id.clone(),
            book_id: self.book_id.clone(),
            from_turn_exclusive: self.from_turn_exclusive,
            to_turn_inclusive: self.to_turn_inclusive,
        };
        validate_range(&range).map_err(|error| error.message)?;
        if self.job_id != Self::stable_id(&range) {
            return Err(format!(
                "historical backfill job_id is not content-addressed: {}",
                self.job_id
            ));
        }
        if self.created_at.trim().is_empty() || self.updated_at.trim().is_empty() {
            return Err(format!(
                "historical backfill job {} timestamps must not be empty",
                self.job_id
            ));
        }
        if self.processed_through < self.from_turn_exclusive
            || self.processed_through > self.to_turn_inclusive
        {
            return Err(format!(
                "historical backfill job {} progress is outside its range",
                self.job_id
            ));
        }
        if (self.status == HistoricalBackfillJobStatus::Completed)
            != (self.processed_through == self.to_turn_inclusive)
        {
            return Err(format!(
                "historical backfill job {} completion does not match progress",
                self.job_id
            ));
        }
        if matches!(
            self.status,
            HistoricalBackfillJobStatus::Running
                | HistoricalBackfillJobStatus::Retryable
                | HistoricalBackfillJobStatus::Completed
        ) && self.attempts == 0
        {
            return Err(format!(
                "historical backfill job {} status requires an attempt",
                self.job_id
            ));
        }
        match (&self.status, &self.last_error) {
            (HistoricalBackfillJobStatus::Retryable, Some(error)) => {
                validate_error(error).map_err(|error| error.message)?;
            }
            (HistoricalBackfillJobStatus::Retryable, None) => {
                return Err(format!(
                    "retryable historical backfill job {} requires an error",
                    self.job_id
                ));
            }
            (_, None) => {}
            (_, Some(_)) => {
                return Err(format!(
                    "historical backfill job {} has an error outside retryable state",
                    self.job_id
                ));
            }
        }
        let mut normalized = self.candidate_fact_ids.clone();
        normalized.sort();
        normalized.dedup();
        if normalized != self.candidate_fact_ids
            || normalized
                .iter()
                .any(|fact_id| !fact_id.starts_with("fact_"))
        {
            return Err(format!(
                "historical backfill job {} candidate IDs are invalid",
                self.job_id
            ));
        }
        Ok(())
    }
}

fn validate_range(range: &HistoricalBackfillRange) -> Result<(), ToolError> {
    if range.session_id.trim().is_empty()
        || range.book_id.trim().is_empty()
        || range.from_turn_exclusive >= range.to_turn_inclusive
    {
        return Err(invalid_backfill(
            "historical backfill requires a non-empty session/book and turn range",
        ));
    }
    Ok(())
}

fn validate_timestamp(now: &str) -> Result<(), ToolError> {
    if now.trim().is_empty() {
        return Err(invalid_backfill(
            "historical backfill transition timestamp must not be empty",
        ));
    }
    Ok(())
}

fn validate_error(error: &ReviewErrorState) -> Result<(), ToolError> {
    if error.error_code.trim().is_empty()
        || error.message.trim().is_empty()
        || error.occurred_at.trim().is_empty()
    {
        return Err(invalid_backfill(
            "historical backfill error fields must not be empty",
        ));
    }
    Ok(())
}

fn validate_candidate_evidence(
    evidence: &[EvidenceRef],
    session_id: &str,
    turn_id: &str,
) -> Result<(), ToolError> {
    if evidence.is_empty()
        || evidence.iter().any(|evidence| {
            !matches!(
                evidence,
                EvidenceRef::Turn {
                    session_id: evidence_session_id,
                    turn_id: evidence_turn_id,
                } if evidence_session_id == session_id && evidence_turn_id == turn_id
            )
        })
    {
        return Err(invalid_backfill(
            "historical backfill output must cite only the current selected resident turn",
        ));
    }
    Ok(())
}

fn ranges_overlap(job: &HistoricalBackfillJob, range: &HistoricalBackfillRange) -> bool {
    job.from_turn_exclusive < range.to_turn_inclusive
        && range.from_turn_exclusive < job.to_turn_inclusive
}

fn find_job<'a>(
    jobs: &'a [HistoricalBackfillJob],
    job_id: &str,
) -> Result<&'a HistoricalBackfillJob, ToolError> {
    jobs.iter()
        .find(|job| job.job_id == job_id)
        .ok_or_else(|| backfill_not_found(job_id))
}

fn find_job_mut<'a>(
    jobs: &'a mut [HistoricalBackfillJob],
    job_id: &str,
) -> Result<&'a mut HistoricalBackfillJob, ToolError> {
    jobs.iter_mut()
        .find(|job| job.job_id == job_id)
        .ok_or_else(|| backfill_not_found(job_id))
}

fn sort_jobs(jobs: &mut [HistoricalBackfillJob]) {
    jobs.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.from_turn_exclusive.cmp(&right.from_turn_exclusive))
            .then_with(|| left.to_turn_inclusive.cmp(&right.to_turn_inclusive))
            .then_with(|| left.job_id.cmp(&right.job_id))
    });
}

fn invalid_backfill(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_HISTORICAL_BACKFILL".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn backfill_not_found(job_id: &str) -> ToolError {
    ToolError {
        error_code: "HISTORICAL_BACKFILL_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("historical backfill job does not exist: {job_id}"),
    }
}

fn backfill_conflict(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "HISTORICAL_BACKFILL_STATE_CONFLICT".into(),
        category: "conflict".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Applicability, CollectionRuleMatcher, Confidence, CreateProfileFact, FactSource,
        PreferenceClaim, ProfileGovernanceAction, ProfileGovernanceMutation, ProfilePayload,
        ProfilePayloadKind, Sensitivity,
    };
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-backfill-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn range(from: u64, to: u64) -> HistoricalBackfillRange {
        HistoricalBackfillRange {
            session_id: "session-a".into(),
            book_id: "book-a".into(),
            from_turn_exclusive: from,
            to_turn_inclusive: to,
        }
    }

    fn candidate(turn_id: &str, key: &str, source: FactSource) -> ReviewFactCandidate {
        ReviewFactCandidate::new(CreateProfileFact {
            scope: ProfileScope::Book {
                book_id: "book-a".into(),
            },
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: key.into(),
                value: "worked_examples_first".into(),
            }),
            source,
            evidence: vec![EvidenceRef::Turn {
                session_id: "session-a".into(),
                turn_id: turn_id.into(),
            }],
            confidence: (source == FactSource::AgentInferred).then_some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        })
        .unwrap()
    }

    #[test]
    fn explicit_job_freezes_range_and_forces_source_preserving_pending_facts() {
        let (path, mut store) = store("pending-source");
        assert!(store.historical_backfill_jobs().is_empty());
        let job = store
            .start_historical_backfill_job(range(0, 2), "start")
            .unwrap();
        assert_eq!(job.processed_through, 0);
        assert_eq!(job.remaining_turns(), 2);
        let duplicate = store
            .start_historical_backfill_job(range(0, 2), "duplicate")
            .unwrap();
        assert_eq!(duplicate, job);

        store
            .claim_historical_backfill_job(&job.job_id, "claim")
            .unwrap();
        let first = store
            .commit_historical_backfill_turn(
                &job.job_id,
                1,
                "turn-1",
                &[candidate("turn-1", "example_order", FactSource::UserStated)],
                "turn-one",
            )
            .unwrap();
        assert_eq!(first.job.processed_through, 1);
        assert_eq!(first.job.status, HistoricalBackfillJobStatus::Running);
        let user_fact = store
            .profile_facts()
            .iter()
            .find(|fact| fact.fact_id == first.added_fact_ids[0])
            .unwrap();
        assert_eq!(user_fact.source, FactSource::UserStated);
        assert_eq!(user_fact.capture, ProfileFactCapture::HistoricalBackfill);
        assert_eq!(user_fact.status, FactStatus::Pending);

        let second = store
            .commit_historical_backfill_turn(
                &job.job_id,
                2,
                "turn-2",
                &[candidate(
                    "turn-2",
                    "diagram_use",
                    FactSource::AgentInferred,
                )],
                "turn-two",
            )
            .unwrap();
        assert_eq!(second.job.status, HistoricalBackfillJobStatus::Completed);
        assert_eq!(second.job.remaining_turns(), 0);
        let inferred = store
            .profile_facts()
            .iter()
            .find(|fact| fact.fact_id == second.added_fact_ids[0])
            .unwrap();
        assert_eq!(inferred.source, FactSource::AgentInferred);
        assert_eq!(inferred.status, FactStatus::Pending);
        assert!(store
            .resolve_profile_facts(&crate::ProfileResolutionContext {
                book_id: Some("book-a".into()),
                ..Default::default()
            })
            .is_empty());

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(
            reopened.historical_backfill_jobs(),
            store.historical_backfill_jobs()
        );
        assert_eq!(reopened.profile_facts(), store.profile_facts());
    }

    #[test]
    fn cancel_and_failure_keep_partial_progress_while_retry_fills_only_remainder() {
        let (_path, mut store) = store("cancel-retry");
        let job = store
            .start_historical_backfill_job(range(0, 3), "start")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim-one")
            .unwrap();
        let first = store
            .commit_historical_backfill_turn(
                &job.job_id,
                1,
                "turn-1",
                &[candidate("turn-1", "first", FactSource::UserStated)],
                "turn-one",
            )
            .unwrap();
        let cancelled = store
            .cancel_historical_backfill_job(&job.job_id, "cancel")
            .unwrap();
        assert_eq!(cancelled.processed_through, 1);
        assert_eq!(cancelled.candidate_fact_ids, first.added_fact_ids);
        assert_eq!(
            store
                .commit_historical_backfill_turn(&job.job_id, 2, "turn-2", &[], "blocked")
                .unwrap_err()
                .error_code,
            "HISTORICAL_BACKFILL_STATE_CONFLICT"
        );

        store
            .retry_historical_backfill_job(&job.job_id, "retry-one")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim-two")
            .unwrap();
        store
            .commit_historical_backfill_turn(&job.job_id, 2, "turn-2", &[], "turn-two")
            .unwrap();
        let retryable = store
            .mark_historical_backfill_retryable(
                &job.job_id,
                ReviewErrorState {
                    error_code: "PROVIDER_FAILED".into(),
                    message: "temporary".into(),
                    occurred_at: "failed".into(),
                },
                "failed",
            )
            .unwrap();
        assert_eq!(retryable.processed_through, 2);
        assert_eq!(retryable.status, HistoricalBackfillJobStatus::Retryable);

        store
            .retry_historical_backfill_job(&job.job_id, "retry-two")
            .unwrap();
        let claimed = store
            .claim_historical_backfill_job(&job.job_id, "claim-three")
            .unwrap();
        assert_eq!(claimed.attempts, 3);
        assert_eq!(claimed.processed_through, 2);
        let completed = store
            .commit_historical_backfill_turn(&job.job_id, 3, "turn-3", &[], "turn-three")
            .unwrap();
        assert_eq!(completed.job.status, HistoricalBackfillJobStatus::Completed);
        assert_eq!(completed.job.candidate_fact_ids, first.added_fact_ids);
    }

    #[test]
    fn restart_requeues_only_interrupted_running_jobs_without_scanning_history() {
        let (path, mut store) = store("resume-running");
        let job = store
            .start_historical_backfill_job(range(4, 6), "start")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim")
            .unwrap();
        drop(store);

        let mut reopened = MemoryStore::open(path).unwrap();
        let resumed = reopened
            .resume_interrupted_historical_backfill_jobs("restart")
            .unwrap();
        assert_eq!(resumed, vec![job.job_id.clone()]);
        let recovered = &reopened.historical_backfill_jobs()[0];
        assert_eq!(recovered.status, HistoricalBackfillJobStatus::Queued);
        assert_eq!(recovered.processed_through, 4);
        assert_eq!(recovered.attempts, 1);
        assert!(reopened
            .resume_interrupted_historical_backfill_jobs("again")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clear_removes_only_unconfirmed_candidates_and_forget_removes_confirmed_fact() {
        let (_path, mut store) = store("clear-confirmed");
        let job = store
            .start_historical_backfill_job(range(0, 2), "start")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim")
            .unwrap();
        let first = store
            .commit_historical_backfill_turn(
                &job.job_id,
                1,
                "turn-1",
                &[candidate("turn-1", "keep", FactSource::UserStated)],
                "one",
            )
            .unwrap();
        let second = store
            .commit_historical_backfill_turn(
                &job.job_id,
                2,
                "turn-2",
                &[candidate("turn-2", "remove", FactSource::UserStated)],
                "two",
            )
            .unwrap();
        let keep_id = first.added_fact_ids[0].clone();
        let remove_id = second.added_fact_ids[0].clone();
        store.confirm_profile_fact(&keep_id, "confirm").unwrap();
        store.reject_profile_fact(&remove_id, "reject").unwrap();

        let cleared = store
            .clear_historical_backfill_job(&job.job_id, "clear")
            .unwrap();
        assert_eq!(cleared.removed_candidate_fact_ids, vec![remove_id.clone()]);
        assert_eq!(cleared.retained_confirmed_fact_ids, vec![keep_id.clone()]);
        assert!(store.historical_backfill_jobs().is_empty());
        assert!(store
            .profile_facts()
            .iter()
            .all(|fact| fact.fact_id != remove_id));
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == keep_id)
                .unwrap()
                .status,
            FactStatus::Confirmed
        );

        store.forget_profile_fact(&keep_id, "forget").unwrap();
        assert!(store
            .profile_facts()
            .iter()
            .all(|fact| fact.fact_id != keep_id));
    }

    #[test]
    fn selected_turn_and_collection_rule_are_hard_boundaries() {
        let (_path, mut store) = store("boundaries");
        store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::AddCollectionRule {
                        operation_id: "rule-op".into(),
                        matcher: CollectionRuleMatcher {
                            payload_kind: ProfilePayloadKind::ExplanationPreference,
                            semantic_key: Some("explanation_preference:blocked".into()),
                            scope: None,
                            applicability: None,
                        },
                    },
                },
                "rule",
            )
            .unwrap();
        let job = store
            .start_historical_backfill_job(range(0, 1), "start")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim")
            .unwrap();
        let revision = store.document_revision();
        assert_eq!(
            store
                .commit_historical_backfill_turn(
                    &job.job_id,
                    1,
                    "turn-1",
                    &[candidate("turn-outside", "outside", FactSource::UserStated)],
                    "invalid",
                )
                .unwrap_err()
                .error_code,
            "INVALID_HISTORICAL_BACKFILL"
        );
        assert_eq!(store.document_revision(), revision);
        assert_eq!(store.historical_backfill_jobs()[0].processed_through, 0);

        let completed = store
            .commit_historical_backfill_turn(
                &job.job_id,
                1,
                "turn-1",
                &[candidate("turn-1", "blocked", FactSource::UserStated)],
                "valid",
            )
            .unwrap();
        assert!(completed.added_fact_ids.is_empty());
        assert!(store.profile_facts().is_empty());
        assert_eq!(completed.job.status, HistoricalBackfillJobStatus::Completed);
    }

    #[test]
    fn forget_scrubs_backfill_candidates_that_share_excluded_evidence() {
        let (_path, mut store) = store("forget-shared-evidence");
        let job = store
            .start_historical_backfill_job(range(0, 1), "start")
            .unwrap();
        store
            .claim_historical_backfill_job(&job.job_id, "claim")
            .unwrap();
        let committed = store
            .commit_historical_backfill_turn(
                &job.job_id,
                1,
                "turn-1",
                &[
                    candidate("turn-1", "forget-one", FactSource::UserStated),
                    candidate("turn-1", "forget-two", FactSource::UserStated),
                ],
                "commit",
            )
            .unwrap();
        let target = committed.added_fact_ids[0].clone();
        store.confirm_profile_fact(&target, "confirm").unwrap();

        let forgotten = store.forget_profile_fact(&target, "forget").unwrap();
        assert_eq!(forgotten.removed_dependent_fact_ids.len(), 1);
        assert!(store.profile_facts().is_empty());
        assert!(store.historical_backfill_jobs()[0]
            .candidate_fact_ids
            .is_empty());
    }

    #[test]
    fn overlapping_ranges_are_rejected_until_the_first_job_is_cleared() {
        let (_path, mut store) = store("overlap");
        let first = store
            .start_historical_backfill_job(range(0, 3), "first")
            .unwrap();
        assert_eq!(
            store
                .start_historical_backfill_job(range(2, 4), "overlap")
                .unwrap_err()
                .error_code,
            "HISTORICAL_BACKFILL_STATE_CONFLICT"
        );
        let cancelled = store
            .cancel_historical_backfill_job(&first.job_id, "cancel-before-claim")
            .unwrap();
        assert_eq!(cancelled.attempts, 0);
        assert_eq!(cancelled.status, HistoricalBackfillJobStatus::Cancelled);
        store
            .clear_historical_backfill_job(&first.job_id, "clear")
            .unwrap();
        assert!(store
            .start_historical_backfill_job(range(2, 4), "after-clear")
            .is_ok());
    }
}
