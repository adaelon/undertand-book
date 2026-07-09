//! 读时 localhost 服务:把冻结命令面投影成 REST `[ADR-0028]`。
//! S10a:`book.*` 四只读叶子 → GET。S10b:`reader.*`/`memory.*` 可变命令 → POST(JSON body),
//! reader.* 返 effect、highlight/note 委托 memory.save(标注单源 `[ADR-0015/0006]`)、非法 LID 透传不降级。
//! S10c:`book.query` 是 LLM 命令(秒级,非确定性叶子)→ **POST**(body `{q, anchor_lid?}`),
//! 直调内层 `runtime::query`(provider 经注入的 `ModelAdapter`)→ 返 `QueryResponse`,结构红线由
//! 内层确定性交叉验停守(citations⊆证据集);anchor 缺省取 reader 当前 anchor(读模式起点)。
//! 路由是**纯函数 `route(&mut AppState, Req) -> Reply`**(脱 socket 可单测,守 A2);
//! socket 绑定 / worker 线程 / Mutex 锁 / 时间戳生成 / adapter 装配在 `main.rs`。
//! 外层 E agent(S10f)、静态资源(S10e)留后续子切片。
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput};
use read_tools::{Book, ContentProfileId, ReaderLayoutAction, ToolError};
use reader::{Reader, DEFAULT_RADIUS};
use runtime::orchestrator::{new_session, run, OuterConfig};
use runtime::{
    guided_route_from, synthesize, unvisited_back, AdapterError, AssistantTurn, CompletionRequest,
    Message, ModelAdapter, ParsedResponse, ToolSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

pub mod mcp;

/// 服务的单会话共享状态(切片0 单用户单书)`[ADR-0028 决策2]`。
/// S10b:持只读 `Book` + 会话态 `Reader` + 用户私有 `MemoryStore`(物理隔离 `[ADR-0006]`)。
/// S10c:持 LLM `adapter`(`book.query` 经它触模型;`+ Send` 供 `Arc<Mutex<_>>` 跨 worker 线程)。
pub struct AppState {
    pub book_dir: PathBuf,
    pub book: Book,
    pub reader: Reader,
    pub store: MemoryStore,
    pub adapter: Box<dyn ModelAdapter + Send>,
    /// 外层 E agent 的当前会话 messages(S10f `[ADR-0030]`)。`/agent/chat` 跨回合累积;
    /// `/agent/new`/history select 会切换到另一份可恢复 session。
    pub messages: Vec<Message>,
    /// 阅读位置持久化文件路径(~/.understand-book/session.json);None 则不持久化。
    pub session_path: Option<PathBuf>,
    /// resident agent 对话历史文件路径(~/.understand-book/memory/agent-history.json);None 则只保存在本进程。
    pub history_path: Option<PathBuf>,
    /// resident agent 的可恢复历史会话。只服务当前人类读者,不写 memory,不开放给访客。
    pub agent_history: AgentHistory,
    /// P7 访客向导会话表:ephemeral ③,只给 MCP `book_guide` 使用,不写 durable memory。
    pub visitor_sessions: mcp::VisitorSessions,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AskQuote {
    pub lid: String,
    pub quote: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentChatTurn {
    pub user: String,
    pub outcome: runtime::orchestrator::OuterOutcome,
    pub question_anchor_lid: Option<String>,
    pub question_quote: Option<AskQuote>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentChatSession {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub turns: Vec<AgentChatTurn>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct AgentHistory {
    #[serde(default)]
    pub active_by_book: BTreeMap<String, String>,
    #[serde(default)]
    pub sessions: Vec<AgentChatSession>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentChatTurnSummary {
    pub user: String,
    pub question_anchor_lid: Option<String>,
    pub question_quote: Option<AskQuote>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentChatSessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: usize,
    pub turns: Vec<AgentChatTurnSummary>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentChatSessionView {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub turns: Vec<AgentChatTurn>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentHistoryResponse {
    pub active_session_id: String,
    pub sessions: Vec<AgentChatSessionSummary>,
    pub current: AgentChatSessionView,
}

fn compact_title(text: &str) -> String {
    let t = text.replace(char::is_whitespace, " ").trim().to_string();
    if t.is_empty() {
        "New chat".into()
    } else if t.chars().count() > 40 {
        format!("{}...", t.chars().take(40).collect::<String>())
    } else {
        t
    }
}

fn new_agent_session(book_id: &str, now: &str, ordinal: usize) -> AgentChatSession {
    AgentChatSession {
        id: format!("chat_{now}_{ordinal}"),
        book_id: book_id.into(),
        title: "New chat".into(),
        created_at: now.into(),
        updated_at: now.into(),
        turns: vec![],
        messages: new_session(),
    }
}

pub fn load_agent_history(path: &Option<PathBuf>) -> AgentHistory {
    let Some(p) = path.as_ref() else {
        return AgentHistory::default();
    };
    let Ok(raw) = std::fs::read_to_string(p) else {
        return AgentHistory::default();
    };
    serde_json::from_str::<AgentHistory>(&raw).unwrap_or_default()
}

fn save_agent_history_path(
    path: &Option<PathBuf>,
    history: &AgentHistory,
) -> Result<(), ToolError> {
    let Some(path) = path else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ToolError {
            error_code: "INTERNAL_ERROR".into(),
            category: "internal".into(),
            message: format!("建 agent history 目录失败: {e}"),
        })?;
    }
    let body = serde_json::to_string_pretty(history).map_err(|e| ToolError {
        error_code: "INTERNAL_ERROR".into(),
        category: "internal".into(),
        message: format!("序列化 agent history 失败: {e}"),
    })?;
    std::fs::write(path, body).map_err(|e| ToolError {
        error_code: "INTERNAL_ERROR".into(),
        category: "internal".into(),
        message: format!("写 agent history 失败: {e}"),
    })
}

fn save_agent_history(state: &AppState) -> Result<(), ToolError> {
    save_agent_history_path(&state.history_path, &state.agent_history)
}

fn ensure_active_agent_session(history: &mut AgentHistory, book_id: &str, now: &str) -> usize {
    if let Some(active_id) = history.active_by_book.get(book_id) {
        if let Some(i) = history
            .sessions
            .iter()
            .position(|s| s.book_id == book_id && &s.id == active_id)
        {
            return i;
        }
    }
    if let Some(i) = history.sessions.iter().rposition(|s| s.book_id == book_id) {
        let id = history.sessions[i].id.clone();
        history.active_by_book.insert(book_id.into(), id);
        return i;
    }
    let i = history.sessions.len();
    let session = new_agent_session(book_id, now, i);
    history
        .active_by_book
        .insert(book_id.into(), session.id.clone());
    history.sessions.push(session);
    i
}

pub fn ensure_agent_history_for_book(
    history: &mut AgentHistory,
    book_id: &str,
    now: &str,
) -> Vec<Message> {
    let i = ensure_active_agent_session(history, book_id, now);
    history.sessions[i].messages.clone()
}

fn session_view(s: &AgentChatSession) -> AgentChatSessionView {
    AgentChatSessionView {
        id: s.id.clone(),
        book_id: s.book_id.clone(),
        title: s.title.clone(),
        created_at: s.created_at.clone(),
        updated_at: s.updated_at.clone(),
        turns: s.turns.clone(),
    }
}

fn session_summary(s: &AgentChatSession) -> AgentChatSessionSummary {
    AgentChatSessionSummary {
        id: s.id.clone(),
        title: s.title.clone(),
        created_at: s.created_at.clone(),
        updated_at: s.updated_at.clone(),
        turn_count: s.turns.len(),
        turns: s
            .turns
            .iter()
            .map(|t| AgentChatTurnSummary {
                user: t.user.clone(),
                question_anchor_lid: t.question_anchor_lid.clone(),
                question_quote: t.question_quote.clone(),
            })
            .collect(),
    }
}

fn agent_history_response(state: &mut AppState, now: &str) -> AgentHistoryResponse {
    let book_id = state.book.base.book_id.clone();
    let i = ensure_active_agent_session(&mut state.agent_history, &book_id, now);
    state.messages = state.agent_history.sessions[i].messages.clone();
    let active_session_id = state.agent_history.sessions[i].id.clone();
    let current = session_view(&state.agent_history.sessions[i]);
    let mut sessions: Vec<AgentChatSessionSummary> = state
        .agent_history
        .sessions
        .iter()
        .filter(|s| s.book_id == book_id)
        .map(session_summary)
        .collect();
    sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| b.id.cmp(&a.id))
    });
    AgentHistoryResponse {
        active_session_id,
        sessions,
        current,
    }
}

/// 一次请求的传输无关输入:方法 + 原始 url(含 query)+ JSON body(GET 为空)+ 时间戳。
/// `now` 由 main 注入(确定性可测,守 A2;memory.save 的 generated_at/last_used 用它)。
pub struct Req<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub body: &'a str,
    pub now: &'a str,
}

/// 路由产物:HTTP 状态码 + JSON body(传输无关,main 负责写回 socket)。
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, PartialEq)]
pub struct BinaryReply {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct BookLibraryEntry {
    name: String,
    book_id: String,
    dir: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
struct PdfPageRectDto {
    #[serde(rename = "pageIndex")]
    page_index: usize,
    bbox: [f64; 4],
}

#[derive(Debug, Deserialize)]
struct PdfSelectionInputRect {
    #[serde(rename = "pageIndex")]
    page_index: Option<usize>,
    bbox: [f64; 4],
}

#[derive(Debug, Deserialize)]
struct PdfSelectionResolveInput {
    #[serde(rename = "pageIndex")]
    page_index: Option<usize>,
    rects: Vec<PdfSelectionInputRect>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
struct SourceSpanDto {
    start: usize,
    end: usize,
}

#[derive(Debug, Serialize, PartialEq)]
struct PdfSemanticRange {
    lid: String,
    range: SourceSpanDto,
    source_span: SourceSpanDto,
    quote_markdown: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct PdfSelectionResolveResponse {
    status: String,
    ranges: Vec<PdfSemanticRange>,
    quote_markdown: String,
}

#[derive(Debug, Deserialize)]
struct PdfRangeInput {
    lid: String,
    range: Option<SourceSpanDto>,
}

#[derive(Debug, Deserialize)]
struct PdfRangesProjectInput {
    ranges: Vec<PdfRangeInput>,
}

#[derive(Debug, Serialize, PartialEq)]
struct PdfRangeProjection {
    lid: String,
    range: Option<SourceSpanDto>,
    status: String,
    source_span: Option<SourceSpanDto>,
    primary_region: Option<serde_json::Value>,
    regions: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, PartialEq)]
struct PdfRangesProjectResponse {
    projections: Vec<PdfRangeProjection>,
}

/// 纯函数路由 `[ADR-0028 决策3]`:按命名空间前缀定方法(`book.*`→GET 只读、
/// `reader.*`/`memory.*`→POST 可变),端点名 = 命令名,错误原样透传 §4.4 信封。
pub fn route(state: &mut AppState, req: Req) -> Reply {
    let (path, q) = parse_query(req.url);
    // book.query:`book.*` 命名空间但 LLM 命令(秒级、非确定性叶子)→ POST,
    // 单列于 GET-only `route_book` 之前(决策3 的方法分派对它例外)`[ADR-0014/0028]`。
    if path == "/book/open" {
        if req.method != "POST" {
            return book_open_method_not_allowed();
        }
        return route_open_book(state, req.body, req.now);
    }
    if path == "/book/query" {
        if req.method != "POST" {
            return query_method_not_allowed();
        }
        return route_query(state, req.body);
    }
    if path == "/book/synthesize" {
        if req.method != "POST" {
            return synthesize_method_not_allowed();
        }
        return route_synthesize(state, req.body);
    }
    if path == "/build_workbench/sidecar_plan.confirm" {
        if req.method != "POST" {
            return method_not_allowed();
        }
        return route_sidecar_plan_confirm(&state.book, &state.book_dir, req.body, req.now);
    }
    if path == "/build_workbench/input.import" {
        if req.method != "POST" {
            return method_not_allowed();
        }
        return route_workbench_input_import(state, req.body, req.now);
    }
    // agent.*(S10f):外层 E agent 编排,POST(会话命令)`[ADR-0030]`。
    if path == "/agent/history" {
        if req.method != "GET" {
            return agent_history_method_not_allowed();
        }
        let response = agent_history_response(state, req.now);
        if let Err(e) = save_agent_history(state) {
            return err_reply(&e);
        }
        return ok_json(&response);
    }
    if path == "/agent/history/select" {
        if req.method != "POST" {
            return agent_method_not_allowed();
        }
        return route_agent_history_select(state, req.body, req.now);
    }
    if path == "/agent/history/delete" {
        if req.method != "POST" {
            return agent_method_not_allowed();
        }
        return route_agent_history_delete(state, req.body, req.now);
    }
    if path == "/agent/chat" {
        if req.method != "POST" {
            return agent_method_not_allowed();
        }
        return route_agent_chat(state, req.body, req.now);
    }
    if path == "/agent/new" {
        if req.method != "POST" {
            return agent_method_not_allowed();
        }
        return route_agent_new(state, req.now);
    }
    if path == "/profile/manifest" {
        if req.method != "GET" {
            return method_not_allowed();
        }
        return route_profile_manifest(&state.book, &q);
    }
    if let Some(p) = path.strip_prefix("/book/") {
        if req.method != "GET" {
            return method_not_allowed();
        }
        route_book(&state.book, &state.book_dir, &state.store, p, &q)
    } else if path.starts_with("/reader/") || path.starts_with("/memory/") {
        if req.method != "POST" {
            return method_not_allowed();
        }
        route_mut(state, path.as_str(), req.body, req.now)
    } else {
        route_not_found(&path)
    }
}

fn route_open_book(state: &mut AppState, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(dir) = v.get("dir").and_then(|x| x.as_str()).map(str::trim) else {
        return validation("INVALID_RANGE", "book.open 需 dir 字段");
    };
    if dir.is_empty() {
        return validation("INVALID_RANGE", "book.open 的 dir 不能为空");
    }
    let book = match Book::load(dir) {
        Ok(book) => book,
        Err(e) => {
            if Path::new(dir).is_dir() {
                state.book_dir = PathBuf::from(dir);
                let _ = save_session(state, Some(dir));
                return ok_json(&json!({
                    "ok": true,
                    "book_id": read_book_id_from_base(&Path::new(dir).join("base.json"))
                        .or_else(|| Path::new(dir).file_name().and_then(|s| s.to_str()).map(str::to_string))
                        .unwrap_or_else(|| state.book.base.book_id.clone()),
                    "route": "workbench"
                }));
            }
            return err_reply(&ToolError {
                error_code: "BOOK_LOAD_FAILED".into(),
                category: "validation".into(),
                message: format!("加载书失败({dir}): {e}"),
            });
        }
    };
    let saved_top = load_session(&state.session_path)
        .and_then(|session| session.top_lid_for_dir(dir).map(str::to_string));
    let mut reader = Reader::new(&book, DEFAULT_RADIUS);
    if let Some(top) = saved_top {
        reader.restore_top_lid(&book, &top);
    }
    state.reader = reader;
    state.book_dir = PathBuf::from(dir);
    state.book = book;
    state.messages =
        ensure_agent_history_for_book(&mut state.agent_history, &state.book.base.book_id, now);
    if let Err(e) = save_agent_history(state) {
        return err_reply(&e);
    }
    let _ = save_session(state, Some(dir));
    ok_json(&json!({ "ok": true, "book_id": state.book.base.book_id }))
}

fn route_profile_manifest(book: &Book, q: &HashMap<String, String>) -> Reply {
    match book.profile_manifest_by_id(q.get("profile_id").map(|s| s.as_str())) {
        Ok(manifest) => ok_json(&manifest),
        Err(e) => err_reply(&e),
    }
}

fn route_book_library(book_dir: &Path) -> Reply {
    let root = book_library_root(book_dir);
    let books = list_book_library(&root);
    ok_json(&json!({
        "root": path_string(&root),
        "books": books,
    }))
}

fn book_library_root(book_dir: &Path) -> PathBuf {
    if let Some(parent) = book_dir.parent() {
        if parent.file_name().and_then(|s| s.to_str()) == Some(".understand-book") {
            return parent.to_path_buf();
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".understand-book")
}

fn list_book_library(root: &Path) -> Vec<BookLibraryEntry> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut books = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let path = entry.path();
            let base_path = path.join("base.json");
            if !base_path.is_file() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let book_id = read_book_id_from_base(&base_path).unwrap_or_else(|| name.clone());
            Some(BookLibraryEntry {
                name,
                book_id,
                dir: path_string(&path),
            })
        })
        .collect::<Vec<_>>();
    books.sort_by(|a, b| {
        a.book_id
            .cmp(&b.book_id)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.dir.cmp(&b.dir))
    });
    books
}

fn read_book_id_from_base(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("book_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn reader_state_response(book: &Book, reader: &Reader) -> serde_json::Value {
    let state = reader.state();
    json!({
        "viewport": state.viewport,
        "open_panels": state.open_panels,
        "selection": state.selection,
        "layout": state.layout,
        "profile": book.profile_summary(),
    })
}

/// `book.*` 只读叶子 → GET(S10a)。`store` 仅 `guided_route_from` 用(派生 reader_profile 已读降权)。
fn route_book(
    book: &Book,
    book_dir: &Path,
    store: &MemoryStore,
    leaf: &str,
    q: &HashMap<String, String>,
) -> Reply {
    match leaf {
        "manifest" => ok_json(&book.manifest()),
        "library" => route_book_library(book_dir),
        "asset_manifest" => route_asset_manifest(book, book_dir),
        "build_workbench" => route_build_workbench(book, book_dir),
        "source_manifest" => route_source_manifest(book_dir),
        "pdf_source_map" => route_pdf_source_map(book_dir),
        "text" => {
            let Some(lid) = q.get("lid") else {
                return validation("INVALID_RANGE", "book.text 需 lid 查询参数");
            };
            match book.text(lid, q.get("end").map(|s| s.as_str())) {
                Ok(t) => ok_json(&json!({ "lid": lid, "text": t })),
                Err(e) => err_reply(&e),
            }
        }
        "context" => {
            let Some(lid) = q.get("lid") else {
                return validation("INVALID_RANGE", "book.context 需 lid 查询参数");
            };
            let k = match q.get("k") {
                None => None,
                Some(s) => match s.parse::<usize>() {
                    Ok(n) => Some(n),
                    Err(_) => return validation("INVALID_K", "k 须为非负整数"),
                },
            };
            let granularity = q.get("granularity").map(|s| s.as_str());
            match book.context(lid, granularity, k) {
                Ok(c) => ok_json(&c),
                Err(e) => err_reply(&e),
            }
        }
        "concept" => {
            let Some(name) = q.get("name") else {
                return validation("INVALID_RANGE", "book.concept 需 name 查询参数");
            };
            match book.concept(name) {
                Ok(c) => ok_json(&c),
                Err(e) => err_reply(&e),
            }
        }
        "formula_semantics" => {
            let Some(lid) = q.get("lid") else {
                return validation("INVALID_RANGE", "book.formula_semantics 需 lid 查询参数");
            };
            match book.formula_semantics(lid) {
                Some(s) => ok_json(s),
                None => err_reply(&ToolError {
                    error_code: "FORMULA_SEMANTICS_NOT_FOUND".into(),
                    category: "not_found".into(),
                    message: format!("未找到公式语义剖面: {lid}"),
                }),
            }
        }
        "structure" => match book.structure(q.get("at").map(|s| s.as_str())) {
            Ok(p) => ok_json(&p),
            Err(e) => err_reply(&e),
        },
        "guide_path" => match book.guide_path(q.get("at").map(|s| s.as_str())) {
            Ok(p) => ok_json(&p),
            Err(e) => err_reply(&e),
        },
        "paper_metadata" => ok_json(&book.paper_metadata_projection()),
        "paper_lexicon" => ok_json(&book.paper_lexicon_projection()),
        "paper_reading_guide" => match book.paper_reading_guide(
            q.get("mode").map(|s| s.as_str()),
            q.get("stage").map(|s| s.as_str()),
        ) {
            Ok(p) => ok_json(&p),
            Err(e) => err_reply(&e),
        },
        "route_from" => {
            let Some(at) = q.get("at") else {
                return validation("INVALID_RANGE", "book.route_from 需 at 查询参数");
            };
            let k = match q.get("k") {
                None => None,
                Some(s) => match s.parse::<usize>() {
                    Ok(n) => Some(n),
                    Err(_) => return validation("INVALID_K", "k 须为非负整数"),
                },
            };
            match book.route_from(at, k) {
                Ok(f) => ok_json(&f),
                Err(e) => err_reply(&e),
            }
        }
        "guided_route_from" => {
            let Some(at) = q.get("at") else {
                return validation("INVALID_RANGE", "book.guided_route_from 需 at 查询参数");
            };
            let k = match q.get("k") {
                None => None,
                Some(s) => match s.parse::<usize>() {
                    Ok(n) => Some(n),
                    Err(_) => return validation("INVALID_K", "k 须为非负整数"),
                },
            };
            // reader_profile 已读降权 `[ADR-0038]`:派生读者画像传入(住户读自己的整形 route)。
            let profile = store.derive_reader_profile(&book.base.book_id);
            match guided_route_from(book, at, k, &profile) {
                Ok(g) => ok_json(&json!({ "at": at, "groups": g })),
                Err(e) => err_reply(&e),
            }
        }
        "unvisited_back" => {
            let Some(at) = q.get("at") else {
                return validation("INVALID_RANGE", "book.unvisited_back 需 at 查询参数");
            };
            // 裸「没懂」兜底 `[ADR-0036 决策3]`:派生 reader_profile,确定性 back ∩ 未读前置。
            let profile = store.derive_reader_profile(&book.base.book_id);
            match unvisited_back(book, at, &profile) {
                Ok(steps) => ok_json(&json!({ "at": at, "unvisited_back": steps })),
                Err(e) => err_reply(&e),
            }
        }
        "route_to" => {
            let (Some(from), Some(target)) = (q.get("from"), q.get("target")) else {
                return validation("INVALID_RANGE", "book.route_to 需 from + target 查询参数");
            };
            let k = match q.get("k") {
                None => None,
                Some(s) => match s.parse::<usize>() {
                    Ok(n) => Some(n),
                    Err(_) => return validation("INVALID_K", "k 须为非负整数"),
                },
            };
            match book.route_to(from, target, k) {
                Ok(p) => ok_json(&json!({ "from": from, "target": target, "path": p })),
                Err(e) => err_reply(&e),
            }
        }
        _ => route_not_found(&format!("/book/{leaf}")),
    }
}

fn route_asset_manifest(book: &Book, book_dir: &Path) -> Reply {
    let path = book_dir.join("asset_manifest.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => ok_json(&value),
            Err(e) => err_reply(&ToolError {
                error_code: "ASSET_MANIFEST_INVALID".into(),
                category: "internal".into(),
                message: format!("asset_manifest.json 非合法 JSON: {e}"),
            }),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ok_json(&json!({
            "version": "asset_manifest.v1",
            "book_id": book.base.book_id,
            "images": [],
        })),
        Err(e) => err_reply(&ToolError {
            error_code: "ASSET_MANIFEST_READ_FAILED".into(),
            category: "internal".into(),
            message: format!("读取 asset_manifest.json 失败: {e}"),
        }),
    }
}

fn read_json_artifact_optional(
    path: &Path,
    invalid_code: &str,
) -> Result<Option<serde_json::Value>, ToolError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(ToolError {
                error_code: "ARTIFACT_READ_FAILED".into(),
                category: "internal".into(),
                message: format!("读取 artifact 失败({}): {e}", path.display()),
            })
        }
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .map(Some)
        .map_err(|e| ToolError {
            error_code: invalid_code.into(),
            category: "internal".into(),
            message: format!("artifact 非合法 JSON({}): {e}", path.display()),
        })
}

const WORKBENCH_INPUT_MANIFEST_RELATIVE: &str = ".build/input/manifest.json";

fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut data = bytes.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let j = i * 4;
            *word = u32::from_be_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for word in h {
        for byte in word.to_be_bytes() {
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn workbench_config_hash() -> String {
    sha256_hex(b"workbench_input_manifest.v1:paper:source_reconciliation_v1")
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, ToolError> {
    let encoded = input
        .split_once(',')
        .filter(|(prefix, _)| prefix.trim_start().starts_with("data:"))
        .map(|(_, payload)| payload)
        .unwrap_or(input);
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    let mut padded = false;
    for byte in encoded.bytes().filter(|b| !b.is_ascii_whitespace()) {
        if byte == b'=' {
            padded = true;
            continue;
        }
        if padded {
            return Err(ToolError {
                error_code: "INVALID_WORKBENCH_INPUT".into(),
                category: "validation".into(),
                message: "paper_pdf_base64 padding 后仍有内容".into(),
            });
        }
        let Some(value) = base64_value(byte) else {
            return Err(ToolError {
                error_code: "INVALID_WORKBENCH_INPUT".into(),
                category: "validation".into(),
                message: "paper_pdf_base64 非合法 base64".into(),
            });
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn workbench_input_manifest_path(book_dir: &Path) -> PathBuf {
    book_dir.join(WORKBENCH_INPUT_MANIFEST_RELATIVE)
}

fn read_workbench_input_manifest(book_dir: &Path) -> Result<Option<serde_json::Value>, ToolError> {
    read_json_artifact_optional(
        &workbench_input_manifest_path(book_dir),
        "WORKBENCH_INPUT_MANIFEST_INVALID",
    )
}

fn input_fingerprint_from_manifest(
    manifest: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    manifest.and_then(|value| value.get("fingerprint")).cloned()
}

fn source_value(
    value: &serde_json::Value,
    content_key: &str,
    path_key: &str,
) -> Result<(Vec<u8>, &'static str, Option<String>), ToolError> {
    let content = value.get(content_key).and_then(|v| v.as_str());
    let path = value
        .get(path_key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (content, path) {
        (Some(_), Some(_)) => Err(ToolError {
            error_code: "INVALID_WORKBENCH_INPUT".into(),
            category: "validation".into(),
            message: format!("{content_key} 与 {path_key} 只能提供一个"),
        }),
        (Some(text), None) if content_key == "paper_pdf_base64" => {
            Ok((decode_base64(text)?, "uploaded_base64", None))
        }
        (Some(text), None) => Ok((text.as_bytes().to_vec(), "uploaded_text", None)),
        (None, Some(path)) => std::fs::read(path)
            .map(|bytes| (bytes, "selected_path", Some(path.to_string())))
            .map_err(|e| ToolError {
                error_code: "WORKBENCH_INPUT_READ_FAILED".into(),
                category: "validation".into(),
                message: format!("读取输入文件失败({path}): {e}"),
            }),
        (None, None) => Err(ToolError {
            error_code: "INVALID_WORKBENCH_INPUT".into(),
            category: "validation".into(),
            message: format!("需提供 {content_key} 或 {path_key}"),
        }),
    }
}

fn write_workbench_input_file(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    std::fs::write(path, bytes).map_err(|e| ToolError {
        error_code: "WORKBENCH_INPUT_WRITE_FAILED".into(),
        category: "internal".into(),
        message: format!("写入 Workbench 输入失败({}): {e}", path.display()),
    })
}

fn write_workbench_json(path: &Path, value: &serde_json::Value) -> Result<(), ToolError> {
    let raw = serde_json::to_string_pretty(value).map_err(|e| ToolError {
        error_code: "WORKBENCH_INPUT_WRITE_FAILED".into(),
        category: "internal".into(),
        message: format!("序列化 Workbench input manifest 失败: {e}"),
    })?;
    std::fs::write(path, raw).map_err(|e| ToolError {
        error_code: "WORKBENCH_INPUT_WRITE_FAILED".into(),
        category: "internal".into(),
        message: format!(
            "写入 Workbench input manifest 失败({}): {e}",
            path.display()
        ),
    })
}

fn artifact_config_hash(book_dir: &Path, relative: &str) -> Result<Option<String>, ToolError> {
    Ok(
        read_json_artifact_optional(&book_dir.join(relative), "ARTIFACT_INVALID")?.and_then(
            |value| {
                value
                    .get("config_hash")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            },
        ),
    )
}

fn stage_value(stage: &str, status: &str, reason: Option<&str>) -> serde_json::Value {
    match reason {
        Some(reason) => json!({ "stage": stage, "status": status, "reason": reason }),
        None => json!({ "stage": stage, "status": status }),
    }
}

const BUILD_WORKBENCH_STAGE_IDS: [&str; 9] = [
    "source_reconciliation",
    "hybrid_foundation",
    "pass1",
    "paper_metadata",
    "paper_lexicon",
    "profile_sidecar",
    "pass2",
    "book_structure",
    "paper_reading_guide",
];

fn value_array_len(value: Option<&serde_json::Value>, key: &str) -> Option<usize> {
    value
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_array())
        .map(Vec::len)
}

fn capability_value<'a>(
    manifest: &'a serde_json::Value,
    name: &str,
) -> Option<&'a serde_json::Value> {
    manifest.get("capabilities").and_then(|v| v.get(name))
}

fn capability_needs_artifact(capability: Option<&serde_json::Value>) -> bool {
    let status = capability
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str());
    let has_artifact = capability
        .and_then(|v| v.get("artifact_path"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    matches!(status, Some("available" | "degraded")) && has_artifact
}

fn capability_hash_mismatch(
    capability: Option<&serde_json::Value>,
    artifact_hash: Option<&str>,
) -> bool {
    let cap_hash = capability
        .and_then(|v| v.get("config_hash"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    matches!((cap_hash, artifact_hash), (Some(left), Some(right)) if left != right)
}

fn capability_degraded_without_reason(capability: Option<&serde_json::Value>) -> bool {
    let status = capability
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str());
    let reason = capability
        .and_then(|v| v.get("reason"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    status == Some("degraded") && reason.is_none()
}

fn stage_dir_has_entries(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.any(|entry| entry.is_ok()))
        .unwrap_or(false)
}

fn derived_stage_status(
    book_dir: &Path,
    stage: &str,
    dir_name: &str,
    extra_file: Option<&str>,
) -> serde_json::Value {
    let done = stage_dir_has_entries(&book_dir.join(".build").join(dir_name))
        || extra_file.is_some_and(|file| book_dir.join(file).is_file());
    if done {
        stage_value(stage, "done", None)
    } else {
        stage_value(
            stage,
            "missing",
            Some("derived paper projection stage artifact is missing"),
        )
    }
}

fn read_build_jobs(book_dir: &Path) -> Result<Vec<serde_json::Value>, ToolError> {
    let jobs_dir = book_dir.join(".build").join("jobs");
    let entries = match std::fs::read_dir(&jobs_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(ToolError {
                error_code: "BUILD_JOBS_READ_FAILED".into(),
                category: "internal".into(),
                message: format!("读取 build jobs 失败({}): {e}", jobs_dir.display()),
            })
        }
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| ToolError {
            error_code: "BUILD_JOBS_READ_FAILED".into(),
            category: "internal".into(),
            message: format!("读取 build job entry 失败: {e}"),
        })?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            files.push(path);
        }
    }
    files.sort();
    files
        .iter()
        .map(|path| {
            read_json_artifact_optional(path, "BUILD_JOB_INVALID").and_then(|value| {
                value.ok_or_else(|| ToolError {
                    error_code: "BUILD_JOB_NOT_FOUND".into(),
                    category: "not_found".into(),
                    message: format!("build job disappeared while reading: {}", path.display()),
                })
            })
        })
        .collect()
}

fn workbench_book_id(
    fallback_book_id: &str,
    book_dir: &Path,
    report: Option<&serde_json::Value>,
    source_manifest: Option<&serde_json::Value>,
) -> String {
    report
        .and_then(|v| v.get("book_id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            source_manifest
                .and_then(|v| v.get("book_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_string)
        .or_else(|| read_book_id_from_base(&book_dir.join("base.json")))
        .or_else(|| {
            book_dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| fallback_book_id.to_string())
}

fn is_current_existing_technical_book(book: &Book, book_dir: &Path) -> bool {
    if book.content_profile_id() == ContentProfileId::Paper
        || !book_dir.join("source.txt").is_file()
    {
        return false;
    }
    read_book_id_from_base(&book_dir.join("base.json")).as_deref()
        == Some(book.base.book_id.as_str())
}

fn route_existing_technical_book_workbench(book: &Book, book_dir: &Path) -> Reply {
    let mut stages = serde_json::Map::new();
    for stage in BUILD_WORKBENCH_STAGE_IDS {
        stages.insert(
            stage.into(),
            stage_value(
                stage,
                "done",
                Some("not required for technical_learning profile"),
            ),
        );
    }
    ok_json(&json!({
        "version": "build_workbench_snapshot.v1",
        "book_id": workbench_book_id(&book.base.book_id, book_dir, None, None),
        "readiness": {
            "route": "reader",
            "status": "trusted_book",
            "reasons": [],
            "stages": stages,
        },
        "jobs": [],
        "input": {
            "manifest": null,
            "fingerprint": null,
            "ready": false,
        },
        "sidecar_plan": {
            "plan": null,
            "form_draft": null,
            "build_spec": null,
        },
    }))
}

fn route_workbench_input_import(state: &mut AppState, body: &str, now: &str) -> Reply {
    let value = match body_value(body) {
        Ok(value) => value,
        Err(reply) => return reply,
    };
    let target_dir = value
        .get("target_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.book_dir.clone());
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        return err_reply(&ToolError {
            error_code: "WORKBENCH_INPUT_WRITE_FAILED".into(),
            category: "internal".into(),
            message: format!("创建 draft workspace 失败({}): {e}", target_dir.display()),
        });
    }

    let existing_manifest = match read_workbench_input_manifest(&target_dir) {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let book_id = value
        .get("book_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            existing_manifest
                .as_ref()
                .and_then(|manifest| manifest.get("book_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_string)
        .or_else(|| read_book_id_from_base(&target_dir.join("base.json")))
        .or_else(|| {
            target_dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| state.book.base.book_id.clone());
    let display_title = value
        .get("display_title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&book_id)
        .to_string();

    let (paper_md, paper_md_source, paper_md_original) =
        match source_value(&value, "paper_md_text", "paper_md_path") {
            Ok(value) => value,
            Err(e) => return err_reply(&e),
        };
    let (paper_pdf, paper_pdf_source, paper_pdf_original) =
        match source_value(&value, "paper_pdf_base64", "paper_pdf_path") {
            Ok(value) => value,
            Err(e) => return err_reply(&e),
        };
    let paper_md_path = target_dir.join("paper.md");
    let paper_pdf_path = target_dir.join("paper.pdf");
    if let Err(e) = write_workbench_input_file(&paper_md_path, &paper_md) {
        return err_reply(&e);
    }
    if let Err(e) = write_workbench_input_file(&paper_pdf_path, &paper_pdf) {
        return err_reply(&e);
    }

    let paper_md_sha256 = sha256_hex(&paper_md);
    let paper_pdf_sha256 = sha256_hex(&paper_pdf);
    let config_hash = workbench_config_hash();
    let fingerprint = json!({
        "paper_md_sha256": paper_md_sha256,
        "paper_pdf_sha256": paper_pdf_sha256,
        "config_hash": config_hash,
    });
    let manifest = json!({
        "version": "workbench_input_manifest.v1",
        "book_id": book_id,
        "profile_id": "paper",
        "display_title": display_title,
        "created_at": now,
        "updated_at": now,
        "inputs": {
            "paper_md": {
                "path": "paper.md",
                "sha256": paper_md_sha256,
                "size_bytes": paper_md.len(),
                "source": paper_md_source,
                "original_path": paper_md_original,
            },
            "paper_pdf": {
                "path": "paper.pdf",
                "sha256": paper_pdf_sha256,
                "size_bytes": paper_pdf.len(),
                "source": paper_pdf_source,
                "original_path": paper_pdf_original,
            },
        },
        "config_hash": config_hash,
        "fingerprint": fingerprint,
        "trusted": false,
    });
    let manifest_path = workbench_input_manifest_path(&target_dir);
    if let Some(parent) = manifest_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err_reply(&ToolError {
                error_code: "WORKBENCH_INPUT_WRITE_FAILED".into(),
                category: "internal".into(),
                message: format!("创建 Workbench input 目录失败({}): {e}", parent.display()),
            });
        }
    }
    if let Err(e) = write_workbench_json(&manifest_path, &manifest) {
        return err_reply(&e);
    }

    state.book_dir = target_dir;
    let _ = save_session(state, state.book_dir.to_str());
    route_build_workbench(&state.book, &state.book_dir)
}

fn route_build_workbench(book: &Book, book_dir: &Path) -> Reply {
    if is_current_existing_technical_book(book, book_dir) {
        return route_existing_technical_book_workbench(book, book_dir);
    }

    let fallback_book_id = &book.base.book_id;
    let input_manifest = match read_workbench_input_manifest(book_dir) {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let current_input_fingerprint = input_fingerprint_from_manifest(input_manifest.as_ref());
    let report = match read_json_artifact_optional(
        &book_dir
            .join(".build")
            .join("source-reconciliation")
            .join("report.json"),
        "SOURCE_RECONCILIATION_REPORT_INVALID",
    ) {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let source_manifest = match read_json_artifact_optional(
        &book_dir.join("source_manifest.json"),
        "SOURCE_MANIFEST_INVALID",
    ) {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let pdf_source_hash = match artifact_config_hash(book_dir, "pdf_source_map.json") {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let pdf_selection_hash = match artifact_config_hash(book_dir, "pdf_selection_map/manifest.json")
    {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    let alignment_hash = match artifact_config_hash(book_dir, "alignment_report.json") {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };

    let mut stages = serde_json::Map::new();
    let mut reasons = Vec::<String>::new();
    let unresolved_count = value_array_len(report.as_ref(), "unresolved").unwrap_or(0);
    let source_status = if report.is_none() {
        stages.insert(
            "source_reconciliation".into(),
            stage_value(
                "source_reconciliation",
                "missing",
                Some("source reconciliation report is missing"),
            ),
        );
        "missing"
    } else if current_input_fingerprint
        .as_ref()
        .is_some_and(|fingerprint| {
            report
                .as_ref()
                .and_then(|value| value.get("input_fingerprint"))
                != Some(fingerprint)
        })
    {
        stages.insert(
            "source_reconciliation".into(),
            stage_value(
                "source_reconciliation",
                "stale",
                Some("source reconciliation input fingerprint does not match current inputs"),
            ),
        );
        "stale"
    } else if unresolved_count > 0 {
        stages.insert(
            "source_reconciliation".into(),
            stage_value(
                "source_reconciliation",
                "needs_review",
                Some("source reconciliation has unresolved blocks"),
            ),
        );
        "needs_review"
    } else {
        stages.insert(
            "source_reconciliation".into(),
            stage_value("source_reconciliation", "done", None),
        );
        "done"
    };

    let foundation_status = if source_status == "done" {
        if !book_dir.join("source.txt").is_file() {
            stages.insert(
                "hybrid_foundation".into(),
                stage_value(
                    "hybrid_foundation",
                    "missing",
                    Some("trusted source.txt is missing"),
                ),
            );
            "missing"
        } else if !book_dir.join("base.json").is_file() {
            stages.insert(
                "hybrid_foundation".into(),
                stage_value("hybrid_foundation", "missing", Some("base.json is missing")),
            );
            "missing"
        } else if source_manifest.is_none() {
            stages.insert(
                "hybrid_foundation".into(),
                stage_value(
                    "hybrid_foundation",
                    "missing",
                    Some("source_manifest.json is missing"),
                ),
            );
            "missing"
        } else {
            let manifest = source_manifest.as_ref().expect("checked above");
            let project_lid = capability_value(manifest, "project_lid_to_pdf");
            let project_ranges = capability_value(manifest, "project_ranges_to_pdf");
            let resolve_selection = capability_value(manifest, "resolve_pdf_selection");
            let missing_artifact = [
                (
                    "project_lid_to_pdf",
                    project_lid,
                    pdf_source_hash.as_deref(),
                ),
                (
                    "project_ranges_to_pdf",
                    project_ranges,
                    pdf_source_hash.as_deref(),
                ),
                (
                    "resolve_pdf_selection",
                    resolve_selection,
                    pdf_selection_hash.as_deref(),
                ),
            ]
            .iter()
            .find(|(_, capability, artifact_hash)| {
                capability_needs_artifact(*capability) && artifact_hash.is_none()
            })
            .map(|(name, _, _)| *name);
            let stale_artifact = [
                (
                    "project_lid_to_pdf",
                    project_lid,
                    pdf_source_hash.as_deref(),
                ),
                (
                    "project_ranges_to_pdf",
                    project_ranges,
                    pdf_source_hash.as_deref(),
                ),
                (
                    "resolve_pdf_selection",
                    resolve_selection,
                    pdf_selection_hash.as_deref(),
                ),
            ]
            .iter()
            .find(|(_, capability, artifact_hash)| {
                capability_hash_mismatch(*capability, *artifact_hash)
            })
            .map(|(name, _, _)| *name);
            let degraded_without_reason = [
                ("project_lid_to_pdf", project_lid),
                ("project_ranges_to_pdf", project_ranges),
                ("resolve_pdf_selection", resolve_selection),
            ]
            .iter()
            .find(|(_, capability)| capability_degraded_without_reason(*capability))
            .map(|(name, _)| *name);
            let manifest_config_hash = project_lid
                .or(resolve_selection)
                .and_then(|v| v.get("config_hash"))
                .and_then(|v| v.as_str());
            if let Some(name) = missing_artifact {
                stages.insert(
                    "hybrid_foundation".into(),
                    stage_value(
                        "hybrid_foundation",
                        "incomplete",
                        Some(&format!("{name} declares an artifact that is missing")),
                    ),
                );
                "incomplete"
            } else if let Some(name) = stale_artifact {
                stages.insert(
                    "hybrid_foundation".into(),
                    stage_value(
                        "hybrid_foundation",
                        "stale",
                        Some(&format!("{name} config hash does not match its artifact")),
                    ),
                );
                "stale"
            } else if let Some(name) = degraded_without_reason {
                stages.insert(
                    "hybrid_foundation".into(),
                    stage_value(
                        "hybrid_foundation",
                        "incomplete",
                        Some(&format!("{name} is degraded without an explicit reason")),
                    ),
                );
                "incomplete"
            } else if matches!((alignment_hash.as_deref(), manifest_config_hash), (Some(left), Some(right)) if left != right)
            {
                stages.insert(
                    "hybrid_foundation".into(),
                    stage_value(
                        "hybrid_foundation",
                        "stale",
                        Some("alignment_report config hash does not match source_manifest capabilities"),
                    ),
                );
                "stale"
            } else {
                stages.insert(
                    "hybrid_foundation".into(),
                    stage_value("hybrid_foundation", "done", None),
                );
                "done"
            }
        }
    } else {
        stages.insert(
            "hybrid_foundation".into(),
            stage_value(
                "hybrid_foundation",
                "blocked",
                Some("upstream stage is not trusted yet"),
            ),
        );
        "blocked"
    };

    if foundation_status == "done" {
        stages.insert(
            "pass1".into(),
            derived_stage_status(book_dir, "pass1", "pass1", None),
        );
        stages.insert(
            "paper_metadata".into(),
            derived_stage_status(
                book_dir,
                "paper_metadata",
                "paper-metadata",
                Some("paper_metadata.json"),
            ),
        );
        stages.insert(
            "paper_lexicon".into(),
            derived_stage_status(
                book_dir,
                "paper_lexicon",
                "paper-lexicon",
                Some("paper_lexicon.json"),
            ),
        );
        stages.insert(
            "profile_sidecar".into(),
            derived_stage_status(
                book_dir,
                "profile_sidecar",
                "profile-sidecar",
                Some("profile_sidecar.json"),
            ),
        );
        stages.insert(
            "pass2".into(),
            derived_stage_status(book_dir, "pass2", "pass2", None),
        );
        stages.insert(
            "book_structure".into(),
            derived_stage_status(
                book_dir,
                "book_structure",
                "book-structure",
                Some("book_structure.json"),
            ),
        );
        stages.insert(
            "paper_reading_guide".into(),
            derived_stage_status(
                book_dir,
                "paper_reading_guide",
                "paper-reading-guide",
                Some("paper_reading_guide.json"),
            ),
        );
    } else {
        for stage in [
            "pass1",
            "paper_metadata",
            "paper_lexicon",
            "profile_sidecar",
            "pass2",
            "book_structure",
            "paper_reading_guide",
        ] {
            stages.insert(
                stage.into(),
                stage_value(stage, "blocked", Some("upstream stage is not trusted yet")),
            );
        }
    }

    if source_status == "needs_review" {
        reasons.push("source reconciliation needs review".into());
    }
    if source_status == "stale" || foundation_status == "stale" {
        reasons.push("build input or artifacts are stale".into());
    }
    if source_status == "missing" || foundation_status == "missing" {
        reasons.push("trusted source foundation is missing".into());
    }
    if foundation_status == "incomplete" {
        let reason = stages
            .get("hybrid_foundation")
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("trusted source foundation is incomplete");
        reasons.push(reason.into());
    }

    let route = if source_status == "done" && foundation_status == "done" {
        "reader"
    } else {
        "workbench"
    };
    let readiness_status = if route == "reader" {
        "trusted_book"
    } else if source_status == "needs_review" {
        "needs_review"
    } else if source_status == "stale" || foundation_status == "stale" {
        "stale_input"
    } else if foundation_status == "incomplete" {
        "incomplete"
    } else {
        "missing"
    };
    if reasons.is_empty() && route == "workbench" {
        reasons.push("trusted source foundation is not ready".into());
    }

    let jobs = match read_build_jobs(book_dir) {
        Ok(jobs) => jobs,
        Err(e) => return err_reply(&e),
    };
    let sidecar_dir = book_dir.join(".build").join("sidecar-plan");
    let sidecar_plan = match (
        read_json_artifact_optional(
            &sidecar_dir.join("sidecar_plan.json"),
            "SIDECAR_PLAN_INVALID",
        ),
        read_json_artifact_optional(
            &sidecar_dir.join("form_draft.json"),
            "SIDECAR_FORM_DRAFT_INVALID",
        ),
        read_json_artifact_optional(
            &sidecar_dir.join("sidecar_build_spec.json"),
            "SIDECAR_BUILD_SPEC_INVALID",
        ),
    ) {
        (Ok(plan), Ok(form_draft), Ok(build_spec)) => {
            json!({ "plan": plan, "form_draft": form_draft, "build_spec": build_spec })
        }
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return err_reply(&e),
    };

    let book_id = input_manifest
        .as_ref()
        .and_then(|value| value.get("book_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            workbench_book_id(
                fallback_book_id,
                book_dir,
                report.as_ref(),
                source_manifest.as_ref(),
            )
        });
    ok_json(&json!({
        "version": "build_workbench_snapshot.v1",
        "book_id": book_id,
        "readiness": {
            "route": route,
            "status": readiness_status,
            "reasons": reasons,
            "stages": stages,
        },
        "input": {
            "manifest": input_manifest,
            "fingerprint": current_input_fingerprint,
            "ready": current_input_fingerprint.is_some(),
        },
        "jobs": jobs,
        "sidecar_plan": sidecar_plan,
    }))
}

fn update_sidecar_form_fields(
    form: &mut serde_json::Value,
    fields: &serde_json::Map<String, serde_json::Value>,
) {
    let Some(items) = form.get_mut("fields").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for item in items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
            continue;
        };
        let editable = item
            .get("editable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if editable {
            if let Some(value) = fields.get(&id) {
                item["value"] = value.clone();
            }
        }
    }
}

fn update_sidecar_plan_from_fields(
    plan: &mut serde_json::Value,
    fields: &serde_json::Map<String, serde_json::Value>,
    now: &str,
) {
    plan["status"] = json!("confirmed");
    plan["sidecar_generation_allowed"] = json!(true);
    plan["confirmed_at"] = json!(now);
    if let Some(target_view) = fields.get("target_view").and_then(|v| v.as_str()) {
        plan["selected_option"] = json!(target_view);
    }
    let Some(intent) = plan.as_object_mut().and_then(|plan| {
        Some(
            plan.entry("intent")
                .or_insert_with(|| json!({}))
                .as_object_mut()?,
        )
    }) else {
        return;
    };
    if let Some(target_view) = fields.get("target_view").and_then(|v| v.as_str()) {
        intent.insert("target_view".into(), json!(target_view));
    }
    if let Some(source_scope) = fields.get("source_scope") {
        intent.insert("source_scope".into(), source_scope.clone());
    }
    let output = intent
        .entry("output_contract")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    if let Some(output) = output {
        if let Some(sidecar_id) = fields.get("sidecar_id") {
            output.insert("sidecar_id".into(), sidecar_id.clone());
        }
        if let Some(schema) = fields.get("schema") {
            output.insert("schema".into(), schema.clone());
        }
        if let Some(visualization) = fields.get("visualization") {
            output.insert("visualization".into(), visualization.clone());
        }
        if let Some(required_evidence) = fields.get("required_evidence") {
            output.insert("required_evidence".into(), required_evidence.clone());
        }
    }
}

fn sidecar_build_spec(plan: &serde_json::Value) -> serde_json::Value {
    let intent = plan.get("intent").unwrap_or(&serde_json::Value::Null);
    let output = intent
        .get("output_contract")
        .unwrap_or(&serde_json::Value::Null);
    let source_scope = intent
        .get("source_scope")
        .cloned()
        .unwrap_or_else(|| json!({ "whole_book": true }));
    let input_lids = source_scope
        .get("lids")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let validation_rules = plan
        .get("validation_rules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    json!({
        "version": "sidecar_build_spec.v1",
        "sidecar_id": output.get("sidecar_id").and_then(|v| v.as_str()).unwrap_or("custom_sidecar"),
        "stage": "custom_sidecar",
        "input_lids": input_lids,
        "source_scope": source_scope,
        "extractor_prompt": intent.get("user_request").and_then(|v| v.as_str()).unwrap_or("custom sidecar"),
        "output_schema": output.get("schema").cloned().unwrap_or_else(|| json!({
            "type": "object",
            "properties": {},
            "additionalProperties": true
        })),
        "validation_rules": validation_rules,
        "visualization_hint": output.get("visualization").and_then(|v| v.as_str()).unwrap_or("cards"),
    })
}

fn route_sidecar_plan_confirm(book: &Book, book_dir: &Path, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(fields) = v.get("fields").and_then(|v| v.as_object()) else {
        return validation(
            "INVALID_SIDECAR_PLAN",
            "sidecar plan confirm 需 fields 对象",
        );
    };
    let sidecar_dir = book_dir.join(".build").join("sidecar-plan");
    let plan_path = sidecar_dir.join("sidecar_plan.json");
    let form_path = sidecar_dir.join("form_draft.json");
    let mut plan = match read_json_artifact_optional(&plan_path, "SIDECAR_PLAN_INVALID") {
        Ok(Some(plan)) => plan,
        Ok(None) => {
            return err_reply(&ToolError {
                error_code: "SIDECAR_PLAN_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("sidecar_plan.json not found: {}", plan_path.display()),
            })
        }
        Err(e) => return err_reply(&e),
    };
    let mut form = match read_json_artifact_optional(&form_path, "SIDECAR_FORM_DRAFT_INVALID") {
        Ok(Some(form)) => form,
        Ok(None) => plan
            .get("form_draft")
            .cloned()
            .unwrap_or_else(|| json!({ "version": "sidecar_form_draft.v1", "fields": [] })),
        Err(e) => return err_reply(&e),
    };
    update_sidecar_form_fields(&mut form, fields);
    update_sidecar_plan_from_fields(&mut plan, fields, now);
    plan["form_draft"] = form.clone();
    let spec = sidecar_build_spec(&plan);
    if let Err(e) = std::fs::create_dir_all(&sidecar_dir) {
        return err_reply(&ToolError {
            error_code: "SIDECAR_PLAN_WRITE_FAILED".into(),
            category: "internal".into(),
            message: format!("创建 sidecar-plan 目录失败({}): {e}", sidecar_dir.display()),
        });
    }
    for (path, value) in [
        (&plan_path, &plan),
        (&form_path, &form),
        (&sidecar_dir.join("sidecar_build_spec.json"), &spec),
    ] {
        let raw = match serde_json::to_string_pretty(value) {
            Ok(raw) => raw,
            Err(e) => {
                return err_reply(&ToolError {
                    error_code: "SIDECAR_PLAN_WRITE_FAILED".into(),
                    category: "internal".into(),
                    message: format!("序列化 sidecar artifact 失败: {e}"),
                })
            }
        };
        if let Err(e) = std::fs::write(path, raw) {
            return err_reply(&ToolError {
                error_code: "SIDECAR_PLAN_WRITE_FAILED".into(),
                category: "internal".into(),
                message: format!("写入 sidecar artifact 失败({}): {e}", path.display()),
            });
        }
    }
    route_build_workbench(book, book_dir)
}

fn read_json_artifact(
    path: &Path,
    missing_code: &str,
    invalid_code: &str,
) -> Result<serde_json::Value, ToolError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ToolError {
                error_code: missing_code.into(),
                category: "not_found".into(),
                message: format!("artifact not found: {}", path.display()),
            }
        } else {
            ToolError {
                error_code: "ARTIFACT_READ_FAILED".into(),
                category: "internal".into(),
                message: format!("读取 artifact 失败({}): {e}", path.display()),
            }
        }
    })?;
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| ToolError {
        error_code: invalid_code.into(),
        category: "internal".into(),
        message: format!("artifact 非合法 JSON({}): {e}", path.display()),
    })
}

fn source_manifest_value(book_dir: &Path) -> Result<serde_json::Value, ToolError> {
    read_json_artifact(
        &book_dir.join("source_manifest.json"),
        "SOURCE_MANIFEST_NOT_FOUND",
        "SOURCE_MANIFEST_INVALID",
    )
}

fn route_source_manifest(book_dir: &Path) -> Reply {
    match source_manifest_value(book_dir) {
        Ok(value) => ok_json(&value),
        Err(e) => err_reply(&e),
    }
}

fn pdf_capability_status(manifest: &serde_json::Value, name: &str) -> Option<String> {
    manifest
        .get("capabilities")
        .and_then(|v| v.get(name))
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn pdf_capability_allows_runtime_map(manifest: &serde_json::Value) -> bool {
    ["project_lid_to_pdf", "project_ranges_to_pdf"]
        .iter()
        .any(|name| {
            matches!(
                pdf_capability_status(manifest, name).as_deref(),
                Some("available" | "degraded")
            )
        })
}

fn route_pdf_source_map(book_dir: &Path) -> Reply {
    let manifest = match source_manifest_value(book_dir) {
        Ok(value) => value,
        Err(e) => return err_reply(&e),
    };
    if !pdf_capability_allows_runtime_map(&manifest) {
        return err_reply(&ToolError {
            error_code: "PDF_SOURCE_MAP_UNAVAILABLE".into(),
            category: "validation".into(),
            message: "source_manifest.v2 does not expose a usable PDF source map capability".into(),
        });
    }
    match read_json_artifact(
        &book_dir.join("pdf_source_map.json"),
        "PDF_SOURCE_MAP_NOT_FOUND",
        "PDF_SOURCE_MAP_INVALID",
    ) {
        Ok(value) => ok_json(&value),
        Err(e) => err_reply(&e),
    }
}

fn safe_manifest_path(book_dir: &Path, declared: &str) -> Result<PathBuf, ToolError> {
    let declared_path = Path::new(declared);
    if declared_path.is_absolute() {
        return Ok(declared_path.to_path_buf());
    }
    let mut out = book_dir.to_path_buf();
    for component in declared_path.components() {
        match component {
            Component::Normal(seg) => out.push(seg),
            _ => {
                return Err(ToolError {
                    error_code: "INVALID_MANIFEST_PATH".into(),
                    category: "validation".into(),
                    message: format!("manifest path must be a normal relative path: {declared}"),
                });
            }
        }
    }
    Ok(out)
}

fn original_pdf_path(book_dir: &Path) -> Result<PathBuf, ToolError> {
    let manifest = source_manifest_value(book_dir)?;
    let Some(path) = manifest
        .get("original_pdf")
        .and_then(|v| v.get("path"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Err(ToolError {
            error_code: "ORIGINAL_PDF_NOT_DECLARED".into(),
            category: "not_found".into(),
            message: "source_manifest.v2 does not declare original_pdf.path".into(),
        });
    };
    safe_manifest_path(book_dir, path)
}

fn route_original_pdf_file(book_dir: &Path) -> BinaryReply {
    let file = match original_pdf_path(book_dir) {
        Ok(path) => path,
        Err(e) => {
            return BinaryReply {
                status: status_for(&e.category),
                content_type: "application/json; charset=utf-8".into(),
                body: to_body(&e).into_bytes(),
            };
        }
    };
    match std::fs::read(&file) {
        Ok(body) => BinaryReply {
            status: 200,
            content_type: "application/pdf".into(),
            body,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BinaryReply {
            status: 404,
            content_type: "application/json; charset=utf-8".into(),
            body: to_body(&ToolError {
                error_code: "ORIGINAL_PDF_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("original PDF not found: {}", file.display()),
            })
            .into_bytes(),
        },
        Err(e) => BinaryReply {
            status: 500,
            content_type: "application/json; charset=utf-8".into(),
            body: to_body(&ToolError {
                error_code: "ORIGINAL_PDF_READ_FAILED".into(),
                category: "internal".into(),
                message: format!("读取 original PDF 失败({}): {e}", file.display()),
            })
            .into_bytes(),
        },
    }
}

pub fn route_book_asset_file(book_dir: &Path, path: &str) -> Option<BinaryReply> {
    if path == "/book/pdf/original" {
        return Some(route_original_pdf_file(book_dir));
    }
    let rel = path.strip_prefix("/book/assets/")?;
    let mut file = book_dir.join("assets");
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') || seg.contains(':') {
            return Some(BinaryReply {
                status: 400,
                content_type: "text/plain; charset=utf-8".into(),
                body: b"invalid asset path".to_vec(),
            });
        }
        file.push(seg);
    }
    match std::fs::read(&file) {
        Ok(body) => Some(BinaryReply {
            status: 200,
            content_type: mime_for_asset(&file).into(),
            body,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(BinaryReply {
            status: 404,
            content_type: "text/plain; charset=utf-8".into(),
            body: b"asset not found".to_vec(),
        }),
        Err(e) => Some(BinaryReply {
            status: 500,
            content_type: "text/plain; charset=utf-8".into(),
            body: format!("asset read failed: {e}").into_bytes(),
        }),
    }
}

fn mime_for_asset(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "avif" => "image/avif",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// `reader.*`/`memory.*` 可变命令 → POST(S10b)。reader.* 返 effect;
/// highlight/note 委托 memory.save(标注单源);memory.* 直读写记忆层。
fn route_mut(state: &mut AppState, path: &str, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let sget = |k: &str| v.get(k).and_then(|x| x.as_str());
    match path {
        "/reader/goto" => {
            let Some(lid) = sget("lid") else {
                return validation("INVALID_RANGE", "reader.goto 需 lid");
            };
            // 字段级不相交借用:reader(mut) + book(shared) + store(mut,记账)。
            match state
                .reader
                .goto_lid(&state.book, &mut state.store, lid, now)
            {
                Ok(e) => {
                    let _ = save_session(state, None);
                    ok_json(&e)
                }
                Err(e) => err_reply(&e),
            }
        }
        "/reader/scroll" => {
            let Some(delta) = v.get("delta").and_then(|x| x.as_i64()) else {
                return validation("INVALID_RANGE", "reader.scroll 需 delta(整数)");
            };
            // scroll 落点记入已读账本 `[ADR-0038]` ⇒ 返 Result(持久写失败诚实透传)。
            match state
                .reader
                .scroll(&state.book, &mut state.store, delta, now)
            {
                Ok(e) => {
                    let _ = save_session(state, None);
                    ok_json(&e)
                }
                Err(e) => err_reply(&e),
            }
        }
        "/reader/highlight" => {
            let Some(lid) = sget("lid") else {
                return validation("INVALID_RANGE", "reader.highlight 需 lid");
            };
            // 段内自由高亮:body 可带 range {start,end}(UTF-16 偏移);缺省=整段高亮 `[ADR-0031]`。
            let range = v.get("range").and_then(|r| {
                let s = r.get("start").and_then(|x| x.as_u64())?;
                let e = r.get("end").and_then(|x| x.as_u64())?;
                Some((s as u32, e as u32))
            });
            let source_session_id = v
                .get("source_session_id")
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            match state.reader.highlight(
                &state.book,
                &mut state.store,
                lid,
                range,
                source_session_id,
                "long_term",
                now,
            ) {
                Ok(e) => ok_json(&e),
                Err(e) => err_reply(&e),
            }
        }
        "/reader/note" => {
            let (Some(lid), Some(text)) = (sget("lid"), sget("text")) else {
                return validation("INVALID_RANGE", "reader.note 需 lid + text");
            };
            match state
                .reader
                .note(&state.book, &mut state.store, lid, text, "long_term", now)
            {
                Ok(e) => ok_json(&e),
                Err(e) => err_reply(&e),
            }
        }
        "/reader/state" => ok_json(&reader_state_response(&state.book, &state.reader)),
        "/reader/layout.apply" => {
            if let Some(proposal_id) = sget("proposal_id") {
                let Some(base_layout_rev) = v.get("base_layout_rev").and_then(|x| x.as_u64())
                else {
                    return validation(
                        "INVALID_LAYOUT_ACTION",
                        "reader.layout.apply proposal 需 base_layout_rev",
                    );
                };
                match state
                    .reader
                    .apply_layout_proposal(&state.book, proposal_id, base_layout_rev)
                {
                    Ok(effect) => ok_json(&json!({ "kind": "effect", "effect": effect })),
                    Err(e) => err_reply(&e),
                }
            } else {
                let Some(actions_value) = v.get("actions") else {
                    return validation(
                        "INVALID_LAYOUT_ACTION",
                        "reader.layout.apply 需 actions 或 proposal_id",
                    );
                };
                let actions = match serde_json::from_value::<Vec<ReaderLayoutAction>>(
                    actions_value.clone(),
                ) {
                    Ok(actions) => actions,
                    Err(e) => {
                        return validation(
                            "INVALID_LAYOUT_ACTION",
                            &format!("reader.layout.apply actions 非法: {e}"),
                        );
                    }
                };
                match state.reader.apply_layout_actions(&state.book, actions) {
                    Ok(outcome) => ok_json(&outcome),
                    Err(e) => err_reply(&e),
                }
            }
        }
        "/reader/pdf_selection.resolve" => {
            route_pdf_selection_resolve(&state.book, &state.book_dir, &v)
        }
        "/reader/pdf_ranges.project" => route_pdf_ranges_project(&state.book, &state.book_dir, &v),
        "/memory/save" => {
            let (Some(ty), Some(anchor), Some(content)) =
                (sget("type"), sget("anchor_lid"), sget("content"))
            else {
                return validation(
                    "INVALID_MEMORY_TYPE",
                    "memory.save 需 type + anchor_lid + content",
                );
            };
            // layer:显式给则用,否则按类型默认(position→session,其余→long_term)`[ADR-0006]`。
            let layer = sget("layer").unwrap_or(if ty == "position" {
                "session"
            } else {
                "long_term"
            });
            let input = SaveInput {
                mem_id: None,
                mem_type: ty.into(),
                layer: layer.into(),
                book_id: state.book.base.book_id.clone(),
                anchor: Anchor {
                    lid: Some(anchor.into()),
                    concept: None,
                },
                content: content.into(),
                range: None, // memory.save 直存(note / agent 高亮保留)无段内 range;人段内高亮走 reader.highlight `[ADR-0031]`
                citations: None,
                source_session_id: None,
            };
            match state.store.save(input, now) {
                Ok(r) => ok_json(&r),
                Err(e) => err_reply(&e),
            }
        }
        "/memory/recall" => {
            // 各维度 Some 即过滤,缺省 = 不限(book_id 不给即跨书 `[ADR-0006]`)。
            let q = RecallQuery {
                book_id: sget("book_id").map(String::from),
                lid: sget("lid").map(String::from),
                mem_type: sget("type").map(String::from),
                layer: sget("layer").map(String::from),
                text: sget("text").map(String::from),
            };
            ok_json(&state.store.recall(&q))
        }
        "/memory/delete" => {
            // 用户显式删(S10g agent 提议「撤销」走它);找不到 → MEMORY_NOT_FOUND 不降级 `[ADR-0015]`。
            let Some(mem_id) = sget("mem_id") else {
                return validation("INVALID_RANGE", "memory.delete 需 mem_id");
            };
            match state.store.delete(mem_id) {
                Ok(()) => ok_json(&json!({ "ok": true })),
                Err(e) => err_reply(&e),
            }
        }
        _ => route_not_found(path),
    }
}

#[derive(Debug, Clone)]
struct SelectionCharHit {
    page_index: usize,
    char_index: usize,
    lid: Option<String>,
    source_span: SourceSpanDto,
}

fn rect_intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

fn parse_pdf_rect(value: &serde_json::Value) -> Option<PdfPageRectDto> {
    let page_index = value.get("pageIndex")?.as_u64()? as usize;
    let bbox_value = value.get("bbox")?.as_array()?;
    if bbox_value.len() != 4 {
        return None;
    }
    let mut bbox = [0.0; 4];
    for (i, v) in bbox_value.iter().enumerate() {
        bbox[i] = v.as_f64()?;
    }
    Some(PdfPageRectDto { page_index, bbox })
}

fn parse_source_span(value: &serde_json::Value) -> Option<SourceSpanDto> {
    Some(SourceSpanDto {
        start: value.get("start")?.as_u64()? as usize,
        end: value.get("end")?.as_u64()? as usize,
    })
}

fn selection_manifest_value(book_dir: &Path) -> Result<serde_json::Value, ToolError> {
    read_json_artifact(
        &book_dir.join("pdf_selection_map").join("manifest.json"),
        "PDF_SELECTION_MAP_NOT_FOUND",
        "PDF_SELECTION_MAP_INVALID",
    )
}

fn selection_page_shard_path(book_dir: &Path, page_index: usize) -> Result<PathBuf, ToolError> {
    let manifest = selection_manifest_value(book_dir)?;
    let Some(shard_path) = manifest
        .get("page_shards")
        .and_then(|v| v.as_array())
        .and_then(|shards| {
            shards.iter().find_map(|shard| {
                let page = shard.get("pageIndex").and_then(|v| v.as_u64())? as usize;
                if page == page_index {
                    shard.get("path").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
        })
    else {
        return Err(ToolError {
            error_code: "PDF_SELECTION_PAGE_NOT_FOUND".into(),
            category: "not_found".into(),
            message: format!("pdf_selection_map shard not found for page {page_index}"),
        });
    };
    safe_manifest_path(&book_dir.join("pdf_selection_map"), shard_path)
}

fn selection_hits_for_page(
    book_dir: &Path,
    page_index: usize,
    rects: &[[f64; 4]],
) -> Result<(Vec<SelectionCharHit>, usize), ToolError> {
    let shard_path = selection_page_shard_path(book_dir, page_index)?;
    let shard = read_json_artifact(
        &shard_path,
        "PDF_SELECTION_PAGE_NOT_FOUND",
        "PDF_SELECTION_PAGE_INVALID",
    )?;
    let mut hits = Vec::new();
    let mut unmapped_hits = 0;
    let Some(chars) = shard.get("chars").and_then(|v| v.as_array()) else {
        return Err(ToolError {
            error_code: "PDF_SELECTION_PAGE_INVALID".into(),
            category: "internal".into(),
            message: format!(
                "pdf_selection_map page shard has no chars array: {}",
                shard_path.display()
            ),
        });
    };
    for ch in chars {
        let Some(rect) = ch.get("rect").and_then(parse_pdf_rect) else {
            continue;
        };
        if rect.page_index != page_index
            || !rects
                .iter()
                .any(|selected| rect_intersects(*selected, rect.bbox))
        {
            continue;
        }
        let Some(source_span) = ch.get("source_span").and_then(parse_source_span) else {
            continue;
        };
        let lid = ch.get("lid").and_then(|v| v.as_str()).map(str::to_string);
        if lid.is_none() {
            unmapped_hits += 1;
        }
        hits.push(SelectionCharHit {
            page_index,
            char_index: ch.get("char_index").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
            lid,
            source_span,
        });
    }
    Ok((hits, unmapped_hits))
}

fn lid_span(book: &Book, lid: &str) -> Result<SourceSpanDto, ToolError> {
    book.base
        .lid_nodes
        .iter()
        .find(|node| node.lid == lid)
        .map(|node| SourceSpanDto {
            start: node.span.start,
            end: node.span.end,
        })
        .ok_or_else(|| ToolError {
            error_code: "LID_NOT_FOUND".into(),
            category: "not_found".into(),
            message: format!("LID 不存在: {lid}"),
        })
}

fn slice_utf16_lossy(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let s = start.min(units.len());
    let e = end.min(units.len()).max(s);
    String::from_utf16_lossy(&units[s..e])
}

fn quote_lid_range(book: &Book, lid: &str, range: SourceSpanDto) -> Result<String, ToolError> {
    let text = book.text(lid, None)?;
    Ok(slice_utf16_lossy(&text, range.start, range.end))
}

fn route_pdf_selection_resolve(book: &Book, book_dir: &Path, body: &serde_json::Value) -> Reply {
    let input = match serde_json::from_value::<PdfSelectionResolveInput>(body.clone()) {
        Ok(input) => input,
        Err(e) => {
            return validation(
                "INVALID_PDF_SELECTION",
                &format!("reader.pdf_selection.resolve 需 pageIndex? + rects[]: {e}"),
            );
        }
    };
    if input.rects.is_empty() {
        return validation(
            "INVALID_PDF_SELECTION",
            "reader.pdf_selection.resolve 需至少一个 rect",
        );
    }

    let mut rects_by_page: BTreeMap<usize, Vec<[f64; 4]>> = BTreeMap::new();
    for rect in input.rects {
        let Some(page_index) = rect.page_index.or(input.page_index) else {
            return validation(
                "INVALID_PDF_SELECTION",
                "selection rect 需 pageIndex,或 body 顶层提供 pageIndex",
            );
        };
        rects_by_page.entry(page_index).or_default().push(rect.bbox);
    }

    let mut hits = Vec::new();
    let mut unmapped_hits = 0;
    for (page_index, rects) in rects_by_page {
        match selection_hits_for_page(book_dir, page_index, &rects) {
            Ok((mut page_hits, page_unmapped)) => {
                hits.append(&mut page_hits);
                unmapped_hits += page_unmapped;
            }
            Err(e) => return err_reply(&e),
        }
    }
    hits.sort_by_key(|hit| (hit.page_index, hit.char_index));

    let mut by_lid: BTreeMap<String, SourceSpanDto> = BTreeMap::new();
    for hit in &hits {
        let Some(lid) = &hit.lid else {
            continue;
        };
        by_lid
            .entry(lid.clone())
            .and_modify(|span| {
                span.start = span.start.min(hit.source_span.start);
                span.end = span.end.max(hit.source_span.end);
            })
            .or_insert(hit.source_span);
    }

    let mut ranges = Vec::new();
    for (lid, abs_span) in by_lid {
        let node_span = match lid_span(book, &lid) {
            Ok(span) => span,
            Err(e) => return err_reply(&e),
        };
        let rel = SourceSpanDto {
            start: abs_span.start.saturating_sub(node_span.start),
            end: abs_span
                .end
                .saturating_sub(node_span.start)
                .min(node_span.end - node_span.start),
        };
        let quote = match quote_lid_range(book, &lid, rel) {
            Ok(quote) => quote,
            Err(e) => return err_reply(&e),
        };
        ranges.push(PdfSemanticRange {
            lid,
            range: rel,
            source_span: abs_span,
            quote_markdown: quote,
        });
    }

    let quote_markdown = ranges
        .iter()
        .map(|range| range.quote_markdown.as_str())
        .collect::<Vec<_>>()
        .join("");
    let status = if ranges.is_empty() {
        "unresolved"
    } else if unmapped_hits > 0 || hits.iter().any(|hit| hit.lid.is_none()) {
        "partial"
    } else {
        "resolved"
    };
    ok_json(&PdfSelectionResolveResponse {
        status: status.into(),
        ranges,
        quote_markdown,
    })
}

fn pdf_source_map_value(book_dir: &Path) -> Result<serde_json::Value, ToolError> {
    let manifest = source_manifest_value(book_dir)?;
    if !pdf_capability_allows_runtime_map(&manifest) {
        return Err(ToolError {
            error_code: "PDF_SOURCE_MAP_UNAVAILABLE".into(),
            category: "validation".into(),
            message: "source_manifest.v2 does not expose a usable PDF source map capability".into(),
        });
    }
    read_json_artifact(
        &book_dir.join("pdf_source_map.json"),
        "PDF_SOURCE_MAP_NOT_FOUND",
        "PDF_SOURCE_MAP_INVALID",
    )
}

fn route_pdf_ranges_project(book: &Book, book_dir: &Path, body: &serde_json::Value) -> Reply {
    let input = match serde_json::from_value::<PdfRangesProjectInput>(body.clone()) {
        Ok(input) => input,
        Err(e) => {
            return validation(
                "INVALID_PDF_RANGE",
                &format!("reader.pdf_ranges.project 需 ranges[]: {e}"),
            );
        }
    };
    let map = match pdf_source_map_value(book_dir) {
        Ok(map) => map,
        Err(e) => return err_reply(&e),
    };
    let Some(entries) = map.get("entries").and_then(|v| v.as_array()) else {
        return err_reply(&ToolError {
            error_code: "PDF_SOURCE_MAP_INVALID".into(),
            category: "internal".into(),
            message: "pdf_source_map.entries missing or not an array".into(),
        });
    };

    let mut projections = Vec::new();
    for input_range in input.ranges {
        if let Err(e) = lid_span(book, &input_range.lid) {
            return err_reply(&e);
        }
        let entry = entries.iter().find(|entry| {
            entry.get("lid").and_then(|v| v.as_str()) == Some(input_range.lid.as_str())
        });
        let Some(entry) = entry else {
            projections.push(PdfRangeProjection {
                lid: input_range.lid,
                range: input_range.range,
                status: "unmapped".into(),
                source_span: None,
                primary_region: None,
                regions: vec![],
            });
            continue;
        };
        let regions = entry
            .get("regions")
            .and_then(|v| v.as_array())
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let source_span = entry.get("source_span").and_then(parse_source_span);
        let entry_status = entry
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unmapped");
        let status = if regions.is_empty() || entry_status == "unmapped" {
            "unmapped"
        } else if entry_status == "word_mapped" {
            "exact"
        } else {
            "lid_region_fallback"
        };
        projections.push(PdfRangeProjection {
            lid: input_range.lid,
            range: input_range.range,
            status: status.into(),
            source_span,
            primary_region: entry.get("primary_region").cloned(),
            regions,
        });
    }
    ok_json(&PdfRangesProjectResponse { projections })
}

/// `book.query` → POST(S10c)。直调内层 `runtime::query`:确定性档位检索 + LLM 合一轮判停 +
/// 确定性交叉验停(citations⊆证据集 = 结构红线 `[ADR-0004/0016]`)。anchor 缺省取 reader 当前
/// anchor(读模式起点 `[ADR-0028]`);`scope` 入参暂不接(内层切片0 固定 local→chapter auto 阶梯,
/// 无 scope 旋钮,留切片1+)。provider 错经 `runtime::query` 映射 `PROVIDER_ERROR` 透传不降级。
fn route_query(state: &mut AppState, body: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(q) = v.get("q").and_then(|x| x.as_str()) else {
        return validation("INVALID_RANGE", "book.query 需 q(问题文本)");
    };
    // anchor:显式给则用,否则取 reader 当前视口 anchor(读到哪问到哪)。
    let anchor = match v.get("anchor_lid").and_then(|x| x.as_str()) {
        Some(a) => a.to_string(),
        None => state.reader.state().viewport.anchor_lid,
    };
    match runtime::query(&state.book, q, &anchor, state.adapter.as_ref()) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}
/// `book.synthesize` → POST(P2)。输入显式 LID 集,不做 scope 外扩;citations 由 runtime 过滤为输入子集。
fn route_synthesize(state: &mut AppState, body: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(arr) = v.get("lids").and_then(|x| x.as_array()) else {
        return validation("INVALID_RANGE", "book.synthesize 需 lids 数组");
    };
    let lids: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str().map(String::from))
        .collect();
    if lids.len() != arr.len() {
        return validation("INVALID_RANGE", "book.synthesize lids 必须全是字符串");
    }
    let task = v.get("task").and_then(|x| x.as_str());
    match synthesize(&state.book, &lids, task, state.adapter.as_ref()) {
        Ok(resp) => ok_json(&resp),
        Err(e) => err_reply(&e),
    }
}

fn parse_question_quote(v: &serde_json::Value) -> Result<Option<AskQuote>, Reply> {
    let Some(q) = v.get("question_quote") else {
        return Ok(None);
    };
    if q.is_null() {
        return Ok(None);
    }
    let Some(lid) = q.get("lid").and_then(|x| x.as_str()) else {
        return Err(validation("INVALID_RANGE", "question_quote 需 lid"));
    };
    let Some(quote) = q.get("quote").and_then(|x| x.as_str()) else {
        return Err(validation("INVALID_RANGE", "question_quote 需 quote"));
    };
    Ok(Some(AskQuote {
        lid: lid.into(),
        quote: quote.into(),
    }))
}

/// `POST /agent/chat`(S10f)`[ADR-0030]`:外层 E agent 编排 loop,注入同一
/// `book/store/reader/messages/adapter`(与前端共享视口、跨回合 messages)。body `{message}` →
/// `OuterOutcome{answer, incomplete, effects, trace, ...}`;agent 动作即时驱动共享 reader 视口,
/// effects 供前端可撤销提议、trace 供查询踪迹展示。provider 错经 run 映射 `PROVIDER_ERROR` 透传不降级。
fn route_agent_chat(state: &mut AppState, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(msg) = v.get("message").and_then(|x| x.as_str()) else {
        return validation("INVALID_RANGE", "agent.chat 需 message(用户消息文本)");
    };
    let display_user = v
        .get("display_user")
        .and_then(|x| x.as_str())
        .unwrap_or(msg)
        .to_string();
    let question_anchor_lid = v
        .get("question_anchor_lid")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let question_quote = match parse_question_quote(&v) {
        Ok(q) => q,
        Err(reply) => return reply,
    };
    let current_book_id = state.book.base.book_id.clone();
    ensure_active_agent_session(&mut state.agent_history, &current_book_id, now);
    // 字段级不相交借用:book(shared)+ store/reader/messages(mut)+ adapter(shared)。
    match run(
        &state.book,
        &mut state.store,
        &mut state.reader,
        state.adapter.as_ref(),
        &mut state.messages,
        msg,
        now,
        OuterConfig::default(),
    ) {
        Ok(out) => {
            let book_id = state.book.base.book_id.clone();
            let idx = ensure_active_agent_session(&mut state.agent_history, &book_id, now);
            let session = &mut state.agent_history.sessions[idx];
            if session.turns.is_empty() {
                session.title = compact_title(&display_user);
            }
            session.updated_at = now.into();
            session.messages = state.messages.clone();
            session.turns.push(AgentChatTurn {
                user: display_user,
                outcome: out.clone(),
                question_anchor_lid,
                question_quote,
            });
            if let Err(e) = save_agent_history(state) {
                return err_reply(&e);
            }
            ok_json(&out)
        }
        Err(e) => err_reply(&e),
    }
}

fn route_agent_new(state: &mut AppState, now: &str) -> Reply {
    let book_id = state.book.base.book_id.clone();
    let ordinal = state.agent_history.sessions.len();
    let session = new_agent_session(&book_id, now, ordinal);
    state
        .agent_history
        .active_by_book
        .insert(book_id, session.id.clone());
    state.messages = session.messages.clone();
    state.agent_history.sessions.push(session);
    let response = agent_history_response(state, now);
    if let Err(e) = save_agent_history(state) {
        return err_reply(&e);
    }
    ok_json(&json!({ "ok": true, "history": response }))
}

fn route_agent_history_select(state: &mut AppState, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(session_id) = v.get("session_id").and_then(|x| x.as_str()) else {
        return validation("INVALID_RANGE", "agent.history.select 需 session_id");
    };
    let book_id = state.book.base.book_id.clone();
    let Some(idx) = state
        .agent_history
        .sessions
        .iter()
        .position(|s| s.book_id == book_id && s.id == session_id)
    else {
        return validation(
            "INVALID_RANGE",
            "agent history session 不属于当前 book 或不存在",
        );
    };
    state
        .agent_history
        .active_by_book
        .insert(book_id, session_id.into());
    state.messages = state.agent_history.sessions[idx].messages.clone();
    let response = agent_history_response(state, now);
    if let Err(e) = save_agent_history(state) {
        return err_reply(&e);
    }
    ok_json(&response)
}

fn route_agent_history_delete(state: &mut AppState, body: &str, now: &str) -> Reply {
    let v = match body_value(body) {
        Ok(v) => v,
        Err(reply) => return reply,
    };
    let Some(session_id) = v.get("session_id").and_then(|x| x.as_str()) else {
        return validation("INVALID_RANGE", "agent.history.delete 需 session_id");
    };
    let book_id = state.book.base.book_id.clone();
    let before = state.agent_history.sessions.len();
    state
        .agent_history
        .sessions
        .retain(|s| !(s.book_id == book_id && s.id == session_id));
    if state.agent_history.sessions.len() == before {
        return validation(
            "INVALID_RANGE",
            "agent history session 不属于当前 book 或不存在",
        );
    }
    if state
        .agent_history
        .active_by_book
        .get(&book_id)
        .is_some_and(|id| id == session_id)
    {
        state.agent_history.active_by_book.remove(&book_id);
    }
    let idx = ensure_active_agent_session(&mut state.agent_history, &book_id, now);
    state.messages = state.agent_history.sessions[idx].messages.clone();
    let response = agent_history_response(state, now);
    if let Err(e) = save_agent_history(state) {
        return err_reply(&e);
    }
    ok_json(&response)
}

/// url → (path, query map);query 值经 percent 解码(支持 CJK 概念名 / 空格)。
fn parse_query(url: &str) -> (String, HashMap<String, String>) {
    let (path, qs) = match url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (url, ""),
    };
    let mut map = HashMap::new();
    for pair in qs.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        map.insert(percent_decode(k), percent_decode(v));
    }
    (path.to_string(), map)
}

/// JSON body 解析:空 body → 空对象(便于无字段端点如 reader.state);非法 → 400。
fn body_value(body: &str) -> Result<serde_json::Value, Reply> {
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    serde_json::from_str(body)
        .map_err(|e| validation("INVALID_RANGE", &format!("请求体非合法 JSON: {e}")))
}

/// 最小 percent 解码:`%XX` 十六进制字节 + `+`→空格;非法 `%` 序列原样保留。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn ok_json<T: Serialize>(v: &T) -> Reply {
    Reply {
        status: 200,
        body: to_body(v),
    }
}

/// 错误信封透传 §4.4 + category→HTTP status 映射 `[ADR-0028 决策3]`。
fn err_reply(e: &ToolError) -> Reply {
    Reply {
        status: status_for(&e.category),
        body: to_body(e),
    }
}

fn validation(code: &str, msg: &str) -> Reply {
    err_reply(&ToolError {
        error_code: code.into(),
        category: "validation".into(),
        message: msg.into(),
    })
}

fn route_not_found(path: &str) -> Reply {
    err_reply(&ToolError {
        error_code: "ROUTE_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("未知路由: {path}"),
    })
}

fn method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "book.* 只支持 GET;reader.*/memory.* 只支持 POST".into(),
        }),
    }
}

fn book_open_method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "book.open 是切换当前书的会话命令,只支持 POST(body {dir})".into(),
        }),
    }
}
/// agent.chat / agent.new 是会话命令(外层 E agent),只收 POST(S10f `[ADR-0030]`)。
fn agent_method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "agent.chat / agent.new 是会话命令,只支持 POST".into(),
        }),
    }
}

/// agent.history 是历史读取端点,只收 GET;选择/删除仍走 POST 子端点。
fn agent_history_method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "agent.history 只支持 GET;select/delete 子端点只支持 POST".into(),
        }),
    }
}

/// book.query 是 book.* 里唯一只收 POST 的端点(LLM 命令),405 文案单列以免误导。
fn synthesize_method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "book.synthesize 是 LLM 命令,只支持 POST(body {lids, task?})".into(),
        }),
    }
}

fn query_method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "book.query 是 LLM 命令,只支持 POST(body {q, anchor_lid?})".into(),
        }),
    }
}

fn to_body<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        format!("{{\"error_code\":\"INTERNAL_ERROR\",\"category\":\"internal\",\"message\":\"序列化失败: {e}\"}}")
    })
}

/// §4.4 category → HTTP status(瞬时 5xx / 永久 4xx)。
fn status_for(category: &str) -> u16 {
    match category {
        "validation" => 400,
        "not_found" => 404,
        "provider" => 502,
        "budget" => 429,
        "internal" => 500,
        _ => 500,
    }
}

/// `.env` 缺失时的兜底 adapter:book/reader/memory 浏览不被 LLM 配置阻塞,
/// 仅 `book.query` 触模型时诚实报 provider 错(经 `runtime::query` 映射 `PROVIDER_ERROR`,
/// category=provider ⇒ HTTP 502,守禁宽松降级 `[ADR-0015]`)。
pub struct UnconfiguredAdapter;

impl ModelAdapter for UnconfiguredAdapter {
    fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        Err(AdapterError {
            message:
                "未配置 LLM 后端:缺 .env(OPENCODE_API_KEY / OPENCODE_BASE_URL / FLUID_LLM_MODEL)"
                    .into(),
        })
    }
    fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
        Err(AdapterError {
            message:
                "未配置 LLM 后端:缺 .env(OPENCODE_API_KEY / OPENCODE_BASE_URL / FLUID_LLM_MODEL)"
                    .into(),
        })
    }
}

// ── 阅读位置持久化(S13d)──
/// 单本书的阅读位置。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionBookProgress {
    pub top_lid: String,
}

/// session.json 结构:记录最后打开的书,并为每本打开过的书分别保存阅读位置。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
    pub current_book_dir: String,
    #[serde(default)]
    pub books: BTreeMap<String, SessionBookProgress>,
}

#[derive(serde::Deserialize)]
struct LegacySessionState {
    book_dir: String,
    top_lid: String,
}

impl SessionState {
    pub fn top_lid_for_dir(&self, dir: &str) -> Option<&str> {
        let key = session_dir_key(dir);
        self.books
            .get(&key)
            .or_else(|| self.books.get(dir))
            .map(|p| p.top_lid.as_str())
    }

    pub fn current_top_lid(&self) -> Option<&str> {
        self.top_lid_for_dir(&self.current_book_dir)
    }

    fn from_legacy(legacy: LegacySessionState) -> Self {
        let dir = session_dir_key(&legacy.book_dir);
        let mut books = BTreeMap::new();
        books.insert(
            dir.clone(),
            SessionBookProgress {
                top_lid: legacy.top_lid,
            },
        );
        SessionState {
            current_book_dir: dir,
            books,
        }
    }
}

fn session_dir_key(dir: &str) -> String {
    let path = std::fs::canonicalize(dir)
        .unwrap_or_else(|_| PathBuf::from(dir))
        .to_string_lossy()
        .to_string();
    normalize_session_path_string(path)
}

fn normalize_session_path_string(path: String) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path
    }
}

/// 启动时选择要打开的书:优先恢复 session 中最后打开且仍可加载的书,否则使用请求目录。
pub fn select_start_book(
    requested_dir: String,
    session: Option<&SessionState>,
) -> (String, Option<String>) {
    let Some(session) = session else {
        return (requested_dir, None);
    };
    let requested_key = session_dir_key(&requested_dir);
    let current_key = session_dir_key(&session.current_book_dir);
    if current_key != requested_key
        && !session.current_book_dir.trim().is_empty()
        && Book::load(&session.current_book_dir).is_ok()
    {
        return (
            session.current_book_dir.clone(),
            session.current_top_lid().map(str::to_string),
        );
    }
    let top = session.top_lid_for_dir(&requested_dir).map(str::to_string);
    (requested_dir, top)
}

/// 把 AppState 当前书目录和阅读位置写入 session.json。dir=Some 覆盖当前书(开新书);None 使用 AppState 当前书。
pub fn save_session(state: &AppState, dir: Option<&str>) {
    let Some(path) = &state.session_path else {
        return;
    };
    let book_dir = dir
        .map(str::to_string)
        .unwrap_or_else(|| path_string(&state.book_dir));
    if book_dir.trim().is_empty() {
        return;
    }
    let key = session_dir_key(&book_dir);
    let top_lid = state.reader.viewport().top_lid;
    let mut session = load_session(&state.session_path).unwrap_or_else(|| SessionState {
        current_book_dir: key.clone(),
        books: BTreeMap::new(),
    });
    session.current_book_dir = key.clone();
    session.books.insert(key, SessionBookProgress { top_lid });
    if let Ok(json) = serde_json::to_string_pretty(&session) {
        let _ = std::fs::write(path, json);
    }
}

/// 从 session.json 读回上次打开的书目录和各书阅读位置。文件缺失或解析失败返回 None(静默,启服务冷启动)。
pub fn load_session(path: &Option<PathBuf>) -> Option<SessionState> {
    let p = path.as_ref()?;
    let raw = std::fs::read_to_string(p).ok()?;
    serde_json::from_str::<SessionState>(&raw).ok().or_else(|| {
        serde_json::from_str::<LegacySessionState>(&raw)
            .ok()
            .map(SessionState::from_legacy)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{
        sample_base, FormulaComposition, FormulaParameter, FormulaSemantics, LidNode, NodeKind,
        ReadOnlyBase, Span,
    };
    use reader::DEFAULT_RADIUS;
    use runtime::{RawCitation, ToolCall};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-server-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-server-test-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn multi_leaf_base(book_id: &str, leaves: usize) -> ReadOnlyBase {
        let mut base = sample_base();
        base.book_id = book_id.into();
        base.graph_nodes.clear();
        base.graph_edges.clear();
        let children = (1..=leaves).map(|i| format!("1.{i}")).collect::<Vec<_>>();
        let mut nodes = vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Chapter,
            span: Span {
                start: 0,
                end: leaves * 10,
            },
            children,
        }];
        nodes.extend((1..=leaves).map(|i| LidNode {
            lid: format!("1.{i}"),
            path: vec![1, i as u32],
            kind: NodeKind::Paragraph,
            span: Span {
                start: (i - 1) * 10,
                end: i * 10,
            },
            children: Vec::new(),
        }));
        base.lid_nodes = nodes;
        base
    }

    fn write_multi_leaf_book(name: &str, book_id: &str, leaves: usize) -> PathBuf {
        let dir = tmp_dir(name);
        let base = multi_leaf_base(book_id, leaves);
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "X".repeat(leaves * 10)).unwrap();
        dir
    }

    fn write_current_book_files(s: &AppState) {
        let max_end = s
            .book
            .base
            .lid_nodes
            .iter()
            .map(|node| node.span.end)
            .max()
            .unwrap_or(0);
        std::fs::write(
            s.book_dir.join("base.json"),
            serde_json::to_string(&s.book.base).unwrap(),
        )
        .unwrap();
        std::fs::write(s.book_dir.join("source.txt"), "X".repeat(max_end + 8)).unwrap();
    }

    fn attach_paper_profile(s: &mut AppState) {
        write_current_book_files(s);
        std::fs::write(
            s.book_dir.join("book_structure.json"),
            serde_json::json!({
                "header": {
                    "book_id": s.book.base.book_id,
                    "book_version": "v1",
                    "profile_id": "paper",
                    "profile_version": "paper_v0",
                    "core_schema_version": "core_v0",
                    "generated_at": "t0"
                },
                "spine": [],
                "throughlines": [],
                "key_stops": []
            })
            .to_string(),
        )
        .unwrap();
        s.book = Book::load(s.book_dir.to_str().unwrap()).unwrap();
        s.reader = Reader::new(&s.book, DEFAULT_RADIUS);
    }

    fn write_pdf_runtime_artifacts(s: &mut AppState) {
        let coord = serde_json::json!({
            "space": "pdf_user_space",
            "origin": "bottom_left",
            "unit": "pt",
            "rotation_applied": false
        });
        let source_manifest = serde_json::json!({
            "version": "source_manifest.v2",
            "book_id": s.book.base.book_id,
            "canonical_source": {
                "kind": "reconciled_markdown",
                "path": "source.txt",
                "citation_anchor": "lid",
                "sha256": "sha-source"
            },
            "original_pdf": {
                "path": "paper.pdf",
                "sha256": "sha-pdf",
                "citation_anchor": false
            },
            "capabilities": {
                "view_pdf": { "status": "available", "artifact_path": "paper.pdf", "config_hash": "cfg-a" },
                "project_lid_to_pdf": {
                    "status": "degraded",
                    "reason": "line fallback fixture",
                    "artifact_path": "pdf_source_map.json",
                    "report_path": "alignment_report.json",
                    "config_hash": "cfg-a"
                },
                "resolve_pdf_selection": {
                    "status": "available",
                    "artifact_path": "pdf_selection_map/manifest.json",
                    "report_path": "alignment_report.json",
                    "config_hash": "cfg-a"
                },
                "project_ranges_to_pdf": {
                    "status": "degraded",
                    "reason": "line fallback fixture",
                    "artifact_path": "pdf_source_map.json",
                    "report_path": "alignment_report.json",
                    "config_hash": "cfg-a"
                }
            }
        });
        std::fs::write(
            s.book_dir.join("source_manifest.json"),
            source_manifest.to_string(),
        )
        .unwrap();
        std::fs::write(s.book_dir.join("paper.pdf"), b"%PDF-1.4\nfixture\n").unwrap();
        let region =
            serde_json::json!({"region_id":"r1","pageIndex":0,"bbox":[10.0,10.0,80.0,20.0]});
        let pdf_source_map = serde_json::json!({
            "version": "pdf_source_map.v1",
            "book_id": s.book.base.book_id,
            "coordinate_system": coord,
            "pages": [{"pageIndex":0,"width":100.0,"height":100.0,"rotate":0,"view":[0.0,0.0,100.0,100.0]}],
            "entries": [{
                "lid": "1.1",
                "source_span": {"start":0,"end":100},
                "status": "line_fallback",
                "regions": [region],
                "primary_region": region,
                "alignment": {"confidence":0.8,"reason":"fixture"}
            }],
            "excluded_regions": [],
            "page_region_index": {"0":["r1"]},
            "page_excluded_index": {},
            "config_hash": "cfg-a"
        });
        std::fs::write(
            s.book_dir.join("pdf_source_map.json"),
            pdf_source_map.to_string(),
        )
        .unwrap();
        let selection_dir = s.book_dir.join("pdf_selection_map");
        std::fs::create_dir_all(selection_dir.join("pages")).unwrap();
        let selection_manifest = serde_json::json!({
            "version": "pdf_selection_map.v1",
            "book_id": s.book.base.book_id,
            "coordinate_system": {
                "space": "pdf_user_space",
                "origin": "bottom_left",
                "unit": "pt",
                "rotation_applied": false
            },
            "config_hash": "cfg-a",
            "page_shards": [{"pageIndex":0,"path":"pages/0.json","sha256":"fixture"}]
        });
        std::fs::write(
            selection_dir.join("manifest.json"),
            selection_manifest.to_string(),
        )
        .unwrap();
        let page = serde_json::json!({
            "version": "pdf_selection_map_page.v1",
            "book_id": s.book.base.book_id,
            "pageIndex": 0,
            "chars": [
                {"char_index":0,"text":"P","rect":{"pageIndex":0,"bbox":[10.0,10.0,12.0,20.0]},"source_span":{"start":0,"end":1},"lid":"1.1"},
                {"char_index":1,"text":"D","rect":{"pageIndex":0,"bbox":[12.0,10.0,14.0,20.0]},"source_span":{"start":1,"end":2},"lid":"1.1"},
                {"char_index":2,"text":"F","rect":{"pageIndex":0,"bbox":[14.0,10.0,16.0,20.0]},"source_span":{"start":2,"end":3},"lid":"1.1"}
            ]
        });
        std::fs::write(selection_dir.join("pages").join("0.json"), page.to_string()).unwrap();
    }

    fn write_workbench_review_artifacts(s: &mut AppState) {
        attach_paper_profile(s);

        let report_dir = s.book_dir.join(".build").join("source-reconciliation");
        std::fs::create_dir_all(&report_dir).unwrap();
        std::fs::write(
            report_dir.join("report.json"),
            serde_json::json!({
                "version": "source_reconciliation_report.v1",
                "book_id": s.book.base.book_id,
                "input_fingerprint": {
                    "paper_md_sha256": "sha-md",
                    "paper_pdf_sha256": "sha-pdf",
                    "config_hash": "cfg-a"
                },
                "summary": {
                    "verified": 1,
                    "auto_repaired": 0,
                    "llm_format_repaired": 0,
                    "needs_review": 1,
                    "pdf_unmatched": 0,
                    "md_unmatched": 0
                },
                "unresolved": [{"id": "block-1", "status": "needs_review", "reason": "number mismatch"}]
            })
            .to_string(),
        )
        .unwrap();

        let jobs_dir = s.book_dir.join(".build").join("jobs");
        std::fs::create_dir_all(&jobs_dir).unwrap();
        std::fs::write(
            jobs_dir.join("job_review.json"),
            serde_json::json!({
                "version": "build_job_state.v1",
                "job_id": "job_review",
                "book_id": s.book.base.book_id,
                "input_fingerprint": {
                    "paper_md_sha256": "sha-md",
                    "paper_pdf_sha256": "sha-pdf",
                    "config_hash": "cfg-a"
                },
                "status": "needs_user",
                "events": [
                    {"event_id": "evt_1", "job_id": "job_review", "created_at": "t1", "type": "decision_requested", "stage": "source_reconciliation"}
                ],
                "decision_requests": [
                    {"decision_id": "decision-1", "job_id": "job_review", "stage": "source_reconciliation", "kind": "source_reconciliation_mode", "prompt": "Choose review mode", "options": [], "status": "pending", "created_at": "t1"}
                ],
                "permission_requests": [
                    {"request_id": "perm-1", "run_id": "run-1", "executor": "codex", "category": "filesystem", "action_summary": "Read PDF", "scope_hint": "stage", "status": "pending", "created_at": "t1"}
                ],
                "created_at": "t1",
                "updated_at": "t1"
            })
            .to_string(),
        )
        .unwrap();

        let sidecar_dir = s.book_dir.join(".build").join("sidecar-plan");
        std::fs::create_dir_all(&sidecar_dir).unwrap();
        std::fs::write(
            sidecar_dir.join("sidecar_plan.json"),
            serde_json::json!({
                "version": "sidecar_plan.v1",
                "book_id": s.book.base.book_id,
                "status": "draft",
                "stage": "custom_sidecar",
                "sidecar_generation_allowed": false
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            sidecar_dir.join("form_draft.json"),
            serde_json::json!({
                "version": "sidecar_form_draft.v1",
                "fields": [{"id": "target_view", "label": "Target view", "value": "comparison_table", "editable": true}]
            })
            .to_string(),
        )
        .unwrap();
    }

    /// 确定性 LLM 替身:首轮即 sufficient + 引用给定 LID(落在证据集内 ⇒ 过内层交叉验停)。
    /// 让 book.query 的 HTTP 路由层脱离真 LLM 可测(守 A2);真跑端到端走 B2 人工。
    struct StubAdapter {
        lid: String,
    }
    impl ModelAdapter for StubAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Ok(ParsedResponse {
                sufficient: true,
                answer: Some("桩答案".into()),
                citations: vec![RawCitation {
                    lid: self.lid.clone(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("server 测不走外层 chat(S10f)")
        }
    }

    struct RecordingAdapter {
        lid: String,
        users: Arc<Mutex<Vec<String>>>,
    }
    impl ModelAdapter for RecordingAdapter {
        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.users.lock().unwrap().push(req.user);
            Ok(ParsedResponse {
                sufficient: true,
                answer: Some("桩答案".into()),
                citations: vec![RawCitation {
                    lid: self.lid.clone(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("server synthesize sidecar smoke 不走外层 chat")
        }
    }

    fn state_named(mem: &str) -> AppState {
        // sample_base:容器 "1" + 叶 "1.1";entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        let book = Book::new(sample_base(), &src);
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let store = MemoryStore::open(tmp(mem)).unwrap();
        // 默认桩引用首叶 "1.1"(book.query 缺省 anchor = reader 首叶,落证据集)。
        let adapter = Box::new(StubAdapter { lid: "1.1".into() });
        AppState {
            book_dir: tmp_dir(&format!("book-dir-{mem}")),
            book,
            reader,
            store,
            adapter,
            messages: new_session(),
            session_path: None,
            history_path: None,
            agent_history: AgentHistory::default(),
            visitor_sessions: mcp::VisitorSessions::default(),
        }
    }

    /// 脚本化外层 chat 替身(S10f):按序吐 AssistantTurn,driv 外层 loop 脱真 LLM 可测(守 A2)。
    /// `complete` 不走(内层 book.query 在 agent 测里不触发)。
    struct ChatStubAdapter {
        turns: RefCell<VecDeque<AssistantTurn>>,
    }
    impl ChatStubAdapter {
        fn scripted(turns: Vec<AssistantTurn>) -> Self {
            ChatStubAdapter {
                turns: RefCell::new(turns.into()),
            }
        }
    }
    impl ModelAdapter for ChatStubAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            unimplemented!("agent 测不走内层 complete")
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            self.turns
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "chat 脚本耗尽".into(),
                })
        }
    }

    fn get(s: &mut AppState, url: &str) -> Reply {
        route(
            s,
            Req {
                method: "GET",
                url,
                body: "",
                now: "t0",
            },
        )
    }
    fn post(s: &mut AppState, url: &str, body: &str) -> Reply {
        route(
            s,
            Req {
                method: "POST",
                url,
                body,
                now: "t0",
            },
        )
    }

    // ── S10a book.* GET(回归)────────────────────────────────
    #[test]
    fn manifest_ok() {
        let r = get(&mut state_named("manifest"), "/book/manifest");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"tree\""));
    }

    #[test]
    fn asset_manifest_missing_defaults_to_empty_images() {
        let mut s = state_named("asset-manifest-empty");
        let r = get(&mut s, "/book/asset_manifest");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"version\":\"asset_manifest.v1\""));
        assert!(r.body.contains("\"images\":[]"));
    }

    #[test]
    fn asset_manifest_reads_book_dir_json() {
        let mut s = state_named("asset-manifest-json");
        std::fs::write(
            s.book_dir.join("asset_manifest.json"),
            r#"{"version":"asset_manifest.v1","book_id":"sample","images":[{"lid":"1.1"}]}"#,
        )
        .unwrap();
        let r = get(&mut s, "/book/asset_manifest");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"lid\":\"1.1\""));
    }

    #[test]
    fn book_library_lists_build_dirs_from_current_book_parent() {
        let mut s = state_named("book-library");
        let base = tmp_dir("book-library-root");
        let root = base.join(".understand-book");
        let alpha = root.join("alpha");
        let draft = root.join("draft");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&draft).unwrap();
        std::fs::write(alpha.join("base.json"), r#"{"book_id":"alpha-book"}"#).unwrap();
        std::fs::write(draft.join("source.txt"), "not built yet").unwrap();
        s.book_dir = alpha.clone();

        let r = get(&mut s, "/book/library");
        assert_eq!(r.status, 200);
        let body: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        let books = body["books"].as_array().unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0]["name"], "alpha");
        assert_eq!(books[0]["book_id"], "alpha-book");
        assert_eq!(books[0]["dir"], path_string(&alpha));
        assert_eq!(body["root"], path_string(&root));
    }

    #[test]
    fn book_asset_file_serves_assets_under_book_dir_only() {
        let dir = tmp_dir("asset-file");
        let image_dir = dir.join("assets").join("images");
        std::fs::create_dir_all(&image_dir).unwrap();
        std::fs::write(image_dir.join("x.png"), [137_u8, 80, 78, 71]).unwrap();

        let ok = route_book_asset_file(&dir, "/book/assets/images/x.png").unwrap();
        assert_eq!(ok.status, 200);
        assert_eq!(ok.content_type, "image/png");
        assert_eq!(ok.body, vec![137_u8, 80, 78, 71]);

        let bad = route_book_asset_file(&dir, "/book/assets/../base.json").unwrap();
        assert_eq!(bad.status, 400);
        let missing = route_book_asset_file(&dir, "/book/assets/images/missing.png").unwrap();
        assert_eq!(missing.status, 404);
        assert!(route_book_asset_file(&dir, "/book/text?lid=1.1").is_none());
    }

    #[test]
    fn build_workbench_routes_existing_technical_book_to_reader_without_paper_gate() {
        let mut s = state_named("workbench-tech-existing");
        write_current_book_files(&s);
        std::fs::write(s.book_dir.join("source_manifest.json"), "{not-json").unwrap();

        let r = get(&mut s, "/book/build_workbench");

        assert_eq!(r.status, 200);
        let body: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(body["readiness"]["route"], "reader");
        assert_eq!(body["readiness"]["status"], "trusted_book");
        assert_eq!(body["readiness"]["reasons"].as_array().unwrap().len(), 0);
        assert_eq!(
            body["readiness"]["stages"]["source_reconciliation"]["status"],
            "done"
        );
        assert_eq!(
            body["readiness"]["stages"]["hybrid_foundation"]["reason"],
            "not required for technical_learning profile"
        );
        assert_eq!(body["jobs"].as_array().unwrap().len(), 0);
        assert!(body["sidecar_plan"]["plan"].is_null());
    }

    #[test]
    fn build_workbench_snapshot_exposes_readiness_jobs_and_sidecar_plan() {
        let mut s = state_named("workbench-snapshot");
        write_workbench_review_artifacts(&mut s);

        let r = get(&mut s, "/book/build_workbench");

        assert_eq!(r.status, 200);
        let body: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(body["version"], "build_workbench_snapshot.v1");
        assert_eq!(body["readiness"]["route"], "workbench");
        assert_eq!(body["readiness"]["status"], "needs_review");
        assert_eq!(
            body["readiness"]["stages"]["source_reconciliation"]["status"],
            "needs_review"
        );
        assert_eq!(
            body["jobs"][0]["decision_requests"][0]["decision_id"],
            "decision-1"
        );
        assert_eq!(
            body["jobs"][0]["permission_requests"][0]["request_id"],
            "perm-1"
        );
        assert_eq!(body["sidecar_plan"]["plan"]["version"], "sidecar_plan.v1");
        assert_eq!(
            body["sidecar_plan"]["form_draft"]["version"],
            "sidecar_form_draft.v1"
        );
    }

    #[test]
    fn sidecar_plan_confirm_writes_confirmed_plan_and_build_spec() {
        let mut s = state_named("workbench-sidecar-confirm");
        write_workbench_review_artifacts(&mut s);

        let r = post(
            &mut s,
            "/build_workbench/sidecar_plan.confirm",
            r#"{"fields":{"sidecar_id":"custom_review","visualization":"table","required_evidence":"lid_required","source_scope":{"lids":["1.1"]},"schema":{"type":"object","properties":{"rows":{"type":"array"}}}}}"#,
        );

        assert_eq!(r.status, 200);
        let plan: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(s.book_dir.join(".build/sidecar-plan/sidecar_plan.json"))
                .unwrap(),
        )
        .unwrap();
        let spec: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                s.book_dir
                    .join(".build/sidecar-plan/sidecar_build_spec.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(plan["status"], "confirmed");
        assert_eq!(plan["sidecar_generation_allowed"], true);
        assert_eq!(spec["version"], "sidecar_build_spec.v1");
        assert_eq!(spec["sidecar_id"], "custom_review");
        assert_eq!(spec["input_lids"][0], "1.1");
    }

    #[test]
    fn workbench_input_import_upload_writes_manifest_and_snapshot_fingerprint() {
        let mut s = state_named("workbench-input-import");

        let r = post(
            &mut s,
            "/build_workbench/input.import",
            r#"{"book_id":"paper-a","display_title":"Paper A","paper_md_text":"abc","paper_pdf_base64":"cGRm"}"#,
        );

        assert_eq!(r.status, 200);
        let body: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(body["version"], "build_workbench_snapshot.v1");
        assert_eq!(body["book_id"], "paper-a");
        assert_eq!(body["readiness"]["route"], "workbench");
        assert_eq!(body["input"]["ready"], true);
        assert_eq!(
            body["input"]["fingerprint"]["paper_md_sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            body["input"]["fingerprint"]["paper_pdf_sha256"],
            sha256_hex(b"pdf")
        );
        assert_eq!(
            std::fs::read_to_string(s.book_dir.join("paper.md")).unwrap(),
            "abc"
        );
        assert_eq!(std::fs::read(s.book_dir.join("paper.pdf")).unwrap(), b"pdf");
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(workbench_input_manifest_path(&s.book_dir)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["version"], "workbench_input_manifest.v1");
        assert_eq!(manifest["profile_id"], "paper");
        assert_eq!(manifest["trusted"], false);
    }

    #[test]
    fn workbench_input_manifest_survives_reopen_draft_workspace() {
        let mut s = state_named("workbench-input-reopen-source");
        let r = post(
            &mut s,
            "/build_workbench/input.import",
            r#"{"book_id":"paper-reopen","paper_md_text":"abc","paper_pdf_base64":"cGRm"}"#,
        );
        assert_eq!(r.status, 200);
        let dir = s.book_dir.clone();

        let mut reopened = state_named("workbench-input-reopen-target");
        let body = format!(
            r#"{{"dir":{}}}"#,
            serde_json::to_string(dir.to_str().unwrap()).unwrap()
        );
        assert_eq!(post(&mut reopened, "/book/open", &body).status, 200);

        let snapshot = get(&mut reopened, "/book/build_workbench");
        assert_eq!(snapshot.status, 200);
        let body: serde_json::Value = serde_json::from_str(&snapshot.body).unwrap();
        assert_eq!(body["book_id"], "paper-reopen");
        assert_eq!(body["input"]["ready"], true);
        assert_eq!(
            body["input"]["manifest"]["inputs"]["paper_md"]["path"],
            "paper.md"
        );
        assert_eq!(body["readiness"]["route"], "workbench");
    }

    #[test]
    fn pdf_runtime_endpoints_expose_manifest_map_original_selection_and_range_projection() {
        let mut s = state_named("pdf-runtime");
        write_pdf_runtime_artifacts(&mut s);

        let manifest = get(&mut s, "/book/source_manifest");
        assert_eq!(manifest.status, 200);
        assert!(manifest.body.contains("\"version\":\"source_manifest.v2\""));
        assert!(manifest.body.contains("\"original_pdf\""));

        let source_map = get(&mut s, "/book/pdf_source_map");
        assert_eq!(source_map.status, 200);
        assert!(source_map
            .body
            .contains("\"version\":\"pdf_source_map.v1\""));
        assert!(source_map.body.contains("\"primary_region\""));

        let pdf = route_book_asset_file(&s.book_dir, "/book/pdf/original").unwrap();
        assert_eq!(pdf.status, 200);
        assert_eq!(pdf.content_type, "application/pdf");
        assert!(pdf.body.starts_with(b"%PDF-1.4"));

        let resolved = post(
            &mut s,
            "/reader/pdf_selection.resolve",
            r#"{"pageIndex":0,"rects":[{"bbox":[9.0,9.0,17.0,21.0]}]}"#,
        );
        assert_eq!(resolved.status, 200);
        let resolved_body: serde_json::Value = serde_json::from_str(&resolved.body).unwrap();
        assert_eq!(resolved_body["status"], "resolved");
        assert_eq!(resolved_body["ranges"][0]["lid"], "1.1");
        assert_eq!(
            resolved_body["ranges"][0]["range"],
            serde_json::json!({"start":0,"end":3})
        );
        assert_eq!(resolved_body["quote_markdown"], "XXX");

        let projected = post(
            &mut s,
            "/reader/pdf_ranges.project",
            r#"{"ranges":[{"lid":"1.1","range":{"start":0,"end":3}}]}"#,
        );
        assert_eq!(projected.status, 200);
        let projected_body: serde_json::Value = serde_json::from_str(&projected.body).unwrap();
        assert_eq!(
            projected_body["projections"][0]["status"],
            "lid_region_fallback"
        );
        assert_eq!(
            projected_body["projections"][0]["primary_region"]["region_id"],
            "r1"
        );
    }

    #[test]
    fn pdf_source_map_respects_manifest_capability() {
        let mut s = state_named("pdf-runtime-unavailable");
        write_pdf_runtime_artifacts(&mut s);
        let mut manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(s.book_dir.join("source_manifest.json")).unwrap(),
        )
        .unwrap();
        manifest["capabilities"]["project_lid_to_pdf"] =
            serde_json::json!({"status":"unavailable","reason":"fixture disabled"});
        manifest["capabilities"]["project_ranges_to_pdf"] =
            serde_json::json!({"status":"unavailable","reason":"fixture disabled"});
        std::fs::write(
            s.book_dir.join("source_manifest.json"),
            manifest.to_string(),
        )
        .unwrap();

        let r = get(&mut s, "/book/pdf_source_map");
        assert_eq!(r.status, 400);
        assert!(r.body.contains("PDF_SOURCE_MAP_UNAVAILABLE"));
    }

    #[test]
    fn profile_manifest_endpoint_returns_current_and_explicit_profiles() {
        let mut s = state_named("profile-manifest");
        let current = get(&mut s, "/profile/manifest");
        assert_eq!(current.status, 200);
        assert!(current
            .body
            .contains("\"profile_id\":\"technical_learning\""));
        assert!(current.body.contains("technical.structure_map"));

        let paper = get(&mut s, "/profile/manifest?profile_id=paper");
        assert_eq!(paper.status, 200);
        assert!(paper.body.contains("\"profile_id\":\"paper\""));
        assert!(paper.body.contains("paper.structure_map"));
        assert!(paper.body.contains("book.paper_reading_guide"));

        let missing = get(&mut s, "/profile/manifest?profile_id=nope");
        assert_eq!(missing.status, 404);
        assert!(missing.body.contains("PROFILE_NOT_FOUND"));

        assert_eq!(post(&mut s, "/profile/manifest", "{}").status, 405);
    }

    #[test]
    fn text_valid_and_unknown_and_missing() {
        let mut s = state_named("text");
        let ok = get(&mut s, "/book/text?lid=1.1");
        assert_eq!(ok.status, 200);
        assert!(ok.body.contains(&"X".repeat(100)));
        let nf = get(&mut s, "/book/text?lid=9.9");
        assert_eq!(nf.status, 404);
        assert!(nf.body.contains("LID_NOT_FOUND"));
        let miss = get(&mut s, "/book/text");
        assert_eq!(miss.status, 400);
        assert!(miss.body.contains("INVALID_RANGE"));
    }

    #[test]
    fn context_and_concept() {
        let mut s = state_named("ctx");
        assert_eq!(get(&mut s, "/book/context?lid=1.1").status, 200);
        assert_eq!(get(&mut s, "/book/context?lid=1.1&k=abc").status, 400);
        assert_eq!(get(&mut s, "/book/concept?name=command").status, 200);
        assert_eq!(get(&mut s, "/book/concept?name=nope").status, 404);
    }

    #[test]
    fn formula_semantics_get_returns_profile() {
        let src = "X".repeat(100) + "尾巴";
        let mut base = sample_base();
        base.lid_nodes[1].kind = NodeKind::Formula;
        let semantics = FormulaSemantics {
            formula_lid: "1.1".into(),
            parameters: vec![FormulaParameter {
                symbol: "x".into(),
                label: Some("input".into()),
                meaning: "输入变量".into(),
                unit: None,
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "1.1".into(),
                meaning: "公式表达输入变量的关系".into(),
                terms: vec!["x".into()],
                evidence_lids: vec!["1.1".into()],
            },
            context_links: vec![],
        };
        let book = Book::new(base, &src).with_formula_semantics(vec![semantics]);
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let store = MemoryStore::open(tmp("formula-semantics-get")).unwrap();
        let adapter = Box::new(StubAdapter { lid: "1.1".into() });
        let mut s = AppState {
            book_dir: tmp_dir("formula-semantics-book-dir"),
            book,
            reader,
            store,
            adapter,
            messages: new_session(),
            session_path: None,
            history_path: None,
            agent_history: AgentHistory::default(),
            visitor_sessions: mcp::VisitorSessions::default(),
        };

        let ok = get(&mut s, "/book/formula_semantics?lid=1.1");
        assert_eq!(ok.status, 200);
        assert!(ok.body.contains("\"formula_lid\":\"1.1\""));
        assert!(ok.body.contains("输入变量"));
        assert_eq!(get(&mut s, "/book/formula_semantics?lid=9.9").status, 404);
        assert_eq!(get(&mut s, "/book/formula_semantics").status, 400);
    }
    #[test]
    fn route_from_and_route_to_get() {
        let mut s = state_named("route_nav");
        // BookStructure P8:无 sidecar 时只读工具显式 unavailable,不阻塞服务启动。
        let structure = get(&mut s, "/book/structure?at=1.1");
        assert_eq!(structure.status, 200);
        assert!(structure.body.contains("\"available\":false"));
        let guide = get(&mut s, "/book/guide_path?at=1.1");
        assert_eq!(guide.status, 200);
        assert!(guide.body.contains("\"segments\":[]"));
        assert_eq!(get(&mut s, "/book/structure?at=9.9").status, 404);
        assert_eq!(get(&mut s, "/book/guide_path?at=9.9").status, 404);
        let paper_meta = get(&mut s, "/book/paper_metadata");
        assert_eq!(paper_meta.status, 200);
        assert!(paper_meta.body.contains("\"available\":false"));
        let paper_lexicon = get(&mut s, "/book/paper_lexicon");
        assert_eq!(paper_lexicon.status, 200);
        assert!(paper_lexicon.body.contains("\"entries\":[]"));
        let paper = get(&mut s, "/book/paper_reading_guide?mode=close&stage=active");
        assert_eq!(paper.status, 200);
        assert!(paper.body.contains("\"available\":false"));
        assert!(paper.body.contains("paper artifacts not attached"));
        assert_eq!(
            get(&mut s, "/book/paper_reading_guide?mode=nope").status,
            400
        );

        // route_from:200 + 返 5 类前沿(Frontier 总含全 5 键)。
        let rf = get(&mut s, "/book/route_from?at=1.1");
        assert_eq!(rf.status, 200);
        assert!(rf.body.contains("\"forward\"") && rf.body.contains("\"continue\""));
        // 缺 at → 400;非法 k → 400;invalid at → 404。
        assert_eq!(get(&mut s, "/book/route_from").status, 400);
        assert_eq!(get(&mut s, "/book/route_from?at=1.1&k=abc").status, 400);
        assert_eq!(get(&mut s, "/book/route_from?at=9.9").status, 404);
        // route_to:200 + 含 path 字段(同端点空路径非 error)。
        let rt = get(&mut s, "/book/route_to?from=1.1&target=1.1");
        assert_eq!(rt.status, 200);
        assert!(rt.body.contains("\"path\""));
        // 缺 target → 400;invalid 端点 → 404。
        assert_eq!(get(&mut s, "/book/route_to?from=1.1").status, 400);
        assert_eq!(
            get(&mut s, "/book/route_to?from=1.1&target=9.9").status,
            404
        );
        // guided_route_from(P3-3):200 + {at, groups}(教学整形,空组已剔)。
        let gf = get(&mut s, "/book/guided_route_from?at=1.1");
        assert_eq!(gf.status, 200);
        assert!(gf.body.contains("\"groups\"") && gf.body.contains("\"at\""));
        // 缺 at → 400;非法 k → 400;invalid at → 404。
        assert_eq!(get(&mut s, "/book/guided_route_from").status, 400);
        assert_eq!(
            get(&mut s, "/book/guided_route_from?at=1.1&k=abc").status,
            400
        );
        assert_eq!(get(&mut s, "/book/guided_route_from?at=9.9").status, 404);
        // unvisited_back(P3-2 裸「没懂」兜底):200 + {at, unvisited_back};缺 at→400;invalid at→404。
        let ub = get(&mut s, "/book/unvisited_back?at=1.1");
        assert_eq!(ub.status, 200);
        assert!(ub.body.contains("\"unvisited_back\"") && ub.body.contains("\"at\""));
        assert_eq!(get(&mut s, "/book/unvisited_back").status, 400);
        assert_eq!(get(&mut s, "/book/unvisited_back?at=9.9").status, 404);
    }

    #[test]
    fn unknown_route_404_and_wrong_method_405() {
        let mut s = state_named("route");
        assert_eq!(get(&mut s, "/book/nope").status, 404);
        assert!(get(&mut s, "/book/nope").body.contains("ROUTE_NOT_FOUND"));
        // 错方法:POST 到 book.* / GET 到 reader.* → 405
        assert_eq!(post(&mut s, "/book/manifest", "{}").status, 405);
        assert_eq!(get(&mut s, "/reader/goto").status, 405);
    }

    #[test]
    fn percent_decode_cjk_and_space() {
        assert_eq!(percent_decode("%E5%91%BD%E4%BB%A4"), "命令");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    // ── S10b reader.* / memory.* POST ───────────────────────
    #[test]
    fn reader_goto_returns_viewport_and_unknown_lid_404() {
        let mut s = state_named("goto");
        let ok = post(&mut s, "/reader/goto", r#"{"lid":"1.1"}"#);
        assert_eq!(ok.status, 200);
        assert!(ok.body.contains("\"anchor_lid\":\"1.1\""));
        assert!(ok.body.contains("\"viewport\""));
        // 非法 LID 透传 LID_NOT_FOUND 不降级 `[ADR-0015]`。
        let nf = post(&mut s, "/reader/goto", r#"{"lid":"9.9"}"#);
        assert_eq!(nf.status, 404);
        assert!(nf.body.contains("LID_NOT_FOUND"));
    }

    #[test]
    fn reader_scroll_returns_viewport() {
        let mut s = state_named("scroll");
        let r = post(&mut s, "/reader/scroll", r#"{"delta":0}"#);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"viewport\""));
        // 缺 delta → 400
        assert_eq!(post(&mut s, "/reader/scroll", "{}").status, 400);
    }

    #[test]
    fn reader_highlight_and_note_delegate_to_memory() {
        let mut s = state_named("hlnote");
        let hl = post(&mut s, "/reader/highlight", r#"{"lid":"1.1"}"#);
        assert_eq!(hl.status, 200);
        assert!(hl.body.contains("highlight_id"));
        let note = post(
            &mut s,
            "/reader/note",
            r#"{"lid":"1.1","text":"命令=对象化调用"}"#,
        );
        assert_eq!(note.status, 200);
        assert!(note.body.contains("note_id"));
        // 标注单源:经 /memory/recall 回显(highlight + note 各一条)。
        let rc = post(&mut s, "/memory/recall", r#"{"lid":"1.1"}"#);
        assert_eq!(rc.status, 200);
        assert!(rc.body.contains("命令=对象化调用"));
        assert!(rc.body.contains("\"type\":\"highlight\""));
        assert!(rc.body.contains("\"type\":\"note\""));
    }

    // H1:段内自由高亮 range → 切子串作 content + 存 range(recall 回显);越界 → 400 `[ADR-0031]`。
    #[test]
    fn reader_highlight_with_range_stores_substring() {
        let mut s = state_named("hlrange");
        // 叶 "1.1" 原文前 100 字符为 'X';range [0,5) → "XXXXX"。
        let hl = post(
            &mut s,
            "/reader/highlight",
            r#"{"lid":"1.1","range":{"start":0,"end":5},"source_session_id":"highlight-group:test"}"#,
        );
        assert_eq!(hl.status, 200);
        let rc = post(
            &mut s,
            "/memory/recall",
            r#"{"lid":"1.1","type":"highlight"}"#,
        );
        assert_eq!(rc.status, 200);
        assert!(rc.body.contains("\"range\""));
        assert!(rc.body.contains("\"start\":0"));
        assert!(rc.body.contains("\"content\":\"XXXXX\""));
        assert!(rc
            .body
            .contains("\"source_session_id\":\"highlight-group:test\""));
        // 越界 → 400 INVALID_RANGE 不降级。
        let oob = post(
            &mut s,
            "/reader/highlight",
            r#"{"lid":"1.1","range":{"start":0,"end":9999}}"#,
        );
        assert_eq!(oob.status, 400);
        assert!(oob.body.contains("INVALID_RANGE"));
    }

    #[test]
    fn reader_state_readonly() {
        let mut s = state_named("state");
        post(&mut s, "/reader/goto", r#"{"lid":"1.1"}"#);
        let r = post(&mut s, "/reader/state", "");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"viewport\""));
        assert!(r.body.contains("\"selection\":\"1.1\""));
        assert!(r.body.contains("\"layout\""));
        assert!(r.body.contains("\"active_preset\":\"technical_read\""));
        assert!(r.body.contains("\"profile\""));
        assert!(r.body.contains("\"profile_id\":\"technical_learning\""));
        assert!(r.body.contains("\"allowed_layout_actions\""));
    }

    #[test]
    fn reader_layout_apply_direct_proposal_and_stale() {
        let mut s = state_named("layout");
        let direct = post(
            &mut s,
            "/reader/layout.apply",
            r#"{"actions":[
                {"kind":"open_slot","slot_id":"technical.evidence","region":"right"},
                {"kind":"focus_slot","slot_id":"technical.evidence"}
            ]}"#,
        );
        assert_eq!(direct.status, 200);
        assert!(direct.body.contains("\"kind\":\"effect\""));
        assert_eq!(s.reader.layout_state().rev, 1);
        assert_eq!(
            s.reader.layout_state().focused_slot.as_deref(),
            Some("technical.evidence")
        );

        let proposal = post(
            &mut s,
            "/reader/layout.apply",
            r#"{"actions":[{"kind":"close_slot","slot_id":"technical.agent"}]}"#,
        );
        assert_eq!(proposal.status, 200);
        assert!(proposal.body.contains("\"kind\":\"proposal\""));
        assert!(s
            .reader
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));
        let value: serde_json::Value = serde_json::from_str(&proposal.body).unwrap();
        let proposal_id = value["proposal"]["proposal_id"].as_str().unwrap();
        let base_layout_rev = value["proposal"]["base_layout_rev"].as_u64().unwrap();
        let apply = post(
            &mut s,
            "/reader/layout.apply",
            &format!(r#"{{"proposal_id":"{proposal_id}","base_layout_rev":{base_layout_rev}}}"#),
        );
        assert_eq!(apply.status, 200);
        assert!(!s
            .reader
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));

        let stale = post(
            &mut s,
            "/reader/layout.apply",
            r#"{"actions":[{"kind":"reset_layout"}]}"#,
        );
        assert_eq!(stale.status, 200);
        let stale_value: serde_json::Value = serde_json::from_str(&stale.body).unwrap();
        let stale_id = stale_value["proposal"]["proposal_id"].as_str().unwrap();
        let stale_rev = stale_value["proposal"]["base_layout_rev"].as_u64().unwrap();
        post(
            &mut s,
            "/reader/layout.apply",
            r#"{"actions":[{"kind":"open_slot","slot_id":"technical.evidence"}]}"#,
        );
        let rejected = post(
            &mut s,
            "/reader/layout.apply",
            &format!(r#"{{"proposal_id":"{stale_id}","base_layout_rev":{stale_rev}}}"#),
        );
        assert_eq!(rejected.status, 400);
        assert!(rejected.body.contains("LAYOUT_PROPOSAL_STALE"));
    }

    #[test]
    fn memory_save_and_recall_roundtrip() {
        let mut s = state_named("memrt");
        let sv = post(
            &mut s,
            "/memory/save",
            r#"{"type":"note","anchor_lid":"1.1","content":"闭包即对象"}"#,
        );
        assert_eq!(sv.status, 200);
        assert!(sv.body.contains("mem_id"));
        assert!(sv.body.contains("\"lid\":\"1.1\"")); // citation 自动锚回
        let rc = post(&mut s, "/memory/recall", r#"{"text":"闭包"}"#);
        assert_eq!(rc.status, 200);
        assert!(rc.body.contains("闭包即对象"));
    }

    #[test]
    fn memory_save_missing_fields_400() {
        let mut s = state_named("memmiss");
        let r = post(&mut s, "/memory/save", r#"{"type":"note"}"#);
        assert_eq!(r.status, 400);
        assert!(r.body.contains("INVALID_MEMORY_TYPE"));
    }

    // S10g-pre:memory.delete 删一条后 recall 不再返;删不存在 → 404 MEMORY_NOT_FOUND 不降级。
    #[test]
    fn memory_delete_removes_and_missing_404() {
        let mut s = state_named("memdel");
        let sv = post(
            &mut s,
            "/memory/save",
            r#"{"type":"note","anchor_lid":"1.1","content":"删我"}"#,
        );
        assert_eq!(sv.status, 200);
        let v: serde_json::Value = serde_json::from_str(&sv.body).unwrap();
        let mem_id = v["mem_id"].as_str().unwrap();
        let del = post(
            &mut s,
            "/memory/delete",
            &format!(r#"{{"mem_id":"{mem_id}"}}"#),
        );
        assert_eq!(del.status, 200);
        assert!(del.body.contains("\"ok\":true"));
        let rc = post(&mut s, "/memory/recall", r#"{"lid":"1.1"}"#);
        assert!(!rc.body.contains("删我"));
        let nf = post(&mut s, "/memory/delete", r#"{"mem_id":"mem_nope"}"#);
        assert_eq!(nf.status, 404);
        assert!(nf.body.contains("MEMORY_NOT_FOUND"));
    }

    #[test]
    fn bad_json_body_400() {
        let mut s = state_named("badjson");
        let r = post(&mut s, "/reader/goto", "{not json");
        assert_eq!(r.status, 400);
        assert!(r.body.contains("INVALID_RANGE"));
    }

    // ── S10c book.query POST ────────────────────────────────
    #[test]
    fn book_query_returns_query_response() {
        let mut s = state_named("query");
        // 缺省 anchor = reader 首叶 "1.1";桩引用 "1.1" 落证据集 → 过交叉验停。
        let r = post(&mut s, "/book/query", r#"{"q":"什么是命令模式"}"#);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"scope_used\":\"local\""));
        assert!(r.body.contains("\"incomplete\":false"));
        assert!(r.body.contains("\"lid\":\"1.1\"")); // citation 全真 LID
        assert!(r.body.contains("桩答案"));
    }

    #[test]
    fn book_query_explicit_anchor() {
        let mut s = state_named("query-anchor");
        let r = post(&mut s, "/book/query", r#"{"q":"问","anchor_lid":"1.1"}"#);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"citations\""));
    }

    #[test]
    fn book_query_missing_q_400() {
        let mut s = state_named("query-missing");
        let r = post(&mut s, "/book/query", "{}");
        assert_eq!(r.status, 400);
        assert!(r.body.contains("INVALID_RANGE"));
    }

    #[test]
    fn book_query_get_405() {
        let mut s = state_named("query-get");
        let r = get(&mut s, "/book/query");
        assert_eq!(r.status, 405);
        assert!(r.body.contains("METHOD_NOT_ALLOWED"));
    }

    // provider 错(.env 缺/后端挂)经 runtime::query 映射 PROVIDER_ERROR → 502,透传不降级。
    #[test]
    fn book_query_provider_error_502() {
        let mut s = state_named("query-err");
        s.adapter = Box::new(UnconfiguredAdapter);
        let r = post(&mut s, "/book/query", r#"{"q":"x"}"#);
        assert_eq!(r.status, 502);
        assert!(r.body.contains("PROVIDER_ERROR"));
    }

    #[test]
    fn book_synthesize_returns_response() {
        let mut s = state_named("synth");
        let r = post(
            &mut s,
            "/book/synthesize",
            r#"{"lids":["1.1"],"task":"总结"}"#,
        );
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"source_lids\":[\"1.1\"]"));
        assert!(r.body.contains("\"batched\":false"));
        assert!(r.body.contains("桩答案"));
    }

    #[test]
    fn book_synthesize_loads_formula_and_discourse_sidecars() {
        let dir = std::env::temp_dir().join("ub-server-synth-sidecars");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut base = sample_base();
        base.lid_nodes[1].kind = NodeKind::Formula;
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "X".repeat(100)).unwrap();
        let semantics = vec![FormulaSemantics {
            formula_lid: "1.1".into(),
            parameters: vec![FormulaParameter {
                symbol: "x".into(),
                label: Some("input".into()),
                meaning: "输入变量".into(),
                unit: None,
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "1.1".into(),
                meaning: "公式表达输入变量的关系".into(),
                terms: vec!["x".into()],
                evidence_lids: vec!["1.1".into()],
            },
            context_links: vec![],
        }];
        std::fs::write(
            dir.join("formula_semantics.json"),
            serde_json::to_string(&semantics).unwrap(),
        )
        .unwrap();
        let discourse = serde_json::json!({
            "items": [{
                "lid": "1.1",
                "mode": "informative",
                "local_function": "definition",
                "rhetorical_move": "main_point",
                "local_summary": "定义核心公式",
                "relations": []
            }]
        });
        std::fs::write(dir.join("discourse_index.json"), discourse.to_string()).unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let store = MemoryStore::open(tmp("synth-sidecars")).unwrap();
        let users = Arc::new(Mutex::new(Vec::new()));
        let adapter = Box::new(RecordingAdapter {
            lid: "1.1".into(),
            users: Arc::clone(&users),
        });
        let mut s = AppState {
            book_dir: dir.clone(),
            book,
            reader,
            store,
            adapter,
            messages: new_session(),
            session_path: None,
            history_path: None,
            agent_history: AgentHistory::default(),
            visitor_sessions: mcp::VisitorSessions::default(),
        };

        let r = post(
            &mut s,
            "/book/synthesize",
            r#"{"lids":["1.1"],"task":"解释公式"}"#,
        );
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"source_lids\":[\"1.1\"]"));
        let prompts = users.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Composition: 公式表达输入变量的关系"));
        assert!(prompts[0].contains("- x (input): 输入变量 [1.1]"));
        assert!(prompts[0].contains("Discourse 1.1: mode=informative"));
        assert!(prompts[0].contains("local_function=definition"));
        assert!(prompts[0].contains("summary=定义核心公式"));

        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn book_synthesize_missing_lids_400_and_get_405() {
        let mut s = state_named("synth-missing");
        assert_eq!(post(&mut s, "/book/synthesize", "{}").status, 400);
        assert_eq!(get(&mut s, "/book/synthesize").status, 405);
    }
    #[test]
    fn session_loads_legacy_single_book_format() {
        let dir = write_multi_leaf_book("session-legacy-book", "legacy-book", 30);
        let session_path = tmp("session-legacy");
        std::fs::write(
            &session_path,
            serde_json::json!({
                "book_dir": path_string(&dir),
                "top_lid": "1.6"
            })
            .to_string(),
        )
        .unwrap();

        let session = load_session(&Some(session_path)).unwrap();
        assert_eq!(
            session.current_book_dir,
            session_dir_key(&path_string(&dir))
        );
        assert_eq!(session.top_lid_for_dir(&path_string(&dir)), Some("1.6"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_start_prefers_last_open_book_and_its_saved_top() {
        let requested = write_multi_leaf_book("session-start-requested", "requested-book", 30);
        let current = write_multi_leaf_book("session-start-current", "current-book", 30);
        let current_key = session_dir_key(&path_string(&current));
        let mut books = BTreeMap::new();
        books.insert(
            session_dir_key(&path_string(&requested)),
            SessionBookProgress {
                top_lid: "1.3".into(),
            },
        );
        books.insert(
            current_key.clone(),
            SessionBookProgress {
                top_lid: "1.9".into(),
            },
        );
        let session = SessionState {
            current_book_dir: current_key.clone(),
            books,
        };

        let (dir, top) = select_start_book(path_string(&requested), Some(&session));
        assert_eq!(dir, current_key);
        assert_eq!(top.as_deref(), Some("1.9"));
        let _ = std::fs::remove_dir_all(&requested);
        let _ = std::fs::remove_dir_all(&current);
    }

    #[test]
    fn book_open_restores_progress_per_book() {
        let dir_a = write_multi_leaf_book("session-book-a", "book-a", 30);
        let dir_b = write_multi_leaf_book("session-book-b", "book-b", 30);
        let session_path = tmp("session-per-book");
        let mut s = state_named("session-per-book-store");
        s.session_path = Some(session_path.clone());

        let body_a = format!(
            r#"{{"dir":{}}}"#,
            serde_json::to_string(&path_string(&dir_a)).unwrap()
        );
        let body_b = format!(
            r#"{{"dir":{}}}"#,
            serde_json::to_string(&path_string(&dir_b)).unwrap()
        );

        assert_eq!(post(&mut s, "/book/open", &body_a).status, 200);
        assert_eq!(
            post(&mut s, "/reader/goto", r#"{"lid":"1.11"}"#).status,
            200
        );
        assert_eq!(s.reader.viewport().top_lid, "1.11");

        assert_eq!(post(&mut s, "/book/open", &body_b).status, 200);
        assert_eq!(post(&mut s, "/reader/goto", r#"{"lid":"1.6"}"#).status, 200);
        assert_eq!(s.reader.viewport().top_lid, "1.6");

        assert_eq!(post(&mut s, "/book/open", &body_a).status, 200);
        assert_eq!(s.reader.viewport().top_lid, "1.11");
        assert_eq!(post(&mut s, "/book/open", &body_b).status, 200);
        assert_eq!(s.reader.viewport().top_lid, "1.6");

        let session = load_session(&Some(session_path)).unwrap();
        assert_eq!(session.top_lid_for_dir(&path_string(&dir_a)), Some("1.11"));
        assert_eq!(session.top_lid_for_dir(&path_string(&dir_b)), Some("1.6"));
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn book_open_reloads_book_and_resets_session_state() {
        let dir = tmp("open-book-dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut base = sample_base();
        base.book_id = "opened-book".into();
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "Y".repeat(100)).unwrap();

        let mut s = state_named("open-book");
        s.messages.push(Message::user("old conversation"));
        let body = format!(
            r#"{{"dir":{}}}"#,
            serde_json::to_string(dir.to_str().unwrap()).unwrap()
        );
        let r = post(&mut s, "/book/open", &body);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("opened-book"));
        assert_eq!(s.book.base.book_id, "opened-book");
        assert_eq!(s.reader.state().viewport.anchor_lid, "1.1");
        assert_eq!(s.messages.len(), 1);

        assert_eq!(post(&mut s, "/book/open", "{}").status, 400);
        assert_eq!(get(&mut s, "/book/open").status, 405);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn book_open_allows_prebase_directory_to_enter_workbench() {
        let dir = tmp_dir("open-workbench-prebase");
        std::fs::write(dir.join("paper.md"), "draft").unwrap();

        let mut s = state_named("open-workbench");
        let body = format!(
            r#"{{"dir":{}}}"#,
            serde_json::to_string(dir.to_str().unwrap()).unwrap()
        );
        let r = post(&mut s, "/book/open", &body);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"route\":\"workbench\""));
        assert_eq!(s.book_dir, dir);

        let snapshot = get(&mut s, "/book/build_workbench");
        assert_eq!(snapshot.status, 200);
        let body: serde_json::Value = serde_json::from_str(&snapshot.body).unwrap();
        assert_eq!(body["book_id"], "ub-server-test-open-workbench-prebase");
        assert_eq!(body["readiness"]["route"], "workbench");
        assert_eq!(body["readiness"]["status"], "missing");
    }
    // ── S10f /agent/chat + /agent/new ───────────────────────
    // /agent/chat:外层 E agent 驱动共享 reader,返 OuterOutcome 含 effects(可撤销提议)。
    #[test]
    fn agent_chat_drives_shared_reader_and_returns_effects() {
        let mut s = state_named("agent");
        // 脚本:turn1 调 reader.highlight(1.1)→ turn2 终答(脱真 LLM,守 A2)。
        s.adapter = Box::new(ChatStubAdapter::scripted(vec![
            AssistantTurn {
                text: None,
                tool_calls: vec![ToolCall {
                    id: "t1".into(),
                    name: "reader.highlight".into(),
                    arguments: r#"{"lid":"1.1"}"#.into(),
                }],
                usage_total_tokens: Some(5),
            },
            AssistantTurn {
                text: Some("已高亮第一段".into()),
                tool_calls: vec![],
                usage_total_tokens: Some(5),
            },
        ]));
        let r = post(&mut s, "/agent/chat", r#"{"message":"高亮第一段"}"#);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"incomplete\":false"));
        assert!(r.body.contains("已高亮第一段"));
        // effects 含 Highlight 提议(tagged enum kind);trace 记录 tool call。
        assert!(r.body.contains("\"kind\":\"Highlight\""));
        assert!(r.body.contains("reader.highlight"));
        // agent 标注落 session 层(提议态)→ recall(layer=session)查得到,真驱动了共享 store。
        let rc = post(&mut s, "/memory/recall", r#"{"layer":"session"}"#);
        assert_eq!(rc.status, 200);
        assert!(rc.body.contains("\"type\":\"highlight\""));
    }

    #[test]
    fn agent_history_new_select_delete_preserves_transcript_and_messages() {
        let mut s = state_named("agent-history");
        s.adapter = Box::new(ChatStubAdapter::scripted(vec![AssistantTurn {
            text: Some("答案一".into()),
            tool_calls: vec![],
            usage_total_tokens: Some(3),
        }]));
        let chat = post(
            &mut s,
            "/agent/chat",
            r#"{"message":"内部提示","display_user":"用户看到的问题","question_anchor_lid":"1.1","question_quote":{"lid":"1.1","quote":"引用"}} "#,
        );
        assert_eq!(chat.status, 200);
        assert!(s.messages.len() > 1);

        let history = get(&mut s, "/agent/history");
        assert_eq!(history.status, 200);
        let history: serde_json::Value = serde_json::from_str(&history.body).unwrap();
        let old_id = history["active_session_id"].as_str().unwrap().to_string();
        assert_eq!(history["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(
            history["sessions"][0]["turns"][0]["question_anchor_lid"],
            "1.1"
        );
        assert_eq!(history["current"]["turns"][0]["user"], "用户看到的问题");
        assert_eq!(
            history["current"]["turns"][0]["question_quote"]["quote"],
            "引用"
        );

        let new_chat = post(&mut s, "/agent/new", "{}");
        assert_eq!(new_chat.status, 200);
        assert_eq!(s.messages.len(), 1);
        let new_chat: serde_json::Value = serde_json::from_str(&new_chat.body).unwrap();
        let new_id = new_chat["history"]["active_session_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(old_id, new_id);
        assert_eq!(new_chat["history"]["sessions"].as_array().unwrap().len(), 2);

        let select_body = format!(r#"{{"session_id":"{old_id}"}}"#);
        let selected = post(&mut s, "/agent/history/select", &select_body);
        assert_eq!(selected.status, 200);
        assert!(s.messages.len() > 1);
        let selected: serde_json::Value = serde_json::from_str(&selected.body).unwrap();
        assert_eq!(selected["active_session_id"], old_id);
        assert_eq!(selected["current"]["turns"][0]["user"], "用户看到的问题");

        let deleted = post(&mut s, "/agent/history/delete", &select_body);
        assert_eq!(deleted.status, 200);
        assert_eq!(s.messages.len(), 1);
        let deleted: serde_json::Value = serde_json::from_str(&deleted.body).unwrap();
        assert_eq!(deleted["active_session_id"], new_id);
        assert_eq!(deleted["sessions"].as_array().unwrap().len(), 1);
    }

    // /agent/new:清空 messages 回到仅 system(会话边界 = 用户「新对话」)。
    #[test]
    fn agent_new_resets_messages() {
        let mut s = state_named("agentnew");
        s.messages.push(Message::user("hi"));
        assert!(s.messages.len() > 1);
        let r = post(&mut s, "/agent/new", "{}");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"ok\":true"));
        assert_eq!(s.messages.len(), 1); // 仅 system
    }

    // agent.* 只支持 POST:GET → 405。
    #[test]
    fn agent_chat_get_405() {
        let mut s = state_named("agentget");
        let r = get(&mut s, "/agent/chat");
        assert_eq!(r.status, 405);
        assert!(r.body.contains("METHOD_NOT_ALLOWED"));
        let r = post(&mut s, "/agent/history", "{}");
        assert_eq!(r.status, 405);
        assert!(r.body.contains("METHOD_NOT_ALLOWED"));
    }

    // 缺 message → 400。
    #[test]
    fn agent_chat_missing_message_400() {
        let mut s = state_named("agentmiss");
        let r = post(&mut s, "/agent/chat", "{}");
        assert_eq!(r.status, 400);
        assert!(r.body.contains("INVALID_RANGE"));
    }
}
