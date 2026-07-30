import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getArtifactBlueprintRegistryEntryV1,
  listArtifactBlueprintRegistryV1,
  recordArtifactBlueprintUseV1,
  resolveArtifactBlueprintV1,
  retireArtifactBlueprintCandidateV1,
  upsertArtifactBlueprintCandidateV1,
} from "../../packages/core/src/artifact-blueprint-registry";
import { canonicalBuildJson } from "../../packages/core/src/build-intent";

const MAX_STDIN_BYTES = 1024 * 1024;

type IntentBlueprintRegistryCommandV1 =
  | { version: "artifact_blueprint_registry_command.v1"; operation: "list"; input: { private_root: string } }
  | {
      version: "artifact_blueprint_registry_command.v1";
      operation: "get";
      input: { private_root: string; blueprint_id: string; blueprint_version: string };
    }
  | {
      version: "artifact_blueprint_registry_command.v1";
      operation: "upsert";
      input: { private_root: string; blueprint: unknown; created_at: string };
    }
  | {
      version: "artifact_blueprint_registry_command.v1";
      operation: "retire";
      input: { private_root: string; blueprint_id: string; blueprint_version: string; retired_at: string };
    }
  | {
      version: "artifact_blueprint_registry_command.v1";
      operation: "record_use";
      input: {
        private_root: string;
        blueprint_id: string;
        blueprint_version: string;
        usage_id: string;
        used_at: string;
      };
    }
  | {
      version: "artifact_blueprint_registry_command.v1";
      operation: "resolve";
      input: { private_root: string; blueprint_id: string; blueprint_version: string; one_off?: unknown };
    };

function object(input: unknown, field: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${field} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (canonicalBuildJson(actual) !== canonicalBuildJson(expected)) {
    throw new Error(`${field} has unrecognized or missing keys`);
  }
}

function parseCommand(input: unknown): IntentBlueprintRegistryCommandV1 {
  const command = object(input, "intent.blueprint command");
  exactKeys(command, ["version", "operation", "input"], "intent.blueprint command");
  if (command.version !== "artifact_blueprint_registry_command.v1") {
    throw new Error("unsupported intent.blueprint command version");
  }
  const body = object(command.input, "intent.blueprint input");
  switch (command.operation) {
    case "list":
      exactKeys(body, ["private_root"], "list input");
      break;
    case "get":
      exactKeys(body, ["private_root", "blueprint_id", "blueprint_version"], "get input");
      break;
    case "upsert":
      exactKeys(body, ["private_root", "blueprint", "created_at"], "upsert input");
      break;
    case "retire":
      exactKeys(body, ["private_root", "blueprint_id", "blueprint_version", "retired_at"], "retire input");
      break;
    case "record_use":
      exactKeys(
        body,
        ["private_root", "blueprint_id", "blueprint_version", "usage_id", "used_at"],
        "record_use input",
      );
      break;
    case "resolve": {
      const keys = Object.keys(body).sort();
      const required = ["private_root", "blueprint_id", "blueprint_version"].sort();
      const withOneOff = [...required, "one_off"].sort();
      if (canonicalBuildJson(keys) !== canonicalBuildJson(required)
        && canonicalBuildJson(keys) !== canonicalBuildJson(withOneOff)) {
        throw new Error("resolve input has unrecognized or missing keys");
      }
      break;
    }
    default:
      throw new Error("unsupported intent.blueprint operation");
  }
  return command as unknown as IntentBlueprintRegistryCommandV1;
}

export function runIntentBlueprintRegistryCommand(input: unknown): unknown {
  const command = parseCommand(input);
  switch (command.operation) {
    case "list":
      return listArtifactBlueprintRegistryV1(command.input.private_root);
    case "get":
      return getArtifactBlueprintRegistryEntryV1(
        command.input.private_root,
        command.input.blueprint_id,
        command.input.blueprint_version,
      );
    case "upsert":
      return upsertArtifactBlueprintCandidateV1(command.input);
    case "retire":
      return retireArtifactBlueprintCandidateV1(command.input);
    case "record_use":
      return recordArtifactBlueprintUseV1(command.input);
    case "resolve":
      return resolveArtifactBlueprintV1(command.input);
  }
}

function readCommand(): unknown {
  const body = readFileSync(0);
  if (!body.byteLength) throw new Error("intent.blueprint requires one JSON request on stdin");
  if (body.byteLength > MAX_STDIN_BYTES) {
    throw new Error(`intent.blueprint stdin exceeds ${MAX_STDIN_BYTES} bytes`);
  }
  return JSON.parse(body.toString("utf8")) as unknown;
}

function isCommandEntrypoint(): boolean {
  return path.basename(process.argv[1] ?? "") === "intent-blueprint.ts";
}

if (isCommandEntrypoint()) {
  try {
    process.stdout.write(`${canonicalBuildJson(runIntentBlueprintRegistryCommand(readCommand()))}\n`);
  } catch {
    process.stderr.write("intent.blueprint request was rejected\n");
    process.exitCode = 2;
  }
}
