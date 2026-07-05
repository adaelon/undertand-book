//! 命令优先阅读器 headless core `[ADR-0007/0015]`:`reader.*` 闭环四动作。
//! 命令优先(headless core + thin UI):人类每个动作都是命令,E 与外部 agent 走同一命令面,GUI=渲染层。
//! 变更命令**返 effect**(非裸 ack);`note/highlight` **委托 memory.save**、渲染读 `memory.recall` 画标注
//! —— 标注**单一真相源 = 记忆层**(防双所有者不一致 `[ADR-0006/0015]`)。
//! viewport = **叶序滑动窗口**(anchor 所在叶为中心,按全书叶 LID 顺序取前后 radius 个;scroll 沿叶序移动)。
//! 切片0 不做 openPanel/closePanel 面板系统、真 GUI、段内字符 range(停 LID 粒度)。
//! 时间戳由调用方注入(确定性可测,守 A2);错误复用 `ToolError` 信封,禁宽松降级 `[ADR-0015]`。
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput, TextRange};
use read_tools::{
    Book, LayoutRegion, LayoutSize, PinnedEvidence, ProfileManifest, ReaderLayoutAction,
    ReaderLayoutActionKind, ReaderLayoutApplyOutcome, ReaderLayoutEffect, ReaderLayoutProposal,
    ReaderLayoutState, ToolError,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// 叶序滑动窗口半径(占位,实测回填 V3 §4.2「何时回头」):窗口 = anchor ± radius,最多 2*radius+1 叶。
pub const DEFAULT_WIDTH: usize = 20;
pub const DEFAULT_RADIUS: usize = DEFAULT_WIDTH;

/// 视口(符 V3 §4.2 `{anchor_lid, visible_lids}`)。headless 下 = 叶序滑动窗口。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Viewport {
    pub anchor_lid: String,
    pub top_lid: String,
    pub bottom_lid: String,
    pub width: usize,
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
    pub layout: ReaderLayoutState,
}

/// 命令优先阅读器(headless,有状态会话态)。不拥有 Book/MemoryStore(调用方注入),
/// 标注不归 reader 持有(归记忆层),reader 只持视口/选区会话态。
pub struct Reader {
    /// 全书叶 LID,按物化路径序(lid_nodes 已是排序数组 `[ADR-0008]`)。
    leaf_lids: Vec<String>,
    /// 当前锚点在 leaf_lids 的下标。
    top_idx: usize,
    /// 滑动窗口半径。
    width: usize,
    /// 当前选区(最近 goto/note/highlight 的目标 LID)。
    selection: Option<String>,
    /// Reader UI Control Plane 会话态 `[ADR-0060]`。
    layout: ReaderLayoutState,
    /// 高风险 layout proposals,绑定 base layout rev,Apply 时复验。
    layout_proposals: HashMap<String, ReaderLayoutProposal>,
    layout_proposal_seq: u64,
}

fn region_key(region: &LayoutRegion) -> String {
    match region {
        LayoutRegion::Left => "left",
        LayoutRegion::Center => "center",
        LayoutRegion::Right => "right",
        LayoutRegion::Bottom => "bottom",
        LayoutRegion::Overlay => "overlay",
    }
    .into()
}

fn action_kind(action: &ReaderLayoutAction) -> ReaderLayoutActionKind {
    match action {
        ReaderLayoutAction::OpenSlot { .. } => ReaderLayoutActionKind::OpenSlot,
        ReaderLayoutAction::CloseSlot { .. } => ReaderLayoutActionKind::CloseSlot,
        ReaderLayoutAction::FocusSlot { .. } => ReaderLayoutActionKind::FocusSlot,
        ReaderLayoutAction::SetActiveTab { .. } => ReaderLayoutActionKind::SetActiveTab,
        ReaderLayoutAction::PinEvidence { .. } => ReaderLayoutActionKind::PinEvidence,
        ReaderLayoutAction::UnpinEvidence { .. } => ReaderLayoutActionKind::UnpinEvidence,
        ReaderLayoutAction::SetPanelSize { .. } => ReaderLayoutActionKind::SetPanelSize,
        ReaderLayoutAction::ReorderSlot { .. } => ReaderLayoutActionKind::ReorderSlot,
        ReaderLayoutAction::SetLayoutPreset { .. } => ReaderLayoutActionKind::SetLayoutPreset,
        ReaderLayoutAction::ResetLayout {} => ReaderLayoutActionKind::ResetLayout,
    }
}

fn is_high_risk(action: &ReaderLayoutAction) -> bool {
    matches!(
        action,
        ReaderLayoutAction::CloseSlot { .. }
            | ReaderLayoutAction::ReorderSlot { .. }
            | ReaderLayoutAction::SetLayoutPreset { .. }
            | ReaderLayoutAction::ResetLayout {}
    )
}

fn layout_error(code: &str, category: &str, message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: code.into(),
        category: category.into(),
        message: message.into(),
    }
}

fn manifest_slot<'a>(
    manifest: &'a ProfileManifest,
    slot_id: &str,
) -> Result<&'a read_tools::UiSlotSpec, ToolError> {
    manifest
        .ui_slots
        .iter()
        .find(|slot| slot.id == slot_id)
        .ok_or_else(|| {
            layout_error(
                "LAYOUT_SLOT_NOT_FOUND",
                "validation",
                format!("layout slot 不存在: {slot_id}"),
            )
        })
}

fn validate_size(size: &LayoutSize) -> Result<(), ToolError> {
    if !size.value.is_finite() || size.value <= 0.0 {
        return Err(layout_error(
            "INVALID_LAYOUT_SIZE",
            "validation",
            "layout size 必须是正数",
        ));
    }
    let ok = match size.kind {
        read_tools::LayoutSizeKind::Percent => size.value <= 100.0,
        read_tools::LayoutSizeKind::Fr => size.value <= 12.0,
        read_tools::LayoutSizeKind::Px => size.value <= 4096.0,
    };
    if ok {
        Ok(())
    } else {
        Err(layout_error(
            "INVALID_LAYOUT_SIZE",
            "validation",
            "layout size 超出允许范围",
        ))
    }
}

fn default_layout_state(manifest: &ProfileManifest) -> ReaderLayoutState {
    layout_from_preset(manifest, manifest.defaults.layout_preset.as_deref()).unwrap_or_else(|| {
        let mut slot_order: HashMap<String, Vec<String>> = HashMap::new();
        for slot_id in &manifest.defaults.open_slots {
            if let Some(slot) = manifest.ui_slots.iter().find(|slot| &slot.id == slot_id) {
                slot_order
                    .entry(region_key(&slot.default_region))
                    .or_default()
                    .push(slot.id.clone());
            }
        }
        ReaderLayoutState {
            rev: 0,
            active_preset: manifest.defaults.layout_preset.clone(),
            open_slots: manifest.defaults.open_slots.clone(),
            focused_slot: manifest.defaults.focused_slot.clone(),
            pinned_evidence: Vec::new(),
            panel_sizes: HashMap::new(),
            slot_order,
        }
    })
}

fn layout_from_preset(
    manifest: &ProfileManifest,
    preset_id: Option<&str>,
) -> Option<ReaderLayoutState> {
    let preset_id = preset_id?;
    let preset = manifest.layout_presets.iter().find(|p| p.id == preset_id)?;
    let mut slots = preset.slots.clone();
    slots.sort_by_key(|slot| slot.order);
    let mut open_slots = Vec::new();
    let mut panel_sizes = HashMap::new();
    let mut slot_order: HashMap<String, Vec<String>> = HashMap::new();
    for slot in slots {
        open_slots.push(slot.slot_id.clone());
        if let Some(size) = slot.size {
            panel_sizes.insert(slot.slot_id.clone(), size);
        }
        slot_order
            .entry(region_key(&slot.region))
            .or_default()
            .push(slot.slot_id);
    }
    Some(ReaderLayoutState {
        rev: 0,
        active_preset: Some(preset_id.into()),
        open_slots,
        focused_slot: preset.focused_slot.clone(),
        pinned_evidence: Vec::new(),
        panel_sizes,
        slot_order,
    })
}

fn is_slot_open(state: &ReaderLayoutState, slot_id: &str) -> bool {
    state.open_slots.iter().any(|s| s == slot_id)
}

fn require_slot_open(state: &ReaderLayoutState, slot_id: &str) -> Result<(), ToolError> {
    if is_slot_open(state, slot_id) {
        Ok(())
    } else {
        Err(layout_error(
            "LAYOUT_SLOT_NOT_OPEN",
            "validation",
            format!("layout slot 未打开: {slot_id}"),
        ))
    }
}

fn remove_slot_from_order(state: &mut ReaderLayoutState, slot_id: &str) {
    for slots in state.slot_order.values_mut() {
        slots.retain(|id| id != slot_id);
    }
}

fn move_slot_to_region(state: &mut ReaderLayoutState, slot_id: &str, region: &LayoutRegion) {
    remove_slot_from_order(state, slot_id);
    state
        .slot_order
        .entry(region_key(region))
        .or_default()
        .push(slot_id.into());
}

fn validate_layout_action_allowed(
    manifest: &ProfileManifest,
    action: &ReaderLayoutAction,
    allow_high_risk: bool,
) -> Result<(), ToolError> {
    let kind = action_kind(action);
    if !manifest.allowed_layout_actions.contains(&kind) {
        return Err(layout_error(
            "INVALID_LAYOUT_ACTION",
            "validation",
            format!("profile 不允许 layout action: {kind:?}"),
        ));
    }
    if is_high_risk(action) && !allow_high_risk {
        return Err(layout_error(
            "LAYOUT_ACTION_REQUIRES_PROPOSAL",
            "validation",
            "高风险 layout action 需要 proposal 确认",
        ));
    }
    Ok(())
}

fn apply_layout_action_to_state(
    book: &Book,
    manifest: &ProfileManifest,
    state: &mut ReaderLayoutState,
    action: &ReaderLayoutAction,
) -> Result<(), ToolError> {
    match action {
        ReaderLayoutAction::OpenSlot { slot_id, region } => {
            let slot = manifest_slot(manifest, slot_id)?;
            if !is_slot_open(state, slot_id) {
                state.open_slots.push(slot_id.clone());
            }
            move_slot_to_region(
                state,
                slot_id,
                region.as_ref().unwrap_or(&slot.default_region),
            );
        }
        ReaderLayoutAction::CloseSlot { slot_id } => {
            manifest_slot(manifest, slot_id)?;
            state.open_slots.retain(|id| id != slot_id);
            if state.focused_slot.as_deref() == Some(slot_id) {
                state.focused_slot = None;
            }
            state.panel_sizes.remove(slot_id);
            remove_slot_from_order(state, slot_id);
            state.pinned_evidence.retain(|pin| pin.slot_id != *slot_id);
        }
        ReaderLayoutAction::FocusSlot { slot_id } => {
            manifest_slot(manifest, slot_id)?;
            require_slot_open(state, slot_id)?;
            state.focused_slot = Some(slot_id.clone());
        }
        ReaderLayoutAction::SetActiveTab { slot_id, tab_id } => {
            manifest_slot(manifest, slot_id)?;
            require_slot_open(state, slot_id)?;
            if tab_id.trim().is_empty() {
                return Err(layout_error(
                    "INVALID_LAYOUT_ACTION",
                    "validation",
                    "set_active_tab 需非空 tab_id",
                ));
            }
        }
        ReaderLayoutAction::PinEvidence {
            slot_id,
            lid,
            reason,
        } => {
            manifest_slot(manifest, slot_id)?;
            require_slot_open(state, slot_id)?;
            if !book.base.lid_nodes.iter().any(|node| node.lid == *lid) {
                return Err(layout_error(
                    "LID_NOT_FOUND",
                    "not_found",
                    format!("LID 不存在: {lid}"),
                ));
            }
            if !state
                .pinned_evidence
                .iter()
                .any(|pin| pin.slot_id == *slot_id && pin.lid == *lid)
            {
                state.pinned_evidence.push(PinnedEvidence {
                    slot_id: slot_id.clone(),
                    lid: lid.clone(),
                    reason: reason.clone(),
                });
            }
        }
        ReaderLayoutAction::UnpinEvidence { slot_id, lid } => {
            manifest_slot(manifest, slot_id)?;
            state
                .pinned_evidence
                .retain(|pin| !(pin.slot_id == *slot_id && pin.lid == *lid));
        }
        ReaderLayoutAction::SetPanelSize { slot_id, size } => {
            manifest_slot(manifest, slot_id)?;
            require_slot_open(state, slot_id)?;
            validate_size(size)?;
            state.panel_sizes.insert(slot_id.clone(), size.clone());
        }
        ReaderLayoutAction::ReorderSlot { region, slot_ids } => {
            let mut seen = HashSet::new();
            for slot_id in slot_ids {
                manifest_slot(manifest, slot_id)?;
                require_slot_open(state, slot_id)?;
                if !seen.insert(slot_id) {
                    return Err(layout_error(
                        "INVALID_LAYOUT_ACTION",
                        "validation",
                        format!("reorder_slot 包含重复 slot: {slot_id}"),
                    ));
                }
            }
            for slot_id in slot_ids {
                remove_slot_from_order(state, slot_id);
            }
            state
                .slot_order
                .insert(region_key(region), slot_ids.clone());
        }
        ReaderLayoutAction::SetLayoutPreset { preset_id } => {
            let mut next = layout_from_preset(manifest, Some(preset_id)).ok_or_else(|| {
                layout_error(
                    "LAYOUT_PRESET_NOT_FOUND",
                    "validation",
                    format!("layout preset 不存在: {preset_id}"),
                )
            })?;
            let old_rev = state.rev;
            let open: HashSet<String> = next.open_slots.iter().cloned().collect();
            next.pinned_evidence = state
                .pinned_evidence
                .iter()
                .filter(|pin| open.contains(&pin.slot_id))
                .cloned()
                .collect();
            next.rev = old_rev;
            *state = next;
        }
        ReaderLayoutAction::ResetLayout {} => {
            let old_rev = state.rev;
            let mut next = default_layout_state(manifest);
            next.rev = old_rev;
            *state = next;
        }
    }
    Ok(())
}

impl Reader {
    /// 建阅读器:算叶序、锚点落书首(idx 0)。
    pub fn new(book: &Book, width: usize) -> Reader {
        let leaf_lids = book
            .base
            .lid_nodes
            .iter()
            .filter(|n| n.children.is_empty())
            .map(|n| n.lid.clone())
            .collect();
        Reader {
            leaf_lids,
            top_idx: 0,
            width: width.max(1),
            selection: None,
            layout: default_layout_state(&book.profile_manifest()),
            layout_proposals: HashMap::new(),
            layout_proposal_seq: 0,
        }
    }

    /// 当前视口 = 叶序滑动窗口(anchor ± radius,边界 saturating)。
    pub fn viewport(&self) -> Viewport {
        if self.leaf_lids.is_empty() {
            return Viewport {
                anchor_lid: String::new(),
                top_lid: String::new(),
                bottom_lid: String::new(),
                width: self.width,
                visible_lids: Vec::new(),
            };
        }
        let lo = self.top_idx.min(self.leaf_lids.len() - 1);
        let hi = (lo + self.width).min(self.leaf_lids.len());
        let anchor_idx = lo + (hi - lo - 1) / 2;
        Viewport {
            anchor_lid: self.leaf_lids[anchor_idx].clone(),
            top_lid: self.leaf_lids[lo].clone(),
            bottom_lid: self.leaf_lids[hi - 1].clone(),
            width: self.width,
            visible_lids: self.leaf_lids[lo..hi].to_vec(),
        }
    }

    fn max_top_idx(&self) -> usize {
        self.leaf_lids.len().saturating_sub(self.width)
    }

    fn mark_visible_read(
        &self,
        book: &Book,
        store: &mut MemoryStore,
        now: &str,
    ) -> Result<(), ToolError> {
        for lid in &self.viewport().visible_lids {
            store.mark_read(&book.base.book_id, lid, now)?;
        }
        Ok(())
    }

    /// 持久化恢复:把 top_idx 设到目标 lid(必须存在于 leaf_lids),不做已读记账。
    /// 供 server 启动时从 session.json 恢复阅读位置。lid 不存在则静默忽略(书可能变了)。
    pub fn restore_top_lid(&mut self, _book: &Book, lid: &str) {
        if let Some(i) = self.leaf_lids.iter().position(|l| l == lid) {
            self.top_idx = i.min(self.max_top_idx());
        }
    }
    /// `reader.gotoLid(lid)`:翻到某 LID。叶 → 锚到该叶;容器 → 锚到子树第一个叶;
    /// 不存在 → `LID_NOT_FOUND`(禁宽松降级,不静默返最近邻 `[ADR-0015]`)。
    pub fn goto_lid(
        &mut self,
        book: &Book,
        store: &mut MemoryStore,
        lid: &str,
        now: &str,
    ) -> Result<ViewportEffect, ToolError> {
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
                self.top_idx = i.min(self.max_top_idx());
                self.selection = Some(lid.to_string());
                self.mark_visible_read(book, store, now)?;
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
    /// 落点 anchor 记入已读账本 `[ADR-0038]`;记账=持久写 ⇒ 返 `Result`(失败诚实传播,不静默降级)。
    pub fn scroll(
        &mut self,
        book: &Book,
        store: &mut MemoryStore,
        delta: i64,
        now: &str,
    ) -> Result<ViewportEffect, ToolError> {
        if !self.leaf_lids.is_empty() {
            let last = self.max_top_idx() as i64;
            let next = (self.top_idx as i64 + delta).clamp(0, last);
            self.top_idx = next as usize;
            self.selection = Some(self.leaf_lids[self.top_idx].clone());
            self.mark_visible_read(book, store, now)?;
        }
        Ok(ViewportEffect {
            ok: true,
            viewport: self.viewport(),
        })
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
        source_session_id: Option<String>,
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
                        message: format!(
                            "高亮区间越界: [{s},{e}) 超出该段 {} 个 UTF-16 单位",
                            units.len()
                        ),
                    });
                }
                (
                    String::from_utf16_lossy(&units[su..eu]),
                    Some(TextRange { start: s, end: e }),
                )
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
                source_session_id,
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
            layout: self.layout.clone(),
        }
    }

    pub fn layout_state(&self) -> ReaderLayoutState {
        self.layout.clone()
    }

    fn validate_layout_actions(
        &self,
        book: &Book,
        manifest: &ProfileManifest,
        state: &ReaderLayoutState,
        actions: &[ReaderLayoutAction],
        allow_high_risk: bool,
    ) -> Result<(), ToolError> {
        let mut scratch = state.clone();
        for action in actions {
            validate_layout_action_allowed(manifest, action, allow_high_risk)?;
            apply_layout_action_to_state(book, manifest, &mut scratch, action)?;
        }
        Ok(())
    }

    fn reduce_layout_actions(
        &mut self,
        book: &Book,
        actions: Vec<ReaderLayoutAction>,
        allow_high_risk: bool,
    ) -> Result<ReaderLayoutEffect, ToolError> {
        let manifest = book.profile_manifest();
        self.validate_layout_actions(book, &manifest, &self.layout, &actions, allow_high_risk)?;
        let before = self.layout.clone();
        let mut after = before.clone();
        for action in &actions {
            apply_layout_action_to_state(book, &manifest, &mut after, action)?;
        }
        after.rev = before.rev + 1;
        self.layout = after.clone();
        Ok(ReaderLayoutEffect {
            before,
            after,
            actions,
        })
    }

    pub fn apply_layout_actions(
        &mut self,
        book: &Book,
        actions: Vec<ReaderLayoutAction>,
    ) -> Result<ReaderLayoutApplyOutcome, ToolError> {
        if actions.is_empty() {
            return Err(layout_error(
                "INVALID_LAYOUT_ACTION",
                "validation",
                "reader.layout.apply 需至少一个 action",
            ));
        }
        let manifest = book.profile_manifest();
        self.validate_layout_actions(book, &manifest, &self.layout, &actions, true)?;
        if actions.iter().any(is_high_risk) {
            self.layout_proposal_seq += 1;
            let proposal = ReaderLayoutProposal {
                proposal_id: format!(
                    "layout_proposal_{}_{}",
                    self.layout.rev, self.layout_proposal_seq
                ),
                base_layout_rev: self.layout.rev,
                actions,
                summary: "High-risk layout change requires confirmation.".into(),
            };
            self.layout_proposals
                .insert(proposal.proposal_id.clone(), proposal.clone());
            return Ok(ReaderLayoutApplyOutcome::Proposal { proposal });
        }
        let effect = self.reduce_layout_actions(book, actions, false)?;
        Ok(ReaderLayoutApplyOutcome::Effect { effect })
    }

    pub fn apply_layout_proposal(
        &mut self,
        book: &Book,
        proposal_id: &str,
        base_layout_rev: u64,
    ) -> Result<ReaderLayoutEffect, ToolError> {
        let proposal = self
            .layout_proposals
            .get(proposal_id)
            .cloned()
            .ok_or_else(|| {
                layout_error(
                    "LAYOUT_PROPOSAL_NOT_FOUND",
                    "not_found",
                    format!("layout proposal 不存在: {proposal_id}"),
                )
            })?;
        if proposal.base_layout_rev != base_layout_rev
            || self.layout.rev != proposal.base_layout_rev
        {
            return Err(layout_error(
                "LAYOUT_PROPOSAL_STALE",
                "validation",
                format!(
                    "layout proposal 已过期: base={} current={}",
                    proposal.base_layout_rev, self.layout.rev
                ),
            ));
        }
        let effect = self.reduce_layout_actions(book, proposal.actions.clone(), true)?;
        self.layout_proposals.remove(proposal_id);
        Ok(effect)
    }

    pub fn undo_layout_effect(
        &mut self,
        effect: &ReaderLayoutEffect,
    ) -> Result<ReaderLayoutEffect, ToolError> {
        if self.layout.rev != effect.after.rev {
            return Err(layout_error(
                "LAYOUT_UNDO_STALE",
                "validation",
                format!(
                    "layout undo 已过期: expected current rev {}, got {}",
                    effect.after.rev, self.layout.rev
                ),
            ));
        }
        let before = self.layout.clone();
        let mut restored = effect.before.clone();
        restored.rev = before.rev + 1;
        self.layout = restored.clone();
        Ok(ReaderLayoutEffect {
            before,
            after: restored,
            actions: Vec::new(),
        })
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
    use base_schema::{GraphEdge, GraphNode, LidNode, NodeKind, ReadOnlyBase, Span};
    use std::path::PathBuf;

    /// 造 n 个叶的书:容器 "1" 下挂 "1.1".."1.n",每叶 10 字符原文。
    fn book_n_leaves(n: usize) -> Book {
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
        assert_eq!(vp.top_lid, "1.1");
        assert_eq!(vp.bottom_lid, "1.3");
        assert_eq!(vp.anchor_lid, "1.2");
        assert_eq!(vp.width, 3);
        assert_eq!(vp.visible_lids, vec!["1.1", "1.2", "1.3"]);
    }

    // scroll:沿叶序移动锚点,两端 clamp。
    #[test]
    fn scroll_moves_anchor_clamped() {
        let b = book_n_leaves(10);
        let mut store = MemoryStore::open(tmp("scroll")).unwrap();
        let mut r = Reader::new(&b, 3);
        let moved = r.scroll(&b, &mut store, 5, "t0").unwrap().viewport;
        assert_eq!(moved.top_lid, "1.6");
        assert_eq!(moved.anchor_lid, "1.7");
        assert_eq!(moved.bottom_lid, "1.8");
        assert_eq!(moved.visible_lids, vec!["1.6", "1.7", "1.8"]);
        let end = r.scroll(&b, &mut store, 100, "t1").unwrap().viewport;
        assert_eq!(end.top_lid, "1.8");
        assert_eq!(end.bottom_lid, "1.10");
        let start = r.scroll(&b, &mut store, -100, "t2").unwrap().viewport;
        assert_eq!(start.top_lid, "1.1");
        assert_eq!(start.bottom_lid, "1.3");
    }

    // goto 叶:锚到该叶 + 选区设为该 lid。
    #[test]
    fn goto_leaf_anchors_and_selects() {
        let b = book_n_leaves(10);
        let mut store = MemoryStore::open(tmp("gotoleaf")).unwrap();
        let mut r = Reader::new(&b, 1);
        let eff = r.goto_lid(&b, &mut store, "1.5", "t0").unwrap();
        assert!(eff.ok);
        assert_eq!(eff.viewport.top_lid, "1.5");
        assert_eq!(eff.viewport.anchor_lid, "1.5");
        assert_eq!(eff.viewport.bottom_lid, "1.5");
        assert_eq!(eff.viewport.visible_lids, vec!["1.5"]);
        assert_eq!(r.state().selection.as_deref(), Some("1.5"));
    }

    // goto 容器:锚到子树第一个叶(翻到"第1章"=章首)。
    #[test]
    fn goto_container_lands_first_leaf() {
        let b = book_n_leaves(10);
        let mut store = MemoryStore::open(tmp("gotocontainer")).unwrap();
        let mut r = Reader::new(&b, 1);
        r.scroll(&b, &mut store, 5, "t0").unwrap(); // 先移开
        let eff = r.goto_lid(&b, &mut store, "1", "t1").unwrap();
        assert_eq!(eff.viewport.top_lid, "1.1");
        assert_eq!(eff.viewport.anchor_lid, "1.1");
        assert_eq!(r.state().selection.as_deref(), Some("1")); // 选区记容器 lid
    }

    // goto 不存在的 LID:LID_NOT_FOUND,禁宽松降级(不静默返最近邻)。
    #[test]
    fn goto_missing_lid_errors_not_silent() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("gotomiss")).unwrap();
        let mut r = Reader::new(&b, 2);
        let e = r.goto_lid(&b, &mut store, "9.9", "t0").unwrap_err();
        assert_eq!(e.error_code, "LID_NOT_FOUND");
        assert_eq!(e.category, "not_found");
    }

    // note 委托 memory.save:返回 note_id=mem_id,记录真落记忆层、citation 自动锚回 lid。
    #[test]
    fn note_delegates_to_memory_single_source() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("note")).unwrap();
        let mut r = Reader::new(&b, 2);
        let eff = r
            .note(&b, &mut store, "1.2", "命令=对象化调用", "long_term", "t0")
            .unwrap();
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
        let eff = r
            .highlight(&b, &mut store, "1.3", None, None, "long_term", "t0")
            .unwrap();
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
        let eff = r
            .highlight(&b, &mut store, "1.2", Some((2, 5)), None, "long_term", "t0")
            .unwrap();
        let got = store.recall(&RecallQuery {
            lid: Some("1.2".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].mem_id, eff.highlight_id);
        assert_eq!(got[0].content, "XXX"); // [2,5) = 3 个字符
        assert_eq!(got[0].range, Some(memory::TextRange { start: 2, end: 5 }));
        // 越界:end 超过段长(10)→ INVALID_RANGE 不降级。
        let e = r
            .highlight(&b, &mut store, "1.2", Some((8, 99)), None, "long_term", "t0")
            .unwrap_err();
        assert_eq!(e.error_code, "INVALID_RANGE");
    }

    // highlight 不存在的 LID:经 book.text 透传 LID_NOT_FOUND(不降级)。
    #[test]
    fn highlight_missing_lid_errors() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("hlmiss")).unwrap();
        let mut r = Reader::new(&b, 2);
        let e = r
            .highlight(&b, &mut store, "9.9", None, None, "long_term", "t0")
            .unwrap_err();
        assert_eq!(e.error_code, "LID_NOT_FOUND");
    }

    // render 读 memory.recall 画标注:note 后渲染含原文 + 笔记内容 + 锚点标记。
    #[test]
    fn render_reads_recall_annotations() {
        let b = book_n_leaves(5);
        let mut store = MemoryStore::open(tmp("render")).unwrap();
        let mut r = Reader::new(&b, 2);
        r.goto_lid(&b, &mut store, "1.2", "t0").unwrap();
        r.note(&b, &mut store, "1.2", "我的笔记", "long_term", "t0")
            .unwrap();
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
            r1.note(&b, &mut store, "1.1", "跨实例可见", "long_term", "t0")
                .unwrap();
        }
        let r2 = Reader::new(&b, 2); // 全新实例,无任何 note 记录
        let out = r2.render(&b, &store);
        assert!(out.contains("跨实例可见"));
    }

    #[test]
    fn layout_defaults_from_profile_manifest() {
        let b = book_n_leaves(5);
        let r = Reader::new(&b, 2);
        let layout = r.layout_state();
        assert_eq!(layout.rev, 0);
        assert_eq!(layout.active_preset.as_deref(), Some("technical_read"));
        assert_eq!(
            layout.open_slots,
            vec!["technical.structure_map", "technical.agent"]
        );
        assert_eq!(layout.focused_slot.as_deref(), Some("technical.agent"));
        assert_eq!(
            layout.slot_order.get("left").unwrap(),
            &vec!["technical.structure_map".to_string()]
        );
        assert_eq!(
            layout.slot_order.get("right").unwrap(),
            &vec!["technical.agent".to_string()]
        );
    }

    #[test]
    fn layout_low_risk_actions_apply_and_undo() {
        let b = book_n_leaves(5);
        let mut r = Reader::new(&b, 2);
        let outcome = r
            .apply_layout_actions(
                &b,
                vec![
                    ReaderLayoutAction::OpenSlot {
                        slot_id: "technical.evidence".into(),
                        region: Some(LayoutRegion::Right),
                    },
                    ReaderLayoutAction::FocusSlot {
                        slot_id: "technical.evidence".into(),
                    },
                    ReaderLayoutAction::SetPanelSize {
                        slot_id: "technical.evidence".into(),
                        size: LayoutSize {
                            kind: read_tools::LayoutSizeKind::Percent,
                            value: 35.0,
                        },
                    },
                    ReaderLayoutAction::PinEvidence {
                        slot_id: "technical.evidence".into(),
                        lid: "1.1".into(),
                        reason: Some("important".into()),
                    },
                ],
            )
            .unwrap();
        let effect = match outcome {
            ReaderLayoutApplyOutcome::Effect { effect } => effect,
            ReaderLayoutApplyOutcome::Proposal { .. } => panic!("expected direct effect"),
        };
        assert_eq!(effect.before.rev, 0);
        assert_eq!(effect.after.rev, 1);
        assert_eq!(
            r.layout_state().focused_slot.as_deref(),
            Some("technical.evidence")
        );
        assert_eq!(r.layout_state().pinned_evidence[0].lid, "1.1");

        let undo = r.undo_layout_effect(&effect).unwrap();
        assert_eq!(undo.before.rev, 1);
        assert_eq!(undo.after.rev, 2);
        assert!(!r
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.evidence"));
        assert!(r.layout_state().pinned_evidence.is_empty());
    }

    #[test]
    fn layout_high_risk_actions_create_proposal_then_apply() {
        let b = book_n_leaves(5);
        let mut r = Reader::new(&b, 2);
        let outcome = r
            .apply_layout_actions(
                &b,
                vec![ReaderLayoutAction::CloseSlot {
                    slot_id: "technical.agent".into(),
                }],
            )
            .unwrap();
        let proposal = match outcome {
            ReaderLayoutApplyOutcome::Proposal { proposal } => proposal,
            ReaderLayoutApplyOutcome::Effect { .. } => panic!("expected proposal"),
        };
        assert_eq!(proposal.base_layout_rev, 0);
        assert!(r
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));

        let effect = r
            .apply_layout_proposal(&b, &proposal.proposal_id, proposal.base_layout_rev)
            .unwrap();
        assert_eq!(effect.before.rev, 0);
        assert_eq!(effect.after.rev, 1);
        assert!(!r
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));
    }

    #[test]
    fn layout_stale_proposal_rejected_after_rev_change() {
        let b = book_n_leaves(5);
        let mut r = Reader::new(&b, 2);
        let proposal = match r
            .apply_layout_actions(
                &b,
                vec![ReaderLayoutAction::CloseSlot {
                    slot_id: "technical.agent".into(),
                }],
            )
            .unwrap()
        {
            ReaderLayoutApplyOutcome::Proposal { proposal } => proposal,
            ReaderLayoutApplyOutcome::Effect { .. } => panic!("expected proposal"),
        };
        r.apply_layout_actions(
            &b,
            vec![ReaderLayoutAction::OpenSlot {
                slot_id: "technical.evidence".into(),
                region: None,
            }],
        )
        .unwrap();
        let err = r
            .apply_layout_proposal(&b, &proposal.proposal_id, proposal.base_layout_rev)
            .unwrap_err();
        assert_eq!(err.error_code, "LAYOUT_PROPOSAL_STALE");
    }

    #[test]
    fn layout_validation_rejects_unknown_slot_and_bad_lid() {
        let b = book_n_leaves(5);
        let mut r = Reader::new(&b, 2);
        let err = r
            .apply_layout_actions(
                &b,
                vec![ReaderLayoutAction::FocusSlot {
                    slot_id: "missing.slot".into(),
                }],
            )
            .unwrap_err();
        assert_eq!(err.error_code, "LAYOUT_SLOT_NOT_FOUND");

        let err = r
            .apply_layout_actions(
                &b,
                vec![ReaderLayoutAction::PinEvidence {
                    slot_id: "technical.agent".into(),
                    lid: "9.9".into(),
                    reason: None,
                }],
            )
            .unwrap_err();
        assert_eq!(err.error_code, "LID_NOT_FOUND");
    }

    // 已读账本接线 `[ADR-0038]`:goto/scroll 落点 anchor 真叶记入已读账本;
    // goto 容器记子树首叶(非传入容器 lid);未翻到的 LID 不在已读集。
    #[test]
    fn goto_scroll_record_read_ledger() {
        let b = book_n_leaves(10);
        let mut store = MemoryStore::open(tmp("ledger")).unwrap();
        let mut r = Reader::new(&b, 3);
        r.goto_lid(&b, &mut store, "1.5", "t0").unwrap(); // 读 1.5
        r.scroll(&b, &mut store, 2, "t1").unwrap(); // 落点 1.7
        r.goto_lid(&b, &mut store, "1", "t2").unwrap(); // 容器 → 记真叶 1.1
        let read = store.read_lids("bookR");
        assert_eq!(
            read,
            vec!["1.5", "1.6", "1.7", "1.9", "1.8", "1.1", "1.3", "1.2"]
        );
        assert!(!read.contains(&"1.10".to_string()));
        assert!(!read.contains(&"1".to_string()));
    }
}
