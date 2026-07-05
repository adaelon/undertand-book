//! 读时确定性叶子工具(切片0:manifest/text;context/concept 见 S4c)`[ADR-0014]`。
//! 消费冻结只读基座 `base.json` + 旁路原文 `source.txt`(UTF-16 span 口径 `[ADR-0024]`)。
//! 纯函数库,无 LLM、provider 无关;HTTP 暴露推 S7。
use base_schema::{
    Direction, EdgeScope, FormulaSemantics, GraphNodeType, LidNode, NodeKind, ReadOnlyBase, Span,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    book_structure: Option<BookStructureSidecar>,
    paper_metadata: Option<PaperMetadataSidecar>,
    paper_lexicon: Option<PaperLexiconSidecar>,
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileArtifactHeader {
    pub book_id: String,
    pub book_version: String,
    pub profile_id: String,
    pub profile_version: String,
    pub core_schema_version: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct AnchoredText {
    pub text: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum BookStructureSpineRole {
    Setup,
    Foundation,
    Method,
    Application,
    Case,
    Synthesis,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum BookStructureKeyStopType {
    Definition,
    Formula,
    Claim,
    Example,
    TurningPoint,
    Warning,
    Summary,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookStructureKeyStop {
    pub id: String,
    pub lid: String,
    #[serde(rename = "type")]
    pub stop_type: BookStructureKeyStopType,
    pub title: Option<String>,
    pub reason: AnchoredText,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookStructureSpineUnit {
    pub lid: String,
    pub role: BookStructureSpineRole,
    pub summary: AnchoredText,
    pub key_stop_ids: Vec<String>,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookStructureThroughline {
    pub id: String,
    pub name: String,
    pub summary: AnchoredText,
    pub lids: Vec<String>,
    pub key_stop_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookStructureSidecar {
    pub header: ProfileArtifactHeader,
    pub spine: Vec<BookStructureSpineUnit>,
    pub throughlines: Vec<BookStructureThroughline>,
    pub key_stops: Vec<BookStructureKeyStop>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct StructureProjection {
    pub available: bool,
    pub at: Option<String>,
    pub spine_index: Option<usize>,
    pub spine_unit: Option<BookStructureSpineUnit>,
    pub key_stops: Vec<BookStructureKeyStop>,
    pub throughlines: Vec<BookStructureThroughline>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct GuidePathSegment {
    pub spine_index: usize,
    pub spine_unit: BookStructureSpineUnit,
    pub key_stops: Vec<BookStructureKeyStop>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct GuidePath {
    pub available: bool,
    pub at: Option<String>,
    pub current_segment_index: Option<usize>,
    pub segments: Vec<GuidePathSegment>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct MetadataField<T> {
    pub value: T,
    pub source: String,
    #[serde(default)]
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperAuthor {
    pub name: String,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperReference {
    pub raw: String,
    pub identifiers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
pub struct PaperMetadataIdentifiers {
    pub doi: Option<MetadataField<String>>,
    pub arxiv: Option<MetadataField<String>>,
    pub url: Option<MetadataField<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PaperMetadataSidecar {
    pub header: ProfileArtifactHeader,
    pub title: Option<MetadataField<String>>,
    pub authors: Option<MetadataField<Vec<PaperAuthor>>>,
    pub affiliations: Option<MetadataField<Vec<String>>>,
    pub venue: Option<MetadataField<String>>,
    pub year: Option<MetadataField<i64>>,
    pub identifiers: Option<PaperMetadataIdentifiers>,
    pub keywords: Option<MetadataField<Vec<String>>>,
    pub field_labels: Option<MetadataField<Vec<String>>>,
    pub references: Option<MetadataField<Vec<PaperReference>>>,
    pub datasets: Option<MetadataField<Vec<String>>>,
    pub code_links: Option<MetadataField<Vec<String>>>,
    pub funding: Option<MetadataField<Vec<String>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PaperLexiconSidecar {
    pub header: ProfileArtifactHeader,
    pub entries: Vec<PaperLexiconEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PaperLexiconEntry {
    pub term: String,
    pub term_type: String,
    #[serde(default)]
    pub occurrences_lids: Vec<String>,
    pub defined_at_lid: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub acronym_expansion: Option<String>,
    pub chinese_gloss: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperReadingMode {
    Skim,
    Close,
    Deep,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperReadingStage {
    Passive,
    Active,
    Critical,
    Creative,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperReadingAnswerSlotKind {
    PaperEvidence,
    ModelSupplement,
    UserReflection,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperReadingAnswerSlot {
    pub kind: PaperReadingAnswerSlotKind,
    pub label: String,
    pub instruction: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperReadingQuestion {
    pub id: String,
    pub question: String,
    pub focus: String,
    pub evidence_lids: Vec<String>,
    pub answer_slots: Vec<PaperReadingAnswerSlot>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperCodebookMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub venue: Option<String>,
    pub year: Option<i64>,
    pub doi: Option<String>,
    pub arxiv: Option<String>,
    pub url: Option<String>,
    pub keywords: Vec<String>,
    pub field_labels: Vec<String>,
    pub datasets: Vec<String>,
    pub code_links: Vec<String>,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperCodebookTerm {
    pub term: String,
    pub term_type: String,
    pub evidence_lids: Vec<String>,
    pub defined_at_lid: Option<String>,
    pub aliases: Vec<String>,
    pub acronym_expansion: Option<String>,
    pub chinese_gloss: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperCodebookStructureItem {
    pub id: String,
    pub lid: String,
    pub title: Option<String>,
    pub summary: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperCodebook {
    pub available: bool,
    pub metadata: PaperCodebookMetadata,
    pub terms: Vec<PaperCodebookTerm>,
    pub throughlines: Vec<PaperCodebookStructureItem>,
    pub key_stops: Vec<PaperCodebookStructureItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperAbstractExcerpt {
    pub lid: String,
    pub text: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperAbstractCheck {
    pub id: String,
    pub prompt: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct AbstractReadingAid {
    pub available: bool,
    pub abstract_lids: Vec<String>,
    pub excerpts: Vec<PaperAbstractExcerpt>,
    pub key_terms: Vec<PaperCodebookTerm>,
    pub comprehension_checks: Vec<PaperAbstractCheck>,
    pub user_reflection_prompt: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperReadingGuide {
    pub available: bool,
    pub mode: PaperReadingMode,
    pub stage: PaperReadingStage,
    pub questions: Vec<PaperReadingQuestion>,
    pub codebook: PaperCodebook,
    pub abstract_aid: AbstractReadingAid,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataStringField {
    pub value: String,
    pub source: String,
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataStringListField {
    pub value: Vec<String>,
    pub source: String,
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataNumberField {
    pub value: i64,
    pub source: String,
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataAuthorsField {
    pub value: Vec<PaperAuthor>,
    pub source: String,
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataReferencesField {
    pub value: Vec<PaperReference>,
    pub source: String,
    pub evidence_lids: Vec<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataIdentifiersProjection {
    pub doi: Option<PaperMetadataStringField>,
    pub arxiv: Option<PaperMetadataStringField>,
    pub url: Option<PaperMetadataStringField>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMetadataProjection {
    pub available: bool,
    pub header: Option<ProfileArtifactHeader>,
    pub title: Option<PaperMetadataStringField>,
    pub authors: Option<PaperMetadataAuthorsField>,
    pub affiliations: Option<PaperMetadataStringListField>,
    pub venue: Option<PaperMetadataStringField>,
    pub year: Option<PaperMetadataNumberField>,
    pub identifiers: Option<PaperMetadataIdentifiersProjection>,
    pub keywords: Option<PaperMetadataStringListField>,
    pub field_labels: Option<PaperMetadataStringListField>,
    pub references: Option<PaperMetadataReferencesField>,
    pub datasets: Option<PaperMetadataStringListField>,
    pub code_links: Option<PaperMetadataStringListField>,
    pub funding: Option<PaperMetadataStringListField>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperLexiconProjection {
    pub available: bool,
    pub header: Option<ProfileArtifactHeader>,
    pub entries: Vec<PaperCodebookTerm>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ContentProfileId {
    TechnicalLearning,
    Paper,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ProjectionKind {
    ReadingGuide,
    Metadata,
    Lexicon,
    Structure,
    Route,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProjectionSpec {
    pub id: String,
    pub kind: ProjectionKind,
    pub endpoint: String,
    pub runtime_tool: Option<String>,
    pub mcp_tool: Option<String>,
    pub ts_type: String,
    pub required: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum UiSlotKind {
    Map,
    Agent,
    Evidence,
    Codebook,
    Aid,
    Questions,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum LayoutRegion {
    Left,
    Center,
    Right,
    Bottom,
    Overlay,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ReaderLayoutActionKind {
    OpenSlot,
    CloseSlot,
    FocusSlot,
    SetActiveTab,
    PinEvidence,
    UnpinEvidence,
    SetPanelSize,
    ReorderSlot,
    SetLayoutPreset,
    ResetLayout,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct UiSlotSpec {
    pub id: String,
    pub title: String,
    pub kind: UiSlotKind,
    pub primary_projection: Option<String>,
    pub secondary_projections: Vec<String>,
    pub allowed_actions: Vec<ReaderLayoutActionKind>,
    pub default_region: LayoutRegion,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum LayoutSizeKind {
    Px,
    Fr,
    Percent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct LayoutSize {
    pub kind: LayoutSizeKind,
    pub value: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct LayoutPresetSlot {
    pub slot_id: String,
    pub region: LayoutRegion,
    pub order: u32,
    pub size: Option<LayoutSize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct LayoutPresetSpec {
    pub id: String,
    pub title: String,
    pub description: String,
    pub slots: Vec<LayoutPresetSlot>,
    pub focused_slot: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct AgentToolSpec {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct GuidedReadingPolicySpec {
    pub route_tool: String,
    pub default_mode: Option<String>,
    pub default_stage: Option<String>,
    pub preferred_slot_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileDefaults {
    pub layout_preset: Option<String>,
    pub open_slots: Vec<String>,
    pub focused_slot: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileManifest {
    pub profile_id: ContentProfileId,
    pub profile_version: String,
    pub projections: Vec<ProjectionSpec>,
    pub ui_slots: Vec<UiSlotSpec>,
    pub layout_presets: Vec<LayoutPresetSpec>,
    pub allowed_layout_actions: Vec<ReaderLayoutActionKind>,
    pub agent_tools: Vec<AgentToolSpec>,
    pub guided_reading_policy: GuidedReadingPolicySpec,
    pub defaults: ProfileDefaults,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ProfileSummary {
    pub profile_id: ContentProfileId,
    pub profile_version: String,
    pub ui_slots: Vec<String>,
    pub layout_presets: Vec<String>,
    pub allowed_layout_actions: Vec<ReaderLayoutActionKind>,
    pub agent_tools: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PinnedEvidence {
    pub slot_id: String,
    pub lid: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ReaderLayoutState {
    pub rev: u64,
    pub active_preset: Option<String>,
    pub open_slots: Vec<String>,
    pub focused_slot: Option<String>,
    pub pinned_evidence: Vec<PinnedEvidence>,
    pub panel_sizes: HashMap<String, LayoutSize>,
    pub slot_order: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ReaderLayoutAction {
    OpenSlot {
        slot_id: String,
        region: Option<LayoutRegion>,
    },
    CloseSlot {
        slot_id: String,
    },
    FocusSlot {
        slot_id: String,
    },
    SetActiveTab {
        slot_id: String,
        tab_id: String,
    },
    PinEvidence {
        slot_id: String,
        lid: String,
        reason: Option<String>,
    },
    UnpinEvidence {
        slot_id: String,
        lid: String,
    },
    SetPanelSize {
        slot_id: String,
        size: LayoutSize,
    },
    ReorderSlot {
        region: LayoutRegion,
        slot_ids: Vec<String>,
    },
    SetLayoutPreset {
        preset_id: String,
    },
    ResetLayout {},
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ReaderLayoutEffect {
    pub before: ReaderLayoutState,
    pub after: ReaderLayoutState,
    pub actions: Vec<ReaderLayoutAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ReaderLayoutProposal {
    pub proposal_id: String,
    pub base_layout_rev: u64,
    pub actions: Vec<ReaderLayoutAction>,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ReaderLayoutApplyOutcome {
    Effect { effect: ReaderLayoutEffect },
    Proposal { proposal: ReaderLayoutProposal },
}

pub const TECHNICAL_LEARNING_PROFILE_VERSION: &str = "technical_learning_v0";
pub const PAPER_PROFILE_VERSION: &str = "paper_v0";

fn all_layout_actions() -> Vec<ReaderLayoutActionKind> {
    vec![
        ReaderLayoutActionKind::OpenSlot,
        ReaderLayoutActionKind::CloseSlot,
        ReaderLayoutActionKind::FocusSlot,
        ReaderLayoutActionKind::SetActiveTab,
        ReaderLayoutActionKind::PinEvidence,
        ReaderLayoutActionKind::UnpinEvidence,
        ReaderLayoutActionKind::SetPanelSize,
        ReaderLayoutActionKind::ReorderSlot,
        ReaderLayoutActionKind::SetLayoutPreset,
        ReaderLayoutActionKind::ResetLayout,
    ]
}

fn low_risk_layout_actions() -> Vec<ReaderLayoutActionKind> {
    vec![
        ReaderLayoutActionKind::OpenSlot,
        ReaderLayoutActionKind::FocusSlot,
        ReaderLayoutActionKind::SetActiveTab,
        ReaderLayoutActionKind::PinEvidence,
        ReaderLayoutActionKind::UnpinEvidence,
        ReaderLayoutActionKind::SetPanelSize,
    ]
}

fn profile_summary(manifest: &ProfileManifest) -> ProfileSummary {
    ProfileSummary {
        profile_id: manifest.profile_id.clone(),
        profile_version: manifest.profile_version.clone(),
        ui_slots: manifest
            .ui_slots
            .iter()
            .map(|slot| slot.id.clone())
            .collect(),
        layout_presets: manifest
            .layout_presets
            .iter()
            .map(|preset| preset.id.clone())
            .collect(),
        allowed_layout_actions: manifest.allowed_layout_actions.clone(),
        agent_tools: manifest
            .agent_tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect(),
    }
}

pub fn technical_learning_profile_manifest() -> ProfileManifest {
    let allowed = all_layout_actions();
    ProfileManifest {
        profile_id: ContentProfileId::TechnicalLearning,
        profile_version: TECHNICAL_LEARNING_PROFILE_VERSION.into(),
        projections: vec![
            ProjectionSpec {
                id: "book.structure".into(),
                kind: ProjectionKind::Structure,
                endpoint: "/book/structure".into(),
                runtime_tool: Some("book.structure".into()),
                mcp_tool: Some("book_structure".into()),
                ts_type: "StructureProjection".into(),
                required: false,
            },
            ProjectionSpec {
                id: "book.guide_path".into(),
                kind: ProjectionKind::Route,
                endpoint: "/book/guide_path".into(),
                runtime_tool: Some("book.guide_path".into()),
                mcp_tool: Some("book_guide_path".into()),
                ts_type: "GuidePath".into(),
                required: false,
            },
        ],
        ui_slots: vec![
            UiSlotSpec {
                id: "technical.structure_map".into(),
                title: "Structure map".into(),
                kind: UiSlotKind::Map,
                primary_projection: Some("book.structure".into()),
                secondary_projections: vec!["book.guide_path".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Left,
            },
            UiSlotSpec {
                id: "technical.agent".into(),
                title: "Agent".into(),
                kind: UiSlotKind::Agent,
                primary_projection: None,
                secondary_projections: vec![],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Right,
            },
            UiSlotSpec {
                id: "technical.evidence".into(),
                title: "Evidence".into(),
                kind: UiSlotKind::Evidence,
                primary_projection: None,
                secondary_projections: vec![],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Right,
            },
        ],
        layout_presets: vec![LayoutPresetSpec {
            id: "technical_read".into(),
            title: "Technical read".into(),
            description: "Default technical reading workspace.".into(),
            slots: vec![
                LayoutPresetSlot {
                    slot_id: "technical.structure_map".into(),
                    region: LayoutRegion::Left,
                    order: 0,
                    size: Some(LayoutSize {
                        kind: LayoutSizeKind::Percent,
                        value: 24.0,
                    }),
                },
                LayoutPresetSlot {
                    slot_id: "technical.agent".into(),
                    region: LayoutRegion::Right,
                    order: 0,
                    size: Some(LayoutSize {
                        kind: LayoutSizeKind::Percent,
                        value: 30.0,
                    }),
                },
            ],
            focused_slot: Some("technical.agent".into()),
        }],
        allowed_layout_actions: allowed,
        agent_tools: vec![AgentToolSpec {
            name: "reader.layout.apply".into(),
            description: "Apply validated reader layout actions.".into(),
        }],
        guided_reading_policy: GuidedReadingPolicySpec {
            route_tool: "book.guided_route_from".into(),
            default_mode: None,
            default_stage: None,
            preferred_slot_ids: vec!["technical.structure_map".into(), "technical.agent".into()],
        },
        defaults: ProfileDefaults {
            layout_preset: Some("technical_read".into()),
            open_slots: vec!["technical.structure_map".into(), "technical.agent".into()],
            focused_slot: Some("technical.agent".into()),
        },
    }
}

pub fn paper_profile_manifest() -> ProfileManifest {
    let allowed = all_layout_actions();
    ProfileManifest {
        profile_id: ContentProfileId::Paper,
        profile_version: PAPER_PROFILE_VERSION.into(),
        projections: vec![
            ProjectionSpec {
                id: "paper.reading_guide".into(),
                kind: ProjectionKind::ReadingGuide,
                endpoint: "/book/paper_reading_guide".into(),
                runtime_tool: Some("book.paper_reading_guide".into()),
                mcp_tool: Some("book_paper_reading_guide".into()),
                ts_type: "PaperReadingGuide".into(),
                required: false,
            },
            ProjectionSpec {
                id: "paper.metadata".into(),
                kind: ProjectionKind::Metadata,
                endpoint: "/book/paper_metadata".into(),
                runtime_tool: Some("book.paper_metadata".into()),
                mcp_tool: Some("book_paper_metadata".into()),
                ts_type: "PaperMetadataProjection".into(),
                required: false,
            },
            ProjectionSpec {
                id: "paper.lexicon".into(),
                kind: ProjectionKind::Lexicon,
                endpoint: "/book/paper_lexicon".into(),
                runtime_tool: Some("book.paper_lexicon".into()),
                mcp_tool: Some("book_paper_lexicon".into()),
                ts_type: "PaperLexiconProjection".into(),
                required: false,
            },
            ProjectionSpec {
                id: "book.structure".into(),
                kind: ProjectionKind::Structure,
                endpoint: "/book/structure".into(),
                runtime_tool: Some("book.structure".into()),
                mcp_tool: Some("book_structure".into()),
                ts_type: "StructureProjection".into(),
                required: false,
            },
        ],
        ui_slots: vec![
            UiSlotSpec {
                id: "paper.structure_map".into(),
                title: "Paper structure map".into(),
                kind: UiSlotKind::Map,
                primary_projection: Some("paper.reading_guide".into()),
                secondary_projections: vec!["book.structure".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Left,
            },
            UiSlotSpec {
                id: "paper.agent".into(),
                title: "Paper agent".into(),
                kind: UiSlotKind::Agent,
                primary_projection: Some("paper.reading_guide".into()),
                secondary_projections: vec![],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Right,
            },
            UiSlotSpec {
                id: "paper.evidence".into(),
                title: "Evidence".into(),
                kind: UiSlotKind::Evidence,
                primary_projection: None,
                secondary_projections: vec!["paper.reading_guide".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Right,
            },
            UiSlotSpec {
                id: "paper.codebook".into(),
                title: "Codebook".into(),
                kind: UiSlotKind::Codebook,
                primary_projection: Some("paper.lexicon".into()),
                secondary_projections: vec!["paper.metadata".into(), "paper.reading_guide".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Bottom,
            },
            UiSlotSpec {
                id: "paper.abstract_aid".into(),
                title: "Abstract aid".into(),
                kind: UiSlotKind::Aid,
                primary_projection: Some("paper.reading_guide".into()),
                secondary_projections: vec!["paper.lexicon".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Bottom,
            },
            UiSlotSpec {
                id: "paper.ten_questions".into(),
                title: "Ten questions".into(),
                kind: UiSlotKind::Questions,
                primary_projection: Some("paper.reading_guide".into()),
                secondary_projections: vec!["paper.metadata".into(), "paper.lexicon".into()],
                allowed_actions: low_risk_layout_actions(),
                default_region: LayoutRegion::Right,
            },
        ],
        layout_presets: vec![
            LayoutPresetSpec {
                id: "paper_skim".into(),
                title: "Paper skim".into(),
                description: "Open structure, agent, and evidence for first-pass reading.".into(),
                slots: vec![
                    LayoutPresetSlot {
                        slot_id: "paper.structure_map".into(),
                        region: LayoutRegion::Left,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 26.0,
                        }),
                    },
                    LayoutPresetSlot {
                        slot_id: "paper.agent".into(),
                        region: LayoutRegion::Right,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 30.0,
                        }),
                    },
                ],
                focused_slot: Some("paper.structure_map".into()),
            },
            LayoutPresetSpec {
                id: "paper_abstract".into(),
                title: "Paper abstract".into(),
                description: "Focus the abstract aid and codebook.".into(),
                slots: vec![
                    LayoutPresetSlot {
                        slot_id: "paper.abstract_aid".into(),
                        region: LayoutRegion::Bottom,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 34.0,
                        }),
                    },
                    LayoutPresetSlot {
                        slot_id: "paper.codebook".into(),
                        region: LayoutRegion::Right,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 28.0,
                        }),
                    },
                ],
                focused_slot: Some("paper.abstract_aid".into()),
            },
            LayoutPresetSpec {
                id: "paper_deep_read".into(),
                title: "Paper deep read".into(),
                description: "Open structure, questions, evidence, and codebook.".into(),
                slots: vec![
                    LayoutPresetSlot {
                        slot_id: "paper.structure_map".into(),
                        region: LayoutRegion::Left,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 24.0,
                        }),
                    },
                    LayoutPresetSlot {
                        slot_id: "paper.ten_questions".into(),
                        region: LayoutRegion::Right,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 32.0,
                        }),
                    },
                    LayoutPresetSlot {
                        slot_id: "paper.codebook".into(),
                        region: LayoutRegion::Bottom,
                        order: 0,
                        size: Some(LayoutSize {
                            kind: LayoutSizeKind::Percent,
                            value: 30.0,
                        }),
                    },
                ],
                focused_slot: Some("paper.ten_questions".into()),
            },
        ],
        allowed_layout_actions: allowed,
        agent_tools: vec![
            AgentToolSpec {
                name: "reader.layout.apply".into(),
                description: "Apply validated reader layout actions.".into(),
            },
            AgentToolSpec {
                name: "book.paper_reading_guide".into(),
                description: "Read the paper guide projection.".into(),
            },
            AgentToolSpec {
                name: "book.paper_metadata".into(),
                description: "Read the single-paper metadata projection.".into(),
            },
            AgentToolSpec {
                name: "book.paper_lexicon".into(),
                description: "Read the single-paper lexicon projection.".into(),
            },
        ],
        guided_reading_policy: GuidedReadingPolicySpec {
            route_tool: "book.guided_route_from".into(),
            default_mode: Some("skim".into()),
            default_stage: Some("passive".into()),
            preferred_slot_ids: vec![
                "paper.structure_map".into(),
                "paper.agent".into(),
                "paper.evidence".into(),
            ],
        },
        defaults: ProfileDefaults {
            layout_preset: Some("paper_skim".into()),
            open_slots: vec![
                "paper.structure_map".into(),
                "paper.agent".into(),
                "paper.evidence".into(),
            ],
            focused_slot: Some("paper.structure_map".into()),
        },
    }
}

pub fn profile_manifest_for_id(profile_id: ContentProfileId) -> ProfileManifest {
    match profile_id {
        ContentProfileId::TechnicalLearning => technical_learning_profile_manifest(),
        ContentProfileId::Paper => paper_profile_manifest(),
    }
}

pub fn parse_content_profile_id(raw: &str) -> Result<ContentProfileId, ToolError> {
    match raw {
        "technical_learning" => Ok(ContentProfileId::TechnicalLearning),
        "paper" => Ok(ContentProfileId::Paper),
        other => Err(ToolError {
            error_code: "PROFILE_NOT_FOUND".into(),
            category: "not_found".into(),
            message: format!("未知 content profile: {other}"),
        }),
    }
}

/// context 默认 top-K(占位,待 P1 实测回填 ADR-0013/0016「何时回头」)。
pub const DEFAULT_NEAR_K: usize = 10;
/// route_from 每类前沿默认 top-K(沿用 context 截断惯例 `[ADR-0034 影响段]`)。
pub const DEFAULT_ROUTE_K: usize = DEFAULT_NEAR_K;
/// route_to BFS 默认跳数预算(占位,实测回填 `[ADR-0034 决策3 路径式预算全程]`)。
pub const DEFAULT_ROUTE_HOPS: usize = 8;
/// 概念共现步的占位权重(Via::Concept 无 weight;实测回填 `[ADR-0034 何时回头]`)。
const CONCEPT_COOCCURRENCE_WEIGHT: f32 = 0.5;

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

/// route 导航类别(ADR-0034 决策5):`edge_type` 经固定确定性映射归入这 5 类之一 `[ADR-0034]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum NavCategory {
    /// 前置/背景:prerequisite, depends_on
    Back,
    /// 深入/承接:builds_on, refines, elaborates, explains, prepares, causes, results_in
    Forward,
    /// 例证/具体:exemplifies, applies, answers
    Concretize,
    /// 关联/跨章:long_range(analogous/contrasts/supports…)+ 概念共现 + 未知 local 兜底
    Cross,
    /// 顺读:next_sibling(阅读序)、discourse continues
    Continue,
}

/// route_from 前沿的一个排序步:纯坐标 + 结构排序分,不带原文(消费方走 `book.text`)`[ADR-0034]`。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct RankedStep {
    /// 真实 LID。
    pub lid: String,
    /// 真实边类型(local / long_range edge_type、discourse relation_type、co_occurrence、next_sibling)。
    pub edge_type: String,
    /// 来自哪条边的导航理由(人可读)。
    pub why: String,
    /// 证据 LID(discourse 取 relation.evidence_lids;其余取 [anchor, step] 两端真 LID)。
    pub evidence_lids: Vec<String>,
    /// 结构排序分 = weight /(1 + 树距)(占位口径,实测回填 `[ADR-0034 何时回头]`)。
    pub score: f32,
}

/// book.route_from 返回:按导航语义分的 5 类前沿(永远返全 5 类,无 category 过滤)`[ADR-0034 决策5]`。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Frontier {
    pub back: Vec<RankedStep>,
    pub forward: Vec<RankedStep>,
    pub concretize: Vec<RankedStep>,
    pub cross: Vec<RankedStep>,
    #[serde(rename = "continue")]
    #[ts(rename = "continue")]
    pub continue_: Vec<RankedStep>,
}

/// book.concept() 返回结构(全量 occurrences 不截断)`[ADR-0014]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Concept {
    pub name: String,
    pub occurrences: Vec<String>,
    pub related_entities: Vec<String>,
}

fn parse_formula_semantics_sidecar(s: &str) -> Result<Vec<FormulaSemantics>, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(s)?;
    if value.is_array() {
        return serde_json::from_value(value);
    }

    #[derive(Deserialize)]
    struct HeaderedFormulaSemanticsSidecar {
        #[allow(dead_code)]
        header: serde_json::Value,
        items: Vec<FormulaSemantics>,
    }

    let sidecar: HeaderedFormulaSemanticsSidecar = serde_json::from_value(value)?;
    Ok(sidecar.items)
}

fn parse_book_structure_sidecar(
    s: &str,
    base: &ReadOnlyBase,
) -> Result<BookStructureSidecar, String> {
    let sidecar: BookStructureSidecar =
        serde_json::from_str(s).map_err(|e| format!("解析 book_structure.json 失败: {e}"))?;
    validate_book_structure_sidecar(&sidecar, base)?;
    Ok(sidecar)
}

fn parse_paper_metadata_sidecar(
    s: &str,
    base: &ReadOnlyBase,
) -> Result<PaperMetadataSidecar, String> {
    let sidecar: PaperMetadataSidecar =
        serde_json::from_str(s).map_err(|e| format!("解析 paper_metadata.json 失败: {e}"))?;
    validate_paper_metadata_sidecar(&sidecar, base)?;
    Ok(sidecar)
}

fn parse_paper_lexicon_sidecar(
    s: &str,
    base: &ReadOnlyBase,
) -> Result<PaperLexiconSidecar, String> {
    let sidecar: PaperLexiconSidecar =
        serde_json::from_str(s).map_err(|e| format!("解析 paper_lexicon.json 失败: {e}"))?;
    validate_paper_lexicon_sidecar(&sidecar, base)?;
    Ok(sidecar)
}

fn validate_anchored_text(
    owner: &str,
    text: &AnchoredText,
    lids: &HashSet<String>,
) -> Result<(), String> {
    if text.text.trim().is_empty() {
        return Err(format!("{owner} 文本为空"));
    }
    if text.evidence_lids.is_empty() {
        return Err(format!("{owner} 缺 evidence_lids"));
    }
    for lid in &text.evidence_lids {
        if !lids.contains(lid) {
            return Err(format!("{owner} evidence_lids 含不存在 LID: {lid}"));
        }
    }
    Ok(())
}

fn validate_book_structure_sidecar(
    sidecar: &BookStructureSidecar,
    base: &ReadOnlyBase,
) -> Result<(), String> {
    let lids: HashSet<String> = base.lid_nodes.iter().map(|n| n.lid.clone()).collect();
    let mut key_stop_ids = HashSet::new();
    for stop in &sidecar.key_stops {
        if stop.id.trim().is_empty() {
            return Err("book_structure key_stop id 为空".into());
        }
        if !key_stop_ids.insert(stop.id.clone()) {
            return Err(format!("book_structure key_stop id 重复: {}", stop.id));
        }
        if !lids.contains(&stop.lid) {
            return Err(format!(
                "book_structure key_stop {} 指向不存在 LID: {}",
                stop.id, stop.lid
            ));
        }
        validate_anchored_text(
            &format!("book_structure key_stop {}", stop.id),
            &stop.reason,
            &lids,
        )?;
    }

    for unit in &sidecar.spine {
        if !lids.contains(&unit.lid) {
            return Err(format!("book_structure spine 指向不存在 LID: {}", unit.lid));
        }
        validate_anchored_text(
            &format!("book_structure spine {}", unit.lid),
            &unit.summary,
            &lids,
        )?;
        for id in &unit.key_stop_ids {
            if !key_stop_ids.contains(id) {
                return Err(format!(
                    "book_structure spine {} 引用不存在 key_stop: {id}",
                    unit.lid
                ));
            }
        }
        for lid in &unit.depends_on {
            if !lids.contains(lid) {
                return Err(format!(
                    "book_structure spine {} depends_on 不存在 LID: {lid}",
                    unit.lid
                ));
            }
        }
    }

    let mut thread_ids = HashSet::new();
    for thread in &sidecar.throughlines {
        if thread.id.trim().is_empty() {
            return Err("book_structure throughline id 为空".into());
        }
        if !thread_ids.insert(thread.id.clone()) {
            return Err(format!("book_structure throughline id 重复: {}", thread.id));
        }
        if thread.name.trim().is_empty() {
            return Err(format!(
                "book_structure throughline {} name 为空",
                thread.id
            ));
        }
        validate_anchored_text(
            &format!("book_structure throughline {}", thread.id),
            &thread.summary,
            &lids,
        )?;
        if thread.lids.is_empty() {
            return Err(format!("book_structure throughline {} 缺 lids", thread.id));
        }
        for lid in &thread.lids {
            if !lids.contains(lid) {
                return Err(format!(
                    "book_structure throughline {} 引用不存在 LID: {lid}",
                    thread.id
                ));
            }
        }
        for id in &thread.key_stop_ids {
            if !key_stop_ids.contains(id) {
                return Err(format!(
                    "book_structure throughline {} 引用不存在 key_stop: {id}",
                    thread.id
                ));
            }
        }
    }
    Ok(())
}

fn validate_metadata_field<T>(
    field_name: &str,
    field: &MetadataField<T>,
    lids: &HashSet<String>,
) -> Result<(), String> {
    if matches!(field.source.as_str(), "front_matter" | "paper_text")
        && field.evidence_lids.is_empty()
    {
        return Err(format!("paper_metadata {field_name}.evidence_lids 缺失"));
    }
    for lid in &field.evidence_lids {
        if !lids.contains(lid) {
            return Err(format!(
                "paper_metadata {field_name}.evidence_lids 含不存在 LID: {lid}"
            ));
        }
    }
    if let Some(confidence) = field.confidence {
        if !(0.0..=1.0).contains(&confidence) {
            return Err(format!("paper_metadata {field_name}.confidence 不在 0..1"));
        }
    }
    Ok(())
}

fn validate_paper_metadata_sidecar(
    sidecar: &PaperMetadataSidecar,
    base: &ReadOnlyBase,
) -> Result<(), String> {
    let lids: HashSet<String> = base.lid_nodes.iter().map(|n| n.lid.clone()).collect();
    if let Some(field) = &sidecar.title {
        validate_metadata_field("title", field, &lids)?;
    }
    if let Some(field) = &sidecar.authors {
        validate_metadata_field("authors", field, &lids)?;
    }
    if let Some(field) = &sidecar.affiliations {
        validate_metadata_field("affiliations", field, &lids)?;
    }
    if let Some(field) = &sidecar.venue {
        validate_metadata_field("venue", field, &lids)?;
    }
    if let Some(field) = &sidecar.year {
        validate_metadata_field("year", field, &lids)?;
    }
    if let Some(identifiers) = &sidecar.identifiers {
        if let Some(field) = &identifiers.doi {
            validate_metadata_field("identifiers.doi", field, &lids)?;
        }
        if let Some(field) = &identifiers.arxiv {
            validate_metadata_field("identifiers.arxiv", field, &lids)?;
        }
        if let Some(field) = &identifiers.url {
            validate_metadata_field("identifiers.url", field, &lids)?;
        }
    }
    if let Some(field) = &sidecar.keywords {
        validate_metadata_field("keywords", field, &lids)?;
    }
    if let Some(field) = &sidecar.field_labels {
        validate_metadata_field("field_labels", field, &lids)?;
    }
    if let Some(field) = &sidecar.references {
        validate_metadata_field("references", field, &lids)?;
    }
    if let Some(field) = &sidecar.datasets {
        validate_metadata_field("datasets", field, &lids)?;
    }
    if let Some(field) = &sidecar.code_links {
        validate_metadata_field("code_links", field, &lids)?;
    }
    if let Some(field) = &sidecar.funding {
        validate_metadata_field("funding", field, &lids)?;
    }
    Ok(())
}

fn validate_paper_lexicon_sidecar(
    sidecar: &PaperLexiconSidecar,
    base: &ReadOnlyBase,
) -> Result<(), String> {
    let lids: HashSet<String> = base.lid_nodes.iter().map(|n| n.lid.clone()).collect();
    let mut terms = HashSet::new();
    for entry in &sidecar.entries {
        let term_key = entry.term.trim().to_lowercase();
        if term_key.is_empty() {
            return Err("paper_lexicon entry term 为空".into());
        }
        if !terms.insert(term_key) {
            return Err(format!("paper_lexicon entry 重复 term: {}", entry.term));
        }
        if entry.term_type.trim().is_empty() {
            return Err(format!("paper_lexicon entry {} term_type 为空", entry.term));
        }
        if entry.occurrences_lids.is_empty() {
            return Err(format!(
                "paper_lexicon entry {} 缺 occurrences_lids",
                entry.term
            ));
        }
        for lid in &entry.occurrences_lids {
            if !lids.contains(lid) {
                return Err(format!(
                    "paper_lexicon entry {} occurrences_lids 含不存在 LID: {}",
                    entry.term, lid
                ));
            }
        }
        if let Some(lid) = &entry.defined_at_lid {
            if !lids.contains(lid) {
                return Err(format!(
                    "paper_lexicon entry {} defined_at_lid 不存在: {}",
                    entry.term, lid
                ));
            }
            if !entry.occurrences_lids.iter().any(|own| own == lid) {
                return Err(format!(
                    "paper_lexicon entry {} defined_at_lid 未出现在 occurrences_lids",
                    entry.term
                ));
            }
        }
    }
    Ok(())
}

fn lid_contains(container: &str, lid: &str) -> bool {
    lid == container || lid.starts_with(&format!("{container}."))
}

fn lid_related(a: &str, b: &str) -> bool {
    lid_contains(a, b) || lid_contains(b, a)
}

fn push_unique(target: &mut Vec<String>, value: &str) {
    if !target.iter().any(|own| own == value) {
        target.push(value.to_string());
    }
}

fn push_unique_all(target: &mut Vec<String>, values: &[String]) {
    for value in values {
        push_unique(target, value);
    }
}

fn contains_any(value: &Option<String>, needles: &[&str]) -> bool {
    let Some(value) = value else {
        return false;
    };
    let lower = value.to_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn parse_paper_reading_mode(raw: Option<&str>) -> Result<PaperReadingMode, ToolError> {
    match raw.unwrap_or("skim") {
        "skim" => Ok(PaperReadingMode::Skim),
        "close" => Ok(PaperReadingMode::Close),
        "deep" => Ok(PaperReadingMode::Deep),
        other => Err(ToolError {
            error_code: "INVALID_MODE".into(),
            category: "validation".into(),
            message: format!("paper_reading_guide mode 不支持: {other}"),
        }),
    }
}

fn parse_paper_reading_stage(raw: Option<&str>) -> Result<PaperReadingStage, ToolError> {
    match raw.unwrap_or("passive") {
        "passive" => Ok(PaperReadingStage::Passive),
        "active" => Ok(PaperReadingStage::Active),
        "critical" => Ok(PaperReadingStage::Critical),
        "creative" => Ok(PaperReadingStage::Creative),
        other => Err(ToolError {
            error_code: "INVALID_STAGE".into(),
            category: "validation".into(),
            message: format!("paper_reading_guide stage 不支持: {other}"),
        }),
    }
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
            Ok(s) => parse_formula_semantics_sidecar(&s)
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
        let book_structure_path = format!("{dir}/book_structure.json");
        let book_structure = match std::fs::read_to_string(&book_structure_path) {
            Ok(s) => Some(parse_book_structure_sidecar(&s, &base)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读 book_structure.json 失败: {e}")),
        };
        let paper_metadata_path = format!("{dir}/paper_metadata.json");
        let paper_metadata = match std::fs::read_to_string(&paper_metadata_path) {
            Ok(s) => Some(parse_paper_metadata_sidecar(&s, &base)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读 paper_metadata.json 失败: {e}")),
        };
        let paper_lexicon_path = format!("{dir}/paper_lexicon.json");
        let paper_lexicon = match std::fs::read_to_string(&paper_lexicon_path) {
            Ok(s) => Some(parse_paper_lexicon_sidecar(&s, &base)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读 paper_lexicon.json 失败: {e}")),
        };
        Ok(Book::new(base, &source)
            .with_formula_semantics(formula_semantics)
            .with_discourse_items(discourse_items)
            .with_book_structure(book_structure)
            .with_paper_metadata(paper_metadata)
            .with_paper_lexicon(paper_lexicon))
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
            book_structure: None,
            paper_metadata: None,
            paper_lexicon: None,
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

    pub fn with_book_structure(mut self, book_structure: Option<BookStructureSidecar>) -> Book {
        self.book_structure = book_structure;
        self
    }

    pub fn book_structure(&self) -> Option<&BookStructureSidecar> {
        self.book_structure.as_ref()
    }

    pub fn with_paper_metadata(mut self, paper_metadata: Option<PaperMetadataSidecar>) -> Book {
        self.paper_metadata = paper_metadata;
        self
    }

    pub fn paper_metadata(&self) -> Option<&PaperMetadataSidecar> {
        self.paper_metadata.as_ref()
    }

    pub fn with_paper_lexicon(mut self, paper_lexicon: Option<PaperLexiconSidecar>) -> Book {
        self.paper_lexicon = paper_lexicon;
        self
    }

    pub fn paper_lexicon(&self) -> Option<&PaperLexiconSidecar> {
        self.paper_lexicon.as_ref()
    }

    pub fn content_profile_id(&self) -> ContentProfileId {
        if self.paper_profile_attached() {
            ContentProfileId::Paper
        } else {
            ContentProfileId::TechnicalLearning
        }
    }

    pub fn profile_manifest(&self) -> ProfileManifest {
        profile_manifest_for_id(self.content_profile_id())
    }

    pub fn profile_manifest_by_id(
        &self,
        profile_id: Option<&str>,
    ) -> Result<ProfileManifest, ToolError> {
        profile_id
            .map(parse_content_profile_id)
            .transpose()
            .map(|id| profile_manifest_for_id(id.unwrap_or_else(|| self.content_profile_id())))
    }

    pub fn profile_summary(&self) -> ProfileSummary {
        profile_summary(&self.profile_manifest())
    }

    fn metadata_string_field(
        field: &Option<MetadataField<String>>,
    ) -> Option<PaperMetadataStringField> {
        field.as_ref().map(|field| PaperMetadataStringField {
            value: field.value.clone(),
            source: field.source.clone(),
            evidence_lids: field.evidence_lids.clone(),
            confidence: field.confidence,
        })
    }

    fn metadata_string_list_field(
        field: &Option<MetadataField<Vec<String>>>,
    ) -> Option<PaperMetadataStringListField> {
        field.as_ref().map(|field| PaperMetadataStringListField {
            value: field.value.clone(),
            source: field.source.clone(),
            evidence_lids: field.evidence_lids.clone(),
            confidence: field.confidence,
        })
    }

    fn metadata_number_field(
        field: &Option<MetadataField<i64>>,
    ) -> Option<PaperMetadataNumberField> {
        field.as_ref().map(|field| PaperMetadataNumberField {
            value: field.value,
            source: field.source.clone(),
            evidence_lids: field.evidence_lids.clone(),
            confidence: field.confidence,
        })
    }

    fn metadata_authors_field(
        field: &Option<MetadataField<Vec<PaperAuthor>>>,
    ) -> Option<PaperMetadataAuthorsField> {
        field.as_ref().map(|field| PaperMetadataAuthorsField {
            value: field.value.clone(),
            source: field.source.clone(),
            evidence_lids: field.evidence_lids.clone(),
            confidence: field.confidence,
        })
    }

    fn metadata_references_field(
        field: &Option<MetadataField<Vec<PaperReference>>>,
    ) -> Option<PaperMetadataReferencesField> {
        field.as_ref().map(|field| PaperMetadataReferencesField {
            value: field.value.clone(),
            source: field.source.clone(),
            evidence_lids: field.evidence_lids.clone(),
            confidence: field.confidence,
        })
    }

    pub fn paper_metadata_projection(&self) -> PaperMetadataProjection {
        let Some(metadata) = &self.paper_metadata else {
            return PaperMetadataProjection {
                available: false,
                header: None,
                title: None,
                authors: None,
                affiliations: None,
                venue: None,
                year: None,
                identifiers: None,
                keywords: None,
                field_labels: None,
                references: None,
                datasets: None,
                code_links: None,
                funding: None,
                warning: Some("paper_metadata.json not attached".into()),
            };
        };
        let identifiers = metadata.identifiers.as_ref().and_then(|identifiers| {
            let projection = PaperMetadataIdentifiersProjection {
                doi: Self::metadata_string_field(&identifiers.doi),
                arxiv: Self::metadata_string_field(&identifiers.arxiv),
                url: Self::metadata_string_field(&identifiers.url),
            };
            if projection.doi.is_some() || projection.arxiv.is_some() || projection.url.is_some() {
                Some(projection)
            } else {
                None
            }
        });
        PaperMetadataProjection {
            available: true,
            header: Some(metadata.header.clone()),
            title: Self::metadata_string_field(&metadata.title),
            authors: Self::metadata_authors_field(&metadata.authors),
            affiliations: Self::metadata_string_list_field(&metadata.affiliations),
            venue: Self::metadata_string_field(&metadata.venue),
            year: Self::metadata_number_field(&metadata.year),
            identifiers,
            keywords: Self::metadata_string_list_field(&metadata.keywords),
            field_labels: Self::metadata_string_list_field(&metadata.field_labels),
            references: Self::metadata_references_field(&metadata.references),
            datasets: Self::metadata_string_list_field(&metadata.datasets),
            code_links: Self::metadata_string_list_field(&metadata.code_links),
            funding: Self::metadata_string_list_field(&metadata.funding),
            warning: None,
        }
    }

    pub fn paper_lexicon_projection(&self) -> PaperLexiconProjection {
        let Some(lexicon) = &self.paper_lexicon else {
            return PaperLexiconProjection {
                available: false,
                header: None,
                entries: Vec::new(),
                warning: Some("paper_lexicon.json not attached".into()),
            };
        };
        PaperLexiconProjection {
            available: true,
            header: Some(lexicon.header.clone()),
            entries: self.paper_codebook_terms(),
            warning: None,
        }
    }

    fn key_stop_map(
        &self,
        sidecar: &BookStructureSidecar,
    ) -> HashMap<String, BookStructureKeyStop> {
        sidecar
            .key_stops
            .iter()
            .map(|s| (s.id.clone(), s.clone()))
            .collect()
    }

    fn matching_spine_index(&self, sidecar: &BookStructureSidecar, at: &str) -> Option<usize> {
        sidecar
            .spine
            .iter()
            .position(|unit| lid_contains(&unit.lid, at))
            .or_else(|| {
                sidecar
                    .spine
                    .iter()
                    .position(|unit| lid_contains(at, &unit.lid))
            })
    }

    fn stops_by_ids(
        &self,
        ids: &[String],
        stops: &HashMap<String, BookStructureKeyStop>,
    ) -> Vec<BookStructureKeyStop> {
        ids.iter().filter_map(|id| stops.get(id).cloned()).collect()
    }

    /// `book.structure(at?)`:BookStructure 在某 LID 周围的只读结构投影 `[ADR-0045]`。
    /// 缺 sidecar 时显式 unavailable;传入 at 时仍先校验 LID 真实存在。
    pub fn structure(&self, at: Option<&str>) -> Result<StructureProjection, ToolError> {
        if let Some(lid) = at {
            self.node(lid)?;
        }
        let Some(sidecar) = &self.book_structure else {
            return Ok(StructureProjection {
                available: false,
                at: at.map(String::from),
                spine_index: None,
                spine_unit: None,
                key_stops: Vec::new(),
                throughlines: Vec::new(),
                warning: Some("book_structure.json not attached".into()),
            });
        };

        let stops = self.key_stop_map(sidecar);
        let (spine_index, spine_unit, key_stops, throughlines) = match at {
            Some(lid) => {
                let spine_index = self.matching_spine_index(sidecar, lid);
                let spine_unit = spine_index.map(|i| sidecar.spine[i].clone());
                let mut key_stop_ids = Vec::new();
                if let Some(unit) = &spine_unit {
                    key_stop_ids.extend(unit.key_stop_ids.iter().cloned());
                }
                for stop in &sidecar.key_stops {
                    if lid_related(&stop.lid, lid) && !key_stop_ids.iter().any(|id| id == &stop.id)
                    {
                        key_stop_ids.push(stop.id.clone());
                    }
                }
                let key_stops = self.stops_by_ids(&key_stop_ids, &stops);
                let throughlines = sidecar
                    .throughlines
                    .iter()
                    .filter(|thread| {
                        thread.lids.iter().any(|l| lid_related(l, lid))
                            || thread
                                .key_stop_ids
                                .iter()
                                .any(|id| key_stop_ids.iter().any(|own| own == id))
                    })
                    .cloned()
                    .collect();
                (spine_index, spine_unit, key_stops, throughlines)
            }
            None => (None, None, Vec::new(), sidecar.throughlines.clone()),
        };

        Ok(StructureProjection {
            available: true,
            at: at.map(String::from),
            spine_index,
            spine_unit,
            key_stops,
            throughlines,
            warning: None,
        })
    }

    /// `book.guide_path(at?)`:全书级宏观带读路线,按 spine 分段展开 key_stops `[ADR-0045]`。
    /// 不理解自然语言、不读取 reader_profile/memory/viewport。
    pub fn guide_path(&self, at: Option<&str>) -> Result<GuidePath, ToolError> {
        if let Some(lid) = at {
            self.node(lid)?;
        }
        let Some(sidecar) = &self.book_structure else {
            return Ok(GuidePath {
                available: false,
                at: at.map(String::from),
                current_segment_index: None,
                segments: Vec::new(),
                warning: Some("book_structure.json not attached".into()),
            });
        };

        let stops = self.key_stop_map(sidecar);
        let segments = sidecar
            .spine
            .iter()
            .enumerate()
            .map(|(i, unit)| GuidePathSegment {
                spine_index: i,
                spine_unit: unit.clone(),
                key_stops: self.stops_by_ids(&unit.key_stop_ids, &stops),
            })
            .collect();
        Ok(GuidePath {
            available: true,
            at: at.map(String::from),
            current_segment_index: at.and_then(|lid| self.matching_spine_index(sidecar, lid)),
            segments,
            warning: None,
        })
    }

    fn paper_profile_attached(&self) -> bool {
        self.paper_metadata.is_some()
            || self.paper_lexicon.is_some()
            || self
                .book_structure
                .as_ref()
                .map(|s| s.header.profile_id == "paper")
                .unwrap_or(false)
    }

    fn metadata_evidence<T>(&self, field: &Option<MetadataField<T>>, out: &mut Vec<String>) {
        if let Some(field) = field {
            push_unique_all(out, &field.evidence_lids);
        }
    }

    fn paper_metadata_evidence_lids(&self) -> Vec<String> {
        let mut lids = Vec::new();
        let Some(metadata) = &self.paper_metadata else {
            return lids;
        };
        self.metadata_evidence(&metadata.title, &mut lids);
        self.metadata_evidence(&metadata.authors, &mut lids);
        self.metadata_evidence(&metadata.affiliations, &mut lids);
        self.metadata_evidence(&metadata.venue, &mut lids);
        self.metadata_evidence(&metadata.year, &mut lids);
        if let Some(identifiers) = &metadata.identifiers {
            self.metadata_evidence(&identifiers.doi, &mut lids);
            self.metadata_evidence(&identifiers.arxiv, &mut lids);
            self.metadata_evidence(&identifiers.url, &mut lids);
        }
        self.metadata_evidence(&metadata.keywords, &mut lids);
        self.metadata_evidence(&metadata.field_labels, &mut lids);
        self.metadata_evidence(&metadata.references, &mut lids);
        self.metadata_evidence(&metadata.datasets, &mut lids);
        self.metadata_evidence(&metadata.code_links, &mut lids);
        self.metadata_evidence(&metadata.funding, &mut lids);
        lids
    }

    fn paper_codebook_metadata(&self) -> PaperCodebookMetadata {
        let Some(metadata) = &self.paper_metadata else {
            return PaperCodebookMetadata {
                title: None,
                authors: Vec::new(),
                venue: None,
                year: None,
                doi: None,
                arxiv: None,
                url: None,
                keywords: Vec::new(),
                field_labels: Vec::new(),
                datasets: Vec::new(),
                code_links: Vec::new(),
                evidence_lids: Vec::new(),
            };
        };
        let identifiers = metadata.identifiers.as_ref();
        PaperCodebookMetadata {
            title: metadata.title.as_ref().map(|f| f.value.clone()),
            authors: metadata
                .authors
                .as_ref()
                .map(|f| f.value.iter().map(|a| a.name.clone()).collect())
                .unwrap_or_default(),
            venue: metadata.venue.as_ref().map(|f| f.value.clone()),
            year: metadata.year.as_ref().map(|f| f.value),
            doi: identifiers.and_then(|i| i.doi.as_ref().map(|f| f.value.clone())),
            arxiv: identifiers.and_then(|i| i.arxiv.as_ref().map(|f| f.value.clone())),
            url: identifiers.and_then(|i| i.url.as_ref().map(|f| f.value.clone())),
            keywords: metadata
                .keywords
                .as_ref()
                .map(|f| f.value.clone())
                .unwrap_or_default(),
            field_labels: metadata
                .field_labels
                .as_ref()
                .map(|f| f.value.clone())
                .unwrap_or_default(),
            datasets: metadata
                .datasets
                .as_ref()
                .map(|f| f.value.clone())
                .unwrap_or_default(),
            code_links: metadata
                .code_links
                .as_ref()
                .map(|f| f.value.clone())
                .unwrap_or_default(),
            evidence_lids: self.paper_metadata_evidence_lids(),
        }
    }

    fn paper_codebook_terms(&self) -> Vec<PaperCodebookTerm> {
        self.paper_lexicon
            .as_ref()
            .map(|lexicon| {
                lexicon
                    .entries
                    .iter()
                    .map(|entry| {
                        let mut evidence_lids = Vec::new();
                        push_unique_all(&mut evidence_lids, &entry.occurrences_lids);
                        if let Some(lid) = &entry.defined_at_lid {
                            push_unique(&mut evidence_lids, lid);
                        }
                        PaperCodebookTerm {
                            term: entry.term.clone(),
                            term_type: entry.term_type.clone(),
                            evidence_lids,
                            defined_at_lid: entry.defined_at_lid.clone(),
                            aliases: entry.aliases.clone(),
                            acronym_expansion: entry.acronym_expansion.clone(),
                            chinese_gloss: entry.chinese_gloss.clone(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn paper_codebook(&self) -> PaperCodebook {
        let metadata = self.paper_codebook_metadata();
        let terms = self.paper_codebook_terms();
        let mut warnings = Vec::new();
        if self.paper_metadata.is_none() {
            warnings.push("paper_metadata.json not attached".into());
        }
        if self.paper_lexicon.is_none() {
            warnings.push("paper_lexicon.json not attached".into());
        }
        if self.book_structure.is_none() {
            warnings.push("book_structure.json not attached".into());
        }

        let (throughlines, key_stops) = match &self.book_structure {
            Some(sidecar) => (
                sidecar
                    .throughlines
                    .iter()
                    .map(|thread| PaperCodebookStructureItem {
                        id: thread.id.clone(),
                        lid: thread.lids.first().cloned().unwrap_or_default(),
                        title: Some(thread.name.clone()),
                        summary: thread.summary.text.clone(),
                        evidence_lids: thread.summary.evidence_lids.clone(),
                    })
                    .collect(),
                sidecar
                    .key_stops
                    .iter()
                    .map(|stop| PaperCodebookStructureItem {
                        id: stop.id.clone(),
                        lid: stop.lid.clone(),
                        title: stop.title.clone(),
                        summary: stop.reason.text.clone(),
                        evidence_lids: stop.reason.evidence_lids.clone(),
                    })
                    .collect(),
            ),
            None => (Vec::new(), Vec::new()),
        };

        PaperCodebook {
            available: self.paper_profile_attached()
                && (self.paper_metadata.is_some()
                    || self.paper_lexicon.is_some()
                    || self.book_structure.is_some()),
            metadata,
            terms,
            throughlines,
            key_stops,
            warnings,
        }
    }

    fn graph_lids_for_edge_types(&self, edge_types: &[&str]) -> Vec<String> {
        let mut lids = Vec::new();
        for edge in &self.base.graph_edges {
            if !edge_types.iter().any(|t| *t == edge.edge_type.as_str()) {
                continue;
            }
            for node_id in [&edge.source, &edge.target] {
                let Some(index) = self.node_idx.get(node_id) else {
                    continue;
                };
                let node = &self.base.graph_nodes[*index];
                if let Some(lid) = &node.source_lid {
                    push_unique(&mut lids, lid);
                }
                push_unique_all(&mut lids, &node.occurrences);
            }
        }
        lids
    }

    fn graph_lids_for_claims(&self) -> Vec<String> {
        let mut lids = Vec::new();
        for node in &self.base.graph_nodes {
            if node.node_type == GraphNodeType::Claim {
                if let Some(lid) = &node.source_lid {
                    push_unique(&mut lids, lid);
                }
            }
        }
        lids
    }

    fn discourse_lids_by_keywords(&self, needles: &[&str]) -> Vec<String> {
        let mut lids = Vec::new();
        for item in &self.discourse_index {
            if contains_any(&item.local_function, needles)
                || contains_any(&item.rhetorical_move, needles)
                || contains_any(&item.local_summary, needles)
            {
                push_unique(&mut lids, &item.lid);
                for relation in &item.relations {
                    push_unique_all(&mut lids, &relation.evidence_lids);
                }
            }
        }
        lids
    }

    fn structure_lids_by_keywords(&self, needles: &[&str]) -> Vec<String> {
        let mut lids = Vec::new();
        let Some(sidecar) = &self.book_structure else {
            return lids;
        };
        for unit in &sidecar.spine {
            let summary = Some(unit.summary.text.clone());
            if contains_any(&summary, needles) {
                push_unique(&mut lids, &unit.lid);
                push_unique_all(&mut lids, &unit.summary.evidence_lids);
            }
        }
        for stop in &sidecar.key_stops {
            let title = stop.title.clone();
            let reason = Some(stop.reason.text.clone());
            if contains_any(&title, needles) || contains_any(&reason, needles) {
                push_unique(&mut lids, &stop.lid);
                push_unique_all(&mut lids, &stop.reason.evidence_lids);
            }
        }
        for thread in &sidecar.throughlines {
            let name = Some(thread.name.clone());
            let summary = Some(thread.summary.text.clone());
            if contains_any(&name, needles) || contains_any(&summary, needles) {
                push_unique_all(&mut lids, &thread.lids);
                push_unique_all(&mut lids, &thread.summary.evidence_lids);
            }
        }
        lids
    }

    fn metadata_field_lids_for(&self, field_name: &str) -> Vec<String> {
        let mut lids = Vec::new();
        let Some(metadata) = &self.paper_metadata else {
            return lids;
        };
        match field_name {
            "references" => self.metadata_evidence(&metadata.references, &mut lids),
            "datasets" => self.metadata_evidence(&metadata.datasets, &mut lids),
            "keywords" => self.metadata_evidence(&metadata.keywords, &mut lids),
            "code_links" => self.metadata_evidence(&metadata.code_links, &mut lids),
            _ => {}
        }
        lids
    }

    fn lexicon_lids_for_term_types(&self, term_types: &[&str]) -> Vec<String> {
        let mut lids = Vec::new();
        let Some(lexicon) = &self.paper_lexicon else {
            return lids;
        };
        for entry in &lexicon.entries {
            if term_types.iter().any(|t| *t == entry.term_type.as_str()) {
                push_unique_all(&mut lids, &entry.occurrences_lids);
                if let Some(lid) = &entry.defined_at_lid {
                    push_unique(&mut lids, lid);
                }
            }
        }
        lids
    }

    fn evidence_for_paper_question(&self, id: &str) -> Vec<String> {
        let mut lids = Vec::new();
        match id {
            "problem_input_output" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "problem",
                        "question",
                        "input",
                        "output",
                        "abstract",
                        "introduction",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.structure_lids_by_keywords(&["problem", "question", "goal"]),
                );
            }
            "problem_nature" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "motivation",
                        "background",
                        "problem",
                        "gap",
                        "limitation",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.structure_lids_by_keywords(&["background", "motivation", "gap"]),
                );
            }
            "hypothesis" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&["hypothesis", "claim", "goal"]),
                );
                push_unique_all(
                    &mut lids,
                    &self.graph_lids_for_edge_types(&["hypothesis_tested_by_experiment"]),
                );
                push_unique_all(&mut lids, &self.graph_lids_for_claims());
            }
            "related_work_key_people" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "related", "prior", "citation", "contrast", "builds",
                    ]),
                );
                push_unique_all(&mut lids, &self.metadata_field_lids_for("references"));
                push_unique_all(
                    &mut lids,
                    &self.graph_lids_for_edge_types(&[
                        "related_work_contrasts",
                        "related_work_builds_on",
                    ]),
                );
            }
            "core_contribution" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "contribution",
                        "result",
                        "claim",
                        "method",
                        "finding",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.structure_lids_by_keywords(&["contribution", "result", "claim", "goal"]),
                );
                push_unique_all(&mut lids, &self.graph_lids_for_claims());
            }
            "experiment_design" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "experiment",
                        "method",
                        "evaluation",
                        "setup",
                        "protocol",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.graph_lids_for_edge_types(&[
                        "method_supports_result",
                        "hypothesis_tested_by_experiment",
                    ]),
                );
            }
            "dataset" => {
                push_unique_all(&mut lids, &self.metadata_field_lids_for("datasets"));
                push_unique_all(
                    &mut lids,
                    &self.lexicon_lids_for_term_types(&["dataset_name"]),
                );
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&["dataset", "corpus", "benchmark"]),
                );
            }
            "results_support_hypothesis" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "evidence",
                        "result",
                        "support",
                        "finding",
                        "experiment",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.graph_lids_for_edge_types(&[
                        "claim_supported_by_evidence",
                        "method_supports_result",
                        "hypothesis_tested_by_experiment",
                    ]),
                );
            }
            "contribution_summary" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&[
                        "conclusion",
                        "summary",
                        "contribution",
                        "result",
                    ]),
                );
                push_unique_all(
                    &mut lids,
                    &self.structure_lids_by_keywords(&["summary", "conclusion", "contribution"]),
                );
            }
            "future_work" => {
                push_unique_all(
                    &mut lids,
                    &self.discourse_lids_by_keywords(&["future", "limitation", "threat", "open"]),
                );
                push_unique_all(
                    &mut lids,
                    &self.graph_lids_for_edge_types(&["limitation_motivates_future_work"]),
                );
            }
            _ => {}
        }
        if lids.is_empty() {
            push_unique_all(&mut lids, &self.paper_metadata_evidence_lids());
        }
        lids
    }

    fn answer_slots_for_stage(
        &self,
        stage: &PaperReadingStage,
        evidence_lids: &[String],
    ) -> Vec<PaperReadingAnswerSlot> {
        let mut slots = vec![PaperReadingAnswerSlot {
            kind: PaperReadingAnswerSlotKind::PaperEvidence,
            label: "paper_evidence".into(),
            instruction: "Answer only from the listed LID evidence; cite every factual claim."
                .into(),
            evidence_lids: evidence_lids.to_vec(),
        }];
        if matches!(
            stage,
            PaperReadingStage::Critical | PaperReadingStage::Creative
        ) {
            slots.push(PaperReadingAnswerSlot {
                kind: PaperReadingAnswerSlotKind::ModelSupplement,
                label: "model_supplement".into(),
                instruction:
                    "Use only for critique or research ideas not explicitly asserted by the paper."
                        .into(),
                evidence_lids: evidence_lids.to_vec(),
            });
        }
        slots.push(PaperReadingAnswerSlot {
            kind: PaperReadingAnswerSlotKind::UserReflection,
            label: "user_reflection".into(),
            instruction: "Reader-owned notes or Chinese restatement; never use as paper citation."
                .into(),
            evidence_lids: Vec::new(),
        });
        slots
    }

    fn paper_questions(&self, stage: &PaperReadingStage) -> Vec<PaperReadingQuestion> {
        let specs = [
            (
                "problem_input_output",
                "What exact problem does the paper solve, and what are its inputs and outputs?",
                "problem and task boundary",
            ),
            (
                "problem_nature",
                "What kind of problem is it: empirical, theoretical, engineering, or conceptual?",
                "problem nature and motivation",
            ),
            (
                "hypothesis",
                "What hypothesis or central claim is being tested?",
                "hypothesis or main claim",
            ),
            (
                "related_work_key_people",
                "Which prior work, authors, or competing lines does the paper position against?",
                "related work and positioning",
            ),
            (
                "core_contribution",
                "What is the paper's core contribution?",
                "claimed contribution",
            ),
            (
                "experiment_design",
                "How are the experiments or validation designed?",
                "method and evaluation design",
            ),
            (
                "dataset",
                "Which datasets, benchmarks, or corpora are used?",
                "data and benchmark context",
            ),
            (
                "results_support_hypothesis",
                "Do the results support the hypothesis or central claim?",
                "result-to-claim evidence",
            ),
            (
                "contribution_summary",
                "How should the paper's contribution be summarized after reading?",
                "paper-level summary",
            ),
            (
                "future_work",
                "What limitations or next research directions does the paper imply?",
                "limitations and future work",
            ),
        ];
        specs
            .iter()
            .map(|(id, question, focus)| {
                let evidence_lids = self.evidence_for_paper_question(id);
                PaperReadingQuestion {
                    id: (*id).into(),
                    question: (*question).into(),
                    focus: (*focus).into(),
                    answer_slots: self.answer_slots_for_stage(stage, &evidence_lids),
                    evidence_lids,
                }
            })
            .collect()
    }

    fn abstract_lids(&self) -> Vec<String> {
        let mut lids = Vec::new();
        for item in &self.discourse_index {
            if contains_any(&item.local_function, &["abstract"])
                || contains_any(&item.rhetorical_move, &["abstract"])
                || contains_any(&item.local_summary, &["abstract"])
            {
                push_unique(&mut lids, &item.lid);
            }
        }
        if lids.is_empty() {
            if let Some(metadata) = &self.paper_metadata {
                self.metadata_evidence(&metadata.title, &mut lids);
                self.metadata_evidence(&metadata.keywords, &mut lids);
            }
        }
        lids
    }

    fn abstract_reading_aid(&self, codebook_terms: &[PaperCodebookTerm]) -> AbstractReadingAid {
        let abstract_lids = self.abstract_lids();
        if abstract_lids.is_empty() {
            return AbstractReadingAid {
                available: false,
                abstract_lids: Vec::new(),
                excerpts: Vec::new(),
                key_terms: Vec::new(),
                comprehension_checks: Vec::new(),
                user_reflection_prompt:
                    "Write a short Chinese restatement only after selecting the abstract LIDs."
                        .into(),
                warning: Some("abstract LID not identified from discourse or metadata".into()),
            };
        }
        let excerpts = abstract_lids
            .iter()
            .filter_map(|lid| {
                self.text(lid, None).ok().map(|text| PaperAbstractExcerpt {
                    lid: lid.clone(),
                    text,
                    evidence_lids: vec![lid.clone()],
                })
            })
            .collect::<Vec<_>>();
        let key_terms = codebook_terms
            .iter()
            .filter(|term| {
                term.evidence_lids.iter().any(|term_lid| {
                    abstract_lids
                        .iter()
                        .any(|abstract_lid| lid_related(abstract_lid, term_lid))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let checks = vec![
            PaperAbstractCheck {
                id: "abstract_problem".into(),
                prompt: "Restate in Chinese the concrete problem named by the abstract.".into(),
                evidence_lids: abstract_lids.clone(),
            },
            PaperAbstractCheck {
                id: "abstract_method_or_claim".into(),
                prompt: "Point to the exact words that state the method, claim, or contribution."
                    .into(),
                evidence_lids: abstract_lids.clone(),
            },
            PaperAbstractCheck {
                id: "abstract_term_decode".into(),
                prompt:
                    "Decode each acronym or paper-specific term before translating the sentence."
                        .into(),
                evidence_lids: key_terms
                    .iter()
                    .flat_map(|term| term.evidence_lids.iter().cloned())
                    .collect(),
            },
        ];
        AbstractReadingAid {
            available: true,
            abstract_lids,
            excerpts,
            key_terms,
            comprehension_checks: checks,
            user_reflection_prompt:
                "Write your Chinese restatement separately; treat it as user_reflection, not evidence."
                    .into(),
            warning: None,
        }
    }

    /// `book.paper_reading_guide(mode?,stage?)`:paper 规则包只读投影。
    /// 组合 BookStructure、graph、discourse、paper_metadata、paper_lexicon 与原文;不落地新 truth。
    pub fn paper_reading_guide(
        &self,
        mode: Option<&str>,
        stage: Option<&str>,
    ) -> Result<PaperReadingGuide, ToolError> {
        let mode = parse_paper_reading_mode(mode)?;
        let stage = parse_paper_reading_stage(stage)?;
        if !self.paper_profile_attached() {
            let codebook = self.paper_codebook();
            return Ok(PaperReadingGuide {
                available: false,
                mode,
                stage,
                questions: Vec::new(),
                abstract_aid: self.abstract_reading_aid(&codebook.terms),
                codebook,
                warnings: vec![
                    "paper artifacts not attached; load a paper-profile book to use this projection"
                        .into(),
                ],
            });
        }

        let codebook = self.paper_codebook();
        let abstract_aid = self.abstract_reading_aid(&codebook.terms);
        let mut warnings = codebook.warnings.clone();
        if let Some(warning) = &abstract_aid.warning {
            warnings.push(warning.clone());
        }
        Ok(PaperReadingGuide {
            available: true,
            mode,
            stage: stage.clone(),
            questions: self.paper_questions(&stage),
            codebook,
            abstract_aid,
            warnings,
        })
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

    /// 两个 LID 在物化路径树上的距离(公共前缀外的层数之和)。占位口径,实测回填。
    fn lid_tree_distance(&self, a: &str, b: &str) -> usize {
        let pa = self.lid_idx.get(a).map(|&i| &self.base.lid_nodes[i].path);
        let pb = self.lid_idx.get(b).map(|&i| &self.base.lid_nodes[i].path);
        match (pa, pb) {
            (Some(pa), Some(pb)) => {
                let common = pa.iter().zip(pb.iter()).take_while(|(x, y)| x == y).count();
                (pa.len() - common) + (pb.len() - common)
            }
            _ => 0,
        }
    }

    /// 把一个 context far 投影项转成 (NavCategory, RankedStep)。
    /// Tree 仅取 next_sibling(→continue);parent/prev_sibling/child 是结构上下文,不进前沿(v1)。
    fn route_step(&self, at: &str, it: &ContextItem) -> Option<(NavCategory, RankedStep)> {
        let (edge_type, weight, evidence_lids, why, cat) = match &it.via {
            Via::Tree { rel } => {
                if rel != "next_sibling" {
                    return None;
                }
                (
                    "next_sibling".to_string(),
                    1.0_f32,
                    vec![at.to_string(), it.lid.clone()],
                    "reading order: next sibling".to_string(),
                    NavCategory::Continue,
                )
            }
            Via::Edge {
                scope,
                edge_type,
                weight,
                ..
            } => (
                edge_type.clone(),
                *weight,
                vec![at.to_string(), it.lid.clone()],
                format!("{scope} edge: {edge_type}"),
                nav_category_of(edge_type),
            ),
            Via::Concept { name, .. } => (
                "co_occurrence".to_string(),
                CONCEPT_COOCCURRENCE_WEIGHT,
                vec![at.to_string(), it.lid.clone()],
                format!("co-occurs via concept: {name}"),
                NavCategory::Cross,
            ),
            Via::Discourse {
                relation_type,
                confidence,
                evidence_lids,
                ..
            } => (
                relation_type.clone(),
                *confidence,
                evidence_lids.clone(),
                format!("discourse: {relation_type}"),
                nav_category_of(relation_type),
            ),
        };
        let dist = self.lid_tree_distance(at, &it.lid);
        let score = weight / (1.0 + dist as f32);
        Some((
            cat,
            RankedStep {
                lid: it.lid.clone(),
                edge_type,
                why,
                evidence_lids,
                score,
            },
        ))
    }

    /// book.route_from(at, k?):前沿式确定性导航原语 `[ADR-0034]`。
    /// 架在 `book.context` 上——吃 `context(at,"far")` 已投影好的全部 边/概念/结构邻接,
    /// 按 `edge_type→NavCategory` 固定映射重组为 5 类,组内 weight/(1+树距) 排序,各类 top-K。
    /// 零 LLM、纯结构;invalid at → context 抛 LID_NOT_FOUND(not_found);叶子无边 → 空 5 类非 error。
    pub fn route_from(&self, at: &str, k: Option<usize>) -> Result<Frontier, ToolError> {
        // 不截断(k=MAX),拿全部投影项,分组后每类各自 top-K(故传 usize::MAX 给 context)。
        let ctx = self.context(at, Some("far"), Some(usize::MAX))?;
        let mut f = Frontier {
            back: Vec::new(),
            forward: Vec::new(),
            concretize: Vec::new(),
            cross: Vec::new(),
            continue_: Vec::new(),
        };
        for it in &ctx.items {
            if let Some((cat, step)) = self.route_step(at, it) {
                match cat {
                    NavCategory::Back => f.back.push(step),
                    NavCategory::Forward => f.forward.push(step),
                    NavCategory::Concretize => f.concretize.push(step),
                    NavCategory::Cross => f.cross.push(step),
                    NavCategory::Continue => f.continue_.push(step),
                }
            }
        }
        let limit = k.unwrap_or(DEFAULT_ROUTE_K);
        let cmp = |a: &RankedStep, b: &RankedStep| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.lid.cmp(&b.lid))
                .then_with(|| a.edge_type.cmp(&b.edge_type))
        };
        for group in [
            &mut f.back,
            &mut f.forward,
            &mut f.concretize,
            &mut f.cross,
            &mut f.continue_,
        ] {
            group.sort_by(cmp);
            group.truncate(limit);
        }
        Ok(f)
    }

    /// 某 LID 的导航邻居:route_from 的 5 类前沿按 (back,forward,concretize,cross,continue)
    /// 顺序展平、按 lid 去重(保留首现=最高优先类/分)。BFS 用全量前沿(k=MAX)避免截断藏路。
    fn route_neighbors(&self, lid: &str) -> Result<Vec<RankedStep>, ToolError> {
        let f = self.route_from(lid, Some(usize::MAX))?;
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for group in [&f.back, &f.forward, &f.concretize, &f.cross, &f.continue_] {
            for s in group {
                if seen.insert(s.lid.clone()) {
                    out.push(s.clone());
                }
            }
        }
        Ok(out)
    }

    /// book.route_to(from, target, k?):路径式确定性导航(route_from 的派生)`[ADR-0034 决策3]`。
    /// 在 route_from 同批边上跑 BFS,返 `from→target` 的导航步路径(全真 LID/真边)。
    /// `target` 须为已解析 LID(NL→入口在 route 之外,复用 `book.concept`)。`k` = 跳数预算。
    /// from/target 非真 → not_found;from==target 或 预算内不可达 → 空路径非 error。
    pub fn route_to(
        &self,
        from: &str,
        target: &str,
        k: Option<usize>,
    ) -> Result<Vec<RankedStep>, ToolError> {
        self.node(from)?;
        self.node(target)?;
        if from == target {
            return Ok(Vec::new());
        }
        let max_hops = k.unwrap_or(DEFAULT_ROUTE_HOPS);
        // BFS:prev 记 到达每个 lid 的 (前驱 lid, 该步),用于回溯;visited 防环。
        let mut prev: HashMap<String, (String, RankedStep)> = HashMap::new();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        visited.insert(from.to_string());
        let mut queue: std::collections::VecDeque<(String, usize)> =
            std::collections::VecDeque::new();
        queue.push_back((from.to_string(), 0));
        while let Some((lid, depth)) = queue.pop_front() {
            if depth >= max_hops {
                continue;
            }
            for step in self.route_neighbors(&lid)? {
                if !visited.insert(step.lid.clone()) {
                    continue;
                }
                let next_lid = step.lid.clone();
                let reached_target = next_lid == target;
                prev.insert(next_lid.clone(), (lid.clone(), step));
                if reached_target {
                    // 回溯:target → from,再反转成 from → target。
                    let mut path = Vec::new();
                    let mut cur = target.to_string();
                    while cur != from {
                        let (p, s) = &prev[&cur];
                        path.push(s.clone());
                        cur = p.clone();
                    }
                    path.reverse();
                    return Ok(path);
                }
                queue.push_back((next_lid, depth + 1));
            }
        }
        Ok(Vec::new())
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

/// `edge_type → NavCategory` 固定确定性映射(Core,零 LLM)`[ADR-0034 决策5]`。
/// 未知 local 边类型 → Cross(关联兜底):Pass1 local edge_type 是开放集,
/// 以兜底保证「覆盖全边类型、不丢边」,代价是关联类可能略宽(实测回填「何时回头」)。
fn nav_category_of(edge_type: &str) -> NavCategory {
    match edge_type {
        "prerequisite" | "depends_on" => NavCategory::Back,
        "builds_on" | "refines" | "elaborates" | "explains" | "prepares" | "causes"
        | "results_in" => NavCategory::Forward,
        "exemplifies" | "applies" | "answers" => NavCategory::Concretize,
        "next_sibling" | "continues" => NavCategory::Continue,
        // analogous_to / contrasts / contradicts / supports / rebuts / summarizes /
        // restates / concedes / co_occurrence / 未知 local → 关联兜底
        _ => NavCategory::Cross,
    }
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
    fn book_isolated_leaf() -> Book {
        let base = ReadOnlyBase {
            book_id: "iso".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 4 },
                    children: vec!["1.1".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 4 },
                    children: vec![],
                },
            ],
            graph_nodes: vec![],
            graph_edges: vec![],
        };
        Book::new(base, "AAAA")
    }
    fn book_chain() -> Book {
        // 三叶 1.1/1.2/1.3,长程链 ea(1.1)→eb(1.2)→ec(1.3),无 1.1→1.3 直边。
        let base = ReadOnlyBase {
            book_id: "chain".into(),
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
            ],
            graph_nodes: vec![
                GraphNode {
                    id: "entity:ea".into(),
                    node_type: GraphNodeType::Entity,
                    name: "EA".into(),
                    occurrences: vec!["1.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:eb".into(),
                    node_type: GraphNodeType::Entity,
                    name: "EB".into(),
                    occurrences: vec!["1.2".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:ec".into(),
                    node_type: GraphNodeType::Entity,
                    name: "EC".into(),
                    occurrences: vec!["1.3".into()],
                    source_lid: None,
                },
            ],
            graph_edges: vec![
                GraphEdge {
                    source: "entity:ea".into(),
                    target: "entity:eb".into(),
                    edge_type: "builds_on".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.9,
                },
                GraphEdge {
                    source: "entity:eb".into(),
                    target: "entity:ec".into(),
                    edge_type: "builds_on".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.9,
                },
            ],
        };
        Book::new(base, "AAAABBBBCCCC")
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

    fn structure_base() -> ReadOnlyBase {
        ReadOnlyBase {
            book_id: "structure-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 8 },
                    children: vec!["1.1".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 8 },
                    children: vec![],
                },
                LidNode {
                    lid: "2".into(),
                    path: vec![2],
                    kind: NodeKind::Chapter,
                    span: Span { start: 8, end: 16 },
                    children: vec!["2.1".into()],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 8, end: 16 },
                    children: vec![],
                },
            ],
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        }
    }

    fn write_book_dir(name: &str, base: &ReadOnlyBase) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("base.json"), serde_json::to_string(base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "AAAABBBBCCCCDDDD").unwrap();
        dir
    }

    fn book_structure_json() -> serde_json::Value {
        serde_json::json!({
            "header": {
                "book_id": "structure-book",
                "book_version": "v1",
                "profile_id": "technical_learning",
                "profile_version": "technical_learning_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-04T00:00:00.000Z"
            },
            "spine": [
                {
                    "lid": "1",
                    "role": "foundation",
                    "summary": {"text": "Builds the foundation.", "evidence_lids": ["1.1"]},
                    "key_stop_ids": ["ks:def"],
                    "depends_on": []
                },
                {
                    "lid": "2",
                    "role": "application",
                    "summary": {"text": "Applies the foundation.", "evidence_lids": ["2.1"]},
                    "key_stop_ids": ["ks:app"],
                    "depends_on": ["1"]
                }
            ],
            "throughlines": [
                {
                    "id": "thread:alpha",
                    "name": "Alpha line",
                    "summary": {"text": "Connects foundation and application.", "evidence_lids": ["1.1", "2.1"]},
                    "lids": ["1", "2"],
                    "key_stop_ids": ["ks:def", "ks:app"]
                }
            ],
            "key_stops": [
                {
                    "id": "ks:def",
                    "lid": "1.1",
                    "type": "definition",
                    "title": "Definition",
                    "reason": {"text": "Defines the core idea.", "evidence_lids": ["1.1"]}
                },
                {
                    "id": "ks:app",
                    "lid": "2.1",
                    "type": "example",
                    "reason": {"text": "Shows the idea in use.", "evidence_lids": ["2.1"]}
                }
            ]
        })
    }

    fn paper_book_structure_json() -> serde_json::Value {
        let mut value = book_structure_json();
        value["header"]["profile_id"] = serde_json::json!("paper");
        value["header"]["profile_version"] = serde_json::json!("paper_v0");
        value["spine"][0]["summary"]["text"] =
            serde_json::json!("Abstract frames the problem and contribution.");
        value["spine"][1]["summary"]["text"] =
            serde_json::json!("Experiment reports dataset evidence.");
        value["key_stops"][0]["title"] = serde_json::json!("Abstract");
        value["key_stops"][0]["reason"]["text"] =
            serde_json::json!("Abstract states the problem and contribution.");
        value["key_stops"][1]["title"] = serde_json::json!("Experiment");
        value["key_stops"][1]["reason"]["text"] =
            serde_json::json!("Experiment reports result evidence.");
        value["throughlines"][0]["summary"]["text"] =
            serde_json::json!("Connects abstract problem framing to experiment evidence.");
        value
    }

    fn paper_metadata_json() -> serde_json::Value {
        serde_json::json!({
            "header": {
                "book_id": "structure-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-05T00:00:00.000Z"
            },
            "title": {
                "value": "Sample Paper",
                "source": "front_matter",
                "evidence_lids": ["1.1"],
                "confidence": 0.9
            },
            "authors": {
                "value": [{"name": "Ada Lovelace", "raw": "Ada Lovelace"}],
                "source": "paper_text",
                "evidence_lids": ["1.1"]
            },
            "year": {
                "value": 2026,
                "source": "paper_text",
                "evidence_lids": ["1.1"]
            },
            "keywords": {
                "value": ["retrieval", "sample"],
                "source": "paper_text",
                "evidence_lids": ["1.1"]
            },
            "references": {
                "value": [{"raw": "Smith et al. 2024"}],
                "source": "paper_text",
                "evidence_lids": ["1.1"]
            },
            "datasets": {
                "value": ["SampleSet"],
                "source": "paper_text",
                "evidence_lids": ["2.1"]
            }
        })
    }

    fn paper_lexicon_json() -> serde_json::Value {
        serde_json::json!({
            "header": {
                "book_id": "structure-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-05T00:00:00.000Z"
            },
            "entries": [
                {
                    "term": "RAG",
                    "term_type": "acronym",
                    "occurrences_lids": ["1.1"],
                    "defined_at_lid": "1.1",
                    "aliases": ["Retrieval-Augmented Generation"],
                    "acronym_expansion": "Retrieval-Augmented Generation",
                    "chinese_gloss": "检索增强生成"
                },
                {
                    "term": "SampleSet",
                    "term_type": "dataset_name",
                    "occurrences_lids": ["2.1"],
                    "chinese_gloss": "示例数据集"
                }
            ]
        })
    }

    fn paper_discourse_json() -> serde_json::Value {
        serde_json::json!({
            "header": {
                "book_id": "structure-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-05T00:00:00.000Z"
            },
            "items": [
                {
                    "lid": "1.1",
                    "mode": "argumentative",
                    "local_function": "abstract_summary",
                    "rhetorical_move": "problem_framing",
                    "local_summary": "Abstract states the problem, hypothesis, and contribution.",
                    "relations": [
                        {
                            "target_lid": "2.1",
                            "type": "claim_supported_by_evidence",
                            "family": "support",
                            "direction": "forward",
                            "confidence": 0.9,
                            "evidence_lids": ["1.1", "2.1"]
                        }
                    ]
                },
                {
                    "lid": "2.1",
                    "mode": "argumentative",
                    "local_function": "experiment_design",
                    "rhetorical_move": "evidence_report",
                    "local_summary": "Experiment reports dataset evidence and result support.",
                    "relations": []
                }
            ]
        })
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
    fn load_reads_headered_formula_semantics_sidecar() {
        let dir = std::env::temp_dir().join("ub-read-tools-formula-headered-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut base = sample_base();
        base.lid_nodes[1].kind = NodeKind::Formula;
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), "X".repeat(100)).unwrap();
        let sidecar = serde_json::json!({
            "header": {
                "book_id": "sample-book",
                "book_version": "v1",
                "profile_id": "technical_learning",
                "profile_version": "technical_learning_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-06-26T00:00:00.000Z"
            },
            "items": [formula_semantics()]
        });
        std::fs::write(
            dir.join("formula_semantics.json"),
            serde_json::to_string(&sidecar).unwrap(),
        )
        .unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert_eq!(
            book.formula_semantics("1.1").unwrap().parameters[0].symbol,
            "x"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_book_structure_sidecar_degrades_explicitly() {
        let base = structure_base();
        let dir = write_book_dir("ub-read-tools-book-structure-missing", &base);

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert!(book.book_structure().is_none());
        let projection = book.structure(Some("1.1")).unwrap();
        assert!(!projection.available);
        assert_eq!(projection.at.as_deref(), Some("1.1"));
        assert!(projection.key_stops.is_empty());
        assert!(projection.warning.unwrap().contains("not attached"));

        let guide = book.guide_path(None).unwrap();
        assert!(!guide.available);
        assert!(guide.segments.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_bad_book_structure_sidecar_fails_fast() {
        let base = structure_base();
        let dir = write_book_dir("ub-read-tools-book-structure-bad", &base);
        let mut sidecar = book_structure_json();
        sidecar["key_stops"][0]["reason"]["evidence_lids"] = serde_json::json!(["9.9"]);
        std::fs::write(dir.join("book_structure.json"), sidecar.to_string()).unwrap();

        let err = match Book::load(dir.to_str().unwrap()) {
            Ok(_) => panic!("expected bad book_structure.json to fail"),
            Err(e) => e,
        };
        assert!(err.contains("book_structure"));
        assert!(err.contains("不存在 LID"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_valid_book_structure_projects_structure_and_guide_path() {
        let base = structure_base();
        let dir = write_book_dir("ub-read-tools-book-structure-valid", &base);
        std::fs::write(
            dir.join("book_structure.json"),
            book_structure_json().to_string(),
        )
        .unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert!(book.book_structure().is_some());

        let projection = book.structure(Some("1.1")).unwrap();
        assert!(projection.available);
        assert_eq!(projection.spine_index, Some(0));
        assert_eq!(projection.spine_unit.unwrap().lid, "1");
        assert_eq!(projection.key_stops.len(), 1);
        assert_eq!(projection.key_stops[0].id, "ks:def");
        assert_eq!(projection.throughlines.len(), 1);
        assert_eq!(projection.throughlines[0].id, "thread:alpha");

        let guide = book.guide_path(Some("2.1")).unwrap();
        assert!(guide.available);
        assert_eq!(guide.current_segment_index, Some(1));
        assert_eq!(guide.segments.len(), 2);
        assert_eq!(guide.segments[0].spine_unit.lid, "1");
        assert_eq!(guide.segments[0].key_stops[0].id, "ks:def");
        assert_eq!(guide.segments[1].spine_unit.lid, "2");
        assert_eq!(guide.segments[1].key_stops[0].id, "ks:app");

        let err = book.structure(Some("9.9")).unwrap_err();
        assert_eq!(err.error_code, "LID_NOT_FOUND");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_manifest_contract_covers_paper_slots_and_actions() {
        let manifest = ProfileManifest {
            profile_id: ContentProfileId::Paper,
            profile_version: "paper_v0".into(),
            projections: vec![ProjectionSpec {
                id: "paper.reading_guide".into(),
                kind: ProjectionKind::ReadingGuide,
                endpoint: "/book/paper_reading_guide".into(),
                runtime_tool: Some("book.paper_reading_guide".into()),
                mcp_tool: Some("book_paper_reading_guide".into()),
                ts_type: "PaperReadingGuide".into(),
                required: false,
            }],
            ui_slots: vec![UiSlotSpec {
                id: "paper.structure_map".into(),
                title: "Structure map".into(),
                kind: UiSlotKind::Map,
                primary_projection: Some("paper.reading_guide".into()),
                secondary_projections: vec!["paper.metadata".into()],
                allowed_actions: vec![
                    ReaderLayoutActionKind::OpenSlot,
                    ReaderLayoutActionKind::FocusSlot,
                    ReaderLayoutActionKind::PinEvidence,
                ],
                default_region: LayoutRegion::Left,
            }],
            layout_presets: vec![LayoutPresetSpec {
                id: "paper_skim".into(),
                title: "Skim".into(),
                description: "Open the paper structure map and agent slot.".into(),
                slots: vec![LayoutPresetSlot {
                    slot_id: "paper.structure_map".into(),
                    region: LayoutRegion::Left,
                    order: 0,
                    size: Some(LayoutSize {
                        kind: LayoutSizeKind::Percent,
                        value: 28.0,
                    }),
                }],
                focused_slot: Some("paper.structure_map".into()),
            }],
            allowed_layout_actions: vec![
                ReaderLayoutActionKind::OpenSlot,
                ReaderLayoutActionKind::SetLayoutPreset,
            ],
            agent_tools: vec![AgentToolSpec {
                name: "reader.layout.apply".into(),
                description: "Apply validated reader layout actions.".into(),
            }],
            guided_reading_policy: GuidedReadingPolicySpec {
                route_tool: "book.guided_route_from".into(),
                default_mode: Some("skim".into()),
                default_stage: Some("passive".into()),
                preferred_slot_ids: vec!["paper.structure_map".into()],
            },
            defaults: ProfileDefaults {
                layout_preset: Some("paper_skim".into()),
                open_slots: vec!["paper.structure_map".into()],
                focused_slot: Some("paper.structure_map".into()),
            },
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["profile_id"], "paper");
        assert_eq!(
            value["projections"][0]["runtime_tool"],
            "book.paper_reading_guide"
        );
        assert_eq!(value["ui_slots"][0]["default_region"], "left");
        assert_eq!(value["allowed_layout_actions"][1], "set_layout_preset");
    }

    #[test]
    fn reader_layout_action_contract_uses_closed_snake_case_tags() {
        let action = ReaderLayoutAction::PinEvidence {
            slot_id: "paper.evidence".into(),
            lid: "1.2".into(),
            reason: Some("supports the main claim".into()),
        };
        let value = serde_json::to_value(&action).unwrap();
        assert_eq!(value["kind"], "pin_evidence");
        assert_eq!(value["slot_id"], "paper.evidence");

        let state = ReaderLayoutState {
            rev: 7,
            active_preset: Some("paper_skim".into()),
            open_slots: vec!["paper.evidence".into()],
            focused_slot: Some("paper.evidence".into()),
            pinned_evidence: vec![PinnedEvidence {
                slot_id: "paper.evidence".into(),
                lid: "1.2".into(),
                reason: None,
            }],
            panel_sizes: HashMap::from([(
                "paper.evidence".into(),
                LayoutSize {
                    kind: LayoutSizeKind::Px,
                    value: 360.0,
                },
            )]),
            slot_order: HashMap::from([("right".into(), vec!["paper.evidence".into()])]),
        };
        let effect = ReaderLayoutEffect {
            before: state.clone(),
            after: ReaderLayoutState { rev: 8, ..state },
            actions: vec![action],
        };
        assert_eq!(effect.after.rev, effect.before.rev + 1);
    }

    #[test]
    fn profile_registry_returns_current_and_explicit_manifests() {
        let default_book = book();
        assert_eq!(
            default_book.content_profile_id(),
            ContentProfileId::TechnicalLearning
        );
        let current = default_book.profile_manifest();
        assert_eq!(current.profile_id, ContentProfileId::TechnicalLearning);
        assert_eq!(current.profile_version, TECHNICAL_LEARNING_PROFILE_VERSION);
        assert!(current
            .ui_slots
            .iter()
            .any(|slot| slot.id == "technical.structure_map"));

        let explicit_paper = default_book
            .profile_manifest_by_id(Some("paper"))
            .expect("paper manifest must be registered");
        assert_eq!(explicit_paper.profile_id, ContentProfileId::Paper);
        assert_eq!(explicit_paper.profile_version, PAPER_PROFILE_VERSION);
        assert!(explicit_paper
            .ui_slots
            .iter()
            .any(|slot| slot.id == "paper.ten_questions"));

        let base = structure_base();
        let paper_sidecar =
            parse_book_structure_sidecar(&paper_book_structure_json().to_string(), &base).unwrap();
        let paper_book = Book::new(base, &"AAAABBBBCCCCDDDD".to_string())
            .with_book_structure(Some(paper_sidecar));
        assert_eq!(paper_book.content_profile_id(), ContentProfileId::Paper);
        let summary = paper_book.profile_summary();
        assert_eq!(summary.profile_id, ContentProfileId::Paper);
        assert!(summary.ui_slots.iter().any(|slot| slot == "paper.evidence"));
        assert!(summary
            .allowed_layout_actions
            .contains(&ReaderLayoutActionKind::SetLayoutPreset));

        let err = paper_book.profile_manifest_by_id(Some("nope")).unwrap_err();
        assert_eq!(err.error_code, "PROFILE_NOT_FOUND");
    }

    #[test]
    fn paper_reading_guide_missing_paper_artifacts_degrades_explicitly() {
        let guide = book().paper_reading_guide(None, None).unwrap();
        assert!(!guide.available);
        assert_eq!(guide.mode, PaperReadingMode::Skim);
        assert_eq!(guide.stage, PaperReadingStage::Passive);
        assert!(guide.questions.is_empty());
        assert!(!guide.codebook.available);
        assert!(guide
            .warnings
            .iter()
            .any(|warning| warning.contains("paper artifacts not attached")));
        let metadata = book().paper_metadata_projection();
        assert!(!metadata.available);
        assert!(metadata.warning.unwrap().contains("not attached"));
        let lexicon = book().paper_lexicon_projection();
        assert!(!lexicon.available);
        assert!(lexicon.entries.is_empty());
    }

    #[test]
    fn load_valid_paper_sidecars_projects_reading_guide() {
        let base = structure_base();
        let dir = write_book_dir("ub-read-tools-paper-guide-valid", &base);
        std::fs::write(
            dir.join("book_structure.json"),
            paper_book_structure_json().to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("paper_metadata.json"),
            paper_metadata_json().to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("paper_lexicon.json"),
            paper_lexicon_json().to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("discourse_index.json"),
            paper_discourse_json().to_string(),
        )
        .unwrap();

        let book = Book::load(dir.to_str().unwrap()).unwrap();
        assert!(book.paper_metadata().is_some());
        assert!(book.paper_lexicon().is_some());

        let metadata = book.paper_metadata_projection();
        assert!(metadata.available);
        assert_eq!(metadata.header.unwrap().profile_id, "paper");
        assert_eq!(metadata.title.unwrap().source, "front_matter");
        assert_eq!(metadata.datasets.unwrap().evidence_lids, vec!["2.1"]);
        let lexicon = book.paper_lexicon_projection();
        assert!(lexicon.available);
        assert_eq!(lexicon.entries.len(), 2);
        assert_eq!(lexicon.entries[0].term, "RAG");

        let guide = book
            .paper_reading_guide(Some("close"), Some("active"))
            .unwrap();
        assert!(guide.available);
        assert_eq!(guide.mode, PaperReadingMode::Close);
        assert_eq!(guide.stage, PaperReadingStage::Active);
        assert_eq!(guide.questions.len(), 10);
        assert_eq!(
            guide.codebook.metadata.title.as_deref(),
            Some("Sample Paper")
        );
        assert_eq!(guide.codebook.metadata.datasets, vec!["SampleSet"]);
        assert!(guide
            .codebook
            .terms
            .iter()
            .any(|term| term.term == "RAG" && term.evidence_lids == vec!["1.1"]));
        assert!(guide.abstract_aid.available);
        assert_eq!(guide.abstract_aid.abstract_lids, vec!["1.1"]);
        assert!(guide.abstract_aid.excerpts[0].text.contains("AAAA"));
        assert!(guide
            .abstract_aid
            .key_terms
            .iter()
            .any(|term| term.term == "RAG"));
        let dataset = guide
            .questions
            .iter()
            .find(|question| question.id == "dataset")
            .unwrap();
        assert!(dataset.evidence_lids.iter().any(|lid| lid == "2.1"));
        assert!(dataset
            .answer_slots
            .iter()
            .any(|slot| slot.kind == PaperReadingAnswerSlotKind::PaperEvidence));
        assert!(dataset
            .answer_slots
            .iter()
            .any(|slot| slot.kind == PaperReadingAnswerSlotKind::UserReflection));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_bad_paper_lexicon_fails_fast() {
        let base = structure_base();
        let dir = write_book_dir("ub-read-tools-paper-lexicon-bad", &base);
        let mut lexicon = paper_lexicon_json();
        lexicon["entries"][0]["occurrences_lids"] = serde_json::json!(["9.9"]);
        std::fs::write(dir.join("paper_lexicon.json"), lexicon.to_string()).unwrap();

        let err = match Book::load(dir.to_str().unwrap()) {
            Ok(_) => panic!("expected bad paper_lexicon.json to fail"),
            Err(e) => e,
        };
        assert!(err.contains("paper_lexicon"));
        assert!(err.contains("不存在 LID"));
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

    // ---- P8-1 route_from ----
    #[test]
    fn nav_category_of_maps_each_bucket_and_unknown_to_cross() {
        assert_eq!(nav_category_of("prerequisite"), NavCategory::Back);
        assert_eq!(nav_category_of("depends_on"), NavCategory::Back);
        assert_eq!(nav_category_of("builds_on"), NavCategory::Forward);
        assert_eq!(nav_category_of("elaborates"), NavCategory::Forward);
        assert_eq!(nav_category_of("exemplifies"), NavCategory::Concretize);
        assert_eq!(nav_category_of("applies"), NavCategory::Concretize);
        assert_eq!(nav_category_of("answers"), NavCategory::Concretize);
        assert_eq!(nav_category_of("analogous_to"), NavCategory::Cross);
        assert_eq!(nav_category_of("contradicts"), NavCategory::Cross);
        assert_eq!(nav_category_of("next_sibling"), NavCategory::Continue);
        assert_eq!(nav_category_of("continues"), NavCategory::Continue);
        // 未知 local 边 → cross 兜底(保证覆盖全边类型、不丢边)
        assert_eq!(nav_category_of("cites"), NavCategory::Cross);
        assert_eq!(nav_category_of("totally_made_up"), NavCategory::Cross);
    }

    #[test]
    fn route_from_groups_far_edge_concept_and_sibling() {
        let b = book_with_far_edge();
        let f = b.route_from("1.1", None).unwrap();
        // builds_on long_range → forward
        assert_eq!(f.forward.len(), 1);
        assert_eq!(f.forward[0].lid, "2.1");
        assert_eq!(f.forward[0].edge_type, "builds_on");
        // next_sibling → continue
        assert_eq!(f.continue_.len(), 1);
        assert_eq!(f.continue_[0].lid, "1.2");
        assert_eq!(f.continue_[0].edge_type, "next_sibling");
        // 概念共现(entity:a 其余 occurrences)→ cross
        let mut cross_lids: Vec<&str> = f.cross.iter().map(|s| s.lid.as_str()).collect();
        cross_lids.sort();
        assert_eq!(cross_lids, vec!["1.2", "2.2"]);
        assert!(f.cross.iter().all(|s| s.edge_type == "co_occurrence"));
        // 无 back/concretize
        assert!(f.back.is_empty());
        assert!(f.concretize.is_empty());
    }

    #[test]
    fn route_from_leaf_no_edges_returns_empty_groups_not_error() {
        let b = book_isolated_leaf();
        let f = b.route_from("1.1", None).unwrap();
        assert!(
            f.back.is_empty()
                && f.forward.is_empty()
                && f.concretize.is_empty()
                && f.cross.is_empty()
                && f.continue_.is_empty()
        );
    }

    #[test]
    fn route_from_invalid_at_returns_not_found() {
        let b = book_with_far_edge();
        let err = b.route_from("9.9", None).unwrap_err();
        assert_eq!(err.error_code, "LID_NOT_FOUND");
        assert_eq!(err.category, "not_found");
    }

    #[test]
    fn route_from_consumes_discourse_relations_via_mapping() {
        let b = book_with_discourse_projection();
        let f = b.route_from("1.1", None).unwrap();
        // depends_on → back
        assert!(f
            .back
            .iter()
            .any(|s| s.lid == "2.1" && s.edge_type == "depends_on"));
        // elaborates → forward
        assert!(f
            .forward
            .iter()
            .any(|s| s.lid == "1.3" && s.edge_type == "elaborates"));
        // next_sibling → continue
        assert!(f
            .continue_
            .iter()
            .any(|s| s.lid == "1.2" && s.edge_type == "next_sibling"));
        // supports→9.9 悬空 target 在 discourse gate 已丢弃,不进任何组
        assert!(f.cross.iter().all(|s| s.lid != "9.9"));
    }

    #[test]
    fn route_from_truncates_each_group_to_k() {
        let b = book_with_far_edge();
        // cross 原有 2 项(1.2,2.2)→ k=1 截断,保留 score 高者(1.2,树距更近)
        let f = b.route_from("1.1", Some(1)).unwrap();
        assert_eq!(f.cross.len(), 1);
        assert_eq!(f.cross[0].lid, "1.2");
    }

    // ---- P8-2 route_to ----
    #[test]
    fn route_to_finds_direct_path() {
        let b = book_with_far_edge();
        // 1.1 -builds_on-> 2.1 是 1 跳直达。
        let path = b.route_to("1.1", "2.1", None).unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path[0].lid, "2.1");
        assert_eq!(path[0].edge_type, "builds_on");
    }

    #[test]
    fn route_to_finds_multi_hop_path() {
        let b = book_chain();
        // 1.1 → 1.2 → 1.3(无 1.1→1.3 直边),2 跳。
        let path = b.route_to("1.1", "1.3", None).unwrap();
        let lids: Vec<&str> = path.iter().map(|s| s.lid.as_str()).collect();
        assert_eq!(lids, vec!["1.2", "1.3"]);
    }

    #[test]
    fn route_to_same_endpoint_returns_empty_not_error() {
        let b = book_with_far_edge();
        assert!(b.route_to("1.1", "1.1", None).unwrap().is_empty());
    }

    #[test]
    fn route_to_unreachable_returns_empty_not_error() {
        let b = book_with_far_edge();
        // 章节 LID "2" 是真实 LID,但从不作为导航步出现(parent/child 不进前沿)→ 不可达。
        assert!(b.route_to("1.1", "2", None).unwrap().is_empty());
    }

    #[test]
    fn route_to_invalid_endpoint_returns_not_found() {
        let b = book_with_far_edge();
        let e1 = b.route_to("1.1", "9.9", None).unwrap_err();
        assert_eq!(e1.error_code, "LID_NOT_FOUND");
        assert_eq!(e1.category, "not_found");
        let e2 = b.route_to("9.9", "1.1", None).unwrap_err();
        assert_eq!(e2.error_code, "LID_NOT_FOUND");
    }

    #[test]
    fn route_to_respects_hop_budget() {
        let b = book_chain();
        // 目标需 2 跳,预算 k=1 → 够不到 → 空路径非 error。
        assert!(b.route_to("1.1", "1.3", Some(1)).unwrap().is_empty());
    }
}
