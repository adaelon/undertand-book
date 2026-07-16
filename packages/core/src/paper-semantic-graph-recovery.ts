import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import { sameLidIdentity, semanticGraphDigest, validateSemanticGraph } from "./hybrid-foundation-apply";
import type { Pass2AuditEdge } from "./pass2-build";
import { ReadOnlyBaseZ } from "./zod";

export interface PaperSemanticGraphRecovery {
  base: ReadOnlyBase;
  semantic_graph_digest: string;
  graph_nodes: number;
  graph_edges: number;
  local_edges: number;
  long_range_edges: number;
  accepted_edges: number;
}

function relationKey(edge: { source: string; target: string; type: string }): string {
  return JSON.stringify([edge.source, edge.target, edge.type]);
}

export function buildPaperSemanticGraphRecovery(
  official: ReadOnlyBase,
  candidate: ReadOnlyBase,
  audit: Pick<{ accepted: Pass2AuditEdge[] }, "accepted">,
): PaperSemanticGraphRecovery {
  if (official.book_id !== candidate.book_id) {
    throw new Error(`paper semantic graph recovery book id mismatch: ${official.book_id} != ${candidate.book_id}`);
  }
  if (!sameLidIdentity(official, candidate)) {
    throw new Error("paper semantic graph recovery LID identity differs");
  }
  if (candidate.graph_nodes.length === 0) {
    throw new Error("paper semantic graph recovery candidate has no graph nodes");
  }

  const officialLids = new Set(official.lid_nodes.map((node) => node.lid));
  if (officialLids.size !== official.lid_nodes.length) {
    throw new Error("official paper foundation contains duplicate LIDs");
  }
  validateSemanticGraph(candidate, officialLids);

  const graphEdgeIds = new Set<string>();
  for (const edge of candidate.graph_edges) {
    const identity = JSON.stringify([
      edge.source,
      edge.target,
      edge.type,
      edge.direction,
      edge.scope,
    ]);
    if (graphEdgeIds.has(identity)) {
      throw new Error(`paper semantic graph recovery contains a duplicate edge: ${identity}`);
    }
    graphEdgeIds.add(identity);
  }

  for (const edge of audit.accepted) {
    const evidenceLids = [
      ...edge.source_evidence_lids,
      ...edge.target_evidence_lids,
      ...edge.evidence_lids,
    ];
    for (const lid of evidenceLids) {
      if (!officialLids.has(lid)) {
        throw new Error(`Pass2 accepted evidence LID is missing from the official foundation: ${lid}`);
      }
    }
  }
  const acceptedKeys = audit.accepted.map(relationKey).sort();
  const longRangeKeys = candidate.graph_edges
    .filter((edge) => edge.scope === "long_range")
    .map(relationKey)
    .sort();
  if (JSON.stringify(acceptedKeys) !== JSON.stringify(longRangeKeys)) {
    throw new Error("Pass2 accepted relations do not match recovered long-range graph edges");
  }

  const base = ReadOnlyBaseZ.parse({
    ...official,
    graph_nodes: candidate.graph_nodes,
    graph_edges: candidate.graph_edges,
  });
  return {
    base,
    semantic_graph_digest: semanticGraphDigest(base),
    graph_nodes: base.graph_nodes.length,
    graph_edges: base.graph_edges.length,
    local_edges: base.graph_edges.filter((edge) => edge.scope === "local").length,
    long_range_edges: longRangeKeys.length,
    accepted_edges: acceptedKeys.length,
  };
}
