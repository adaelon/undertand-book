import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  AUTOMATIC_BUILD_RELEASE_V3,
  PROFILE_SIDECAR_POLICY_V2,
} from "../src/automatic-build-protocol";
import { parseAutomaticBuildStageCloseResult } from "../src/automatic-build-close";
import { automaticBuildProtocolDoctor } from "../../../skills/build/automatic-build";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-br10-release-"));
  const source = path.join(root, "release.md");
  writeFileSync(source, "# Release\n\nA deterministic semantic paragraph.\n", "utf8");
  return { root, source, workspace: path.join(root, ".understand-book", "release") };
}

function fileSnapshot(root: string): Array<{ path: string; body: string }> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { path: path.relative(root, file).replaceAll("\\", "/"), body: readFileSync(file, "utf8") };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

describe("BR10 automatic build release contract", () => {
  it("freezes v3 routing, recovery, quality, and close under one release identity", () => {
    expect(AUTOMATIC_BUILD_RELEASE_V3).toMatchObject({
      version: "automatic_build_release.v3",
      production_default: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      model_work_unit: "automatic_build_work_unit.v3",
      policy_set: "automatic_build_stage_policy_set.v2",
      policy_migration_receipt: "automatic_build_policy_migration_receipt.v1",
      recovery_envelope: "automatic_build_recovery.v1",
      quality_report: "automatic_build_stage_quality_report.v2",
      stage_batch_result: "automatic_build_stage_batch_result.v1",
      close_result: "automatic_build_stage_close_result.v1",
      close_success_next: "replan",
      model_input: {
        render_contract: "model_input_render.v1",
        estimator: "weighted_codepoint_estimator.v1",
      },
    });
    expect(AUTOMATIC_BUILD_RELEASE_V3.release_policy_members).toHaveLength(7);
    expect(new Set(AUTOMATIC_BUILD_RELEASE_V3.release_policy_members.map((member) => member.kind))).toEqual(
      new Set([
        "pass1_window",
        "pass1_source_slice",
        "pass1_lid_stitch",
        "profile_sidecar_discourse",
        "profile_sidecar_discourse_fragment",
        "profile_sidecar_discourse_reduce",
        "profile_sidecar_formula",
      ]),
    );
    const profilePrompt = readFileSync(
      path.join(REPO_ROOT, "agents", "profile-sidecar-extractor.md"),
      "utf8",
    );
    const profilePromptSha256 = createHash("sha256").update(profilePrompt).digest("hex");
    const profileMembers = AUTOMATIC_BUILD_RELEASE_V3.release_policy_members
      .filter((member) => member.prompt_name === "profile-sidecar-extractor.md");
    expect(profileMembers).toHaveLength(2);
    expect(profileMembers.every((member) => (
      member.stage_policy_version === PROFILE_SIDECAR_POLICY_V2.stage_policy_version
      && member.prompt_sha256 === profilePromptSha256
      && member.schema_version === PROFILE_SIDECAR_POLICY_V2.schema_version
    ))).toBe(true);
    const sidecarEntry = readFileSync(path.join(REPO_ROOT, "skills", "build", "sidecar-entry.ts"), "utf8");
    expect(sidecarEntry).toContain("profile-sidecar-extractor.md");
    expect(sidecarEntry).toContain("releaseValidatedPrompt");
  });

  it("audits every release policy member and reader without mutating the target", () => {
    const current = fixture();
    const before = fileSnapshot(current.workspace);
    const doctor = automaticBuildProtocolDoctor(current.source, current.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });

    expect(doctor).toMatchObject({
      version: "automatic_build_protocol_doctor.v3",
      status: "compatible",
      release: { version: "automatic_build_release.v3" },
      checks: {
        release_contract: {
          status: "compatible",
          policy_sets: [
            { stage: "pass1", members: expect.arrayContaining([
              expect.objectContaining({ kind: "pass1_window" }),
              expect.objectContaining({ kind: "pass1_source_slice" }),
              expect.objectContaining({ kind: "pass1_lid_stitch" }),
            ]) },
            { stage: "profile_sidecar", members: expect.arrayContaining([
              expect.objectContaining({ kind: "profile_sidecar_discourse" }),
              expect.objectContaining({ kind: "profile_sidecar_discourse_fragment" }),
              expect.objectContaining({ kind: "profile_sidecar_discourse_reduce" }),
              expect.objectContaining({ kind: "profile_sidecar_formula" }),
            ]) },
          ],
          model_input: {
            render_contract: "model_input_render.v1",
            estimator: "weighted_codepoint_estimator.v1",
            proven_members: 7,
          },
          readers: {
            recovery: { version: "automatic_build_recovery.v1", status: "compatible" },
            close: { version: "automatic_build_stage_close_result.v1", status: "compatible" },
          },
        },
        executor_bootstrap: {
          status: "compatible",
          session_protocol: "automatic_build_executor_session.v2",
          registration_scope: "agent_only",
        },
        root_tool_inventory: {
          status: "compatible",
          executor_tool_intersection: [],
        },
        connection_capability: { status: "compatible" },
      },
      target_state: { dry_run_mutates_state: false },
    });
    expect(doctor.checks.release_contract.policy_sets.flatMap((set) => set.members)).toHaveLength(7);
    expect(fileSnapshot(current.workspace)).toEqual(before);
  }, 30_000);

  it("strictly reads close results and rejects unknown or malformed fields", () => {
    const valid = {
      version: "automatic_build_stage_close_result.v1" as const,
      status: "closed" as const,
      stage: "pass1" as const,
      target: {
        book_id: "release-doctor",
        profile_id: "technical_learning" as const,
        input_fingerprint: "1".repeat(64),
      },
      quality: { report_digest: "2".repeat(64), gate_status: "passed" as const },
      publication: { transaction_id: "3".repeat(64), receipt_digest: "4".repeat(64) },
      postcondition: {
        stage_closed: true as const,
        policy_set_digest: "5".repeat(64),
        coverage_digest: "6".repeat(64),
        freshness_digest: "7".repeat(64),
        public_artifact_set_digest: "8".repeat(64),
      },
      next: "replan" as const,
    };
    expect(parseAutomaticBuildStageCloseResult(valid)).toEqual(valid);
    expect(() => parseAutomaticBuildStageCloseResult({ ...valid, next: "done" })).toThrow();
    expect(() => parseAutomaticBuildStageCloseResult({ ...valid, raw_error: "private" })).toThrow();
    expect(() => parseAutomaticBuildStageCloseResult({
      ...valid,
      postcondition: { ...valid.postcondition, freshness_digest: "not-a-digest" },
    })).toThrow();
  });
});
