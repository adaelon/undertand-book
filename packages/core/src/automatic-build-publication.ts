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

export interface AutomaticBuildPublicationReceiptV1 {
  version: "automatic_build_publication_receipt.v1";
  stage: AutomaticBuildStage;
  transaction_id: string;
  status: "committed";
  artifacts: Array<{ path: string; sha256: string; size_bytes: number }>;
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

export function publishAutomaticBuildArtifactSet(input: {
  workspace_dir: string;
  stage: AutomaticBuildStage;
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
  const transactionId = sha256(JSON.stringify({ version: "automatic_build_publication.v1", stage: input.stage, artifacts: identity }));
  const transactionRoot = path.join(workspace, ".build", "automatic-build", "v2", "publication", input.stage, transactionId);
  const receiptPath = path.join(transactionRoot, "receipt.json");
  let existingReceipt: AutomaticBuildPublicationReceiptV1 | undefined;
  if (existsSync(receiptPath)) {
    existingReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as AutomaticBuildPublicationReceiptV1;
    const currentMatches = existingReceipt.artifacts.every((artifact) => {
      const file = path.join(workspace, artifact.path);
      return existsSync(file) && sha256(readFileSync(file)) === artifact.sha256;
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
