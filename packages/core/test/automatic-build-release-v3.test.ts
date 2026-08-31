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
import {
  automaticBuildProtocolDoctor,
  validateAutomaticBuildProtocolDoctorBoundaryV3,
} from "../../../skills/build/automatic-build";

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

type DoctorBoundaryInput = Parameters<typeof validateAutomaticBuildProtocolDoctorBoundaryV3>[0];
type DoctorBoundaryCheck = keyof ReturnType<
  typeof validateAutomaticBuildProtocolDoctorBoundaryV3
>["checks"];

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function mutateSharedMcpProjection(
  input: DoctorBoundaryInput,
  mutate: (server: Record<string, unknown>, servers: Record<string, unknown>) => void,
): DoctorBoundaryInput {
  const parsed = mutableRecord(JSON.parse(input.plugin_mcp_projections[0]), "plugin MCP config");
  const servers = mutableRecord(parsed.mcpServers, "plugin MCP servers");
  const server = mutableRecord(servers.understand_book_build_executor, "shared Executor server");
  mutate(server, servers);
  const projection = JSON.stringify(parsed);
  return {
    ...input,
    plugin_mcp_projections: input.plugin_mcp_projections.map(() => projection),
  };
}

function firstReleasePolicyMember(releaseContract: unknown): Record<string, unknown> {
  const release = mutableRecord(releaseContract, "release contract");
  const policySets = release.policy_sets;
  if (!Array.isArray(policySets) || policySets.length === 0) throw new Error("release policy set is missing");
  const policySet = mutableRecord(policySets[0], "release policy set");
  const members = policySet.members;
  if (!Array.isArray(members) || members.length === 0) throw new Error("release policy member is missing");
  return mutableRecord(members[0], "release policy member");
}

function boundaryFixture(): DoctorBoundaryInput {
  const current = fixture();
  const doctor = automaticBuildProtocolDoctor(current.source, current.root, {
    requested_workers: 1,
    available_agent_slots: 1,
  });
  if (doctor.status !== "compatible") throw new Error("base R5 doctor fixture must be compatible");
  return {
    agent_template: readFileSync(
      path.join(REPO_ROOT, "assets", "codex-agents", "understand-book-executor.toml"),
      "utf8",
    ),
    plugin_mcp_projections: [
      readFileSync(path.join(REPO_ROOT, ".mcp.json"), "utf8"),
      readFileSync(path.join(REPO_ROOT, "plugins", "understand-book", ".mcp.json"), "utf8"),
    ],
    launcher_projections: [
      readFileSync(path.join(REPO_ROOT, "scripts", "start-build-executor-mcp.cmd"), "utf8"),
      readFileSync(
        path.join(REPO_ROOT, "plugins", "understand-book", "scripts", "start-build-executor-mcp.cmd"),
        "utf8",
      ),
    ],
    release_contract: doctor.checks.release_contract,
  };
}

const R5_BOUNDARY_FAILURES: Array<[
  string,
  DoctorBoundaryCheck,
  (input: DoctorBoundaryInput) => DoctorBoundaryInput,
]> = [
  ["missing root-shared scope", "shared_executor_mcp", (input) => mutateSharedMcpProjection(
    input,
    (_server, servers) => { delete servers.understand_book_build_executor; },
  )],
  ["required shared server", "shared_executor_mcp", (input) => mutateSharedMcpProjection(
    input,
    (server) => { server.required = true; },
  )],
  ["non-exact tool allowlist", "shared_executor_mcp", (input) => mutateSharedMcpProjection(
    input,
    (server) => { server.enabled_tools = ["executor.open"]; },
  )],
  ["bootstrap version mismatch", "shared_executor_mcp", (input) => ({
    ...input,
    launcher_projections: input.launcher_projections.map((projection) => (
      projection.replace("automatic_build_executor_bootstrap.v3", "automatic_build_executor_bootstrap.v2")
    )),
  })],
  ["session version mismatch", "shared_executor_mcp", (input) => ({
    ...input,
    launcher_projections: input.launcher_projections.map((projection) => (
      projection.replace("automatic_build_executor_session.v3", "automatic_build_executor_session.v2")
    )),
  })],
  ["launcher path mismatch", "shared_executor_mcp", (input) => mutateSharedMcpProjection(
    input,
    (server) => { server.args = ["/d", "/s", "/c", "scripts\\wrong-launcher.cmd"]; },
  )],
  ["role-local MCP block", "executor_role", (input) => ({
    ...input,
    agent_template: `${input.agent_template}\n[mcp_servers.understand_book_build_executor]\n`,
  })],
  ["budget proof identity field", "semantic_reuse_identity", (input) => {
    const releaseContract = structuredClone(input.release_contract);
    firstReleasePolicyMember(releaseContract).proof_digest = true;
    return { ...input, release_contract: releaseContract };
  }],
  ["missing explicit policy generation", "semantic_reuse_identity", (input) => {
    const releaseContract = structuredClone(input.release_contract);
    delete firstReleasePolicyMember(releaseContract).policy_generation_id;
    return { ...input, release_contract: releaseContract };
  }],
  ["direct projection text mismatch", "shared_executor_mcp", (input) => ({
    ...input,
    plugin_mcp_projections: [input.plugin_mcp_projections[0], `${input.plugin_mcp_projections[1]}\n`],
  })],
];

describe("BR10 automatic build release contract", () => {
  it("freezes v3 routing, recovery, quality, and close under one release identity", () => {
    expect(AUTOMATIC_BUILD_RELEASE_V3).toMatchObject({
      version: "automatic_build_release.v3",
      production_default: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      model_work_unit: "automatic_build_work_unit.v3",
      policy_set: "automatic_build_stage_policy_set.v3",
      policy_migration_receipt: "automatic_build_policy_migration_receipt.v2",
      recovery_envelope: "automatic_build_recovery.v1",
      quality_report: "automatic_build_stage_quality_report.v2",
      stage_batch_result: "automatic_build_stage_batch_result.v1",
      close_result: "automatic_build_stage_close_result.v2",
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

  it("R1 audits release policy readers through the shared Executor boundary without mutation", () => {
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
            close: { version: "automatic_build_stage_close_result.v2", status: "compatible" },
          },
        },
        executor_role: {
          status: "compatible",
          agent_name: "understand_book_executor",
          mcp_servers_in_role: 0,
        },
        shared_executor_mcp: {
          status: "compatible",
          registration_scope: "root_shared",
          bootstrap_version: "automatic_build_executor_bootstrap.v3",
          session_protocol: "automatic_build_executor_session.v3",
          required: false,
          default_tools_approval_mode: "approve",
          executor_tool_count: 4,
        },
        connection_integrity: {
          status: "compatible",
          model_parameter: false,
          caller_role_authenticated: false,
          cross_handoff_rejected: true,
          session_private_root_bound: true,
          forbidden_digest_field_count: 0,
        },
        semantic_reuse_identity: {
          status: "compatible",
          budget_proof_is_freshness_identity: false,
          policy_generation_is_explicit: true,
          large_content_hash_consumers_present: true,
        },
      },
      target_state: { dry_run_mutates_state: false },
    });
    // R1_RED action: R5 makes the release doctor describe the shared V3 boundary truthfully.
    expect(doctor.checks.release_contract.policy_sets.flatMap((set) => set.members)).toHaveLength(7);
    expect(fileSnapshot(current.workspace)).toEqual(before);
  }, 30_000);

  it.each(R5_BOUNDARY_FAILURES)(
    "R5 fails closed on %s without a digest-tamper fixture",
    (_label, failedCheck, mutate) => {
      const result = validateAutomaticBuildProtocolDoctorBoundaryV3(mutate(boundaryFixture()));
      expect(result.status).toBe("incompatible");
      expect(result.checks[failedCheck].status).toBe("incompatible");
    },
    30_000,
  );

  it("R5 keeps both release smoke evidence shapes shared, exact-four, and digest-free", () => {
    const compiledSmoke = readFileSync(
      path.join(REPO_ROOT, "apps", "desktop", "scripts", "smoke-t7-executor-release.ts"),
      "utf8",
    );
    const codexCliSmoke = readFileSync(
      path.join(REPO_ROOT, "apps", "desktop", "scripts", "smoke-t7-codex-cli-release.ts"),
      "utf8",
    );
    expect(compiledSmoke).toContain('"--bootstrap-version"');
    expect(compiledSmoke).toContain('version: "automatic_build_executor_open_request.v3"');
    expect(compiledSmoke).toContain("transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2");
    expect(compiledSmoke).toContain("capability_isolation: false");
    expect(compiledSmoke).toContain(
      "caller_role_authenticated: BUILD_EXECUTOR_MCP_CONTRACT_V3.caller_role_authenticated",
    );
    expect(compiledSmoke).toContain("forbidden_digest_field_count: 0");

    expect(codexCliSmoke).toContain("executor_server_present: true");
    expect(codexCliSmoke).toContain("executor_tool_count: installedSharedMcp.tool_names.length");
    expect(codexCliSmoke).toContain("capability_isolation: false");
    expect(codexCliSmoke).toContain("caller_role_authenticated: false");
    expect(codexCliSmoke).toContain("forbidden_digest_field_count: 0");
    expect(codexCliSmoke).not.toMatch(/^\s*executor_tool_intersection\s*:/mu);
    expect(codexCliSmoke).not.toMatch(/^\s*executor_server_present\s*:\s*false/mu);

    const forbiddenEvidenceProperty = /^\s*(?:transport_profile_digest|compiled_sidecar_sha256|manifest_sha256|skill_sha256|root_final_sha256)\s*:/mu;
    expect(compiledSmoke).not.toMatch(forbiddenEvidenceProperty);
    expect(codexCliSmoke).not.toMatch(forbiddenEvidenceProperty);
  });

  it("strictly reads close results and rejects unknown or malformed fields", () => {
    const valid = {
      version: "automatic_build_stage_close_result.v2" as const,
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
        policy_contracts: [{
          kind: "pass1_window",
          policy_generation_id: "release-policy-generation",
          semantic_contract: {
            profile_version: "technical_learning.v1",
            stage_policy_version: "pass1.v1",
            router_version: "pass1-router.v1",
            prompt_sha256: "5".repeat(64),
            schema_version: "pass1_output.v1",
            quality_profile: "full" as const,
          },
        }],
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
