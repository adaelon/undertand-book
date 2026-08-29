import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAutomaticBuildJson,
  AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  AUTOMATIC_BUILD_PROTOCOL_V2,
  AUTOMATIC_BUILD_RELEASE_V1,
  AUTOMATIC_BUILD_RELEASE_V2,
} from "../src/automatic-build-protocol";
import {
  automaticBuildNext,
  automaticBuildPlan,
  automaticBuildProtocolDoctor,
} from "../../../skills/build/automatic-build";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-bp8-release-"));
  const source = path.join(root, "guide.md");
  writeFileSync(source, "# Guide\n\nA deterministic semantic paragraph.\n", "utf8");
  return { root, source };
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

describe("automatic build BP8 production release", () => {
  it("keeps the previous release readable and makes dispatch the new claim default", () => {
    expect(AUTOMATIC_BUILD_RELEASE_V1).toEqual({
      version: "automatic_build_release.v1",
      production_default: "automatic_build_protocol.v2",
      parallel_dispatch_protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      legacy_protocol: AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
      max_workers: 3,
      candidate_handoff: "executor_owned_task_mailbox",
      exact_usage_policy: "receipt_or_unknown",
      legacy_policy: "explicit_legacy_resume_or_v2_rebuild",
    });
    expect(AUTOMATIC_BUILD_PRODUCTION_DEFAULT).toBe(AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1);
    expect(AUTOMATIC_BUILD_RELEASE_V2).toMatchObject({
      version: "automatic_build_release.v2",
      production_default: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      new_claim_protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      readable_protocols: [
        AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
        AUTOMATIC_BUILD_PROTOCOL_V2,
        AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
      ],
      rollback: {
        protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
        artifact_migration: "none",
        task_state_rewrite: "none",
      },
    });
  });

  it("emits canonical JSON with recursively sorted object keys", () => {
    expect(canonicalAutomaticBuildJson({ z: 1, a: { d: 4, b: 2 }, c: [2, { y: 1, x: 0 }] }))
      .toBe('{"a":{"b":2,"d":4},"c":[2,{"x":0,"y":1}],"z":1}\n');
  });

  it("defaults accepted work to dispatch while preserving explicit v2 task resume", () => {
    const current = fixture();
    const currentBuildPlan = confirmedStandardBuildPlan(current.source, current.root);
    const currentPlan = automaticBuildPlan(current.source, current.root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: currentBuildPlan,
    });
    if (!currentPlan.preflight) throw new Error("expected current preflight");
    expect(currentPlan.protocol).toBe(AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1);
    const currentNext = automaticBuildNext(current.source, current.root, 1, {
      accepted_plan_digest: currentPlan.preflight.plan_digest,
      available_agent_slots: 1,
      now: "2026-07-25T09:00:00.000Z",
      build_plan: currentBuildPlan,
    });
    expect(currentNext).toMatchObject({
      protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      action: { kind: "dispatch" },
    });
    expect(existsSync(path.join(
      current.root,
      ".understand-book",
      "guide",
      ".build",
      "automatic-build",
      "v2",
      "tasks",
    ))).toBe(false);

    const rollback = fixture();
    const rollbackBuildPlan = confirmedStandardBuildPlan(rollback.source, rollback.root);
    const rollbackPlan = automaticBuildPlan(rollback.source, rollback.root, {
      requested_workers: 1,
      build_plan: rollbackBuildPlan,
    });
    if (!rollbackPlan.preflight) throw new Error("expected rollback preflight");
    const rollbackNext = automaticBuildNext(rollback.source, rollback.root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      accepted_plan_digest: rollbackPlan.preflight.plan_digest,
      available_agent_slots: 1,
      owner: "bp8-rollback-owner",
      now: "2026-07-25T09:00:00.000Z",
      build_plan: rollbackBuildPlan,
    });
    expect(rollbackNext).toMatchObject({
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      action: { kind: "extract", tasks: [{ lease: { version: "automatic_build_task_lease.v2" } }] },
    });
  });

  it("audits existing v2 task state without mutating it", () => {
    const { root, source } = fixture();
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, { requested_workers: 1, build_plan: buildPlan });
    if (!plan.preflight) throw new Error("expected doctor preflight");
    automaticBuildNext(source, root, 1, {
      protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
      accepted_plan_digest: plan.preflight.plan_digest,
      owner: "bp8-existing-v2-owner",
      now: "2026-07-25T09:00:00.000Z",
      build_plan: buildPlan,
    });
    const workspace = path.join(root, ".understand-book", "guide");
    const before = fileSnapshot(workspace);
    const doctor = automaticBuildProtocolDoctor(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    expect(doctor).toMatchObject({
      version: "automatic_build_protocol_doctor.v3",
      status: "compatible",
      checks: {
        prompt_provider: {
          status: "compatible",
          source: "node_source",
          checked_extractors: [
            "pass1-local-extractor.md",
            "paper-metadata-extractor.md",
            "paper-lexicon-extractor.md",
            "profile-sidecar-extractor.md",
            "pass1-source-fragment-extractor.md",
            "pass1-lid-stitcher.md",
            "profile-sidecar-discourse-fragment-extractor.md",
            "profile-sidecar-discourse-reducer.md",
            "pass2-longrange-linker.md",
            "book-structure-extractor.md",
            "book-structure-v2-extractor.md",
            "book-structure-fragment-extractor.md",
            "book-structure-reducer.md",
            "book-structure-stitch-fragment-extractor.md",
            "book-structure-stitch-reducer.md",
          ],
        },
        handoff_preparation: {
          status: "compatible",
          byte_length: expect.any(Number),
        },
        plugin_shape: {
          status: "compatible",
          thin_plugin: false,
          agents_required: false,
        },
        executor_bootstrap: {
          status: "compatible",
          session_protocol: "automatic_build_executor_session.v2",
          registration_scope: "agent_only",
          sandbox_mode: "read-only",
        },
        root_tool_inventory: {
          status: "compatible",
          server_registered: false,
          executor_tool_intersection: [],
        },
        connection_capability: {
          status: "compatible",
          model_parameter: false,
          cross_handoff_rejected: true,
          session_private_root_bound: true,
        },
      },
      production_default: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      target_state: {
        persisted_task_attempts: 1,
        current_execution_identities: 1,
        dry_run_mutates_state: false,
      },
    });
    expect(fileSnapshot(workspace)).toEqual(before);
  }, 20_000);

  it("reports an unavailable packaged prompt provider as incompatible without mutating state", () => {
    const { root, source } = fixture();
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const workspace = path.join(root, ".understand-book", "guide");
    const before = fileSnapshot(workspace);
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = path.join(root, "missing-understand-book-build.exe");
    try {
      const doctor = automaticBuildProtocolDoctor(source, root, {
        requested_workers: 1,
        available_agent_slots: 1,
        build_plan: buildPlan,
      });
      expect(doctor).toMatchObject({
        version: "automatic_build_protocol_doctor.v3",
        status: "incompatible",
        checks: {
          prompt_provider: {
            status: "incompatible",
            source: "packaged_sidecar",
            diagnostic_code: "prompt_provider_unavailable",
          },
          handoff_preparation: {
            status: "incompatible",
            diagnostic_code: "prompt_provider_unavailable",
          },
          plugin_shape: {
            status: "incompatible",
            agents_required: false,
            agent_template_present: false,
            diagnostic_code: "plugin_shape_incompatible",
          },
          executor_bootstrap: {
            status: "incompatible",
            diagnostic_code: "executor_bootstrap_incompatible",
          },
        },
        target_state: { dry_run_mutates_state: false },
      });
      expect(fileSnapshot(workspace)).toEqual(before);
      expect(JSON.stringify(doctor)).not.toContain("missing-understand-book-build.exe");
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("keeps the Codex manifest on one cachebuster suffix", () => {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe("understand-book");
    expect(manifest.version).toMatch(/^0\.1\.0\+codex\.[0-9A-Za-z.-]+$/);
    expect((manifest.version.match(/\+codex\./g) ?? [])).toHaveLength(1);
  });
});
