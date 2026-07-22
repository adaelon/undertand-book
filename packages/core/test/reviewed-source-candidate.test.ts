import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runReviewedSourceCandidateCli } from "../scripts/build-reviewed-source-candidate";
import { parseMarkdownSourceBlocks } from "../src/md-adapter";
import {
  buildReviewedSourceCandidate,
  type ReviewedSourceRepairPlan,
} from "../src/reviewed-source-candidate";
import { segment } from "../src/segment";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const REAL_PLAN_PATH = fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-reviewed-source-plan.json",
  import.meta.url,
));
const REAL_AUDIT_PATH = fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-reviewed-source-candidate-audit.json",
  import.meta.url,
));

function fixture() {
  const source = [
    "# Title",
    "",
    "Alpha $ \\underline{\\text{broken $ x $ end.}} $ after.",
    "",
    "import bad",
    "value = bad",
    "return value",
    "",
  ].join("\n");
  const malformedStart = source.indexOf("Alpha ");
  const malformedEnd = source.indexOf("\n\n", malformedStart);
  const codeStart = source.indexOf("import bad");
  const codeEnd = source.length;
  const nestedFormulaStart = source.indexOf("$ x $", malformedStart);
  const codeLines = ["import bad", "value = bad", "return value"];
  let codeCursor = codeStart;
  const oldBase = {
    book_id: "paper-v1",
    lid_nodes: segment([
      { kind: "heading", level: 1, text: "Title", span: { start: 0, end: 7 } },
      {
        kind: "leaf",
        text: source.slice(malformedStart, nestedFormulaStart),
        span: { start: malformedStart, end: nestedFormulaStart },
      },
      {
        kind: "leaf",
        assetKind: "formula",
        text: "$ x $",
        span: { start: nestedFormulaStart, end: nestedFormulaStart + 5 },
      },
      {
        kind: "leaf",
        text: source.slice(nestedFormulaStart + 5, malformedEnd),
        span: { start: nestedFormulaStart + 5, end: malformedEnd },
      },
      ...codeLines.map((line) => {
        const block = {
          kind: "leaf" as const,
          text: line,
          span: { start: codeCursor, end: codeCursor + line.length },
        };
        codeCursor += line.length + 1;
        return block;
      }),
    ]),
    graph_nodes: [],
    graph_edges: [],
  };
  const baseText = JSON.stringify(oldBase);
  const malformedSpan = { start: malformedStart, end: malformedEnd };
  const codeSpan = { start: codeStart, end: codeEnd };
  const official = [
    "\\emph{Alpha has valid math $x$.}",
    "\\begin{lstlisting}[language=Python, caption=Reviewed code.]",
    "import good",
    "value = good",
    "return value",
    "\\end{lstlisting}",
  ].join("\n");
  const emphasisBody = "Alpha has valid math $x$.";
  const listingBody = ["import good", "value = good", "return value"].join("\n");
  const proposals = parseMarkdownSourceBlocks(source).review_proposals;
  const materialLid = oldBase.lid_nodes.find((node) =>
    node.children.length === 0 && node.span.start === malformedStart
  )!.lid;
  const plan: ReviewedSourceRepairPlan = {
    version: "reviewed_source_repair_plan.v1",
    old_book_id: "paper-v1",
    new_book_id: "paper-v2",
    input_fingerprint: {
      source_sha256: sha256(source),
      base_sha256: sha256(baseText),
    },
    evidence: [{
      id: "official-source",
      kind: "official_arxiv_source",
      revision: "v1",
      sha256: sha256(official),
    }],
    decisions: [
      {
        id: `material:${materialLid}`,
        category: "material_mismatch",
        baseline_lid: materialLid,
        status: "reviewed_repaired",
        evidence_id: "official-source",
        repair_id: "repair-emphasis",
      },
      ...proposals.map((proposal, index) => ({
        id: `proposal:${index + 1}`,
        category: proposal.kind,
        source_span: proposal.source_span,
        status: "reviewed_repaired" as const,
        evidence_id: "official-source",
        repair_id: proposal.kind === "malformed_inline_math" ? "repair-emphasis" : "repair-code",
      })),
    ],
    repairs: [
      {
        id: "repair-emphasis",
        kind: "official_latex_emphasis",
        source_span: malformedSpan,
        source_span_sha256: sha256(source.slice(malformedSpan.start, malformedSpan.end)),
        evidence_id: "official-source",
        evidence_content_sha256: sha256(emphasisBody),
      },
      {
        id: "repair-code",
        kind: "official_latex_listing",
        source_span: codeSpan,
        source_span_sha256: sha256(source.slice(codeSpan.start, codeSpan.end)),
        evidence_id: "official-source",
        evidence_content_sha256: sha256(listingBody),
      },
    ],
  };
  return { source, oldBase, baseText, official, proposals, materialLid, plan };
}

describe("PR10 reviewed source candidate", () => {
  it("requires every real builder input path explicitly", () => {
    expect(() => runReviewedSourceCandidateCli([])).toThrow("--source requires an explicit path");
  });

  it("builds a deterministic independent candidate and one-to-one LID migration", () => {
    const input = fixture();
    const build = () => buildReviewedSourceCandidate({
      source: input.source,
      old_base_json: input.baseText,
      required_material_lids: [input.materialLid],
      required_review_proposals: input.proposals,
      plan: input.plan,
      evidence: { "official-source": input.official },
    });

    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first.base.book_id).toBe("paper-v2");
    expect(first.source).toContain("*Alpha has valid math $x$.*");
    expect(first.source).toContain("```python\nimport good");
    expect(first.source).toContain("Reviewed code.");
    expect(first.report).toMatchObject({
      version: "reviewed_source_candidate_report.v1",
      source_review_gate: "approved",
      candidate_scope: "structural_source_base",
      formal_release_gate: "pending_pr20_rebuild",
      decision_counts: {
        material_mismatch: 1,
        malformed_inline_math: 1,
        unfenced_code: 1,
      },
      parser_review_proposal_count: 0,
      migration: { unexpected_candidate_count: 0, duplicate_candidate_count: 0 },
    });
    const leaves = first.base.lid_nodes.filter((node) => node.children.length === 0);
    expect(leaves.filter((node) => node.kind === "code")).toHaveLength(1);
    expect(first.base.lid_nodes.filter((node) => node.kind === "chapter")).toHaveLength(1);
    const mapped = Object.values(first.lid_migration_map).flatMap((entry) => entry.v2_lid ? [entry.v2_lid] : []);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped).toHaveLength(leaves.length);
    expect(input.source).toBe(fixture().source);
    expect(input.oldBase).toEqual(fixture().oldBase);
  });

  it("fails closed on missing review decisions and evidence drift", () => {
    const input = fixture();
    const build = (plan: ReviewedSourceRepairPlan, evidence = input.official) =>
      buildReviewedSourceCandidate({
        source: input.source,
        old_base_json: input.baseText,
        required_material_lids: [input.materialLid],
        required_review_proposals: input.proposals,
        plan,
        evidence: { "official-source": evidence },
      });

    expect(() => build({ ...input.plan, decisions: input.plan.decisions.slice(1) }))
      .toThrow(/missing required decision.*material/u);
    expect(() => build(input.plan, `${input.official}\nchanged`)).toThrow(/evidence hash mismatch/u);
    expect(() => buildReviewedSourceCandidate({
      source: input.source,
      old_base_json: `${input.baseText}\n`,
      required_material_lids: [input.materialLid],
      required_review_proposals: input.proposals,
      plan: input.plan,
      evidence: { "official-source": input.official },
    })).toThrow(/base hash mismatch/u);
  });

  it("rejects candidate leaves without a declared predecessor interval", () => {
    const input = fixture();
    const codeRepair = input.plan.repairs.find((repair) => repair.id === "repair-code")!;
    const outside = {
      ...codeRepair,
      source_span: { start: input.source.length, end: input.source.length },
      source_span_sha256: sha256(""),
    };
    const plan = {
      ...input.plan,
      repairs: input.plan.repairs.map((repair) => repair.id === "repair-code" ? outside : repair),
    };
    expect(() => buildReviewedSourceCandidate({
      source: input.source,
      old_base_json: input.baseText,
      required_material_lids: [input.materialLid],
      required_review_proposals: input.proposals,
      plan,
      evidence: { "official-source": input.official },
    })).toThrow(/span must be non-empty|repair does not cover reviewed proposal|no predecessor interval/u);
  });

  it("freezes the real-book review closure and candidate audit without source text", () => {
    const planText = readFileSync(REAL_PLAN_PATH, "utf8");
    const plan = JSON.parse(planText) as ReviewedSourceRepairPlan;
    const audit = JSON.parse(readFileSync(REAL_AUDIT_PATH, "utf8"));

    expect(sha256(planText)).toBe("7a146b101f095571ab4a8c98a20296979f5b12fb0cf4ff5057b00f1ea3633df9");
    expect(plan.decisions).toHaveLength(38);
    expect(plan.repairs).toHaveLength(3);
    expect(plan.decisions.filter((decision) => decision.category === "material_mismatch")).toHaveLength(28);
    expect(plan.decisions.filter((decision) => decision.status === "reviewed_repaired")).toHaveLength(25);
    expect(plan.decisions.filter((decision) => decision.status === "intentional_source_difference")).toHaveLength(13);
    expect(plan.evidence.map((item) => item.sha256)).toEqual([
      "cb108cabb5198cf07820b5eb49e6d3094fdf870ae20b130c93539b721ed653c9",
      "f53620ace3c77b3011087c17c323aee383ea42712899e2d4dbc3bab0e9a0785b",
      "8eb68b661d3901d4032e305ecbeb73d8377cd575316e580ea831d550a7c894e1",
    ]);
    expect(planText).not.toContain('"text"');
    expect(audit).toMatchObject({
      source_review_gate: "approved",
      candidate_scope: "structural_source_base",
      formal_release_gate: "pending_pr20_rebuild",
      decision_counts: { material_mismatch: 28, malformed_inline_math: 1, unfenced_code: 9 },
      parser_review_proposal_count: 0,
      partition: { ok: true, coverage: 1 },
      candidate: {
        leaf_count: 1945,
        leaf_kind_counts: { code: 2, formula: 830, image: 19, paragraph: 1092, table: 2 },
        top_level_containers: ["1"],
      },
      migration: {
        stable: 1935,
        content_drift: 10,
        removed: 130,
        unexpected_candidate_count: 0,
        duplicate_candidate_count: 0,
      },
    });
  });
});
