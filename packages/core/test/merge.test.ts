import { describe, it, expect } from "vitest";
import { mergeAndGate, type Pass1Output } from "../src/merge";
import type { GraphNode } from "../src/generated/GraphNode";
import type { GraphEdge } from "../src/generated/GraphEdge";
import type { LidNode } from "../src/generated/LidNode";

const leaf = (lid: string): LidNode => ({
  lid,
  path: lid.split(".").map(Number),
  kind: "paragraph",
  span: { start: 0, end: 1 },
  children: [],
});
const ent = (id: string, name: string, occ: string[]): GraphNode => ({ id, type: "entity", name, occurrences: occ, source_lid: null });
const claim = (id: string, name: string, lid: string): GraphNode => ({ id, type: "claim", name, occurrences: [], source_lid: lid });
const edge = (source: string, target: string, type: string, direction: "directed" | "undirected", weight: number): GraphEdge => ({ source, target, type, direction, scope: "local", weight });

const LIDS = [leaf("1.1"), leaf("1.2"), leaf("2.1")]; // 全集 = 叶子 = 3

describe("S3 merge + 确定性图谱闸 [ADR-0010/0011]", () => {
  it("实体跨窗口 occurrences 并集合并(name keep-last)", () => {
    const outs: Pass1Output[] = [
      { nodes: [ent("entity:command", "command", ["1.1"])], edges: [] },
      { nodes: [ent("entity:command", "Command", ["1.2"])], edges: [] },
    ];
    const { nodes, report } = mergeAndGate(outs, LIDS);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].occurrences.sort()).toEqual(["1.1", "1.2"]);
    expect(nodes[0].name).toBe("Command"); // keep-last
    expect(report.nodesMerged).toBe(1);
  });

  it("边去重 (source,target,type,direction) keep higher weight", () => {
    const outs: Pass1Output[] = [
      { nodes: [ent("entity:a", "a", ["1.1"]), ent("entity:b", "b", ["1.2"])], edges: [edge("entity:a", "entity:b", "builds_on", "directed", 0.5)] },
      { nodes: [], edges: [edge("entity:a", "entity:b", "builds_on", "directed", 0.8)] },
    ];
    const { edges, report } = mergeAndGate(outs, LIDS);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.8);
    expect(report.edgesDeduped).toBe(1);
  });

  it("undirected 边规范化端点顺序 (A,B)≡(B,A)", () => {
    const outs: Pass1Output[] = [
      {
        nodes: [ent("entity:a", "a", ["1.1"]), ent("entity:b", "b", ["1.2"])],
        edges: [edge("entity:a", "entity:b", "contradicts", "undirected", 0.6), edge("entity:b", "entity:a", "contradicts", "undirected", 0.9)],
      },
    ];
    const { edges, report } = mergeAndGate(outs, LIDS);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
    expect(report.edgesDeduped).toBe(1);
  });

  it("边端节点缺失只丢边、不连坐节点(missing_target)", () => {
    const outs: Pass1Output[] = [
      { nodes: [ent("entity:a", "a", ["1.1"])], edges: [edge("entity:a", "entity:ghost", "cites", "directed", 0.7)] },
    ];
    const { nodes, edges, report } = mergeAndGate(outs, LIDS);
    expect(nodes).toHaveLength(1); // entity:a 存活
    expect(edges).toHaveLength(0);
    expect(report.droppedEdges).toEqual([{ source: "entity:a", target: "entity:ghost", type: "cites", reason: "missing_target" }]);
  });

  it("断言 source_lid 悬空 → 丢断言 + 连坐其边", () => {
    const outs: Pass1Output[] = [
      {
        nodes: [ent("entity:a", "a", ["1.1"]), claim("claim:9.9:x", "悬空断言", "9.9")],
        edges: [edge("claim:9.9:x", "entity:a", "exemplifies", "directed", 0.8)],
      },
    ];
    const { nodes, edges, report } = mergeAndGate(outs, LIDS);
    expect(nodes.map((n) => n.id)).toEqual(["entity:a"]); // 断言被丢
    expect(report.droppedNodes).toContainEqual({ id: "claim:9.9:x", reason: "claim_source_lid_dangling" });
    expect(edges).toHaveLength(0); // 连坐:边因 source 不在 survivors 被丢
    expect(report.droppedEdges[0].reason).toBe("missing_source");
  });

  it("实体部分 occurrence 悬空 → 只剔该锚、节点存活", () => {
    const outs: Pass1Output[] = [{ nodes: [ent("entity:a", "a", ["1.1", "9.9"])], edges: [] }];
    const { nodes, report } = mergeAndGate(outs, LIDS);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].occurrences).toEqual(["1.1"]); // 9.9 被剔
    expect(report.prunedOccurrences).toEqual([{ id: "entity:a", lid: "9.9" }]);
  });

  it("实体 occurrences 全悬空 → 丢节点 + 连坐边", () => {
    const outs: Pass1Output[] = [
      { nodes: [ent("entity:dead", "dead", ["9.8", "9.9"]), ent("entity:a", "a", ["1.1"])], edges: [edge("entity:a", "entity:dead", "builds_on", "directed", 0.5)] },
    ];
    const { nodes, edges, report } = mergeAndGate(outs, LIDS);
    expect(nodes.map((n) => n.id)).toEqual(["entity:a"]);
    expect(report.droppedNodes).toContainEqual({ id: "entity:dead", reason: "all_occurrences_dangling" });
    expect(edges).toHaveLength(0); // 连坐
  });

  it("锚定率 = 锚定叶子 LID / 总叶子 LID", () => {
    // 锚定 1.1、2.1,未锚定 1.2 ⇒ 2/3
    const outs: Pass1Output[] = [{ nodes: [ent("entity:a", "a", ["1.1"]), claim("claim:2.1:y", "断言", "2.1")], edges: [] }];
    const { report } = mergeAndGate(outs, LIDS);
    expect(report.anchorRate).toBeCloseTo(2 / 3, 5);
  });

  it("每条丢弃可见 + 计数自洽(无静默丢)", () => {
    const outs: Pass1Output[] = [
      { nodes: [ent("entity:a", "a", ["1.1"]), claim("claim:9.9:x", "悬空", "9.9")], edges: [edge("entity:a", "entity:ghost", "cites", "directed", 0.7)] },
    ];
    const { report } = mergeAndGate(outs, LIDS);
    expect(report.nodesIn).toBe(2);
    expect(report.nodesOut).toBe(1);
    expect(report.droppedNodes).toHaveLength(1);
    expect(report.edgesIn).toBe(1);
    expect(report.edgesOut).toBe(0);
    expect(report.droppedEdges).toHaveLength(1);
  });
});
