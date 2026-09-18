//! Immutable candidates and versions beside the host's private AgentHistory.
//! Calls use the authoritative AppState borrow, like history commits (one Reader host).
use crate::{AgentAssistantStatus, AgentChatSession, AppState};
use read_tools::ToolError;
use runtime::{
    orchestrator::{AgentAnswerPart, OuterOutcome},
    presentation::*,
};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

fn error(code: &str, category: &str, message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: code.into(),
        category: category.into(),
        message: message.into(),
    }
}
fn invalid(message: impl Into<String>) -> ToolError {
    error("PRESENTATION_INVALID", "validation", message)
}
fn storage(detail: impl std::fmt::Display) -> ToolError {
    error(
        "PRESENTATION_STORAGE_FAILED",
        "internal",
        detail.to_string(),
    )
}
fn check_id(id: &str) -> Result<(), ToolError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid("Invalid presentation or candidate id"));
    }
    Ok(())
}
fn new_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{prefix}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

struct PresentationStore {
    root: PathBuf,
}
impl PresentationStore {
    fn for_state(state: &AppState) -> Result<Self, ToolError> {
        let path = state.history_path.as_ref().ok_or_else(|| {
            error(
                "PRESENTATION_STORAGE_UNAVAILABLE",
                "unavailable",
                "Presentation delivery requires private persistent history",
            )
        })?;
        Ok(Self {
            root: path.with_extension("presentations"),
        })
    }
    fn candidate_path(&self, id: &str) -> Result<PathBuf, ToolError> {
        check_id(id)?;
        Ok(self.root.join("candidates").join(format!("{id}.json")))
    }
    fn versions_dir(&self, id: &str) -> Result<PathBuf, ToolError> {
        check_id(id)?;
        Ok(self.root.join("versions").join(id))
    }
    fn version_path(&self, reference: &PresentationRef) -> Result<PathBuf, ToolError> {
        if reference.revision == 0 {
            return Err(invalid("Revision must be positive"));
        }
        Ok(self
            .versions_dir(&reference.presentation_id)?
            .join(format!("{}.json", reference.revision)))
    }
    fn read<T: DeserializeOwned>(path: &Path) -> Result<T, ToolError> {
        let bytes = fs::read(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                error(
                    "PRESENTATION_NOT_FOUND",
                    "not_found",
                    "Presentation candidate or revision not found",
                )
            } else {
                storage(e)
            }
        })?;
        serde_json::from_slice(&bytes).map_err(storage)
    }
    fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), ToolError> {
        let parent = path.parent().expect("presentation path has parent");
        fs::create_dir_all(parent).map_err(storage)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(storage)?;
        serde_json::to_writer(&mut temporary, value).map_err(storage)?;
        temporary.flush().map_err(storage)?;
        temporary.as_file().sync_all().map_err(storage)?;
        temporary.persist_noclobber(path).map_err(storage)?;
        Ok(())
    }
    fn read_version(
        &self,
        owner: &PresentationOwner,
        reference: &PresentationRef,
    ) -> Result<AgentPresentation, ToolError> {
        let version: AgentPresentation = Self::read(&self.version_path(reference)?)?;
        if &version.owner != owner {
            return Err(owner_error());
        }
        if &version.reference != reference {
            return Err(invalid("Stored revision identity does not match reference"));
        }
        Ok(version)
    }
    fn read_candidate(
        &self,
        owner: &PresentationOwner,
        id: &str,
    ) -> Result<PresentationCandidate, ToolError> {
        let candidate: PresentationCandidate = Self::read(&self.candidate_path(id)?)?;
        if &candidate.owner != owner {
            return Err(owner_error());
        }
        if candidate.candidate_id != id {
            return Err(invalid(
                "Stored candidate identity does not match reference",
            ));
        }
        Ok(candidate)
    }
    fn revisions(&self, id: &str) -> Result<Vec<u32>, ToolError> {
        let entries = match fs::read_dir(self.versions_dir(id)?) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(storage(e)),
        };
        let mut revisions = Vec::new();
        for entry in entries {
            let path = entry.map_err(storage)?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let revision = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|r| *r > 0)
                    .ok_or_else(|| invalid("Invalid stored revision filename"))?;
                revisions.push(revision);
            }
        }
        revisions.sort_unstable();
        Ok(revisions)
    }
}

fn owner_error() -> ToolError {
    error(
        "PRESENTATION_OWNER_MISMATCH",
        "not_found",
        "Presentation does not belong to this book and session",
    )
}
fn session<'a>(state: &'a AppState, session_id: &str) -> Result<&'a AgentChatSession, ToolError> {
    state
        .agent_history
        .sessions
        .iter()
        .find(|s| s.id == session_id && s.book_id == state.book.base.book_id)
        .ok_or_else(owner_error)
}
fn owner(state: &AppState, session_id: &str) -> Result<PresentationOwner, ToolError> {
    let session = session(state, session_id)?;
    Ok(PresentationOwner {
        book_id: session.book_id.clone(),
        session_id: session.id.clone(),
    })
}
fn pending_turn(state: &AppState, session_id: &str, turn_id: &str) -> Result<(), ToolError> {
    if !session(state, session_id)?
        .turns
        .iter()
        .any(|t| t.turn_id == turn_id && t.status == AgentAssistantStatus::PendingAssistant)
    {
        return Err(error(
            "PRESENTATION_TURN_NOT_PENDING",
            "conflict",
            "Presentation authoring requires the owning pending Resident turn",
        ));
    }
    Ok(())
}
fn validate_content(
    content: &PresentationContent,
    owner: &PresentationOwner,
) -> Result<(), ToolError> {
    if content.title.trim().is_empty()
        || content.readable_content.trim().is_empty()
        || !content.content_files.contains_key(&content.entrypoint)
    {
        return Err(invalid(
            "Content requires title, readable content and an existing entrypoint",
        ));
    }
    for path in content.content_files.keys() {
        if path.is_empty()
            || path.contains(['\\', ':', '?', '#'])
            || path
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(invalid("Content filenames must be relative logical paths"));
        }
    }
    let mut refs = std::collections::HashSet::new();
    for binding in &content.source_bindings {
        if binding.book_id != owner.book_id
            || binding.source_ref_id.trim().is_empty()
            || binding.evidence_text_digest.trim().is_empty()
            || !refs.insert(&binding.source_ref_id)
        {
            return Err(invalid(
                "Content source bindings must be unique bindings for the owning book",
            ));
        }
    }
    Ok(())
}

impl AppState {
    /// Latest saved scene of this exact version; never search a newer content revision.
    pub(crate) fn latest_presentation_state(&self, session_id: &str, reference: &PresentationRef) -> Result<Option<SavedPresentationState>, ToolError> {
        self.read_presentation(session_id, reference)?;
        let store = PresentationStore::for_state(self)?;
        let directory = store.root.join("states").join(&reference.presentation_id).join(reference.revision.to_string());
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(storage(e)),
        };
        let mut latest = None;
        for entry in entries {
            let path = entry.map_err(storage)?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let revision = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok())
                .ok_or_else(|| invalid("Invalid stored state revision filename"))?;
            if latest.as_ref().is_none_or(|(old, _)| revision > *old) { latest = Some((revision, path)); }
        }
        latest.map(|(_, path)| {
            let saved: SavedPresentationState = PresentationStore::read(&path)?;
            if saved.receipt.session_id != session_id || saved.receipt.reference != *reference { return Err(owner_error()); }
            self.read_presentation_state(&saved.receipt)
        }).transpose()
    }

    pub(crate) fn save_presentation_state(
        &self, session_id: &str, turn_id: &str, reference: &PresentationRef,
        state: PresentationState,
    ) -> Result<PresentationFollowUp, ToolError> {
        let version = crate::presentation_api::delivered_version(self, session_id, turn_id, reference)?;
        let store = PresentationStore::for_state(self)?;
        let directory = store.root.join("states").join(&reference.presentation_id).join(reference.revision.to_string());
        let mut revision = 0;
        if directory.exists() {
            for entry in fs::read_dir(&directory).map_err(storage)? {
                let path = entry.map_err(storage)?.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    let number = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok())
                        .ok_or_else(|| invalid("Invalid stored state revision filename"))?;
                    revision = revision.max(number);
                }
            }
        }
        let receipt = PresentationFollowUp {
            session_id: session_id.into(), turn_id: turn_id.into(), reference: reference.clone(),
            state_revision: revision.checked_add(1).ok_or_else(|| invalid("State revision overflow"))?,
            saved_state_ref: new_id("state"),
        };
        let saved = SavedPresentationState { receipt: receipt.clone(), owner: version.owner, state };
        PresentationStore::write(&directory.join(format!("{}.json", receipt.state_revision)), &saved)?;
        Ok(receipt)
    }

    pub(crate) fn read_presentation_state(&self, receipt: &PresentationFollowUp) -> Result<SavedPresentationState, ToolError> {
        let version = crate::presentation_api::delivered_version(self, &receipt.session_id, &receipt.turn_id, &receipt.reference)?;
        check_id(&receipt.saved_state_ref)?;
        let store = PresentationStore::for_state(self)?;
        let path = store.root.join("states").join(&receipt.reference.presentation_id)
            .join(receipt.reference.revision.to_string()).join(format!("{}.json", receipt.state_revision));
        let saved: SavedPresentationState = PresentationStore::read(&path)?;
        if saved.receipt != *receipt || saved.owner != version.owner { return Err(invalid("State receipt does not match this version and turn")); }
        Ok(saved)
    }

    /// Called under the existing Reader state borrow; no public book directory is used.
    pub fn create_presentation_candidate(
        &mut self,
        session_id: &str,
        turn_id: &str,
        based_on: Option<PresentationRef>,
        content: PresentationContent,
    ) -> Result<PresentationCandidate, ToolError> {
        let owner = owner(self, session_id)?;
        pending_turn(self, session_id, turn_id)?;
        validate_content(&content, &owner)?;
        let store = PresentationStore::for_state(self)?;
        let presentation_id = match &based_on {
            Some(reference) => {
                store
                    .read_version(&owner, reference)?
                    .reference
                    .presentation_id
            }
            None => new_id("presentation"),
        };
        let candidate = PresentationCandidate {
            candidate_id: new_id("candidate"),
            presentation_id,
            owner,
            created_by_turn_id: turn_id.into(),
            based_on,
            content,
        };
        PresentationStore::write(&store.candidate_path(&candidate.candidate_id)?, &candidate)?;
        Ok(candidate)
    }

    pub fn read_presentation_candidate(
        &self,
        session_id: &str,
        candidate_id: &str,
    ) -> Result<PresentationCandidate, ToolError> {
        PresentationStore::for_state(self)?.read_candidate(&owner(self, session_id)?, candidate_id)
    }

    /// Save a complete immutable version before returning a usable reference.
    /// RP4 calls this after preview/source compilation; it does not submit an answer.
    pub fn persist_presentation_candidate(
        &mut self,
        session_id: &str,
        turn_id: &str,
        candidate_id: &str,
    ) -> Result<PresentationRef, ToolError> {
        let owner = owner(self, session_id)?;
        pending_turn(self, session_id, turn_id)?;
        let store = PresentationStore::for_state(self)?;
        let candidate = store.read_candidate(&owner, candidate_id)?;
        if candidate.created_by_turn_id != turn_id {
            return Err(owner_error());
        }
        validate_content(&candidate.content, &owner)?;
        if let Some(base) = &candidate.based_on {
            store.read_version(&owner, base)?;
        }
        let revisions = store.revisions(&candidate.presentation_id)?;
        // Retrying a save after a lost receipt returns the same version.
        for revision in &revisions {
            let reference = PresentationRef {
                presentation_id: candidate.presentation_id.clone(),
                revision: *revision,
            };
            let version = store.read_version(&owner, &reference)?;
            if version.candidate_id == candidate.candidate_id {
                return Ok(reference);
            }
        }
        let revision = revisions
            .last()
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| invalid("Revision overflow"))?;
        let reference = PresentationRef {
            presentation_id: candidate.presentation_id,
            revision,
        };
        let version = AgentPresentation {
            reference: reference.clone(),
            candidate_id: candidate.candidate_id,
            owner,
            created_by_turn_id: candidate.created_by_turn_id,
            based_on: candidate.based_on,
            content: candidate.content,
        };
        PresentationStore::write(&store.version_path(&reference)?, &version)?;
        Ok(reference)
    }

    /// A session need not be active, but it must belong to the currently opened book.
    pub fn read_presentation(
        &self,
        session_id: &str,
        reference: &PresentationRef,
    ) -> Result<AgentPresentation, ToolError> {
        PresentationStore::for_state(self)?.read_version(&owner(self, session_id)?, reference)
    }
}

pub(crate) fn validate_answer_references(
    state: &AppState,
    session_id: &str,
    outcome: &OuterOutcome,
    messages: &[runtime::Message],
    answer_bindings: &[runtime::orchestrator::SourceBinding],
) -> Result<(), ToolError> {
    let mut bindings = answer_bindings.to_vec();
    if let Some(view) = &outcome.answer_view {
        for part in &view.parts {
            if let AgentAnswerPart::Presentation {
                presentation_id,
                revision,
            } = part
            {
                let version = state.read_presentation(
                    session_id,
                    &PresentationRef {
                        presentation_id: presentation_id.clone(),
                        revision: *revision,
                    },
                )?;
                crate::presentation_api::validate_semantics(&version, messages)?;
                for binding in version.content.source_bindings {
                    if bindings.iter().any(|old| old.source_ref_id == binding.source_ref_id && old != &binding) {
                        return Err(invalid("Source ref identifies different evidence in this answer"));
                    }
                    bindings.push(binding);
                }
            }
        }
    }
    Ok(())
}
