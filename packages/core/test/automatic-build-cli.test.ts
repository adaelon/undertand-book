import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  automaticBuildNext,
  automaticBuildPlan,
  captureBuildProcessOutput,
  recordAutomaticBuildAttempt,
  type AutomaticBuildNextOptions,
} from "../../../skills/build/automatic-build";
import { resolveAutomaticBuildTarget, type AutomaticBuildTarget } from "../src/build-orchestrator";
import { buildSourceManifest, buildSourceManifestV2 } from "../src/source-manifest";
import { emptyReconciliationSummary, sha256Text } from "../src/source-reconciliation";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows } from "../src/window";
import { buildPass1Artifact } from "../src/build-resume";
import { resolveContentProfile } from "../src/content-profile";
import { automaticBuildExtractionPolicy, buildSemanticArtifactEnvelope } from "../src/semantic-artifact";
import { confirmedStandardBuildPlan } from "./helpers/confirmed-build-plan";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function acceptedNext(
  targetInput: string,
  rootDir: string,
  maxParallel = 5,
  options: AutomaticBuildNextOptions = {},
) {
  const buildPlan = options.build_plan ?? confirmedStandardBuildPlan(targetInput, rootDir);
  const plan = automaticBuildPlan(targetInput, rootDir, {
    requested_workers: maxParallel,
    quality_profile: options.quality_profile,
    budget: options.budget,
    build_plan: buildPlan,
  });
  if (!plan.preflight) return automaticBuildNext(targetInput, rootDir, maxParallel, { ...options, build_plan: buildPlan });
  return automaticBuildNext(targetInput, rootDir, maxParallel, {
    protocol: "automatic_build_protocol.v2",
    ...options,
    build_plan: buildPlan,
    accepted_plan_digest: plan.preflight.plan_digest,
  });
}

function pass1Envelope(target: AutomaticBuildTarget, taskId: number, payload: { content_hash: string; nodes: unknown[]; edges: unknown[] }) {
  return buildSemanticArtifactEnvelope({
    target: target.target_ref,
    stage: "pass1",
    work_unit_id: String(taskId),
    input_hash: payload.content_hash,
    policy_fingerprint: automaticBuildExtractionPolicy("pass1", resolveContentProfile(target.profile_id), "full"),
    provenance: { executor: "test", model: "codex-test", attempt: 1, generated_at: "2026-07-19T00:00:00.000Z" },
    payload,
  });
}

function writeTrustedPaperWorkspace(root: string): string {
  const bookId = "paper-cli";
  const workspace = path.join(root, ".understand-book", bookId);
  const source = "# Abstract\n\nThis paper studies retrieval.\n";
  const draftSource = "# Abstract\n\nThis paper studies retrieval with OCR noise.\n";
  const fingerprint = {
    paper_md_sha256: sha256Text(draftSource),
    paper_pdf_sha256: "sha-pdf",
    config_hash: "cfg-cli",
  };
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "source.txt"), source, "utf8");
  writeFileSync(path.join(workspace, "paper.md"), draftSource, "utf8");
  writeFileSync(path.join(workspace, "paper.pdf"), "pdf", "utf8");
  writeJson(path.join(workspace, "base.json"), { book_id: bookId, lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(workspace, "source_manifest.json"), buildSourceManifestV2({
    book_id: bookId,
    source_sha256: sha256Text(source),
    original_pdf_path: "paper.pdf",
    original_pdf_sha256: "sha-pdf",
    pdf_source_map_path: "pdf_source_map.json",
    pdf_selection_map_manifest_path: "pdf_selection_map/manifest.json",
    alignment_report_path: "alignment_report.json",
    config_hash: fingerprint.config_hash,
  }));
  writeJson(path.join(workspace, ".build", "source-reconciliation", "report.json"), {
    version: "source_reconciliation_report.v1",
    book_id: bookId,
    input_fingerprint: fingerprint,
    summary: { ...emptyReconciliationSummary(), verified: 1 },
    unresolved: [],
  });
  writeJson(path.join(workspace, ".build", "input", "manifest.json"), {
    version: "workbench_input_manifest.v1",
    book_id: bookId,
    profile_id: "paper",
    fingerprint,
    inputs: {
      paper_md: { path: "paper.md", original_path: null, sha256: fingerprint.paper_md_sha256 },
      paper_pdf: { path: "paper.pdf", original_path: null, sha256: fingerprint.paper_pdf_sha256 },
    },
  });
  return workspace;
}

function writeTechnicalLearningWorkspace(
  root: string,
  bookId = "stable-guide",
  sourceFilename = "renamed-import.md",
): { workspace: string; source: string } {
  const workspace = path.join(root, ".understand-book", bookId);
  const source = path.join(root, sourceFilename);
  const body = "# Stable guide\n\nA deterministic technical learning source.\n";
  mkdirSync(workspace, { recursive: true });
  writeFileSync(source, body, "utf8");
  writeFileSync(path.join(workspace, "source.txt"), body, "utf8");
  writeJson(path.join(workspace, "base.json"), { book_id: bookId, lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(workspace, "source_manifest.json"), buildSourceManifest({
    book_id: bookId,
    source_path: source,
  }));
  writeJson(path.join(workspace, "profile_metadata.json"), {
    header: { book_id: bookId, profile_id: "technical_learning" },
  });
  return { workspace, source };
}

describe("automatic build attempt policy", () => {
  it("captures stage output larger than spawnSync's default pipe buffer", () => {
    const outputBytes = 2 * 1024 * 1024 + 17;
    const result = captureBuildProcessOutput(
      process.execPath,
      ["-e", `process.stdout.write("x".repeat(${outputBytes})); process.stderr.write("capture-ok")`],
      process.cwd(),
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(outputBytes);
    expect(result.stderr).toBe("capture-ok");
  });

  it("persists failures across next calls and requires the user after three attempts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-attempts-"));
    const source = path.join(root, "retry-guide.md");
    writeFileSync(source, "# Retry guide\n\nA compact source paragraph.\n", "utf8");
    const target = resolveAutomaticBuildTarget(source, root);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      recordAutomaticBuildAttempt(target, "pass1", "0", "failure", `gate failure ${attempt}`);
    }

    expect(automaticBuildNext(source, root, 5, {
      build_plan: confirmedStandardBuildPlan(source, root),
    })).toMatchObject({
      action: {
        kind: "needs_user",
        reason: "retry_exhausted",
        stage: "pass1",
        tasks: [{ task_id: "0", failures: 3, last_error: "gate failure 3" }],
      },
    });

    recordAutomaticBuildAttempt(target, "pass1", "0", "reset");
    expect(acceptedNext(source, root)).toMatchObject({
      action: {
        kind: "extract",
        stage: "pass1",
        tasks: [{ task_id: "0", attempt_number: 4 }],
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
      const result = acceptedNext(source, root, 1);
      expect(result.action.kind).toBe("extract");
      if (result.action.kind !== "extract") throw new Error("expected extract action");
      if (!result.action.tasks) throw new Error("expected extract tasks");
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected sidecar extract task");
      expect(task.input_command.slice(0, 2)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "input",
      ]);
      expect(task.submit_command.slice(0, 2)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "submit",
      ]);
      expect(task.usage_path).toContain("usage.json");
      expect(task).not.toHaveProperty("write_command");
      expect(task).not.toHaveProperty("record_success_command");
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("keeps the paper workspace target across generated task and reset commands", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-paper-target-"));
    const workspace = writeTrustedPaperWorkspace(root);
    const source = path.join(workspace, "source.txt");
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const result = acceptedNext(source, root, 1);
      expect(result.snapshot.target).toMatchObject({
        kind: "paper_workspace",
        workspace_dir: path.resolve(workspace),
        target_ref: { version: "build_target_ref.v2", input_fingerprint: expect.any(String) },
      });
      expect(result.action.kind).toBe("extract");
      if (result.action.kind !== "extract") throw new Error("expected extract action");
      if (!result.action.tasks) throw new Error("expected extract tasks");
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected generated task commands");
      expect(task.input_command.slice(0, 3)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "input", path.resolve(workspace)]);
      expect(task.candidate_command.slice(0, 3)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "candidate", path.resolve(workspace)]);
      expect(task.candidate_command).toContain("{candidate_source}");
      expect(task.submit_command.slice(0, 3)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "submit", path.resolve(workspace)]);
      expect(task.inspect_command.slice(0, 3)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "inspect", path.resolve(workspace)]);
      expect(task.fail_command.slice(0, 3)).toEqual([process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "fail", path.resolve(workspace)]);
      expect(task.usage_path).toContain("usage.json");
      expect(task).not.toHaveProperty("write_command");
      expect(task).not.toHaveProperty("record_failure_command");
      expect(task).not.toHaveProperty("record_success_command");

      const target = resolveAutomaticBuildTarget(source, root);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        recordAutomaticBuildAttempt(target, "pass1", "0", "failure", `gate failure ${attempt}`);
      }
      const exhausted = automaticBuildNext(source, root, 1, {
        build_plan: confirmedStandardBuildPlan(source, root),
      });
      expect(exhausted.action.kind).toBe("needs_user");
      if (!("reset_commands" in exhausted.action)) throw new Error("expected reset commands");
      const resetCommands = exhausted.action.reset_commands;
      if (!resetCommands) throw new Error("expected reset commands");
      expect(resetCommands[0].slice(0, 3)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "record-attempt",
        path.resolve(workspace),
      ]);
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("propagates and prefers an existing technical workspace book id when the source filename differs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-technical-target-"));
    const { workspace, source } = writeTechnicalLearningWorkspace(root);
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const result = acceptedNext(workspace, root, 1);
      expect(result.action.kind).toBe("extract");
      if (result.action.kind !== "extract") throw new Error("expected extract action");
      if (!result.action.tasks) throw new Error("expected extract tasks");
      const task = result.action.tasks[0];
      if (!("input_command" in task)) throw new Error("expected generated task commands");

      for (const command of [
        task.input_command,
        task.candidate_command,
        task.submit_command,
        task.fail_command,
        task.inspect_command,
        task.heartbeat_command,
      ]) {
        const commandBookIdIndex = command.indexOf("--book-id");
        expect(command.slice(commandBookIdIndex, commandBookIdIndex + 2)).toEqual(["--book-id", "stable-guide"]);
      }
      const bookIdIndex = task.input_command.indexOf("--book-id");
      expect(task.input_command).toContain(path.resolve(source));

      const resolved = resolveAutomaticBuildTarget(source, root, { book_id: task.input_command[bookIdIndex + 1] });
      expect(resolved).toMatchObject({
        book_id: "stable-guide",
        workspace_dir: path.resolve(workspace),
        source_path: path.resolve(source),
      });
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("propagates the resolved book id through executor dispatch commands", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-dispatch-target-"));
    const source = path.join(root, "dispatch-guide.md");
    writeFileSync(source, "# Dispatch guide\n\nA compact source paragraph.\n", "utf8");
    const buildPlan = confirmedStandardBuildPlan(source, root);
    const plan = automaticBuildPlan(source, root, {
      requested_workers: 1,
      available_agent_slots: 1,
      build_plan: buildPlan,
    });
    if (!plan.preflight) throw new Error("expected automatic build preflight");

    const result = automaticBuildNext(source, root, 1, {
      owner: "dispatch-book-id-test",
      now: "2026-07-30T14:00:00.000Z",
      available_agent_slots: 1,
      accepted_plan_digest: plan.preflight.plan_digest,
      executor_dispatches: true,
      build_plan: buildPlan,
    });
    if (!("dispatches" in result.action) || !result.action.dispatches) {
      throw new Error("expected executor dispatch handoff");
    }
    expect(result.action.dispatches).toHaveLength(1);
    for (const command of [
      result.action.dispatches[0].next_command,
      result.action.dispatches[0].inspect_command,
      result.action.dispatches[0].finish_command,
      result.action.dispatches[0].interrupt_command,
    ]) {
      const bookIdIndex = command.indexOf("--book-id");
      expect(command.slice(bookIdIndex, bookIdIndex + 2)).toEqual(["--book-id", "dispatch-guide"]);
    }
  });

  it("emits a canonical paper close command without exposing source.txt as the target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-paper-close-"));
    const workspace = writeTrustedPaperWorkspace(root);
    const sourcePath = path.join(workspace, "source.txt");
    const source = readFileSync(sourcePath, "utf8");
    const lidNodes = segment(markdownToBlocks(source));
    const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
    const windows = splitWindows(lidNodes, source);
    const profile = resolveContentProfile("paper");
    const target = resolveAutomaticBuildTarget(workspace, root);
    for (const window of windows) {
      const sourceLid = window.leafLids[0];
      writeJson(
        path.join(workspace, ".build", "pass1", `${window.id}.json`),
        pass1Envelope(target, window.id, buildPass1Artifact(window, byLid, source, {
          nodes: [{
            id: `claim:${sourceLid}:quality-gate`,
            type: "claim",
            name: "Grounded fixture claim",
            occurrences: [],
            source_lid: sourceLid,
          }],
          edges: [],
        }, profile)),
      );
    }
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const result = automaticBuildNext(workspace, root, 1, {
        build_plan: confirmedStandardBuildPlan(workspace, root),
      });
      expect(result.action).toMatchObject({ kind: "close_stage", stage: "pass1" });
      if (!("command" in result.action)) throw new Error("expected close command");
      expect(result.action.command.slice(0, 4)).toEqual([
        process.env.UNDERSTAND_BOOK_SIDECAR_SELF,
        "close",
        path.resolve(workspace),
        "pass1",
      ]);
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });
});
