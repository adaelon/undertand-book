import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { canonicalBuildJson } from "../../packages/core/src/build-intent";
import {
  validateBuildIntentV3,
  validateBuildPlanV3,
  type BuildIntentAny,
  type BuildPlanAny,
} from "../../packages/core/src/build-intent-v2";
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
  type IntentArtifactTaskEnvelopeV3,
} from "../../packages/core/src/intent-artifact";

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

export interface PrepareIntentArtifactMailboxInput {
  private_root: string;
  intent: BuildIntentAny;
  plan: BuildPlanAny;
  available_lids: string[];
  resolved_scope_lids: string[];
  created_at: string;
  max_attempts?: number;
}

export interface IntentArtifactTaskBatchHandoffV2 {
  version: "intent_artifact_task_batch_handoff.v2";
  book_id: string;
  intent_id: string;
  intent_revision: number;
  plan_id: string;
  plan_revision: number;
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

function artifactDirectory(privateRoot: string, task: IntentArtifactTaskEnvelopeV3): string {
  return path.join(
    privateRoot,
    task.book_id,
    "artifacts",
    task.intent_id,
    task.artifact.artifact_id,
  );
}

function artifactAlreadyCommitted(
  privateRoot: string,
  task: IntentArtifactTaskEnvelopeV3,
): boolean {
  const directory = artifactDirectory(privateRoot, task);
  const acceptedPath = path.join(directory, "accepted.v3.json");
  if (!existsSync(acceptedPath)) return false;
  const attemptsDirectory = path.join(directory, "attempts-v3");
  if (!existsSync(attemptsDirectory)) {
    throw new Error("legacy accepted intent artifact requires migration before V3 production read");
  }
  const latest = readdirSync(attemptsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{6}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!latest) throw new Error("accepted intent artifact has no task attempt");
  const inspection = inspectIntentArtifactTaskAttempt({
    private_root: privateRoot,
    task_path: path.join(attemptsDirectory, latest, "task.json"),
  });
  if (inspection.state !== "committed"
    || inspection.task_id !== task.task_id
    || inspection.intent_id !== task.intent_id
    || inspection.intent_revision !== task.intent_revision
    || inspection.plan_id !== task.plan_id
    || inspection.plan_revision !== task.plan_revision
    || inspection.artifact_id !== task.artifact.artifact_id
    || inspection.blueprint_id !== task.artifact.blueprint_id
    || inspection.blueprint_version !== task.artifact.blueprint_version) {
    throw new Error("accepted intent artifact does not match the current task");
  }
  return true;
}

export function prepareIntentArtifactMailboxes(
  input: PrepareIntentArtifactMailboxInput,
): IntentArtifactTaskBatchHandoffV2 {
  const intent = validateBuildIntentV3(input.intent);
  const plan = validateBuildPlanV3(input.plan);
  const tasks = compileIntentArtifactTasks({
    intent,
    plan,
    available_lids: input.available_lids,
    resolved_scope_lids: input.resolved_scope_lids,
  });
  return {
    version: "intent_artifact_task_batch_handoff.v2",
    book_id: plan.book_id,
    intent_id: intent.intent_id,
    intent_revision: intent.intent_revision,
    plan_id: plan.plan_id,
    plan_revision: plan.plan_revision,
    tasks: tasks
      .filter((task) => !artifactAlreadyCommitted(input.private_root, task))
      .map((task) => openIntentArtifactTaskAttempt({
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
