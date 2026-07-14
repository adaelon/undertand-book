use crate::{
    classify_profile_privacy, Applicability, FactSource, FactStatus, MemoryStore, ProfileFact,
    ProfilePayload, ProfilePrivacyClass, ProfileScope, Sensitivity,
};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

const PROFILE_MARKDOWN_MARKER_PREFIX: &str = "<!-- profile-markdown.v2 projection_revision=";
const PROFILE_MARKDOWN_MARKER_SUFFIX: &str = " -->";
const REDACTED_SENSITIVE_VALUE: &str = "[敏感值已脱敏]";
const READER_PROFILE_FILENAME: &str = "reader-profile.md";
const READING_HANDBOOK_FILENAME: &str = "reading-handbook.md";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileMarkdownFileState {
    Current,
    Stale,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileMarkdownProjectionStatus {
    pub source_projection_revision: u64,
    pub reader_profile: ProfileMarkdownFileState,
    pub reading_handbook: ProfileMarkdownFileState,
}

struct PreparedProjectionFile {
    target: PathBuf,
    temporary: PathBuf,
    backup: PathBuf,
    had_original: bool,
}

impl MemoryStore {
    /// 渲染 revision-tagged `reader-profile.md` v2 `[ADR-0040/0075/0076]`。
    pub fn render_reader_profile_md(&self) -> String {
        let active = self.active_markdown_facts();
        let mut output =
            projection_header(self.projection_revision(), "# 读者画像 (reader-profile)");
        output.push_str("\n## 全局画像\n");
        render_fact_list(
            &mut output,
            active
                .iter()
                .copied()
                .filter(|fact| fact.scope == ProfileScope::Global),
        );

        output.push_str("\n## 单本画像\n");
        let book_facts = group_book_facts(active.iter().copied());
        if book_facts.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            for (book_id, facts) in book_facts {
                output.push_str(&format!("### {}\n", markdown_inline(&book_id)));
                render_fact_list(&mut output, facts.into_iter());
            }
        }

        output.push_str("\n## 原始阅读活动\n");
        let book_ids = self.markdown_book_ids();
        if book_ids.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            for book_id in &book_ids {
                self.render_book_activity(&mut output, book_id);
            }
        }

        output.push_str("\n## context 时间线\n");
        if book_ids.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            for book_id in &book_ids {
                output.push_str(&format!("### {}\n", markdown_inline(book_id)));
                let timeline = self.context_timeline(book_id);
                if timeline.is_empty() {
                    output.push_str("(暂无)\n");
                    continue;
                }
                for record in timeline {
                    let citations = if record.citations.is_empty() {
                        String::new()
                    } else {
                        let lids = record
                            .citations
                            .iter()
                            .map(|citation| markdown_inline(&citation.lid))
                            .collect::<Vec<_>>();
                        format!(" [cite: {}]", lids.join(" "))
                    };
                    output.push_str(&format!(
                        "- {} {}{}\n",
                        markdown_inline(&record.generated_at),
                        markdown_record_value(&record.content),
                        citations
                    ));
                }
            }
        }
        output
    }

    /// 渲染 revision-tagged `reading-handbook.md` v2 `[ADR-0040/0075/0076]`。
    pub fn render_handbook_md(&self) -> String {
        let active = self.active_markdown_facts();
        let book_ids = self.markdown_book_ids();
        let mut output = projection_header(self.projection_revision(), "# 阅读手册 (memory)");
        output.push_str("\n## global profile facts\n");
        render_fact_list(
            &mut output,
            active
                .iter()
                .copied()
                .filter(|fact| fact.scope == ProfileScope::Global),
        );

        output.push_str("\n## per-book\n");
        if book_ids.is_empty() {
            output.push_str("(暂无)\n");
        }
        for book_id in &book_ids {
            let state = self.derive_book_reading_state(book_id);
            let totals = state.engagement_by_lid.values().fold(
                (0_u32, 0_u32, 0_u32, 0_u32),
                |(read, qa, note, highlight), signals| {
                    (
                        read.saturating_add(signals.read_count),
                        qa.saturating_add(signals.qa_count),
                        note.saturating_add(signals.note_count),
                        highlight.saturating_add(signals.highlight_count),
                    )
                },
            );
            let active_fact_count = active
                .iter()
                .filter(|fact| {
                    matches!(&fact.scope, ProfileScope::Book { book_id: value } if value == book_id)
                })
                .count();
            output.push_str(&format!(
                "- **{}** — read {} / qa {} / note {} / highlight {} / context {} / active facts {}\n",
                markdown_inline(book_id),
                totals.0,
                totals.1,
                totals.2,
                totals.3,
                self.context_timeline(book_id).len(),
                active_fact_count,
            ));
        }

        output.push_str("\n## per-book profile facts\n");
        let book_facts = group_book_facts(active.iter().copied());
        if book_facts.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            for (book_id, facts) in book_facts {
                output.push_str(&format!("### {}\n", markdown_inline(&book_id)));
                render_fact_list(&mut output, facts.into_iter());
            }
        }

        output.push_str("\n## cross-book raw activity\n");
        let read_books = book_ids
            .iter()
            .filter(|book_id| !self.read_lids(book_id).is_empty())
            .map(|book_id| markdown_inline(book_id))
            .collect::<Vec<_>>();
        if read_books.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            output.push_str(&format!("- 读过的书:{}\n", read_books.join(", ")));
            for book_id in &book_ids {
                let state = self.derive_book_reading_state(book_id);
                output.push_str(&format!(
                    "- {}: raw LID {} / context {} 条\n",
                    markdown_inline(book_id),
                    state.engagement_by_lid.len(),
                    self.context_timeline(book_id).len()
                ));
            }
        }
        output
    }

    /// 成对物化两个单向派生视图;失败不会改变 `MemoryDocument` 真相 `[ADR-0076]`。
    pub fn write_profile_files(&self) -> Result<(), ToolError> {
        self.ensure_storage_available()?;
        let Some(dir) = self.path.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|error| {
            profile_markdown_error(format!("create profile projection directory: {error}"))
        })?;
        write_projection_pair(
            &[
                (
                    dir.join(READER_PROFILE_FILENAME),
                    self.render_reader_profile_md(),
                ),
                (
                    dir.join(READING_HANDBOOK_FILENAME),
                    self.render_handbook_md(),
                ),
            ],
            self.private_storage_enabled(),
        )
    }

    pub fn profile_markdown_projection_status(&self) -> ProfileMarkdownProjectionStatus {
        let revision = self.projection_revision();
        if !self.private_storage_available() {
            return ProfileMarkdownProjectionStatus {
                source_projection_revision: revision,
                reader_profile: ProfileMarkdownFileState::Unreadable,
                reading_handbook: ProfileMarkdownFileState::Unreadable,
            };
        }
        let Some(dir) = self.path.parent() else {
            return ProfileMarkdownProjectionStatus {
                source_projection_revision: revision,
                reader_profile: ProfileMarkdownFileState::Missing,
                reading_handbook: ProfileMarkdownFileState::Missing,
            };
        };
        ProfileMarkdownProjectionStatus {
            source_projection_revision: revision,
            reader_profile: projection_file_state(&dir.join(READER_PROFILE_FILENAME), revision),
            reading_handbook: projection_file_state(&dir.join(READING_HANDBOOK_FILENAME), revision),
        }
    }

    fn active_markdown_facts(&self) -> Vec<&ProfileFact> {
        let mut facts = self
            .document
            .profile_facts
            .iter()
            .filter(|fact| matches!(fact.status, FactStatus::Confirmed | FactStatus::Provisional))
            .collect::<Vec<_>>();
        facts.sort_by(|left, right| {
            scope_sort_key(&left.scope)
                .cmp(&scope_sort_key(&right.scope))
                .then_with(|| {
                    left.payload
                        .semantic_key()
                        .cmp(&right.payload.semantic_key())
                })
                .then_with(|| left.fact_id.cmp(&right.fact_id))
        });
        facts
    }

    fn markdown_book_ids(&self) -> Vec<String> {
        let mut ids = self
            .document
            .records
            .iter()
            .filter(|record| {
                matches!(
                    record.mem_type.as_str(),
                    "read" | "qa" | "note" | "highlight" | "context"
                )
            })
            .map(|record| record.book_id.clone())
            .collect::<BTreeSet<_>>();
        ids.extend(self.document.profile_facts.iter().filter_map(|fact| {
            if let ProfileScope::Book { book_id } = &fact.scope {
                Some(book_id.clone())
            } else {
                None
            }
        }));
        ids.into_iter().collect()
    }

    fn render_book_activity(&self, output: &mut String, book_id: &str) {
        let state = self.derive_book_reading_state(book_id);
        output.push_str(&format!("### {}\n", markdown_inline(book_id)));
        output.push_str(&format!("#### 已读 ({} 叶)\n", state.read_lids.len()));
        if state.read_lids.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            output.push_str(&format!(
                "{}\n",
                state
                    .read_lids
                    .iter()
                    .map(|lid| markdown_inline(lid))
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }
        output.push_str("#### LID 活动计数\n");
        if state.engagement_by_lid.is_empty() {
            output.push_str("(暂无)\n");
        } else {
            for (lid, signals) in &state.engagement_by_lid {
                let last_seen = signals
                    .last_seen_at
                    .as_deref()
                    .map(markdown_inline)
                    .unwrap_or_else(|| "-".into());
                output.push_str(&format!(
                    "- `{}` · read={} · qa={} · note={} · highlight={} · last_seen={}\n",
                    markdown_inline(lid),
                    signals.read_count,
                    signals.qa_count,
                    signals.note_count,
                    signals.highlight_count,
                    last_seen
                ));
            }
        }
        output.push_str("#### QA 原始记录\n");
        let qa_lids = state
            .engagement_by_lid
            .iter()
            .filter(|(_, signals)| signals.qa_count > 0)
            .collect::<Vec<_>>();
        if qa_lids.is_empty() {
            output.push_str("(暂空)\n");
        } else {
            for (lid, signals) in qa_lids {
                output.push_str(&format!(
                    "- {} (×{})\n",
                    markdown_inline(lid),
                    signals.qa_count
                ));
                for question in self.qa_questions(book_id, lid) {
                    output.push_str(&format!("  - {}\n", markdown_record_value(question)));
                }
            }
        }
    }
}

fn projection_header(projection_revision: u64, title: &str) -> String {
    format!(
        "{PROFILE_MARKDOWN_MARKER_PREFIX}{projection_revision}{PROFILE_MARKDOWN_MARKER_SUFFIX}\n\
         {title}\n\n\
         > 自动派生只读视图 · 真相源 = memory.json · 不接受 Markdown 反向写入 `[ADR-0040/0075]`\n\n\
         - format: profile-markdown.v2\n\
         - projection_revision: {projection_revision}\n"
    )
}

fn render_fact_list<'a>(output: &mut String, facts: impl Iterator<Item = &'a ProfileFact>) {
    let facts = facts.collect::<Vec<_>>();
    if facts.is_empty() {
        output.push_str("(暂无)\n");
        return;
    }
    for fact in facts {
        let (semantic_key, value) = if fact.sensitivity == Sensitivity::Sensitive {
            ("[敏感字段已脱敏]".into(), REDACTED_SENSITIVE_VALUE.into())
        } else {
            (
                markdown_inline(&fact.payload.semantic_key()),
                markdown_inline(&profile_payload_value(&fact.payload)),
            )
        };
        output.push_str(&format!(
            "- `{}` · status={} · source={} · applicability={}\n  - {}: {}\n",
            markdown_inline(&fact.fact_id),
            fact_status_label(fact.status),
            fact_source_label(fact.source),
            applicability_label(&fact.applicability),
            semantic_key,
            value
        ));
    }
}

fn group_book_facts<'a>(
    facts: impl Iterator<Item = &'a ProfileFact>,
) -> BTreeMap<String, Vec<&'a ProfileFact>> {
    let mut grouped: BTreeMap<String, Vec<&ProfileFact>> = BTreeMap::new();
    for fact in facts {
        if let ProfileScope::Book { book_id } = &fact.scope {
            grouped.entry(book_id.clone()).or_default().push(fact);
        }
    }
    grouped
}

fn scope_sort_key(scope: &ProfileScope) -> (u8, &str) {
    match scope {
        ProfileScope::Global => (0, ""),
        ProfileScope::Book { book_id } => (1, book_id),
    }
}

fn profile_payload_value(payload: &ProfilePayload) -> String {
    match payload {
        ProfilePayload::Background(claim) => claim.value.clone(),
        ProfilePayload::Capability(claim) => claim.value.clone(),
        ProfilePayload::Goal(claim) => claim.value.clone(),
        ProfilePayload::ExplanationPreference(claim) => claim.value.clone(),
        ProfilePayload::Constraint(claim) => claim.value.clone(),
        ProfilePayload::Extension { value, .. } => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".into())
        }
    }
}

fn fact_status_label(status: FactStatus) -> &'static str {
    match status {
        FactStatus::Confirmed => "confirmed",
        FactStatus::Provisional => "provisional",
        FactStatus::Pending => "pending",
        FactStatus::Superseded => "superseded",
        FactStatus::Expired => "expired",
    }
}

fn fact_source_label(source: FactSource) -> &'static str {
    match source {
        FactSource::DeterministicBehavior => "deterministic_behavior",
        FactSource::UserStated => "user_stated",
        FactSource::AgentInferred => "agent_inferred",
    }
}

fn applicability_label(applicability: &Applicability) -> String {
    match applicability {
        Applicability::Any => "any".into(),
        Applicability::ContentProfile { profile_id } => {
            format!("content_profile:{}", markdown_inline(profile_id))
        }
        Applicability::PaperSubtype { subtype } => {
            format!("paper_subtype:{}", markdown_inline(subtype))
        }
        Applicability::Domain { domain } => format!("domain:{}", markdown_inline(domain)),
    }
}

fn markdown_inline(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('`', "&#96;")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn markdown_record_value(value: &str) -> String {
    match classify_profile_privacy(value) {
        ProfilePrivacyClass::Normal => markdown_inline(value),
        ProfilePrivacyClass::Sensitive | ProfilePrivacyClass::Secret => {
            REDACTED_SENSITIVE_VALUE.into()
        }
    }
}

fn projection_file_state(path: &Path, projection_revision: u64) -> ProfileMarkdownFileState {
    match std::fs::read_to_string(path) {
        Ok(contents) if projection_marker_revision(&contents) == Some(projection_revision) => {
            ProfileMarkdownFileState::Current
        }
        Ok(_) => ProfileMarkdownFileState::Stale,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ProfileMarkdownFileState::Missing
        }
        Err(_) => ProfileMarkdownFileState::Unreadable,
    }
}

fn projection_marker_revision(contents: &str) -> Option<u64> {
    contents
        .lines()
        .next()?
        .strip_prefix(PROFILE_MARKDOWN_MARKER_PREFIX)?
        .strip_suffix(PROFILE_MARKDOWN_MARKER_SUFFIX)?
        .parse()
        .ok()
}

fn projection_temporary_path(path: &Path) -> PathBuf {
    projection_sibling_path(path, "projection.tmp")
}

fn projection_backup_path(path: &Path) -> PathBuf {
    projection_sibling_path(path, "projection.bak")
}

fn projection_sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("profile-markdown");
    path.with_file_name(format!(".{filename}.{suffix}"))
}

fn write_projection_pair(files: &[(PathBuf, String)], private: bool) -> Result<(), ToolError> {
    for (target, _) in files {
        recover_projection_target(target)?;
        ensure_regular_or_missing(target)?;
    }

    let mut prepared = Vec::with_capacity(files.len());
    for (target, contents) in files {
        match prepare_projection_file(target, contents, private) {
            Ok(file) => prepared.push(file),
            Err(error) => {
                cleanup_prepared_files(&prepared);
                return Err(error);
            }
        }
    }

    let mut installed = 0_usize;
    while installed < prepared.len() {
        let file = &prepared[installed];
        if file.had_original {
            if let Err(error) = std::fs::rename(&file.target, &file.backup) {
                rollback_projection_files(&prepared[..installed]);
                cleanup_prepared_files(&prepared[installed..]);
                return Err(profile_markdown_error(format!(
                    "backup {}: {error}",
                    file.target.display()
                )));
            }
        }
        if let Err(error) = std::fs::rename(&file.temporary, &file.target) {
            if file.had_original {
                let _ = std::fs::rename(&file.backup, &file.target);
            }
            rollback_projection_files(&prepared[..installed]);
            cleanup_prepared_files(&prepared[installed..]);
            return Err(profile_markdown_error(format!(
                "install {}: {error}",
                file.target.display()
            )));
        }
        installed += 1;
    }

    for file in &prepared {
        if file.had_original {
            let _ = std::fs::remove_file(&file.backup);
        }
    }
    Ok(())
}

fn recover_projection_target(target: &Path) -> Result<(), ToolError> {
    let backup = projection_backup_path(target);
    if !backup.exists() {
        return Ok(());
    }
    ensure_regular_or_missing(&backup)?;
    if target.exists() {
        std::fs::remove_file(&backup).map_err(|error| {
            profile_markdown_error(format!("remove stale {}: {error}", backup.display()))
        })?;
    } else {
        std::fs::rename(&backup, target).map_err(|error| {
            profile_markdown_error(format!("recover {}: {error}", target.display()))
        })?;
    }
    Ok(())
}

fn ensure_regular_or_missing(path: &Path) -> Result<(), ToolError> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(profile_markdown_error(format!(
            "profile projection path is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(profile_markdown_error(format!(
            "inspect {}: {error}",
            path.display()
        ))),
    }
}

fn prepare_projection_file(
    target: &Path,
    contents: &str,
    private: bool,
) -> Result<PreparedProjectionFile, ToolError> {
    let temporary = projection_temporary_path(target);
    let backup = projection_backup_path(target);
    remove_regular_if_present(&temporary)?;
    remove_regular_if_present(&backup)?;
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(profile_markdown_error(format!(
            "stage {}: {error}",
            target.display()
        )));
    }
    if private {
        if let Err(error) = crate::private_storage::secure_private_file(&temporary) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
    }
    Ok(PreparedProjectionFile {
        target: target.to_path_buf(),
        temporary,
        backup,
        had_original: target.is_file(),
    })
}

fn remove_regular_if_present(path: &Path) -> Result<(), ToolError> {
    if !path.exists() {
        return Ok(());
    }
    ensure_regular_or_missing(path)?;
    std::fs::remove_file(path).map_err(|error| {
        profile_markdown_error(format!("remove stale {}: {error}", path.display()))
    })
}

fn cleanup_prepared_files(files: &[PreparedProjectionFile]) {
    for file in files {
        let _ = std::fs::remove_file(&file.temporary);
    }
}

fn rollback_projection_files(files: &[PreparedProjectionFile]) {
    for file in files.iter().rev() {
        let _ = std::fs::remove_file(&file.target);
        if file.had_original {
            let _ = std::fs::rename(&file.backup, &file.target);
        }
    }
}

fn profile_markdown_error(message: String) -> ToolError {
    ToolError {
        error_code: "PROFILE_MARKDOWN_WRITE_FAILED".into(),
        category: "internal".into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Anchor, Applicability, CollectionRuleMatcher, Confidence, CreateProfileFact, EvidenceRef,
        ExplicitProfileFact, FactSource, MemoryOp, MemoryOpOutcome, PreferenceClaim,
        ProfileGovernanceAction, ProfileGovernanceMutation, ProfileMarkdownFileState,
        ProfilePayload, ProfilePayloadKind, ProfileScope, SaveInput, Sensitivity,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    fn test_store(name: &str) -> (std::path::PathBuf, MemoryStore) {
        let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ub-profile-markdown-{name}-{}-{sequence}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = MemoryStore::open(dir.join("memory.json")).unwrap();
        (dir, store)
    }

    fn activity_input(mem_type: &str, content: &str) -> SaveInput {
        SaveInput {
            mem_id: None,
            mem_type: mem_type.into(),
            layer: "long_term".into(),
            book_id: "book-a".into(),
            anchor: Anchor {
                lid: Some("1.1".into()),
                concept: None,
            },
            content: content.into(),
            range: None,
            selection_context: None,
            citations: None,
            source_session_id: None,
        }
    }

    fn remember(
        store: &mut MemoryStore,
        operation_id: &str,
        scope: ProfileScope,
        key: &str,
        value: &str,
        sensitivity: Sensitivity,
    ) -> String {
        let evidence_text = if sensitivity == Sensitivity::Sensitive {
            format!("Remember my medical profile: {value}")
        } else {
            format!("Remember this preference: {value}")
        };
        let outcome = store
            .apply_memory_op(
                MemoryOp::Remember {
                    operation_id: operation_id.into(),
                    book_id: "book-a".into(),
                    evidence_text,
                    fact: ExplicitProfileFact {
                        scope,
                        applicability: Applicability::Any,
                        payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                            key: key.into(),
                            value: value.into(),
                        }),
                        sensitivity,
                        valid_until: None,
                        sensitive_plaintext_acknowledged: sensitivity == Sensitivity::Sensitive,
                    },
                },
                "2026-07-14T00:00:00Z",
            )
            .unwrap();
        match outcome {
            MemoryOpOutcome::Remembered { fact, .. } => fact.fact_id,
            _ => panic!("remember helper returned a non-remember outcome"),
        }
    }

    #[test]
    fn v2_render_is_revision_stable_partitioned_and_sensitive_safe() {
        let (dir, mut store) = test_store("render");
        store.mark_read("book-a", "1.1", "t0").unwrap();
        store
            .save(activity_input("qa", "what is ownership?"), "t1")
            .unwrap();
        store
            .save(activity_input("note", "ownership note"), "t2")
            .unwrap();
        store
            .save(
                activity_input("context", "medical diagnosis raw-record-sensitive-needle"),
                "t3",
            )
            .unwrap();
        let global_id = remember(
            &mut store,
            "op-global",
            ProfileScope::Global,
            "depth",
            "normal-visible-value",
            Sensitivity::Normal,
        );
        let sensitive_id = remember(
            &mut store,
            "op-sensitive",
            ProfileScope::Book {
                book_id: "book-a".into(),
            },
            "diagnosis-sensitive-key",
            "sensitive-value-never-materialized",
            Sensitivity::Sensitive,
        );
        let pending = store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "pending".into(),
                        value: "pending-value-never-active".into(),
                    }),
                    source: FactSource::AgentInferred,
                    evidence: vec![EvidenceRef::BookLocation {
                        book_id: "book-a".into(),
                        lid: "1.1".into(),
                    }],
                    confidence: Some(Confidence::Low),
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-07-14T00:01:00Z",
            )
            .unwrap();
        let provisional = store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Book {
                        book_id: "book-a".into(),
                    },
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "provisional".into(),
                        value: "provisional-active-value".into(),
                    }),
                    source: FactSource::AgentInferred,
                    evidence: vec![EvidenceRef::BookLocation {
                        book_id: "book-a".into(),
                        lid: "1.1".into(),
                    }],
                    confidence: Some(Confidence::Low),
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-07-14T00:02:00Z",
            )
            .unwrap();
        let lifecycle_status = store.profile_markdown_projection_status();
        assert_eq!(
            lifecycle_status.reader_profile,
            ProfileMarkdownFileState::Current
        );
        assert_eq!(
            lifecycle_status.reading_handbook,
            ProfileMarkdownFileState::Current
        );

        let reader = store.render_reader_profile_md();
        let handbook = store.render_handbook_md();
        assert_eq!(reader, store.render_reader_profile_md());
        assert_eq!(handbook, store.render_handbook_md());
        assert!(reader.starts_with("<!-- profile-markdown.v2 projection_revision="));
        assert!(handbook.starts_with("<!-- profile-markdown.v2 projection_revision="));
        assert!(reader.contains("## 全局画像") && reader.contains("## 单本画像"));
        assert!(reader.contains(&global_id) && reader.contains(&sensitive_id));
        assert!(reader.contains("status=confirmed"));
        assert!(reader.contains("normal-visible-value"));
        assert!(reader.contains("[敏感值已脱敏]"));
        assert!(!reader.contains("sensitive-value-never-materialized"));
        assert!(!handbook.contains("sensitive-value-never-materialized"));
        assert!(!reader.contains("diagnosis-sensitive-key"));
        assert!(!handbook.contains("diagnosis-sensitive-key"));
        assert!(!reader.contains("raw-record-sensitive-needle"));
        assert!(!handbook.contains("raw-record-sensitive-needle"));
        assert!(!reader.contains(&pending.fact_id));
        assert!(!reader.contains("pending-value-never-active"));
        assert!(reader.contains(&provisional.fact_id));
        assert!(reader.contains("status=provisional"));
        assert!(reader.contains("provisional-active-value"));
        assert!(reader.contains("## 原始阅读活动"));
        assert!(reader.contains("read=1 · qa=1 · note=1 · highlight=0"));

        store.write_profile_files().unwrap();
        let status = store.profile_markdown_projection_status();
        assert_eq!(
            status.source_projection_revision,
            store.projection_revision()
        );
        assert_eq!(status.reader_profile, ProfileMarkdownFileState::Current);
        assert_eq!(status.reading_handbook, ProfileMarkdownFileState::Current);
        assert_eq!(
            std::fs::read_to_string(dir.join("reader-profile.md")).unwrap(),
            reader
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("reading-handbook.md")).unwrap(),
            handbook
        );

        let projection_revision = store.projection_revision();
        store
            .apply_profile_governance_mutation(
                ProfileGovernanceMutation {
                    expected_document_revision: store.document_revision(),
                    action: ProfileGovernanceAction::AddCollectionRule {
                        operation_id: "op-document-only".into(),
                        matcher: CollectionRuleMatcher {
                            payload_kind: ProfilePayloadKind::Goal,
                            semantic_key: Some("goal:future".into()),
                            scope: None,
                            applicability: None,
                        },
                    },
                },
                "2026-07-14T00:03:00Z",
            )
            .unwrap();
        assert_eq!(store.projection_revision(), projection_revision);
        assert_eq!(store.render_reader_profile_md(), reader);
        assert_eq!(store.render_handbook_md(), handbook);
        assert_eq!(
            std::fs::read_to_string(dir.join("reader-profile.md")).unwrap(),
            reader
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("reading-handbook.md")).unwrap(),
            handbook
        );
        let document_only_status = store.profile_markdown_projection_status();
        assert_eq!(
            document_only_status.reader_profile,
            ProfileMarkdownFileState::Current
        );
        assert_eq!(
            document_only_status.reading_handbook,
            ProfileMarkdownFileState::Current
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn forget_removes_values_from_both_materialized_views() {
        let (dir, mut store) = test_store("forget");
        let fact_id = remember(
            &mut store,
            "op-forget-source",
            ProfileScope::Book {
                book_id: "book-a".into(),
            },
            "format",
            "forgotten-profile-value-needle",
            Sensitivity::Normal,
        );
        assert!(std::fs::read_to_string(dir.join("reader-profile.md"))
            .unwrap()
            .contains("forgotten-profile-value-needle"));
        assert!(std::fs::read_to_string(dir.join("reading-handbook.md"))
            .unwrap()
            .contains("forgotten-profile-value-needle"));

        store
            .apply_memory_op(
                MemoryOp::Forget {
                    operation_id: "op-forget".into(),
                    fact_id: fact_id.clone(),
                },
                "2026-07-14T00:02:00Z",
            )
            .unwrap();

        for filename in ["reader-profile.md", "reading-handbook.md"] {
            let materialized = std::fs::read_to_string(dir.join(filename)).unwrap();
            assert!(!materialized.contains("forgotten-profile-value-needle"));
            assert!(!materialized.contains(&fact_id));
        }
        let status = store.profile_markdown_projection_status();
        assert_eq!(status.reader_profile, ProfileMarkdownFileState::Current);
        assert_eq!(status.reading_handbook, ProfileMarkdownFileState::Current);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn materialization_failure_preserves_truth_and_reports_stale_unreadable() {
        let (dir, mut store) = test_store("failure");
        let missing = store.profile_markdown_projection_status();
        assert_eq!(missing.reader_profile, ProfileMarkdownFileState::Missing);
        assert_eq!(missing.reading_handbook, ProfileMarkdownFileState::Missing);

        store.mark_read("book-a", "1.1", "t0").unwrap();
        let reader_path = dir.join("reader-profile.md");
        let handbook_path = dir.join("reading-handbook.md");
        let reader_before = std::fs::read_to_string(&reader_path).unwrap();
        std::fs::remove_file(&handbook_path).unwrap();
        std::fs::create_dir(&handbook_path).unwrap();

        let fact_id = remember(
            &mut store,
            "op-write-failure",
            ProfileScope::Global,
            "failure",
            "truth-survives-markdown-failure",
            Sensitivity::Normal,
        );
        assert!(store
            .profile_facts()
            .iter()
            .any(|fact| fact.fact_id == fact_id));
        assert_eq!(
            std::fs::read_to_string(&reader_path).unwrap(),
            reader_before
        );
        let error = store.write_profile_files().unwrap_err();
        assert_eq!(error.error_code, "PROFILE_MARKDOWN_WRITE_FAILED");

        let status = store.profile_markdown_projection_status();
        assert_eq!(status.reader_profile, ProfileMarkdownFileState::Stale);
        assert_eq!(
            status.reading_handbook,
            ProfileMarkdownFileState::Unreadable
        );
        assert_eq!(
            MemoryStore::open(dir.join("memory.json"))
                .unwrap()
                .document_revision(),
            2
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
