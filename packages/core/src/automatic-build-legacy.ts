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
): AutomaticBuildLegacyAuditV1 {
  const artifacts: AutomaticBuildLegacyArtifactAuditV1[] = [];
  let descriptorByStageAndId = new Map<string, { input_hash: string }>();
  try {
    const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
    descriptorByStageAndId = new Map(snapshot.stages.flatMap((stageState) =>
      (stageState.work_units ?? []).map((unit) => [`${stageState.stage}:${unit.work_unit_id}`, unit] as const),
    ));
  } catch {
    // Audit remains useful with unknown freshness when a legacy target cannot build a current descriptor plan.
  }
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
    throw new Error("legacy_resume requires source-fresh, shape-valid legacy artifacts with known descriptor identity");
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
