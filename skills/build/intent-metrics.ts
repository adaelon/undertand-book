import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalBuildJson } from "../../packages/core/src/build-intent";
import { automaticBuildTaskMetricsUsageEvent } from "../../packages/core/src/automatic-build-metrics";
import {
  appendIntentBuildUsageEvent,
  deleteIntentBuildUsageForIntent,
  planSelectedUsageEvent,
  replayIntentBuildUsageLedger,
} from "../../packages/core/src/intent-build-metrics";

const MAX_STDIN_BYTES = 1024 * 1024;

type IntentMetricsCommandV1 =
  | {
      version: "intent_build_usage_command.v1";
      operation: "append";
      input: { private_root: string; event: unknown };
    }
  | {
      version: "intent_build_usage_command.v1";
      operation: "append_automatic_cost";
      input: {
        private_root: string;
        plan: Parameters<typeof automaticBuildTaskMetricsUsageEvent>[0]["plan"];
        metrics: Parameters<typeof automaticBuildTaskMetricsUsageEvent>[0]["metrics"];
        occurred_at: string;
      };
    }
  | {
      version: "intent_build_usage_command.v1";
      operation: "append_plan_selected";
      input: {
        private_root: string;
        event_id: string;
        book_id: string;
        occurred_at: string;
        mode: "read_now" | "standard_deep" | "goal_directed";
        plan: Parameters<typeof planSelectedUsageEvent>[0]["plan"];
      };
    }
  | {
      version: "intent_build_usage_command.v1";
      operation: "report";
      input: { private_root: string; book_id: string; as_of: string; window_days?: number };
    }
  | {
      version: "intent_build_usage_command.v1";
      operation: "delete_intent";
      input: { private_root: string; book_id: string; intent_id: string };
    };

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (canonicalBuildJson(actual) !== canonicalBuildJson(expected)) {
    throw new Error(`${field} has unrecognized or missing keys`);
  }
}

function parseCommand(input: unknown): IntentMetricsCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("intent.metrics requires one command object");
  }
  const command = input as Record<string, unknown>;
  exactKeys(command, ["version", "operation", "input"], "intent.metrics command");
  if (command.version !== "intent_build_usage_command.v1") throw new Error("unsupported intent.metrics version");
  if (!command.input || typeof command.input !== "object" || Array.isArray(command.input)) {
    throw new Error("intent.metrics requires an input object");
  }
  const body = command.input as Record<string, unknown>;
  switch (command.operation) {
    case "append":
      exactKeys(body, ["private_root", "event"], "append input");
      break;
    case "append_automatic_cost":
      exactKeys(body, ["private_root", "plan", "metrics", "occurred_at"], "append_automatic_cost input");
      break;
    case "append_plan_selected":
      exactKeys(body, ["private_root", "event_id", "book_id", "occurred_at", "mode", "plan"], "append_plan_selected input");
      break;
    case "report": {
      const keys = Object.keys(body).sort();
      const withoutWindow = ["as_of", "book_id", "private_root"];
      const withWindow = [...withoutWindow, "window_days"].sort();
      if (canonicalBuildJson(keys) !== canonicalBuildJson(withoutWindow)
        && canonicalBuildJson(keys) !== canonicalBuildJson(withWindow)) {
        throw new Error("report input has unrecognized or missing keys");
      }
      break;
    }
    case "delete_intent":
      exactKeys(body, ["private_root", "book_id", "intent_id"], "delete_intent input");
      break;
    default:
      throw new Error("unsupported intent.metrics operation");
  }
  return command as unknown as IntentMetricsCommandV1;
}

function timestamp(value: string): string {
  if (!/^\d+$/u.test(value)) return value;
  const parsed = new Date(Number(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("intent.metrics timestamp is invalid");
  return parsed.toISOString();
}

export function runIntentMetricsCommand(input: unknown): unknown {
  const command = parseCommand(input);
  switch (command.operation) {
    case "append":
      return appendIntentBuildUsageEvent(command.input.private_root, command.input.event);
    case "append_automatic_cost": {
      const event = automaticBuildTaskMetricsUsageEvent({
        plan: command.input.plan,
        metrics: command.input.metrics,
        occurred_at: timestamp(command.input.occurred_at),
      });
      return event
        ? appendIntentBuildUsageEvent(command.input.private_root, event)
        : { version: "intent_build_usage_append_result.v1", event_id: null, disposition: "skipped" };
    }
    case "append_plan_selected": {
      const event = planSelectedUsageEvent({
        event_id: command.input.event_id,
        book_id: command.input.book_id,
        occurred_at: timestamp(command.input.occurred_at),
        mode: command.input.mode,
        plan: command.input.plan,
      });
      return appendIntentBuildUsageEvent(command.input.private_root, event);
    }
    case "report":
      return replayIntentBuildUsageLedger(command.input.private_root, {
        book_id: command.input.book_id,
        as_of: timestamp(command.input.as_of),
        ...(command.input.window_days === undefined ? {} : { window_days: command.input.window_days }),
      });
    case "delete_intent":
      return deleteIntentBuildUsageForIntent(
        command.input.private_root,
        command.input.book_id,
        command.input.intent_id,
      );
  }
}

function readCommand(): unknown {
  const body = readFileSync(0);
  if (!body.byteLength) throw new Error("intent.metrics requires one JSON request on stdin");
  if (body.byteLength > MAX_STDIN_BYTES) throw new Error(`intent.metrics stdin exceeds ${MAX_STDIN_BYTES} bytes`);
  return JSON.parse(body.toString("utf8")) as unknown;
}

function isCommandEntrypoint(): boolean {
  return path.basename(process.argv[1] ?? "") === "intent-metrics.ts";
}

if (isCommandEntrypoint()) {
  try {
    process.stdout.write(`${canonicalBuildJson(runIntentMetricsCommand(readCommand()))}\n`);
  } catch {
    process.stderr.write("intent.metrics request was rejected\n");
    process.exitCode = 2;
  }
}
