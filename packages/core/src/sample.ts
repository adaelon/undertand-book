// 按 ts-rs 生成的权威类型构造样例基座(与 Rust base_schema::sample_base() 逐字段对齐)。
// 用生成类型做编译期约束(tsc --noEmit 验);形状失配会被 tsc 抓到。
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";

export function buildSampleBase(): ReadOnlyBase {
  return {
    book_id: "sample-book",
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: 100 }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 100 }, children: [] },
    ],
    graph_nodes: [
      { id: "entity:command", type: "entity", name: "command", occurrences: ["1.1"], source_lid: null },
      {
        id: "claim:1.1:cmd-is-reified-call",
        type: "claim",
        name: "命令是对象化的方法调用",
        occurrences: [],
        source_lid: "1.1",
      },
    ],
    graph_edges: [
      {
        source: "claim:1.1:cmd-is-reified-call",
        target: "entity:command",
        type: "exemplifies",
        direction: "directed",
        scope: "local",
        weight: 0.8,
      },
    ],
  };
}
