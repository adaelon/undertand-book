import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalBuildJson } from "../../packages/core/src/build-intent";
import type { BuildIntentV1, BuildPlanV1 } from "../../packages/core/src/build-intent";
import {
  failIntentArtifactTaskAttempt,
  inspectIntentArtifactTaskAttempt,
  openIntentArtifactTaskAttempt,
  submitIntentArtifactTaskAttempt,
  type FailIntentArtifactTaskAttemptInput,
  type OpenIntentArtifactTaskAttemptInput,
  type SubmitIntentArtifactTaskAttemptInput,
} from "../../packages/core/src/intent-artifact-mailbox";
import {
  compileIntentArtifactTasks,
  type IntentArtifactTaskEnvelopeV1,
} from "../../packages/core/src/intent-artifact";

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

export interface PrepareIntentArtifactMailboxInput {
  private_root: string;
  intent: BuildIntentV1;
  plan: BuildPlanV1;
  available_lids: string[];
  resolved_scope_lids: string[];
  created_at: string;
  max_attempts?: number;
}

export interface IntentArtifactTaskBatchHandoffV1 {
  version: "intent_artifact_task_batch_handoff.v1";
  book_id: string;
  intent_id: string;
  plan_id: string;
  plan_digest: string;
  tasks: ReturnType<typeof openIntentArtifactTaskAttempt>[];
}

export type IntentArtifactMailboxCommandV1 =
  | {
      version: "intent_artifact_mailbox_command.v1";
      operation: "prepare";
      input: PrepareIntentArtifactMailboxInput;
    }
  | {
      version: "intent_artifact_mailbox_command.v1";
      operation: "start";
      input: OpenIntentArtifactTaskAttemptInput;
    }
  | {
      version: "intent_artifact_mailbox_command.v1";
      operation: "submit";
      input: SubmitIntentArtifactTaskAttemptInput;
    }
  | {
      version: "intent_artifact_mailbox_command.v1";
      operation: "fail";
      input: FailIntentArtifactTaskAttemptInput;
    }
  | {
      version: "intent_artifact_mailbox_command.v1";
      operation: "inspect";
      input: { private_root: string; task_path: string };
    };

function parseCommand(input: unknown): IntentArtifactMailboxCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("intent.artifact requires one command object");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (canonicalBuildJson(keys) !== canonicalBuildJson(["input", "operation", "version"])) {
    throw new Error("intent.artifact command has unrecognized keys");
  }
  if (record.version !== "intent_artifact_mailbox_command.v1") {
    throw new Error("unsupported intent.artifact command version");
  }
  if (!["prepare", "start", "submit", "fail", "inspect"].includes(String(record.operation))) {
    throw new Error("unsupported intent.artifact operation");
  }
  if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
    throw new Error("intent.artifact command requires an input object");
  }
  const inputRecord = record.input as Record<string, unknown>;
  const allowedInputKeys: Record<string, readonly string[]> = {
    prepare: [
      "private_root",
      "intent",
      "plan",
      "available_lids",
      "resolved_scope_lids",
      "created_at",
      "max_attempts",
    ],
    start: ["private_root", "artifact_directory", "task", "created_at", "max_attempts"],
    submit: [
      "private_root",
      "task_path",
      "current_intent",
      "current_plan",
      "current_source_fingerprint",
      "available_lids",
      "resolved_scope_lids",
      "accepted_at",
      "max_candidate_bytes",
    ],
    fail: ["private_root", "task_path", "diagnostic_code", "message", "failed_at"],
    inspect: ["private_root", "task_path"],
  };
  const allowed = new Set(allowedInputKeys[String(record.operation)]);
  const unknownInputKeys = Object.keys(inputRecord).filter((key) => !allowed.has(key));
  if (unknownInputKeys.length) {
    throw new Error(`intent.artifact input has unrecognized keys: ${unknownInputKeys.join(", ")}`);
  }
  return record as unknown as IntentArtifactMailboxCommandV1;
}

function normalizeTimestamp(value: string): string {
  if (!/^\d+$/u.test(value)) return value;
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new Error("intent.artifact timestamp is invalid");
  return date.toISOString();
}

export function runIntentArtifactMailboxCommand(input: unknown): unknown {
  const command = parseCommand(input);
  switch (command.operation) {
    case "prepare":
      return prepareIntentArtifactMailboxes({
        ...command.input,
        created_at: normalizeTimestamp(command.input.created_at),
      });
    case "start":
      return openIntentArtifactTaskAttempt({
        ...command.input,
        created_at: normalizeTimestamp(command.input.created_at),
      });
    case "submit":
      return submitIntentArtifactTaskAttempt({
        ...command.input,
        accepted_at: normalizeTimestamp(command.input.accepted_at),
      });
    case "fail":
      return failIntentArtifactTaskAttempt({
        ...command.input,
        failed_at: normalizeTimestamp(command.input.failed_at),
      });
    case "inspect":
      return inspectIntentArtifactTaskAttempt(command.input);
  }
}

function artifactDirectory(privateRoot: string, task: IntentArtifactTaskEnvelopeV1): string {
  return path.join(
    privateRoot,
    task.book_id,
    "artifacts",
    task.intent_id,
    task.artifact.artifact_id,
  );
}

export function prepareIntentArtifactMailboxes(
  input: PrepareIntentArtifactMailboxInput,
): IntentArtifactTaskBatchHandoffV1 {
  const tasks = compileIntentArtifactTasks({
    intent: input.intent,
    plan: input.plan,
    available_lids: input.available_lids,
    resolved_scope_lids: input.resolved_scope_lids,
  });
  return {
    version: "intent_artifact_task_batch_handoff.v1",
    book_id: input.plan.book_id,
    intent_id: input.intent.intent_id,
    plan_id: input.plan.plan_id,
    plan_digest: input.plan.plan_digest,
    tasks: tasks.map((task) => openIntentArtifactTaskAttempt({
      private_root: input.private_root,
      artifact_directory: artifactDirectory(input.private_root, task),
      task,
      created_at: input.created_at,
      ...(input.max_attempts === undefined ? {} : { max_attempts: input.max_attempts }),
    })),
  };
}

function readCommand(): unknown {
  const body = readFileSync(0);
  if (!body.byteLength) throw new Error("intent.artifact requires one JSON request on stdin");
  if (body.byteLength > MAX_STDIN_BYTES) throw new Error(`intent.artifact stdin exceeds ${MAX_STDIN_BYTES} bytes`);
  return JSON.parse(body.toString("utf8")) as unknown;
}

function isCommandEntrypoint(): boolean {
  return path.basename(process.argv[1] ?? "") === "intent-artifact.ts";
}

if (isCommandEntrypoint()) {
  try {
    process.stdout.write(`${canonicalBuildJson(runIntentArtifactMailboxCommand(readCommand()))}\n`);
  } catch {
    process.stderr.write("intent.artifact failed; inspect the private task attempt for diagnostics\n");
    process.exitCode = 2;
  }
}
