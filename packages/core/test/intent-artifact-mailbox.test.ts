import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileBuildMode } from "../src/build-capability";
import {
  transitionBuildIntent,
  transitionBuildPlan,
  validateBuildIntentV1,
  type BuildIntentV1,
  type BuildPlanV1,
} from "../src/build-intent";
import {
  failIntentArtifactTaskAttempt,
  inspectIntentArtifactTaskAttempt,
  openIntentArtifactTaskAttempt,
  submitIntentArtifactTaskAttempt,
} from "../src/intent-artifact-mailbox";
import {
  compileIntentArtifactTasks,
  type IntentArtifactCandidateV1,
  type IntentArtifactTaskEnvelopeV1,
} from "../src/intent-artifact";
import { runIntentArtifactMailboxCommand } from "../../../skills/build/intent-artifact";

const availableLids = ["1.1", "1.2", "2.1"];
const resolvedScopeLids = ["1.1", "1.2"];

function confirmedSelection(): { intent: BuildIntentV1; plan: BuildPlanV1 } {
  const draftIntent = validateBuildIntentV1({
    version: "build_intent.v1",
    intent_id: "intent-private-mailbox",
    revision: 1,
    book_id: "book-a",
    source_fingerprint: "source-a",
    content_profile: { id: "technical_learning", version: "technical_learning_v0" },
    user_goal: "PRIVATE_MAILBOX_SENTINEL compare the sequence and concepts.",
    goal_kind: "compare",
    source_scope: { whole_book: false, lids: ["1.1", "1.2"], sections: [] },
    desired_artifacts: ["timeline", "concept_map"],
    usage_horizon: "project",
    privacy: "reader_private",
    status: "draft",
    created_at: "2026-07-26T01:00:00.000Z",
  });
  const draftPlan = compileBuildMode({
    mode: "goal_directed",
    book_id: draftIntent.book_id,
    source_fingerprint: draftIntent.source_fingerprint,
    content_profile: draftIntent.content_profile,
    plan_id: "plan-private-mailbox",
    revision: 1,
    created_at: draftIntent.created_at,
    budget: { max_total_tokens: 20_000, on_exceed: "needs_user" },
    public_freshness: [],
    intent: draftIntent,
  }).plan!;
  return {
    intent: transitionBuildIntent(draftIntent, "confirmed", { at: "2026-07-26T01:01:00.000Z" }),
    plan: transitionBuildPlan(draftPlan, "confirmed", {
      at: "2026-07-26T01:01:00.000Z",
      confirmation_source: "reader_ui",
    }),
  };
}

function fixture() {
  const privateRoot = mkdtempSync(path.join(tmpdir(), "understand-book-intent-mailbox-"));
  const selection = confirmedSelection();
  const tasks = compileIntentArtifactTasks({
    ...selection,
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
  });
  const directory = (task: IntentArtifactTaskEnvelopeV1) => path.join(
    privateRoot,
    task.book_id,
    "artifacts",
    task.intent_id,
    task.artifact.artifact_id,
  );
  return { privateRoot, ...selection, tasks, directory };
}

function candidate(task: IntentArtifactTaskEnvelopeV1, payload: unknown): IntentArtifactCandidateV1 {
  return {
    version: "intent_artifact_candidate.v1",
    task_id: task.task_id,
    book_id: task.book_id,
    source_fingerprint: task.source_fingerprint,
    intent_id: task.intent_id,
    intent_digest: task.intent_digest,
    plan_id: task.plan_id,
    plan_digest: task.plan_digest,
    artifact_id: task.artifact.artifact_id,
    artifact_type: task.artifact.artifact_type,
    payload,
  };
}

function submitInput(f: ReturnType<typeof fixture>, taskPath: string) {
  return {
    private_root: f.privateRoot,
    task_path: taskPath,
    current_intent: f.intent,
    current_plan: f.plan,
    current_source_fingerprint: "source-a",
    available_lids: availableLids,
    resolved_scope_lids: resolvedScopeLids,
    accepted_at: "2026-07-26T01:03:00.000Z",
  } as const;
}

describe("IP7 reader-private task-owned artifact mailbox", () => {
  it("opens one isolated attempt per artifact and exposes only an opaque task path", () => {
    const f = fixture();
    const handoffs = f.tasks.map((task) => openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(task),
      task,
      created_at: "2026-07-26T01:02:00.000Z",
    }));

    expect(handoffs.map((handoff) => handoff.attempt)).toEqual([1, 1]);
    expect(new Set(handoffs.map((handoff) => path.dirname(handoff.task_path))).size).toBe(2);
    for (const handoff of handoffs) {
      const serialized = JSON.stringify(handoff);
      expect(serialized).not.toContain("PRIVATE_MAILBOX_SENTINEL");
      expect(serialized).not.toContain("output_contract");
      expect(serialized).not.toContain("allowed_evidence_lids");
      expect(readFileSync(handoff.task_path, "utf8")).toContain("PRIVATE_MAILBOX_SENTINEL");
      expect(path.basename(handoff.task_path)).toBe("task.json");
    }
  });

  it("commits only the task-owned candidate and returns an idempotent body-free receipt", () => {
    const f = fixture();
    const task = f.tasks[0];
    const artifactDirectory = f.directory(task);
    const handoff = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: artifactDirectory,
      task,
      created_at: "2026-07-26T01:02:00.000Z",
    });
    const candidatePath = path.join(path.dirname(handoff.task_path), "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate(task, {
      items: [{ id: "event-1", label: "Private result body", evidence_lids: ["1.1"] }],
    })), "utf8");

    const first = submitIntentArtifactTaskAttempt(submitInput(f, handoff.task_path));
    const second = submitIntentArtifactTaskAttempt(submitInput(f, handoff.task_path));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      version: "intent_artifact_mailbox_receipt.v1",
      state: "committed",
      task_id: task.task_id,
      attempt: 1,
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("PRIVATE_MAILBOX_SENTINEL");
    expect(serialized).not.toContain("Private result body");
    expect(serialized).not.toContain("evidence_lids");
    expect(serialized).not.toContain(f.privateRoot);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4_096);
    expect(readFileSync(path.join(artifactDirectory, "accepted.json"), "utf8")).toContain("Private result body");
    expect(inspectIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      task_path: handoff.task_path,
    })).toEqual(first);

    writeFileSync(candidatePath, JSON.stringify(candidate(task, {
      items: [{ id: "event-2", label: "Conflicting body", evidence_lids: ["1.2"] }],
    })), "utf8");
    expect(() => submitIntentArtifactTaskAttempt(submitInput(f, handoff.task_path))).toThrow(/candidate hash/i);
  });

  it("records private failure detail, retries in a new attempt, and leaves sibling artifacts untouched", () => {
    const f = fixture();
    const [timeline, concept] = f.tasks;
    const timelineFirst = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(timeline),
      task: timeline,
      created_at: "2026-07-26T01:02:00.000Z",
    });
    const conceptFirst = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(concept),
      task: concept,
      created_at: "2026-07-26T01:02:00.000Z",
    });
    const failure = failIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      task_path: timelineFirst.task_path,
      diagnostic_code: "provider_unavailable",
      message: "PRIVATE_FAILURE_SENTINEL provider returned a private excerpt",
      failed_at: "2026-07-26T01:03:00.000Z",
    });
    expect(failure).toMatchObject({ state: "retryable_failure", attempt: 1 });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_FAILURE_SENTINEL");
    expect(readFileSync(path.join(path.dirname(timelineFirst.task_path), "failure-detail.json"), "utf8"))
      .toContain("PRIVATE_FAILURE_SENTINEL");

    const timelineRetry = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(timeline),
      task: timeline,
      created_at: "2026-07-26T01:04:00.000Z",
    });
    expect(timelineRetry.attempt).toBe(2);
    expect(inspectIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      task_path: conceptFirst.task_path,
    })).toMatchObject({ state: "pending", attempt: 1, task_id: concept.task_id });
    expect(existsSync(path.join(f.directory(concept), "accepted.json"))).toBe(false);
  });

  it("rejects public/out-of-root paths, a second owner, and cross-task candidates", () => {
    const f = fixture();
    const [timeline, concept] = f.tasks;
    const outside = mkdtempSync(path.join(tmpdir(), "understand-book-public-artifact-"));
    expect(() => openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: outside,
      task: timeline,
      created_at: "2026-07-26T01:02:00.000Z",
    })).toThrow(/private root/i);

    const handoff = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(timeline),
      task: timeline,
      created_at: "2026-07-26T01:02:00.000Z",
    });
    expect(() => openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(timeline),
      task: concept,
      created_at: "2026-07-26T01:03:00.000Z",
    })).toThrow(/owner/i);

    mkdirSync(path.dirname(handoff.task_path), { recursive: true });
    writeFileSync(
      path.join(path.dirname(handoff.task_path), "candidate.json"),
      JSON.stringify(candidate(concept, { nodes: [], links: [] })),
      "utf8",
    );
    expect(() => submitIntentArtifactTaskAttempt(submitInput(f, handoff.task_path))).toThrow(/task_id/i);
  });

  it("runs prepare, submit, and inspect through one stdin-safe Sidecar command surface", () => {
    const f = fixture();
    const task = f.tasks[0];
    const prepared = runIntentArtifactMailboxCommand({
      version: "intent_artifact_mailbox_command.v1",
      operation: "prepare",
      input: {
        private_root: f.privateRoot,
        intent: f.intent,
        plan: f.plan,
        available_lids: availableLids,
        resolved_scope_lids: resolvedScopeLids,
        created_at: "1785037320000",
      },
    });
    expect(prepared).toMatchObject({
      version: "intent_artifact_task_batch_handoff.v1",
      book_id: task.book_id,
      intent_id: task.intent_id,
      plan_id: task.plan_id,
      tasks: [
        { task_id: task.task_id, attempt: 1 },
        { task_id: f.tasks[1].task_id, attempt: 1 },
      ],
    });
    const taskPath = (prepared as { tasks: Array<{ task_path: string }> }).tasks[0].task_path;
    expect(JSON.parse(readFileSync(path.join(path.dirname(taskPath), "attempt.json"), "utf8")).created_at)
      .toBe("2026-07-26T03:42:00.000Z");
    writeFileSync(path.join(path.dirname(taskPath), "candidate.json"), JSON.stringify(candidate(task, {
      items: [{ id: "event-sidecar", label: "PRIVATE_SIDECAR_BODY", evidence_lids: ["1.1"] }],
    })), "utf8");
    const submit = runIntentArtifactMailboxCommand({
      version: "intent_artifact_mailbox_command.v1",
      operation: "submit",
      input: { ...submitInput(f, taskPath), accepted_at: "1785037380000" },
    });
    const inspect = runIntentArtifactMailboxCommand({
      version: "intent_artifact_mailbox_command.v1",
      operation: "inspect",
      input: { private_root: f.privateRoot, task_path: taskPath },
    });
    expect(inspect).toEqual(submit);
    expect((submit as { terminal_at: string }).terminal_at).toBe("2026-07-26T03:43:00.000Z");
    for (const output of [prepared, submit, inspect]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain("PRIVATE_MAILBOX_SENTINEL");
      expect(serialized).not.toContain("PRIVATE_SIDECAR_BODY");
      expect(serialized).not.toContain("evidence_lids");
    }
    expect(readFileSync(path.resolve(process.cwd(), "../../skills/build/sidecar-entry.ts"), "utf8"))
      .toContain('command === "intent.artifact"');
    expect(() => runIntentArtifactMailboxCommand({
      version: "intent_artifact_mailbox_command.v1",
      operation: "inspect",
      input: { private_root: f.privateRoot, task_path: taskPath, candidate_body: "PRIVATE_SIDECAR_BODY" },
    })).toThrow(/unrecognized keys/i);
  });

  it("never trusts an executor-authored receipt as a root-safe projection", () => {
    const f = fixture();
    const task = f.tasks[0];
    const handoff = openIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      artifact_directory: f.directory(task),
      task,
      created_at: "2026-07-26T01:02:00.000Z",
    });
    writeFileSync(path.join(path.dirname(handoff.task_path), "receipt.json"), JSON.stringify({
      version: "intent_artifact_mailbox_receipt.v1",
      state: "committed",
      task_id: task.task_id,
      artifact_id: task.artifact.artifact_id,
      artifact_type: task.artifact.artifact_type,
      attempt: 1,
      intent_digest: task.intent_digest,
      plan_digest: task.plan_digest,
      terminal_at: "2026-07-26T01:03:00.000Z",
      payload: "PRIVATE_FORGED_RECEIPT_BODY",
    }), "utf8");
    expect(() => inspectIntentArtifactTaskAttempt({
      private_root: f.privateRoot,
      task_path: handoff.task_path,
    })).toThrow(/unrecognized keys/i);
  });
});
