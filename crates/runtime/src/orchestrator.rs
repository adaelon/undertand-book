//! 外层 E 编排 loop `[ADR-0026/0016/0005]`:messages 会话态、LLM 自主多轮 tool-calling、
//! 双重停机(max_turns ∨ usage token 触顶 → 诚实标 incomplete)、工具错误回喂不降级。
//! 外层工具集 = book.query/text/context/concept + memory.save/recall + reader.gotoLid/scroll/highlight/note/state。
//! book.manifest **不在外层暴露**(返回全树 token 炸弹,S7 真跑实测一次撑爆 budget;外层导航靠 concept/context 足够);
//! dispatch 仍保留 manifest 防御分支。reader.* 是会话态阅读器(S7 接入):agent 经命令面驱动
//! 「问→跳转→高亮→记笔记」闭环 `[ADR-0007/0015]`。
//! 内层 book.query 复用 `crate::query`(同一 adapter 触 `complete`)`[ADR-0025]`。
use crate::{query, synthesize, AssistantTurn, Message, ModelAdapter, Role, ToolSpec};
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput};
use read_tools::{Book, ToolError};
use reader::Reader;
use serde::Serialize;
use ts_rs::TS;

/// 外层停机预算(切片0 占位,实测回填 `[ADR-0016]`)。
#[derive(Debug, Clone, Copy)]
pub struct OuterConfig {
    pub max_turns: usize,
    pub token_budget: u32,
}

impl Default for OuterConfig {
    fn default() -> OuterConfig {
        OuterConfig {
            max_turns: 12,
            token_budget: 120_000,
        }
    }
}

/// 外层 loop 终局 `[ADR-0026]`。incomplete=true ⇒ 触顶诚实标,answer 可能是部分答/缺。
/// `effects`/`trace`:本回合(一次 `/agent/chat`)的可撤销副作用清单 + 查询踪迹 `[ADR-0030]`,
/// runtime 内部结构(非冻结命令面),前端据此渲提议卡 / 折叠踪迹。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct OuterOutcome {
    pub answer: Option<String>,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub turns: usize,
    pub tokens_spent: u32,
    pub effects: Vec<AgentEffect>,
    pub trace: Vec<TraceStep>,
}

/// 一次对话回合的**可撤销副作用** `[ADR-0030 决策3]`:前端据此做反向命令 undo。
/// 提议单元 = 一次对话回合(事务性):视口变更跨回合合并成单条 `Goto`(undo=goto(before));
/// highlight/note 每次一条(undo=memory.delete(mem_id))。agent 标注落 session 层,用户「保留」才升 long_term。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(tag = "kind")]
pub enum AgentEffect {
    /// 视口跳转(goto/scroll 合并);undo = `reader.goto(before_anchor)`。
    Goto {
        before_anchor: String,
        after_anchor: String,
    },
    /// 高亮提议(session 层);undo = `memory.delete(mem_id)`。
    Highlight { mem_id: String, lid: String },
    /// 笔记提议(session 层);undo = `memory.delete(mem_id)`。
    Note {
        mem_id: String,
        lid: String,
        text: String,
    },
}

/// 查询踪迹一步 `[ADR-0030 决策5]`:tool_calls 序列摘要,对用户可见(book.query 的检索范围 + citations 链在 `result_digest` 里)。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct TraceStep {
    pub tool: String,
    pub args: String,
    pub result_digest: String,
}

/// 确定性近似 token(CJK=1,其余=0.25,ceil);仅在后端不返 usage 时兜底 `[ADR-0026]`。
fn estimate_tokens(s: &str) -> u32 {
    let mut t = 0f32;
    for c in s.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            t += 1.0;
        } else {
            t += 0.25;
        }
    }
    t.ceil() as u32
}

fn messages_estimate(messages: &[Message]) -> u32 {
    messages
        .iter()
        .map(|m| m.content.as_deref().map(estimate_tokens).unwrap_or(0))
        .sum()
}

/// 外层 loop 暴露给模型的工具集(7 个;reader.* 留 S7)`[ADR-0026]`。
pub fn tool_specs() -> Vec<ToolSpec> {
    use serde_json::json;
    let s = |name: &str, description: &str, parameters: serde_json::Value| ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters,
    };
    vec![
        s(
            "book.query",
            "对本书做锚定问答:给定问题与一个锚点 LID,内部确定性检索+合一轮作答,返回带真 LID citation 的答案。",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "自然语言问题"},
                    "anchor_lid": {"type": "string", "description": "锚点 LID(从 manifest/context 获得)"}
                },
                "required": ["query", "anchor_lid"]
            }),
        ),
        s(
            "book.synthesize",
            "对调用方给定的离散 LID 集做综合;不外扩检索,返回 citations ⊆ 输入 lids 的综合回答。",
            json!({
                "type": "object",
                "properties": {
                    "lids": {"type": "array", "items": {"type": "string"}, "description": "要综合的 LID 列表"},
                    "task": {"type": "string", "description": "可选综合任务"}
                },
                "required": ["lids"]
            }),
        ),
        s(
            "book.text",
            "按 LID 或 LID 区间取真原文。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "end_lid": {"type": "string", "description": "可选,取 [lid, end_lid] 区间"}
                },
                "required": ["lid"]
            }),
        ),
        s(
            "book.context",
            "取某 LID 的上下文指针:near=树邻接+local 边,mid=near+概念/实体其他 occurrences,far=mid+long_range 边;不带原文,用 book.text 取内容。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "granularity": {"type": "string", "enum": ["near", "mid", "far"], "description": "默认 near"},
                    "k": {"type": "integer", "description": "可选 top-K"}
                },
                "required": ["lid"]
            }),
        ),
        s(
            "book.concept",
            "按名查概念/实体,返回全量出现 LID + 关联实体。",
            json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }),
        ),
        s(
            "memory.save",
            "保存一条记忆(note/highlight/position),自动锚回 LID citation。",
            json!({
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["note", "highlight", "position"]},
                    "anchor_lid": {"type": "string"},
                    "content": {"type": "string"}
                },
                "required": ["type", "anchor_lid", "content"]
            }),
        ),
        s(
            "memory.recall",
            "召回本书相关记忆(可按 lid/type/层/文本子串过滤),每条带可验证 LID citation。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "type": {"type": "string"},
                    "layer": {"type": "string"},
                    "text": {"type": "string"}
                }
            }),
        ),
        s(
            "reader.gotoLid",
            "翻到某 LID(叶→锚到该叶,容器→锚到子树首叶),返回变更后视口 {anchor_lid, visible_lids}。",
            json!({
                "type": "object",
                "properties": {"lid": {"type": "string", "description": "目标 LID"}},
                "required": ["lid"]
            }),
        ),
        s(
            "reader.scroll",
            "沿叶序滚动锚点(delta 正向后/负向前,越界 clamp),返回变更后视口。",
            json!({
                "type": "object",
                "properties": {"delta": {"type": "integer", "description": "沿叶序移动的叶数(可负)"}},
                "required": ["delta"]
            }),
        ),
        s(
            "reader.highlight",
            "高亮某 LID(薄入口,持久化委托记忆层),返回 highlight_id(=记忆层 id)。",
            json!({
                "type": "object",
                "properties": {"lid": {"type": "string"}},
                "required": ["lid"]
            }),
        ),
        s(
            "reader.note",
            "对某 LID 记笔记(薄入口,持久化委托记忆层),返回 note_id(=记忆层 id)。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "text": {"type": "string", "description": "笔记内容"}
                },
                "required": ["lid", "text"]
            }),
        ),
        s(
            "reader.state",
            "取阅读器当前会话态 {viewport, open_panels, selection},供中途接入/手动操作后 re-sync。",
            json!({"type": "object", "properties": {}}),
        ),
    ]
}

const SYSTEM_PROMPT: &str = "你是这本书的阅读 agent。事实性回答经 book.query 取得带真 LID citation 的证据;\
用 book.concept/context/text 定位与读原文。\
特别注意——当用户要求操作阅读器时,必须真的调用对应 reader 工具来执行,不能只靠读原文代替:\
要求『翻到/跳转』调 reader.gotoLid(lid);要求『高亮』调 reader.highlight(lid);要求『记笔记/记录』调 reader.note(lid,text)。\
流程:先用 book.concept/context 定位到目标 LID,一旦定位到就立即调用 reader 工具完成操作,然后给简短终答,不要反复读原文。\
证据不足时诚实说明,不要编造 LID。准备好最终答案时直接用自然语言回复(不再调用工具)。";

/// 执行一次工具调用,返回 `(喂回模型的结果 JSON, 可选可撤销 effect)` `[ADR-0015/0026/0030]`。
/// 错误**不降级**:把 ToolError 信封原样回喂,模型据 recovery 自纠。
/// agent 的 highlight/note 落 `session` 层(提议态,用户「保留」才升 long_term `[ADR-0030]`)。
/// 视口变更(goto/scroll)不在此产 effect:由 `run` 按回合首尾 anchor 合并成单条 `Goto`(事务性 undo)。
#[allow(clippy::too_many_arguments)]
fn dispatch(
    name: &str,
    arguments: &str,
    book: &Book,
    store: &mut MemoryStore,
    reader: &mut Reader,
    adapter: &dyn ModelAdapter,
    now: &str,
) -> (String, Option<AgentEffect>) {
    let args: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(e) => {
            return (
                err_json(
                    "INVALID_RANGE",
                    "validation",
                    &format!("工具参数非合法 JSON: {e}"),
                ),
                None,
            )
        }
    };
    let sget = |k: &str| args.get(k).and_then(|v| v.as_str());

    match name {
        "book.query" => {
            let (Some(q), Some(anchor)) = (sget("query"), sget("anchor_lid")) else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.query 需 query + anchor_lid",
                    ),
                    None,
                );
            };
            let body = match query(book, q, anchor, adapter) {
                Ok(resp) => to_json(&resp),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.synthesize" => {
            let Some(arr) = args.get("lids").and_then(|v| v.as_array()) else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.synthesize 需 lids"),
                    None,
                );
            };
            let lids: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if lids.len() != arr.len() {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.synthesize lids 必须全是字符串",
                    ),
                    None,
                );
            }
            let task = args.get("task").and_then(|v| v.as_str());
            let body = match synthesize(book, &lids, task, adapter) {
                Ok(resp) => to_json(&resp),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.text" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.text 需 lid"),
                    None,
                );
            };
            let body = match book.text(lid, sget("end_lid")) {
                Ok(t) => to_json(&serde_json::json!({ "lid": lid, "text": t })),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.context" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.context 需 lid"),
                    None,
                );
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            let granularity = args.get("granularity").and_then(|v| v.as_str());
            let body = match book.context(lid, granularity, k) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.concept" => {
            let Some(n) = sget("name") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.concept 需 name"),
                    None,
                );
            };
            let body = match book.concept(n) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.manifest" => (to_json(&book.manifest()), None),
        "memory.save" => {
            let (Some(ty), Some(anchor), Some(content)) =
                (sget("type"), sget("anchor_lid"), sget("content"))
            else {
                return (
                    err_json(
                        "INVALID_MEMORY_TYPE",
                        "validation",
                        "memory.save 需 type + anchor_lid + content",
                    ),
                    None,
                );
            };
            let layer = if ty == "position" {
                "session"
            } else {
                "long_term"
            };
            let input = SaveInput {
                mem_id: None,
                mem_type: ty.into(),
                layer: layer.into(),
                book_id: book.base.book_id.clone(),
                anchor: Anchor {
                    lid: Some(anchor.into()),
                    concept: None,
                },
                content: content.into(),
                range: None,
                citations: None,
                source_session_id: None,
            };
            let body = match store.save(input, now) {
                Ok(r) => to_json(&r),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "memory.recall" => {
            let q = RecallQuery {
                book_id: Some(book.base.book_id.clone()),
                lid: sget("lid").map(String::from),
                mem_type: sget("type").map(String::from),
                layer: sget("layer").map(String::from),
                text: sget("text").map(String::from),
            };
            (to_json(&store.recall(&q)), None)
        }
        "reader.gotoLid" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.gotoLid 需 lid"),
                    None,
                );
            };
            let body = match reader.goto_lid(book, lid) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "reader.scroll" => {
            let Some(delta) = args.get("delta").and_then(|v| v.as_i64()) else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "reader.scroll 需 delta(整数)",
                    ),
                    None,
                );
            };
            (to_json(&reader.scroll(delta)), None)
        }
        "reader.highlight" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.highlight 需 lid"),
                    None,
                );
            };
            // agent 标注 = 提议态,落 session 层 `[ADR-0030 决策4]`;agent 高亮整段(range=None `[ADR-0031]`)。
            match reader.highlight(book, store, lid, None, "session", now) {
                Ok(e) => {
                    let eff = AgentEffect::Highlight {
                        mem_id: e.highlight_id.clone(),
                        lid: lid.to_string(),
                    };
                    (to_json(&e), Some(eff))
                }
                Err(e) => (to_json(&e), None),
            }
        }
        "reader.note" => {
            let (Some(lid), Some(text)) = (sget("lid"), sget("text")) else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.note 需 lid + text"),
                    None,
                );
            };
            match reader.note(book, store, lid, text, "session", now) {
                Ok(e) => {
                    let eff = AgentEffect::Note {
                        mem_id: e.note_id.clone(),
                        lid: lid.to_string(),
                        text: text.to_string(),
                    };
                    (to_json(&e), Some(eff))
                }
                Err(e) => (to_json(&e), None),
            }
        }
        "reader.state" => (to_json(&reader.state()), None),
        other => (
            err_json("INVALID_RANGE", "validation", &format!("未知工具: {other}")),
            None,
        ),
    }
}

/// 踪迹结果摘要:截断到 200 字(book.query 的 citations 链落在此,对用户可见 `[ADR-0030]`)。
fn digest(s: &str) -> String {
    s.chars().take(200).collect()
}

/// 回合收尾:视口若较回合前 anchor 变了,合并成单条 `Goto` effect(事务性 undo `[ADR-0030]`)。
fn with_goto(reader: &Reader, before: &str, mut effects: Vec<AgentEffect>) -> Vec<AgentEffect> {
    let after = reader.state().viewport.anchor_lid;
    if after != before {
        effects.push(AgentEffect::Goto {
            before_anchor: before.to_string(),
            after_anchor: after,
        });
    }
    effects
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        err_json(
            "INTERNAL_ERROR",
            "internal",
            &format!("结果序列化失败: {e}"),
        )
    })
}

fn err_json(error_code: &str, category: &str, message: &str) -> String {
    to_json(&ToolError {
        error_code: error_code.into(),
        category: category.into(),
        message: message.into(),
    })
}

/// 新建一个对话会话的初始 `messages`(仅 system)`[ADR-0030]`:供 server `/agent/new` 重置、
/// CLI/测试起会话。messages 由调用方(server `AppState`)跨回合持有,run 不再自建。
pub fn new_session() -> Vec<Message> {
    vec![Message::system(SYSTEM_PROMPT)]
}

/// 外层 E 编排 loop `[ADR-0026/0016/0030]`:LLM 自主多轮调工具,双重停机诚实标 incomplete。
/// `reader`/`messages` 由调用方注入(与前端共享同一会话态视口 + 跨回合 messages `[ADR-0030 决策2]`);
/// 本回合(一次调用)的可撤销 `effects` + 查询 `trace` 随 `OuterOutcome` 返回。
#[allow(clippy::too_many_arguments)]
pub fn run(
    book: &Book,
    store: &mut MemoryStore,
    reader: &mut Reader,
    adapter: &dyn ModelAdapter,
    messages: &mut Vec<Message>,
    question: &str,
    now: &str,
    cfg: OuterConfig,
) -> Result<OuterOutcome, ToolError> {
    let tools = tool_specs();
    messages.push(Message::user(question)); // system 由 new_session 注入;messages 跨回合保留
    let before_anchor = reader.state().viewport.anchor_lid; // 回合前视口锚(viewport undo 基准)
    let mut effects: Vec<AgentEffect> = Vec::new();
    let mut trace: Vec<TraceStep> = Vec::new();
    let trace_dbg = std::env::var("UB_TRACE").is_ok(); // 诊断:打印每轮 tool_calls + 结果(env-gated)
    let mut spent: u32 = 0;
    let mut turns: usize = 0;

    loop {
        turns += 1;
        let turn: AssistantTurn =
            adapter
                .chat(messages.as_slice(), &tools)
                .map_err(|e| ToolError {
                    error_code: "PROVIDER_ERROR".into(),
                    category: "provider".into(),
                    message: e.message,
                })?;
        spent += turn
            .usage_total_tokens
            .unwrap_or_else(|| messages_estimate(messages.as_slice()));

        if trace_dbg {
            eprintln!(
                "── turn {turns}: text={:?} tool_calls={:?}",
                turn.text
                    .as_deref()
                    .map(|t| t.chars().take(60).collect::<String>()),
                turn.tool_calls
                    .iter()
                    .map(|t| format!("{}({})", t.name, t.arguments))
                    .collect::<Vec<_>>()
            );
        }

        // 正常停:无工具请求 = LLM 给最终答。终答入 messages(跨回合保留,下一回合可见上轮回答)。
        if turn.tool_calls.is_empty() {
            messages.push(Message {
                role: Role::Assistant,
                content: turn.text.clone(),
                tool_calls: vec![],
                tool_call_id: None,
            });
            return Ok(OuterOutcome {
                answer: turn.text,
                incomplete: false,
                warning: None,
                turns,
                tokens_spent: spent,
                effects: with_goto(reader, &before_anchor, effects),
                trace,
            });
        }

        // 追加 assistant 回合(含 tool_calls),再逐个执行工具、回填 tool 结果 + 攒 effects/trace。
        messages.push(Message {
            role: Role::Assistant,
            content: turn.text.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        });
        for tc in &turn.tool_calls {
            let (result, effect) =
                dispatch(&tc.name, &tc.arguments, book, store, reader, adapter, now);
            if trace_dbg {
                eprintln!(
                    "   ↳ {} => {}",
                    tc.name,
                    result.chars().take(180).collect::<String>()
                );
            }
            trace.push(TraceStep {
                tool: tc.name.clone(),
                args: tc.arguments.clone(),
                result_digest: digest(&result),
            });
            if let Some(e) = effect {
                effects.push(e);
            }
            messages.push(Message {
                role: Role::Tool,
                content: Some(result),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
            });
        }

        // 硬闸双重停机:max_turns ∨ token 触顶 → 诚实标 incomplete,不假装完整。
        if turns >= cfg.max_turns || spent > cfg.token_budget {
            return Ok(OuterOutcome {
                answer: turn.text,
                incomplete: true,
                warning: Some("CONTEXT_BUDGET_EXCEEDED".into()),
                turns,
                tokens_spent: spent,
                effects: with_goto(reader, &before_anchor, effects),
                trace,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterError, CompletionRequest, ParsedResponse, RawCitation, ToolCall};
    use base_schema::{sample_base, GraphEdge, GraphNode, LidNode, NodeKind, ReadOnlyBase, Span};
    use reader::DEFAULT_RADIUS;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;

    /// 双队列脚本替身:chat 回合 + (内层 book.query 触发的)complete 回合各一队,按序吐。
    struct FakeAdapter {
        chats: RefCell<VecDeque<AssistantTurn>>,
        completes: RefCell<VecDeque<ParsedResponse>>,
    }
    impl FakeAdapter {
        fn new(chats: Vec<AssistantTurn>, completes: Vec<ParsedResponse>) -> Self {
            FakeAdapter {
                chats: RefCell::new(chats.into()),
                completes: RefCell::new(completes.into()),
            }
        }
    }
    impl ModelAdapter for FakeAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.completes
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake complete 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            self.chats
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake chat 脚本耗尽".into(),
                })
        }
    }

    fn book() -> Book {
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }
    /// 容器 "1" 下挂 n 个叶 "1.1".."1.n"(各 10 字符),供视口跳转/合并测试(首叶 "1.1")。
    fn book_leaves(n: usize) -> Book {
        let mut lid_nodes = vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Chapter,
            span: Span {
                start: 0,
                end: n * 10,
            },
            children: (1..=n).map(|i| format!("1.{i}")).collect(),
        }];
        for i in 1..=n {
            lid_nodes.push(LidNode {
                lid: format!("1.{i}"),
                path: vec![1, i as u32],
                kind: NodeKind::Paragraph,
                span: Span {
                    start: (i - 1) * 10,
                    end: i * 10,
                },
                children: vec![],
            });
        }
        Book::new(
            ReadOnlyBase {
                book_id: "bookL".into(),
                lid_nodes,
                graph_nodes: Vec::<GraphNode>::new(),
                graph_edges: Vec::<GraphEdge>::new(),
            },
            &"X".repeat(n * 10),
        )
    }
    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-orch-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }
    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }
    fn turn_calls(calls: Vec<ToolCall>) -> AssistantTurn {
        AssistantTurn {
            text: None,
            tool_calls: calls,
            usage_total_tokens: Some(10),
        }
    }
    fn turn_final(text: &str) -> AssistantTurn {
        AssistantTurn {
            text: Some(text.into()),
            tool_calls: vec![],
            usage_total_tokens: Some(10),
        }
    }

    // 多跳收敛:chat 调 book.query(触发内层 complete)→ chat 调 memory.save → chat 终答。
    #[test]
    fn multihop_query_then_save_then_finish() {
        let b = book();
        let mut store = MemoryStore::open(tmp("multihop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "c1",
                    "book.query",
                    r#"{"query":"命令模式?","anchor_lid":"1.1"}"#,
                )]),
                turn_calls(vec![call(
                    "c2",
                    "memory.save",
                    r#"{"type":"note","anchor_lid":"1.1","content":"命令=对象化的调用"}"#,
                )]),
                turn_final("命令模式把请求封装成对象。"),
            ],
            // 内层 book.query 的合一轮:充分 + 真 LID citation
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            }],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "命令模式是什么",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.answer.as_deref(), Some("命令模式把请求封装成对象。"));
        assert_eq!(out.turns, 3);
        // memory.save 真落库 + citation 自动锚回 1.1
        let recalled = store.recall(&RecallQuery::default());
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].citations[0].lid, "1.1");
    }

    // 双重停机:max_turns 触顶,每轮都请求工具 → 诚实标 incomplete + CONTEXT_BUDGET_EXCEEDED。
    #[test]
    fn halts_at_max_turns_marks_incomplete() {
        let b = book();
        let mut store = MemoryStore::open(tmp("halt")).unwrap();
        // 每轮都调 manifest(确定性、不触 complete),永不终答
        let chats = vec![
            turn_calls(vec![call("a", "book.manifest", "{}")]),
            turn_calls(vec![call("b", "book.manifest", "{}")]),
            turn_calls(vec![call("c", "book.manifest", "{}")]),
        ];
        let fake = FakeAdapter::new(chats, vec![]);
        let cfg = OuterConfig {
            max_turns: 2,
            token_budget: 1_000_000,
        };
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "绕圈",
            "t0",
            cfg,
        )
        .unwrap();
        assert!(out.incomplete);
        assert_eq!(out.warning.as_deref(), Some("CONTEXT_BUDGET_EXCEEDED"));
        assert_eq!(out.turns, 2);
    }

    // 工具错误回喂不降级:book.text 取不存在 LID → 直接验 dispatch 回喂 LID_NOT_FOUND 信封(非静默)。
    #[test]
    fn tool_error_fed_back_not_silent() {
        let b = book();
        let mut store = MemoryStore::open(tmp("err")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (out, eff) = dispatch(
            "book.text",
            r#"{"lid":"9.9"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(out.contains("LID_NOT_FOUND"));
        assert!(out.contains("not_found"));
        assert!(eff.is_none()); // 报错不产 effect
    }

    // 闭环验收:agent 经外层 loop 命令面跑通「问→跳转→高亮→记笔记」一次闭环 `[ADR-0007/0015]`。
    // 标注真落记忆层(单一真相源)、citation 锚回真 LID,兑现切片0 总判据第 3 条。
    #[test]
    fn closed_loop_query_goto_highlight_note() {
        let b = book();
        let mut store = MemoryStore::open(tmp("closeloop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "c1",
                    "book.query",
                    r#"{"query":"命令模式?","anchor_lid":"1.1"}"#,
                )]),
                turn_calls(vec![call("c2", "reader.gotoLid", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call("c3", "reader.highlight", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call(
                    "c4",
                    "reader.note",
                    r#"{"lid":"1.1","text":"命令=对象化调用"}"#,
                )]),
                turn_final("命令模式把请求封装成对象,已跳转、高亮并记笔记。"),
            ],
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            }],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "讲讲命令模式并高亮记笔记",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 5); // 问→跳转→高亮→记笔记→终答
                                  // S10f effects:agent 标注产 Highlight + Note(undo 材料);首叶=1.1 视口未变,无 Goto。
        assert_eq!(out.effects.len(), 2);
        assert!(matches!(&out.effects[0], AgentEffect::Highlight { lid, .. } if lid == "1.1"));
        assert!(
            matches!(&out.effects[1], AgentEffect::Note { lid, text, .. } if lid == "1.1" && text == "命令=对象化调用")
        );
        // trace 记录每个 tool call(问→跳转→高亮→记笔记 = 4 步),book.query 居首。
        assert_eq!(out.trace.len(), 4);
        assert_eq!(out.trace[0].tool, "book.query");
        // agent 标注落 session 层(提议态,用户「保留」才升 long_term):highlight + note 两条都在 session。
        let sess = store.recall(&RecallQuery {
            layer: Some("session".into()),
            ..Default::default()
        });
        assert_eq!(sess.len(), 2);
        // 跳转→高亮→记笔记 的标注真落记忆层(单源),anchor/citation 锚回真 LID 1.1
        let hl = store.recall(&RecallQuery {
            mem_type: Some("highlight".into()),
            ..Default::default()
        });
        assert_eq!(hl.len(), 1);
        assert_eq!(hl[0].anchor.lid.as_deref(), Some("1.1"));
        let note = store.recall(&RecallQuery {
            mem_type: Some("note".into()),
            ..Default::default()
        });
        assert_eq!(note.len(), 1);
        assert_eq!(note[0].content, "命令=对象化调用");
        assert_eq!(note[0].citations[0].lid, "1.1");
    }

    // loop 在工具报错后仍继续、并能收敛(错误回喂 → 模型读到后终答)。
    #[test]
    fn loop_continues_after_tool_error_and_converges() {
        let b = book();
        let mut store = MemoryStore::open(tmp("recover")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "book.text", r#"{"lid":"9.9"}"#)]), // 报错回喂
                turn_final("抱歉,该 LID 不存在,据现有信息无法定位。"),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "取 9.9",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 2);
        assert!(out.answer.unwrap().contains("不存在"));
    }

    // S10f:agent 视口跳转(scroll/goto)按回合合并成**单条 Goto** effect(事务性 undo),trace 记录踪迹。
    #[test]
    fn agent_viewport_change_merges_into_single_goto_effect() {
        let b = book_leaves(10); // 首叶 1.1
        let mut store = MemoryStore::open(tmp("goto-merge")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "reader.scroll", r#"{"delta":5}"#)]), // 1.1 → 1.6
                turn_calls(vec![call("c2", "reader.gotoLid", r#"{"lid":"1.8"}"#)]), // 1.6 → 1.8
                turn_final("已翻到目标位置。"),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "翻到 1.8",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        // 两次视口变更(scroll + goto)合并成一条 Goto:before=回合前首叶 1.1,after=最终 1.8。
        assert_eq!(out.effects.len(), 1);
        assert!(
            matches!(&out.effects[0], AgentEffect::Goto { before_anchor, after_anchor }
            if before_anchor == "1.1" && after_anchor == "1.8")
        );
        // 共享 reader 的视口真被 agent 改到 1.8(双向共享 `[ADR-0030 决策2]`)。
        assert_eq!(reader.state().viewport.anchor_lid, "1.8");
        // trace 记录两步视口工具调用。
        assert_eq!(out.trace.len(), 2);
        assert_eq!(out.trace[0].tool, "reader.scroll");
        assert_eq!(out.trace[1].tool, "reader.gotoLid");
    }

    // S10f:messages 跨回合保留 + new_session 重置(承载会话边界 = 用户「新对话」`[ADR-0030 决策6]`)。
    #[test]
    fn messages_persist_across_turns_and_reset() {
        let b = book();
        let mut store = MemoryStore::open(tmp("messages")).unwrap();
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        assert_eq!(messages.len(), 1); // 仅 system
                                       // 第一回合:终答即停 → messages 累积 system + user + assistant。
        let fake = FakeAdapter::new(vec![turn_final("答1")], vec![]);
        run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "问1",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        let after_first = messages.len();
        assert!(after_first > 1);
        // 第二回合:复用同一 messages → 继续累积(跨回合保留)。
        let fake2 = FakeAdapter::new(vec![turn_final("答2")], vec![]);
        run(
            &b,
            &mut store,
            &mut reader,
            &fake2,
            &mut messages,
            "问2",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(messages.len() > after_first);
        // 「新对话」:重置回仅 system。
        messages = new_session();
        assert_eq!(messages.len(), 1);
    }
}
