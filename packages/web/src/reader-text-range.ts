import type { ManifestNode } from "./generated/ManifestNode";

export interface TextRangeReply {
  lid: string;
  text: string;
  /** Additive response identity used when a transport exposes the requested tail. */
  end_lid?: string;
}

function invalidRange(message: string): never {
  throw new Error(`Invalid UTF-16 range: ${message}`);
}

function isUtf16Boundary(text: string, index: number): boolean {
  if (index === 0 || index === text.length) return true;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff);
}

/**
 * Splits one canonical `book.text(first, last)` response back into its exact
 * singular leaf texts. Manifest and JavaScript offsets are both UTF-16 units.
 * Any identity, leaf, ordering, span, boundary, or unowned-content mismatch
 * fails closed rather than guessing a delimiter.
 */
export function splitUtf16Range(
  reply: TextRangeReply,
  requestedLeaves: readonly ManifestNode[],
): Map<string, string> {
  if (requestedLeaves.length === 0) invalidRange("requested leaf range is empty");
  const first = requestedLeaves[0]!;
  const last = requestedLeaves[requestedLeaves.length - 1]!;
  if (reply.lid !== first.lid) {
    invalidRange(`response starts at ${reply.lid}, expected ${first.lid}`);
  }
  if (reply.end_lid !== undefined && reply.end_lid !== last.lid) {
    invalidRange(`response ends at ${reply.end_lid}, expected ${last.lid}`);
  }

  const seen = new Set<string>();
  let previous: ManifestNode | null = null;
  for (const node of requestedLeaves) {
    if (node.children.length !== 0) invalidRange(`${node.lid} is not a leaf`);
    if (!node.lid || seen.has(node.lid)) {
      invalidRange(`leaf identity is empty or duplicated: ${node.lid}`);
    }
    seen.add(node.lid);
    const { start, end } = node.span;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
      invalidRange(`invalid span for ${node.lid}: [${start}, ${end})`);
    }
    if (previous && previous.span.end > start) {
      invalidRange(`${node.lid} is out of order or overlaps ${previous.lid}`);
    }
    previous = node;
  }

  const rangeStart = first.span.start;
  const expectedLength = last.span.end - rangeStart;
  if (reply.text.length !== expectedLength) {
    invalidRange(`response length ${reply.text.length} does not match ${expectedLength}`);
  }

  const result = new Map<string, string>();
  let previousEnd = rangeStart;
  for (const node of requestedLeaves) {
    const start = node.span.start - rangeStart;
    const end = node.span.end - rangeStart;
    if (start < 0 || end > reply.text.length || start >= end) {
      invalidRange(`${node.lid} falls outside the response`);
    }
    if (!isUtf16Boundary(reply.text, start) || !isUtf16Boundary(reply.text, end)) {
      invalidRange(`${node.lid} bisects a surrogate pair`);
    }

    const gapStart = previousEnd - rangeStart;
    if (/\S/u.test(reply.text.slice(gapStart, start))) {
      invalidRange(`non-whitespace response content is not owned before ${node.lid}`);
    }
    const text = reply.text.slice(start, end);
    if (text.length !== node.span.end - node.span.start) {
      invalidRange(`split length mismatch for ${node.lid}`);
    }
    result.set(node.lid, text);
    previousEnd = node.span.end;
  }

  return result;
}
