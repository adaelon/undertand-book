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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR_AGENT_DESCRIPTION =
  "Execute exactly one Understand Book opaque handoff through the packaged executor session protocol.";

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

    const wrapper = readText("agents/automatic-build-dispatch-executor.md");
    expect(projectAgent).toContain(expectedDeveloperInstructionsAssignment(wrapper));
    expect(contractSha256(wrapper)).toMatch(/^[a-f0-9]{64}$/u);
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
    for (const forbidden of ["BuildIntent", "BuildPlan", "build.step", "planning.context", "draft.candidate"]) {
      expect(rootSkill).not.toContain(forbidden);
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
    ]) {
      expect(releaseAssertion).toContain(marker);
    }
  });
});
