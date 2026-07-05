// epub -> faithful SourceBlock[] + normalized source [ADR-0008/0029].
// Parse zip(fflate) -> container.xml -> content.opf -> spine xhtml.
// Block extraction preserves asset leaves for SA3 while segment() keeps current paragraph behavior until SA4.
import { unzipSync, strFromU8 } from "fflate";
import { parse, HTMLElement } from "node-html-parser";
import { posix as pathPosix } from "node:path";
import type { AssetKind, SourceBlock, SourceImageRef } from "./segment";

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LEAF = new Set(["p", "li", "blockquote"]);
const SKIP = new Set(["script", "style", "head", "title"]);

interface RawBlock {
  kind: "heading" | "leaf";
  level?: number;
  assetKind?: AssetKind;
  text: string;
  image?: SourceImageRef;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const rawText = (e: HTMLElement): string => e.text.replace(/^\s+|\s+$/g, "");

function resolveEpubImagePath(xhtmlPath: string | undefined, src: string): string | undefined {
  if (!xhtmlPath || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("#")) return undefined;
  const clean = src.split("#")[0].split("?")[0];
  if (!clean) return undefined;
  const base = xhtmlPath.includes("/") ? xhtmlPath.slice(0, xhtmlPath.lastIndexOf("/") + 1) : "";
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the original path if EPUB used invalid percent escaping.
  }
  return pathPosix.normalize(base + decoded).replace(/^\/+/, "");
}

function imageMarkdown(e: HTMLElement, xhtmlPath?: string): { text: string; image: SourceImageRef } | null {
  const src = e.getAttribute("src")?.trim();
  if (!src) return null;
  const alt = e.getAttribute("alt") ?? "";
  return {
    text: `![${alt}](${src})`,
    image: { alt, src, epubPath: resolveEpubImagePath(xhtmlPath, src) },
  };
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

function leafBlocks(e: HTMLElement, xhtmlPath?: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let text = "";
  const flushText = () => {
    const t = norm(text);
    if (t) blocks.push({ kind: "leaf", text: t });
    text = "";
  };

  for (const child of e.childNodes) {
    if (child.nodeType !== 1) {
      text += child.text;
      continue;
    }
    const el = child as HTMLElement;
    const tag = (el.rawTagName ?? "").toLowerCase();
    if (SKIP.has(tag)) continue;
    if (tag === "math") {
      flushText();
      const formula = mathSource(el);
      if (formula) blocks.push({ kind: "leaf", assetKind: "formula", text: formula });
    } else if (tag === "img") {
      flushText();
      const image = imageMarkdown(el, xhtmlPath);
      if (image) blocks.push({ kind: "leaf", assetKind: "image", text: image.text, image: image.image });
    } else if (tag === "br") {
      text += "\n";
    } else {
      text += el.text;
    }
  }
  flushText();
  return blocks;
}

function walk(el: HTMLElement, acc: RawBlock[], xhtmlPath?: string): void {
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
      const image = imageMarkdown(e, xhtmlPath);
      if (image) acc.push({ kind: "leaf", assetKind: "image", text: image.text, image: image.image });
    } else if (tag === "math") {
      const text = mathSource(e);
      if (text) acc.push({ kind: "leaf", assetKind: "formula", text });
    } else if (LEAF.has(tag)) {
      acc.push(...leafBlocks(e, xhtmlPath));
    } else {
      walk(e, acc, xhtmlPath);
    }
  }
}

export function xhtmlToBlocks(html: string, xhtmlPath?: string): RawBlock[] {
  const root = parse(html);
  const body = root.querySelector("body") ?? root;
  const acc: RawBlock[] = [];
  walk(body, acc, xhtmlPath);
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
    raw.push(...xhtmlToBlocks(strFromU8(data), path));
  }

  let source = "";
  const blocks: SourceBlock[] = [];
  for (const rb of raw) {
    const start = source.length;
    source += rb.text;
    blocks.push({ kind: rb.kind, level: rb.level, assetKind: rb.assetKind, text: rb.text, image: rb.image, span: { start, end: source.length } });
    source += "\n\n";
  }
  return { source, blocks };
}
