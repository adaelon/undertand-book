import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  validateAutomaticBuildPolicyMigrationReceipt,
  type AutomaticBuildPolicyMigrationReceiptV2,
} from "./automatic-build-policy-generation";
import type { SemanticBuildStage } from "./semantic-artifact";
import {
  buildAutomaticBuildSnapshot,
  type AutomaticBuildStage,
  type AutomaticBuildTarget,
  type BuildTargetRefV2,
} from "./build-orchestrator";

export type AutomaticBuildMigrationMode = "legacy_resume" | "v2_rebuild";

export interface AutomaticBuildLegacyArtifactAuditV1 {
  path: string;
  stage: AutomaticBuildStage;
  format: "legacy_v1" | "v2" | "invalid_json";
  work_unit_id: string;
  source_freshness: "fresh" | "stale" | "unknown";
  schema_status: "shape_valid" | "shape_invalid" | "unknown";
  policy_gap: "none" | "legacy_policy_unknown" | "invalid_json";
  sha256: string;
  size_bytes: number;
}

export interface AutomaticBuildLegacyAuditV1 {
  version: "automatic_build_legacy_audit.v1";
  target_ref: BuildTargetRefV2;
  artifacts: AutomaticBuildLegacyArtifactAuditV1[];
  legacy_artifacts: number;
  v2_artifacts: number;
  invalid_artifacts: number;
  source_fresh_artifacts: number;
  source_stale_artifacts: number;
  source_unknown_artifacts: number;
  schema_valid_artifacts: number;
  schema_invalid_artifacts: number;
  policy_status: "none" | "legacy_policy_unknown" | "v2_policy_bound" | "mixed_policy";
  legacy_resume_allowed: boolean;
  recommended_mode: AutomaticBuildMigrationMode | null;
  digest: string;
}

export interface AutomaticBuildMigrationDecisionV1 {
  version: "automatic_build_migration_decision.v1";
  target_ref: BuildTargetRefV2;
  mode: AutomaticBuildMigrationMode;
  selected_at: string;
  audit_digest: string;
  legacy_snapshot_path?: string;
}

const STAGE_DIRECTORIES: Array<[AutomaticBuildStage, string]> = [
  ["pass1", "pass1"],
  ["paper_metadata", "paper-metadata"],
  ["paper_lexicon", "paper-lexicon"],
  ["profile_sidecar", "profile-sidecar"],
  ["pass2", "pass2"],
  ["book_structure", "book-structure"],
];

export function automaticBuildLegacyStageArtifactPath(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  workUnitId: string,
): string {
  if (!workUnitId || Buffer.byteLength(workUnitId, "utf8") > 512) {
    throw new Error("legacy artifact work_unit_id must be a non-empty bounded string");
  }
  const relativeDir = STAGE_DIRECTORIES.find(([candidate]) => candidate === stage)?.[1];
  if (!relativeDir) throw new Error(`unsupported legacy artifact stage: ${stage}`);
  const stageRoot = path.join(target.workspace_dir, ".build", relativeDir);
  const insideStageRoot = (candidate: string): string => {
    const relative = path.relative(path.resolve(stageRoot), path.resolve(candidate));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("legacy artifact work_unit_id escapes its stage directory");
    }
    return candidate;
  };
  if (stage === "book_structure") {
    if (workUnitId === "stitch") return insideStageRoot(path.join(stageRoot, "stitch.json"));
    if (workUnitId.startsWith("unit:")) {
      return insideStageRoot(path.join(stageRoot, "units", `${workUnitId.slice("unit:".length)}.json`));
    }
  }
  if (workUnitId.includes("/") || workUnitId.includes("\\") || workUnitId === "." || workUnitId === "..") {
    throw new Error("legacy artifact work_unit_id must not contain path separators");
  }
  return insideStageRoot(path.join(stageRoot, `${workUnitId}.json`));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursive(item));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(item);
  }
  return files.sort();
}

function descriptorInputHashesFromMigrationReceipts(
  target: AutomaticBuildTarget,
): Map<string, Set<string>> {
  const hashes = new Map<string, Set<string>>();
  const migrationRoot = path.join(target.workspace_dir, ".build", "automatic-build", "v4", "migrations");
  for (const file of filesRecursive(migrationRoot)) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (value.version !== "automatic_build_policy_migration_receipt.v2"
        || typeof value.stage !== "string"
        || typeof value.work_unit_id !== "string"
        || typeof value.current_input_hash !== "string") {
        continue;
      }
      const targetRef = value.target_ref;
      if (!targetRef || typeof targetRef !== "object") continue;
      const receiptTarget = targetRef as Record<string, unknown>;
      if (receiptTarget.version !== target.target_ref.version
        || typeof receiptTarget.workspace_dir !== "string"
        || path.resolve(receiptTarget.workspace_dir) !== path.resolve(target.target_ref.workspace_dir)
        || receiptTarget.book_id !== target.target_ref.book_id
        || receiptTarget.profile_id !== target.target_ref.profile_id
        || receiptTarget.input_fingerprint !== target.target_ref.input_fingerprint
        || !STAGE_DIRECTORIES.some(([candidate]) => candidate === value.stage)
        || !value.work_unit_id
        || Buffer.byteLength(value.work_unit_id, "utf8") > 512
        || !/^[a-f0-9]{64}$/u.test(value.current_input_hash)) {
        continue;
      }
      const receipt = validateAutomaticBuildPolicyMigrationReceipt(
        target,
        value.stage as SemanticBuildStage,
        value as unknown as AutomaticBuildPolicyMigrationReceiptV2,
      );
      if (receipt.current_route !== "model" || !receipt.current_input_hash) continue;
      const key = `${receipt.stage}:${receipt.work_unit_id}`;
      const candidates = hashes.get(key) ?? new Set<string>();
      candidates.add(receipt.current_input_hash);
      hashes.set(key, candidates);
    } catch {
      // Invalid or unrelated private receipts cannot establish descriptor identity.
    }
  }
  return hashes;
}

function inferWorkUnitId(stage: AutomaticBuildStage, stageRoot: string, file: string): string {
  const relative = path.relative(stageRoot, file).replaceAll("\\", "/").replace(/\.json$/, "");
  if (stage !== "book_structure") return path.basename(relative);
  if (relative === "stitch") return "stitch";
  return relative.startsWith("units/") ? `unit:${relative.slice("units/".length)}` : relative;
}

function legacyShapeValid(stage: AutomaticBuildStage, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.content_hash !== "string") return false;
  if (stage === "pass1") return Array.isArray(record.nodes) && Array.isArray(record.edges);
  if (stage === "paper_metadata") return Boolean(record.metadata && typeof record.metadata === "object");
  if (stage === "paper_lexicon") return Array.isArray(record.entries);
  if (stage === "profile_sidecar") return Array.isArray(record.discourse_items) && Array.isArray(record.formula_semantics);
  if (stage === "pass2") return Boolean(record.output && typeof record.output === "object");
  if (stage === "book_structure") return Boolean(record.output && typeof record.output === "object");
  return false;
}

export function auditAutomaticBuildLegacy(
  target: AutomaticBuildTarget,
  stage?: AutomaticBuildStage,
  options: { inspect_current_descriptors?: boolean } = {},
): AutomaticBuildLegacyAuditV1 {
  const artifacts: AutomaticBuildLegacyArtifactAuditV1[] = [];
  const descriptorHashes = descriptorInputHashesFromMigrationReceipts(target);
  if (options.inspect_current_descriptors !== false) {
    try {
      const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
      for (const stageState of snapshot.stages) {
        for (const unit of stageState.work_units ?? []) {
          const key = `${stageState.stage}:${unit.work_unit_id}`;
          const candidates = descriptorHashes.get(key) ?? new Set<string>();
          candidates.add(unit.input_hash);
          descriptorHashes.set(key, candidates);
        }
      }
    } catch {
      // Audit remains useful with unknown freshness when a legacy target cannot build a current descriptor plan.
    }
  }
  const descriptorByStageAndId = new Map(
    [...descriptorHashes.entries()]
      .filter(([, candidates]) => candidates.size === 1)
      .map(([key, candidates]) => [key, { input_hash: [...candidates][0] }] as const),
  );
  for (const [candidateStage, relativeDir] of STAGE_DIRECTORIES) {
    if (stage && candidateStage !== stage) continue;
    const stageRoot = path.join(target.workspace_dir, ".build", relativeDir);
    for (const file of filesRecursive(stageRoot)) {
      const bytes = readFileSync(file);
      let format: AutomaticBuildLegacyArtifactAuditV1["format"] = "invalid_json";
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
        format = (parsed as { version?: unknown })?.version === "semantic_task_artifact.v2" ? "v2" : "legacy_v1";
      } catch {
        // Invalid JSON is reported,never repaired or deleted here.
      }
      const workUnitId = inferWorkUnitId(candidateStage, stageRoot, file);
      const descriptor = descriptorByStageAndId.get(`${candidateStage}:${workUnitId}`);
      const contentHash = parsed && typeof parsed === "object"
        ? format === "v2"
          ? (parsed as { input_hash?: unknown }).input_hash
          : (parsed as { content_hash?: unknown }).content_hash
        : undefined;
      const sourceFreshness = typeof contentHash !== "string" || !descriptor
        ? "unknown" as const
        : contentHash === descriptor.input_hash
          ? "fresh" as const
          : "stale" as const;
      const schemaStatus = format === "invalid_json"
        ? "shape_invalid" as const
        : format === "v2" || legacyShapeValid(candidateStage, parsed)
          ? "shape_valid" as const
          : "shape_invalid" as const;
      artifacts.push({
        path: path.relative(target.workspace_dir, file).replaceAll("\\", "/"),
        stage: candidateStage,
        format,
        work_unit_id: workUnitId,
        source_freshness: sourceFreshness,
        schema_status: schemaStatus,
        policy_gap: format === "v2" ? "none" : format === "legacy_v1" ? "legacy_policy_unknown" : "invalid_json",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      });
    }
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const legacy = artifacts.filter((item) => item.format === "legacy_v1").length;
  const v2 = artifacts.filter((item) => item.format === "v2").length;
  const invalid = artifacts.filter((item) => item.format === "invalid_json").length;
  const sourceFresh = artifacts.filter((item) => item.source_freshness === "fresh").length;
  const sourceStale = artifacts.filter((item) => item.source_freshness === "stale").length;
  const sourceUnknown = artifacts.filter((item) => item.source_freshness === "unknown").length;
  const schemaValid = artifacts.filter((item) => item.schema_status === "shape_valid").length;
  const schemaInvalid = artifacts.filter((item) => item.schema_status === "shape_invalid").length;
  const policyStatus = legacy && v2
    ? "mixed_policy" as const
    : legacy
      ? "legacy_policy_unknown" as const
      : v2
        ? "v2_policy_bound" as const
        : "none" as const;
  const core = {
    version: "automatic_build_legacy_audit.v1" as const,
    target_ref: target.target_ref,
    artifacts,
    legacy_artifacts: legacy,
    v2_artifacts: v2,
    invalid_artifacts: invalid,
    source_fresh_artifacts: sourceFresh,
    source_stale_artifacts: sourceStale,
    source_unknown_artifacts: sourceUnknown,
    schema_valid_artifacts: schemaValid,
    schema_invalid_artifacts: schemaInvalid,
    policy_status: policyStatus,
    legacy_resume_allowed: legacy > 0 && invalid === 0 && sourceStale === 0 && sourceUnknown === 0 && schemaInvalid === 0,
    recommended_mode: legacy || invalid ? "v2_rebuild" as const : null,
  };
  return { ...core, digest: sha256(JSON.stringify(core)) };
}

function decisionPath(target: AutomaticBuildTarget): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "v2", "migration", "decision.json");
}

function snapshotLegacy(target: AutomaticBuildTarget, audit: AutomaticBuildLegacyAuditV1): string | undefined {
  const legacy = audit.artifacts.filter((item) => item.format !== "v2");
  if (!legacy.length) return undefined;
  const root = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "legacy-snapshots");
  const finalDir = path.join(root, audit.digest);
  if (existsSync(path.join(finalDir, "manifest.json"))) return finalDir;
  mkdirSync(root, { recursive: true });
  const tempDir = `${finalDir}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(tempDir, { recursive: true });
  try {
    for (const artifact of legacy) {
      const source = path.join(target.workspace_dir, artifact.path);
      const destination = path.join(tempDir, artifact.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    writeFileSync(path.join(tempDir, "manifest.json"), `${JSON.stringify({
      version: "automatic_build_legacy_snapshot.v1",
      target_ref: target.target_ref,
      audit_digest: audit.digest,
      artifacts: legacy,
    }, null, 2)}\n`, "utf8");
    try {
      renameSync(tempDir, finalDir);
    } catch (error) {
      if (!existsSync(finalDir)) throw error;
      rmSync(tempDir, { recursive: true, force: true });
    }
    return finalDir;
  } catch (error) {
    if (existsSync(tempDir) && statSync(tempDir).isDirectory()) rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function readAutomaticBuildMigrationDecision(
  target: AutomaticBuildTarget,
): AutomaticBuildMigrationDecisionV1 | undefined {
  const file = decisionPath(target);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as AutomaticBuildMigrationDecisionV1;
  if (value.version !== "automatic_build_migration_decision.v1") throw new Error(`invalid migration decision: ${file}`);
  if (path.resolve(value.target_ref.workspace_dir) !== path.resolve(target.target_ref.workspace_dir)
    || value.target_ref.book_id !== target.target_ref.book_id
    || value.target_ref.profile_id !== target.target_ref.profile_id
    || value.target_ref.input_fingerprint !== target.target_ref.input_fingerprint) {
    throw new Error(`migration decision target mismatch: ${file}`);
  }
  return value;
}

export function selectAutomaticBuildMigrationMode(
  target: AutomaticBuildTarget,
  mode: AutomaticBuildMigrationMode,
  selectedAt = new Date().toISOString(),
): AutomaticBuildMigrationDecisionV1 {
  if (!Number.isFinite(Date.parse(selectedAt))) throw new Error("selected_at must be an ISO timestamp");
  const audit = auditAutomaticBuildLegacy(target);
  if (mode === "legacy_resume" && !audit.legacy_resume_allowed) {
    throw new Error(
      "legacy_resume requires source-fresh, shape-valid legacy artifacts with known descriptor identity "
      + `(source_stale_artifacts=${audit.source_stale_artifacts}, `
      + `source_unknown_artifacts=${audit.source_unknown_artifacts}, `
      + `schema_invalid_artifacts=${audit.schema_invalid_artifacts}, `
      + `invalid_artifacts=${audit.invalid_artifacts})`,
    );
  }
  const decision: AutomaticBuildMigrationDecisionV1 = {
    version: "automatic_build_migration_decision.v1",
    target_ref: target.target_ref,
    mode,
    selected_at: selectedAt,
    audit_digest: audit.digest,
    ...(mode === "v2_rebuild" ? { legacy_snapshot_path: snapshotLegacy(target, audit) } : {}),
  };
  const file = decisionPath(target);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return decision;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const existing = readAutomaticBuildMigrationDecision(target)!;
    if (existing.mode !== mode || existing.audit_digest !== audit.digest) {
      throw new Error(`migration decision is already frozen: ${file}`);
    }
    return existing;
  }
}
