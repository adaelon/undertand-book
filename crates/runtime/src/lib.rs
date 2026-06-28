//! 模块 E 自建最小运行时:`book.query` 内层无状态 mini-loop `[ADR-0016/0025]`。
//! 确定性档位检索(复用 `read-tools` 的 `Book`)+ ModelAdapter 合一轮判停 + 确定性交叉验停。
//! 切片0:scope 两档(local/chapter)+ FakeAdapter(确定性测);NativeAdapter 见 S5b。
use base_schema::{GraphNodeType, LidNode, NodeKind};
use memory::ReaderProfile;
use read_tools::{Book, Frontier, NavCategory, RankedStep, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use ts_rs::TS;

pub mod goldset;
pub mod orchestrator;

/// scope 档(P1 扩到 local/chapter/cross_chapter/global)`[ADR-0016/0033]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Local,
    Chapter,
    CrossChapter,
    Global,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Local => "local",
            Scope::Chapter => "chapter",
            Scope::CrossChapter => "cross_chapter",
            Scope::Global => "global",
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
        Message {
            role: Role::System,
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
    pub fn user(content: impl Into<String>) -> Message {
        Message {
            role: Role::User,
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
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
    fn chat(&self, messages: &[Message], tools: &[ToolSpec])
        -> Result<AssistantTurn, AdapterError>;
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
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryResponse {
    pub answer: Option<String>,
    pub citations: Vec<Citation>,
    pub model_supplement: Vec<SupplementOut>,
    pub scope_used: String,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Citation {
    pub lid: String,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SupplementOut {
    pub text: String,
    pub source: String,
}

/// `book.synthesize` 对外响应:复用 query 的 answer/citations/model_supplement 骨架,
/// 但 echo 输入 `source_lids` 并标记是否走分批归并 `[ADR-0017/0033]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SynthesizeResponse {
    pub answer: Option<String>,
    pub citations: Vec<Citation>,
    pub model_supplement: Vec<SupplementOut>,
    pub source_lids: Vec<String>,
    pub batched: bool,
    pub evidence_chain: Vec<String>,
    pub related_concepts: Vec<String>,
    pub suggested_probing: Vec<String>,
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
            let is_leaf = lid_node(book, l)
                .map(|nd| nd.children.is_empty())
                .unwrap_or(false);
            if in_tree && is_leaf && !out.iter().any(|x| x == l) {
                out.push(l.to_string());
            }
        }
    }
    out.sort();
    out
}

/// 全书所有 anchored 叶 LID,供 global scope 使用。
fn anchored_leaves_all(book: &Book) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in &book.base.graph_nodes {
        let lids: Vec<&str> = match n.node_type {
            GraphNodeType::Claim => n.source_lid.as_deref().into_iter().collect(),
            _ => n.occurrences.iter().map(|s| s.as_str()).collect(),
        };
        for l in lids {
            let is_leaf = lid_node(book, l)
                .map(|nd| nd.children.is_empty())
                .unwrap_or(false);
            if is_leaf && !out.iter().any(|x| x == l) {
                out.push(l.to_string());
            }
        }
    }
    out.sort();
    out
}

/// 确定性档位检索:沿图谱/树捞 LID + 真原文成证据集 `[ADR-0016/0033]`。
/// local = anchor ∪ context(near);chapter = local ∪ 章内 anchored 叶;
/// cross_chapter = chapter ∪ context(far);global = cross_chapter ∪ 全书 anchored 叶。
fn retrieve(book: &Book, anchor: &str, scope: Scope) -> Result<EvidenceSet, ToolError> {
    let mut ev: EvidenceSet = BTreeMap::new();
    ev.insert(anchor.to_string(), book.text(anchor, None)?);

    let ctx = book.context(anchor, Some("near"), Some(usize::MAX))?;
    for it in ctx.items {
        if !ev.contains_key(&it.lid) {
            ev.insert(it.lid.clone(), book.text(&it.lid, None)?);
        }
    }

    if matches!(scope, Scope::Chapter | Scope::CrossChapter | Scope::Global) {
        let root = chapter_root(book, anchor);
        for l in anchored_leaves_under(book, &root) {
            if !ev.contains_key(&l) {
                ev.insert(l.clone(), book.text(&l, None)?);
            }
        }
    }

    if matches!(scope, Scope::CrossChapter | Scope::Global) {
        let ctx = book.context(anchor, Some("far"), Some(usize::MAX))?;
        for it in ctx.items {
            if !ev.contains_key(&it.lid) {
                ev.insert(it.lid.clone(), book.text(&it.lid, None)?);
            }
        }
    }

    if scope == Scope::Global {
        for l in anchored_leaves_all(book) {
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

const SYNTHESIZE_BATCH_TOKEN_LIMIT: usize = 80;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SynthesizeMode {
    Compare,
    Explain,
    Summarize,
    Derive,
    Teach,
    AnswerQuestion,
}

impl SynthesizeMode {
    fn from_task(task: Option<&str>) -> SynthesizeMode {
        let Some(task) = task else {
            return SynthesizeMode::Summarize;
        };
        let lower = task.to_ascii_lowercase();
        if task.contains("比较") || task.contains("对比") || lower.contains("compare") {
            SynthesizeMode::Compare
        } else if task.contains("推导") || task.contains("证明") || lower.contains("derive") || lower.contains("prove") {
            SynthesizeMode::Derive
        } else if task.contains("教") || task.contains("讲给") || lower.contains("teach") {
            SynthesizeMode::Teach
        } else if task.contains("解释") || task.contains("说明") || lower.contains("explain") {
            SynthesizeMode::Explain
        } else if task.contains("回答") || task.contains("问题") || lower.contains("answer") || lower.contains("question") {
            SynthesizeMode::AnswerQuestion
        } else {
            SynthesizeMode::Summarize
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SynthesizeMode::Compare => "compare",
            SynthesizeMode::Explain => "explain",
            SynthesizeMode::Summarize => "summarize",
            SynthesizeMode::Derive => "derive",
            SynthesizeMode::Teach => "teach",
            SynthesizeMode::AnswerQuestion => "answer_question",
        }
    }

    fn instruction(self) -> &'static str {
        match self {
            SynthesizeMode::Compare => "组织为相同点/差异点/适用边界,不要引入输入 LID 之外的证据。",
            SynthesizeMode::Explain => "优先给定义、机制、例子和限制,证据必须来自输入 LID。",
            SynthesizeMode::Summarize => "按章节/LID 顺序压缩主旨,保留关键限定条件。",
            SynthesizeMode::Derive => "按原文证据给出逐步推导链,缺失步骤必须标为 model_supplement。",
            SynthesizeMode::Teach => "用教学顺序组织解释,可补前置知识但不得把补充当 citation。",
            SynthesizeMode::AnswerQuestion => "直接回答问题,再列支撑证据和必要补充。",
        }
    }
}

fn estimate_tokens(s: &str) -> usize {
    let mut t = 0.0f32;
    for ch in s.chars() {
        t += if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            1.0
        } else {
            0.25
        };
    }
    t.ceil() as usize
}

fn formula_semantics_hint(book: &Book, lid: &str) -> Option<String> {
    let node = lid_node(book, lid)?;
    if !matches!(node.kind, NodeKind::Formula) {
        return None;
    }
    let Some(semantics) = book.formula_semantics(lid) else {
        return Some(format!(
            "[FormulaSemantics] formula_lid={lid}; optional_sidecar=not_attached; use formula text and surrounding supplied evidence only."
        ));
    };

    let mut lines = vec![format!("Formula {}", semantics.formula_lid)];
    lines.push(format!("Composition: {}", semantics.composition.meaning));
    if !semantics.composition.terms.is_empty() {
        lines.push(format!("Terms: {}", semantics.composition.terms.join("; ")));
    }
    if !semantics.parameters.is_empty() {
        lines.push("Parameters:".into());
        for p in &semantics.parameters {
            let label = p
                .label
                .as_ref()
                .map(|label| format!("{} ({label})", p.symbol))
                .unwrap_or_else(|| p.symbol.clone());
            let unit = p
                .unit
                .as_ref()
                .map(|u| format!(" unit={u}"))
                .unwrap_or_default();
            let domain = p
                .domain
                .as_ref()
                .map(|d| format!(" domain={d}"))
                .unwrap_or_default();
            lines.push(format!(
                "- {label}: {meaning}{unit}{domain} [{evidence}]",
                meaning = p.meaning,
                evidence = p.evidence_lids.join(", ")
            ));
        }
    }
    if !semantics.context_links.is_empty() {
        lines.push("Context links:".into());
        for link in &semantics.context_links {
            lines.push(format!(
                "- {relation} {target}: {description} [{evidence}]",
                relation = link.relation,
                target = link.target_lid,
                description = link.description,
                evidence = link.evidence_lids.join(", ")
            ));
        }
    }
    Some(lines.join("\n"))
}

fn discourse_hints(book: &Book, ev: &EvidenceSet) -> Vec<String> {
    let allowed: std::collections::BTreeSet<&str> = ev.keys().map(|lid| lid.as_str()).collect();
    let mut hints = Vec::new();
    for lid in ev.keys() {
        let Some(item) = book.discourse_item(lid) else {
            continue;
        };
        let mut lines = vec![format!("Discourse {}: mode={}", item.lid, item.mode)];
        if let Some(local_function) = &item.local_function {
            lines.push(format!("local_function={local_function}"));
        }
        if let Some(rhetorical_move) = &item.rhetorical_move {
            lines.push(format!("rhetorical_move={rhetorical_move}"));
        }
        if let Some(summary) = &item.local_summary {
            lines.push(format!("summary={summary}"));
        }
        let mut relation_lines = Vec::new();
        for r in &item.relations {
            let target_in_input = allowed.contains(r.target_lid.as_str());
            let evidence_in_input = r.evidence_lids.iter().all(|l| allowed.contains(l.as_str()));
            if target_in_input && evidence_in_input {
                relation_lines.push(format!(
                    "- {ty} -> {target} direction={direction} confidence={confidence:.2} evidence=[{evidence}]",
                    ty = r.relation_type,
                    target = r.target_lid,
                    direction = r.direction,
                    confidence = r.confidence,
                    evidence = r.evidence_lids.join(", ")
                ));
            }
        }
        if !relation_lines.is_empty() {
            lines.push("relations:".into());
            lines.extend(relation_lines);
        }
        hints.push(lines.join("\n"));
    }
    hints
}
fn build_synthesize_prompt(
    task: Option<&str>,
    mode: SynthesizeMode,
    ev: &EvidenceSet,
    formula_hints: &[String],
    discourse_hints: &[String],
    partials: &[String],
) -> CompletionRequest {
    let mut user = String::from("任务:\n");
    user.push_str(task.unwrap_or("综合这些 LID 的内容"));
    user.push_str("\n\nSynthesizePolicy:\n");
    user.push_str("- book_profile=technical_learning\n");
    user.push_str(&format!("- mode={}\n", mode.as_str()));
    user.push_str("- citation_policy=citations_subset_of_input_lids\n");
    user.push_str("- formula_policy=include_formula_semantics_when_formula_lid_present\n");
    user.push_str("- discourse_policy=use_discourse_relations_as_structure_hints\n");
    user.push_str("- reader_profile=not_attached\n");
    user.push_str(&format!("- mode_instruction={}\n", mode.instruction()));
    user.push_str("\n\n输入 LID 范围(只允许引用这些 LID):\n");
    for lid in ev.keys() {
        user.push_str(&format!("- {lid}\n"));
    }
    if !formula_hints.is_empty() {
        user.push_str("\n公式语义上下文(仅作结构提示,不新增 citation):\n");
        for h in formula_hints {
            user.push_str(h);
            user.push('\n');
        }
    }
    if !discourse_hints.is_empty() {
        user.push_str("\n语篇结构提示(仅限输入 LID 范围,不新增 citation):\n");
        for h in discourse_hints {
            user.push_str(h);
            user.push('\n');
        }
    }
    if !partials.is_empty() {
        user.push_str("\n分批局部综合结果(归并时仍只能引用输入 LID):\n");
        for (i, p) in partials.iter().enumerate() {
            user.push_str(&format!("[batch:{}] {p}\n", i + 1));
        }
    }
    user.push_str("\n证据(每条前缀 [LID],citations 只能引用这里出现的 LID):\n");
    for (lid, text) in ev {
        user.push_str(&format!("[{lid}] {text}\n"));
    }
    CompletionRequest {
        system: "你是书内综合器。只依据调用方给定的 LID 范围综合;不得外扩检索。\
                 citations 只能引用输入 LID;原文未覆盖的世界知识补充放 model_supplement(无 LID)。"
            .into(),
        user,
    }
}

fn valid_citations(resp: &ParsedResponse, ev: &EvidenceSet) -> Vec<RawCitation> {
    resp.citations
        .iter()
        .filter(|c| ev.contains_key(&c.lid))
        .cloned()
        .collect()
}


fn related_concepts(book: &Book, source_lids: &[String]) -> Vec<String> {
    let source: std::collections::BTreeSet<&str> = source_lids.iter().map(|s| s.as_str()).collect();
    let mut names = std::collections::BTreeSet::new();
    for node in &book.base.graph_nodes {
        let anchored = match node.node_type {
            GraphNodeType::Claim => node
                .source_lid
                .as_deref()
                .is_some_and(|lid| source.contains(lid)),
            GraphNodeType::Entity | GraphNodeType::Concept => node
                .occurrences
                .iter()
                .any(|lid| source.contains(lid.as_str())),
        };
        if anchored && matches!(node.node_type, GraphNodeType::Entity | GraphNodeType::Concept) {
            names.insert(node.name.clone());
        }
    }
    names.into_iter().collect()
}

fn suggested_probing(book: &Book, source_lids: &[String]) -> Vec<String> {
    let source: std::collections::BTreeSet<&str> = source_lids.iter().map(|s| s.as_str()).collect();
    let mut suggestions = std::collections::BTreeSet::new();
    for lid in source_lids {
        if book.formula_semantics(lid).is_some() {
            suggestions.insert(format!("解释公式 {lid} 的参数、组合含义和适用条件"));
        }
        if let Some(item) = book.discourse_item(lid) {
            if let Some(local_function) = &item.local_function {
                suggestions.insert(format!("围绕 {lid} 的 {local_function} 功能继续追问"));
            }
            for rel in &item.relations {
                let target_in_input = source.contains(rel.target_lid.as_str());
                let evidence_in_input = rel.evidence_lids.iter().all(|l| source.contains(l.as_str()));
                if target_in_input && evidence_in_input {
                    suggestions.insert(format!(
                        "追问 {lid} 如何通过 {} 关系连接 {}",
                        rel.relation_type, rel.target_lid
                    ));
                }
            }
        }
    }
    suggestions.into_iter().collect()
}
fn synth_response(
    resp: ParsedResponse,
    valid: Vec<RawCitation>,
    source_lids: Vec<String>,
    batched: bool,
    evidence_chain: Vec<String>,
    related_concepts: Vec<String>,
    suggested_probing: Vec<String>,
) -> SynthesizeResponse {
    SynthesizeResponse {
        answer: resp.answer,
        citations: valid
            .into_iter()
            .map(|c| Citation {
                lid: c.lid,
                text: c.text,
                role: c.role,
            })
            .collect(),
        model_supplement: resp
            .model_supplement
            .into_iter()
            .map(|s| SupplementOut {
                text: s.text,
                source: "model".into(),
            })
            .collect(),
        source_lids,
        batched,
        evidence_chain,
        related_concepts,
        suggested_probing,
    }
}

/// `book.synthesize(lids, task?)` 深路径 `[ADR-0017/0033]`。
/// 调用方显式给定离散 LID 集;系统不外扩,并确定性过滤 citations ⊆ input lids。
pub fn synthesize(
    book: &Book,
    lids: &[String],
    task: Option<&str>,
    adapter: &dyn ModelAdapter,
) -> Result<SynthesizeResponse, ToolError> {
    if lids.is_empty() {
        return Err(ToolError {
            error_code: "INVALID_RANGE".into(),
            category: "validation".into(),
            message: "book.synthesize 需至少一个 LID".into(),
        });
    }
    let mode = SynthesizeMode::from_task(task);
    let mut ev: EvidenceSet = BTreeMap::new();
    let mut formula_hints = Vec::new();
    for lid in lids {
        if !ev.contains_key(lid) {
            ev.insert(lid.clone(), book.text(lid, None)?);
            if let Some(h) = formula_semantics_hint(book, lid) {
                formula_hints.push(h);
            }
        }
    }
    let source_lids: Vec<String> = ev.keys().cloned().collect();
    let total_tokens: usize = ev
        .iter()
        .map(|(lid, text)| estimate_tokens(lid) + estimate_tokens(text))
        .sum();
    if total_tokens <= SYNTHESIZE_BATCH_TOKEN_LIMIT {
        let resp = adapter
            .complete(build_synthesize_prompt(
                task,
                mode,
                &ev,
                &formula_hints,
                &discourse_hints(book, &ev),
                &[],
            ))
            .map_err(|e| ToolError {
                error_code: "PROVIDER_ERROR".into(),
                category: "provider".into(),
                message: e.message,
            })?;
        let valid = valid_citations(&resp, &ev);
        return Ok(synth_response(
            resp,
            valid,
            source_lids.clone(),
            false,
            source_lids.clone(),
            related_concepts(book, &source_lids),
            suggested_probing(book, &source_lids),
        ));
    }

    let mut batches: Vec<EvidenceSet> = Vec::new();
    let mut cur: EvidenceSet = BTreeMap::new();
    let mut cur_tokens = 0usize;
    for (lid, text) in &ev {
        let cost = estimate_tokens(lid) + estimate_tokens(text);
        if !cur.is_empty() && cur_tokens + cost > SYNTHESIZE_BATCH_TOKEN_LIMIT {
            batches.push(cur);
            cur = BTreeMap::new();
            cur_tokens = 0;
        }
        cur.insert(lid.clone(), text.clone());
        cur_tokens += cost;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }

    let mut partials = Vec::new();
    let mut cited_lids = Vec::new();
    for batch in &batches {
        let batch_hints: Vec<String> = batch
            .keys()
            .filter_map(|lid| formula_semantics_hint(book, lid))
            .collect();
        let resp = adapter
            .complete(build_synthesize_prompt(
                task,
                mode,
                batch,
                &batch_hints,
                &discourse_hints(book, batch),
                &[],
            ))
            .map_err(|e| ToolError {
                error_code: "PROVIDER_ERROR".into(),
                category: "provider".into(),
                message: e.message,
            })?;
        for c in valid_citations(&resp, batch) {
            if !cited_lids.iter().any(|l: &String| l == &c.lid) {
                cited_lids.push(c.lid);
            }
        }
        if let Some(answer) = resp.answer {
            partials.push(answer);
        }
    }

    let mut merge_ev: EvidenceSet = BTreeMap::new();
    if cited_lids.is_empty() {
        for lid in &source_lids {
            merge_ev.insert(lid.clone(), ev[lid].clone());
        }
    } else {
        cited_lids.sort();
        for lid in &cited_lids {
            merge_ev.insert(lid.clone(), ev[lid].clone());
        }
    }
    let merge_chain: Vec<String> = merge_ev.keys().cloned().collect();
    let resp = adapter
        .complete(build_synthesize_prompt(
            task,
            mode,
            &merge_ev,
            &formula_hints,
            &discourse_hints(book, &merge_ev),
            &partials,
        ))
        .map_err(|e| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: e.message,
        })?;
    let valid = valid_citations(&resp, &merge_ev);
    Ok(synth_response(
        resp,
        valid,
        source_lids.clone(),
        true,
        merge_chain,
        related_concepts(book, &source_lids),
        suggested_probing(book, &source_lids),
    ))
}
/// `book.query` 内层无状态 mini-loop `[ADR-0016/0025]`。
/// 混合驱动:确定性档位骨架捞证据 → LLM 合一轮判停作答 → 确定性交叉验停(citations⊆证据集)。
/// 不足或零有效 citation → 外扩(local→chapter→cross_chapter→global);global 仍不足 → 触顶诚实标 incomplete。
pub fn query(
    book: &Book,
    q: &str,
    anchor: &str,
    adapter: &dyn ModelAdapter,
) -> Result<QueryResponse, ToolError> {
    let ladder = [
        Scope::Local,
        Scope::Chapter,
        Scope::CrossChapter,
        Scope::Global,
    ];
    for (i, &scope) in ladder.iter().enumerate() {
        let ev = retrieve(book, anchor, scope)?;
        let resp = adapter
            .complete(build_prompt(q, &ev))
            .map_err(|e| ToolError {
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
            // 触顶兜底:global 仍不足/零有效 → 诚实标 incomplete,不假装完整。
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
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

/// 鲁棒 JSON 对象抽取(S9 `[ADR-0016 决策5 / ADR-0004]`):从可能含 markdown 围栏 /
/// 前后散文杂质的内容里,抽出**第一个平衡 `{}` 对象子串**(跳过字符串字面量内的括号与
/// `\` 转义,故引号内的 `{`/`}` 不计深度)。抽不到返回 `None`,由调用方诚实报错,
/// **不静默降级**(守 `[ADR-0015]`)。本函数只负责「形状」抽取,值的正确性仍由内层
/// `query` 的确定性交叉验停(`citations⊆证据集`)再校验一遍 `[ADR-0004]`。
/// 仅扫描 `{`/`}`/`"`/`\` 等 ASCII 字节,返回的子串始终落在 char 边界(多字节 UTF-8 续字节 ≥0x80,
/// 不与这些 ASCII 冲突),`&t[start..=i]` 切片安全。
fn extract_json_object(s: &str) -> Option<&str> {
    let t = strip_fence(s);
    let bytes = t.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&t[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
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
        // S9:抽不到平衡 JSON 对象(空响应 / 纯散文)→ 显式报错,不静默成功(守禁宽松降级 `[ADR-0015]`)。
        let json = extract_json_object(content).ok_or_else(|| AdapterError {
            message: format!("模型输出抽不到合法 JSON 对象;原文={content}"),
        })?;
        let out: LlmOut = serde_json::from_str(json).map_err(|e| AdapterError {
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
    fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<AssistantTurn, AdapterError> {
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
                    arguments: tc["function"]["arguments"]
                        .as_str()
                        .unwrap_or("{}")
                        .to_string(),
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

/// technical_learning 教学整形后的有序前沿分组 `[ADR-0037]`。
/// = route_from 5 类前沿按教学序重排 + 剔空组;保分组导航语义(不平铺)。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct GuidedGroup {
    pub category: NavCategory,
    pub steps: Vec<RankedStep>,
}

/// 无 reader_profile 时的中性默认教学序 `[ADR-0037 决策4]`:主线推进优先,不假设新手。
/// 占位常量,实测 / reader_profile(P4)回填(ADR-0037 何时回头)。
const TEACHING_ORDER: [NavCategory; 5] = [
    NavCategory::Continue,
    NavCategory::Back,
    NavCategory::Concretize,
    NavCategory::Forward,
    NavCategory::Cross,
];

/// technical_learning 教学整形 `[ADR-0037 决策2 / ADR-0038 已读降权]`:按 `TEACHING_ORDER` 重排 5 类分组
/// + 剔空组 + **reader_profile 组内已读降权**。零 LLM、确定性可单测;与 `book.synthesize`「Core+policy」同构。
/// 已读降权 = 组内**稳定排序**未读在前、已读沉底(保留组内原 weight×距离 次序;**保留回看入口,不剔除**)。
/// `read_set` 空(无 reader_profile / 全未读)⇒ 退化为纯 TEACHING_ORDER 重排(向后兼容)。
fn technical_learning_reorder(f: Frontier, read_set: &HashSet<String>) -> Vec<GuidedGroup> {
    let Frontier {
        back,
        forward,
        concretize,
        cross,
        continue_,
    } = f;
    let mut buckets: Vec<(NavCategory, Vec<RankedStep>)> = vec![
        (NavCategory::Back, back),
        (NavCategory::Forward, forward),
        (NavCategory::Concretize, concretize),
        (NavCategory::Cross, cross),
        (NavCategory::Continue, continue_),
    ];
    // 组内已读降权:false(未读)< true(已读),稳定排序保组内原次序。
    for (_, steps) in buckets.iter_mut() {
        steps.sort_by_key(|s| read_set.contains(&s.lid));
    }
    TEACHING_ORDER
        .iter()
        .filter_map(|cat| {
            let pos = buckets.iter().position(|(c, _)| c == cat)?;
            let (category, steps) = buckets.remove(pos);
            (!steps.is_empty()).then_some(GuidedGroup { category, steps })
        })
        .collect()
}

/// `book.guided_route_from(at, k?)` `[ADR-0037 决策1 / ADR-0038]`:route_from(Core)+ technical_learning
/// 教学整形 + reader_profile 个性化(已读降权)。裸 `book.route_from` 仍在(访客/高级);住户带读优先用本工具。
/// `profile` 是读者私人画像(② 绝不外借访客);仅消费 `read_lids` 做降权(focus/puzzle 留后续)。
pub fn guided_route_from(
    book: &Book,
    at: &str,
    k: Option<usize>,
    profile: &ReaderProfile,
) -> Result<Vec<GuidedGroup>, ToolError> {
    let read_set: HashSet<String> = profile.read_lids.iter().cloned().collect();
    Ok(technical_learning_reorder(book.route_from(at, k)?, &read_set))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{
        sample_base, FormulaComposition, FormulaParameter, FormulaSemantics, GraphEdge, GraphNode,
        ReadOnlyBase, Span,
    };
    use read_tools::{TechnicalLearningDiscourseItem, TechnicalLearningDiscourseRelation};
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn rstep(lid: &str) -> RankedStep {
        RankedStep {
            lid: lid.into(),
            edge_type: "x".into(),
            why: String::new(),
            evidence_lids: vec![],
            score: 1.0,
        }
    }

    // P3-3 教学整形:中性序 continue>back>concretize>forward>cross + 剔空组,确定性。
    #[test]
    fn technical_learning_reorder_neutral_order_and_drops_empty() {
        let f = Frontier {
            back: vec![rstep("1.0")],
            forward: vec![],
            concretize: vec![],
            cross: vec![rstep("9.9")],
            continue_: vec![rstep("1.2")],
        };
        let g = technical_learning_reorder(f, &HashSet::new());
        let cats: Vec<NavCategory> = g.iter().map(|x| x.category).collect();
        // 中性序剔空组后 = [Continue, Back, Cross]
        assert_eq!(
            cats,
            vec![NavCategory::Continue, NavCategory::Back, NavCategory::Cross]
        );
        assert_eq!(g[0].steps[0].lid, "1.2"); // continue
        assert_eq!(g[1].steps[0].lid, "1.0"); // back
        assert_eq!(g[2].steps[0].lid, "9.9"); // cross
    }

    // 全空前沿 → 无分组(非 error)。
    #[test]
    fn technical_learning_reorder_empty_frontier_yields_no_groups() {
        let f = Frontier {
            back: vec![],
            forward: vec![],
            concretize: vec![],
            cross: vec![],
            continue_: vec![],
        };
        assert!(technical_learning_reorder(f, &HashSet::new()).is_empty());
    }

    // reader_profile 已读降权 `[ADR-0038]`:组内未读在前、已读沉底(稳定排序保原次序);不剔除。
    #[test]
    fn technical_learning_reorder_demotes_read_within_group() {
        let f = Frontier {
            back: vec![rstep("1.0"), rstep("1.1"), rstep("1.2")], // 1.0/1.2 已读、1.1 未读
            forward: vec![rstep("2.0")],                          // 全未读,不变
            concretize: vec![],
            cross: vec![],
            continue_: vec![],
        };
        let read: HashSet<String> = ["1.0", "1.2"].iter().map(|s| s.to_string()).collect();
        let g = technical_learning_reorder(f, &read);
        let back = g.iter().find(|x| x.category == NavCategory::Back).unwrap();
        let lids: Vec<&str> = back.steps.iter().map(|s| s.lid.as_str()).collect();
        assert_eq!(lids, vec!["1.1", "1.0", "1.2"]); // 未读升首,已读沉底保原序
        assert_eq!(back.steps.len(), 3); // 已读不剔除(保留回看入口)
        let fwd = g.iter().find(|x| x.category == NavCategory::Forward).unwrap();
        assert_eq!(fwd.steps[0].lid, "2.0"); // 全未读不变
    }

    /// 确定性测试替身:按调用次序吐脚本化 ParsedResponse(loop 每轮调一次 complete)。
    struct FakeAdapter {
        scripted: RefCell<VecDeque<ParsedResponse>>,
    }

    struct RecordingAdapter {
        scripted: RefCell<VecDeque<ParsedResponse>>,
        users: RefCell<Vec<String>>,
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

    impl RecordingAdapter {
        fn new(rs: Vec<ParsedResponse>) -> Self {
            RecordingAdapter {
                scripted: RefCell::new(rs.into()),
                users: RefCell::new(vec![]),
            }
        }
    }
    impl ModelAdapter for RecordingAdapter {
        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.users.borrow_mut().push(req.user);
            self.scripted
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "recording fake 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("synthesize 测不涉及外层 chat")
        }
    }

    fn book() -> Book {
        // sample_base: "1"(容器)+ "1.1"(叶);entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    fn book_with_cjk_leaves(n: usize) -> Book {
        let leaf_units = 100usize;
        let mut source = String::new();
        let mut children = Vec::new();
        let mut lid_nodes = Vec::new();
        for i in 1..=n {
            children.push(format!("1.{i}"));
            lid_nodes.push(LidNode {
                lid: format!("1.{i}"),
                path: vec![1, i as u32],
                kind: NodeKind::Paragraph,
                span: Span {
                    start: (i - 1) * leaf_units,
                    end: i * leaf_units,
                },
                children: vec![],
            });
            source.push_str(&"汉".repeat(leaf_units));
        }
        lid_nodes.insert(
            0,
            LidNode {
                lid: "1".into(),
                path: vec![1],
                kind: NodeKind::Chapter,
                span: Span {
                    start: 0,
                    end: n * leaf_units,
                },
                children,
            },
        );
        Book::new(
            ReadOnlyBase {
                book_id: "book-cjk".into(),
                lid_nodes,
                graph_nodes: Vec::<GraphNode>::new(),
                graph_edges: Vec::<GraphEdge>::new(),
            },
            &source,
        )
    }
    fn formula_semantics() -> FormulaSemantics {
        FormulaSemantics {
            formula_lid: "1.2".into(),
            parameters: vec![FormulaParameter {
                symbol: "r".into(),
                label: Some("radius".into()),
                meaning: "圆的半径".into(),
                unit: Some("m".into()),
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "1.2".into(),
                meaning: "圆面积由半径平方和常数 pi 相乘得到".into(),
                terms: vec!["pi".into(), "r^2".into()],
                evidence_lids: vec!["1.1".into()],
            },
            context_links: vec![],
        }
    }

    fn book_with_discourse_index() -> Book {
        let source = "AAAABBBBCCCC";
        let base = ReadOnlyBase {
            book_id: "discourse-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 8 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 4 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 4, end: 8 },
                    children: vec![],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 8, end: 12 },
                    children: vec![],
                },
            ],
            graph_nodes: Vec::<GraphNode>::new(),
            graph_edges: Vec::<GraphEdge>::new(),
        };
        Book::new(base, source).with_discourse_items(vec![TechnicalLearningDiscourseItem {
            lid: "1.1".into(),
            mode: "informative".into(),
            local_function: Some("definition".into()),
            rhetorical_move: Some("main_point".into()),
            local_summary: Some("定义核心概念".into()),
            relations: vec![
                TechnicalLearningDiscourseRelation {
                    target_lid: "1.2".into(),
                    relation_type: "elaborates".into(),
                    family: Some("expansion".into()),
                    direction: "forward".into(),
                    confidence: 0.9,
                    evidence_lids: vec!["1.1".into(), "1.2".into()],
                },
                TechnicalLearningDiscourseRelation {
                    target_lid: "2.1".into(),
                    relation_type: "depends_on".into(),
                    family: None,
                    direction: "forward".into(),
                    confidence: 0.8,
                    evidence_lids: vec!["1.1".into(), "2.1".into()],
                },
            ],
        }])
    }
    fn book_with_formula_semantics() -> Book {
        let source = "AAAAAAAAAAAABBBBBBBBBBBBBBB";
        let base = ReadOnlyBase {
            book_id: "formula-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 27 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 12 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Formula,
                    span: Span { start: 12, end: 27 },
                    children: vec![],
                },
            ],
            graph_nodes: Vec::<GraphNode>::new(),
            graph_edges: Vec::<GraphEdge>::new(),
        };
        Book::new(base, source).with_formula_semantics(vec![formula_semantics()])
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
            answer: if sufficient {
                Some("答案".into())
            } else {
                None
            },
            citations: cites,
            model_supplement: vec![],
        }
    }

    #[test]
    fn synthesize_includes_only_input_scoped_discourse_hints() {
        let b = book_with_discourse_index();
        let fake = RecordingAdapter::new(vec![resp(true, vec![cite("1.1")])]);
        let out = synthesize(&b, &["1.1".into(), "1.2".into()], Some("综合结构"), &fake).unwrap();
        assert_eq!(out.citations[0].lid, "1.1");
        let prompts = fake.users.borrow();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Discourse 1.1: mode=informative"));
        assert!(prompts[0].contains("local_function=definition"));
        assert!(prompts[0].contains("summary=定义核心概念"));
        assert!(prompts[0]
            .contains("- elaborates -> 1.2 direction=forward confidence=0.90 evidence=[1.1, 1.2]"));
        assert!(!prompts[0].contains("depends_on -> 2.1"));
        assert!(!prompts[0].contains("2.1 direction"));
    }
    #[test]
    fn synthesize_includes_formula_semantics_sidecar_in_prompt() {
        let b = book_with_formula_semantics();
        let fake = RecordingAdapter::new(vec![resp(true, vec![cite("1.2")])]);
        let out = synthesize(&b, &["1.2".into()], Some("解释公式"), &fake).unwrap();
        assert_eq!(out.citations[0].lid, "1.2");
        let prompts = fake.users.borrow();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Composition: 圆面积由半径平方和常数 pi 相乘得到"));
        assert!(prompts[0].contains("- r (radius): 圆的半径 unit=m [1.1]"));
        assert!(!prompts[0].contains("optional_sidecar=not_attached"));
        assert!(out
            .suggested_probing
            .contains(&"解释公式 1.2 的参数、组合含义和适用条件".to_string()));
    }
    #[test]
    fn synthesize_filters_citations_outside_input_lids() {
        let b = book();
        let fake = FakeAdapter::new(vec![resp(true, vec![cite("1.1"), cite("9.9")])]);
        let out = synthesize(&b, &["1.1".into()], Some("总结"), &fake).unwrap();
        assert!(!out.batched);
        assert_eq!(out.source_lids, vec!["1.1"]);
        assert_eq!(out.evidence_chain, vec!["1.1"]);
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].lid, "1.1");
    }

    #[test]
    fn synthesize_rejects_empty_or_unknown_lids() {
        let b = book();
        let fake = FakeAdapter::new(vec![]);
        let empty = synthesize(&b, &[], None, &fake).unwrap_err();
        assert_eq!(empty.error_code, "INVALID_RANGE");
        let missing = synthesize(&b, &["9.9".into()], None, &fake).unwrap_err();
        assert_eq!(missing.error_code, "LID_NOT_FOUND");
    }

    #[test]
    fn synthesize_batches_by_lid_order_and_filters_merge_citations() {
        let b = book_with_cjk_leaves(3);
        let fake = FakeAdapter::new(vec![
            ParsedResponse {
                sufficient: true,
                answer: Some("part 1".into()),
                citations: vec![cite("1.1")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("part 2".into()),
                citations: vec![cite("1.2")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("part 3".into()),
                citations: vec![cite("1.3")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("merged".into()),
                citations: vec![cite("1.2"), cite("9.9")],
                model_supplement: vec![],
            },
        ]);
        let out = synthesize(
            &b,
            &["1.1".into(), "1.2".into(), "1.3".into()],
            Some("综合"),
            &fake,
        )
        .unwrap();
        assert!(out.batched);
        assert_eq!(out.answer.as_deref(), Some("merged"));
        assert_eq!(out.source_lids, vec!["1.1", "1.2", "1.3"]);
        assert_eq!(out.evidence_chain, vec!["1.1", "1.2", "1.3"]);
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].lid, "1.2");
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

    // 路径③:四档都不足 → 触顶诚实标 incomplete + CONTEXT_BUDGET_EXCEEDED。
    #[test]
    fn exhausting_ladder_marks_incomplete() {
        let b = book();
        let fake = FakeAdapter::new(vec![
            resp(false, vec![]),
            resp(false, vec![]),
            resp(false, vec![]),
            resp(false, vec![]),
        ]);
        let out = query(&b, "问", "1.1", &fake).unwrap();
        assert_eq!(out.scope_used, "global");
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

    // S9 判据①:纯 JSON / 带围栏 / 前后包散文 三形态都抽对。
    #[test]
    fn extract_json_three_forms() {
        // 纯 JSON
        let pure = r#"{"sufficient": true, "answer": "x"}"#;
        assert_eq!(extract_json_object(pure), Some(pure));
        // markdown ```json 围栏
        assert_eq!(
            extract_json_object("```json\n{\"a\": 1}\n```"),
            Some("{\"a\": 1}")
        );
        // 前后包散文(模型啰嗦)
        assert_eq!(
            extract_json_object("好的,结果如下:{\"a\": 1} 希望有帮助。"),
            Some("{\"a\": 1}")
        );
    }

    // S9:跳过字符串字面量内的括号与转义 → 不被引号内的 } / { 提前截断。
    #[test]
    fn extract_json_skips_braces_in_strings() {
        let s = r#"前缀 {"text": "含 } 和 { 的引文", "n": 1} 后缀"#;
        assert_eq!(
            extract_json_object(s),
            Some(r#"{"text": "含 } 和 { 的引文", "n": 1}"#)
        );
        // 转义引号不误判字符串结束
        let esc = r#"{"text": "他说 \"x}\" 完"}"#;
        assert_eq!(extract_json_object(esc), Some(esc));
    }

    // S9 判据②前提:空内容 / 纯散文(无对象)→ None → 调用方报 PROVIDER_ERROR 不静默成功。
    #[test]
    fn extract_json_none_when_no_object() {
        assert_eq!(extract_json_object(""), None);
        assert_eq!(extract_json_object("   "), None);
        assert_eq!(extract_json_object("纯散文,没有任何 JSON 对象"), None);
        // 不平衡(只开不闭)→ 扫到末尾 depth>0 → None,不返回半截
        assert_eq!(extract_json_object(r#"{"a": 1"#), None);
    }
}
