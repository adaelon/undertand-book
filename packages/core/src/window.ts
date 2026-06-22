// S2 窗口切分 [ADR-0009]。消费 S1 段级 LidNode[],按 LID 章/节子树切成喂给 Pass1 的窗口。
// 双约束预算:输入硬闸(近似 token 上限)+ 输出软闸(单窗口叶子段数软上限)。
// 超限子树内按叶子(段)贪心细分,切点吸附 LID 边界、绝不腰斩(段是切片0 最小单位);
// 过小单元由贪心累加自然合并;不跨卷(顶层容器之间绝不合并)。
// token = 确定性近似估算(中文 1 / 其他 0.25),零依赖、跨 provider 稳定;
// 误差由安全系数吸收,数字(硬闸/软闸/并发)留切片0实测回填 [ADR-0009]「何时回头」。
import type { LidNode } from "./generated/LidNode";
import type { Span } from "./generated/Span";

export interface WindowBudget {
  /** 输入硬闸:窗口正文近似 token 上限(= 上下文窗口 × 安全系数 − 指令/目录/输出预留) */
  maxInputTokens: number;
  /** 输出软闸:单窗口叶子段数软上限(防模型在大窗口里过量抽低质边) */
  maxLeavesSoft: number;
}

// 占位默认(留切片0实测回填 ADR-0009)。预构建期后端 = Claude Opus 4.8(ctx 200k);
// 保守取值:窗口正文远小于 ctx,给抽取指令/全局目录/输出留足空间,且小窗口抽取质量更稳。
export const DEFAULT_BUDGET: WindowBudget = { maxInputTokens: 12000, maxLeavesSoft: 80 };

export interface Window {
  id: number;
  /** 覆盖的叶子段 LID(有序,文档序) */
  leafLids: string[];
  /** 本窗口估算 token(覆盖叶子文本之和) */
  tokens: number;
  /** 覆盖的源区间(相邻已合并;通常连续单段) */
  spans: Span[];
  /** 单叶段本身超硬闸、无法再切时为 true —— 诚实暴露不腰斩(守 ADR-0008 分区不变式) */
  overBudget: boolean;
}

/** 确定性近似 token 估算:CJK 表意文字按 1,其余按 0.25(~4 char/token),向上取整。 */
export function estimateTokens(text: string): number {
  let t = 0;
  for (const ch of text) t += /[一-鿿]/.test(ch) ? 1 : 0.25;
  return Math.ceil(t);
}

function makeWindow(
  id: number,
  leafLids: string[],
  tokens: number,
  byLid: Map<string, LidNode>,
  overBudget: boolean,
): Window {
  const sorted = leafLids.map((l) => byLid.get(l)!.span).sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  for (const s of sorted) {
    const last = spans[spans.length - 1];
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      spans.push({ ...s });
    }
  }
  return { id, leafLids: [...leafLids], tokens, spans, overBudget };
}

export function splitWindows(
  nodes: LidNode[],
  source: string,
  budget: WindowBudget = DEFAULT_BUDGET,
): Window[] {
  const byLid = new Map<string, LidNode>();
  for (const n of nodes) byLid.set(n.lid, n);
  const isLeaf = (n: LidNode) => n.children.length === 0;

  const leafTok = new Map<string, number>();
  const tokenOf = (lid: string): number => {
    let v = leafTok.get(lid);
    if (v === undefined) {
      const n = byLid.get(lid)!;
      v = estimateTokens(source.slice(n.span.start, n.span.end));
      leafTok.set(lid, v);
    }
    return v;
  };

  const subtreeLeavesCache = new Map<string, string[]>();
  const subtreeLeaves = (lid: string): string[] => {
    const cached = subtreeLeavesCache.get(lid);
    if (cached) return cached;
    const n = byLid.get(lid)!;
    const v: string[] = isLeaf(n) ? [lid] : n.children.flatMap(subtreeLeaves);
    subtreeLeavesCache.set(lid, v);
    return v;
  };
  const subtreeTokens = (lid: string): number =>
    subtreeLeaves(lid).reduce((s, l) => s + tokenOf(l), 0);

  const windows: Window[] = [];
  let nextId = 0;

  // 贪心累加器:把同父相邻"可合并单元"装进一个窗口(自然合并过小单元),超约束即封口。
  let curLeaves: string[] = [];
  let curTok = 0;
  const closeCur = () => {
    if (curLeaves.length === 0) return;
    windows.push(makeWindow(nextId++, curLeaves, curTok, byLid, false));
    curLeaves = [];
    curTok = 0;
  };
  const addUnit = (leaves: string[], tok: number) => {
    if (
      curLeaves.length > 0 &&
      (curTok + tok > budget.maxInputTokens ||
        curLeaves.length + leaves.length > budget.maxLeavesSoft)
    ) {
      closeCur();
    }
    curLeaves.push(...leaves);
    curTok += tok;
  };

  const emitSubtree = (lid: string) => {
    const leaves = subtreeLeaves(lid);
    const tok = subtreeTokens(lid);
    if (tok <= budget.maxInputTokens && leaves.length <= budget.maxLeavesSoft) {
      addUnit(leaves, tok); // atomic 子树:可与同父兄弟合并
      return;
    }
    // 子树超限 → 子树内细分(吸附 LID 边界)
    const n = byLid.get(lid)!;
    for (const c of n.children) {
      const cn = byLid.get(c)!;
      if (isLeaf(cn)) {
        const ct = tokenOf(c);
        if (ct > budget.maxInputTokens) {
          closeCur(); // 单叶超硬闸:段不可再切,自成一窗、诚实标记,不腰斩
          windows.push(makeWindow(nextId++, [c], ct, byLid, true));
        } else {
          addUnit([c], ct);
        }
      } else {
        const ctok = subtreeTokens(c);
        const cleaves = subtreeLeaves(c);
        if (ctok <= budget.maxInputTokens && cleaves.length <= budget.maxLeavesSoft) {
          addUnit(cleaves, ctok); // atomic 子树:并入贪心
        } else {
          closeCur(); // 大子树自成边界:先封外层累加
          emitSubtree(c); // 递归细分
          closeCur(); // 再封,后续兄弟不并入大子树尾窗
        }
      }
    }
  };

  // 顶层 = path.length === 1;逐顶层处理并封口 ⇒ 顶层(卷)之间绝不合并(不跨卷)。
  for (const t of nodes) {
    if (t.path.length !== 1) continue;
    emitSubtree(t.lid);
    closeCur();
  }
  return windows;
}
