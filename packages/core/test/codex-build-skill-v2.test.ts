import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateCodexBuildIntentCommandV2,
  validateCodexBuildIntentResultV2,
} from "../src/build-planning-context";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTEXT_FIXTURE = JSON.parse(readFileSync(
  path.join(__dirname, "fixtures", "build-planning-context.v1.golden.json"),
  "utf8",
));
const SKILL_PATHS = [
  "skills/build/SKILL.md",
  "plugins/understand-book/skills/build/SKILL.md",
];

function readSkill(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("Codex-owned build planning skill v2", () => {
  it("requires context then candidate and forbids a v1 raw-goal fallback in both skill snapshots", () => {
    for (const relativePath of SKILL_PATHS) {
      const skill = readSkill(relativePath);
      for (const marker of [
        "codex_build_intent_command.v2",
        "codex_build_intent_result.v2",
        "codex_build_intent_response.v1",
        "build_planning_context.v1",
        "build_intent_planner_candidate.v2",
        "planning.context",
        "draft.candidate",
        "BUILD_PLANNING_CONTEXT_DRIFT",
        "CODEX_BUILD_INTENT_V2_REQUIRED",
        "free-form string",
        "Never fall back to `codex_build_intent_command.v1`",
      ]) {
        expect(skill, `${relativePath} missing ${marker}`).toContain(marker);
      }
      expect(skill.indexOf("planning.context")).toBeLessThan(skill.indexOf("draft.candidate"));
      expect(skill).toContain("pass2=enabled|disabled");
      expect(skill).toContain("--pass2 <enabled|disabled>");
      expect(skill.indexOf("pass2=enabled|disabled")).toBeLessThan(skill.indexOf("legacy-plan <target>"));
    }
  });

  it("freezes a body-private fake controller transcript and reacquires context after drift", () => {
    const privateGoal = "CB5_PRIVATE_GOAL_SENTINEL";
    const candidate = CONTEXT_FIXTURE.commands.draft_candidate.input.candidate;
    const contextCommand = validateCodexBuildIntentCommandV2({
      version: "codex_build_intent_command.v2",
      operation: "planning.context",
      target: { workspace_dir: "C:\\Reader\\library\\book" },
      input: {},
    });
    const contextResult = validateCodexBuildIntentResultV2({
      version: "codex_build_intent_result.v2",
      status: "ok",
      response: CONTEXT_FIXTURE.context,
    });
    const draftCommand = validateCodexBuildIntentCommandV2({
      version: "codex_build_intent_command.v2",
      operation: "draft.candidate",
      target: contextCommand.target,
      input: {
        user_goal: privateGoal,
        planning_context_digest: CONTEXT_FIXTURE.context.context_digest,
        candidate,
      },
    });
    const driftResult = validateCodexBuildIntentResultV2({
      version: "codex_build_intent_result.v2",
      status: "error",
      error: {
        error_code: "BUILD_PLANNING_CONTEXT_DRIFT",
        category: "conflict",
        phase: "context",
        retryable: true,
        message: "Build planning context changed; request a fresh context",
      },
    });
    const reacquireCommand = validateCodexBuildIntentCommandV2({
      version: "codex_build_intent_command.v2",
      operation: "planning.context",
      target: contextCommand.target,
      input: {},
    });

    const transcript = [contextCommand, contextResult, draftCommand, driftResult, reacquireCommand];
    expect(transcript.map((entry) => "operation" in entry ? entry.operation : entry.status)).toEqual([
      "planning.context",
      "ok",
      "draft.candidate",
      "error",
      "planning.context",
    ]);
    const argv = ["--codex-build-intent"];
    const publicResultBytes = JSON.stringify([contextResult, driftResult]);
    expect(JSON.stringify(argv)).not.toContain(privateGoal);
    expect(publicResultBytes).not.toContain(privateGoal);
    expect(JSON.stringify(contextCommand)).not.toContain(privateGoal);
    expect(JSON.stringify(draftCommand)).toContain(privateGoal);
  });
});
