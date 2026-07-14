use crate::global_consolidation::reconcile_global_promotions;
use crate::profile::{build_profile_fact, reject_excluded_evidence};
use crate::{
    classify_profile_fact_privacy, fnv1a, Applicability, Confidence, CreateProfileFact,
    EvidenceExclusion, EvidenceRef, ExclusionReason, FactSource, FactStatus, MemoryDocument,
    MemoryStore, ProfileFact, ProfilePayload, ProfilePrivacyClass, ProfileScope, Record,
    Sensitivity, Usage,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const PROFILE_EVIDENCE_RECORD_TYPE: &str = "profile_evidence";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExplicitProfileFact {
    pub scope: ProfileScope,
    pub applicability: Applicability,
    pub payload: ProfilePayload,
    pub sensitivity: Sensitivity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub sensitive_plaintext_acknowledged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoryOp {
    Remember {
        operation_id: String,
        book_id: String,
        evidence_text: String,
        fact: ExplicitProfileFact,
    },
    Correct {
        operation_id: String,
        book_id: String,
        evidence_text: String,
        fact_id: String,
        replacement: ExplicitProfileFact,
    },
    Forget {
        operation_id: String,
        fact_id: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoryOpOutcome {
    Remembered {
        operation_id: String,
        fact: ProfileFact,
        evidence_mem_id: String,
    },
    Corrected {
        operation_id: String,
        fact: ProfileFact,
        evidence_mem_id: String,
    },
    Forgotten {
        operation_id: String,
        forgotten_fact_ids: Vec<String>,
        excluded_evidence_ids: Vec<String>,
        removed_dependent_fact_ids: Vec<String>,
    },
}

pub(crate) struct ReducedMemoryOp {
    pub(crate) candidate: Option<MemoryDocument>,
    pub(crate) outcome: MemoryOpOutcome,
    pub(crate) refresh_profile_files: bool,
}

impl MemoryStore {
    pub fn apply_memory_op(
        &mut self,
        operation: MemoryOp,
        now: &str,
    ) -> Result<MemoryOpOutcome, ToolError> {
        let reduced = self.reduce_memory_op(operation, now)?;
        if let Some(candidate) = reduced.candidate {
            self.commit_document(candidate)?;
            if reduced.refresh_profile_files {
                let _ = self.write_profile_files();
            }
        }
        Ok(reduced.outcome)
    }

    pub(crate) fn reduce_memory_op(
        &self,
        operation: MemoryOp,
        now: &str,
    ) -> Result<ReducedMemoryOp, ToolError> {
        match operation {
            MemoryOp::Remember {
                operation_id,
                book_id,
                evidence_text,
                fact,
            } => self.reduce_remember(operation_id, book_id, evidence_text, fact, now),
            MemoryOp::Correct {
                operation_id,
                book_id,
                evidence_text,
                fact_id,
                replacement,
            } => self.reduce_correction(
                operation_id,
                book_id,
                evidence_text,
                fact_id,
                replacement,
                now,
            ),
            MemoryOp::Forget {
                operation_id,
                fact_id,
            } => self.reduce_forget(operation_id, fact_id, now),
        }
    }

    pub fn profile_evidence_record(&self, mem_id: &str) -> Option<&Record> {
        self.document.records.iter().find(|record| {
            record.mem_type == PROFILE_EVIDENCE_RECORD_TYPE && record.mem_id == mem_id
        })
    }

    fn reduce_remember(
        &self,
        operation_id: String,
        book_id: String,
        evidence_text: String,
        mut fact: ExplicitProfileFact,
        now: &str,
    ) -> Result<ReducedMemoryOp, ToolError> {
        validate_operation_fields(&operation_id, Some(&book_id), Some(&evidence_text), now)?;
        validate_explicit_fact(&evidence_text, &mut fact)?;
        let evidence = explicit_evidence(&operation_id);
        let evidence_mem_id = match &evidence {
            EvidenceRef::MemoryRecord { mem_id } => mem_id.clone(),
            _ => unreachable!("explicit evidence always uses MemoryRecord"),
        };
        let profile_fact = build_profile_fact(
            create_fact_input(fact, vec![evidence.clone()]),
            Vec::new(),
            now,
        )?;
        reject_excluded_evidence(&self.document.exclusions, &profile_fact.evidence)?;
        if let Some(existing) = self
            .document
            .profile_facts
            .iter()
            .find(|candidate| candidate.fact_id == profile_fact.fact_id)
        {
            validate_existing_evidence(self, &evidence_mem_id, &book_id, &evidence_text)?;
            return Ok(ReducedMemoryOp {
                candidate: None,
                outcome: MemoryOpOutcome::Remembered {
                    operation_id,
                    fact: existing.clone(),
                    evidence_mem_id,
                },
                refresh_profile_files: false,
            });
        }

        let mut candidate = self.projection_mutation_candidate()?;
        insert_evidence_record(
            &mut candidate.records,
            &operation_id,
            &book_id,
            &evidence_text,
            now,
        )?;
        let affected_keys = vec![profile_fact.payload.semantic_key()];
        candidate.profile_facts.push(profile_fact.clone());
        reconcile_global_promotions(&mut candidate, &affected_keys, now)?;
        Ok(ReducedMemoryOp {
            candidate: Some(candidate),
            outcome: MemoryOpOutcome::Remembered {
                operation_id,
                fact: profile_fact,
                evidence_mem_id,
            },
            refresh_profile_files: true,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn reduce_correction(
        &self,
        operation_id: String,
        book_id: String,
        evidence_text: String,
        fact_id: String,
        mut replacement: ExplicitProfileFact,
        now: &str,
    ) -> Result<ReducedMemoryOp, ToolError> {
        validate_operation_fields(&operation_id, Some(&book_id), Some(&evidence_text), now)?;
        validate_explicit_fact(&evidence_text, &mut replacement)?;
        let current = self
            .document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == fact_id)
            .cloned()
            .ok_or_else(|| fact_not_found(&fact_id))?;
        let evidence = explicit_evidence(&operation_id);
        let evidence_mem_id = match &evidence {
            EvidenceRef::MemoryRecord { mem_id } => mem_id.clone(),
            _ => unreachable!("explicit evidence always uses MemoryRecord"),
        };
        let corrected = build_profile_fact(
            create_fact_input(replacement, vec![evidence]),
            vec![fact_id.clone()],
            now,
        )?;
        reject_excluded_evidence(&self.document.exclusions, &corrected.evidence)?;
        if let Some(existing) = self
            .document
            .profile_facts
            .iter()
            .find(|fact| fact.fact_id == corrected.fact_id)
        {
            validate_existing_evidence(self, &evidence_mem_id, &book_id, &evidence_text)?;
            return Ok(ReducedMemoryOp {
                candidate: None,
                outcome: MemoryOpOutcome::Corrected {
                    operation_id,
                    fact: existing.clone(),
                    evidence_mem_id,
                },
                refresh_profile_files: false,
            });
        }
        if matches!(current.status, FactStatus::Superseded | FactStatus::Expired) {
            return Err(state_conflict(format!(
                "cannot correct {:?} profile fact: {fact_id}",
                current.status
            )));
        }

        let mut candidate = self.projection_mutation_candidate()?;
        insert_evidence_record(
            &mut candidate.records,
            &operation_id,
            &book_id,
            &evidence_text,
            now,
        )?;
        let old = candidate
            .profile_facts
            .iter_mut()
            .find(|fact| fact.fact_id == fact_id)
            .expect("candidate cloned from current document");
        old.status = FactStatus::Superseded;
        old.updated_at = now.into();
        candidate.profile_facts.push(corrected.clone());
        reconcile_global_promotions(
            &mut candidate,
            &[
                current.payload.semantic_key(),
                corrected.payload.semantic_key(),
            ],
            now,
        )?;
        Ok(ReducedMemoryOp {
            candidate: Some(candidate),
            outcome: MemoryOpOutcome::Corrected {
                operation_id,
                fact: corrected,
                evidence_mem_id,
            },
            refresh_profile_files: true,
        })
    }

    fn reduce_forget(
        &self,
        operation_id: String,
        fact_id: String,
        now: &str,
    ) -> Result<ReducedMemoryOp, ToolError> {
        validate_operation_fields(&operation_id, None, None, now)?;
        if !self
            .document
            .profile_facts
            .iter()
            .any(|fact| fact.fact_id == fact_id)
        {
            return Err(fact_not_found(&fact_id));
        }

        let forgotten_ids = correction_component(&self.document.profile_facts, &fact_id);
        let mut excluded_evidence_ids = Vec::new();
        let mut evidence_mem_ids = BTreeSet::new();
        for fact in self
            .document
            .profile_facts
            .iter()
            .filter(|fact| forgotten_ids.contains(fact.fact_id.as_str()))
        {
            for evidence in &fact.evidence {
                excluded_evidence_ids.push(evidence.evidence_id());
                if let EvidenceRef::MemoryRecord { mem_id } = evidence {
                    evidence_mem_ids.insert(mem_id.clone());
                }
            }
        }
        excluded_evidence_ids.sort();
        excluded_evidence_ids.dedup();
        let excluded_evidence_id_set: BTreeSet<_> =
            excluded_evidence_ids.iter().map(String::as_str).collect();
        let mut affected_keys: Vec<String> = self
            .document
            .profile_facts
            .iter()
            .filter(|fact| {
                forgotten_ids.contains(fact.fact_id.as_str())
                    || fact.evidence.iter().any(|evidence| {
                        excluded_evidence_id_set.contains(evidence.evidence_id().as_str())
                    })
            })
            .map(|fact| fact.payload.semantic_key())
            .collect();
        affected_keys.sort();
        affected_keys.dedup();

        let mut candidate = self.projection_mutation_candidate()?;
        candidate
            .profile_facts
            .retain(|fact| !forgotten_ids.contains(fact.fact_id.as_str()));
        candidate.records.retain(|record| {
            record.mem_type != PROFILE_EVIDENCE_RECORD_TYPE
                || !evidence_mem_ids.contains(&record.mem_id)
        });
        for evidence_id in &excluded_evidence_ids {
            if !candidate
                .exclusions
                .iter()
                .any(|exclusion| &exclusion.evidence_id == evidence_id)
            {
                candidate.exclusions.push(EvidenceExclusion {
                    evidence_id: evidence_id.clone(),
                    reason: ExclusionReason::Forgotten,
                    created_at: now.into(),
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
            .sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));
        let consolidation = reconcile_global_promotions(&mut candidate, &affected_keys, now)?;
        removed_dependent_fact_ids.extend(consolidation.removed_fact_ids);
        removed_dependent_fact_ids.sort();
        removed_dependent_fact_ids.dedup();
        Ok(ReducedMemoryOp {
            candidate: Some(candidate),
            outcome: MemoryOpOutcome::Forgotten {
                operation_id,
                forgotten_fact_ids: forgotten_ids.into_iter().collect(),
                excluded_evidence_ids,
                removed_dependent_fact_ids,
            },
            refresh_profile_files: true,
        })
    }
}

fn validate_operation_fields(
    operation_id: &str,
    book_id: Option<&str>,
    evidence_text: Option<&str>,
    now: &str,
) -> Result<(), ToolError> {
    if operation_id.trim().is_empty() {
        return Err(invalid_operation("operation_id must not be empty"));
    }
    if book_id.is_some_and(|value| value.trim().is_empty()) {
        return Err(invalid_operation("book_id must not be empty"));
    }
    if evidence_text.is_some_and(|value| value.trim().is_empty()) {
        return Err(invalid_operation("evidence_text must not be empty"));
    }
    if now.trim().is_empty() {
        return Err(invalid_operation(
            "memory operation timestamp must not be empty",
        ));
    }
    Ok(())
}

fn validate_explicit_fact(
    evidence_text: &str,
    fact: &mut ExplicitProfileFact,
) -> Result<(), ToolError> {
    if matches!(&fact.payload, ProfilePayload::Extension { .. }) {
        return Err(invalid_operation(
            "profile extension requires a registered M3 schema validator",
        ));
    }
    match classify_profile_fact_privacy(evidence_text, &fact.payload) {
        ProfilePrivacyClass::Secret => {
            return Err(ToolError {
                error_code: "SECRET_PROFILE_REJECTED".into(),
                category: "validation".into(),
                message: "credentials and other secrets are never stored in profile memory".into(),
            });
        }
        ProfilePrivacyClass::Sensitive => fact.sensitivity = Sensitivity::Sensitive,
        ProfilePrivacyClass::Normal => {}
    }
    if fact.sensitivity == Sensitivity::Sensitive && !fact.sensitive_plaintext_acknowledged {
        return Err(ToolError {
            error_code: "SENSITIVE_CONFIRMATION_REQUIRED".into(),
            category: "conflict".into(),
            message: "sensitive profile fact requires explicit local-plaintext acknowledgement"
                .into(),
        });
    }
    Ok(())
}

fn create_fact_input(fact: ExplicitProfileFact, evidence: Vec<EvidenceRef>) -> CreateProfileFact {
    CreateProfileFact {
        scope: fact.scope,
        applicability: fact.applicability,
        payload: fact.payload,
        source: FactSource::UserStated,
        evidence,
        confidence: Option::<Confidence>::None,
        sensitivity: fact.sensitivity,
        valid_until: fact.valid_until,
    }
}

fn explicit_evidence(operation_id: &str) -> EvidenceRef {
    EvidenceRef::MemoryRecord {
        mem_id: format!("mem_profile_{:016x}", fnv1a(operation_id)),
    }
}

fn insert_evidence_record(
    records: &mut Vec<Record>,
    operation_id: &str,
    book_id: &str,
    evidence_text: &str,
    now: &str,
) -> Result<(), ToolError> {
    let EvidenceRef::MemoryRecord { mem_id } = explicit_evidence(operation_id) else {
        unreachable!("explicit evidence always uses MemoryRecord");
    };
    if let Some(existing) = records.iter().find(|record| record.mem_id == mem_id) {
        if existing.mem_type == PROFILE_EVIDENCE_RECORD_TYPE
            && existing.book_id == book_id
            && existing.content == evidence_text
        {
            return Ok(());
        }
        return Err(state_conflict(format!(
            "memory operation_id already belongs to different evidence: {operation_id}"
        )));
    }
    records.push(Record {
        mem_id,
        mem_type: PROFILE_EVIDENCE_RECORD_TYPE.into(),
        layer: "long_term".into(),
        book_id: book_id.into(),
        anchor: Default::default(),
        content: evidence_text.into(),
        range: None,
        selection_context: None,
        citations: Vec::new(),
        usage: Usage {
            count: 1,
            last_used: Some(now.into()),
        },
        generated_at: now.into(),
        source_session_id: None,
    });
    Ok(())
}

fn validate_existing_evidence(
    store: &MemoryStore,
    mem_id: &str,
    book_id: &str,
    evidence_text: &str,
) -> Result<(), ToolError> {
    match store.profile_evidence_record(mem_id) {
        Some(record) if record.book_id == book_id && record.content == evidence_text => Ok(()),
        Some(_) => Err(state_conflict(format!(
            "memory operation evidence changed for {mem_id}"
        ))),
        None => Err(state_conflict(format!(
            "memory operation fact exists without evidence record: {mem_id}"
        ))),
    }
}

fn correction_component(facts: &[ProfileFact], start: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::from([start.to_string()]);
    loop {
        let before = ids.len();
        for fact in facts {
            if ids.contains(fact.fact_id.as_str()) {
                ids.extend(fact.supersedes.iter().cloned());
            }
            if fact
                .supersedes
                .iter()
                .any(|superseded| ids.contains(superseded.as_str()))
            {
                ids.insert(fact.fact_id.clone());
            }
        }
        if ids.len() == before {
            return ids;
        }
    }
}

fn invalid_operation(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_MEMORY_OP".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn fact_not_found(fact_id: &str) -> ToolError {
    ToolError {
        error_code: "PROFILE_FACT_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("profile fact does not exist: {fact_id}"),
    }
}

fn state_conflict(message: String) -> ToolError {
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
        Anchor, PreferenceClaim, ProfileResolutionContext, RecallQuery, ReplaceInput, SaveInput,
    };
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-memory-op-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn draft(value: &str) -> ExplicitProfileFact {
        ExplicitProfileFact {
            scope: ProfileScope::Global,
            applicability: Applicability::Any,
            payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                key: "depth".into(),
                value: value.into(),
            }),
            sensitivity: Sensitivity::Normal,
            valid_until: None,
            sensitive_plaintext_acknowledged: false,
        }
    }

    fn remember(operation_id: &str, evidence: &str, value: &str) -> MemoryOp {
        MemoryOp::Remember {
            operation_id: operation_id.into(),
            book_id: "book-a".into(),
            evidence_text: evidence.into(),
            fact: draft(value),
        }
    }

    fn remembered(outcome: MemoryOpOutcome) -> (ProfileFact, String) {
        match outcome {
            MemoryOpOutcome::Remembered {
                fact,
                evidence_mem_id,
                ..
            } => (fact, evidence_mem_id),
            other => panic!("expected remembered outcome, got {other:?}"),
        }
    }

    #[test]
    fn remember_atomically_writes_confirmed_fact_and_hidden_evidence() {
        let (path, mut store) = store("remember");
        let (fact, evidence_mem_id) = remembered(
            store
                .apply_memory_op(
                    remember("op-1", "Remember that I prefer detail", "detailed"),
                    "2026-01-01T00:00:00Z",
                )
                .unwrap(),
        );
        assert_eq!(fact.status, FactStatus::Confirmed);
        assert_eq!(
            (store.document_revision(), store.projection_revision()),
            (1, 1)
        );
        assert!(store.recall(&RecallQuery::default()).is_empty());
        assert!(store
            .recall(&RecallQuery {
                mem_type: Some(PROFILE_EVIDENCE_RECORD_TYPE.into()),
                ..Default::default()
            })
            .is_empty());
        assert_eq!(
            store
                .profile_evidence_record(&evidence_mem_id)
                .unwrap()
                .content,
            "Remember that I prefer detail"
        );
        assert_eq!(
            store.delete(&evidence_mem_id).unwrap_err().error_code,
            "PROFILE_EVIDENCE_PROTECTED"
        );
        assert_eq!(
            store
                .replace(
                    ReplaceInput {
                        mem_id: evidence_mem_id.clone(),
                        content: "tampered".into(),
                        selection_context: None,
                    },
                    "2026-01-02T00:00:00Z",
                )
                .unwrap_err()
                .error_code,
            "PROFILE_EVIDENCE_PROTECTED"
        );
        assert_eq!(
            store
                .save(
                    SaveInput {
                        mem_id: None,
                        mem_type: PROFILE_EVIDENCE_RECORD_TYPE.into(),
                        layer: "long_term".into(),
                        book_id: "book-a".into(),
                        anchor: Anchor::default(),
                        content: "forged".into(),
                        range: None,
                        selection_context: None,
                        citations: None,
                        source_session_id: None,
                    },
                    "2026-01-02T00:00:00Z",
                )
                .unwrap_err()
                .error_code,
            "PROFILE_EVIDENCE_PROTECTED"
        );
        assert_eq!(store.document_revision(), 1);

        let reopened = MemoryStore::open(path).unwrap();
        assert_eq!(reopened.profile_facts(), &[fact]);
        assert!(reopened.recall(&RecallQuery::default()).is_empty());
        assert!(reopened.profile_evidence_record(&evidence_mem_id).is_some());
    }

    #[test]
    fn remember_retry_is_idempotent_and_changed_evidence_conflicts() {
        let (_path, mut store) = store("idempotent");
        let first = store
            .apply_memory_op(
                remember("op-1", "remember detail", "detailed"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let second = store
            .apply_memory_op(
                remember("op-1", "remember detail", "detailed"),
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(store.document_revision(), 1);
        let MemoryOp::Remember {
            operation_id,
            evidence_text,
            fact,
            ..
        } = remember("op-1", "remember detail", "detailed")
        else {
            unreachable!()
        };
        assert_eq!(
            store
                .apply_memory_op(
                    MemoryOp::Remember {
                        operation_id,
                        book_id: "book-b".into(),
                        evidence_text,
                        fact,
                    },
                    "2026-01-02T00:00:00Z",
                )
                .unwrap_err()
                .error_code,
            "PROFILE_FACT_STATE_CONFLICT"
        );
        assert_eq!(
            store
                .apply_memory_op(
                    remember("op-1", "different evidence", "detailed"),
                    "2026-01-03T00:00:00Z",
                )
                .unwrap_err()
                .error_code,
            "PROFILE_FACT_STATE_CONFLICT"
        );
        assert_eq!(store.document_revision(), 1);
    }

    #[test]
    fn failed_memory_op_commit_preserves_in_memory_document() {
        let (_path, mut store) = store("failed-commit");
        let blocker = std::env::temp_dir().join("ub-memory-op-parent-blocker");
        let _ = std::fs::remove_file(&blocker);
        let _ = std::fs::remove_dir_all(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();
        store.path = blocker.join("memory.json");

        let error = store
            .apply_memory_op(
                remember("op-1", "remember detail", "detailed"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap_err();
        assert_eq!(error.category, "internal");
        assert_eq!(
            (store.document_revision(), store.projection_revision()),
            (0, 0)
        );
        assert!(store.profile_facts().is_empty());
        assert!(store.document.records.is_empty());
    }

    #[test]
    fn sensitive_requires_ack_and_extension_is_rejected_without_mutation() {
        let (_path, mut store) = store("validation");
        let mut sensitive = draft("medical detail");
        sensitive.sensitivity = Sensitivity::Sensitive;
        let error = store
            .apply_memory_op(
                MemoryOp::Remember {
                    operation_id: "op-sensitive".into(),
                    book_id: "book-a".into(),
                    evidence_text: "remember my medical detail".into(),
                    fact: sensitive,
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap_err();
        assert_eq!(error.error_code, "SENSITIVE_CONFIRMATION_REQUIRED");

        let extension = ExplicitProfileFact {
            scope: ProfileScope::Global,
            applicability: Applicability::Any,
            payload: ProfilePayload::Extension {
                namespace: "future".into(),
                key: "raw".into(),
                value: serde_json::json!({"value": "x"}),
            },
            sensitivity: Sensitivity::Normal,
            valid_until: None,
            sensitive_plaintext_acknowledged: false,
        };
        let error = store
            .apply_memory_op(
                MemoryOp::Remember {
                    operation_id: "op-extension".into(),
                    book_id: "book-a".into(),
                    evidence_text: "remember extension".into(),
                    fact: extension,
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap_err();
        assert_eq!(error.error_code, "INVALID_MEMORY_OP");
        assert_eq!(store.document_revision(), 0);

        let mut acknowledged = draft("medical detail");
        acknowledged.sensitivity = Sensitivity::Sensitive;
        acknowledged.sensitive_plaintext_acknowledged = true;
        let outcome = store
            .apply_memory_op(
                MemoryOp::Remember {
                    operation_id: "op-sensitive-confirmed".into(),
                    book_id: "book-a".into(),
                    evidence_text: "confirmed local plaintext storage".into(),
                    fact: acknowledged,
                },
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let MemoryOpOutcome::Remembered { fact, .. } = outcome else {
            panic!("expected remembered sensitive fact");
        };
        assert_eq!(fact.sensitivity, Sensitivity::Sensitive);
        assert_eq!(store.document_revision(), 1);
    }

    #[test]
    fn reducer_rejects_secret_and_upgrades_sensitive_content_from_normal() {
        let (path, mut store) = store("privacy-upgrade");
        let secret = store
            .apply_memory_op(
                remember(
                    "op-secret",
                    "remember my API key is sk-abcdefghijklmnop",
                    "preferred account",
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap_err();
        assert_eq!(secret.error_code, "SECRET_PROFILE_REJECTED");
        assert_eq!(store.document_revision(), 0);
        assert!(store.profile_facts().is_empty());
        assert!(!std::fs::read_to_string(&path)
            .unwrap_or_default()
            .contains("sk-abcdefghijklmnop"));

        let sensitive = store
            .apply_memory_op(
                remember(
                    "op-sensitive-upgrade",
                    "remember this preference",
                    "my medical diagnosis needs review",
                ),
                "2026-01-01T00:00:00Z",
            )
            .unwrap_err();
        assert_eq!(sensitive.error_code, "SENSITIVE_CONFIRMATION_REQUIRED");
        assert_eq!(store.document_revision(), 0);
    }

    #[test]
    fn correct_is_atomic_and_resolver_selects_replacement() {
        let (_path, mut store) = store("correct");
        let (original, _) = remembered(
            store
                .apply_memory_op(
                    remember("op-1", "remember concise", "concise"),
                    "2026-01-01T00:00:00Z",
                )
                .unwrap(),
        );
        let corrected = store
            .apply_memory_op(
                MemoryOp::Correct {
                    operation_id: "op-2".into(),
                    book_id: "book-a".into(),
                    evidence_text: "Correction: I prefer detail".into(),
                    fact_id: original.fact_id.clone(),
                    replacement: draft("detailed"),
                },
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let MemoryOpOutcome::Corrected { fact, .. } = corrected else {
            panic!("expected corrected outcome");
        };
        assert_eq!(fact.supersedes, vec![original.fact_id.clone()]);
        assert_eq!(store.document_revision(), 2);
        assert_eq!(
            store
                .profile_facts()
                .iter()
                .find(|fact| fact.fact_id == original.fact_id)
                .unwrap()
                .status,
            FactStatus::Superseded
        );
        let resolved = store.resolve_profile_facts(&ProfileResolutionContext::default());
        assert_eq!(resolved, vec![fact]);
    }

    #[test]
    fn forget_deletes_correction_chain_evidence_and_disk_values() {
        let (path, mut store) = store("forget-chain");
        let (original, _) = remembered(
            store
                .apply_memory_op(
                    remember("op-1", "remember SECRET_OLD", "SECRET_OLD"),
                    "2026-01-01T00:00:00Z",
                )
                .unwrap(),
        );
        let corrected = store
            .apply_memory_op(
                MemoryOp::Correct {
                    operation_id: "op-2".into(),
                    book_id: "book-a".into(),
                    evidence_text: "correct to SECRET_NEW".into(),
                    fact_id: original.fact_id,
                    replacement: draft("SECRET_NEW"),
                },
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let MemoryOpOutcome::Corrected { fact, .. } = corrected else {
            panic!("expected corrected outcome");
        };
        let outcome = store
            .apply_memory_op(
                MemoryOp::Forget {
                    operation_id: "op-3".into(),
                    fact_id: fact.fact_id,
                },
                "2026-01-03T00:00:00Z",
            )
            .unwrap();
        let MemoryOpOutcome::Forgotten {
            forgotten_fact_ids,
            excluded_evidence_ids,
            ..
        } = outcome
        else {
            panic!("expected forgotten outcome");
        };
        assert_eq!(forgotten_fact_ids.len(), 2);
        assert_eq!(excluded_evidence_ids.len(), 2);
        assert!(store.profile_facts().is_empty());
        assert_eq!(store.evidence_exclusions().len(), 2);
        assert_eq!(store.document_revision(), 3);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("SECRET_OLD"));
        assert!(!disk.contains("SECRET_NEW"));

        let reopened = MemoryStore::open(path).unwrap();
        assert!(reopened.profile_facts().is_empty());
        assert!(reopened.recall(&RecallQuery::default()).is_empty());
    }
}
