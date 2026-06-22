// epub → 忠实块映射 SourceBlock[] + 规范化 source `[ADR-0008]`。
// 解 zip(fflate)→ 读 container.xml 定位 content.opf → 按 spine 顺序解析各 xhtml
// (node-html-parser),块级标记忠实成块:h1-6=heading(带 level)、p/li/blockquote/pre=leaf。
// 嵌套块(blockquote 内 p、ul 内 li)只取外层一块,不重复下钻。
// source = 各块文本按顺序拼接(块间 "\n\n" 分隔=空白 gap),block.span 索引进 source。
import { unzipSync, strFromU8 } from "fflate";
import { parse, HTMLElement } from "node-html-parser";
import type { SourceBlock } from "./segment";

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LEAF = new Set(["p", "li", "blockquote", "pre"]);
const SKIP = new Set(["script", "style", "head", "title"]);

interface RawBlock {
  kind: "heading" | "leaf";
  level?: number;
  text: string;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function walk(el: HTMLElement, acc: RawBlock[]): void {
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue; // 仅元素节点
    const e = child as HTMLElement;
    const tag = (e.rawTagName ?? "").toLowerCase();
    if (!tag || SKIP.has(tag)) continue;
    if (HEADING.has(tag)) {
      const text = norm(e.text);
      if (text) acc.push({ kind: "heading", level: Number(tag[1]), text });
      // 不下钻
    } else if (LEAF.has(tag)) {
      const text = norm(e.text);
      if (text) acc.push({ kind: "leaf", text });
      // 不下钻(嵌套块只算外层一块)
    } else {
      walk(e, acc); // 容器(div/ul/section/body…)继续下钻
    }
  }
}

export function xhtmlToBlocks(html: string): RawBlock[] {
  const root = parse(html);
  const body = root.querySelector("body") ?? root;
  const acc: RawBlock[] = [];
  walk(body, acc);
  return acc;
}

export interface EpubSource {
  source: string;
  blocks: SourceBlock[];
}

export function epubToSource(zip: Uint8Array): EpubSource {
  const files = unzipSync(zip);
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error("epub: META-INF/container.xml 缺失");
  const opfPath = /full-path="([^"]+)"/.exec(strFromU8(container))?.[1];
  if (!opfPath || !files[opfPath]) throw new Error("epub: content.opf 未找到");
  const opf = strFromU8(files[opfPath]);
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  // manifest: id -> href(属性顺序无关)
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }
  // spine 顺序
  const spine: string[] = [];
  for (const m of opf.matchAll(/<itemref\s[^>]*\bidref="([^"]+)"/g)) spine.push(m[1]);

  const raw: RawBlock[] = [];
  for (const idref of spine) {
    const href = manifest.get(idref);
    if (!href) continue;
    const path = opfDir + decodeURIComponent(href);
    const data = files[path];
    if (!data) continue;
    raw.push(...xhtmlToBlocks(strFromU8(data)));
  }

  let source = "";
  const blocks: SourceBlock[] = [];
  for (const rb of raw) {
    const start = source.length;
    source += rb.text;
    blocks.push({ kind: rb.kind, level: rb.level, text: rb.text, span: { start, end: source.length } });
    source += "\n\n"; // 块间分隔(空白 gap)
  }
  return { source, blocks };
}
