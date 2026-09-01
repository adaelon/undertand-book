import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
  validateBuildExecutorRoleConfigV3,
} from "../src/build-executor-connection-capability";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR_AGENT_DESCRIPTION =
  "Execute exactly one Understand Book opaque handoff through the packaged executor session protocol.";
const EXECUTOR_SKILL_PROHIBITION =
  "Do not activate `$understand-book-build`, `$understand-book-executor`, or any other skill; "
  + "this role already carries the complete bootstrap contract.";
const EXECUTOR_MCP_ONLY =
  "Use only the four tools on the dedicated `understand_book_build_executor` MCP connection.";
const EXECUTOR_SERVER_NAME = "understand_book_build_executor";
const EXECUTOR_TOOL_NAMES = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const;

const PROJECT_AGENT = ".codex/agents/understand-book-executor.toml";
const ROOT_AGENT_TEMPLATE = "assets/codex-agents/understand-book-executor.toml";
const RELEASE_AGENT_TEMPLATE =
  "plugins/understand-book/assets/codex-agents/understand-book-executor.toml";
const ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE =
  "assets/codex-agents/understand-book-executor.known-predecessor.toml";
const RELEASE_KNOWN_PREDECESSOR_AGENT_TEMPLATE =
  "plugins/understand-book/assets/codex-agents/understand-book-executor.known-predecessor.toml";
const TARGET_AGENT_VERSION = "automatic_build_executor_session.v3";
const ROOT_REGISTER_SCRIPT = "scripts/register-executor-agent.ps1";
const RELEASE_REGISTER_SCRIPT = "plugins/understand-book/scripts/register-executor-agent.ps1";
const ROOT_REGISTER_SKILL = "skills/register-executor/SKILL.md";
const RELEASE_REGISTER_SKILL = "plugins/understand-book/skills/register-executor/SKILL.md";
const ROOT_EXECUTOR_SKILL = "skills/executor/SKILL.md";
const RELEASE_EXECUTOR_SKILL = "plugins/understand-book/skills/executor/SKILL.md";
const ROOT_BUILD_SKILL = "skills/build/SKILL.md";
const RELEASE_BUILD_SKILL = "plugins/understand-book/skills/build/SKILL.md";
const RELEASE_ASSERTION = "apps/desktop/scripts/assert-plugin-release.mjs";
const ROOT_SHARED_MCP_CONFIGS = [
  ".mcp.json",
  "plugins/understand-book/.mcp.json",
] as const;
const ROOT_EXECUTOR_MCP_LAUNCHER = "scripts/start-build-executor-mcp.cmd";
const RELEASE_EXECUTOR_MCP_LAUNCHER =
  "plugins/understand-book/scripts/start-build-executor-mcp.cmd";
const EXECUTOR_AGENT_ASSETS = [
  PROJECT_AGENT,
  ROOT_AGENT_TEMPLATE,
  RELEASE_AGENT_TEMPLATE,
] as const;

function absolute(relativePath: string): string {
  return path.join(REPO_ROOT, ...relativePath.split("/"));
}

function expectFiles(relativePaths: string[]): void {
  const missing = relativePaths.filter((relativePath) => !existsSync(absolute(relativePath)));
  expect(missing, `missing executor bootstrap publication assets: ${missing.join(", ")}`).toEqual([]);
}

function readText(relativePath: string): string {
  return readFileSync(absolute(relativePath), "utf8");
}

function readOptionalText(relativePath: string): string {
  const file = absolute(relativePath);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function normalizeContract(text: string): string {
  return text.replace(/\r\n?|\n/gu, "\n").replace(/\n+$/u, "");
}

function expectedDeveloperInstructionsAssignment(wrapper: string): string {
  const escaped = normalizeContract(wrapper).replace(/\\/gu, "\\\\");
  return `developer_instructions = """\n${escaped}\n"""`;
}

function skillBody(skill: string): string {
  const normalized = skill.replace(/\r\n?/gu, "\n");
  expect(normalized.startsWith("---\n"), "executor skill must start with YAML frontmatter").toBe(true);
  const closing = normalized.indexOf("\n---\n", 4);
  expect(closing, "executor skill frontmatter must have a closing delimiter").toBeGreaterThan(0);
  return normalizeContract(normalized.slice(closing + 5));
}

function roleOnlyV3Config(): string {
  return `name = "understand_book_executor"
sandbox_mode = "read-only"
approval_policy = "never"
web_search = "disabled"
tools.view_image = false
skills.config = []
developer_instructions = """
# Automatic Build Executor Session Protocol
Protocol version: \`automatic_build_executor_session.v3\`.
Process exactly one code-issued \`opaque_handoff_ref\`.
Call \`executor.open\`, \`executor.input.next\`, \`executor.generation.start\`, and
\`executor.submit_candidate\` in the canonical loop.
Handle action.kind=DELIVER_INPUT, action.kind=INPUT_BATCH,
action.kind=GENERATE, action.kind=WAIT, and action.kind=DONE.
Never return candidate JSON to the caller.
"""
[features]
shell_tool = false
apps = false
`;
}

describe("Codex executor bootstrap publication", () => {
  it("publishes one project custom agent and two byte-identical release templates", () => {
    expectFiles([PROJECT_AGENT, ROOT_AGENT_TEMPLATE, RELEASE_AGENT_TEMPLATE]);

    const projectAgent = readText(PROJECT_AGENT);
    const rootTemplate = readText(ROOT_AGENT_TEMPLATE);
    const releaseTemplate = readText(RELEASE_AGENT_TEMPLATE);
    expect(rootTemplate).toBe(projectAgent);
    expect(releaseTemplate).toBe(projectAgent);
    expect(projectAgent).toMatch(/^name\s*=\s*"understand_book_executor"\s*$/mu);
    expect(projectAgent).toContain(`description = "${EXECUTOR_AGENT_DESCRIPTION}"`);
    expect(projectAgent).not.toMatch(/^model(?:_reasoning_effort)?\s*=/mu);
    expect(projectAgent).toContain('sandbox_mode = "read-only"');

    const wrapper = readText("agents/automatic-build-dispatch-executor.md");
    expect(wrapper).toContain(EXECUTOR_SKILL_PROHIBITION);
    expect(wrapper).toContain(EXECUTOR_MCP_ONLY);
    expect(projectAgent).toContain(expectedDeveloperInstructionsAssignment(wrapper));
    expect(projectAgent).not.toMatch(/automatic_build_executor_session\.v1|candidate_path|executor\.session|private candidate source/u);
    const present = [
      projectAgent.includes("--agent-bootstrap-digest") ? "agent-bootstrap-digest" : undefined,
      Object.hasOwn(BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3, "bootstrap_digest")
        ? "bootstrap_digest"
        : undefined,
    ].filter((field): field is string => field !== undefined);
    // H0_RED action: R3 replaces the still-published launcher digest with --bootstrap-version;
    // R2 already publishes the digest-free structured V3 identity tested separately.
    expect(present).toEqual([]);
  });

  it("R2 validates only the effective V3 role projection and rejects role-local MCP transport", () => {
    const validation = validateBuildExecutorRoleConfigV3(roleOnlyV3Config());
    expect(validation).toEqual({
      status: "compatible",
      agent_name: "understand_book_executor",
      role_projection: "bounded_agent_role_overrides",
      canonical_instructions_projected: true,
      projected_role_reductions: ["shell_tool=false", "apps=false"],
      unprojected_agent_fields_are_child_contract: false,
      mcp_servers_in_role: 0,
      session_protocol: "automatic_build_executor_session.v3",
      tool_names: [...EXECUTOR_TOOL_NAMES],
    });
    expect(validation).not.toHaveProperty("sandbox_mode");
    expect(validation).not.toHaveProperty("approval_policy");
    expect(validation).not.toHaveProperty("web_search");
    expect(validation).not.toHaveProperty("view_image");
    expect(validation).not.toHaveProperty("skills_config");

    expect(() => validateBuildExecutorRoleConfigV3(`${roleOnlyV3Config()}\n${[
      "[mcp_servers.understand_book_build_executor]",
      'command = "cmd.exe"',
    ].join("\n")}`)).toThrow(/role.*mcp|mcp.*role/i);
  });

  it("R1 expects both plugin MCP configs to own one optional exact-four shared Executor server", () => {
    const violations: string[] = [];
    for (const relativePath of ROOT_SHARED_MCP_CONFIGS) {
      const config = JSON.parse(readText(relativePath)) as {
        mcpServers?: Record<string, {
          required?: unknown;
          enabled_tools?: unknown;
          default_tools_approval_mode?: unknown;
        }>;
      };
      const server = config.mcpServers?.[EXECUTOR_SERVER_NAME];
      if (!server) {
        violations.push(`${relativePath}: missing ${EXECUTOR_SERVER_NAME}`);
        continue;
      }
      if (server.required !== false) violations.push(`${relativePath}: required must be false`);
      if (JSON.stringify(server.enabled_tools) !== JSON.stringify(EXECUTOR_TOOL_NAMES)) {
        violations.push(`${relativePath}: enabled_tools must be exact-four`);
      }
      if (server.default_tools_approval_mode !== "approve") {
        violations.push(`${relativePath}: default_tools_approval_mode must be approve`);
      }
    }
    // R1_RED action: R3 adds the same optional shared server to both plugin MCP configs.
    expect(violations).toEqual([]);
    expect(readText(ROOT_SHARED_MCP_CONFIGS[1])).toBe(readText(ROOT_SHARED_MCP_CONFIGS[0]));
  });

  it("keeps plugin-owned Executor transport out of the project Codex config", () => {
    const projectConfig = readOptionalText(".codex/config.toml");
    expect(projectConfig).not.toContain(EXECUTOR_SERVER_NAME);
    for (const toolName of EXECUTOR_TOOL_NAMES) expect(projectConfig).not.toContain(toolName);
  });

  it("R1 expects all three Executor role assets to inherit MCP and contain zero local servers", () => {
    const offenders = EXECUTOR_AGENT_ASSETS.filter((relativePath) => (
      /^\[mcp_servers\.[^\]]+\]\s*$/mu.test(readText(relativePath))
    ));
    // R1_RED action: R3 removes transport ownership from all three role-only TOML assets.
    expect(offenders).toEqual([]);
  });

  it("R3 publishes byte-identical plugin-owned Executor launchers with fixed V3 arguments", () => {
    expectFiles([ROOT_EXECUTOR_MCP_LAUNCHER, RELEASE_EXECUTOR_MCP_LAUNCHER]);
    const rootLauncher = readText(ROOT_EXECUTOR_MCP_LAUNCHER);
    const releaseLauncher = readText(RELEASE_EXECUTOR_MCP_LAUNCHER);

    expect(releaseLauncher).toBe(rootLauncher);
    for (const marker of [
      "UNDERSTAND_BOOK_BUILD_EXE",
      "HKCU\\Software\\UnderstandBook",
      "understand-book-build.exe",
      "executor.mcp --bootstrap-version automatic_build_executor_bootstrap.v3 "
        + "--protocol-generation automatic_build_executor_session.v3",
    ]) {
      expect(rootLauncher).toContain(marker);
    }
    expect(rootLauncher).not.toContain("--agent-bootstrap-digest");
    expect(rootLauncher).not.toContain("%*");
  });

  it("publishes byte-identical explicit registration script and skill projections", () => {
    expectFiles([
      ROOT_REGISTER_SCRIPT,
      RELEASE_REGISTER_SCRIPT,
      ROOT_REGISTER_SKILL,
      RELEASE_REGISTER_SKILL,
      ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE,
      RELEASE_KNOWN_PREDECESSOR_AGENT_TEMPLATE,
    ]);
    expect(readText(RELEASE_REGISTER_SCRIPT)).toBe(readText(ROOT_REGISTER_SCRIPT));
    expect(readText(RELEASE_REGISTER_SKILL)).toBe(readText(ROOT_REGISTER_SKILL));
    expect(readText(RELEASE_KNOWN_PREDECESSOR_AGENT_TEMPLATE))
      .toBe(readText(ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE));

    const knownPredecessor = readText(ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE);
    expect(knownPredecessor).toContain("automatic_build_executor_session.v2");
    expect(knownPredecessor).toContain("the agent-only stdio MCP connection owns authorization");
    expect(knownPredecessor).toMatch(/^\[mcp_servers\.understand_book_build_executor\]\s*$/mu);
    expect(knownPredecessor).not.toBe(readText(ROOT_AGENT_TEMPLATE));

    const registrationSkill = readText(ROOT_REGISTER_SKILL);
    expect(registrationSkill).toMatch(/^name:\s*understand-book-register-executor\s*$/mu);
    expect(registrationSkill).toMatch(/^description:.*(?:register|install).*executor.*agent/imu);
    expect(registrationSkill).not.toMatch(/^description:.*(?:build|opaque handoff)/imu);
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("R3 Executor launcher invokes the selected binary and fails closed when it is absent", () => {
    expectFiles([ROOT_EXECUTOR_MCP_LAUNCHER]);
    const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-executor-launcher-"));
    const fakeBuildExe = path.join(workspace, "fake-understand-book-build.cmd");
    writeFileSync(fakeBuildExe, "@echo off\r\necho %*\r\n", "utf8");

    const invoke = (selectedBinary: string) => spawnSync("cmd.exe", [
      "/d",
      "/s",
      "/c",
      ROOT_EXECUTOR_MCP_LAUNCHER.replaceAll("/", "\\"),
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, UNDERSTAND_BOOK_BUILD_EXE: selectedBinary },
      encoding: "utf8",
    });

    const launched = invoke(fakeBuildExe);
    expect(launched.status, launched.stderr || launched.stdout).toBe(0);
    expect(launched.stderr).toBe("");
    expect(launched.stdout.trim()).toBe(
      "executor.mcp --bootstrap-version automatic_build_executor_bootstrap.v3 "
        + "--protocol-generation automatic_build_executor_session.v3",
    );

    const unavailable = invoke(path.join(workspace, "missing-understand-book-build.exe"));
    expect(unavailable.status).toBe(2);
    expect(unavailable.stdout).toBe("");
    expect(unavailable.stderr).toBe(
      "Understand Book Build Executor MCP is unavailable. "
        + "Install Understand Book Setup or set UNDERSTAND_BOOK_BUILD_EXE.\r\n",
    );
  });

  windowsIt("registers absent/same, explicitly migrates the known predecessor, and preserves conflicts", () => {
    expectFiles([
      ROOT_REGISTER_SCRIPT,
      ROOT_AGENT_TEMPLATE,
      ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE,
    ]);
    const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-executor-agent-"));
    const target = path.join(workspace, ".codex", "agents", "understand-book-executor.toml");
    const backup = `${target}.automatic_build_executor_session.v2.bak`;
    const template = readFileSync(absolute(ROOT_AGENT_TEMPLATE));
    const knownPredecessor = readFileSync(absolute(ROOT_KNOWN_PREDECESSOR_AGENT_TEMPLATE));
    const templateWithCrLf = Buffer.from(
      template.toString("utf8").replace(/\n/gu, "\r\n"),
      "utf8",
    );
    const knownPredecessorWithCrLf = Buffer.from(
      knownPredecessor.toString("utf8").replace(/\n/gu, "\r\n"),
      "utf8",
    );
    const run = (...extraArgs: string[]) => spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      absolute(ROOT_REGISTER_SCRIPT),
      "-Scope",
      "project",
      "-WorkspaceRoot",
      workspace,
      ...extraArgs,
    ], { cwd: workspace, encoding: "utf8" });

    const installed = run();
    expect(installed.status, installed.stderr || installed.stdout).toBe(0);
    expect(readFileSync(target)).toEqual(template);
    expect(readdirSync(path.dirname(target))).toEqual(["understand-book-executor.toml"]);
    expect(JSON.parse(installed.stdout)).toEqual({
      source_state: "absent",
      target_version: TARGET_AGENT_VERSION,
      backup: null,
      new_task_required: true,
    });

    writeFileSync(target, templateWithCrLf);
    const fixedTime = new Date("2026-08-10T00:00:00.000Z");
    utimesSync(target, fixedTime, fixedTime);
    const currentMtime = statSync(target).mtimeMs;
    const alreadyCurrent = run();
    expect(alreadyCurrent.status, alreadyCurrent.stderr || alreadyCurrent.stdout).toBe(0);
    expect(readFileSync(target)).toEqual(templateWithCrLf);
    expect(statSync(target).mtimeMs).toBe(currentMtime);
    expect(JSON.parse(alreadyCurrent.stdout)).toEqual({
      source_state: "same",
      target_version: TARGET_AGENT_VERSION,
      backup: null,
      new_task_required: true,
    });

    writeFileSync(target, knownPredecessorWithCrLf);
    const migrationWithoutConsent = run();
    expect(migrationWithoutConsent.status).not.toBe(0);
    expect(readFileSync(target)).toEqual(knownPredecessorWithCrLf);
    expect(existsSync(backup)).toBe(false);

    const migrated = run("-MigrateKnownPredecessor");
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0);
    expect(readFileSync(target)).toEqual(template);
    expect(readFileSync(backup)).toEqual(knownPredecessorWithCrLf);
    expect(JSON.parse(migrated.stdout)).toEqual({
      source_state: "known_predecessor",
      target_version: TARGET_AGENT_VERSION,
      backup,
      new_task_required: true,
    });

    const conflicting = Buffer.from("user-owned conflicting executor agent\n", "utf8");
    writeFileSync(target, conflicting);
    const conflict = run("-MigrateKnownPredecessor");
    expect(conflict.status).not.toBe(0);
    expect(readFileSync(target)).toEqual(conflicting);

    writeFileSync(target, knownPredecessorWithCrLf);
    writeFileSync(backup, "conflicting backup bytes\n", "utf8");
    const backupConflict = run("-MigrateKnownPredecessor");
    expect(backupConflict.status).not.toBe(0);
    expect(readFileSync(target)).toEqual(knownPredecessorWithCrLf);
    expect(readFileSync(backup, "utf8")).toBe("conflicting backup bytes\n");
  }, 20_000);

  windowsIt("registers a personal executor agent inside an isolated CODEX_HOME", () => {
    const registrationScript = readText(ROOT_REGISTER_SCRIPT);
    expect(registrationScript).toContain('GetEnvironmentVariable("CODEX_HOME")');

    const container = mkdtempSync(path.join(tmpdir(), "understand-book-personal-executor-agent-"));
    const codexHome = path.join(container, "codex-home");
    const target = path.join(codexHome, "agents", "understand-book-executor.toml");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      absolute(ROOT_REGISTER_SCRIPT),
      "-Scope",
      "personal",
    ], {
      cwd: container,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(readText(ROOT_AGENT_TEMPLATE));
    expect(JSON.parse(result.stdout)).toEqual({
      source_state: "absent",
      target_version: TARGET_AGENT_VERSION,
      backup: null,
      new_task_required: true,
    });
  }, 20_000);

  it("publishes a byte-identical executor-only skill backed by the canonical wrapper", () => {
    expectFiles([ROOT_EXECUTOR_SKILL, RELEASE_EXECUTOR_SKILL]);
    const rootSkill = readText(ROOT_EXECUTOR_SKILL);
    const releaseSkill = readText(RELEASE_EXECUTOR_SKILL);
    expect(releaseSkill).toBe(rootSkill);
    expect(rootSkill).toMatch(/^name:\s*understand-book-executor\s*$/mu);

    const body = skillBody(rootSkill);
    const wrapper = normalizeContract(readText("agents/automatic-build-dispatch-executor.md"));
    expect(body).toBe(wrapper);
    expect(rootSkill).toContain("ack_through_ordinal");
    expect(rootSkill).toContain("confirmed_through_ordinal");
    expect(rootSkill).toMatch(/Make exactly one executor MCP\s+call per tool step/u);
    expect(rootSkill).toContain(
      "The stdio state machine enforces direct phase, ref, ordinal, and schema checks, "
        + "but it does not authenticate the caller role.",
    );
    expect(rootSkill).not.toMatch(/agent-only stdio|chunk_receipt|previous_chunk_receipt/u);
    for (const forbidden of ["BuildIntent", "BuildPlan", "build.step", "planning.context", "draft.candidate"]) {
      expect(rootSkill).not.toContain(forbidden);
    }
  });

  it("publishes the V3 first-terminal root orchestration contract byte-identically", () => {
    expectFiles([ROOT_BUILD_SKILL, RELEASE_BUILD_SKILL]);
    const rootSkill = readText(ROOT_BUILD_SKILL);
    expect(readText(RELEASE_BUILD_SKILL)).toBe(rootSkill);
    for (const marker of [
      "automatic_build_executor_session.v3",
      "live_by_ref",
      "completed_refs",
      "first owned child becomes terminal",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
      "ack_through_ordinal",
      "confirmed_through_ordinal",
    ]) {
      expect(rootSkill).toContain(marker);
    }
    expect(rootSkill).not.toMatch(
      /automatic_build_executor_session\.v[12]|previous_chunk_receipt|executor-private temporary source|executor\.session/u,
    );

    const customProvider = "Process exactly this code-issued opaque handoff ref and return only bounded lifecycle state:";
    const fallbackProvider = "Use $understand-book-executor for exactly this opaque handoff ref:";
    expect(rootSkill).toMatch(
      /Process exactly this code-issued opaque handoff ref and return only bounded lifecycle state:\s+<opaque_handoff_ref>/u,
    );
    expect(rootSkill).toMatch(
      /Use \$understand-book-executor for exactly this opaque handoff ref:\s+<opaque_handoff_ref>\s+Return only the bounded lifecycle state defined by that skill\.\s+Do not use \$understand-book-build inside this subagent\./u,
    );
    expect(rootSkill.indexOf(customProvider)).toBeLessThan(rootSkill.indexOf(fallbackProvider));
  });

  it("R4 prohibits every shared Executor tool before the root action loop and at hard boundaries", () => {
    const rootSkill = readText(ROOT_BUILD_SKILL);
    const actionLoop = rootSkill.indexOf("## Four-action loop");
    expect(actionLoop).toBeGreaterThan(0);
    const preLoop = rootSkill.slice(0, actionLoop);
    const hardBoundaries = rootSkill.slice(rootSkill.indexOf("## Hard boundaries"));
    for (const toolName of EXECUTOR_TOOL_NAMES) {
      const marker = `The root must not call, probe, enumerate, or use \`${toolName}\` to diagnose a handoff.`;
      expect(preLoop).toContain(marker);
      expect(hardBoundaries).toContain(marker);
    }
  });

  it("H0/R6 removes source release snapshot digests after direct file assertions", () => {
    const releaseAssertion = readText(RELEASE_ASSERTION);
    // H0_RED action: R6 reports direct source/compiled/thin-plugin gate results and compares
    // the files already read by the release assertion; it no longer emits a skill snapshot digest.
    expect(releaseAssertion).not.toContain("skill_sha256");
    expect(releaseAssertion).not.toContain("canonicalTextSha256");
    expect(releaseAssertion).not.toContain("node:crypto");
    expect(releaseAssertion).toMatch(/assert\.equal\(\s*installedSkill,\s*releaseSkill,/u);
  });

  it("R6 keeps thin-plugin parity on the shared V3 doctor and direct byte comparisons", () => {
    const parity = readText("apps/desktop/scripts/smoke-automatic-build-parity.mjs");
    const sidecarEntry = readText("skills/build/sidecar-entry.ts");
    const sidecarBuild = readText("apps/desktop/scripts/build-sidecar.mjs");
    expect(parity).toContain("automatic_build_executor_session.v3");
    expect(parity).not.toContain("automatic_build_executor_session.v2");
    for (const marker of [
      "checks?.executor_role",
      "checks?.shared_executor_mcp",
      "checks?.connection_integrity",
      "checks?.semantic_reuse_identity",
      "caller_role_authenticated !== false",
      "forbidden_digest_field_count !== 0",
    ]) {
      expect(parity).toContain(marker);
    }
    expect(parity).not.toContain("checks?.executor_bootstrap");
    expect(parity).not.toContain("node=${createHash");
    expect(parity).not.toContain("sidecar=${createHash");
    for (const command of ["executor.mcp-config", "executor.mcp-launcher"]) {
      expect(sidecarEntry).toContain(command);
      expect(parity).toContain(command);
    }
    expect(sidecarBuild).toContain('"--loader=.cmd:text"');
  });

  it("R1 runs the shared-boundary source release gate before compiled or installed evidence", () => {
    const env = { ...process.env };
    delete env.UNDERSTAND_BOOK_INSTALLED_PLUGIN_ROOT;
    const result = spawnSync(process.execPath, [
      absolute(RELEASE_ASSERTION),
      "--source-contract-only",
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });

    // R1_RED action: R3-R6 make every new source assertion pass without compiled evidence.
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^plugin source contract ok: .+/u);
    const releaseAssertion = readText(RELEASE_ASSERTION);
    expect(releaseAssertion.indexOf('process.argv.includes("--source-contract-only")'))
      .toBeLessThan(releaseAssertion.indexOf("spawnSync(sidecarBinary"));
  });

  it("R1 requires release evidence to state that shared capability is not role-isolated", () => {
    const releaseAssertion = readText(RELEASE_ASSERTION);
    const realCliSmoke = readText("apps/desktop/scripts/smoke-t7-codex-cli-release.ts");
    const expectedMarkers = ["capability_isolation: false", "caller_role_authenticated: false"];
    expect(expectedMarkers.filter((marker) => !releaseAssertion.includes(marker))).toEqual([]);
    // R1_RED action: R7 serializes both false risk fields in the thread-attributed release evidence.
    expect(expectedMarkers.filter((marker) => !realCliSmoke.includes(marker))).toEqual([]);
  });

  it("publishes a deterministic T7 compiled executor release gate", () => {
    const desktopPackage = JSON.parse(readText("apps/desktop/package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(desktopPackage.scripts?.["test:t7-executor-release"])
      .toContain("smoke-t7-executor-release.ts");
    expect(desktopPackage.scripts?.["test:t7-codex-cli-release"])
      .toContain("smoke-t7-codex-cli-release.ts");
    expect(desktopPackage.scripts?.["package:windows"])
      .toContain("smoke-t7-executor-release.ts");
    expect(desktopPackage.scripts?.["package:windows"])
      .toContain("--t7-executor-release-prechecked");

    const smoke = readText("apps/desktop/scripts/smoke-t7-executor-release.ts");
    for (const marker of [
      "T7_SEMANTIC_INPUT_SENTINEL_317247",
      "executor.mcp",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
      "automatic_build_executor_bootstrap.v2",
      "automatic_build_executor_session.v3",
      "unknown_request_field",
      "ack_through_ordinal_mismatch",
      "trace_allowlist",
    ]) {
      expect(smoke).toContain(marker);
    }
    expect(smoke).not.toContain("supersedeUnopenedAutomaticBuildExecutorHandoffV2");
    const releaseAssertion = readText(RELEASE_ASSERTION);
    expect(releaseAssertion).toContain("smoke-t7-executor-release.ts");
    expect(releaseAssertion).toContain("--t7-executor-release-prechecked");

    const realCliSmoke = readText("apps/desktop/scripts/smoke-t7-codex-cli-release.ts");
    for (const marker of [
      "CODEX_HOME: codexHome",
      "CODEX_ROLLOUT_TRACE_ROOT",
      '"-Scope",\n        "personal"',
      "agent_type=understand_book_executor",
      "real Codex executor child never accepted generation.start",
      '"debug", "trace-reduce"',
      "analyzeR7RolloutTrace",
      "max_live_dedicated_children",
      "root_executor_dispatch_attempt_count",
      "understand_book_root_shared_executor_evidence.v1",
    ]) {
      expect(realCliSmoke).toContain(marker);
    }
  });

  it("keeps source agent directories out of the plugin while gating the asset template", () => {
    expect(existsSync(absolute("plugins/understand-book/agents"))).toBe(false);
    expect(existsSync(absolute("plugins/understand-book/.codex/agents"))).toBe(false);
    const releaseAssertion = readText("apps/desktop/scripts/assert-plugin-release.mjs");
    for (const marker of [
      "assets/codex-agents/understand-book-executor.toml",
      "skills/register-executor/SKILL.md",
      "scripts/register-executor-agent.ps1",
      "skills/executor/SKILL.md",
      "agent_type\\s*=\\s*understand_book_executor",
      ".codex/config.toml",
      "understand_book_build_executor",
      "--source-contract-only",
    ]) {
      expect(releaseAssertion).toContain(marker);
    }
  });
});
