import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2,
  validateBuildExecutorAgentConfigV2,
  validateBuildExecutorRootNegativeToolInventory,
} from "../src/build-executor-connection-capability";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR_AGENT_DESCRIPTION =
  "Execute exactly one Understand Book opaque handoff through the packaged executor session protocol.";
const EXECUTOR_SKILL_PROHIBITION =
  "Do not activate `$understand-book-build`, `$understand-book-executor`, or any other skill; "
  + "this role already carries the complete bootstrap contract.";
const EXECUTOR_MCP_ONLY =
  "Use only the four tools on the dedicated `understand_book_build_executor` MCP connection.";

const PROJECT_AGENT = ".codex/agents/understand-book-executor.toml";
const ROOT_AGENT_TEMPLATE = "assets/codex-agents/understand-book-executor.toml";
const RELEASE_AGENT_TEMPLATE =
  "plugins/understand-book/assets/codex-agents/understand-book-executor.toml";
const ROOT_REGISTER_SCRIPT = "scripts/register-executor-agent.ps1";
const RELEASE_REGISTER_SCRIPT = "plugins/understand-book/scripts/register-executor-agent.ps1";
const ROOT_REGISTER_SKILL = "skills/register-executor/SKILL.md";
const RELEASE_REGISTER_SKILL = "plugins/understand-book/skills/register-executor/SKILL.md";
const ROOT_EXECUTOR_SKILL = "skills/executor/SKILL.md";
const RELEASE_EXECUTOR_SKILL = "plugins/understand-book/skills/executor/SKILL.md";
const ROOT_BUILD_SKILL = "skills/build/SKILL.md";
const RELEASE_BUILD_SKILL = "plugins/understand-book/skills/build/SKILL.md";
const RELEASE_ASSERTION = "apps/desktop/scripts/assert-plugin-release.mjs";

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

function normalizeContract(text: string): string {
  return text.replace(/\r\n?|\n/gu, "\n").replace(/\n+$/u, "");
}

function contractSha256(text: string): string {
  return createHash("sha256").update(normalizeContract(text)).digest("hex");
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
    expect(projectAgent).toContain("[mcp_servers.understand_book_build_executor]");
    expect(projectAgent).toContain(`'${BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest}'`);
    for (const toolName of BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.tools) {
      expect(projectAgent).toContain(`"${toolName}"`);
    }

    const wrapper = readText("agents/automatic-build-dispatch-executor.md");
    expect(wrapper).toContain(EXECUTOR_SKILL_PROHIBITION);
    expect(wrapper).toContain(EXECUTOR_MCP_ONLY);
    expect(projectAgent).toContain(expectedDeveloperInstructionsAssignment(wrapper));
    expect(validateBuildExecutorAgentConfigV2(projectAgent)).toMatchObject({
      status: "compatible",
      bootstrap_digest: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.bootstrap_digest,
      session_protocol: "automatic_build_executor_session.v2",
      sandbox_mode: "read-only",
      registration_scope: "agent_only",
      shell_tool: false,
      skills_config: "empty",
      tool_names: [...BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V2.tools],
    });
    expect(() => validateBuildExecutorAgentConfigV2(
      projectAgent.replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'),
    )).toThrow(/bootstrap|config|incompatible/i);
    expect(projectAgent).not.toMatch(/automatic_build_executor_session\.v1|candidate_path|executor\.session|private candidate source/u);
    expect(contractSha256(wrapper)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps executor tools out of root and project MCP inventories", () => {
    const rootConfig = `${readText(".codex/config.toml")}\n${readText(".mcp.json")}`;
    const projectMcp = readText("plugins/understand-book/.mcp.json");
    expect(validateBuildExecutorRootNegativeToolInventory([rootConfig, projectMcp])).toEqual({
      status: "compatible",
      server_registered: false,
      executor_tool_intersection: [],
    });
    expect(() => validateBuildExecutorRootNegativeToolInventory([
      `${projectMcp}\nexecutor.open`,
    ])).toThrow(/root|project|executor tool/i);
  });

  it("publishes byte-identical explicit registration script and skill projections", () => {
    expectFiles([
      ROOT_REGISTER_SCRIPT,
      RELEASE_REGISTER_SCRIPT,
      ROOT_REGISTER_SKILL,
      RELEASE_REGISTER_SKILL,
    ]);
    expect(readText(RELEASE_REGISTER_SCRIPT)).toBe(readText(ROOT_REGISTER_SCRIPT));
    expect(readText(RELEASE_REGISTER_SKILL)).toBe(readText(ROOT_REGISTER_SKILL));

    const registrationSkill = readText(ROOT_REGISTER_SKILL);
    expect(registrationSkill).toMatch(/^name:\s*understand-book-register-executor\s*$/mu);
    expect(registrationSkill).toMatch(/^description:.*(?:register|install).*executor.*agent/imu);
    expect(registrationSkill).not.toMatch(/^description:.*(?:build|opaque handoff)/imu);
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("registers absent and current templates while preserving a conflicting user file", () => {
    expectFiles([ROOT_REGISTER_SCRIPT, ROOT_AGENT_TEMPLATE]);
    const workspace = mkdtempSync(path.join(tmpdir(), "understand-book-executor-agent-"));
    const target = path.join(workspace, ".codex", "agents", "understand-book-executor.toml");
    const template = readText(ROOT_AGENT_TEMPLATE);
    const run = () => spawnSync("powershell.exe", [
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
    ], { cwd: workspace, encoding: "utf8" });

    const installed = run();
    expect(installed.status, installed.stderr || installed.stdout).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(template);
    expect(readdirSync(path.dirname(target))).toEqual(["understand-book-executor.toml"]);

    const fixedTime = new Date("2026-08-10T00:00:00.000Z");
    utimesSync(target, fixedTime, fixedTime);
    const currentMtime = statSync(target).mtimeMs;
    const alreadyCurrent = run();
    expect(alreadyCurrent.status, alreadyCurrent.stderr || alreadyCurrent.stdout).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(template);
    expect(statSync(target).mtimeMs).toBe(currentMtime);

    const conflicting = "user-owned conflicting executor agent\n";
    writeFileSync(target, conflicting, "utf8");
    const conflict = run();
    expect(conflict.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(conflicting);
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
    expect(JSON.parse(result.stdout)).toMatchObject({
      scope: "personal",
      target,
      activation: "new_task_required",
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
    expect(contractSha256(body)).toBe(contractSha256(wrapper));
    expect(rootSkill).toContain("action.chunk.chunk_receipt");
    expect(rootSkill).toMatch(/Make exactly one executor MCP\s+call per tool step/u);
    for (const forbidden of ["BuildIntent", "BuildPlan", "build.step", "planning.context", "draft.candidate"]) {
      expect(rootSkill).not.toContain(forbidden);
    }
  });

  it("publishes the V2 first-terminal root orchestration contract byte-identically", () => {
    expectFiles([ROOT_BUILD_SKILL, RELEASE_BUILD_SKILL]);
    const rootSkill = readText(ROOT_BUILD_SKILL);
    expect(readText(RELEASE_BUILD_SKILL)).toBe(rootSkill);
    for (const marker of [
      "automatic_build_executor_session.v2",
      "live_by_ref",
      "completed_refs",
      "first owned child becomes terminal",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
    ]) {
      expect(rootSkill).toContain(marker);
    }
    expect(rootSkill).not.toMatch(
      /automatic_build_executor_session\.v1|executor-private temporary source|executor\.session/u,
    );
  });

  it("passes the scoped T6 source release gate without installed or compiled evidence", () => {
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

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^plugin source contract ok: .+ skill_sha256=[a-f0-9]{64}\s*$/u);

    const releaseAssertion = readText(RELEASE_ASSERTION);
    expect(releaseAssertion.indexOf('process.argv.includes("--source-contract-only")'))
      .toBeLessThan(releaseAssertion.indexOf("spawnSync(sidecarBinary"));
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
      "tampered_chunk_receipt",
      "trace_allowlist",
    ]) {
      expect(smoke).toContain(marker);
    }
    const releaseAssertion = readText(RELEASE_ASSERTION);
    expect(releaseAssertion).toContain("smoke-t7-executor-release.ts");
    expect(releaseAssertion).toContain("--t7-executor-release-prechecked");

    const realCliSmoke = readText("apps/desktop/scripts/smoke-t7-codex-cli-release.ts");
    for (const marker of [
      "CODEX_HOME: codexHome",
      '"-Scope",\n        "personal"',
      "agent_type=understand_book_executor",
      "real Codex executor child never accepted generation.start",
      "trace_allowlist",
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
