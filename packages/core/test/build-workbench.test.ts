import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_STAGE_DAG,
  createBuildJob,
  detectBuildReadiness,
  makeBuildJobId,
  readBuildWorkbenchSnapshot,
  requestBuildDecision,
  requestExecutorPermission,
  resolveBuildDecision,
  resolveExecutorPermission,
  reuseOrCreateBuildJob,
  setActiveExecutor,
  type BuildJobState,
  type BuildWorkbenchSnapshot,
} from "../src/build-workbench";
import { buildSourceManifestV2, type SourceManifestV2 } from "../src/source-manifest";
import {
  emptyReconciliationSummary,
  sha256Text,
  type BuildInputFingerprint,
  type SourceReconciliationReport,
} from "../src/source-reconciliation";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-workbench-"));
}

function fingerprint(overrides: Partial<BuildInputFingerprint> = {}): BuildInputFingerprint {
  return {
    paper_md_sha256: "sha-md",
    paper_pdf_sha256: "sha-pdf",
    config_hash: "cfg-a",
    ...overrides,
  };
}

function trustedReport(inputFingerprint = fingerprint()): SourceReconciliationReport {
  return {
    version: "source_reconciliation_report.v1",
    book_id: "paper-a",
    input_fingerprint: inputFingerprint,
    summary: { ...emptyReconciliationSummary(), verified: 1 },
    unresolved: [],
  };
}

function reviewReport(inputFingerprint = fingerprint()): SourceReconciliationReport {
  return {
    ...trustedReport(inputFingerprint),
    summary: { ...emptyReconciliationSummary(), needs_review: 1 },
    unresolved: [{ id: "block-1", status: "needs_review", reason: "number mismatch" }],
  };
}

function manifest(source: string, overrides: Partial<SourceManifestV2> = {}): SourceManifestV2 {
  return {
    ...buildSourceManifestV2({
      book_id: "paper-a",
      source_sha256: sha256Text(source),
      original_pdf_path: "paper.pdf",
      original_pdf_sha256: "sha-pdf",
      pdf_source_map_path: "pdf_source_map.json",
      pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
      alignment_report_path: "alignment_report.json",
      config_hash: "cfg-a",
      capability_overrides: {
        project_lid_to_pdf: {
          status: "degraded",
          reason: "line fallback only",
          artifact_path: "pdf_source_map.json",
          report_path: "alignment_report.json",
          config_hash: "cfg-a",
        },
        project_ranges_to_pdf: {
          status: "degraded",
          reason: "line fallback only",
          artifact_path: "pdf_source_map.json",
          report_path: "alignment_report.json",
          config_hash: "cfg-a",
        },
      },
    }),
    ...overrides,
  };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function writeTrustedBook(dir: string, source = "Trusted text.\n"): void {
  writeFileSync(path.join(dir, "source.txt"), source, "utf8");
  writeJson(path.join(dir, "base.json"), { book_id: "paper-a", lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(dir, "source_manifest.json"), manifest(source));
  writeJson(path.join(dir, ".build", "source-reconciliation", "report.json"), trustedReport());
  writeJson(path.join(dir, "pdf_source_map.json"), { version: "pdf_source_map.v1", config_hash: "cfg-a" });
  writeJson(path.join(dir, "pdf_selection_map", "manifest.json"), { version: "pdf_selection_map.v1", config_hash: "cfg-a" });
  writeJson(path.join(dir, "alignment_report.json"), { version: "alignment_report.v1", config_hash: "cfg-a" });
}

describe("PH6 Build Workbench readiness", () => {
  it("keeps the stage DAG explicit and ordered through paper projection follow-ups", () => {
    expect(BUILD_STAGE_DAG.hybrid_foundation.depends_on).toEqual(["source_reconciliation"]);
    expect(BUILD_STAGE_DAG.pass1.depends_on).toEqual(["hybrid_foundation"]);
    expect(BUILD_STAGE_DAG.paper_metadata.depends_on).toEqual(["pass1"]);
    expect(BUILD_STAGE_DAG.paper_lexicon.depends_on).toEqual(["pass1"]);
    expect(BUILD_STAGE_DAG.pass2.depends_on).toEqual(["profile_sidecar"]);
    expect(BUILD_STAGE_DAG.paper_reading_guide.depends_on).toEqual(["book_structure"]);
  });

  it("routes missing source foundation to Build Workbench", () => {
    const readiness = detectBuildReadiness({ book_id: "paper-a", base_exists: false, current_input_fingerprint: fingerprint() });

    expect(readiness.route).toBe("workbench");
    expect(readiness.status).toBe("missing");
    expect(readiness.stages.source_reconciliation.status).toBe("missing");
    expect(readiness.reasons).toContain("trusted source foundation is missing");
  });

  it("routes review-required reconciliation to Build Workbench and does not bless job state as artifact truth", () => {
    const snapshot: BuildWorkbenchSnapshot = {
      book_id: "paper-a",
      current_input_fingerprint: fingerprint(),
      source_reconciliation_report: reviewReport(),
      source_txt_sha256: sha256Text("The measured value is 42 mg.\n"),
      source_manifest: manifest("The measured value is 42 mg.\n"),
      base_exists: true,
    };
    const readiness = detectBuildReadiness(snapshot);

    expect(readiness.route).toBe("workbench");
    expect(readiness.status).toBe("needs_review");
    expect(readiness.stages.source_reconciliation.status).toBe("needs_review");
    expect(readiness.stages.hybrid_foundation.status).toBe("blocked");
  });

  it("treats an explicit manual override as an accepted source stage while retaining residual diagnostics", () => {
    const source = "The measured value is 42 mg.\n";
    const readiness = detectBuildReadiness({
      book_id: "paper-a",
      current_input_fingerprint: fingerprint(),
      source_reconciliation_report: {
        ...reviewReport(),
        acceptance: {
          mode: "manual_override",
          policy: "single_review_then_override_v1",
          accepted_at: "2026-07-10T12:00:00.000Z",
          residual_unresolved_count: 1,
          decision_count: 1,
        },
      },
      source_txt_sha256: sha256Text(source),
      source_manifest: manifest(source),
      base_exists: true,
      pdf_source_map: { config_hash: "cfg-a" },
      pdf_selection_map: { config_hash: "cfg-a" },
      alignment_report: { config_hash: "cfg-a" },
    });

    expect(readiness.stages.source_reconciliation.status).toBe("done");
    expect(readiness.stages.hybrid_foundation.status).toBe("done");
    expect(readiness.route).toBe("reader");
  });

  it("routes stale input fingerprints to Build Workbench", () => {
    const readiness = detectBuildReadiness({
      book_id: "paper-a",
      current_input_fingerprint: fingerprint({ paper_md_sha256: "sha-md-new" }),
      source_reconciliation_report: trustedReport(),
      base_exists: true,
    });

    expect(readiness.route).toBe("workbench");
    expect(readiness.status).toBe("stale_input");
    expect(readiness.stages.source_reconciliation.status).toBe("stale");
  });

  it("routes trusted source/map foundation to reader even when derived paper projection stages are absent", () => {
    const dir = tempDir();
    writeTrustedBook(dir);
    const readiness = detectBuildReadiness(readBuildWorkbenchSnapshot(dir, { current_input_fingerprint: fingerprint() }));

    expect(readiness.route).toBe("reader");
    expect(readiness.status).toBe("trusted_book");
    expect(readiness.stages.source_reconciliation.status).toBe("done");
    expect(readiness.stages.hybrid_foundation.status).toBe("done");
    expect(readiness.stages.paper_metadata.status).toBe("missing");
  });

  it("detects stale hybrid foundation hashes before reader entry", () => {
    const dir = tempDir();
    writeTrustedBook(dir, "Trusted text.\n");
    writeFileSync(path.join(dir, "source.txt"), "Trusted text changed.\n", "utf8");
    const readiness = detectBuildReadiness(readBuildWorkbenchSnapshot(dir, { current_input_fingerprint: fingerprint() }));

    expect(readiness.route).toBe("workbench");
    expect(readiness.status).toBe("stale_input");
    expect(readiness.stages.hybrid_foundation.status).toBe("stale");
  });
});

describe("PH6 BuildJob orchestration shell", () => {
  const now = "2026-07-09T00:00:00.000Z";

  it("uses deterministic job ids and reuses incomplete jobs for identical inputs", () => {
    const job = createBuildJob("paper-a", fingerprint(), now);
    const reused = reuseOrCreateBuildJob("paper-a", fingerprint(), [job], "2026-07-09T00:01:00.000Z");

    expect(job.job_id).toBe(makeBuildJobId("paper-a", fingerprint()));
    expect(reused.reused).toBe(true);
    expect(reused.job.job_id).toBe(job.job_id);
    expect(reused.job.events.at(-1)?.type).toBe("job_reused");
  });

  it("marks old jobs stale and creates a fresh job when input fingerprint changes", () => {
    const oldJob = createBuildJob("paper-a", fingerprint(), now);
    const nextFingerprint = fingerprint({ paper_pdf_sha256: "sha-pdf-new" });
    const result = reuseOrCreateBuildJob("paper-a", nextFingerprint, [oldJob], "2026-07-09T00:02:00.000Z");

    expect(result.reused).toBe(false);
    expect(result.job.input_fingerprint).toEqual(nextFingerprint);
    expect(result.stale_jobs).toHaveLength(1);
    expect(result.stale_jobs[0].status).toBe("stale_input");
    expect(result.stale_jobs[0].events.at(-1)?.type).toBe("job_marked_stale");
  });

  it("records active executor telemetry, build decisions, and executor permissions as separate event streams", () => {
    let job: BuildJobState = createBuildJob("paper-a", fingerprint(), now);
    job = setActiveExecutor(
      job,
      {
        run_id: "run-1",
        stage: "source_reconciliation",
        executor: "codex",
        telemetry: { command: "source-reconcile", tokens_used: 120 },
      },
      "2026-07-09T00:03:00.000Z",
    );
    job = requestBuildDecision(
      job,
      {
        decision_id: "decision-1",
        stage: "source_reconciliation",
        kind: "source_reconciliation_mode",
        prompt: "Choose review mode",
        options: [{ id: "manual", label: "Manual" }],
      },
      "2026-07-09T00:04:00.000Z",
    );
    job = requestExecutorPermission(
      job,
      {
        request_id: "perm-1",
        run_id: "run-1",
        executor: "codex",
        category: "shell_command",
        action_summary: "run source reconciliation CLI",
        scope_hint: "stage",
      },
      "2026-07-09T00:05:00.000Z",
    );
    job = resolveBuildDecision(job, "decision-1", "manual", "2026-07-09T00:06:00.000Z");
    job = resolveExecutorPermission(job, "perm-1", true, "2026-07-09T00:07:00.000Z");

    expect(job.active_run?.telemetry?.tokens_used).toBe(120);
    expect(job.decision_requests).toMatchObject([{ decision_id: "decision-1", status: "answered", answer: "manual" }]);
    expect(job.permission_requests).toMatchObject([{ request_id: "perm-1", status: "granted" }]);
    expect(job.status).toBe("ready");
    expect(job.events.map((event) => event.type)).toEqual([
      "job_created",
      "executor_started",
      "decision_requested",
      "permission_requested",
      "decision_resolved",
      "permission_resolved",
    ]);
  });
});
