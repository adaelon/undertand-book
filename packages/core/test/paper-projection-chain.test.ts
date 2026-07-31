import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPaperProjectionWorkspaceTarget,
  assertTrustedPaperProjectionSource,
  buildPaperProjectionChainPlan,
} from "../src/paper-projection-chain";
import { buildSourceManifestV2 } from "../src/source-manifest";
import {
  emptyReconciliationSummary,
  sha256Text,
  type SourceReconciliationReport,
} from "../src/source-reconciliation";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-paper-projection-"));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function trustedReport(bookId = "paper-a"): SourceReconciliationReport {
  return {
    version: "source_reconciliation_report.v1",
    book_id: bookId,
    input_fingerprint: {
      paper_md_sha256: "sha-md",
      paper_pdf_sha256: "sha-pdf",
      config_hash: "cfg-a",
    },
    summary: { ...emptyReconciliationSummary(), verified: 2 },
    unresolved: [],
  };
}

function writeTrustedBook(dir: string, source = "# Abstract\n\nThis paper studies retrieval.\n"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.txt"), source, "utf8");
  writeJson(path.join(dir, "base.json"), {
    book_id: "paper-a",
    lid_nodes: [
      { lid: "1", path: [1], kind: "chapter", span: { start: 0, end: source.length }, children: ["1.1"] },
      { lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 12, end: source.length }, children: [] },
    ],
    graph_nodes: [],
    graph_edges: [],
  });
  writeJson(
    path.join(dir, "source_manifest.json"),
    buildSourceManifestV2({
      book_id: "paper-a",
      source_sha256: sha256Text(source),
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_source_map_path: "pdf_source_map.json",
      pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
      alignment_report_path: "alignment_report.json",
      config_hash: "cfg-a",
    }),
  );
  writeJson(path.join(dir, ".build", "source-reconciliation", "report.json"), trustedReport());
}

describe("PH8 paper projection chain", () => {
  it("plans existing paper projection batches against trusted reconciled source.txt", () => {
    const dir = tempDir();
    writeTrustedBook(dir);

    const plan = buildPaperProjectionChainPlan(dir, { allow_partial: true, paper_subtype: "survey" });

    expect(plan.version).toBe("paper_projection_chain_plan.v1");
    expect(plan.source_truth_locked).toBe(true);
    expect(plan.projection_failures_do_not_update_source).toBe(true);
    expect(plan.trusted_source_path).toBe(path.join(path.resolve(dir), "source.txt"));
    expect(plan.stages.map((stage) => stage.stage)).toEqual([
      "paper_metadata",
      "paper_lexicon",
      "profile_sidecar",
      "pass2",
      "book_structure",
      "paper_reading_guide",
    ]);
    for (const stage of plan.stages) {
      expect(stage.uses_trusted_source).toBe(true);
      expect(stage.projection_only).toBe(true);
      expect(stage.may_update_source_truth).toBe(false);
    }
    expect(plan.stages[0].args).toContain(plan.trusted_source_path);
    expect(plan.stages[0].args).toContain("--allow-partial");
    expect(plan.stages[4].allow_partial_supported).toBe(false);
    expect(plan.stages[5]).toMatchObject({
      kind: "projection_verification",
      command: "pnpm",
      args: ["exec", "tsx", "skills/build/verify-paper-reading-guide.ts", path.resolve(dir)],
    });
  });

  it("can omit Pass2 while retaining BookStructure with no audit input requirement", () => {
    const dir = tempDir();
    writeTrustedBook(dir);

    const plan = buildPaperProjectionChainPlan(dir, { pass2: "disabled" });

    expect(plan.stages.map((stage) => stage.stage)).toEqual([
      "paper_metadata",
      "paper_lexicon",
      "profile_sidecar",
      "book_structure",
      "paper_reading_guide",
    ]);
    const bookStructure = plan.stages.find((stage) => stage.stage === "book_structure")!;
    expect(bookStructure.required_inputs.some((input) => input.endsWith("pass2_audit.json"))).toBe(false);
  });

  it("rejects stale canonical source hashes before planning projections", () => {
    const dir = tempDir();
    writeTrustedBook(dir, "Trusted source.\n");
    writeFileSync(path.join(dir, "source.txt"), "Changed source.\n", "utf8");

    expect(() => assertTrustedPaperProjectionSource(dir)).toThrow("canonical source hash");
  });

  it("plans projections from an explicitly accepted manual override while retaining residual diagnostics", () => {
    const dir = tempDir();
    writeTrustedBook(dir);
    writeJson(path.join(dir, ".build", "source-reconciliation", "report.json"), {
      ...trustedReport(),
      summary: { ...emptyReconciliationSummary(), needs_review: 1 },
      unresolved: [{ id: "block-1", status: "needs_review", reason: "manual review remained different" }],
      acceptance: {
        mode: "manual_override",
        policy: "single_review_then_override_v1",
        accepted_at: "2026-07-10T12:00:00.000Z",
        residual_unresolved_count: 1,
        decision_count: 1,
      },
    });

    const plan = buildPaperProjectionChainPlan(dir);
    const source = assertTrustedPaperProjectionSource(dir);

    expect(plan.source_truth_locked).toBe(true);
    expect(source.source_reconciliation_report.unresolved).toHaveLength(1);
    expect(source.source_reconciliation_report.acceptance?.mode).toBe("manual_override");
  });

  it("rejects unresolved source reconciliation reports", () => {
    const dir = tempDir();
    writeTrustedBook(dir);
    writeJson(path.join(dir, ".build", "source-reconciliation", "report.json"), {
      ...trustedReport(),
      summary: { ...emptyReconciliationSummary(), needs_review: 1 },
      unresolved: [{ id: "block-1", status: "needs_review", reason: "manual review required" }],
    });

    expect(() => buildPaperProjectionChainPlan(dir)).toThrow("unresolved blocks");
  });

  it("guards --run to the workspace .understand-book target used by existing batch scripts", () => {
    const dir = tempDir();
    writeTrustedBook(dir);
    const plan = buildPaperProjectionChainPlan(dir);

    expect(() => assertPaperProjectionWorkspaceTarget(plan, tempDir())).toThrow(".understand-book");
  });
});
