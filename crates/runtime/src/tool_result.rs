use crate::tool_registry::{ToolOutputPolicy, ToolResultPolicy};
use crate::{Message, Role};
use book_tool_contracts::{validate_input, BookToolId, BookToolInput};
use read_tools::{Book, EvidenceRange, SearchTextResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const TOOL_RESULT_ENVELOPE_VERSION: &str = "tool_result_envelope.v1";
pub const ACTIVE_TURN_TOOL_MODEL_BODY_BUDGET_BYTES: usize = 48 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalToolStatus {
    Ok,
    Error,
    LegacyUnparsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoricalToolReceipt {
    pub version: String,
    pub tool: String,
    pub locator_args: Value,
    pub status: HistoricalToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_evidence: Vec<EvidenceRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_refs: Vec<String>,
    pub opaque_result_digest: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolResultStatus {
    Ok,
    Partial,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ToolContinuation {
    ToolCursor {
        tool: String,
        arguments: Value,
    },
    NextCall {
        tool: String,
        arguments: Value,
        reason: String,
    },
    RefineCall {
        tool: String,
        arguments: Value,
        guidance: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ToolResultEnvelope {
    pub version: String,
    pub status: ToolResultStatus,
    pub model_body: Value,
    pub receipt: HistoricalToolReceipt,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<ToolContinuation>,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolResultDraft {
    pub status: ToolResultStatus,
    pub model_body: Value,
    pub truncated: bool,
    pub continuation: Option<ToolContinuation>,
    pub evidence_arguments: String,
}

impl ToolResultDraft {
    pub fn model_body_json(&self) -> String {
        serde_json::to_string(&self.model_body).unwrap_or_else(|_| "null".into())
    }

    pub fn into_envelope(self, receipt: HistoricalToolReceipt) -> ToolResultEnvelope {
        ToolResultEnvelope {
            version: TOOL_RESULT_ENVELOPE_VERSION.into(),
            status: self.status,
            model_body: self.model_body,
            receipt,
            truncated: self.truncated,
            continuation: self.continuation,
        }
    }
}

fn json_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn next_search_cursor(tool: &str, arguments: &str, body: &Value) -> Option<ToolContinuation> {
    let cursor = body.get("next_cursor")?.as_str()?;
    let mut next_arguments = serde_json::from_str::<Value>(arguments).ok()?;
    next_arguments
        .as_object_mut()?
        .insert("cursor".into(), Value::String(cursor.into()));
    Some(ToolContinuation::ToolCursor {
        tool: tool.into(),
        arguments: next_arguments,
    })
}

fn pop_named_array(value: &mut Value, target: &str) -> bool {
    match value {
        Value::Object(object) => {
            if let Some(array) = object.get_mut(target).and_then(Value::as_array_mut) {
                if !array.is_empty() {
                    array.pop();
                    return true;
                }
            }
            object
                .values_mut()
                .any(|child| pop_named_array(child, target))
        }
        Value::Array(array) => array.iter_mut().any(|child| pop_named_array(child, target)),
        _ => false,
    }
}

fn pop_any_array(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => object.values_mut().any(pop_any_array),
        Value::Array(array) => {
            if !array.is_empty() {
                array.pop();
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

fn truncate_one_string(value: &mut Value, field: Option<&str>) -> bool {
    const PROTECTED: &[&str] = &[
        "status",
        "error_code",
        "category",
        "version",
        "source_revision",
        "lid",
        "start_lid",
        "end_lid",
        "next_cursor",
    ];
    match value {
        Value::Object(object) => object
            .iter_mut()
            .any(|(key, child)| truncate_one_string(child, Some(key.as_str()))),
        Value::Array(array) => array
            .iter_mut()
            .any(|child| truncate_one_string(child, None)),
        Value::String(text)
            if !field.is_some_and(|field| PROTECTED.contains(&field))
                && text.chars().count() > 32 =>
        {
            let keep = (text.chars().count() / 2).max(16);
            *text = format!(
                "{}...[truncated]",
                text.chars().take(keep).collect::<String>()
            );
            true
        }
        _ => false,
    }
}

fn bounded_value(mut value: Value, limit: usize, drop_order: &[&str]) -> Value {
    if json_len(&value) <= limit {
        return value;
    }
    loop {
        let changed = drop_order
            .iter()
            .any(|field| pop_named_array(&mut value, field))
            || truncate_one_string(&mut value, None)
            || pop_any_array(&mut value);
        if json_len(&value) <= limit {
            return value;
        }
        if !changed {
            break;
        }
    }
    let summary = json!({
        "projection": "bounded_summary",
        "message": "tool result exceeded the model-body budget; use continuation"
    });
    if json_len(&summary) <= limit {
        summary
    } else {
        Value::Null
    }
}

fn refine_continuation(tool: &str, arguments: &str, guidance: &str) -> ToolContinuation {
    ToolContinuation::RefineCall {
        tool: tool.into(),
        arguments: serde_json::from_str(arguments).unwrap_or_else(|_| json!({})),
        guidance: guidance.into(),
    }
}

fn first_citation_lid(value: &Value) -> Option<&str> {
    value
        .get("citations")?
        .as_array()?
        .first()?
        .get("lid")?
        .as_str()
}

fn project_text(arguments: &str, raw: &Value, limit: usize, book: &Book) -> ToolResultDraft {
    let input = serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| validate_input(BookToolId::Text, value).ok());
    let Some(BookToolInput::Text(input)) = input else {
        return ToolResultDraft {
            status: ToolResultStatus::Partial,
            model_body: bounded_value(raw.clone(), limit, &[]),
            truncated: true,
            continuation: Some(refine_continuation(
                "book.text",
                arguments,
                "retry with a narrower LID range",
            )),
            evidence_arguments: arguments.into(),
        };
    };
    let end_lid = input.end_lid.as_deref().unwrap_or(&input.lid);
    let start = book
        .base
        .lid_nodes
        .iter()
        .find(|node| node.lid == input.lid);
    let end = book.base.lid_nodes.iter().find(|node| node.lid == end_lid);
    let mut leaves = match (start, end) {
        (Some(start), Some(end)) => book
            .base
            .lid_nodes
            .iter()
            .filter(|node| {
                node.children.is_empty()
                    && node.span.start >= start.span.start
                    && node.span.end <= end.span.end
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    leaves.sort_by_key(|node| (node.span.start, node.span.end));

    let Some(first) = leaves.first() else {
        return ToolResultDraft {
            status: ToolResultStatus::Partial,
            model_body: bounded_value(raw.clone(), limit, &[]),
            truncated: true,
            continuation: Some(refine_continuation(
                "book.text",
                arguments,
                "retry with a narrower child LID",
            )),
            evidence_arguments: arguments.into(),
        };
    };

    let mut best: Option<(usize, Value)> = None;
    for (index, last) in leaves.iter().enumerate() {
        let Ok(text) = book.text(
            &first.lid,
            (first.lid != last.lid).then_some(last.lid.as_str()),
        ) else {
            break;
        };
        let candidate = json!({"lid": first.lid, "text": text});
        if json_len(&candidate) > limit {
            break;
        }
        best = Some((index, candidate));
    }

    let Some((last_index, model_body)) = best else {
        return ToolResultDraft {
            status: ToolResultStatus::Partial,
            model_body: bounded_value(raw.clone(), limit, &[]),
            truncated: true,
            continuation: Some(refine_continuation(
                "book.text",
                arguments,
                "the selected LID is too large; request a narrower child LID or nearby context",
            )),
            evidence_arguments: arguments.into(),
        };
    };
    let included_end = &leaves[last_index].lid;
    let evidence_arguments = serde_json::to_string(&json!({
        "lid": first.lid,
        "end_lid": included_end,
    }))
    .unwrap_or_else(|_| arguments.into());
    let continuation = leaves
        .get(last_index + 1)
        .map(|next| ToolContinuation::NextCall {
            tool: "book.text".into(),
            arguments: json!({"lid": next.lid, "end_lid": leaves.last().unwrap().lid}),
            reason: "continue the omitted LID range".into(),
        });
    ToolResultDraft {
        status: ToolResultStatus::Partial,
        model_body,
        truncated: true,
        continuation,
        evidence_arguments,
    }
}

fn project_search(arguments: &str, raw: &Value, limit: usize) -> ToolResultDraft {
    let Ok(mut projected) = serde_json::from_value::<SearchTextResult>(raw.clone()) else {
        return ToolResultDraft {
            status: ToolResultStatus::Partial,
            model_body: bounded_value(raw.clone(), limit, &["occurrences", "section_counts"]),
            truncated: true,
            continuation: Some(refine_continuation(
                "book.search_text",
                arguments,
                "retry with a smaller page_size or narrower scope",
            )),
            evidence_arguments: arguments.into(),
        };
    };
    let original = projected.clone();
    while serde_json::to_vec(&projected).map_or(0, |bytes| bytes.len()) > limit
        && !projected.occurrences.is_empty()
    {
        projected.occurrences.pop();
    }
    if serde_json::to_vec(&projected).map_or(0, |bytes| bytes.len()) > limit {
        projected.section_counts.clear();
    }
    projected.exhaustive = false;
    projected.next_cursor = None;
    while serde_json::to_vec(&projected).map_or(0, |bytes| bytes.len()) > limit
        && projected
            .occurrences
            .last()
            .is_some_and(|occurrence| occurrence.excerpt.chars().count() > 32)
    {
        let occurrence = projected
            .occurrences
            .last_mut()
            .expect("last occurrence was checked");
        let keep = (occurrence.excerpt.chars().count() / 2).max(16);
        occurrence.excerpt = format!(
            "{}...[truncated]",
            occurrence.excerpt.chars().take(keep).collect::<String>()
        );
    }
    let model_body = bounded_value(
        serde_json::to_value(&projected).unwrap_or(Value::Null),
        limit,
        &["section_counts", "occurrences"],
    );
    let kept = model_body
        .get("occurrences")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let omitted = original.occurrences.get(kept);
    let continuation = omitted
        .and_then(|occurrence| {
            let mut next = serde_json::from_str::<Value>(arguments).ok()?;
            let object = next.as_object_mut()?;
            object.remove("cursor");
            object.insert("page_size".into(), Value::from(1));
            object.insert("scope".into(), json!({"within_lid": occurrence.start_lid}));
            Some(ToolContinuation::NextCall {
                tool: "book.search_text".into(),
                arguments: next,
                reason: "continue from the first occurrence omitted by the model-body budget"
                    .into(),
            })
        })
        .or_else(|| next_search_cursor("book.search_text", arguments, raw))
        .or_else(|| {
            Some(refine_continuation(
                "book.search_text",
                arguments,
                "retry with a smaller page_size or narrower scope",
            ))
        });
    ToolResultDraft {
        status: ToolResultStatus::Partial,
        model_body,
        truncated: true,
        continuation,
        evidence_arguments: arguments.into(),
    }
}

fn project_structured(
    tool: &str,
    arguments: &str,
    raw: &Value,
    limit: usize,
    result_policy: ToolResultPolicy,
) -> ToolResultDraft {
    let drop_order = match result_policy {
        ToolResultPolicy::QueryResponse => &[
            "model_supplement",
            "suggested_probing",
            "related_concepts",
            "evidence_chain",
            "support",
            "bindings",
            "citations",
        ][..],
        ToolResultPolicy::ProfileProjection => &[
            "warnings",
            "projections",
            "presets",
            "slots",
            "facts",
            "items",
        ][..],
        ToolResultPolicy::NavigationProjection => {
            &["warnings", "frontier", "route", "questions", "key_stops"][..]
        }
        ToolResultPolicy::ArtifactProjection => &["relations", "records", "hits", "artifacts"][..],
        _ => &[
            "warnings",
            "entries",
            "items",
            "occurrences",
            "references",
            "questions",
        ][..],
    };
    let model_body = bounded_value(raw.clone(), limit, drop_order);
    let continuation = first_citation_lid(raw)
        .map(|lid| ToolContinuation::NextCall {
            tool: "book.text".into(),
            arguments: json!({"lid": lid}),
            reason: "read exact evidence omitted by the bounded query result".into(),
        })
        .or_else(|| {
            Some(refine_continuation(
                tool,
                arguments,
                "retry with a narrower target, scope, stage, or field selection",
            ))
        });
    ToolResultDraft {
        status: ToolResultStatus::Partial,
        model_body,
        truncated: true,
        continuation,
        evidence_arguments: arguments.into(),
    }
}

fn project_error(arguments: &str, raw: &Value, limit: usize) -> ToolResultDraft {
    let model_body = bounded_value(raw.clone(), limit, &[]);
    ToolResultDraft {
        status: ToolResultStatus::Error,
        truncated: model_body != *raw,
        model_body,
        continuation: None,
        evidence_arguments: arguments.into(),
    }
}

pub(crate) fn project_tool_result(
    tool: &str,
    arguments: &str,
    raw_result: &str,
    output_policy: ToolOutputPolicy,
    remaining_turn_body_bytes: usize,
    book: &Book,
) -> ToolResultDraft {
    let limit = output_policy
        .max_model_body_bytes
        .min(remaining_turn_body_bytes);
    let raw = serde_json::from_str::<Value>(raw_result).unwrap_or_else(|error| {
        json!({
            "error_code": "TOOL_RESULT_INVALID_JSON",
            "category": "internal",
            "message": error.to_string(),
        })
    });
    if raw.get("error_code").and_then(Value::as_str).is_some() {
        return project_error(arguments, &raw, limit);
    }
    if json_len(&raw) <= limit {
        return ToolResultDraft {
            status: ToolResultStatus::Ok,
            continuation: (tool == "book.search_text")
                .then(|| next_search_cursor(tool, arguments, &raw))
                .flatten(),
            model_body: raw,
            truncated: false,
            evidence_arguments: arguments.into(),
        };
    }
    match tool {
        "book.text" => project_text(arguments, &raw, limit, book),
        "book.search_text" => project_search(arguments, &raw, limit),
        _ => project_structured(tool, arguments, &raw, limit, output_policy.result_policy),
    }
}

#[derive(Debug, Clone)]
struct ActiveToolResult {
    envelope: ToolResultEnvelope,
    sampled: bool,
    retain_model_body: bool,
    sequence: u64,
}

#[derive(Debug, Default)]
pub(crate) struct ActiveToolResultLedger {
    by_call_id: HashMap<String, ActiveToolResult>,
    next_sequence: u64,
}

impl ActiveToolResultLedger {
    pub fn remaining_model_body_bytes(&self) -> usize {
        let fresh: usize = self
            .by_call_id
            .values()
            .filter(|result| result.retain_model_body)
            .map(|result| json_len(&result.envelope.model_body))
            .sum();
        ACTIVE_TURN_TOOL_MODEL_BODY_BUDGET_BYTES.saturating_sub(fresh)
    }

    pub fn make_room_for(&mut self, desired_model_body_bytes: usize) {
        let desired = desired_model_body_bytes.min(ACTIVE_TURN_TOOL_MODEL_BODY_BUDGET_BYTES);
        while self.remaining_model_body_bytes() < desired {
            let oldest = self
                .by_call_id
                .iter()
                .filter(|(_, result)| result.sampled && result.retain_model_body)
                .min_by_key(|(_, result)| result.sequence)
                .map(|(call_id, _)| call_id.clone());
            let Some(oldest) = oldest else {
                break;
            };
            if let Some(result) = self.by_call_id.get_mut(&oldest) {
                result.retain_model_body = false;
            }
        }
    }

    pub fn insert(&mut self, call_id: impl Into<String>, envelope: ToolResultEnvelope) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.by_call_id.insert(
            call_id.into(),
            ActiveToolResult {
                envelope,
                sampled: false,
                retain_model_body: true,
                sequence,
            },
        );
    }

    pub fn project_messages(&self, messages: &mut [Message]) {
        for message in messages
            .iter_mut()
            .filter(|message| message.role == Role::Tool)
        {
            let Some(result) = message
                .tool_call_id
                .as_deref()
                .and_then(|call_id| self.by_call_id.get(call_id))
            else {
                continue;
            };
            let mut envelope = result.envelope.clone();
            if !result.retain_model_body {
                envelope.model_body = Value::Null;
            }
            message.content = Some(
                serde_json::to_string(&envelope).unwrap_or_else(|_| {
                    r#"{"version":"tool_result_envelope.v1","status":"error","model_body":null,"truncated":true}"#.into()
                }),
            );
        }
    }

    pub fn mark_projected_fresh_results_sampled(&mut self) {
        for result in self.by_call_id.values_mut() {
            result.sampled = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{LidNode, NodeKind, ReadOnlyBase, Span};
    use book_tool_contracts::{SearchMatchMode, SearchOrder, SearchTextInput};

    fn policy(result_policy: ToolResultPolicy, max_model_body_bytes: usize) -> ToolOutputPolicy {
        ToolOutputPolicy {
            result_policy,
            max_model_body_bytes,
        }
    }

    fn receipt(tool: &str) -> HistoricalToolReceipt {
        HistoricalToolReceipt {
            version: "historical_tool_receipt.v1".into(),
            tool: tool.into(),
            locator_args: json!({}),
            status: HistoricalToolStatus::Ok,
            error_code: None,
            accepted_evidence: Vec::new(),
            source_refs: Vec::new(),
            opaque_result_digest: "digest".into(),
        }
    }

    fn two_leaf_book() -> Book {
        let source = format!("{}{}", "A".repeat(600), "B".repeat(600));
        Book::new(
            ReadOnlyBase {
                book_id: "bounded-text".into(),
                lid_nodes: vec![
                    LidNode {
                        lid: "1".into(),
                        path: vec![1],
                        kind: NodeKind::Chapter,
                        span: Span {
                            start: 0,
                            end: 1200,
                        },
                        children: vec!["1.1".into(), "1.2".into()],
                    },
                    LidNode {
                        lid: "1.1".into(),
                        path: vec![1, 1],
                        kind: NodeKind::Paragraph,
                        span: Span { start: 0, end: 600 },
                        children: Vec::new(),
                    },
                    LidNode {
                        lid: "1.2".into(),
                        path: vec![1, 2],
                        kind: NodeKind::Paragraph,
                        span: Span {
                            start: 600,
                            end: 1200,
                        },
                        children: Vec::new(),
                    },
                ],
                graph_nodes: Vec::new(),
                graph_edges: Vec::new(),
            },
            &source,
        )
    }

    #[test]
    fn tool_result_projection_text_is_bounded_at_lid_boundaries_and_continuable() {
        let book = two_leaf_book();
        let raw = serde_json::to_string(&json!({
            "lid": "1",
            "text": book.text("1", None).unwrap(),
        }))
        .unwrap();

        let draft = project_tool_result(
            "book.text",
            r#"{"lid":"1"}"#,
            &raw,
            policy(ToolResultPolicy::EvidenceProjection, 700),
            700,
            &book,
        );

        assert_eq!(draft.status, ToolResultStatus::Partial);
        assert!(draft.truncated);
        assert!(draft.model_body_json().len() <= 700);
        assert_eq!(draft.model_body["lid"], "1.1");
        assert_eq!(draft.model_body["text"].as_str().unwrap().len(), 600);
        assert_eq!(
            serde_json::from_str::<Value>(&draft.evidence_arguments).unwrap(),
            json!({"lid":"1.1","end_lid":"1.1"})
        );
        assert!(matches!(
            draft.continuation,
            Some(ToolContinuation::NextCall { ref tool, .. }) if tool == "book.text"
        ));
    }

    #[test]
    fn tool_result_projection_search_keeps_valid_json_and_marks_context_truncation() {
        let source = "needle ".repeat(80);
        let end = source.len();
        let book = Book::new(
            ReadOnlyBase {
                book_id: "bounded-search".into(),
                lid_nodes: vec![LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end },
                    children: Vec::new(),
                }],
                graph_nodes: Vec::new(),
                graph_edges: Vec::new(),
            },
            &source,
        );
        let input = SearchTextInput {
            query: "needle".into(),
            match_mode: SearchMatchMode::Exact,
            scope: None,
            order: SearchOrder::Document,
            cursor: None,
            page_size: 50,
        };
        let raw = serde_json::to_string(&book.search_text(&input).unwrap()).unwrap();
        let arguments = serde_json::to_string(&input).unwrap();

        let draft = project_tool_result(
            "book.search_text",
            &arguments,
            &raw,
            policy(ToolResultPolicy::EvidenceProjection, 1_200),
            1_200,
            &book,
        );

        assert!(draft.truncated);
        assert!(draft.model_body_json().len() <= 1_200);
        let projected: SearchTextResult = serde_json::from_value(draft.model_body).unwrap();
        assert!(projected.occurrences.len() < 50);
        assert!(draft.continuation.is_some());
    }

    #[test]
    fn tool_result_projection_native_search_cursor_is_not_context_truncation() {
        let source = "needle needle";
        let book = Book::new(
            ReadOnlyBase {
                book_id: "native-search-page".into(),
                lid_nodes: vec![LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span {
                        start: 0,
                        end: source.len(),
                    },
                    children: Vec::new(),
                }],
                graph_nodes: Vec::new(),
                graph_edges: Vec::new(),
            },
            source,
        );
        let input = SearchTextInput {
            query: "needle".into(),
            match_mode: SearchMatchMode::Exact,
            scope: None,
            order: SearchOrder::Document,
            cursor: None,
            page_size: 1,
        };
        let raw = serde_json::to_string(&book.search_text(&input).unwrap()).unwrap();
        let arguments = serde_json::to_string(&input).unwrap();

        let draft = project_tool_result(
            "book.search_text",
            &arguments,
            &raw,
            policy(ToolResultPolicy::EvidenceProjection, 16 * 1024),
            16 * 1024,
            &book,
        );

        assert_eq!(draft.status, ToolResultStatus::Ok);
        assert!(!draft.truncated);
        assert!(matches!(
            draft.continuation,
            Some(ToolContinuation::ToolCursor { .. })
        ));
    }

    #[test]
    fn tool_result_projection_query_paper_profile_and_error_are_explicitly_bounded() {
        let book = two_leaf_book();
        let query = json!({
            "status":"complete",
            "answer":"A".repeat(3_000),
            "citations":[{"lid":"1.1","text":"A".repeat(600),"role":"support"}],
            "bindings":[],"support":[],"model_supplement":[]
        });
        let paper = json!({"available":true,"questions":vec!["Q".repeat(800); 20],"warnings":[]});
        let profile = json!({"slots":vec!["S".repeat(800); 20],"presets":[],"projections":[]});
        for (tool, value, result_policy) in [
            ("book.query", query, ToolResultPolicy::QueryResponse),
            (
                "book.paper_reading_guide",
                paper,
                ToolResultPolicy::NavigationProjection,
            ),
            (
                "profile.manifest",
                profile,
                ToolResultPolicy::ProfileProjection,
            ),
        ] {
            let draft = project_tool_result(
                tool,
                "{}",
                &value.to_string(),
                policy(result_policy, 1_024),
                1_024,
                &book,
            );
            assert_eq!(draft.status, ToolResultStatus::Partial);
            assert!(draft.truncated);
            assert!(draft.model_body_json().len() <= 1_024);
            assert!(draft.continuation.is_some());
        }

        let error = json!({
            "error_code":"LID_NOT_FOUND",
            "category":"not_found",
            "message":"M".repeat(5_000),
        });
        let draft = project_tool_result(
            "book.text",
            "{}",
            &error.to_string(),
            policy(ToolResultPolicy::EvidenceProjection, 512),
            512,
            &book,
        );
        assert_eq!(draft.status, ToolResultStatus::Error);
        assert!(draft.truncated);
        assert_eq!(draft.model_body["error_code"], "LID_NOT_FOUND");
        assert!(draft.model_body_json().len() <= 512);
        assert!(draft.continuation.is_none());
    }

    #[test]
    fn tool_result_projection_fresh_body_is_retained_until_budget_pressure_then_receipt_only() {
        let envelope = ToolResultEnvelope {
            version: TOOL_RESULT_ENVELOPE_VERSION.into(),
            status: ToolResultStatus::Ok,
            model_body: json!({"text":"FRESH_BODY"}),
            receipt: receipt("book.text"),
            truncated: false,
            continuation: None,
        };
        let durable = Message {
            role: Role::Tool,
            content: Some("RAW_DURABLE_BODY".into()),
            tool_calls: Vec::new(),
            tool_call_id: Some("call-1".into()),
        };
        let mut ledger = ActiveToolResultLedger::default();
        ledger.insert("call-1", envelope);

        let mut first = vec![durable.clone()];
        ledger.project_messages(&mut first);
        assert!(first[0].content.as_deref().unwrap().contains("FRESH_BODY"));
        ledger.mark_projected_fresh_results_sampled();

        let mut second = vec![durable.clone()];
        ledger.project_messages(&mut second);
        let second: ToolResultEnvelope =
            serde_json::from_str(second[0].content.as_deref().unwrap()).unwrap();
        assert_eq!(second.model_body, json!({"text":"FRESH_BODY"}));

        ledger.make_room_for(ACTIVE_TURN_TOOL_MODEL_BODY_BUDGET_BYTES);
        let mut evicted = vec![durable.clone()];
        ledger.project_messages(&mut evicted);
        let evicted: ToolResultEnvelope =
            serde_json::from_str(evicted[0].content.as_deref().unwrap()).unwrap();
        assert_eq!(evicted.model_body, Value::Null);
        assert_eq!(durable.content.as_deref(), Some("RAW_DURABLE_BODY"));
    }

    #[test]
    fn tool_result_projection_active_fresh_bodies_share_one_turn_budget() {
        let book = two_leaf_book();
        let mut ledger = ActiveToolResultLedger::default();
        for index in 0..4 {
            let remaining = ledger.remaining_model_body_bytes();
            let draft = project_tool_result(
                "profile.manifest",
                "{}",
                &json!({"slots":["X".repeat(30_000)]}).to_string(),
                policy(ToolResultPolicy::ProfileProjection, 20 * 1024),
                remaining,
                &book,
            );
            let receipt = receipt("profile.manifest");
            ledger.insert(format!("call-{index}"), draft.into_envelope(receipt));
        }
        let used: usize = ledger
            .by_call_id
            .values()
            .map(|result| json_len(&result.envelope.model_body))
            .sum();
        assert!(used <= ACTIVE_TURN_TOOL_MODEL_BODY_BUDGET_BYTES);
    }
}
