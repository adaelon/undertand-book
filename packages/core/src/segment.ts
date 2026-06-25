// 段级 LID 切分器(Model A `[ADR-0008]`)。
// 输入 = 忠实块映射的源块序列(SourceBlock[]);输出 = LidNode[](物化路径树,深度可变)。
// Model A:章/节 = 纯结构容器(span=子并集、不独占内容);标题文字 = 容器的首个叶子段。
// ⇒ 叶子(标题段 + 正文段)构成对全文的划分;容器不进叶子覆盖。
import type { LidNode } from "./generated/LidNode";
import type { NodeKind } from "./generated/NodeKind";

export type AssetKind = Extract<NodeKind, "code" | "table" | "image" | "formula">;

export interface Span {
  start: number;
  end: number;
}

/** 忠实块映射的一个源块。heading 定义层级;leaf = 段(段落/引用块/代码块/列表项/asset)。 */
export interface SourceBlock {
  kind: "heading" | "leaf";
  /** heading 层级:1=章,≥2=节;leaf 时 undefined */
  level?: number;
  /** code/table/image/formula asset 叶子类型。SA4 前 segment 暂不消费该字段。 */
  assetKind?: AssetKind;
  /** 规范化后的展示文本(标题已去 marker) */
  text: string;
  /** 源区间(含 marker,保证无未分类非内容字节);切片0 用 JS 串下标(UTF-16),字节精确化留后 */
  span: Span;
}

function headingKind(level: number): NodeKind {
  return level <= 1 ? "chapter" : "section";
}

interface Frame {
  lid: string;
  path: number[];
  level: number;
}

export function segment(blocks: SourceBlock[]): LidNode[] {
  const out: LidNode[] = [];
  const byLid = new Map<string, LidNode>();
  const childCount = new Map<string, number>(); // parentLid -> count;"" = 根
  const stack: Frame[] = [];
  let rootCount = 0;

  const make = (parentLid: string, parentPath: number[], kind: NodeKind, span: Span): LidNode => {
    const idx =
      parentLid === ""
        ? ++rootCount
        : (childCount.set(parentLid, (childCount.get(parentLid) ?? 0) + 1), childCount.get(parentLid)!);
    const path = [...parentPath, idx];
    const lid = path.join(".");
    const node: LidNode = { lid, path, kind, span: { ...span }, children: [] };
    out.push(node);
    byLid.set(lid, node);
    if (parentLid !== "") byLid.get(parentLid)!.children.push(lid);
    return node;
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      const level = b.level ?? 1;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const parentLid = parent ? parent.lid : "";
      const parentPath = parent ? parent.path : [];
      // 结构容器(初始 span = 标题 span,post-pass 扩成子并集)
      const container = make(parentLid, parentPath, headingKind(level), b.span);
      stack.push({ lid: container.lid, path: container.path, level });
      // 标题 = 容器首个叶子段
      make(container.lid, container.path, "paragraph", b.span);
    } else {
      const parent = stack[stack.length - 1];
      const parentLid = parent ? parent.lid : "";
      const parentPath = parent ? parent.path : [];
      make(parentLid, parentPath, "paragraph", b.span);
    }
  }

  // post-pass:容器 span = 后代并集(保证 父 ⊇ 子)。深度大者先算。
  const deepFirst = [...out].sort((a, b) => b.path.length - a.path.length);
  for (const n of deepFirst) {
    if (n.children.length) {
      let { start, end } = n.span;
      for (const c of n.children) {
        const cn = byLid.get(c)!;
        if (cn.span.start < start) start = cn.span.start;
        if (cn.span.end > end) end = cn.span.end;
      }
      n.span = { start, end };
    }
  }
  return out;
}
