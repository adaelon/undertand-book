import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalBuildJson, type BuildPlanV1 } from "./build-intent";
import type { BuildPlanV3 } from "./build-intent-v2";

const NonBlankZ = z.string().trim().min(1);
const PathSafeIdZ = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u);
const IsoTimestampZ = z.string().datetime({ offset: true });
const NonNegativeIntegerZ = z.number().int().safe().nonnegative();
const NonNegativeNumberZ = z.number().finite().nonnegative();
const ModeZ = z.enum(["read_now", "standard_deep", "goal_directed"]);
const ArtifactTypeZ = z.enum(["timeline", "concept_map", "comparison_table", "argument_map"]);
const MAX_USAGE_EVENT_BYTES = 32 * 1024;
const MAX_USAGE_EVENTS = 100_000;

const PlanRefZ = z.object({
  plan_id: PathSafeIdZ,
  plan_revision: z.number().int().safe().positive(),
  confirmation_source: z.enum(["reader_ui", "codex_conversation", "explicit_legacy_command"]),
  intent_id: PathSafeIdZ.optional(),
}).strict();

type BuildPlanForUsage = BuildPlanV1 | BuildPlanV3;

const ArtifactRefZ = z.object({
  artifact_id: PathSafeIdZ,
  artifact_type: ArtifactTypeZ,
}).strict();

const EstimateSnapshotZ = z.object({
  token_lower: NonNegativeIntegerZ,
  token_upper: NonNegativeIntegerZ,
  token_coverage: z.number().finite().min(0).max(1),
  wall_clock_p50_minutes: NonNegativeNumberZ.optional(),
  wall_clock_p95_minutes: NonNegativeNumberZ.optional(),
  wall_clock_confidence: z.enum(["none", "low", "medium", "high"]),
  unknown_item_count: NonNegativeIntegerZ,
}).strict().superRefine((estimate, context) => {
  if (estimate.token_lower > estimate.token_upper) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "estimate token lower exceeds upper" });
  }
  if ((estimate.wall_clock_p50_minutes ?? 0) > (estimate.wall_clock_p95_minutes ?? Number.POSITIVE_INFINITY)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "estimate wall-clock p50 exceeds p95" });
  }
});

const UsageZ = z.object({
  source: z.enum(["native", "executor_reported", "unavailable"]),
  input_tokens: NonNegativeIntegerZ.optional(),
  cached_input_tokens: NonNegativeIntegerZ.optional(),
  output_tokens: NonNegativeIntegerZ.optional(),
  estimate_method: NonBlankZ.optional(),
  estimated_input_tokens: NonNegativeIntegerZ.optional(),
  estimated_output_tokens: NonNegativeIntegerZ.optional(),
}).strict().superRefine((usage, context) => {
  const exact = usage.input_tokens !== undefined
    || usage.cached_input_tokens !== undefined
    || usage.output_tokens !== undefined;
  if (usage.source === "unavailable" && exact) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable usage cannot contain exact tokens" });
  }
  if (usage.source !== "unavailable" && !exact) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "known usage requires exact token data" });
  }
  const estimateFields = usage.estimate_method !== undefined
    || usage.estimated_input_tokens !== undefined
    || usage.estimated_output_tokens !== undefined;
  if (estimateFields && (usage.estimate_method === undefined
    || usage.estimated_input_tokens === undefined
    || usage.estimated_output_tokens === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "usage estimate fields must be complete" });
  }
});

const BaseShape = {
  version: z.literal("intent_build_usage_event.v1"),
  event_id: PathSafeIdZ,
  book_id: PathSafeIdZ,
  mode: ModeZ,
  occurred_at: IsoTimestampZ,
};

export const IntentBuildUsageEventV1Z = z.discriminatedUnion("kind", [
  z.object({
    ...BaseShape,
    kind: z.literal("plan_selected"),
    plan: PlanRefZ.nullable(),
    estimate: EstimateSnapshotZ.nullable(),
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal("reader_ready"),
    plan: PlanRefZ.nullable(),
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal("cost_observed"),
    plan: PlanRefZ.nullable(),
    artifact: ArtifactRefZ.optional(),
    attempt_id: PathSafeIdZ,
    outcome: z.enum(["committed", "retryable_failure", "needs_user", "cancelled"]),
    wall_clock_ms: NonNegativeIntegerZ,
    usage: UsageZ,
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal("artifact_accepted"),
    plan: PlanRefZ,
    artifact: ArtifactRefZ,
    record_count: NonNegativeIntegerZ,
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal("artifact_opened"),
    plan: PlanRefZ,
    artifact: ArtifactRefZ,
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal("artifact_cited"),
    plan: PlanRefZ,
    artifact: ArtifactRefZ,
    citation_count: z.number().int().safe().positive(),
  }).strict(),
]).superRefine((event, context) => {
  const plan = "plan" in event ? event.plan : null;
  if (event.mode === "read_now" && plan !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "read_now events cannot bind a BuildPlan" });
  }
  if (event.mode !== "read_now" && plan === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${event.mode} events require a BuildPlan` });
  }
  if (event.kind === "plan_selected" && ((event.plan === null) !== (event.estimate === null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "plan and estimate must both be null or present" });
  }
  if ("artifact" in event && event.artifact !== undefined && event.mode !== "goal_directed") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact usage belongs only to goal_directed mode" });
  }
  if (plan?.intent_id !== undefined && event.mode !== "goal_directed") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "only goal_directed plans can bind an intent" });
  }
  if (event.mode === "goal_directed" && plan && !plan.intent_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "goal_directed plan usage requires intent_id" });
  }
});

export type IntentBuildUsageEventV1 = z.infer<typeof IntentBuildUsageEventV1Z>;
export type IntentBuildMode = z.infer<typeof ModeZ>;

export interface IntentBuildModeAblationV1 {
  mode: IntentBuildMode;
  selection_count: number;
  plan_revisions: Array<z.infer<typeof PlanRefZ>>;
  estimate: {
    token_lower: number;
    token_upper: number;
    unknown_item_count: number;
  };
  actual: {
    attempt_count: number;
    outcome_counts: Record<"committed" | "retryable_failure" | "needs_user" | "cancelled", number>;
    known_usage_attempts: number;
    unavailable_usage_attempts: number;
    known_usage_coverage: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    estimated_input_tokens: number;
    estimated_output_tokens: number;
    wall_clock_ms: number;
  };
  timing: {
    first_readable_ms: number | null;
    first_goal_artifact_ms: number | null;
  };
  consumption_7d: {
    accepted_artifacts: number;
    opened_artifacts: number;
    cited_artifacts: number;
    open_rate: number | null;
    citation_rate: number | null;
    open_events: number;
    citation_events: number;
  };
  artifact_costs: Array<{
    artifact_type: z.infer<typeof ArtifactTypeZ>;
    attempt_count: number;
    committed_attempts: number;
    failed_or_cancelled_attempts: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    wall_clock_ms: number;
  }>;
}

export interface IntentBuildAblationReportV1 {
  version: "intent_build_ablation_report.v1";
  book_id: string;
  as_of: string;
  window_days: number;
  event_count: number;
  modes: IntentBuildModeAblationV1[];
  privacy: {
    raw_goal: false;
    artifact_body: false;
    lid_or_quote: false;
    user_profile: false;
  };
  digest: string;
}

export function validateIntentBuildUsageEventV1(input: unknown): IntentBuildUsageEventV1 {
  return IntentBuildUsageEventV1Z.parse(input);
}

export function buildPlanUsageRef(plan: BuildPlanForUsage): z.infer<typeof PlanRefZ> {
  if (!plan.confirmation_source) throw new Error("selected plan requires confirmation_source");
  return PlanRefZ.parse({
    plan_id: plan.plan_id,
    plan_revision: plan.version === "build_plan.v3" ? plan.plan_revision : plan.revision,
    confirmation_source: plan.confirmation_source,
    ...(plan.intent_id ? { intent_id: plan.intent_id } : {}),
  });
}

export function planSelectedUsageEvent(input: {
  event_id: string;
  book_id: string;
  occurred_at: string;
  mode: IntentBuildMode;
  plan: BuildPlanForUsage | null;
}): IntentBuildUsageEventV1 {
  const plan = input.plan;
  return validateIntentBuildUsageEventV1({
    version: "intent_build_usage_event.v1",
    event_id: input.event_id,
    book_id: input.book_id,
    mode: input.mode,
    occurred_at: input.occurred_at,
    kind: "plan_selected",
    plan: plan ? buildPlanUsageRef(plan) : null,
    estimate: plan ? {
      token_lower: plan.estimate.input_tokens.lower + plan.estimate.output_tokens.lower,
      token_upper: plan.estimate.input_tokens.upper + plan.estimate.output_tokens.upper,
      token_coverage: Math.min(
        plan.estimate.input_tokens.coverage,
        plan.estimate.output_tokens.coverage,
      ),
      ...(plan.estimate.wall_clock_minutes.p50 !== undefined
        ? { wall_clock_p50_minutes: plan.estimate.wall_clock_minutes.p50 }
        : {}),
      ...(plan.estimate.wall_clock_minutes.p95 !== undefined
        ? { wall_clock_p95_minutes: plan.estimate.wall_clock_minutes.p95 }
        : {}),
      wall_clock_confidence: plan.estimate.wall_clock_minutes.confidence,
      unknown_item_count: plan.estimate.unknown_stages.length,
    } : null,
  });
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}

function emptyActual(): IntentBuildModeAblationV1["actual"] {
  return {
    attempt_count: 0,
    outcome_counts: { committed: 0, retryable_failure: 0, needs_user: 0, cancelled: 0 },
    known_usage_attempts: 0,
    unavailable_usage_attempts: 0,
    known_usage_coverage: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    wall_clock_ms: 0,
  };
}

function modeReport(
  mode: IntentBuildMode,
  events: IntentBuildUsageEventV1[],
  asOfMs: number,
  cutoffMs: number,
): IntentBuildModeAblationV1 {
  const selections = events.filter((event) => event.mode === mode && event.kind === "plan_selected");
  const planMap = new Map<string, z.infer<typeof PlanRefZ>>();
  for (const event of selections) {
    if (event.kind === "plan_selected" && event.plan) {
      planMap.set(`${event.plan.plan_id}:${event.plan.plan_revision}`, event.plan);
    }
  }
  const actual = emptyActual();
  const costs = new Map<z.infer<typeof ArtifactTypeZ>, IntentBuildModeAblationV1["artifact_costs"][number]>();
  for (const event of events) {
    if (event.mode !== mode || event.kind !== "cost_observed") continue;
    actual.attempt_count += 1;
    actual.outcome_counts[event.outcome] += 1;
    actual.wall_clock_ms += event.wall_clock_ms;
    if (event.usage.source === "unavailable") actual.unavailable_usage_attempts += 1;
    else actual.known_usage_attempts += 1;
    actual.input_tokens += event.usage.input_tokens ?? 0;
    actual.cached_input_tokens += event.usage.cached_input_tokens ?? 0;
    actual.output_tokens += event.usage.output_tokens ?? 0;
    actual.estimated_input_tokens += event.usage.estimated_input_tokens ?? 0;
    actual.estimated_output_tokens += event.usage.estimated_output_tokens ?? 0;
    if (!event.artifact) continue;
    const cost = costs.get(event.artifact.artifact_type) ?? {
      artifact_type: event.artifact.artifact_type,
      attempt_count: 0,
      committed_attempts: 0,
      failed_or_cancelled_attempts: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      wall_clock_ms: 0,
    };
    cost.attempt_count += 1;
    cost.committed_attempts += event.outcome === "committed" ? 1 : 0;
    cost.failed_or_cancelled_attempts += event.outcome === "committed" ? 0 : 1;
    cost.input_tokens += event.usage.input_tokens ?? 0;
    cost.cached_input_tokens += event.usage.cached_input_tokens ?? 0;
    cost.output_tokens += event.usage.output_tokens ?? 0;
    cost.wall_clock_ms += event.wall_clock_ms;
    costs.set(event.artifact.artifact_type, cost);
  }
  actual.known_usage_coverage = actual.attempt_count
    ? actual.known_usage_attempts / actual.attempt_count
    : 0;

  const selectionTimes = selections.map((event) => timestamp(event.occurred_at, "plan_selected.occurred_at"));
  const start = selectionTimes.length ? Math.min(...selectionTimes) : null;
  const firstReady = events
    .filter((event) => event.mode === mode && event.kind === "reader_ready")
    .map((event) => timestamp(event.occurred_at, "reader_ready.occurred_at"))
    .filter((value) => start === null || value >= start)
    .sort((a, b) => a - b)[0];
  const firstArtifact = events
    .filter((event) => event.mode === mode && event.kind === "artifact_accepted")
    .map((event) => timestamp(event.occurred_at, "artifact_accepted.occurred_at"))
    .filter((value) => start === null || value >= start)
    .sort((a, b) => a - b)[0];

  const accepted = new Map<string, number>();
  for (const event of events) {
    if (event.mode !== mode || event.kind !== "artifact_accepted") continue;
    const at = timestamp(event.occurred_at, "artifact_accepted.occurred_at");
    if (at < cutoffMs || at > asOfMs) continue;
    const prior = accepted.get(event.artifact.artifact_id);
    if (prior === undefined || at < prior) accepted.set(event.artifact.artifact_id, at);
  }
  const opened = new Set<string>();
  const cited = new Set<string>();
  let openEvents = 0;
  let citationEvents = 0;
  for (const event of events) {
    if (event.mode !== mode || (event.kind !== "artifact_opened" && event.kind !== "artifact_cited")) continue;
    const acceptedAt = accepted.get(event.artifact.artifact_id);
    const at = timestamp(event.occurred_at, `${event.kind}.occurred_at`);
    if (acceptedAt === undefined || at < acceptedAt || at > asOfMs) continue;
    if (event.kind === "artifact_opened") {
      opened.add(event.artifact.artifact_id);
      openEvents += 1;
    } else {
      cited.add(event.artifact.artifact_id);
      citationEvents += event.citation_count;
    }
  }
  const acceptedCount = accepted.size;
  return {
    mode,
    selection_count: selections.length,
    plan_revisions: [...planMap.values()].sort((left, right) => left.plan_revision - right.plan_revision
      || left.plan_id.localeCompare(right.plan_id)),
    estimate: selections.reduce((sum, event) => {
      if (event.kind !== "plan_selected" || !event.estimate) return sum;
      sum.token_lower += event.estimate.token_lower;
      sum.token_upper += event.estimate.token_upper;
      sum.unknown_item_count += event.estimate.unknown_item_count;
      return sum;
    }, { token_lower: 0, token_upper: 0, unknown_item_count: 0 }),
    actual,
    timing: {
      first_readable_ms: start !== null && firstReady !== undefined ? firstReady - start : null,
      first_goal_artifact_ms: start !== null && firstArtifact !== undefined ? firstArtifact - start : null,
    },
    consumption_7d: {
      accepted_artifacts: acceptedCount,
      opened_artifacts: opened.size,
      cited_artifacts: cited.size,
      open_rate: acceptedCount ? opened.size / acceptedCount : null,
      citation_rate: acceptedCount ? cited.size / acceptedCount : null,
      open_events: openEvents,
      citation_events: citationEvents,
    },
    artifact_costs: [...costs.values()].sort((left, right) => left.artifact_type.localeCompare(right.artifact_type)),
  };
}

export function replayIntentBuildUsageEvents(
  inputs: unknown[],
  options: { book_id: string; as_of: string; window_days?: number },
): IntentBuildAblationReportV1 {
  const asOfMs = timestamp(options.as_of, "as_of");
  const windowDays = options.window_days ?? 7;
  if (!Number.isSafeInteger(windowDays) || windowDays <= 0 || windowDays > 365) {
    throw new Error("window_days must be an integer in 1..365");
  }
  const byId = new Map<string, IntentBuildUsageEventV1>();
  for (const input of inputs) {
    const event = validateIntentBuildUsageEventV1(input);
    if (event.book_id !== options.book_id) throw new Error("usage event belongs to another book");
    if (timestamp(event.occurred_at, "event.occurred_at") > asOfMs) continue;
    const existing = byId.get(event.event_id);
    if (existing && canonicalBuildJson(existing) !== canonicalBuildJson(event)) {
      throw new Error(`usage event_id conflicts with existing content: ${event.event_id}`);
    }
    byId.set(event.event_id, event);
  }
  const events = [...byId.values()].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)
    || left.event_id.localeCompare(right.event_id));
  const reportWithoutDigest = {
    version: "intent_build_ablation_report.v1" as const,
    book_id: options.book_id,
    as_of: options.as_of,
    window_days: windowDays,
    event_count: events.length,
    modes: (["read_now", "standard_deep", "goal_directed"] as const).map((mode) => modeReport(
      mode,
      events,
      asOfMs,
      asOfMs - windowDays * 24 * 60 * 60 * 1_000,
    )),
    privacy: {
      raw_goal: false as const,
      artifact_body: false as const,
      lid_or_quote: false as const,
      user_profile: false as const,
    },
  };
  return {
    ...reportWithoutDigest,
    digest: createHash("sha256").update(canonicalBuildJson(reportWithoutDigest), "utf8").digest("hex"),
  };
}

export interface IntentBuildUsageAppendResultV1 {
  version: "intent_build_usage_append_result.v1";
  event_id: string;
  disposition: "created" | "existing";
}

export interface IntentBuildUsageDeleteResultV1 {
  version: "intent_build_usage_delete_result.v1";
  book_id: string;
  intent_id: string;
  deleted_event_count: number;
}

function isOutside(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function privateRoot(input: string): string {
  if (!path.isAbsolute(input) || !existsSync(input)) {
    throw new Error("private_root must be an existing absolute directory");
  }
  const metadata = lstatSync(input);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("private_root must be a real directory without symlinks");
  }
  return realpathSync.native(input);
}

function assertRealDescendant(root: string, target: string, create: boolean): string {
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || isOutside(relative)) throw new Error("usage ledger path must stay below private_root");
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("usage ledger path must not contain a symlink");
    }
  }
  if (create) mkdirSync(resolved, { recursive: true });
  if (existsSync(resolved)) {
    const metadata = lstatSync(resolved);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("usage ledger directory must be a real directory");
    }
    const real = realpathSync.native(resolved);
    if (isOutside(path.relative(root, real))) throw new Error("usage ledger directory escapes private_root");
    return real;
  }
  return resolved;
}

function eventDirectory(privateRootInput: string, bookId: string, create: boolean): string {
  const root = privateRoot(privateRootInput);
  const safeBookId = PathSafeIdZ.parse(bookId);
  return assertRealDescendant(root, path.join(root, safeBookId, "usage", "events"), create);
}

function eventFile(directory: string, eventId: string): string {
  return path.join(directory, `${PathSafeIdZ.parse(eventId)}.json`);
}

function readStoredEvent(file: string): IntentBuildUsageEventV1 {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("usage event path must be a real file without symlinks");
  }
  if (statSync(file).size > MAX_USAGE_EVENT_BYTES) {
    throw new Error(`usage event exceeds ${MAX_USAGE_EVENT_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error("usage ledger contains invalid JSON", { cause: error });
  }
  return validateIntentBuildUsageEventV1(value);
}

export function appendIntentBuildUsageEvent(
  privateRootInput: string,
  input: unknown,
): IntentBuildUsageAppendResultV1 {
  const event = validateIntentBuildUsageEventV1(input);
  const directory = eventDirectory(privateRootInput, event.book_id, true);
  const file = eventFile(directory, event.event_id);
  const body = `${canonicalBuildJson(event)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_USAGE_EVENT_BYTES) {
    throw new Error(`usage event exceeds ${MAX_USAGE_EVENT_BYTES} bytes`);
  }
  let disposition: IntentBuildUsageAppendResultV1["disposition"] = "created";
  try {
    writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const stored = readStoredEvent(file);
    if (canonicalBuildJson(stored) !== canonicalBuildJson(event)) {
      throw new Error(`usage event_id conflicts with existing content: ${event.event_id}`);
    }
    disposition = "existing";
  }
  return {
    version: "intent_build_usage_append_result.v1",
    event_id: event.event_id,
    disposition,
  };
}

export function readIntentBuildUsageEvents(
  privateRootInput: string,
  bookId: string,
): IntentBuildUsageEventV1[] {
  const directory = eventDirectory(privateRootInput, bookId, false);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).sort();
  if (names.length > MAX_USAGE_EVENTS) throw new Error(`usage ledger exceeds ${MAX_USAGE_EVENTS} events`);
  const events: IntentBuildUsageEventV1[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) throw new Error("usage ledger contains an unexpected entry");
    const file = path.join(directory, name);
    const event = readStoredEvent(file);
    if (`${event.event_id}.json` !== name || event.book_id !== bookId) {
      throw new Error("usage event file identity does not match its ledger path");
    }
    events.push(event);
  }
  return events;
}

export function replayIntentBuildUsageLedger(
  privateRootInput: string,
  options: { book_id: string; as_of: string; window_days?: number },
): IntentBuildAblationReportV1 {
  return replayIntentBuildUsageEvents(
    readIntentBuildUsageEvents(privateRootInput, options.book_id),
    options,
  );
}

export function deleteIntentBuildUsageForIntent(
  privateRootInput: string,
  bookId: string,
  intentId: string,
): IntentBuildUsageDeleteResultV1 {
  PathSafeIdZ.parse(intentId);
  const directory = eventDirectory(privateRootInput, bookId, false);
  if (!existsSync(directory)) {
    return {
      version: "intent_build_usage_delete_result.v1",
      book_id: bookId,
      intent_id: intentId,
      deleted_event_count: 0,
    };
  }
  const events = readIntentBuildUsageEvents(privateRootInput, bookId);
  let deleted = 0;
  for (const event of events) {
    if (event.plan?.intent_id !== intentId) continue;
    unlinkSync(eventFile(directory, event.event_id));
    deleted += 1;
  }
  return {
    version: "intent_build_usage_delete_result.v1",
    book_id: bookId,
    intent_id: intentId,
    deleted_event_count: deleted,
  };
}
