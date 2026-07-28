//! 读时确定性叶子工具(切片0:manifest/text;context/concept 见 S4c)`[ADR-0014]`。
//! 消费冻结只读基座 `base.json` + 旁路原文 `source.txt`(UTF-16 span 口径 `[ADR-0024]`)。
//! 纯函数库,无 LLM、provider 无关;HTTP 暴露推 S7。
use base_schema::{
    Direction, EdgeScope, FormulaSemantics, GraphNodeType, LidNode, NodeKind, ReadOnlyBase, Span,
};
use book_tool_contracts::{
    SearchMatchMode, SearchOrder, SearchRelativeDirection, SearchTextInput, SearchTextScope,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use ts_rs::TS;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::char::{canonical_combining_class, compose, decompose_compatible};

/// Versioned normalized-search semantics. Dependency or Unicode-data upgrades must change this
/// value because it is bound into every search cursor's canonical request digest.
pub const SEARCH_TEXT_NORMALIZATION_VERSION: &str =
    "nfkc-u17.0.0_unicode-normalization-0.1.25__full-casefold-u9.0.0_unicode-casefold-0.2.0__nonturkic-crlf-whitespace-v1";

// API DTO 的 ts-rs 导出目标(相对本 crate src/):前端类型契约单一真相源 `[ADR-0028 决策6]`。
// 与 base-schema(导出到 packages/core)分置:DTO 落 packages/web,跨指的 base 类型由 ts-rs 算相对 import。

/// 加载后的书:基座 + 原文(UTF-16 code unit 序列,span 即此口径 `[ADR-0024]`)+ lid 索引。
pub struct Book {
    pub base: ReadOnlyBase,
    source_u16: Vec<u16>,
    source_fingerprint: String,
    lid_idx: HashMap<String, usize>,
    node_idx: HashMap<String, usize>,
    formula_semantics: Vec<FormulaSemantics>,
    discourse_index: Vec<TechnicalLearningDiscourseItem>,
    book_structure: Option<BookStructureSidecar>,
    paper_metadata: Option<PaperMetadataSidecar>,
    paper_lexicon: Option<PaperLexiconSidecar>,
    paper_minimap_artifacts: PaperMinimapArtifacts,
}

#[derive(Debug, Clone, Default)]
struct PaperMinimapArtifacts {
    source_manifest: Option<RuntimeSourceManifestV2>,
    pdf_source_map: Option<RuntimePdfSourceMap>,
    pass2_audit: Option<RuntimePass2Audit>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimeSourceManifestV2 {
    version: String,
    book_id: String,
    canonical_source: RuntimeCanonicalSource,
    capabilities: RuntimePdfCapabilities,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimeCanonicalSource {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfCapabilities {
    view_pdf: RuntimePdfCapability,
    project_lid_to_pdf: RuntimePdfCapability,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfCapability {
    status: String,
    config_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfSourceMap {
    version: String,
    book_id: String,
    pages: Vec<RuntimePdfPage>,
    entries: Vec<RuntimePdfSourceMapEntry>,
    config_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfPage {
    #[serde(rename = "pageIndex")]
    page_index: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfSourceMapEntry {
    lid: String,
    source_span: Span,
    #[serde(default)]
    precision: Option<String>,
    #[serde(default)]
    exact_source_spans: Vec<Span>,
    regions: Vec<RuntimePdfRegion>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePdfRegion {
    #[serde(rename = "pageIndex")]
    page_index: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePass2Audit {
    header: ProfileArtifactHeader,
    accepted: Vec<RuntimePass2AuditEdge>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePass2AuditEdge {
    candidate_id: String,
    source: String,
    target: String,
    #[serde(rename = "type")]
    relation_type: String,
    source_evidence_lids: Vec<String>,
    target_evidence_lids: Vec<String>,
    evidence_lids: Vec<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapAvailabilityStatus {
    Available,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperRegionKind {
    Abstract,
    Introduction,
    RelatedWork,
    Method,
    Results,
    Discussion,
    Conclusion,
    References,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperRegionClassificationSource {
    Heading,
    Discourse,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperLandmarkKind {
    ResearchQuestion,
    Hypothesis,
    RelatedWork,
    Method,
    Experiment,
    Evidence,
    Result,
    Claim,
    Contribution,
    Limitation,
    FutureWork,
    Other,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperLandmarkProvenance {
    BookStructure,
    Discourse,
    Graph,
    Pass2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperMinimapRelation {
    Frames,
    Addresses,
    Tests,
    Produces,
    Supports,
    Challenges,
    Limits,
    Motivates,
    BuildsOn,
    Contrasts,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperArgumentSlot {
    Background,
    ResearchGap,
    ResearchQuestion,
    Hypothesis,
    Input,
    Object,
    MethodStep,
    Method,
    Output,
    Assumption,
    Experiment,
    Evidence,
    Result,
    Claim,
    Contribution,
    Interpretation,
    Limitation,
    FutureWork,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperLidSpan {
    pub start_lid: String,
    pub end_lid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperPageSpan {
    pub start_page: u32,
    pub end_page: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperRegion {
    pub region_id: String,
    pub title: String,
    pub kind: PaperRegionKind,
    pub lid_span: PaperLidSpan,
    pub page_span: PaperPageSpan,
    pub classification_source: PaperRegionClassificationSource,
    pub confidence: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperLandmark {
    pub landmark_id: String,
    pub kind: PaperLandmarkKind,
    pub anchor_lid: String,
    pub page_index: u32,
    pub label: String,
    pub source_label: Option<String>,
    pub evidence_lids: Vec<String>,
    pub provenance: Vec<PaperLandmarkProvenance>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperArgumentRelation {
    pub relation_id: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub relation_type: PaperMinimapRelation,
    pub source_landmark_id: String,
    pub target_landmark_id: String,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapLayerStatus {
    pub status: PaperMinimapAvailabilityStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct PaperMinimapBase {
    pub version: String,
    pub book_id: String,
    pub book_version: String,
    pub fingerprint: String,
    pub status: PaperMinimapAvailabilityStatus,
    pub regions: Vec<PaperRegion>,
    pub landmarks: Vec<PaperLandmark>,
    pub relations: Vec<PaperArgumentRelation>,
    pub layer_status: HashMap<String, PaperMinimapLayerStatus>,
    pub warnings: Vec<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum PaperReadingMode {
    Skim,
    Close,
    Deep,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, TS)]
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
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct MemoryPolicyRef {
    pub policy_id: String,
    pub policy_version: String,
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
    pub memory_policy: MemoryPolicyRef,
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
pub const TECHNICAL_LEARNING_MEMORY_POLICY_VERSION: &str = "technical_learning_memory_v1";
pub const PAPER_MEMORY_POLICY_VERSION: &str = "paper_memory_v1";

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
        memory_policy: MemoryPolicyRef {
            policy_id: "technical_learning".into(),
            policy_version: TECHNICAL_LEARNING_MEMORY_POLICY_VERSION.into(),
        },
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
        memory_policy: MemoryPolicyRef {
            policy_id: "paper".into(),
            policy_version: PAPER_MEMORY_POLICY_VERSION.into(),
        },
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceTextRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceSelectedRange {
    pub lid: String,
    pub range: SourceTextRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceRange {
    pub start_lid: String,
    pub end_lid: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ranges: Vec<SourceSelectedRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedSource {
    pub label: String,
    pub heading_path: Vec<String>,
    pub preview: String,
    pub evidence_text_digest: String,
    pub highlighted_quote: String,
    pub context_before: String,
    pub context_after: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum TextMatchType {
    Exact,
    Normalized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct TextOccurrenceRange {
    pub lid: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct HeadingPathItem {
    pub lid: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct TextOccurrence {
    pub ordinal: usize,
    pub start_lid: String,
    pub end_lid: String,
    pub source_range_utf16: Span,
    pub ranges: Vec<TextOccurrenceRange>,
    pub heading_path: Vec<HeadingPathItem>,
    pub excerpt: String,
    pub match_type: TextMatchType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SearchSectionCount {
    pub section_lid: String,
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExactSearchResult {
    pub source_revision: String,
    pub exhaustive: bool,
    pub total_occurrences: usize,
    pub total_lids: usize,
    pub occurrences: Vec<TextOccurrence>,
    pub section_counts: Vec<SearchSectionCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SearchTextResult {
    pub version: String,
    pub source_revision: String,
    pub exhaustive: bool,
    pub total_occurrences: usize,
    pub total_lids: usize,
    pub occurrences: Vec<TextOccurrence>,
    pub section_counts: Vec<SearchSectionCount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
struct MappedChar {
    value: char,
    source_start_utf16: usize,
    source_end_utf16: usize,
}

#[derive(Debug, Clone)]
struct MappedUnit {
    value: u16,
    source_start_utf16: usize,
    source_end_utf16: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchCursorV1 {
    version: String,
    source_revision: String,
    request_digest: String,
    offset: usize,
}

enum PreparedTextSearch {
    Exact {
        query: Vec<u16>,
        scope: Span,
    },
    Normalized {
        source_units: Vec<MappedUnit>,
        query: Vec<u16>,
    },
}

impl PreparedTextSearch {
    fn visit_matches(
        &self,
        source_u16: &[u16],
        mut visitor: impl FnMut(Span) -> Result<bool, ToolError>,
    ) -> Result<(), ToolError> {
        match self {
            Self::Exact { query, scope } => {
                if query.len() <= scope.end.saturating_sub(scope.start) {
                    let last_start = scope.end - query.len();
                    for start in scope.start..=last_start {
                        let end = start + query.len();
                        if source_u16[start..end] == *query.as_slice()
                            && !visitor(Span { start, end })?
                        {
                            break;
                        }
                    }
                }
            }
            Self::Normalized {
                source_units,
                query,
            } => {
                let mut previous = None;
                if query.len() <= source_units.len() {
                    for start in 0..=source_units.len() - query.len() {
                        let end = start + query.len();
                        if !source_units[start..end]
                            .iter()
                            .map(|unit| unit.value)
                            .eq(query.iter().copied())
                        {
                            continue;
                        }
                        let source_range = Span {
                            start: source_units[start..end]
                                .iter()
                                .map(|unit| unit.source_start_utf16)
                                .min()
                                .expect("normalized match has mapped units"),
                            end: source_units[start..end]
                                .iter()
                                .map(|unit| unit.source_end_utf16)
                                .max()
                                .expect("normalized match has mapped units"),
                        };
                        if previous.as_ref() == Some(&source_range) {
                            continue;
                        }
                        previous = Some(source_range.clone());
                        if !visitor(source_range)? {
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

struct SearchAggregate {
    total_occurrences: usize,
    total_lids: usize,
    section_counts: Vec<SearchSectionCount>,
}

pub fn disambiguate_source_labels(sources: &mut [ResolvedSource]) {
    let initial_labels: Vec<_> = sources.iter().map(|source| source.label.clone()).collect();
    for index in 0..sources.len() {
        if initial_labels
            .iter()
            .filter(|label| **label == initial_labels[index])
            .count()
            < 2
        {
            continue;
        }
        let kind_label = initial_labels[index]
            .split_once(" · ")
            .map(|(kind, _)| kind)
            .unwrap_or(initial_labels[index].as_str());
        for depth in 2..=sources[index].heading_path.len() {
            let start = sources[index].heading_path.len() - depth;
            let suffix = sources[index].heading_path[start..].join(" / ");
            let unique = sources.iter().enumerate().all(|(other_index, other)| {
                other_index == index
                    || other.heading_path.len() < depth
                    || other.heading_path[other.heading_path.len() - depth..].join(" / ") != suffix
            });
            if unique {
                sources[index].label = format!("{kind_label} · {suffix}");
                break;
            }
        }
    }
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CatalogRecallStrength {
    None,
    ContextOnly,
    Approximate,
    Direct,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CatalogReferentKind {
    Concept,
    Entity,
    PaperTerm,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CatalogReferentSource {
    Graph,
    PaperLexicon,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CatalogExcerpt {
    pub lid: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct CatalogHint {
    pub acronym_expansion: Option<String>,
    pub chinese_gloss: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReferentCandidate {
    pub candidate_id: String,
    pub kind: CatalogReferentKind,
    pub sources: Vec<CatalogReferentSource>,
    pub labels: Vec<String>,
    pub aliases: Vec<String>,
    pub recall_strength: CatalogRecallStrength,
    pub lexical_score: u32,
    pub match_reasons: Vec<String>,
    pub occurrence_lids: Vec<String>,
    pub defined_at_lid: Option<String>,
    pub excerpts: Vec<CatalogExcerpt>,
    pub hint_only: Option<CatalogHint>,
    pub anchor_distance: usize,
}

pub struct ReferentCatalog<'a> {
    book: &'a Book,
    anchor_lid: String,
}

pub fn fair_candidate_quotas(target_count: usize, total: usize) -> Vec<usize> {
    if target_count == 0 {
        return Vec::new();
    }
    let base = total / target_count;
    let remainder = total % target_count;
    (0..target_count)
        .map(|index| base + usize::from(index < remainder))
        .collect()
}

fn lexical_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn lexical_match(
    target: &str,
    labels: &[String],
    aliases: &[String],
    occurrence_texts: &[String],
) -> (CatalogRecallStrength, u32, Vec<String>) {
    let target_tokens: BTreeSet<String> = lexical_tokens(target).into_iter().collect();
    let target_joined = target_tokens.iter().cloned().collect::<Vec<_>>().join(" ");
    let mut label_tokens = BTreeSet::new();
    let mut exact_full = false;
    for field in labels.iter().chain(aliases) {
        let tokens = lexical_tokens(field);
        let joined = tokens.join(" ");
        exact_full |= !joined.is_empty() && joined == target_joined;
        label_tokens.extend(tokens);
    }
    let direct_overlap = target_tokens.intersection(&label_tokens).count();
    if exact_full || direct_overlap > 0 {
        return (
            CatalogRecallStrength::Direct,
            9_000
                + u32::try_from(direct_overlap)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(100)
                + u32::from(exact_full) * 900,
            vec![if exact_full {
                "exact label or alias".into()
            } else {
                "direct label token".into()
            }],
        );
    }

    let approximate_overlap = target_tokens
        .iter()
        .filter(|target_token| {
            target_token.chars().count() > 1
                && label_tokens.iter().any(|label_token| {
                    label_token.contains(target_token.as_str())
                        || target_token.contains(label_token.as_str())
                })
        })
        .count();
    if approximate_overlap > 0 {
        return (
            CatalogRecallStrength::Approximate,
            5_000
                + u32::try_from(approximate_overlap)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(100),
            vec!["approximate label token".into()],
        );
    }

    let context_hits = occurrence_texts
        .iter()
        .flat_map(|text| lexical_tokens(text))
        .filter(|token| target_tokens.contains(token))
        .count();
    if context_hits > 0 {
        return (
            CatalogRecallStrength::ContextOnly,
            1_000 + u32::try_from(context_hits).unwrap_or(u32::MAX).min(999),
            vec!["occurrence text token".into()],
        );
    }
    (CatalogRecallStrength::None, 0, Vec::new())
}

fn sentence_or_centered_excerpt(text: &str, target: &str, cap: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= cap {
        return text.to_string();
    }
    let lowercase = text.to_lowercase();
    let match_byte = lexical_tokens(target)
        .into_iter()
        .filter_map(|token| lowercase.find(&token))
        .min();
    let match_char = match_byte
        .map(|index| lowercase[..index].chars().count())
        .unwrap_or(0);
    let sentence_break = |ch: char| matches!(ch, '。' | '！' | '？' | '.' | '!' | '?' | '\n');
    let sentence_start = chars[..match_char.min(chars.len())]
        .iter()
        .rposition(|ch| sentence_break(*ch))
        .map(|index| index + 1)
        .unwrap_or(0);
    let sentence_end = chars[match_char.min(chars.len())..]
        .iter()
        .position(|ch| sentence_break(*ch))
        .map(|index| match_char + index + 1)
        .unwrap_or(chars.len());
    if sentence_end.saturating_sub(sentence_start) <= cap {
        return chars[sentence_start..sentence_end].iter().collect();
    }
    let start = match_char.saturating_sub(cap / 2).min(chars.len() - cap);
    chars[start..start + cap].iter().collect()
}

fn normalized_label_set(candidate: &ReferentCandidate) -> BTreeSet<String> {
    candidate
        .labels
        .iter()
        .chain(&candidate.aliases)
        .map(|value| lexical_tokens(value).join(" "))
        .filter(|value| !value.is_empty())
        .collect()
}

fn all_candidate_lids(candidate: &ReferentCandidate) -> BTreeSet<&str> {
    candidate
        .occurrence_lids
        .iter()
        .map(String::as_str)
        .chain(candidate.defined_at_lid.as_deref())
        .collect()
}

impl ReferentCandidate {
    fn compatible_for_paper_graph_merge(&self, other: &ReferentCandidate) -> bool {
        !normalized_label_set(self).is_disjoint(&normalized_label_set(other))
            && !all_candidate_lids(self).is_disjoint(&all_candidate_lids(other))
    }
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

fn load_optional_minimap_json<T: DeserializeOwned>(
    path: &str,
    label: &str,
    warnings: &mut Vec<String>,
) -> Option<T> {
    match std::fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(format!("{label} is invalid: {error}"));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            warnings.push(format!("{label} is not attached"));
            None
        }
        Err(error) => {
            warnings.push(format!("{label} cannot be read: {error}"));
            None
        }
    }
}

fn load_paper_minimap_artifacts(dir: &str) -> PaperMinimapArtifacts {
    let mut warnings = Vec::new();
    let source_manifest = load_optional_minimap_json(
        &format!("{dir}/source_manifest.json"),
        "source_manifest.json",
        &mut warnings,
    );
    let pdf_source_map = load_optional_minimap_json(
        &format!("{dir}/pdf_source_map.json"),
        "pdf_source_map.json",
        &mut warnings,
    );
    let pass2_audit = load_optional_minimap_json(
        &format!("{dir}/pass2_audit.json"),
        "pass2_audit.json",
        &mut warnings,
    );
    PaperMinimapArtifacts {
        source_manifest,
        pdf_source_map,
        pass2_audit,
        warnings,
    }
}

fn stable_minimap_fingerprint(parts: &[String]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in part.as_bytes().iter().chain(std::iter::once(&0_u8)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("paper-minimap-fnv1a64-{hash:016x}")
}

fn pdf_capability_usable(capability: &RuntimePdfCapability) -> bool {
    matches!(capability.status.as_str(), "available" | "degraded")
}

fn validate_runtime_pdf_entry_contract(
    map_version: &str,
    entry: &RuntimePdfSourceMapEntry,
) -> Result<(), String> {
    if map_version == "pdf_source_map.v1" {
        return Ok(());
    }
    let precision = entry
        .precision
        .as_deref()
        .ok_or_else(|| format!("PDF source map v2 entry has no precision: {}", entry.lid))?;
    if !matches!(
        precision,
        "char_exact" | "region_exact" | "partial" | "unmapped"
    ) {
        return Err(format!(
            "PDF source map v2 entry has unsupported precision: {} ({precision})",
            entry.lid
        ));
    }
    if entry.exact_source_spans.iter().any(|span| {
        span.start >= span.end
            || span.start < entry.source_span.start
            || span.end > entry.source_span.end
    }) {
        return Err(format!(
            "PDF source map v2 exact span is outside its LID: {}",
            entry.lid
        ));
    }
    if precision == "region_exact" && !entry.exact_source_spans.is_empty() {
        return Err(format!(
            "PDF source map v2 region_exact entry claims character spans: {}",
            entry.lid
        ));
    }
    if precision == "unmapped"
        && (!entry.regions.is_empty() || !entry.exact_source_spans.is_empty())
    {
        return Err(format!(
            "PDF source map v2 unmapped entry claims PDF evidence: {}",
            entry.lid
        ));
    }
    Ok(())
}

fn is_structural_node(node: &LidNode) -> bool {
    matches!(node.kind, NodeKind::Chapter | NodeKind::Section)
}

fn structural_parent_lids(lid: &str) -> Vec<String> {
    let parts: Vec<&str> = lid.split('.').collect();
    (1..parts.len()).map(|end| parts[..end].join(".")).collect()
}

fn select_paper_region_units<'a>(
    nodes: &'a [LidNode],
    by_lid: &HashMap<&str, &'a LidNode>,
) -> Vec<&'a LidNode> {
    let structural: Vec<&LidNode> = nodes
        .iter()
        .filter(|node| is_structural_node(node))
        .collect();
    let structural_lids: HashSet<&str> = structural.iter().map(|node| node.lid.as_str()).collect();
    let roots: Vec<&LidNode> = structural
        .iter()
        .copied()
        .filter(|node| {
            !structural_parent_lids(&node.lid)
                .iter()
                .any(|parent| structural_lids.contains(parent.as_str()))
        })
        .collect();
    if roots.len() == 1 {
        let children: Vec<&LidNode> = roots[0]
            .children
            .iter()
            .filter_map(|lid| by_lid.get(lid.as_str()).copied())
            .filter(|node| is_structural_node(node))
            .collect();
        if !children.is_empty() {
            return children;
        }
    }
    if !roots.is_empty() {
        return roots;
    }
    let non_leaf: Vec<&LidNode> = nodes
        .iter()
        .filter(|node| !node.children.is_empty())
        .collect();
    if !non_leaf.is_empty() {
        return non_leaf;
    }
    nodes.first().into_iter().collect()
}

fn normalize_paper_heading(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn structured_abstract_marker(text: &str) -> Option<&'static str> {
    let (label, _) = text.trim().split_once(':')?;
    match normalize_paper_heading(label).as_str() {
        "background" => Some("background"),
        "objective" | "objectives" | "aim" | "aims" => Some("objective"),
        "method" | "methods" => Some("methods"),
        "result" | "results" | "findings" => Some("results"),
        "conclusion" | "conclusions" => Some("conclusions"),
        _ => None,
    }
}

fn structured_abstract_leaf_lids(
    nodes: &[LidNode],
    source_u16: &[u16],
    before_offset: usize,
) -> Vec<String> {
    let leaves: Vec<&LidNode> = nodes
        .iter()
        .filter(|node| node.children.is_empty() && node.span.end <= before_offset)
        .collect();
    let markers: Vec<(usize, &'static str)> = leaves
        .iter()
        .enumerate()
        .filter_map(|(index, node)| {
            if node.kind != NodeKind::Paragraph {
                return None;
            }
            source_u16
                .get(node.span.start..node.span.end)
                .map(String::from_utf16_lossy)
                .as_deref()
                .and_then(structured_abstract_marker)
                .map(|marker| (index, marker))
        })
        .collect();
    let distinct: HashSet<&str> = markers.iter().map(|(_, marker)| *marker).collect();
    if distinct.len() < 2 || (!distinct.contains("results") && !distinct.contains("conclusions")) {
        return Vec::new();
    }
    let Some((start, _)) = markers.first() else {
        return Vec::new();
    };
    let Some((end, _)) = markers.last() else {
        return Vec::new();
    };
    leaves[*start..=*end]
        .iter()
        .map(|node| node.lid.clone())
        .collect()
}

fn is_end_matter_heading(title: &str) -> bool {
    matches!(
        normalize_paper_heading(title).as_str(),
        "acknowledgment"
            | "acknowledgments"
            | "acknowledgement"
            | "acknowledgements"
            | "author contributions"
            | "funding"
            | "disclosures"
            | "data availability"
            | "supplemental material"
    )
}

fn inherited_major_heading_kind(
    source_u16: &[u16],
    before_offset: usize,
) -> Option<PaperRegionKind> {
    let prefix = String::from_utf16_lossy(source_u16.get(..before_offset)?);
    let mut inherited = None;
    for line in prefix.lines() {
        let raw = line.trim();
        let markdown_heading = raw.starts_with('#');
        let heading = raw.trim_start_matches('#').trim();
        if heading.is_empty() {
            continue;
        }
        if is_end_matter_heading(heading)
            || classify_paper_heading(heading) == PaperRegionKind::References
        {
            inherited = None;
            continue;
        }
        let kind = classify_paper_heading(heading);
        if matches!(kind, PaperRegionKind::Results | PaperRegionKind::Discussion)
            || (!markdown_heading
                && matches!(
                    kind,
                    PaperRegionKind::Introduction
                        | PaperRegionKind::RelatedWork
                        | PaperRegionKind::Method
                        | PaperRegionKind::Conclusion
                ))
        {
            inherited = Some(kind);
        }
    }
    inherited
}

fn paper_heading(raw: &str, fallback: &str) -> String {
    let heading = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback)
        .trim_start_matches('#')
        .trim();
    let without_number = heading.trim_start_matches(|ch: char| {
        ch.is_ascii_digit() || matches!(ch, '.' | ')' | '(' | ':' | '-' | ' ')
    });
    if without_number.is_empty() {
        fallback.to_string()
    } else {
        without_number.to_string()
    }
}

fn classify_paper_heading(title: &str) -> PaperRegionKind {
    let normalized = normalize_paper_heading(title);
    match normalized.as_str() {
        "abstract" => PaperRegionKind::Abstract,
        "introduction" | "background" => PaperRegionKind::Introduction,
        "related work" | "literature review" => PaperRegionKind::RelatedWork,
        "materials and methods"
        | "methods"
        | "methodology"
        | "experimental procedures"
        | "experimental design" => PaperRegionKind::Method,
        "results" | "findings" => PaperRegionKind::Results,
        "results and discussion" | "discussion" => PaperRegionKind::Discussion,
        "conclusion" | "conclusions" | "concluding remarks" => PaperRegionKind::Conclusion,
        "references" | "bibliography" => PaperRegionKind::References,
        _ => PaperRegionKind::Unknown,
    }
}

#[derive(Debug, Clone)]
struct MinimapLandmarkCandidate {
    kind: PaperLandmarkKind,
    anchor_lid: String,
    label: String,
    source_label: Option<String>,
    evidence_lids: Vec<String>,
    provenance: Vec<PaperLandmarkProvenance>,
}

#[derive(Debug, Clone)]
struct NormalizedMinimapEdge {
    relation: PaperMinimapRelation,
    reverse: bool,
    source_kind: Option<PaperLandmarkKind>,
    target_kind: Option<PaperLandmarkKind>,
}

#[derive(Debug, Clone)]
struct PendingMinimapRelation {
    relation: PaperMinimapRelation,
    source_candidate_key: String,
    target_candidate_key: String,
    evidence_lids: Vec<String>,
}

fn paper_landmark_kind_key(kind: &PaperLandmarkKind) -> &'static str {
    match kind {
        PaperLandmarkKind::ResearchQuestion => "research_question",
        PaperLandmarkKind::Hypothesis => "hypothesis",
        PaperLandmarkKind::RelatedWork => "related_work",
        PaperLandmarkKind::Method => "method",
        PaperLandmarkKind::Experiment => "experiment",
        PaperLandmarkKind::Evidence => "evidence",
        PaperLandmarkKind::Result => "result",
        PaperLandmarkKind::Claim => "claim",
        PaperLandmarkKind::Contribution => "contribution",
        PaperLandmarkKind::Limitation => "limitation",
        PaperLandmarkKind::FutureWork => "future_work",
        PaperLandmarkKind::Other => "other",
    }
}

fn minimap_candidate_key(kind: &PaperLandmarkKind, anchor_lid: &str) -> String {
    format!("{}:{anchor_lid}", paper_landmark_kind_key(kind))
}

fn push_unique_provenance(
    target: &mut Vec<PaperLandmarkProvenance>,
    value: PaperLandmarkProvenance,
) {
    if !target.iter().any(|own| own == &value) {
        target.push(value);
    }
}

fn paper_relation_key(relation: &PaperMinimapRelation) -> &'static str {
    match relation {
        PaperMinimapRelation::Frames => "frames",
        PaperMinimapRelation::Addresses => "addresses",
        PaperMinimapRelation::Tests => "tests",
        PaperMinimapRelation::Produces => "produces",
        PaperMinimapRelation::Supports => "supports",
        PaperMinimapRelation::Challenges => "challenges",
        PaperMinimapRelation::Limits => "limits",
        PaperMinimapRelation::Motivates => "motivates",
        PaperMinimapRelation::BuildsOn => "builds_on",
        PaperMinimapRelation::Contrasts => "contrasts",
    }
}

fn discourse_landmark_kind(item: &TechnicalLearningDiscourseItem) -> Option<PaperLandmarkKind> {
    let local = match item.local_function.as_deref() {
        Some("research_question") => Some(PaperLandmarkKind::ResearchQuestion),
        Some("hypothesis") => Some(PaperLandmarkKind::Hypothesis),
        Some("related_work") => Some(PaperLandmarkKind::RelatedWork),
        Some("method_description") => Some(PaperLandmarkKind::Method),
        Some("experiment_setup") => Some(PaperLandmarkKind::Experiment),
        Some("evidence_report") => Some(PaperLandmarkKind::Evidence),
        Some("result_interpretation") => Some(PaperLandmarkKind::Result),
        Some("limitation") => Some(PaperLandmarkKind::Limitation),
        Some("future_work") => Some(PaperLandmarkKind::FutureWork),
        _ => None,
    };
    local.or_else(|| match item.rhetorical_move.as_deref() {
        Some("related_work_positioning") => Some(PaperLandmarkKind::RelatedWork),
        Some("method_setup") => Some(PaperLandmarkKind::Method),
        Some("experiment_report") => Some(PaperLandmarkKind::Experiment),
        Some("result_claim") => Some(PaperLandmarkKind::Claim),
        Some("limitation_acknowledgement") => Some(PaperLandmarkKind::Limitation),
        Some("future_work_projection") => Some(PaperLandmarkKind::FutureWork),
        _ => None,
    })
}

fn book_structure_key_stop_kind(stop: &BookStructureKeyStop) -> PaperLandmarkKind {
    match &stop.stop_type {
        BookStructureKeyStopType::Claim => PaperLandmarkKind::Claim,
        BookStructureKeyStopType::Example => PaperLandmarkKind::Evidence,
        BookStructureKeyStopType::Warning => PaperLandmarkKind::Limitation,
        BookStructureKeyStopType::Summary => PaperLandmarkKind::Contribution,
        _ => PaperLandmarkKind::Other,
    }
}

fn book_structure_spine_kind(role: &BookStructureSpineRole) -> PaperLandmarkKind {
    match role {
        BookStructureSpineRole::Method => PaperLandmarkKind::Method,
        BookStructureSpineRole::Synthesis => PaperLandmarkKind::Contribution,
        _ => PaperLandmarkKind::Other,
    }
}

fn graph_node_landmark_kind(node_type: &GraphNodeType) -> PaperLandmarkKind {
    match node_type {
        GraphNodeType::Claim => PaperLandmarkKind::Claim,
        _ => PaperLandmarkKind::Other,
    }
}

fn normalize_graph_relation(relation_type: &str) -> Option<NormalizedMinimapEdge> {
    let normalized = match relation_type {
        "claim_supported_by_evidence" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Supports,
            reverse: true,
            source_kind: Some(PaperLandmarkKind::Claim),
            target_kind: Some(PaperLandmarkKind::Evidence),
        },
        "method_supports_result" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Produces,
            reverse: false,
            source_kind: Some(PaperLandmarkKind::Method),
            target_kind: Some(PaperLandmarkKind::Result),
        },
        "hypothesis_tested_by_experiment" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Tests,
            reverse: true,
            source_kind: Some(PaperLandmarkKind::Hypothesis),
            target_kind: Some(PaperLandmarkKind::Experiment),
        },
        "related_work_contrasts" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Contrasts,
            reverse: false,
            source_kind: Some(PaperLandmarkKind::RelatedWork),
            target_kind: None,
        },
        "related_work_builds_on" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::BuildsOn,
            reverse: false,
            source_kind: Some(PaperLandmarkKind::RelatedWork),
            target_kind: None,
        },
        "limitation_motivates_future_work" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Motivates,
            reverse: false,
            source_kind: Some(PaperLandmarkKind::Limitation),
            target_kind: Some(PaperLandmarkKind::FutureWork),
        },
        "supports" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Supports,
            reverse: false,
            source_kind: None,
            target_kind: None,
        },
        "rebuts" | "contradicts" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Challenges,
            reverse: false,
            source_kind: None,
            target_kind: None,
        },
        "builds_on" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::BuildsOn,
            reverse: false,
            source_kind: None,
            target_kind: None,
        },
        "contrasts" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Contrasts,
            reverse: false,
            source_kind: None,
            target_kind: None,
        },
        "prerequisite" => NormalizedMinimapEdge {
            relation: PaperMinimapRelation::Frames,
            reverse: false,
            source_kind: None,
            target_kind: None,
        },
        _ => return None,
    };
    Some(normalized)
}

fn normalize_discourse_relation(relation_type: &str) -> Option<PaperMinimapRelation> {
    match relation_type {
        "supports" => Some(PaperMinimapRelation::Supports),
        "rebuts" => Some(PaperMinimapRelation::Challenges),
        "contrasts" => Some(PaperMinimapRelation::Contrasts),
        "answers" => Some(PaperMinimapRelation::Addresses),
        "depends_on" => Some(PaperMinimapRelation::BuildsOn),
        "prepares" => Some(PaperMinimapRelation::Frames),
        "results_in" => Some(PaperMinimapRelation::Produces),
        "causes" => Some(PaperMinimapRelation::Motivates),
        _ => None,
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

impl<'a> ReferentCatalog<'a> {
    fn source_texts(&self, lids: &[String]) -> Vec<String> {
        lids.iter()
            .filter_map(|lid| self.book.text(lid, None).ok())
            .collect()
    }

    fn anchor_distance(&self, lids: &[String]) -> usize {
        let Some(anchor_index) = self.book.lid_idx.get(&self.anchor_lid).copied() else {
            return usize::MAX;
        };
        lids.iter()
            .filter_map(|lid| self.book.lid_idx.get(lid).copied())
            .map(|index| index.abs_diff(anchor_index))
            .min()
            .unwrap_or(usize::MAX)
    }

    fn excerpts(&self, target: &str, lids: &[String]) -> Vec<CatalogExcerpt> {
        let target_tokens = lexical_tokens(target);
        let mut entries: Vec<(bool, usize, String, String)> = lids
            .iter()
            .filter_map(|lid| {
                self.book.text(lid, None).ok().map(|text| {
                    let normalized = text.to_lowercase();
                    let matched = target_tokens.iter().any(|token| normalized.contains(token));
                    let distance = self.anchor_distance(std::slice::from_ref(lid));
                    (matched, distance, lid.clone(), text)
                })
            })
            .collect();
        entries.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.cmp(&right.2))
        });
        entries
            .into_iter()
            .take(2)
            .map(|(_, _, lid, text)| CatalogExcerpt {
                lid,
                text: sentence_or_centered_excerpt(&text, target, 180),
            })
            .collect()
    }

    fn refresh_match(&self, target: &str, candidate: &mut ReferentCandidate) {
        let mut search_labels = candidate.labels.clone();
        search_labels.push(candidate.candidate_id.clone());
        let texts = self.source_texts(&candidate.occurrence_lids);
        let (strength, score, reasons) =
            lexical_match(target, &search_labels, &candidate.aliases, &texts);
        candidate.recall_strength = strength;
        candidate.lexical_score = score;
        candidate.match_reasons = reasons;
        let mut evidence_lids = Vec::new();
        if let Some(defined_at) = &candidate.defined_at_lid {
            evidence_lids.push(defined_at.clone());
        }
        for lid in &candidate.occurrence_lids {
            if !evidence_lids.contains(lid) {
                evidence_lids.push(lid.clone());
            }
        }
        candidate.anchor_distance = self.anchor_distance(&evidence_lids);
        candidate.excerpts = if strength == CatalogRecallStrength::None {
            Vec::new()
        } else {
            self.excerpts(target, &evidence_lids)
        };
        candidate.aliases.truncate(6);
    }

    fn graph_candidates(&self, target: &str) -> Vec<ReferentCandidate> {
        self.book
            .base
            .graph_nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.node_type,
                    GraphNodeType::Concept | GraphNodeType::Entity
                )
            })
            .map(|node| {
                let mut candidate = ReferentCandidate {
                    candidate_id: node.id.clone(),
                    kind: if node.node_type == GraphNodeType::Concept {
                        CatalogReferentKind::Concept
                    } else {
                        CatalogReferentKind::Entity
                    },
                    sources: vec![CatalogReferentSource::Graph],
                    labels: vec![node.name.clone()],
                    aliases: Vec::new(),
                    recall_strength: CatalogRecallStrength::None,
                    lexical_score: 0,
                    match_reasons: Vec::new(),
                    occurrence_lids: node.occurrences.clone(),
                    defined_at_lid: None,
                    excerpts: Vec::new(),
                    hint_only: None,
                    anchor_distance: usize::MAX,
                };
                self.refresh_match(target, &mut candidate);
                candidate
            })
            .collect()
    }

    fn paper_candidates(&self, target: &str) -> Vec<ReferentCandidate> {
        let Some(lexicon) = self.book.paper_lexicon() else {
            return Vec::new();
        };
        lexicon
            .entries
            .iter()
            .map(|entry| {
                let mut aliases = entry.aliases.clone();
                if let Some(expansion) = &entry.acronym_expansion {
                    if !aliases.contains(expansion) {
                        aliases.push(expansion.clone());
                    }
                }
                let stable_term = lexical_tokens(&entry.term).join("_");
                let mut candidate = ReferentCandidate {
                    candidate_id: format!("paper_term:{stable_term}"),
                    kind: CatalogReferentKind::PaperTerm,
                    sources: vec![CatalogReferentSource::PaperLexicon],
                    labels: vec![entry.term.clone()],
                    aliases,
                    recall_strength: CatalogRecallStrength::None,
                    lexical_score: 0,
                    match_reasons: Vec::new(),
                    occurrence_lids: entry.occurrences_lids.clone(),
                    defined_at_lid: entry.defined_at_lid.clone(),
                    excerpts: Vec::new(),
                    hint_only: Some(CatalogHint {
                        acronym_expansion: entry.acronym_expansion.clone(),
                        chinese_gloss: entry.chinese_gloss.clone(),
                    }),
                    anchor_distance: usize::MAX,
                };
                self.refresh_match(target, &mut candidate);
                candidate
            })
            .collect()
    }

    pub fn search(&self, target: &str, limit: usize) -> Vec<ReferentCandidate> {
        let mut graph = self.graph_candidates(target);
        let mut merged = Vec::new();
        for mut paper in self.paper_candidates(target) {
            let matching_graph: Vec<usize> = graph
                .iter()
                .enumerate()
                .filter_map(|(index, candidate)| {
                    paper
                        .compatible_for_paper_graph_merge(candidate)
                        .then_some(index)
                })
                .collect();
            for index in matching_graph.into_iter().rev() {
                let graph_candidate = graph.remove(index);
                for source in graph_candidate.sources {
                    if !paper.sources.contains(&source) {
                        paper.sources.push(source);
                    }
                }
                for label in graph_candidate.labels {
                    if !paper.labels.contains(&label) {
                        paper.labels.push(label);
                    }
                }
                for alias in graph_candidate.aliases {
                    if !paper.aliases.contains(&alias) {
                        paper.aliases.push(alias);
                    }
                }
                for lid in graph_candidate.occurrence_lids {
                    if !paper.occurrence_lids.contains(&lid) {
                        paper.occurrence_lids.push(lid);
                    }
                }
            }
            paper.sources.sort();
            self.refresh_match(target, &mut paper);
            merged.push(paper);
        }
        merged.extend(graph);
        merged.sort_by(|left, right| {
            right
                .recall_strength
                .cmp(&left.recall_strength)
                .then_with(|| right.lexical_score.cmp(&left.lexical_score))
                .then_with(|| left.anchor_distance.cmp(&right.anchor_distance))
                .then_with(|| left.candidate_id.cmp(&right.candidate_id))
        });
        merged.truncate(limit);
        merged
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
        let paper_minimap_artifacts = load_paper_minimap_artifacts(dir);
        Ok(Book::new(base, &source)
            .with_formula_semantics(formula_semantics)
            .with_discourse_items(discourse_items)
            .with_book_structure(book_structure)
            .with_paper_metadata(paper_metadata)
            .with_paper_lexicon(paper_lexicon)
            .with_paper_minimap_artifacts(paper_minimap_artifacts))
    }

    pub fn new(base: ReadOnlyBase, source: &str) -> Book {
        let source_u16: Vec<u16> = source.encode_utf16().collect();
        let source_fingerprint = search_sha256_hex(source.as_bytes());
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
            source_fingerprint,
            lid_idx,
            node_idx,
            formula_semantics: Vec::new(),
            discourse_index: Vec::new(),
            book_structure: None,
            paper_metadata: None,
            paper_lexicon: None,
            paper_minimap_artifacts: PaperMinimapArtifacts::default(),
        }
    }

    /// SHA-256 of the canonical `source.txt` bytes loaded into this Book.
    pub fn source_fingerprint(&self) -> &str {
        &self.source_fingerprint
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

    pub fn referent_catalog(&self, anchor_lid: &str) -> Result<ReferentCatalog<'_>, ToolError> {
        self.node(anchor_lid)?;
        Ok(ReferentCatalog {
            book: self,
            anchor_lid: anchor_lid.into(),
        })
    }

    fn with_paper_minimap_artifacts(mut self, artifacts: PaperMinimapArtifacts) -> Book {
        self.paper_minimap_artifacts = artifacts;
        self
    }

    fn paper_minimap_book_version(&self) -> String {
        self.book_structure
            .as_ref()
            .map(|sidecar| sidecar.header.book_version.clone())
            .or_else(|| {
                self.paper_minimap_artifacts
                    .source_manifest
                    .as_ref()
                    .map(|manifest| manifest.canonical_source.sha256.clone())
            })
            .filter(|version| !version.trim().is_empty())
            .unwrap_or_else(|| "unknown".into())
    }

    fn unavailable_paper_minimap(
        &self,
        mut warnings: Vec<String>,
        reason: impl Into<String>,
    ) -> PaperMinimapBase {
        let reason = reason.into();
        if !warnings.iter().any(|warning| warning == &reason) {
            warnings.push(reason.clone());
        }
        let book_version = self.paper_minimap_book_version();
        PaperMinimapBase {
            version: "paper_minimap.v1".into(),
            book_id: self.base.book_id.clone(),
            fingerprint: stable_minimap_fingerprint(&[
                self.base.book_id.clone(),
                book_version.clone(),
                "unavailable".into(),
                reason.clone(),
            ]),
            book_version,
            status: PaperMinimapAvailabilityStatus::Unavailable,
            regions: Vec::new(),
            landmarks: Vec::new(),
            relations: Vec::new(),
            layer_status: HashMap::from([
                (
                    "topology".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Unavailable,
                        reason: Some(reason),
                    },
                ),
                (
                    "regions".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Unavailable,
                        reason: Some("topology is unavailable".into()),
                    },
                ),
                (
                    "landmarks".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Unavailable,
                        reason: Some("landmark projection has not run".into()),
                    },
                ),
                (
                    "arguments".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Unavailable,
                        reason: Some("argument projection has not run".into()),
                    },
                ),
            ]),
            warnings,
        }
    }

    fn validated_paper_minimap_artifacts(
        &self,
    ) -> Result<
        (
            &RuntimeSourceManifestV2,
            &RuntimePdfSourceMap,
            HashMap<&str, &RuntimePdfSourceMapEntry>,
        ),
        String,
    > {
        let manifest = self
            .paper_minimap_artifacts
            .source_manifest
            .as_ref()
            .ok_or_else(|| "source_manifest.v2 is unavailable".to_string())?;
        let pdf_map = self
            .paper_minimap_artifacts
            .pdf_source_map
            .as_ref()
            .ok_or_else(|| "PDF source map is unavailable".to_string())?;
        if manifest.version != "source_manifest.v2" {
            return Err(format!(
                "unsupported source manifest version: {}",
                manifest.version
            ));
        }
        if !matches!(
            pdf_map.version.as_str(),
            "pdf_source_map.v1" | "pdf_source_map.v2"
        ) {
            return Err(format!(
                "unsupported PDF source map version: {}",
                pdf_map.version
            ));
        }
        if manifest.book_id != self.base.book_id || pdf_map.book_id != self.base.book_id {
            return Err("paper minimap artifacts do not match base book_id".into());
        }
        if manifest.canonical_source.path != "source.txt"
            || manifest.canonical_source.sha256.trim().is_empty()
        {
            return Err("source manifest canonical source identity is invalid".into());
        }
        if !pdf_capability_usable(&manifest.capabilities.view_pdf)
            || !pdf_capability_usable(&manifest.capabilities.project_lid_to_pdf)
        {
            return Err("PDF view or LID projection capability is unavailable".into());
        }
        let manifest_config_hash = manifest
            .capabilities
            .project_lid_to_pdf
            .config_hash
            .as_deref()
            .filter(|hash| !hash.trim().is_empty())
            .ok_or_else(|| "PDF projection capability has no config_hash".to_string())?;
        if pdf_map.config_hash.trim().is_empty() || manifest_config_hash != pdf_map.config_hash {
            return Err("PDF source map config_hash is stale".into());
        }

        let mut page_indices = HashSet::new();
        for page in &pdf_map.pages {
            if !page_indices.insert(page.page_index) {
                return Err(format!("duplicate PDF page identity: {}", page.page_index));
            }
        }
        if page_indices.is_empty() {
            return Err("PDF source map contains no pages".into());
        }

        let mut entries = HashMap::new();
        for entry in &pdf_map.entries {
            validate_runtime_pdf_entry_contract(&pdf_map.version, entry)?;
            if entries.insert(entry.lid.as_str(), entry).is_some() {
                return Err(format!("duplicate PDF source map LID: {}", entry.lid));
            }
            let node = self
                .lid_idx
                .get(&entry.lid)
                .map(|index| &self.base.lid_nodes[*index])
                .ok_or_else(|| format!("PDF source map references missing LID: {}", entry.lid))?;
            if !node.children.is_empty() {
                return Err(format!("PDF source map LID is not a leaf: {}", entry.lid));
            }
            if entry.source_span != node.span {
                return Err(format!(
                    "PDF source map span is stale for LID: {}",
                    entry.lid
                ));
            }
            for region in &entry.regions {
                if !page_indices.contains(&region.page_index) {
                    return Err(format!(
                        "PDF source map LID {} references missing page {}",
                        entry.lid, region.page_index
                    ));
                }
            }
        }
        Ok((manifest, pdf_map, entries))
    }

    fn collect_minimap_leaf_lids(&self, lid: &str, leaves: &mut Vec<String>) -> Result<(), String> {
        let node = self
            .lid_idx
            .get(lid)
            .map(|index| &self.base.lid_nodes[*index])
            .ok_or_else(|| format!("structure references missing LID: {lid}"))?;
        if node.children.is_empty() {
            leaves.push(node.lid.clone());
            return Ok(());
        }
        for child in &node.children {
            self.collect_minimap_leaf_lids(child, leaves)?;
        }
        Ok(())
    }

    fn paper_region_from_leaves(
        &self,
        region_id: String,
        title: String,
        kind: PaperRegionKind,
        classification_source: PaperRegionClassificationSource,
        confidence: f32,
        leaves: Vec<String>,
        entries: &HashMap<&str, &RuntimePdfSourceMapEntry>,
        warnings: &mut Vec<String>,
    ) -> Option<PaperRegion> {
        let pages: Vec<u32> = leaves
            .iter()
            .filter_map(|lid| entries.get(lid.as_str()))
            .flat_map(|entry| entry.regions.iter().map(|region| region.page_index))
            .collect();
        let (Some(start_page), Some(end_page)) =
            (pages.iter().min().copied(), pages.iter().max().copied())
        else {
            warnings.push(format!("paper region {region_id} has no PDF projection"));
            return None;
        };
        let Some(start_lid) = leaves.first().cloned() else {
            warnings.push(format!("paper region {region_id} has no leaf LID"));
            return None;
        };
        let end_lid = leaves.last().cloned().unwrap_or_else(|| start_lid.clone());
        Some(PaperRegion {
            region_id,
            title,
            kind,
            lid_span: PaperLidSpan { start_lid, end_lid },
            page_span: PaperPageSpan {
                start_page,
                end_page,
            },
            classification_source,
            confidence,
        })
    }

    fn minimap_source_excerpt(&self, lid: &str) -> Option<String> {
        let node = self
            .lid_idx
            .get(lid)
            .map(|index| &self.base.lid_nodes[*index])?;
        let text = self.source_u16.get(node.span.start..node.span.end)?;
        let value = String::from_utf16_lossy(text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if value.is_empty() {
            None
        } else {
            Some(value.chars().take(160).collect())
        }
    }

    fn graph_node_evidence_lids(&self, node: &base_schema::GraphNode) -> Vec<String> {
        match &node.node_type {
            GraphNodeType::Claim => node.source_lid.clone().into_iter().collect(),
            _ => node.occurrences.clone(),
        }
    }

    fn insert_minimap_candidate(
        &self,
        candidates: &mut HashMap<String, MinimapLandmarkCandidate>,
        mut candidate: MinimapLandmarkCandidate,
        warnings: &mut Vec<String>,
    ) -> Option<String> {
        if !self.lid_idx.contains_key(&candidate.anchor_lid) {
            warnings.push(format!(
                "paper landmark candidate references missing anchor LID: {}",
                candidate.anchor_lid
            ));
            return None;
        }
        if candidate.evidence_lids.is_empty() {
            candidate.evidence_lids.push(candidate.anchor_lid.clone());
        }
        if let Some(dangling) = candidate
            .evidence_lids
            .iter()
            .find(|lid| !self.lid_idx.contains_key(*lid))
        {
            warnings.push(format!(
                "paper landmark candidate {} has dangling evidence LID: {dangling}",
                candidate.anchor_lid
            ));
            return None;
        }
        let mut unique_evidence = Vec::new();
        push_unique_all(&mut unique_evidence, &candidate.evidence_lids);
        candidate.evidence_lids = unique_evidence;
        if candidate.label.trim().is_empty() {
            candidate.label = self
                .minimap_source_excerpt(&candidate.anchor_lid)
                .unwrap_or_else(|| candidate.anchor_lid.clone());
        }
        let key = minimap_candidate_key(&candidate.kind, &candidate.anchor_lid);
        if let Some(existing) = candidates.get_mut(&key) {
            push_unique_all(&mut existing.evidence_lids, &candidate.evidence_lids);
            for provenance in candidate.provenance {
                push_unique_provenance(&mut existing.provenance, provenance);
            }
            if existing.source_label.is_none() {
                existing.source_label = candidate.source_label;
            }
        } else {
            candidates.insert(key.clone(), candidate);
        }
        Some(key)
    }

    fn minimap_candidate_page(
        &self,
        candidate: &MinimapLandmarkCandidate,
        entries: &HashMap<&str, &RuntimePdfSourceMapEntry>,
    ) -> Option<u32> {
        let direct_pages = candidate
            .evidence_lids
            .iter()
            .chain(std::iter::once(&candidate.anchor_lid))
            .filter_map(|lid| entries.get(lid.as_str()))
            .flat_map(|entry| entry.regions.iter().map(|region| region.page_index));
        if let Some(page) = direct_pages.min() {
            return Some(page);
        }
        let mut leaves = Vec::new();
        self.collect_minimap_leaf_lids(&candidate.anchor_lid, &mut leaves)
            .ok()?;
        leaves
            .iter()
            .filter_map(|lid| entries.get(lid.as_str()))
            .flat_map(|entry| entry.regions.iter().map(|region| region.page_index))
            .min()
    }

    fn valid_minimap_relation_evidence(&self, evidence_lids: &[String]) -> bool {
        !evidence_lids.is_empty()
            && evidence_lids
                .iter()
                .all(|lid| self.lid_idx.contains_key(lid))
    }

    fn insert_pending_minimap_relation(
        &self,
        relations: &mut HashMap<String, PendingMinimapRelation>,
        relation: PaperMinimapRelation,
        source_candidate_key: String,
        target_candidate_key: String,
        evidence_lids: Vec<String>,
        warning_context: &str,
        warnings: &mut Vec<String>,
    ) {
        if !self.valid_minimap_relation_evidence(&evidence_lids) {
            warnings.push(format!(
                "{warning_context} has empty or dangling evidence_lids"
            ));
            return;
        }
        let key = format!(
            "{}|{}|{}",
            paper_relation_key(&relation),
            source_candidate_key,
            target_candidate_key
        );
        if let Some(existing) = relations.get_mut(&key) {
            push_unique_all(&mut existing.evidence_lids, &evidence_lids);
        } else {
            let mut unique_evidence = Vec::new();
            push_unique_all(&mut unique_evidence, &evidence_lids);
            relations.insert(
                key,
                PendingMinimapRelation {
                    relation,
                    source_candidate_key,
                    target_candidate_key,
                    evidence_lids: unique_evidence,
                },
            );
        }
    }

    fn project_discourse_minimap_relations(
        &self,
        discourse_by_lid: &HashMap<&str, &TechnicalLearningDiscourseItem>,
        candidates: &mut HashMap<String, MinimapLandmarkCandidate>,
        relations: &mut HashMap<String, PendingMinimapRelation>,
        warnings: &mut Vec<String>,
    ) {
        for item in &self.discourse_index {
            for relation in &item.relations {
                let Some(normalized) = normalize_discourse_relation(&relation.relation_type) else {
                    continue;
                };
                let Some(target_item) = discourse_by_lid.get(relation.target_lid.as_str()) else {
                    warnings.push(format!(
                        "discourse relation {} -> {} has no target item",
                        item.lid, relation.target_lid
                    ));
                    continue;
                };
                if !relation.evidence_lids.iter().any(|lid| lid == &item.lid)
                    || !relation
                        .evidence_lids
                        .iter()
                        .any(|lid| lid == &relation.target_lid)
                {
                    warnings.push(format!(
                        "discourse relation {} -> {} does not cover both endpoints",
                        item.lid, relation.target_lid
                    ));
                    continue;
                }
                let source_kind = discourse_landmark_kind(item).unwrap_or(PaperLandmarkKind::Other);
                let target_kind =
                    discourse_landmark_kind(target_item).unwrap_or(PaperLandmarkKind::Other);
                let source_key = self.insert_minimap_candidate(
                    candidates,
                    MinimapLandmarkCandidate {
                        kind: source_kind,
                        anchor_lid: item.lid.clone(),
                        label: item
                            .local_summary
                            .clone()
                            .or_else(|| self.minimap_source_excerpt(&item.lid))
                            .unwrap_or_else(|| item.lid.clone()),
                        source_label: self.minimap_source_excerpt(&item.lid),
                        evidence_lids: vec![item.lid.clone()],
                        provenance: vec![PaperLandmarkProvenance::Discourse],
                    },
                    warnings,
                );
                let target_key = self.insert_minimap_candidate(
                    candidates,
                    MinimapLandmarkCandidate {
                        kind: target_kind,
                        anchor_lid: target_item.lid.clone(),
                        label: target_item
                            .local_summary
                            .clone()
                            .or_else(|| self.minimap_source_excerpt(&target_item.lid))
                            .unwrap_or_else(|| target_item.lid.clone()),
                        source_label: self.minimap_source_excerpt(&target_item.lid),
                        evidence_lids: vec![target_item.lid.clone()],
                        provenance: vec![PaperLandmarkProvenance::Discourse],
                    },
                    warnings,
                );
                let (Some(source_key), Some(target_key)) = (source_key, target_key) else {
                    continue;
                };
                self.insert_pending_minimap_relation(
                    relations,
                    normalized,
                    source_key,
                    target_key,
                    relation.evidence_lids.clone(),
                    "discourse relation",
                    warnings,
                );
            }
        }
    }

    fn graph_relation_endpoint_candidate(
        &self,
        node: &base_schema::GraphNode,
        kind: PaperLandmarkKind,
        evidence_lids: &[String],
        provenance: Vec<PaperLandmarkProvenance>,
        candidates: &mut HashMap<String, MinimapLandmarkCandidate>,
        warnings: &mut Vec<String>,
    ) -> Option<String> {
        let anchor_lid = evidence_lids.first()?.clone();
        self.insert_minimap_candidate(
            candidates,
            MinimapLandmarkCandidate {
                kind,
                anchor_lid: anchor_lid.clone(),
                label: node.name.clone(),
                source_label: self.minimap_source_excerpt(&anchor_lid),
                evidence_lids: evidence_lids.to_vec(),
                provenance,
            },
            warnings,
        )
    }

    fn project_graph_minimap_relations(
        &self,
        candidates: &mut HashMap<String, MinimapLandmarkCandidate>,
        relations: &mut HashMap<String, PendingMinimapRelation>,
        warnings: &mut Vec<String>,
    ) {
        for edge in &self.base.graph_edges {
            if edge.scope != EdgeScope::Local {
                continue;
            }
            let Some(normalized) = normalize_graph_relation(&edge.edge_type) else {
                continue;
            };
            let (Some(source_index), Some(target_index)) = (
                self.node_idx.get(&edge.source),
                self.node_idx.get(&edge.target),
            ) else {
                warnings.push(format!(
                    "graph relation {} has a missing graph endpoint",
                    edge.edge_type
                ));
                continue;
            };
            let source_node = &self.base.graph_nodes[*source_index];
            let target_node = &self.base.graph_nodes[*target_index];
            let source_evidence = self.graph_node_evidence_lids(source_node);
            let target_evidence = self.graph_node_evidence_lids(target_node);
            let source_kind = normalized
                .source_kind
                .clone()
                .unwrap_or_else(|| graph_node_landmark_kind(&source_node.node_type));
            let target_kind = normalized
                .target_kind
                .clone()
                .unwrap_or_else(|| graph_node_landmark_kind(&target_node.node_type));
            let source_key = self.graph_relation_endpoint_candidate(
                source_node,
                source_kind,
                &source_evidence,
                vec![PaperLandmarkProvenance::Graph],
                candidates,
                warnings,
            );
            let target_key = self.graph_relation_endpoint_candidate(
                target_node,
                target_kind,
                &target_evidence,
                vec![PaperLandmarkProvenance::Graph],
                candidates,
                warnings,
            );
            let (Some(mut source_key), Some(mut target_key)) = (source_key, target_key) else {
                warnings.push(format!(
                    "graph relation {} has an endpoint without LID evidence",
                    edge.edge_type
                ));
                continue;
            };
            if normalized.reverse {
                std::mem::swap(&mut source_key, &mut target_key);
            }
            let mut evidence_lids = source_evidence;
            push_unique_all(&mut evidence_lids, &target_evidence);
            self.insert_pending_minimap_relation(
                relations,
                normalized.relation,
                source_key,
                target_key,
                evidence_lids,
                "graph relation",
                warnings,
            );
        }

        let Some(audit) = &self.paper_minimap_artifacts.pass2_audit else {
            return;
        };
        if audit.header.book_id != self.base.book_id
            || self
                .book_structure
                .as_ref()
                .is_some_and(|structure| structure.header.book_version != audit.header.book_version)
        {
            warnings.push("pass2_audit.json header does not match the paper minimap base".into());
            return;
        }
        for edge in &audit.accepted {
            let Some(normalized) = normalize_graph_relation(&edge.relation_type) else {
                continue;
            };
            let (Some(source_index), Some(target_index)) = (
                self.node_idx.get(&edge.source),
                self.node_idx.get(&edge.target),
            ) else {
                warnings.push(format!(
                    "Pass2 edge {} has a missing graph endpoint",
                    edge.candidate_id
                ));
                continue;
            };
            let evidence_covers_sides = edge
                .source_evidence_lids
                .iter()
                .chain(edge.target_evidence_lids.iter())
                .all(|lid| edge.evidence_lids.iter().any(|evidence| evidence == lid));
            if edge.source_evidence_lids.is_empty()
                || edge.target_evidence_lids.is_empty()
                || !evidence_covers_sides
                || !self.valid_minimap_relation_evidence(&edge.evidence_lids)
            {
                warnings.push(format!(
                    "Pass2 edge {} has invalid evidence",
                    edge.candidate_id
                ));
                continue;
            }
            let source_node = &self.base.graph_nodes[*source_index];
            let target_node = &self.base.graph_nodes[*target_index];
            let source_kind = normalized
                .source_kind
                .clone()
                .unwrap_or_else(|| graph_node_landmark_kind(&source_node.node_type));
            let target_kind = normalized
                .target_kind
                .clone()
                .unwrap_or_else(|| graph_node_landmark_kind(&target_node.node_type));
            let provenance = vec![
                PaperLandmarkProvenance::Graph,
                PaperLandmarkProvenance::Pass2,
            ];
            let source_key = self.graph_relation_endpoint_candidate(
                source_node,
                source_kind,
                &edge.source_evidence_lids,
                provenance.clone(),
                candidates,
                warnings,
            );
            let target_key = self.graph_relation_endpoint_candidate(
                target_node,
                target_kind,
                &edge.target_evidence_lids,
                provenance,
                candidates,
                warnings,
            );
            let (Some(mut source_key), Some(mut target_key)) = (source_key, target_key) else {
                continue;
            };
            if normalized.reverse {
                std::mem::swap(&mut source_key, &mut target_key);
            }
            self.insert_pending_minimap_relation(
                relations,
                normalized.relation,
                source_key,
                target_key,
                edge.evidence_lids.clone(),
                "Pass2 relation",
                warnings,
            );
        }
    }

    fn project_book_structure_minimap_relations(
        &self,
        _candidates: &mut HashMap<String, MinimapLandmarkCandidate>,
        relations: &mut HashMap<String, PendingMinimapRelation>,
        warnings: &mut Vec<String>,
    ) {
        let Some(structure) = &self.book_structure else {
            return;
        };
        let units_by_lid: HashMap<&str, &BookStructureSpineUnit> = structure
            .spine
            .iter()
            .map(|unit| (unit.lid.as_str(), unit))
            .collect();
        for unit in &structure.spine {
            for dependency_lid in &unit.depends_on {
                let Some(dependency) = units_by_lid.get(dependency_lid.as_str()) else {
                    warnings.push(format!(
                        "book structure dependency {} -> {} is missing",
                        unit.lid, dependency_lid
                    ));
                    continue;
                };
                let mut evidence_lids = unit.summary.evidence_lids.clone();
                push_unique_all(&mut evidence_lids, &dependency.summary.evidence_lids);
                self.insert_pending_minimap_relation(
                    relations,
                    PaperMinimapRelation::BuildsOn,
                    minimap_candidate_key(&book_structure_spine_kind(&unit.role), &unit.lid),
                    minimap_candidate_key(
                        &book_structure_spine_kind(&dependency.role),
                        &dependency.lid,
                    ),
                    evidence_lids,
                    "book structure dependency",
                    warnings,
                );
            }
        }
    }

    fn project_paper_minimap_semantics(
        &self,
        entries: &HashMap<&str, &RuntimePdfSourceMapEntry>,
        warnings: &mut Vec<String>,
    ) -> (
        Vec<PaperLandmark>,
        Vec<PaperArgumentRelation>,
        PaperMinimapLayerStatus,
        PaperMinimapLayerStatus,
    ) {
        let warning_start = warnings.len();
        let mut candidates: HashMap<String, MinimapLandmarkCandidate> = HashMap::new();
        let mut pending_relations: HashMap<String, PendingMinimapRelation> = HashMap::new();
        let discourse_by_lid: HashMap<&str, &TechnicalLearningDiscourseItem> = self
            .discourse_index
            .iter()
            .map(|item| (item.lid.as_str(), item))
            .collect();

        for item in &self.discourse_index {
            let Some(kind) = discourse_landmark_kind(item) else {
                continue;
            };
            let label = item
                .local_summary
                .clone()
                .or_else(|| self.minimap_source_excerpt(&item.lid))
                .unwrap_or_else(|| item.lid.clone());
            self.insert_minimap_candidate(
                &mut candidates,
                MinimapLandmarkCandidate {
                    kind,
                    anchor_lid: item.lid.clone(),
                    label,
                    source_label: self.minimap_source_excerpt(&item.lid),
                    evidence_lids: vec![item.lid.clone()],
                    provenance: vec![PaperLandmarkProvenance::Discourse],
                },
                warnings,
            );
        }

        for node in &self.base.graph_nodes {
            if node.node_type != GraphNodeType::Claim {
                continue;
            }
            let Some(anchor_lid) = node.source_lid.clone() else {
                warnings.push(format!("claim graph node {} has no source_lid", node.id));
                continue;
            };
            self.insert_minimap_candidate(
                &mut candidates,
                MinimapLandmarkCandidate {
                    kind: PaperLandmarkKind::Claim,
                    anchor_lid: anchor_lid.clone(),
                    label: node.name.clone(),
                    source_label: self.minimap_source_excerpt(&anchor_lid),
                    evidence_lids: vec![anchor_lid],
                    provenance: vec![PaperLandmarkProvenance::Graph],
                },
                warnings,
            );
        }

        if let Some(structure) = &self.book_structure {
            for stop in &structure.key_stops {
                self.insert_minimap_candidate(
                    &mut candidates,
                    MinimapLandmarkCandidate {
                        kind: book_structure_key_stop_kind(stop),
                        anchor_lid: stop.lid.clone(),
                        label: stop
                            .title
                            .clone()
                            .unwrap_or_else(|| stop.reason.text.clone()),
                        source_label: self.minimap_source_excerpt(&stop.lid),
                        evidence_lids: stop.reason.evidence_lids.clone(),
                        provenance: vec![PaperLandmarkProvenance::BookStructure],
                    },
                    warnings,
                );
            }
            for unit in &structure.spine {
                self.insert_minimap_candidate(
                    &mut candidates,
                    MinimapLandmarkCandidate {
                        kind: book_structure_spine_kind(&unit.role),
                        anchor_lid: unit.lid.clone(),
                        label: unit.summary.text.clone(),
                        source_label: self.minimap_source_excerpt(&unit.lid),
                        evidence_lids: unit.summary.evidence_lids.clone(),
                        provenance: vec![PaperLandmarkProvenance::BookStructure],
                    },
                    warnings,
                );
            }
        }

        // Relation sources may add evidence-backed endpoint candidates before final page resolution.
        self.project_discourse_minimap_relations(
            &discourse_by_lid,
            &mut candidates,
            &mut pending_relations,
            warnings,
        );
        self.project_graph_minimap_relations(&mut candidates, &mut pending_relations, warnings);
        self.project_book_structure_minimap_relations(
            &mut candidates,
            &mut pending_relations,
            warnings,
        );

        let mut candidate_entries: Vec<(String, MinimapLandmarkCandidate)> =
            candidates.into_iter().collect();
        candidate_entries.sort_by(|left, right| left.0.cmp(&right.0));
        let mut candidate_to_landmark = HashMap::new();
        let mut landmarks = Vec::new();
        for (candidate_key, candidate) in candidate_entries {
            let Some(page_index) = self.minimap_candidate_page(&candidate, entries) else {
                warnings.push(format!(
                    "paper landmark {} has no PDF projection",
                    candidate.anchor_lid
                ));
                continue;
            };
            let landmark_id = format!(
                "landmark:{}:{}",
                paper_landmark_kind_key(&candidate.kind),
                candidate.anchor_lid
            );
            candidate_to_landmark.insert(candidate_key, landmark_id.clone());
            landmarks.push(PaperLandmark {
                landmark_id,
                kind: candidate.kind,
                anchor_lid: candidate.anchor_lid,
                page_index,
                label: candidate.label,
                source_label: candidate.source_label,
                evidence_lids: candidate.evidence_lids,
                provenance: candidate.provenance,
            });
        }
        landmarks.sort_by(|left, right| {
            left.page_index
                .cmp(&right.page_index)
                .then_with(|| left.anchor_lid.cmp(&right.anchor_lid))
                .then_with(|| left.landmark_id.cmp(&right.landmark_id))
        });

        let mut relation_entries: Vec<PendingMinimapRelation> =
            pending_relations.into_values().collect();
        relation_entries.sort_by(|left, right| {
            left.source_candidate_key
                .cmp(&right.source_candidate_key)
                .then_with(|| left.target_candidate_key.cmp(&right.target_candidate_key))
                .then_with(|| {
                    paper_relation_key(&left.relation).cmp(paper_relation_key(&right.relation))
                })
        });
        let mut relations = Vec::new();
        for pending in relation_entries {
            let (Some(source_landmark_id), Some(target_landmark_id)) = (
                candidate_to_landmark.get(&pending.source_candidate_key),
                candidate_to_landmark.get(&pending.target_candidate_key),
            ) else {
                warnings.push(format!(
                    "paper relation {} has an endpoint without PDF projection",
                    paper_relation_key(&pending.relation)
                ));
                continue;
            };
            relations.push(PaperArgumentRelation {
                relation_id: format!(
                    "relation:{}:{}:{}",
                    paper_relation_key(&pending.relation),
                    source_landmark_id,
                    target_landmark_id
                ),
                relation_type: pending.relation,
                source_landmark_id: source_landmark_id.clone(),
                target_landmark_id: target_landmark_id.clone(),
                evidence_lids: pending.evidence_lids,
            });
        }

        let semantic_degraded = warnings.len() > warning_start
            || self.book_structure.is_none()
            || self.discourse_index.is_empty();
        let landmark_status = if landmarks.is_empty() {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Unavailable,
                reason: Some("no evidence-backed paper landmarks are available".into()),
            }
        } else if semantic_degraded {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Degraded,
                reason: Some("one or more semantic sources or candidates are unavailable".into()),
            }
        } else {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Available,
                reason: None,
            }
        };
        let relation_status = if relations.is_empty() {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Unavailable,
                reason: Some("no evidence-backed paper relations are available".into()),
            }
        } else if semantic_degraded || self.paper_minimap_artifacts.pass2_audit.is_none() {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Degraded,
                reason: Some("one or more relation sources or candidates are unavailable".into()),
            }
        } else {
            PaperMinimapLayerStatus {
                status: PaperMinimapAvailabilityStatus::Available,
                reason: None,
            }
        };
        (landmarks, relations, landmark_status, relation_status)
    }

    /// Deterministic, read-only paper topology projected from existing LID/PDF artifacts.
    pub fn paper_minimap(&self) -> PaperMinimapBase {
        let mut warnings = self.paper_minimap_artifacts.warnings.clone();
        let (manifest, pdf_map, entries) = match self.validated_paper_minimap_artifacts() {
            Ok(artifacts) => artifacts,
            Err(reason) => return self.unavailable_paper_minimap(warnings, reason),
        };
        let by_lid: HashMap<&str, &LidNode> = self
            .base
            .lid_nodes
            .iter()
            .map(|node| (node.lid.as_str(), node))
            .collect();
        let units = select_paper_region_units(&self.base.lid_nodes, &by_lid);
        let mut regions = Vec::new();
        let has_explicit_abstract = units.iter().any(|unit| {
            self.source_u16
                .get(unit.span.start..unit.span.end)
                .map(String::from_utf16_lossy)
                .map(|raw| classify_paper_heading(&paper_heading(&raw, &unit.lid)))
                == Some(PaperRegionKind::Abstract)
        });
        if !has_explicit_abstract {
            let before_offset = units
                .iter()
                .map(|unit| unit.span.start)
                .min()
                .unwrap_or(self.source_u16.len());
            let abstract_leaves = structured_abstract_leaf_lids(
                &self.base.lid_nodes,
                &self.source_u16,
                before_offset,
            );
            if !abstract_leaves.is_empty() {
                let region_id = format!("region:abstract:{}", abstract_leaves[0]);
                if let Some(region) = self.paper_region_from_leaves(
                    region_id,
                    "Abstract".into(),
                    PaperRegionKind::Abstract,
                    PaperRegionClassificationSource::Discourse,
                    1.0,
                    abstract_leaves,
                    &entries,
                    &mut warnings,
                ) {
                    regions.push(region);
                }
            }
        }
        for unit in units {
            let mut leaves = Vec::new();
            if let Err(reason) = self.collect_minimap_leaf_lids(&unit.lid, &mut leaves) {
                return self.unavailable_paper_minimap(warnings, reason);
            }
            let raw_title = self
                .source_u16
                .get(unit.span.start..unit.span.end)
                .map(String::from_utf16_lossy)
                .unwrap_or_else(|| unit.lid.clone());
            let title = paper_heading(&raw_title, &unit.lid);
            let exact_kind = classify_paper_heading(&title);
            let (kind, classification_source, confidence) =
                if exact_kind != PaperRegionKind::Unknown {
                    (exact_kind, PaperRegionClassificationSource::Heading, 1.0)
                } else if is_end_matter_heading(&title) {
                    (
                        PaperRegionKind::Unknown,
                        PaperRegionClassificationSource::Unknown,
                        0.0,
                    )
                } else if let Some(inherited) =
                    inherited_major_heading_kind(&self.source_u16, unit.span.start)
                {
                    (inherited, PaperRegionClassificationSource::Heading, 0.9)
                } else {
                    (
                        PaperRegionKind::Unknown,
                        PaperRegionClassificationSource::Unknown,
                        0.0,
                    )
                };
            if let Some(region) = self.paper_region_from_leaves(
                format!("region:{}", unit.lid),
                title,
                kind,
                classification_source,
                confidence,
                leaves,
                &entries,
                &mut warnings,
            ) {
                regions.push(region);
            }
        }
        if regions.is_empty() {
            return self.unavailable_paper_minimap(
                warnings,
                "no structural paper region has a valid PDF projection",
            );
        }

        let (landmarks, relations, landmark_status, argument_status) =
            self.project_paper_minimap_semantics(&entries, &mut warnings);
        let mut fingerprint_parts = vec![
            self.base.book_id.clone(),
            manifest.canonical_source.sha256.clone(),
            pdf_map.config_hash.clone(),
        ];
        for region in &regions {
            fingerprint_parts.push(format!(
                "{}:{}:{}:{}:{}:{:?}",
                region.region_id,
                region.lid_span.start_lid,
                region.lid_span.end_lid,
                region.page_span.start_page,
                region.page_span.end_page,
                region.kind
            ));
        }
        for landmark in &landmarks {
            fingerprint_parts.push(format!(
                "{}:{}:{}:{}",
                landmark.landmark_id,
                landmark.anchor_lid,
                landmark.page_index,
                landmark.evidence_lids.join(",")
            ));
        }
        for relation in &relations {
            fingerprint_parts.push(format!(
                "{}:{}:{}:{}",
                relation.relation_id,
                relation.source_landmark_id,
                relation.target_landmark_id,
                relation.evidence_lids.join(",")
            ));
        }
        let status = if landmark_status.status == PaperMinimapAvailabilityStatus::Available
            && argument_status.status == PaperMinimapAvailabilityStatus::Available
        {
            PaperMinimapAvailabilityStatus::Available
        } else {
            PaperMinimapAvailabilityStatus::Degraded
        };
        PaperMinimapBase {
            version: "paper_minimap.v1".into(),
            book_id: self.base.book_id.clone(),
            book_version: self.paper_minimap_book_version(),
            fingerprint: stable_minimap_fingerprint(&fingerprint_parts),
            status,
            regions,
            landmarks,
            relations,
            layer_status: HashMap::from([
                (
                    "topology".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Available,
                        reason: None,
                    },
                ),
                (
                    "regions".into(),
                    PaperMinimapLayerStatus {
                        status: PaperMinimapAvailabilityStatus::Available,
                        reason: None,
                    },
                ),
                ("landmarks".into(), landmark_status),
                ("arguments".into(), argument_status),
            ]),
            warnings,
        }
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

    pub fn resolve_source(
        &self,
        evidence: &EvidenceRange,
        locale: &str,
        expected_digest: Option<&str>,
    ) -> Result<ResolvedSource, ToolError> {
        let leaves = self.source_leaves();
        let leaf_positions: HashMap<&str, usize> = leaves
            .iter()
            .enumerate()
            .map(|(index, node)| (node.lid.as_str(), index))
            .collect();
        let start_node = self
            .node(&evidence.start_lid)
            .map_err(|_| invalid_source_range("start_lid must identify readable source"))?;
        let end_node = self
            .node(&evidence.end_lid)
            .map_err(|_| invalid_source_range("end_lid must identify readable source"))?;
        let start_index = source_endpoint_leaf_index(start_node, &leaves, &leaf_positions, true)?;
        let end_index = source_endpoint_leaf_index(end_node, &leaves, &leaf_positions, false)?;
        if start_index > end_index || start_node.span.start > end_node.span.end {
            return Err(invalid_source_range(
                "start_lid must not follow end_lid in reading order",
            ));
        }

        let selected = &leaves[start_index..=end_index];
        let evidence_text = if evidence.ranges.is_empty() {
            String::from_utf16_lossy(
                self.source_u16
                    .get(start_node.span.start..end_node.span.end)
                    .ok_or_else(|| {
                        invalid_source_range("source passage is outside canonical text")
                    })?,
            )
        } else {
            if !start_node.children.is_empty() || !end_node.children.is_empty() {
                return Err(invalid_source_range(
                    "explicit ranges require leaf start_lid and end_lid",
                ));
            }
            self.validate_and_read_source_ranges(evidence, selected)?
        };
        if evidence_text.trim().is_empty() {
            return Err(invalid_source_range("source evidence must contain text"));
        }

        let digest = source_evidence_digest(&self.base.book_id, evidence, &evidence_text);
        if expected_digest.is_some_and(|expected| expected != digest) {
            return Err(ToolError {
                error_code: "SOURCE_STALE".into(),
                category: "conflict".into(),
                message: "source evidence no longer matches the stored digest".into(),
            });
        }

        let heading_path = self.source_heading_path(start_node)?;
        let kind_label = localized_source_kind(&start_node.kind, locale);
        let label = heading_path
            .last()
            .map(|heading| format!("{kind_label} · {heading}"))
            .unwrap_or_else(|| kind_label.to_string());
        let highlighted_quote = evidence_text.trim().to_string();
        let (context_before, context_after) = self.source_context(
            evidence,
            &leaves,
            start_index,
            end_index,
            &highlighted_quote,
        )?;

        Ok(ResolvedSource {
            label,
            heading_path,
            preview: source_preview(&highlighted_quote),
            evidence_text_digest: digest,
            highlighted_quote,
            context_before,
            context_after,
        })
    }

    fn source_leaves(&self) -> Vec<&LidNode> {
        let mut leaves: Vec<_> = self
            .base
            .lid_nodes
            .iter()
            .filter(|node| node.children.is_empty())
            .collect();
        leaves.sort_by(|left, right| {
            left.span
                .start
                .cmp(&right.span.start)
                .then_with(|| left.span.end.cmp(&right.span.end))
                .then_with(|| left.path.cmp(&right.path))
        });
        leaves
    }

    pub fn search_text_exact(
        &self,
        query: &str,
        scope: Option<Span>,
    ) -> Result<ExactSearchResult, ToolError> {
        if query.trim().is_empty() {
            return Err(search_error(
                "SEARCH_QUERY_EMPTY",
                "search query must contain non-whitespace text",
            ));
        }
        let leaves = self.validated_search_leaves()?;
        let scope = scope.unwrap_or(Span {
            start: 0,
            end: self.source_u16.len(),
        });
        if scope.start > scope.end
            || scope.end > self.source_u16.len()
            || !is_utf16_boundary(&self.source_u16, scope.start)
            || !is_utf16_boundary(&self.source_u16, scope.end)
        {
            return Err(search_error(
                "SEARCH_SCOPE_INVALID",
                "search scope must be an in-bounds UTF-16 range",
            ));
        }

        let query_u16: Vec<u16> = query.encode_utf16().collect();
        let mut matches = Vec::new();
        if query_u16.len() <= scope.end.saturating_sub(scope.start) {
            let last_start = scope.end - query_u16.len();
            for start in scope.start..=last_start {
                let end = start + query_u16.len();
                if self.source_u16[start..end] == query_u16 {
                    matches.push(Span { start, end });
                }
            }
        }
        let source_revision = self.search_source_revision(&leaves)?;
        self.build_search_scan(&leaves, source_revision, matches, TextMatchType::Exact)
    }

    pub fn search_text(&self, input: &SearchTextInput) -> Result<SearchTextResult, ToolError> {
        let query_length = input.query.chars().count();
        if input.query.trim().is_empty() {
            return Err(search_error(
                "SEARCH_QUERY_EMPTY",
                "search query must contain non-whitespace text",
            ));
        }
        if query_length > 4096 {
            return Err(search_error(
                "SEARCH_QUERY_TOO_LONG",
                "search query must contain at most 4096 Unicode scalar values",
            ));
        }
        if !(1..=50).contains(&input.page_size) {
            return Err(search_error(
                "BOOK_TOOL_INPUT_INVALID",
                "page_size must be between 1 and 50",
            ));
        }

        let scope = self.resolve_search_scope(input.scope.as_ref())?;
        let leaves = self.validated_search_leaves()?;
        let source_revision = self.search_source_revision(&leaves)?;
        let request_digest = search_request_digest(input)?;
        let offset = match input.cursor.as_deref() {
            None => 0,
            Some(cursor) => {
                let cursor = decode_search_cursor(cursor)?;
                if cursor.source_revision != source_revision {
                    return Err(search_error(
                        "SEARCH_CURSOR_STALE",
                        "search cursor belongs to a different source revision",
                    ));
                }
                if cursor.request_digest != request_digest {
                    return Err(search_error(
                        "SEARCH_CURSOR_MISMATCH",
                        "search cursor does not match the canonical request",
                    ));
                }
                cursor.offset
            }
        };

        let prepared = self.prepare_text_search(&input.query, input.match_mode, scope)?;
        let aggregate = self.aggregate_search_matches(&leaves, &prepared)?;
        if offset > 0 && offset >= aggregate.total_occurrences {
            return Err(search_error(
                "SEARCH_CURSOR_INVALID",
                "search cursor offset is outside the occurrence set",
            ));
        }

        let end = offset
            .saturating_add(input.page_size)
            .min(aggregate.total_occurrences);
        let (forward_start, forward_end) = match input.order {
            SearchOrder::Document => (offset, end),
            SearchOrder::ReverseDocument => (
                aggregate.total_occurrences - end,
                aggregate.total_occurrences - offset,
            ),
        };
        let match_type = match input.match_mode {
            SearchMatchMode::Exact => TextMatchType::Exact,
            SearchMatchMode::Normalized => TextMatchType::Normalized,
        };
        let mut forward_index = 0;
        let mut occurrences = Vec::with_capacity(end.saturating_sub(offset));
        prepared.visit_matches(&self.source_u16, |source_range| {
            if forward_index >= forward_end {
                return Ok(false);
            }
            let current = forward_index;
            forward_index += 1;
            if current >= forward_start {
                occurrences.push(self.search_occurrence(
                    &leaves,
                    source_range,
                    match_type,
                    current + 1,
                )?);
            }
            Ok(true)
        })?;
        if input.order == SearchOrder::ReverseDocument {
            occurrences.reverse();
        }

        let next_cursor = if end < aggregate.total_occurrences {
            Some(encode_search_cursor(&SearchCursorV1 {
                version: "search_text.v1".into(),
                source_revision: source_revision.clone(),
                request_digest,
                offset: end,
            })?)
        } else {
            None
        };
        Ok(SearchTextResult {
            version: "search_text.v1".into(),
            source_revision,
            exhaustive: true,
            total_occurrences: aggregate.total_occurrences,
            total_lids: aggregate.total_lids,
            occurrences,
            section_counts: aggregate.section_counts,
            next_cursor,
        })
    }

    fn prepare_text_search(
        &self,
        query: &str,
        match_mode: SearchMatchMode,
        scope: Span,
    ) -> Result<PreparedTextSearch, ToolError> {
        if scope.start > scope.end
            || scope.end > self.source_u16.len()
            || !is_utf16_boundary(&self.source_u16, scope.start)
            || !is_utf16_boundary(&self.source_u16, scope.end)
        {
            return Err(search_error(
                "SEARCH_SCOPE_INVALID",
                "search scope must be an in-bounds UTF-16 range",
            ));
        }
        match match_mode {
            SearchMatchMode::Exact => Ok(PreparedTextSearch::Exact {
                query: query.encode_utf16().collect(),
                scope,
            }),
            SearchMatchMode::Normalized => {
                let source_units =
                    normalize_mapped_units(&self.source_u16, scope.start, scope.end)?;
                let query_u16: Vec<u16> = query.encode_utf16().collect();
                let query_units = normalize_mapped_units(&query_u16, 0, query_u16.len())?;
                let query = query_units
                    .iter()
                    .map(|unit| unit.value)
                    .collect::<Vec<_>>();
                if query.is_empty() {
                    return Err(search_error(
                        "SEARCH_QUERY_EMPTY",
                        "normalized search query is empty",
                    ));
                }
                Ok(PreparedTextSearch::Normalized {
                    source_units,
                    query,
                })
            }
        }
    }

    fn aggregate_search_matches(
        &self,
        leaves: &[&LidNode],
        prepared: &PreparedTextSearch,
    ) -> Result<SearchAggregate, ToolError> {
        let mut total_occurrences = 0usize;
        let mut touched_leaves = vec![false; leaves.len()];
        let mut leaf_sections = vec![None::<usize>; leaves.len()];
        let mut section_counts: Vec<SearchSectionCount> = Vec::new();
        prepared.visit_matches(&self.source_u16, |source_range| {
            let leaf_range = search_match_leaf_range(leaves, &source_range)?;
            total_occurrences += 1;
            for index in leaf_range.clone() {
                touched_leaves[index] = true;
            }
            let leaf_index = leaf_range.start;
            if let Some(section_index) = leaf_sections[leaf_index] {
                section_counts[section_index].count += 1;
            } else {
                let (section_lid, label) = self.search_section(leaves[leaf_index])?;
                let section_index = if let Some(section_index) = section_counts
                    .iter()
                    .position(|section| section.section_lid == section_lid)
                {
                    section_counts[section_index].count += 1;
                    section_index
                } else {
                    let section_index = section_counts.len();
                    section_counts.push(SearchSectionCount {
                        section_lid,
                        label,
                        count: 1,
                    });
                    section_index
                };
                leaf_sections[leaf_index] = Some(section_index);
            }
            Ok(true)
        })?;
        Ok(SearchAggregate {
            total_occurrences,
            total_lids: touched_leaves
                .into_iter()
                .filter(|touched| *touched)
                .count(),
            section_counts,
        })
    }

    fn search_occurrence(
        &self,
        leaves: &[&LidNode],
        source_range: Span,
        match_type: TextMatchType,
        ordinal: usize,
    ) -> Result<TextOccurrence, ToolError> {
        let leaf_range = search_match_leaf_range(leaves, &source_range)?;
        let mut ranges = Vec::with_capacity(leaf_range.len());
        for leaf in &leaves[leaf_range] {
            let overlap_start = source_range.start.max(leaf.span.start);
            let overlap_end = source_range.end.min(leaf.span.end);
            ranges.push(TextOccurrenceRange {
                lid: leaf.lid.clone(),
                start_utf16: overlap_start - leaf.span.start,
                end_utf16: overlap_end - leaf.span.start,
            });
        }
        let first_range = ranges.first().expect("validated match intersects a leaf");
        let last_range = ranges.last().expect("validated match intersects a leaf");
        let start_node = self.node(&first_range.lid)?;
        Ok(TextOccurrence {
            ordinal,
            start_lid: first_range.lid.clone(),
            end_lid: last_range.lid.clone(),
            heading_path: self.source_heading_path_items(start_node)?,
            excerpt: self.search_excerpt(source_range.start, source_range.end),
            source_range_utf16: source_range,
            ranges,
            match_type,
        })
    }

    fn build_search_scan(
        &self,
        leaves: &[&LidNode],
        source_revision: String,
        matches: Vec<Span>,
        match_type: TextMatchType,
    ) -> Result<ExactSearchResult, ToolError> {
        let mut occurrences = Vec::with_capacity(matches.len());
        for source_range in matches {
            let first_leaf = leaves.partition_point(|leaf| leaf.span.end <= source_range.start);
            let mut ranges = Vec::new();
            for leaf in leaves[first_leaf..]
                .iter()
                .take_while(|leaf| leaf.span.start < source_range.end)
            {
                let overlap_start = source_range.start.max(leaf.span.start);
                let overlap_end = source_range.end.min(leaf.span.end);
                if overlap_start < overlap_end {
                    ranges.push(TextOccurrenceRange {
                        lid: leaf.lid.clone(),
                        start_utf16: overlap_start - leaf.span.start,
                        end_utf16: overlap_end - leaf.span.start,
                    });
                }
            }
            let Some(first_range) = ranges.first() else {
                return Err(search_error(
                    "SEARCH_SOURCE_INVALID",
                    "a non-whitespace match did not intersect any source leaf",
                ));
            };
            let last_range = ranges.last().expect("non-empty occurrence ranges");
            let start_node = self.node(&first_range.lid)?;
            occurrences.push(TextOccurrence {
                ordinal: occurrences.len() + 1,
                start_lid: first_range.lid.clone(),
                end_lid: last_range.lid.clone(),
                heading_path: self.source_heading_path_items(start_node)?,
                excerpt: self.search_excerpt(source_range.start, source_range.end),
                source_range_utf16: source_range,
                ranges,
                match_type,
            });
        }

        let total_lids = occurrences
            .iter()
            .flat_map(|occurrence| occurrence.ranges.iter().map(|range| range.lid.as_str()))
            .collect::<HashSet<_>>()
            .len();
        let mut section_counts: Vec<SearchSectionCount> = Vec::new();
        for occurrence in &occurrences {
            let leaf = self.node(&occurrence.start_lid)?;
            let (section_lid, label) = self.search_section(leaf)?;
            if let Some(section) = section_counts
                .iter_mut()
                .find(|section| section.section_lid == section_lid)
            {
                section.count += 1;
            } else {
                section_counts.push(SearchSectionCount {
                    section_lid,
                    label,
                    count: 1,
                });
            }
        }

        Ok(ExactSearchResult {
            source_revision,
            exhaustive: true,
            total_occurrences: occurrences.len(),
            total_lids,
            occurrences,
            section_counts,
        })
    }

    fn resolve_search_scope(&self, scope: Option<&SearchTextScope>) -> Result<Span, ToolError> {
        let mut resolved = Span {
            start: 0,
            end: self.source_u16.len(),
        };
        let Some(scope) = scope else {
            return Ok(resolved);
        };
        if let Some(within_lid) = &scope.within_lid {
            let node = self.node(within_lid).map_err(|_| {
                search_error(
                    "SEARCH_SCOPE_INVALID",
                    format!("within_lid does not exist: {within_lid}"),
                )
            })?;
            resolved.start = resolved.start.max(node.span.start);
            resolved.end = resolved.end.min(node.span.end);
        }
        if let Some(relative) = &scope.relative_to {
            let node = self.node(&relative.lid).map_err(|_| {
                search_error(
                    "SEARCH_SCOPE_INVALID",
                    format!("relative_to lid does not exist: {}", relative.lid),
                )
            })?;
            match relative.direction {
                SearchRelativeDirection::Before => resolved.end = resolved.end.min(node.span.start),
                SearchRelativeDirection::After => {
                    resolved.start = resolved.start.max(node.span.end)
                }
            }
        }
        if resolved.start > resolved.end {
            resolved.start = resolved.end;
        }
        Ok(resolved)
    }

    fn validated_search_leaves(&self) -> Result<Vec<&LidNode>, ToolError> {
        let leaves = self.source_leaves();
        let mut previous_end = 0;
        for leaf in &leaves {
            if leaf.span.start >= leaf.span.end
                || leaf.span.end > self.source_u16.len()
                || !is_utf16_boundary(&self.source_u16, leaf.span.start)
                || !is_utf16_boundary(&self.source_u16, leaf.span.end)
            {
                return Err(search_error(
                    "SEARCH_SOURCE_INVALID",
                    format!("invalid UTF-16 source span for leaf {}", leaf.lid),
                ));
            }
            if leaf.span.start < previous_end {
                return Err(search_error(
                    "SEARCH_SOURCE_INVALID",
                    format!("overlapping source leaf span at {}", leaf.lid),
                ));
            }
            if !utf16_is_whitespace(&self.source_u16[previous_end..leaf.span.start]) {
                return Err(search_error(
                    "SEARCH_SOURCE_INVALID",
                    format!("non-whitespace source gap before leaf {}", leaf.lid),
                ));
            }
            previous_end = leaf.span.end;
        }
        if !utf16_is_whitespace(&self.source_u16[previous_end..]) {
            return Err(search_error(
                "SEARCH_SOURCE_INVALID",
                "non-whitespace source tail is not owned by a leaf",
            ));
        }
        Ok(leaves)
    }

    fn search_source_revision(&self, leaves: &[&LidNode]) -> Result<String, ToolError> {
        #[derive(Serialize)]
        struct RevisionLeaf<'a> {
            lid: &'a str,
            path: &'a [u32],
            span: &'a Span,
        }

        let source = String::from_utf16(&self.source_u16).map_err(|_| {
            search_error(
                "SEARCH_SOURCE_INVALID",
                "canonical source is not valid UTF-16",
            )
        })?;
        let partition: Vec<_> = leaves
            .iter()
            .map(|leaf| RevisionLeaf {
                lid: &leaf.lid,
                path: &leaf.path,
                span: &leaf.span,
            })
            .collect();
        let partition = serde_json::to_vec(&partition).map_err(|error| {
            search_error(
                "SEARCH_SOURCE_INVALID",
                format!("cannot serialize source partition: {error}"),
            )
        })?;
        let mut revision_material = Vec::with_capacity(source.len() + partition.len() + 1);
        revision_material.extend_from_slice(source.as_bytes());
        revision_material.push(0);
        revision_material.extend_from_slice(&partition);
        Ok(search_sha256_hex(&revision_material))
    }

    fn source_heading_path_items(&self, node: &LidNode) -> Result<Vec<HeadingPathItem>, ToolError> {
        let mut ancestors: Vec<_> = self
            .base
            .lid_nodes
            .iter()
            .filter(|ancestor| {
                matches!(ancestor.kind, NodeKind::Chapter | NodeKind::Section)
                    && path_is_prefix(&ancestor.path, &node.path)
            })
            .collect();
        ancestors.sort_by_key(|ancestor| ancestor.path.len());
        let mut headings = Vec::new();
        for ancestor in ancestors {
            if let Some(title) = markdown_heading(&self.source_node_text(ancestor)?) {
                headings.push(HeadingPathItem {
                    lid: ancestor.lid.clone(),
                    title,
                });
            }
        }
        Ok(headings)
    }

    fn search_section(&self, leaf: &LidNode) -> Result<(String, String), ToolError> {
        let min_depth = self
            .base
            .lid_nodes
            .iter()
            .map(|node| node.path.len())
            .min()
            .ok_or_else(|| search_error("SEARCH_SOURCE_INVALID", "book has no LID nodes"))?;
        let roots: Vec<_> = self
            .base
            .lid_nodes
            .iter()
            .filter(|node| node.path.len() == min_depth)
            .collect();
        let root = roots
            .iter()
            .copied()
            .find(|root| path_is_prefix(&root.path, &leaf.path))
            .ok_or_else(|| {
                search_error(
                    "SEARCH_SOURCE_INVALID",
                    format!("leaf {} has no structural root", leaf.lid),
                )
            })?;
        let section = if roots.len() == 1 && !root.children.is_empty() {
            self.base
                .lid_nodes
                .iter()
                .filter(|node| {
                    node.path.len() == root.path.len() + 1
                        && path_is_prefix(&root.path, &node.path)
                        && path_is_prefix(&node.path, &leaf.path)
                })
                .min_by(|left, right| left.path.cmp(&right.path))
                .unwrap_or(root)
        } else {
            root
        };
        let label = markdown_heading(&self.source_node_text(section)?)
            .unwrap_or_else(|| section.lid.clone());
        Ok((section.lid.clone(), label))
    }

    fn search_excerpt(&self, match_start: usize, match_end: usize) -> String {
        const CONTEXT_UTF16: usize = 48;
        let mut start = match_start.saturating_sub(CONTEXT_UTF16);
        let mut end = (match_end + CONTEXT_UTF16).min(self.source_u16.len());
        while start > 0 && !is_utf16_boundary(&self.source_u16, start) {
            start -= 1;
        }
        while end < self.source_u16.len() && !is_utf16_boundary(&self.source_u16, end) {
            end += 1;
        }
        String::from_utf16_lossy(&self.source_u16[start..end])
    }

    fn source_node_u16(&self, node: &LidNode) -> Result<&[u16], ToolError> {
        self.source_u16
            .get(node.span.start..node.span.end)
            .ok_or_else(|| invalid_source_range("source node span is outside canonical text"))
    }

    fn source_node_text(&self, node: &LidNode) -> Result<String, ToolError> {
        Ok(String::from_utf16_lossy(self.source_node_u16(node)?))
    }

    fn validate_and_read_source_ranges(
        &self,
        evidence: &EvidenceRange,
        selected: &[&LidNode],
    ) -> Result<String, ToolError> {
        if evidence.ranges.len() != selected.len() {
            return Err(invalid_source_range(
                "explicit source ranges must cover every leaf in the evidence passage",
            ));
        }

        let mut text = String::new();
        for (index, (range, node)) in evidence.ranges.iter().zip(selected.iter()).enumerate() {
            if range.lid != node.lid {
                return Err(invalid_source_range(
                    "explicit source ranges must follow consecutive leaf reading order",
                ));
            }
            let node_u16 = self.source_node_u16(node)?;
            let start = range.range.start as usize;
            let end = range.range.end as usize;
            if start >= end
                || end > node_u16.len()
                || !is_utf16_boundary(node_u16, start)
                || !is_utf16_boundary(node_u16, end)
            {
                return Err(invalid_source_range(
                    "source range must be a non-empty UTF-16 interval inside its leaf",
                ));
            }

            if selected.len() > 1 {
                if index > 0 && !utf16_is_whitespace(&node_u16[..start]) {
                    return Err(invalid_source_range(
                        "only the first leaf may have a non-whitespace prefix outside evidence",
                    ));
                }
                if index + 1 < selected.len() && !utf16_is_whitespace(&node_u16[end..]) {
                    return Err(invalid_source_range(
                        "only the last leaf may have a non-whitespace suffix outside evidence",
                    ));
                }
            }
            text.push_str(&String::from_utf16_lossy(&node_u16[start..end]));
        }
        Ok(text)
    }

    fn source_heading_path(&self, node: &LidNode) -> Result<Vec<String>, ToolError> {
        let mut ancestors: Vec<_> = self
            .base
            .lid_nodes
            .iter()
            .filter(|ancestor| {
                matches!(ancestor.kind, NodeKind::Chapter | NodeKind::Section)
                    && path_is_prefix(&ancestor.path, &node.path)
            })
            .collect();
        ancestors.sort_by_key(|node| node.path.len());
        ancestors
            .into_iter()
            .map(|ancestor| {
                self.source_node_text(ancestor)
                    .map(|text| markdown_heading(&text))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|headings| headings.into_iter().flatten().collect())
    }

    fn source_context(
        &self,
        evidence: &EvidenceRange,
        leaves: &[&LidNode],
        start_index: usize,
        end_index: usize,
        highlighted_quote: &str,
    ) -> Result<(String, String), ToolError> {
        let boundary = self
            .base
            .lid_nodes
            .iter()
            .filter(|node| {
                matches!(node.kind, NodeKind::Chapter | NodeKind::Section)
                    && path_is_prefix(&node.path, &leaves[start_index].path)
                    && path_is_prefix(&node.path, &leaves[end_index].path)
            })
            .max_by_key(|node| node.path.len());
        let (boundary_start, boundary_end) = boundary
            .map(|node| {
                let indexes: Vec<_> = leaves
                    .iter()
                    .enumerate()
                    .filter(|(_, leaf)| path_is_prefix(&node.path, &leaf.path))
                    .map(|(index, _)| index)
                    .collect();
                (
                    indexes.first().copied().unwrap_or(start_index),
                    indexes.last().copied().unwrap_or(end_index),
                )
            })
            .unwrap_or((start_index, end_index));

        let mut before = Vec::new();
        let mut after = Vec::new();
        if let Some(first_range) = evidence.ranges.first() {
            let start_u16 = self.source_node_u16(leaves[start_index])?;
            let prefix = String::from_utf16_lossy(&start_u16[..first_range.range.start as usize]);
            if !prefix.is_empty() {
                before.push(prefix);
            }
        }
        if let Some(last_range) = evidence.ranges.last() {
            let end_u16 = self.source_node_u16(leaves[end_index])?;
            let suffix = String::from_utf16_lossy(&end_u16[last_range.range.end as usize..]);
            if !suffix.is_empty() {
                after.push(suffix);
            }
        }

        let cjk = contains_cjk(highlighted_quote)
            || boundary
                .and_then(|node| self.source_node_text(node).ok())
                .is_some_and(|text| contains_cjk(&text));
        let target_min = if cjk { 300 } else { 120 };
        let target_max = if cjk { 800 } else { 300 };
        let hard_max = if cjk { 1200 } else { 500 };
        let mut left = start_index.checked_sub(1);
        let mut right = end_index + 1;
        let mut prefer_left = true;
        while source_window_measure(&before, highlighted_quote, &after, cjk) < target_min {
            let mut added = false;
            for choose_left in [prefer_left, !prefer_left] {
                if choose_left {
                    if let Some(index) = left.filter(|index| *index >= boundary_start) {
                        before.insert(0, self.source_node_text(leaves[index])?);
                        left = index.checked_sub(1);
                        added = true;
                        break;
                    }
                } else if right <= boundary_end {
                    after.push(self.source_node_text(leaves[right])?);
                    right += 1;
                    added = true;
                    break;
                }
            }
            if !added {
                break;
            }
            prefer_left = !prefer_left;
            if source_window_measure(&before, highlighted_quote, &after, cjk) >= target_max {
                break;
            }
        }

        let before = before.concat().trim().to_string();
        let after = after.concat().trim().to_string();
        Ok(limit_source_context(
            &before,
            &after,
            highlighted_quote,
            cjk,
            hard_max,
        ))
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

fn invalid_source_range(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INVALID_SOURCE_RANGE".into(),
        category: "invalid_input".into(),
        message: message.into(),
    }
}

fn search_error(code: &str, message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: code.into(),
        category: if code == "SEARCH_SOURCE_INVALID" {
            "internal".into()
        } else {
            "validation".into()
        },
        message: message.into(),
    }
}

fn search_match_leaf_range(
    leaves: &[&LidNode],
    source_range: &Span,
) -> Result<std::ops::Range<usize>, ToolError> {
    let start = leaves.partition_point(|leaf| leaf.span.end <= source_range.start);
    let mut end = start;
    while end < leaves.len() && leaves[end].span.start < source_range.end {
        if source_range.start.max(leaves[end].span.start)
            < source_range.end.min(leaves[end].span.end)
        {
            end += 1;
        } else {
            break;
        }
    }
    if start == end {
        return Err(search_error(
            "SEARCH_SOURCE_INVALID",
            "a non-whitespace match did not intersect any source leaf",
        ));
    }
    Ok(start..end)
}

fn normalize_mapped_units(
    source: &[u16],
    start_utf16: usize,
    end_utf16: usize,
) -> Result<Vec<MappedUnit>, ToolError> {
    let mut original = Vec::new();
    let mut source_offset = start_utf16;
    for decoded in char::decode_utf16(source[start_utf16..end_utf16].iter().copied()) {
        let value = decoded.map_err(|_| {
            search_error(
                "SEARCH_SOURCE_INVALID",
                "normalization input is not valid UTF-16",
            )
        })?;
        let char_end = source_offset + value.len_utf16();
        original.push(MappedChar {
            value,
            source_start_utf16: source_offset,
            source_end_utf16: char_end,
        });
        source_offset = char_end;
    }

    let mut decomposed = Vec::new();
    for mapped in original {
        decompose_compatible(mapped.value, |value| {
            decomposed.push(MappedChar {
                value,
                source_start_utf16: mapped.source_start_utf16,
                source_end_utf16: mapped.source_end_utf16,
            });
        });
    }

    let mut ordered: Vec<MappedChar> = Vec::with_capacity(decomposed.len());
    let mut pending_start = 0;
    for mapped in decomposed {
        if canonical_combining_class(mapped.value) == 0 {
            ordered[pending_start..]
                .sort_by_key(|candidate| canonical_combining_class(candidate.value));
            ordered.push(mapped);
            pending_start = ordered.len();
        } else {
            ordered.push(mapped);
        }
    }
    ordered[pending_start..].sort_by_key(|candidate| canonical_combining_class(candidate.value));

    let mut recomposed: Vec<MappedChar> = Vec::with_capacity(ordered.len());
    let mut starter_index: Option<usize> = None;
    let mut last_combining_class = 0;
    for mapped in ordered {
        let combining_class = canonical_combining_class(mapped.value);
        if let Some(index) = starter_index {
            if let Some(composed) = (last_combining_class == 0
                || last_combining_class < combining_class)
                .then(|| compose(recomposed[index].value, mapped.value))
                .flatten()
            {
                recomposed[index].value = composed;
                recomposed[index].source_start_utf16 = recomposed[index]
                    .source_start_utf16
                    .min(mapped.source_start_utf16);
                recomposed[index].source_end_utf16 = recomposed[index]
                    .source_end_utf16
                    .max(mapped.source_end_utf16);
                continue;
            }
        }
        if combining_class == 0 {
            starter_index = Some(recomposed.len());
            last_combining_class = 0;
        } else {
            last_combining_class = combining_class;
        }
        recomposed.push(mapped);
    }

    let mut folded = Vec::new();
    for mapped in recomposed {
        for value in std::iter::once(mapped.value).case_fold() {
            folded.push(MappedChar {
                value,
                source_start_utf16: mapped.source_start_utf16,
                source_end_utf16: mapped.source_end_utf16,
            });
        }
    }

    let mut collapsed: Vec<MappedChar> = Vec::new();
    for mut mapped in folded {
        if mapped.value == '\r' {
            mapped.value = '\n';
        }
        if mapped.value.is_whitespace() {
            if let Some(previous) = collapsed.last_mut().filter(|value| value.value == ' ') {
                previous.source_start_utf16 =
                    previous.source_start_utf16.min(mapped.source_start_utf16);
                previous.source_end_utf16 = previous.source_end_utf16.max(mapped.source_end_utf16);
            } else {
                mapped.value = ' ';
                collapsed.push(mapped);
            }
        } else {
            collapsed.push(mapped);
        }
    }

    let mut units = Vec::new();
    for mapped in collapsed {
        let mut buffer = [0u16; 2];
        for value in mapped.value.encode_utf16(&mut buffer).iter().copied() {
            units.push(MappedUnit {
                value,
                source_start_utf16: mapped.source_start_utf16,
                source_end_utf16: mapped.source_end_utf16,
            });
        }
    }
    Ok(units)
}

fn search_request_digest(input: &SearchTextInput) -> Result<String, ToolError> {
    let mut canonical = input.clone();
    canonical.cursor = None;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": "search_text.v1",
        "normalized_semantics": SEARCH_TEXT_NORMALIZATION_VERSION,
        "request": canonical,
    }))
    .map_err(|error| {
        search_error(
            "SEARCH_CURSOR_INVALID",
            format!("cannot serialize canonical search request: {error}"),
        )
    })?;
    Ok(search_sha256_hex(&bytes))
}

fn encode_search_cursor(cursor: &SearchCursorV1) -> Result<String, ToolError> {
    let payload = serde_json::to_vec(cursor).map_err(|error| {
        search_error(
            "SEARCH_CURSOR_INVALID",
            format!("cannot serialize search cursor: {error}"),
        )
    })?;
    Ok(format!(
        "st1.{}.{}",
        search_hex_encode(&payload),
        search_sha256_hex(&payload)
    ))
}

fn decode_search_cursor(cursor: &str) -> Result<SearchCursorV1, ToolError> {
    let mut parts = cursor.split('.');
    let (Some(prefix), Some(payload), Some(checksum), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(search_error(
            "SEARCH_CURSOR_INVALID",
            "search cursor has an invalid envelope",
        ));
    };
    if prefix != "st1" {
        return Err(search_error(
            "SEARCH_CURSOR_INVALID",
            "search cursor version is not supported",
        ));
    }
    let payload = search_hex_decode(payload)?;
    if search_sha256_hex(&payload) != checksum {
        return Err(search_error(
            "SEARCH_CURSOR_INVALID",
            "search cursor checksum is invalid",
        ));
    }
    let cursor: SearchCursorV1 = serde_json::from_slice(&payload)
        .map_err(|_| search_error("SEARCH_CURSOR_INVALID", "search cursor payload is invalid"))?;
    if cursor.version != "search_text.v1" {
        return Err(search_error(
            "SEARCH_CURSOR_INVALID",
            "search cursor payload version is not supported",
        ));
    }
    Ok(cursor)
}

fn search_hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn search_hex_decode(value: &str) -> Result<Vec<u8>, ToolError> {
    if value.len() % 2 != 0 {
        return Err(search_error(
            "SEARCH_CURSOR_INVALID",
            "search cursor payload is not valid hex",
        ));
    }
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let Some(high) = search_hex_value(pair[0]) else {
            return Err(search_error(
                "SEARCH_CURSOR_INVALID",
                "search cursor payload is not valid hex",
            ));
        };
        let Some(low) = search_hex_value(pair[1]) else {
            return Err(search_error(
                "SEARCH_CURSOR_INVALID",
                "search cursor payload is not valid hex",
            ));
        };
        output.push((high << 4) | low);
    }
    Ok(output)
}

fn search_hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn search_sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut data = bytes.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    let mut hash: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in data.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let mut a = hash[0];
        let mut b = hash[1];
        let mut c = hash[2];
        let mut d = hash[3];
        let mut e = hash[4];
        let mut f = hash[5];
        let mut g = hash[6];
        let mut h = hash[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        hash[0] = hash[0].wrapping_add(a);
        hash[1] = hash[1].wrapping_add(b);
        hash[2] = hash[2].wrapping_add(c);
        hash[3] = hash[3].wrapping_add(d);
        hash[4] = hash[4].wrapping_add(e);
        hash[5] = hash[5].wrapping_add(f);
        hash[6] = hash[6].wrapping_add(g);
        hash[7] = hash[7].wrapping_add(h);
    }

    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for word in hash {
        for byte in word.to_be_bytes() {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    output
}

fn path_is_prefix(prefix: &[u32], path: &[u32]) -> bool {
    prefix.len() <= path.len() && prefix.iter().zip(path).all(|(left, right)| left == right)
}

fn source_endpoint_leaf_index(
    node: &LidNode,
    leaves: &[&LidNode],
    leaf_positions: &HashMap<&str, usize>,
    first: bool,
) -> Result<usize, ToolError> {
    if let Some(index) = leaf_positions.get(node.lid.as_str()) {
        return Ok(*index);
    }
    let descendants = leaves
        .iter()
        .enumerate()
        .filter(|(_, leaf)| path_is_prefix(&node.path, &leaf.path))
        .map(|(index, _)| index);
    if first {
        descendants.min()
    } else {
        descendants.max()
    }
    .ok_or_else(|| invalid_source_range("source container has no readable leaf"))
}

fn is_utf16_boundary(text: &[u16], index: usize) -> bool {
    index == 0
        || index == text.len()
        || !((0xd800..=0xdbff).contains(&text[index - 1])
            && (0xdc00..=0xdfff).contains(&text[index]))
}

fn utf16_is_whitespace(text: &[u16]) -> bool {
    String::from_utf16_lossy(text)
        .chars()
        .all(char::is_whitespace)
}

fn markdown_heading(text: &str) -> Option<String> {
    let trimmed = text.lines().find(|line| !line.trim().is_empty())?.trim();
    let marker_len = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    if marker_len == 0 || marker_len > 6 {
        return None;
    }
    let title = trimmed[marker_len..].trim();
    (!title.is_empty()).then(|| title.trim_end_matches('#').trim().to_string())
}

fn localized_source_kind(kind: &NodeKind, locale: &str) -> &'static str {
    let zh = locale.to_ascii_lowercase().starts_with("zh");
    match (zh, kind) {
        (true, NodeKind::Chapter) => "章节",
        (true, NodeKind::Section) => "小节",
        (true, NodeKind::Paragraph) => "正文",
        (true, NodeKind::Code) => "代码",
        (true, NodeKind::Table) => "表格",
        (true, NodeKind::Image) => "图片",
        (true, NodeKind::Formula) => "公式",
        (false, NodeKind::Chapter) => "Chapter",
        (false, NodeKind::Section) => "Section",
        (false, NodeKind::Paragraph) => "Passage",
        (false, NodeKind::Code) => "Code",
        (false, NodeKind::Table) => "Table",
        (false, NodeKind::Image) => "Figure",
        (false, NodeKind::Formula) => "Formula",
    }
}

fn source_evidence_digest(book_id: &str, evidence: &EvidenceRange, text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    let mut update = |part: &str| {
        for byte in part.as_bytes().iter().chain(std::iter::once(&0_u8)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    update(book_id);
    update(&evidence.start_lid);
    update(&evidence.end_lid);
    for selected in &evidence.ranges {
        update(&selected.lid);
        update(&selected.range.start.to_string());
        update(&selected.range.end.to_string());
    }
    update(text);
    format!("source-fnv1a64-{hash:016x}")
}

fn source_preview(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn contains_cjk(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(
            character as u32,
            0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
        )
    })
}

fn source_text_measure(text: &str, cjk: bool) -> usize {
    if cjk {
        text.chars().count()
    } else {
        text.split_whitespace().count()
    }
}

fn source_window_measure(
    before: &[String],
    highlighted_quote: &str,
    after: &[String],
    cjk: bool,
) -> usize {
    before
        .iter()
        .chain(after.iter())
        .map(|part| source_text_measure(part, cjk))
        .sum::<usize>()
        + source_text_measure(highlighted_quote, cjk)
}

fn limit_source_context(
    before: &str,
    after: &str,
    highlighted_quote: &str,
    cjk: bool,
    hard_max: usize,
) -> (String, String) {
    let remaining = hard_max.saturating_sub(source_text_measure(highlighted_quote, cjk));
    let before_budget = remaining / 2;
    let after_budget = remaining - before_budget;
    (
        take_source_units(before, before_budget, cjk, true),
        take_source_units(after, after_budget, cjk, false),
    )
}

fn take_source_units(text: &str, limit: usize, cjk: bool, from_end: bool) -> String {
    if cjk {
        let chars: Vec<_> = text.chars().collect();
        if chars.len() <= limit {
            return text.to_string();
        }
        if from_end {
            chars[chars.len() - limit..].iter().collect()
        } else {
            chars[..limit].iter().collect()
        }
    } else {
        let words: Vec<_> = text.split_whitespace().collect();
        if words.len() <= limit {
            return text.to_string();
        }
        if from_end {
            words[words.len() - limit..].join(" ")
        } else {
            words[..limit].join(" ")
        }
    }
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
            memory_policy: MemoryPolicyRef {
                policy_id: "paper".into(),
                policy_version: PAPER_MEMORY_POLICY_VERSION.into(),
            },
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
        assert_eq!(value["memory_policy"]["policy_id"], "paper");
        assert_eq!(
            value["memory_policy"]["policy_version"],
            PAPER_MEMORY_POLICY_VERSION
        );
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
    fn referent_catalog_book() -> Book {
        let texts = vec![
            "The nearby paragraph mentions target only as context.".to_string(),
            format!("{} target RAG {}", "a".repeat(220), "b".repeat(220)),
            "SameName appears at a different source location.".to_string(),
            "PaperOther and CoLocated share a location without sharing a label.".to_string(),
        ];
        let lids = ["1.1", "1.2", "2.1", "2.2"];
        let mut source = String::new();
        let mut lid_nodes = Vec::new();
        let mut offset = 0usize;
        for (index, (lid, text)) in lids.iter().zip(&texts).enumerate() {
            let start = offset;
            source.push_str(text);
            offset += text.encode_utf16().count();
            lid_nodes.push(LidNode {
                lid: (*lid).into(),
                path: vec![u32::try_from(index + 1).unwrap()],
                kind: NodeKind::Paragraph,
                span: Span { start, end: offset },
                children: Vec::new(),
            });
        }
        let base = ReadOnlyBase {
            book_id: "referent-catalog".into(),
            lid_nodes,
            graph_nodes: vec![
                GraphNode {
                    id: "concept:nearby".into(),
                    node_type: GraphNodeType::Concept,
                    name: "nearby".into(),
                    occurrences: vec!["1.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "concept:target".into(),
                    node_type: GraphNodeType::Concept,
                    name: "target".into(),
                    occurrences: vec!["1.2".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "concept:RAG".into(),
                    node_type: GraphNodeType::Concept,
                    name: "RAG".into(),
                    occurrences: vec!["1.2".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "concept:SameName".into(),
                    node_type: GraphNodeType::Concept,
                    name: "SameName".into(),
                    occurrences: vec!["1.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "concept:CoLocated".into(),
                    node_type: GraphNodeType::Concept,
                    name: "CoLocated".into(),
                    occurrences: vec!["2.2".into()],
                    source_lid: None,
                },
            ],
            graph_edges: Vec::new(),
        };
        Book::new(base, &source).with_paper_lexicon(Some(PaperLexiconSidecar {
            header: ProfileArtifactHeader {
                book_id: "referent-catalog".into(),
                book_version: "v1".into(),
                profile_id: "paper".into(),
                profile_version: "v1".into(),
                core_schema_version: "v1".into(),
                generated_at: "now".into(),
            },
            entries: vec![
                PaperLexiconEntry {
                    term: "RAG".into(),
                    term_type: "acronym".into(),
                    occurrences_lids: vec!["1.2".into()],
                    defined_at_lid: Some("1.2".into()),
                    aliases: (0..9).map(|index| format!("rag-alias-{index}")).collect(),
                    acronym_expansion: Some("Retrieval Augmented Generation".into()),
                    chinese_gloss: Some("检索增强生成".into()),
                },
                PaperLexiconEntry {
                    term: "SameName".into(),
                    term_type: "term".into(),
                    occurrences_lids: vec!["2.1".into()],
                    defined_at_lid: None,
                    aliases: Vec::new(),
                    acronym_expansion: None,
                    chinese_gloss: None,
                },
                PaperLexiconEntry {
                    term: "PaperOther".into(),
                    term_type: "term".into(),
                    occurrences_lids: vec!["2.2".into()],
                    defined_at_lid: None,
                    aliases: Vec::new(),
                    acronym_expansion: None,
                    chinese_gloss: None,
                },
            ],
        }))
    }

    #[test]
    fn referent_ranking_uses_anchor_only_as_peer_tiebreak() {
        let book = referent_catalog_book();
        for anchor in ["1.1", "2.2"] {
            let candidates = book.referent_catalog(anchor).unwrap().search("target", 5);
            assert_eq!(candidates[0].candidate_id, "concept:target");
            assert_eq!(candidates[0].recall_strength, CatalogRecallStrength::Direct);
            assert_eq!(
                candidates
                    .iter()
                    .find(|candidate| candidate.candidate_id == "concept:nearby")
                    .unwrap()
                    .recall_strength,
                CatalogRecallStrength::ContextOnly
            );
        }
    }

    #[test]
    fn candidate_preview_enforces_fair_topk_and_match_centered_caps() {
        let book = referent_catalog_book();
        let candidates = book.referent_catalog("1.1").unwrap().search("RAG", 12);
        assert_eq!(fair_candidate_quotas(1, 12), vec![12]);
        assert_eq!(fair_candidate_quotas(2, 12), vec![6, 6]);
        assert_eq!(fair_candidate_quotas(3, 12), vec![4, 4, 4]);
        let rag = candidates
            .iter()
            .find(|candidate| candidate.labels.iter().any(|label| label == "RAG"))
            .unwrap();
        assert!(rag.aliases.len() <= 6);
        assert!(rag.excerpts.len() <= 2);
        assert!(rag
            .excerpts
            .iter()
            .all(|excerpt| excerpt.text.chars().count() <= 180));
        assert!(rag
            .excerpts
            .iter()
            .any(|excerpt| excerpt.text.contains("target")));
    }

    #[test]
    fn paper_referent_catalog_merges_only_alias_and_shared_lid_matches() {
        let book = referent_catalog_book();
        let candidates = book.referent_catalog("1.1").unwrap().search("RAG", 20);
        let merged = candidates
            .iter()
            .filter(|candidate| candidate.labels.iter().any(|label| label == "RAG"))
            .collect::<Vec<_>>();
        assert_eq!(merged.len(), 1);
        assert_eq!(
            merged[0].sources,
            vec![
                CatalogReferentSource::Graph,
                CatalogReferentSource::PaperLexicon
            ]
        );
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate.labels.iter().any(|label| label == "SameName"))
                .count(),
            2
        );
        assert!(candidates.iter().any(|candidate| {
            candidate.labels.iter().any(|label| label == "PaperOther")
                && candidate.sources == vec![CatalogReferentSource::PaperLexicon]
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.labels.iter().any(|label| label == "CoLocated")
                && candidate.sources == vec![CatalogReferentSource::Graph]
        }));
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

    fn write_paper_minimap_book(name: &str, manifest_config_hash: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sections = [
            ("Introduction", "Intro text.\n", vec![0_u32]),
            (
                "Materials and Methods",
                "Method text.\n",
                vec![2_u32, 3_u32],
            ),
            ("Odd Segment", "Odd text.\n", vec![4_u32]),
        ];
        let mut source = String::new();
        let mut nodes = Vec::new();
        let mut map_entries = Vec::new();
        let mut section_lids = Vec::new();
        for (index, (title, body, pages)) in sections.iter().enumerate() {
            let section_lid = format!("1.{}", index + 1);
            let leaf_lid = format!("{section_lid}.1");
            let section_start = source.encode_utf16().count();
            let heading = format!("# {title}\n");
            source.push_str(&heading);
            let leaf_start = source.encode_utf16().count();
            source.push_str(body);
            let section_end = source.encode_utf16().count();
            nodes.push(LidNode {
                lid: section_lid.clone(),
                path: vec![1, (index + 1) as u32],
                kind: NodeKind::Section,
                span: Span {
                    start: section_start,
                    end: section_end,
                },
                children: vec![leaf_lid.clone()],
            });
            nodes.push(LidNode {
                lid: leaf_lid.clone(),
                path: vec![1, (index + 1) as u32, 1],
                kind: NodeKind::Paragraph,
                span: Span {
                    start: leaf_start,
                    end: section_end,
                },
                children: Vec::new(),
            });
            map_entries.push(serde_json::json!({
                "lid": leaf_lid,
                "source_span": {"start": leaf_start, "end": section_end},
                "status": "word_mapped",
                "regions": pages.iter().enumerate().map(|(region_index, page)| serde_json::json!({
                    "region_id": format!("pdf:{index}:{region_index}"),
                    "pageIndex": page,
                    "bbox": [0, 0, 10, 10]
                })).collect::<Vec<_>>(),
                "alignment": {"confidence": 1.0}
            }));
            section_lids.push(section_lid);
        }
        nodes.insert(
            0,
            LidNode {
                lid: "1".into(),
                path: vec![1],
                kind: NodeKind::Chapter,
                span: Span {
                    start: 0,
                    end: source.encode_utf16().count(),
                },
                children: section_lids,
            },
        );
        let base = ReadOnlyBase {
            book_id: "paper-minimap-book".into(),
            lid_nodes: nodes,
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        };
        let source_manifest = serde_json::json!({
            "version": "source_manifest.v2",
            "book_id": "paper-minimap-book",
            "canonical_source": {
                "kind": "reconciled_markdown",
                "path": "source.txt",
                "citation_anchor": "lid",
                "sha256": "source-sha-a"
            },
            "capabilities": {
                "view_pdf": {"status": "available"},
                "project_lid_to_pdf": {
                    "status": "available",
                    "config_hash": manifest_config_hash
                },
                "resolve_pdf_selection": {"status": "unavailable"},
                "project_ranges_to_pdf": {"status": "available"}
            }
        });
        let pdf_source_map = serde_json::json!({
            "version": "pdf_source_map.v1",
            "book_id": "paper-minimap-book",
            "pages": (0..5).map(|page| serde_json::json!({
                "pageIndex": page,
                "width": 100,
                "height": 100,
                "rotate": 0,
                "view": [0, 0, 100, 100]
            })).collect::<Vec<_>>(),
            "entries": map_entries,
            "config_hash": "config-a"
        });
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), source).unwrap();
        std::fs::write(
            dir.join("source_manifest.json"),
            source_manifest.to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("pdf_source_map.json"), pdf_source_map.to_string()).unwrap();
        dir
    }

    fn rewrite_paper_minimap_map_v2(dir: &std::path::Path) {
        let path = dir.join("pdf_source_map.json");
        let mut map: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        map["version"] = serde_json::json!("pdf_source_map.v2");
        for entry in map["entries"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().remove("status");
            entry["precision"] = serde_json::json!("char_exact");
            entry["exact_source_spans"] = serde_json::json!([entry["source_span"].clone()]);
            entry["alignment"] = serde_json::json!({
                "unit_id": format!("unit:{}", entry["lid"].as_str().unwrap()),
                "reason": "v2 test projection"
            });
        }
        std::fs::write(path, map.to_string()).unwrap();
    }

    fn write_flattened_paper_minimap_book(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut source = String::new();
        let mut nodes = Vec::new();
        let mut map_entries = Vec::new();
        let mut root_children = Vec::new();
        let mut push_paragraph = |lid: &str, text: &str, page: u32| {
            let start = source.encode_utf16().count();
            source.push_str(text);
            source.push_str("\n\n");
            let end = source.encode_utf16().count();
            let path = lid
                .split('.')
                .map(|part| part.parse::<u32>().unwrap())
                .collect();
            nodes.push(LidNode {
                lid: lid.into(),
                path,
                kind: NodeKind::Paragraph,
                span: Span { start, end },
                children: Vec::new(),
            });
            map_entries.push(serde_json::json!({
                "lid": lid,
                "source_span": {"start": start, "end": end},
                "status": "word_mapped",
                "regions": [{
                    "region_id": format!("pdf:{lid}"),
                    "pageIndex": page,
                    "bbox": [0, 0, 10, 10]
                }],
                "alignment": {"confidence": 1.0}
            }));
            root_children.push(lid.to_string());
        };
        push_paragraph("1.1", "BACKGROUND: Context and research gap.", 0);
        push_paragraph("1.2", "METHODS: We ran the experiment.", 0);
        push_paragraph("1.3", "RESULTS: The intervention worked.", 0);
        push_paragraph("1.4", "CONCLUSIONS: The result matters.", 0);
        push_paragraph("1.5", "METHODS", 0);
        drop(push_paragraph);

        let sections = [
            ("1.6", "Tissue Acquisition", "Method body.", 1_u32),
            ("1.7", "RESULTS", "Results overview.", 2_u32),
            ("1.8", "Detailed Finding", "Detailed result.", 2_u32),
            ("1.9", "Acknowledgments", "Thanks.", 3_u32),
        ];
        for (lid, title, body, page) in sections {
            let start = source.encode_utf16().count();
            source.push_str(&format!("## {title}\n\n"));
            let leaf_start = source.encode_utf16().count();
            source.push_str(body);
            source.push_str("\n\n");
            let end = source.encode_utf16().count();
            let leaf_lid = format!("{lid}.1");
            let path = lid
                .split('.')
                .map(|part| part.parse::<u32>().unwrap())
                .collect::<Vec<_>>();
            let mut leaf_path = path.clone();
            leaf_path.push(1);
            nodes.push(LidNode {
                lid: lid.into(),
                path,
                kind: NodeKind::Section,
                span: Span { start, end },
                children: vec![leaf_lid.clone()],
            });
            nodes.push(LidNode {
                lid: leaf_lid.clone(),
                path: leaf_path,
                kind: NodeKind::Paragraph,
                span: Span {
                    start: leaf_start,
                    end,
                },
                children: Vec::new(),
            });
            map_entries.push(serde_json::json!({
                "lid": leaf_lid,
                "source_span": {"start": leaf_start, "end": end},
                "status": "word_mapped",
                "regions": [{
                    "region_id": format!("pdf:{lid}"),
                    "pageIndex": page,
                    "bbox": [0, 0, 10, 10]
                }],
                "alignment": {"confidence": 1.0}
            }));
            root_children.push(lid.into());
        }
        nodes.insert(
            0,
            LidNode {
                lid: "1".into(),
                path: vec![1],
                kind: NodeKind::Chapter,
                span: Span {
                    start: 0,
                    end: source.encode_utf16().count(),
                },
                children: root_children,
            },
        );
        let base = ReadOnlyBase {
            book_id: "paper-minimap-flat".into(),
            lid_nodes: nodes,
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        };
        let source_manifest = serde_json::json!({
            "version": "source_manifest.v2",
            "book_id": "paper-minimap-flat",
            "canonical_source": {
                "kind": "reconciled_markdown",
                "path": "source.txt",
                "citation_anchor": "lid",
                "sha256": "source-sha-flat"
            },
            "capabilities": {
                "view_pdf": {"status": "available"},
                "project_lid_to_pdf": {"status": "available", "config_hash": "config-flat"},
                "resolve_pdf_selection": {"status": "unavailable"},
                "project_ranges_to_pdf": {"status": "available"}
            }
        });
        let pdf_source_map = serde_json::json!({
            "version": "pdf_source_map.v1",
            "book_id": "paper-minimap-flat",
            "pages": (0..4).map(|page| serde_json::json!({
                "pageIndex": page,
                "width": 100,
                "height": 100,
                "rotate": 0,
                "view": [0, 0, 100, 100]
            })).collect::<Vec<_>>(),
            "entries": map_entries,
            "config_hash": "config-flat"
        });
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), source).unwrap();
        std::fs::write(
            dir.join("source_manifest.json"),
            source_manifest.to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("pdf_source_map.json"), pdf_source_map.to_string()).unwrap();
        dir
    }

    fn write_paper_minimap_semantics(dir: &std::path::Path, dangling_pass2_evidence: bool) {
        let base_raw = std::fs::read_to_string(dir.join("base.json")).unwrap();
        let mut base: ReadOnlyBase = serde_json::from_str(&base_raw).unwrap();
        base.graph_nodes = vec![
            base_schema::GraphNode {
                id: "claim:hypothesis".into(),
                node_type: GraphNodeType::Claim,
                name: "The intervention should improve the outcome".into(),
                occurrences: Vec::new(),
                source_lid: Some("1.1.1".into()),
            },
            base_schema::GraphNode {
                id: "entity:experiment".into(),
                node_type: GraphNodeType::Entity,
                name: "Controlled experiment".into(),
                occurrences: vec!["1.2.1".into()],
                source_lid: None,
            },
            base_schema::GraphNode {
                id: "claim:result".into(),
                node_type: GraphNodeType::Claim,
                name: "The experiment improved the outcome".into(),
                occurrences: Vec::new(),
                source_lid: Some("1.3.1".into()),
            },
        ];
        base.graph_edges = vec![
            base_schema::GraphEdge {
                source: "claim:hypothesis".into(),
                target: "entity:experiment".into(),
                edge_type: "hypothesis_tested_by_experiment".into(),
                direction: Direction::Directed,
                scope: EdgeScope::Local,
                weight: 1.0,
            },
            base_schema::GraphEdge {
                source: "entity:experiment".into(),
                target: "claim:result".into(),
                edge_type: "method_supports_result".into(),
                direction: Direction::Directed,
                scope: EdgeScope::Local,
                weight: 1.0,
            },
        ];
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();

        let discourse = serde_json::json!({
            "header": {
                "book_id": "paper-minimap-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-12T00:00:00Z"
            },
            "items": [
                {
                    "lid": "1.1.1",
                    "mode": "argumentative",
                    "local_function": "research_question",
                    "local_summary": "Which intervention improves the outcome?",
                    "relations": [{
                        "target_lid": "1.3.1",
                        "type": "supports",
                        "direction": "forward",
                        "confidence": 1.0,
                        "evidence_lids": ["1.1.1", "1.3.1"]
                    }]
                },
                {
                    "lid": "1.2.1",
                    "mode": "procedural",
                    "local_function": "method_description",
                    "local_summary": "Runs the controlled experiment.",
                    "relations": []
                },
                {
                    "lid": "1.3.1",
                    "mode": "argumentative",
                    "local_function": "result_interpretation",
                    "rhetorical_move": "result_claim",
                    "local_summary": "Interprets the positive result.",
                    "relations": []
                }
            ]
        });
        std::fs::write(dir.join("discourse_index.json"), discourse.to_string()).unwrap();

        let structure = serde_json::json!({
            "header": {
                "book_id": "paper-minimap-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-12T00:00:00Z"
            },
            "spine": [
                {
                    "lid": "1.2",
                    "role": "method",
                    "summary": {"text": "Controlled method", "evidence_lids": ["1.2.1"]},
                    "key_stop_ids": [],
                    "depends_on": []
                },
                {
                    "lid": "1.3",
                    "role": "synthesis",
                    "summary": {"text": "Result synthesis", "evidence_lids": ["1.3.1"]},
                    "key_stop_ids": ["ks:result"],
                    "depends_on": ["1.2"]
                }
            ],
            "throughlines": [],
            "key_stops": [{
                "id": "ks:result",
                "lid": "1.3.1",
                "type": "claim",
                "title": "Central result",
                "reason": {"text": "Central result claim", "evidence_lids": ["1.3.1"]}
            }]
        });
        std::fs::write(dir.join("book_structure.json"), structure.to_string()).unwrap();

        let pass2_evidence = if dangling_pass2_evidence {
            vec!["1.1.1", "9.9"]
        } else {
            vec!["1.1.1", "1.3.1"]
        };
        let pass2 = serde_json::json!({
            "header": {
                "book_id": "paper-minimap-book",
                "book_version": "v1",
                "profile_id": "paper",
                "profile_version": "paper_v0",
                "core_schema_version": "core_v0",
                "generated_at": "2026-07-12T00:00:00Z"
            },
            "accepted": [{
                "candidate_id": "cand:hypothesis-result",
                "source": "claim:hypothesis",
                "target": "claim:result",
                "type": "supports",
                "source_evidence_lids": ["1.1.1"],
                "target_evidence_lids": [pass2_evidence[1]],
                "evidence_lids": pass2_evidence,
                "support_level": "explicit",
                "rationale": "Explicit cross-section support"
            }],
            "pending": [{
                "candidate_id": "pending:must-not-project",
                "source": "claim:result",
                "target": "claim:hypothesis",
                "type": "rebuts",
                "source_evidence_lids": ["1.3.1"],
                "target_evidence_lids": ["1.1.1"],
                "evidence_lids": ["1.3.1", "1.1.1"],
                "support_level": "strong_inference",
                "rationale": "Pending only"
            }],
            "rejected": [],
            "gate_dropped": []
        });
        std::fs::write(dir.join("pass2_audit.json"), pass2.to_string()).unwrap();
    }

    #[test]
    fn paper_minimap_projects_heading_alias_unknown_and_cross_page_region() {
        let dir = write_paper_minimap_book("ub-read-tools-paper-minimap-project", "config-a");
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.status, PaperMinimapAvailabilityStatus::Degraded);
        assert_eq!(minimap.regions.len(), 3);
        assert_eq!(minimap.regions[0].title, "Introduction");
        assert_eq!(minimap.regions[0].kind, PaperRegionKind::Introduction);
        assert_eq!(minimap.regions[1].kind, PaperRegionKind::Method);
        assert_eq!(minimap.regions[1].page_span.start_page, 2);
        assert_eq!(minimap.regions[1].page_span.end_page, 3);
        assert_eq!(minimap.regions[2].kind, PaperRegionKind::Unknown);
        assert_eq!(minimap.regions[2].confidence, 0.0);
        assert_eq!(minimap.fingerprint, book.paper_minimap().fingerprint);
        assert_eq!(
            minimap.layer_status["topology"].status,
            PaperMinimapAvailabilityStatus::Available
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_dual_reads_v1_and_v2_source_maps_but_rejects_unknown_versions() {
        let v1_dir = write_paper_minimap_book("ub-read-tools-paper-minimap-v1", "config-a");
        let v1 = Book::load(v1_dir.to_str().unwrap())
            .unwrap()
            .paper_minimap();
        assert_ne!(v1.status, PaperMinimapAvailabilityStatus::Unavailable);

        let v2_dir = write_paper_minimap_book("ub-read-tools-paper-minimap-v2", "config-a");
        rewrite_paper_minimap_map_v2(&v2_dir);
        let v2 = Book::load(v2_dir.to_str().unwrap())
            .unwrap()
            .paper_minimap();
        assert_ne!(v2.status, PaperMinimapAvailabilityStatus::Unavailable);
        assert_eq!(v2.regions, v1.regions);

        let unknown_dir =
            write_paper_minimap_book("ub-read-tools-paper-minimap-unknown", "config-a");
        let path = unknown_dir.join("pdf_source_map.json");
        let mut map: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        map["version"] = serde_json::json!("pdf_source_map.v3");
        std::fs::write(path, map.to_string()).unwrap();
        let unknown = Book::load(unknown_dir.to_str().unwrap())
            .unwrap()
            .paper_minimap();
        assert_eq!(unknown.status, PaperMinimapAvailabilityStatus::Unavailable);
        assert!(unknown
            .warnings
            .iter()
            .any(|warning| warning.contains("unsupported PDF source map version")));

        let _ = std::fs::remove_dir_all(v1_dir);
        let _ = std::fs::remove_dir_all(v2_dir);
        let _ = std::fs::remove_dir_all(unknown_dir);
    }

    #[test]
    fn paper_minimap_recovers_structured_abstract_and_flattened_major_sections() {
        let dir = write_flattened_paper_minimap_book("ub-read-tools-paper-minimap-flat");
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.regions.len(), 5);
        assert_eq!(minimap.regions[0].kind, PaperRegionKind::Abstract);
        assert_eq!(minimap.regions[0].lid_span.start_lid, "1.1");
        assert_eq!(minimap.regions[0].lid_span.end_lid, "1.4");
        assert_eq!(minimap.regions[1].kind, PaperRegionKind::Method);
        assert_eq!(minimap.regions[2].kind, PaperRegionKind::Results);
        assert_eq!(minimap.regions[3].kind, PaperRegionKind::Results);
        assert_eq!(minimap.regions[4].kind, PaperRegionKind::Unknown);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_stale_config_degrades_without_breaking_book_load() {
        let dir = write_paper_minimap_book("ub-read-tools-paper-minimap-stale", "config-b");
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.status, PaperMinimapAvailabilityStatus::Unavailable);
        assert!(minimap.regions.is_empty());
        assert!(minimap
            .warnings
            .iter()
            .any(|warning| warning.contains("config_hash is stale")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_projects_deduped_landmarks_provenance_and_closed_relations() {
        let dir = write_paper_minimap_book("ub-read-tools-paper-minimap-semantics", "config-a");
        write_paper_minimap_semantics(&dir, false);
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.status, PaperMinimapAvailabilityStatus::Available);
        assert!(minimap
            .landmarks
            .iter()
            .any(|landmark| landmark.kind == PaperLandmarkKind::ResearchQuestion));
        assert!(minimap
            .landmarks
            .iter()
            .any(|landmark| landmark.kind == PaperLandmarkKind::Method));
        let result_claims: Vec<&PaperLandmark> = minimap
            .landmarks
            .iter()
            .filter(|landmark| {
                landmark.kind == PaperLandmarkKind::Claim && landmark.anchor_lid == "1.3.1"
            })
            .collect();
        assert_eq!(result_claims.len(), 1);
        assert!(result_claims[0]
            .provenance
            .contains(&PaperLandmarkProvenance::BookStructure));
        assert!(result_claims[0]
            .provenance
            .contains(&PaperLandmarkProvenance::Graph));
        assert!(result_claims[0]
            .provenance
            .contains(&PaperLandmarkProvenance::Pass2));
        let tests_relation = minimap
            .relations
            .iter()
            .find(|relation| relation.relation_type == PaperMinimapRelation::Tests)
            .unwrap();
        assert!(tests_relation
            .source_landmark_id
            .starts_with("landmark:experiment:"));
        assert!(tests_relation
            .target_landmark_id
            .starts_with("landmark:hypothesis:"));
        assert!(minimap
            .relations
            .iter()
            .any(|relation| relation.relation_type == PaperMinimapRelation::Produces));
        assert!(!minimap
            .relations
            .iter()
            .any(|relation| relation.relation_type == PaperMinimapRelation::Challenges));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_drops_dangling_pass2_evidence_and_degrades_arguments_only() {
        let dir =
            write_paper_minimap_book("ub-read-tools-paper-minimap-dangling-pass2", "config-a");
        write_paper_minimap_semantics(&dir, true);
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.status, PaperMinimapAvailabilityStatus::Degraded);
        assert_eq!(
            minimap.layer_status["topology"].status,
            PaperMinimapAvailabilityStatus::Available
        );
        assert_eq!(
            minimap.layer_status["arguments"].status,
            PaperMinimapAvailabilityStatus::Degraded
        );
        assert!(minimap
            .warnings
            .iter()
            .any(|warning| warning.contains("Pass2 edge") && warning.contains("invalid evidence")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_missing_semantic_sidecars_keeps_topology_and_marks_layers_unavailable() {
        let dir = write_paper_minimap_book("ub-read-tools-paper-minimap-topology-only", "config-a");
        let book = Book::load(dir.to_str().unwrap()).unwrap();
        let minimap = book.paper_minimap();

        assert_eq!(minimap.regions.len(), 3);
        assert_eq!(
            minimap.layer_status["landmarks"].status,
            PaperMinimapAvailabilityStatus::Unavailable
        );
        assert_eq!(
            minimap.layer_status["arguments"].status,
            PaperMinimapAvailabilityStatus::Unavailable
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paper_minimap_base_contract_round_trips_closed_types() {
        let region = PaperRegion {
            region_id: "region:method".into(),
            title: "Methods".into(),
            kind: PaperRegionKind::Method,
            lid_span: PaperLidSpan {
                start_lid: "2.1".into(),
                end_lid: "2.4".into(),
            },
            page_span: PaperPageSpan {
                start_page: 2,
                end_page: 4,
            },
            classification_source: PaperRegionClassificationSource::Heading,
            confidence: 1.0,
        };
        let landmark = PaperLandmark {
            landmark_id: "landmark:method:2.2".into(),
            kind: PaperLandmarkKind::Method,
            anchor_lid: "2.2".into(),
            page_index: 3,
            label: "核心方法".into(),
            source_label: Some("Splicing assay".into()),
            evidence_lids: vec!["2.2".into()],
            provenance: vec![
                PaperLandmarkProvenance::BookStructure,
                PaperLandmarkProvenance::Discourse,
            ],
        };
        let relation = PaperArgumentRelation {
            relation_id: "relation:method-result".into(),
            relation_type: PaperMinimapRelation::Produces,
            source_landmark_id: landmark.landmark_id.clone(),
            target_landmark_id: "landmark:result:3.1".into(),
            evidence_lids: vec!["2.2".into(), "3.1".into()],
        };
        let base = PaperMinimapBase {
            version: "paper_minimap.v1".into(),
            book_id: "paper-a".into(),
            book_version: "v1".into(),
            fingerprint: "fp-a".into(),
            status: PaperMinimapAvailabilityStatus::Degraded,
            regions: vec![region],
            landmarks: vec![landmark],
            relations: vec![relation],
            layer_status: HashMap::from([(
                "arguments".into(),
                PaperMinimapLayerStatus {
                    status: PaperMinimapAvailabilityStatus::Degraded,
                    reason: Some("partial graph coverage".into()),
                },
            )]),
            warnings: vec!["partial graph coverage".into()],
        };

        let value = serde_json::to_value(&base).unwrap();
        assert_eq!(value["version"], "paper_minimap.v1");
        assert_eq!(value["status"], "degraded");
        assert_eq!(value["regions"][0]["kind"], "method");
        assert_eq!(value["relations"][0]["type"], "produces");
        assert_eq!(
            serde_json::from_value::<PaperMinimapBase>(value).unwrap(),
            base
        );
    }

    #[test]
    fn paper_minimap_contract_rejects_unknown_enum_and_missing_required_field() {
        let unknown_kind = serde_json::json!({
            "region_id": "region:x",
            "title": "X",
            "kind": "invented",
            "lid_span": {"start_lid": "1.1", "end_lid": "1.1"},
            "page_span": {"start_page": 0, "end_page": 0},
            "classification_source": "unknown",
            "confidence": 0.0
        });
        assert!(serde_json::from_value::<PaperRegion>(unknown_kind).is_err());

        let missing_evidence = serde_json::json!({
            "relation_id": "relation:x",
            "type": "supports",
            "source_landmark_id": "landmark:a",
            "target_landmark_id": "landmark:b"
        });
        assert!(serde_json::from_value::<PaperArgumentRelation>(missing_evidence).is_err());
    }

    fn source_presentation_book() -> Book {
        const SOURCE: &str = concat!(
            "# Chapter One\n",
            "Chapter intro gives broad context.\n",
            "## Methods\n",
            "Alpha evidence begins here.\n",
            "Beta evidence continues here.\n",
            "## Results\n",
            "Gamma result follows.\n",
            "Chapter closing context.\n",
            "# Chapter Two\n",
            "## Methods\n",
            "Outside boundary.\n",
        );

        fn offset(source: &str, needle: &str) -> usize {
            source[..source.find(needle).unwrap()]
                .encode_utf16()
                .count()
        }

        fn span(source: &str, text: &str) -> Span {
            let start = offset(source, text);
            Span {
                start,
                end: start + text.encode_utf16().count(),
            }
        }

        let chapter_two_start = offset(SOURCE, "# Chapter Two\n");
        let methods_start = offset(SOURCE, "## Methods\n");
        let results_start = offset(SOURCE, "## Results\n");
        let source_end = SOURCE.encode_utf16().count();
        let base = ReadOnlyBase {
            book_id: "source-presentation-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span {
                        start: 0,
                        end: chapter_two_start,
                    },
                    children: vec!["1.1".into(), "1.2".into(), "1.3".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Chapter intro gives broad context.\n"),
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Section,
                    span: Span {
                        start: methods_start,
                        end: results_start,
                    },
                    children: vec!["1.2.1".into(), "1.2.2".into()],
                },
                LidNode {
                    lid: "1.2.1".into(),
                    path: vec![1, 2, 1],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Alpha evidence begins here.\n"),
                    children: vec![],
                },
                LidNode {
                    lid: "1.2.2".into(),
                    path: vec![1, 2, 2],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Beta evidence continues here.\n"),
                    children: vec![],
                },
                LidNode {
                    lid: "1.3".into(),
                    path: vec![1, 3],
                    kind: NodeKind::Section,
                    span: Span {
                        start: results_start,
                        end: chapter_two_start,
                    },
                    children: vec!["1.3.1".into(), "1.3.2".into()],
                },
                LidNode {
                    lid: "1.3.1".into(),
                    path: vec![1, 3, 1],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Gamma result follows.\n"),
                    children: vec![],
                },
                LidNode {
                    lid: "1.3.2".into(),
                    path: vec![1, 3, 2],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Chapter closing context.\n"),
                    children: vec![],
                },
                LidNode {
                    lid: "2".into(),
                    path: vec![2],
                    kind: NodeKind::Chapter,
                    span: Span {
                        start: chapter_two_start,
                        end: source_end,
                    },
                    children: vec!["2.1".into()],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Section,
                    span: Span {
                        start: offset(SOURCE, "## Methods\nOutside boundary.\n"),
                        end: source_end,
                    },
                    children: vec!["2.1.1".into()],
                },
                LidNode {
                    lid: "2.1.1".into(),
                    path: vec![2, 1, 1],
                    kind: NodeKind::Paragraph,
                    span: span(SOURCE, "Outside boundary.\n"),
                    children: vec![],
                },
            ],
            graph_nodes: vec![],
            graph_edges: vec![],
        };
        Book::new(base, SOURCE)
    }

    fn selected_source_range(lid: &str, start: u32, end: u32) -> SourceSelectedRange {
        SourceSelectedRange {
            lid: lid.into(),
            range: SourceTextRange { start, end },
        }
    }

    #[test]
    fn source_presentation_resolves_original_heading_localized_kind_and_stable_digest() {
        let book = source_presentation_book();
        let evidence = EvidenceRange {
            start_lid: "1.2.1".into(),
            end_lid: "1.2.1".into(),
            ranges: vec![selected_source_range("1.2.1", 0, 14)],
        };

        let first = book.resolve_source(&evidence, "zh-CN", None).unwrap();
        let second = book.resolve_source(&evidence, "zh-CN", None).unwrap();

        assert_eq!(first.label, "正文 · Methods");
        assert_eq!(first.heading_path, vec!["Chapter One", "Methods"]);
        assert_eq!(first.highlighted_quote, "Alpha evidence");
        assert_eq!(first.preview, "Alpha evidence");
        assert!(first
            .context_after
            .contains("Beta evidence continues here."));
        assert!(!first.context_before.contains("Chapter intro"));
        assert!(first.evidence_text_digest.starts_with("source-fnv1a64-"));
        assert_eq!(first.evidence_text_digest, second.evidence_text_digest);
    }

    #[test]
    fn source_presentation_accepts_adjacent_multi_lid_and_rejects_skipped_leaf() {
        let book = source_presentation_book();
        let adjacent = EvidenceRange {
            start_lid: "1.2.1".into(),
            end_lid: "1.2.2".into(),
            ranges: vec![
                selected_source_range("1.2.1", 0, 27),
                selected_source_range("1.2.2", 0, 29),
            ],
        };
        assert!(book.resolve_source(&adjacent, "en", None).is_ok());

        let skipped = EvidenceRange {
            start_lid: "1.2.1".into(),
            end_lid: "1.3.1".into(),
            ranges: vec![
                selected_source_range("1.2.1", 0, 27),
                selected_source_range("1.3.1", 0, 21),
            ],
        };
        let error = book.resolve_source(&skipped, "en", None).unwrap_err();
        assert_eq!(error.error_code, "INVALID_SOURCE_RANGE");
    }

    #[test]
    fn source_presentation_accepts_cross_heading_continuity_and_bounds_context() {
        let book = source_presentation_book();
        let evidence = EvidenceRange {
            start_lid: "1.2.2".into(),
            end_lid: "1.3.1".into(),
            ranges: vec![
                selected_source_range("1.2.2", 0, 29),
                selected_source_range("1.3.1", 0, 21),
            ],
        };

        let resolved = book.resolve_source(&evidence, "en", None).unwrap();

        assert!(resolved
            .highlighted_quote
            .contains("Beta evidence continues here."));
        assert!(resolved.highlighted_quote.contains("Gamma result follows."));
        assert!(resolved
            .context_before
            .contains("Chapter intro gives broad context."));
        assert!(resolved.context_after.contains("Chapter closing context."));
        assert!(!resolved.context_after.contains("Outside boundary."));
    }

    #[test]
    fn source_presentation_preserves_structural_book_text_passage() {
        let book = source_presentation_book();
        let evidence = EvidenceRange {
            start_lid: "1.2".into(),
            end_lid: "1.2".into(),
            ranges: vec![],
        };

        let resolved = book.resolve_source(&evidence, "zh-CN", None).unwrap();

        assert_eq!(resolved.label, "小节 · Methods");
        assert_eq!(
            resolved.highlighted_quote,
            book.text("1.2", None).unwrap().trim()
        );
        assert!(resolved.highlighted_quote.starts_with("## Methods"));
        assert!(!resolved.context_before.contains("Chapter intro"));
        assert!(!resolved.context_after.contains("Gamma result"));
    }

    #[test]
    fn source_presentation_rejects_invalid_utf16_range() {
        let book = source_presentation_book();
        let evidence = EvidenceRange {
            start_lid: "1.2.1".into(),
            end_lid: "1.2.1".into(),
            ranges: vec![selected_source_range("1.2.1", 0, 99)],
        };

        let error = book.resolve_source(&evidence, "en", None).unwrap_err();
        assert_eq!(error.error_code, "INVALID_SOURCE_RANGE");
    }

    #[test]
    fn source_presentation_rejects_digest_mismatch() {
        let book = source_presentation_book();
        let evidence = EvidenceRange {
            start_lid: "1.2.1".into(),
            end_lid: "1.2.1".into(),
            ranges: vec![selected_source_range("1.2.1", 0, 14)],
        };
        let digest = book
            .resolve_source(&evidence, "en", None)
            .unwrap()
            .evidence_text_digest;

        assert!(book.resolve_source(&evidence, "en", Some(&digest)).is_ok());
        let error = book
            .resolve_source(&evidence, "en", Some("source-fnv1a64-deadbeef"))
            .unwrap_err();
        assert_eq!(error.error_code, "SOURCE_STALE");
    }

    #[test]
    fn source_presentation_preserves_chinese_heading_and_falls_back_without_heading() {
        let source = "# 第一章\n## 方法\n证据文本。\n";
        let chapter_end = source.encode_utf16().count();
        let section_start = "# 第一章\n".encode_utf16().count();
        let leaf_start = "# 第一章\n## 方法\n".encode_utf16().count();
        let titled = Book::new(
            ReadOnlyBase {
                book_id: "source-presentation-zh".into(),
                lid_nodes: vec![
                    LidNode {
                        lid: "1".into(),
                        path: vec![1],
                        kind: NodeKind::Chapter,
                        span: Span {
                            start: 0,
                            end: chapter_end,
                        },
                        children: vec!["1.1".into()],
                    },
                    LidNode {
                        lid: "1.1".into(),
                        path: vec![1, 1],
                        kind: NodeKind::Section,
                        span: Span {
                            start: section_start,
                            end: chapter_end,
                        },
                        children: vec!["1.1.1".into()],
                    },
                    LidNode {
                        lid: "1.1.1".into(),
                        path: vec![1, 1, 1],
                        kind: NodeKind::Paragraph,
                        span: Span {
                            start: leaf_start,
                            end: chapter_end,
                        },
                        children: vec![],
                    },
                ],
                graph_nodes: vec![],
                graph_edges: vec![],
            },
            source,
        );
        let resolved = titled
            .resolve_source(
                &EvidenceRange {
                    start_lid: "1.1.1".into(),
                    end_lid: "1.1.1".into(),
                    ranges: vec![selected_source_range("1.1.1", 0, 5)],
                },
                "zh-CN",
                None,
            )
            .unwrap();
        assert_eq!(resolved.label, "正文 · 方法");
        assert_eq!(resolved.heading_path, vec!["第一章", "方法"]);

        let untitled = book()
            .resolve_source(
                &EvidenceRange {
                    start_lid: "1.1".into(),
                    end_lid: "1.1".into(),
                    ranges: vec![],
                },
                "zh-CN",
                None,
            )
            .unwrap();
        assert_eq!(untitled.label, "正文");
        assert!(untitled.heading_path.is_empty());
    }

    #[test]
    fn source_presentation_disambiguates_duplicate_titles_with_parent_headings() {
        let book = source_presentation_book();
        let mut resolved = vec![
            book.resolve_source(
                &EvidenceRange {
                    start_lid: "1.2.1".into(),
                    end_lid: "1.2.1".into(),
                    ranges: vec![],
                },
                "zh-CN",
                None,
            )
            .unwrap(),
            book.resolve_source(
                &EvidenceRange {
                    start_lid: "2.1.1".into(),
                    end_lid: "2.1.1".into(),
                    ranges: vec![],
                },
                "zh-CN",
                None,
            )
            .unwrap(),
        ];
        assert_eq!(resolved[0].label, "正文 · Methods");
        assert_eq!(resolved[1].label, "正文 · Methods");

        disambiguate_source_labels(&mut resolved);

        assert_eq!(resolved[0].label, "正文 · Chapter One / Methods");
        assert_eq!(resolved[1].label, "正文 · Chapter Two / Methods");
        assert!(!resolved.iter().any(|source| source.label.contains("1.2")));
    }

    #[test]
    fn source_presentation_context_obeys_hard_word_limit_and_keeps_nearest_text() {
        let before = (0..400)
            .map(|index| format!("before{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let after = (0..400)
            .map(|index| format!("after{index}"))
            .collect::<Vec<_>>()
            .join(" ");

        let (limited_before, limited_after) =
            limit_source_context(&before, &after, "evidence", false, 500);

        assert_eq!(
            source_text_measure(&limited_before, false)
                + source_text_measure("evidence", false)
                + source_text_measure(&limited_after, false),
            500
        );
        assert!(limited_before.ends_with("before399"));
        assert!(limited_after.starts_with("after0"));
    }
}

#[cfg(test)]
mod search_text_exact_tests {
    use super::*;
    use base_schema::sample_base;

    fn node(
        lid: &str,
        path: &[u32],
        kind: NodeKind,
        start: usize,
        end: usize,
        children: &[&str],
    ) -> LidNode {
        LidNode {
            lid: lid.into(),
            path: path.to_vec(),
            kind,
            span: Span { start, end },
            children: children.iter().map(|child| (*child).into()).collect(),
        }
    }

    fn search_book(source: &str, lid_nodes: Vec<LidNode>) -> Book {
        let mut base = sample_base();
        base.book_id = "search-text-exact".into();
        base.lid_nodes = lid_nodes;
        base.graph_nodes.clear();
        base.graph_edges.clear();
        Book::new(base, source)
    }

    #[test]
    fn search_text_exact_counts_overlaps_and_uses_span_document_order() {
        let book = search_book(
            "aaaa",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 4, &["1.9", "1.10"]),
                // Deliberately reverse base order; span/path define canonical order.
                node("1.10", &[1, 10], NodeKind::Paragraph, 2, 4, &[]),
                node("1.9", &[1, 9], NodeKind::Paragraph, 0, 2, &[]),
            ],
        );

        let result = book.search_text_exact("aa", None).unwrap();
        assert!(result.exhaustive);
        assert_eq!(result.total_occurrences, 3);
        assert_eq!(result.total_lids, 2);
        assert_eq!(
            result
                .occurrences
                .iter()
                .map(|occurrence| (occurrence.ordinal, occurrence.source_range_utf16.clone()))
                .collect::<Vec<_>>(),
            vec![
                (1, Span { start: 0, end: 2 }),
                (2, Span { start: 1, end: 3 }),
                (3, Span { start: 2, end: 4 }),
            ]
        );
        assert_eq!(result.occurrences[0].start_lid, "1.9");
        assert_eq!(result.occurrences[1].start_lid, "1.9");
        assert_eq!(result.occurrences[1].end_lid, "1.10");
        assert_eq!(result.occurrences[1].ranges.len(), 2);
        assert_eq!(result.occurrences[2].start_lid, "1.10");
        assert_eq!(result.section_counts[0].section_lid, "1.9");
        assert_eq!(result.section_counts[0].count, 2);
        assert_eq!(result.section_counts[1].section_lid, "1.10");
        assert_eq!(result.section_counts[1].count, 1);
    }

    #[test]
    fn search_text_exact_preserves_global_whitespace_gap_and_leaf_ranges() {
        let book = search_book(
            "ab cd",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 5, &["1.1", "1.2"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 2, &[]),
                node("1.2", &[1, 2], NodeKind::Paragraph, 3, 5, &[]),
            ],
        );

        let result = book.search_text_exact("b c", None).unwrap();
        assert_eq!(result.total_occurrences, 1);
        let occurrence = &result.occurrences[0];
        assert_eq!(occurrence.source_range_utf16, Span { start: 1, end: 4 });
        assert_eq!(
            occurrence.ranges,
            vec![
                TextOccurrenceRange {
                    lid: "1.1".into(),
                    start_utf16: 1,
                    end_utf16: 2,
                },
                TextOccurrenceRange {
                    lid: "1.2".into(),
                    start_utf16: 0,
                    end_utf16: 1,
                },
            ]
        );
    }

    #[test]
    fn search_text_exact_scope_and_utf16_offsets_are_stable() {
        let source = "甲😀甲😀";
        let book = search_book(
            source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 6, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 6, &[]),
            ],
        );

        let all = book.search_text_exact("😀", None).unwrap();
        assert_eq!(
            all.occurrences
                .iter()
                .map(|occurrence| occurrence.source_range_utf16.clone())
                .collect::<Vec<_>>(),
            vec![Span { start: 1, end: 3 }, Span { start: 4, end: 6 }]
        );
        let scoped = book
            .search_text_exact("😀", Some(Span { start: 3, end: 6 }))
            .unwrap();
        assert_eq!(scoped.total_occurrences, 1);
        assert_eq!(scoped.occurrences[0].source_range_utf16.start, 4);

        let invalid = book
            .search_text_exact("😀", Some(Span { start: 2, end: 6 }))
            .unwrap_err();
        assert_eq!(invalid.error_code, "SEARCH_SCOPE_INVALID");
    }

    #[test]
    fn search_text_exact_rejects_invalid_partition_and_stabilizes_revision() {
        assert_eq!(
            search_sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let one_leaf = search_book(
            "abcd",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 4, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 4, &[]),
            ],
        );
        let two_leaves = search_book(
            "abcd",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 4, &["1.1", "1.2"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 2, &[]),
                node("1.2", &[1, 2], NodeKind::Paragraph, 2, 4, &[]),
            ],
        );
        let empty = one_leaf.search_text_exact("missing", None).unwrap();
        assert!(empty.exhaustive);
        assert_eq!(empty.total_occurrences, 0);
        assert_eq!(empty.total_lids, 0);
        assert_ne!(
            empty.source_revision,
            two_leaves
                .search_text_exact("missing", None)
                .unwrap()
                .source_revision
        );
        assert_eq!(
            one_leaf
                .search_text_exact("   ", None)
                .unwrap_err()
                .error_code,
            "SEARCH_QUERY_EMPTY"
        );

        let non_whitespace_gap = search_book(
            "aXb",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 3, &["1.1", "1.2"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 1, &[]),
                node("1.2", &[1, 2], NodeKind::Paragraph, 2, 3, &[]),
            ],
        );
        assert_eq!(
            non_whitespace_gap
                .search_text_exact("a", None)
                .unwrap_err()
                .error_code,
            "SEARCH_SOURCE_INVALID"
        );

        let overlap = search_book(
            "abc",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 3, &["1.1", "1.2"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 2, &[]),
                node("1.2", &[1, 2], NodeKind::Paragraph, 1, 3, &[]),
            ],
        );
        assert_eq!(
            overlap.search_text_exact("a", None).unwrap_err().error_code,
            "SEARCH_SOURCE_INVALID"
        );
    }

    fn request(query: &str, match_mode: SearchMatchMode, page_size: usize) -> SearchTextInput {
        SearchTextInput {
            query: query.into(),
            match_mode,
            scope: None,
            order: SearchOrder::Document,
            cursor: None,
            page_size,
        }
    }

    #[test]
    fn search_text_pagination_concatenates_the_complete_set_in_both_orders() {
        let source = "x x x x x";
        let end = source.encode_utf16().count();
        let book = search_book(
            source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, end, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, end, &[]),
            ],
        );

        for (order, expected) in [
            (SearchOrder::Document, vec![1, 2, 3, 4, 5]),
            (SearchOrder::ReverseDocument, vec![5, 4, 3, 2, 1]),
        ] {
            let mut input = request("x", SearchMatchMode::Exact, 2);
            input.order = order;
            let mut ordinals = Vec::new();
            loop {
                let page = book.search_text(&input).unwrap();
                assert_eq!(page.version, "search_text.v1");
                assert!(page.exhaustive);
                assert_eq!(page.total_occurrences, 5);
                ordinals.extend(page.occurrences.iter().map(|occurrence| occurrence.ordinal));
                let Some(cursor) = page.next_cursor else {
                    break;
                };
                input.cursor = Some(cursor);
            }
            assert_eq!(ordinals, expected);
        }
    }

    #[test]
    fn search_text_pagination_distinguishes_invalid_mismatch_and_stale_cursors() {
        let source = "x x x";
        let end = source.encode_utf16().count();
        let book = search_book(
            source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, end, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, end, &[]),
            ],
        );
        let input = request("x", SearchMatchMode::Exact, 1);
        let cursor = book.search_text(&input).unwrap().next_cursor.unwrap();

        let mut mismatch = request("x", SearchMatchMode::Exact, 2);
        mismatch.cursor = Some(cursor.clone());
        assert_eq!(
            book.search_text(&mismatch).unwrap_err().error_code,
            "SEARCH_CURSOR_MISMATCH"
        );

        let stale_book = search_book(
            "x y x",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, end, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, end, &[]),
            ],
        );
        let mut stale = input.clone();
        stale.cursor = Some(cursor.clone());
        assert_eq!(
            stale_book.search_text(&stale).unwrap_err().error_code,
            "SEARCH_CURSOR_STALE"
        );

        let mut invalid = input;
        invalid.cursor = Some(format!("{cursor}0"));
        assert_eq!(
            book.search_text(&invalid).unwrap_err().error_code,
            "SEARCH_CURSOR_INVALID"
        );
    }

    #[test]
    fn search_text_pagination_intersects_within_and_relative_scopes() {
        let source = "one two one three one";
        let end = source.encode_utf16().count();
        let book = search_book(
            source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, end, &["1.1", "1.2", "1.3"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 3, &[]),
                node("1.2", &[1, 2], NodeKind::Paragraph, 4, 11, &[]),
                node("1.3", &[1, 3], NodeKind::Paragraph, 12, end, &[]),
            ],
        );

        let mut within = request("one", SearchMatchMode::Exact, 20);
        within.scope = Some(SearchTextScope {
            within_lid: Some("1.2".into()),
            relative_to: None,
        });
        let result = book.search_text(&within).unwrap();
        assert_eq!(result.total_occurrences, 1);
        assert_eq!(result.occurrences[0].start_lid, "1.2");

        let mut before = request("one", SearchMatchMode::Exact, 20);
        before.scope = Some(SearchTextScope {
            within_lid: None,
            relative_to: Some(book_tool_contracts::SearchRelativeScope {
                lid: "1.3".into(),
                direction: SearchRelativeDirection::Before,
            }),
        });
        assert_eq!(book.search_text(&before).unwrap().total_occurrences, 2);

        let mut empty_intersection = request("one", SearchMatchMode::Exact, 20);
        empty_intersection.scope = Some(SearchTextScope {
            within_lid: Some("1.1".into()),
            relative_to: Some(book_tool_contracts::SearchRelativeScope {
                lid: "1.2".into(),
                direction: SearchRelativeDirection::After,
            }),
        });
        let empty = book.search_text(&empty_intersection).unwrap();
        assert_eq!(empty.total_occurrences, 0);
        assert!(empty.next_cursor.is_none());

        within.scope.as_mut().unwrap().within_lid = Some("9.9".into());
        assert_eq!(
            book.search_text(&within).unwrap_err().error_code,
            "SEARCH_SCOPE_INVALID"
        );
    }

    #[test]
    fn search_text_pagination_normalized_maps_nfkc_casefold_and_whitespace_to_source() {
        assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_casefold::UNICODE_VERSION, (9, 0, 0));
        assert!(SEARCH_TEXT_NORMALIZATION_VERSION.contains("u17.0.0"));
        assert!(SEARCH_TEXT_NORMALIZATION_VERSION.contains("u9.0.0"));

        use unicode_normalization::UnicodeNormalization;

        let source = "Ａ Straße\r\n  CAFÉ e\u{301} 가";
        let end = source.encode_utf16().count();
        let book = search_book(
            source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, end, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, end, &[]),
            ],
        );

        let expected = source
            .nfkc()
            .case_fold()
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let mapped =
            normalize_mapped_units(&source.encode_utf16().collect::<Vec<_>>(), 0, end).unwrap();
        assert_eq!(
            String::from_utf16(&mapped.iter().map(|unit| unit.value).collect::<Vec<_>>()).unwrap(),
            expected
        );

        let whole = book
            .search_text(&request(
                "a STRASSE   CAFÉ É 가",
                SearchMatchMode::Normalized,
                20,
            ))
            .unwrap();
        assert_eq!(whole.total_occurrences, 1);
        assert_eq!(
            whole.occurrences[0].source_range_utf16,
            Span { start: 0, end }
        );
        assert_eq!(
            String::from_utf16(
                &source.encode_utf16().collect::<Vec<_>>()[whole.occurrences[0]
                    .source_range_utf16
                    .start
                    ..whole.occurrences[0].source_range_utf16.end]
            )
            .unwrap(),
            source
        );

        let sharp_s = search_book(
            "ß",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 1, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 1, &[]),
            ],
        );
        assert_eq!(
            sharp_s
                .search_text(&request("s", SearchMatchMode::Normalized, 20))
                .unwrap()
                .total_occurrences,
            1,
            "case-fold expansion must not duplicate one original source range"
        );

        let combining = search_book(
            "e\u{301}",
            vec![
                node("1", &[1], NodeKind::Chapter, 0, 2, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, 2, &[]),
            ],
        );
        let composed = combining
            .search_text(&request("é", SearchMatchMode::Normalized, 20))
            .unwrap();
        assert_eq!(
            composed.occurrences[0].source_range_utf16,
            Span { start: 0, end: 2 }
        );
    }

    #[test]
    fn search_text_real_book_replays_all_formula_occurrences() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".understand-book/quantification-essence");
        assert!(
            path.join("base.json").is_file(),
            "real-book base is missing"
        );
        assert!(
            path.join("source.txt").is_file(),
            "real-book source is missing"
        );
        let book = Book::load(path.to_str().unwrap()).unwrap();
        let query = r"\sqrt{2\ln N}";
        let exact = book.search_text_exact(query, None).unwrap();
        assert_eq!(exact.total_occurrences, 32);
        assert_eq!(exact.occurrences[0].start_lid, "1.10.3.10");

        let mut input = request(query, SearchMatchMode::Exact, 7);
        let mut page_ranges = Vec::new();
        let mut page_ordinals = Vec::new();
        let mut pages = 0;
        loop {
            let page = book.search_text(&input).unwrap();
            pages += 1;
            assert_eq!(page.total_occurrences, 32);
            assert_eq!(page.total_lids, exact.total_lids);
            assert_eq!(page.section_counts, exact.section_counts);
            page_ranges.extend(
                page.occurrences
                    .iter()
                    .map(|occurrence| occurrence.source_range_utf16.clone()),
            );
            page_ordinals.extend(page.occurrences.iter().map(|occurrence| occurrence.ordinal));
            let Some(cursor) = page.next_cursor else {
                break;
            };
            input.cursor = Some(cursor);
        }
        assert_eq!(pages, 5);
        assert_eq!(page_ordinals, (1..=32).collect::<Vec<_>>());
        assert_eq!(
            page_ranges,
            exact
                .occurrences
                .iter()
                .map(|occurrence| occurrence.source_range_utf16.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn search_text_release_5_mib_p95_is_under_one_second() {
        if cfg!(debug_assertions) {
            return;
        }
        const SOURCE_SIZE: usize = 5 * 1024 * 1024;
        let source = "x".repeat(SOURCE_SIZE);
        let book = search_book(
            &source,
            vec![
                node("1", &[1], NodeKind::Chapter, 0, SOURCE_SIZE, &["1.1"]),
                node("1.1", &[1, 1], NodeKind::Paragraph, 0, SOURCE_SIZE, &[]),
            ],
        );
        let input = request("x", SearchMatchMode::Exact, 50);
        let warmup = book.search_text(&input).unwrap();
        assert_eq!(warmup.total_occurrences, SOURCE_SIZE);
        assert_eq!(warmup.occurrences.len(), 50);

        let mut elapsed = Vec::new();
        for _ in 0..7 {
            let started = std::time::Instant::now();
            let result = book.search_text(&input).unwrap();
            elapsed.push(started.elapsed());
            assert_eq!(result.total_occurrences, SOURCE_SIZE);
            assert_eq!(result.occurrences.len(), 50);
        }
        elapsed.sort_unstable();
        let p95 = elapsed[(elapsed.len() * 95).div_ceil(100) - 1];
        eprintln!("5 MiB exact search p95: {p95:?}");
        assert!(
            p95 < std::time::Duration::from_secs(1),
            "5 MiB exact search p95 exceeded one second: {p95:?}"
        );
    }
}
