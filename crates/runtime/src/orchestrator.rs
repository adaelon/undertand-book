//! 外层 E 编排 loop `[ADR-0026/0016/0005]`:messages 会话态、LLM 自主多轮 tool-calling、
//! 双重停机(max_turns ∨ usage token 触顶 → 诚实标 incomplete)、工具错误回喂不降级。
//! 外层工具集 = book.query/text/context/concept + memory.save/recall + reader.gotoLid/scroll/highlight/note/state。
//! book.manifest **不在外层暴露**(返回全树 token 炸弹,S7 真跑实测一次撑爆 budget;外层导航靠 concept/context 足够);
//! dispatch 仍保留 manifest 防御分支。reader.* 是会话态阅读器(S7 接入):agent 经命令面驱动
//! 「问→跳转→高亮→记笔记」闭环 `[ADR-0007/0015]`。
//! 内层 book.query 复用 `crate::query`(同一 adapter 触 `complete`)`[ADR-0025]`。
use crate::{query, AssistantTurn, Message, ModelAdapter, Role, ToolSpec};
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput};
use reader::{Reader, DEFAULT_RADIUS};
use read_tools::{Book, ToolError};
use serde::Serialize;

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
#[derive(Debug, Serialize)]
pub struct OuterOutcome {
    pub answer: Option<String>,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub turns: usize,
    pub tokens_spent: u32,
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
            "取某 LID 的近邻上下文指针(树邻接 + 局部图谱边),不带原文,用 book.text 取内容。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
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

/// 执行一次工具调用,返回喂回模型的结果 JSON 字符串。
/// 错误**不降级**:把 ToolError 信封原样回喂,模型据 recovery 自纠 `[ADR-0015/0026]`。
#[allow(clippy::too_many_arguments)]
fn dispatch(
    name: &str,
    arguments: &str,
    book: &Book,
    store: &mut MemoryStore,
    reader: &mut Reader,
    adapter: &dyn ModelAdapter,
    now: &str,
) -> String {
    let args: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(e) => return err_json("INVALID_RANGE", "validation", &format!("工具参数非合法 JSON: {e}")),
    };
    let sget = |k: &str| args.get(k).and_then(|v| v.as_str());

    match name {
        "book.query" => {
            let (Some(q), Some(anchor)) = (sget("query"), sget("anchor_lid")) else {
                return err_json("INVALID_RANGE", "validation", "book.query 需 query + anchor_lid");
            };
            match query(book, q, anchor, adapter) {
                Ok(resp) => to_json(&resp),
                Err(e) => to_json(&e),
            }
        }
        "book.text" => {
            let Some(lid) = sget("lid") else {
                return err_json("INVALID_RANGE", "validation", "book.text 需 lid");
            };
            match book.text(lid, sget("end_lid")) {
                Ok(t) => to_json(&serde_json::json!({ "lid": lid, "text": t })),
                Err(e) => to_json(&e),
            }
        }
        "book.context" => {
            let Some(lid) = sget("lid") else {
                return err_json("INVALID_RANGE", "validation", "book.context 需 lid");
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            match book.context_near(lid, k) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            }
        }
        "book.concept" => {
            let Some(n) = sget("name") else {
                return err_json("INVALID_RANGE", "validation", "book.concept 需 name");
            };
            match book.concept(n) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            }
        }
        "book.manifest" => to_json(&book.manifest()),
        "memory.save" => {
            let (Some(ty), Some(anchor), Some(content)) =
                (sget("type"), sget("anchor_lid"), sget("content"))
            else {
                return err_json("INVALID_MEMORY_TYPE", "validation", "memory.save 需 type + anchor_lid + content");
            };
            let layer = if ty == "position" { "session" } else { "long_term" };
            let input = SaveInput {
                mem_id: None,
                mem_type: ty.into(),
                layer: layer.into(),
                book_id: book.base.book_id.clone(),
                anchor: Anchor { lid: Some(anchor.into()), concept: None },
                content: content.into(),
                citations: None,
                source_session_id: None,
            };
            match store.save(input, now) {
                Ok(r) => to_json(&r),
                Err(e) => to_json(&e),
            }
        }
        "memory.recall" => {
            let q = RecallQuery {
                book_id: Some(book.base.book_id.clone()),
                lid: sget("lid").map(String::from),
                mem_type: sget("type").map(String::from),
                layer: sget("layer").map(String::from),
                text: sget("text").map(String::from),
            };
            to_json(&store.recall(&q))
        }
        "reader.gotoLid" => {
            let Some(lid) = sget("lid") else {
                return err_json("INVALID_RANGE", "validation", "reader.gotoLid 需 lid");
            };
            match reader.goto_lid(book, lid) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            }
        }
        "reader.scroll" => {
            let Some(delta) = args.get("delta").and_then(|v| v.as_i64()) else {
                return err_json("INVALID_RANGE", "validation", "reader.scroll 需 delta(整数)");
            };
            to_json(&reader.scroll(delta))
        }
        "reader.highlight" => {
            let Some(lid) = sget("lid") else {
                return err_json("INVALID_RANGE", "validation", "reader.highlight 需 lid");
            };
            match reader.highlight(book, store, lid, now) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            }
        }
        "reader.note" => {
            let (Some(lid), Some(text)) = (sget("lid"), sget("text")) else {
                return err_json("INVALID_RANGE", "validation", "reader.note 需 lid + text");
            };
            match reader.note(book, store, lid, text, now) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            }
        }
        "reader.state" => to_json(&reader.state()),
        other => err_json("INVALID_RANGE", "validation", &format!("未知工具: {other}")),
    }
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| err_json("INTERNAL_ERROR", "internal", &format!("结果序列化失败: {e}")))
}

fn err_json(error_code: &str, category: &str, message: &str) -> String {
    to_json(&ToolError {
        error_code: error_code.into(),
        category: category.into(),
        message: message.into(),
    })
}

/// 外层 E 编排 loop `[ADR-0026/0016]`:LLM 自主多轮调工具,双重停机诚实标 incomplete。
pub fn run(
    book: &Book,
    store: &mut MemoryStore,
    adapter: &dyn ModelAdapter,
    question: &str,
    now: &str,
    cfg: OuterConfig,
) -> Result<OuterOutcome, ToolError> {
    let tools = tool_specs();
    let mut messages = vec![Message::system(SYSTEM_PROMPT), Message::user(question)];
    let mut reader = Reader::new(book, DEFAULT_RADIUS); // 会话态阅读器,贯穿本次 loop
    let trace = std::env::var("UB_TRACE").is_ok(); // 诊断:打印每轮 tool_calls + 结果(env-gated)
    let mut spent: u32 = 0;
    let mut turns: usize = 0;

    loop {
        turns += 1;
        let turn: AssistantTurn = adapter.chat(&messages, &tools).map_err(|e| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: e.message,
        })?;
        spent += turn
            .usage_total_tokens
            .unwrap_or_else(|| messages_estimate(&messages));

        if trace {
            eprintln!(
                "── turn {turns}: text={:?} tool_calls={:?}",
                turn.text.as_deref().map(|t| t.chars().take(60).collect::<String>()),
                turn.tool_calls.iter().map(|t| format!("{}({})", t.name, t.arguments)).collect::<Vec<_>>()
            );
        }

        // 正常停:无工具请求 = LLM 给最终答。
        if turn.tool_calls.is_empty() {
            return Ok(OuterOutcome {
                answer: turn.text,
                incomplete: false,
                warning: None,
                turns,
                tokens_spent: spent,
            });
        }

        // 追加 assistant 回合(含 tool_calls),再逐个执行工具、回填 tool 结果。
        messages.push(Message {
            role: Role::Assistant,
            content: turn.text.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        });
        for tc in &turn.tool_calls {
            let result = dispatch(&tc.name, &tc.arguments, book, store, &mut reader, adapter, now);
            if trace {
                eprintln!("   ↳ {} => {}", tc.name, result.chars().take(180).collect::<String>());
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
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterError, CompletionRequest, ParsedResponse, RawCitation, ToolCall};
    use base_schema::sample_base;
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
            self.completes.borrow_mut().pop_front().ok_or_else(|| AdapterError {
                message: "fake complete 脚本耗尽".into(),
            })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            self.chats.borrow_mut().pop_front().ok_or_else(|| AdapterError {
                message: "fake chat 脚本耗尽".into(),
            })
        }
    }

    fn book() -> Book {
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }
    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-orch-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }
    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall { id: id.into(), name: name.into(), arguments: args.into() }
    }
    fn turn_calls(calls: Vec<ToolCall>) -> AssistantTurn {
        AssistantTurn { text: None, tool_calls: calls, usage_total_tokens: Some(10) }
    }
    fn turn_final(text: &str) -> AssistantTurn {
        AssistantTurn { text: Some(text.into()), tool_calls: vec![], usage_total_tokens: Some(10) }
    }

    // 多跳收敛:chat 调 book.query(触发内层 complete)→ chat 调 memory.save → chat 终答。
    #[test]
    fn multihop_query_then_save_then_finish() {
        let b = book();
        let mut store = MemoryStore::open(tmp("multihop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "book.query", r#"{"query":"命令模式?","anchor_lid":"1.1"}"#)]),
                turn_calls(vec![call("c2", "memory.save", r#"{"type":"note","anchor_lid":"1.1","content":"命令=对象化的调用"}"#)]),
                turn_final("命令模式把请求封装成对象。"),
            ],
            // 内层 book.query 的合一轮:充分 + 真 LID citation
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation { lid: "1.1".into(), text: "片段".into(), role: "support".into() }],
                model_supplement: vec![],
            }],
        );
        let out = run(&b, &mut store, &fake, "命令模式是什么", "t0", OuterConfig::default()).unwrap();
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
        let cfg = OuterConfig { max_turns: 2, token_budget: 1_000_000 };
        let out = run(&b, &mut store, &fake, "绕圈", "t0", cfg).unwrap();
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
        let out = dispatch("book.text", r#"{"lid":"9.9"}"#, &b, &mut store, &mut reader, &fake, "t0");
        assert!(out.contains("LID_NOT_FOUND"));
        assert!(out.contains("not_found"));
    }

    // 闭环验收:agent 经外层 loop 命令面跑通「问→跳转→高亮→记笔记」一次闭环 `[ADR-0007/0015]`。
    // 标注真落记忆层(单一真相源)、citation 锚回真 LID,兑现切片0 总判据第 3 条。
    #[test]
    fn closed_loop_query_goto_highlight_note() {
        let b = book();
        let mut store = MemoryStore::open(tmp("closeloop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "book.query", r#"{"query":"命令模式?","anchor_lid":"1.1"}"#)]),
                turn_calls(vec![call("c2", "reader.gotoLid", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call("c3", "reader.highlight", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call("c4", "reader.note", r#"{"lid":"1.1","text":"命令=对象化调用"}"#)]),
                turn_final("命令模式把请求封装成对象,已跳转、高亮并记笔记。"),
            ],
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation { lid: "1.1".into(), text: "片段".into(), role: "support".into() }],
                model_supplement: vec![],
            }],
        );
        let out = run(&b, &mut store, &fake, "讲讲命令模式并高亮记笔记", "t0", OuterConfig::default()).unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 5); // 问→跳转→高亮→记笔记→终答
        // 跳转→高亮→记笔记 的标注真落记忆层(单源),anchor/citation 锚回真 LID 1.1
        let hl = store.recall(&RecallQuery { mem_type: Some("highlight".into()), ..Default::default() });
        assert_eq!(hl.len(), 1);
        assert_eq!(hl[0].anchor.lid.as_deref(), Some("1.1"));
        let note = store.recall(&RecallQuery { mem_type: Some("note".into()), ..Default::default() });
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
        let out = run(&b, &mut store, &fake, "取 9.9", "t0", OuterConfig::default()).unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 2);
        assert!(out.answer.unwrap().contains("不存在"));
    }
}
