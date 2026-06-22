import { describe, it, expect } from "vitest";
import { projectCatalog } from "../src/catalog";
import type { GraphNode } from "../src/generated/GraphNode";

const ent = (id: string, name: string, occ: string[]): GraphNode => ({ id, type: "entity", name, occurrences: occ, source_lid: null });
const claim = (id: string, name: string, lid: string): GraphNode => ({ id, type: "claim", name, occurrences: [], source_lid: lid });

describe("S3 全局目录投影 [ADR-0010]", () => {
  const nodes: GraphNode[] = [
    ent("entity:command", "command", ["1.1", "2.3"]),
    claim("claim:1.1:x", "命令是对象化调用", "1.1"),
  ];
  const cat = projectCatalog(nodes);

  it("目录 ≡ 节点:每节点恰一条,零幽灵", () => {
    expect(cat).toHaveLength(nodes.length);
    expect(cat.map((c) => c.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it("实体 lid = occurrences[0],断言 lid = source_lid", () => {
    expect(cat.find((c) => c.id === "entity:command")!.lid).toBe("1.1");
    expect(cat.find((c) => c.id === "claim:1.1:x")!.lid).toBe("1.1");
  });

  it("type/name 透传", () => {
    const e = cat.find((c) => c.id === "entity:command")!;
    expect(e.type).toBe("entity");
    expect(e.name).toBe("command");
  });

  it("空图 → 空目录", () => {
    expect(projectCatalog([])).toEqual([]);
  });
});
