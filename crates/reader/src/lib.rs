//! 命令优先阅读器 headless core `[ADR-0007/0015]`:`reader.*` 闭环四动作。
//! 命令优先(headless core + thin UI):人类每个动作都是命令,E 与外部 agent 走同一命令面,GUI=渲染层。
//! 变更命令**返 effect**(非裸 ack);`note/highlight` **委托 memory.save**、渲染读 `memory.recall` 画标注
//! —— 标注**单一真相源 = 记忆层**(防双所有者不一致 `[ADR-0006/0015]`)。
//! viewport = **叶序滑动窗口**(anchor 所在叶为中心,按全书叶 LID 顺序取前后 radius 个;scroll 沿叶序移动)。
//! 切片0 不做 openPanel/closePanel 面板系统、真 GUI、段内字符 range(停 LID 粒度)。
//! 时间戳由调用方注入(确定性可测,守 A2);错误复用 `ToolError` 信封,禁宽松降级 `[ADR-0015]`。
use memory::{Anchor, MemoryStore, RecallQuery, SaveInput, TextRange};
use read_tools::{
    Book, LayoutRegion, LayoutSize, PaperArgumentSlot, PaperLandmark, PaperLandmarkKind,
    PaperMinimapAvailabilityStatus, PaperMinimapBase, PaperRegion, PaperRegionKind, PinnedEvidence,
    ProfileManifest, ReaderLayoutAction, ReaderLayoutActionKind, ReaderLayoutApplyOutcome,
    ReaderLayoutEffect, ReaderLayoutProposal, ReaderLayoutState, ToolError,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapMode {
    Skim,
    Abstract,
    Deep,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapActor {
    User,
    Agent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapPresentation {
    Collapsed,
    Expanded,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperViewportPosition {
    pub start_page: u32,
    pub end_page: u32,
    pub center_page: f32,
    pub progress_ratio: f32,
    pub anchor_lid: Option<String>,
    pub region_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMapFocus {
    pub region_id: Option<String>,
    pub landmark_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperLocalProjection {
    pub region_id: String,
    pub grammar: PaperRegionKind,
    pub focus_slots: Vec<PaperArgumentSlot>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperArgumentSlotBinding {
    pub slot: PaperArgumentSlot,
    pub landmark_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperAbstractCorrespondence {
    pub slot: PaperArgumentSlot,
    pub abstract_landmark_id: String,
    pub body_landmark_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapLensProjection {
    pub mode: PaperMinimapMode,
    pub focus_region_id: Option<String>,
    pub global_landmark_ids: Vec<String>,
    pub local_landmark_ids: Vec<String>,
    pub relation_ids: Vec<String>,
    pub slot_bindings: Vec<PaperArgumentSlotBinding>,
    pub abstract_correspondences: Vec<PaperAbstractCorrespondence>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct MinimapOverlay {
    pub emphasized_landmark_ids: Vec<String>,
    pub hidden_landmark_ids: Vec<String>,
    pub pinned_landmark_ids: Vec<String>,
    pub focused_region_id: Option<String>,
    pub focused_landmark_id: Option<String>,
    pub visible_layers: Vec<String>,
    pub local_projection: Option<PaperLocalProjection>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum UserLandmarkKind {
    Important,
    Question,
    Confusing,
    FollowUp,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct UserLandmark {
    pub landmark_id: String,
    pub label: String,
    pub anchor_lid: String,
    pub kind: UserLandmarkKind,
    pub note: Option<String>,
    pub created_from_effect: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum UserLandmarkOverrideOperation {
    Hide,
    Deemphasize,
    Rename,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct UserLandmarkOverride {
    pub target_landmark_id: String,
    pub operation: UserLandmarkOverrideOperation,
    pub label: Option<String>,
    pub user_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapSavedModePreference {
    pub mode: PaperMinimapMode,
    pub visible_layers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SavedUserOverlay {
    pub book_id: String,
    pub book_version: String,
    pub overlay_rev: u64,
    pub emphasized_kinds: Vec<PaperLandmarkKind>,
    pub hidden_landmark_ids: Vec<String>,
    pub pinned_landmark_ids: Vec<String>,
    pub custom_landmarks: Vec<UserLandmark>,
    pub landmark_overrides: Vec<UserLandmarkOverride>,
    pub saved_mode_preferences: Vec<PaperMinimapSavedModePreference>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ReaderPaperMinimapState {
    pub rev: u64,
    pub base_map_rev: String,
    pub presentation: PaperMinimapPresentation,
    pub mode: PaperMinimapMode,
    pub viewport_position: PaperViewportPosition,
    pub selected_lid: Option<String>,
    pub map_focus: Option<PaperMapFocus>,
    pub session_overlay: MinimapOverlay,
    pub saved_user_overlay: SavedUserOverlay,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapAction {
    SetPresentation {
        presentation: PaperMinimapPresentation,
    },
    UpdateViewport {
        position: PaperViewportPosition,
    },
    SetSelectedLid {
        selected_lid: Option<String>,
    },
    FocusRegion {
        region_id: String,
    },
    FocusLandmark {
        landmark_id: String,
    },
    EmphasizeLandmarks {
        landmark_ids: Vec<String>,
        reason: String,
    },
    SelectLocalProjection {
        region_id: String,
        grammar: PaperRegionKind,
        focus_slots: Vec<PaperArgumentSlot>,
    },
    SetLayerVisibility {
        layer: String,
        visible: bool,
    },
    PinLandmark {
        landmark_id: String,
    },
    UnpinLandmark {
        landmark_id: String,
    },
    SetModeLens {
        mode: PaperMinimapMode,
    },
    ClearSessionOverlay {},
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum SavedUserOverlayAction {
    SaveUserLandmark {
        anchor_lid: String,
        label: String,
        user_kind: UserLandmarkKind,
        note: Option<String>,
    },
    RemoveUserLandmark {
        landmark_id: String,
    },
    SetLandmarkOverride {
        target_landmark_id: String,
        operation: UserLandmarkOverrideOperation,
        label: Option<String>,
        user_reason: Option<String>,
    },
    RemoveLandmarkOverride {
        target_landmark_id: String,
    },
    SaveModePreference {
        mode: PaperMinimapMode,
        visible_layers: Vec<String>,
    },
    ClearSavedOverlay {},
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "scope", content = "action", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapCommand {
    Session(PaperMinimapAction),
    Saved(SavedUserOverlayAction),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapEffect {
    pub effect_id: String,
    pub base_map_rev: String,
    pub before_state_rev: u64,
    pub after_state_rev: u64,
    pub trigger_turn_id: Option<String>,
    pub actions: Vec<PaperMinimapCommand>,
    pub reason: String,
    pub evidence_lids: Vec<String>,
    pub created_at: String,
    pub before: ReaderPaperMinimapState,
    pub after: ReaderPaperMinimapState,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapProposal {
    pub proposal_id: String,
    pub base_map_rev: String,
    pub base_state_rev: u64,
    pub actions: Vec<PaperMinimapCommand>,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapApplyOutcome {
    Effect { effect: PaperMinimapEffect },
    Proposal { proposal: PaperMinimapProposal },
    Noop { state: ReaderPaperMinimapState },
}

const MINIMAP_GLOBAL_LANDMARK_BUDGET: usize = 5;
const MINIMAP_LOCAL_LANDMARK_BUDGET: usize = 4;
const MINIMAP_RELATION_BUDGET: usize = 3;
const MINIMAP_ABSTRACT_CORRESPONDENCE_BUDGET: usize = 3;

fn minimap_landmark_priority(kind: &PaperLandmarkKind) -> usize {
    match kind {
        PaperLandmarkKind::ResearchQuestion => 0,
        PaperLandmarkKind::Method => 1,
        PaperLandmarkKind::Evidence => 2,
        PaperLandmarkKind::Result => 3,
        PaperLandmarkKind::Contribution => 4,
        PaperLandmarkKind::Claim => 5,
        PaperLandmarkKind::Limitation => 6,
        PaperLandmarkKind::Hypothesis => 7,
        PaperLandmarkKind::Experiment => 8,
        PaperLandmarkKind::FutureWork => 9,
        PaperLandmarkKind::RelatedWork => 10,
        PaperLandmarkKind::Other => 11,
    }
}

fn minimap_slot_for_landmark(
    region_kind: &PaperRegionKind,
    landmark_kind: &PaperLandmarkKind,
) -> Option<PaperArgumentSlot> {
    match region_kind {
        PaperRegionKind::Abstract => match landmark_kind {
            PaperLandmarkKind::ResearchQuestion => Some(PaperArgumentSlot::ResearchQuestion),
            PaperLandmarkKind::Method => Some(PaperArgumentSlot::Method),
            PaperLandmarkKind::Result => Some(PaperArgumentSlot::Result),
            PaperLandmarkKind::Contribution => Some(PaperArgumentSlot::Contribution),
            _ => None,
        },
        PaperRegionKind::Introduction => match landmark_kind {
            PaperLandmarkKind::ResearchQuestion => Some(PaperArgumentSlot::ResearchQuestion),
            PaperLandmarkKind::Hypothesis => Some(PaperArgumentSlot::Hypothesis),
            _ => None,
        },
        PaperRegionKind::Method => match landmark_kind {
            PaperLandmarkKind::Method => Some(PaperArgumentSlot::Method),
            _ => None,
        },
        PaperRegionKind::Results => match landmark_kind {
            PaperLandmarkKind::Experiment => Some(PaperArgumentSlot::Experiment),
            PaperLandmarkKind::Evidence => Some(PaperArgumentSlot::Evidence),
            PaperLandmarkKind::Result => Some(PaperArgumentSlot::Result),
            PaperLandmarkKind::Claim => Some(PaperArgumentSlot::Claim),
            _ => None,
        },
        PaperRegionKind::Discussion => match landmark_kind {
            PaperLandmarkKind::Claim => Some(PaperArgumentSlot::Claim),
            PaperLandmarkKind::Result => Some(PaperArgumentSlot::Result),
            PaperLandmarkKind::Limitation => Some(PaperArgumentSlot::Limitation),
            PaperLandmarkKind::FutureWork => Some(PaperArgumentSlot::FutureWork),
            _ => None,
        },
        PaperRegionKind::Conclusion => match landmark_kind {
            PaperLandmarkKind::ResearchQuestion => Some(PaperArgumentSlot::ResearchQuestion),
            PaperLandmarkKind::Contribution => Some(PaperArgumentSlot::Contribution),
            PaperLandmarkKind::Claim => Some(PaperArgumentSlot::Claim),
            PaperLandmarkKind::Limitation => Some(PaperArgumentSlot::Limitation),
            _ => None,
        },
        PaperRegionKind::RelatedWork => match landmark_kind {
            PaperLandmarkKind::RelatedWork => Some(PaperArgumentSlot::Background),
            PaperLandmarkKind::Claim => Some(PaperArgumentSlot::Claim),
            _ => None,
        },
        PaperRegionKind::Unknown | PaperRegionKind::References => None,
    }
}

fn minimap_slot_priority(slot: &PaperArgumentSlot) -> usize {
    match slot {
        PaperArgumentSlot::Background => 0,
        PaperArgumentSlot::ResearchGap => 1,
        PaperArgumentSlot::ResearchQuestion => 2,
        PaperArgumentSlot::Hypothesis => 3,
        PaperArgumentSlot::Input => 4,
        PaperArgumentSlot::Object => 5,
        PaperArgumentSlot::MethodStep => 6,
        PaperArgumentSlot::Method => 7,
        PaperArgumentSlot::Output => 8,
        PaperArgumentSlot::Assumption => 9,
        PaperArgumentSlot::Experiment => 10,
        PaperArgumentSlot::Evidence => 11,
        PaperArgumentSlot::Result => 12,
        PaperArgumentSlot::Claim => 13,
        PaperArgumentSlot::Contribution => 14,
        PaperArgumentSlot::Interpretation => 15,
        PaperArgumentSlot::Limitation => 16,
        PaperArgumentSlot::FutureWork => 17,
    }
}

fn minimap_region_contains(region: &PaperRegion, landmark: &PaperLandmark) -> bool {
    landmark.page_index >= region.page_span.start_page
        && landmark.page_index <= region.page_span.end_page
}

/// Applies a deterministic mode lens to immutable base IDs. It never creates map facts.
pub fn project_paper_minimap_lens(
    base: &PaperMinimapBase,
    mode: PaperMinimapMode,
    requested_focus_region_id: Option<&str>,
) -> Result<PaperMinimapLensProjection, ToolError> {
    if base.status == PaperMinimapAvailabilityStatus::Unavailable {
        return Err(ToolError {
            error_code: "PAPER_MINIMAP_UNAVAILABLE".into(),
            category: "unavailable".into(),
            message: "paper minimap topology is unavailable".into(),
        });
    }
    let mut warnings = Vec::new();
    let requested_region = requested_focus_region_id
        .map(|region_id| {
            base.regions
                .iter()
                .find(|region| region.region_id == region_id)
                .ok_or_else(|| ToolError {
                    error_code: "PAPER_MINIMAP_REGION_NOT_FOUND".into(),
                    category: "not_found".into(),
                    message: format!("paper minimap region does not exist: {region_id}"),
                })
        })
        .transpose()?;
    let focus_region = match mode {
        PaperMinimapMode::Skim => None,
        PaperMinimapMode::Abstract => {
            let abstract_region = base
                .regions
                .iter()
                .find(|region| region.kind == PaperRegionKind::Abstract);
            if abstract_region.is_none() {
                warnings.push("paper minimap has no abstract region".into());
            }
            abstract_region
        }
        PaperMinimapMode::Deep => {
            if requested_region.is_none() {
                warnings.push("deep minimap lens requires an explicit focus region".into());
            }
            requested_region
        }
    };

    let mut global_landmarks: Vec<&PaperLandmark> = base.landmarks.iter().collect();
    global_landmarks.sort_by(|left, right| {
        minimap_landmark_priority(&left.kind)
            .cmp(&minimap_landmark_priority(&right.kind))
            .then_with(|| left.page_index.cmp(&right.page_index))
            .then_with(|| left.anchor_lid.cmp(&right.anchor_lid))
            .then_with(|| left.landmark_id.cmp(&right.landmark_id))
    });
    let global_landmark_ids: Vec<String> = global_landmarks
        .into_iter()
        .take(MINIMAP_GLOBAL_LANDMARK_BUDGET)
        .map(|landmark| landmark.landmark_id.clone())
        .collect();

    let mut local_candidates: Vec<(&PaperLandmark, PaperArgumentSlot)> = focus_region
        .map(|region| {
            base.landmarks
                .iter()
                .filter(|landmark| minimap_region_contains(region, landmark))
                .filter_map(|landmark| {
                    minimap_slot_for_landmark(&region.kind, &landmark.kind)
                        .map(|slot| (landmark, slot))
                })
                .collect()
        })
        .unwrap_or_default();
    local_candidates.sort_by(|(left_landmark, left_slot), (right_landmark, right_slot)| {
        minimap_slot_priority(left_slot)
            .cmp(&minimap_slot_priority(right_slot))
            .then_with(|| left_landmark.page_index.cmp(&right_landmark.page_index))
            .then_with(|| left_landmark.anchor_lid.cmp(&right_landmark.anchor_lid))
            .then_with(|| left_landmark.landmark_id.cmp(&right_landmark.landmark_id))
    });
    let mut used_slots = Vec::new();
    let mut local_landmark_ids = Vec::new();
    let mut slot_bindings = Vec::new();
    for (landmark, slot) in local_candidates {
        if used_slots.iter().any(|used| used == &slot) {
            continue;
        }
        used_slots.push(slot.clone());
        local_landmark_ids.push(landmark.landmark_id.clone());
        slot_bindings.push(PaperArgumentSlotBinding {
            slot,
            landmark_id: landmark.landmark_id.clone(),
        });
        if local_landmark_ids.len() == MINIMAP_LOCAL_LANDMARK_BUDGET {
            break;
        }
    }

    let global_landmark_set: HashSet<&str> =
        global_landmark_ids.iter().map(String::as_str).collect();
    let local_landmark_set: HashSet<&str> = local_landmark_ids.iter().map(String::as_str).collect();
    let visible_landmark_ids: HashSet<&str> = global_landmark_set
        .iter()
        .chain(local_landmark_set.iter())
        .copied()
        .collect();
    let local_relations_allowed = focus_region.is_some_and(|region| {
        !matches!(
            region.kind,
            PaperRegionKind::Unknown | PaperRegionKind::References
        )
    });
    let mut relation_ids: Vec<String> = base
        .relations
        .iter()
        .filter(|relation| {
            let source = relation.source_landmark_id.as_str();
            let target = relation.target_landmark_id.as_str();
            match mode {
                PaperMinimapMode::Skim => {
                    global_landmark_set.contains(source) && global_landmark_set.contains(target)
                }
                PaperMinimapMode::Abstract => {
                    local_relations_allowed
                        && local_landmark_set.contains(source)
                        && local_landmark_set.contains(target)
                }
                PaperMinimapMode::Deep => {
                    local_relations_allowed
                        && visible_landmark_ids.contains(source)
                        && visible_landmark_ids.contains(target)
                        && (local_landmark_set.contains(source)
                            || local_landmark_set.contains(target))
                }
            }
        })
        .map(|relation| relation.relation_id.clone())
        .collect();
    relation_ids.sort();
    relation_ids.truncate(MINIMAP_RELATION_BUDGET);

    let mut abstract_correspondences = Vec::new();
    if mode == PaperMinimapMode::Abstract {
        if let Some(abstract_region) = focus_region {
            for binding in &slot_bindings {
                let Some(abstract_landmark) = base
                    .landmarks
                    .iter()
                    .find(|landmark| landmark.landmark_id == binding.landmark_id)
                else {
                    continue;
                };
                let mut body_matches: Vec<&PaperLandmark> = base
                    .landmarks
                    .iter()
                    .filter(|landmark| {
                        landmark.kind == abstract_landmark.kind
                            && !minimap_region_contains(abstract_region, landmark)
                    })
                    .collect();
                body_matches.sort_by(|left, right| {
                    left.page_index
                        .cmp(&right.page_index)
                        .then_with(|| left.anchor_lid.cmp(&right.anchor_lid))
                        .then_with(|| left.landmark_id.cmp(&right.landmark_id))
                });
                if let Some(body_landmark) = body_matches.first() {
                    abstract_correspondences.push(PaperAbstractCorrespondence {
                        slot: binding.slot.clone(),
                        abstract_landmark_id: binding.landmark_id.clone(),
                        body_landmark_id: body_landmark.landmark_id.clone(),
                    });
                }
                if abstract_correspondences.len() == MINIMAP_ABSTRACT_CORRESPONDENCE_BUDGET {
                    break;
                }
            }
        }
    }

    Ok(PaperMinimapLensProjection {
        mode,
        focus_region_id: focus_region.map(|region| region.region_id.clone()),
        global_landmark_ids,
        local_landmark_ids,
        relation_ids,
        slot_bindings,
        abstract_correspondences,
        warnings,
    })
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
    paper_minimap: ReaderPaperMinimapState,
    paper_minimap_proposals: HashMap<String, PaperMinimapProposal>,
    paper_minimap_effects: HashMap<String, PaperMinimapEffect>,
    paper_minimap_proposal_seq: u64,
    paper_minimap_effect_seq: u64,
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

fn default_minimap_overlay() -> MinimapOverlay {
    MinimapOverlay {
        emphasized_landmark_ids: Vec::new(),
        hidden_landmark_ids: Vec::new(),
        pinned_landmark_ids: Vec::new(),
        focused_region_id: None,
        focused_landmark_id: None,
        visible_layers: vec!["regions".into(), "landmarks".into(), "arguments".into()],
        local_projection: None,
    }
}

fn default_paper_minimap_state(book: &Book) -> ReaderPaperMinimapState {
    let base = book.paper_minimap();
    let first_region = base.regions.first();
    let start_page = first_region
        .map(|region| region.page_span.start_page)
        .unwrap_or(0);
    ReaderPaperMinimapState {
        rev: 0,
        base_map_rev: base.fingerprint,
        presentation: PaperMinimapPresentation::Collapsed,
        mode: PaperMinimapMode::Skim,
        viewport_position: PaperViewportPosition {
            start_page,
            end_page: start_page,
            center_page: start_page as f32,
            progress_ratio: 0.0,
            anchor_lid: book
                .base
                .lid_nodes
                .iter()
                .find(|node| node.children.is_empty())
                .map(|node| node.lid.clone()),
            region_id: first_region.map(|region| region.region_id.clone()),
        },
        selected_lid: None,
        map_focus: None,
        session_overlay: default_minimap_overlay(),
        saved_user_overlay: SavedUserOverlay {
            book_id: base.book_id,
            book_version: base.book_version,
            overlay_rev: 0,
            emphasized_kinds: Vec::new(),
            hidden_landmark_ids: Vec::new(),
            pinned_landmark_ids: Vec::new(),
            custom_landmarks: Vec::new(),
            landmark_overrides: Vec::new(),
            saved_mode_preferences: Vec::new(),
        },
    }
}

fn minimap_error(code: &str, category: &str, message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: code.into(),
        category: category.into(),
        message: message.into(),
    }
}

fn minimap_region<'a>(
    base: &'a PaperMinimapBase,
    region_id: &str,
) -> Result<&'a PaperRegion, ToolError> {
    base.regions
        .iter()
        .find(|region| region.region_id == region_id)
        .ok_or_else(|| {
            minimap_error(
                "PAPER_MINIMAP_REGION_NOT_FOUND",
                "not_found",
                format!("paper minimap region does not exist: {region_id}"),
            )
        })
}

fn require_minimap_landmark(base: &PaperMinimapBase, landmark_id: &str) -> Result<(), ToolError> {
    if base
        .landmarks
        .iter()
        .any(|landmark| landmark.landmark_id == landmark_id)
    {
        Ok(())
    } else {
        Err(minimap_error(
            "PAPER_MINIMAP_LANDMARK_NOT_FOUND",
            "not_found",
            format!("paper minimap landmark does not exist: {landmark_id}"),
        ))
    }
}

fn allowed_minimap_slots(kind: &PaperRegionKind) -> Vec<PaperArgumentSlot> {
    let candidates = [
        PaperArgumentSlot::Background,
        PaperArgumentSlot::ResearchGap,
        PaperArgumentSlot::ResearchQuestion,
        PaperArgumentSlot::Hypothesis,
        PaperArgumentSlot::Input,
        PaperArgumentSlot::Object,
        PaperArgumentSlot::MethodStep,
        PaperArgumentSlot::Method,
        PaperArgumentSlot::Output,
        PaperArgumentSlot::Assumption,
        PaperArgumentSlot::Experiment,
        PaperArgumentSlot::Evidence,
        PaperArgumentSlot::Result,
        PaperArgumentSlot::Claim,
        PaperArgumentSlot::Contribution,
        PaperArgumentSlot::Interpretation,
        PaperArgumentSlot::Limitation,
        PaperArgumentSlot::FutureWork,
    ];
    candidates
        .into_iter()
        .filter(|slot| match kind {
            PaperRegionKind::Abstract => matches!(
                slot,
                PaperArgumentSlot::ResearchQuestion
                    | PaperArgumentSlot::Method
                    | PaperArgumentSlot::Result
                    | PaperArgumentSlot::Contribution
            ),
            PaperRegionKind::Introduction => matches!(
                slot,
                PaperArgumentSlot::Background
                    | PaperArgumentSlot::ResearchGap
                    | PaperArgumentSlot::ResearchQuestion
                    | PaperArgumentSlot::Hypothesis
            ),
            PaperRegionKind::Method => matches!(
                slot,
                PaperArgumentSlot::Input
                    | PaperArgumentSlot::Object
                    | PaperArgumentSlot::MethodStep
                    | PaperArgumentSlot::Output
                    | PaperArgumentSlot::Assumption
                    | PaperArgumentSlot::Method
            ),
            PaperRegionKind::Results => matches!(
                slot,
                PaperArgumentSlot::Experiment
                    | PaperArgumentSlot::Evidence
                    | PaperArgumentSlot::Result
                    | PaperArgumentSlot::Claim
            ),
            PaperRegionKind::Discussion => matches!(
                slot,
                PaperArgumentSlot::Claim
                    | PaperArgumentSlot::Result
                    | PaperArgumentSlot::Interpretation
                    | PaperArgumentSlot::Limitation
                    | PaperArgumentSlot::FutureWork
            ),
            PaperRegionKind::Conclusion => matches!(
                slot,
                PaperArgumentSlot::ResearchQuestion
                    | PaperArgumentSlot::Contribution
                    | PaperArgumentSlot::Claim
                    | PaperArgumentSlot::Limitation
            ),
            PaperRegionKind::RelatedWork => {
                matches!(
                    slot,
                    PaperArgumentSlot::Background | PaperArgumentSlot::Claim
                )
            }
            PaperRegionKind::Unknown | PaperRegionKind::References => false,
        })
        .collect()
}

fn minimap_commands_require_proposal(
    actor: &PaperMinimapActor,
    commands: &[PaperMinimapCommand],
) -> bool {
    commands.iter().any(|command| match command {
        PaperMinimapCommand::Saved(_) => true,
        PaperMinimapCommand::Session(PaperMinimapAction::SetModeLens { .. }) => {
            actor == &PaperMinimapActor::Agent
        }
        _ => false,
    })
}

fn apply_minimap_session_action(
    book: &Book,
    base: &PaperMinimapBase,
    state: &mut ReaderPaperMinimapState,
    actor: &PaperMinimapActor,
    action: &PaperMinimapAction,
) -> Result<(), ToolError> {
    match action {
        PaperMinimapAction::SetPresentation { presentation } => {
            if actor == &PaperMinimapActor::Agent {
                return Err(minimap_error(
                    "PAPER_MINIMAP_ACTION_FORBIDDEN",
                    "permission",
                    "agent cannot change minimap presentation",
                ));
            }
            state.presentation = presentation.clone();
        }
        PaperMinimapAction::UpdateViewport { position } => {
            if actor == &PaperMinimapActor::Agent {
                return Err(minimap_error(
                    "PAPER_MINIMAP_ACTION_FORBIDDEN",
                    "permission",
                    "agent cannot update the deterministic PDF viewport",
                ));
            }
            let first_page = base
                .regions
                .iter()
                .map(|region| region.page_span.start_page)
                .min()
                .ok_or_else(|| {
                    minimap_error(
                        "INVALID_PAPER_MINIMAP_VIEWPORT",
                        "validation",
                        "paper minimap viewport requires base regions",
                    )
                })?;
            let last_page = base
                .regions
                .iter()
                .map(|region| region.page_span.end_page)
                .max()
                .unwrap_or(first_page);
            if position.start_page > position.end_page
                || position.start_page < first_page
                || position.end_page > last_page
                || !position.center_page.is_finite()
                || position.center_page < position.start_page as f32
                || position.center_page > position.end_page.saturating_add(1) as f32
                || !position.progress_ratio.is_finite()
                || !(0.0..=1.0).contains(&position.progress_ratio)
            {
                return Err(minimap_error(
                    "INVALID_PAPER_MINIMAP_VIEWPORT",
                    "validation",
                    "paper minimap viewport is outside the trusted PDF page bounds",
                ));
            }
            if let Some(anchor_lid) = &position.anchor_lid {
                if !book
                    .base
                    .lid_nodes
                    .iter()
                    .any(|node| node.lid == *anchor_lid)
                {
                    return Err(minimap_error(
                        "PAPER_MINIMAP_LID_NOT_FOUND",
                        "not_found",
                        format!("paper minimap viewport LID does not exist: {anchor_lid}"),
                    ));
                }
            }
            if let Some(region_id) = &position.region_id {
                let region = minimap_region(base, region_id)?;
                let center_page = position.center_page.floor() as u32;
                if center_page < region.page_span.start_page
                    || center_page > region.page_span.end_page
                {
                    return Err(minimap_error(
                        "INVALID_PAPER_MINIMAP_VIEWPORT",
                        "validation",
                        "paper minimap viewport region does not contain its center page",
                    ));
                }
            }
            state.viewport_position = position.clone();
        }
        PaperMinimapAction::SetSelectedLid { selected_lid } => {
            if actor == &PaperMinimapActor::Agent {
                return Err(minimap_error(
                    "PAPER_MINIMAP_ACTION_FORBIDDEN",
                    "permission",
                    "agent cannot change the reader selection",
                ));
            }
            if let Some(lid) = selected_lid {
                if !book.base.lid_nodes.iter().any(|node| node.lid == *lid) {
                    return Err(minimap_error(
                        "PAPER_MINIMAP_LID_NOT_FOUND",
                        "not_found",
                        format!("paper minimap selected LID does not exist: {lid}"),
                    ));
                }
            }
            state.selected_lid = selected_lid.clone();
        }
        PaperMinimapAction::FocusRegion { region_id } => {
            minimap_region(base, region_id)?;
            state.map_focus = Some(PaperMapFocus {
                region_id: Some(region_id.clone()),
                landmark_id: None,
            });
            state.session_overlay.focused_region_id = Some(region_id.clone());
            state.session_overlay.focused_landmark_id = None;
        }
        PaperMinimapAction::FocusLandmark { landmark_id } => {
            require_minimap_landmark(base, landmark_id)?;
            state.map_focus = Some(PaperMapFocus {
                region_id: None,
                landmark_id: Some(landmark_id.clone()),
            });
            state.session_overlay.focused_region_id = None;
            state.session_overlay.focused_landmark_id = Some(landmark_id.clone());
        }
        PaperMinimapAction::EmphasizeLandmarks {
            landmark_ids,
            reason,
        } => {
            if reason.trim().is_empty() || landmark_ids.len() > MINIMAP_GLOBAL_LANDMARK_BUDGET {
                return Err(minimap_error(
                    "INVALID_PAPER_MINIMAP_ACTION",
                    "validation",
                    "emphasis requires a reason and at most five landmarks",
                ));
            }
            let mut unique = Vec::new();
            for landmark_id in landmark_ids {
                require_minimap_landmark(base, landmark_id)?;
                if !unique.iter().any(|own| own == landmark_id) {
                    unique.push(landmark_id.clone());
                }
            }
            state.session_overlay.emphasized_landmark_ids = unique;
        }
        PaperMinimapAction::SelectLocalProjection {
            region_id,
            grammar,
            focus_slots,
        } => {
            let region = minimap_region(base, region_id)?;
            if &region.kind != grammar || focus_slots.len() > MINIMAP_LOCAL_LANDMARK_BUDGET {
                return Err(minimap_error(
                    "INVALID_PAPER_MINIMAP_GRAMMAR",
                    "validation",
                    "local projection grammar or budget does not match the region",
                ));
            }
            let allowed = allowed_minimap_slots(grammar);
            let mut unique = Vec::new();
            for slot in focus_slots {
                if !allowed.contains(slot) || unique.contains(slot) {
                    return Err(minimap_error(
                        "INVALID_PAPER_MINIMAP_GRAMMAR",
                        "validation",
                        "local projection contains an invalid or duplicate slot",
                    ));
                }
                unique.push(slot.clone());
            }
            state.session_overlay.local_projection = Some(PaperLocalProjection {
                region_id: region_id.clone(),
                grammar: grammar.clone(),
                focus_slots: unique,
            });
        }
        PaperMinimapAction::SetLayerVisibility { layer, visible } => {
            if !matches!(
                layer.as_str(),
                "regions" | "landmarks" | "arguments" | "user"
            ) {
                return Err(minimap_error(
                    "INVALID_PAPER_MINIMAP_LAYER",
                    "validation",
                    format!("unknown paper minimap layer: {layer}"),
                ));
            }
            state
                .session_overlay
                .visible_layers
                .retain(|existing| existing != layer);
            if *visible {
                state.session_overlay.visible_layers.push(layer.clone());
                state.session_overlay.visible_layers.sort();
            }
        }
        PaperMinimapAction::PinLandmark { landmark_id } => {
            require_minimap_landmark(base, landmark_id)?;
            if !state
                .session_overlay
                .pinned_landmark_ids
                .iter()
                .any(|existing| existing == landmark_id)
            {
                state
                    .session_overlay
                    .pinned_landmark_ids
                    .push(landmark_id.clone());
            }
        }
        PaperMinimapAction::UnpinLandmark { landmark_id } => {
            require_minimap_landmark(base, landmark_id)?;
            state
                .session_overlay
                .pinned_landmark_ids
                .retain(|existing| existing != landmark_id);
        }
        PaperMinimapAction::SetModeLens { mode } => state.mode = mode.clone(),
        PaperMinimapAction::ClearSessionOverlay {} => {
            state.session_overlay = default_minimap_overlay();
            state.map_focus = None;
        }
    }
    Ok(())
}

fn apply_minimap_saved_action(
    book: &Book,
    base: &PaperMinimapBase,
    state: &mut ReaderPaperMinimapState,
    action: &SavedUserOverlayAction,
) -> Result<(), ToolError> {
    match action {
        SavedUserOverlayAction::SaveUserLandmark {
            anchor_lid,
            label,
            user_kind,
            note,
        } => {
            if label.trim().is_empty()
                || !book
                    .base
                    .lid_nodes
                    .iter()
                    .any(|node| node.lid == *anchor_lid)
            {
                return Err(minimap_error(
                    "INVALID_SAVED_PAPER_MINIMAP_ACTION",
                    "validation",
                    "saved user landmark requires a valid LID and non-empty label",
                ));
            }
            let landmark_id = format!(
                "user-landmark:{}:{}",
                state.saved_user_overlay.overlay_rev + 1,
                state.saved_user_overlay.custom_landmarks.len() + 1
            );
            state
                .saved_user_overlay
                .custom_landmarks
                .push(UserLandmark {
                    landmark_id,
                    label: label.trim().into(),
                    anchor_lid: anchor_lid.clone(),
                    kind: user_kind.clone(),
                    note: note.clone(),
                    created_from_effect: None,
                });
        }
        SavedUserOverlayAction::RemoveUserLandmark { landmark_id } => {
            state
                .saved_user_overlay
                .custom_landmarks
                .retain(|landmark| landmark.landmark_id != *landmark_id);
        }
        SavedUserOverlayAction::SetLandmarkOverride {
            target_landmark_id,
            operation,
            label,
            user_reason,
        } => {
            require_minimap_landmark(base, target_landmark_id)?;
            if operation == &UserLandmarkOverrideOperation::Rename
                && label.as_deref().is_none_or(|value| value.trim().is_empty())
            {
                return Err(minimap_error(
                    "INVALID_SAVED_PAPER_MINIMAP_ACTION",
                    "validation",
                    "rename override requires a non-empty label",
                ));
            }
            state
                .saved_user_overlay
                .landmark_overrides
                .retain(|item| item.target_landmark_id != *target_landmark_id);
            state
                .saved_user_overlay
                .landmark_overrides
                .push(UserLandmarkOverride {
                    target_landmark_id: target_landmark_id.clone(),
                    operation: operation.clone(),
                    label: label.clone(),
                    user_reason: user_reason.clone(),
                });
        }
        SavedUserOverlayAction::RemoveLandmarkOverride { target_landmark_id } => {
            state
                .saved_user_overlay
                .landmark_overrides
                .retain(|item| item.target_landmark_id != *target_landmark_id);
        }
        SavedUserOverlayAction::SaveModePreference {
            mode,
            visible_layers,
        } => {
            if visible_layers.iter().any(|layer| {
                !matches!(
                    layer.as_str(),
                    "regions" | "landmarks" | "arguments" | "user"
                )
            }) {
                return Err(minimap_error(
                    "INVALID_PAPER_MINIMAP_LAYER",
                    "validation",
                    "saved mode preference contains an unknown layer",
                ));
            }
            state
                .saved_user_overlay
                .saved_mode_preferences
                .retain(|preference| preference.mode != *mode);
            state
                .saved_user_overlay
                .saved_mode_preferences
                .push(PaperMinimapSavedModePreference {
                    mode: mode.clone(),
                    visible_layers: visible_layers.clone(),
                });
        }
        SavedUserOverlayAction::ClearSavedOverlay {} => {
            let overlay_rev = state.saved_user_overlay.overlay_rev;
            state.saved_user_overlay = SavedUserOverlay {
                book_id: base.book_id.clone(),
                book_version: base.book_version.clone(),
                overlay_rev,
                emphasized_kinds: Vec::new(),
                hidden_landmark_ids: Vec::new(),
                pinned_landmark_ids: Vec::new(),
                custom_landmarks: Vec::new(),
                landmark_overrides: Vec::new(),
                saved_mode_preferences: Vec::new(),
            };
        }
    }
    Ok(())
}

fn apply_minimap_commands_to_state(
    book: &Book,
    base: &PaperMinimapBase,
    state: &mut ReaderPaperMinimapState,
    actor: &PaperMinimapActor,
    commands: &[PaperMinimapCommand],
) -> Result<(), ToolError> {
    let saved_before = state.saved_user_overlay.clone();
    let mut saved_changed = false;
    for command in commands {
        match command {
            PaperMinimapCommand::Session(action) => {
                apply_minimap_session_action(book, base, state, actor, action)?
            }
            PaperMinimapCommand::Saved(action) => {
                apply_minimap_saved_action(book, base, state, action)?;
                saved_changed = true;
            }
        }
    }
    if saved_changed && state.saved_user_overlay != saved_before {
        state.saved_user_overlay.overlay_rev = saved_before.overlay_rev + 1;
    }
    Ok(())
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
            paper_minimap: default_paper_minimap_state(book),
            paper_minimap_proposals: HashMap::new(),
            paper_minimap_effects: HashMap::new(),
            paper_minimap_proposal_seq: 0,
            paper_minimap_effect_seq: 0,
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
                selection_context: None,
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
                selection_context: None,
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
    pub fn paper_minimap_state(&self) -> ReaderPaperMinimapState {
        self.paper_minimap.clone()
    }

    pub fn restore_saved_user_overlay(
        &mut self,
        book: &Book,
        overlay: SavedUserOverlay,
    ) -> Result<(), ToolError> {
        let base = book.paper_minimap();
        if overlay.book_id != base.book_id || overlay.book_version != base.book_version {
            return Err(minimap_error(
                "PAPER_MINIMAP_OVERLAY_IDENTITY_MISMATCH",
                "conflict",
                "saved paper minimap overlay does not match the current book version",
            ));
        }
        if overlay.custom_landmarks.iter().any(|landmark| {
            !book
                .base
                .lid_nodes
                .iter()
                .any(|node| node.lid == landmark.anchor_lid)
        }) {
            return Err(minimap_error(
                "PAPER_MINIMAP_OVERLAY_DANGLING_LID",
                "validation",
                "saved paper minimap overlay contains a dangling custom landmark LID",
            ));
        }
        let base_landmark_ids: HashSet<&str> = base
            .landmarks
            .iter()
            .map(|landmark| landmark.landmark_id.as_str())
            .collect();
        if overlay
            .hidden_landmark_ids
            .iter()
            .chain(overlay.pinned_landmark_ids.iter())
            .chain(
                overlay
                    .landmark_overrides
                    .iter()
                    .map(|item| &item.target_landmark_id),
            )
            .any(|landmark_id| !base_landmark_ids.contains(landmark_id.as_str()))
        {
            return Err(minimap_error(
                "PAPER_MINIMAP_OVERLAY_DANGLING_LANDMARK",
                "validation",
                "saved paper minimap overlay contains a dangling base landmark",
            ));
        }
        self.paper_minimap.saved_user_overlay = overlay;
        Ok(())
    }

    fn validate_minimap_base_and_rev(
        &self,
        base: &PaperMinimapBase,
        base_state_rev: u64,
    ) -> Result<(), ToolError> {
        if base.fingerprint != self.paper_minimap.base_map_rev {
            return Err(minimap_error(
                "PAPER_MINIMAP_BASE_STALE",
                "conflict",
                "paper minimap base fingerprint has changed",
            ));
        }
        if base_state_rev != self.paper_minimap.rev {
            return Err(minimap_error(
                "PAPER_MINIMAP_STATE_STALE",
                "conflict",
                format!(
                    "paper minimap state is stale: base={base_state_rev} current={}",
                    self.paper_minimap.rev
                ),
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_minimap_commands(
        &mut self,
        book: &Book,
        base: &PaperMinimapBase,
        actor: PaperMinimapActor,
        commands: Vec<PaperMinimapCommand>,
        reason: String,
        evidence_lids: Vec<String>,
        trigger_turn_id: Option<String>,
        created_at: String,
    ) -> Result<PaperMinimapApplyOutcome, ToolError> {
        let before = self.paper_minimap.clone();
        let existing_custom_landmarks = before.saved_user_overlay.custom_landmarks.len();
        let mut after = before.clone();
        apply_minimap_commands_to_state(book, base, &mut after, &actor, &commands)?;
        if after == before {
            return Ok(PaperMinimapApplyOutcome::Noop { state: before });
        }
        after.rev = before.rev + 1;
        self.paper_minimap_effect_seq += 1;
        let effect_id = format!(
            "paper_minimap_effect_{}_{}",
            before.rev, self.paper_minimap_effect_seq
        );
        for landmark in after
            .saved_user_overlay
            .custom_landmarks
            .iter_mut()
            .skip(existing_custom_landmarks)
        {
            if landmark.created_from_effect.is_none() {
                landmark.created_from_effect = Some(effect_id.clone());
            }
        }
        self.paper_minimap = after.clone();
        let effect = PaperMinimapEffect {
            effect_id: effect_id.clone(),
            base_map_rev: base.fingerprint.clone(),
            before_state_rev: before.rev,
            after_state_rev: after.rev,
            trigger_turn_id,
            actions: commands,
            reason,
            evidence_lids,
            created_at,
            before,
            after,
        };
        let undoable = effect.actions.iter().any(|command| {
            !matches!(
                command,
                PaperMinimapCommand::Session(PaperMinimapAction::UpdateViewport { .. })
                    | PaperMinimapCommand::Session(PaperMinimapAction::SetSelectedLid { .. })
            )
        });
        if undoable {
            self.paper_minimap_effects.insert(effect_id, effect.clone());
            if self.paper_minimap_effects.len() > 64 {
                if let Some(oldest_id) = self
                    .paper_minimap_effects
                    .values()
                    .min_by_key(|item| item.before_state_rev)
                    .map(|item| item.effect_id.clone())
                {
                    self.paper_minimap_effects.remove(&oldest_id);
                }
            }
        }
        Ok(PaperMinimapApplyOutcome::Effect { effect })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_paper_minimap_commands(
        &mut self,
        book: &Book,
        base_state_rev: u64,
        actor: PaperMinimapActor,
        commands: Vec<PaperMinimapCommand>,
        reason: impl Into<String>,
        evidence_lids: Vec<String>,
        trigger_turn_id: Option<String>,
        created_at: impl Into<String>,
    ) -> Result<PaperMinimapApplyOutcome, ToolError> {
        if commands.is_empty() {
            return Err(minimap_error(
                "INVALID_PAPER_MINIMAP_ACTION",
                "validation",
                "paper minimap apply requires at least one command",
            ));
        }
        let reason = reason.into();
        if reason.trim().is_empty()
            || evidence_lids
                .iter()
                .any(|lid| !book.base.lid_nodes.iter().any(|node| node.lid == *lid))
        {
            return Err(minimap_error(
                "INVALID_PAPER_MINIMAP_ACTION",
                "validation",
                "paper minimap apply requires a reason and valid evidence LIDs",
            ));
        }
        let base = book.paper_minimap();
        self.validate_minimap_base_and_rev(&base, base_state_rev)?;
        let mut scratch = self.paper_minimap.clone();
        apply_minimap_commands_to_state(book, &base, &mut scratch, &actor, &commands)?;
        if minimap_commands_require_proposal(&actor, &commands) {
            self.paper_minimap_proposal_seq += 1;
            let proposal = PaperMinimapProposal {
                proposal_id: format!(
                    "paper_minimap_proposal_{}_{}",
                    self.paper_minimap.rev, self.paper_minimap_proposal_seq
                ),
                base_map_rev: base.fingerprint,
                base_state_rev: self.paper_minimap.rev,
                actions: commands,
                summary: reason,
            };
            self.paper_minimap_proposals
                .insert(proposal.proposal_id.clone(), proposal.clone());
            return Ok(PaperMinimapApplyOutcome::Proposal { proposal });
        }
        self.commit_minimap_commands(
            book,
            &base,
            actor,
            commands,
            reason,
            evidence_lids,
            trigger_turn_id,
            created_at.into(),
        )
    }

    pub fn apply_paper_minimap_proposal(
        &mut self,
        book: &Book,
        proposal_id: &str,
        base_map_rev: &str,
        base_state_rev: u64,
        created_at: impl Into<String>,
    ) -> Result<PaperMinimapEffect, ToolError> {
        let proposal = self
            .paper_minimap_proposals
            .get(proposal_id)
            .cloned()
            .ok_or_else(|| {
                minimap_error(
                    "PAPER_MINIMAP_PROPOSAL_NOT_FOUND",
                    "not_found",
                    format!("paper minimap proposal does not exist: {proposal_id}"),
                )
            })?;
        let base = book.paper_minimap();
        if proposal.base_map_rev != base_map_rev
            || proposal.base_map_rev != base.fingerprint
            || proposal.base_state_rev != base_state_rev
        {
            return Err(minimap_error(
                "PAPER_MINIMAP_PROPOSAL_STALE",
                "conflict",
                "paper minimap proposal base identity is stale",
            ));
        }
        self.validate_minimap_base_and_rev(&base, base_state_rev)
            .map_err(|_| {
                minimap_error(
                    "PAPER_MINIMAP_PROPOSAL_STALE",
                    "conflict",
                    "paper minimap proposal state revision is stale",
                )
            })?;
        let outcome = self.commit_minimap_commands(
            book,
            &base,
            PaperMinimapActor::User,
            proposal.actions,
            proposal.summary,
            Vec::new(),
            None,
            created_at.into(),
        )?;
        self.paper_minimap_proposals.remove(proposal_id);
        match outcome {
            PaperMinimapApplyOutcome::Effect { effect } => Ok(effect),
            PaperMinimapApplyOutcome::Noop { .. } => Err(minimap_error(
                "PAPER_MINIMAP_PROPOSAL_NOOP",
                "conflict",
                "paper minimap proposal no longer changes state",
            )),
            PaperMinimapApplyOutcome::Proposal { .. } => unreachable!(),
        }
    }

    pub fn dismiss_paper_minimap_proposal(
        &mut self,
        proposal_id: &str,
        base_map_rev: &str,
        base_state_rev: u64,
    ) -> Result<ReaderPaperMinimapState, ToolError> {
        let proposal = self
            .paper_minimap_proposals
            .get(proposal_id)
            .ok_or_else(|| {
                minimap_error(
                    "PAPER_MINIMAP_PROPOSAL_NOT_FOUND",
                    "not_found",
                    format!("paper minimap proposal does not exist: {proposal_id}"),
                )
            })?;
        if proposal.base_map_rev != base_map_rev
            || proposal.base_state_rev != base_state_rev
            || self.paper_minimap.base_map_rev != base_map_rev
            || self.paper_minimap.rev != base_state_rev
        {
            return Err(minimap_error(
                "PAPER_MINIMAP_PROPOSAL_STALE",
                "conflict",
                "paper minimap proposal cannot be dismissed from a stale state",
            ));
        }
        self.paper_minimap_proposals.remove(proposal_id);
        Ok(self.paper_minimap.clone())
    }

    pub fn undo_paper_minimap_effect(
        &mut self,
        effect: &PaperMinimapEffect,
        created_at: impl Into<String>,
    ) -> Result<PaperMinimapEffect, ToolError> {
        if effect.base_map_rev != self.paper_minimap.base_map_rev
            || effect.after_state_rev != self.paper_minimap.rev
        {
            return Err(minimap_error(
                "PAPER_MINIMAP_EFFECT_STALE",
                "conflict",
                "paper minimap effect cannot be undone from the current revision",
            ));
        }
        let before = self.paper_minimap.clone();
        let mut after = effect.before.clone();
        after.rev = before.rev + 1;
        self.paper_minimap_effect_seq += 1;
        let undo = PaperMinimapEffect {
            effect_id: format!(
                "paper_minimap_effect_{}_{}",
                before.rev, self.paper_minimap_effect_seq
            ),
            base_map_rev: effect.base_map_rev.clone(),
            before_state_rev: before.rev,
            after_state_rev: after.rev,
            trigger_turn_id: None,
            actions: Vec::new(),
            reason: format!("undo {}", effect.effect_id),
            evidence_lids: effect.evidence_lids.clone(),
            created_at: created_at.into(),
            before,
            after: after.clone(),
        };
        self.paper_minimap = after;
        Ok(undo)
    }

    pub fn undo_paper_minimap_effect_by_id(
        &mut self,
        effect_id: &str,
        base_state_rev: u64,
        created_at: impl Into<String>,
    ) -> Result<PaperMinimapEffect, ToolError> {
        if self.paper_minimap.rev != base_state_rev {
            return Err(minimap_error(
                "PAPER_MINIMAP_STATE_STALE",
                "conflict",
                format!(
                    "paper minimap state is stale: base={base_state_rev} current={}",
                    self.paper_minimap.rev
                ),
            ));
        }
        let effect = self
            .paper_minimap_effects
            .get(effect_id)
            .cloned()
            .ok_or_else(|| {
                minimap_error(
                    "PAPER_MINIMAP_EFFECT_NOT_FOUND",
                    "not_found",
                    format!("paper minimap effect does not exist: {effect_id}"),
                )
            })?;
        let undo = self.undo_paper_minimap_effect(&effect, created_at)?;
        self.paper_minimap_effects.remove(effect_id);
        Ok(undo)
    }

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

    fn paper_minimap_book(name: &str) -> (Book, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ub-reader-minimap-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = "# Introduction\nWhich method works?\n";
        let heading_end = "# Introduction\n".encode_utf16().count();
        let source_end = source.encode_utf16().count();
        let base = ReadOnlyBase {
            book_id: "reader-minimap-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span {
                        start: 0,
                        end: source_end,
                    },
                    children: vec!["1.1".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Section,
                    span: Span {
                        start: 0,
                        end: source_end,
                    },
                    children: vec!["1.1.1".into()],
                },
                LidNode {
                    lid: "1.1.1".into(),
                    path: vec![1, 1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span {
                        start: heading_end,
                        end: source_end,
                    },
                    children: Vec::new(),
                },
            ],
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        };
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), source).unwrap();
        std::fs::write(
            dir.join("source_manifest.json"),
            serde_json::json!({
                "version": "source_manifest.v2",
                "book_id": "reader-minimap-book",
                "canonical_source": {"path": "source.txt", "sha256": "sha-a"},
                "capabilities": {
                    "view_pdf": {"status": "available"},
                    "project_lid_to_pdf": {"status": "available", "config_hash": "cfg-a"}
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("pdf_source_map.json"),
            serde_json::json!({
                "version": "pdf_source_map.v1",
                "book_id": "reader-minimap-book",
                "pages": [{"pageIndex": 0}],
                "entries": [{
                    "lid": "1.1.1",
                    "source_span": {"start": heading_end, "end": source_end},
                    "regions": [{"pageIndex": 0}]
                }],
                "config_hash": "cfg-a"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("discourse_index.json"),
            serde_json::json!({
                "items": [{
                    "lid": "1.1.1",
                    "mode": "argumentative",
                    "local_function": "research_question",
                    "local_summary": "Which method works?",
                    "relations": []
                }]
            })
            .to_string(),
        )
        .unwrap();
        (Book::load(dir.to_str().unwrap()).unwrap(), dir)
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
            .highlight(
                &b,
                &mut store,
                "1.2",
                Some((8, 99)),
                None,
                "long_term",
                "t0",
            )
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

    fn minimap_state() -> ReaderPaperMinimapState {
        ReaderPaperMinimapState {
            rev: 3,
            base_map_rev: "fp-a".into(),
            presentation: PaperMinimapPresentation::Collapsed,
            mode: PaperMinimapMode::Skim,
            viewport_position: PaperViewportPosition {
                start_page: 1,
                end_page: 2,
                center_page: 1.5,
                progress_ratio: 0.25,
                anchor_lid: Some("1.2".into()),
                region_id: Some("region:introduction".into()),
            },
            selected_lid: Some("1.2".into()),
            map_focus: Some(PaperMapFocus {
                region_id: Some("region:introduction".into()),
                landmark_id: None,
            }),
            session_overlay: MinimapOverlay {
                emphasized_landmark_ids: vec!["landmark:rq".into()],
                hidden_landmark_ids: Vec::new(),
                pinned_landmark_ids: Vec::new(),
                focused_region_id: Some("region:introduction".into()),
                focused_landmark_id: None,
                visible_layers: vec!["regions".into(), "landmarks".into()],
                local_projection: Some(PaperLocalProjection {
                    region_id: "region:introduction".into(),
                    grammar: PaperRegionKind::Introduction,
                    focus_slots: vec![
                        PaperArgumentSlot::ResearchGap,
                        PaperArgumentSlot::ResearchQuestion,
                    ],
                }),
            },
            saved_user_overlay: SavedUserOverlay {
                book_id: "paper-a".into(),
                book_version: "v1".into(),
                overlay_rev: 1,
                emphasized_kinds: vec![PaperLandmarkKind::Limitation],
                hidden_landmark_ids: Vec::new(),
                pinned_landmark_ids: vec!["landmark:rq".into()],
                custom_landmarks: Vec::new(),
                landmark_overrides: Vec::new(),
                saved_mode_preferences: Vec::new(),
            },
        }
    }

    fn lens_base() -> PaperMinimapBase {
        let region =
            |region_id: &str, kind: PaperRegionKind, page: u32| -> read_tools::PaperRegion {
                read_tools::PaperRegion {
                    region_id: region_id.into(),
                    title: region_id.into(),
                    kind,
                    lid_span: read_tools::PaperLidSpan {
                        start_lid: format!("{page}.1"),
                        end_lid: format!("{page}.9"),
                    },
                    page_span: read_tools::PaperPageSpan {
                        start_page: page,
                        end_page: page,
                    },
                    classification_source: read_tools::PaperRegionClassificationSource::Heading,
                    confidence: 1.0,
                }
            };
        let landmark =
            |id: &str, kind: PaperLandmarkKind, page: u32| -> read_tools::PaperLandmark {
                read_tools::PaperLandmark {
                    landmark_id: id.into(),
                    kind,
                    anchor_lid: format!("{page}.{id}"),
                    page_index: page,
                    label: id.into(),
                    source_label: None,
                    evidence_lids: vec![format!("{page}.1")],
                    provenance: vec![read_tools::PaperLandmarkProvenance::Discourse],
                }
            };
        let relation =
            |id: &str, source: &str, target: &str| -> read_tools::PaperArgumentRelation {
                read_tools::PaperArgumentRelation {
                    relation_id: id.into(),
                    relation_type: read_tools::PaperMinimapRelation::Supports,
                    source_landmark_id: source.into(),
                    target_landmark_id: target.into(),
                    evidence_lids: vec!["2.1".into()],
                }
            };
        PaperMinimapBase {
            version: "paper_minimap.v1".into(),
            book_id: "lens-book".into(),
            book_version: "v1".into(),
            fingerprint: "lens-fp".into(),
            status: PaperMinimapAvailabilityStatus::Available,
            regions: vec![
                region("region:abstract", PaperRegionKind::Abstract, 0),
                region("region:method", PaperRegionKind::Method, 1),
                region("region:results", PaperRegionKind::Results, 2),
                region("region:discussion", PaperRegionKind::Discussion, 3),
                region("region:unknown", PaperRegionKind::Unknown, 4),
            ],
            landmarks: vec![
                landmark("rq", PaperLandmarkKind::ResearchQuestion, 0),
                landmark("abstract-method", PaperLandmarkKind::Method, 0),
                landmark("abstract-result", PaperLandmarkKind::Result, 0),
                landmark("abstract-contribution", PaperLandmarkKind::Contribution, 0),
                landmark("method", PaperLandmarkKind::Method, 1),
                landmark("experiment", PaperLandmarkKind::Experiment, 2),
                landmark("evidence", PaperLandmarkKind::Evidence, 2),
                landmark("result", PaperLandmarkKind::Result, 2),
                landmark("claim", PaperLandmarkKind::Claim, 2),
                landmark("limitation", PaperLandmarkKind::Limitation, 3),
                landmark("future", PaperLandmarkKind::FutureWork, 3),
                landmark("other", PaperLandmarkKind::Other, 4),
            ],
            relations: vec![
                relation("rel:experiment-evidence", "experiment", "evidence"),
                relation("rel:evidence-result", "evidence", "result"),
                relation("rel:result-claim", "result", "claim"),
                relation("rel:claim-future", "claim", "future"),
            ],
            layer_status: HashMap::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn paper_minimap_lens_enforces_global_local_and_relation_budgets() {
        let base = lens_base();
        let skim = project_paper_minimap_lens(&base, PaperMinimapMode::Skim, None).unwrap();
        assert_eq!(skim.global_landmark_ids.len(), 5);
        assert!(skim.local_landmark_ids.is_empty());
        assert!(skim.relation_ids.len() <= 3);

        let abstract_lens =
            project_paper_minimap_lens(&base, PaperMinimapMode::Abstract, None).unwrap();
        assert_eq!(
            abstract_lens.focus_region_id.as_deref(),
            Some("region:abstract")
        );
        assert_eq!(abstract_lens.local_landmark_ids.len(), 4);

        let deep =
            project_paper_minimap_lens(&base, PaperMinimapMode::Deep, Some("region:results"))
                .unwrap();
        assert_eq!(deep.local_landmark_ids.len(), 4);
        assert_eq!(deep.slot_bindings.len(), 4);
        assert_eq!(deep.relation_ids.len(), 3);
        assert_eq!(deep.slot_bindings[0].slot, PaperArgumentSlot::Experiment);
        assert_eq!(deep.slot_bindings[1].slot, PaperArgumentSlot::Evidence);
        assert_eq!(deep.slot_bindings[2].slot, PaperArgumentSlot::Result);
        assert_eq!(deep.slot_bindings[3].slot, PaperArgumentSlot::Claim);
        assert_ne!(abstract_lens.slot_bindings, deep.slot_bindings);
        assert_ne!(skim.relation_ids, deep.relation_ids);
        assert!(deep.relation_ids.iter().all(|relation_id| {
            let relation = base
                .relations
                .iter()
                .find(|relation| &relation.relation_id == relation_id)
                .unwrap();
            deep.local_landmark_ids
                .contains(&relation.source_landmark_id)
                || deep
                    .local_landmark_ids
                    .contains(&relation.target_landmark_id)
        }));
    }

    #[test]
    fn paper_layout_preset_and_minimap_mode_are_independent_control_planes() {
        let (_, dir) = paper_minimap_book("layout-mode-independence");
        std::fs::write(
            dir.join("book_structure.json"),
            serde_json::json!({
                "header": {
                    "book_id": "reader-minimap-book", "book_version": "v1",
                    "profile_id": "paper", "profile_version": "paper_v0",
                    "core_schema_version": "core_v0", "generated_at": "t0"
                },
                "spine": [], "throughlines": [], "key_stops": []
            })
            .to_string(),
        )
        .unwrap();
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let mut reader = Reader::new(&book, 2);
        let proposal = match reader
            .apply_layout_actions(
                &book,
                vec![ReaderLayoutAction::SetLayoutPreset {
                    preset_id: "paper_deep_read".into(),
                }],
            )
            .unwrap()
        {
            ReaderLayoutApplyOutcome::Proposal { proposal } => proposal,
            _ => panic!("expected layout proposal"),
        };
        reader
            .apply_layout_proposal(&book, &proposal.proposal_id, proposal.base_layout_rev)
            .unwrap();
        assert_eq!(
            reader.layout_state().active_preset.as_deref(),
            Some("paper_deep_read")
        );
        assert!(reader
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "paper.ten_questions"));
        assert_eq!(reader.paper_minimap_state().mode, PaperMinimapMode::Skim);

        reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetModeLens {
                        mode: PaperMinimapMode::Abstract,
                    },
                )],
                "user selected abstract minimap mode",
                Vec::new(),
                None,
                "t1",
            )
            .unwrap();
        assert_eq!(
            reader.paper_minimap_state().mode,
            PaperMinimapMode::Abstract
        );
        assert_eq!(
            reader.layout_state().active_preset.as_deref(),
            Some("paper_deep_read")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_lens_unknown_region_stays_empty_and_never_fabricates_ids() {
        let base = lens_base();
        let projection =
            project_paper_minimap_lens(&base, PaperMinimapMode::Deep, Some("region:unknown"))
                .unwrap();
        assert!(projection.local_landmark_ids.is_empty());
        assert!(projection.slot_bindings.is_empty());
        assert!(projection.relation_ids.is_empty());
        assert!(projection.global_landmark_ids.iter().all(|id| base
            .landmarks
            .iter()
            .any(|landmark| &landmark.landmark_id == id)));
    }

    #[test]
    fn paper_minimap_abstract_lens_has_four_slots_and_explicit_missing_fallback() {
        let mut base = lens_base();
        let projection =
            project_paper_minimap_lens(&base, PaperMinimapMode::Abstract, None).unwrap();
        assert_eq!(
            projection.focus_region_id.as_deref(),
            Some("region:abstract")
        );
        assert_eq!(projection.local_landmark_ids.len(), 4);
        assert_eq!(projection.abstract_correspondences.len(), 2);
        assert!(projection.abstract_correspondences.iter().all(|item| {
            base.landmarks
                .iter()
                .any(|landmark| landmark.landmark_id == item.abstract_landmark_id)
                && base
                    .landmarks
                    .iter()
                    .any(|landmark| landmark.landmark_id == item.body_landmark_id)
        }));
        assert!(projection.warnings.is_empty());

        base.regions
            .retain(|region| region.kind != PaperRegionKind::Abstract);
        let fallback = project_paper_minimap_lens(&base, PaperMinimapMode::Abstract, None).unwrap();
        assert!(fallback.focus_region_id.is_none());
        assert!(fallback.local_landmark_ids.is_empty());
        assert!(fallback.abstract_correspondences.is_empty());
        assert_eq!(fallback.global_landmark_ids.len(), 5);
        assert!(fallback
            .warnings
            .iter()
            .any(|warning| warning.contains("no abstract region")));
    }

    #[test]
    fn paper_minimap_reducer_applies_user_effect_noop_and_undo() {
        let (book, dir) = paper_minimap_book("effect");
        let mut reader = Reader::new(&book, 2);
        let outcome = reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetPresentation {
                        presentation: PaperMinimapPresentation::Expanded,
                    },
                )],
                "user opened minimap",
                Vec::new(),
                None,
                "t1",
            )
            .unwrap();
        let effect = match outcome {
            PaperMinimapApplyOutcome::Effect { effect } => effect,
            _ => panic!("expected effect"),
        };
        assert_eq!(reader.paper_minimap_state().rev, 1);
        assert_eq!(
            reader.paper_minimap_state().presentation,
            PaperMinimapPresentation::Expanded
        );
        let undo = reader
            .undo_paper_minimap_effect_by_id(&effect.effect_id, effect.after_state_rev, "t2")
            .unwrap();
        assert_eq!(undo.after_state_rev, 2);
        assert_eq!(
            reader.paper_minimap_state().presentation,
            PaperMinimapPresentation::Collapsed
        );
        let replay = reader
            .undo_paper_minimap_effect_by_id(&effect.effect_id, 2, "t2-replay")
            .unwrap_err();
        assert_eq!(replay.error_code, "PAPER_MINIMAP_EFFECT_NOT_FOUND");

        let mut fresh = Reader::new(&book, 2);
        let noop = fresh
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetPresentation {
                        presentation: PaperMinimapPresentation::Collapsed,
                    },
                )],
                "keep collapsed",
                Vec::new(),
                None,
                "t3",
            )
            .unwrap();
        assert!(matches!(noop, PaperMinimapApplyOutcome::Noop { .. }));
        assert_eq!(fresh.paper_minimap_state().rev, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_reducer_syncs_viewport_and_selection_without_changing_focus() {
        let (book, dir) = paper_minimap_book("viewport-sync");
        let base = book.paper_minimap();
        let region_id = base.regions[0].region_id.clone();
        let mut reader = Reader::new(&book, 2);
        let outcome = reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![
                    PaperMinimapCommand::Session(PaperMinimapAction::UpdateViewport {
                        position: PaperViewportPosition {
                            start_page: 0,
                            end_page: 0,
                            center_page: 0.5,
                            progress_ratio: 0.5,
                            anchor_lid: Some("1.1.1".into()),
                            region_id: Some(region_id),
                        },
                    }),
                    PaperMinimapCommand::Session(PaperMinimapAction::SetSelectedLid {
                        selected_lid: Some("1.1.1".into()),
                    }),
                ],
                "sync deterministic PDF position",
                Vec::new(),
                None,
                "t1",
            )
            .unwrap();
        let effect = match outcome {
            PaperMinimapApplyOutcome::Effect { effect } => effect,
            _ => panic!("expected effect"),
        };
        let after = &effect.after;
        assert_eq!(after.viewport_position.center_page, 0.5);
        assert_eq!(after.selected_lid.as_deref(), Some("1.1.1"));
        assert!(after.map_focus.is_none());
        let not_undoable = reader
            .undo_paper_minimap_effect_by_id(&effect.effect_id, 1, "t1-undo")
            .unwrap_err();
        assert_eq!(not_undoable.error_code, "PAPER_MINIMAP_EFFECT_NOT_FOUND");

        let forbidden = reader
            .apply_paper_minimap_commands(
                &book,
                1,
                PaperMinimapActor::Agent,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetSelectedLid { selected_lid: None },
                )],
                "agent tried to clear selection",
                Vec::new(),
                None,
                "t2",
            )
            .unwrap_err();
        assert_eq!(forbidden.error_code, "PAPER_MINIMAP_ACTION_FORBIDDEN");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_reducer_rejects_untrusted_viewport_coordinates() {
        let (book, dir) = paper_minimap_book("viewport-validation");
        let mut reader = Reader::new(&book, 2);
        let invalid_page = reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::UpdateViewport {
                        position: PaperViewportPosition {
                            start_page: 0,
                            end_page: 3,
                            center_page: 1.5,
                            progress_ratio: 0.5,
                            anchor_lid: Some("1.1.1".into()),
                            region_id: None,
                        },
                    },
                )],
                "invalid PDF position",
                Vec::new(),
                None,
                "t1",
            )
            .unwrap_err();
        assert_eq!(invalid_page.error_code, "INVALID_PAPER_MINIMAP_VIEWPORT");

        let invalid_lid = reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetSelectedLid {
                        selected_lid: Some("9.9".into()),
                    },
                )],
                "invalid PDF selection",
                Vec::new(),
                None,
                "t2",
            )
            .unwrap_err();
        assert_eq!(invalid_lid.error_code, "PAPER_MINIMAP_LID_NOT_FOUND");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_reducer_enforces_agent_and_proposal_authority() {
        let (book, dir) = paper_minimap_book("authority");
        let mut reader = Reader::new(&book, 2);
        let forbidden = reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::Agent,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetPresentation {
                        presentation: PaperMinimapPresentation::Expanded,
                    },
                )],
                "agent tried to open minimap",
                Vec::new(),
                Some("turn-1".into()),
                "t1",
            )
            .unwrap_err();
        assert_eq!(forbidden.error_code, "PAPER_MINIMAP_ACTION_FORBIDDEN");

        let proposal = match reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::Agent,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetModeLens {
                        mode: PaperMinimapMode::Deep,
                    },
                )],
                "agent suggests deep mode",
                Vec::new(),
                Some("turn-2".into()),
                "t2",
            )
            .unwrap()
        {
            PaperMinimapApplyOutcome::Proposal { proposal } => proposal,
            _ => panic!("expected proposal"),
        };
        assert_eq!(reader.paper_minimap_state().mode, PaperMinimapMode::Skim);
        let effect = reader
            .apply_paper_minimap_proposal(
                &book,
                &proposal.proposal_id,
                &proposal.base_map_rev,
                proposal.base_state_rev,
                "t3",
            )
            .unwrap();
        assert_eq!(effect.after.mode, PaperMinimapMode::Deep);

        let saved = reader
            .apply_paper_minimap_commands(
                &book,
                1,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Saved(
                    SavedUserOverlayAction::SaveUserLandmark {
                        anchor_lid: "1.1.1".into(),
                        label: "Revisit".into(),
                        user_kind: UserLandmarkKind::FollowUp,
                        note: None,
                    },
                )],
                "save a personal landmark",
                vec!["1.1.1".into()],
                None,
                "t4",
            )
            .unwrap();
        assert!(matches!(saved, PaperMinimapApplyOutcome::Proposal { .. }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_reducer_rejects_stale_invalid_ids_grammar_and_budget() {
        let (book, dir) = paper_minimap_book("validation");
        let mut reader = Reader::new(&book, 2);
        let base = book.paper_minimap();
        let landmark_id = base.landmarks[0].landmark_id.clone();
        let region_id = base.regions[0].region_id.clone();
        let proposal = match reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::Agent,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SetModeLens {
                        mode: PaperMinimapMode::Deep,
                    },
                )],
                "suggest deep",
                Vec::new(),
                None,
                "t1",
            )
            .unwrap()
        {
            PaperMinimapApplyOutcome::Proposal { proposal } => proposal,
            _ => panic!("expected proposal"),
        };
        reader
            .apply_paper_minimap_commands(
                &book,
                0,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::FocusLandmark {
                        landmark_id: landmark_id.clone(),
                    },
                )],
                "focus landmark",
                Vec::new(),
                None,
                "t2",
            )
            .unwrap();
        let stale = reader
            .apply_paper_minimap_proposal(
                &book,
                &proposal.proposal_id,
                &proposal.base_map_rev,
                proposal.base_state_rev,
                "t3",
            )
            .unwrap_err();
        assert_eq!(stale.error_code, "PAPER_MINIMAP_PROPOSAL_STALE");

        let bad_id = reader
            .apply_paper_minimap_commands(
                &book,
                1,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::FocusLandmark {
                        landmark_id: "missing".into(),
                    },
                )],
                "bad id",
                Vec::new(),
                None,
                "t4",
            )
            .unwrap_err();
        assert_eq!(bad_id.error_code, "PAPER_MINIMAP_LANDMARK_NOT_FOUND");

        let bad_grammar = reader
            .apply_paper_minimap_commands(
                &book,
                1,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::SelectLocalProjection {
                        region_id,
                        grammar: PaperRegionKind::Method,
                        focus_slots: vec![PaperArgumentSlot::Method],
                    },
                )],
                "bad grammar",
                Vec::new(),
                None,
                "t5",
            )
            .unwrap_err();
        assert_eq!(bad_grammar.error_code, "INVALID_PAPER_MINIMAP_GRAMMAR");

        let over_budget = reader
            .apply_paper_minimap_commands(
                &book,
                1,
                PaperMinimapActor::User,
                vec![PaperMinimapCommand::Session(
                    PaperMinimapAction::EmphasizeLandmarks {
                        landmark_ids: vec![landmark_id; 6],
                        reason: "too many".into(),
                    },
                )],
                "over budget",
                Vec::new(),
                None,
                "t6",
            )
            .unwrap_err();
        assert_eq!(over_budget.error_code, "INVALID_PAPER_MINIMAP_ACTION");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_reader_contract_round_trips_commands_and_outcome() {
        let before = minimap_state();
        let mut after = before.clone();
        after.rev = 4;
        after.presentation = PaperMinimapPresentation::Expanded;
        let command = PaperMinimapCommand::Session(PaperMinimapAction::SetPresentation {
            presentation: PaperMinimapPresentation::Expanded,
        });
        let effect = PaperMinimapEffect {
            effect_id: "minimap-effect-1".into(),
            base_map_rev: before.base_map_rev.clone(),
            before_state_rev: before.rev,
            after_state_rev: after.rev,
            trigger_turn_id: None,
            actions: vec![command],
            reason: "user opened minimap".into(),
            evidence_lids: Vec::new(),
            created_at: "2026-07-12T12:00:00Z".into(),
            before,
            after,
        };
        let outcome = PaperMinimapApplyOutcome::Effect { effect };

        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["kind"], "effect");
        assert_eq!(value["effect"]["actions"][0]["scope"], "session");
        assert_eq!(
            value["effect"]["actions"][0]["action"]["kind"],
            "set_presentation"
        );
        assert_eq!(
            serde_json::from_value::<PaperMinimapApplyOutcome>(value).unwrap(),
            outcome
        );
    }

    #[test]
    fn paper_minimap_saved_actions_are_proposal_safe_and_closed() {
        let command = PaperMinimapCommand::Saved(SavedUserOverlayAction::SetLandmarkOverride {
            target_landmark_id: "landmark:claim".into(),
            operation: UserLandmarkOverrideOperation::Rename,
            label: Some("我关注的主张".into()),
            user_reason: Some("user correction".into()),
        });
        let proposal = PaperMinimapProposal {
            proposal_id: "minimap-proposal-1".into(),
            base_map_rev: "fp-a".into(),
            base_state_rev: 3,
            actions: vec![command],
            summary: "保存个人地标标签".into(),
        };
        let value = serde_json::to_value(&proposal).unwrap();
        assert_eq!(value["actions"][0]["scope"], "saved");
        assert_eq!(value["actions"][0]["action"]["operation"], "rename");
        assert_eq!(
            serde_json::from_value::<PaperMinimapProposal>(value).unwrap(),
            proposal
        );

        let unknown_action = serde_json::json!({"kind": "draw_arbitrary_graph"});
        assert!(serde_json::from_value::<PaperMinimapAction>(unknown_action).is_err());
        let missing_target = serde_json::json!({
            "kind": "set_landmark_override",
            "operation": "hide",
            "label": null,
            "user_reason": null
        });
        assert!(serde_json::from_value::<SavedUserOverlayAction>(missing_target).is_err());
    }
}
