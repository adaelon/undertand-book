import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HybridFoundationAdaptationBaselineZ } from "../src/hybrid-foundation-goldset";
import type { MarkdownSourceReviewProposal } from "../src/md-adapter";
import {
  ReviewedSourceRepairPlanZ,
  type ReviewedSourceRepairPlan,
} from "../src/reviewed-source-candidate";

const OLD_BOOK_ID = "understanding-transformer-from-the-perspective-of";
const NEW_BOOK_ID = "understanding-transformer-from-the-perspective-of-reviewed-v2";

function requiredPath(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} requires an explicit path`);
  return path.resolve(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function adaptationBaseline(value: unknown) {
  const candidate = value && typeof value === "object" && "expected_adaptation_v1" in value
    ? (value as { expected_adaptation_v1: unknown }).expected_adaptation_v1
    : value;
  return HybridFoundationAdaptationBaselineZ.parse(candidate);
}

function listings(source: string): Array<{ body: string }> {
  const normalized = source.replace(/\r\n?/gu, "\n");
  return [...normalized.matchAll(/\\begin\{lstlisting\}(?:\[[^\]]*\])?\s*\n([\s\S]*?)\n\\end\{lstlisting\}/gu)]
    .map((match) => ({ body: match[1] }));
}

function balancedCommands(source: string, command: string): string[] {
  const marker = `\\${command}{`;
  const result: string[] = [];
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start < 0) return result;
    const contentStart = start + marker.length;
    let depth = 1;
    let cursor = contentStart;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      if (source[cursor] === "{" && source[cursor - 1] !== "\\") depth += 1;
      if (source[cursor] === "}" && source[cursor - 1] !== "\\") depth -= 1;
    }
    if (depth !== 0) throw new Error(`unbalanced \\${command} in official source`);
    result.push(source.slice(contentStart, cursor - 1));
    searchFrom = cursor;
  }
}

function unique<T>(values: T[], predicate: (value: T) => boolean, label: string): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} matched ${matches.length} official source items`);
  return matches[0];
}

function overlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

export function freezeTransformerReviewedSourcePlan(args: string[]) {
  const sourcePath = requiredPath(args, "--source");
  const basePath = requiredPath(args, "--base");
  const baselinePath = requiredPath(args, "--adaptation-baseline");
  const structureAuditPath = requiredPath(args, "--structure-audit");
  const appendixPath = requiredPath(args, "--appendix-tex");
  const associativePath = requiredPath(args, "--associative-tex");
  const outputPath = requiredPath(args, "--output");
  const source = readFileSync(sourcePath, "utf8");
  const baseText = readFileSync(basePath, "utf8");
  const baseline = adaptationBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  const structureAudit = JSON.parse(readFileSync(structureAuditPath, "utf8")) as {
    source_sha256: string;
    parser: { review_proposals: MarkdownSourceReviewProposal[] };
  };
  if (structureAudit.source_sha256 !== sha256(source)) throw new Error("structure audit source hash mismatch");
  const appendix = readFileSync(appendixPath, "utf8");
  const associative = readFileSync(associativePath, "utf8");
  const malformedProposal = unique(
    structureAudit.parser.review_proposals,
    (proposal) => proposal.kind === "malformed_inline_math",
    "malformed proposal",
  );
  const codeProposals = structureAudit.parser.review_proposals.filter((proposal) => proposal.kind === "unfenced_code");
  if (codeProposals.length !== 9) throw new Error(`expected 9 unfenced code proposals, got ${codeProposals.length}`);

  const malformedStart = source.indexOf(" $ \\underline", malformedProposal.source_span.start);
  const firstCodeStart = codeProposals[0].source_span.start;
  const firstCodeEnd = source.indexOf("### D.3.1", firstCodeStart);
  const toyCodeStart = codeProposals[1].source_span.start;
  const toyCodeEnd = source.indexOf("### F Analytical Solution", toyCodeStart);
  if (malformedStart < malformedProposal.source_span.start || malformedStart >= malformedProposal.source_span.end
    || firstCodeEnd < 0 || toyCodeEnd < 0) {
    throw new Error("review repair anchors do not match the frozen source");
  }
  const officialListings = listings(appendix);
  const firstListing = unique(officialListings, (listing) => listing.body.includes("def flash_attn"), "D.3 listing");
  const toyListing = unique(officialListings, (listing) => listing.body.includes("class DeltaAttention"), "E.4 listing");
  const emphasis = unique(
    balancedCommands(associative, "emph"),
    (body) => body.includes("expressivity of DeltaFormer") && body.includes("NC^1"),
    "DeltaFormer emphasis",
  );
  const repairs: ReviewedSourceRepairPlan["repairs"] = [
    {
      id: "repair-malformed-deltaformer-emphasis",
      kind: "official_latex_emphasis",
      source_span: { start: malformedStart, end: malformedProposal.source_span.end },
      source_span_sha256: sha256(source.slice(malformedStart, malformedProposal.source_span.end)),
      evidence_id: "official-associative-memory-source",
      evidence_content_sha256: sha256(emphasis),
    },
    {
      id: "repair-appendix-d3-listing",
      kind: "official_latex_listing",
      source_span: { start: firstCodeStart, end: firstCodeEnd },
      source_span_sha256: sha256(source.slice(firstCodeStart, firstCodeEnd)),
      evidence_id: "official-appendix-source",
      evidence_content_sha256: sha256(firstListing.body),
    },
    {
      id: "repair-appendix-e4-listing",
      kind: "official_latex_listing",
      source_span: { start: toyCodeStart, end: toyCodeEnd },
      source_span_sha256: sha256(source.slice(toyCodeStart, toyCodeEnd)),
      evidence_id: "official-appendix-source",
      evidence_content_sha256: sha256(toyListing.body),
    },
  ];
  const materialLeaves = baseline.leaves.filter((leaf) => leaf.expected.issue_ids.includes("PDF-A011"));
  if (materialLeaves.length !== 28) throw new Error(`expected 28 PDF-A011 leaves, got ${materialLeaves.length}`);
  const repairedBySpan = (span: { start: number; end: number }) => repairs.find((repair) => overlap(repair.source_span, span));
  const materialDecisions: ReviewedSourceRepairPlan["decisions"] = materialLeaves.map((leaf) => {
    const repair = repairedBySpan(leaf.source_span);
    return {
      id: `material:${leaf.baseline_lid}`,
      category: "material_mismatch",
      baseline_lid: leaf.baseline_lid,
      status: repair ? "reviewed_repaired" : "intentional_source_difference",
      evidence_id: repair?.evidence_id ?? "reviewed-original-markdown",
      ...(repair ? { repair_id: repair.id } : {}),
    };
  });
  const proposalDecisions: ReviewedSourceRepairPlan["decisions"] = structureAudit.parser.review_proposals.map((proposal) => {
    const repair = repairedBySpan(proposal.source_span);
    if (!repair) throw new Error(`review proposal has no approved repair:${proposal.kind}:${proposal.source_span.start}`);
    return {
      id: `proposal:${proposal.kind}:${proposal.source_span.start}:${proposal.source_span.end}`,
      category: proposal.kind,
      source_span: proposal.source_span,
      status: "reviewed_repaired",
      evidence_id: repair.evidence_id,
      repair_id: repair.id,
    };
  });
  const plan = ReviewedSourceRepairPlanZ.parse({
    version: "reviewed_source_repair_plan.v1",
    old_book_id: OLD_BOOK_ID,
    new_book_id: NEW_BOOK_ID,
    input_fingerprint: { source_sha256: sha256(source), base_sha256: sha256(baseText) },
    evidence: [
      { id: "reviewed-original-markdown", kind: "original_markdown", sha256: sha256(source) },
      {
        id: "official-appendix-source",
        kind: "official_arxiv_source",
        revision: "arXiv:2505.19488v1/sections/appendix.tex",
        sha256: sha256(appendix),
      },
      {
        id: "official-associative-memory-source",
        kind: "official_arxiv_source",
        revision: "arXiv:2505.19488v1/sections/associative_mem.tex",
        sha256: sha256(associative),
      },
    ],
    decisions: [...materialDecisions, ...proposalDecisions],
    repairs,
  });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const plan = freezeTransformerReviewedSourcePlan(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      version: plan.version,
      output: requiredPath(process.argv.slice(2), "--output"),
      decision_count: plan.decisions.length,
      repair_count: plan.repairs.length,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
