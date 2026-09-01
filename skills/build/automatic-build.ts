import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  automaticBuildExtractorForWorkUnitKind,
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  nextAutomaticBuildAction,
  nextPlannedAutomaticBuildAction,
  routeAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type AutomaticBuildStageState,
  type AutomaticBuildTarget,
  type AutomaticBuildTargetResolutionOptions,
  type SemanticExtractor,
} from "../../packages/core/src/build-orchestrator";
import {
  createAutomaticBuildRecoveryEnvelope,
  parseAutomaticBuildRecoveryEnvelope,
  type AutomaticBuildRecoveryEnvelopeV1,
} from "../../packages/core/src/automatic-build-recovery";
import {
  closeAutomaticBuildStage,
  parseAutomaticBuildStageCloseResult,
  verifyAutomaticBuildStageClose,
} from "../../packages/core/src/automatic-build-close";
import {
  observeAutomaticBuildRemainingWork,
} from "../../packages/core/src/automatic-build-observation";
import type { AutomaticBuildPublicationStage } from "../../packages/core/src/automatic-build-publication";
import {
  createAutomaticBuildStagePolicySet,
  freezeAutomaticBuildStagePolicySet,
  validateAutomaticBuildStagePolicySet,
  type AutomaticBuildStagePolicySetV3,
} from "../../packages/core/src/automatic-build-policy-generation";
import {
  assertPass1ShadowCandidatePath,
  freezePass1ShadowTask,
  pass1ModelSlicePolicyMembers,
  pass1ShadowTaskPath,
  pass1ShadowTaskPrivateDirectory,
  readPass1ShadowTask,
  writePass1ShadowCandidate,
} from "../../packages/core/src/pass1-reduction";
import {
  freezeProfileSidecarDiscourseShadowTask,
  freezeProfileSidecarSemanticFastPathTask,
  profileSidecarMapReducePolicyMembers,
  profileSidecarDiscourseShadowTaskPath,
  profileSidecarDiscourseShadowTaskPrivateDirectory,
} from "../../packages/core/src/profile-sidecar-reduction";
import {
  bookStructureGenerationTaskPath,
  freezeBookStructureGenerationTask,
  readBookStructureGenerationTask,
  writeBookStructureGenerationCandidate,
} from "../../packages/core/src/book-structure-generation";
import type { BuildPlanV1 } from "../../packages/core/src/build-intent";
import type { Pass2PlanChoice } from "../../packages/core/src/build-capability";
import { mapLegacyBuildInvocation } from "../../packages/core/src/build-intent-controller";
import {
  readAutomaticBuildAttemptSnapshot,
  listAutomaticBuildStoredAttempts,
  recordAutomaticBuildAttemptEvent,
  type AutomaticBuildAttemptRecord,
  type AutomaticBuildExecutionIdentity,
} from "../../packages/core/src/automatic-build-task-store";
import {
  assertActiveAutomaticBuildLease,
  automaticBuildTaskPolicyBindingFromLease,
  claimAutomaticBuildTask,
  heartbeatAutomaticBuildLease,
  inspectAutomaticBuildTaskClaim,
  readAutomaticBuildLease,
  startAutomaticBuildLease,
  type AutomaticBuildTaskLease,
} from "../../packages/core/src/automatic-build-lease";
import {
  inspectRenderedModelInput,
  MODEL_INPUT_RENDER_CONTRACT_VERSION,
  type ModelInputRenderRequest,
} from "../../packages/core/src/model-input-renderer";
import {
  evaluateModelInputBudget,
  MODEL_INPUT_ESTIMATOR_VERSION,
  verifyModelInputBudgetProof,
} from "../../packages/core/src/model-input-budget";
import type { WorkUnitDescriptor, WorkUnitKind } from "../../packages/core/src/stage-work-unit";
import { parseExtractorContractErrorFromStderr } from "../../packages/core/src/extractor-contract";
import {
  failAutomaticBuildTask,
  inspectAutomaticBuildTask,
  stageAutomaticBuildCandidate,
  submitAutomaticBuildCandidate,
  type AutomaticBuildWriterResult,
  type AutomaticBuildWriterWarnings,
} from "../../packages/core/src/automatic-build-mailbox";
import { inspectPaperLexiconCommittedArtifact } from "../../packages/core/src/paper-lexicon-router";
import {
  automaticBuildStageMetricsSummaryPath,
  automaticBuildUsageReceiptPath,
  buildAutomaticBuildStageMetricsSummary,
  recordAutomaticBuildInputObservation,
  type AutomaticBuildStageMetricsSummaryV1,
  writeAutomaticBuildStageMetricsSummary,
} from "../../packages/core/src/automatic-build-metrics";
import {
  automaticBuildGenerationArtifactPath,
  extractionPolicyFromSemanticContract,
  isAutomaticBuildTaskPolicyBindingV2,
  type ExtractionQualityProfile,
  type SemanticContractV1,
  type SemanticBuildStage,
} from "../../packages/core/src/semantic-artifact";
import {
  automaticBuildPreflightEvaluationEvidence,
  automaticBuildPreflightPlanEvidence,
  buildAutomaticBuildPreflight,
  DEFAULT_AUTOMATIC_BUILD_BUDGET,
  evaluateAutomaticBuildPlanBudget,
  sameAutomaticBuildBudgetEvidence,
  selectAutomaticBuildCostBatch,
  type AutomaticBuildBudgetLimitsV1,
  type AutomaticBuildExecutorProvenanceV1,
  type AutomaticBuildHistoricalUsageV1,
  type AutomaticBuildPlanActualUsageV1,
  type AutomaticBuildPlanBudgetEvaluationV2,
  type AutomaticBuildPreflightEvaluationEvidenceV2,
  type AutomaticBuildPreflightV2,
  type AutomaticBuildWallBudgetV1,
} from "../../packages/core/src/automatic-build-budget";
import {
  auditAutomaticBuildLegacy,
  readAutomaticBuildMigrationDecision,
  selectAutomaticBuildMigrationMode,
  type AutomaticBuildMigrationMode,
} from "../../packages/core/src/automatic-build-legacy";
import {
  automaticBuildStageQualityReportPath,
  collectAutomaticBuildStageQuality,
} from "../../packages/core/src/automatic-build-quality";
import {
  canonicalAutomaticBuildJson,
  AUTOMATIC_BUILD_ACTIVE_RELEASE,
  AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
  AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
  AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  AUTOMATIC_BUILD_PROTOCOL_V2,
  AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1,
  AUTOMATIC_BUILD_RELEASE_V3,
  AUTOMATIC_BUILD_ROUTING_RELEASE,
  resolveAutomaticBuildClaimProtocol,
  type AutomaticBuildClaimProtocol,
} from "../../packages/core/src/automatic-build-protocol";
import {
  advanceAutomaticBuildDispatch,
  AutomaticBuildLegacyPartialDispatchRunError,
  automaticBuildDispatchRunId,
  finishAutomaticBuildDispatch,
  inspectAutomaticBuildDispatch,
  prepareAutomaticBuildDispatch,
  persistAutomaticBuildDispatch,
  readAutomaticBuildDispatch,
  selectAutomaticBuildDispatchHandoff,
  type AutomaticBuildExecutorDispatchReceiptV1,
  type AutomaticBuildExecutorInterruptionInputV1,
} from "../../packages/core/src/automatic-build-dispatch-runtime";
import { issueAutomaticBuildOpaqueHandoff } from "../../packages/core/src/automatic-build-executor-session";
import {
  BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
  createBuildExecutorStdioConnectionCapability,
  validateBuildExecutorRoleConfigV3,
} from "../../packages/core/src/build-executor-connection-capability";
import {
  BUILD_EXECUTOR_MCP_CONTRACT_V3,
  validateBuildExecutorSharedMcpConfigV3,
} from "../../packages/core/src/build-executor-tool-adapter";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "../../packages/core/src/executor-transport";
import {
  composeAutomaticBuildExecutorPrompt,
  type AutomaticBuildExecutorPromptMode,
} from "./executor-prompt";
import { resolveContentProfile } from "../../packages/core/src/content-profile";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import {
  AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES,
  isAutomaticBuildExtractorPromptName,
  type AutomaticBuildExtractorPromptName,
} from "./executor-prompt-cli";

const PLUGIN_ROOT = process.env.UNDERSTAND_BOOK_PLUGIN_ROOT
  ? path.resolve(process.env.UNDERSTAND_BOOK_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = path.join(PLUGIN_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAX_ATTEMPTS = 3;
const MAX_LEASE_EPOCHS = 3;
const DEFAULT_RESERVE_TTL_MS = 600_000;
const DEFAULT_RUN_TTL_MS = 1_800_000;
const MAX_AUTOMATIC_BUILD_EXECUTOR_PROMPT_BYTES = 65_536;
const MAX_AUTOMATIC_BUILD_EXECUTOR_AGENT_TEMPLATE_BYTES = 65_536;
const MAX_AUTOMATIC_BUILD_EXECUTOR_BOUNDARY_ASSET_BYTES = 65_536;
const MAX_DISPATCH_EXECUTOR_HANDOFF_BYTES = 262_144;
const AUTOMATIC_BUILD_STAGES: AutomaticBuildStage[] = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
];

export interface AutomaticBuildNextOptions extends AutomaticBuildTargetResolutionOptions {
  owner?: string;
  now?: string;
  lease_ttl_ms?: number;
  run_ttl_ms?: number;
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
  available_agent_slots?: number;
  accepted_plan_digest?: string;
  accepted_evaluation_evidence?: AutomaticBuildPreflightEvaluationEvidenceV2;
  accepted_plan_budget_evidence?: AutomaticBuildPlanBudgetEvaluationV2;
  protocol?: AutomaticBuildClaimProtocol;
  executor_dispatches?: boolean;
  build_plan?: BuildPlanV1;
}

export interface AutomaticBuildPlanOptions extends AutomaticBuildTargetResolutionOptions {
  quality_profile?: ExtractionQualityProfile;
  budget?: AutomaticBuildBudgetLimitsV1;
  wall_budget?: AutomaticBuildWallBudgetV1;
  executor_provenance?: AutomaticBuildExecutorProvenanceV1;
  requested_workers?: number;
  available_agent_slots?: number;
  build_plan?: BuildPlanV1;
}

interface StageCommands {
  input?: string;
  write?: string;
  close: string | null;
}

const STAGE_COMMANDS: Record<AutomaticBuildStage, StageCommands> = {
  pass1: { input: "emit-input.ts", write: "pass1-write.ts", close: "pass1-batch.ts" },
  paper_metadata: { input: "paper-metadata-input.ts", write: "paper-metadata-write.ts", close: "paper-metadata-batch.ts" },
  paper_lexicon: { input: "paper-lexicon-input.ts", write: "paper-lexicon-write.ts", close: "paper-lexicon-batch.ts" },
  profile_sidecar: { input: "profile-sidecar-input.ts", write: "profile-sidecar-write.ts", close: "profile-sidecar-batch.ts" },
  pass2: { input: "pass2-input.ts", write: "pass2-write.ts", close: "pass2-batch.ts" },
  book_structure: { input: "book-structure-input.ts", write: "book-structure-write.ts", close: "book-structure-batch.ts" },
  paper_reading_guide: { close: null },
};

function extractorPromptName(extractor: SemanticExtractor): AutomaticBuildExtractorPromptName {
  const promptName = `${extractor}.md`;
  if (!isAutomaticBuildExtractorPromptName(promptName)) {
    throw new Error(`automatic build extractor has no registered prompt: ${extractor}`);
  }
  return promptName;
}

function scriptCommand(script: string, args: string[]): string[] {
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  if (sidecar) {
    return script === "automatic-build.ts"
      ? [sidecar, ...args]
      : [sidecar, "run-script", script, ...args];
  }
  return [process.execPath, TSX_CLI, path.join(PLUGIN_ROOT, "skills", "build", script), ...args];
}

function executorPromptCommand(prompt: string, mode: "dispatch" | "task"): string[] {
  const args = [prompt, "--executor-protocol", mode];
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  return sidecar
    ? [sidecar, "prompt", ...args]
    : [process.execPath, TSX_CLI, path.join(PLUGIN_ROOT, "skills", "build", "executor-prompt-cli.ts"), ...args];
}

export type AutomaticBuildPromptSource = "packaged_sidecar" | "node_source";

export type AutomaticBuildExecutorPromptDiagnosticCode =
  | "prompt_provider_unavailable"
  | "prompt_provider_output_invalid"
  | "prompt_contract_invalid";

export interface ResolvedAutomaticBuildExecutorPromptV1 {
  version: "resolved_automatic_build_executor_prompt.v1";
  extractor_name: AutomaticBuildExtractorPromptName;
  mode: AutomaticBuildExecutorPromptMode;
  source: AutomaticBuildPromptSource;
  bytes: Uint8Array;
  sha256: string;
  byte_length: number;
}

export interface ResolvedAutomaticBuildPromptAssetV1 {
  version: "resolved_automatic_build_prompt_asset.v1";
  extractor_name: AutomaticBuildExtractorPromptName;
  source: AutomaticBuildPromptSource;
  bytes: Uint8Array;
  sha256: string;
  byte_length: number;
}

export class AutomaticBuildExecutorPromptResolutionError extends Error {
  readonly name = "AutomaticBuildExecutorPromptResolutionError";

  constructor(
    readonly diagnostic_code: AutomaticBuildExecutorPromptDiagnosticCode,
    readonly source: AutomaticBuildPromptSource,
  ) {
    super(`automatic build executor prompt resolution failed: ${diagnostic_code}`);
  }
}

export function resolveAutomaticBuildExecutorPrompt(
  extractorName: AutomaticBuildExtractorPromptName,
  mode: AutomaticBuildExecutorPromptMode,
): ResolvedAutomaticBuildExecutorPromptV1 {
  if (!isAutomaticBuildExtractorPromptName(extractorName)) {
    throw new AutomaticBuildExecutorPromptResolutionError("prompt_contract_invalid", "node_source");
  }
  const source: AutomaticBuildPromptSource = process.env.UNDERSTAND_BOOK_SIDECAR_SELF
    ? "packaged_sidecar"
    : "node_source";
  let prompt: string;
  if (source === "node_source") {
    try {
      prompt = composeAutomaticBuildExecutorPrompt({
        mode,
        extractor_name: extractorName,
        extractor_prompt: readFileSync(path.join(PLUGIN_ROOT, "agents", extractorName), "utf8"),
        protocol_wrapper: mode === "dispatch"
          ? readFileSync(path.join(PLUGIN_ROOT, "agents", "automatic-build-dispatch-executor.md"), "utf8")
          : "",
      });
    } catch {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_unavailable", source);
    }
  } else {
    const [command, ...args] = executorPromptCommand(extractorName, mode);
    const output = captureBuildProcessOutput(command, args, path.dirname(path.resolve(command)));
    if (output.error || output.status !== 0) {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_unavailable", source);
    }
    if (output.stderr !== "") {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_output_invalid", source);
    }
    prompt = output.stdout;
  }
  const bytes = Buffer.from(prompt, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUTOMATIC_BUILD_EXECUTOR_PROMPT_BYTES) {
    throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_output_invalid", source);
  }
  const requiredMarkers = mode === "dispatch"
    ? [
      "automatic_build_executor_session.v3",
      "opaque_handoff_ref",
      "executor.open",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
      "action.kind=DELIVER_INPUT",
      "action.kind=INPUT_BATCH",
      "action.kind=GENERATE",
      "action.kind=WAIT",
      "action.kind=DONE",
      "Never return candidate JSON to the caller",
    ]
    : ["automatic_build_executor.v1", "candidate_path", "submit_command", "fail_command"];
  if (prompt.includes("\0") || requiredMarkers.some((marker) => !prompt.includes(marker))) {
    throw new AutomaticBuildExecutorPromptResolutionError("prompt_contract_invalid", source);
  }
  return {
    version: "resolved_automatic_build_executor_prompt.v1",
    extractor_name: extractorName,
    mode,
    source,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
  };
}

export function resolveAutomaticBuildPromptAsset(
  extractorName: AutomaticBuildExtractorPromptName,
): ResolvedAutomaticBuildPromptAssetV1 {
  if (!isAutomaticBuildExtractorPromptName(extractorName)) {
    throw new AutomaticBuildExecutorPromptResolutionError("prompt_contract_invalid", "node_source");
  }
  const source: AutomaticBuildPromptSource = process.env.UNDERSTAND_BOOK_SIDECAR_SELF
    ? "packaged_sidecar"
    : "node_source";
  let bytes: Buffer;
  if (source === "packaged_sidecar") {
    const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF!;
    const output = captureBuildProcessOutput(
      sidecar,
      ["prompt", extractorName],
      path.dirname(path.resolve(sidecar)),
    );
    if (output.error || output.status !== 0) {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_unavailable", source);
    }
    if (output.stderr !== "") {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_output_invalid", source);
    }
    bytes = Buffer.from(output.stdout, "utf8");
  } else {
    try {
      bytes = readFileSync(path.join(PLUGIN_ROOT, "agents", extractorName));
    } catch {
      throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_unavailable", source);
    }
  }
  if (bytes.byteLength === 0
    || bytes.byteLength > MAX_AUTOMATIC_BUILD_EXECUTOR_PROMPT_BYTES
    || bytes.includes(0)) {
    throw new AutomaticBuildExecutorPromptResolutionError("prompt_provider_output_invalid", source);
  }
  return {
    version: "resolved_automatic_build_prompt_asset.v1",
    extractor_name: extractorName,
    source,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
  };
}

function resolveBuildExecutorAgentTemplate(): string {
  let bytes: Buffer;
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  if (sidecar) {
    const output = captureBuildProcessOutput(
      sidecar,
      ["executor.agent-template"],
      path.dirname(path.resolve(sidecar)),
    );
    if (output.error || output.status !== 0 || output.stderr !== "") {
      throw new Error("packaged executor agent template is unavailable");
    }
    bytes = Buffer.from(output.stdout, "utf8");
  } else {
    bytes = readFileSync(path.join(
      PLUGIN_ROOT,
      "assets",
      "codex-agents",
      "understand-book-executor.toml",
    ));
  }
  if (bytes.byteLength === 0
    || bytes.byteLength > MAX_AUTOMATIC_BUILD_EXECUTOR_AGENT_TEMPLATE_BYTES
    || bytes.includes(0)) {
    throw new Error("executor agent template bytes are invalid");
  }
  return bytes.toString("utf8");
}

function resolveBuildExecutorBoundaryProjections(): {
  plugin_mcp_projections: string[];
  launcher_projections: string[];
} {
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  if (sidecar) {
    const readPackagedAsset = (command: "executor.mcp-config" | "executor.mcp-launcher"): string => {
      const output = captureBuildProcessOutput(
        sidecar,
        [command],
        path.dirname(path.resolve(sidecar)),
      );
      const bytes = Buffer.from(output.stdout, "utf8");
      if (output.error
        || output.status !== 0
        || output.stderr !== ""
        || bytes.byteLength === 0
        || bytes.byteLength > MAX_AUTOMATIC_BUILD_EXECUTOR_BOUNDARY_ASSET_BYTES
        || bytes.includes(0)) {
        throw new Error(`packaged Build Executor boundary asset is unavailable: ${command}`);
      }
      return output.stdout;
    };
    return {
      plugin_mcp_projections: [readPackagedAsset("executor.mcp-config")],
      launcher_projections: [readPackagedAsset("executor.mcp-launcher")],
    };
  }

  const rootPluginMcpPath = path.join(PLUGIN_ROOT, ".mcp.json");
  const releasePluginMcpPath = path.join(PLUGIN_ROOT, "plugins", "understand-book", ".mcp.json");
  const rootLauncherPath = path.join(PLUGIN_ROOT, "scripts", "start-build-executor-mcp.cmd");
  const releaseLauncherPath = path.join(
    PLUGIN_ROOT,
    "plugins",
    "understand-book",
    "scripts",
    "start-build-executor-mcp.cmd",
  );
  return {
    plugin_mcp_projections: existsSync(rootPluginMcpPath)
      ? [rootPluginMcpPath, ...(existsSync(releasePluginMcpPath) ? [releasePluginMcpPath] : [])]
        .map((candidate) => readFileSync(candidate, "utf8"))
      : [],
    launcher_projections: existsSync(rootLauncherPath)
      ? [rootLauncherPath, ...(existsSync(releaseLauncherPath) ? [releaseLauncherPath] : [])]
        .map((candidate) => readFileSync(candidate, "utf8"))
      : [],
  };
}

function buildDispatchExecutorHandoffBytes(
  resolvedPrompt: ResolvedAutomaticBuildExecutorPromptV1,
  envelope: object,
): Buffer {
  const envelopeRecord = envelope as { version?: unknown; dispatch_run_id?: unknown; executor_handoff?: unknown };
  if (resolvedPrompt.mode !== "dispatch"
    || envelopeRecord.version !== "automatic_build_dispatch_executor.v1"
    || typeof envelopeRecord.dispatch_run_id !== "string"
    || !envelopeRecord.dispatch_run_id
    || envelopeRecord.executor_handoff !== undefined) {
    throw new Error("invalid dispatch executor envelope for handoff");
  }
  const completePrompt = Buffer.from(resolvedPrompt.bytes).toString("utf8");
  const handoff = {
    version: "automatic_build_dispatch_executor_handoff.v1" as const,
    prompt_sha256: resolvedPrompt.sha256,
    prompt: completePrompt,
    envelope,
  };
  const bytes = Buffer.from(`${canonicalAutomaticBuildJson(handoff)}\n`, "utf8");
  if (bytes.byteLength > MAX_DISPATCH_EXECUTOR_HANDOFF_BYTES) {
    throw new Error(
      `dispatch executor handoff exceeds ${MAX_DISPATCH_EXECUTOR_HANDOFF_BYTES} bytes: ${bytes.byteLength}`,
    );
  }
  return bytes;
}

function persistDispatchExecutorHandoff(
  manifestPath: string,
  resolvedPrompt: ResolvedAutomaticBuildExecutorPromptV1,
  envelope: object,
): {
  version: "automatic_build_dispatch_executor_handoff_ref.v1";
  path: string;
  sha256: string;
  byte_length: number;
} {
  const bytes = buildDispatchExecutorHandoffBytes(resolvedPrompt, envelope);
  const handoffPath = path.join(path.dirname(manifestPath), "executor-handoff.json");
  mkdirSync(path.dirname(handoffPath), { recursive: true });
  try {
    writeFileSync(handoffPath, bytes, { flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readFileSync(handoffPath);
    if (!existing.equals(bytes)) {
      throw new Error(`dispatch executor handoff conflicts with its run identity: ${handoffPath}`);
    }
  }
  return {
    version: "automatic_build_dispatch_executor_handoff_ref.v1",
    path: handoffPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
  };
}

function stageScriptArgs(target: AutomaticBuildTarget): string[] {
  const result = [target.source_path, "--book-id", target.book_id, "--content-profile", target.profile_id];
  if (target.profile_id === "paper") result.push("--paper-subtype", "research_article");
  return result;
}

function targetCommandInput(target: AutomaticBuildTarget): string {
  return target.kind === "paper_workspace" ? target.target_ref.workspace_dir : target.source_path;
}

function targetResolutionCommandArgs(target: AutomaticBuildTarget): string[] {
  return ["--root", target.root_dir, "--book-id", target.book_id];
}

export interface CapturedBuildProcessOutput {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function captureBuildProcessOutput(
  command: string,
  args: string[],
  cwd: string,
): CapturedBuildProcessOutput {
  const captureDir = mkdtempSync(path.join(tmpdir(), "understand-book-stage-capture-"));
  const stdoutPath = path.join(captureDir, "stdout");
  const stderrPath = path.join(captureDir, "stderr");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;

  try {
    stdoutFd = openSync(stdoutPath, "w");
    stderrFd = openSync(stderrPath, "w");
    const result = spawnSync(command, args, {
      cwd,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
    closeSync(stdoutFd);
    stdoutFd = undefined;
    closeSync(stderrFd);
    stderrFd = undefined;
    return {
      ...(result.error ? { error: result.error } : {}),
      status: result.status,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    };
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function forwardStageScript(
  target: AutomaticBuildTarget,
  script: string,
  args: string[],
  capture = false,
): { stdout: string; stderr: string } {
  const [command, ...commandArgs] = scriptCommand(script, args);
  const result = capture
    ? captureBuildProcessOutput(command, commandArgs, target.root_dir)
    : spawnSync(command, commandArgs, { cwd: target.root_dir, stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const extractorFailure = parseExtractorContractErrorFromStderr(result.stderr);
    if (extractorFailure) throw extractorFailure;
    throw new Error(`stage script ${script} failed (${result.status ?? 1}): ${result.stderr ?? ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stageArtifactPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
): string {
  const buildRoot = path.join(target.workspace_dir, ".build");
  switch (stage) {
    case "pass1": return path.join(buildRoot, "pass1", `${taskId}.json`);
    case "paper_metadata": return path.join(buildRoot, "paper-metadata", `${taskId}.json`);
    case "paper_lexicon": return path.join(buildRoot, "paper-lexicon", `${taskId}.json`);
    case "profile_sidecar": return path.join(buildRoot, "profile-sidecar", `${taskId}.json`);
    case "pass2": return path.join(buildRoot, "pass2", `${taskId}.json`);
    case "book_structure": return taskId === "stitch"
      ? path.join(buildRoot, "book-structure", "stitch.json")
      : path.join(buildRoot, "book-structure", "units", `${taskId.replace(/^unit:/, "")}.json`);
    case "paper_reading_guide": throw new Error("paper_reading_guide has no semantic writer");
  }
}

function paperLexiconWriterWarnings(artifactPath: string): AutomaticBuildWriterWarnings | undefined {
  const committed = inspectPaperLexiconCommittedArtifact(
    JSON.parse(readFileSync(artifactPath, "utf8").replace(/^\uFEFF/, "")) as unknown,
  );
  if (!committed) throw new Error("paper lexicon writer produced an invalid committed artifact");
  const warnings: AutomaticBuildWriterWarnings = {};
  for (const warning of committed.artifact.warnings ?? []) {
    if (warning.code === "candidate_reconciled") {
      warnings.paper_lexicon_candidate_reconciled = warning.count;
    } else if (warning.code === "candidate_rejected") {
      warnings.paper_lexicon_candidate_rejected = warning.count;
    }
  }
  return Object.keys(warnings).length ? warnings : undefined;
}

function shadowCandidatePath(directory: string, attempt: number, candidateBytes: Buffer): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("shadow candidate attempt must be a positive safe integer");
  }
  const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
  return path.join(
    directory,
    "attempts",
    String(attempt).padStart(6, "0"),
    candidateSha256,
    "candidate.json",
  );
}

export function runAutomaticBuildStageWriter(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  candidatePath: string,
  generation?: {
    policy_generation_id: string;
    attempt: number;
    executor: string;
    generated_at: string;
  },
): AutomaticBuildWriterResult {
  const script = STAGE_COMMANDS[stage].write;
  if (!script) throw new Error(`stage ${stage} does not support write`);
  const generationStage = stage === "pass1" || stage === "profile_sidecar" ? stage : undefined;
  const generationTaskPath = generation
    ? stage === "pass1"
      ? pass1ShadowTaskPath(target, generation.policy_generation_id, taskId)
      : stage === "profile_sidecar"
        ? profileSidecarDiscourseShadowTaskPath(target, generation.policy_generation_id, taskId)
        : stage === "book_structure"
          ? bookStructureGenerationTaskPath(target, generation.policy_generation_id, taskId)
          : undefined
    : undefined;
  if (generation && (!generationTaskPath || !existsSync(generationTaskPath))) {
    throw new Error(`policy_generation_conflict: frozen production generation task is unavailable: ${stage}/${taskId}`);
  }
  if (generation && stage === "book_structure") {
    const task = readBookStructureGenerationTask(target, generation.policy_generation_id, taskId);
    if (!task) {
      throw new Error(`policy_generation_conflict: frozen BookStructure generation task is unavailable: ${taskId}`);
    }
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8").replace(/^\uFEFF/, "")) as unknown;
    writeBookStructureGenerationCandidate({
      target,
      task,
      candidate,
      provenance: {
        executor: generation.executor,
        attempt: generation.attempt,
        generated_at: generation.generated_at,
      },
    });
    return {
      artifact_path: automaticBuildGenerationArtifactPath(
        target,
        "book_structure",
        generation.policy_generation_id,
        taskId,
      ),
    };
  }
  if (generation && generationStage && generationTaskPath && existsSync(generationTaskPath)) {
    const directory = generationStage === "pass1"
      ? pass1ShadowTaskPrivateDirectory(target, generation.policy_generation_id, taskId)
      : profileSidecarDiscourseShadowTaskPrivateDirectory(
          target,
          generation.policy_generation_id,
          taskId,
        );
    const candidateBytes = readFileSync(candidatePath);
    const candidatePathForExecution = shadowCandidatePath(directory, generation.attempt, candidateBytes);
    mkdirSync(path.dirname(candidatePathForExecution), { recursive: true });
    try {
      writeFileSync(candidatePathForExecution, candidateBytes, { flag: "wx" });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST" || !readFileSync(candidatePathForExecution).equals(candidateBytes)) throw error;
    }
    if (generationStage === "pass1") {
      const task = readPass1ShadowTask(target, generation.policy_generation_id, taskId);
      const candidatePath = assertPass1ShadowCandidatePath({
        target,
        task,
        candidate_path: candidatePathForExecution,
      });
      const sourceBytes = readFileSync(target.source_path);
      const source = /\.epub$/iu.test(target.source_path)
        ? epubToSource(new Uint8Array(sourceBytes)).source
        : sourceBytes.toString("utf8");
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8").replace(/^\uFEFF/, "")) as unknown;
      return writePass1ShadowCandidate({
        target,
        source,
        task,
        candidate,
        provenance: {
          executor: generation.executor,
          attempt: generation.attempt,
          generated_at: generation.generated_at,
        },
      });
    }
    forwardStageScript(
      target,
      script,
      [
        target.source_path,
        taskId,
        candidatePathForExecution,
        ...stageScriptArgs(target).slice(1),
        "--shadow-generation",
        generation.policy_generation_id,
        "--attempt",
        String(generation.attempt),
        "--generated-at",
        generation.generated_at,
        "--executor",
        generation.executor,
      ],
      true,
    );
    return {
      artifact_path: automaticBuildGenerationArtifactPath(
        target,
        generationStage,
        generation.policy_generation_id,
        taskId,
      ),
    };
  }
  forwardStageScript(
    target,
    script,
    [target.source_path, taskId, candidatePath, ...stageScriptArgs(target).slice(1)],
    true,
  );
  const artifactPath = stageArtifactPath(target, stage, taskId);
  const writerWarnings = stage === "paper_lexicon" ? paperLexiconWriterWarnings(artifactPath) : undefined;
  return {
    artifact_path: artifactPath,
    ...(writerWarnings ? { writer_warnings: writerWarnings } : {}),
  };
}

export function renderAutomaticBuildTaskInput(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  options: { policy_generation_id?: string } = {},
): { stdout: string; stderr: string } {
  const productionGenerationId = options.policy_generation_id;
  if (productionGenerationId) {
    const generationTaskPath = stage === "pass1"
      ? pass1ShadowTaskPath(target, productionGenerationId, taskId)
      : stage === "profile_sidecar"
        ? profileSidecarDiscourseShadowTaskPath(target, productionGenerationId, taskId)
        : stage === "book_structure"
          ? bookStructureGenerationTaskPath(target, productionGenerationId, taskId)
          : undefined;
    if (!generationTaskPath || !existsSync(generationTaskPath)) {
      throw new Error(`policy_generation_conflict: frozen production generation task is unavailable: ${stage}/${taskId}`);
    }
  }

  const script = STAGE_COMMANDS[stage].input;
  if (!script) throw new Error(`stage ${stage} does not support input`);
  const args = [target.source_path, taskId, ...stageScriptArgs(target).slice(1)];
  if (productionGenerationId) {
    args.push("--shadow-generation", productionGenerationId);
  }
  return forwardStageScript(target, script, args, true);
}

function runAutomaticBuildTaskInputWithSource(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  leaseRef: string,
  leaseToken: string,
  inputSource: (lease: ReturnType<typeof readAutomaticBuildLease>) => {
    stdout: string;
    stderr: string;
  },
  options: { now?: string; run_ttl_ms?: number } = {},
): { stdout: string; stderr: string } {
  startAutomaticBuildLease(target, leaseRef, leaseToken, {
    ...(options.now ? { now: options.now } : {}),
    run_ttl_ms: options.run_ttl_ms ?? DEFAULT_RUN_TTL_MS,
  });
  const lease = readAutomaticBuildLease(target, leaseRef, leaseToken);
  if (lease.stage !== stage || lease.work_unit_id !== taskId) {
    throw new Error(`stage command does not match lease identity: ${stage}/${taskId}`);
  }

  const startedAt = options.now ?? new Date().toISOString();
  const result = inputSource(lease);
  const finishedAt = options.now ?? new Date().toISOString();
  const binding = automaticBuildTaskPolicyBindingFromLease(lease);
  const inputSha256 = createHash("sha256").update(result.stdout, "utf8").digest("hex");
  if (binding && isAutomaticBuildTaskPolicyBindingV2(binding) && inputSha256 !== binding.input_hash) {
    failAutomaticBuildTask(target, leaseRef, leaseToken, {
      diagnostic_code: "budget_proof_invalid",
      ...(options.now ? { now: options.now } : {}),
    });
    throw new Error("budget_proof_invalid");
  }
  recordAutomaticBuildInputObservation(target, leaseRef, leaseToken, {
    started_at: startedAt,
    finished_at: finishedAt,
    input_bytes: Buffer.byteLength(result.stdout),
    ...(binding && isAutomaticBuildTaskPolicyBindingV2(binding) ? {
      input_sha256: inputSha256,
      render_contract_version: MODEL_INPUT_RENDER_CONTRACT_VERSION,
    } : {}),
  });
  return result;
}

export function runAutomaticBuildTaskInput(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  leaseRef: string,
  leaseToken: string,
  options: { now?: string; run_ttl_ms?: number } = {},
): { stdout: string; stderr: string } {
  return runAutomaticBuildTaskInputWithSource(
    target,
    stage,
    taskId,
    leaseRef,
    leaseToken,
    (lease) => renderAutomaticBuildTaskInput(target, stage, taskId, {
      ...(lease.policy_generation_id
        ? { policy_generation_id: lease.policy_generation_id }
        : {}),
    }),
    options,
  );
}

export function runAutomaticBuildFrozenTaskInput(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  leaseRef: string,
  leaseToken: string,
  frozenInput: string,
  options: { now?: string; run_ttl_ms?: number } = {},
): { stdout: string; stderr: string } {
  if (typeof frozenInput !== "string") {
    throw new Error("frozen automatic build task input must be a string");
  }
  return runAutomaticBuildTaskInputWithSource(
    target,
    stage,
    taskId,
    leaseRef,
    leaseToken,
    () => ({ stdout: frozenInput, stderr: "" }),
    options,
  );
}

export function submitAutomaticBuildTaskCandidate(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  leaseRef: string,
  leaseToken: string,
  options: { now?: string } = {},
) {
  const lease = readAutomaticBuildLease(target, leaseRef, leaseToken);
  if (lease.stage !== stage || lease.work_unit_id !== taskId) {
    throw new Error(`stage command does not match lease identity: ${stage}/${taskId}`);
  }
  const binding = automaticBuildTaskPolicyBindingFromLease(lease);
  return submitAutomaticBuildCandidate(
    target,
    leaseRef,
    leaseToken,
    path.join(path.dirname(leaseRef), "candidate.json"),
    (candidatePath) => runAutomaticBuildStageWriter(
      target,
      stage,
      taskId,
      candidatePath,
      binding && isAutomaticBuildTaskPolicyBindingV2(binding)
        ? {
            policy_generation_id: binding.policy_generation_id,
            attempt: lease.attempt,
            executor: lease.owner,
            generated_at: options.now ?? new Date().toISOString(),
          }
        : undefined,
    ),
    { ...(options.now ? { now: options.now } : {}) },
  );
}

export function recordAutomaticBuildAttempt(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  outcome: "failure" | "success" | "reset",
  error?: string,
  options: {
    attempt?: number;
    event_id?: string;
    created_at?: string;
    lease_ref?: string;
    lease_token?: string;
    now?: string;
  } = {},
): AutomaticBuildAttemptRecord {
  const current = readAutomaticBuildAttemptSnapshot(target).stages[stage]?.[taskId];
  const attempt = options.attempt
    ?? (outcome === "reset" ? current?.last_attempt ?? 1 : current?.next_attempt ?? 1);
  if (Boolean(options.lease_ref) !== Boolean(options.lease_token)) {
    throw new Error("lease_ref and lease_token must be provided together");
  }
  if (options.lease_ref && options.lease_token) {
    const terminalExists = existsSync(path.join(path.dirname(options.lease_ref), "result.json"));
    const lease = terminalExists
      ? readAutomaticBuildLease(target, options.lease_ref, options.lease_token)
      : assertActiveAutomaticBuildLease(target, options.lease_ref, options.lease_token, options.now);
    if (lease.stage !== stage || lease.work_unit_id !== taskId || lease.attempt !== attempt) {
      throw new Error(`attempt event does not match lease identity: ${stage}/${taskId}/${attempt}`);
    }
  }
  return recordAutomaticBuildAttemptEvent(target, {
    stage,
    work_unit_id: taskId,
    attempt,
    event_id: options.event_id ?? `${stage}:${taskId}:${attempt}:${outcome}`,
    outcome,
    ...(error ? { diagnostic: error } : {}),
    ...(options.created_at ? { created_at: options.created_at } : {}),
  });
}

function historicalUsageForStage(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildHistoricalUsageV1 | undefined {
  const file = automaticBuildStageMetricsSummaryPath(target, stage);
  if (!existsSync(file)) return undefined;
  const metrics = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStageMetricsSummaryV1;
  if (metrics.version !== "automatic_build_stage_metrics_summary.v1") return undefined;
  return {
    source: "automatic_build_stage_metrics.v1",
    known_usage_coverage: metrics.usage.known_usage_coverage,
    exact_input_tokens: metrics.usage.input_tokens,
    exact_output_tokens: metrics.usage.output_tokens,
  };
}

function historicalPerformanceForStage(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
): AutomaticBuildStageMetricsSummaryV1["performance_history"] | undefined {
  const file = automaticBuildStageMetricsSummaryPath(target, stage);
  if (!existsSync(file)) return undefined;
  const metrics = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildStageMetricsSummaryV1;
  if (metrics.version !== "automatic_build_stage_metrics_summary.v1") return undefined;
  return metrics.performance_history;
}

function actualUsageForBuildPlan(
  target: AutomaticBuildTarget,
  plan: BuildPlanV1,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  now: string,
): AutomaticBuildPlanActualUsageV1 {
  let attempts = 0;
  let knownAttempts = 0;
  let exactInputTokens = 0;
  let exactOutputTokens = 0;
  for (const stage of plan.public_stage_closure as AutomaticBuildStage[]) {
    const stageState = snapshot.stages.find((item) => item.stage === stage);
    const summary = buildAutomaticBuildStageMetricsSummary(target, stage, {
      now,
      work_units: stageState?.work_units ?? [],
    });
    const stageAttempts = summary.usage.fully_known_attempts
      + summary.usage.partially_known_attempts
      + summary.usage.unavailable_attempts;
    attempts += stageAttempts;
    knownAttempts += summary.usage.fully_known_attempts + summary.usage.partially_known_attempts;
    exactInputTokens += summary.usage.input_tokens;
    exactOutputTokens += summary.usage.output_tokens;
  }
  return {
    known_usage_coverage: attempts ? knownAttempts / attempts : 0,
    exact_input_tokens: exactInputTokens,
    exact_output_tokens: exactOutputTokens,
  };
}

function buildPlanBudgetEvaluation(
  target: AutomaticBuildTarget,
  plan: BuildPlanV1,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  now: string,
  preflight?: AutomaticBuildPreflightV2,
): AutomaticBuildPlanBudgetEvaluationV2 {
  return evaluateAutomaticBuildPlanBudget({
    plan,
    actual_usage: actualUsageForBuildPlan(target, plan, snapshot, now),
    ...(preflight ? {
      current_forecast: {
        estimated_total_tokens_upper: preflight.cost_scope.remaining.estimated_total_tokens_upper,
        wall_clock_p95_minutes: preflight.wall_clock.predicted.remaining.p95_ms / 60_000,
      },
    } : {}),
  });
}

function preflightForAction(
  target: AutomaticBuildTarget,
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>,
  action: ReturnType<typeof nextAutomaticBuildAction> | ReturnType<typeof nextPlannedAutomaticBuildAction>,
  requestedWorkers: number,
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
  wallBudget?: AutomaticBuildWallBudgetV1,
  executorProvenance?: AutomaticBuildExecutorProvenanceV1,
  buildPlan?: BuildPlanV1,
): AutomaticBuildPreflightV2 | undefined {
  if (action.kind !== "extract") return undefined;
  const stage = snapshot.stages.find((item) => item.stage === action.stage);
  if (!stage?.work_units) throw new Error(`automatic preflight requires descriptor plan: ${action.stage}`);
  const historicalMetrics = historicalUsageForStage(target, action.stage);
  const historicalPerformance = historicalPerformanceForStage(target, action.stage);
  return buildAutomaticBuildPreflight({
    target_ref: target.target_ref,
    stage: action.stage,
    work_units: stage.work_units,
    ...(stage.task_bindings ? { task_bindings: stage.task_bindings } : {}),
    pending_ids: stage.pending_tasks,
    quality_profile: qualityProfile,
    requested_workers: requestedWorkers,
    available_agent_slots: availableAgentSlots,
    budget,
    ...(historicalMetrics ? { historical_metrics: historicalMetrics } : {}),
    ...(historicalPerformance ? { historical_performance: historicalPerformance } : {}),
    ...(wallBudget ? { wall_budget: wallBudget } : {}),
    ...(executorProvenance ? { executor_provenance: executorProvenance } : {}),
    ...(buildPlan ? { build_plan: buildPlan } : {}),
  });
}

function automaticBuildRecoveryAction(recovery: AutomaticBuildRecoveryEnvelopeV1) {
  return {
    kind: "needs_user" as const,
    reason: "automatic_build_routing_blocked" as const,
    ...(recovery.stage ? { stage: recovery.stage } : {}),
    recovery,
    message: "automatic build routing is blocked; follow an allowlisted recovery action before claiming work",
  };
}

function buildPlanBudgetRecoveryAction(input: {
  target: AutomaticBuildTarget;
  snapshot: ReturnType<typeof buildAutomaticBuildSnapshot>;
  build_plan: BuildPlanV1;
  plan_budget: AutomaticBuildPlanBudgetEvaluationV2;
  stage?: AutomaticBuildStage;
  preflight?: AutomaticBuildPreflightV2;
}) {
  const stageState = input.stage
    ? input.snapshot.stages.find((candidate) => candidate.stage === input.stage)
    : undefined;
  const affected = stageState?.pending_work_units ?? stageState?.work_units ?? [];
  const recovery = createAutomaticBuildRecoveryEnvelope({
    phase: "preflight",
    code: "build_plan_budget_changed",
    ...(input.stage ? { stage: input.stage } : {}),
    target_ref: input.target.target_ref,
    ...(input.preflight?.policy_fingerprint
      ? { router_version: input.preflight.policy_fingerprint.router_version }
      : {}),
    affected_work_units: affected.map((unit) => ({
      work_unit_id: unit.work_unit_id,
      evidence_lids: unit.evidence_lids,
      estimated_tokens: unit.cost.estimated_input_tokens,
    })),
    retryable: false,
    recovery_actions: ["reconfirm_build_plan"],
  });
  return {
    kind: "needs_user" as const,
    reason: "build_plan_budget_changed" as const,
    ...(input.stage ? { stage: input.stage } : {}),
    plan_id: input.build_plan.plan_id,
    plan_revision: input.build_plan.revision,
    violations: input.plan_budget.violations,
    plan_budget_evidence: input.plan_budget,
    recovery,
    message: "actual usage plus remaining forecast changed beyond the confirmed BuildPlan budget",
  };
}

function persistAutomaticBuildPlanAcceptance(
  target: AutomaticBuildTarget,
  preflight: AutomaticBuildPreflightV2,
  acceptedAt: string,
): string {
  const dir = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "preflight", preflight.stage);
  const file = path.join(dir, `${encodeURIComponent(acceptedAt)}.json`);
  const planEvidence = automaticBuildPreflightPlanEvidence(preflight);
  const value = {
    version: "automatic_build_plan_acceptance.v2",
    plan_evidence: planEvidence,
    accepted_at: acceptedAt,
  };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as typeof value;
    if (!sameAutomaticBuildBudgetEvidence(existing, value)) {
      throw new Error(`automatic build plan acceptance conflicts with current preflight: ${file}`);
    }
  }
  return file;
}

function persistAutomaticBuildEvaluationAcceptance(
  target: AutomaticBuildTarget,
  preflight: AutomaticBuildPreflightV2,
  acceptedAt: string,
): string {
  const dir = path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "preflight",
    preflight.stage,
    "evaluations",
  );
  const file = path.join(dir, `${encodeURIComponent(acceptedAt)}.json`);
  const value = {
    version: "automatic_build_evaluation_acceptance.v2",
    plan_evidence: automaticBuildPreflightPlanEvidence(preflight),
    evaluation_evidence: automaticBuildPreflightEvaluationEvidence(preflight),
    accepted_at: acceptedAt,
  };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(file, "utf8")) as typeof value;
    if (!sameAutomaticBuildBudgetEvidence(existing, value)) {
      throw new Error(`automatic build evaluation acceptance conflicts with current preflight: ${file}`);
    }
  }
  return file;
}

export function automaticBuildPlan(
  targetInput: string,
  rootDir: string,
  options: AutomaticBuildPlanOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const qualityProfile = options.quality_profile ?? "full";
  const requestedWorkers = options.requested_workers ?? 1;
  const availableAgentSlots = options.available_agent_slots ?? requestedWorkers;
  const budget = options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET;
  const snapshotRoute = routeAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  if (snapshotRoute.status === "blocked") {
    return {
      version: "automatic_build_plan.v1",
      protocol: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
      release: AUTOMATIC_BUILD_ACTIVE_RELEASE,
      routing_release: AUTOMATIC_BUILD_ROUTING_RELEASE,
      snapshot: { target, stages: [] },
      next_action: automaticBuildRecoveryAction(snapshotRoute.recovery),
      preflight: null,
    };
  }
  const snapshot = snapshotRoute.value;
  const nextAction = options.build_plan
    ? nextPlannedAutomaticBuildAction(snapshot, options.build_plan, Number.MAX_SAFE_INTEGER, {
        quality_profile: qualityProfile,
      })
    : nextAutomaticBuildAction(snapshot, Number.MAX_SAFE_INTEGER);
  const preflight = preflightForAction(
    target,
    snapshot,
    nextAction,
    requestedWorkers,
    availableAgentSlots,
    qualityProfile,
    budget,
    options.wall_budget,
    options.executor_provenance,
    options.build_plan,
  );
  return {
    version: "automatic_build_plan.v1",
    protocol: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_ACTIVE_RELEASE,
    routing_release: AUTOMATIC_BUILD_ROUTING_RELEASE,
    snapshot,
    next_action: nextAction,
    preflight: preflight ?? null,
  };
}

export function prepareExplicitLegacyBuildPlan(
  targetInput: string,
  rootDir: string,
  options: {
    now?: string;
    budget?: BuildPlanV1["budget"];
    book_id?: string;
    pass2?: Pass2PlanChoice;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const now = options.now ?? new Date().toISOString();
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
  const selection = mapLegacyBuildInvocation({
    invocation: "explicit_full_build",
    target: {
      book_id: target.book_id,
      source_fingerprint: target.target_ref.input_fingerprint,
      content_profile: target.profile_id === "paper"
        ? { id: "paper", version: "paper_v0" }
        : { id: "technical_learning", version: "technical_learning_v0" },
      public_freshness: inspectAutomaticBuildStageFreshness(snapshot, { quality_profile: "full" }),
    },
    now,
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.pass2 ? { pass2: options.pass2 } : {}),
  });
  if (!selection?.plan) throw new Error("explicit legacy full build did not compile a BuildPlan");
  const invocationId = createHash("sha256")
    .update(canonicalAutomaticBuildJson({ target: target.target_ref, now, pass2: options.pass2 ?? "enabled" }), "utf8")
    .digest("hex")
    .slice(0, 16);
  const directory = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "legacy-plans");
  const buildPlanPath = path.join(directory, `${invocationId}.json`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(buildPlanPath, `${canonicalAutomaticBuildJson(selection.plan)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(buildPlanPath, "utf8")) as BuildPlanV1;
    if (canonicalAutomaticBuildJson(existing) !== canonicalAutomaticBuildJson(selection.plan)) {
      throw new Error(`explicit legacy BuildPlan conflicts with its invocation record: ${buildPlanPath}`);
    }
  }
  return {
    version: "explicit_legacy_build_plan.v1" as const,
    invocation: "explicit_full_build" as const,
    target_ref: target.target_ref,
    build_plan_path: buildPlanPath,
    plan: selection.plan,
  };
}

export function automaticBuildRemainingWork(
  targetInput: string,
  rootDir: string,
  options: {
    book_id?: string;
    quality_profile?: ExtractionQualityProfile;
    now?: string;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: options.quality_profile ?? "full",
  });
  return {
    version: "automatic_build_remaining_work_observation.v1" as const,
    remaining_work: observeAutomaticBuildRemainingWork(snapshot, {
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}

function freezeAutomaticBuildGenerationTask(
  target: AutomaticBuildTarget,
  stageState: AutomaticBuildStageState,
  workUnitId: string,
): void {
  if (!stageState.policy_set) return;
  freezeAutomaticBuildStagePolicySet(target, stageState.policy_set);
  const generationTask = stageState.generation_tasks?.[workUnitId];
  if (!generationTask) {
    throw new Error(`v3 production work unit is missing its frozen generation task: ${stageState.stage}/${workUnitId}`);
  }
  if (generationTask.kind === "pass1") {
    freezePass1ShadowTask(target, generationTask.task);
    return;
  }
  if (generationTask.kind === "profile_sidecar_discourse") {
    freezeProfileSidecarDiscourseShadowTask(target, generationTask.task);
    return;
  }
  if (generationTask.kind === "profile_sidecar_fast_path") {
    freezeProfileSidecarSemanticFastPathTask(target, generationTask.task);
    return;
  }
  if (generationTask.kind === "book_structure") {
    freezeBookStructureGenerationTask(target, generationTask.task);
    return;
  }
  throw new Error(`unsupported proof-bound production generation task: ${stageState.stage}/${workUnitId}`);
}

function expandAction(
  target: AutomaticBuildTarget,
  maxParallel: number,
  leaseOptions: { owner: string; now: string; reserve_ttl_ms: number; run_ttl_ms?: number },
  availableAgentSlots: number,
  qualityProfile: ExtractionQualityProfile,
  budget: AutomaticBuildBudgetLimitsV1,
  wallBudget?: AutomaticBuildWallBudgetV1,
  executorProvenance?: AutomaticBuildExecutorProvenanceV1,
  acceptedPlanDigest?: string,
  acceptedEvaluationEvidence?: AutomaticBuildPreflightEvaluationEvidenceV2,
  acceptedPlanBudgetEvidence?: AutomaticBuildPlanBudgetEvaluationV2,
  executorDispatches = false,
  buildPlan?: BuildPlanV1,
) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const snapshotRoute = routeAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  if (snapshotRoute.status === "blocked") {
    return {
      snapshot: { target, stages: [] },
      action: automaticBuildRecoveryAction(snapshotRoute.recovery),
    };
  }
  const snapshot = snapshotRoute.value;
  const action = nextPlannedAutomaticBuildAction(snapshot, buildPlan, Number.MAX_SAFE_INTEGER, {
    quality_profile: qualityProfile,
  });
  if (action.kind === "needs_user") return { snapshot, action };
  if (!buildPlan) throw new Error("planned automatic action is missing its BuildPlan");
  const settledPlanBudget = action.kind === "extract"
    ? undefined
    : buildPlanBudgetEvaluation(target, buildPlan, snapshot, leaseOptions.now);
  if (settledPlanBudget?.status === "exceeded"
    && !sameAutomaticBuildBudgetEvidence(acceptedPlanBudgetEvidence, settledPlanBudget)) {
    return {
      snapshot,
      plan_budget: settledPlanBudget,
      action: buildPlanBudgetRecoveryAction({
        target,
        snapshot,
        build_plan: buildPlan,
        plan_budget: settledPlanBudget,
      }),
    };
  }
  if (action.kind === "extract") {
    const productionStageState = snapshot.stages.find((stage) => stage.stage === action.stage);
    if (!productionStageState) throw new Error(`automatic stage state is missing: ${action.stage}`);
    const targetInput = targetCommandInput(target);
    const legacyAudit = auditAutomaticBuildLegacy(target, action.stage);
    if (legacyAudit.legacy_artifacts || legacyAudit.invalid_artifacts) {
      const migration = readAutomaticBuildMigrationDecision(target);
      if (!migration) {
        return {
          snapshot,
          legacy_audit: legacyAudit,
          action: {
            kind: "needs_user" as const,
            reason: "legacy_migration_required",
            stage: action.stage,
            policy_status: legacyAudit.policy_status,
            message: "legacy artifacts require an explicit legacy_resume or v2_rebuild decision before v2 claim",
            audit_command: scriptCommand("automatic-build.ts", [
              "audit-legacy", targetInput, action.stage, ...targetResolutionCommandArgs(target),
            ]),
            migration_commands: (["legacy_resume", "v2_rebuild"] as const).map((mode) => scriptCommand(
              "automatic-build.ts",
              ["migration-mode", targetInput, mode, ...targetResolutionCommandArgs(target)],
            )),
          },
        };
      }
      if (migration.mode === "legacy_resume") {
        return {
          snapshot,
          legacy_audit: legacyAudit,
          migration,
          action: {
            kind: "needs_user" as const,
            reason: "legacy_resume_selected",
            stage: action.stage,
            policy_status: "legacy_policy_unknown",
            message: "continue this stage only through the frozen production v1 contract; it cannot become v2 complete",
          },
        };
      }
    }
    const attempts = readAutomaticBuildAttemptSnapshot(target).stages[action.stage] ?? {};
    const descriptors = new Map((productionStageState.work_units ?? [])
      .map((descriptor) => [descriptor.work_unit_id, descriptor]));
    const claimInspections = action.task_ids.map((taskId) => {
      const descriptor = descriptors.get(taskId);
      const binding = productionStageState.task_bindings?.[taskId];
      if (!descriptor) throw new Error(`automatic semantic task is missing its descriptor: ${action.stage}/${taskId}`);
      if (!binding) throw new Error(`automatic semantic task is missing policy binding: ${action.stage}/${taskId}`);
      return {
        task_id: taskId,
        last_attempt: attempts[taskId]?.last_attempt ?? 0,
        inspection: inspectAutomaticBuildTaskClaim(target, action.stage, taskId, {
          now: leaseOptions.now,
          descriptor,
          binding,
          ...(descriptor.version === "automatic_build_work_unit.v3"
            ? { policy_generation: "v3_only" as const }
            : {}),
          max_semantic_attempts: MAX_ATTEMPTS,
          max_lease_epochs: MAX_LEASE_EPOCHS,
        }),
      };
    });
    const policyBlockers = claimInspections.filter((item) => (
      item.inspection.status === "policy_generation_conflict"
      || item.inspection.status === "policy_generation_migration_required"
    ));
    if (policyBlockers.length) {
      const reason = policyBlockers.some((item) => item.inspection.status === "policy_generation_conflict")
        ? "policy_generation_conflict"
        : "policy_generation_migration_required";
      return {
        snapshot,
        action: {
          kind: "needs_user" as const,
          reason,
          stage: action.stage,
          tasks: policyBlockers.map(({ task_id, inspection }) => ({ task_id, ...inspection })),
          message: reason === "policy_generation_conflict"
            ? "an active task lease belongs to a different complete policy scope"
            : "an active legacy lease has no unambiguous complete policy scope",
        },
      };
    }
    const executionBlockers = claimInspections
      .filter((item) => item.inspection.status === "retry_exhausted"
        || item.inspection.status === "executor_instability");
    if (executionBlockers.length) {
      const reason = executionBlockers.some((item) => item.inspection.status === "retry_exhausted")
        ? "retry_exhausted"
        : "executor_instability";
      const resetCommands = executionBlockers.flatMap(({ task_id, last_attempt, inspection }) => {
        if ("attempt_scope_digest" in inspection && inspection.attempt_scope_digest) return [];
        if (last_attempt < 1) throw new Error(`execution blocker is missing attempt state: ${action.stage}/${task_id}`);
        return [scriptCommand("automatic-build.ts", [
          "record-attempt", targetInput, action.stage, task_id, "reset",
          ...targetResolutionCommandArgs(target),
          "--attempt", String(last_attempt),
          "--event-id", `${action.stage}:${task_id}:${last_attempt}:reset`,
        ])];
      });
      return {
        snapshot,
        action: {
          kind: "needs_user" as const,
          reason,
          stage: action.stage,
          tasks: executionBlockers.map(({ task_id, inspection }) => ({ task_id, ...inspection })),
          ...(resetCommands.length ? { reset_commands: resetCommands } : {}),
          message: reason === "retry_exhausted"
            ? `semantic extraction failed ${MAX_ATTEMPTS} times; validate the required guarded recovery before retrying`
            : `task lease recovery exceeded ${MAX_LEASE_EPOCHS} epochs; use executor-specific recovery without a semantic reset`,
        },
      };
    }
    const preflight = preflightForAction(
      target,
      snapshot,
      action,
      maxParallel,
      availableAgentSlots,
      qualityProfile,
      budget,
      wallBudget,
      executorProvenance,
      buildPlan,
    )!;
    const planBudget = buildPlanBudgetEvaluation(target, buildPlan, snapshot, leaseOptions.now, preflight);
    if (planBudget.status === "exceeded"
      && !sameAutomaticBuildBudgetEvidence(acceptedPlanBudgetEvidence, planBudget)) {
      return {
        snapshot,
        preflight,
        plan_budget: planBudget,
        action: buildPlanBudgetRecoveryAction({
          target,
          snapshot,
          build_plan: buildPlan,
          plan_budget: planBudget,
          stage: action.stage,
          preflight,
        }),
      };
    }
    if (preflight.budget.status === "exceeded") {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "budget_exceeded",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          violations: preflight.budget.violations,
          message: "automatic build preflight exceeds the configured model-work budget",
        },
      };
    }
    if (preflight.wall_clock.budget.status !== "within_budget") {
      const lowConfidence = preflight.wall_clock.budget.status === "low_confidence";
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: lowConfidence ? "low_confidence_wall_budget" : "wall_budget_exceeded",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          evaluation_evidence: automaticBuildPreflightEvaluationEvidence(preflight),
          violations: preflight.wall_clock.budget.violations,
          confidence: preflight.wall_clock.confidence,
          message: lowConfidence
            ? "wall-clock or agent-start budget is exceeded without fully matched performance history"
            : "automatic build preflight exceeds the configured wall-clock budget",
        },
      };
    }
    if (preflight.worker_plan.available_agent_slots === 0) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "executor_unavailable",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          message: "no dedicated Codex executor slot is currently available",
        },
      };
    }
    if (!acceptedPlanDigest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "preflight_required",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          message: "inspect and accept the stable preflight plan before the first claim",
        },
      };
    }
    if (acceptedPlanDigest !== preflight.descriptor_plan_digest) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "plan_changed",
          stage: action.stage,
          accepted_plan_digest: acceptedPlanDigest,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          message: "the accepted preflight digest does not match the current descriptor plan",
        },
      };
    }
    if (wallBudget && !acceptedEvaluationEvidence) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "evaluation_required",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          evaluation_evidence: automaticBuildPreflightEvaluationEvidence(preflight),
          message: "inspect and accept the current wall-clock evaluation before the first claim",
        },
      };
    }
    if (wallBudget && !sameAutomaticBuildBudgetEvidence(
      acceptedEvaluationEvidence,
      automaticBuildPreflightEvaluationEvidence(preflight),
    )) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "evaluation_changed",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          accepted_evaluation_evidence: acceptedEvaluationEvidence,
          evaluation_evidence: automaticBuildPreflightEvaluationEvidence(preflight),
          message: "the accepted wall-clock evaluation does not match current history or remaining work",
        },
      };
    }
    const spec = STAGE_COMMANDS[action.stage];
    if (!spec.input || !spec.write) throw new Error(`stage ${action.stage} is not a semantic extraction stage`);
    const promptName = extractorPromptName(action.extractor);
    const allPendingUnits = action.work_units ?? [];
    const scheduled = selectAutomaticBuildCostBatch(allPendingUnits, {
      max_tasks: allPendingUnits.length,
      max_total_score: Math.min(
        preflight.worker_plan.max_batch_score,
        preflight.worker_plan.max_parallel_cost,
      ),
    });
    if (!scheduled.units.length) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "needs_user" as const,
          reason: "budget_exceeded",
          stage: action.stage,
          descriptor_plan_digest: preflight.descriptor_plan_digest,
          violations: [{
            code: "max_batch_score",
            actual: Math.min(...(action.work_units ?? []).map((unit) => unit.cost.score)),
            limit: preflight.worker_plan.max_batch_score,
          }],
          message: "no pending work unit fits the configured batch cost",
        },
      };
    }
    const acceptancePath = persistAutomaticBuildPlanAcceptance(target, preflight, leaseOptions.now);
    const evaluationAcceptancePath = wallBudget
      ? persistAutomaticBuildEvaluationAcceptance(target, preflight, leaseOptions.now)
      : undefined;
    if (executorDispatches) {
      let handoff: ReturnType<typeof selectAutomaticBuildDispatchHandoff>;
      try {
        handoff = selectAutomaticBuildDispatchHandoff(target, {
          accepted_plan_digest: preflight.descriptor_plan_digest,
          current_dispatch_plan: preflight.dispatch_plan,
          available_new_executor_slots: preflight.worker_plan.max_workers,
          created_at: leaseOptions.now,
        });
      } catch (error) {
        if (!(error instanceof AutomaticBuildLegacyPartialDispatchRunError)) throw error;
        return {
          snapshot,
          preflight,
          plan_budget: planBudget,
          action: {
            kind: "needs_user" as const,
            reason: "legacy_partial_dispatch_run",
            stage: error.prepared.manifest.stage,
            dispatch_id: error.prepared.manifest.dispatch_id,
            dispatch_run_id: error.prepared.dispatch_run_id,
            has_claim_or_progress: error.has_claim_or_progress,
            message: "a legacy manifest-only dispatch has claimed progress and requires explicit recovery inspection",
          },
        };
      }
      const selectedDispatches = handoff.selected_manifests;
      const dispatchRunId = automaticBuildDispatchRunId(handoff.persisted_plan.created_at);
      if (!selectedDispatches.length) {
        if (handoff.active_dispatch_ids.length) {
          return {
            snapshot,
            preflight,
            action: {
              kind: "waiting" as const,
              reason: "active_dispatches",
              stage: action.stage,
              active_dispatch_ids: handoff.active_dispatch_ids,
              dispatch_run_id: dispatchRunId,
              retry_after_ms: Math.min(leaseOptions.reserve_ttl_ms, 30_000),
            },
          };
        }
        return {
          snapshot,
          preflight,
          action: {
            kind: "needs_user" as const,
            reason: "executor_unavailable",
            stage: action.stage,
            descriptor_plan_digest: preflight.descriptor_plan_digest,
            message: "no executor dispatch can be assigned to the currently available dedicated slots",
          },
        };
      }
      const descriptorById = new Map(allPendingUnits.map((descriptor) => [descriptor.work_unit_id, descriptor]));
      const dispatchPrompts = new Map<string, {
        prompt_name: AutomaticBuildExtractorPromptName;
        resolved: ResolvedAutomaticBuildExecutorPromptV1;
      }>();
      if (action.stage === "paper_reading_guide") {
        throw new Error("paper_reading_guide cannot produce semantic executor dispatches");
      }
      try {
        for (const manifest of selectedDispatches) {
          const manifestExtractor = automaticBuildExtractorForWorkUnitKind(action.stage, manifest.kind);
          const manifestPromptName = extractorPromptName(manifestExtractor);
          dispatchPrompts.set(manifest.dispatch_id, {
            prompt_name: manifestPromptName,
            resolved: resolveAutomaticBuildExecutorPrompt(manifestPromptName, "dispatch"),
          });
        }
      } catch (error) {
        if (!(error instanceof AutomaticBuildExecutorPromptResolutionError)) throw error;
        return {
          snapshot,
          preflight,
          plan_budget: planBudget,
          action: {
            kind: "needs_user" as const,
            reason: "executor_prompt_unavailable",
            stage: action.stage,
            descriptor_plan_digest: preflight.descriptor_plan_digest,
            diagnostic_code: error.diagnostic_code,
            prompt_source: error.source,
            message: "the executor prompt provider is unavailable; run protocol-doctor before retrying",
          },
        };
      }
      for (const manifest of selectedDispatches) {
        for (const workUnitId of manifest.ordered_work_unit_ids) {
          freezeAutomaticBuildGenerationTask(target, productionStageState, workUnitId);
        }
      }
      const dispatches = selectedDispatches.map((manifest) => {
        const dispatchPrompt = dispatchPrompts.get(manifest.dispatch_id);
        if (!dispatchPrompt) {
          throw new Error(`automatic build dispatch is missing its extractor prompt: ${manifest.dispatch_id}`);
        }
        const runTtlMs = leaseOptions.run_ttl_ms
          ?? preflight.wall_clock.adaptive_run_ttl_ms_by_kind[manifest.kind]
          ?? DEFAULT_RUN_TTL_MS;
        const publication = prepareAutomaticBuildDispatch(target, manifest, {
          owner: `automatic-build-dispatch:${manifest.dispatch_id}:${dispatchRunId}`,
          created_at: handoff.persisted_plan.created_at,
          reserve_ttl_ms: leaseOptions.reserve_ttl_ms,
          run_ttl_ms: runTtlMs,
          dispatch_run_id: dispatchRunId,
        });
        const existingDispatch = existsSync(publication.manifest_path)
          ? readAutomaticBuildDispatch(target, manifest.stage, manifest.dispatch_id, dispatchRunId)
          : undefined;
        if (existingDispatch
          && (canonicalAutomaticBuildJson(existingDispatch.manifest) !== canonicalAutomaticBuildJson(manifest)
            || existingDispatch.owner !== publication.prepared.owner)) {
          throw new Error(`persisted dispatch identity conflicts with selected plan: ${publication.manifest_path}`);
        }
        const envelope = {
          version: "automatic_build_dispatch_executor.v1" as const,
          manifest,
          dispatch_run_id: dispatchRunId,
          manifest_path: publication.manifest_path,
          cwd: target.root_dir,
          next_command: scriptCommand("automatic-build.ts", [
            "dispatch.next", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          inspect_command: scriptCommand("automatic-build.ts", [
            "dispatch.inspect", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          finish_command: scriptCommand("automatic-build.ts", [
            "dispatch.finish", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, ...targetResolutionCommandArgs(target),
          ]),
          interrupt_command: scriptCommand("automatic-build.ts", [
            "dispatch.finish", targetInput, action.stage, manifest.dispatch_id,
            "--dispatch-run", dispatchRunId, "--terminal-reason", "executor_interrupted",
            "--interruption-code", "{diagnostic_code}",
            "--interruption-reporter", "{reporter}",
            "--interruption-command-role", "{last_command_role}",
            ...targetResolutionCommandArgs(target),
          ]),
          accounting: {
            work_units: manifest.ordered_work_unit_ids.length,
            total_score: manifest.ordered_work_unit_ids.reduce(
              (sum, workUnitId) => sum + (descriptorById.get(workUnitId)?.cost.score ?? 0),
              0,
            ),
          },
        };
        const executorHandoff = existingDispatch?.executor_handoff ?? (() => {
          const preparedHandoff = persistDispatchExecutorHandoff(
            publication.manifest_path,
            dispatchPrompt.resolved,
            envelope,
          );
          return persistAutomaticBuildDispatch(target, manifest, {
            owner: publication.prepared.owner,
            created_at: publication.prepared.created_at,
            reserve_ttl_ms: publication.prepared.reserve_ttl_ms,
            run_ttl_ms: publication.prepared.run_ttl_ms,
            dispatch_run_id: publication.prepared.dispatch_run_id,
            executor_handoff: preparedHandoff,
          }).persisted.executor_handoff;
        })();
        const opaqueHandoff = issueAutomaticBuildOpaqueHandoff({
          target,
          kind: "public_dispatch",
          owner_identity: {
            version: "automatic_build_dispatch_owner_identity.v1",
            stage: manifest.stage,
            dispatch_id: manifest.dispatch_id,
            dispatch_run_id: dispatchRunId,
          },
          executor_handoff: executorHandoff,
          issued_at: leaseOptions.now,
        });
        return {
          ...envelope,
          executor_handoff: executorHandoff,
          opaque_handoff_ref: opaqueHandoff.opaque_handoff_ref,
        };
      });
      const dispatchedIds = new Set(selectedDispatches.flatMap((dispatch) => dispatch.ordered_work_unit_ids));
      return {
        snapshot,
        preflight,
        plan_budget: planBudget,
        action: {
          kind: "dispatch" as const,
          stage: action.stage,
          plan_acceptance_path: acceptancePath,
          ...(evaluationAcceptancePath ? { evaluation_acceptance_path: evaluationAcceptancePath } : {}),
          cwd: target.root_dir,
          extractor_prompt_command: executorPromptCommand(
            dispatchPrompts.get(selectedDispatches[0].dispatch_id)?.prompt_name ?? promptName,
            "dispatch",
          ),
          dispatches,
          dispatch_plan_digest: handoff.persisted_plan.dispatch_plan.dispatch_plan_digest,
          active_dispatch_ids: handoff.active_dispatch_ids,
          completed_dispatch_ids: handoff.completed_dispatch_ids,
          scheduled_batch: {
            total_score: dispatches.reduce((sum, dispatch) => sum + dispatch.accounting.total_score, 0),
            deferred_ids: allPendingUnits
              .filter((unit) => !dispatchedIds.has(unit.work_unit_id))
              .map((unit) => unit.work_unit_id),
          },
          receipt_aggregation: {
            version: "automatic_build_dispatch_receipt_aggregation.v1" as const,
            expected_receipts: dispatches.length,
            max_receipt_bytes: 16_384,
            max_total_bytes: dispatches.length * 16_384,
            candidate_payload_forbidden: true,
          },
        },
      };
    }
    const claims: Array<{
      task_id: string;
      descriptor: WorkUnitDescriptor;
      status: "leased";
      lease_ref: string;
      lease: AutomaticBuildTaskLease;
      execution_identity: AutomaticBuildExecutionIdentity;
    }> = [];
    let claimedScore = 0;
    for (const descriptor of scheduled.units) {
      const taskId = descriptor.work_unit_id;
      const binding = action.task_bindings?.[taskId];
      if (!binding) throw new Error(`automatic semantic task is missing policy binding: ${action.stage}/${taskId}`);
      freezeAutomaticBuildGenerationTask(target, productionStageState, taskId);
      const claim = claimAutomaticBuildTask(target, action.stage, taskId, {
        owner: leaseOptions.owner,
        now: leaseOptions.now,
        reserve_ttl_ms: leaseOptions.reserve_ttl_ms,
        binding,
        descriptor,
        ...(descriptor.version === "automatic_build_work_unit.v3"
          ? { policy_generation: "v3_only" as const }
          : {}),
      });
      if (claim.status === "leased") {
        claims.push({ task_id: taskId, descriptor, ...claim });
        claimedScore += descriptor.cost.score;
      }
      if (claims.length >= preflight.worker_plan.max_workers) break;
    }
    if (claims.length === 0) {
      return {
        snapshot,
        preflight,
        action: {
          kind: "waiting" as const,
          reason: "active_leases",
          stage: action.stage,
          retry_after_ms: Math.min(leaseOptions.reserve_ttl_ms, 30_000),
        },
      };
    }
    return {
      snapshot,
      preflight,
      plan_budget: planBudget,
      action: {
        ...action,
        task_ids: claims.map((claim) => claim.task_id),
        work_units: claims.map((claim) => claim.descriptor),
        plan_acceptance_path: acceptancePath,
        ...(evaluationAcceptancePath ? { evaluation_acceptance_path: evaluationAcceptancePath } : {}),
        scheduled_batch: {
          total_score: claimedScore,
          deferred_ids: allPendingUnits
            .filter((unit) => !claims.some((claim) => claim.task_id === unit.work_unit_id))
            .map((unit) => unit.work_unit_id),
        },
        receipt_aggregation: {
          version: "automatic_build_receipt_aggregation.v1",
          expected_receipts: claims.length,
          max_receipt_bytes: 4_096,
          max_total_bytes: claims.length * 4_096,
          candidate_payload_forbidden: true,
        },
        cwd: target.root_dir,
        extractor_prompt: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? undefined
          : path.join(PLUGIN_ROOT, "agents", promptName),
        extractor_prompt_command: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? [process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "prompt", promptName]
          : undefined,
        tasks: claims.map((claim) => {
          const taskId = claim.task_id;
          const attemptNumber = claim.execution_identity.semantic_attempt;
          const runTtlMs = leaseOptions.run_ttl_ms
            ?? preflight.wall_clock.adaptive_run_ttl_ms_by_kind[claim.descriptor.kind]
            ?? DEFAULT_RUN_TTL_MS;
          const leaseArgs = ["--lease-ref", claim.lease_ref, "--lease-token", claim.lease.token];
          const candidatePath = path.join(path.dirname(claim.lease_ref), "candidate.json");
          return {
            task_id: taskId,
            attempt_number: attemptNumber,
            execution_identity: claim.execution_identity,
            lease_ref: claim.lease_ref,
            lease: claim.lease,
            descriptor: claim.descriptor,
            candidate_path: candidatePath,
            usage_path: automaticBuildUsageReceiptPath(claim.lease_ref),
            input_command: scriptCommand("automatic-build.ts", [
              "input", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), "--run-ttl-ms", String(runTtlMs), ...leaseArgs,
            ]),
            candidate_command: scriptCommand("automatic-build.ts", [
              "candidate", targetInput, action.stage, taskId, "{candidate_source}",
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            submit_command: scriptCommand("automatic-build.ts", [
              "submit", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            fail_command: scriptCommand("automatic-build.ts", [
              "fail", targetInput, action.stage, taskId,
              "--diagnostic-code", "{diagnostic_code}", "--message", "{diagnostic}",
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            inspect_command: scriptCommand("automatic-build.ts", [
              "inspect", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
            heartbeat_command: scriptCommand("automatic-build.ts", [
              "heartbeat", targetInput, action.stage, taskId,
              ...targetResolutionCommandArgs(target), ...leaseArgs,
            ]),
          };
        }),
      },
    };
  }
  if (action.kind === "close_stage") {
    if (action.stage !== "paper_reading_guide") {
      const stageState = snapshot.stages.find((stage) => stage.stage === action.stage);
      if (!stageState) throw new Error(`quality gate stage is missing from snapshot: ${action.stage}`);
      const qualityReport = collectAutomaticBuildStageQuality(target, stageState, qualityProfile);
      if (qualityReport.gate_status !== "passed") {
        return {
          snapshot,
          plan_budget: settledPlanBudget,
          quality_report: qualityReport,
          action: {
            kind: "needs_user" as const,
            reason: "quality_gate_failed",
            stage: action.stage,
            gate_status: qualityReport.gate_status,
            quality_report: qualityReport,
            message: "stage integrity or the selected versioned quality floor did not pass; public artifacts were not published",
          },
        };
      }
      return {
        snapshot,
        plan_budget: settledPlanBudget,
        quality_report: qualityReport,
        action: {
          ...action,
          quality_report_path: automaticBuildStageQualityReportPath(target, action.stage),
          cwd: target.root_dir,
          command: scriptCommand("automatic-build.ts", [
            "close", targetCommandInput(target), action.stage,
            ...targetResolutionCommandArgs(target),
            "--quality-profile", qualityProfile,
          ]),
        },
      };
    }
    return {
      snapshot,
      plan_budget: settledPlanBudget,
      action: {
        ...action,
        cwd: target.root_dir,
        command: scriptCommand("automatic-build.ts", [
          "close", targetCommandInput(target), action.stage, ...targetResolutionCommandArgs(target),
        ]),
        ...(action.stage === "paper_reading_guide"
          ? { verification_path: path.join(target.workspace_dir, ".build", "paper-reading-guide", "verification.json") }
          : {}),
      },
    };
  }
  return { snapshot, plan_budget: settledPlanBudget, action };
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printAutomaticBuildJson(value: unknown): void {
  process.stdout.write(canonicalAutomaticBuildJson(value));
}

export function automaticBuildNext(
  targetInput: string,
  rootDir: string,
  maxParallel = 5,
  options: AutomaticBuildNextOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const protocol = resolveAutomaticBuildClaimProtocol(options.protocol, options.executor_dispatches === true);
  const leaseOptions = {
    owner: options.owner ?? `automatic-build:${process.pid}:${randomUUID()}`,
    now: options.now ?? new Date().toISOString(),
    reserve_ttl_ms: options.lease_ttl_ms ?? DEFAULT_RESERVE_TTL_MS,
    ...(options.run_ttl_ms !== undefined ? { run_ttl_ms: options.run_ttl_ms } : {}),
  };
  return {
    version: "automatic_build_next.v1",
    protocol,
    release: AUTOMATIC_BUILD_ACTIVE_RELEASE,
    routing_release: AUTOMATIC_BUILD_ROUTING_RELEASE,
    ...expandAction(
      target,
      maxParallel,
      leaseOptions,
      options.available_agent_slots ?? maxParallel,
      options.quality_profile ?? "full",
      options.budget ?? DEFAULT_AUTOMATIC_BUILD_BUDGET,
      options.wall_budget,
      options.executor_provenance,
      options.accepted_plan_digest,
      options.accepted_evaluation_evidence,
      options.accepted_plan_budget_evidence,
      protocol === AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
      options.build_plan,
    ),
  };
}

function policyContractsForStage(policySet: AutomaticBuildStagePolicySetV3): Array<{
  kind: WorkUnitKind;
  policy_generation_id: string;
  semantic_contract: SemanticContractV1;
}> {
  return policySet.members.map((member) => ({
    kind: member.kind,
    policy_generation_id: member.policy_generation_id,
    semantic_contract: member.semantic_contract,
  }));
}

export function runAutomaticBuildCloseStage(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  options: {
    quality_profile?: ExtractionQualityProfile;
    book_id?: string;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const qualityProfile = options.quality_profile ?? "full";
  if (stage === "paper_reading_guide") {
    forwardStageScript(target, "verify-paper-reading-guide.ts", [target.workspace_dir], true);
    return verifyAutomaticBuildStageClose(target);
  }

  const script = STAGE_COMMANDS[stage].close;
  if (!script) throw new Error(`stage ${stage} does not support close`);
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfile });
  const stageState = snapshot.stages.find((candidate) => candidate.stage === stage);
  if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stage}`);

  let productionPolicyContracts: string | undefined;
  if (stageState.policy_set) {
    if (stage !== "pass1" && stage !== "profile_sidecar" && stage !== "book_structure") {
      throw new Error(`proof-bound production close is not supported for stage ${stage}`);
    }
    productionPolicyContracts = JSON.stringify(policyContractsForStage(stageState.policy_set));
  }
  const args = stageScriptArgs(target);
  if (productionPolicyContracts) {
    args.push(
      "--production-policy-contracts", productionPolicyContracts,
      "--quality-profile", qualityProfile,
    );
  }
  if (stage === "pass1" && target.kind === "paper_workspace") {
    args.push("--preserve-foundation", target.workspace_dir);
  }
  return closeAutomaticBuildStage({
    target,
    stage,
    quality_profile: qualityProfile,
    run_batch: () => forwardStageScript(target, script, args, true),
  });
}

type AutomaticBuildReleaseDoctorDiagnosticCode =
  | AutomaticBuildExecutorPromptDiagnosticCode
  | "release_policy_set_invalid"
  | "release_prompt_hash_mismatch"
  | "release_renderer_invalid"
  | "release_budget_proof_invalid"
  | "release_recovery_reader_invalid"
  | "release_close_reader_invalid"
  | "release_contract_invalid";

class AutomaticBuildReleaseDoctorError extends Error {
  readonly name = "AutomaticBuildReleaseDoctorError";

  constructor(readonly diagnostic_code: AutomaticBuildReleaseDoctorDiagnosticCode) {
    super(`automatic build release doctor failed: ${diagnostic_code}`);
  }
}

function syntheticModelInputRequest(
  kind: (typeof AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1)[number]["kind"],
  profileId: string,
): ModelInputRenderRequest {
  const core = "Synthetic semantic evidence.";
  const span = { start: 0, end: core.length };
  const artifactHash = "a".repeat(64);
  switch (kind) {
    case "pass1_window":
      return { kind, input: { text: "[LID 1]\nSynthetic whole semantic input.\n" } };
    case "pass1_source_slice":
      return {
        kind,
        input: {
          version: "model_input_slice_render_context.v1",
          content_profile_id: profileId,
          parent_lid: "1",
          ordinal: 0,
          boundary_kind: "whole_lid",
          core_span_utf16: span,
          context_span_utf16: span,
          context_before: "",
          core,
          context_after: "",
          core_sha256: createHash("sha256").update(core, "utf8").digest("hex"),
        },
      };
    case "pass1_lid_stitch":
      return {
        kind,
        input: {
          version: "pass1_lid_stitch_input.v1",
          work_unit_id: "release-doctor-pass1-final",
          window_id: 1,
          reducer_level: 1,
          group_ordinal: 0,
          role: "final",
          source_unit_range: { start_ordinal: 0, end_ordinal_exclusive: 1 },
          children: [{
            work_unit_id: "release-doctor-pass1-child",
            artifact_hash: artifactHash,
            source_unit_range: { start_ordinal: 0, end_ordinal_exclusive: 1 },
            payload: { nodes: [], edges: [] },
          }],
        },
      };
    case "profile_sidecar_discourse":
    case "profile_sidecar_formula":
      return {
        kind,
        input: {
          work_unit_id: `release-doctor-${kind}`,
          unit_kind: kind,
          visible_lids: ["1"],
          formula_lids: kind === "profile_sidecar_formula" ? ["1"] : [],
          text: "[LID 1]\nSynthetic profile semantic input.\n",
        },
      };
    case "profile_sidecar_discourse_fragment":
      return {
        kind,
        input: {
          version: "model_input_slice_render_context.v1",
          content_profile_id: profileId,
          parent_lid: "1",
          ordinal: 0,
          boundary_kind: "whole_lid",
          core_span_utf16: span,
          context_span_utf16: span,
          context_before: "",
          core,
          context_after: "",
        },
      };
    case "profile_sidecar_discourse_reduce":
      return {
        kind,
        input: {
          version: "profile_sidecar_discourse_reduction_input.v1",
          work_unit_id: "release-doctor-profile-final",
          parent_lid: "1",
          reducer_level: 1,
          group_ordinal: 0,
          role: "final",
          source_slice_range: { start_ordinal: 0, end_ordinal_exclusive: 1 },
          children: [{
            work_unit_id: "release-doctor-profile-child",
            artifact_hash: artifactHash,
            source_slice_range: { start_ordinal: 0, end_ordinal_exclusive: 1 },
            payload: {
              version: "profile_sidecar_discourse_observation.v1",
              parent_lid: "1",
              source_slice_ordinal: 0,
            },
          }],
        },
      };
  }
}

function buildAutomaticBuildReleaseContractCheck(profileId: AutomaticBuildTarget["profile_id"]) {
  const profile = resolveContentProfile(profileId);
  const syntheticTarget = {
    version: "build_target_ref.v2" as const,
    workspace_dir: "<automatic-build-release-doctor>",
    book_id: "release-doctor",
    profile_id: profile.id,
    input_fingerprint: "1".repeat(64),
  };
  const policySets = [
    createAutomaticBuildStagePolicySet({
      target_ref: syntheticTarget,
      stage: "pass1",
      members: pass1ModelSlicePolicyMembers(profile, "full"),
      frozen_at: AUTOMATIC_BUILD_ROUTING_RELEASE.activated_at,
    }),
    createAutomaticBuildStagePolicySet({
      target_ref: syntheticTarget,
      stage: "profile_sidecar",
      members: profileSidecarMapReducePolicyMembers(profile, "full"),
      frozen_at: AUTOMATIC_BUILD_ROUTING_RELEASE.activated_at,
    }),
  ];
  const expectedByIdentity = new Map(AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1.map((member) => [
    `${member.stage}:${member.kind}`,
    member,
  ]));
  const promptAssets = new Map<string, ResolvedAutomaticBuildPromptAssetV1>();
  const reports: Array<{
    stage: SemanticBuildStage;
    members: Array<{
      kind: WorkUnitKind;
      extractor: string;
      policy_generation_id: string;
      semantic_contract: SemanticContractV1;
      prompt_name: string;
      prompt_source: AutomaticBuildPromptSource;
      prompt_sha256: string;
      prompt_bytes: number;
      schema_version: string;
      router_version: string;
      rendered_input_sha256: string;
      estimated_tokens: number;
    }>;
  }> = [];
  let provenMembers = 0;
  let recoveryReaderStatus: "compatible" | "incompatible" = "incompatible";
  let closeReaderStatus: "compatible" | "incompatible" = "incompatible";
  try {
    if (MODEL_INPUT_RENDER_CONTRACT_VERSION !== AUTOMATIC_BUILD_RELEASE_V3.model_input.render_contract
      || MODEL_INPUT_ESTIMATOR_VERSION !== AUTOMATIC_BUILD_RELEASE_V3.model_input.estimator
      || canonicalAutomaticBuildJson(AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1)
        !== canonicalAutomaticBuildJson(AUTOMATIC_BUILD_RELEASE_V3.model_input.budget)) {
      throw new AutomaticBuildReleaseDoctorError("release_renderer_invalid");
    }
    const seen = new Set<string>();
    for (const uncheckedPolicySet of policySets) {
      let policySet;
      try {
        policySet = validateAutomaticBuildStagePolicySet(uncheckedPolicySet);
      } catch {
        throw new AutomaticBuildReleaseDoctorError("release_policy_set_invalid");
      }
      const members: (typeof reports)[number]["members"] = [];
      for (const member of policySet.members) {
        const identity = `${policySet.stage}:${member.kind}`;
        const expected = expectedByIdentity.get(identity);
        if (!expected || seen.has(identity)) {
          throw new AutomaticBuildReleaseDoctorError("release_policy_set_invalid");
        }
        seen.add(identity);
        const policy = extractionPolicyFromSemanticContract(profile.id, member.semantic_contract);
        const promptName = extractorPromptName(member.extractor);
        if (member.extractor !== expected.extractor
          || promptName !== expected.prompt_name
          || policy.stage_policy_version !== expected.stage_policy_version
          || policy.router_version !== expected.router_version
          || policy.prompt_sha256 !== expected.prompt_sha256
          || policy.schema_version !== expected.schema_version
          || policy.profile_id !== profile.id
          || policy.profile_version !== profile.profile_version
          || policy.quality_profile !== "full") {
          throw new AutomaticBuildReleaseDoctorError("release_policy_set_invalid");
        }
        let promptAsset = promptAssets.get(promptName);
        if (!promptAsset) {
          try {
            promptAsset = resolveAutomaticBuildPromptAsset(promptName);
          } catch (error) {
            if (error instanceof AutomaticBuildExecutorPromptResolutionError) {
              throw new AutomaticBuildReleaseDoctorError(error.diagnostic_code);
            }
            throw error;
          }
          promptAssets.set(promptName, promptAsset);
        }
        if (promptAsset.sha256 !== expected.prompt_sha256) {
          throw new AutomaticBuildReleaseDoctorError("release_prompt_hash_mismatch");
        }
        const rendered = inspectRenderedModelInput(syntheticModelInputRequest(expected.kind, profile.id));
        if (rendered.render_contract_version !== MODEL_INPUT_RENDER_CONTRACT_VERSION) {
          throw new AutomaticBuildReleaseDoctorError("release_renderer_invalid");
        }
        const evaluated = evaluateModelInputBudget({
          ...AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
          rendered_input: rendered.text,
          router_version: policy.router_version,
          prompt_sha256: policy.prompt_sha256,
        });
        if (evaluated.status !== "within_limit") {
          throw new AutomaticBuildReleaseDoctorError("release_budget_proof_invalid");
        }
        try {
          verifyModelInputBudgetProof(rendered.text, evaluated.proof);
        } catch {
          throw new AutomaticBuildReleaseDoctorError("release_budget_proof_invalid");
        }
        if (evaluated.proof.estimator_version !== MODEL_INPUT_ESTIMATOR_VERSION
          || evaluated.proof.render_contract_version !== MODEL_INPUT_RENDER_CONTRACT_VERSION
          || evaluated.proof.rendered_input_sha256 !== rendered.sha256
          || Object.hasOwn(evaluated.proof, "proof_digest")
          || Object.hasOwn(evaluated.proof, "preflight_evaluation_digest")
          || Object.hasOwn(evaluated.proof, "receipt_digest")) {
          throw new AutomaticBuildReleaseDoctorError("release_budget_proof_invalid");
        }
        provenMembers += 1;
        members.push({
          kind: member.kind,
          extractor: member.extractor,
          policy_generation_id: member.policy_generation_id,
          semantic_contract: member.semantic_contract,
          prompt_name: promptName,
          prompt_source: promptAsset.source,
          prompt_sha256: promptAsset.sha256,
          prompt_bytes: promptAsset.byte_length,
          schema_version: policy.schema_version,
          router_version: policy.router_version,
          rendered_input_sha256: rendered.sha256,
          estimated_tokens: rendered.estimated_tokens,
        });
      }
      reports.push({ stage: policySet.stage, members });
    }
    if (seen.size !== AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1.length) {
      throw new AutomaticBuildReleaseDoctorError("release_policy_set_invalid");
    }
    try {
      parseAutomaticBuildRecoveryEnvelope(createAutomaticBuildRecoveryEnvelope({
        phase: "routing",
        code: "budget_proof_invalid",
        stage: "pass1",
        target_ref: syntheticTarget,
        router_version: AUTOMATIC_BUILD_ROUTING_RELEASE.pass1_router,
        affected_work_units: [{
          work_unit_id: "release-doctor-pass1",
          evidence_lids: ["1"],
          estimated_tokens: 1,
          limit_tokens: AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.stage_body_limit_tokens,
        }],
        retryable: true,
        recovery_actions: ["retry_plan"],
      }));
      recoveryReaderStatus = "compatible";
    } catch {
      throw new AutomaticBuildReleaseDoctorError("release_recovery_reader_invalid");
    }
    try {
      parseAutomaticBuildStageCloseResult({
        version: "automatic_build_stage_close_result.v2",
        status: "closed",
        stage: "pass1",
        target: {
          book_id: syntheticTarget.book_id,
          profile_id: syntheticTarget.profile_id,
          input_fingerprint: syntheticTarget.input_fingerprint,
        },
        quality: { report_digest: "2".repeat(64), gate_status: "passed" },
        publication: { transaction_id: "3".repeat(64), receipt_digest: "4".repeat(64) },
        postcondition: {
          stage_closed: true,
          policy_contracts: reports[0].members.map((member) => ({
            kind: member.kind,
            policy_generation_id: member.policy_generation_id,
            semantic_contract: member.semantic_contract,
          })),
          coverage_digest: "6".repeat(64),
          freshness_digest: "7".repeat(64),
          public_artifact_set_digest: "8".repeat(64),
        },
        next: "replan",
      });
      closeReaderStatus = "compatible";
    } catch {
      throw new AutomaticBuildReleaseDoctorError("release_close_reader_invalid");
    }
    return {
      status: "compatible" as const,
      profile_id: profile.id,
      policy_sets: reports,
      model_input: {
        render_contract: MODEL_INPUT_RENDER_CONTRACT_VERSION,
        estimator: MODEL_INPUT_ESTIMATOR_VERSION,
        proven_members: provenMembers,
      },
      readers: {
        recovery: {
          version: AUTOMATIC_BUILD_RELEASE_V3.recovery_envelope,
          status: recoveryReaderStatus,
        },
        close: {
          version: AUTOMATIC_BUILD_RELEASE_V3.close_result,
          status: closeReaderStatus,
        },
      },
    };
  } catch (error) {
    const diagnosticCode = error instanceof AutomaticBuildReleaseDoctorError
      ? error.diagnostic_code
      : "release_contract_invalid";
    return {
      status: "incompatible" as const,
      profile_id: profile.id,
      policy_sets: reports,
      model_input: {
        render_contract: MODEL_INPUT_RENDER_CONTRACT_VERSION,
        estimator: MODEL_INPUT_ESTIMATOR_VERSION,
        proven_members: provenMembers,
      },
      readers: {
        recovery: {
          version: AUTOMATIC_BUILD_RELEASE_V3.recovery_envelope,
          status: recoveryReaderStatus,
        },
        close: {
          version: AUTOMATIC_BUILD_RELEASE_V3.close_result,
          status: closeReaderStatus,
        },
      },
      diagnostic_code: diagnosticCode,
    };
  }
}

const AUTOMATIC_BUILD_DOCTOR_POLICY_EVIDENCE_FORBIDDEN_FIELDS = [
  "current_policy_digest",
  "current_proof_digest",
  "current_route_digest",
  "evidence_digest",
  "file_sha256",
  "preflight_evaluation_digest",
  "proof_digest",
  "policy_digest",
  "policy_set_digest",
  "receipt_digest",
  "resolution_digest",
] as const;

const AUTOMATIC_BUILD_DOCTOR_TRANSPORT_FORBIDDEN_FIELDS = [
  "delivery_ledger_digest",
  "output_contract_digest",
  "pack_digest",
  "payload_sha256",
  "profile_digest",
  "serialized_response_sha256",
  "transport_profile_digest",
] as const;

interface AutomaticBuildProtocolDoctorBoundaryInputV3 {
  agent_template: string;
  plugin_mcp_projections: readonly string[];
  launcher_projections: readonly string[];
  release_contract: unknown;
}

function isDoctorRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function countOwnDoctorFields(
  value: unknown,
  fields: readonly string[],
): number {
  if (!isDoctorRecord(value)) return 0;
  return fields.filter((field) => Object.hasOwn(value, field)).length;
}

function validateDirectTextProjections(projections: readonly string[], label: string): string {
  if (projections.length === 0 || projections.some((projection) => projection.length === 0)) {
    throw new Error(`${label} projection is missing`);
  }
  const canonical = projections[0];
  if (projections.some((projection) => projection !== canonical)) {
    throw new Error(`${label} projections differ by direct text comparison`);
  }
  return canonical;
}

function validateBuildExecutorLauncherV3(text: string): void {
  const normalizedLines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim());
  const expectedCommand = `"%BUILD_EXECUTOR_BIN%" executor.mcp --bootstrap-version ${
    BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version
  } --protocol-generation ${BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol}`;
  if (normalizedLines.filter((line) => line === expectedCommand).length !== 1
    || normalizedLines.some((line) => line.includes("--agent-bootstrap-digest"))) {
    throw new Error("Build Executor launcher bootstrap or session protocol is incompatible");
  }
}

function releasePolicySets(releaseContract: unknown): Record<string, unknown>[] {
  if (!isDoctorRecord(releaseContract)
    || releaseContract.status !== "compatible"
    || !Array.isArray(releaseContract.policy_sets)) {
    return [];
  }
  return releaseContract.policy_sets.filter(isDoctorRecord);
}

function releasePolicyMembers(policySets: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return policySets.flatMap((policySet) => (
    Array.isArray(policySet.members) ? policySet.members.filter(isDoctorRecord) : []
  ));
}

export function validateAutomaticBuildProtocolDoctorBoundaryV3(
  input: AutomaticBuildProtocolDoctorBoundaryInputV3,
) {
  let executorRole:
    | {
      status: "compatible";
      agent_name: "understand_book_executor";
      mcp_servers_in_role: 0;
    }
    | { status: "incompatible"; diagnostic_code: "executor_role_incompatible" };
  try {
    const role = validateBuildExecutorRoleConfigV3(input.agent_template);
    executorRole = {
      status: "compatible",
      agent_name: role.agent_name,
      mcp_servers_in_role: role.mcp_servers_in_role,
    };
  } catch {
    executorRole = { status: "incompatible", diagnostic_code: "executor_role_incompatible" };
  }

  let sharedExecutorMcp:
    | {
      status: "compatible";
      registration_scope: "root_shared";
      bootstrap_version: "automatic_build_executor_bootstrap.v3";
      session_protocol: "automatic_build_executor_session.v3";
      required: false;
      default_tools_approval_mode: "approve";
      executor_tool_count: 4;
    }
    | { status: "incompatible"; diagnostic_code: "shared_executor_mcp_incompatible" };
  try {
    if (input.plugin_mcp_projections.length !== input.launcher_projections.length) {
      throw new Error("Build Executor config and launcher projection counts differ");
    }
    validateDirectTextProjections(input.plugin_mcp_projections, "Build Executor MCP config");
    const launcher = validateDirectTextProjections(
      input.launcher_projections,
      "Build Executor launcher",
    );
    const sharedConfigs = input.plugin_mcp_projections.map((projection) => (
      validateBuildExecutorSharedMcpConfigV3(projection)
    ));
    validateBuildExecutorLauncherV3(launcher);
    const shared = sharedConfigs[0];
    if (!shared
      || shared.registration_scope !== BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.registration_scope
      || shared.tool_names.length !== BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.length
      || shared.tool_names.some((toolName, index) => (
        toolName !== BUILD_EXECUTOR_MCP_CONTRACT_V3.tools[index]?.name
      ))) {
      throw new Error("Build Executor shared MCP identity is incompatible");
    }
    sharedExecutorMcp = {
      status: "compatible",
      registration_scope: shared.registration_scope,
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      session_protocol: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      required: shared.required,
      default_tools_approval_mode: shared.default_tools_approval_mode,
      executor_tool_count: 4,
    };
  } catch {
    sharedExecutorMcp = {
      status: "incompatible",
      diagnostic_code: "shared_executor_mcp_incompatible",
    };
  }

  const policySets = releasePolicySets(input.release_contract);
  const members = releasePolicyMembers(policySets);
  const policyEvidenceObjects = [input.release_contract, ...policySets, ...members];
  const toolSchemaObjects = BUILD_EXECUTOR_MCP_CONTRACT_V3.tools.flatMap((tool) => [
    tool,
    tool.input_schema,
    tool.input_schema.properties,
  ]);
  const forbiddenDigestFieldCount = countOwnDoctorFields(
    BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3,
    ["bootstrap_digest"],
  ) + countOwnDoctorFields(
    CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
    AUTOMATIC_BUILD_DOCTOR_TRANSPORT_FORBIDDEN_FIELDS,
  ) + toolSchemaObjects.reduce<number>((count, value) => count + countOwnDoctorFields(
    value,
    AUTOMATIC_BUILD_DOCTOR_TRANSPORT_FORBIDDEN_FIELDS,
  ), 0) + policyEvidenceObjects.reduce<number>((count, value) => count + countOwnDoctorFields(
    value,
    AUTOMATIC_BUILD_DOCTOR_POLICY_EVIDENCE_FORBIDDEN_FIELDS,
  ), 0);
  let connectionIntegrity:
    | {
      status: "compatible";
      model_parameter: false;
      caller_role_authenticated: false;
      cross_handoff_rejected: true;
      session_private_root_bound: true;
      forbidden_digest_field_count: 0;
    }
    | {
      status: "incompatible";
      diagnostic_code: "connection_integrity_incompatible";
      forbidden_digest_field_count: number;
    };
  try {
    const connection = createBuildExecutorStdioConnectionCapability({
      bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
      protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
      session_private_root: path.resolve(PLUGIN_ROOT, ".automatic-build-executor-private"),
    });
    const firstOpen = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v3",
        opaque_handoff_ref: `abhandoff1_${"a".repeat(64)}`,
      },
    };
    const crossHandoffOpen = {
      tool_name: "executor.open" as const,
      request: {
        version: "automatic_build_executor_open_request.v3",
        opaque_handoff_ref: `abhandoff1_${"b".repeat(64)}`,
      },
    };
    let relativeRootRejected = false;
    try {
      createBuildExecutorStdioConnectionCapability({
        bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
        protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
        session_private_root: "relative-root-is-not-bound",
      });
    } catch {
      relativeRootRejected = true;
    }
    const serializedToolContract = JSON.stringify(BUILD_EXECUTOR_MCP_CONTRACT_V3);
    if (connection.authorize_connection(Symbol("root"), firstOpen)
      || !connection.authorize_connection(connection.connection_capability, firstOpen)
      || connection.authorize_connection(connection.connection_capability, crossHandoffOpen)
      || JSON.stringify(connection.connection_capability) !== undefined
      || !relativeRootRejected
      || BUILD_EXECUTOR_MCP_CONTRACT_V3.caller_role_authenticated !== false
      || serializedToolContract.includes("connection_capability")
      || serializedToolContract.includes("session_private_root")
      || forbiddenDigestFieldCount !== 0) {
      throw new Error("Build Executor connection integrity evidence is incompatible");
    }
    connectionIntegrity = {
      status: "compatible",
      model_parameter: false,
      caller_role_authenticated: false,
      cross_handoff_rejected: true,
      session_private_root_bound: true,
      forbidden_digest_field_count: 0,
    };
  } catch {
    connectionIntegrity = {
      status: "incompatible",
      diagnostic_code: "connection_integrity_incompatible",
      forbidden_digest_field_count: forbiddenDigestFieldCount,
    };
  }

  const policyGenerationIsExplicit = members.length > 0 && members.every((member) => (
    typeof member.policy_generation_id === "string"
    && member.policy_generation_id.length > 0
    && isDoctorRecord(member.semantic_contract)
    && typeof member.semantic_contract.prompt_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(member.semantic_contract.prompt_sha256)
  ));
  const largeContentHashConsumersPresent = members.length > 0 && members.every((member) => (
    typeof member.prompt_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(member.prompt_sha256)
    && typeof member.rendered_input_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(member.rendered_input_sha256)
  ));
  const semanticIdentityForbiddenFieldCount = policyEvidenceObjects.reduce<number>(
    (count, value) => count + countOwnDoctorFields(
      value,
      AUTOMATIC_BUILD_DOCTOR_POLICY_EVIDENCE_FORBIDDEN_FIELDS,
    ),
    0,
  );
  const budgetProofIsFreshnessIdentity = semanticIdentityForbiddenFieldCount > 0;
  const semanticReuseIdentity = !budgetProofIsFreshnessIdentity
    && policyGenerationIsExplicit
    && largeContentHashConsumersPresent
    ? {
      status: "compatible" as const,
      budget_proof_is_freshness_identity: false as const,
      policy_generation_is_explicit: true as const,
      large_content_hash_consumers_present: true as const,
    }
    : {
      status: "incompatible" as const,
      diagnostic_code: "semantic_reuse_identity_incompatible" as const,
      budget_proof_is_freshness_identity: budgetProofIsFreshnessIdentity,
      policy_generation_is_explicit: policyGenerationIsExplicit,
      large_content_hash_consumers_present: largeContentHashConsumersPresent,
    };

  const checks = {
    executor_role: executorRole,
    shared_executor_mcp: sharedExecutorMcp,
    connection_integrity: connectionIntegrity,
    semantic_reuse_identity: semanticReuseIdentity,
  };
  return {
    status: Object.values(checks).every((check) => check.status === "compatible")
      ? "compatible" as const
      : "incompatible" as const,
    checks,
  };
}

export function automaticBuildProtocolDoctor(
  targetInput: string,
  rootDir: string,
  options: AutomaticBuildPlanOptions = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const attempts = AUTOMATIC_BUILD_STAGES.flatMap((stage) => listAutomaticBuildStoredAttempts(target, stage));
  const currentExecutionIdentities = attempts.filter(
    (attempt) => attempt.execution_identity?.identity_source === "native",
  ).length;
  const legacyInferredExecutionIdentities = attempts.filter(
    (attempt) => attempt.execution_identity?.identity_source === "legacy_inferred",
  ).length;
  const legacyAudit = auditAutomaticBuildLegacy(target, undefined, {
    inspect_current_descriptors: false,
  });
  const releaseContract = buildAutomaticBuildReleaseContractCheck(target.profile_id);
  const checkedExtractors: string[] = [];
  const resolvedDispatchPrompts: ResolvedAutomaticBuildExecutorPromptV1[] = [];
  let promptSource: AutomaticBuildPromptSource = process.env.UNDERSTAND_BOOK_SIDECAR_SELF
    ? "packaged_sidecar"
    : "node_source";
  let promptDiagnostic: AutomaticBuildExecutorPromptDiagnosticCode | undefined;
  for (const extractorName of AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES) {
    try {
      const dispatchPrompt = resolveAutomaticBuildExecutorPrompt(extractorName, "dispatch");
      const taskPrompt = resolveAutomaticBuildExecutorPrompt(extractorName, "task");
      if (dispatchPrompt.source !== taskPrompt.source) {
        throw new AutomaticBuildExecutorPromptResolutionError(
          "prompt_contract_invalid",
          dispatchPrompt.source,
        );
      }
      promptSource = dispatchPrompt.source;
      resolvedDispatchPrompts.push(dispatchPrompt);
      checkedExtractors.push(extractorName);
    } catch (error) {
      if (!(error instanceof AutomaticBuildExecutorPromptResolutionError)) throw error;
      promptSource = error.source;
      promptDiagnostic = error.diagnostic_code;
      break;
    }
  }
  let handoffByteLength: number | undefined;
  let handoffDiagnostic: AutomaticBuildExecutorPromptDiagnosticCode | "handoff_preparation_failed"
    | undefined = promptDiagnostic;
  if (!promptDiagnostic) {
    try {
      handoffByteLength = Math.max(...resolvedDispatchPrompts.map((resolvedPrompt, index) => (
        buildDispatchExecutorHandoffBytes(resolvedPrompt, {
          version: "automatic_build_dispatch_executor.v1",
          dispatch_run_id: `doctor-synthetic-${index}`,
          manifest_path: `in-memory://doctor/${index}/manifest.json`,
        }).byteLength
      )));
    } catch {
      handoffDiagnostic = "handoff_preparation_failed";
    }
  }
  let executorAgentTemplate = "";
  let executorAgentTemplatePresent = false;
  try {
    executorAgentTemplate = resolveBuildExecutorAgentTemplate();
    executorAgentTemplatePresent = true;
  } catch {
    executorAgentTemplate = "";
  }

  let boundaryProjections: {
    plugin_mcp_projections: string[];
    launcher_projections: string[];
  } = {
    plugin_mcp_projections: [],
    launcher_projections: [],
  };
  try {
    boundaryProjections = resolveBuildExecutorBoundaryProjections();
  } catch {
    // The shared Executor server is optional. Protocol doctor reports missing or
    // unreadable packaged boundary assets through the existing incompatible checks.
  }
  const boundary = validateAutomaticBuildProtocolDoctorBoundaryV3({
    agent_template: executorAgentTemplate,
    plugin_mcp_projections: boundaryProjections.plugin_mcp_projections,
    launcher_projections: boundaryProjections.launcher_projections,
    release_contract: releaseContract,
  });

  const thinPlugin = !existsSync(path.join(PLUGIN_ROOT, "agents"));
  const pluginShapeCompatible = (promptSource === "packaged_sidecar" || !thinPlugin)
    && executorAgentTemplatePresent;
  const checks = {
    release_contract: releaseContract,
    prompt_provider: {
      status: promptDiagnostic ? "incompatible" as const : "compatible" as const,
      source: promptSource,
      checked_extractors: checkedExtractors,
      ...(promptDiagnostic ? { diagnostic_code: promptDiagnostic } : {}),
    },
    handoff_preparation: {
      status: handoffDiagnostic ? "incompatible" as const : "compatible" as const,
      ...(handoffByteLength !== undefined ? { byte_length: handoffByteLength } : {}),
      ...(handoffDiagnostic ? { diagnostic_code: handoffDiagnostic } : {}),
    },
    plugin_shape: {
      status: pluginShapeCompatible ? "compatible" as const : "incompatible" as const,
      thin_plugin: thinPlugin,
      agents_required: false as const,
      agent_template_required: true as const,
      agent_template_present: executorAgentTemplatePresent,
      ...(!pluginShapeCompatible ? { diagnostic_code: "plugin_shape_incompatible" as const } : {}),
    },
    ...boundary.checks,
  };
  const doctorStatus = checks.release_contract.status === "compatible"
    && checks.prompt_provider.status === "compatible"
    && checks.handoff_preparation.status === "compatible"
    && checks.plugin_shape.status === "compatible"
    && boundary.status === "compatible"
    ? "compatible" as const
    : "incompatible" as const;
  return {
    version: "automatic_build_protocol_doctor.v3" as const,
    status: doctorStatus,
    checks,
    production_default: AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
    release: AUTOMATIC_BUILD_ACTIVE_RELEASE,
    routing_release: AUTOMATIC_BUILD_ROUTING_RELEASE,
    protocol_capabilities: [
      {
        protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
        readable: true,
        new_claims: true,
        resume: "dispatch_and_v3_task_state" as const,
      },
      {
        protocol: AUTOMATIC_BUILD_PROTOCOL_V2,
        readable: true,
        new_claims: false,
        resume: "explicit_task_executor_rollback" as const,
      },
      {
        protocol: AUTOMATIC_BUILD_ACTIVE_RELEASE.readable_protocols[2],
        readable: true,
        new_claims: false,
        resume: "explicit_legacy_migration_only" as const,
      },
    ],
    target_ref: target.target_ref,
    target_state: {
      persisted_task_attempts: attempts.length,
      current_execution_identities: currentExecutionIdentities,
      legacy_inferred_execution_identities: legacyInferredExecutionIdentities,
      artifact_policy_status: legacyAudit.policy_status,
      legacy_artifacts: legacyAudit.legacy_artifacts,
      v2_artifacts: legacyAudit.v2_artifacts,
      invalid_artifacts: legacyAudit.invalid_artifacts,
      dry_run_mutates_state: false as const,
    },
  };
}

export function automaticBuildDispatchNext(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: { now?: string; dispatch_run_id?: string; book_id?: string } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  const persisted = readAutomaticBuildDispatch(target, stage, dispatchId, options.dispatch_run_id);
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: persisted.manifest.policy_fingerprint.quality_profile,
  });
  const stageState = snapshot.stages.find((candidate) => candidate.stage === stage);
  if (!stageState?.work_units) throw new Error(`dispatch stage descriptor plan is unavailable: ${stage}/${dispatchId}`);
  const advanced = advanceAutomaticBuildDispatch(target, stage, dispatchId, {
    descriptors: stageState.work_units,
    task_bindings: stageState.task_bindings ?? {},
    dispatch_run_id: persisted.dispatch_run_id,
    ...(options.now ? { now: options.now } : {}),
    max_semantic_attempts: MAX_ATTEMPTS,
    max_lease_epochs: MAX_LEASE_EPOCHS,
  });
  const base = {
    version: "automatic_build_dispatch_next.v1" as const,
    protocol: AUTOMATIC_BUILD_EXECUTOR_DISPATCH_PROTOCOL_V1,
    dispatch_id: dispatchId,
    stage,
  };
  if (advanced.status === "finished") {
    return { ...base, action: { kind: "finished" as const, receipt: advanced.receipt } };
  }
  if (advanced.status === "ready_to_finish") {
    return {
      ...base,
      action: {
        kind: "finish" as const,
        task_receipts: advanced.task_receipts,
        finish_command: scriptCommand("automatic-build.ts", [
          "dispatch.finish", targetCommandInput(target), stage, dispatchId, ...targetResolutionCommandArgs(target),
          "--dispatch-run", persisted.dispatch_run_id,
        ]),
      },
    };
  }
  if (advanced.status === "waiting") {
    return {
      ...base,
      action: {
        kind: "waiting" as const,
        work_unit_id: advanced.work_unit_id,
        retry_after_ms: advanced.retry_after_ms,
      },
    };
  }
  if (advanced.status === "policy_generation_conflict"
    || advanced.status === "policy_generation_migration_required") {
    return {
      ...base,
      action: {
        kind: "waiting" as const,
        reason: advanced.status,
        work_unit_id: advanced.work_unit_id,
        retry_after_ms: Math.min(advanced.persisted.reserve_ttl_ms, 30_000),
      },
    };
  }
  if (advanced.status === "retry_exhausted" || advanced.status === "executor_instability") {
    const terminalReason = advanced.status === "retry_exhausted"
      ? "task_failure"
      : "executor_interrupted";
    return {
      ...base,
      action: {
        kind: "finish" as const,
        reason: advanced.status,
        work_unit_id: advanced.work_unit_id,
        finish_command: scriptCommand("automatic-build.ts", [
          "dispatch.finish", targetCommandInput(target), stage, dispatchId, ...targetResolutionCommandArgs(target),
          "--dispatch-run", persisted.dispatch_run_id, "--terminal-reason", terminalReason,
          ...(terminalReason === "executor_interrupted"
            ? [
              "--interruption-code", "executor_lost",
              "--interruption-reporter", "build_engine",
              "--interruption-command-role", "dispatch_next",
            ]
            : []),
        ]),
      },
    };
  }
  if (advanced.status !== "leased") throw new Error(`unhandled dispatch state: ${advanced.status}`);
  const claim = advanced.claim;
  const taskId = advanced.descriptor.work_unit_id;
  const leaseArgs = ["--lease-ref", claim.lease_ref, "--lease-token", claim.lease.token];
  const candidatePath = path.join(path.dirname(claim.lease_ref), "candidate.json");
  return {
    ...base,
    action: {
      kind: "task" as const,
      task: {
        task_id: taskId,
        attempt_number: claim.execution_identity.semantic_attempt,
        execution_identity: claim.execution_identity,
        lease_ref: claim.lease_ref,
        lease: claim.lease,
        descriptor: advanced.descriptor,
        candidate_path: candidatePath,
        usage_path: automaticBuildUsageReceiptPath(claim.lease_ref),
        input_command: scriptCommand("automatic-build.ts", [
          "input", targetCommandInput(target), stage, taskId,
          ...targetResolutionCommandArgs(target), "--run-ttl-ms", String(advanced.persisted.run_ttl_ms), ...leaseArgs,
        ]),
        candidate_command: scriptCommand("automatic-build.ts", [
          "candidate", targetCommandInput(target), stage, taskId, "{candidate_source}",
          ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        submit_command: scriptCommand("automatic-build.ts", [
          "submit", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        fail_command: scriptCommand("automatic-build.ts", [
          "fail", targetCommandInput(target), stage, taskId,
          "--diagnostic-code", "{diagnostic_code}", "--message", "{diagnostic}",
          ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        inspect_command: scriptCommand("automatic-build.ts", [
          "inspect", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
        heartbeat_command: scriptCommand("automatic-build.ts", [
          "heartbeat", targetCommandInput(target), stage, taskId, ...targetResolutionCommandArgs(target), ...leaseArgs,
        ]),
      },
    },
  };
}

export function automaticBuildDispatchInspect(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: { now?: string; dispatch_run_id?: string; book_id?: string } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  return inspectAutomaticBuildDispatch(target, stage, dispatchId, options.now, options.dispatch_run_id);
}

export function automaticBuildDispatchFinish(
  targetInput: string,
  rootDir: string,
  stage: AutomaticBuildStage,
  dispatchId: string,
  options: {
    terminal_reason?: AutomaticBuildExecutorDispatchReceiptV1["terminal_reason"];
    interruption?: AutomaticBuildExecutorInterruptionInputV1;
    now?: string;
    dispatch_run_id?: string;
    book_id?: string;
  } = {},
) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: options.book_id });
  return finishAutomaticBuildDispatch(target, stage, dispatchId, options);
}

function nonNegativeIntegerArg(argv: string[], name: string, fallback: number): number {
  const raw = valueArg(argv, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function budgetFromArgs(argv: string[]): AutomaticBuildBudgetLimitsV1 {
  return {
    version: "automatic_build_budget_limits.v1",
    max_tasks: nonNegativeIntegerArg(argv, "--max-tasks", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_tasks),
    max_total_score: nonNegativeIntegerArg(argv, "--max-total-score", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_total_score),
    max_estimated_total_tokens: nonNegativeIntegerArg(argv, "--max-estimated-total-tokens", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_estimated_total_tokens),
    max_batch_score: nonNegativeIntegerArg(argv, "--max-batch-score", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_batch_score),
    max_parallel_cost: nonNegativeIntegerArg(argv, "--max-parallel-cost", DEFAULT_AUTOMATIC_BUILD_BUDGET.max_parallel_cost),
  };
}

function wallBudgetFromArgs(argv: string[]): AutomaticBuildWallBudgetV1 | undefined {
  const maxWall = valueArg(argv, "--max-wall-clock-minutes");
  const maxStarts = valueArg(argv, "--max-agent-starts");
  const maxDuplicate = valueArg(argv, "--max-duplicate-lease-ratio");
  const onExceed = valueArg(argv, "--wall-budget-on-exceed");
  if (maxWall === undefined && maxStarts === undefined && maxDuplicate === undefined && onExceed === undefined) {
    return undefined;
  }
  const numeric = (raw: string | undefined, field: string): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
    return value;
  };
  if (onExceed !== undefined && !["needs_user", "stop"].includes(onExceed)) {
    throw new Error("--wall-budget-on-exceed must be needs_user|stop");
  }
  return {
    version: "automatic_build_wall_budget.v1",
    ...(maxWall !== undefined ? { max_wall_clock_minutes: numeric(maxWall, "--max-wall-clock-minutes")! } : {}),
    ...(maxStarts !== undefined ? { max_agent_starts: nonNegativeIntegerArg(argv, "--max-agent-starts", 0) } : {}),
    ...(maxDuplicate !== undefined
      ? { max_duplicate_lease_ratio: numeric(maxDuplicate, "--max-duplicate-lease-ratio")! }
      : {}),
    on_exceed: (onExceed ?? "needs_user") as AutomaticBuildWallBudgetV1["on_exceed"],
  };
}

function executorProvenanceFromArgs(argv: string[]): AutomaticBuildExecutorProvenanceV1 | undefined {
  const values = {
    model: valueArg(argv, "--executor-model"),
    reasoning_effort: valueArg(argv, "--executor-reasoning-effort"),
    harness_release: valueArg(argv, "--executor-harness-release"),
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3) throw new Error("executor provenance requires model, reasoning effort, and harness release together");
  return values as AutomaticBuildExecutorProvenanceV1;
}

function qualityProfileFromArgs(argv: string[]): ExtractionQualityProfile {
  const qualityProfile = valueArg(argv, "--quality-profile") ?? "full";
  if (!["full", "balanced", "sparse"].includes(qualityProfile)) {
    throw new Error(`--quality-profile must be full|balanced|sparse, received ${qualityProfile}`);
  }
  return qualityProfile as ExtractionQualityProfile;
}

function claimProtocolFromArgs(argv: string[]): AutomaticBuildClaimProtocol | undefined {
  const requested = valueArg(argv, "--protocol");
  const dispatchAlias = argv.includes("--executor-dispatches");
  if (requested === undefined && !dispatchAlias) return undefined;
  return resolveAutomaticBuildClaimProtocol(requested, dispatchAlias);
}

function buildPlanFromArgs(argv: string[]): BuildPlanV1 | undefined {
  const requested = valueArg(argv, "--build-plan");
  if (!requested) return undefined;
  const file = path.resolve(requested);
  return JSON.parse(readFileSync(file, "utf8")) as BuildPlanV1;
}

function pass2ChoiceFromArgs(argv: string[]): Pass2PlanChoice {
  const choice = valueArg(argv, "--pass2") ?? "enabled";
  if (choice !== "enabled" && choice !== "disabled") {
    throw new Error(`--pass2 must be enabled or disabled, got: ${choice}`);
  }
  return choice;
}

function resolveAutomaticBuildTargetFromArgs(
  targetInput: string,
  rootDir: string,
  argv: string[],
): AutomaticBuildTarget {
  return resolveAutomaticBuildTarget(targetInput, rootDir, { book_id: valueArg(argv, "--book-id") });
}

const argv = process.argv.slice(2);
if (argv[0] === "legacy-plan") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts legacy-plan <target> [--root <dir>] [--now <ISO timestamp>] [--pass2 enabled|disabled] [budget flags]");
    process.exit(2);
  }
  printAutomaticBuildJson(prepareExplicitLegacyBuildPlan(
    targetInput,
    path.resolve(valueArg(argv, "--root") ?? process.cwd()),
    {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--book-id") ? { book_id: valueArg(argv, "--book-id") } : {}),
      pass2: pass2ChoiceFromArgs(argv),
      budget: {
        ...(valueArg(argv, "--max-estimated-total-tokens")
          ? { max_total_tokens: Number(valueArg(argv, "--max-estimated-total-tokens")) }
          : {}),
        ...(valueArg(argv, "--max-wall-clock-minutes")
          ? { max_wall_clock_minutes: Number(valueArg(argv, "--max-wall-clock-minutes")) }
          : {}),
        on_exceed: "needs_user",
      },
    },
  ));
} else if (argv[0] === "protocol-doctor") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts protocol-doctor <target> [--root <dir>] [--max-parallel <n>] [--build-plan <confirmed-plan.json>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const requestedWorkers = Number(valueArg(argv, "--max-parallel") ?? "3");
  printAutomaticBuildJson(automaticBuildProtocolDoctor(targetInput, rootDir, {
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    requested_workers: requestedWorkers,
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", requestedWorkers),
    quality_profile: qualityProfileFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (argv[0] === "plan") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts plan <target> [--root <dir>] [--max-parallel <n>] [--build-plan <confirmed-plan.json>] [budget flags]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const requestedWorkers = Number(valueArg(argv, "--max-parallel") ?? "3");
  printAutomaticBuildJson(automaticBuildPlan(targetInput, rootDir, {
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    requested_workers: requestedWorkers,
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", requestedWorkers),
    quality_profile: qualityProfileFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (argv[0] === "next") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts next <target> [--root <dir>] [--max-parallel <n>] --build-plan <confirmed-plan.json>");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const maxParallel = Number(valueArg(argv, "--max-parallel") ?? "3");
  const leaseTtlMs = Number(valueArg(argv, "--lease-ttl-ms") ?? String(DEFAULT_RESERVE_TTL_MS));
  const runTtlMs = valueArg(argv, "--run-ttl-ms");
  const qualityProfile = qualityProfileFromArgs(argv);
  printAutomaticBuildJson(automaticBuildNext(targetInput, rootDir, maxParallel, {
    owner: valueArg(argv, "--owner"),
    now: valueArg(argv, "--now"),
    lease_ttl_ms: leaseTtlMs,
    ...(runTtlMs !== undefined ? { run_ttl_ms: Number(runTtlMs) } : {}),
    quality_profile: qualityProfile,
    budget: budgetFromArgs(argv),
    wall_budget: wallBudgetFromArgs(argv),
    executor_provenance: executorProvenanceFromArgs(argv),
    available_agent_slots: nonNegativeIntegerArg(argv, "--available-agent-slots", maxParallel),
    accepted_plan_digest: valueArg(argv, "--accepted-plan"),
    protocol: claimProtocolFromArgs(argv),
    build_plan: buildPlanFromArgs(argv),
    book_id: valueArg(argv, "--book-id"),
  }));
} else if (["dispatch.next", "dispatch.inspect", "dispatch.finish"].includes(argv[0] ?? "")) {
  const operation = argv[0];
  const [targetInput, stageValue, dispatchId] = argv.slice(1, 4);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage) || !dispatchId) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage> <dispatch-id> [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const stage = stageValue as AutomaticBuildStage;
  if (operation === "dispatch.next") {
    printAutomaticBuildJson(automaticBuildDispatchNext(targetInput, rootDir, stage, dispatchId, {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  } else if (operation === "dispatch.inspect") {
    printAutomaticBuildJson(automaticBuildDispatchInspect(targetInput, rootDir, stage, dispatchId, {
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  } else {
    const terminalReason = valueArg(argv, "--terminal-reason");
    if (terminalReason && !["complete", "task_failure", "executor_interrupted"].includes(terminalReason)) {
      throw new Error("--terminal-reason must be complete|task_failure|executor_interrupted");
    }
    const interruptionCode = valueArg(argv, "--interruption-code");
    const interruptionReporter = valueArg(argv, "--interruption-reporter");
    const interruptionCommandRole = valueArg(argv, "--interruption-command-role");
    const interruption = interruptionCode || interruptionReporter || interruptionCommandRole
      ? {
          diagnostic_code: (interruptionCode ?? "") as AutomaticBuildExecutorInterruptionInputV1["diagnostic_code"],
          reporter: (interruptionReporter ?? "") as AutomaticBuildExecutorInterruptionInputV1["reporter"],
          last_command_role: (interruptionCommandRole ?? "") as AutomaticBuildExecutorInterruptionInputV1["last_command_role"],
        }
      : undefined;
    printAutomaticBuildJson(automaticBuildDispatchFinish(targetInput, rootDir, stage, dispatchId, {
      ...(terminalReason
        ? { terminal_reason: terminalReason as AutomaticBuildExecutorDispatchReceiptV1["terminal_reason"] }
        : {}),
      ...(interruption ? { interruption } : {}),
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
      ...(valueArg(argv, "--dispatch-run") ? { dispatch_run_id: valueArg(argv, "--dispatch-run") } : {}),
      book_id: valueArg(argv, "--book-id"),
    }));
  }
} else if (argv[0] === "audit-legacy") {
  const targetInput = argv[1];
  const stageValue = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
  if (!targetInput || (stageValue && !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage))) {
    console.error("usage: tsx skills/build/automatic-build.ts audit-legacy <target> [stage] [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  printAutomaticBuildJson(auditAutomaticBuildLegacy(target, stageValue as AutomaticBuildStage | undefined));
} else if (argv[0] === "migration-mode") {
  const [targetInput, modeValue] = argv.slice(1, 3);
  if (!targetInput || !["legacy_resume", "v2_rebuild"].includes(modeValue ?? "")) {
    console.error("usage: tsx skills/build/automatic-build.ts migration-mode <target> <legacy_resume|v2_rebuild> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  printAutomaticBuildJson(selectAutomaticBuildMigrationMode(
    target,
    modeValue as AutomaticBuildMigrationMode,
    valueArg(argv, "--now"),
  ));
} else if (argv[0] === "quality") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || stageValue === "paper_reading_guide") {
    console.error("usage: tsx skills/build/automatic-build.ts quality <target> <semantic-stage> [--root <dir>] [--quality-profile <profile>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
  const stageState = snapshot.stages.find((stage) => stage.stage === stageValue);
  if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stageValue}`);
  printAutomaticBuildJson(collectAutomaticBuildStageQuality(target, stageState, qualityProfileFromArgs(argv)));
} else if (argv[0] === "remaining-work") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts remaining-work <target> [--root <dir>] [--quality-profile <profile>] [--now <iso>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  printAutomaticBuildJson(automaticBuildRemainingWork(targetInput, rootDir, {
    ...(valueArg(argv, "--book-id") ? { book_id: valueArg(argv, "--book-id") } : {}),
    quality_profile: qualityProfileFromArgs(argv),
    ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
  }));
} else if (argv[0] === "metrics") {
  const [targetInput, stageValue] = argv.slice(1, 3);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)) {
    console.error("usage: tsx skills/build/automatic-build.ts metrics <target> <stage> [--root <dir>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const metricsSnapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
  const metricsStage = metricsSnapshot.stages.find((stage) => stage.stage === stageValue);
  printAutomaticBuildJson(writeAutomaticBuildStageMetricsSummary(
    target,
    stageValue as AutomaticBuildStage,
    { work_units: metricsStage?.work_units ?? [] },
  ));
} else if (argv[0] === "record-attempt") {
  const [targetInput, stageValue, taskId, outcomeValue] = argv.slice(1, 5);
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage) || !taskId
    || !["failure", "success", "reset"].includes(outcomeValue)) {
    console.error("usage: tsx skills/build/automatic-build.ts record-attempt <target> <stage> <task> <failure|success|reset> [--root <dir>] [--message <text>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const attemptValue = valueArg(argv, "--attempt");
  const attempt = attemptValue === undefined ? undefined : Number(attemptValue);
  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
    console.error(`--attempt must be a positive integer, received ${attemptValue}`);
    process.exit(2);
  }
  const record = recordAutomaticBuildAttempt(
    target,
    stageValue as AutomaticBuildStage,
    taskId,
    outcomeValue as "failure" | "success" | "reset",
    valueArg(argv, "--message"),
    {
      ...(attempt === undefined ? {} : { attempt }),
      ...(valueArg(argv, "--event-id") ? { event_id: valueArg(argv, "--event-id") } : {}),
      ...(valueArg(argv, "--lease-ref") ? { lease_ref: valueArg(argv, "--lease-ref") } : {}),
      ...(valueArg(argv, "--lease-token") ? { lease_token: valueArg(argv, "--lease-token") } : {}),
      ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
    },
  );
  printAutomaticBuildJson({ version: "automatic_build_attempt_record.v1", stage: stageValue, task_id: taskId, record });
} else if (argv[0] === "heartbeat") {
  const [targetInput, stageValue, taskId] = argv.slice(1, 4);
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || !taskId || !leaseRef || !leaseToken) {
    console.error("usage: tsx skills/build/automatic-build.ts heartbeat <target> <stage> <task> --lease-ref <path> --lease-token <token> [--root <dir>] [--ttl-ms <n>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const heartbeat = heartbeatAutomaticBuildLease(target, leaseRef, leaseToken, {
    ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
    ...(valueArg(argv, "--ttl-ms") ? { ttl_ms: Number(valueArg(argv, "--ttl-ms")) } : {}),
  });
  printAutomaticBuildJson({ version: "automatic_build_heartbeat_receipt.v1", stage: stageValue, task_id: taskId, heartbeat });
} else if (["candidate", "submit", "legacy-submit", "fail", "inspect"].includes(argv[0] ?? "")) {
  const operation = argv[0];
  const [targetInput, stageValue, taskId] = argv.slice(1, 4);
  const sourceCandidate = operation === "candidate" || operation === "legacy-submit" ? argv[4] : undefined;
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  if (!targetInput || !AUTOMATIC_BUILD_STAGES.includes(stageValue as AutomaticBuildStage)
    || !taskId || !leaseRef || !leaseToken
    || ((operation === "candidate" || operation === "legacy-submit") && !sourceCandidate)) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage> <task>${sourceCandidate === undefined ? "" : " <candidate-source>"} --lease-ref <path> --lease-token <token> [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const stage = stageValue as AutomaticBuildStage;
  const now = valueArg(argv, "--now");
  if (operation === "candidate") {
    printAutomaticBuildJson(stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, {
      ...(now ? { now } : {}),
    }));
  } else if (operation === "submit" || operation === "legacy-submit") {
    if (operation === "legacy-submit") {
      stageAutomaticBuildCandidate(target, leaseRef, leaseToken, sourceCandidate!, { ...(now ? { now } : {}) });
    }
    printAutomaticBuildJson(submitAutomaticBuildTaskCandidate(
      target,
      stage,
      taskId,
      leaseRef,
      leaseToken,
      { ...(now ? { now } : {}) },
    ));
  } else if (operation === "fail") {
    const diagnosticCode = valueArg(argv, "--diagnostic-code");
    if (!diagnosticCode) throw new Error("fail requires --diagnostic-code");
    printAutomaticBuildJson(failAutomaticBuildTask(target, leaseRef, leaseToken, {
      diagnostic_code: diagnosticCode,
      ...(valueArg(argv, "--message") ? { message: valueArg(argv, "--message") } : {}),
      ...(now ? { now } : {}),
    }));
  } else {
    printAutomaticBuildJson(inspectAutomaticBuildTask(target, leaseRef, leaseToken));
  }
} else if (argv[0] === "input" || argv[0] === "write" || argv[0] === "close") {
  const operation = argv[0];
  const targetInput = argv[1];
  const stageValue = argv[2] as AutomaticBuildStage | undefined;
  const taskId = operation === "close" ? undefined : argv[3];
  const outputJson = operation === "write" ? argv[4] : undefined;
  if (!targetInput || !stageValue || !AUTOMATIC_BUILD_STAGES.includes(stageValue)
    || (operation !== "close" && !taskId) || (operation === "write" && !outputJson)) {
    console.error(`usage: tsx skills/build/automatic-build.ts ${operation} <target> <stage>${operation === "close" ? "" : " <task>"}${operation === "write" ? " <output_json>" : ""} [--root <dir>]`);
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTargetFromArgs(targetInput, rootDir, argv);
  const leaseRef = valueArg(argv, "--lease-ref");
  const leaseToken = valueArg(argv, "--lease-token");
  let productionGenerationId: string | undefined;
  let closeProductionPolicyContracts: string | undefined;
  if (Boolean(leaseRef) !== Boolean(leaseToken)) throw new Error("lease_ref and lease_token must be provided together");
  if (leaseRef && leaseToken && operation === "write") {
    const leaseState = assertActiveAutomaticBuildLease(target, leaseRef, leaseToken, valueArg(argv, "--now"));
    if (leaseState.stage !== stageValue || leaseState.work_unit_id !== taskId) {
      throw new Error(`stage command does not match lease identity: ${stageValue}/${taskId}`);
    }
    if (leaseState.policy_generation_id) {
      const generationTaskPath = stageValue === "pass1"
        ? pass1ShadowTaskPath(target, leaseState.policy_generation_id, taskId!)
        : stageValue === "profile_sidecar"
          ? profileSidecarDiscourseShadowTaskPath(target, leaseState.policy_generation_id, taskId!)
          : stageValue === "book_structure"
            ? bookStructureGenerationTaskPath(target, leaseState.policy_generation_id, taskId!)
            : undefined;
      if (!generationTaskPath || !existsSync(generationTaskPath)) {
        throw new Error(`policy_generation_conflict: frozen production generation task is unavailable: ${stageValue}/${taskId}`);
      }
      productionGenerationId = leaseState.policy_generation_id;
    }
  }
  let verifiedClose = false;
  if (operation === "close" && stageValue === "paper_reading_guide") {
    const verification = forwardStageScript(
      target,
      "verify-paper-reading-guide.ts",
      [target.workspace_dir],
      true,
    );
    if (verification.stdout) process.stderr.write(verification.stdout);
    if (verification.stderr) process.stderr.write(verification.stderr);
    const result = verifyAutomaticBuildStageClose(target);
    printAutomaticBuildJson(result);
    verifiedClose = result.version === "automatic_build_stage_verification_result.v1";
    if (!verifiedClose) process.exitCode = 1;
  } else {
    const spec = STAGE_COMMANDS[stageValue];
    const script = operation === "close" ? spec.close : operation === "input" ? spec.input : spec.write;
    if (!script) throw new Error(`stage ${stageValue} does not support ${operation}`);
    if (operation === "close") {
      const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
      const stageState = snapshot.stages.find((stage) => stage.stage === stageValue);
      if (!stageState) throw new Error(`quality stage is not reachable in the current snapshot: ${stageValue}`);
      if (stageState.policy_set) {
        if (stageValue !== "pass1"
          && stageValue !== "profile_sidecar"
          && stageValue !== "book_structure") {
          throw new Error(`proof-bound production close is not supported for stage ${stageValue}`);
        }
        closeProductionPolicyContracts = JSON.stringify(policyContractsForStage(stageState.policy_set));
      }
    }
    const args = operation === "close"
      ? stageScriptArgs(target)
      : operation === "input"
        ? [target.source_path, taskId!, ...stageScriptArgs(target).slice(1)]
        : [target.source_path, taskId!, outputJson!, ...stageScriptArgs(target).slice(1)];
    if (productionGenerationId && operation !== "close") {
      args.push("--shadow-generation", productionGenerationId);
    }
    if (closeProductionPolicyContracts && operation === "close") {
      args.push(
        "--production-policy-contracts", closeProductionPolicyContracts,
        "--quality-profile", qualityProfileFromArgs(argv),
      );
    }
    if (operation === "close" && stageValue === "pass1" && target.kind === "paper_workspace") {
      args.push("--preserve-foundation", target.workspace_dir);
    }
    if (operation === "close") {
      const outcome = closeAutomaticBuildStage({
        target,
        stage: stageValue as AutomaticBuildPublicationStage,
        quality_profile: qualityProfileFromArgs(argv),
        run_batch: () => {
          const batch = forwardStageScript(target, script, args, true);
          if (batch.stderr) process.stderr.write(batch.stderr);
          return batch;
        },
      });
      printAutomaticBuildJson(outcome);
      verifiedClose = outcome.version === "automatic_build_stage_close_result.v2";
      if (!verifiedClose) process.exitCode = 1;
    } else if (operation === "input" && leaseRef && leaseToken) {
      const result = runAutomaticBuildTaskInput(target, stageValue, taskId!, leaseRef, leaseToken, {
        ...(valueArg(argv, "--now") ? { now: valueArg(argv, "--now") } : {}),
        run_ttl_ms: Number(valueArg(argv, "--run-ttl-ms") ?? String(DEFAULT_RUN_TTL_MS)),
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    } else {
      forwardStageScript(target, script, args);
    }
  }
  if (operation === "close" && verifiedClose) {
    const metricsSnapshot = buildAutomaticBuildSnapshot(target, { quality_profile: qualityProfileFromArgs(argv) });
    const metricsStage = metricsSnapshot.stages.find((stage) => stage.stage === stageValue);
    writeAutomaticBuildStageMetricsSummary(target, stageValue, { work_units: metricsStage?.work_units ?? [] });
  }
}
