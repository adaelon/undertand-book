import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ReadOnlyBase } from "./generated/ReadOnlyBase";
import { ReadOnlyBaseZ } from "./zod";

export const HYBRID_FOUNDATION_ARTIFACT_PATHS = [
  "base.json",
  "source.txt",
  "source_manifest.json",
  "pdf_source_map.json",
  "alignment_report.json",
  "pdf_selection_map",
] as const;

export type HybridFoundationArtifactPath = typeof HYBRID_FOUNDATION_ARTIFACT_PATHS[number];
export type HybridFoundationApplyFaultInjector = (point: string) => void;

type ArtifactHashes = Record<HybridFoundationArtifactPath, string | null>;
type TransactionPhase =
  | "preparing"
  | "prepared"
  | "old_moved"
  | "new_moved"
  | "validated"
  | "committed"
  | "rolled_back";

interface HybridFoundationApplyJournal {
  version: "hybrid_foundation_apply_transaction.v1";
  revision: number;
  transaction_id: string;
  phase: TransactionPhase;
  old_hashes: ArtifactHashes;
  new_hashes: ArtifactHashes;
  old_graph_digest: string | null;
  new_graph_digest: string;
  old_moved: HybridFoundationArtifactPath[];
  new_moved: HybridFoundationArtifactPath[];
}

export interface ApplyHybridFoundationArtifactSetOptions {
  book_dir: string;
  candidate_dir: string;
  validate_artifact_set: (root: string) => void;
  validate_candidate_artifact_set?: (root: string) => void;
  transaction_id?: string;
  fault_injector?: HybridFoundationApplyFaultInjector;
  recover_on_error?: boolean;
}

export interface RecoverHybridFoundationArtifactApplicationsOptions {
  book_dir: string;
  validate_artifact_set: (root: string) => void;
}

export interface HybridFoundationArtifactApplyResult {
  status: "applied" | "already_current";
  transaction_id: string | null;
  backup_dir: string | null;
  artifact_hashes: ArtifactHashes;
  semantic_graph_digest: string;
}

export interface HybridFoundationRecoveryResult {
  transaction_id: string;
  outcome: "committed" | "rolled_back";
}

const activeBookLocks = new Set<string>();

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function digestFilesystemPath(target: string, relative = ""): string {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new Error(`hybrid foundation artifacts may not contain symlinks: ${target}`);
  if (info.isFile()) return sha256(`file\0${relative}\0${sha256(readFileSync(target))}`);
  if (!info.isDirectory()) throw new Error(`unsupported hybrid foundation artifact type: ${target}`);
  const children = readdirSync(target).sort((left, right) => left.localeCompare(right));
  return sha256(`dir\0${relative}\0${children.map((child) => (
    `${child}\0${digestFilesystemPath(path.join(target, child), relative ? `${relative}/${child}` : child)}`
  )).join("\0")}`);
}

function artifactHashes(root: string): ArtifactHashes {
  return Object.fromEntries(HYBRID_FOUNDATION_ARTIFACT_PATHS.map((relativePath) => {
    const target = path.join(root, relativePath);
    return [relativePath, existsSync(target) ? digestFilesystemPath(target, relativePath) : null];
  })) as ArtifactHashes;
}

function hashesEqual(left: ArtifactHashes, right: ArtifactHashes): boolean {
  return HYBRID_FOUNDATION_ARTIFACT_PATHS.every((relativePath) => left[relativePath] === right[relativePath]);
}

function completeArtifactSet(hashes: ArtifactHashes): boolean {
  return HYBRID_FOUNDATION_ARTIFACT_PATHS.every((relativePath) => hashes[relativePath] !== null);
}

function assertCompleteArtifactSet(hashes: ArtifactHashes, label: string): void {
  const missing = HYBRID_FOUNDATION_ARTIFACT_PATHS.filter((relativePath) => hashes[relativePath] === null);
  if (missing.length) throw new Error(`${label} is missing hybrid foundation artifacts: ${missing.join(", ")}`);
}

export function hybridFoundationArtifactSetDigest(root: string): string {
  return sha256(JSON.stringify(artifactHashes(path.resolve(root))));
}

function readBaseGraphDigest(root: string): string | null {
  const basePath = path.join(root, "base.json");
  if (!existsSync(basePath)) return null;
  return semanticGraphDigest(ReadOnlyBaseZ.parse(JSON.parse(readFileSync(basePath, "utf8"))));
}

function buildDir(bookDir: string): string {
  return path.join(bookDir, ".build");
}

function transactionRoot(bookDir: string): string {
  return path.join(buildDir(bookDir), "hybrid-foundation-transactions");
}

function transactionDir(bookDir: string, transactionId: string): string {
  return path.join(transactionRoot(bookDir), transactionId);
}

function journalCandidates(root: string): string[] {
  return ["journal.json", "journal.next.json", "journal.previous.json"].map((name) => path.join(root, name));
}

function parseJournal(file: string): HybridFoundationApplyJournal | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as HybridFoundationApplyJournal;
    if (value.version !== "hybrid_foundation_apply_transaction.v1"
      || !Number.isInteger(value.revision)
      || !value.transaction_id
      || !value.phase) return null;
    return value;
  } catch {
    return null;
  }
}

function readJournal(root: string): HybridFoundationApplyJournal {
  const journals = journalCandidates(root)
    .map(parseJournal)
    .filter((value): value is HybridFoundationApplyJournal => value !== null)
    .sort((left, right) => right.revision - left.revision);
  if (!journals[0]) throw new Error(`hybrid foundation transaction journal is unreadable: ${root}`);
  return journals[0];
}

function writeJournal(root: string, journal: HybridFoundationApplyJournal): HybridFoundationApplyJournal {
  const current = parseJournal(path.join(root, "journal.json"));
  const next = { ...journal, revision: Math.max(journal.revision, current?.revision ?? 0) + 1 };
  const main = path.join(root, "journal.json");
  const pending = path.join(root, "journal.next.json");
  const previous = path.join(root, "journal.previous.json");
  writeFileSync(pending, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  rmSync(previous, { force: true });
  if (existsSync(main)) renameSync(main, previous);
  renameSync(pending, main);
  rmSync(previous, { force: true });
  return next;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withBookLock<T>(bookDir: string, action: () => T): T {
  const resolved = path.resolve(bookDir);
  if (activeBookLocks.has(resolved)) throw new Error(`hybrid foundation apply is already locked for book: ${resolved}`);
  mkdirSync(buildDir(resolved), { recursive: true });
  const lockDir = path.join(buildDir(resolved), "hybrid-foundation-apply.lock");
  if (existsSync(lockDir)) {
    let ownerPid = -1;
    try {
      ownerPid = (JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")) as { pid?: number }).pid ?? -1;
    } catch {
      ownerPid = -1;
    }
    if (ownerPid > 0 && ownerPid !== process.pid && pidIsAlive(ownerPid)) {
      throw new Error(`hybrid foundation apply is already locked for book: ${resolved}`);
    }
    rmSync(lockDir, { recursive: true, force: true });
  }
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
  activeBookLocks.add(resolved);
  try {
    return action();
  } finally {
    activeBookLocks.delete(resolved);
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function moveArtifact(sourceRoot: string, targetRoot: string, relativePath: HybridFoundationArtifactPath): void {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(source, target);
}

function validateCurrentSet(
  root: string,
  expected: ArtifactHashes,
  expectedGraphDigest: string,
  validate: (root: string) => void,
): void {
  const current = artifactHashes(root);
  if (!hashesEqual(current, expected)) throw new Error("official hybrid foundation artifact hashes differ from the staged set");
  validate(root);
  if (readBaseGraphDigest(root) !== expectedGraphDigest) {
    throw new Error("semantic graph digest changed during hybrid foundation application");
  }
}

function rollbackTransaction(
  bookDir: string,
  root: string,
  journal: HybridFoundationApplyJournal,
  validate: (root: string) => void,
): HybridFoundationApplyJournal {
  const stageDir = path.join(root, "stage");
  const backupDir = path.join(root, "backup");
  const abandonedDir = path.join(root, "abandoned-new");
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(abandonedDir, { recursive: true });

  for (const relativePath of [...HYBRID_FOUNDATION_ARTIFACT_PATHS].reverse()) {
    const officialPath = path.join(bookDir, relativePath);
    const backupPath = path.join(backupDir, relativePath);
    const officialHash = existsSync(officialPath) ? digestFilesystemPath(officialPath, relativePath) : null;
    const backupHash = existsSync(backupPath) ? digestFilesystemPath(backupPath, relativePath) : null;
    const oldHash = journal.old_hashes[relativePath];
    const newHash = journal.new_hashes[relativePath];

    if (oldHash === null) {
      if (officialHash !== null) {
        if (officialHash !== newHash) throw new Error(`cannot recover unknown official artifact: ${relativePath}`);
        const abandonedPath = path.join(abandonedDir, relativePath);
        mkdirSync(path.dirname(abandonedPath), { recursive: true });
        rmSync(abandonedPath, { recursive: true, force: true });
        renameSync(officialPath, abandonedPath);
      }
      continue;
    }
    if (officialHash === oldHash) continue;
    if (officialHash !== null && officialHash !== newHash) {
      throw new Error(`cannot recover unknown official artifact: ${relativePath}`);
    }
    if (backupHash !== oldHash) throw new Error(`hybrid foundation backup is missing or corrupt: ${relativePath}`);
    if (officialHash !== null) {
      const abandonedPath = path.join(abandonedDir, relativePath);
      mkdirSync(path.dirname(abandonedPath), { recursive: true });
      rmSync(abandonedPath, { recursive: true, force: true });
      renameSync(officialPath, abandonedPath);
    }
    moveArtifact(backupDir, bookDir, relativePath);
  }

  const restored = artifactHashes(bookDir);
  if (!hashesEqual(restored, journal.old_hashes)) {
    throw new Error(`hybrid foundation rollback did not restore transaction ${journal.transaction_id}`);
  }
  if (completeArtifactSet(restored)) validate(bookDir);
  if (readBaseGraphDigest(bookDir) !== journal.old_graph_digest) {
    throw new Error("semantic graph digest changed during hybrid foundation rollback");
  }
  const rolledBack = writeJournal(root, { ...journal, phase: "rolled_back" });
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
  rmSync(abandonedDir, { recursive: true, force: true });
  return rolledBack;
}

function recoverTransactionsLocked(
  bookDir: string,
  validate: (root: string) => void,
): HybridFoundationRecoveryResult[] {
  const root = transactionRoot(bookDir);
  if (!existsSync(root)) return [];
  const results: HybridFoundationRecoveryResult[] = [];
  for (const name of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    const currentRoot = path.join(root, name);
    if (!lstatSync(currentRoot).isDirectory()) continue;
    const journal = readJournal(currentRoot);
    if (journal.phase === "committed" || journal.phase === "rolled_back") continue;
    if (journal.phase === "validated") {
      try {
        validateCurrentSet(bookDir, journal.new_hashes, journal.new_graph_digest, validate);
        writeJournal(currentRoot, { ...journal, phase: "committed" });
        rmSync(path.join(currentRoot, "stage"), { recursive: true, force: true });
        results.push({ transaction_id: journal.transaction_id, outcome: "committed" });
        continue;
      } catch {
        // A validated journal only commits if the complete new set still matches.
      }
    }
    rollbackTransaction(bookDir, currentRoot, journal, validate);
    results.push({ transaction_id: journal.transaction_id, outcome: "rolled_back" });
  }
  return results;
}

export function recoverHybridFoundationArtifactApplications(
  options: RecoverHybridFoundationArtifactApplicationsOptions,
): HybridFoundationRecoveryResult[] {
  const bookDir = path.resolve(options.book_dir);
  return withBookLock(bookDir, () => recoverTransactionsLocked(bookDir, options.validate_artifact_set));
}

export function applyHybridFoundationArtifactSet(
  options: ApplyHybridFoundationArtifactSetOptions,
): HybridFoundationArtifactApplyResult {
  const bookDir = path.resolve(options.book_dir);
  const candidateDir = path.resolve(options.candidate_dir);
  return withBookLock(bookDir, () => {
    recoverTransactionsLocked(bookDir, options.validate_artifact_set);
    const validateCandidate = options.validate_candidate_artifact_set ?? options.validate_artifact_set;
    validateCandidate(candidateDir);
    const newHashes = artifactHashes(candidateDir);
    assertCompleteArtifactSet(newHashes, "candidate");
    const newGraphDigest = readBaseGraphDigest(candidateDir);
    if (!newGraphDigest) throw new Error("candidate base.json is missing");

    const oldHashes = artifactHashes(bookDir);
    if (hashesEqual(oldHashes, newHashes)) {
      validateCurrentSet(bookDir, newHashes, newGraphDigest, validateCandidate);
      return {
        status: "already_current",
        transaction_id: null,
        backup_dir: null,
        artifact_hashes: newHashes,
        semantic_graph_digest: newGraphDigest,
      };
    }
    const oldGraphDigest = readBaseGraphDigest(bookDir);
    if (oldGraphDigest && oldGraphDigest !== newGraphDigest) {
      throw new Error("candidate does not preserve the official semantic graph digest");
    }

    const transactionId = options.transaction_id ?? randomUUID();
    if (!/^[A-Za-z0-9._-]+$/u.test(transactionId)) throw new Error("hybrid foundation transaction id is invalid");
    const root = transactionDir(bookDir, transactionId);
    if (existsSync(root)) throw new Error(`hybrid foundation transaction already exists: ${transactionId}`);
    const stageDir = path.join(root, "stage");
    const backupDir = path.join(root, "backup");
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    let journal = writeJournal(root, {
      version: "hybrid_foundation_apply_transaction.v1",
      revision: 0,
      transaction_id: transactionId,
      phase: "preparing",
      old_hashes: oldHashes,
      new_hashes: newHashes,
      old_graph_digest: oldGraphDigest,
      new_graph_digest: newGraphDigest,
      old_moved: [],
      new_moved: [],
    });

    try {
      for (const relativePath of HYBRID_FOUNDATION_ARTIFACT_PATHS) {
        cpSync(path.join(candidateDir, relativePath), path.join(stageDir, relativePath), {
          recursive: true,
          errorOnExist: true,
        });
      }
      validateCandidate(stageDir);
      if (!hashesEqual(artifactHashes(stageDir), newHashes)) {
        throw new Error("staged hybrid foundation artifact hashes differ from the candidate");
      }
      journal = writeJournal(root, { ...journal, phase: "prepared" });
      options.fault_injector?.("after_prepare");

      for (const relativePath of HYBRID_FOUNDATION_ARTIFACT_PATHS) {
        if (oldHashes[relativePath] === null) continue;
        moveArtifact(bookDir, backupDir, relativePath);
        options.fault_injector?.(`after_move_old:${relativePath}`);
        journal = writeJournal(root, {
          ...journal,
          old_moved: [...journal.old_moved, relativePath],
        });
      }
      journal = writeJournal(root, { ...journal, phase: "old_moved" });

      for (const relativePath of HYBRID_FOUNDATION_ARTIFACT_PATHS) {
        moveArtifact(stageDir, bookDir, relativePath);
        options.fault_injector?.(`after_move_new:${relativePath}`);
        journal = writeJournal(root, {
          ...journal,
          new_moved: [...journal.new_moved, relativePath],
        });
      }
      journal = writeJournal(root, { ...journal, phase: "new_moved" });
      options.fault_injector?.("before_validate_official");
      validateCurrentSet(bookDir, newHashes, newGraphDigest, validateCandidate);
      options.fault_injector?.("after_validate_official");
      journal = writeJournal(root, { ...journal, phase: "validated" });
      options.fault_injector?.("after_mark_validated");
      journal = writeJournal(root, { ...journal, phase: "committed" });
      rmSync(stageDir, { recursive: true, force: true });
      return {
        status: "applied",
        transaction_id: transactionId,
        backup_dir: backupDir,
        artifact_hashes: newHashes,
        semantic_graph_digest: newGraphDigest,
      };
    } catch (error) {
      if (options.recover_on_error !== false) {
        const current = readJournal(root);
        if (current.phase !== "committed" && current.phase !== "rolled_back") {
          if (current.phase === "validated") {
            validateCurrentSet(bookDir, current.new_hashes, current.new_graph_digest, validateCandidate);
            writeJournal(root, { ...current, phase: "committed" });
          } else {
            rollbackTransaction(bookDir, root, current, options.validate_artifact_set);
          }
        }
      }
      throw error;
    }
  });
}

export function sameLidIdentity(left: ReadOnlyBase, right: ReadOnlyBase): boolean {
  return JSON.stringify(left.lid_nodes.map((node) => node.lid))
    === JSON.stringify(right.lid_nodes.map((node) => node.lid));
}

export function semanticGraphDigest(base: ReadOnlyBase): string {
  return createHash("sha256")
    .update(JSON.stringify({
      graph_nodes: base.graph_nodes,
      graph_edges: base.graph_edges,
    }))
    .digest("hex");
}

export function validateSemanticGraph(base: ReadOnlyBase, candidateLids: Set<string>): void {
  const graphIds = new Set<string>();
  for (const node of base.graph_nodes) {
    if (graphIds.has(node.id)) {
      throw new Error(`duplicate semantic graph node id: ${node.id}`);
    }
    graphIds.add(node.id);
    for (const lid of node.occurrences) {
      if (!candidateLids.has(lid)) {
        throw new Error(`semantic graph anchor does not exist in candidate LIDs: ${node.id} -> ${lid}`);
      }
    }
    if (node.source_lid && !candidateLids.has(node.source_lid)) {
      throw new Error(`semantic graph anchor does not exist in candidate LIDs: ${node.id} -> ${node.source_lid}`);
    }
  }
  for (const edge of base.graph_edges) {
    if (!graphIds.has(edge.source) || !graphIds.has(edge.target)) {
      throw new Error(`semantic graph edge endpoint is missing: ${edge.source} -> ${edge.target}`);
    }
  }
}

export function mergeHybridFoundationBase(
  official: ReadOnlyBase,
  candidate: ReadOnlyBase,
): ReadOnlyBase {
  if (official.book_id !== candidate.book_id) {
    throw new Error(`hybrid foundation book id mismatch: ${official.book_id} != ${candidate.book_id}`);
  }
  if (!sameLidIdentity(official, candidate)) {
    throw new Error("official and candidate LID identity differ");
  }
  const candidateLids = new Set(candidate.lid_nodes.map((node) => node.lid));
  if (candidateLids.size !== candidate.lid_nodes.length) {
    throw new Error("candidate LID identity contains duplicates");
  }
  validateSemanticGraph(official, candidateLids);
  return ReadOnlyBaseZ.parse({
    ...candidate,
    graph_nodes: official.graph_nodes,
    graph_edges: official.graph_edges,
  });
}
