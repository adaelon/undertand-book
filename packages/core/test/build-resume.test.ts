import { describe, it, expect } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows, type WindowBudget } from "../src/window";
import { buildPass1Input } from "../src/pass1-input";
import {
  computeBuildStatus,
  pass1ContentHash,
  buildPass1Artifact,
  type Pass1ArtifactMeta,
} from "../src/build-resume";
import type { Pass1Output } from "../src/merge";

// 多章多段 → 至少 2 窗(小预算逼分窗,便于测部分抽 / 失配)
const md =
  "# 章一\n\n第一段。\n\n第二段较长内容以撑预算。\n\n# 章二\n\n第三段。\n\n第四段也较长以撑预算。\n\n# 章三\n\n第五段。";
const nodes = segment(markdownToBlocks(md));
const byLid = new Map(nodes.map((n) => [n.lid, n]));
const TIGHT: WindowBudget = { maxInputTokens: 30, maxLeavesSoft: 1 };
const windows = splitWindows(nodes, md, TIGHT);

/** 把全部窗口算成"已正确落盘"的 existing map(content_hash = 重算值)。 */
function allDoneMap(): Map<number, Pass1ArtifactMeta> {
  return new Map(windows.map((w) => [w.id, { content_hash: pass1ContentHash(buildPass1Input(w, byLid, md)) }]));
}

describe("PB5-2 computeBuildStatus 续建视图 [ADR-0042]", () => {
  it("夹具确实多窗(否则部分抽/失配测不出)", () => {
    expect(windows.length).toBeGreaterThanOrEqual(2);
  });

  it("磁盘全缺 → 全 pending", () => {
    const { done, pending } = computeBuildStatus(windows, byLid, md, new Map());
    expect(done).toEqual([]);
    expect(pending).toEqual(windows.map((w) => w.id));
  });

  it("全抽且 content_hash 一致 → 全 done", () => {
    const { done, pending } = computeBuildStatus(windows, byLid, md, allDoneMap());
    expect(pending).toEqual([]);
    expect(done).toEqual(windows.map((w) => w.id));
  });

  it("删某窗 json(map 缺该 id)→ 该窗 pending,余 done", () => {
    const m = allDoneMap();
    const dropped = windows[0].id;
    m.delete(dropped);
    const { done, pending } = computeBuildStatus(windows, byLid, md, m);
    expect(pending).toEqual([dropped]);
    expect(done).toEqual(windows.filter((w) => w.id !== dropped).map((w) => w.id));
  });

  it("content_hash 失配(source 变 / 陈旧产物)→ 该窗 pending,不静默复用", () => {
    const m = allDoneMap();
    const stale = windows[windows.length - 1].id;
    m.set(stale, { content_hash: "deadbeef-陈旧" });
    const { done, pending } = computeBuildStatus(windows, byLid, md, m);
    expect(pending).toEqual([stale]);
    expect(done).not.toContain(stale);
  });

  it("pass1ContentHash 确定性、对正文变化敏感", () => {
    const inp = buildPass1Input(windows[0], byLid, md);
    expect(pass1ContentHash(inp)).toBe(pass1ContentHash(inp)); // 同输入同 hash
    const mutated = { ...inp, text: inp.text + " x" };
    expect(pass1ContentHash(mutated)).not.toBe(pass1ContentHash(inp)); // 正文变 hash 变
  });

  it("buildPass1Artifact:content_hash 从窗口重算(= 状态 done 判据)、nodes/edges 原样挂", () => {
    const w = windows[0];
    const output: Pass1Output = {
      nodes: [{ id: "entity:x", type: "entity", name: "X", occurrences: [w.leafLids[0]], source_lid: null }],
      edges: [],
    };
    const art = buildPass1Artifact(w, byLid, md, output);
    // content_hash 与续建视图重算一致 → 写出的产物 computeBuildStatus 必判 done
    expect(art.content_hash).toBe(pass1ContentHash(buildPass1Input(w, byLid, md)));
    expect(art.nodes).toEqual(output.nodes); // 抽取结果原样
    expect(art.edges).toEqual(output.edges);
    const status = computeBuildStatus([w], byLid, md, new Map([[w.id, art]]));
    expect(status.done).toEqual([w.id]);
  });
});
