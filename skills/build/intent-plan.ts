import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  confirmBuildIntentSelection,
  draftBuildIntentSelection,
  projectCodexBuildIntentSelection,
  redactBuildIntentSelection,
  rejectBuildIntentSelection,
  markBuildIntentSelectionStale,
  supersedeBuildIntentSelection,
  type BuildIntentSelection,
  type DraftBuildIntentSelectionInput,
} from "../../packages/core/src/build-intent-controller";
import { canonicalBuildJson } from "../../packages/core/src/build-intent";
import {
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  type AutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";

interface IntentPlanFreshnessTargetV1 {
  version: "intent_plan_freshness_target.v1";
  book_id: string;
  source_fingerprint: string;
  profile_id: "technical_learning" | "paper";
  root_dir: string;
  workspace_dir: string;
  source_path: string;
}

type IntentPlanRequest =
  | { operation: "draft"; input: DraftBuildIntentSelectionInput }
  | {
      operation: "confirm";
      selection: BuildIntentSelection;
      confirmation: Parameters<typeof confirmBuildIntentSelection>[1];
    }
  | { operation: "reject"; selection: BuildIntentSelection }
  | { operation: "redact"; selection: BuildIntentSelection }
  | { operation: "project_codex"; selection: BuildIntentSelection }
  | { operation: "supersede"; selection: BuildIntentSelection }
  | { operation: "stale_source"; selection: BuildIntentSelection }
  | { operation: "inspect_freshness"; target: IntentPlanFreshnessTargetV1 };

function readRequest(): IntentPlanRequest {
  const body = readFileSync(0, "utf8");
  if (!body.trim()) throw new Error("intent.plan requires one JSON request on stdin");
  return JSON.parse(body) as IntentPlanRequest;
}

function normalizeTimestamp(value: string): string {
  if (!/^\d+$/u.test(value)) return value;
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new Error("intent.plan timestamp is invalid");
  return date.toISOString();
}

function inspectFreshness(input: IntentPlanFreshnessTargetV1) {
  if (input.version !== "intent_plan_freshness_target.v1") {
    throw new Error("unsupported intent freshness target version");
  }
  if (!input.book_id.trim() || !input.source_fingerprint.match(/^[a-f0-9]{64}$/u)) {
    throw new Error("intent freshness target identity is invalid");
  }
  if (input.profile_id !== "technical_learning" && input.profile_id !== "paper") {
    throw new Error("intent freshness target profile is invalid");
  }
  const rootDir = path.resolve(input.root_dir);
  const workspaceDir = path.resolve(input.workspace_dir);
  const sourcePath = path.resolve(input.source_path);
  if (!statSync(workspaceDir).isDirectory() || !statSync(sourcePath).isFile()) {
    throw new Error("intent freshness target paths are unavailable");
  }
  const sourceDigest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  if (sourceDigest !== input.source_fingerprint) {
    throw new Error("intent freshness target source fingerprint is stale");
  }
  const target: AutomaticBuildTarget = {
    kind: input.profile_id === "paper" ? "paper_workspace" : "source_file",
    profile_id: input.profile_id,
    book_id: input.book_id,
    root_dir: rootDir,
    workspace_dir: workspaceDir,
    source_path: sourcePath,
    target_ref: {
      version: "build_target_ref.v2",
      workspace_dir: workspaceDir,
      book_id: input.book_id,
      profile_id: input.profile_id,
      input_fingerprint: input.source_fingerprint,
    },
  };
  return {
    version: "intent_build_public_freshness.v1",
    public_freshness: inspectAutomaticBuildStageFreshness(
      buildAutomaticBuildSnapshot(target, { quality_profile: "full" }),
      { quality_profile: "full" },
    ),
  };
}

function run(request: IntentPlanRequest): unknown {
  switch (request.operation) {
    case "draft":
      return draftBuildIntentSelection({
        ...request.input,
        now: normalizeTimestamp(request.input.now),
      });
    case "confirm":
      return confirmBuildIntentSelection(request.selection, {
        ...request.confirmation,
        at: normalizeTimestamp(request.confirmation.at),
      });
    case "reject":
      return rejectBuildIntentSelection(request.selection);
    case "redact":
      return redactBuildIntentSelection(request.selection);
    case "project_codex":
      return projectCodexBuildIntentSelection(request.selection);
    case "supersede":
      return supersedeBuildIntentSelection(request.selection);
    case "stale_source":
      return markBuildIntentSelectionStale(request.selection);
    case "inspect_freshness":
      return inspectFreshness(request.target);
    default:
      throw new Error("unsupported intent.plan operation");
  }
}

try {
  process.stdout.write(`${canonicalBuildJson(run(readRequest()))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "intent.plan failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
