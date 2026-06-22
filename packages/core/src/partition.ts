// 分区不变式自检闸(确定性,LLM 零介入)`[ADR-0008]`。
// 断言:① LID 全局唯一 ② 同级数值递增 ③ 父 span ⊇ 子并集
//       ④ 全部叶子 span 构成对原文内容的一次划分(全覆盖 + 无重叠)
//       ⑤ 非内容字节(叶子间空白)显式归类,不静默丢(非空白 gap = 违例)
// 切段覆盖率 = 入叶子内容(非空白)字节 / 全文非空白字节,目标 100%。
import type { LidNode } from "./generated/LidNode";

export interface PartitionViolation {
  code:
    | "LID_DUP"
    | "DANGLING_CHILD"
    | "SIBLING_ORDER"
    | "PARENT_NOT_SUPERSET"
    | "LEAF_OVERLAP"
    | "UNCLASSIFIED_CONTENT";
  detail: string;
}

export interface PartitionReport {
  ok: boolean;
  violations: PartitionViolation[];
  coverage: number; // 切段覆盖率 [0,1]
}

const nonWs = (s: string) => s.replace(/\s/g, "").length;

export function checkPartitionInvariant(nodes: LidNode[], source: string): PartitionReport {
  const violations: PartitionViolation[] = [];
  const byLid = new Map(nodes.map((n) => [n.lid, n]));

  // ① LID 唯一
  if (byLid.size !== nodes.length) violations.push({ code: "LID_DUP", detail: "重复 lid" });

  // ②③ 同级递增 + 父 ⊇ 子
  for (const n of nodes) {
    let prevSeg = -Infinity;
    let uStart = Infinity;
    let uEnd = -Infinity;
    for (const c of n.children) {
      const cn = byLid.get(c);
      if (!cn) {
        violations.push({ code: "DANGLING_CHILD", detail: `${n.lid} -> ${c}` });
        continue;
      }
      const seg = cn.path[cn.path.length - 1];
      if (seg <= prevSeg) violations.push({ code: "SIBLING_ORDER", detail: `${n.lid}: ${seg} <= ${prevSeg}` });
      prevSeg = seg;
      uStart = Math.min(uStart, cn.span.start);
      uEnd = Math.max(uEnd, cn.span.end);
    }
    if (n.children.length && (n.span.start > uStart || n.span.end < uEnd)) {
      violations.push({ code: "PARENT_NOT_SUPERSET", detail: n.lid });
    }
  }

  // ④⑤ 叶子划分 + 覆盖率
  const leaves = nodes.filter((n) => n.children.length === 0).sort((a, b) => a.span.start - b.span.start);
  let cursor = 0;
  for (const lf of leaves) {
    if (lf.span.start < cursor) violations.push({ code: "LEAF_OVERLAP", detail: lf.lid });
    const gap = source.slice(cursor, lf.span.start);
    if (gap.trim().length > 0)
      violations.push({ code: "UNCLASSIFIED_CONTENT", detail: `${lf.lid} 前 gap: ${JSON.stringify(gap.slice(0, 24))}` });
    cursor = Math.max(cursor, lf.span.end);
  }
  const tail = source.slice(cursor);
  if (tail.trim().length > 0) violations.push({ code: "UNCLASSIFIED_CONTENT", detail: "尾部残留内容" });

  const total = nonWs(source);
  const covered = leaves.reduce((s, lf) => s + nonWs(source.slice(lf.span.start, lf.span.end)), 0);
  const coverage = total === 0 ? 1 : covered / total;

  return { ok: violations.length === 0, violations, coverage };
}
