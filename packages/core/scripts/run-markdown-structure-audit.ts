import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseMarkdownSourceBlocks } from "../src/md-adapter";
import { checkPartitionInvariant } from "../src/partition";
import { segment } from "../src/segment";
import { ReadOnlyBaseZ } from "../src/zod";

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function countStrings(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function runMarkdownStructureAuditCli(args: string[]) {
  const sourcePath = valueAfter(args, "--source");
  const baselineBasePath = valueAfter(args, "--baseline-base");
  const outputPath = valueAfter(args, "--output");
  if (!sourcePath) throw new Error("--source requires an explicit path");
  if (!baselineBasePath) throw new Error("--baseline-base requires an explicit path");
  const source = readFileSync(path.resolve(sourcePath), "utf8");
  const baseline = ReadOnlyBaseZ.parse(JSON.parse(readFileSync(path.resolve(baselineBasePath), "utf8")));
  const parsed = parseMarkdownSourceBlocks(source);
  const nodes = segment(parsed.blocks);
  const partition = checkPartitionInvariant(nodes, source);
  const baselineLeaves = baseline.lid_nodes.filter((node) => node.children.length === 0);
  const candidateLeaves = nodes.filter((node) => node.children.length === 0);
  const baselineBySpan = new Map(baselineLeaves.map((node) => [`${node.span.start}:${node.span.end}`, node]));
  const candidateBySpan = new Map(candidateLeaves.map((node) => [`${node.span.start}:${node.span.end}`, node]));
  const leafRecord = (node: typeof candidateLeaves[number]) => ({
    lid: node.lid,
    kind: node.kind,
    source_span: node.span,
    source_span_sha256: sha256(source.slice(node.span.start, node.span.end)),
  });
  const exactSpanMatches = candidateLeaves.flatMap((candidate) => {
    const previous = baselineBySpan.get(`${candidate.span.start}:${candidate.span.end}`);
    return previous ? [{ previous: leafRecord(previous), candidate: leafRecord(candidate) }] : [];
  });
  const report = {
    version: "markdown_structure_audit.v1",
    source_sha256: sha256(source),
    parser: {
      block_counts: countStrings(parsed.blocks.map((block) => block.assetKind ?? block.kind)),
      review_proposals: parsed.review_proposals,
    },
    partition,
    baseline: {
      node_count: baseline.lid_nodes.length,
      leaf_count: baselineLeaves.length,
      leaf_kind_counts: countStrings(baselineLeaves.map((node) => node.kind)),
      top_level_containers: baseline.lid_nodes
        .filter((node) => node.path.length === 1 && node.children.length > 0)
        .map((node) => node.lid),
    },
    candidate: {
      node_count: nodes.length,
      leaf_count: candidateLeaves.length,
      leaf_kind_counts: countStrings(candidateLeaves.map((node) => node.kind)),
      top_level_containers: nodes
        .filter((node) => node.path.length === 1 && node.children.length > 0)
        .map((node) => node.lid),
    },
    differences: {
      exact_span_match_count: exactSpanMatches.length,
      kind_changes: exactSpanMatches
        .filter((match) => match.previous.kind !== match.candidate.kind)
        .map((match) => ({ previous: match.previous, candidate: match.candidate })),
      lid_changes: exactSpanMatches
        .filter((match) => match.previous.lid !== match.candidate.lid)
        .map((match) => ({ previous: match.previous, candidate: match.candidate })),
      removed_baseline_leaves: baselineLeaves
        .filter((node) => !candidateBySpan.has(`${node.span.start}:${node.span.end}`))
        .map(leafRecord),
      added_candidate_leaves: candidateLeaves
        .filter((node) => !baselineBySpan.has(`${node.span.start}:${node.span.end}`))
        .map(leafRecord),
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(path.resolve(outputPath), serialized, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const report = runMarkdownStructureAuditCli(args);
    const outputPath = valueAfter(args, "--output");
    const output = outputPath ? {
      version: report.version,
      output_path: path.resolve(outputPath),
      source_sha256: report.source_sha256,
      review_proposal_count: report.parser.review_proposals.length,
      baseline_leaf_count: report.baseline.leaf_count,
      candidate_leaf_count: report.candidate.leaf_count,
      exact_span_match_count: report.differences.exact_span_match_count,
      partition_ok: report.partition.ok,
    } : report;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
