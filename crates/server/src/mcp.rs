use crate::{err_reply, ok_json, validation, AppState, Reply};
use read_tools::{RankedStep, ToolError};
use runtime::{
    book_guide, query, synthesize, BookGuideRequest, BookGuideResponse, BookGuideSessionContext,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const DEFAULT_VISITOR_SESSION_TIMEOUT_MS: u128 = 30 * 60 * 1000;

pub const TOOL_NAMES: &[&str] = &[
    "book_manifest",
    "book_text",
    "book_context",
    "book_concept",
    "book_structure",
    "book_guide_path",
    "book_paper_metadata",
    "book_paper_lexicon",
    "book_paper_reading_guide",
    "book_query",
    "book_synthesize",
    "book_guide",
];

#[derive(Debug, Clone, Serialize)]
pub struct VisitorExchange {
    pub intent: String,
    pub response_summary: String,
    pub route_lids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VisitorCursor {
    pub at_lid: String,
    pub last_frontier: Vec<RankedStep>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VisitorSession {
    pub session_id: String,
    pub book_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_intent: Option<String>,
    pub transcript: Vec<VisitorExchange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<VisitorCursor>,
    pub opened_at: u128,
    pub last_active_at: u128,
}

#[derive(Debug, Clone)]
pub struct VisitorSessions {
    next_id: u64,
    sessions: BTreeMap<String, VisitorSession>,
    timeout_ms: u128,
}

impl Default for VisitorSessions {
    fn default() -> Self {
        VisitorSessions {
            next_id: 1,
            sessions: BTreeMap::new(),
            timeout_ms: DEFAULT_VISITOR_SESSION_TIMEOUT_MS,
        }
    }
}

impl VisitorSessions {
    pub fn with_timeout_ms(timeout_ms: u128) -> Self {
        VisitorSessions {
            timeout_ms,
            ..VisitorSessions::default()
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn get(&self, session_id: &str) -> Option<&VisitorSession> {
        self.sessions.get(session_id)
    }

    fn get_mut(&mut self, session_id: &str) -> Option<&mut VisitorSession> {
        self.sessions.get_mut(session_id)
    }

    fn open(&mut self, book_id: &str, declared_intent: Option<String>, now_ms: u128) -> String {
        let session_id = format!("visitor-{}", self.next_id);
        self.next_id += 1;
        self.sessions.insert(
            session_id.clone(),
            VisitorSession {
                session_id: session_id.clone(),
                book_id: book_id.to_string(),
                declared_intent,
                transcript: Vec::new(),
                cursor: None,
                opened_at: now_ms,
                last_active_at: now_ms,
            },
        );
        session_id
    }

    fn close(&mut self, session_id: &str) -> Option<VisitorSession> {
        self.sessions.remove(session_id)
    }

    pub fn gc_expired(&mut self, now_ms: u128) -> usize {
        let before = self.sessions.len();
        let timeout = self.timeout_ms;
        self.sessions
            .retain(|_, s| now_ms.saturating_sub(s.last_active_at) <= timeout);
        before - self.sessions.len()
    }
}

pub fn parse_now_ms(now: &str) -> u128 {
    now.trim().parse::<u128>().unwrap_or(0)
}

pub fn tools_list_result() -> Value {
    json!({
        "tools": [
            tool_schema("book_manifest", "Return the read-only book manifest.", json!({})),
            tool_schema("book_text", "Return source text for a LID or LID range.", json!({
                "lid": {"type": "string"},
                "end_lid": {"type": "string"}
            })),
            tool_schema("book_context", "Return deterministic context around a LID.", json!({
                "lid": {"type": "string"},
                "granularity": {"type": "string"},
                "k": {"type": "integer", "minimum": 0}
            })),
            tool_schema("book_concept", "Return occurrences and related entities for a concept.", json!({
                "name": {"type": "string"}
            })),
            tool_schema("book_structure", "Return the public BookStructure projection for a LID.", json!({
                "at": {"type": "string"}
            })),
            tool_schema("book_guide_path", "Return the public BookStructure guide path.", json!({
                "at": {"type": "string"}
            })),
            tool_schema("book_paper_metadata", "Return the current single paper metadata projection.", json!({})),
            tool_schema("book_paper_lexicon", "Return the current single paper lexicon projection.", json!({})),
            tool_schema("book_paper_reading_guide", "Return the paper reading projection for the current single book.", json!({
                "mode": {"type": "string", "enum": ["skim", "close", "deep"]},
                "stage": {"type": "string", "enum": ["passive", "active", "critical", "creative"]}
            })),
            tool_schema("book_query", "Answer a question using explicit book evidence near anchor_lid.", json!({
                "q": {"type": "string"},
                "anchor_lid": {"type": "string"}
            })),
            tool_schema("book_synthesize", "Synthesize explicit LIDs without expanding evidence scope.", json!({
                "lids": {"type": "array", "items": {"type": "string"}},
                "task": {"type": "string"}
            })),
            tool_schema("book_guide", "Open/refine/close an ephemeral visitor guide session.", json!({
                "action": {"type": "string", "enum": ["guide", "close"]},
                "session_id": {"type": "string"},
                "intent": {"type": "string"},
                "anchor_lid": {"type": "string"},
                "feedback": {"type": "string"}
            }))
        ]
    })
}

fn tool_schema(name: &str, description: &str, properties: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "additionalProperties": false
        }
    })
}

pub fn dispatch_mcp_tool(state: &mut AppState, name: &str, arguments: Value, now: &str) -> Reply {
    let now_ms = parse_now_ms(now);
    state.visitor_sessions.gc_expired(now_ms);

    match name {
        "book_manifest" => ok_json(&state.book.manifest()),
        "book_text" => route_book_text(state, &arguments),
        "book_context" => route_book_context(state, &arguments),
        "book_concept" => route_book_concept(state, &arguments),
        "book_structure" => route_book_structure(state, &arguments),
        "book_guide_path" => route_book_guide_path(state, &arguments),
        "book_paper_metadata" => route_book_paper_metadata(state),
        "book_paper_lexicon" => route_book_paper_lexicon(state),
        "book_paper_reading_guide" => route_book_paper_reading_guide(state, &arguments),
        "book_query" => route_book_query(state, &arguments),
        "book_synthesize" => route_book_synthesize(state, &arguments),
        "book_guide" => route_book_guide(state, &arguments, now_ms),
        _ => mcp_tool_not_found(name),
    }
}

fn route_book_text(state: &AppState, args: &Value) -> Reply {
    let lid = match required_str(args, "lid") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let end_lid = match optional_str(args, "end_lid") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state.book.text(&lid, end_lid.as_deref()) {
        Ok(text) => ok_json(&json!({ "lid": lid, "text": text })),
        Err(e) => err_reply(&e),
    }
}

fn route_book_context(state: &AppState, args: &Value) -> Reply {
    let lid = match required_str(args, "lid") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let granularity = match optional_str(args, "granularity") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let k = match optional_usize(args, "k") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state.book.context(&lid, granularity.as_deref(), k) {
        Ok(ctx) => ok_json(&ctx),
        Err(e) => err_reply(&e),
    }
}

fn route_book_concept(state: &AppState, args: &Value) -> Reply {
    let name = match required_str(args, "name") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state.book.concept(&name) {
        Ok(concept) => ok_json(&concept),
        Err(e) => err_reply(&e),
    }
}

fn route_book_structure(state: &AppState, args: &Value) -> Reply {
    let at = match optional_str(args, "at") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state.book.structure(at.as_deref()) {
        Ok(projection) => ok_json(&projection),
        Err(e) => err_reply(&e),
    }
}

fn route_book_guide_path(state: &AppState, args: &Value) -> Reply {
    let at = match optional_str(args, "at") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state.book.guide_path(at.as_deref()) {
        Ok(path) => ok_json(&path),
        Err(e) => err_reply(&e),
    }
}

fn route_book_paper_metadata(state: &AppState) -> Reply {
    ok_json(&state.book.paper_metadata_projection())
}

fn route_book_paper_lexicon(state: &AppState) -> Reply {
    ok_json(&state.book.paper_lexicon_projection())
}

fn route_book_paper_reading_guide(state: &AppState, args: &Value) -> Reply {
    let mode = match optional_str(args, "mode") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let stage = match optional_str(args, "stage") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match state
        .book
        .paper_reading_guide(mode.as_deref(), stage.as_deref())
    {
        Ok(guide) => ok_json(&guide),
        Err(e) => err_reply(&e),
    }
}

fn route_book_query(state: &AppState, args: &Value) -> Reply {
    let q = match required_str(args, "q") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let anchor = match required_str(args, "anchor_lid") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match query(&state.book, &q, &anchor, state.adapter.as_ref()) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}

fn route_book_synthesize(state: &AppState, args: &Value) -> Reply {
    let lids = match required_string_array(args, "lids") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let task = match optional_str(args, "task") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match synthesize(&state.book, &lids, task.as_deref(), state.adapter.as_ref()) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}

fn route_book_guide(state: &mut AppState, args: &Value, now_ms: u128) -> Reply {
    let action = match optional_str(args, "action") {
        Ok(Some(v)) => v,
        Ok(None) => "guide".to_string(),
        Err(r) => return r,
    };
    if action == "close" {
        let session_id = match required_str(args, "session_id") {
            Ok(v) => v,
            Err(r) => return r,
        };
        return match state.visitor_sessions.close(&session_id) {
            Some(_) => ok_json(&json!({ "ok": true, "closed": true, "session_id": session_id })),
            None => visitor_session_not_found(&session_id),
        };
    }
    if action != "guide" {
        return validation("INVALID_RANGE", "book_guide action 只支持 guide/close");
    }

    let intent = match required_str(args, "intent") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let feedback = match optional_str(args, "feedback") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let anchor_lid = match optional_str(args, "anchor_lid") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let session_arg = match optional_str(args, "session_id") {
        Ok(v) => v,
        Err(r) => return r,
    };

    let (session_id, opened) = match session_arg {
        Some(session_id) => {
            let Some(session) = state.visitor_sessions.get(&session_id) else {
                return visitor_session_not_found(&session_id);
            };
            if session.book_id != state.book.base.book_id {
                return validation(
                    "INVALID_RANGE",
                    "VisitorSession 所属 book 与当前 book 不一致",
                );
            }
            (session_id, false)
        }
        None => {
            let session_id =
                state
                    .visitor_sessions
                    .open(&state.book.base.book_id, Some(intent.clone()), now_ms);
            (session_id, true)
        }
    };

    let Some(session_snapshot) = state.visitor_sessions.get(&session_id).cloned() else {
        return visitor_session_not_found(&session_id);
    };
    let ctx = session_context(&session_snapshot);
    let mut guide_intent = intent.clone();
    if let Some(feedback) = &feedback {
        guide_intent.push_str("\n反馈:");
        guide_intent.push_str(feedback);
    }
    let guide = match book_guide(
        &state.book,
        BookGuideRequest {
            intent: guide_intent,
            anchor_lid,
        },
        Some(&ctx),
        state.adapter.as_ref(),
    ) {
        Ok(guide) => guide,
        Err(e) => return err_reply(&e),
    };
    update_session_after_guide(
        &mut state.visitor_sessions,
        &session_id,
        &intent,
        feedback,
        &guide,
        now_ms,
    );
    ok_json(&json!({
        "session_id": session_id,
        "opened": opened,
        "guide": guide
    }))
}

fn session_context(session: &VisitorSession) -> BookGuideSessionContext {
    BookGuideSessionContext {
        cursor_at_lid: session.cursor.as_ref().map(|c| c.at_lid.clone()),
        last_frontier: session
            .cursor
            .as_ref()
            .map(|c| c.last_frontier.clone())
            .unwrap_or_default(),
        transcript_tail: session
            .transcript
            .iter()
            .map(|x| {
                let route = if x.route_lids.is_empty() {
                    "route=[]".to_string()
                } else {
                    format!("route=[{}]", x.route_lids.join(" -> "))
                };
                format!("intent={} {route}", x.intent)
            })
            .collect(),
    }
}

fn update_session_after_guide(
    sessions: &mut VisitorSessions,
    session_id: &str,
    intent: &str,
    feedback: Option<String>,
    guide: &BookGuideResponse,
    now_ms: u128,
) {
    let route_lids: Vec<String> = guide.route.iter().map(|s| s.lid.clone()).collect();
    let at_lid = route_lids
        .first()
        .cloned()
        .unwrap_or_else(|| guide.entry_lid.clone());
    let response_summary = guide
        .answer
        .clone()
        .unwrap_or_else(|| format!("entry={}, route_len={}", guide.entry_lid, guide.route.len()));
    if let Some(session) = sessions.get_mut(session_id) {
        if session.declared_intent.is_none() {
            session.declared_intent = Some(intent.to_string());
        }
        session.last_active_at = now_ms;
        session.cursor = Some(VisitorCursor {
            at_lid,
            last_frontier: guide.frontier.clone(),
        });
        session.transcript.push(VisitorExchange {
            intent: intent.to_string(),
            response_summary,
            route_lids,
            feedback,
        });
    }
}

fn object_args(args: &Value) -> Result<&Map<String, Value>, Reply> {
    args.as_object()
        .ok_or_else(|| validation("INVALID_RANGE", "MCP tool arguments 必须是 JSON object"))
}

fn required_str(args: &Value, key: &str) -> Result<String, Reply> {
    let obj = object_args(args)?;
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| validation("INVALID_RANGE", &format!("缺少字符串参数 {key}")))
}

fn optional_str(args: &Value, key: &str) -> Result<Option<String>, Reply> {
    let obj = object_args(args)?;
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| validation("INVALID_RANGE", &format!("{key} 必须是字符串"))),
    }
}

fn optional_usize(args: &Value, key: &str) -> Result<Option<usize>, Reply> {
    let obj = object_args(args)?;
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(|n| Some(n as usize))
            .ok_or_else(|| validation("INVALID_K", &format!("{key} 必须是非负整数"))),
    }
}

fn required_string_array(args: &Value, key: &str) -> Result<Vec<String>, Reply> {
    let obj = object_args(args)?;
    let Some(arr) = obj.get(key).and_then(|v| v.as_array()) else {
        return Err(validation(
            "INVALID_RANGE",
            &format!("缺少字符串数组参数 {key}"),
        ));
    };
    let out: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if out.len() != arr.len() {
        return Err(validation(
            "INVALID_RANGE",
            &format!("{key} 必须全是字符串"),
        ));
    }
    Ok(out)
}

fn mcp_tool_not_found(name: &str) -> Reply {
    err_reply(&ToolError {
        error_code: "TOOL_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("未知 MCP 工具: {name}"),
    })
}

fn visitor_session_not_found(session_id: &str) -> Reply {
    err_reply(&ToolError {
        error_code: "VISITOR_SESSION_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("访客会话不存在或已关闭: {session_id}"),
    })
}

pub fn handle_jsonrpc_message(state: &mut AppState, line: &str, now: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return Some(jsonrpc_error(
                Value::Null,
                -32700,
                format!("Parse error: {e}"),
                Value::Null,
            ));
        }
    };
    let id = msg.get("id").cloned();
    let method = match msg.get("method").and_then(|v| v.as_str()) {
        Some(m) => m,
        None => {
            return Some(jsonrpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid Request",
                Value::Null,
            ));
        }
    };

    if method == "notifications/initialized" {
        return None;
    }
    let response_id = id.unwrap_or(Value::Null);
    match method {
        "initialize" => Some(jsonrpc_success(
            response_id,
            json!({
                "protocolVersion": msg
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("2025-11-25"),
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "understand-book",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )),
        "tools/list" => Some(jsonrpc_success(response_id, tools_list_result())),
        "tools/call" => Some(handle_tools_call(
            state,
            response_id,
            msg.get("params"),
            now,
        )),
        _ => Some(jsonrpc_error(
            response_id,
            -32601,
            format!("Method not found: {method}"),
            Value::Null,
        )),
    }
}

fn handle_tools_call(state: &mut AppState, id: Value, params: Option<&Value>, now: &str) -> Value {
    let Some(params) = params.and_then(|p| p.as_object()) else {
        return jsonrpc_error(
            id,
            -32602,
            "tools/call params must be an object",
            Value::Null,
        );
    };
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return jsonrpc_error(
            id,
            -32602,
            "tools/call params.name must be a string",
            Value::Null,
        );
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let reply = dispatch_mcp_tool(state, name, arguments, now);
    let body: Value =
        serde_json::from_str(&reply.body).unwrap_or_else(|_| json!({ "text": reply.body }));
    jsonrpc_success(
        id,
        json!({
            "content": [{"type": "text", "text": reply.body}],
            "structuredContent": body,
            "isError": reply.status != 200
        }),
    )
}

fn jsonrpc_success(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
            "data": data
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UnconfiguredAdapter;
    use base_schema::{
        Direction, EdgeScope, GraphEdge, GraphNode, GraphNodeType, LidNode, NodeKind, ReadOnlyBase,
        Span,
    };
    use memory::{
        Applicability, CreateProfileFact, EvidenceRef, FactSource, MemoryStore, PreferenceClaim,
        ProfilePayload, ProfileScope, Sensitivity,
    };
    use read_tools::Book;
    use reader::{Reader, DEFAULT_RADIUS};
    use runtime::orchestrator::new_session;
    use runtime::{
        AdapterError, AssistantTurn, CompletionRequest, Message, ModelAdapter, ParsedResponse,
        RawCitation, ToolSpec,
    };
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    struct StubAdapter;
    struct CompleteRecordingAdapter {
        requests: Arc<Mutex<Vec<CompletionRequest>>>,
    }

    impl ModelAdapter for StubAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Ok(ParsedResponse {
                sufficient: true,
                answer: Some("从入口开始沿结构边阅读。".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            })
        }

        fn chat(
            &self,
            _messages: &[Message],
            _tools: &[ToolSpec],
        ) -> Result<AssistantTurn, AdapterError> {
            Err(AdapterError {
                message: "not used".into(),
            })
        }
    }

    impl ModelAdapter for CompleteRecordingAdapter {
        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.requests.lock().unwrap().push(req);
            Ok(ParsedResponse {
                sufficient: true,
                answer: Some("public visitor answer".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            })
        }

        fn chat(
            &self,
            _messages: &[Message],
            _tools: &[ToolSpec],
        ) -> Result<AssistantTurn, AdapterError> {
            Err(AdapterError {
                message: "not used".into(),
            })
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-server-mcp-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn book() -> Book {
        let source = "A".repeat(100) + &"B".repeat(100) + &"C".repeat(100);
        let base = ReadOnlyBase {
            book_id: "mcp-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 300 },
                    children: vec!["1.1".into(), "1.2".into(), "1.3".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 100 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Paragraph,
                    span: Span {
                        start: 100,
                        end: 200,
                    },
                    children: vec![],
                },
                LidNode {
                    lid: "1.3".into(),
                    path: vec![1, 3],
                    kind: NodeKind::Paragraph,
                    span: Span {
                        start: 200,
                        end: 300,
                    },
                    children: vec![],
                },
            ],
            graph_nodes: vec![
                GraphNode {
                    id: "entity:alpha".into(),
                    node_type: GraphNodeType::Entity,
                    name: "alpha".into(),
                    occurrences: vec!["1.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:beta".into(),
                    node_type: GraphNodeType::Entity,
                    name: "beta".into(),
                    occurrences: vec!["1.2".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:gamma".into(),
                    node_type: GraphNodeType::Entity,
                    name: "gamma".into(),
                    occurrences: vec!["1.3".into()],
                    source_lid: None,
                },
            ],
            graph_edges: vec![
                GraphEdge {
                    source: "entity:alpha".into(),
                    target: "entity:beta".into(),
                    edge_type: "builds_on".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.9,
                },
                GraphEdge {
                    source: "entity:alpha".into(),
                    target: "entity:gamma".into(),
                    edge_type: "exemplifies".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.8,
                },
            ],
        };
        Book::new(base, &source)
    }

    fn state(timeout_ms: Option<u128>) -> AppState {
        let book = book();
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        AppState {
            book_dir: std::env::temp_dir(),
            library_root: None,
            book,
            reader,
            store: MemoryStore::open(tmp("memory")).unwrap(),
            adapter: Box::new(StubAdapter),
            messages: new_session(),
            session_path: None,
            history_path: None,
            agent_history: crate::AgentHistory::default(),
            profile_context_cache: runtime::profile_context::ProfileContextCache::default(),
            visitor_sessions: timeout_ms
                .map(VisitorSessions::with_timeout_ms)
                .unwrap_or_default(),
            workbench_loaded_revision: None,
        }
    }

    #[test]
    fn tools_list_excludes_private_and_bare_route_tools() {
        let names: Vec<String> = tools_list_result()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"book_guide".to_string()));
        assert!(names.contains(&"book_structure".to_string()));
        assert!(names.contains(&"book_guide_path".to_string()));
        assert!(names.contains(&"book_paper_metadata".to_string()));
        assert!(names.contains(&"book_paper_lexicon".to_string()));
        assert!(names.contains(&"book_paper_reading_guide".to_string()));
        assert!(!names.iter().any(|n| n.starts_with("reader")));
        assert!(!names.iter().any(|n| n.starts_with("memory")));
        assert!(!names.iter().any(|n| n.starts_with("profile")));
        assert!(!names.contains(&"book_route_from".to_string()));
        assert!(!names.contains(&"book_route_to".to_string()));
        assert!(!names.iter().any(|n| n.contains("cross_paper")));
        assert!(!names.iter().any(|n| n.contains("corpus")));
    }

    #[test]
    fn tier1_readonly_calls_do_not_create_visitor_session() {
        let mut s = state(None);
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_manifest", json!({}), "1000").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_structure", json!({"at":"1.1"}), "1001").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_guide_path", json!({"at":"1.1"}), "1002").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_paper_metadata", json!({}), "1003").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_paper_lexicon", json!({}), "1004").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
        let paper = dispatch_mcp_tool(
            &mut s,
            "book_paper_reading_guide",
            json!({"mode":"close", "stage":"active"}),
            "1005",
        );
        assert_eq!(paper.status, 200);
        assert!(paper.body.contains("\"available\":false"));
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(
                &mut s,
                "book_query",
                json!({"q":"alpha 是什么", "anchor_lid":"1.1"}),
                "1006"
            )
            .status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
    }

    #[test]
    fn visitor_dispatch_has_no_reader_or_memory_branch() {
        let mut s = state(None);
        let r = dispatch_mcp_tool(&mut s, "reader.goto", json!({"lid":"1.1"}), "1000");
        assert_eq!(r.status, 404);
        assert!(r.body.contains("TOOL_NOT_FOUND"));
        assert_eq!(s.visitor_sessions.len(), 0);
    }

    #[test]
    fn visitor_guide_never_reads_or_injects_reader_private_profile() {
        let mut s = state(None);
        s.store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "private".into(),
                        value: "PRIVATE_VISITOR_SENTINEL".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "seed".into(),
                        turn_id: "turn".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let revision = s.store.projection_revision();
        let requests = Arc::new(Mutex::new(Vec::new()));
        s.adapter = Box::new(CompleteRecordingAdapter {
            requests: Arc::clone(&requests),
        });

        let reply = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"intent":"public route", "anchor_lid":"1.1"}),
            "1000",
        );
        assert_eq!(reply.status, 200, "{}", reply.body);
        let requests = requests.lock().unwrap();
        assert!(!requests.is_empty());
        let serialized = requests
            .iter()
            .map(|request| format!("{}\n{}", request.system, request.user))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!serialized.contains("reader_profile_snapshot.v1"));
        assert!(!serialized.contains("PRIVATE_VISITOR_SENTINEL"));
        assert_eq!(s.store.projection_revision(), revision);
        assert_eq!(s.store.profile_facts().len(), 1);
    }

    #[test]
    fn book_guide_opens_refines_and_closes_ephemeral_session() {
        let mut s = state(None);
        let first = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"intent":"带我理解 alpha", "anchor_lid":"1.1"}),
            "1000",
        );
        assert_eq!(first.status, 200);
        assert_eq!(s.visitor_sessions.len(), 1);
        let v: Value = serde_json::from_str(&first.body).unwrap();
        let session_id = v["session_id"].as_str().unwrap().to_string();
        assert_eq!(v["opened"].as_bool(), Some(true));
        assert!(v["guide"]["route"].as_array().unwrap().len() >= 1);

        let refine = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"session_id":session_id, "intent":"不对,换一条"}),
            "1001",
        );
        assert_eq!(refine.status, 200);
        let refined: Value = serde_json::from_str(&refine.body).unwrap();
        assert_eq!(refined["opened"].as_bool(), Some(false));
        assert_eq!(refined["guide"]["refined"].as_bool(), Some(true));
        assert_eq!(s.visitor_sessions.len(), 1);

        let close = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"action":"close", "session_id":session_id}),
            "1002",
        );
        assert_eq!(close.status, 200);
        assert_eq!(s.visitor_sessions.len(), 0);
    }

    #[test]
    fn concurrent_visitor_sessions_are_isolated() {
        let mut s = state(None);
        let a = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"intent":"alpha path", "anchor_lid":"1.1"}),
            "1000",
        );
        let b = dispatch_mcp_tool(
            &mut s,
            "book_guide",
            json!({"intent":"beta path", "anchor_lid":"1.2"}),
            "1001",
        );
        assert_eq!(a.status, 200);
        assert_eq!(b.status, 200);
        assert_eq!(s.visitor_sessions.len(), 2);

        let av: Value = serde_json::from_str(&a.body).unwrap();
        let bv: Value = serde_json::from_str(&b.body).unwrap();
        let aid = av["session_id"].as_str().unwrap();
        let bid = bv["session_id"].as_str().unwrap();
        assert_ne!(aid, bid);
        let a_session = s.visitor_sessions.get(aid).unwrap();
        let b_session = s.visitor_sessions.get(bid).unwrap();
        assert_eq!(a_session.declared_intent.as_deref(), Some("alpha path"));
        assert_eq!(b_session.declared_intent.as_deref(), Some("beta path"));
        assert_ne!(
            a_session.cursor.as_ref().map(|c| c.at_lid.as_str()),
            b_session.cursor.as_ref().map(|c| c.at_lid.as_str())
        );
    }

    #[test]
    fn expired_visitor_sessions_are_gc_during_dispatch() {
        let mut s = state(Some(10));
        assert_eq!(
            dispatch_mcp_tool(
                &mut s,
                "book_guide",
                json!({"intent":"带我理解 alpha", "anchor_lid":"1.1"}),
                "1000"
            )
            .status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 1);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_manifest", json!({}), "1011").status,
            200
        );
        assert_eq!(s.visitor_sessions.len(), 0);
    }

    #[test]
    fn jsonrpc_tools_call_wraps_tool_result() {
        let mut s = state(None);
        let resp = handle_jsonrpc_message(
            &mut s,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"book_manifest","arguments":{}}}"#,
            "1000",
        )
        .unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["isError"], false);
    }

    #[test]
    fn unconfigured_adapter_errors_do_not_create_tier1_session() {
        let mut s = state(None);
        s.adapter = Box::new(UnconfiguredAdapter);
        let r = dispatch_mcp_tool(
            &mut s,
            "book_query",
            json!({"q":"x", "anchor_lid":"1.1"}),
            "1000",
        );
        assert_eq!(r.status, 502);
        assert_eq!(s.visitor_sessions.len(), 0);
    }
}
