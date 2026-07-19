import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { automaticBuildNext, automaticBuildPlan } from "../../../skills/build/automatic-build";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const EXTRACTOR_PROMPTS = [
  "pass1-local-extractor.md",
  "paper-metadata-extractor.md",
  "paper-lexicon-extractor.md",
  "profile-sidecar-extractor.md",
  "pass2-longrange-linker.md",
  "book-structure-extractor.md",
];

describe("automatic build Codex executor handoff", () => {
  it("emits a lease envelope without a root candidate relay", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-handoff-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA compact paragraph.\n", "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const plan = automaticBuildPlan(source, root, { requested_workers: 1 });
      if (!plan.preflight) throw new Error("expected handoff preflight");
      const result = automaticBuildNext(source, root, 1, {
        owner: "handoff-test",
        now: "2026-07-19T00:00:00.000Z",
        lease_ttl_ms: 60_000,
        accepted_plan_digest: plan.preflight.plan_digest,
      });
      expect(result.action.kind).toBe("extract");
      if (!("tasks" in result.action) || !result.action.tasks) {
        throw new Error("expected executor task");
      }
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected executor command envelope");
      expect(task).toMatchObject({
        task_id: "0",
        attempt_number: 1,
        candidate_path: expect.stringContaining("candidate.json"),
        usage_path: expect.stringContaining("usage.json"),
        descriptor: {
          version: "automatic_build_work_unit.v2",
          work_unit_id: "0",
          kind: "pass1_window",
          cost: { score: expect.any(Number) },
        },
      });
      const executable = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      expect(task.input_command.slice(0, 3)).toEqual([executable, "input", expect.any(String)]);
      expect(task.submit_command.slice(0, 3)).toEqual([executable, "submit", expect.any(String)]);
      expect(task.fail_command.slice(0, 3)).toEqual([executable, "fail", expect.any(String)]);
      expect(task.heartbeat_command.slice(0, 3)).toEqual([executable, "heartbeat", expect.any(String)]);
      expect(task.inspect_command.slice(0, 3)).toEqual([executable, "inspect", expect.any(String)]);
      expect(task).not.toHaveProperty("write_command");
      expect(task).not.toHaveProperty("candidate_command");
      expect(task).not.toHaveProperty("record_failure_command");
      expect(task).not.toHaveProperty("record_success_command");
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("freezes receipt-only execution in the skill and every specialized extractor", () => {
    const skill = readFileSync(path.join(REPO_ROOT, "skills", "build", "SKILL.md"), "utf8");
    expect(skill).toContain("automatic_build_executor.v1");
    expect(skill).toContain("needs_user(executor_unavailable)");
    expect(skill).toContain("root 禁止接收、复述、缓存、写入或转发 candidate JSON");
    expect(skill).toContain("也禁止调用");
    expect(skill).toContain("`legacy-submit`");

    for (const prompt of EXTRACTOR_PROMPTS) {
      const content = readFileSync(path.join(REPO_ROOT, "agents", prompt), "utf8");
      expect(content, prompt).toContain("Automatic Build Executor Envelope");
      expect(content, prompt).toContain("directly at `candidate_path`");
      expect(content, prompt).toContain("return only its receipt JSON");
      expect(content, prompt).toContain("Never return candidate JSON to the caller");
    }
  });
});
