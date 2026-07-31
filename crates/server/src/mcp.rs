use crate::intent_build_store::IntentArtifactStore;
use crate::{err_reply, ok_json, validation, AppState, Reply};
use artifact_tools::{
    artifact_list_input_schema, artifact_read_input_schema, artifact_search_input_schema,
    validate_artifact_list_input, validate_artifact_read_input, validate_artifact_search_input,
    ArtifactAccessSnapshot, ArtifactToolError, ArtifactToolId, ARTIFACT_CURSOR_INVALID,
    ARTIFACT_LIST_MCP_ALIAS, ARTIFACT_OVERLAY_UNAVAILABLE, ARTIFACT_READ_MCP_ALIAS,
    ARTIFACT_RECORD_REF_INVALID, ARTIFACT_REF_INVALID, ARTIFACT_RESULT_TOO_LARGE,
    ARTIFACT_SEARCH_MCP_ALIAS, ARTIFACT_SNAPSHOT_INVALID, ARTIFACT_TOOL_INPUT_INVALID,
};
use book_tool_contracts::{
    contracts, from_mcp_alias, input_schema, validate_input, BookToolId, BookToolInput,
    GuideAction, GuideInput,
};
use read_tools::{Book, RankedStep, ToolError};
use runtime::{
    book_guide, parse_book_query_request, query, synthesize, BookGuideRequest, BookGuideResponse,
    BookGuideSessionContext,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const DEFAULT_VISITOR_SESSION_TIMEOUT_MS: u128 = 30 * 60 * 1000;

const ARTIFACT_MCP_TOOLS: [(ArtifactToolId, &str, &str); 3] = [
    (
        ArtifactToolId::List,
        ARTIFACT_LIST_MCP_ALIAS,
        "List bounded Routing Cards for the current active accepted artifact overlay.",
    ),
    (
        ArtifactToolId::Search,
        ARTIFACT_SEARCH_MCP_ALIAS,
        "Search current active accepted artifacts with deterministic bounded lexical ranking.",
    ),
    (
        ArtifactToolId::Read,
        ARTIFACT_READ_MCP_ALIAS,
        "Read bounded records from a current active accepted artifact by opaque reference.",
    ),
];

pub trait ArtifactSnapshotReadPort: Send {
    fn read_current_snapshot(&self) -> Result<ArtifactAccessSnapshot, ToolError>;
}

pub struct BookMcpArtifactReadPort {
    book_dir: PathBuf,
    bound_book_id: String,
    store_root: PathBuf,
}

impl BookMcpArtifactReadPort {
    pub fn new(book_dir: PathBuf, bound_book_id: String, store_root: PathBuf) -> Self {
        Self {
            book_dir,
            bound_book_id,
            store_root,
        }
    }

    pub fn from_default(book_dir: PathBuf, bound_book_id: String) -> Result<Self, ToolError> {
        Ok(Self::new(
            book_dir,
            bound_book_id,
            IntentArtifactStore::default_root()?,
        ))
    }
}

impl ArtifactSnapshotReadPort for BookMcpArtifactReadPort {
    fn read_current_snapshot(&self) -> Result<ArtifactAccessSnapshot, ToolError> {
        let book_dir = self.book_dir.to_str().ok_or_else(|| {
            artifact_overlay_unavailable("bound Book MCP directory is not valid UTF-8")
        })?;
        let current_book = Book::load(book_dir).map_err(|error| {
            artifact_overlay_unavailable(format!(
                "bound Book MCP source is not currently readable: {error}"
            ))
        })?;
        if current_book.base.book_id != self.bound_book_id {
            return Err(artifact_overlay_unavailable(
                "bound Book MCP directory now resolves to a different book",
            ));
        }
        IntentArtifactStore::open(&self.store_root)?.read_active_artifact_access_snapshot(
            &self.bound_book_id,
            current_book.source_fingerprint(),
        )
    }
}

pub fn tool_names() -> Vec<&'static str> {
    let mut names = contracts()
        .iter()
        .filter_map(|contract| contract.aliases.mcp)
        .collect::<Vec<_>>();
    names.extend(ARTIFACT_MCP_TOOLS.iter().map(|(_, name, _)| *name));
    names
}

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
    let mut tools: Vec<_> = contracts()
        .iter()
        .filter_map(|contract| {
            contract.aliases.mcp.map(|name| {
                json!({
                    "name": name,
                    "description": contract.description,
                    "inputSchema": input_schema(contract.id),
                })
            })
        })
        .collect();
    tools.extend(ARTIFACT_MCP_TOOLS.iter().map(|(id, name, description)| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": artifact_input_schema(*id),
        })
    }));
    json!({ "tools": tools })
}

pub fn dispatch_mcp_tool(state: &mut AppState, name: &str, arguments: Value, now: &str) -> Reply {
    let now_ms = parse_now_ms(now);
    state.visitor_sessions.gc_expired(now_ms);

    if let Some(id) = artifact_tool_from_mcp_alias(name) {
        return dispatch_artifact_tool(state, id, arguments);
    }

    let Some(id) = from_mcp_alias(name) else {
        return mcp_tool_not_found(name);
    };
    if id == BookToolId::Query {
        return route_book_query(state, &arguments);
    }
    let input = match validate_input(id, arguments) {
        Ok(input) => input,
        Err(error) => return validation(error.code, &error.message),
    };
    match (id, input) {
        (BookToolId::Manifest, BookToolInput::Empty(_)) => ok_json(&state.book.manifest()),
        (BookToolId::Text, BookToolInput::Text(input)) => route_book_text(state, input),
        (BookToolId::SearchText, BookToolInput::SearchText(input)) => {
            match state.book.search_text(&input) {
                Ok(result) => ok_json(&result),
                Err(error) => err_reply(&error),
            }
        }
        (BookToolId::Context, BookToolInput::Context(input)) => route_book_context(state, input),
        (BookToolId::Concept, BookToolInput::Concept(input)) => route_book_concept(state, input),
        (BookToolId::Structure, BookToolInput::At(input)) => route_book_structure(state, input),
        (BookToolId::GuidePath, BookToolInput::At(input)) => route_book_guide_path(state, input),
        (BookToolId::PaperMetadata, BookToolInput::Empty(_)) => route_book_paper_metadata(state),
        (BookToolId::PaperLexicon, BookToolInput::Empty(_)) => route_book_paper_lexicon(state),
        (BookToolId::PaperReadingGuide, BookToolInput::PaperReadingGuide(input)) => {
            route_book_paper_reading_guide(state, input)
        }
        (BookToolId::Synthesize, BookToolInput::Synthesize(input)) => {
            route_book_synthesize(state, input)
        }
        (BookToolId::Guide, BookToolInput::Guide(input)) => route_book_guide(state, input, now_ms),
        _ => validation(
            "BOOK_TOOL_CONTRACT_INVALID",
            "MCP Book tool resolved to an incompatible input contract",
        ),
    }
}

fn artifact_tool_from_mcp_alias(name: &str) -> Option<ArtifactToolId> {
    ARTIFACT_MCP_TOOLS
        .iter()
        .find_map(|(id, alias, _)| (*alias == name).then_some(*id))
}

fn artifact_input_schema(id: ArtifactToolId) -> Value {
    match id {
        ArtifactToolId::List => artifact_list_input_schema(),
        ArtifactToolId::Search => artifact_search_input_schema(),
        ArtifactToolId::Read => artifact_read_input_schema(),
    }
}

fn dispatch_artifact_tool(state: &AppState, id: ArtifactToolId, arguments: Value) -> Reply {
    match id {
        ArtifactToolId::List => {
            let input = match validate_artifact_list_input(arguments) {
                Ok(input) => input,
                Err(error) => return err_reply(&artifact_tool_error(error)),
            };
            let snapshot = match current_artifact_snapshot(state) {
                Ok(snapshot) => snapshot,
                Err(error) => return err_reply(&error),
            };
            match snapshot.list(input) {
                Ok(result) => ok_json(&result),
                Err(error) => err_reply(&artifact_tool_error(error)),
            }
        }
        ArtifactToolId::Search => {
            let input = match validate_artifact_search_input(arguments) {
                Ok(input) => input,
                Err(error) => return err_reply(&artifact_tool_error(error)),
            };
            let snapshot = match current_artifact_snapshot(state) {
                Ok(snapshot) => snapshot,
                Err(error) => return err_reply(&error),
            };
            match snapshot.search(input) {
                Ok(result) => ok_json(&result),
                Err(error) => err_reply(&artifact_tool_error(error)),
            }
        }
        ArtifactToolId::Read => {
            let input = match validate_artifact_read_input(arguments) {
                Ok(input) => input,
                Err(error) => return err_reply(&artifact_tool_error(error)),
            };
            let snapshot = match current_artifact_snapshot(state) {
                Ok(snapshot) => snapshot,
                Err(error) => return err_reply(&error),
            };
            match snapshot.read(input) {
                Ok(result) => ok_json(&result),
                Err(error) => err_reply(&artifact_tool_error(error)),
            }
        }
    }
}

fn current_artifact_snapshot(state: &AppState) -> Result<ArtifactAccessSnapshot, ToolError> {
    state
        .mcp_artifact_read_port
        .as_ref()
        .ok_or_else(|| artifact_overlay_unavailable("Book MCP has no current artifact overlay"))?
        .read_current_snapshot()
}

fn artifact_tool_error(error: ArtifactToolError) -> ToolError {
    let category = match error.code {
        ARTIFACT_TOOL_INPUT_INVALID
        | ARTIFACT_REF_INVALID
        | ARTIFACT_RECORD_REF_INVALID
        | ARTIFACT_CURSOR_INVALID => "validation",
        ARTIFACT_RESULT_TOO_LARGE => "budget",
        ARTIFACT_OVERLAY_UNAVAILABLE => "unavailable",
        ARTIFACT_SNAPSHOT_INVALID => "data",
        _ => "internal",
    };
    ToolError {
        error_code: error.code.into(),
        category: category.into(),
        message: error.message,
    }
}

fn artifact_overlay_unavailable(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: ARTIFACT_OVERLAY_UNAVAILABLE.into(),
        category: "unavailable".into(),
        message: message.into(),
    }
}

fn route_book_text(state: &AppState, input: book_tool_contracts::TextInput) -> Reply {
    match state.book.text(&input.lid, input.end_lid.as_deref()) {
        Ok(text) => ok_json(&json!({ "lid": input.lid, "text": text })),
        Err(e) => err_reply(&e),
    }
}

fn route_book_context(state: &AppState, input: book_tool_contracts::ContextInput) -> Reply {
    let granularity = input.granularity.map(|value| value.as_str());
    match state.book.context(&input.lid, granularity, input.k) {
        Ok(ctx) => ok_json(&ctx),
        Err(e) => err_reply(&e),
    }
}

fn route_book_concept(state: &AppState, input: book_tool_contracts::ConceptInput) -> Reply {
    match state
        .book
        .concept_candidates(&input.query, input.anchor_lid.as_deref(), input.limit)
    {
        Ok(concept) => ok_json(&concept),
        Err(e) => err_reply(&e),
    }
}

fn route_book_structure(state: &AppState, input: book_tool_contracts::AtInput) -> Reply {
    match state.book.structure(input.at.as_deref()) {
        Ok(projection) => ok_json(&projection),
        Err(e) => err_reply(&e),
    }
}

fn route_book_guide_path(state: &AppState, input: book_tool_contracts::AtInput) -> Reply {
    match state.book.guide_path(input.at.as_deref()) {
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

fn route_book_paper_reading_guide(
    state: &AppState,
    input: book_tool_contracts::PaperReadingGuideInput,
) -> Reply {
    match state
        .book
        .paper_reading_guide(Some(input.mode.as_str()), Some(input.stage.as_str()))
    {
        Ok(guide) => ok_json(&guide),
        Err(e) => err_reply(&e),
    }
}

fn route_book_query(state: &AppState, args: &Value) -> Reply {
    let request = match parse_book_query_request(args.clone()) {
        Ok(request) => request,
        Err(outcome) => return ok_json(&outcome),
    };
    match query(&state.book, &request, state.adapter.as_ref()) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}

fn route_book_synthesize(state: &AppState, input: book_tool_contracts::SynthesizeInput) -> Reply {
    match synthesize(
        &state.book,
        &input.lids,
        input.task.as_deref(),
        state.adapter.as_ref(),
    ) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}

fn route_book_guide(state: &mut AppState, input: GuideInput, now_ms: u128) -> Reply {
    if input.action == GuideAction::Close {
        let session_id = input
            .session_id
            .expect("validated close action must have session_id");
        return match state.visitor_sessions.close(&session_id) {
            Some(_) => ok_json(&json!({ "ok": true, "closed": true, "session_id": session_id })),
            None => visitor_session_not_found(&session_id),
        };
    }
    let intent = input
        .intent
        .expect("validated guide action must have intent");
    let feedback = input.feedback;
    let anchor_lid = input.anchor_lid;
    let session_arg = input.session_id;

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
    use artifact_tools::{
        ArtifactSearchAnalyzer, ArtifactSnapshotBlueprint, ArtifactSnapshotItem,
        ArtifactSnapshotRecord, ArtifactSnapshotScope, ArtifactSnapshotSearchField,
    };
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
        AdapterError, AgentRequestPlan, AssistantTurn, CompletionRequest, ModelAdapter,
        ParsedResponse, RawCitation,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct StubAdapter;
    struct CompleteRecordingAdapter {
        requests: Arc<Mutex<Vec<CompletionRequest>>>,
    }

    struct StubArtifactPort {
        calls: Arc<AtomicUsize>,
        rotate_after_first: bool,
    }

    impl ArtifactSnapshotReadPort for StubArtifactPort {
        fn read_current_snapshot(&self) -> Result<ArtifactAccessSnapshot, ToolError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let revision = if self.rotate_after_first && call > 0 {
                'd'
            } else {
                'c'
            };
            artifact_snapshot(revision)
        }
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

        fn complete_structured(
            &self,
            req: CompletionRequest,
        ) -> Result<serde_json::Value, AdapterError> {
            if req.system.contains("PlanGate") {
                Ok(json!({
                    "plan_gate": {"valid": true, "missing_requirements": [], "target_issues": []},
                    "candidate_fits": [
                        {"target_index": 0, "candidate_id": "entity:alpha", "fit": "direct_match", "reason": "fixture"},
                        {"target_index": 0, "candidate_id": "entity:beta", "fit": "reject", "reason": "fixture"},
                        {"target_index": 0, "candidate_id": "entity:gamma", "fit": "reject", "reason": "fixture"}
                    ],
                    "probes": []
                }))
            } else {
                Ok(json!({
                    "answer": "alpha answer",
                    "assessments": [{
                        "obligation_index": 0,
                        "verdict": "supported",
                        "citation_lids": ["1.1"],
                        "support_note": "fixture"
                    }],
                    "citations": [{"lid": "1.1", "text": "A", "role": "support"}],
                    "model_supplement": []
                }))
            }
        }

        fn chat(&self, _request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
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

        fn chat(&self, _request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
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
            intent_store_root: None,
            mcp_artifact_read_port: None,
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

    fn artifact_snapshot(revision: char) -> Result<ArtifactAccessSnapshot, ToolError> {
        ArtifactAccessSnapshot::new(
            ArtifactSnapshotScope {
                book_id: "mcp-book".into(),
                source_fingerprint: format!("source-{revision}"),
                overlay_identity: revision.to_string().repeat(64),
            },
            vec![ArtifactSnapshotItem {
                artifact_id: "private-artifact-id".into(),
                payload_digest: revision.to_string().repeat(64),
                blueprint: ArtifactSnapshotBlueprint {
                    blueprint_digest: "a".repeat(64),
                    title: "Cardiac index".into(),
                    purpose: "Find cardiac mechanisms.".into(),
                    use_when: vec!["the question concerns cardiac mechanisms".into()],
                    avoid_when: vec!["the user requests source text only".into()],
                    covered_topics: vec!["cardiac biology".into()],
                    scope_label: "confirmed scope".into(),
                    search_fields: vec![ArtifactSnapshotSearchField {
                        path: "/label".into(),
                        weight: 10,
                        analyzer: ArtifactSearchAnalyzer::Text,
                    }],
                    summary_fields: vec!["/label".into()],
                },
                records: vec![ArtifactSnapshotRecord {
                    record_id: "private-record-id".into(),
                    data: json!({"label": "Cardiac splicing", "detail": "accepted artifact"})
                        .as_object()
                        .unwrap()
                        .clone(),
                    evidence_lids: vec!["1.1".into()],
                }],
                relations: vec![],
            }],
        )
        .map_err(artifact_tool_error)
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
        assert!(!names.iter().any(|n| n.contains("intent")));
        assert!(names.contains(&"artifact_list".to_string()));
        assert!(names.contains(&"artifact_search".to_string()));
        assert!(names.contains(&"artifact_read".to_string()));
        assert!(!names.contains(&"artifact_write".to_string()));
        assert!(!names.iter().any(|n| n.contains("overlay")));
    }

    #[test]
    fn mcp_tool_characterization() {
        assert_eq!(
            tool_names(),
            vec![
                "book_manifest",
                "book_text",
                "book_search_text",
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
                "artifact_list",
                "artifact_search",
                "artifact_read",
            ]
        );

        let listed = tools_list_result();
        let tools = listed["tools"].as_array().expect("MCP tools array");
        let schema = |name: &str| {
            &tools
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("missing MCP tool schema: {name}"))["inputSchema"]
        };

        for name in tool_names() {
            assert_eq!(
                schema(name)["additionalProperties"],
                Value::Bool(false),
                "MCP schemas reject unknown properties: {name}"
            );
        }
        assert_eq!(
            schema("book_query")["required"],
            json!(["anchor_lid", "intent", "obligations", "query", "targets"])
        );
        assert_eq!(
            schema("book_paper_reading_guide")["properties"]["mode"]["enum"],
            json!(["skim", "close", "deep"])
        );
        assert_eq!(
            schema("book_paper_reading_guide")["properties"]["stage"]["enum"],
            json!(["passive", "active", "critical", "creative"])
        );

        // Alias differences are intentional transport projection; input contracts
        // are now identical to the Resident registry projection.
        for (name, required) in [
            ("book_text", json!(["lid"])),
            ("book_context", json!(["lid"])),
            ("book_concept", json!(["query"])),
            ("book_synthesize", json!(["lids"])),
        ] {
            assert_eq!(
                schema(name)["required"],
                required,
                "required drift for {name}"
            );
        }
        assert_eq!(
            schema("book_concept")["properties"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["anchor_lid", "limit", "query"]
        );
        assert_eq!(schema("book_concept")["properties"]["limit"]["default"], 12);
        assert_eq!(schema("book_concept")["properties"]["limit"]["minimum"], 1);
        assert_eq!(schema("book_concept")["properties"]["limit"]["maximum"], 50);
        assert_eq!(
            schema("book_context")["properties"]["granularity"]["enum"],
            json!(["near", "mid", "far"])
        );
        assert_eq!(schema("book_search_text")["required"], json!(["query"]));
        assert_eq!(
            schema("book_search_text")["properties"]["match_mode"]["enum"],
            json!(["exact", "normalized"])
        );
        assert_eq!(schema("artifact_list")["additionalProperties"], false);
        assert_eq!(schema("artifact_search")["required"], json!(["query"]));
        assert_eq!(schema("artifact_read")["required"], json!(["artifact_ref"]));

        let mut app = state(None);
        assert_eq!(
            dispatch_mcp_tool(&mut app, "book_text", json!({}), "1000").status,
            400,
            "schema and typed dispatch both require lid"
        );
        let text = dispatch_mcp_tool(&mut app, "book_text", json!({"lid": "1.1"}), "1001");
        assert_eq!(text.status, 200);
        let body: Value = serde_json::from_str(&text.body).expect("book_text JSON response");
        assert_eq!(body["lid"], "1.1");
        assert!(body["text"].is_string());
    }

    #[test]
    fn book_concept_v2_mcp_contract_and_dispatch() {
        let mut app = state(None);
        let response =
            dispatch_mcp_tool(&mut app, "book_concept", json!({"query": "alpha"}), "1000");
        assert_eq!(response.status, 200, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["version"], "book_concept.v2");
        assert_eq!(body["returned_count"], 1);
        assert_eq!(body["candidates"][0]["name"], "alpha");

        for invalid in [
            json!({"name": "command"}),
            json!({"query": "command", "limit": 0}),
            json!({"query": "command", "limit": 51}),
        ] {
            assert_eq!(
                dispatch_mcp_tool(&mut app, "book_concept", invalid, "1001").status,
                400
            );
        }
        assert_eq!(
            dispatch_mcp_tool(
                &mut app,
                "book_concept",
                json!({"query": "not-present"}),
                "1002",
            )
            .status,
            404
        );
    }

    #[test]
    fn artifact_tools_fail_closed_when_overlay_is_unavailable() {
        let mut app = state(None);
        for (name, arguments) in [
            ("artifact_list", json!({})),
            ("artifact_search", json!({"query": "cardiac"})),
            ("artifact_read", json!({"artifact_ref": "ar1_missing"})),
        ] {
            let reply = dispatch_mcp_tool(&mut app, name, arguments, "1000");
            assert_eq!(reply.status, 503, "{name}: {}", reply.body);
            let body: Value = serde_json::from_str(&reply.body).unwrap();
            assert_eq!(body["error_code"], "ARTIFACT_OVERLAY_UNAVAILABLE");
        }

        let invalid = dispatch_mcp_tool(&mut app, "artifact_list", json!({"write": true}), "1001");
        assert_eq!(invalid.status, 400, "{}", invalid.body);
        let invalid_body: Value = serde_json::from_str(&invalid.body).unwrap();
        assert_eq!(invalid_body["error_code"], "ARTIFACT_TOOL_INPUT_INVALID");

        let write = dispatch_mcp_tool(&mut app, "artifact_write", json!({}), "1002");
        assert_eq!(write.status, 404);
        assert!(write.body.contains("TOOL_NOT_FOUND"));
    }

    #[test]
    fn artifact_tools_use_the_shared_executor_and_reread_snapshot_per_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut app = state(None);
        app.mcp_artifact_read_port = Some(Box::new(StubArtifactPort {
            calls: Arc::clone(&calls),
            rotate_after_first: false,
        }));

        let listed = dispatch_mcp_tool(&mut app, "artifact_list", json!({}), "1000");
        assert_eq!(listed.status, 200, "{}", listed.body);
        let listed: Value = serde_json::from_str(&listed.body).unwrap();
        let artifact_ref = listed["artifacts"][0]["artifact_ref"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!listed.to_string().contains("private-artifact-id"));

        let searched = dispatch_mcp_tool(
            &mut app,
            "artifact_search",
            json!({"query": "cardiac splicing"}),
            "1001",
        );
        assert_eq!(searched.status, 200, "{}", searched.body);
        let searched: Value = serde_json::from_str(&searched.body).unwrap();
        let record_ref = searched["hits"][0]["record_ref"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(searched["hits"][0]["data"]["label"], "Cardiac splicing");
        assert!(!searched.to_string().contains("private-record-id"));

        let read = dispatch_mcp_tool(
            &mut app,
            "artifact_read",
            json!({"artifact_ref": artifact_ref, "record_refs": [record_ref]}),
            "1002",
        );
        assert_eq!(read.status, 200, "{}", read.body);
        let read: Value = serde_json::from_str(&read.body).unwrap();
        assert_eq!(read["records"][0]["data"]["detail"], "accepted artifact");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn artifact_refs_fail_closed_after_the_current_snapshot_changes() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut app = state(None);
        app.mcp_artifact_read_port = Some(Box::new(StubArtifactPort {
            calls: Arc::clone(&calls),
            rotate_after_first: true,
        }));

        let listed = dispatch_mcp_tool(&mut app, "artifact_list", json!({}), "1000");
        let listed: Value = serde_json::from_str(&listed.body).unwrap();
        let old_artifact_ref = listed["artifacts"][0]["artifact_ref"].clone();
        let stale_read = dispatch_mcp_tool(
            &mut app,
            "artifact_read",
            json!({"artifact_ref": old_artifact_ref}),
            "1001",
        );
        assert_eq!(stale_read.status, 400, "{}", stale_read.body);
        let stale_read: Value = serde_json::from_str(&stale_read.body).unwrap();
        assert_eq!(stale_read["error_code"], "ARTIFACT_REF_INVALID");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
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
        let search = dispatch_mcp_tool(
            &mut s,
            "book_search_text",
            json!({"query":"AA", "page_size":1}),
            "1001",
        );
        assert_eq!(search.status, 200);
        assert!(search.body.contains("\"total_occurrences\":99"));
        assert_eq!(s.visitor_sessions.len(), 0);
        assert_eq!(
            dispatch_mcp_tool(&mut s, "book_structure", json!({"at":"1.1"}), "1002").status,
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
                json!({
                    "query":"alpha 是什么",
                    "intent":"definition",
                    "targets":["alpha"],
                    "obligations":[{"requirement":"给出 alpha 的定义"}],
                    "anchor_lid":"1.1"
                }),
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

        let unavailable = handle_jsonrpc_message(
            &mut s,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"artifact_list","arguments":{}}}"#,
            "1001",
        )
        .unwrap();
        assert_eq!(unavailable["id"], 2);
        assert_eq!(unavailable["result"]["isError"], true);
        assert_eq!(
            unavailable["result"]["structuredContent"]["error_code"],
            ARTIFACT_OVERLAY_UNAVAILABLE
        );
    }

    #[test]
    fn unconfigured_adapter_errors_do_not_create_tier1_session() {
        let mut s = state(None);
        s.adapter = Box::new(UnconfiguredAdapter);
        let r = dispatch_mcp_tool(
            &mut s,
            "book_query",
            json!({
                "query":"x 是什么",
                "intent":"definition",
                "targets":["x"],
                "obligations":[{"requirement":"定义 x"}],
                "anchor_lid":"1.1"
            }),
            "1000",
        );
        assert_eq!(r.status, 502);
        assert_eq!(s.visitor_sessions.len(), 0);
    }
}
