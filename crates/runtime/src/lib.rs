//! 模块 E 自建最小运行时:`book.query` 内层无状态 mini-loop `[ADR-0016/0025]`。
//! 确定性档位检索(复用 `read-tools` 的 `Book`)+ ModelAdapter 合一轮判停 + 确定性交叉验停。
//! 切片0:scope 两档(local/chapter)+ FakeAdapter(确定性测);NativeAdapter 见 S5b。
use base_schema::{GraphNodeType, LidNode, NodeKind};
use read_tools::{Book, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod memory;
pub mod orchestrator;

/// scope 档(切片0 两档;cross_chapter/global 留切片1+)`[ADR-0016/0025]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Local,
    Chapter,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Local => "local",
            Scope::Chapter => "chapter",
        }
    }
}

/// 证据集:lid → 真原文(BTreeMap 保证确定性顺序)。
pub type EvidenceSet = BTreeMap<String, String>;

/// LLM 合一轮的归一化产出(ModelAdapter 出)`[ADR-0016]`。lid 待确定性校验。
#[derive(Debug, Clone)]
pub struct ParsedResponse {
    pub sufficient: bool,
    pub answer: Option<String>,
    pub citations: Vec<RawCitation>,
    pub model_supplement: Vec<Supplement>,
}

#[derive(Debug, Clone)]
pub struct RawCitation {
    pub lid: String,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Clone)]
pub struct Supplement {
    pub text: String,
}

/// 喂给后端的请求(provider 无关)。
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub system: String,
    pub user: String,
}

#[derive(Debug)]
pub struct AdapterError {
    pub message: String,
}

/// 外层 loop 会话消息角色(OpenAI-兼容)`[ADR-0026]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// 外层 loop 的一条会话消息 `[ADR-0026]`。
#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub content: Option<String>,
    /// assistant 回合请求的工具调用(其余角色为空)。
    pub tool_calls: Vec<ToolCall>,
    /// tool 角色:配对的 assistant tool_call id。
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Message {
        Message { role: Role::System, content: Some(content.into()), tool_calls: vec![], tool_call_id: None }
    }
    pub fn user(content: impl Into<String>) -> Message {
        Message { role: Role::User, content: Some(content.into()), tool_calls: vec![], tool_call_id: None }
    }
}

/// 模型请求的一次工具调用(arguments = OpenAI 风格的 JSON 字符串)`[ADR-0026]`。
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 暴露给模型的工具规格(name + 描述 + JSON-Schema 参数)`[ADR-0026]`。
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// 外层 chat 回合的归一化产出 `[ADR-0026]`:文本(终答)或工具调用,二选一/可并存;usage 供停机口径。
#[derive(Debug, Clone)]
pub struct AssistantTurn {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage_total_tokens: Option<u32>,
}

/// loop 与后端之间的薄层 `[ADR-0016/0026]`;loop 控制 provider 无关,只经此触模型。
/// `complete` = 内层 query 合一轮(JSON 契约);`chat` = 外层多轮 tool-calling。
pub trait ModelAdapter {
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError>;
    fn chat(&self, messages: &[Message], tools: &[ToolSpec]) -> Result<AssistantTurn, AdapterError>;
}

/// Message → OpenAI 请求体 JSON(assistant tool_calls / tool 结果按 OpenAI 形拼)。
fn message_to_json(m: &Message) -> serde_json::Value {
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut o = serde_json::json!({ "role": role });
    match &m.content {
        Some(c) => o["content"] = serde_json::json!(c),
        None if m.role == Role::Assistant => o["content"] = serde_json::Value::Null,
        None => {}
    }
    if !m.tool_calls.is_empty() {
        o["tool_calls"] = serde_json::Value::Array(
            m.tool_calls
                .iter()
                .map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": tc.name, "arguments": tc.arguments },
                    })
                })
                .collect(),
        );
    }
    if let Some(id) = &m.tool_call_id {
        o["tool_call_id"] = serde_json::json!(id);
    }
    o
}

/// `book.query` 对外响应(符 V3 §4.1 核心子集)。citations 已过确定性验停 ⇒ lid 全真。
#[derive(Debug, Serialize)]
pub struct QueryResponse {
    pub answer: Option<String>,
    pub citations: Vec<Citation>,
    pub model_supplement: Vec<SupplementOut>,
    pub scope_used: String,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Citation {
    pub lid: String,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct SupplementOut {
    pub text: String,
    pub source: String,
}

/// 物化路径父 LID:"11.18.4" → Some("11.18");"1" → None。
fn parent_of(lid: &str) -> Option<String> {
    lid.rfind('.').map(|i| lid[..i].to_string())
}

fn lid_node<'a>(book: &'a Book, lid: &str) -> Option<&'a LidNode> {
    book.base.lid_nodes.iter().find(|n| n.lid == lid)
}

/// 章根 = 从 anchor 上溯最近的 `NodeKind∈{Section,Chapter}` 祖先(深度可变 LID 用 kind 定位,
/// 非物化路径段数 `[ADR-0025]`);无显式章/节祖先则退化到顶层段。
fn chapter_root(book: &Book, anchor: &str) -> String {
    let mut cur = parent_of(anchor);
    while let Some(lid) = cur {
        if let Some(n) = lid_node(book, &lid) {
            if matches!(n.kind, NodeKind::Section | NodeKind::Chapter) {
                return lid;
            }
        }
        cur = parent_of(&lid);
    }
    anchor.split('.').next().unwrap_or(anchor).to_string()
}

/// 章子树内、所有 anchored 叶 LID(实体/概念 occ + 断言 source_lid)`[ADR-0025]`。
fn anchored_leaves_under(book: &Book, root: &str) -> Vec<String> {
    let prefix = format!("{root}.");
    let mut out: Vec<String> = Vec::new();
    for n in &book.base.graph_nodes {
        let lids: Vec<&str> = match n.node_type {
            GraphNodeType::Claim => n.source_lid.as_deref().into_iter().collect(),
            _ => n.occurrences.iter().map(|s| s.as_str()).collect(),
        };
        for l in lids {
            let in_tree = l == root || l.starts_with(&prefix);
            let is_leaf = lid_node(book, l).map(|nd| nd.children.is_empty()).unwrap_or(false);
            if in_tree && is_leaf && !out.iter().any(|x| x == l) {
                out.push(l.to_string());
            }
        }
    }
    out.sort();
    out
}

/// 确定性档位检索:沿图谱/树捞 LID + 真原文成证据集 `[ADR-0016/0025]`。
/// local = anchor ∪ context_near(树邻接+local边);chapter = local ∪ 章内 anchored 叶。
fn retrieve(book: &Book, anchor: &str, scope: Scope) -> Result<EvidenceSet, ToolError> {
    let mut ev: EvidenceSet = BTreeMap::new();
    ev.insert(anchor.to_string(), book.text(anchor, None)?);
    // local:树邻接 + scope=local 边(全量,不截断 top-K)
    let ctx = book.context_near(anchor, Some(usize::MAX))?;
    for it in ctx.items {
        if !ev.contains_key(&it.lid) {
            ev.insert(it.lid.clone(), book.text(&it.lid, None)?);
        }
    }
    if scope == Scope::Chapter {
        let root = chapter_root(book, anchor);
        for l in anchored_leaves_under(book, &root) {
            if !ev.contains_key(&l) {
                ev.insert(l.clone(), book.text(&l, None)?);
            }
        }
    }
    Ok(ev)
}

/// 合一轮提示:问题 + 证据集(每段前缀 `[LID]`,红线物理前提 `[ADR-0004]`)。
fn build_prompt(q: &str, ev: &EvidenceSet) -> CompletionRequest {
    let mut user = String::from("问题:\n");
    user.push_str(q);
    user.push_str("\n\n证据(每条前缀 [LID],citations 只能引用这里出现的 LID):\n");
    for (lid, text) in ev {
        user.push_str(&format!("[{lid}] {text}\n"));
    }
    CompletionRequest {
        system: "你是锚定问答器。只依据证据作答。判断证据是否足以作答(sufficient)。\
                 citations 只能引用证据中出现的 [LID];原文未覆盖的世界知识补充放 model_supplement(无 LID)。"
            .into(),
        user,
    }
}

fn build_response(
    r: ParsedResponse,
    valid: Vec<RawCitation>,
    scope: Scope,
    incomplete: bool,
    warning: Option<String>,
) -> QueryResponse {
    QueryResponse {
        answer: r.answer,
        citations: valid
            .into_iter()
            .map(|c| Citation {
                lid: c.lid,
                text: c.text,
                role: c.role,
            })
            .collect(),
        model_supplement: r
            .model_supplement
            .into_iter()
            .map(|s| SupplementOut {
                text: s.text,
                source: "model".into(),
            })
            .collect(),
        scope_used: scope.as_str().into(),
        incomplete,
        warning,
    }
}

/// `book.query` 内层无状态 mini-loop `[ADR-0016/0025]`。
/// 混合驱动:确定性档位骨架捞证据 → LLM 合一轮判停作答 → 确定性交叉验停(citations⊆证据集)。
/// 不足或零有效 citation → 外扩(local→chapter);chapter 仍不足 → 触顶诚实标 incomplete。
pub fn query(
    book: &Book,
    q: &str,
    anchor: &str,
    adapter: &dyn ModelAdapter,
) -> Result<QueryResponse, ToolError> {
    let ladder = [Scope::Local, Scope::Chapter];
    for (i, &scope) in ladder.iter().enumerate() {
        let ev = retrieve(book, anchor, scope)?;
        let resp = adapter.complete(build_prompt(q, &ev)).map_err(|e| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: e.message,
        })?;
        // 确定性交叉验停:只留落在证据集 LID 全集内的 citation(悬空滤净 = 结构红线)。
        let valid: Vec<RawCitation> = resp
            .citations
            .iter()
            .filter(|c| ev.contains_key(&c.lid))
            .cloned()
            .collect();
        let is_top = i + 1 == ladder.len();
        if resp.sufficient && !valid.is_empty() {
            return Ok(build_response(resp, valid, scope, false, None));
        }
        if is_top {
            // 触顶兜底:chapter 仍不足/零有效 → 诚实标 incomplete,不假装完整。
            return Ok(build_response(
                resp,
                valid,
                scope,
                true,
                Some("CONTEXT_BUDGET_EXCEEDED".into()),
            ));
        }
        // 否则外扩到下一档(早停防护:声称 sufficient 但零有效 citation 也外扩)。
    }
    unreachable!("ladder 非空,必在循环内 return")
}

// ─────────────────────────── NativeAdapter(S5b)───────────────────────────
// 读 `.env` 的 OpenAI-兼容端点(BASE_URL/API_KEY/MODEL),POST /chat/completions,
// `response_format=json_object` 拿结构化,解析回 ParsedResponse `[ADR-0025]`。
// 结构红线不在此守:lid 真实性由 loop 的确定性交叉验停过滤,后端乱吐也滤净 `[ADR-0004]`。

/// LLM 合一轮的 JSON 输出契约(拼到 system,约束 glm-5.1 等 OpenAI-兼容后端的 json 形状)。
const OUTPUT_CONTRACT: &str = "只输出一个 JSON 对象,不要 markdown 代码块,形如:\n\
{\"sufficient\": true 或 false, \"answer\": \"答案文本或 null\", \
\"citations\": [{\"lid\": \"证据中的LID\", \"text\": \"引用的原文片段\", \"role\": \"support 或 contrast\"}], \
\"model_supplement\": [{\"text\": \"原文未覆盖的世界知识补充\"}]}\n\
规则:\n\
- 只要证据中有任何片段能支撑你的回答,就把综合答案写进 answer 字段、令 sufficient=true。\n\
- citations 的 lid 必须来自上面 [LID] 标注过的证据,引用支撑答案的原文片段。\n\
- model_supplement 只放证据完全无法支撑、纯靠世界知识的延伸;不要把主答案放这里。\n\
- 只有当证据完全无法支撑任何回答时,才令 sufficient=false、answer=null。";

/// NativeAdapter:对接 `.env` 配置的 OpenAI-兼容后端 `[ADR-0003/0025]`。
pub struct NativeAdapter {
    api_key: String,
    base_url: String,
    model: String,
}

impl NativeAdapter {
    /// 从 `.env` / 进程环境读配置(`OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `FLUID_LLM_MODEL`)。
    pub fn from_env() -> Result<NativeAdapter, AdapterError> {
        dotenvy::dotenv().ok(); // .env 可选;缺则退回进程环境变量
        let get = |k: &str| {
            std::env::var(k).map_err(|_| AdapterError {
                message: format!("缺少环境变量 {k}(填 .env 或 export)"),
            })
        };
        Ok(NativeAdapter {
            api_key: get("OPENCODE_API_KEY")?,
            base_url: get("OPENCODE_BASE_URL")?,
            model: get("FLUID_LLM_MODEL")?,
        })
    }
}

/// 后端 JSON 输出的中间解析形(宽松:缺字段给默认,不静默改 lid)。
#[derive(Deserialize)]
struct LlmOut {
    #[serde(default)]
    sufficient: bool,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    citations: Vec<LlmCite>,
    #[serde(default)]
    model_supplement: Vec<LlmSupp>,
}
#[derive(Deserialize)]
struct LlmCite {
    lid: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    role: String,
}
#[derive(Deserialize)]
struct LlmSupp {
    text: String,
}

/// 剥可能的 markdown ```json fence(json 解析容错,非 LID 降级)。
fn strip_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

impl ModelAdapter for NativeAdapter {
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        let system = format!("{}\n\n{}", req.system, OUTPUT_CONTRACT);
        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": req.user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        });
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| AdapterError {
                message: format!("HTTP 请求失败: {e}"),
            })?;
        let v: serde_json::Value = resp.into_json().map_err(|e| AdapterError {
            message: format!("响应非 JSON: {e}"),
        })?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AdapterError {
                message: format!("响应缺 choices[0].message.content: {v}"),
            })?;
        let out: LlmOut = serde_json::from_str(strip_fence(content)).map_err(|e| AdapterError {
            message: format!("模型输出非合法 JSON: {e};原文={content}"),
        })?;
        Ok(ParsedResponse {
            sufficient: out.sufficient,
            answer: out.answer,
            citations: out
                .citations
                .into_iter()
                .map(|c| RawCitation {
                    lid: c.lid,
                    text: c.text,
                    role: c.role,
                })
                .collect(),
            model_supplement: out
                .model_supplement
                .into_iter()
                .map(|s| Supplement { text: s.text })
                .collect(),
        })
    }

    /// 外层多轮 tool-calling:带 `tools` schema 请求,解析 `assistant.tool_calls` + `usage` `[ADR-0026]`。
    fn chat(&self, messages: &[Message], tools: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
        let msgs: Vec<serde_json::Value> = messages.iter().map(message_to_json).collect();
        let tool_specs: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                })
            })
            .collect();
        let body = serde_json::json!({
            "model": self.model,
            "messages": msgs,
            "tools": tool_specs,
            "temperature": 0,
        });
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| AdapterError {
                message: format!("HTTP 请求失败: {e}"),
            })?;
        let v: serde_json::Value = resp.into_json().map_err(|e| AdapterError {
            message: format!("响应非 JSON: {e}"),
        })?;
        let msg = &v["choices"][0]["message"];
        let text = msg["content"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let mut tool_calls = Vec::new();
        if let Some(arr) = msg["tool_calls"].as_array() {
            for tc in arr {
                tool_calls.push(ToolCall {
                    id: tc["id"].as_str().unwrap_or("").to_string(),
                    name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                    arguments: tc["function"]["arguments"].as_str().unwrap_or("{}").to_string(),
                });
            }
        }
        let usage_total_tokens = v["usage"]["total_tokens"].as_u64().map(|u| u as u32);
        Ok(AssistantTurn {
            text,
            tool_calls,
            usage_total_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::sample_base;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// 确定性测试替身:按调用次序吐脚本化 ParsedResponse(loop 每轮调一次 complete)。
    struct FakeAdapter {
        scripted: RefCell<VecDeque<ParsedResponse>>,
    }
    impl FakeAdapter {
        fn new(rs: Vec<ParsedResponse>) -> Self {
            FakeAdapter {
                scripted: RefCell::new(rs.into()),
            }
        }
    }
    impl ModelAdapter for FakeAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.scripted
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("query 内层测的 FakeAdapter 不涉及外层 chat")
        }
    }

    fn book() -> Book {
        // sample_base: "1"(容器)+ "1.1"(叶);entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    fn cite(lid: &str) -> RawCitation {
        RawCitation {
            lid: lid.into(),
            text: "片段".into(),
            role: "support".into(),
        }
    }

    fn resp(sufficient: bool, cites: Vec<RawCitation>) -> ParsedResponse {
        ParsedResponse {
            sufficient,
            answer: if sufficient { Some("答案".into()) } else { None },
            citations: cites,
            model_supplement: vec![],
        }
    }

    // 路径①:首轮 sufficient + 有效 citation → local 收口,非 incomplete。
    #[test]
    fn sufficient_with_valid_citation_stops_at_local() {
        let b = book();
        let fake = FakeAdapter::new(vec![resp(true, vec![cite("1.1")])]);
        let out = query(&b, "命令模式是什么", "1.1", &fake).unwrap();
        assert_eq!(out.scope_used, "local");
        assert!(!out.incomplete);
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].lid, "1.1");
    }

    // 路径②:首轮声称 sufficient 但 citation 悬空(零有效)→ 强制外扩;
    //        次轮给真 LID → chapter 收口。验证「零有效强制外扩」+「悬空滤净(结构红线)」。
    #[test]
    fn zero_valid_citation_forces_expand_and_filters_hallucination() {
        let b = book();
        let fake = FakeAdapter::new(vec![
            resp(true, vec![cite("9.9")]), // 9.9 不在证据集 → 滤掉 → 零有效 → 外扩
            resp(true, vec![cite("1.1")]),
        ]);
        let out = query(&b, "问", "1.1", &fake).unwrap();
        assert_eq!(out.scope_used, "chapter");
        assert!(!out.incomplete);
        assert!(out.citations.iter().all(|c| c.lid == "1.1")); // 悬空 9.9 不出现
    }

    // 路径③:两档都不足 → 触顶诚实标 incomplete + CONTEXT_BUDGET_EXCEEDED。
    #[test]
    fn exhausting_ladder_marks_incomplete() {
        let b = book();
        let fake = FakeAdapter::new(vec![resp(false, vec![]), resp(false, vec![])]);
        let out = query(&b, "问", "1.1", &fake).unwrap();
        assert_eq!(out.scope_used, "chapter");
        assert!(out.incomplete);
        assert_eq!(out.warning.as_deref(), Some("CONTEXT_BUDGET_EXCEEDED"));
    }

    // retrieve:证据集含 anchor 自身 + 真原文。
    #[test]
    fn retrieve_local_includes_anchor_text() {
        let b = book();
        let ev = retrieve(&b, "1.1", Scope::Local).unwrap();
        assert!(ev.contains_key("1.1"));
        assert_eq!(ev["1.1"], "X".repeat(100));
    }
}
