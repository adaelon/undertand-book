import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FORMULA_SOURCE_AST_POLICY, parseFormulaSourceAst, type FormulaSourceAstNode } from "../src/formula-source-ast";
import {
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
} from "../src/hybrid-foundation-goldset";
import { parseMarkdownSourceBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";

function requiredPath(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} requires an explicit path`);
  return path.resolve(value);
}

function optionalPath(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error(`${name} requires a path`);
  return value ? path.resolve(value) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function counts(values: string[]): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function flattenNodes(nodes: FormulaSourceAstNode[]): FormulaSourceAstNode[] {
  return nodes.flatMap((node) => [
    node,
    ...flattenNodes(node.children ?? []),
  ]);
}

export async function runFormulaSourceAstAuditCli(args: string[]) {
  const sourcePath = requiredPath(args, "--source");
  const descriptorPath = requiredPath(args, "--descriptor");
  const migrationMapPath = requiredPath(args, "--migration-map");
  const outputPath = optionalPath(args, "--output");
  const source = readFileSync(sourcePath, "utf8");
  const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(descriptorPath, "utf8")));
  const migrationMap = HybridFoundationAdaptationMigrationMapZ.parse(
    JSON.parse(readFileSync(migrationMapPath, "utf8")),
  );
  const parsedSource = parseMarkdownSourceBlocks(source);
  const nodeByLid = new Map(segment(parsedSource.blocks).map((node) => [node.lid, node]));
  const baselineLeaves = descriptor.expected_adaptation_v1.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A001"));
  const items = baselineLeaves.map((leaf) => {
    const migration = migrationMap[leaf.baseline_lid];
    if (migration?.status === "removed") {
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration.status,
        status: "removed",
        classification: "reviewed_source_removed",
      };
    }
    const currentLid = migration?.v2_lid ?? leaf.baseline_lid;
    const node = nodeByLid.get(currentLid);
    if (!node) {
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        current_lid: currentLid,
        status: "missing_successor",
        classification: "unclassified",
      };
    }
    if (node.kind !== "formula") {
      const reviewedFormulaRepair = migration?.status === "content_drift" && node.kind === "paragraph";
      return {
        baseline_lid: leaf.baseline_lid,
        migration_status: migration?.status ?? "direct",
        current_lid: currentLid,
        status: "replayed",
        classification: reviewedFormulaRepair ? "reviewed_formula_to_paragraph" : "unclassified",
        block_kind: node.kind,
      };
    }
    const formula = parseFormulaSourceAst(source, node.span);
    const nodes = flattenNodes(formula.nodes);
    const underlineNodeCount = nodes.filter((node) => (
      node.kind === "command" && node.command === "underline" && node.category === "transparent_wrapper"
    )).length;
    const tokenSpansValid = formula.visible_tokens.every((token) => {
      if (token.source_span.start < node.span.start || token.source_span.end > node.span.end) return false;
      const raw = source.slice(token.source_span.start, token.source_span.end);
      return token.kind === "whitespace" ? /^\s+$/u.test(raw) : raw === token.value;
    });
    const classification = formula.status === "invalid"
      ? "invalid_formula_ast"
      : !underlineNodeCount
        ? "missing_transparent_wrapper"
        : !formula.visible_tokens.length || !tokenSpansValid
          ? "invalid_visible_token_spans"
          : formula.projectable
            ? "transparent_wrapper_projectable"
            : "transparent_wrapper_structural";
    return {
      baseline_lid: leaf.baseline_lid,
      migration_status: migration?.status ?? "direct",
      current_lid: currentLid,
      status: "replayed",
      classification,
      formula_status: formula.status,
      delimiter: formula.delimiter,
      projectable: formula.projectable,
      visible_token_count: formula.visible_tokens.length,
      underline_node_count: underlineNodeCount,
      node_category_counts: counts(nodes.map((node) => node.category)),
      token_spans_valid: tokenSpansValid,
      ...(formula.reason ? { reason: formula.reason } : {}),
    };
  });
  const missingSuccessorCount = items.filter((item) => item.status === "missing_successor").length;
  const invalidCount = items.filter((item) => (
    item.classification === "invalid_formula_ast" || item.classification === "invalid_visible_token_spans"
  )).length;
  const unclassifiedCount = items.filter((item) => (
    item.classification === "unclassified" || item.classification === "missing_transparent_wrapper"
  )).length;
  const report = {
    version: "formula_source_ast_audit.v1",
    policy_version: FORMULA_SOURCE_AST_POLICY.version,
    source_sha256: sha256(source),
    passed: baselineLeaves.length === 47
      && missingSuccessorCount === 0
      && invalidCount === 0
      && unclassifiedCount === 0
      && parsedSource.review_proposals.length === 0,
    summary: {
      baseline_count: baselineLeaves.length,
      replayed_count: items.filter((item) => item.status === "replayed").length,
      removed_count: items.filter((item) => item.status === "removed").length,
      missing_successor_count: missingSuccessorCount,
      projectable_count: items.filter((item) => "projectable" in item && item.projectable).length,
      structural_count: items.filter((item) => item.classification === "transparent_wrapper_structural").length,
      invalid_count: invalidCount,
      unclassified_count: unclassifiedCount,
      parser_review_proposal_count: parsedSource.review_proposals.length,
      classification_counts: counts(items.map((item) => item.classification)),
    },
    items,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFormulaSourceAstAuditCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(`${JSON.stringify({
        version: report.version,
        policy_version: report.policy_version,
        source_sha256: report.source_sha256,
        passed: report.passed,
        ...report.summary,
      }, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
