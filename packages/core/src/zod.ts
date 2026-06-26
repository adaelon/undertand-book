// 预构建产出前的运行时自检 schema（zod），镜像 crates/base-schema 的 Rust 权威定义。
// 字段失配在 .parse() 处抛错（非静默）——兑现 S0 判据① + ADR-0021「zod 产出前自检」。
// 注:本文件是手写镜像;Rust 权威类型见 src/generated/*（ts-rs 生成）。
import { z } from "zod";

export const ProfileArtifactHeaderZ = z.object({
  book_id: z.string().min(1),
  book_version: z.string().min(1),
  profile_id: z.literal("technical_learning"),
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
export const ReadOnlyBaseZ = z.object({
  book_id: z.string(),
  lid_nodes: z.array(LidNodeZ),
  graph_nodes: z.array(GraphNodeZ),
  graph_edges: z.array(GraphEdgeZ),
});
