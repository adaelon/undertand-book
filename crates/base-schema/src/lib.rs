//! 基座 schema 单一真相源(切片0 最小子集)。
//! Rust 权威定义 → ts-rs 生成 TS(给预构建)+ schemars 出 JSON Schema(语言中立文档)。
//! 见 docs/adr/0021(技术栈)/ docs/切片方案-切片0样板间.md S0。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 内容区间(半开 [start, end)),映射回源文。
/// 切片0 = **UTF-16 code unit 下标**(TS segment 用 JS 串下标);字节精确化留后 `[ADR-0024]`。
/// ⇒ Rust book.text 须按 UTF-16 语义切原文(encode_utf16 索引),勿按 UTF-8 字节直切(中文会错位)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// LID 节点类型。切片0 停在段(Paragraph),句留切片1+。
/// Asset 一等对象切片只增不改:Code/Table/Image/Formula 是带类型 LID 叶子 `[ADR-0029]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub enum NodeKind {
    Chapter,
    Section,
    Paragraph,
    Code,
    Table,
    Image,
    Formula,
}

/// 一个 LID 树节点(切分产物),物化路径寻址。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct LidNode {
    /// 物化路径串,如 "3.2.5"(比较用逐段数值,非字典序)
    pub lid: String,
    /// 物化路径的数值分段(排序键)
    pub path: Vec<u32>,
    pub kind: NodeKind,
    pub span: Span,
    /// 子 LID(有序)
    pub children: Vec<String>,
}

/// 图谱节点类型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub enum GraphNodeType {
    Entity,
    Concept,
    Claim,
}

/// 图谱节点。实体/概念多锚(occurrences),断言单锚(source_lid)`[ADR-0010]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct GraphNode {
    /// entity:{name} | concept:{name} | claim:{lid}:{slug}
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: GraphNodeType,
    pub name: String,
    /// 实体/概念出现锚点集;断言为空
    pub occurrences: Vec<String>,
    /// 断言单锚 LID;实体/概念为 null
    pub source_lid: Option<String>,
}

/// 边来源标记。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub enum EdgeScope {
    Local,
    LongRange,
}

/// 边方向 `[ADR-0010/0011/0023]`。directed = source→target 有序(如 builds_on/cites);
/// undirected = 两端对称(如 contradicts),merge 去重时规范化端点顺序后比对。
/// 是 merge 去重键 (source,target,type,direction) 的成员 `[ADR-0011 决策4]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub enum Direction {
    Directed,
    Undirected,
}

/// 语义边。source/target = 节点 id(非 LID)`[ADR-0010]`。
/// 切片0 字段 = source/target/type/direction/scope/weight;
/// **不含 description**(读时边只作召回路标、不进推理 [ADR-0011];merge 亦不用)`[ADR-0023]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub direction: Direction,
    pub scope: EdgeScope,
    pub weight: f32,
}

/// 公式参数解释。每条解释必须带真实 LID 证据 `[ADR-0029]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct FormulaParameter {
    pub symbol: String,
    pub label: Option<String>,
    pub meaning: String,
    pub unit: Option<String>,
    pub domain: Option<String>,
    pub evidence_lids: Vec<String>,
}

/// 公式整体组合含义。source_lid 指向公式叶子本身, evidence_lids 指向上下文证据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct FormulaComposition {
    pub source_lid: String,
    pub meaning: String,
    pub terms: Vec<String>,
    pub evidence_lids: Vec<String>,
}

/// 公式与上下文段落 / 概念 / 断言 / asset 的关系。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct FormulaContextLink {
    pub target_lid: String,
    pub relation: String,
    pub description: String,
    pub evidence_lids: Vec<String>,
}

/// Formula 叶子的高优先级读时语义剖面 `[ADR-0029]`。
/// 本类型先作为独立 schema 导出;SA5 再决定实际存储/索引位置,避免本刀破坏旧 base.json。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct FormulaSemantics {
    pub formula_lid: String,
    pub parameters: Vec<FormulaParameter>,
    pub composition: FormulaComposition,
    pub context_links: Vec<FormulaContextLink>,
}
/// 冻结只读基座(切片0 最小子集:LID 表 + 知识图谱)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/core/src/generated/")]
pub struct ReadOnlyBase {
    pub book_id: String,
    pub lid_nodes: Vec<LidNode>,
    pub graph_nodes: Vec<GraphNode>,
    pub graph_edges: Vec<GraphEdge>,
}

/// 手造样例基座 —— Rust roundtrip 测试与 TS fixture 比对共用同一形状。
pub fn sample_base() -> ReadOnlyBase {
    ReadOnlyBase {
        book_id: "sample-book".to_string(),
        lid_nodes: vec![
            LidNode {
                lid: "1".into(),
                path: vec![1],
                kind: NodeKind::Chapter,
                span: Span { start: 0, end: 100 },
                children: vec!["1.1".into()],
            },
            LidNode {
                lid: "1.1".into(),
                path: vec![1, 1],
                kind: NodeKind::Paragraph,
                span: Span { start: 0, end: 100 },
                children: vec![],
            },
        ],
        graph_nodes: vec![
            GraphNode {
                id: "entity:command".into(),
                node_type: GraphNodeType::Entity,
                name: "command".into(),
                occurrences: vec!["1.1".into()],
                source_lid: None,
            },
            GraphNode {
                id: "claim:1.1:cmd-is-reified-call".into(),
                node_type: GraphNodeType::Claim,
                name: "命令是对象化的方法调用".into(),
                occurrences: vec![],
                source_lid: Some("1.1".into()),
            },
        ],
        graph_edges: vec![GraphEdge {
            source: "claim:1.1:cmd-is-reified-call".into(),
            target: "entity:command".into(),
            edge_type: "exemplifies".into(),
            direction: Direction::Directed,
            scope: EdgeScope::Local,
            weight: 0.8,
        }],
    }
}
