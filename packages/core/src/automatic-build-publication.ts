import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AutomaticBuildStage } from "./build-orchestrator";

export type AutomaticBuildPublicationStage = Exclude<AutomaticBuildStage, "paper_reading_guide">;

const AUTOMATIC_BUILD_PUBLICATION_VERSION = "automatic_build_publication.v1" as const;
const AUTOMATIC_BUILD_PUBLICATION_ROOT_REF = ".build/automatic-build/v2/publication";
const SHA256 = /^[a-f0-9]{64}$/u;

export interface AutomaticBuildPublicationReceiptV1 {
  version: "automatic_build_publication_receipt.v1";
  stage: AutomaticBuildPublicationStage;
  transaction_id: string;
  status: "committed";
  artifacts: Array<{ path: string; sha256: string; size_bytes: number }>;
}

export interface AutomaticBuildStageBatchResultV1 {
  version: "automatic_build_stage_batch_result.v1";
  stage: AutomaticBuildPublicationStage;
  publication: {
    transaction_id: string;
    receipt_ref: string;
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || path.isAbsolute(relative) || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new Error(`publication artifact path must stay relative to the workspace: ${relative}`);
  }
  return normalized;
}

function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTransactionId(transactionId: string): string {
  if (!SHA256.test(transactionId)) throw new Error("publication transaction_id must be a lowercase SHA-256 digest");
  return transactionId;
}

function isPublicationStage(value: unknown): value is AutomaticBuildPublicationStage {
  return [
    "pass1",
    "paper_metadata",
    "paper_lexicon",
    "profile_sidecar",
    "pass2",
    "book_structure",
  ].includes(String(value));
}

export function automaticBuildPublicationReceiptRef(
  stage: AutomaticBuildPublicationStage,
  transactionId: string,
): string {
  return `${AUTOMATIC_BUILD_PUBLICATION_ROOT_REF}/${stage}/${assertTransactionId(transactionId)}/receipt.json`;
}

export function automaticBuildPublicationReceiptPath(
  workspaceDir: string,
  stage: AutomaticBuildPublicationStage,
  transactionId: string,
): string {
  return path.join(path.resolve(workspaceDir), ...automaticBuildPublicationReceiptRef(stage, transactionId).split("/"));
}

export function validateAutomaticBuildPublicationReceipt(
  value: unknown,
  expected: { stage?: AutomaticBuildPublicationStage; transaction_id?: string } = {},
): AutomaticBuildPublicationReceiptV1 {
  if (!isRecord(value) || !exactKeys(value, ["version", "stage", "transaction_id", "status", "artifacts"])
    || value.version !== "automatic_build_publication_receipt.v1"
    || !isPublicationStage(value.stage)
    || typeof value.transaction_id !== "string"
    || !SHA256.test(value.transaction_id)
    || value.status !== "committed"
    || !Array.isArray(value.artifacts)
    || value.artifacts.length < 1
    || value.artifacts.length > 32) {
    throw new Error("automatic build publication receipt is invalid");
  }
  const artifacts = value.artifacts.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["path", "sha256", "size_bytes"])
      || typeof item.path !== "string"
      || typeof item.sha256 !== "string"
      || !SHA256.test(item.sha256)
      || !Number.isSafeInteger(item.size_bytes)
      || (item.size_bytes as number) < 0) {
      throw new Error("automatic build publication receipt artifact is invalid");
    }
    return {
      path: safeRelative(item.path),
      sha256: item.sha256,
      size_bytes: item.size_bytes as number,
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length
    || artifacts.some((artifact, index) => index > 0 && artifacts[index - 1].path.localeCompare(artifact.path) >= 0)) {
    throw new Error("automatic build publication receipt artifacts must be unique and sorted");
  }
  const transactionId = sha256(JSON.stringify({
    version: AUTOMATIC_BUILD_PUBLICATION_VERSION,
    stage: value.stage,
    artifacts,
  }));
  if (transactionId !== value.transaction_id
    || (expected.stage !== undefined && value.stage !== expected.stage)
    || (expected.transaction_id !== undefined && value.transaction_id !== expected.transaction_id)) {
    throw new Error("automatic build publication receipt identity mismatch");
  }
  return {
    version: "automatic_build_publication_receipt.v1",
    stage: value.stage,
    transaction_id: value.transaction_id,
    status: "committed",
    artifacts,
  };
}

export function readAutomaticBuildPublicationReceipt(
  workspaceDir: string,
  stage: AutomaticBuildPublicationStage,
  transactionId: string,
): AutomaticBuildPublicationReceiptV1 {
  const file = automaticBuildPublicationReceiptPath(workspaceDir, stage, transactionId);
  if (!existsSync(file)) throw new Error("automatic build publication receipt is missing");
  return validateAutomaticBuildPublicationReceipt(JSON.parse(readFileSync(file, "utf8")), {
    stage,
    transaction_id: transactionId,
  });
}

export function buildAutomaticBuildStageBatchResult(
  receipt: AutomaticBuildPublicationReceiptV1,
): AutomaticBuildStageBatchResultV1 {
  const validated = validateAutomaticBuildPublicationReceipt(receipt);
  return {
    version: "automatic_build_stage_batch_result.v1",
    stage: validated.stage,
    publication: {
      transaction_id: validated.transaction_id,
      receipt_ref: automaticBuildPublicationReceiptRef(validated.stage, validated.transaction_id),
    },
  };
}

export function parseAutomaticBuildStageBatchResult(
  value: unknown,
  expectedStage?: AutomaticBuildPublicationStage,
): AutomaticBuildStageBatchResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["version", "stage", "publication"])
    || value.version !== "automatic_build_stage_batch_result.v1"
    || !isPublicationStage(value.stage)
    || !isRecord(value.publication)
    || !exactKeys(value.publication, ["transaction_id", "receipt_ref"])
    || typeof value.publication.transaction_id !== "string"
    || !SHA256.test(value.publication.transaction_id)
    || typeof value.publication.receipt_ref !== "string"
    || value.publication.receipt_ref !== automaticBuildPublicationReceiptRef(
      value.stage,
      value.publication.transaction_id,
    )
    || (expectedStage !== undefined && value.stage !== expectedStage)) {
    throw new Error("automatic build stage batch result is invalid");
  }
  return value as unknown as AutomaticBuildStageBatchResultV1;
}

export function publishAutomaticBuildArtifactSet(input: {
  workspace_dir: string;
  stage: AutomaticBuildPublicationStage;
  artifacts: Record<string, string | Uint8Array>;
  validate_candidates?: (candidatePaths: Record<string, string>) => void;
  fault_injection?: { fail_after_promotions: number };
}): AutomaticBuildPublicationReceiptV1 {
  const workspace = path.resolve(input.workspace_dir);
  const entries = Object.entries(input.artifacts)
    .map(([relative, bytes]) => [safeRelative(relative), typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new Error("publication requires at least one artifact");
  const identity = entries.map(([relative, bytes]) => ({ path: relative, sha256: sha256(bytes), size_bytes: bytes.byteLength }));
  const transactionId = sha256(JSON.stringify({ version: AUTOMATIC_BUILD_PUBLICATION_VERSION, stage: input.stage, artifacts: identity }));
  const transactionRoot = path.join(workspace, ".build", "automatic-build", "v2", "publication", input.stage, transactionId);
  const receiptPath = path.join(transactionRoot, "receipt.json");
  let existingReceipt: AutomaticBuildPublicationReceiptV1 | undefined;
  if (existsSync(receiptPath)) {
    existingReceipt = validateAutomaticBuildPublicationReceipt(JSON.parse(readFileSync(receiptPath, "utf8")), {
      stage: input.stage,
      transaction_id: transactionId,
    });
    const currentMatches = existingReceipt.artifacts.every((artifact) => {
      const file = path.join(workspace, artifact.path);
      if (!existsSync(file)) return false;
      const bytes = readFileSync(file);
      return bytes.byteLength === artifact.size_bytes && sha256(bytes) === artifact.sha256;
    });
    if (currentMatches) return existingReceipt;
  }

  const runRoot = `${transactionRoot}.run-${process.pid}-${randomUUID()}`;
  const candidateRoot = path.join(runRoot, "candidates");
  const backupRoot = path.join(runRoot, "backup");
  mkdirSync(candidateRoot, { recursive: true });
  const candidatePaths: Record<string, string> = {};
  for (const [relative, bytes] of entries) {
    const file = path.join(candidateRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: "wx" });
    candidatePaths[relative] = file;
  }
  input.validate_candidates?.(candidatePaths);

  const promoted: string[] = [];
  const backedUp: string[] = [];
  try {
    for (const [relative] of entries) {
      const official = path.join(workspace, relative);
      const backup = path.join(backupRoot, relative);
      if (existsSync(official)) {
        mkdirSync(path.dirname(backup), { recursive: true });
        renameSync(official, backup);
        backedUp.push(relative);
      }
      mkdirSync(path.dirname(official), { recursive: true });
      renameSync(candidatePaths[relative], official);
      promoted.push(relative);
      if (input.fault_injection?.fail_after_promotions === promoted.length) {
        throw new Error(`injected publication failure after ${promoted.length} promotions`);
      }
    }
    mkdirSync(transactionRoot, { recursive: true });
    const receipt: AutomaticBuildPublicationReceiptV1 = {
      version: "automatic_build_publication_receipt.v1",
      stage: input.stage,
      transaction_id: transactionId,
      status: "committed",
      artifacts: identity,
    };
    if (!existingReceipt) {
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    rmSync(runRoot, { recursive: true, force: true });
    return receipt;
  } catch (error) {
    for (const relative of [...promoted].reverse()) {
      const official = path.join(workspace, relative);
      if (existsSync(official)) rmSync(official, { force: true });
    }
    for (const relative of [...backedUp].reverse()) {
      const backup = path.join(backupRoot, relative);
      const official = path.join(workspace, relative);
      if (existsSync(backup)) {
        mkdirSync(path.dirname(official), { recursive: true });
        renameSync(backup, official);
      }
    }
    rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}
