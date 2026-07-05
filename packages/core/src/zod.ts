// 预构建产出前的运行时自检 schema（zod），镜像 crates/base-schema 的 Rust 权威定义。
// 字段失配在 .parse() 处抛错（非静默）——兑现 S0 判据① + ADR-0021「zod 产出前自检」。
// 注:本文件是手写镜像;Rust 权威类型见 src/generated/*（ts-rs 生成）。
import { z } from "zod";
import { SUPPORTED_CONTENT_PROFILE_IDS } from "./content-profile";

export const ProfileArtifactHeaderZ = z.object({
  book_id: z.string().min(1),
  book_version: z.string().min(1),
  profile_id: z.enum(SUPPORTED_CONTENT_PROFILE_IDS),
  profile_version: z.string().min(1),
  core_schema_version: z.string().min(1),
  generated_at: z.string().min(1),
});
export const SpanZ = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const NodeKindZ = z.enum(["chapter", "section", "paragraph", "code", "table", "image", "formula"]);

export const LidNodeZ = z.object({
  lid: z.string(),
  path: z.array(z.number().int().nonnegative()),
  kind: NodeKindZ,
  span: SpanZ,
  children: z.array(z.string()),
});

export const GraphNodeTypeZ = z.enum(["entity", "concept", "claim"]);

export const GraphNodeZ = z.object({
  id: z.string(),
  type: GraphNodeTypeZ,
  name: z.string(),
  occurrences: z.array(z.string()),
  source_lid: z.string().nullable(),
});

export const EdgeScopeZ = z.enum(["local", "long_range"]);

export const DirectionZ = z.enum(["directed", "undirected"]);

export const GraphEdgeZ = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  direction: DirectionZ,
  scope: EdgeScopeZ,
  weight: z.number(),
});


export const FormulaParameterZ = z.object({
  symbol: z.string(),
  label: z.string().nullable(),
  meaning: z.string(),
  unit: z.string().nullable(),
  domain: z.string().nullable(),
  evidence_lids: z.array(z.string()),
});

export const FormulaCompositionZ = z.object({
  source_lid: z.string(),
  meaning: z.string(),
  terms: z.array(z.string()),
  evidence_lids: z.array(z.string()),
});

export const FormulaContextLinkZ = z.object({
  target_lid: z.string(),
  relation: z.string(),
  description: z.string(),
  evidence_lids: z.array(z.string()),
});

export const FormulaSemanticsZ = z.object({
  formula_lid: z.string(),
  parameters: z.array(FormulaParameterZ),
  composition: FormulaCompositionZ,
  context_links: z.array(FormulaContextLinkZ),
});
export const FormulaSemanticsSidecarZ = z.object({
  header: ProfileArtifactHeaderZ,
  items: z.array(FormulaSemanticsZ),
});

export const PdfSourceMapManifestEntryZ = z.object({
  status: z.enum(["not_provided", "provided"]),
  path: z.string().min(1).optional(),
  may_project_lid_to_pdf_region: z.boolean(),
  citation_anchor: z.literal(false),
});

export const OriginalPdfAttachmentManifestEntryZ = z.object({
  kind: z.literal("original_pdf"),
  path: z.string().min(1),
  role: z.literal("side_preview"),
  participates_in_lid: z.literal(false),
  citation_anchor: z.literal(false),
  pdf_source_map: PdfSourceMapManifestEntryZ,
});

export const SourceManifestZ = z.object({
  book_id: z.string().min(1),
  canonical_source: z.object({
    kind: z.enum(["markdown", "epub"]),
    path: z.string().min(1),
    truth_file: z.literal("source.txt"),
    participates_in_lid: z.literal(true),
    citation_anchor: z.literal("lid"),
  }),
  attachments: z.array(OriginalPdfAttachmentManifestEntryZ),
});

export const ImageAssetManifestEntryZ = z.object({
  kind: z.literal("image"),
  lid: z.string().min(1),
  alt: z.string(),
  original_src: z.string().min(1),
  source: z.enum(["markdown", "epub", "data_uri"]),
  status: z.enum(["available", "missing", "external", "unsupported"]),
  stored_path: z.string().min(1).nullable(),
  url_path: z.string().min(1).nullable(),
  mime: z.string().min(1).nullable(),
  sha256: z.string().min(1).nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  warning: z.string().min(1).nullable(),
});

export const AssetManifestZ = z.object({
  version: z.literal("asset_manifest.v1"),
  book_id: z.string().min(1),
  images: z.array(ImageAssetManifestEntryZ),
});

export const MetadataSourceZ = z.enum(["front_matter", "paper_text", "user_supplied", "filename", "external_resolver"]);
export const MetadataFieldZ = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    source: MetadataSourceZ,
    evidence_lids: z.array(z.string().min(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  });
export const PaperAuthorZ = z.object({
  name: z.string().min(1),
  raw: z.string().optional(),
});
export const PaperReferenceZ = z.object({
  raw: z.string().min(1),
  identifiers: z.record(z.string()).optional(),
});
export const PaperMetadataZ = z.object({
  header: ProfileArtifactHeaderZ,
  title: MetadataFieldZ(z.string().min(1)).optional(),
  authors: MetadataFieldZ(z.array(PaperAuthorZ)).optional(),
  affiliations: MetadataFieldZ(z.array(z.string().min(1))).optional(),
  venue: MetadataFieldZ(z.string().min(1)).optional(),
  year: MetadataFieldZ(z.number()).optional(),
  identifiers: z
    .object({
      doi: MetadataFieldZ(z.string().min(1)).optional(),
      arxiv: MetadataFieldZ(z.string().min(1)).optional(),
      url: MetadataFieldZ(z.string().min(1)).optional(),
    })
    .optional(),
  keywords: MetadataFieldZ(z.array(z.string().min(1))).optional(),
  field_labels: MetadataFieldZ(z.array(z.string().min(1))).optional(),
  references: MetadataFieldZ(z.array(PaperReferenceZ)).optional(),
  datasets: MetadataFieldZ(z.array(z.string().min(1))).optional(),
  code_links: MetadataFieldZ(z.array(z.string().min(1))).optional(),
  funding: MetadataFieldZ(z.array(z.string().min(1))).optional(),
});
export const PaperTermTypeZ = z.enum([
  "paper_defined_term",
  "method_name",
  "acronym",
  "domain_term",
  "dataset_name",
  "metric_name",
  "model_name",
  "academic_phrase",
]);
export const PaperLexiconEntryZ = z.object({
  term: z.string().min(1),
  term_type: PaperTermTypeZ,
  occurrences_lids: z.array(z.string().min(1)).min(1),
  defined_at_lid: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  acronym_expansion: z.string().min(1).optional(),
  chinese_gloss: z.string().min(1).optional(),
});
export const PaperLexiconZ = z.object({
  header: ProfileArtifactHeaderZ,
  entries: z.array(PaperLexiconEntryZ),
});
export const DiscourseModeZ = z.enum(["informative", "argumentative", "procedural", "descriptive", "meta"]);
export const LocalFunctionZ = z.enum([
  "definition",
  "description",
  "classification",
  "explanation",
  "cause",
  "effect",
  "example",
  "counterexample",
  "comparison",
  "contrast",
  "procedure_step",
  "application",
  "warning",
  "limitation",
  "question",
  "answer",
  "summary",
  "research_question",
  "hypothesis",
  "related_work",
  "method_description",
  "experiment_setup",
  "evidence_report",
  "result_interpretation",
  "future_work",
  "transition",
]);
export const RhetoricalMoveZ = z.enum([
  "chapter_setup",
  "problem_framing",
  "prerequisite",
  "main_point",
  "concept_elaboration",
  "worked_example",
  "case_analysis",
  "argument_support",
  "objection",
  "resolution",
  "recap",
  "abstract_summary",
  "related_work_positioning",
  "method_setup",
  "experiment_report",
  "result_claim",
  "limitation_acknowledgement",
  "future_work_projection",
  "bridge_to_next",
]);
export const DiscourseRelationTypeZ = z.enum([
  "elaborates",
  "exemplifies",
  "explains",
  "causes",
  "results_in",
  "contrasts",
  "concedes",
  "supports",
  "rebuts",
  "summarizes",
  "restates",
  "prepares",
  "continues",
  "answers",
  "depends_on",
]);
export const DiscourseRelationFamilyZ = z.enum(["temporal", "contingency", "comparison", "expansion"]);
export const DiscourseDirectionZ = z.enum(["backward", "forward", "lateral"]);
export const TechnicalLearningDiscourseRelationZ = z.object({
  target_lid: z.string(),
  type: DiscourseRelationTypeZ,
  family: DiscourseRelationFamilyZ.optional(),
  direction: DiscourseDirectionZ,
  confidence: z.number().min(0).max(1),
  evidence_lids: z.array(z.string()).min(1),
});
export const TechnicalLearningDiscourseItemZ = z.object({
  lid: z.string(),
  mode: DiscourseModeZ,
  local_function: LocalFunctionZ.optional(),
  rhetorical_move: RhetoricalMoveZ.optional(),
  local_summary: z.string().optional(),
  relations: z.array(TechnicalLearningDiscourseRelationZ),
});
export const TechnicalLearningDiscourseIndexZ = z.object({
  header: ProfileArtifactHeaderZ,
  items: z.array(TechnicalLearningDiscourseItemZ),
});
// PB3 Pass2 build audit sidecar self-check (mirrors pass2-build.ts).
export const TechnicalLearningLongRangeEdgeTypeZ = z.enum([
  "builds_on",
  "contradicts",
  "exemplifies",
  "prerequisite",
  "refines",
  "applies",
  "analogous_to",
  "contrasts",
  "supports",
  "rebuts",
  "summarizes",
  "claim_supported_by_evidence",
  "method_supports_result",
  "hypothesis_tested_by_experiment",
  "related_work_contrasts",
  "related_work_builds_on",
  "limitation_motivates_future_work",
]);
export const SupportLevelZ = z.enum(["explicit", "strong_inference", "weak_inference"]);
export const Pass2AuditEdgeZ = z.object({
  candidate_id: z.string(),
  source: z.string(),
  target: z.string(),
  type: TechnicalLearningLongRangeEdgeTypeZ,
  source_evidence_lids: z.array(z.string()),
  target_evidence_lids: z.array(z.string()),
  evidence_lids: z.array(z.string()),
  support_level: SupportLevelZ,
  rationale: z.string(),
  failure_risk: z.string().optional(),
});
export const RejectedCandidateZ = z.object({
  candidate_id: z.string(),
  reason: z.enum([
    "topical_overlap_only",
    "missing_source_evidence",
    "missing_target_evidence",
    "relation_contract_not_met",
    "direction_unclear",
    "weak_retrieval_value",
    "duplicate_or_local_relation",
  ]),
});
export const Pass2GateDropZ = z.object({
  candidate_id: z.string(),
  reason: z.enum([
    "invalid_type",
    "invalid_scope",
    "missing_source",
    "missing_target",
    "empty_source_evidence",
    "empty_target_evidence",
    "evidence_not_covering",
    "dangling_evidence",
    "weak_inference",
    "below_weight_threshold",
    "not_cross_window",
  ]),
});
export const Pass2BuildAuditSidecarZ = z.object({
  header: ProfileArtifactHeaderZ,
  accepted: z.array(Pass2AuditEdgeZ),
  pending: z.array(Pass2AuditEdgeZ),
  rejected: z.array(RejectedCandidateZ),
  gate_dropped: z.array(Pass2GateDropZ),
});
export const AnchoredTextZ = z.object({
  text: z.string().min(1),
  evidence_lids: z.array(z.string()).min(1),
});
export const BookStructureSpineRoleZ = z.enum(["setup", "foundation", "method", "application", "case", "synthesis"]);
export const BookStructureKeyStopTypeZ = z.enum(["definition", "formula", "claim", "example", "turning_point", "warning", "summary"]);
export const BookStructureKeyStopZ = z.object({
  id: z.string().min(1),
  lid: z.string().min(1),
  type: BookStructureKeyStopTypeZ,
  title: z.string().optional(),
  reason: AnchoredTextZ,
});
export const BookStructureSpineUnitZ = z.object({
  lid: z.string().min(1),
  role: BookStructureSpineRoleZ,
  summary: AnchoredTextZ,
  key_stop_ids: z.array(z.string()),
  depends_on: z.array(z.string()),
});
export const BookStructureThroughlineZ = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: AnchoredTextZ,
  lids: z.array(z.string()).min(1),
  key_stop_ids: z.array(z.string()),
});
export const BookStructureSidecarZ = z.object({
  header: ProfileArtifactHeaderZ,
  spine: z.array(BookStructureSpineUnitZ),
  throughlines: z.array(BookStructureThroughlineZ),
  key_stops: z.array(BookStructureKeyStopZ),
});
export const ReadOnlyBaseZ = z.object({
  book_id: z.string(),
  lid_nodes: z.array(LidNodeZ),
  graph_nodes: z.array(GraphNodeZ),
  graph_edges: z.array(GraphEdgeZ),
});
