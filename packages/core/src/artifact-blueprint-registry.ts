import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1,
  computeArtifactBlueprintDigest,
  validateArtifactBlueprintV1,
  validatePlannerOneOffArtifactBlueprintV1,
  type ArtifactBlueprintV1,
} from "./artifact-blueprint";
import { canonicalBuildJson, validatePathSafeBuildId } from "./build-intent";

const REGISTRY_DIRECTORY = "artifact-blueprint-registry";
const REGISTRY_VERSION_DIRECTORY = "v1";
const MAX_CANDIDATE_BYTES = 512 * 1024;
const MAX_CANDIDATES = 4_096;
const MAX_USAGE_EVENTS_PER_CANDIDATE = 100_000;

export interface ArtifactBlueprintRegistryEntryV1 {
  version: "artifact_blueprint_registry_entry.v1";
  source: "system" | "user_private";
  blueprint: ArtifactBlueprintV1;
  digest: string;
  status: "active" | "retired";
  usage_count: number;
  created_at?: string;
  retired_at?: string;
  last_used_at?: string;
}

export interface ArtifactBlueprintRegistryListV1 {
  version: "artifact_blueprint_registry_list.v1";
  system_presets: ArtifactBlueprintRegistryEntryV1[];
  user_candidates: ArtifactBlueprintRegistryEntryV1[];
}

export interface ArtifactBlueprintCandidateUpsertResultV1 {
  version: "artifact_blueprint_candidate_upsert_result.v1";
  blueprint_id: string;
  blueprint_version: string;
  digest: string;
  disposition: "created" | "existing";
}

export interface ArtifactBlueprintCandidateRetireResultV1 {
  version: "artifact_blueprint_candidate_retire_result.v1";
  blueprint_id: string;
  blueprint_version: string;
  digest: string;
  status: "retired";
  retired_at: string;
  disposition: "created" | "existing";
}

export interface ArtifactBlueprintUsageResultV1 {
  version: "artifact_blueprint_usage_result.v1";
  blueprint_id: string;
  blueprint_version: string;
  usage_id: string;
  disposition: "created" | "existing";
  usage_count: number;
  last_used_at: string;
}

export interface ArtifactBlueprintResolutionV1 {
  version: "artifact_blueprint_resolution.v1";
  source: "system" | "user_private" | "one_off";
  blueprint: ArtifactBlueprintV1;
  digest: string;
}

interface StoredCandidateV1 {
  version: "artifact_blueprint_candidate.v1";
  blueprint: ArtifactBlueprintV1;
  digest: string;
  created_at: string;
}

interface StoredRetirementV1 {
  version: "artifact_blueprint_retirement.v1";
  blueprint_id: string;
  blueprint_version: string;
  digest: string;
  retired_at: string;
}

interface StoredUsageV1 {
  version: "artifact_blueprint_usage.v1";
  usage_id: string;
  blueprint_id: string;
  blueprint_version: string;
  digest: string;
  used_at: string;
}

type JsonObject = Record<string, unknown>;

function requireObject(input: unknown, field: string): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${field} must be an object`);
  }
  return input as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalBuildJson(actual) !== canonicalBuildJson(expected)) {
    throw new Error(`${field} has unrecognized or missing keys`);
  }
}

function timestamp(input: unknown, field: string): string {
  if (typeof input !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input)) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function serializedBody(input: unknown, maximumBytes: number, field: string): string {
  const body = `${canonicalBuildJson(input)}\n`;
  if (Buffer.byteLength(body, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  }
  return body;
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

function secureDirectory(root: string, segments: readonly string[], create: boolean): string {
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(cursor, segments[index]);
    if (!existsSync(next)) {
      if (!create) return path.join(next, ...segments.slice(index + 1));
      mkdirSync(next, { mode: 0o700 });
    }
    const metadata = lstatSync(next);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("artifact blueprint registry path must be a real directory without symlinks");
    }
    const real = realpathSync.native(next);
    if (isOutside(path.relative(root, real))) {
      throw new Error("artifact blueprint registry path escapes private_root");
    }
    cursor = real;
  }
  return cursor;
}

function registryDirectory(privateRootInput: string, leaf: "candidates" | "retirements" | "usage", create: boolean): string {
  const root = privateRoot(privateRootInput);
  return secureDirectory(root, [REGISTRY_DIRECTORY, REGISTRY_VERSION_DIRECTORY, leaf], create);
}

function identityDirectory(
  privateRootInput: string,
  leaf: "candidates" | "retirements" | "usage",
  blueprintId: string,
  create: boolean,
): string {
  const safeId = validatePathSafeBuildId(blueprintId, "blueprint_id");
  const base = registryDirectory(privateRootInput, leaf, create);
  if (!existsSync(base) && !create) return path.join(base, safeId);
  const root = privateRoot(privateRootInput);
  const relative = path.relative(root, base);
  return secureDirectory(root, [...relative.split(path.sep), safeId], create);
}

function candidateFile(privateRootInput: string, blueprintId: string, blueprintVersion: string, create: boolean): string {
  const safeVersion = validatePathSafeBuildId(blueprintVersion, "blueprint_version");
  return path.join(identityDirectory(privateRootInput, "candidates", blueprintId, create), `${safeVersion}.json`);
}

function retirementFile(privateRootInput: string, blueprintId: string, blueprintVersion: string, create: boolean): string {
  const safeVersion = validatePathSafeBuildId(blueprintVersion, "blueprint_version");
  return path.join(identityDirectory(privateRootInput, "retirements", blueprintId, create), `${safeVersion}.json`);
}

function usageDirectory(
  privateRootInput: string,
  blueprintId: string,
  blueprintVersion: string,
  create: boolean,
): string {
  const safeVersion = validatePathSafeBuildId(blueprintVersion, "blueprint_version");
  const idDirectory = identityDirectory(privateRootInput, "usage", blueprintId, create);
  if (!existsSync(idDirectory) && !create) return path.join(idDirectory, safeVersion);
  const root = privateRoot(privateRootInput);
  const relative = path.relative(root, idDirectory);
  return secureDirectory(root, [...relative.split(path.sep), safeVersion], create);
}

function readJsonFile(file: string, maximumBytes: number, field: string): unknown {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${field} must be a real file without symlinks`);
  }
  if (statSync(file).size > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${field} contains invalid JSON`, { cause: error });
  }
}

function parseStoredCandidate(input: unknown): StoredCandidateV1 {
  const value = requireObject(input, "stored ArtifactBlueprint candidate");
  exactKeys(value, ["version", "blueprint", "digest", "created_at"], "stored ArtifactBlueprint candidate");
  if (value.version !== "artifact_blueprint_candidate.v1") {
    throw new Error("unsupported stored ArtifactBlueprint candidate version");
  }
  const blueprint = validateArtifactBlueprintV1(value.blueprint);
  if (blueprint.origin !== "user_private") {
    throw new Error("stored ArtifactBlueprint candidate must have user_private origin");
  }
  const digest = computeArtifactBlueprintDigest(blueprint);
  if (value.digest !== digest) throw new Error("stored ArtifactBlueprint candidate digest mismatch");
  return {
    version: "artifact_blueprint_candidate.v1",
    blueprint,
    digest,
    created_at: timestamp(value.created_at, "stored candidate created_at"),
  };
}

function readStoredCandidate(file: string): StoredCandidateV1 {
  return parseStoredCandidate(readJsonFile(file, MAX_CANDIDATE_BYTES, "ArtifactBlueprint candidate path"));
}

function parseRetirement(input: unknown, candidate: StoredCandidateV1): StoredRetirementV1 {
  const value = requireObject(input, "ArtifactBlueprint retirement");
  exactKeys(
    value,
    ["version", "blueprint_id", "blueprint_version", "digest", "retired_at"],
    "ArtifactBlueprint retirement",
  );
  if (value.version !== "artifact_blueprint_retirement.v1"
    || value.blueprint_id !== candidate.blueprint.blueprint_id
    || value.blueprint_version !== candidate.blueprint.blueprint_version
    || value.digest !== candidate.digest) {
    throw new Error("ArtifactBlueprint retirement identity or digest mismatch");
  }
  return {
    version: "artifact_blueprint_retirement.v1",
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    digest: candidate.digest,
    retired_at: timestamp(value.retired_at, "retired_at"),
  };
}

function readRetirement(privateRootInput: string, candidate: StoredCandidateV1): StoredRetirementV1 | undefined {
  const file = retirementFile(
    privateRootInput,
    candidate.blueprint.blueprint_id,
    candidate.blueprint.blueprint_version,
    false,
  );
  if (!existsSync(file)) return undefined;
  return parseRetirement(readJsonFile(file, 16 * 1024, "ArtifactBlueprint retirement path"), candidate);
}

function parseUsage(input: unknown, candidate: StoredCandidateV1): StoredUsageV1 {
  const value = requireObject(input, "ArtifactBlueprint usage");
  exactKeys(
    value,
    ["version", "usage_id", "blueprint_id", "blueprint_version", "digest", "used_at"],
    "ArtifactBlueprint usage",
  );
  if (value.version !== "artifact_blueprint_usage.v1"
    || value.blueprint_id !== candidate.blueprint.blueprint_id
    || value.blueprint_version !== candidate.blueprint.blueprint_version
    || value.digest !== candidate.digest) {
    throw new Error("ArtifactBlueprint usage identity or digest mismatch");
  }
  return {
    version: "artifact_blueprint_usage.v1",
    usage_id: validatePathSafeBuildId(value.usage_id, "usage_id"),
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    digest: candidate.digest,
    used_at: timestamp(value.used_at, "used_at"),
  };
}

function usageSummary(privateRootInput: string, candidate: StoredCandidateV1): {
  usage_count: number;
  last_used_at?: string;
} {
  const directory = usageDirectory(
    privateRootInput,
    candidate.blueprint.blueprint_id,
    candidate.blueprint.blueprint_version,
    false,
  );
  if (!existsSync(directory)) return { usage_count: 0 };
  const names = readdirSync(directory).sort();
  if (names.length > MAX_USAGE_EVENTS_PER_CANDIDATE) {
    throw new Error(`ArtifactBlueprint usage exceeds ${MAX_USAGE_EVENTS_PER_CANDIDATE} events`);
  }
  let lastUsedAt: string | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) throw new Error("ArtifactBlueprint usage directory contains an unknown entry");
    const event = parseUsage(
      readJsonFile(path.join(directory, name), 16 * 1024, "ArtifactBlueprint usage path"),
      candidate,
    );
    if (`${event.usage_id}.json` !== name) throw new Error("ArtifactBlueprint usage filename does not match usage_id");
    if (lastUsedAt === undefined || event.used_at > lastUsedAt) lastUsedAt = event.used_at;
  }
  return { usage_count: names.length, ...(lastUsedAt === undefined ? {} : { last_used_at: lastUsedAt }) };
}

function systemEntry(blueprint: ArtifactBlueprintV1, digest: string): ArtifactBlueprintRegistryEntryV1 {
  return {
    version: "artifact_blueprint_registry_entry.v1",
    source: "system",
    blueprint,
    digest,
    status: "active",
    usage_count: 0,
  };
}

function getSystemEntry(blueprintId: string, blueprintVersion: string): ArtifactBlueprintRegistryEntryV1 | undefined {
  for (const entry of Object.values(SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1)) {
    if (entry.blueprint.blueprint_id === blueprintId && entry.blueprint.blueprint_version === blueprintVersion) {
      return systemEntry(entry.blueprint, entry.digest);
    }
  }
  return undefined;
}

function privateEntry(privateRootInput: string, candidate: StoredCandidateV1): ArtifactBlueprintRegistryEntryV1 {
  const retirement = readRetirement(privateRootInput, candidate);
  const usage = usageSummary(privateRootInput, candidate);
  return {
    version: "artifact_blueprint_registry_entry.v1",
    source: "user_private",
    blueprint: candidate.blueprint,
    digest: candidate.digest,
    status: retirement === undefined ? "active" : "retired",
    usage_count: usage.usage_count,
    created_at: candidate.created_at,
    ...(retirement === undefined ? {} : { retired_at: retirement.retired_at }),
    ...(usage.last_used_at === undefined ? {} : { last_used_at: usage.last_used_at }),
  };
}

function findPrivateCandidate(
  privateRootInput: string,
  blueprintId: string,
  blueprintVersion: string,
): StoredCandidateV1 | undefined {
  const file = candidateFile(privateRootInput, blueprintId, blueprintVersion, false);
  if (!existsSync(file)) return undefined;
  const candidate = readStoredCandidate(file);
  if (candidate.blueprint.blueprint_id !== blueprintId
    || candidate.blueprint.blueprint_version !== blueprintVersion) {
    throw new Error("ArtifactBlueprint candidate filename does not match its identity");
  }
  return candidate;
}

function listPrivateCandidates(privateRootInput: string): ArtifactBlueprintRegistryEntryV1[] {
  const directory = registryDirectory(privateRootInput, "candidates", false);
  if (!existsSync(directory)) return [];
  const identities = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const results: ArtifactBlueprintRegistryEntryV1[] = [];
  for (const identity of identities) {
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw new Error("ArtifactBlueprint candidate registry contains a non-directory identity");
    }
    validatePathSafeBuildId(identity.name, "blueprint_id");
    const idDirectory = identityDirectory(privateRootInput, "candidates", identity.name, false);
    const versions = readdirSync(idDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const versionFile of versions) {
      if (versionFile.isSymbolicLink() || !versionFile.isFile() || !versionFile.name.endsWith(".json")) {
        throw new Error("ArtifactBlueprint candidate registry contains an unknown version entry");
      }
      const version = validatePathSafeBuildId(versionFile.name.slice(0, -5), "blueprint_version");
      const candidate = readStoredCandidate(path.join(idDirectory, versionFile.name));
      if (candidate.blueprint.blueprint_id !== identity.name
        || candidate.blueprint.blueprint_version !== version) {
        throw new Error("ArtifactBlueprint candidate filename does not match its identity");
      }
      results.push(privateEntry(privateRootInput, candidate));
      if (results.length > MAX_CANDIDATES) throw new Error(`ArtifactBlueprint registry exceeds ${MAX_CANDIDATES} candidates`);
    }
  }
  return results;
}

export function listArtifactBlueprintRegistryV1(privateRootInput: string): ArtifactBlueprintRegistryListV1 {
  const systemPresets = Object.values(SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1)
    .map((entry) => systemEntry(entry.blueprint, entry.digest))
    .sort((left, right) => left.blueprint.blueprint_id.localeCompare(right.blueprint.blueprint_id));
  return {
    version: "artifact_blueprint_registry_list.v1",
    system_presets: systemPresets,
    user_candidates: listPrivateCandidates(privateRootInput),
  };
}

export function getArtifactBlueprintRegistryEntryV1(
  privateRootInput: string,
  blueprintIdInput: string,
  blueprintVersionInput: string,
): ArtifactBlueprintRegistryEntryV1 {
  const blueprintId = validatePathSafeBuildId(blueprintIdInput, "blueprint_id");
  const blueprintVersion = validatePathSafeBuildId(blueprintVersionInput, "blueprint_version");
  const system = getSystemEntry(blueprintId, blueprintVersion);
  if (system) return system;
  const candidate = findPrivateCandidate(privateRootInput, blueprintId, blueprintVersion);
  if (!candidate) throw new Error("ArtifactBlueprint candidate was not found");
  return privateEntry(privateRootInput, candidate);
}

export function upsertArtifactBlueprintCandidateV1(input: {
  private_root: string;
  blueprint: unknown;
  created_at: string;
}): ArtifactBlueprintCandidateUpsertResultV1 {
  const blueprint = validateArtifactBlueprintV1(input.blueprint);
  if (blueprint.origin !== "user_private") {
    throw new Error("persisted ArtifactBlueprint candidates must have user_private origin");
  }
  if (blueprint.blueprint_id.startsWith("system.")
    || getSystemEntry(blueprint.blueprint_id, blueprint.blueprint_version)) {
    throw new Error("system ArtifactBlueprint identities are reserved");
  }
  const digest = computeArtifactBlueprintDigest(blueprint);
  const candidate: StoredCandidateV1 = {
    version: "artifact_blueprint_candidate.v1",
    blueprint,
    digest,
    created_at: timestamp(input.created_at, "created_at"),
  };
  const file = candidateFile(input.private_root, blueprint.blueprint_id, blueprint.blueprint_version, true);
  const body = serializedBody(candidate, MAX_CANDIDATE_BYTES, "ArtifactBlueprint candidate");
  let disposition: ArtifactBlueprintCandidateUpsertResultV1["disposition"] = "created";
  try {
    writeFileSync(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const stored = readStoredCandidate(file);
    if (stored.blueprint.blueprint_id !== blueprint.blueprint_id
      || stored.blueprint.blueprint_version !== blueprint.blueprint_version
      || stored.digest !== digest) {
      throw new Error("ArtifactBlueprint with the same identity and version conflicts with existing content");
    }
    disposition = "existing";
  }
  return {
    version: "artifact_blueprint_candidate_upsert_result.v1",
    blueprint_id: blueprint.blueprint_id,
    blueprint_version: blueprint.blueprint_version,
    digest,
    disposition,
  };
}

export function retireArtifactBlueprintCandidateV1(input: {
  private_root: string;
  blueprint_id: string;
  blueprint_version: string;
  retired_at: string;
}): ArtifactBlueprintCandidateRetireResultV1 {
  if (getSystemEntry(input.blueprint_id, input.blueprint_version)) {
    throw new Error("system ArtifactBlueprint presets cannot be retired by the private registry");
  }
  const candidate = findPrivateCandidate(input.private_root, input.blueprint_id, input.blueprint_version);
  if (!candidate) throw new Error("ArtifactBlueprint candidate was not found");
  const retirement: StoredRetirementV1 = {
    version: "artifact_blueprint_retirement.v1",
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    digest: candidate.digest,
    retired_at: timestamp(input.retired_at, "retired_at"),
  };
  const file = retirementFile(input.private_root, input.blueprint_id, input.blueprint_version, true);
  const body = serializedBody(retirement, 16 * 1024, "ArtifactBlueprint retirement");
  let disposition: ArtifactBlueprintCandidateRetireResultV1["disposition"] = "created";
  try {
    writeFileSync(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const stored = parseRetirement(
      readJsonFile(file, 16 * 1024, "ArtifactBlueprint retirement path"),
      candidate,
    );
    retirement.retired_at = stored.retired_at;
    disposition = "existing";
  }
  return {
    version: "artifact_blueprint_candidate_retire_result.v1",
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    digest: candidate.digest,
    status: "retired",
    retired_at: retirement.retired_at,
    disposition,
  };
}

export function recordArtifactBlueprintUseV1(input: {
  private_root: string;
  blueprint_id: string;
  blueprint_version: string;
  usage_id: string;
  used_at: string;
}): ArtifactBlueprintUsageResultV1 {
  const candidate = findPrivateCandidate(input.private_root, input.blueprint_id, input.blueprint_version);
  if (!candidate) throw new Error("user-private ArtifactBlueprint candidate was not found");
  const event: StoredUsageV1 = {
    version: "artifact_blueprint_usage.v1",
    usage_id: validatePathSafeBuildId(input.usage_id, "usage_id"),
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    digest: candidate.digest,
    used_at: timestamp(input.used_at, "used_at"),
  };
  const directory = usageDirectory(input.private_root, input.blueprint_id, input.blueprint_version, true);
  const file = path.join(directory, `${event.usage_id}.json`);
  const body = serializedBody(event, 16 * 1024, "ArtifactBlueprint usage");
  let disposition: ArtifactBlueprintUsageResultV1["disposition"] = "created";
  try {
    writeFileSync(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const stored = parseUsage(readJsonFile(file, 16 * 1024, "ArtifactBlueprint usage path"), candidate);
    if (canonicalBuildJson(stored) !== canonicalBuildJson(event)) {
      throw new Error(`ArtifactBlueprint usage_id conflicts with existing content: ${event.usage_id}`);
    }
    disposition = "existing";
  }
  const summary = usageSummary(input.private_root, candidate);
  return {
    version: "artifact_blueprint_usage_result.v1",
    blueprint_id: candidate.blueprint.blueprint_id,
    blueprint_version: candidate.blueprint.blueprint_version,
    usage_id: event.usage_id,
    disposition,
    usage_count: summary.usage_count,
    last_used_at: summary.last_used_at!,
  };
}

export function resolveArtifactBlueprintV1(input: {
  private_root: string;
  blueprint_id: string;
  blueprint_version: string;
  one_off?: unknown;
  planning_candidate?: true;
}): ArtifactBlueprintResolutionV1 {
  if (input.planning_candidate !== undefined && input.planning_candidate !== true) {
    throw new Error("planning_candidate must be true when provided");
  }
  const blueprintId = validatePathSafeBuildId(input.blueprint_id, "blueprint_id");
  const blueprintVersion = validatePathSafeBuildId(input.blueprint_version, "blueprint_version");
  const system = getSystemEntry(blueprintId, blueprintVersion);
  if (system) {
    return {
      version: "artifact_blueprint_resolution.v1",
      source: "system",
      blueprint: system.blueprint,
      digest: system.digest,
    };
  }
  const candidate = findPrivateCandidate(input.private_root, blueprintId, blueprintVersion);
  if (candidate) {
    const entry = privateEntry(input.private_root, candidate);
    if (entry.status === "retired") throw new Error("retired ArtifactBlueprint candidate cannot be selected for a new Plan");
    return {
      version: "artifact_blueprint_resolution.v1",
      source: "user_private",
      blueprint: entry.blueprint,
      digest: entry.digest,
    };
  }
  if (input.one_off === undefined) throw new Error("ArtifactBlueprint candidate was not found and no one-off was provided");
  const oneOff = input.planning_candidate === true
    ? validatePlannerOneOffArtifactBlueprintV1(input.one_off)
    : validateArtifactBlueprintV1(input.one_off);
  if (oneOff.origin !== "one_off") throw new Error("one-off fallback must have one_off origin");
  if (oneOff.blueprint_id !== blueprintId || oneOff.blueprint_version !== blueprintVersion) {
    throw new Error("one-off fallback identity must match the requested ArtifactBlueprint");
  }
  return {
    version: "artifact_blueprint_resolution.v1",
    source: "one_off",
    blueprint: oneOff,
    digest: computeArtifactBlueprintDigest(oneOff),
  };
}
