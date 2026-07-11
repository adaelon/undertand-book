// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { BuildStageId, BuildWorkbenchSnapshot } from "./api";
import {
  chooseAppSurface,
  readSurfacePreference,
  writeSurfacePreference,
} from "./surface-selection";

const stages = [
  "source_reconciliation",
  "hybrid_foundation",
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
] as const satisfies readonly BuildStageId[];

function trustedPaperSnapshot(): BuildWorkbenchSnapshot {
  return {
    version: "build_workbench_snapshot.v1",
    book_id: "paper-a",
    readiness: {
      route: "reader",
      status: "trusted_book",
      reasons: [],
      stages: Object.fromEntries(stages.map((stage) => [stage, { stage, status: "done" }])) as
        BuildWorkbenchSnapshot["readiness"]["stages"],
    },
    input: {
      ready: true,
      manifest: {
        version: "workbench_input_manifest.v1",
        book_id: "paper-a",
        profile_id: "paper",
        display_title: "Paper A",
        created_at: "1",
        updated_at: "1",
        inputs: {
          paper_md: { path: "paper.md", sha256: "md", size_bytes: 1, source: "uploaded_text" },
          paper_pdf: { path: "paper.pdf", sha256: "pdf", size_bytes: 1, source: "uploaded_base64" },
        },
        config_hash: "cfg",
        fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "cfg" },
        trusted: false,
      },
      fingerprint: { paper_md_sha256: "md", paper_pdf_sha256: "pdf", config_hash: "cfg" },
    },
    jobs: [],
    source_review: {
      report: null,
      unresolved: [],
      review_draft_markdown: null,
      decisions: null,
      ready_for_rerun: false,
    },
    sidecar_plan: { plan: null, form_draft: null, build_spec: null },
    operations: {
      warnings: [],
      permission_audit: [],
      retention: { max_jobs: 20, max_events_per_job: 200, max_permission_audit_entries: 200 },
    },
  };
}

describe("reader surface selection", () => {
  it("keeps the visible Workbench after reader trust becomes available", () => {
    expect(chooseAppSurface(trustedPaperSnapshot(), "workbench", null)).toBe("workbench");
  });

  it("defaults a trusted paper to reader but restores an explicit session choice", () => {
    const snapshot = trustedPaperSnapshot();
    expect(chooseAppSurface(snapshot, "loading", null)).toBe("reader");
    expect(chooseAppSurface(snapshot, "loading", "workbench")).toBe("workbench");
  });

  it("stores the choice per book for the current browser session", () => {
    writeSurfacePreference(sessionStorage, "paper-a", "workbench");
    writeSurfacePreference(sessionStorage, "paper-b", "reader");
    expect(readSurfacePreference(sessionStorage, "paper-a")).toBe("workbench");
    expect(readSurfacePreference(sessionStorage, "paper-b")).toBe("reader");
  });
});
