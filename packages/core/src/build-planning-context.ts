import { createHash } from "node:crypto";
import { z } from "zod";
import { type ArtifactShape } from "./artifact-blueprint";
import {
  BuildIntentPlannerCandidateV2Z,
  type BuildIntentPlannerCandidateV2,
  type CodexBuildIntentPlanV1,
  type CodexBuildIntentPlanV2,
} from "./build-intent-controller";
import { canonicalBuildJson } from "./build-intent";

export const BUILD_PLANNING_SCOPE_SAMPLE_LIMIT = 128;
export const BUILD_PLANNING_BLUEPRINT_SAMPLE_LIMIT = 128;
export const BUILD_PLANNING_MAX_ARTIFACTS = 16;
export const BUILD_PLANNING_RESULT_MAX_BYTES = 64 * 1024;

const PathSafeIdZ = z.string().min(1).max(128).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u);
const Sha256Z = z.string().regex(/^[a-f0-9]{64}$/u);
const LidZ = z.string().max(128).regex(/^\d+(?:\.\d+)*$/u);
const SectionZ = z.string().trim().min(1).max(256);
const ShapeZ = z.enum(["collection", "table", "graph", "sequence", "document"]);

export const ArtifactBlueprintPlannerSummaryV1Z = z.object({
  source: z.enum(["system", "user_private"]),
  blueprint_id: PathSafeIdZ,
  blueprint_version: PathSafeIdZ,
  digest: Sha256Z,
  title: z.string().trim().min(1).max(256),
  purpose: z.string().trim().min(1).max(1_024),
  shape: ShapeZ,
  key_fields: z.array(z.string().trim().min(1).max(128)).max(64),
}).strict().superRefine((summary, context) => {
  if (new Set(summary.key_fields).size !== summary.key_fields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["key_fields"], message: "key_fields must be unique" });
  }
});

export type ArtifactBlueprintPlannerSummaryV1 = z.infer<typeof ArtifactBlueprintPlannerSummaryV1Z>;

const BuildPlanningCandidateContractV1Z = z.object({
  version: z.literal("build_intent_planner_candidate.v2"),
  max_artifacts: z.literal(BUILD_PLANNING_MAX_ARTIFACTS),
  allowed_shapes: z.tuple([
    z.literal("collection"),
    z.literal("table"),
    z.literal("graph"),
    z.literal("sequence"),
    z.literal("document"),
  ]),
  one_off_blueprint_version: z.literal("artifact_blueprint.v1"),
}).strict();

const BuildPlanningContextBodyBaseV1Z = z.object({
  version: z.literal("build_planning_context.v1"),
  target: z.object({
    book_id: PathSafeIdZ,
    source_fingerprint: Sha256Z,
    content_profile: z.enum(["technical_learning", "paper"]),
  }).strict(),
  scope_catalog: z.object({
    available_lids: z.array(LidZ).max(BUILD_PLANNING_SCOPE_SAMPLE_LIMIT),
    available_lid_count: z.number().int().nonnegative(),
    available_sections: z.array(SectionZ).max(BUILD_PLANNING_SCOPE_SAMPLE_LIMIT),
    available_section_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    whole_book_allowed: z.literal(true),
  }).strict(),
  blueprint_registry: z.array(ArtifactBlueprintPlannerSummaryV1Z).max(BUILD_PLANNING_BLUEPRINT_SAMPLE_LIMIT),
  blueprint_registry_count: z.number().int().nonnegative(),
  blueprint_registry_truncated: z.boolean(),
  candidate_contract: BuildPlanningCandidateContractV1Z,
}).strict();

function refineBuildPlanningContextBody(
  body: z.infer<typeof BuildPlanningContextBodyBaseV1Z>,
  context: z.RefinementCtx,
): void {
  const scope = body.scope_catalog;
  if (scope.available_lid_count < scope.available_lids.length
    || scope.available_section_count < scope.available_sections.length
    || scope.truncated !== (
      scope.available_lid_count > scope.available_lids.length
      || scope.available_section_count > scope.available_sections.length
    )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope_catalog"], message: "scope catalog counts and truncation disagree" });
  }
  if (new Set(scope.available_lids).size !== scope.available_lids.length
    || new Set(scope.available_sections).size !== scope.available_sections.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope_catalog"], message: "scope catalog samples must be unique" });
  }
  if (body.blueprint_registry_count < body.blueprint_registry.length
    || body.blueprint_registry_truncated !== (body.blueprint_registry_count > body.blueprint_registry.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blueprint_registry"], message: "Blueprint Registry count and truncation disagree" });
  }
  const identities = body.blueprint_registry.map((entry) => (
    `${entry.source}\u0000${entry.blueprint_id}\u0000${entry.blueprint_version}`
  ));
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blueprint_registry"], message: "Blueprint Registry identities must be unique" });
  }
}

const BuildPlanningContextBodyV1Z = BuildPlanningContextBodyBaseV1Z.superRefine(
  refineBuildPlanningContextBody,
);

export const BuildPlanningContextV1Z = BuildPlanningContextBodyBaseV1Z.extend({
  context_digest: Sha256Z,
}).strict().superRefine(refineBuildPlanningContextBody);

export type BuildPlanningContextV1 = z.infer<typeof BuildPlanningContextV1Z>;

export interface BuildPlanningContextInputV1 {
  target: BuildPlanningContextV1["target"];
  available_lids: string[];
  available_sections: string[];
  blueprint_registry: ArtifactBlueprintPlannerSummaryV1[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicSample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor(index * (values.length - 1) / (limit - 1))]
  ));
}

function canonicalBlueprintRegistry(
  input: readonly ArtifactBlueprintPlannerSummaryV1[],
): ArtifactBlueprintPlannerSummaryV1[] {
  return input.map((value) => ArtifactBlueprintPlannerSummaryV1Z.parse({
    ...value,
    key_fields: [...value.key_fields].sort(),
  })).sort((left, right) => canonicalBuildJson([
    left.source, left.blueprint_id, left.blueprint_version, left.digest,
  ]).localeCompare(canonicalBuildJson([
    right.source, right.blueprint_id, right.blueprint_version, right.digest,
  ]), "en"));
}

export function computeBuildPlanningContextDigest(
  input: Omit<BuildPlanningContextV1, "context_digest">,
): string {
  return sha256(canonicalBuildJson(BuildPlanningContextBodyV1Z.parse(input)));
}

export function buildPlanningContextV1(input: BuildPlanningContextInputV1): BuildPlanningContextV1 {
  const availableLids = z.array(LidZ).parse(input.available_lids);
  const availableSections = z.array(SectionZ).parse(input.available_sections);
  if (new Set(availableLids).size !== availableLids.length
    || new Set(availableSections).size !== availableSections.length) {
    throw new Error("planning scope catalogs must contain unique values");
  }
  const registry = canonicalBlueprintRegistry(input.blueprint_registry);
  const registryIdentities = registry.map((entry) => `${entry.source}\u0000${entry.blueprint_id}\u0000${entry.blueprint_version}`);
  if (new Set(registryIdentities).size !== registryIdentities.length) {
    throw new Error("Blueprint Registry summaries contain duplicate identities");
  }
  const body = BuildPlanningContextBodyV1Z.parse({
    version: "build_planning_context.v1",
    target: input.target,
    scope_catalog: {
      available_lids: deterministicSample(availableLids, BUILD_PLANNING_SCOPE_SAMPLE_LIMIT),
      available_lid_count: availableLids.length,
      available_sections: deterministicSample(availableSections, BUILD_PLANNING_SCOPE_SAMPLE_LIMIT),
      available_section_count: availableSections.length,
      truncated: availableLids.length > BUILD_PLANNING_SCOPE_SAMPLE_LIMIT
        || availableSections.length > BUILD_PLANNING_SCOPE_SAMPLE_LIMIT,
      whole_book_allowed: true,
    },
    blueprint_registry: deterministicSample(registry, BUILD_PLANNING_BLUEPRINT_SAMPLE_LIMIT),
    blueprint_registry_count: registry.length,
    blueprint_registry_truncated: registry.length > BUILD_PLANNING_BLUEPRINT_SAMPLE_LIMIT,
    candidate_contract: {
      version: "build_intent_planner_candidate.v2",
      max_artifacts: BUILD_PLANNING_MAX_ARTIFACTS,
      allowed_shapes: ["collection", "table", "graph", "sequence", "document"],
      one_off_blueprint_version: "artifact_blueprint.v1",
    },
  });
  return BuildPlanningContextV1Z.parse({
    ...body,
    context_digest: computeBuildPlanningContextDigest(body),
  });
}

export function validateBuildPlanningContextV1(input: unknown): BuildPlanningContextV1 {
  const context = BuildPlanningContextV1Z.parse(input);
  const { context_digest, ...body } = context;
  if (computeBuildPlanningContextDigest(body) !== context_digest) {
    throw new Error("BuildPlanningContext digest does not match its canonical body");
  }
  return context;
}

const EmptyInputZ = z.object({}).strict();
const TargetZ = z.object({ workspace_dir: z.string().min(1).max(32_768) }).strict();
const PlanIdInputZ = z.object({ plan_id: PathSafeIdZ }).strict();
const CodexCommandV2Z = z.discriminatedUnion("operation", [
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("planning.context"), target: TargetZ, input: EmptyInputZ }).strict(),
  z.object({
    version: z.literal("codex_build_intent_command.v2"),
    operation: z.literal("draft.candidate"),
    target: TargetZ,
    input: z.object({
      user_goal: z.string().trim().min(1).max(4_096),
      planning_context_digest: Sha256Z,
      candidate: BuildIntentPlannerCandidateV2Z,
      budget: z.unknown().optional(),
    }).strict(),
  }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("status"), target: TargetZ, input: z.object({ plan_id: PathSafeIdZ.optional() }).strict() }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("confirm"), target: TargetZ, input: z.object({ plan_id: PathSafeIdZ, plan_digest: Sha256Z }).strict() }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("reject"), target: TargetZ, input: PlanIdInputZ }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("artifact.prepare"), target: TargetZ, input: PlanIdInputZ }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("artifact.submit"), target: TargetZ, input: z.object({ task_path: z.string().min(1).max(32_768) }).strict() }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("artifact.inspect"), target: TargetZ, input: z.object({ task_path: z.string().min(1).max(32_768) }).strict() }).strict(),
  z.object({ version: z.literal("codex_build_intent_command.v2"), operation: z.literal("artifact.fail"), target: TargetZ, input: z.object({ task_path: z.string().min(1).max(32_768), diagnostic_code: PathSafeIdZ, message: z.string().max(1_024).optional() }).strict() }).strict(),
]);

export type CodexBuildIntentCommandV2 = z.infer<typeof CodexCommandV2Z>;

export function validateCodexBuildIntentCommandV2(input: unknown): CodexBuildIntentCommandV2 {
  return CodexCommandV2Z.parse(input);
}

export type CodexBuildIntentResponseV1 = CodexBuildIntentPlanV1 | CodexBuildIntentPlanV2;
export type IntentArtifactResponseV1 = Record<string, unknown> & { version: string };

export type CodexBuildIntentResultV2 =
  | {
      version: "codex_build_intent_result.v2";
      status: "ok";
      response: BuildPlanningContextV1 | CodexBuildIntentResponseV1 | IntentArtifactResponseV1;
    }
  | {
      version: "codex_build_intent_result.v2";
      status: "error";
      error: {
        error_code: string;
        category: string;
        phase: "request" | "context" | "candidate" | "blueprint" | "compile" | "store" | "artifact";
        retryable: boolean;
        message: string;
      };
    };

export type CodexBuildIntentFailurePhase =
  | "request"
  | "context"
  | "candidate"
  | "blueprint"
  | "compile"
  | "store"
  | "artifact";

const ErrorResultZ = z.object({
  version: z.literal("codex_build_intent_result.v2"),
  status: z.literal("error"),
  error: z.object({
    error_code: PathSafeIdZ,
    category: PathSafeIdZ,
    phase: z.enum(["request", "context", "candidate", "blueprint", "compile", "store", "artifact"]),
    retryable: z.boolean(),
    message: z.string().max(1_024),
  }).strict(),
}).strict();

export function validateCodexBuildIntentResultV2(input: unknown): CodexBuildIntentResultV2 {
  if (input && typeof input === "object" && !Array.isArray(input) && (input as { status?: unknown }).status === "error") {
    return ErrorResultZ.parse(input);
  }
  const parsed = z.object({
    version: z.literal("codex_build_intent_result.v2"),
    status: z.literal("ok"),
    response: z.object({ version: z.string().min(1).max(128) }).passthrough(),
  }).strict().parse(input) as Extract<CodexBuildIntentResultV2, { status: "ok" }>;
  if (Buffer.byteLength(canonicalBuildJson(parsed), "utf8") > BUILD_PLANNING_RESULT_MAX_BYTES) {
    throw new Error("Codex build-intent result exceeds its bounded response budget");
  }
  if ((parsed.response as { version?: string }).version === "build_planning_context.v1") {
    validateBuildPlanningContextV1(parsed.response);
  }
  return parsed;
}

export function createCodexBuildIntentErrorResultV2(input: {
  error_code: string;
  category: string;
  phase: CodexBuildIntentFailurePhase;
  retryable: boolean;
  message: string;
  sensitive_values?: readonly string[];
}): CodexBuildIntentResultV2 {
  let message = input.message.replace(/[\r\n\t]+/gu, " ");
  for (const sensitive of input.sensitive_values ?? []) {
    if (sensitive) message = message.split(sensitive).join("[REDACTED]");
  }
  if (message.length > 1_024) message = `${message.slice(0, 1_011)} [TRUNCATED]`;
  return ErrorResultZ.parse({
    version: "codex_build_intent_result.v2",
    status: "error",
    error: {
      error_code: input.error_code,
      category: input.category,
      phase: input.phase,
      retryable: input.retryable,
      message,
    },
  });
}

export const BUILD_PLANNING_ALLOWED_SHAPES: readonly ArtifactShape[] = [
  "collection", "table", "graph", "sequence", "document",
];
