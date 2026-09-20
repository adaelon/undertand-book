export interface SourceTextRange {
  start: number;
  end: number;
}

type EditKind = "equal" | "delete" | "insert";

interface Edit {
  kind: EditKind;
}

interface AlignmentSpan {
  sourceStart: number;
  sourceEnd: number;
  semanticStart: number;
  semanticEnd: number;
  kind: "equal" | "replacement" | "source-only" | "semantic-only";
}

interface DomProjection {
  text: string;
  pieces: DomPiece[];
  offsetForPoint(container: Node, offset: number, edge: "start" | "end"): number;
}

interface DomPiece {
  kind: "text" | "atomic" | "break";
  node: Text | Element;
  start: number;
  end: number;
  domStart?: number;
}

export interface MarkedSourceRange extends SourceTextRange {
  className: string;
}

function shortestEditScript(source: string, semantic: string): Edit[] {
  const sourceLength = source.length;
  const semanticLength = semantic.length;
  const maxDistance = sourceLength + semanticLength;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const fromInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let sourceOffset = diagonal === -distance || (diagonal !== distance && fromDelete < fromInsert)
        ? fromInsert
        : fromDelete + 1;
      if (!Number.isFinite(sourceOffset)) sourceOffset = 0;
      let semanticOffset = sourceOffset - diagonal;
      while (
        sourceOffset < sourceLength
        && semanticOffset < semanticLength
        && source[sourceOffset] === semantic[semanticOffset]
      ) {
        sourceOffset += 1;
        semanticOffset += 1;
      }
      frontier.set(diagonal, sourceOffset);
      if (sourceOffset >= sourceLength && semanticOffset >= semanticLength) {
        return backtrackEdits(trace, distance, sourceLength, semanticLength);
      }
    }
  }
  return [];
}

function backtrackEdits(
  trace: Array<Map<number, number>>,
  distance: number,
  sourceLength: number,
  semanticLength: number,
): Edit[] {
  const reversed: Edit[] = [];
  let sourceOffset = sourceLength;
  let semanticOffset = semanticLength;

  for (let currentDistance = distance; currentDistance > 0; currentDistance -= 1) {
    const frontier = trace[currentDistance];
    const diagonal = sourceOffset - semanticOffset;
    const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const fromInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -currentDistance
      || (diagonal !== currentDistance && fromDelete < fromInsert)
      ? diagonal + 1
      : diagonal - 1;
    const previousSourceOffset = frontier.get(previousDiagonal) ?? 0;
    const previousSemanticOffset = previousSourceOffset - previousDiagonal;

    while (sourceOffset > previousSourceOffset && semanticOffset > previousSemanticOffset) {
      reversed.push({ kind: "equal" });
      sourceOffset -= 1;
      semanticOffset -= 1;
    }
    if (sourceOffset === previousSourceOffset) {
      reversed.push({ kind: "insert" });
      semanticOffset -= 1;
    }
    else {
      reversed.push({ kind: "delete" });
      sourceOffset -= 1;
    }
  }
  while (sourceOffset > 0 && semanticOffset > 0) {
    reversed.push({ kind: "equal" });
    sourceOffset -= 1;
    semanticOffset -= 1;
  }
  while (sourceOffset > 0) {
    reversed.push({ kind: "delete" });
    sourceOffset -= 1;
  }
  while (semanticOffset > 0) {
    reversed.push({ kind: "insert" });
    semanticOffset -= 1;
  }
  return reversed.reverse();
}

function alignmentSpans(source: string, semantic: string): AlignmentSpan[] {
  const edits = shortestEditScript(source, semantic);
  const spans: AlignmentSpan[] = [];
  let sourceOffset = 0;
  let semanticOffset = 0;
  let index = 0;

  while (index < edits.length) {
    if (edits[index].kind === "equal") {
      const sourceStart = sourceOffset;
      const semanticStart = semanticOffset;
      while (index < edits.length && edits[index].kind === "equal") {
        sourceOffset += 1;
        semanticOffset += 1;
        index += 1;
      }
      spans.push({
        sourceStart,
        sourceEnd: sourceOffset,
        semanticStart,
        semanticEnd: semanticOffset,
        kind: "equal",
      });
      continue;
    }

    const sourceStart = sourceOffset;
    const semanticStart = semanticOffset;
    while (index < edits.length && edits[index].kind !== "equal") {
      if (edits[index].kind === "delete") sourceOffset += 1;
      else semanticOffset += 1;
      index += 1;
    }
    const hasSource = sourceOffset > sourceStart;
    const hasSemantic = semanticOffset > semanticStart;
    spans.push({
      sourceStart,
      sourceEnd: sourceOffset,
      semanticStart,
      semanticEnd: semanticOffset,
      kind: hasSource && hasSemantic ? "replacement" : hasSource ? "source-only" : "semantic-only",
    });
  }
  return spans;
}

function katexMarkdown(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  const latex = annotation?.textContent ?? "";
  if (!latex) return "";
  return element.closest(".katex-display") ? `$$${latex}$$` : `$${latex}$`;
}

function projectDom(root: Node): DomProjection {
  const textParts: string[] = [];
  const bounds = new Map<Node, { start: number; end: number }>();
  const childBoundaries = new Map<Node, number[]>();
  const atomicBounds: Array<{ element: Element; start: number; end: number }> = [];
  const pieces: DomPiece[] = [];
  const textDomStarts = new Map<Text, number>();
  let cursor = 0;

  const visit = (node: Node): void => {
    const start = cursor;
    if (node.nodeType === node.TEXT_NODE) {
      const rawText = node.textContent ?? "";
      // markdown-it emits one formatting newline after <br>. It is not another source newline.
      const domStart = node.previousSibling instanceof Element && node.previousSibling.tagName === "BR" && rawText.startsWith("\n") ? 1 : 0;
      const text = rawText.slice(domStart);
      textParts.push(text);
      cursor += text.length;
      bounds.set(node, { start, end: cursor });
      textDomStarts.set(node as Text, domStart);
      if (cursor > start) pieces.push({ kind: "text", node: node as Text, start, end: cursor, domStart });
      return;
    }

    const element = node.nodeType === node.ELEMENT_NODE ? node as Element : null;
    if (element?.hasAttribute("data-reader-selection-ignore")) {
      bounds.set(node, { start, end: start });
      childBoundaries.set(node, Array(node.childNodes.length + 1).fill(start));
      return;
    }
    if (element?.classList.contains("katex")) {
      const text = katexMarkdown(element);
      textParts.push(text);
      cursor += text.length;
      bounds.set(node, { start, end: cursor });
      atomicBounds.push({ element, start, end: cursor });
      if (cursor > start) pieces.push({ kind: "atomic", node: element, start, end: cursor });
      return;
    }
    if (element?.tagName === "BR") {
      textParts.push("\n");
      cursor += 1;
      bounds.set(node, { start, end: cursor });
      pieces.push({ kind: "break", node: element, start, end: cursor });
      return;
    }

    const boundaries = [cursor];
    for (const child of Array.from(node.childNodes)) {
      visit(child);
      boundaries.push(cursor);
    }
    bounds.set(node, { start, end: cursor });
    childBoundaries.set(node, boundaries);
  };
  visit(root);

  return {
    text: textParts.join(""),
    pieces,
    offsetForPoint(container, offset, edge) {
      const atomic = atomicBounds.find(({ element }) => element === container || element.contains(container));
      if (atomic) return edge === "start" ? atomic.start : atomic.end;

      const nodeBounds = bounds.get(container);
      if (!nodeBounds) return edge === "start" ? 0 : cursor;
      if (container.nodeType === container.TEXT_NODE) {
        const domStart = textDomStarts.get(container as Text) ?? 0;
        return nodeBounds.start + Math.max(0, Math.min(offset - domStart, nodeBounds.end - nodeBounds.start));
      }
      const boundaries = childBoundaries.get(container);
      if (!boundaries) return edge === "start" ? nodeBounds.start : nodeBounds.end;
      return boundaries[Math.max(0, Math.min(offset, boundaries.length - 1))];
    },
  };
}

function mergeAdjacentRanges(ranges: SourceTextRange[]): SourceTextRange[] {
  const merged: SourceTextRange[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function sourceTextForRanges(source: string, ranges: SourceTextRange[]): string {
  return ranges.map(({ start, end }) => source.slice(start, end)).join("");
}

export function createMarkdownDomSourceMap(source: string, root: Node) {
  const projection = projectDom(root);
  const spans = alignmentSpans(source, projection.text);

  function sourceRangesForSemanticRange(start: number, end: number): SourceTextRange[] {
    const selectionStart = Math.max(0, Math.min(start, projection.text.length));
    const selectionEnd = Math.max(selectionStart, Math.min(end, projection.text.length));
    const ranges: SourceTextRange[] = [];

    for (const span of spans) {
      const overlapStart = Math.max(selectionStart, span.semanticStart);
      const overlapEnd = Math.min(selectionEnd, span.semanticEnd);
      if (overlapEnd <= overlapStart) continue;
      if (span.kind === "equal") {
        ranges.push({
          start: span.sourceStart + overlapStart - span.semanticStart,
          end: span.sourceStart + overlapEnd - span.semanticStart,
        });
      }
      else if (span.kind === "replacement" && span.sourceEnd > span.sourceStart) {
        ranges.push({ start: span.sourceStart, end: span.sourceEnd });
      }
    }
    return mergeAdjacentRanges(ranges);
  }

  function semanticRangesForSourceRange(start: number, end: number): SourceTextRange[] {
    const selectionStart = Math.max(0, Math.min(start, source.length));
    const selectionEnd = Math.max(selectionStart, Math.min(end, source.length));
    const ranges: SourceTextRange[] = [];

    for (const span of spans) {
      const overlapStart = Math.max(selectionStart, span.sourceStart);
      const overlapEnd = Math.min(selectionEnd, span.sourceEnd);
      if (overlapEnd <= overlapStart) continue;
      if (span.kind === "equal") {
        ranges.push({
          start: span.semanticStart + overlapStart - span.sourceStart,
          end: span.semanticStart + overlapEnd - span.sourceStart,
        });
      }
      else if (span.kind === "replacement" && span.semanticEnd > span.semanticStart) {
        ranges.push({ start: span.semanticStart, end: span.semanticEnd });
      }
    }
    return mergeAdjacentRanges(ranges);
  }

  return {
    semanticText: projection.text,
    domPieces: projection.pieces,
    sourceRangesForRange(range: Range): SourceTextRange[] {
      const start = projection.offsetForPoint(range.startContainer, range.startOffset, "start");
      const end = projection.offsetForPoint(range.endContainer, range.endOffset, "end");
      return sourceRangesForSemanticRange(start, end);
    },
    sourceRangesForSemanticRange,
    semanticRangesForSourceRange,
  };
}

interface MarkedSemanticRange extends SourceTextRange {
  className: string;
}

function disjointMarkedRanges(ranges: MarkedSemanticRange[]): MarkedSemanticRange[] {
  const boundaries = Array.from(new Set(ranges.flatMap(({ start, end }) => [start, end]))).sort((a, b) => a - b);
  const disjoint: MarkedSemanticRange[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const className = Array.from(new Set(
      ranges
        .filter((range) => range.start < end && range.end > start)
        .flatMap((range) => range.className.split(/\s+/).filter(Boolean)),
    )).sort().join(" ");
    if (!className || end <= start) continue;
    const previous = disjoint[disjoint.length - 1];
    if (previous && previous.end === start && previous.className === className) previous.end = end;
    else disjoint.push({ start, end, className });
  }
  return disjoint;
}

function wrapTextPiece(piece: DomPiece, ranges: MarkedSemanticRange[]): void {
  if (piece.kind !== "text") return;
  const node = piece.node as Text;
  const overlaps = ranges
    .map((range) => ({
      start: Math.max(range.start, piece.start) - piece.start,
      end: Math.min(range.end, piece.end) - piece.start,
      className: range.className,
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => right.start - left.start);

  for (const overlap of overlaps) {
    const selected = node.splitText(overlap.start + (piece.domStart ?? 0));
    selected.splitText(overlap.end - overlap.start);
    const mark = node.ownerDocument.createElement("mark");
    mark.className = overlap.className;
    selected.parentNode?.insertBefore(mark, selected);
    mark.appendChild(selected);
  }
}

function wrapAtomicPiece(piece: DomPiece, ranges: MarkedSemanticRange[]): void {
  if (piece.kind !== "atomic") return;
  const className = Array.from(new Set(
    ranges
      .filter((range) => range.start < piece.end && range.end > piece.start)
      .flatMap((range) => range.className.split(/\s+/).filter(Boolean)),
  )).sort().join(" ");
  if (!className) return;
  const element = piece.node as Element;
  const parent = element.parentNode;
  if (!parent) return;
  const mark = element.ownerDocument.createElement("mark");
  mark.className = className;
  parent.insertBefore(mark, element);
  mark.appendChild(element);
}

export function markMarkdownDomSourceRanges(
  source: string,
  root: Node,
  ranges: MarkedSourceRange[],
): void {
  if (!ranges.length) return;
  const map = createMarkdownDomSourceMap(source, root);
  const semanticRanges = disjointMarkedRanges(ranges.flatMap(({ start, end, className }) =>
    map.semanticRangesForSourceRange(start, end).map((range) => ({ ...range, className })),
  ));
  for (const piece of [...map.domPieces].reverse()) {
    if (piece.kind === "text") wrapTextPiece(piece, semanticRanges);
    else if (piece.kind === "atomic") wrapAtomicPiece(piece, semanticRanges);
  }
}
