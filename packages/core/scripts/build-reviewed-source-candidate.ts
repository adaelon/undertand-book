import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HybridFoundationAdaptationBaselineZ } from "../src/hybrid-foundation-goldset";
import type { MarkdownSourceReviewProposal } from "../src/md-adapter";
import {
  buildReviewedSourceCandidate,
  ReviewedSourceRepairPlanZ,
} from "../src/reviewed-source-candidate";

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredPath(args: string[], name: string): string {
  const value = valueAfter(args, name);
  if (!value) throw new Error(`${name} requires an explicit path`);
  return path.resolve(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function adaptationBaseline(value: unknown) {
  const candidate = value && typeof value === "object" && "expected_adaptation_v1" in value
    ? (value as { expected_adaptation_v1: unknown }).expected_adaptation_v1
    : value;
  return HybridFoundationAdaptationBaselineZ.parse(candidate);
}

function evidenceArguments(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--evidence") continue;
    const value = args[index + 1];
    const separator = value?.indexOf("=") ?? -1;
    if (!value || separator <= 0 || separator === value.length - 1) {
      throw new Error("--evidence requires id=path");
    }
    const id = value.slice(0, separator);
    if (result[id]) throw new Error(`duplicate --evidence id:${id}`);
    result[id] = readFileSync(path.resolve(value.slice(separator + 1)), "utf8");
  }
  return result;
}

export function runReviewedSourceCandidateCli(args: string[]) {
  const sourcePath = requiredPath(args, "--source");
  const basePath = requiredPath(args, "--base");
  const baselinePath = requiredPath(args, "--adaptation-baseline");
  const structureAuditPath = requiredPath(args, "--structure-audit");
  const planPath = requiredPath(args, "--plan");
  const outputDir = requiredPath(args, "--output-dir");
  const source = readFileSync(sourcePath, "utf8");
  const baseText = readFileSync(basePath, "utf8");
  const baseline = adaptationBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  const structureAudit = JSON.parse(readFileSync(structureAuditPath, "utf8")) as {
    source_sha256: string;
    parser: { review_proposals: MarkdownSourceReviewProposal[] };
  };
  if (structureAudit.source_sha256 !== sha256(source)) throw new Error("structure audit source hash mismatch");
  const requiredMaterialLids = baseline.leaves
    .filter((leaf) => leaf.expected.issue_ids.includes("PDF-A011"))
    .map((leaf) => leaf.baseline_lid);
  const plan = ReviewedSourceRepairPlanZ.parse(JSON.parse(readFileSync(planPath, "utf8")));
  const result = buildReviewedSourceCandidate({
    source,
    old_base_json: baseText,
    required_material_lids: requiredMaterialLids,
    required_review_proposals: structureAudit.parser.review_proposals,
    plan,
    evidence: evidenceArguments(args),
  });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "source.txt"), result.source, "utf8");
  writeFileSync(path.join(outputDir, "base.json"), artifactJson(result.base), "utf8");
  writeFileSync(path.join(outputDir, "lid_migration_map.json"), artifactJson(result.lid_migration_map), "utf8");
  writeFileSync(path.join(outputDir, "source_review_report.json"), artifactJson(result.report), "utf8");
  return result.report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = runReviewedSourceCandidateCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
