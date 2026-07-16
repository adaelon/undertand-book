import { createHash } from "node:crypto";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import { ReadOnlyBaseZ } from "./zod";

export function sameLidIdentity(left: ReadOnlyBase, right: ReadOnlyBase): boolean {
  return JSON.stringify(left.lid_nodes.map((node) => node.lid))
    === JSON.stringify(right.lid_nodes.map((node) => node.lid));
}

export function semanticGraphDigest(base: ReadOnlyBase): string {
  return createHash("sha256")
    .update(JSON.stringify({
      graph_nodes: base.graph_nodes,
      graph_edges: base.graph_edges,
    }))
    .digest("hex");
}

export function validateSemanticGraph(base: ReadOnlyBase, candidateLids: Set<string>): void {
  const graphIds = new Set<string>();
  for (const node of base.graph_nodes) {
    if (graphIds.has(node.id)) {
      throw new Error(`duplicate semantic graph node id: ${node.id}`);
    }
    graphIds.add(node.id);
    for (const lid of node.occurrences) {
      if (!candidateLids.has(lid)) {
        throw new Error(`semantic graph anchor does not exist in candidate LIDs: ${node.id} -> ${lid}`);
      }
    }
    if (node.source_lid && !candidateLids.has(node.source_lid)) {
      throw new Error(`semantic graph anchor does not exist in candidate LIDs: ${node.id} -> ${node.source_lid}`);
    }
  }
  for (const edge of base.graph_edges) {
    if (!graphIds.has(edge.source) || !graphIds.has(edge.target)) {
      throw new Error(`semantic graph edge endpoint is missing: ${edge.source} -> ${edge.target}`);
    }
  }
}

export function mergeHybridFoundationBase(
  official: ReadOnlyBase,
  candidate: ReadOnlyBase,
): ReadOnlyBase {
  if (official.book_id !== candidate.book_id) {
    throw new Error(`hybrid foundation book id mismatch: ${official.book_id} != ${candidate.book_id}`);
  }
  if (!sameLidIdentity(official, candidate)) {
    throw new Error("official and candidate LID identity differ");
  }
  const candidateLids = new Set(candidate.lid_nodes.map((node) => node.lid));
  if (candidateLids.size !== candidate.lid_nodes.length) {
    throw new Error("candidate LID identity contains duplicates");
  }
  validateSemanticGraph(official, candidateLids);
  return ReadOnlyBaseZ.parse({
    ...candidate,
    graph_nodes: official.graph_nodes,
    graph_edges: official.graph_edges,
  });
}
