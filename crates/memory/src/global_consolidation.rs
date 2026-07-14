use crate::document::MemoryDocument;
use crate::profile::build_profile_fact;
use crate::{
    fnv1a, Applicability, Confidence, CreateProfileFact, EvidenceRef, FactSource, FactStatus,
    GlobalConsolidationJob, ProfileFact, ProfilePayload, ProfileScope, ReviewJobStatus,
    Sensitivity,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MIN_PROMOTION_BOOKS: usize = 2;
const MIN_PROMOTION_EVIDENCE: usize = 3;
const MAX_COMPLETED_CONSOLIDATION_JOBS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GlobalPromotionState {
    pub cluster_key: String,
    pub semantic_key: String,
    pub candidate_fact_id: String,
    pub supporting_fact_ids: Vec<String>,
    pub book_ids: Vec<String>,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GlobalConsolidationDelta {
    pub added_fact_ids: Vec<String>,
    pub removed_fact_ids: Vec<String>,
}

struct PromotionCluster {
    cluster_key: String,
    semantic_key: String,
    applicability: Applicability,
    payload: ProfilePayload,
    supporting_fact_ids: BTreeSet<String>,
    book_ids: BTreeSet<String>,
    evidence_by_id: BTreeMap<String, EvidenceRef>,
    books_by_evidence_id: BTreeMap<String, BTreeSet<String>>,
}

pub(crate) fn reconcile_global_promotions(
    document: &mut MemoryDocument,
    affected_keys: &[String],
    now: &str,
) -> Result<GlobalConsolidationDelta, ToolError> {
    let affected_keys = normalized_strings(affected_keys);
    if affected_keys.is_empty() {
        return Ok(GlobalConsolidationDelta::default());
    }
    let affected: BTreeSet<&str> = affected_keys.iter().map(String::as_str).collect();
    let excluded: BTreeSet<&str> = document
        .exclusions
        .iter()
        .map(|exclusion| exclusion.evidence_id.as_str())
        .collect();
    let owned_candidate_ids: BTreeSet<&str> = document
        .review_state
        .global_promotions
        .iter()
        .map(|promotion| promotion.candidate_fact_id.as_str())
        .collect();
    let previous_promotions = document.review_state.global_promotions.clone();
    let mut clusters = BTreeMap::<String, PromotionCluster>::new();
    let mut blocking_global_clusters = BTreeSet::new();

    for fact in &document.profile_facts {
        let semantic_key = fact.payload.semantic_key();
        if !affected.contains(semantic_key.as_str()) || !fact_is_active(fact, now) {
            continue;
        }
        let cluster_key = promotion_cluster_key(&semantic_key, &fact.applicability, &fact.payload);
        match &fact.scope {
            ProfileScope::Global => {
                if !owned_candidate_ids.contains(fact.fact_id.as_str()) {
                    blocking_global_clusters.insert(cluster_key);
                }
            }
            ProfileScope::Book { book_id }
                if fact.source != FactSource::DeterministicBehavior
                    && fact.sensitivity == Sensitivity::Normal
                    && !matches!(&fact.payload, ProfilePayload::Extension { .. }) =>
            {
                let cluster =
                    clusters
                        .entry(cluster_key.clone())
                        .or_insert_with(|| PromotionCluster {
                            cluster_key,
                            semantic_key,
                            applicability: fact.applicability.clone(),
                            payload: fact.payload.clone(),
                            supporting_fact_ids: BTreeSet::new(),
                            book_ids: BTreeSet::new(),
                            evidence_by_id: BTreeMap::new(),
                            books_by_evidence_id: BTreeMap::new(),
                        });
                cluster.supporting_fact_ids.insert(fact.fact_id.clone());
                cluster.book_ids.insert(book_id.clone());
                for evidence in &fact.evidence {
                    let evidence_id = evidence.evidence_id();
                    if !excluded.contains(evidence_id.as_str()) {
                        cluster
                            .books_by_evidence_id
                            .entry(evidence_id.clone())
                            .or_default()
                            .insert(book_id.clone());
                        cluster
                            .evidence_by_id
                            .entry(evidence_id)
                            .or_insert_with(|| evidence.clone());
                    }
                }
            }
            ProfileScope::Book { .. } => {}
        }
    }

    let mut desired_promotions = Vec::new();
    let mut added_facts = Vec::new();
    for cluster in clusters.into_values() {
        if cluster.book_ids.len() < MIN_PROMOTION_BOOKS
            || cluster.evidence_by_id.len() < MIN_PROMOTION_EVIDENCE
            || blocking_global_clusters.contains(&cluster.cluster_key)
        {
            continue;
        }
        let supporting_fact_ids: Vec<_> = cluster.supporting_fact_ids.into_iter().collect();
        let book_ids: Vec<_> = cluster.book_ids.into_iter().collect();
        let evidence_ids: Vec<_> = cluster.evidence_by_id.keys().cloned().collect();
        let existing_promotion = previous_promotions
            .iter()
            .find(|promotion| promotion.cluster_key == cluster.cluster_key);
        let existing_fact = existing_promotion.and_then(|promotion| {
            document
                .profile_facts
                .iter()
                .find(|fact| fact.fact_id == promotion.candidate_fact_id)
                .filter(|fact| {
                    fact.evidence.len() >= MIN_PROMOTION_EVIDENCE
                        && fact.evidence.iter().all(|evidence| {
                            cluster.evidence_by_id.contains_key(&evidence.evidence_id())
                        })
                })
        });
        let existing = existing_promotion.zip(existing_fact);
        let candidate_fact_id = if let Some((promotion, _fact)) = existing {
            promotion.candidate_fact_id.clone()
        } else {
            let evidence = promotion_certificate(
                &cluster.evidence_by_id,
                &cluster.books_by_evidence_id,
                &book_ids,
            );
            let fact = build_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: cluster.applicability,
                    payload: cluster.payload,
                    source: FactSource::AgentInferred,
                    evidence,
                    confidence: Some(Confidence::Medium),
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                Vec::new(),
                now,
            )?;
            let fact_id = fact.fact_id.clone();
            if !document
                .profile_facts
                .iter()
                .any(|existing| existing.fact_id == fact.fact_id)
            {
                added_facts.push(fact);
            }
            fact_id
        };
        desired_promotions.push(GlobalPromotionState {
            cluster_key: cluster.cluster_key,
            semantic_key: cluster.semantic_key,
            candidate_fact_id,
            supporting_fact_ids,
            book_ids,
            evidence_ids,
        });
    }

    let desired_fact_ids: BTreeSet<&str> = desired_promotions
        .iter()
        .map(|promotion| promotion.candidate_fact_id.as_str())
        .collect();
    let stale_fact_ids: BTreeSet<String> = previous_promotions
        .iter()
        .filter(|promotion| affected.contains(promotion.semantic_key.as_str()))
        .filter(|promotion| !desired_fact_ids.contains(promotion.candidate_fact_id.as_str()))
        .map(|promotion| promotion.candidate_fact_id.clone())
        .collect();
    let mut removed_fact_ids = Vec::new();
    document.profile_facts.retain(|fact| {
        if stale_fact_ids.contains(&fact.fact_id) && fact.status != FactStatus::Superseded {
            removed_fact_ids.push(fact.fact_id.clone());
            false
        } else {
            true
        }
    });
    let added_fact_ids: Vec<_> = added_facts
        .iter()
        .map(|fact| fact.fact_id.clone())
        .collect();
    document.profile_facts.extend(added_facts);
    document
        .review_state
        .global_promotions
        .retain(|promotion| !affected.contains(promotion.semantic_key.as_str()));
    document
        .review_state
        .global_promotions
        .extend(desired_promotions);
    document
        .review_state
        .global_promotions
        .sort_by(|left, right| {
            left.cluster_key
                .cmp(&right.cluster_key)
                .then_with(|| left.candidate_fact_id.cmp(&right.candidate_fact_id))
        });
    record_completed_job(document, &affected_keys);
    removed_fact_ids.sort();

    Ok(GlobalConsolidationDelta {
        added_fact_ids,
        removed_fact_ids,
    })
}

pub(crate) fn validate_promotion_states(promotions: &[GlobalPromotionState]) -> Result<(), String> {
    let mut cluster_keys = BTreeSet::new();
    let mut candidate_fact_ids = BTreeSet::new();
    for promotion in promotions {
        if !promotion.cluster_key.starts_with("promotion_cluster_")
            || promotion.semantic_key.trim().is_empty()
            || !promotion.candidate_fact_id.starts_with("fact_")
            || promotion.supporting_fact_ids.len() < MIN_PROMOTION_BOOKS
            || promotion.book_ids.len() < MIN_PROMOTION_BOOKS
            || promotion.evidence_ids.len() < MIN_PROMOTION_EVIDENCE
            || promotion.supporting_fact_ids != normalized_strings(&promotion.supporting_fact_ids)
            || promotion.book_ids != normalized_strings(&promotion.book_ids)
            || promotion.evidence_ids != normalized_strings(&promotion.evidence_ids)
        {
            return Err("invalid global promotion state".into());
        }
        if !cluster_keys.insert(promotion.cluster_key.as_str()) {
            return Err(format!(
                "duplicate global promotion cluster: {}",
                promotion.cluster_key
            ));
        }
        if !candidate_fact_ids.insert(promotion.candidate_fact_id.as_str()) {
            return Err(format!(
                "duplicate global promotion candidate: {}",
                promotion.candidate_fact_id
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_promotion_links(
    promotions: &[GlobalPromotionState],
    facts: &[ProfileFact],
) -> Result<(), String> {
    for promotion in promotions {
        let candidate = facts
            .iter()
            .find(|fact| fact.fact_id == promotion.candidate_fact_id)
            .ok_or_else(|| {
                format!(
                    "global promotion candidate is missing: {}",
                    promotion.candidate_fact_id
                )
            })?;
        if candidate.scope != ProfileScope::Global
            || candidate.source != FactSource::AgentInferred
            || candidate.payload.semantic_key() != promotion.semantic_key
            || promotion.cluster_key
                != promotion_cluster_key(
                    &promotion.semantic_key,
                    &candidate.applicability,
                    &candidate.payload,
                )
        {
            return Err(format!(
                "global promotion candidate contract mismatch: {}",
                candidate.fact_id
            ));
        }
        let mut source_book_ids = BTreeSet::new();
        let mut source_evidence_ids = BTreeSet::new();
        for source_fact_id in &promotion.supporting_fact_ids {
            let source = facts
                .iter()
                .find(|fact| fact.fact_id == *source_fact_id)
                .ok_or_else(|| format!("global promotion source is missing: {source_fact_id}"))?;
            let ProfileScope::Book { book_id } = &source.scope else {
                return Err(format!(
                    "global promotion source is not book-scoped: {source_fact_id}"
                ));
            };
            if !matches!(
                source.status,
                FactStatus::Confirmed | FactStatus::Provisional
            ) || source.payload.semantic_key() != promotion.semantic_key
                || promotion.cluster_key
                    != promotion_cluster_key(
                        &promotion.semantic_key,
                        &source.applicability,
                        &source.payload,
                    )
            {
                return Err(format!(
                    "global promotion source contract mismatch: {source_fact_id}"
                ));
            }
            source_book_ids.insert(book_id.clone());
            source_evidence_ids.extend(source.evidence.iter().map(EvidenceRef::evidence_id));
        }
        if source_book_ids.into_iter().collect::<Vec<_>>() != promotion.book_ids
            || source_evidence_ids.into_iter().collect::<Vec<_>>() != promotion.evidence_ids
            || candidate
                .evidence
                .iter()
                .any(|evidence| !promotion.evidence_ids.contains(&evidence.evidence_id()))
        {
            return Err(format!(
                "global promotion support index mismatch: {}",
                promotion.candidate_fact_id
            ));
        }
    }
    Ok(())
}

fn record_completed_job(document: &mut MemoryDocument, affected_keys: &[String]) {
    let source_revision = document.projection_revision;
    let job_id = GlobalConsolidationJob::stable_id(affected_keys, source_revision);
    if document
        .review_state
        .consolidation_jobs
        .iter()
        .any(|job| job.job_id == job_id)
    {
        return;
    }
    document
        .review_state
        .consolidation_jobs
        .push(GlobalConsolidationJob {
            job_id,
            affected_keys: affected_keys.to_vec(),
            source_revision,
            status: ReviewJobStatus::Completed,
            attempts: 1,
            next_attempt_at: None,
        });
    document
        .review_state
        .consolidation_jobs
        .sort_by(|left, right| {
            left.source_revision
                .cmp(&right.source_revision)
                .then_with(|| left.job_id.cmp(&right.job_id))
        });
    let mut completed_to_remove = document
        .review_state
        .consolidation_jobs
        .iter()
        .filter(|job| job.status == ReviewJobStatus::Completed)
        .count()
        .saturating_sub(MAX_COMPLETED_CONSOLIDATION_JOBS);
    document.review_state.consolidation_jobs.retain(|job| {
        if completed_to_remove > 0 && job.status == ReviewJobStatus::Completed {
            completed_to_remove -= 1;
            false
        } else {
            true
        }
    });
}

fn fact_is_active(fact: &ProfileFact, now: &str) -> bool {
    matches!(fact.status, FactStatus::Confirmed | FactStatus::Provisional)
        && fact
            .valid_until
            .as_ref()
            .is_none_or(|valid_until| now.is_empty() || valid_until.as_str() > now)
}

fn promotion_certificate(
    evidence_by_id: &BTreeMap<String, EvidenceRef>,
    books_by_evidence_id: &BTreeMap<String, BTreeSet<String>>,
    book_ids: &[String],
) -> Vec<EvidenceRef> {
    let mut selected_ids = BTreeSet::new();
    for book_id in book_ids.iter().take(MIN_PROMOTION_BOOKS) {
        if let Some((evidence_id, _)) = books_by_evidence_id.iter().find(|(evidence_id, books)| {
            books.contains(book_id.as_str()) && !selected_ids.contains(evidence_id.as_str())
        }) {
            selected_ids.insert(evidence_id.clone());
        }
    }
    for evidence_id in evidence_by_id.keys() {
        if selected_ids.len() >= MIN_PROMOTION_EVIDENCE {
            break;
        }
        selected_ids.insert(evidence_id.clone());
    }
    selected_ids
        .into_iter()
        .filter_map(|evidence_id| evidence_by_id.get(&evidence_id).cloned())
        .collect()
}

fn promotion_cluster_key(
    semantic_key: &str,
    applicability: &Applicability,
    payload: &ProfilePayload,
) -> String {
    let canonical = serde_json::to_string(&(semantic_key, applicability, payload))
        .expect("promotion cluster identity has fixed serializable fields");
    format!("promotion_cluster_{:016x}", fnv1a(&canonical))
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExplicitProfileFact, MemoryOp, MemoryOpOutcome, MemoryStore, PreferenceClaim,
        ProfileResolutionContext, ReviewFactCandidate, ReviewSessionCursor, SnapshotContext,
        SnapshotRequest,
    };
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-global-consolidation-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn source_fact(book_id: &str, turn_id: &str, value: &str) -> CreateProfileFact {
        CreateProfileFact {
            scope: ProfileScope::Book {
                book_id: book_id.into(),
            },
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: "example_order".into(),
                value: value.into(),
            }),
            source: FactSource::AgentInferred,
            evidence: vec![EvidenceRef::Turn {
                session_id: format!("session-{book_id}"),
                turn_id: turn_id.into(),
            }],
            confidence: Some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        }
    }

    fn review_candidate(book_id: &str, session_id: &str, turn_id: &str) -> ReviewFactCandidate {
        ReviewFactCandidate::new(CreateProfileFact {
            scope: ProfileScope::Book {
                book_id: book_id.into(),
            },
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: "example_order".into(),
                value: "worked_examples_first".into(),
            }),
            source: FactSource::AgentInferred,
            evidence: vec![EvidenceRef::Turn {
                session_id: session_id.into(),
                turn_id: turn_id.into(),
            }],
            confidence: Some(Confidence::Medium),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
        })
        .unwrap()
    }

    fn seed_eligible(store: &mut MemoryStore) -> Vec<ProfileFact> {
        [
            ("book-a", "turn-a1"),
            ("book-a", "turn-a2"),
            ("book-b", "turn-b1"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (book_id, turn_id))| {
            store
                .create_profile_fact(
                    source_fact(book_id, turn_id, "worked_examples_first"),
                    &format!("2026-07-14T00:0{index}:00Z"),
                )
                .unwrap()
        })
        .collect()
    }

    fn promotion_fact(store: &MemoryStore) -> ProfileFact {
        let state = store.review_state();
        assert_eq!(state.global_promotions.len(), 1);
        let candidate_id = &state.global_promotions[0].candidate_fact_id;
        store
            .profile_facts()
            .iter()
            .find(|fact| &fact.fact_id == candidate_id)
            .unwrap()
            .clone()
    }

    fn snapshot(store: &MemoryStore) -> crate::ReaderProfileSnapshot {
        store.project_reader_profile_snapshot(&SnapshotRequest::current(SnapshotContext {
            book_id: Some("book-c".into()),
            content_profile: Some("technical_learning".into()),
            ..Default::default()
        }))
    }

    #[test]
    fn one_book_repetition_never_promotes() {
        let (_path, mut store) = store("one-book");
        for index in 0..3 {
            store
                .create_profile_fact(
                    source_fact("book-a", &format!("turn-{index}"), "examples_first"),
                    &format!("2026-07-14T00:0{index}:00Z"),
                )
                .unwrap();
        }

        assert!(store.review_state().global_promotions.is_empty());
        assert!(!store
            .profile_facts()
            .iter()
            .any(|fact| matches!(fact.scope, ProfileScope::Global)));
        assert!(store
            .review_state()
            .consolidation_jobs
            .iter()
            .all(|job| job.status == ReviewJobStatus::Completed));
    }

    #[test]
    fn two_books_three_evidence_create_pending_then_confirmed_snapshot() {
        let (path, mut store) = store("eligible-confirm");
        seed_eligible(&mut store);
        let pending = promotion_fact(&store);

        assert_eq!(pending.scope, ProfileScope::Global);
        assert_eq!(pending.source, FactSource::AgentInferred);
        assert_eq!(pending.status, FactStatus::Pending);
        assert_eq!(pending.evidence.len(), MIN_PROMOTION_EVIDENCE);
        let evidence_sessions: BTreeSet<_> = pending
            .evidence
            .iter()
            .filter_map(|evidence| match evidence {
                EvidenceRef::Turn { session_id, .. } => Some(session_id.as_str()),
                _ => None,
            })
            .collect();
        assert!(evidence_sessions.contains("session-book-a"));
        assert!(evidence_sessions.contains("session-book-b"));
        assert!(!snapshot(&store)
            .injected_fact_ids()
            .contains(&pending.fact_id));
        assert!(store
            .resolve_profile_facts(&ProfileResolutionContext::default())
            .iter()
            .all(|fact| fact.fact_id != pending.fact_id));

        let confirmed = store
            .confirm_profile_fact(&pending.fact_id, "2026-07-14T00:04:00Z")
            .unwrap();
        assert_eq!(confirmed.status, FactStatus::Confirmed);
        assert!(snapshot(&store)
            .injected_fact_ids()
            .contains(&pending.fact_id));

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.review_state(), store.review_state());
        assert_eq!(promotion_fact(&reopened).status, FactStatus::Confirmed);
    }

    #[test]
    fn rejected_candidate_stays_inactive_until_its_evidence_basis_changes() {
        let (_path, mut store) = store("reject");
        seed_eligible(&mut store);
        let pending = promotion_fact(&store);

        let rejected = store
            .reject_profile_fact(&pending.fact_id, "2026-07-14T00:04:00Z")
            .unwrap();
        assert_eq!(rejected.status, FactStatus::Expired);
        store
            .create_profile_fact(
                source_fact("book-b", "turn-b2", "worked_examples_first"),
                "2026-07-14T00:05:00Z",
            )
            .unwrap();

        assert_eq!(promotion_fact(&store).fact_id, pending.fact_id);
        assert_eq!(promotion_fact(&store).status, FactStatus::Expired);
        assert!(!snapshot(&store)
            .injected_fact_ids()
            .contains(&pending.fact_id));
        assert!(!store
            .profile_facts()
            .iter()
            .any(|fact| fact.scope == ProfileScope::Global && fact.status == FactStatus::Pending));
    }

    #[test]
    fn source_expiry_correction_and_forget_reverse_recompute_promotions() {
        let (_path, mut expiry_store) = store("source-expiry");
        let expiry_sources = seed_eligible(&mut expiry_store);
        let expiry_candidate = promotion_fact(&expiry_store);
        expiry_store
            .expire_profile_fact(&expiry_sources[2].fact_id, "2026-07-14T00:04:00Z")
            .unwrap();
        assert!(expiry_store.review_state().global_promotions.is_empty());
        assert!(!expiry_store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == expiry_candidate.fact_id));

        let (_path, mut correction_store) = store("source-correction");
        let correction_sources = seed_eligible(&mut correction_store);
        let correction_candidate = promotion_fact(&correction_store);
        correction_store
            .correct_profile_fact(
                &correction_sources[2].fact_id,
                CreateProfileFact {
                    scope: ProfileScope::Book {
                        book_id: "book-b".into(),
                    },
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "example_order".into(),
                        value: "diagrams_first".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "session-book-b".into(),
                        turn_id: "turn-correction".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-07-14T00:04:00Z",
            )
            .unwrap();
        assert!(correction_store.review_state().global_promotions.is_empty());
        assert!(!correction_store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == correction_candidate.fact_id));

        let (_path, mut forget_store) = store("source-forget");
        let forget_sources = seed_eligible(&mut forget_store);
        let forget_candidate = promotion_fact(&forget_store);
        forget_store
            .confirm_profile_fact(&forget_candidate.fact_id, "2026-07-14T00:04:00Z")
            .unwrap();
        let outcome = forget_store
            .forget_profile_fact(&forget_sources[2].fact_id, "2026-07-14T00:05:00Z")
            .unwrap();
        assert!(outcome
            .removed_dependent_fact_ids
            .contains(&forget_candidate.fact_id));
        assert!(forget_store.review_state().global_promotions.is_empty());
        assert!(!snapshot(&forget_store)
            .injected_fact_ids()
            .contains(&forget_candidate.fact_id));
    }

    #[test]
    fn review_commits_trigger_consolidation_without_transcript_rescan() {
        let (_path, mut store) = store("review-entry");
        store
            .reconcile_review_jobs(
                &[
                    ReviewSessionCursor {
                        session_id: "session-a".into(),
                        book_id: "book-a".into(),
                        latest_user_turn_ordinal: 2,
                    },
                    ReviewSessionCursor {
                        session_id: "session-b".into(),
                        book_id: "book-b".into(),
                        latest_user_turn_ordinal: 1,
                    },
                ],
                "2026-07-14T00:00:00Z",
            )
            .unwrap();
        let job_a = store
            .review_state()
            .review_jobs
            .iter()
            .find(|job| job.session_id == "session-a")
            .unwrap()
            .clone();
        store
            .claim_review_job(&job_a.job_id, "2026-07-14T00:01:00Z")
            .unwrap();
        store
            .commit_review_result(
                &job_a.job_id,
                &["turn-a1".into(), "turn-a2".into()],
                &[
                    review_candidate("book-a", "session-a", "turn-a1"),
                    review_candidate("book-a", "session-a", "turn-a2"),
                ],
                &[],
                "2026-07-14T00:02:00Z",
            )
            .unwrap();
        assert!(store.review_state().global_promotions.is_empty());

        let job_b = store
            .review_state()
            .review_jobs
            .iter()
            .find(|job| job.session_id == "session-b")
            .unwrap()
            .clone();
        store
            .claim_review_job(&job_b.job_id, "2026-07-14T00:03:00Z")
            .unwrap();
        store
            .commit_review_result(
                &job_b.job_id,
                &["turn-b1".into()],
                &[review_candidate("book-b", "session-b", "turn-b1")],
                &[],
                "2026-07-14T00:04:00Z",
            )
            .unwrap();

        assert_eq!(promotion_fact(&store).status, FactStatus::Pending);
        assert_eq!(store.review_state().global_promotions[0].book_ids.len(), 2);
        assert_eq!(
            store.review_state().global_promotions[0].evidence_ids.len(),
            3
        );
    }

    #[test]
    fn explicit_memory_ops_trigger_and_reverse_consolidation_atomically() {
        let (_path, mut store) = store("operation-entry");
        let mut source_fact_ids = Vec::new();
        for (index, (book_id, operation_id)) in [
            ("book-a", "remember-a1"),
            ("book-a", "remember-a2"),
            ("book-b", "remember-b1"),
        ]
        .into_iter()
        .enumerate()
        {
            let outcome = store
                .apply_memory_op(
                    MemoryOp::Remember {
                        operation_id: operation_id.into(),
                        book_id: book_id.into(),
                        evidence_text: "Remember that I prefer worked examples first".into(),
                        fact: ExplicitProfileFact {
                            scope: ProfileScope::Book {
                                book_id: book_id.into(),
                            },
                            applicability: Applicability::Any,
                            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                                key: "example_order".into(),
                                value: "worked_examples_first".into(),
                            }),
                            sensitivity: Sensitivity::Normal,
                            valid_until: None,
                            sensitive_plaintext_acknowledged: false,
                        },
                    },
                    &format!("2026-07-14T00:0{index}:00Z"),
                )
                .unwrap();
            let MemoryOpOutcome::Remembered { fact, .. } = outcome else {
                panic!("expected remembered outcome");
            };
            source_fact_ids.push(fact.fact_id);
        }
        let candidate = promotion_fact(&store);

        let outcome = store
            .apply_memory_op(
                MemoryOp::Forget {
                    operation_id: "forget-b1".into(),
                    fact_id: source_fact_ids[2].clone(),
                },
                "2026-07-14T00:04:00Z",
            )
            .unwrap();
        let MemoryOpOutcome::Forgotten {
            removed_dependent_fact_ids,
            ..
        } = outcome
        else {
            panic!("expected forgotten outcome");
        };

        assert!(removed_dependent_fact_ids.contains(&candidate.fact_id));
        assert!(store.review_state().global_promotions.is_empty());
        assert!(!store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == candidate.fact_id));
    }
}
