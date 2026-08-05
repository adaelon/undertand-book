import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalBuildJson } from "./build-intent";
import {
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  routeAutomaticBuildSnapshot,
  type AutomaticBuildStageState,
  type AutomaticBuildTarget,
} from "./build-orchestrator";
import {
  collectAutomaticBuildStageQuality,
  writeAutomaticBuildStageQualityReport,
  type AutomaticBuildStageQualityReportV1,
  type AutomaticBuildStageQualityReportV2,
} from "./automatic-build-quality";
import {
  createAutomaticBuildRecoveryEnvelope,
  type AutomaticBuildRecoveryEnvelopeV1,
} from "./automatic-build-recovery";
import {
  parseAutomaticBuildStageBatchResult,
  readAutomaticBuildPublicationReceipt,
  type AutomaticBuildPublicationReceiptV1,
  type AutomaticBuildPublicationStage,
} from "./automatic-build-publication";
import type { ExtractionQualityProfile } from "./semantic-artifact";

const SHA256 = /^[a-f0-9]{64}$/u;
const CLOSE_STAGES: AutomaticBuildPublicationStage[] = [
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function boundedString(value: unknown, maxBytes = 512): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

const PUBLICATION_PATH_ALLOWLIST: Record<AutomaticBuildPublicationStage, ReadonlySet<string>> = {
  pass1: new Set([
    "asset_manifest.json",
    "base.json",
    "discourse_index.json",
    "formula_semantics.json",
    "long_range_candidates.json",
    "pass2_audit.json",
    "profile_metadata.json",
    "source.txt",
    "source_manifest.json",
  ]),
  paper_metadata: new Set(["paper_metadata.json"]),
  paper_lexicon: new Set(["paper_lexicon.json"]),
  profile_sidecar: new Set(["discourse_index.json", "formula_semantics.json"]),
  pass2: new Set(["base.json", "long_range_candidates.json", "pass2_audit.json"]),
  book_structure: new Set(["book_structure.json"]),
};

export interface AutomaticBuildStageCloseResultV1 {
  version: "automatic_build_stage_close_result.v1";
  status: "closed";
  stage: AutomaticBuildPublicationStage;
  target: {
    book_id: string;
    profile_id: AutomaticBuildTarget["profile_id"];
    input_fingerprint: string;
  };
  quality: {
    report_digest: string;
    gate_status: "passed";
  };
  publication: {
    transaction_id: string;
    receipt_digest: string;
  };
  postcondition: {
    stage_closed: true;
    policy_set_digest: string;
    coverage_digest: string;
    freshness_digest: string;
    public_artifact_set_digest: string;
  };
  next: "replan";
}

export type AutomaticBuildStageCloseOutcomeV1 =
  | AutomaticBuildStageCloseResultV1
  | AutomaticBuildRecoveryEnvelopeV1;

export interface AutomaticBuildStageVerificationResultV1 {
  version: "automatic_build_stage_verification_result.v1";
  status: "verified";
  stage: "paper_reading_guide";
  target: {
    book_id: string;
    profile_id: AutomaticBuildTarget["profile_id"];
    input_fingerprint: string;
  };
  postcondition: {
    stage_closed: true;
    freshness_digest: string;
  };
  next: "replan";
}

export interface AutomaticBuildStageBatchExecutionV1 {
  stdout: string;
  stderr?: string;
}

export function parseAutomaticBuildStageCloseResult(
  value: unknown,
): AutomaticBuildStageCloseResultV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "version",
      "status",
      "stage",
      "target",
      "quality",
      "publication",
      "postcondition",
      "next",
    ])
    || value.version !== "automatic_build_stage_close_result.v1"
    || value.status !== "closed"
    || !(CLOSE_STAGES as string[]).includes(String(value.stage))
    || value.next !== "replan"
    || !isRecord(value.target)
    || !exactKeys(value.target, ["book_id", "profile_id", "input_fingerprint"])
    || !boundedString(value.target.book_id)
    || !["technical_learning", "paper"].includes(String(value.target.profile_id))
    || typeof value.target.input_fingerprint !== "string"
    || !SHA256.test(value.target.input_fingerprint)
    || !isRecord(value.quality)
    || !exactKeys(value.quality, ["report_digest", "gate_status"])
    || typeof value.quality.report_digest !== "string"
    || !SHA256.test(value.quality.report_digest)
    || value.quality.gate_status !== "passed"
    || !isRecord(value.publication)
    || !exactKeys(value.publication, ["transaction_id", "receipt_digest"])
    || typeof value.publication.transaction_id !== "string"
    || !SHA256.test(value.publication.transaction_id)
    || typeof value.publication.receipt_digest !== "string"
    || !SHA256.test(value.publication.receipt_digest)
    || !isRecord(value.postcondition)
    || !exactKeys(value.postcondition, [
      "stage_closed",
      "policy_set_digest",
      "coverage_digest",
      "freshness_digest",
      "public_artifact_set_digest",
    ])
    || value.postcondition.stage_closed !== true
    || [
      value.postcondition.policy_set_digest,
      value.postcondition.coverage_digest,
      value.postcondition.freshness_digest,
      value.postcondition.public_artifact_set_digest,
    ].some((digest) => typeof digest !== "string" || !SHA256.test(digest))) {
    throw new Error("automatic build stage close result is invalid");
  }
  return value as unknown as AutomaticBuildStageCloseResultV1;
}

class AutomaticBuildCloseResultConflictError extends Error {}

function sha256(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" || value instanceof Uint8Array ? value : canonicalBuildJson(value),
  ).digest("hex");
}

function closeRecovery(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildPublicationStage,
  phase: "close" | "post_close",
  code: "publication_receipt_invalid" | "stage_close_postcondition_failed",
  policyDigest?: string,
): AutomaticBuildRecoveryEnvelopeV1 {
  return createAutomaticBuildRecoveryEnvelope({
    phase,
    code,
    stage,
    target_ref: target.target_ref,
    ...(policyDigest ? { policy_digest: policyDigest } : {}),
    affected_work_units: [],
    retryable: false,
    recovery_actions: ["inspect_publication"],
  });
}

function stageState(
  stages: AutomaticBuildStageState[],
  stage: AutomaticBuildPublicationStage,
): AutomaticBuildStageState {
  const state = stages.find((candidate) => candidate.stage === stage);
  if (!state) throw new Error(`close stage is not reachable in the current snapshot: ${stage}`);
  return state;
}

function reportCloseEvidence(
  report: AutomaticBuildStageQualityReportV1 | AutomaticBuildStageQualityReportV2,
  state: AutomaticBuildStageState,
): { policy_set_digest: string; coverage_digest: string } {
  if (report.version === "automatic_build_stage_quality_report.v2") {
    return {
      policy_set_digest: report.routing.policy_set_digest,
      coverage_digest: report.coverage.coverage_digest,
    };
  }
  const policies = (state.work_units ?? [])
    .map((unit) => unit.policy_fingerprint)
    .sort((left, right) => canonicalBuildJson(left).localeCompare(canonicalBuildJson(right)));
  return {
    policy_set_digest: sha256({
      version: "automatic_build_stage_policy_set_compatibility.v1",
      stage: report.stage,
      policies,
    }),
    coverage_digest: sha256({
      version: "automatic_build_stage_coverage_compatibility.v1",
      stage: report.stage,
      accounting: report.accounting,
      artifact_set_digest: report.integrity.artifact_set_digest,
    }),
  };
}

function publicationReceiptDigest(receipt: AutomaticBuildPublicationReceiptV1): string {
  return sha256(receipt);
}

function validatePublicationPaths(
  receipt: AutomaticBuildPublicationReceiptV1,
  stage: AutomaticBuildPublicationStage,
): void {
  const allowed = PUBLICATION_PATH_ALLOWLIST[stage];
  if (receipt.artifacts.some((artifact) => !allowed.has(artifact.path))) {
    throw new Error("publication receipt contains an artifact outside the stage allowlist");
  }
}

function publicArtifactsMatchReceipt(
  target: AutomaticBuildTarget,
  receipt: AutomaticBuildPublicationReceiptV1,
): boolean {
  return receipt.artifacts.every((artifact) => {
    const file = path.join(target.workspace_dir, ...artifact.path.split("/"));
    if (!existsSync(file)) return false;
    const bytes = readFileSync(file);
    return bytes.byteLength === artifact.size_bytes && sha256(bytes) === artifact.sha256;
  });
}

export function automaticBuildStageCloseResultPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildPublicationStage,
  transactionId: string,
): string {
  if (!SHA256.test(transactionId)) throw new Error("close result transaction_id must be a lowercase SHA-256 digest");
  return path.join(
    target.workspace_dir,
    ".build",
    "automatic-build",
    "v2",
    "close",
    stage,
    `${transactionId}.json`,
  );
}

export function writeAutomaticBuildStageCloseResult(
  target: AutomaticBuildTarget,
  result: AutomaticBuildStageCloseResultV1,
): AutomaticBuildStageCloseResultV1 {
  const validated = parseAutomaticBuildStageCloseResult(result);
  if (validated.target.book_id !== target.book_id
    || validated.target.profile_id !== target.profile_id
    || validated.target.input_fingerprint !== target.target_ref.input_fingerprint) {
    throw new Error("automatic build close result target identity mismatch");
  }
  const file = automaticBuildStageCloseResultPath(
    target,
    validated.stage,
    validated.publication.transaction_id,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const existing = parseAutomaticBuildStageCloseResult(JSON.parse(readFileSync(file, "utf8")));
    if (canonicalBuildJson(existing) === canonicalBuildJson(validated)) return existing;
    throw new AutomaticBuildCloseResultConflictError("automatic build close result conflicts with create-only identity");
  }
  try {
    writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return validated;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = parseAutomaticBuildStageCloseResult(JSON.parse(readFileSync(file, "utf8")));
    if (canonicalBuildJson(existing) === canonicalBuildJson(validated)) return existing;
    throw new AutomaticBuildCloseResultConflictError("automatic build close result conflicts with create-only identity");
  }
}

export function closeAutomaticBuildStage(input: {
  target: AutomaticBuildTarget;
  stage: AutomaticBuildPublicationStage;
  quality_profile: ExtractionQualityProfile;
  run_batch: () => AutomaticBuildStageBatchExecutionV1;
}): AutomaticBuildStageCloseOutcomeV1 {
  const preSnapshot = buildAutomaticBuildSnapshot(input.target, { quality_profile: input.quality_profile });
  const preStage = stageState(preSnapshot.stages, input.stage);
  const preQuality = collectAutomaticBuildStageQuality(input.target, preStage, input.quality_profile);
  if (preQuality.gate_status !== "passed") {
    throw new Error(`quality_gate_failed:${input.stage}:${preQuality.gate_status}`);
  }
  const preEvidence = reportCloseEvidence(preQuality, preStage);
  writeAutomaticBuildStageQualityReport(input.target, preQuality);

  const batch = input.run_batch();
  let receipt: AutomaticBuildPublicationReceiptV1;
  try {
    const batchResult = parseAutomaticBuildStageBatchResult(JSON.parse(batch.stdout), input.stage);
    receipt = readAutomaticBuildPublicationReceipt(
      input.target.workspace_dir,
      input.stage,
      batchResult.publication.transaction_id,
    );
    validatePublicationPaths(receipt, input.stage);
  } catch {
    return closeRecovery(
      input.target,
      input.stage,
      "close",
      "publication_receipt_invalid",
      preEvidence.policy_set_digest,
    );
  }
  if (!publicArtifactsMatchReceipt(input.target, receipt)) {
    return closeRecovery(
      input.target,
      input.stage,
      "post_close",
      "stage_close_postcondition_failed",
      preEvidence.policy_set_digest,
    );
  }

  const postRoute = routeAutomaticBuildSnapshot(input.target, { quality_profile: input.quality_profile });
  if (postRoute.status === "blocked") {
    return closeRecovery(
      input.target,
      input.stage,
      "post_close",
      "stage_close_postcondition_failed",
      preEvidence.policy_set_digest,
    );
  }
  const postSnapshot = postRoute.value;
  const postStage = stageState(postSnapshot.stages, input.stage);
  const postQuality = collectAutomaticBuildStageQuality(input.target, postStage, input.quality_profile);
  const postEvidence = reportCloseEvidence(postQuality, postStage);
  const freshness = inspectAutomaticBuildStageFreshness(postSnapshot, {
    quality_profile: input.quality_profile,
  }).find((item) => item.stage === input.stage);
  if (!postStage.closed
    || postQuality.gate_status !== "passed"
    || postQuality.digest !== preQuality.digest
    || postEvidence.policy_set_digest !== preEvidence.policy_set_digest
    || postEvidence.coverage_digest !== preEvidence.coverage_digest
    || !freshness?.fresh
    || !freshness.freshness_digest) {
    return closeRecovery(
      input.target,
      input.stage,
      "post_close",
      "stage_close_postcondition_failed",
      preEvidence.policy_set_digest,
    );
  }
  const result: AutomaticBuildStageCloseResultV1 = {
    version: "automatic_build_stage_close_result.v1",
    status: "closed",
    stage: input.stage,
    target: {
      book_id: input.target.book_id,
      profile_id: input.target.profile_id,
      input_fingerprint: input.target.target_ref.input_fingerprint,
    },
    quality: {
      report_digest: postQuality.digest,
      gate_status: "passed",
    },
    publication: {
      transaction_id: receipt.transaction_id,
      receipt_digest: publicationReceiptDigest(receipt),
    },
    postcondition: {
      stage_closed: true,
      policy_set_digest: postEvidence.policy_set_digest,
      coverage_digest: postEvidence.coverage_digest,
      freshness_digest: freshness.freshness_digest,
      public_artifact_set_digest: sha256(receipt.artifacts),
    },
    next: "replan",
  };
  try {
    return writeAutomaticBuildStageCloseResult(input.target, result);
  } catch (error) {
    if (!(error instanceof AutomaticBuildCloseResultConflictError)) throw error;
    return closeRecovery(
      input.target,
      input.stage,
      "post_close",
      "stage_close_postcondition_failed",
      preEvidence.policy_set_digest,
    );
  }
}

export function verifyAutomaticBuildStageClose(
  target: AutomaticBuildTarget,
): AutomaticBuildStageVerificationResultV1 | AutomaticBuildRecoveryEnvelopeV1 {
  const snapshotRoute = routeAutomaticBuildSnapshot(target);
  if (snapshotRoute.status === "blocked") {
    return createAutomaticBuildRecoveryEnvelope({
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "paper_reading_guide",
      target_ref: target.target_ref,
      affected_work_units: [],
      retryable: false,
      recovery_actions: ["inspect_publication"],
    });
  }
  const snapshot = snapshotRoute.value;
  const stage = snapshot.stages.find((candidate) => candidate.stage === "paper_reading_guide");
  const freshness = inspectAutomaticBuildStageFreshness(snapshot)
    .find((candidate) => candidate.stage === "paper_reading_guide");
  if (!stage?.closed || !freshness?.fresh || !freshness.freshness_digest) {
    return createAutomaticBuildRecoveryEnvelope({
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "paper_reading_guide",
      target_ref: target.target_ref,
      affected_work_units: [],
      retryable: false,
      recovery_actions: ["inspect_publication"],
    });
  }
  return {
    version: "automatic_build_stage_verification_result.v1",
    status: "verified",
    stage: "paper_reading_guide",
    target: {
      book_id: target.book_id,
      profile_id: target.profile_id,
      input_fingerprint: target.target_ref.input_fingerprint,
    },
    postcondition: {
      stage_closed: true,
      freshness_digest: freshness.freshness_digest,
    },
    next: "replan",
  };
}
