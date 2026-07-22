import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runBindingOwnershipAuditCli } from "../scripts/run-binding-ownership-audit";

const FIXTURE = path.resolve(fileURLToPath(new URL(
  "fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-binding-ownership-audit.json",
  import.meta.url,
)));

describe("PR18 binding ownership audit", () => {
  it("requires explicit approved inputs", async () => {
    await expect(runBindingOwnershipAuditCli([])).rejects.toThrow("--source requires an explicit path");
  });

  it("freezes conflict ownership without source text", () => {
    const reportText = readFileSync(FIXTURE, "utf8");
    const report = JSON.parse(reportText);

    expect(createHash("sha256").update(reportText).digest("hex"))
      .toBe("ae431d40eebfcd47574c01172fdd0b346d6da89c21f523f7a6f34404a5c38e8a");
    expect(Buffer.byteLength(reportText)).toBe(6_228);
    expect(report).toMatchObject({
      version: "binding_ownership_audit.v1",
      policy_version: "pdf_binding_ownership_policy.v1",
      source_sha256: "feb442870b9364e578c22b210b1ac6ed9ce098f59bd39ceb07806c741715af43",
      passed: true,
      summary: {
        competing_region_binding_count: 0,
        competing_selection_binding_count: 15,
        resolved_duplicate_region_binding_count: 0,
        resolved_duplicate_selection_binding_count: 0,
        conflict_group_count: 2,
        unique_owner_group_count: 2,
        ambiguous_group_count: 0,
        rejected_candidate_count: 2,
        formal_duplicate_region_binding_count: 0,
        formal_duplicate_selection_binding_count: 0,
        invalid_rejection_count: 0,
        unaudited_rejection_projection_count: 0,
        legacy_a009_count: 11,
        legacy_a009_classification_counts: {
          reviewed_content_drift: 1,
          reviewed_removed: 6,
          stable_ambiguous_binding: 1,
          unique_owner: 3,
        },
      },
    });
    expect(reportText).not.toMatch(/source_text|raw_quote|excerpt/u);
  });
});
