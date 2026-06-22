// S3 Pass1 抽取输入组装 [ADR-0010]。把 S2 窗口还原成喂 pass1-local-extractor 的正文:
// **每个叶子段前缀 [LID] 标注** —— 这是回填红线([ADR-0004])的物理前提:
// LLM 引用的 LID 只能从标注里回填、不自由生成,悬空锚由下游确定性闸([ADR-0011])丢弃。
// 纯确定性(不调 LLM),消费 Window.leafLids + LidNode.span 取真原文。
import type { LidNode } from "./generated/LidNode";
import type { Window } from "./window";

export interface Pass1Input {
  windowId: number;
  /** 本窗口覆盖的叶子 LID(有序,= Window.leafLids) */
  lids: string[];
  /** 抽取输入正文:每段一块,前缀 `[lid] `,块间空行分隔 */
  text: string;
}

/** 单窗口 → Pass1 抽取输入(每段前缀 [LID])。 */
export function buildPass1Input(w: Window, byLid: Map<string, LidNode>, source: string): Pass1Input {
  const blocks = w.leafLids.map((lid) => {
    const n = byLid.get(lid)!;
    return `[${lid}] ${source.slice(n.span.start, n.span.end)}`;
  });
  return { windowId: w.id, lids: [...w.leafLids], text: blocks.join("\n\n") };
}

/** 批量:全部窗口 → Pass1 抽取输入序列。 */
export function buildPass1Inputs(windows: Window[], nodes: LidNode[], source: string): Pass1Input[] {
  const byLid = new Map(nodes.map((n) => [n.lid, n]));
  return windows.map((w) => buildPass1Input(w, byLid, source));
}
