import { HTMLElement, NodeType, parse } from "node-html-parser";

export interface PaperMarkdownCanonicalizationRepair {
  kind: "presentation_html_unwrap";
  span: { start: number; end: number };
  original: string;
  replacement: string;
}

export interface PaperMarkdownCanonicalizationResult {
  markdown: string;
  repairs: PaperMarkdownCanonicalizationRepair[];
}

function whitespaceNode(node: { nodeType: NodeType; rawText: string }): boolean {
  return node.nodeType === NodeType.TEXT_NODE && !node.rawText.trim();
}

function centeredPresentationDiv(node: HTMLElement): boolean {
  if (node.tagName.toLowerCase() !== "div") return false;
  const attributes = node.attributes;
  const keys = Object.keys(attributes).map((key) => key.toLowerCase());
  if (!keys.length || keys.some((key) => key !== "style" && key !== "align")) return false;

  const style = attributes.style?.replace(/\s+/gu, "").replace(/;+$/u, "").toLowerCase();
  const align = attributes.align?.trim().toLowerCase();
  if (style !== undefined && style !== "text-align:center") return false;
  if (align !== undefined && align !== "center") return false;
  return style === "text-align:center" || align === "center";
}

function unwrapPresentationTextLine(line: string): string | null {
  const contentMatch = /^( {0,3})(\S(?:[\s\S]*?\S)?)( *)$/u.exec(line);
  if (!contentMatch) return null;
  const [, indentation, content] = contentMatch;
  if (!/^<div[\s>]/iu.test(content) || !/<\/div>$/iu.test(content)) return null;

  const root = parse(content);
  const rootNodes = root.childNodes.filter((node) => !whitespaceNode(node));
  if (rootNodes.length !== 1 || !(rootNodes[0] instanceof HTMLElement)) return null;

  let current = rootNodes[0];
  while (centeredPresentationDiv(current)) {
    const children = current.childNodes.filter((node) => !whitespaceNode(node));
    if (children.length === 1 && children[0] instanceof HTMLElement) {
      if (!centeredPresentationDiv(children[0])) return null;
      current = children[0];
      continue;
    }
    if (children.some((node) => node.nodeType !== NodeType.TEXT_NODE)) return null;
    const replacement = current.innerHTML.trim();
    return replacement ? `${indentation}${replacement}` : null;
  }
  return null;
}

/** Removes only full-line, presentation-only div chains around text. */
export function canonicalizePaperMarkdown(source: string): PaperMarkdownCanonicalizationResult {
  const repairs: PaperMarkdownCanonicalizationRepair[] = [];
  let markdown = "";
  let cursor = 0;

  for (const match of source.matchAll(/\r\n|\n|\r/gu)) {
    const end = match.index;
    const original = source.slice(cursor, end);
    const replacement = unwrapPresentationTextLine(original);
    if (replacement !== null && replacement !== original) {
      repairs.push({
        kind: "presentation_html_unwrap",
        span: { start: cursor, end },
        original,
        replacement,
      });
      markdown += replacement;
    } else {
      markdown += original;
    }
    markdown += match[0];
    cursor = end + match[0].length;
  }

  const original = source.slice(cursor);
  const replacement = unwrapPresentationTextLine(original);
  if (replacement !== null && replacement !== original) {
    repairs.push({
      kind: "presentation_html_unwrap",
      span: { start: cursor, end: source.length },
      original,
      replacement,
    });
    markdown += replacement;
  } else {
    markdown += original;
  }

  return { markdown, repairs };
}
