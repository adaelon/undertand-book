// 预构建产出前的运行时自检 schema（zod），镜像 crates/base-schema 的 Rust 权威定义。
// 字段失配在 .parse() 处抛错（非静默）——兑现 S0 判据① + ADR-0021「zod 产出前自检」。
// 注:本文件是手写镜像;Rust 权威类型见 src/generated/*（ts-rs 生成）。
import { z } from "zod";

export const SpanZ = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const NodeKindZ = z.enum(["chapter", "section", "paragraph"]);

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

export const GraphEdgeZ = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  scope: EdgeScopeZ,
  weight: z.number(),
});

export const ReadOnlyBaseZ = z.object({
  book_id: z.string(),
  lid_nodes: z.array(LidNodeZ),
  graph_nodes: z.array(GraphNodeZ),
  graph_edges: z.array(GraphEdgeZ),
});
