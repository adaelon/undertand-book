// Markdown -> faithful SourceBlock[] mapping `[ADR-0008/0029]`.
// CommonMark/GFM/math parsing comes from micromark/mdast; all spans are parser
// offsets in JavaScript UTF-16 units, which is the source/LID coordinate space.
import type { Nodes, Parents, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { parse } from "node-html-parser";
import type { AssetKind, SourceBlock, SourceImageRef, Span } from "./segment";

export interface MarkdownSourceReviewProposal {
  kind: "malformed_inline_math" | "unfenced_code";
  source_span: Span;
  reason: string;
}

export interface MarkdownSourceBlockParseResult {
  blocks: SourceBlock[];
  review_proposals: MarkdownSourceReviewProposal[];
  alignment_contexts: MarkdownAlignmentContext[];
}

export interface MarkdownAlignmentContext {
  kind: "paragraph" | "list_item";
  source_span: Span;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const raw of source.split(/(?<=\n)/u)) {
    lines.push({ text: raw, start, end: start + raw.length });
    start += raw.length;
  }
  return lines;
}

function nodeSpan(node: Nodes): Span {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end < start) {
    throw new Error(`Markdown parser node lacks a valid source position: ${node.type}`);
  }
  return { start, end };
}

function blockSpan(node: RootContent, source: string): Span {
  const span = nodeSpan(node);
  if (node.type !== "code" || node.lang) return span;
  const lineStart = source.lastIndexOf("\n", Math.max(0, span.start - 1)) + 1;
  return source.slice(lineStart, span.start).trim().length === 0 ? { ...span, start: lineStart } : span;
}

function sourceBlock(
  source: string,
  span: Span,
  options: { kind?: "heading"; level?: number; text?: string; assetKind?: AssetKind; image?: SourceImageRef } = {},
): SourceBlock {
  return {
    kind: options.kind ?? "leaf",
    ...(options.level ? { level: options.level } : {}),
    ...(options.assetKind ? { assetKind: options.assetKind } : {}),
    ...(options.image ? { image: options.image } : {}),
    text: options.text ?? source.slice(span.start, span.end),
    span,
  };
}

function parseImageSource(raw: string): SourceImageRef | null {
  const markdown = /^!\[([^\]]*)\]\(([^)]+)\)$/u.exec(raw.trim());
  if (markdown) return { alt: markdown[1], src: markdown[2].trim() };
  if (!/<img[\s>]/iu.test(raw)) return null;
  const root = parse(raw);
  const image = root.querySelector("img");
  const src = image?.getAttribute("src")?.trim();
  if (!image || !src || root.text.trim()) return null;
  return { alt: image.getAttribute("alt") ?? "", src };
}

function isSingleRawHtmlTable(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^<table(?:\s|>)/iu.test(trimmed) || !/<\/table>$/iu.test(trimmed)) return false;
  const root = parse(trimmed);
  const tables = root.querySelectorAll("table");
  return tables.length === 1 && tables[0].outerHTML.trim() === trimmed;
}

function plainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) return (node as Parents).children.map((child) => plainText(child)).join("");
  return "";
}

function collectInlineMath(node: Nodes, result: Nodes[] = []): Nodes[] {
  if (node.type === "inlineMath") result.push(node);
  if ("children" in node) {
    for (const child of (node as Parents).children) collectInlineMath(child, result);
  }
  return result;
}

function formulaMarkupIsBalanced(raw: string): boolean {
  const open = /^(\${1,2})/u.exec(raw)?.[1];
  if (!open || !raw.endsWith(open) || raw.length <= open.length * 2) return false;
  const content = raw.slice(open.length, -open.length);
  let braceDepth = 0;
  for (let index = 0; index < content.length; index += 1) {
    const escaped = index > 0 && content[index - 1] === "\\";
    if (!escaped && content[index] === "$") return false;
    if (!escaped && content[index] === "{") braceDepth += 1;
    if (!escaped && content[index] === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return false;
    }
  }
  return braceDepth === 0;
}

function projectInlineMathContainer(
  node: RootContent,
  source: string,
  proposals: MarkdownSourceReviewProposal[],
): SourceBlock[] {
  const span = nodeSpan(node);
  const formulas = collectInlineMath(node)
    .map((formula) => nodeSpan(formula))
    .sort((left, right) => left.start - right.start);
  if (!formulas.length) return [sourceBlock(source, span)];
  if (formulas.some((formula) => !formulaMarkupIsBalanced(source.slice(formula.start, formula.end)))) {
    proposals.push({
      kind: "malformed_inline_math",
      source_span: span,
      reason: "parser math nodes contain unbalanced braces or nested dollar delimiters",
    });
    return [sourceBlock(source, span)];
  }

  const blocks: SourceBlock[] = [];
  let cursor = span.start;
  for (const formula of formulas) {
    if (formula.start < cursor || formula.end > span.end) {
      throw new Error(`Markdown parser produced overlapping inline math at ${formula.start}:${formula.end}`);
    }
    if (source.slice(cursor, formula.start).trim()) {
      blocks.push(sourceBlock(source, { start: cursor, end: formula.start }));
    }
    blocks.push(sourceBlock(source, formula, { assetKind: "formula" }));
    cursor = formula.end;
  }
  if (source.slice(cursor, span.end).trim()) blocks.push(sourceBlock(source, { start: cursor, end: span.end }));
  return blocks;
}

function projectRootNode(
  node: RootContent,
  source: string,
  proposals: MarkdownSourceReviewProposal[],
): SourceBlock[] {
  const span = blockSpan(node, source);
  if (node.type === "heading") {
    return [sourceBlock(source, span, { kind: "heading", level: node.depth, text: plainText(node) })];
  }
  if (node.type === "code") return [sourceBlock(source, span, { assetKind: "code" })];
  if (node.type === "table") return [sourceBlock(source, span, { assetKind: "table" })];
  if (node.type === "math") {
    if (!formulaMarkupIsBalanced(source.slice(span.start, span.end))) {
      proposals.push({
        kind: "malformed_inline_math",
        source_span: span,
        reason: "display math contains unbalanced braces or nested dollar delimiters",
      });
      return [sourceBlock(source, span)];
    }
    return [sourceBlock(source, span, { assetKind: "formula" })];
  }
  if (node.type === "list") {
    return node.children.flatMap((item) => projectInlineMathContainer(item, source, proposals));
  }
  if (node.type === "paragraph") {
    const raw = source.slice(span.start, span.end);
    const image = parseImageSource(raw);
    if (image) return [sourceBlock(source, span, { assetKind: "image", image })];
    return projectInlineMathContainer(node, source, proposals);
  }
  if (node.type === "image") {
    return [sourceBlock(source, span, { assetKind: "image", image: { alt: node.alt ?? "", src: node.url } })];
  }
  if (node.type === "html") {
    const raw = source.slice(span.start, span.end);
    if (isSingleRawHtmlTable(raw)) return [sourceBlock(source, span, { assetKind: "table" })];
    const image = parseImageSource(raw);
    if (image) return [sourceBlock(source, span, { assetKind: "image", image })];
  }
  return [sourceBlock(source, span)];
}

function codeLikeLine(line: string): boolean {
  const value = line.replace(/[\r\n]+$/u, "");
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^(?:from|import)\s+[A-Za-z_]/u.test(trimmed)
    || /^(?:async\s+)?(?:def|class)\s+[A-Za-z_]/u.test(trimmed)
    || /^(?:for|while|if|elif|else|return|yield|with|try|except|finally)\b/u.test(trimmed)
    || /^[A-Za-z_][A-Za-z0-9_.\[\]]*\s*=\s*\S/u.test(trimmed)
    || /^[A-Za-z_][A-Za-z0-9_.]*\([^)]*\)\s*$/u.test(trimmed)
    || /^#\s*(?:seed|project|compute|train|plot|load|save|initialize|\[)/iu.test(trimmed)
    || /^\s{2,}\S/u.test(value);
}

function unfencedCodeProposals(
  source: string,
  parsedNodes: RootContent[],
): MarkdownSourceReviewProposal[] {
  const codeSpans = parsedNodes.filter((node) => node.type === "code").map((node) => blockSpan(node, source));
  const candidates = splitLines(source)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !codeSpans.some((span) => line.start >= span.start && line.start < span.end))
    .filter(({ line }) => codeLikeLine(line.text));
  const groups: typeof candidates[] = [];
  for (const candidate of candidates) {
    const current = groups.at(-1);
    if (current && candidate.index - current.at(-1)!.index <= 2) current.push(candidate);
    else groups.push([candidate]);
  }
  return groups.filter((group) => group.length >= 3).map((group) => ({
    kind: "unfenced_code" as const,
    source_span: { start: group[0].line.start, end: group.at(-1)!.line.end },
    reason: "three or more nearby code-like lines occur outside a fenced or indented code node",
  }));
}

export function parseMarkdownSourceBlocks(source: string): MarkdownSourceBlockParseResult {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const reviewProposals: MarkdownSourceReviewProposal[] = [];
  const blocks = tree.children
    .flatMap((node) => projectRootNode(node, source, reviewProposals))
    .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index].span.start < blocks[index - 1].span.end) {
      throw new Error(`Markdown parser block spans overlap at ${blocks[index].span.start}`);
    }
  }
  reviewProposals.push(...unfencedCodeProposals(source, tree.children));
  reviewProposals.sort((left, right) => left.source_span.start - right.source_span.start
    || left.source_span.end - right.source_span.end
    || left.kind.localeCompare(right.kind));
  const alignmentContexts = tree.children.flatMap((node): MarkdownAlignmentContext[] => {
    if (node.type === "paragraph") {
      const span = nodeSpan(node);
      return parseImageSource(source.slice(span.start, span.end))
        ? []
        : [{ kind: "paragraph", source_span: span }];
    }
    if (node.type === "list") {
      return node.children.map((item) => ({ kind: "list_item", source_span: nodeSpan(item) }));
    }
    return [];
  });
  return { blocks, review_proposals: reviewProposals, alignment_contexts: alignmentContexts };
}

export function markdownToBlocks(source: string): SourceBlock[] {
  return parseMarkdownSourceBlocks(source).blocks;
}
