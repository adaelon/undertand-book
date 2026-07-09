// markdown → 忠实块映射 SourceBlock[] `[ADR-0008/0029]`。
// 规则:`#{1,6} ` 行 = heading(span 含 marker,保证无未分类字节);
// fenced code / table / image / formula = 带 assetKind 的 leaf;其余非空行聚成普通 leaf 段。
// span 用 JS 串下标(UTF-16 code unit),与 partition 检查同源、自洽。
import { parse } from "node-html-parser";
import type { AssetKind, SourceBlock, SourceImageRef } from "./segment";

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

function lineLooksLikeTable(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  return (t.match(/\|/g) ?? []).length >= 3;
}

function parseImageLine(line: string): SourceImageRef | null {
  const m = /^!\[([^\]]*)]\(([^)]+)\)$/.exec(line.trim());
  return m ? { alt: m[1], src: m[2].trim() } : null;
}

function parseHtmlImageLine(line: string): SourceImageRef | null {
  if (!/<img[\s>]/i.test(line)) return null;
  const root = parse(line);
  const img = root.querySelector("img");
  const src = img?.getAttribute("src")?.trim();
  if (!img || !src) return null;
  const nonImageText = root.text.trim();
  if (nonImageText) return null;
  return { alt: img.getAttribute("alt") ?? "", src };
}

function standaloneInlineFormula(line: string): boolean {
  return /^\$[^$\n]+\$$/.test(line.trim());
}

function isEscaped(s: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && s[i] === "\\"; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function inlineFormulaRanges(line: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("$$", i) && !isEscaped(line, i)) {
      const end = line.indexOf("$$", i + 2);
      if (end >= 0) {
        ranges.push({ start: i, end: end + 2 });
        i = end + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (line[i] === "$" && line[i + 1] !== "$" && !isEscaped(line, i)) {
      let found = false;
      for (let j = i + 1; j < line.length; j += 1) {
        if (line[j] === "$" && line[j + 1] !== "$" && line[j - 1] !== "$" && !isEscaped(line, j)) {
          if (j > i + 1) ranges.push({ start: i, end: j + 1 });
          i = j + 1;
          found = true;
          break;
        }
      }
      if (!found) i += 1;
      continue;
    }
    i += 1;
  }
  return ranges;
}

export function markdownToBlocks(src: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let para: { start: number; end: number; text: string } | null = null;
  const lines = splitLines(src);

  const flush = () => {
    if (para) blocks.push({ kind: "leaf", text: para.text, span: { start: para.start, end: para.end } });
    para = null;
  };

  const pushAsset = (assetKind: AssetKind, start: number, end: number, image?: SourceImageRef) => {
    blocks.push({ kind: "leaf", assetKind, text: src.slice(start, end), image, span: { start, end } });
  };

  const appendPara = (start: number, end: number) => {
    if (end <= start) return;
    const text = src.slice(start, end);
    if (!text.trim()) return;
    if (!para) para = { start, end, text };
    else {
      para.end = end;
      para.text += "\n" + text;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
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

    const fence = /^(```|~~~)/.exec(lineContent);
    if (fence) {
      flush();
      let end = cs.end;
      for (let j = i + 1; j < lines.length; j += 1) {
        const endSpan = contentSpan(lines[j]);
        end = endSpan?.end ?? lines[j].end;
        if (endSpan && src.slice(endSpan.start, endSpan.end).startsWith(fence[1])) {
          i = j;
          break;
        }
        if (j === lines.length - 1) i = j;
      }
      pushAsset("code", cs.start, end);
      continue;
    }

    if (lineContent.startsWith("$$")) {
      flush();
      let end = cs.end;
      if (!lineContent.endsWith("$$") || lineContent.length <= 2) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const endSpan = contentSpan(lines[j]);
          end = endSpan?.end ?? lines[j].end;
          if (endSpan && src.slice(endSpan.start, endSpan.end).endsWith("$$")) {
            i = j;
            break;
          }
          if (j === lines.length - 1) i = j;
        }
      }
      pushAsset("formula", cs.start, end);
      continue;
    }

    if (lineContent === "$") {
      flush();
      let end = cs.end;
      let closed = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const endSpan = contentSpan(lines[j]);
        end = endSpan?.end ?? lines[j].end;
        if (endSpan && src.slice(endSpan.start, endSpan.end) === "$") {
          i = j;
          closed = true;
          break;
        }
        if (j === lines.length - 1) i = j;
      }
      if (closed) pushAsset("formula", cs.start, end);
      else appendPara(cs.start, cs.end);
      continue;
    }

    if (standaloneInlineFormula(lineContent)) {
      flush();
      pushAsset("formula", cs.start, cs.end);
      continue;
    }

    const image = parseImageLine(lineContent) ?? parseHtmlImageLine(lineContent);
    if (image) {
      flush();
      pushAsset("image", cs.start, cs.end, image);
      continue;
    }

    if (lineLooksLikeTable(lineContent)) {
      flush();
      let end = cs.end;
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextSpan = contentSpan(lines[j]);
        if (!nextSpan) break;
        const nextContent = src.slice(nextSpan.start, nextSpan.end);
        if (!lineLooksLikeTable(nextContent)) break;
        end = nextSpan.end;
        i = j;
      }
      pushAsset("table", cs.start, end);
      continue;
    }

    const inlineFormulas = inlineFormulaRanges(lineContent);
    if (inlineFormulas.length) {
      let cursor = 0;
      for (const range of inlineFormulas) {
        appendPara(cs.start + cursor, cs.start + range.start);
        flush();
        pushAsset("formula", cs.start + range.start, cs.start + range.end);
        cursor = range.end;
      }
      appendPara(cs.start + cursor, cs.end);
    } else {
      appendPara(cs.start, cs.end);
    }
  }
  flush();
  return blocks;
}
