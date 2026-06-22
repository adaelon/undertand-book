// markdown → 忠实块映射 SourceBlock[](切片0 起步;epub 适配器另写)`[ADR-0008]`。
// 规则:`#{1,6} ` 行 = heading(span 含 marker,保证无未分类字节);空行分段;其余非空行聚成 leaf 段。
// span 用 JS 串下标(UTF-16 code unit),与 partition 检查同源、自洽。
import type { SourceBlock } from "./segment";

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(src: string): Line[] {
  const lines: Line[] = [];
  let off = 0;
  // 保留换行符,逐行带偏移
  for (const raw of src.split(/(?<=\n)/)) {
    lines.push({ text: raw, start: off, end: off + raw.length });
    off += raw.length;
  }
  return lines;
}

/** 该行去首尾空白后的内容区间 [contentStart, contentEnd)(空行返回 null) */
function contentSpan(ln: Line): { start: number; end: number } | null {
  const leading = ln.text.length - ln.text.replace(/^\s+/, "").length;
  const trailing = ln.text.length - ln.text.replace(/\s+$/, "").length;
  const start = ln.start + leading;
  const end = ln.end - trailing;
  return end > start ? { start, end } : null;
}

export function markdownToBlocks(src: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let para: { start: number; end: number; text: string } | null = null;

  const flush = () => {
    if (para) blocks.push({ kind: "leaf", text: para.text, span: { start: para.start, end: para.end } });
    para = null;
  };

  for (const ln of splitLines(src)) {
    const cs = contentSpan(ln);
    if (!cs) {
      flush();
      continue;
    } // 空行
    const lineContent = src.slice(cs.start, cs.end);
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(lineContent);
    if (h) {
      flush();
      // 标题 span 含 marker(整行内容区),text 取去 marker 的标题
      blocks.push({ kind: "heading", level: h[1].length, text: h[2], span: cs });
      continue;
    }
    if (!para) para = { start: cs.start, end: cs.end, text: lineContent };
    else {
      para.end = cs.end;
      para.text += "\n" + lineContent;
    }
  }
  flush();
  return blocks;
}
