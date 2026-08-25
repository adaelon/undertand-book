use crate::{tool_exposure::CapabilityRequestAudit, Message, Role, ToolSpec};
use serde_json::json;

pub const AGENT_REQUEST_AUDIT_VERSION: &str = "agent_request_audit.v2";

/// Server-side observability for the provider-neutral request assembled by the runtime.
/// It intentionally stores only sizes and digests, never message or tool-result bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestAudit {
    pub version: String,
    pub requests: Vec<AgentRequestTurnAudit>,
    pub capability_requests: Vec<CapabilityRequestAudit>,
    pub cumulative_billed_tokens: u32,
}

impl Default for AgentRequestAudit {
    fn default() -> Self {
        Self {
            version: AGENT_REQUEST_AUDIT_VERSION.into(),
            requests: Vec::new(),
            capability_requests: Vec::new(),
            cumulative_billed_tokens: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestTurnAudit {
    pub request_ordinal: usize,
    pub messages: Vec<AgentRequestMessageAudit>,
    pub tool_schemas: Vec<AgentRequestToolSchemaAudit>,
    pub profile_snapshot_count: usize,
    pub message_payload_bytes: usize,
    pub tool_body_bytes: usize,
    pub tool_call_argument_bytes: usize,
    pub tool_schema_bytes: usize,
    pub message_estimated_tokens: u32,
    pub tool_schema_estimated_tokens: u32,
    pub active_input_estimated_tokens: u32,
    pub cumulative_billed_tokens_before: u32,
    pub provider_reported_billed_tokens: Option<u32>,
    pub billed_tokens_charged: u32,
    pub cumulative_billed_tokens_after: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestMessageAudit {
    pub ordinal: usize,
    pub role: Role,
    pub content_bytes: usize,
    pub content_digest: String,
    pub tool_call_count: usize,
    pub tool_call_argument_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestToolSchemaAudit {
    pub name: String,
    pub schema_bytes: usize,
}

impl AgentRequestAudit {
    pub fn record_capability_request(&mut self, audit: CapabilityRequestAudit) {
        self.capability_requests.push(audit);
    }

    pub fn begin_request(
        &mut self,
        messages: &[Message],
        tools: &[ToolSpec],
        cumulative_billed_tokens_before: u32,
    ) -> usize {
        let message_payload = serde_json::to_string(messages).unwrap_or_default();
        let tool_payloads = tools
            .iter()
            .map(|tool| {
                serde_json::to_string(&json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }))
                .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        let tool_schema_bytes = tool_payloads.iter().map(String::len).sum::<usize>()
            + tool_payloads.len().saturating_sub(1)
            + 2;
        let message_estimated_tokens = estimate_tokens(&message_payload);
        let tool_schema_estimated_tokens =
            estimate_tokens(&format!("[{}]", tool_payloads.join(",")));

        let message_audits = messages
            .iter()
            .enumerate()
            .map(|(ordinal, message)| {
                let content = message.content.as_deref().unwrap_or_default();
                AgentRequestMessageAudit {
                    ordinal,
                    role: message.role,
                    content_bytes: content.len(),
                    content_digest: digest(content),
                    tool_call_count: message.tool_calls.len(),
                    tool_call_argument_bytes: message
                        .tool_calls
                        .iter()
                        .map(|call| call.arguments.len())
                        .sum(),
                }
            })
            .collect::<Vec<_>>();

        let request_ordinal = self.requests.len() + 1;
        self.requests.push(AgentRequestTurnAudit {
            request_ordinal,
            messages: message_audits,
            tool_schemas: tools
                .iter()
                .zip(tool_payloads.iter())
                .map(|(tool, payload)| AgentRequestToolSchemaAudit {
                    name: tool.name.clone(),
                    schema_bytes: payload.len(),
                })
                .collect(),
            profile_snapshot_count: messages
                .iter()
                .filter(|message| {
                    message.role == Role::System
                        && message
                            .content
                            .as_deref()
                            .is_some_and(|content| content.contains("reader_profile_snapshot.v1"))
                })
                .count(),
            message_payload_bytes: message_payload.len(),
            tool_body_bytes: messages
                .iter()
                .filter(|message| message.role == Role::Tool)
                .filter_map(|message| message.content.as_ref())
                .map(String::len)
                .sum(),
            tool_call_argument_bytes: messages
                .iter()
                .flat_map(|message| message.tool_calls.iter())
                .map(|call| call.arguments.len())
                .sum(),
            tool_schema_bytes,
            message_estimated_tokens,
            tool_schema_estimated_tokens,
            active_input_estimated_tokens: message_estimated_tokens
                .saturating_add(tool_schema_estimated_tokens),
            cumulative_billed_tokens_before,
            provider_reported_billed_tokens: None,
            billed_tokens_charged: 0,
            cumulative_billed_tokens_after: cumulative_billed_tokens_before,
        });
        self.requests.len() - 1
    }

    pub fn finish_request(
        &mut self,
        request_index: usize,
        provider_reported_billed_tokens: Option<u32>,
        billed_tokens_charged: u32,
        cumulative_billed_tokens_after: u32,
    ) {
        if let Some(request) = self.requests.get_mut(request_index) {
            request.provider_reported_billed_tokens = provider_reported_billed_tokens;
            request.billed_tokens_charged = billed_tokens_charged;
            request.cumulative_billed_tokens_after = cumulative_billed_tokens_after;
        }
        self.cumulative_billed_tokens = cumulative_billed_tokens_after;
    }
}

fn estimate_tokens(text: &str) -> u32 {
    let mut estimate = 0.0_f32;
    for character in text.chars() {
        estimate += if character as u32 >= 0x2e80 {
            1.0
        } else {
            0.25
        };
    }
    estimate.ceil() as u32
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
    use crate::ToolCall;

    fn tool(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: format!("Synthetic schema for {name}"),
            parameters: json!({"type": "object", "properties": {}}),
        }
    }

    fn tool_message(id: &str, body: &str) -> Message {
        Message {
            role: Role::Tool,
            content: Some(body.into()),
            tool_calls: vec![],
            tool_call_id: Some(id.into()),
        }
    }

    fn assistant_call(id: &str, name: &str, arguments: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: arguments.into(),
            }],
            tool_call_id: None,
        }
    }

    #[test]
    fn agent_request_audit_five_synthetic_fixtures_are_repeatable() {
        let profile = Message::system("reader_profile_snapshot.v1 synthetic");
        let fixtures = vec![
            (
                "local-citation",
                vec![
                    profile.clone(),
                    Message::user("Explain the selected sentence"),
                ],
                0,
            ),
            (
                "eq-9-gap",
                vec![
                    profile.clone(),
                    Message::user("Explain the normalization gap near Eq. 9"),
                    assistant_call("c1", "book.text", r#"{"lid":"1.9"}"#),
                    tool_message("c1", r#"{"lid":"1.9","text":"synthetic equation"}"#),
                ],
                r#"{"lid":"1.9","text":"synthetic equation"}"#.len(),
            ),
            (
                "exhaustive-occurrence",
                vec![
                    profile.clone(),
                    Message::user("Find every synthetic occurrence"),
                    assistant_call("c2", "book.search_text", r#"{"query":"synthetic"}"#),
                    tool_message("c2", r#"{"exhaustive":true,"occurrences":[]}"#),
                ],
                r#"{"exhaustive":true,"occurrences":[]}"#.len(),
            ),
            (
                "reader-side-effect",
                vec![
                    profile.clone(),
                    Message::user("Move the reader to the target"),
                    assistant_call("c3", "reader.gotoLid", r#"{"lid":"1.2"}"#),
                    tool_message("c3", r#"{"ok":true,"anchor_lid":"1.2"}"#),
                ],
                r#"{"ok":true,"anchor_lid":"1.2"}"#.len(),
            ),
            (
                "long-tool-body",
                vec![
                    profile,
                    Message::user("Inspect the synthetic long body"),
                    assistant_call("c4", "book.text", r#"{"lid":"1.long"}"#),
                    tool_message("c4", &"x".repeat(16 * 1024)),
                ],
                16 * 1024,
            ),
        ];
        let tools = vec![
            tool("book.text"),
            tool("book.search_text"),
            tool("reader.gotoLid"),
        ];

        for (name, messages, expected_tool_body_bytes) in fixtures {
            let mut first = AgentRequestAudit::default();
            let request = first.begin_request(&messages, &tools, 17);
            first.finish_request(request, Some(11), 11, 28);

            let mut second = AgentRequestAudit::default();
            let request = second.begin_request(&messages, &tools, 17);
            second.finish_request(request, Some(11), 11, 28);

            assert_eq!(first, second, "fixture {name} must be deterministic");
            let request = &first.requests[0];
            assert_eq!(request.profile_snapshot_count, 1, "fixture {name}");
            assert_eq!(
                request.tool_body_bytes, expected_tool_body_bytes,
                "fixture {name}"
            );
            assert!(request.active_input_estimated_tokens > 0, "fixture {name}");
            assert_eq!(
                request.cumulative_billed_tokens_before, 17,
                "fixture {name}"
            );
            assert_eq!(request.cumulative_billed_tokens_after, 28, "fixture {name}");
        }
    }
}
