//! 读时确定性叶子工具(切片0:manifest/text;context/concept 见 S4c)`[ADR-0014]`。
//! 消费冻结只读基座 `base.json` + 旁路原文 `source.txt`(UTF-16 span 口径 `[ADR-0024]`)。
//! 纯函数库,无 LLM、provider 无关;HTTP 暴露推 S7。
use base_schema::{
    Direction, EdgeScope, FormulaSemantics, GraphNodeType, LidNode, NodeKind, ReadOnlyBase, Span,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

// API DTO 的 ts-rs 导出目标(相对本 crate src/):前端类型契约单一真相源 `[ADR-0028 决策6]`。
// 与 base-schema(导出到 packages/core)分置:DTO 落 packages/web,跨指的 base 类型由 ts-rs 算相对 import。

/// 加载后的书:基座 + 原文(UTF-16 code unit 序列,span 即此口径 `[ADR-0024]`)+ lid 索引。
pub struct Book {
    pub base: ReadOnlyBase,
    source_u16: Vec<u16>,
    lid_idx: HashMap<String, usize>,
    node_idx: HashMap<String, usize>,
    formula_semantics: Vec<FormulaSemantics>,
    discourse_index: Vec<TechnicalLearningDiscourseItem>,
}

/// technical_learning discourse sidecar item(P2/P2a 契约的 Rust 读时载体)。
/// 这里不进入 ReadOnlyBase,只供 synthesize/context 等读时路径消费。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TechnicalLearningDiscourseIndex {
    pub items: Vec<TechnicalLearningDiscourseItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TechnicalLearningDiscourseItem {
    pub lid: String,
    pub mode: String,
    pub local_function: Option<String>,
    pub rhetorical_move: Option<String>,
    pub local_summary: Option<String>,
    #[serde(default)]
    pub relations: Vec<TechnicalLearningDiscourseRelation>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TechnicalLearningDiscourseRelation {
    pub target_lid: String,
    #[serde(rename = "type")]
    pub relation_type: String,
    pub family: Option<String>,
    pub direction: String,
    pub confidence: f32,
    #[serde(default)]
    pub evidence_lids: Vec<String>,
}
/// context 默认 top-K(占位,待 P1 实测回填 ADR-0013/0016「何时回头」)。
pub const DEFAULT_NEAR_K: usize = 10;

/// 统一错误信封(子集)`[ADR-0015]`;禁宽松降级——找不到即报错,不静默返最近邻。
#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ToolError {
    pub error_code: String,
    pub category: String,
    pub message: String,
}

/// book.manifest 树节点(确定性拓扑)`[ADR-0014]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ManifestNode {
    pub lid: String,
    pub children: Vec<String>,
    pub span: Span,
    pub kind: NodeKind,
}

/// 每 LID 的确定性统计。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct LidStats {
    pub child_count: usize,
    pub leaf_count: usize,
    pub anchored_nodes: usize,
}

/// book.manifest() 返回结构(符 V3 §4.1)。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Manifest {
    pub tree: Vec<ManifestNode>,
    pub stats_by_lid: HashMap<String, LidStats>,
}

/// context item 的确定性接入来源 + 排序键(判别联合)`[ADR-0014]`。
/// P1 覆盖 Tree / Concept(mid 二跳) / Edge(local 与 long_range 召回路标);
/// P2a 覆盖 technical_learning discourse sidecar 投影 `[ADR-0033]`。
#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum Via {
    Tree {
        rel: String,
    },
    Concept {
        name: String,
        shared_count: usize,
    },
    Edge {
        scope: String,
        #[serde(rename = "type")]
        edge_type: String,
        weight: f32,
        direction: String,
    },
    Discourse {
        source_lid: String,
        target_lid: String,
        #[serde(rename = "type")]
        relation_type: String,
        family: Option<String>,
        direction: String,
        confidence: f32,
        evidence_lids: Vec<String>,
    },
}

/// book.context 的一个指针项(纯坐标,不带原文)`[ADR-0014]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ContextItem {
    pub lid: String,
    pub layer: String,
    pub via: Via,
}

/// book.context() 返回结构(符 V3 §4.1)。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Context {
    pub anchor: String,
    pub items: Vec<ContextItem>,
}

/// book.concept() 返回结构(全量 occurrences 不截断)`[ADR-0014]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Concept {
    pub name: String,
    pub occurrences: Vec<String>,
    pub related_entities: Vec<String>,
}

impl Book {
    /// 从书目录(含 base.json + source.txt)加载。
    pub fn load(dir: &str) -> Result<Book, String> {
        let base_s = std::fs::read_to_string(format!("{dir}/base.json"))
            .map_err(|e| format!("读 base.json 失败: {e}"))?;
        let base: ReadOnlyBase =
            serde_json::from_str(&base_s).map_err(|e| format!("解析 base.json 失败: {e}"))?;
        let source = std::fs::read_to_string(format!("{dir}/source.txt"))
            .map_err(|e| format!("读 source.txt 失败(原文旁路缺失,book.text 不可用): {e}"))?;
        let formula_semantics_path = format!("{dir}/formula_semantics.json");
        let formula_semantics = match std::fs::read_to_string(&formula_semantics_path) {
            Ok(s) => serde_json::from_str(&s)
                .map_err(|e| format!("解析 formula_semantics.json 失败: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("读 formula_semantics.json 失败: {e}")),
        };
        let discourse_index_path = format!("{dir}/discourse_index.json");
        let discourse_items = match std::fs::read_to_string(&discourse_index_path) {
            Ok(s) => {
                let index: TechnicalLearningDiscourseIndex = serde_json::from_str(&s)
                    .map_err(|e| format!("解析 discourse_index.json 失败: {e}"))?;
                index.items
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("读 discourse_index.json 失败: {e}")),
        };
        Ok(Book::new(base, &source)
            .with_formula_semantics(formula_semantics)
            .with_discourse_items(discourse_items))
    }

    pub fn new(base: ReadOnlyBase, source: &str) -> Book {
        let source_u16: Vec<u16> = source.encode_utf16().collect();
        let lid_idx = base
            .lid_nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.lid.clone(), i))
            .collect();
        let node_idx = base
            .graph_nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
        Book {
            base,
            source_u16,
            lid_idx,
            node_idx,
            formula_semantics: Vec::new(),
            discourse_index: Vec::new(),
        }
    }

    pub fn with_formula_semantics(mut self, formula_semantics: Vec<FormulaSemantics>) -> Book {
        self.formula_semantics = formula_semantics;
        self
    }

    pub fn formula_semantics(&self, formula_lid: &str) -> Option<&FormulaSemantics> {
        self.formula_semantics
            .iter()
            .find(|s| s.formula_lid == formula_lid)
    }

    pub fn with_discourse_items(
        mut self,
        discourse_items: Vec<TechnicalLearningDiscourseItem>,
    ) -> Book {
        self.discourse_index = discourse_items;
        self
    }

    pub fn discourse_item(&self, lid: &str) -> Option<&TechnicalLearningDiscourseItem> {
        self.discourse_index.iter().find(|item| item.lid == lid)
    }

    fn node(&self, lid: &str) -> Result<&LidNode, ToolError> {
        self.lid_idx
            .get(lid)
            .map(|&i| &self.base.lid_nodes[i])
            .ok_or_else(|| ToolError {
                error_code: "LID_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("LID 不存在: {lid}"),
            })
    }

    /// book.text(lid, range?):按 LID / LID 区间取真原文 `[ADR-0014]`。
    /// span 是 UTF-16 code unit 下标 `[ADR-0024]` ⇒ 按 UTF-16 切,绝不按 UTF-8 字节直切。
    /// `end_lid = Some(e)` 取 [lid.span.start, e.span.end);None 取单 LID。
    pub fn text(&self, lid: &str, end_lid: Option<&str>) -> Result<String, ToolError> {
        let start = self.node(lid)?.span.start;
        let end = match end_lid {
            Some(e) => self.node(e)?.span.end,
            None => self.node(lid)?.span.end,
        };
        Ok(String::from_utf16_lossy(&self.source_u16[start..end]))
    }

    /// book.manifest():确定性拓扑 + 每 LID 统计(无 LLM、无"推荐路径/认知深度" `[ADR-0014]`)。
    pub fn manifest(&self) -> Manifest {
        // 锚定计数:实体/概念按 occurrences、断言按 source_lid 计到对应 LID。
        let mut anchored: HashMap<&str, usize> = HashMap::new();
        for n in &self.base.graph_nodes {
            match n.node_type {
                GraphNodeType::Claim => {
                    if let Some(l) = &n.source_lid {
                        *anchored.entry(l.as_str()).or_default() += 1;
                    }
                }
                _ => {
                    for l in &n.occurrences {
                        *anchored.entry(l.as_str()).or_default() += 1;
                    }
                }
            }
        }
        let tree = self
            .base
            .lid_nodes
            .iter()
            .map(|n| ManifestNode {
                lid: n.lid.clone(),
                children: n.children.clone(),
                span: n.span.clone(),
                kind: n.kind.clone(),
            })
            .collect();
        let stats_by_lid = self
            .base
            .lid_nodes
            .iter()
            .map(|n| {
                let prefix = format!("{}.", n.lid);
                let leaf_count = self
                    .base
                    .lid_nodes
                    .iter()
                    .filter(|d| {
                        (d.lid == n.lid || d.lid.starts_with(&prefix)) && d.children.is_empty()
                    })
                    .count();
                (
                    n.lid.clone(),
                    LidStats {
                        child_count: n.children.len(),
                        leaf_count,
                        anchored_nodes: *anchored.get(n.lid.as_str()).unwrap_or(&0),
                    },
                )
            })
            .collect();
        Manifest { tree, stats_by_lid }
    }

    fn tree_item(&self, lid: &str, rel: &str) -> ContextItem {
        ContextItem {
            lid: lid.to_string(),
            layer: "near".into(),
            via: Via::Tree { rel: rel.into() },
        }
    }

    /// 锚在某 LID 的图谱节点 id(实体/概念按 occurrences、断言按 source_lid)。
    fn nodes_anchored_at(&self, lid: &str) -> Vec<&str> {
        self.base
            .graph_nodes
            .iter()
            .filter(|n| match n.node_type {
                GraphNodeType::Claim => n.source_lid.as_deref() == Some(lid),
                _ => n.occurrences.iter().any(|l| l == lid),
            })
            .map(|n| n.id.as_str())
            .collect()
    }

    /// 某图谱节点锚定的 LID(实体/概念=occurrences、断言=source_lid)。
    fn lids_of_node(&self, id: &str) -> Vec<&str> {
        match self.node_idx.get(id) {
            Some(&i) => {
                let n = &self.base.graph_nodes[i];
                match n.node_type {
                    GraphNodeType::Claim => n.source_lid.as_deref().into_iter().collect(),
                    _ => n.occurrences.iter().map(|s| s.as_str()).collect(),
                }
            }
            None => vec![],
        }
    }

    fn edge_item(&self, lid: &str, layer: &str, e: &base_schema::GraphEdge) -> ContextItem {
        ContextItem {
            lid: lid.to_string(),
            layer: layer.into(),
            via: Via::Edge {
                scope: match &e.scope {
                    EdgeScope::Local => "local",
                    EdgeScope::LongRange => "long_range",
                }
                .into(),
                edge_type: e.edge_type.clone(),
                weight: e.weight,
                direction: match e.direction {
                    Direction::Directed => "directed",
                    Direction::Undirected => "undirected",
                }
                .into(),
            },
        }
    }

    fn edge_context_items(
        &self,
        lid: &str,
        anchored_ids: &[&str],
        scope: &EdgeScope,
        layer: &str,
    ) -> Vec<(f32, ContextItem)> {
        let mut out = Vec::new();
        for e in &self.base.graph_edges {
            if &e.scope != scope {
                continue;
            }
            let src_at = anchored_ids.iter().any(|id| *id == e.source);
            let tgt_at = anchored_ids.iter().any(|id| *id == e.target);
            if src_at == tgt_at {
                continue;
            }
            let other = if src_at { &e.target } else { &e.source };
            for l in self.lids_of_node(other) {
                if l != lid {
                    out.push((e.weight, self.edge_item(l, layer, e)));
                }
            }
        }
        out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        out
    }

    fn discourse_layer(&self, source_lid: &str, target_lid: &str) -> &'static str {
        if parent_lid(source_lid) == parent_lid(target_lid) {
            "near"
        } else {
            "far"
        }
    }

    fn discourse_relation_valid(&self, r: &TechnicalLearningDiscourseRelation) -> bool {
        self.lid_idx.contains_key(&r.target_lid)
            && r.evidence_lids
                .iter()
                .all(|evidence| self.lid_idx.contains_key(evidence))
    }

    fn discourse_context_items(&self, anchor_lid: &str) -> Vec<(f32, ContextItem)> {
        let mut out = Vec::new();
        for item in &self.discourse_index {
            if !self.lid_idx.contains_key(&item.lid) {
                continue;
            }
            for r in &item.relations {
                if !self.discourse_relation_valid(r) {
                    continue;
                }
                let other_lid = if item.lid == anchor_lid {
                    r.target_lid.as_str()
                } else if r.target_lid == anchor_lid {
                    item.lid.as_str()
                } else {
                    continue;
                };
                if other_lid == anchor_lid {
                    continue;
                }
                let layer = self.discourse_layer(&item.lid, &r.target_lid);
                out.push((
                    r.confidence,
                    ContextItem {
                        lid: other_lid.to_string(),
                        layer: layer.into(),
                        via: Via::Discourse {
                            source_lid: item.lid.clone(),
                            target_lid: r.target_lid.clone(),
                            relation_type: r.relation_type.clone(),
                            family: r.family.clone(),
                            direction: r.direction.clone(),
                            confidence: r.confidence,
                            evidence_lids: r.evidence_lids.clone(),
                        },
                    },
                ));
            }
        }
        out.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.lid.cmp(&b.1.lid))
        });
        out
    }
    /// book.context(lid, granularity=near|mid|far, k?):纯指针 `[ADR-0013/0014/0033]`。
    /// near = 树邻接 + local 边; mid = near + anchor 概念/实体其他 occurrences;
    /// far = near + mid + long_range 边。items 不带原文,消费方走 book.text 取。
    pub fn context(
        &self,
        lid: &str,
        granularity: Option<&str>,
        k: Option<usize>,
    ) -> Result<Context, ToolError> {
        let anchor = self.node(lid)?;
        let granularity = granularity.unwrap_or("near");
        if !matches!(granularity, "near" | "mid" | "far") {
            return Err(ToolError {
                error_code: "INVALID_GRANULARITY".into(),
                category: "validation".into(),
                message: format!("book.context granularity 不支持: {granularity}"),
            });
        }

        let mut items: Vec<ContextItem> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let push = |it: ContextItem,
                    items: &mut Vec<ContextItem>,
                    seen: &mut std::collections::HashSet<String>| {
            let key = context_item_key(&it);
            if seen.insert(key) {
                items.push(it);
            }
        };

        if let Some(p) = parent_lid(lid) {
            if let Some(&pi) = self.lid_idx.get(&p) {
                push(self.tree_item(&p, "parent"), &mut items, &mut seen);
                let sibs = &self.base.lid_nodes[pi].children;
                if let Some(pos) = sibs.iter().position(|c| c == lid) {
                    if pos > 0 {
                        push(
                            self.tree_item(&sibs[pos - 1], "prev_sibling"),
                            &mut items,
                            &mut seen,
                        );
                    }
                    if pos + 1 < sibs.len() {
                        push(
                            self.tree_item(&sibs[pos + 1], "next_sibling"),
                            &mut items,
                            &mut seen,
                        );
                    }
                }
            }
        }
        for c in &anchor.children {
            push(self.tree_item(c, "child"), &mut items, &mut seen);
        }

        let anchored_ids = self.nodes_anchored_at(lid);
        for (_, it) in self.edge_context_items(lid, &anchored_ids, &EdgeScope::Local, "near") {
            push(it, &mut items, &mut seen);
        }
        for (_, it) in self.discourse_context_items(lid) {
            if it.layer == "near" {
                push(it, &mut items, &mut seen);
            }
        }

        if matches!(granularity, "mid" | "far") {
            let mut mid: Vec<ContextItem> = Vec::new();
            for id in &anchored_ids {
                if let Some(&i) = self.node_idx.get(*id) {
                    let n = &self.base.graph_nodes[i];
                    if matches!(n.node_type, GraphNodeType::Entity | GraphNodeType::Concept) {
                        for l in &n.occurrences {
                            if l != lid {
                                mid.push(ContextItem {
                                    lid: l.clone(),
                                    layer: "mid".into(),
                                    via: Via::Concept {
                                        name: n.name.clone(),
                                        shared_count: 1,
                                    },
                                });
                            }
                        }
                    }
                }
            }
            mid.sort_by(|a, b| a.lid.cmp(&b.lid));
            for it in mid {
                push(it, &mut items, &mut seen);
            }
        }

        if granularity == "far" {
            for (_, it) in self.edge_context_items(lid, &anchored_ids, &EdgeScope::LongRange, "far")
            {
                push(it, &mut items, &mut seen);
            }
            for (_, it) in self.discourse_context_items(lid) {
                if it.layer == "far" {
                    push(it, &mut items, &mut seen);
                }
            }
        }

        items.truncate(k.unwrap_or(DEFAULT_NEAR_K));
        Ok(Context {
            anchor: lid.to_string(),
            items,
        })
    }

    /// Backward-compatible near wrapper used by older call sites.
    pub fn context_near(&self, lid: &str, k: Option<usize>) -> Result<Context, ToolError> {
        self.context(lid, Some("near"), k)
    }
    /// book.concept(name):按名找 concept/entity 节点,返全量 occurrences + 关联实体 `[ADR-0014]`。
    /// 找不到 → CONCEPT_NOT_FOUND(不静默降级 `[ADR-0015]`)。
    pub fn concept(&self, name: &str) -> Result<Concept, ToolError> {
        let n = self
            .base
            .graph_nodes
            .iter()
            .find(|n| {
                matches!(n.node_type, GraphNodeType::Concept | GraphNodeType::Entity)
                    && n.name == name
            })
            .ok_or_else(|| ToolError {
                error_code: "CONCEPT_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("概念/实体不存在: {name}"),
            })?;
        let mut related: Vec<String> = Vec::new();
        for e in &self.base.graph_edges {
            let other = if e.source == n.id {
                Some(&e.target)
            } else if e.target == n.id {
                Some(&e.source)
            } else {
                None
            };
            if let Some(o) = other {
                if let Some(&i) = self.node_idx.get(o) {
                    let on = &self.base.graph_nodes[i];
                    if matches!(on.node_type, GraphNodeType::Entity) && !related.contains(&on.name)
                    {
                        related.push(on.name.clone());
                    }
                }
            }
        }
        Ok(Concept {
            name: n.name.clone(),
            occurrences: n.occurrences.clone(),
            related_entities: related,
        })
    }
}

/// 物化路径父 LID:"11.18.4" → Some("11.18");"1" → None。
fn parent_lid(lid: &str) -> Option<String> {
    lid.rfind('.').map(|i| lid[..i].to_string())
}

fn context_item_key(it: &ContextItem) -> String {
    match &it.via {
        Via::Tree { rel } => format!("{}|tree|{rel}", it.lid),
        Via::Concept { name, .. } => format!("{}|concept|{name}", it.lid),
        Via::Edge {
            scope,
            edge_type,
            direction,
            ..
        } => format!("{}|edge|{scope}|{edge_type}|{direction}", it.lid),
        Via::Discourse {
            source_lid,
            target_lid,
            relation_type,
            direction,
            ..
        } => format!(
            "{}|discourse|{}|{}|{}|{}",
            it.lid, source_lid, target_lid, relation_type, direction
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{
        sample_base, Direction, EdgeScope, FormulaComposition, FormulaParameter, FormulaSemantics,
        GraphEdge, GraphNode, GraphNodeType, LidNode, NodeKind, ReadOnlyBase, Span,
    };

    fn book_with_far_edge() -> Book {
        let src = "A".repeat(10) + &"B".repeat(10) + &"C".repeat(10) + &"D".repeat(10);
        let base = ReadOnlyBase {
            book_id: "far-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 20 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 10 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 10, end: 20 },
                    children: vec![],
                },
                LidNode {
                    lid: "2".into(),
                    path: vec![2],
                    kind: NodeKind::Chapter,
                    span: Span { start: 20, end: 40 },
                    children: vec!["2.1".into(), "2.2".into()],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 20, end: 30 },
                    children: vec![],
                },
                LidNode {
                    lid: "2.2".into(),
                    path: vec![2, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 30, end: 40 },
                    children: vec![],
                },
            ],
            graph_nodes: vec![
                GraphNode {
                    id: "entity:a".into(),
                    node_type: GraphNodeType::Entity,
                    name: "A".into(),
                    occurrences: vec!["1.1".into(), "1.2".into(), "2.2".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:b".into(),
                    node_type: GraphNodeType::Entity,
                    name: "B".into(),
                    occurrences: vec!["2.1".into()],
                    source_lid: None,
                },
            ],
            graph_edges: vec![GraphEdge {
                source: "entity:a".into(),
                target: "entity:b".into(),
                edge_type: "builds_on".into(),
                direction: Direction::Directed,
                scope: EdgeScope::LongRange,
                weight: 0.9,
            }],
        };
        Book::new(base, &src)
    }
    fn book() -> Book {
        // sample_base: lid "1"(span 0..100,容器)+ "1.1"(span 0..100,叶);entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    fn book_with_discourse_projection() -> Book {
        let source = "AAAABBBBCCCCDDDDEEEE";
        let base = ReadOnlyBase {
            book_id: "discourse-projection-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 12 },
                    children: vec!["1.1".into(), "1.2".into(), "1.3".into()],
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
                    lid: "1.3".into(),
                    path: vec![1, 3],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 8, end: 12 },
                    children: vec![],
                },
                LidNode {
                    lid: "2".into(),
                    path: vec![2],
                    kind: NodeKind::Chapter,
                    span: Span { start: 12, end: 20 },
                    children: vec!["2.1".into(), "2.2".into()],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 12, end: 16 },
                    children: vec![],
                },
                LidNode {
                    lid: "2.2".into(),
                    path: vec![2, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 16, end: 20 },
                    children: vec![],
                },
            ],
            graph_nodes: vec![],
            graph_edges: vec![],
        };
        Book::new(base, source).with_discourse_items(vec![TechnicalLearningDiscourseItem {
            lid: "1.1".into(),
            mode: "informative".into(),
            local_function: Some("definition".into()),
            rhetorical_move: Some("main_point".into()),
            local_summary: Some("定义核心概念".into()),
            relations: vec![
                TechnicalLearningDiscourseRelation {
                    target_lid: "1.3".into(),
                    relation_type: "elaborates".into(),
                    family: Some("expansion".into()),
                    direction: "forward".into(),
                    confidence: 0.9,
                    evidence_lids: vec!["1.1".into(), "1.3".into()],
                },
                TechnicalLearningDiscourseRelation {
                    target_lid: "2.1".into(),
                    relation_type: "depends_on".into(),
                    family: None,
                    direction: "forward".into(),
                    confidence: 0.8,
                    evidence_lids: vec!["1.1".into(), "2.1".into()],
                },
                TechnicalLearningDiscourseRelation {
                    target_lid: "9.9".into(),
                    relation_type: "supports".into(),
                    family: None,
                    direction: "forward".into(),
                    confidence: 0.7,
                    evidence_lids: vec!["1.1".into(), "9.9".into()],
                },
            ],
        }])
    }
    fn formula_semantics() -> FormulaSemantics {
        FormulaSemantics {
            formula_lid: "1.1".into(),
            parameters: vec![FormulaParameter {
                symbol: "x".into(),
                label: None,
                meaning: "输入变量".into(),
                unit: None,
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "1.1".into(),
                meaning: "线性关系".into(),
                terms: vec!["x".into()],
                evidence_lids: vec!["1.1".into()],
            },
            context_links: vec![],
        }
    }
    #[test]
    fn load_reads_optional_discourse_index_sidecar() {
        let dir = std::env::temp_dir().join("ub-read-tools-discourse-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let base = sample_base();
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "X".repeat(100)).unwrap();
        let index = TechnicalLearningDiscourseIndex {
            items: vec![TechnicalLearningDiscourseItem {
                lid: "1.1".into(),
                mode: "informative".into(),
                local_function: Some("definition".into()),
                rhetorical_move: None,
                local_summary: Some("定义命令模式".into()),
                relations: vec![],
            }],
        };
        std::fs::write(
            dir.join("discourse_index.json"),
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert_eq!(
            book.discourse_item("1.1").unwrap().local_summary.as_deref(),
            Some("定义命令模式")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn load_reads_optional_formula_semantics_sidecar() {
        let dir = std::env::temp_dir().join("ub-read-tools-formula-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut base = sample_base();
        base.lid_nodes[1].kind = NodeKind::Formula;
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "X".repeat(100)).unwrap();
        std::fs::write(
            dir.join("formula_semantics.json"),
            serde_json::to_string(&vec![formula_semantics()]).unwrap(),
        )
        .unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert_eq!(
            book.formula_semantics("1.1").unwrap().composition.meaning,
            "线性关系"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn text_by_single_lid() {
        let b = book();
        assert_eq!(b.text("1.1", None).unwrap(), "X".repeat(100));
    }

    #[test]
    fn text_missing_lid_errors_not_silent() {
        let b = book();
        let e = b.text("9.9", None).unwrap_err();
        assert_eq!(e.error_code, "LID_NOT_FOUND");
        assert_eq!(e.category, "not_found");
    }

    #[test]
    fn manifest_stats_correct() {
        let b = book();
        let m = b.manifest();
        assert_eq!(m.tree.len(), 2);
        assert!(m
            .tree
            .iter()
            .any(|n| n.lid == "1.1" && n.kind == NodeKind::Paragraph));
        let s1 = &m.stats_by_lid["1"];
        assert_eq!(s1.child_count, 1);
        assert_eq!(s1.leaf_count, 1); // 仅 1.1 是叶
        assert_eq!(s1.anchored_nodes, 0); // 锚定都落在 1.1,不在容器 1
        let s11 = &m.stats_by_lid["1.1"];
        assert_eq!(s11.anchored_nodes, 2); // entity:command(occ 含 1.1)+ claim(source 1.1)
    }

    #[test]
    fn context_near_tree_adjacency() {
        let b = book();
        let ctx = b.context_near("1.1", Some(10)).unwrap();
        assert_eq!(ctx.anchor, "1.1");
        // 1.1 的树邻接含 parent "1";sample 里 claim→entity 边两端都锚 1.1(同 anchor),不产 edge item
        assert!(ctx
            .items
            .iter()
            .any(|i| i.lid == "1" && matches!(i.via, Via::Tree { .. })));
        assert!(ctx.items.iter().all(|i| i.layer == "near"));
    }

    #[test]
    fn context_near_missing_lid_errors() {
        let b = book();
        assert_eq!(
            b.context_near("9.9", None).unwrap_err().error_code,
            "LID_NOT_FOUND"
        );
    }

    #[test]
    fn context_far_accumulates_near_mid_and_long_range() {
        let b = book_with_far_edge();
        let ctx = b.context("1.1", Some("far"), Some(10)).unwrap();
        assert!(ctx.items.iter().any(|i| i.lid == "1" && i.layer == "near"));
        assert!(ctx
            .items
            .iter()
            .any(|i| i.lid == "2.2" && i.layer == "mid" && matches!(i.via, Via::Concept { .. })));
        assert!(ctx.items.iter().any(|i| i.lid == "2.1"
            && i.layer == "far"
            && matches!(i.via, Via::Edge { ref scope, .. } if scope == "long_range")));
    }

    #[test]
    fn context_projects_discourse_relations_to_near_and_far() {
        let b = book_with_discourse_projection();
        let near = b.context("1.1", Some("near"), Some(20)).unwrap();
        assert!(near.items.iter().any(|i| i.lid == "1.3"
            && i.layer == "near"
            && matches!(i.via, Via::Discourse { ref relation_type, ref target_lid, .. }
                if relation_type == "elaborates" && target_lid == "1.3")));
        assert!(!near
            .items
            .iter()
            .any(|i| i.lid == "2.1" && matches!(i.via, Via::Discourse { .. })));
        assert!(!near.items.iter().any(|i| i.lid == "9.9"));

        let far = b.context("1.1", Some("far"), Some(20)).unwrap();
        assert!(far.items.iter().any(|i| i.lid == "2.1"
            && i.layer == "far"
            && matches!(i.via, Via::Discourse { ref relation_type, ref target_lid, .. }
                if relation_type == "depends_on" && target_lid == "2.1")));
    }
    #[test]
    fn context_rejects_unknown_granularity() {
        let b = book();
        let err = b.context("1.1", Some("wide"), None).unwrap_err();
        assert_eq!(err.error_code, "INVALID_GRANULARITY");
        assert_eq!(err.category, "validation");
    }
    #[test]
    fn concept_found_and_missing() {
        let b = book();
        let c = b.concept("command").unwrap();
        assert_eq!(c.occurrences, vec!["1.1".to_string()]);
        assert_eq!(
            b.concept("不存在").unwrap_err().error_code,
            "CONCEPT_NOT_FOUND"
        );
    }
}
