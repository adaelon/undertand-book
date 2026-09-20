//! Incremental public answer projection; the full compiler remains authoritative.
use crate::{
    orchestrator::{
        compile_answer_preview, AgentAnswerPart, AgentAnswerView, AnswerProvenanceLedger,
        SourceBinding,
    },
    provider_stream::{ModelDelta, ModelObserver},
    run_events::RunEvents,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct AnswerPatch {
    pub message_id: u32,
    pub revision: u32,
    pub operation: String,
    pub view: Option<AgentAnswerView>,
}

/// Materialize a patch for snapshots; stale revisions never replace current content.
pub fn apply_patch(previous: Option<&AnswerPatch>, patch: &AnswerPatch) -> Option<AnswerPatch> {
    if let Some(old) = previous {
        if patch.message_id < old.message_id
            || (patch.message_id == old.message_id && patch.revision < old.revision)
        {
            return Some(old.clone());
        }
    }
    if patch.operation != "append" {
        return Some(patch.clone());
    }
    let old = previous?;
    if (old.message_id, old.revision) != (patch.message_id, patch.revision) {
        return Some(old.clone());
    }
    let mut next = old.clone();
    if let (Some(view), Some(delta)) = (&mut next.view, &patch.view) {
        for part in &delta.parts {
            match (view.parts.last_mut(), part) {
                (
                    Some(AgentAnswerPart::Markdown { text }),
                    AgentAnswerPart::Markdown { text: tail },
                ) => text.push_str(tail),
                _ => view.parts.push(part.clone()),
            }
        }
        for source in &delta.sources {
            if !view
                .sources
                .iter()
                .any(|s| s.source_ref_id == source.source_ref_id)
            {
                view.sources.push(source.clone());
            }
        }
    }
    next.operation = "replace".into();
    Some(next)
}

pub(crate) struct AnswerProjector {
    events: RunEvents,
    message_id: u32,
    revision: u32,
    raw: String,
    structured: bool,
    bindings: Vec<SourceBinding>,
    provenance: AnswerProvenanceLedger,
    published: String,
    published_view: Option<AgentAnswerView>,
    withdrawn: bool,
}
impl AnswerProjector {
    pub fn new(
        events: RunEvents,
        structured: bool,
        bindings: &[SourceBinding],
        provenance: &AnswerProvenanceLedger,
        repair: bool,
    ) -> Self {
        events.source_bindings(bindings);
        let (message_id, revision) = events.answer_identity(repair);
        let this = Self {
            events,
            message_id,
            revision,
            raw: String::new(),
            structured,
            bindings: bindings.to_vec(),
            provenance: provenance.clone(),
            published: String::new(),
            published_view: None,
            withdrawn: false,
        };
        if repair {
            this.patch("replace", None);
        }
        this
    }
    fn patch(&self, operation: &str, view: Option<AgentAnswerView>) {
        self.events.answer_patch(AnswerPatch {
            message_id: self.message_id,
            revision: self.revision,
            operation: operation.into(),
            view,
        });
    }
    pub fn discard(&mut self) {
        if !self.withdrawn {
            self.patch("discard", None);
            self.withdrawn = true;
        }
    }
    fn push(&mut self, delta: &str) {
        self.raw.push_str(delta);
        if self.withdrawn {
            return;
        }
        let text = if self.structured {
            match answer_field_prefix(&self.raw) {
                Some(text) => text,
                None => return,
            }
        } else {
            self.raw.clone()
        };
        // Keep undecided tails, including split source markers and Markdown structures.
        let Some(end) = stable_end(&text) else {
            return;
        };
        let prefix = &text[..end];
        if prefix == self.published {
            return;
        }
        if let Some(view) = compile_answer_preview(prefix, &self.bindings, &self.provenance) {
            self.published = prefix.into();
            let tail = self.published_view.as_ref().and_then(|previous| {
                match (previous.parts.as_slice(), view.parts.as_slice()) {
                    (
                        [AgentAnswerPart::Markdown { text: old }],
                        [AgentAnswerPart::Markdown { text: new }],
                    ) if previous.sources.is_empty() && view.sources.is_empty() => {
                        new.strip_prefix(old).map(str::to_owned)
                    }
                    _ => None,
                }
            });
            self.published_view = Some(view.clone());
            if let Some(text) = tail {
                self.patch(
                    "append",
                    Some(AgentAnswerView {
                        parts: vec![AgentAnswerPart::Markdown { text }],
                        sources: Vec::new(),
                    }),
                );
            } else {
                self.patch("replace", Some(view));
            }
        }
    }
}
impl ModelObserver for AnswerProjector {
    fn observe(&mut self, delta: ModelDelta) {
        match delta {
            ModelDelta::Text(text) => self.push(&text),
            ModelDelta::ToolArguments { .. } => self.discard(),
            _ => {}
        }
    }
}

fn stable_end(text: &str) -> Option<usize> {
    let mut end = None;
    let mut brackets = 0usize;
    let mut backticks = false;
    for (index, ch) in text.char_indices() {
        match ch {
            '`' => backticks = !backticks,
            '[' | '(' | '{' if !backticks => brackets += 1,
            ']' | ')' | '}' if !backticks => brackets = brackets.saturating_sub(1),
            _ => {}
        }
        if !backticks && brackets == 0 && matches!(ch, '。' | '！' | '？' | '\n') {
            end = Some(index + ch.len_utf8());
        }
        if !backticks
            && brackets == 0
            && matches!(ch, '.' | '!' | '?')
            && text[index + 1..].starts_with(char::is_whitespace)
        {
            end = Some(index + 1);
        }
    }
    end
}

/// Decode only top-level answer/final string values, never nested tool arguments.
fn answer_field_prefix(raw: &str) -> Option<String> {
    let raw = raw
        .trim_start()
        .strip_prefix("```json")
        .or_else(|| raw.trim_start().strip_prefix("```"))
        .unwrap_or(raw)
        .trim_start();
    if !raw.starts_with('{') {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut i = 1;
    let mut depth = 1usize;
    let mut key = None;
    let mut expect_key = true;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                    } else if bytes[i] == b'"' {
                        break;
                    } else {
                        i += 1;
                    }
                }
                let closed = i < bytes.len();
                if depth == 1 && !expect_key && matches!(key.as_deref(), Some("answer" | "final")) {
                    if closed {
                        return serde_json::from_str(&raw[start..=i]).ok();
                    }
                    let mut tail = &raw[start..];
                    // Drop only an incomplete JSON escape, preserving Unicode character boundaries.
                    for _ in 0..13 {
                        if let Ok(value) = serde_json::from_str::<String>(&format!("{tail}\"")) {
                            return Some(value);
                        }
                        tail = &tail[..tail.char_indices().last()?.0];
                    }
                    return None;
                }
                if !closed {
                    return None;
                }
                if depth == 1 && expect_key {
                    key = serde_json::from_str::<String>(&raw[start..=i]).ok();
                    expect_key = false;
                }
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            b',' if depth == 1 => {
                expect_key = true;
                key = None;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structured_prefix_decodes_escapes_and_ignores_nested_protocol() {
        assert_eq!(
            answer_field_prefix(r#"{"final":"中文。后"#),
            Some("中文。后".into())
        );
        assert_eq!(
            answer_field_prefix(r#"{"answer":"中文。\u4e2"#),
            Some("中文。".into())
        );
        assert_eq!(
            answer_field_prefix(r#"{"answer":"中文。\uD83D\uDE00"#),
            Some("中文。😀".into())
        );
        assert_eq!(
            answer_field_prefix(r#"{"tool_calls":[{"arguments":{"answer":"内部。"}}]}"#),
            None
        );
        assert_eq!(
            answer_field_prefix(r#"{"citations":[],"answer":"正文。"}"#),
            Some("正文。".into())
        );
        assert_eq!(stable_end("正文。[[sou"), Some("正文。".len()));
        assert_eq!(stable_end("```rust\nlet x = 1;\n"), None);
    }
    #[test]
    fn export_answer_patch() {
        AnswerPatch::export_all().unwrap();
    }
}
