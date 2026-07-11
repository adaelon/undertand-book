import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  automaticBuildNext,
  recordAutomaticBuildAttempt,
} from "../../../skills/build/automatic-build";
import { resolveAutomaticBuildTarget } from "../src/build-orchestrator";

describe("automatic build attempt policy", () => {
  it("persists failures across next calls and requires the user after three attempts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-attempts-"));
    const source = path.join(root, "retry-guide.md");
    writeFileSync(source, "# Retry guide\n\nA compact source paragraph.\n", "utf8");
    const target = resolveAutomaticBuildTarget(source, root);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      recordAutomaticBuildAttempt(target, "pass1", "0", "failure", `gate failure ${attempt}`);
    }

    expect(automaticBuildNext(source, root)).toMatchObject({
      action: {
        kind: "needs_user",
        reason: "retry_exhausted",
        stage: "pass1",
        tasks: [{ task_id: "0", failures: 3, last_error: "gate failure 3" }],
      },
    });

    recordAutomaticBuildAttempt(target, "pass1", "0", "reset");
    expect(automaticBuildNext(source, root)).toMatchObject({
      action: {
        kind: "extract",
        stage: "pass1",
        tasks: [{ task_id: "0", attempt_number: 1 }],
      },
    });
  });

  it("emits self-contained sidecar commands when packaged", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-sidecar-"));
    const source = path.join(root, "sidecar-guide.md");
    writeFileSync(source, "# Sidecar guide\n\nA compact source paragraph.\n", "utf8");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const result = automaticBuildNext(source, root, 1);
      expect(result.action.kind).toBe("extract");
      if (result.action.kind !== "extract") throw new Error("expected extract action");
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected sidecar extract task");
      expect(task.input_command.slice(0, 3)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "run-script",
        "emit-input.ts",
      ]);
      expect(task.record_success_command.slice(0, 2)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "record-attempt",
      ]);
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });
});
