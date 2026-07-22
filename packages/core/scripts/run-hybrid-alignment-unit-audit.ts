import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  auditHybridAlignmentUnits,
  HYBRID_ALIGNMENT_UNIT_POLICY,
} from "../src/hybrid-alignment-v2";

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function counts(values: string[]): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function runHybridAlignmentUnitAuditCli(args: string[]) {
  const sourcePath = valueAfter(args, "--source");
  const outputPath = valueAfter(args, "--output");
  if (!sourcePath) throw new Error("--source requires an explicit path");
  const source = readFileSync(path.resolve(sourcePath), "utf8");
  const analysis = auditHybridAlignmentUnits(source);
  const units = analysis.units;
  const children = units.flatMap((unit) => unit.child_lids);
  const report = {
    version: "hybrid_alignment_unit_audit.v1",
    policy: HYBRID_ALIGNMENT_UNIT_POLICY,
    source_sha256: sha256(source),
    passed: analysis.passed,
    summary: {
      unit_count: analysis.summary.unit_count,
      child_count: analysis.summary.child_count,
      child_kind_counts: counts(children.map((child) => child.kind)),
      within_guard_count: analysis.summary.within_guard_count,
      oversize_singleton_count: analysis.summary.oversize_singleton_count,
      oversized_multi_child_unit_count: analysis.summary.oversized_multi_child_unit_count,
      boundary_violation_count: analysis.summary.boundary_violation_count,
      max_child_count: analysis.summary.max_child_count,
      max_source_utf16_length: analysis.summary.max_source_utf16_length,
      max_searchable_token_count: analysis.summary.max_searchable_token_count,
    },
    coverage: analysis.coverage,
    units: units.map((unit) => ({
      unit_id: unit.unit_id,
      source_span: unit.source_span,
      source_span_sha256: sha256(source.slice(unit.source_span.start, unit.source_span.end)),
      diagnostic: unit.diagnostic,
      metrics: unit.metrics,
      children: unit.child_lids,
    })),
  };
  if (outputPath) writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = runHybridAlignmentUnitAuditCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      version: report.version,
      source_sha256: report.source_sha256,
      passed: report.passed,
      ...report.summary,
    }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
