//! 读时确定性叶子工具(切片0:manifest/text;context/concept 见 S4c)`[ADR-0014]`。
//! 消费冻结只读基座 `base.json` + 旁路原文 `source.txt`(UTF-16 span 口径 `[ADR-0024]`)。
//! 纯函数库,无 LLM、provider 无关;HTTP 暴露推 S7。
use base_schema::{Direction, EdgeScope, GraphNodeType, LidNode, ReadOnlyBase, Span};
use serde::Serialize;
use std::collections::HashMap;

/// 加载后的书:基座 + 原文(UTF-16 code unit 序列,span 即此口径 `[ADR-0024]`)+ lid 索引。
pub struct Book {
    pub base: ReadOnlyBase,
    source_u16: Vec<u16>,
    lid_idx: HashMap<String, usize>,
    node_idx: HashMap<String, usize>,
}

/// near 档默认 top-K(占位,S4d 实测回填 ADR-0013/0014「何时回头」)。
pub const DEFAULT_NEAR_K: usize = 10;

/// 统一错误信封(子集)`[ADR-0015]`;禁宽松降级——找不到即报错,不静默返最近邻。
#[derive(Debug, Serialize, PartialEq)]
pub struct ToolError {
    pub error_code: String,
    pub category: String,
    pub message: String,
}

/// book.manifest 树节点(确定性拓扑)`[ADR-0014]`。
#[derive(Debug, Serialize)]
pub struct ManifestNode {
    pub lid: String,
    pub children: Vec<String>,
    pub span: Span,
}

/// 每 LID 的确定性统计。
#[derive(Debug, Serialize)]
pub struct LidStats {
    pub child_count: usize,
    pub leaf_count: usize,
    pub anchored_nodes: usize,
}

/// book.manifest() 返回结构(符 V3 §4.1)。
#[derive(Debug, Serialize)]
pub struct Manifest {
    pub tree: Vec<ManifestNode>,
    pub stats_by_lid: HashMap<String, LidStats>,
}

/// context item 的确定性接入来源 + 排序键(判别联合)`[ADR-0014]`。
/// 切片0 near 档只产 Tree / Edge;Concept(经概念二跳)留 mid 档(切片1+)。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Via {
    Tree {
        rel: String,
    },
    Edge {
        scope: String,
        #[serde(rename = "type")]
        edge_type: String,
        weight: f32,
        direction: String,
    },
}

/// book.context 的一个指针项(纯坐标,不带原文)`[ADR-0014]`。
#[derive(Debug, Serialize)]
pub struct ContextItem {
    pub lid: String,
    pub layer: String,
    pub via: Via,
}

/// book.context() 返回结构(符 V3 §4.1)。
#[derive(Debug, Serialize)]
pub struct Context {
    pub anchor: String,
    pub items: Vec<ContextItem>,
}

/// book.concept() 返回结构(全量 occurrences 不截断)`[ADR-0014]`。
#[derive(Debug, Serialize)]
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
        Ok(Book::new(base, &source))
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
        }
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

    /// book.context(lid, granularity=near, k?):纯指针 `[ADR-0013/0014]`。
    /// 切片0 只做 **near** 档 = 树邻接(parent/child/prev·next sibling)+ scope=local 边;
    /// mid(概念二跳)/ far(long_range 边)留切片1+。items 不带原文,消费方走 book.text 取。
    /// 排序:树邻接(距离最近)保序在前,local 边按 weight 降序;同 LID 去重;top-K 截断。
    pub fn context_near(&self, lid: &str, k: Option<usize>) -> Result<Context, ToolError> {
        let anchor = self.node(lid)?;
        let mut tree_items: Vec<ContextItem> = Vec::new();
        if let Some(p) = parent_lid(lid) {
            if let Some(&pi) = self.lid_idx.get(&p) {
                tree_items.push(self.tree_item(&p, "parent"));
                let sibs = &self.base.lid_nodes[pi].children;
                if let Some(pos) = sibs.iter().position(|c| c == lid) {
                    if pos > 0 {
                        tree_items.push(self.tree_item(&sibs[pos - 1], "prev_sibling"));
                    }
                    if pos + 1 < sibs.len() {
                        tree_items.push(self.tree_item(&sibs[pos + 1], "next_sibling"));
                    }
                }
            }
        }
        for c in &anchor.children {
            tree_items.push(self.tree_item(c, "child"));
        }
        // scope=local 边:经锚在 lid 的图谱节点跳到对端节点的 LID
        let anchored_ids = self.nodes_anchored_at(lid);
        let mut edge_items: Vec<(f32, ContextItem)> = Vec::new();
        for e in &self.base.graph_edges {
            if !matches!(e.scope, EdgeScope::Local) {
                continue;
            }
            let src_at = anchored_ids.iter().any(|id| *id == e.source);
            let tgt_at = anchored_ids.iter().any(|id| *id == e.target);
            if src_at == tgt_at {
                continue; // 恰一端锚在 anchor 才是向外的召回路标
            }
            let other = if src_at { &e.target } else { &e.source };
            for l in self.lids_of_node(other) {
                if l != lid {
                    edge_items.push((
                        e.weight,
                        ContextItem {
                            lid: l.to_string(),
                            layer: "near".into(),
                            via: Via::Edge {
                                scope: "local".into(),
                                edge_type: e.edge_type.clone(),
                                weight: e.weight,
                                direction: match e.direction {
                                    Direction::Directed => "directed",
                                    Direction::Undirected => "undirected",
                                }
                                .into(),
                            },
                        },
                    ));
                }
            }
        }
        edge_items.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut seen = std::collections::HashSet::new();
        let mut items: Vec<ContextItem> = Vec::new();
        for it in tree_items
            .into_iter()
            .chain(edge_items.into_iter().map(|(_, it)| it))
        {
            if seen.insert(it.lid.clone()) {
                items.push(it);
            }
        }
        items.truncate(k.unwrap_or(DEFAULT_NEAR_K));
        Ok(Context {
            anchor: lid.to_string(),
            items,
        })
    }

    /// book.concept(name):按名找 concept/entity 节点,返全量 occurrences + 关联实体 `[ADR-0014]`。
    /// 找不到 → CONCEPT_NOT_FOUND(不静默降级 `[ADR-0015]`)。
    pub fn concept(&self, name: &str) -> Result<Concept, ToolError> {
        let n = self
            .base
            .graph_nodes
            .iter()
            .find(|n| {
                matches!(
                    n.node_type,
                    GraphNodeType::Concept | GraphNodeType::Entity
                ) && n.name == name
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
                    if matches!(on.node_type, GraphNodeType::Entity) && !related.contains(&on.name) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::sample_base;

    fn book() -> Book {
        // sample_base: lid "1"(span 0..100,容器)+ "1.1"(span 0..100,叶);entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
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
