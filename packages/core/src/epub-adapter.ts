// epub -> faithful SourceBlock[] + normalized source [ADR-0008/0029].
// Parse zip(fflate) -> container.xml -> content.opf -> spine xhtml.
// Block extraction preserves asset leaves for SA3 while segment() keeps current paragraph behavior until SA4.
import { unzipSync, strFromU8 } from "fflate";
import { parse, HTMLElement } from "node-html-parser";
import type { AssetKind, SourceBlock } from "./segment";

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LEAF = new Set(["p", "li", "blockquote"]);
const SKIP = new Set(["script", "style", "head", "title"]);

interface RawBlock {
  kind: "heading" | "leaf";
  level?: number;
  assetKind?: AssetKind;
  text: string;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const rawText = (e: HTMLElement): string => e.text.replace(/^\s+|\s+$/g, "");

function imageMarkdown(e: HTMLElement): string | null {
  const src = e.getAttribute("src")?.trim();
  if (!src) return null;
  const alt = e.getAttribute("alt") ?? "";
  return `![${alt}](${src})`;
}

function tableText(e: HTMLElement): string {
  const rows: string[] = [];
  for (const row of e.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("th,td").map((cell) => norm(cell.text));
    if (cells.length) rows.push(`| ${cells.join(" | ")} |`);
  }
  return rows.join("\n");
}

function mathSource(e: HTMLElement): string {
  return e.toString().trim();
}

function walk(el: HTMLElement, acc: RawBlock[]): void {
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const e = child as HTMLElement;
    const tag = (e.rawTagName ?? "").toLowerCase();
    if (!tag || SKIP.has(tag)) continue;

    if (HEADING.has(tag)) {
      const text = norm(e.text);
      if (text) acc.push({ kind: "heading", level: Number(tag[1]), text });
    } else if (tag === "pre") {
      const text = rawText(e);
      if (text) acc.push({ kind: "leaf", assetKind: "code", text });
    } else if (tag === "table") {
      const text = tableText(e);
      if (text) acc.push({ kind: "leaf", assetKind: "table", text });
    } else if (tag === "img") {
      const text = imageMarkdown(e);
      if (text) acc.push({ kind: "leaf", assetKind: "image", text });
    } else if (tag === "math") {
      const text = mathSource(e);
      if (text) acc.push({ kind: "leaf", assetKind: "formula", text });
    } else if (LEAF.has(tag)) {
      const text = norm(e.text);
      if (text) acc.push({ kind: "leaf", text });
    } else {
      walk(e, acc);
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

  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }

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
    blocks.push({ kind: rb.kind, level: rb.level, assetKind: rb.assetKind, text: rb.text, span: { start, end: source.length } });
    source += "\n\n";
  }
  return { source, blocks };
}
