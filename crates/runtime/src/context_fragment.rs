use crate::{Message, Role};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTEXT_FRAGMENT_VERSION: &str = "context_fragment.v1";
pub const READER_PROFILE_FRAGMENT_KEY: &str = "reader.profile_snapshot";
pub const MEMORY_OPERATION_FRAGMENT_KEY: &str = "memory.operation_result";
pub const PAPER_MINIMAP_FRAGMENT_KEY: &str = "reader.paper_minimap_agent_context";
pub const ARTIFACT_ROUTING_FRAGMENT_KEY: &str = "reader.artifact_routing_cards";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FragmentScope {
    SessionStable,
    TurnFrozen,
    Dynamic,
}

impl FragmentScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::SessionStable => "session_stable",
            Self::TurnFrozen => "turn_frozen",
            Self::Dynamic => "dynamic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FragmentSensitivity {
    Public,
    Private,
    Sensitive,
}

impl FragmentSensitivity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
            Self::Sensitive => "sensitive",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextFragment {
    pub key: String,
    pub revision: String,
    pub scope: FragmentScope,
    pub role: Role,
    pub content: String,
    pub sensitivity: FragmentSensitivity,
}

impl ContextFragment {
    pub fn new(
        key: impl Into<String>,
        scope: FragmentScope,
        role: Role,
        content: impl Into<String>,
        sensitivity: FragmentSensitivity,
    ) -> Self {
        let key = key.into();
        let content = content.into();
        let revision = fragment_revision(&key, &content);
        Self {
            key,
            revision,
            scope,
            role,
            content,
            sensitivity,
        }
    }

    pub fn projected_message(&self) -> Message {
        Message {
            role: self.role,
            content: Some(format!(
                "{CONTEXT_FRAGMENT_VERSION}\nkey={}\nrevision={}\nscope={}\nsensitivity={}\ncontent:\n{}",
                self.key,
                self.revision,
                self.scope.as_str(),
                self.sensitivity.as_str(),
                self.content
            )),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FragmentUpsertOutcome {
    Inserted,
    Replaced,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFragmentError {
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct ContextFragmentLedger {
    active: BTreeMap<String, ContextFragment>,
    projection_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFragmentSnapshot {
    pub revision: String,
    pub fragments: Vec<ContextFragment>,
}

impl ContextFragmentLedger {
    pub fn upsert(
        &mut self,
        fragment: ContextFragment,
    ) -> Result<FragmentUpsertOutcome, ContextFragmentError> {
        if fragment.key.trim().is_empty() || fragment.revision.trim().is_empty() {
            return Err(ContextFragmentError {
                message: "context fragment key and revision must be nonempty".into(),
            });
        }
        if let Some(current) = self.active.get(&fragment.key) {
            if current.revision == fragment.revision {
                if current == &fragment {
                    return Ok(FragmentUpsertOutcome::Unchanged);
                }
                return Err(ContextFragmentError {
                    message: format!(
                        "context fragment revision collision for key {} revision {}",
                        fragment.key, fragment.revision
                    ),
                });
            }
            self.active.insert(fragment.key.clone(), fragment);
            return Ok(FragmentUpsertOutcome::Replaced);
        }

        self.projection_order.push(fragment.key.clone());
        self.active.insert(fragment.key.clone(), fragment);
        Ok(FragmentUpsertOutcome::Inserted)
    }

    pub fn snapshot(&self) -> ContextFragmentSnapshot {
        let fragments = self
            .projection_order
            .iter()
            .filter_map(|key| self.active.get(key).cloned())
            .collect::<Vec<_>>();
        let revision_input = fragments
            .iter()
            .map(|fragment| format!("{}={}", fragment.key, fragment.revision))
            .collect::<Vec<_>>()
            .join("\n");
        ContextFragmentSnapshot {
            revision: digest(&revision_input),
            fragments,
        }
    }

    pub fn project_messages(&self, messages: &[Message]) -> Vec<Message> {
        let insert_at = messages
            .iter()
            .position(|message| message.role != Role::System)
            .unwrap_or(messages.len());
        let snapshot = self.snapshot();
        let mut projected = Vec::with_capacity(messages.len() + snapshot.fragments.len());
        projected.extend_from_slice(&messages[..insert_at]);
        projected.extend(
            snapshot
                .fragments
                .iter()
                .map(ContextFragment::projected_message),
        );
        projected.extend_from_slice(&messages[insert_at..]);
        projected
    }

    pub fn projected_messages(&self) -> Vec<Message> {
        self.snapshot()
            .fragments
            .iter()
            .map(ContextFragment::projected_message)
            .collect()
    }
}

fn fragment_revision(key: &str, content: &str) -> String {
    digest(&format!("{key}\n{content}"))
}

fn digest(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(key: &str, content: &str) -> ContextFragment {
        ContextFragment::new(
            key,
            FragmentScope::TurnFrozen,
            Role::System,
            content,
            FragmentSensitivity::Private,
        )
    }

    #[test]
    fn context_fragment_ledger_keeps_one_latest_revision_per_key_in_stable_order() {
        let mut ledger = ContextFragmentLedger::default();
        let profile_v1 = fragment("reader.profile_snapshot", "profile v1");
        let profile_v1_revision = profile_v1.revision.clone();
        assert_eq!(
            ledger.upsert(profile_v1.clone()).unwrap(),
            FragmentUpsertOutcome::Inserted
        );
        assert_eq!(
            ledger.upsert(profile_v1).unwrap(),
            FragmentUpsertOutcome::Unchanged
        );
        assert_eq!(
            ledger
                .upsert(fragment("memory.operation_result", "memory result"))
                .unwrap(),
            FragmentUpsertOutcome::Inserted
        );
        assert_eq!(
            ledger
                .upsert(fragment("reader.profile_snapshot", "profile v2"))
                .unwrap(),
            FragmentUpsertOutcome::Replaced
        );

        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.fragments.len(), 2);
        assert_eq!(snapshot.fragments[0].key, "reader.profile_snapshot");
        assert_eq!(snapshot.fragments[0].content, "profile v2");
        assert_ne!(snapshot.fragments[0].revision, profile_v1_revision);
        assert_eq!(snapshot.fragments[1].key, "memory.operation_result");
    }

    #[test]
    fn context_fragment_projection_is_repeatable_and_revision_collisions_fail_closed() {
        let mut ledger = ContextFragmentLedger::default();
        let profile = fragment(
            "reader.profile_snapshot",
            "reader_profile_snapshot.v1 synthetic",
        );
        ledger.upsert(profile.clone()).unwrap();
        let first = ledger.project_messages(&[Message::system("base"), Message::user("question")]);
        let second = ledger.project_messages(&[Message::system("base"), Message::user("question")]);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        assert_eq!(
            first
                .iter()
                .filter_map(|message| message.content.as_deref())
                .filter(|content| content.contains("reader_profile_snapshot.v1"))
                .count(),
            1
        );

        let mut collision = profile;
        collision.content = "different content with a forged revision".into();
        assert!(ledger.upsert(collision).is_err());
    }
}
