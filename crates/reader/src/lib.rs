//! 命令优先阅读器 headless core `[ADR-0007/0015]`:`reader.*` 闭环四动作。
//! 命令优先(headless core + thin UI):人类每个动作都是命令,E 与外部 agent 走同一命令面,GUI=渲染层。
//! 变更命令**返 effect**(非裸 ack);`note/highlight` **委托 memory.save**、渲染读 `memory.recall` 画标注
//! —— 标注**单一真相源 = 记忆层**(防双所有者不一致 `[ADR-0006/0015]`)。
//! viewport = **叶序滑动窗口**(anchor 所在叶为中心,按全书叶 LID 顺序取前后 radius 个;scroll 沿叶序移动)。
//! 切片0 不做 openPanel/closePanel 面板系统、真 GUI、段内字符 range(停 LID 粒度)。
//! 时间戳由调用方注入(确定性可测,守 A2);错误复用 `ToolError` 信封,禁宽松降级 `[ADR-0015]`。
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput, TextRange};
use read_tools::{Book, ToolError};
use serde::Serialize;

/// 叶序滑动窗口半径(占位,实测回填 V3 §4.2「何时回头」):窗口 = anchor ± radius,最多 2*radius+1 叶。
pub const DEFAULT_RADIUS: usize = 3;

/// 视口(符 V3 §4.2 `{anchor_lid, visible_lids}`)。headless 下 = 叶序滑动窗口。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Viewport {
    pub anchor_lid: String,
    pub visible_lids: Vec<String>,
}

/// gotoLid / scroll 的 effect:变更后视口(非裸 ack `[ADR-0015]`)。
#[derive(Debug, Clone, Serialize)]
pub struct ViewportEffect {
    pub ok: bool,
    pub viewport: Viewport,
}

/// highlight 的 effect:记忆层 id 即 highlight_id(标注单源=memory `[ADR-0015]`)。
#[derive(Debug, Clone, Serialize)]
pub struct HighlightEffect {
    pub ok: bool,
    pub highlight_id: String,
}

/// note 的 effect:记忆层 id 即 note_id。
#[derive(Debug, Clone, Serialize)]
pub struct NoteEffect {
    pub ok: bool,
    pub note_id: String,
}

/// reader.state() 只读会话态(供 agent 中途接入 / 人手动操作后 re-sync `[ADR-0015]`)。
#[derive(Debug, Clone, Serialize)]
pub struct ReaderState {
    pub viewport: Viewport,
    pub open_panels: Vec<String>,
    pub selection: Option<String>,
}

/// 命令优先阅读器(headless,有状态会话态)。不拥有 Book/MemoryStore(调用方注入),
/// 标注不归 reader 持有(归记忆层),reader 只持视口/选区会话态。
pub struct Reader {
    /// 全书叶 LID,按物化路径序(lid_nodes 已是排序数组 `[ADR-0008]`)。
    leaf_lids: Vec<String>,
    /// 当前锚点在 leaf_lids 的下标。
    anchor_idx: usize,
    /// 滑动窗口半径。
    radius: usize,
    /// 当前选区(最近 goto/note/highlight 的目标 LID)。
    selection: Option<String>,
}

impl Reader {
    /// 建阅读器:算叶序、锚点落书首(idx 0)。
    pub fn new(book: &Book, radius: usize) -> Reader {
        let leaf_lids = book
            .base
            .lid_nodes
            .iter()
            .filter(|n| n.children.is_empty())
            .map(|n| n.lid.clone())
            .collect();
        Reader {
            leaf_lids,
            anchor_idx: 0,
            radius,
            selection: None,
        }
    }

    /// 当前视口 = 叶序滑动窗口(anchor ± radius,边界 saturating)。
    pub fn viewport(&self) -> Viewport {
        if self.leaf_lids.is_empty() {
            return Viewport {
                anchor_lid: String::new(),
                visible_lids: Vec::new(),
            };
        }
        let lo = self.anchor_idx.saturating_sub(self.radius);
        let hi = (self.anchor_idx + self.radius + 1).min(self.leaf_lids.len());
        Viewport {
            anchor_lid: self.leaf_lids[self.anchor_idx].clone(),
            visible_lids: self.leaf_lids[lo..hi].to_vec(),
        }
    }

    /// `reader.gotoLid(lid)`:翻到某 LID。叶 → 锚到该叶;容器 → 锚到子树第一个叶;
    /// 不存在 → `LID_NOT_FOUND`(禁宽松降级,不静默返最近邻 `[ADR-0015]`)。
    pub fn goto_lid(&mut self, book: &Book, lid: &str) -> Result<ViewportEffect, ToolError> {
        // 校验 LID 真实存在(锚定红线:不存在即报错)。
        if !book.base.lid_nodes.iter().any(|n| n.lid == lid) {
            return Err(lid_not_found(lid));
        }
        // 定位叶:lid 本身是叶则用它,否则取子树(前缀 "{lid}.")第一个叶。
        let prefix = format!("{lid}.");
        let idx = self
            .leaf_lids
            .iter()
            .position(|l| l == lid)
            .or_else(|| self.leaf_lids.iter().position(|l| l.starts_with(&prefix)));
        match idx {
            Some(i) => {
                self.anchor_idx = i;
                self.selection = Some(lid.to_string());
                Ok(ViewportEffect {
                    ok: true,
                    viewport: self.viewport(),
                })
            }
            // lid 存在但其子树无叶(分区不变式下不应发生)——诚实报内部错,不静默。
            None => Err(ToolError {
                error_code: "INTERNAL_ERROR".into(),
                category: "internal".into(),
                message: format!("LID {lid} 存在但定位不到叶子"),
            }),
        }
    }

    /// `reader.scroll(delta)`:沿叶序移动锚点(clamp 到 [0, len-1]),返变更后视口。
    pub fn scroll(&mut self, delta: i64) -> ViewportEffect {
        if !self.leaf_lids.is_empty() {
            let last = (self.leaf_lids.len() - 1) as i64;
            let next = (self.anchor_idx as i64 + delta).clamp(0, last);
            self.anchor_idx = next as usize;
            self.selection = Some(self.leaf_lids[self.anchor_idx].clone());
        }
        ViewportEffect {
            ok: true,
            viewport: self.viewport(),
        }
    }

    /// `reader.highlight(lid, range?)`:薄入口,持久化**委托 memory.save**(type=highlight)。
    /// `range=Some(s,e)`:段内自由高亮——按 **UTF-16 偏移**切该段子串作 content + 存 range `[ADR-0031]`;
    /// 越界 → `INVALID_RANGE` 不降级。`range=None`:整段高亮(向后兼容 / agent 走此路)。
    /// 返回的 highlight_id = 记忆层 mem_id;`layer`:人默认 `long_term`、agent 提议态 `session` `[ADR-0030]`。
    pub fn highlight(
        &mut self,
        book: &Book,
        store: &mut MemoryStore,
        lid: &str,
        range: Option<(u32, u32)>,
        layer: &str,
        now: &str,
    ) -> Result<HighlightEffect, ToolError> {
        let full = book.text(lid, None)?; // LID 不存在 → ToolError 透传,不降级
        let (frag, range_rec) = match range {
            Some((s, e)) => {
                // 段内 UTF-16 code unit 切片(与前端 DOM 选区偏移 / JS string.slice 同口径 `[ADR-0024/0031]`)。
                let units: Vec<u16> = full.encode_utf16().collect();
                let (su, eu) = (s as usize, e as usize);
                if su > eu || eu > units.len() {
                    return Err(ToolError {
                        error_code: "INVALID_RANGE".into(),
                        category: "validation".into(),
                        message: format!("高亮区间越界: [{s},{e}) 超出该段 {} 个 UTF-16 单位", units.len()),
                    });
                }
                (String::from_utf16_lossy(&units[su..eu]), Some(TextRange { start: s, end: e }))
            }
            None => (full, None),
        };
        let saved = store.save(
            SaveInput {
                mem_id: None,
                mem_type: "highlight".into(),
                layer: layer.into(),
                book_id: book.base.book_id.clone(),
                anchor: Anchor {
                    lid: Some(lid.to_string()),
                    concept: None,
                },
                content: frag,
                range: range_rec,
                citations: None, // memory 自动派生锚回 lid 的 citation
                source_session_id: None,
            },
            now,
        )?;
        self.selection = Some(lid.to_string());
        Ok(HighlightEffect {
            ok: true,
            highlight_id: saved.mem_id,
        })
    }

    /// `reader.note(lid, text)`:薄入口,持久化**委托 memory.save**(type=note,content=text)。
    /// 返回的 note_id = 记忆层 mem_id(标注单源=记忆层)。
    /// `layer`:人默认 `long_term`、agent 提议态传 `session`(同 highlight `[ADR-0030]`)。
    pub fn note(
        &mut self,
        book: &Book,
        store: &mut MemoryStore,
        lid: &str,
        text: &str,
        layer: &str,
        now: &str,
    ) -> Result<NoteEffect, ToolError> {
        book.text(lid, None)?; // 仅校验 LID 真实存在(锚定红线),不取原文
        let saved = store.save(
            SaveInput {
                mem_id: None,
                mem_type: "note".into(),
                layer: layer.into(),
                book_id: book.base.book_id.clone(),
                anchor: Anchor {
                    lid: Some(lid.to_string()),
                    concept: None,
                },
                content: text.to_string(),
                range: None,
                citations: None,
                source_session_id: None,
            },
            now,
        )?;
        self.selection = Some(lid.to_string());
        Ok(NoteEffect {
            ok: true,
            note_id: saved.mem_id,
        })
    }

    /// `reader.state()`:只读会话态(viewport + 空面板集 + 选区)。
    pub fn state(&self) -> ReaderState {
        ReaderState {
            viewport: self.viewport(),
            open_panels: Vec::new(),
            selection: self.selection.clone(),
        }
    }

    /// headless 文本渲染:逐 visible_lid 拼原文,**读 memory.recall(lid) 画标注**
    /// —— 标注从记忆层来(单一真相源),非 reader 自持。锚点叶前缀 `▶`。
    pub fn render(&self, book: &Book, store: &MemoryStore) -> String {
        let vp = self.viewport();
        let mut out = String::new();
        for lid in &vp.visible_lids {
            let marker = if *lid == vp.anchor_lid { "▶" } else { " " };
            let text = book.text(lid, None).unwrap_or_default();
            out.push_str(&format!("[{lid}]{marker} {text}\n"));
            let anns = store.recall(&RecallQuery {
                book_id: Some(book.base.book_id.clone()),
                lid: Some(lid.clone()),
                ..Default::default()
            });
            for a in &anns {
                match a.mem_type.as_str() {
                    "note" => out.push_str(&format!("    📝 {}\n", a.content)),
                    "highlight" => out.push_str("    🖍 (highlighted)\n"),
                    _ => {}
                }
            }
        }
        out
    }
}

fn lid_not_found(lid: &str) -> ToolError {
    ToolError {
        error_code: "LID_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("LID 不存在: {lid}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{
        GraphEdge, GraphNode, LidNode, NodeKind, ReadOnlyBase, Span,
    };
    use std::path::PathBuf;

    /// 造 n 个叶的书:容器 "1" 下挂 "1.1".."1.n",每叶 10 字符原文。
    fn book_n_leaves(n: usize) -> Book {
        let mut lid_nodes = vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Chapter,
            span: Span { start: 0, end: n * 10 },
            children: (1..=n).map(|i| format!("1.{i}")).collect(),
        }];
        for i in 1..=n {
            lid_nodes.push(LidNode {
                lid: format!("1.{i}"),
                path: vec![1, i as u32],
                kind: NodeKind::Paragraph,
                span: Span { start: (i - 1) * 10, end: i * 10 },
                children: vec![],
            });
        }
        let source = "X".repeat(n * 10);
        Book::new(
            ReadOnlyBase {
                book_id: "bookR".into(),
                lid_nodes,
                graph_nodes: Vec::<GraphNode>::new(),
                graph_edges: Vec::<GraphEdge>::new(),
            },
            &source,
        )
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-reader-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    // new:锚点落书首叶;viewport 叶序窗口 anchor ± radius,书首左侧 saturating。
    #[test]
    fn new_anchors_first_leaf_and_window() {
        let b = book_n_leaves(10);
        let r = Reader::new(&b, 3);
        let vp = r.viewport();
        assert_eq!(vp.anchor_lid, "1.1");
        // anchor idx 0,左 saturate,右取 3 → [1.1,1.2,1.3,1.4]
        assert_eq!(vp.visible_lids, vec!["1.1", "1.2", "1.3", "1.4"]);
    }

    // scroll:沿叶序移动锚点,两端 clamp。
    #[test]
    fn scroll_moves_anchor_clamped() {
        let b = book_n_leaves(10);
        let mut r = Reader::new(&b, 2);
        assert_eq!(r.scroll(5).viewport.anchor_lid, "1.6");
        // 居中窗口:1.6 ± 2 → [1.4..1.8]
        assert_eq!(r.viewport().visible_lids, vec!["1.4", "1.5", "1.6", "1.7", "1.8"]);
        assert_eq!(r.scroll(100).viewport.anchor_lid, "1.10"); // clamp 到末叶
        assert_eq!(r.scroll(-100).viewport.anchor_lid, "1.1"); // clamp 到首叶
    }

    // goto 叶:锚到该叶 + 选区设为该 lid。
    #[test]
    fn goto_leaf_anchors_and_selects() {
        let b = book_n_leaves(10);
        let mut r = Reader::new(&b, 1);
        let eff = r.goto_lid(&b, "1.5").unwrap();
        assert!(eff.ok);
        assert_eq!(eff.viewport.anchor_lid, "1.5");
        assert_eq!(eff.viewport.visible_lids, vec!["1.4", "1.5", "1.6"]);
        assert_eq!(r.state().selection.as_deref(), Some("1.5"));
    }

    // goto 容器:锚到子树第一个叶(翻到"第1章"=章首)。
    #[test]
    fn goto_container_lands_first_leaf() {
        let b = book_n_leaves(10);
        let mut r = Reader::new(&b, 1);
        r.scroll(5); // 先移开
        let eff = r.goto_lid(&b, "1").unwrap();
        assert_eq!(eff.viewport.anchor_lid, "1.1");
        assert_eq!(r.state().selection.as_deref(), Some("1")); // 选区记容器 lid
    }

    // goto 不存在的 LID:LID_NOT_FOUND,禁宽松降级(不静默返最近邻)。
    #[test]
    fn goto_missing_lid_errors_not_silent() {
        let b = book_n_leaves(5);
        let mut r = Reader::new(&b, 2);
        let e = r.goto_lid(&b, "9.9").unwrap_err();
        assert_eq!(e.error_code, "LID_NOT_FOUND");
        assert_eq!(e.category, "not_found");
    }

    // note 委托 memory.save:返回 note_id=mem_id,记录真落记忆层、citation 自动锚回 lid。
    #[test]
    fn note_delegates_to_memory_single_source() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("note")).unwrap();
        let mut r = Reader::new(&b, 2);
        let eff = r.note(&b, &mut store, "1.2", "命令=对象化调用", "long_term", "t0").unwrap();
        assert!(eff.ok);
        // 标注单源=记忆层:recall 查得到,content/citation 对
        let got = store.recall(&RecallQuery {
            lid: Some("1.2".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].mem_id, eff.note_id);
        assert_eq!(got[0].mem_type, "note");
        assert_eq!(got[0].content, "命令=对象化调用");
        assert_eq!(got[0].citations[0].lid, "1.2"); // 可验证 LID citation
    }

    // highlight 委托 memory.save:content = 该叶原文片段。
    #[test]
    fn highlight_delegates_with_original_text() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("hl")).unwrap();
        let mut r = Reader::new(&b, 2);
        let eff = r.highlight(&b, &mut store, "1.3", None, "long_term", "t0").unwrap();
        let got = store.recall(&RecallQuery {
            lid: Some("1.3".into()),
            mem_type: Some("highlight".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].mem_id, eff.highlight_id);
        assert_eq!(got[0].content, "X".repeat(10)); // 整段高亮:1.3 全文
        assert!(got[0].range.is_none());
    }

    // 段内自由高亮:range=Some 按 UTF-16 切子串作 content + 存 range;越界 → INVALID_RANGE `[ADR-0031]`。
    #[test]
    fn highlight_range_slices_substring_and_rejects_oob() {
        let b = book_n_leaves(5); // 每叶 10 个 'X'
        let mut store = MemoryStore::open(tmp("hlrange")).unwrap();
        let mut r = Reader::new(&b, 2);
        let eff = r.highlight(&b, &mut store, "1.2", Some((2, 5)), "long_term", "t0").unwrap();
        let got = store.recall(&RecallQuery { lid: Some("1.2".into()), ..Default::default() });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].mem_id, eff.highlight_id);
        assert_eq!(got[0].content, "XXX"); // [2,5) = 3 个字符
        assert_eq!(got[0].range, Some(memory::TextRange { start: 2, end: 5 }));
        // 越界:end 超过段长(10)→ INVALID_RANGE 不降级。
        let e = r.highlight(&b, &mut store, "1.2", Some((8, 99)), "long_term", "t0").unwrap_err();
        assert_eq!(e.error_code, "INVALID_RANGE");
    }

    // highlight 不存在的 LID:经 book.text 透传 LID_NOT_FOUND(不降级)。
    #[test]
    fn highlight_missing_lid_errors() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("hlmiss")).unwrap();
        let mut r = Reader::new(&b, 2);
        let e = r.highlight(&b, &mut store, "9.9", None, "long_term", "t0").unwrap_err();
        assert_eq!(e.error_code, "LID_NOT_FOUND");
    }

    // render 读 memory.recall 画标注:note 后渲染含原文 + 笔记内容 + 锚点标记。
    #[test]
    fn render_reads_recall_annotations() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("render")).unwrap();
        let mut r = Reader::new(&b, 2);
        r.goto_lid(&b, "1.2").unwrap();
        r.note(&b, &mut store, "1.2", "我的笔记", "long_term", "t0").unwrap();
        let out = r.render(&b, &store);
        assert!(out.contains("[1.2]▶")); // 锚点标记
        assert!(out.contains("我的笔记")); // 标注从记忆层读出
    }

    // 标注单一真相源 = 记忆层:换一个全新 Reader 实例对同一 store render,仍看得到标注
    // ⇒ 标注归记忆层、不归某个 reader 会话实例。
    #[test]
    fn annotation_belongs_to_memory_not_reader_instance() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("single-source")).unwrap();
        {
            let mut r1 = Reader::new(&b, 2);
            r1.note(&b, &mut store, "1.1", "跨实例可见", "long_term", "t0").unwrap();
        }
        let r2 = Reader::new(&b, 2); // 全新实例,无任何 note 记录
        let out = r2.render(&b, &store);
        assert!(out.contains("跨实例可见"));
    }
}
