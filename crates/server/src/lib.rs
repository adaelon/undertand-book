//! 读时 localhost 服务:把冻结命令面投影成 REST `[ADR-0028]`。
//! S10a:`book.*` 四只读叶子 → GET。S10b:`reader.*`/`memory.*` 可变命令 → POST(JSON body),
//! reader.* 返 effect、highlight/note 委托 memory.save(标注单源 `[ADR-0015/0006]`)、非法 LID 透传不降级。
//! S10c:`book.query` 是 LLM 命令(秒级,非确定性叶子)→ **POST**(body `{q, anchor_lid?}`),
//! 直调内层 `runtime::query`(provider 经注入的 `ModelAdapter`)→ 返 `QueryResponse`,结构红线由
//! 内层确定性交叉验停守(citations⊆证据集);anchor 缺省取 reader 当前 anchor(读模式起点)。
//! 路由是**纯函数 `route(&mut AppState, Req) -> Reply`**(脱 socket 可单测,守 A2);
//! socket 绑定 / worker 线程 / Mutex 锁 / 时间戳生成 / adapter 装配在 `main.rs`。
//! synthesize、外层 E agent(S10f)、静态资源(S10e)留后续子切片。
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput};
use read_tools::{Book, ToolError};
use reader::Reader;
use runtime::orchestrator::{new_session, run, OuterConfig};
use runtime::{AdapterError, AssistantTurn, CompletionRequest, Message, ModelAdapter, ParsedResponse, ToolSpec};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;

/// 服务的单会话共享状态(切片0 单用户单书)`[ADR-0028 决策2]`。
/// S10b:持只读 `Book` + 会话态 `Reader` + 用户私有 `MemoryStore`(物理隔离 `[ADR-0006]`)。
/// S10c:持 LLM `adapter`(`book.query` 经它触模型;`+ Send` 供 `Arc<Mutex<_>>` 跨 worker 线程)。
pub struct AppState {
    pub book: Book,
    pub reader: Reader,
    pub store: MemoryStore,
    pub adapter: Box<dyn ModelAdapter + Send>,
    /// 外层 E agent 的会话 messages(S10f `[ADR-0030]`)。`/agent/chat` 跨回合累积、`/agent/new` 重置;
    /// 会话边界 = 用户「新对话」(不自动 idle 判定)。
    pub messages: Vec<Message>,
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

/// 纯函数路由 `[ADR-0028 决策3]`:按命名空间前缀定方法(`book.*`→GET 只读、
/// `reader.*`/`memory.*`→POST 可变),端点名 = 命令名,错误原样透传 §4.4 信封。
pub fn route(state: &mut AppState, req: Req) -> Reply {
    let (path, q) = parse_query(req.url);
    // book.query:`book.*` 命名空间但 LLM 命令(秒级、非确定性叶子)→ POST,
    // 单列于 GET-only `route_book` 之前(决策3 的方法分派对它例外)`[ADR-0014/0028]`。
    if path == "/book/query" {
        if req.method != "POST" {
            return query_method_not_allowed();
        }
        return route_query(state, req.body);
    }
    // agent.*(S10f):外层 E agent 编排,POST(会话命令)`[ADR-0030]`。
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
        state.messages = new_session();
        return ok_json(&json!({ "ok": true }));
    }
    if let Some(p) = path.strip_prefix("/book/") {
        if req.method != "GET" {
            return method_not_allowed();
        }
        route_book(&state.book, p, &q)
    } else if path.starts_with("/reader/") || path.starts_with("/memory/") {
        if req.method != "POST" {
            return method_not_allowed();
        }
        route_mut(state, path.as_str(), req.body, req.now)
    } else {
        route_not_found(&path)
    }
}

/// `book.*` 只读叶子 → GET(S10a)。
fn route_book(book: &Book, leaf: &str, q: &HashMap<String, String>) -> Reply {
    match leaf {
        "manifest" => ok_json(&book.manifest()),
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
        _ => route_not_found(&format!("/book/{leaf}")),
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
            // 字段级不相交借用:reader(mut) + book(shared)。
            match state.reader.goto_lid(&state.book, lid) {
                Ok(e) => ok_json(&e),
                Err(e) => err_reply(&e),
            }
        }
        "/reader/scroll" => {
            let Some(delta) = v.get("delta").and_then(|x| x.as_i64()) else {
                return validation("INVALID_RANGE", "reader.scroll 需 delta(整数)");
            };
            ok_json(&state.reader.scroll(delta))
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
            match state.reader.highlight(&state.book, &mut state.store, lid, range, "long_term", now) {
                Ok(e) => ok_json(&e),
                Err(e) => err_reply(&e),
            }
        }
        "/reader/note" => {
            let (Some(lid), Some(text)) = (sget("lid"), sget("text")) else {
                return validation("INVALID_RANGE", "reader.note 需 lid + text");
            };
            match state.reader.note(&state.book, &mut state.store, lid, text, "long_term", now) {
                Ok(e) => ok_json(&e),
                Err(e) => err_reply(&e),
            }
        }
        "/reader/state" => ok_json(&state.reader.state()),
        "/memory/save" => {
            let (Some(ty), Some(anchor), Some(content)) =
                (sget("type"), sget("anchor_lid"), sget("content"))
            else {
                return validation("INVALID_MEMORY_TYPE", "memory.save 需 type + anchor_lid + content");
            };
            // layer:显式给则用,否则按类型默认(position→session,其余→long_term)`[ADR-0006]`。
            let layer = sget("layer").unwrap_or(if ty == "position" { "session" } else { "long_term" });
            let input = SaveInput {
                mem_id: None,
                mem_type: ty.into(),
                layer: layer.into(),
                book_id: state.book.base.book_id.clone(),
                anchor: Anchor { lid: Some(anchor.into()), concept: None },
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
        Ok(out) => ok_json(&out),
        Err(e) => err_reply(&e),
    }
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

/// book.query 是 book.* 里唯一只收 POST 的端点(LLM 命令),405 文案单列以免误导。
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
            message: "未配置 LLM 后端:缺 .env(OPENCODE_API_KEY / OPENCODE_BASE_URL / FLUID_LLM_MODEL)".into(),
        })
    }
    fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
        Err(AdapterError {
            message: "未配置 LLM 后端:缺 .env(OPENCODE_API_KEY / OPENCODE_BASE_URL / FLUID_LLM_MODEL)".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::sample_base;
    use reader::DEFAULT_RADIUS;
    use runtime::{RawCitation, ToolCall};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-server-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
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

    fn state_named(mem: &str) -> AppState {
        // sample_base:容器 "1" + 叶 "1.1";entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        let book = Book::new(sample_base(), &src);
        let reader = Reader::new(&book, DEFAULT_RADIUS);
        let store = MemoryStore::open(tmp(mem)).unwrap();
        // 默认桩引用首叶 "1.1"(book.query 缺省 anchor = reader 首叶,落证据集)。
        let adapter = Box::new(StubAdapter { lid: "1.1".into() });
        AppState { book, reader, store, adapter, messages: new_session() }
    }

    /// 脚本化外层 chat 替身(S10f):按序吐 AssistantTurn,driv 外层 loop 脱真 LLM 可测(守 A2)。
    /// `complete` 不走(内层 book.query 在 agent 测里不触发)。
    struct ChatStubAdapter {
        turns: RefCell<VecDeque<AssistantTurn>>,
    }
    impl ChatStubAdapter {
        fn scripted(turns: Vec<AssistantTurn>) -> Self {
            ChatStubAdapter { turns: RefCell::new(turns.into()) }
        }
    }
    impl ModelAdapter for ChatStubAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            unimplemented!("agent 测不走内层 complete")
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            self.turns.borrow_mut().pop_front().ok_or_else(|| AdapterError {
                message: "chat 脚本耗尽".into(),
            })
        }
    }

    fn get(s: &mut AppState, url: &str) -> Reply {
        route(s, Req { method: "GET", url, body: "", now: "t0" })
    }
    fn post(s: &mut AppState, url: &str, body: &str) -> Reply {
        route(s, Req { method: "POST", url, body, now: "t0" })
    }

    // ── S10a book.* GET(回归)────────────────────────────────
    #[test]
    fn manifest_ok() {
        let r = get(&mut state_named("manifest"), "/book/manifest");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"tree\""));
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
        let note = post(&mut s, "/reader/note", r#"{"lid":"1.1","text":"命令=对象化调用"}"#);
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
        let hl = post(&mut s, "/reader/highlight", r#"{"lid":"1.1","range":{"start":0,"end":5}}"#);
        assert_eq!(hl.status, 200);
        let rc = post(&mut s, "/memory/recall", r#"{"lid":"1.1","type":"highlight"}"#);
        assert_eq!(rc.status, 200);
        assert!(rc.body.contains("\"range\""));
        assert!(rc.body.contains("\"start\":0"));
        assert!(rc.body.contains("\"content\":\"XXXXX\""));
        // 越界 → 400 INVALID_RANGE 不降级。
        let oob = post(&mut s, "/reader/highlight", r#"{"lid":"1.1","range":{"start":0,"end":9999}}"#);
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
        let sv = post(&mut s, "/memory/save", r#"{"type":"note","anchor_lid":"1.1","content":"删我"}"#);
        assert_eq!(sv.status, 200);
        let v: serde_json::Value = serde_json::from_str(&sv.body).unwrap();
        let mem_id = v["mem_id"].as_str().unwrap();
        let del = post(&mut s, "/memory/delete", &format!(r#"{{"mem_id":"{mem_id}"}}"#));
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
            AssistantTurn { text: Some("已高亮第一段".into()), tool_calls: vec![], usage_total_tokens: Some(5) },
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
