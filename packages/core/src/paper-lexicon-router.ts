import { createHash } from "node:crypto";
import { AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1 } from "./automatic-build-protocol";
import {
  blockedAutomaticBuildRoute,
  createAutomaticBuildRecoveryEnvelope,
  readyAutomaticBuildRoute,
  type AutomaticBuildRouteResult,
} from "./automatic-build-recovery";
import type { BuildTargetRefV2 } from "./build-orchestrator";
import { pass1ContentHash, type Pass1ArtifactMeta } from "./build-resume";
import type { LidNode } from "./generated/LidNode";
import { evaluateModelInputBudget, type ModelInputBudgetProofV1 } from "./model-input-budget";
import { renderPaperLexiconModelInput } from "./model-input-renderer";
import {
  routeModelInputSlices,
  type ModelInputSliceRenderContextV1,
  type ModelInputSliceV1,
  type ModelInputUnsplittableDraftV1,
} from "./model-input-slice";
import {
  buildPaperLexiconSidecar,
  normalizePaperLexiconKey,
  paperLexiconEntriesFromOutput,
  PAPER_TERM_TYPES,
  type PaperLexiconArtifact,
  type PaperLexiconEntry,
  type PaperLexiconExtractionOutput,
  type PaperTermType,
} from "./paper-lexicon";
import { buildPass1Input } from "./pass1-input";
import { extractionPolicyDigest, type ExtractionPolicyFingerprintV1 } from "./semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  workUnitPlanDigest,
  type WorkUnitDescriptorV2,
} from "./stage-work-unit";
import type { Window } from "./window";

export const PAPER_LEXICON_ROUTER_VERSION = "paper_lexicon_cluster.v3" as const;
export const DEFAULT_LEXICON_BATCH_INPUT_TOKENS = 6_000;
export const DEFAULT_LEXICON_BATCH_CANDIDATES = 32;
export const PAPER_LEXICON_PROMPT_SHA256 = "c563d13e6fb3874f24689eb29a4dc0a9c117f4f6411ccc37cf2a47aebee2fe41" as const;

export const PAPER_LEXICON_CANDIDATE_SIGNALS = [
  "acronym_expansion",
  "recurring_acronym",
  "explicit_term",
  "technical_phrase",
  "dataset_symbol",
  "named_symbol",
] as const;

export type PaperLexiconCandidateSignal = (typeof PAPER_LEXICON_CANDIDATE_SIGNALS)[number];

export interface PaperLexiconCandidateClusterV1 {
  version: "paper_lexicon_candidate_cluster.v1";
  normalized_key: string;
  surface_forms: string[];
  occurrence_lids: string[];
  definition_lids: string[];
  signals: PaperLexiconCandidateSignal[];
  suggested_term_types: PaperTermType[];
}

export type PaperLexiconPacketRouteV1 =
  | {
      version: "paper_lexicon_packet_route.v1";
      role: "direct";
      cluster_keys: string[];
    }
  | {
      version: "paper_lexicon_packet_route.v1";
      role: "fragment";
      cluster_keys: [string];
      fragment_ordinal: number;
    }
  | {
      version: "paper_lexicon_packet_route.v1";
      role: "reduce";
      cluster_keys: [string];
      reducer_level: number;
      child_work_unit_ids: string[];
    };

export interface PaperLexiconReductionChildV1 {
  work_unit_id: string;
  artifact_hash: string;
  entries: PaperLexiconEntry[];
}

export interface PaperLexiconCandidatePacketV3 {
  version: "paper_lexicon_candidate_packet.v3";
  router_version: typeof PAPER_LEXICON_ROUTER_VERSION;
  work_unit_id: string;
  route: PaperLexiconPacketRouteV1;
  candidate_clusters: PaperLexiconCandidateClusterV1[];
  visible_lids: string[];
  requested_term_types: PaperTermType[];
  source_slices: ModelInputSliceV1[];
  reduction_children: PaperLexiconReductionChildV1[];
  text: string;
  estimated_input_tokens: number;
  estimated_rendered_tokens: number;
  input_hash: string;
  rendered_input_sha256: string;
  input_budget_proof: ModelInputBudgetProofV1;
}

export interface PaperLexiconClusterRouteV1 {
  version: "paper_lexicon_cluster_route.v1";
  normalized_key: string;
  role: "direct" | "fragment_reduce";
  source_work_unit_ids: string[];
  final_work_unit_id?: string;
}

export interface PaperLexiconCommittedArtifactV1 {
  artifact_hash: string;
  artifact: PaperLexiconArtifact;
}

export interface PaperLexiconRoutingAnalysis {
  version: "paper_lexicon_routing_analysis.v3";
  router_version: typeof PAPER_LEXICON_ROUTER_VERSION;
  clusters: PaperLexiconCandidateClusterV1[];
  packets: Record<string, PaperLexiconCandidatePacketV3>;
  cluster_routes: Record<string, PaperLexiconClusterRouteV1>;
  skip_windows: Record<string, { code: "no_lexicon_candidate"; evidence: string[]; input_hash: string }>;
}

export interface PaperLexiconRoutingPlan extends Omit<PaperLexiconRoutingAnalysis, "version"> {
  version: "paper_lexicon_routing_plan.v3";
  work_units: WorkUnitDescriptorV2[];
  plan_digest: string;
}

export interface PaperLexiconRoutingStatus {
  total: number;
  eligible: number;
  committed: number;
  pending: number;
  skipped: number;
  done_ids: string[];
  pending_ids: string[];
  skipped_ids: string[];
}

export interface PaperLexiconCandidateStatus extends PaperLexiconRoutingStatus {
  analysis: PaperLexiconRoutingAnalysis;
}

interface MutableCluster {
  normalizedKey: string;
  surfaceForms: Map<string, string>;
  occurrenceLids: Set<string>;
  definitionLids: Set<string>;
  signals: Set<PaperLexiconCandidateSignal>;
  suggestedTermTypes: Set<PaperTermType>;
}

interface LeafText {
  lid: string;
  text: string;
  normalizedText: string;
  windowId: number;
}

const CONNECTORS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "via", "with"]);
const EDGE_STOPWORDS = new Set([
  ...CONNECTORS,
  "be", "been", "being", "between", "can", "called", "class", "consists", "could", "define", "defined", "denote", "does", "each", "has", "have", "here", "higher", "indicates", "introduce", "introduced", "is", "it", "its", "measures", "our", "present", "propose", "records", "same", "than", "that", "this", "those", "use", "used", "using", "we", "while", "will",
]);
const TECHNICAL_SUFFIXES = new Set([
  "ability", "accuracy", "algorithm", "architecture", "attention", "benchmark", "capability", "capacity", "circuit", "complexity", "context", "dataset", "decay", "depth", "distribution", "embedding", "encoding", "equation", "evolution", "execution", "factor", "feature", "function", "gate", "gradient", "head", "hierarchy", "implementation", "imbalance", "inference", "inversion", "kernel", "layer", "learning", "lemma", "loss", "map", "mapping", "mask", "matrix", "memories", "memory", "method", "metric", "model", "network", "noise", "norm", "normalization", "objective", "optimization", "phrase", "programmer", "ratio", "reachability", "recall", "regression", "representation", "retrieval", "rule", "score", "sequence", "signal", "speed", "sphere", "state", "step", "term", "theorem", "token", "tracking", "tradeoff", "training", "transformer", "update", "validation", "value", "vector",
]);
const TECHNICAL_PLURALS = new Map([
  ["algorithms", "algorithm"], ["architectures", "architecture"], ["benchmarks", "benchmark"], ["circuits", "circuit"], ["datasets", "dataset"], ["distributions", "distribution"], ["embeddings", "embedding"], ["equations", "equation"], ["features", "feature"], ["functions", "function"], ["heads", "head"], ["kernels", "kernel"], ["layers", "layer"], ["matrices", "matrix"], ["methods", "method"], ["metrics", "metric"], ["models", "model"], ["networks", "network"], ["objectives", "objective"], ["representations", "representation"], ["scores", "score"], ["sequences", "sequence"], ["states", "state"], ["tokens", "token"], ["transformers", "transformer"], ["vectors", "vector"],
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function paperLexiconArtifactHash(artifact: PaperLexiconArtifact): string {
  return sha256(stableJson(artifact));
}

export function inspectPaperLexiconCommittedArtifact(
  value: unknown,
): PaperLexiconCommittedArtifactV1 | undefined {
  const envelope = isRecord(value)
    && (value.version === "semantic_task_artifact.v2" || value.version === "semantic_task_artifact.v3")
    ? value
    : undefined;
  const artifactValue = envelope?.payload ?? value;
  if (!isRecord(artifactValue)
    || typeof artifactValue.content_hash !== "string"
    || !Array.isArray(artifactValue.entries)) {
    return undefined;
  }
  const artifact = artifactValue as unknown as PaperLexiconArtifact;
  const artifactHash = paperLexiconArtifactHash(artifact);
  if (envelope && envelope.artifact_hash !== artifactHash) return undefined;
  return { artifact_hash: artifactHash, artifact };
}

function normalizedText(value: string): string {
  return normalizePaperLexiconKey(value);
}

function normalizeSurface(value: string): string {
  return value.replace(/^[-,:;\s]+|[-,:;\s]+$/g, "").replace(/\s+/g, " ").trim();
}

function wordTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019._+/-]*/gu) ?? [];
}

function technicalSuffix(token: string): string | undefined {
  const normalized = normalizedText(token);
  return TECHNICAL_SUFFIXES.has(normalized) ? normalized : TECHNICAL_PLURALS.get(normalized);
}

function suggestedTypes(surface: string, signal: PaperLexiconCandidateSignal): PaperTermType[] {
  if (signal === "acronym_expansion" || signal === "recurring_acronym") return ["acronym"];
  if (signal === "dataset_symbol" || /dataset|benchmark/i.test(surface)) return ["dataset_name"];
  const last = wordTokens(surface).at(-1) ?? "";
  const suffix = technicalSuffix(last);
  if (suffix === "accuracy" || suffix === "metric" || suffix === "ratio" || suffix === "score" || /\bSNR\b/.test(surface)) return ["metric_name"];
  if (["algorithm", "attention", "implementation", "inversion", "method", "optimization", "rule", "update"].includes(suffix ?? "")) return ["method_name"];
  if (["architecture", "model", "network", "transformer"].includes(suffix ?? "")) return ["model_name"];
  if (signal === "explicit_term") return ["paper_defined_term"];
  return ["domain_term"];
}

function addCandidate(
  clusters: Map<string, MutableCluster>,
  surfaceInput: string,
  lid: string,
  signal: PaperLexiconCandidateSignal,
  options: { normalizedKey?: string; definition?: boolean; aliases?: string[] } = {},
): MutableCluster | undefined {
  const surface = normalizeSurface(surfaceInput);
  const key = options.normalizedKey ?? normalizedText(surface);
  if (!surface || key.length < 2 || /^\d+$/.test(key)) return undefined;
  const cluster = clusters.get(key) ?? {
    normalizedKey: key,
    surfaceForms: new Map(),
    occurrenceLids: new Set(),
    definitionLids: new Set(),
    signals: new Set(),
    suggestedTermTypes: new Set(),
  };
  cluster.surfaceForms.set(normalizedText(surface), surface);
  for (const alias of options.aliases ?? []) {
    const normalizedAlias = normalizeSurface(alias);
    if (normalizedAlias) cluster.surfaceForms.set(normalizedText(normalizedAlias), normalizedAlias);
  }
  cluster.occurrenceLids.add(lid);
  if (options.definition) cluster.definitionLids.add(lid);
  cluster.signals.add(signal);
  for (const type of suggestedTypes(surface, signal)) cluster.suggestedTermTypes.add(type);
  clusters.set(key, cluster);
  return cluster;
}

function acronymInitials(words: string[]): string {
  return words
    .flatMap((word) => word.split(/[-/]/))
    .filter((word) => word && !CONNECTORS.has(word.toLocaleLowerCase()))
    .map((word) => word[0]?.toLocaleUpperCase() ?? "")
    .join("");
}

function alignedLongForm(prefix: string, acronym: string): string | undefined {
  const words = wordTokens(prefix).slice(-10);
  for (let start = words.length - 1; start >= 0; start -= 1) {
    const candidate = words.slice(start);
    if (acronymInitials(candidate) === acronym.toLocaleUpperCase()) return candidate.join(" ");
  }
  return undefined;
}

function isDefinitionText(text: string): boolean {
  return /\b(?:we\s+define|is\s+defined\s+as|we\s+call|we\s+refer\s+to|denote(?:d)?\s+as)\b/i.test(text);
}

function bibliographyExcludedLids(orderedLeaves: LidNode[], source: string): Set<string> {
  const excluded = new Set<string>();
  let activeLevel: number | undefined;
  for (const node of orderedLeaves) {
    const text = source.slice(node.span.start, node.span.end).replace(/\s+/g, " ").trim();
    const heading = text.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (activeLevel !== undefined && heading[1].length <= activeLevel) activeLevel = undefined;
      if (/^(?:references|bibliography|works cited)(?:\s+continued)?$/i.test(heading[2].trim())) activeLevel = heading[1].length;
    }
    if (activeLevel !== undefined) excluded.add(node.lid);
  }
  return excluded;
}

function scanCandidates(leaves: LeafText[]): PaperLexiconCandidateClusterV1[] {
  const clusters = new Map<string, MutableCluster>();
  const acronymKey = new Map<string, string>();
  const technicalOccurrences = new Map<string, { surfaces: Map<string, string>; lids: Set<string>; definitions: Set<string>; count: number }>();
  const acronymOccurrences = new Map<string, Set<string>>();

  for (const leaf of leaves) {
    const definition = isDefinitionText(leaf.text);
    const acronymPattern = /([\p{L}][\p{L}\p{N}-]*(?:\s+[\p{L}][\p{L}\p{N}-]*){1,9})\s*\(([A-Z][A-Z0-9-]{1,9})\)/gu;
    for (const match of leaf.text.matchAll(acronymPattern)) {
      const longForm = alignedLongForm(match[1], match[2]);
      if (!longForm) continue;
      const key = normalizedText(longForm);
      addCandidate(clusters, longForm, leaf.lid, "acronym_expansion", {
        normalizedKey: key,
        definition,
        aliases: [match[2]],
      });
      acronymKey.set(normalizedText(match[2]), key);
    }

    for (const acronym of leaf.text.match(/\b[A-Z][A-Z0-9-]{1,9}\b/g) ?? []) {
      const key = normalizedText(acronym);
      const lids = acronymOccurrences.get(key) ?? new Set<string>();
      lids.add(leaf.lid);
      acronymOccurrences.set(key, lids);
    }

    for (const dataset of leaf.text.matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:Dataset|DataSet|Benchmark))\b/g)) {
      addCandidate(clusters, dataset[1], leaf.lid, "dataset_symbol", { definition });
    }

    for (const symbol of wordTokens(leaf.text)) {
      const letters = symbol.replace(/[^A-Za-z]/g, "");
      const mixedCase = /[a-z]/.test(letters) && (letters.match(/[A-Z]/g)?.length ?? 0) >= 2;
      const alphaNumeric = /[A-Za-z]/.test(symbol) && /\d/.test(symbol);
      const namedSuffix = /^.+(?:Attention|Former|GPT|Net|Norm|RNN|Transformer)$/i.test(symbol) && /[A-Z]/.test(symbol);
      if (symbol.length >= 3 && (mixedCase || alphaNumeric || namedSuffix)) {
        addCandidate(clusters, symbol, leaf.lid, "named_symbol", { definition });
      }
    }

    for (const label of leaf.text.matchAll(/\b((?:Assumption|Axiom|Claim|Lemma|Proposition|Theorem)\s+[A-Z0-9][A-Za-z0-9.-]*)\b/g)) {
      addCandidate(clusters, label[1], leaf.lid, "explicit_term", { definition: true });
    }

    const explicitPattern = /\b(?:introduce|propose|present)\s+(?:(?:a|an|the|our|novel|new)\s+)*([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,5})/g;
    for (const explicit of leaf.text.matchAll(explicitPattern)) {
      addCandidate(clusters, explicit[1], leaf.lid, "explicit_term", { definition });
    }

    for (const sentence of leaf.text.split(/[.!?;:\n]+/)) {
      const tokens = wordTokens(sentence);
      for (let end = 0; end < tokens.length; end += 1) {
        if (!technicalSuffix(tokens[end])) continue;
        let start = end;
        while (
          start > 0
          && end - start < 4
          && !EDGE_STOPWORDS.has(normalizedText(tokens[start - 1]))
          && !technicalSuffix(tokens[start - 1])
          && !/(?:Dataset|DataSet|Benchmark)$/i.test(tokens[start - 1])
        ) start -= 1;
        const phraseTokens = tokens.slice(start, end + 1);
        if (phraseTokens.length >= 2 && /^\p{Lu}/u.test(phraseTokens[0])) {
          addCandidate(clusters, phraseTokens.join(" "), leaf.lid, "technical_phrase", { definition });
        }
      }
      for (let start = 0; start < tokens.length; start += 1) {
        for (let length = 1; length <= 5 && start + length <= tokens.length; length += 1) {
          const phraseTokens = tokens.slice(start, start + length);
          const first = normalizedText(phraseTokens[0]);
          const last = normalizedText(phraseTokens.at(-1)!);
          if (EDGE_STOPWORDS.has(first) || EDGE_STOPWORDS.has(last) || !technicalSuffix(last)) continue;
          const surface = phraseTokens.join(" ");
          const key = normalizedText(surface);
          if (key.length < 3) continue;
          const occurrence = technicalOccurrences.get(key) ?? { surfaces: new Map(), lids: new Set(), definitions: new Set(), count: 0 };
          occurrence.surfaces.set(normalizedText(surface), surface);
          occurrence.lids.add(leaf.lid);
          occurrence.count += 1;
          if (definition) occurrence.definitions.add(leaf.lid);
          technicalOccurrences.set(key, occurrence);
        }
      }
    }
  }

  for (const [key, occurrence] of technicalOccurrences) {
    if (occurrence.count < 2 && !clusters.has(key)) continue;
    const surface = [...occurrence.surfaces.values()][0];
    const tokenCount = wordTokens(surface).length;
    if (tokenCount === 1 && !(occurrence.lids.size >= 4 && /^\p{Lu}/u.test(surface))) continue;
    const cluster = addCandidate(clusters, surface, [...occurrence.lids][0], "technical_phrase", { normalizedKey: key });
    if (!cluster) continue;
    for (const lid of occurrence.lids) cluster.occurrenceLids.add(lid);
    for (const lid of occurrence.definitions) cluster.definitionLids.add(lid);
  }

  for (const [key, lids] of acronymOccurrences) {
    const resolvedKey = acronymKey.get(key) ?? key;
    const existing = clusters.get(resolvedKey);
    if (!existing && lids.size < 2) continue;
    const surface = existing?.surfaceForms.get(key) ?? key.toLocaleUpperCase();
    const cluster = addCandidate(clusters, surface, [...lids][0], "recurring_acronym", { normalizedKey: resolvedKey });
    if (!cluster) continue;
    for (const lid of lids) cluster.occurrenceLids.add(lid);
  }

  for (const cluster of clusters.values()) {
    for (const leaf of leaves) {
      const matches = [...cluster.surfaceForms.keys()].some((surfaceKey) =>
        surfaceKey.length >= 2 && ` ${leaf.normalizedText} `.includes(` ${surfaceKey} `),
      );
      if (!matches) continue;
      cluster.occurrenceLids.add(leaf.lid);
      if (isDefinitionText(leaf.text)) cluster.definitionLids.add(leaf.lid);
    }
  }

  for (const [key, cluster] of [...clusters]) {
    if (cluster.signals.size !== 1 || !cluster.signals.has("technical_phrase") || wordTokens(key).length < 2) continue;
    const occurrenceSet = cluster.occurrenceLids;
    const coveredByLonger = [...clusters.values()].some((other) =>
      other !== cluster
      && other.normalizedKey.split(" ").length > key.split(" ").length
      && (other.normalizedKey.endsWith(` ${key}`)
        || (["noise", "signal"].includes(key.split(" ").at(-1) ?? "") && other.normalizedKey.startsWith(`${key} `)))
      && [...occurrenceSet].every((lid) => other.occurrenceLids.has(lid)),
    );
    if (coveredByLonger) clusters.delete(key);
  }
  for (const [key, cluster] of [...clusters]) {
    const last = key.split(" ").at(-1) ?? "";
    const incompletePrefix = ["noise", "signal"].includes(last)
      && [...clusters.keys()].some((other) => other.startsWith(`${key} `));
    const redundantDatasetPhrase = key.endsWith(" dataset")
      && [...cluster.surfaceForms.keys()].some((surface) => /dataset dataset$/i.test(surface));
    if (incompletePrefix || redundantDatasetPhrase) clusters.delete(key);
  }

  const signalOrder = new Map(PAPER_LEXICON_CANDIDATE_SIGNALS.map((signal, index) => [signal, index]));
  const typeOrder = new Map(PAPER_TERM_TYPES.map((type, index) => [type, index]));
  return [...clusters.values()]
    .map((cluster): PaperLexiconCandidateClusterV1 => ({
      version: "paper_lexicon_candidate_cluster.v1",
      normalized_key: cluster.normalizedKey,
      surface_forms: [...cluster.surfaceForms.values()].sort((left, right) => left.localeCompare(right)),
      occurrence_lids: [...cluster.occurrenceLids],
      definition_lids: [...cluster.definitionLids],
      signals: [...cluster.signals].sort((left, right) => signalOrder.get(left)! - signalOrder.get(right)!),
      suggested_term_types: [...cluster.suggestedTermTypes].sort((left, right) => typeOrder.get(left)! - typeOrder.get(right)!),
    }))
    .sort((left, right) => left.normalized_key.localeCompare(right.normalized_key));
}

type PaperLexiconPacketIdentityV3 = Omit<
  PaperLexiconCandidatePacketV3,
  | "estimated_input_tokens"
  | "estimated_rendered_tokens"
  | "input_hash"
  | "rendered_input_sha256"
  | "input_budget_proof"
>;

type PaperLexiconPacketBuildResult =
  | { status: "within_limit"; packet: PaperLexiconCandidatePacketV3; rendered_input: string }
  | {
      status: "over_limit";
      estimated_rendered_tokens: number;
      effective_body_limit_tokens: number;
    };

class PaperLexiconRoutingBudgetBlock extends Error {
  readonly name = "PaperLexiconRoutingBudgetBlock";

  constructor(
    readonly work_unit_id: string,
    readonly recovery: ModelInputUnsplittableDraftV1,
  ) {
    super(`paper lexicon input is not safely routable: ${work_unit_id}`);
  }
}

function sourceFingerprint(source: string): string {
  return sha256(source);
}

function orderedLids(lids: Iterable<string>, byLid: Map<string, LidNode>): string[] {
  return [...new Set(lids)].sort((left, right) => {
    const leftNode = byLid.get(left);
    const rightNode = byLid.get(right);
    if (!leftNode || !rightNode) throw new Error(`paper lexicon candidate references an unknown LID: ${!leftNode ? left : right}`);
    return leftNode.span.start - rightNode.span.start || left.localeCompare(right);
  });
}

function representativeLids(
  cluster: PaperLexiconCandidateClusterV1,
  byLid: Map<string, LidNode>,
): string[] {
  const definitions = orderedLids(cluster.definition_lids, byLid);
  const definitionSet = new Set(definitions);
  const occurrences = orderedLids(cluster.occurrence_lids, byLid)
    .filter((lid) => !definitionSet.has(lid));
  const sampled = occurrences.length <= 4
    ? occurrences
    : [occurrences[0], occurrences[Math.floor(occurrences.length / 2)], occurrences.at(-1)!];
  return [...definitions, ...sampled];
}

function wholeLidSlice(
  source: string,
  fingerprint: string,
  node: LidNode,
): ModelInputSliceV1 {
  const core = source.slice(node.span.start, node.span.end);
  return {
    version: "model_input_slice.v1",
    source_fingerprint: fingerprint,
    parent_lid: node.lid,
    ordinal: 0,
    core_span_utf16: { ...node.span },
    context_span_utf16: { ...node.span },
    boundary_kind: "whole_lid",
    core_sha256: sha256(core),
    context_sha256: sha256(core),
  };
}

function sliceFromRenderContext(
  fingerprint: string,
  context: ModelInputSliceRenderContextV1,
): ModelInputSliceV1 {
  return {
    version: "model_input_slice.v1",
    source_fingerprint: fingerprint,
    parent_lid: context.parent_lid,
    ordinal: context.ordinal,
    core_span_utf16: { ...context.core_span_utf16 },
    context_span_utf16: { ...context.context_span_utf16 },
    boundary_kind: context.boundary_kind,
    core_sha256: sha256(context.core),
    context_sha256: sha256(`${context.context_before}${context.core}${context.context_after}`),
  };
}

function textForSlices(source: string, slices: ModelInputSliceV1[]): string {
  return slices.map((slice) => {
    const core = source.slice(slice.core_span_utf16.start, slice.core_span_utf16.end);
    if (slice.boundary_kind === "whole_lid") return `[${slice.parent_lid}] ${core}`;
    const before = source.slice(slice.context_span_utf16.start, slice.core_span_utf16.start);
    const after = source.slice(slice.core_span_utf16.end, slice.context_span_utf16.end);
    return [
      `[${slice.parent_lid} fragment=${slice.ordinal} core=${slice.core_span_utf16.start}:${slice.core_span_utf16.end}]`,
      before,
      "<LEXICON_CORE>",
      core,
      "</LEXICON_CORE>",
      after,
    ].join("\n");
  }).join("\n\n");
}

function lexiconBudget(maxInputTokens: number) {
  const reserves = AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.prompt_reserve_tokens
    + AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.protocol_reserve_tokens
    + AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.output_reserve_tokens
    + AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.safety_margin_tokens;
  return {
    ...AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1,
    stage_body_limit_tokens: maxInputTokens,
    executor_context_floor_tokens: Math.max(
      AUTOMATIC_BUILD_MODEL_INPUT_BUDGET_V1.executor_context_floor_tokens,
      maxInputTokens + reserves,
    ),
    router_version: PAPER_LEXICON_ROUTER_VERSION,
    prompt_sha256: PAPER_LEXICON_PROMPT_SHA256,
  };
}

function finishPacket(
  identity: PaperLexiconPacketIdentityV3,
  maxInputTokens: number,
): PaperLexiconPacketBuildResult {
  const renderedInput = renderPaperLexiconModelInput(identity);
  const evaluated = evaluateModelInputBudget({
    ...lexiconBudget(maxInputTokens),
    rendered_input: renderedInput,
  });
  if (evaluated.status === "over_limit") {
    return {
      status: "over_limit",
      estimated_rendered_tokens: evaluated.estimated_rendered_tokens,
      effective_body_limit_tokens: evaluated.effective_body_limit_tokens,
    };
  }
  return {
    status: "within_limit",
    rendered_input: renderedInput,
    packet: {
      ...identity,
      estimated_input_tokens: evaluated.proof.estimated_rendered_tokens,
      estimated_rendered_tokens: evaluated.proof.estimated_rendered_tokens,
      input_hash: sha256(stableJson(identity)),
      rendered_input_sha256: evaluated.proof.rendered_input_sha256,
      input_budget_proof: evaluated.proof,
    },
  };
}

function directWorkUnitId(clusters: PaperLexiconCandidateClusterV1[]): string {
  return `lexicon-batch-${sha256(clusters.map((cluster) => cluster.normalized_key).join("\n")).slice(0, 16)}`;
}

function sourcePacketIdentity(input: {
  clusters: PaperLexiconCandidateClusterV1[];
  route: Exclude<PaperLexiconPacketRouteV1, { role: "reduce" }>;
  source: string;
  source_slices: ModelInputSliceV1[];
  visible_lids: string[];
}): PaperLexiconPacketIdentityV3 {
  const workUnitId = input.route.role === "direct"
    ? directWorkUnitId(input.clusters)
    : `lexicon-fragment-${sha256(stableJson({
        version: "paper_lexicon_fragment_identity.v1",
        router_version: PAPER_LEXICON_ROUTER_VERSION,
        cluster_key: input.route.cluster_keys[0],
        fragment_ordinal: input.route.fragment_ordinal,
        source_slices: input.source_slices,
      })).slice(0, 24)}`;
  return {
    version: "paper_lexicon_candidate_packet.v3",
    router_version: PAPER_LEXICON_ROUTER_VERSION,
    work_unit_id: workUnitId,
    route: input.route,
    candidate_clusters: input.clusters,
    visible_lids: [...new Set(input.visible_lids)],
    requested_term_types: [...PAPER_TERM_TYPES],
    source_slices: input.source_slices.map((slice) => ({
      ...slice,
      core_span_utf16: { ...slice.core_span_utf16 },
      context_span_utf16: { ...slice.context_span_utf16 },
    })),
    reduction_children: [],
    text: textForSlices(input.source, input.source_slices),
  };
}

function directPacket(input: {
  clusters: PaperLexiconCandidateClusterV1[];
  byLid: Map<string, LidNode>;
  source: string;
  maxInputTokens: number;
}): PaperLexiconPacketBuildResult {
  const fingerprint = sourceFingerprint(input.source);
  const contextLids = orderedLids(
    input.clusters.flatMap((cluster) => representativeLids(cluster, input.byLid)),
    input.byLid,
  );
  const sourceSlices = contextLids.map((lid) => wholeLidSlice(input.source, fingerprint, input.byLid.get(lid)!));
  const visibleLids = orderedLids(
    input.clusters.flatMap((cluster) => [...cluster.occurrence_lids, ...cluster.definition_lids]),
    input.byLid,
  );
  return finishPacket(sourcePacketIdentity({
    clusters: input.clusters,
    route: {
      version: "paper_lexicon_packet_route.v1",
      role: "direct",
      cluster_keys: input.clusters.map((cluster) => cluster.normalized_key),
    },
    source: input.source,
    source_slices: sourceSlices,
    visible_lids: visibleLids,
  }), input.maxInputTokens);
}

function fragmentPacket(input: {
  cluster: PaperLexiconCandidateClusterV1;
  source: string;
  source_slices: ModelInputSliceV1[];
  fragment_ordinal: number;
  maxInputTokens: number;
}): PaperLexiconPacketBuildResult {
  return finishPacket(sourcePacketIdentity({
    clusters: [input.cluster],
    route: {
      version: "paper_lexicon_packet_route.v1",
      role: "fragment",
      cluster_keys: [input.cluster.normalized_key],
      fragment_ordinal: input.fragment_ordinal,
    },
    source: input.source,
    source_slices: input.source_slices,
    visible_lids: input.source_slices.map((slice) => slice.parent_lid),
  }), input.maxInputTokens);
}

function routeClusterFragments(input: {
  cluster: PaperLexiconCandidateClusterV1;
  byLid: Map<string, LidNode>;
  source: string;
  maxInputTokens: number;
}): PaperLexiconCandidatePacketV3[] {
  const fingerprint = sourceFingerprint(input.source);
  const contextLids = representativeLids(input.cluster, input.byLid);
  const fragments: PaperLexiconCandidatePacketV3[] = [];
  let pendingLids: string[] = [];

  const packetForLids = (lids: string[], ordinal: number) => fragmentPacket({
    cluster: input.cluster,
    source: input.source,
    source_slices: lids.map((lid) => wholeLidSlice(input.source, fingerprint, input.byLid.get(lid)!)),
    fragment_ordinal: ordinal,
    maxInputTokens: input.maxInputTokens,
  });
  const flushPending = (): void => {
    if (!pendingLids.length) return;
    const built = packetForLids(pendingLids, fragments.length);
    if (built.status !== "within_limit") throw new Error("paper lexicon whole-LID regroup drifted over budget");
    fragments.push(built.packet);
    pendingLids = [];
  };

  for (const lid of contextLids) {
    const proposed = packetForLids([...pendingLids, lid], fragments.length);
    if (proposed.status === "within_limit") {
      pendingLids.push(lid);
      continue;
    }
    flushPending();
    const whole = packetForLids([lid], fragments.length);
    if (whole.status === "within_limit") {
      pendingLids = [lid];
      continue;
    }
    const parent = input.byLid.get(lid);
    if (!parent) throw new Error(`paper lexicon representative LID does not exist: ${lid}`);
    const baseOrdinal = fragments.length;
    const sliced = routeModelInputSlices({
      source: input.source,
      source_fingerprint: fingerprint,
      parent,
      context_overlap_utf16: 64,
      budget: lexiconBudget(input.maxInputTokens),
      render: (context) => renderPaperLexiconModelInput(sourcePacketIdentity({
        clusters: [input.cluster],
        route: {
          version: "paper_lexicon_packet_route.v1",
          role: "fragment",
          cluster_keys: [input.cluster.normalized_key],
          fragment_ordinal: baseOrdinal + context.ordinal,
        },
        source: input.source,
        source_slices: [sliceFromRenderContext(fingerprint, context)],
        visible_lids: [context.parent_lid],
      })),
    });
    if (sliced.status === "blocked") {
      throw new PaperLexiconRoutingBudgetBlock(
        `lexicon-fragment-${sha256(`${input.cluster.normalized_key}\n${lid}`).slice(0, 24)}`,
        sliced.recovery,
      );
    }
    for (const routed of sliced.slices) {
      const built = fragmentPacket({
        cluster: input.cluster,
        source: input.source,
        source_slices: [routed.slice],
        fragment_ordinal: fragments.length,
        maxInputTokens: input.maxInputTokens,
      });
      if (built.status !== "within_limit" || built.rendered_input !== routed.rendered_input) {
        throw new Error("paper lexicon source-slice renderer drifted after routing");
      }
      fragments.push(built.packet);
    }
  }
  flushPending();

  if (fragments.length === 1) {
    const only = fragments[0];
    const direct = finishPacket(sourcePacketIdentity({
      clusters: [input.cluster],
      route: {
        version: "paper_lexicon_packet_route.v1",
        role: "direct",
        cluster_keys: [input.cluster.normalized_key],
      },
      source: input.source,
      source_slices: only.source_slices,
      visible_lids: only.visible_lids,
    }), input.maxInputTokens);
    if (direct.status === "within_limit") return [direct.packet];
  }
  return fragments;
}

function batchDirectClusters(input: {
  clusters: PaperLexiconCandidateClusterV1[];
  byLid: Map<string, LidNode>;
  source: string;
  maxInputTokens: number;
  maxCandidates: number;
}): PaperLexiconCandidatePacketV3[] {
  const packets: PaperLexiconCandidatePacketV3[] = [];
  let current: PaperLexiconCandidateClusterV1[] = [];
  const flush = (): void => {
    if (!current.length) return;
    const built = directPacket({ ...input, clusters: current });
    if (built.status !== "within_limit") throw new Error("paper lexicon direct batch drifted over budget");
    packets.push(built.packet);
    current = [];
  };
  for (const cluster of input.clusters) {
    const proposed = [...current, cluster];
    const built = proposed.length <= input.maxCandidates
      ? directPacket({ ...input, clusters: proposed })
      : undefined;
    if (built?.status === "within_limit") current = proposed;
    else {
      flush();
      current = [cluster];
    }
  }
  flush();
  return packets;
}

function freshFragmentArtifact(
  packet: PaperLexiconCandidatePacketV3,
  existing: ReadonlyMap<string, PaperLexiconCommittedArtifactV1>,
): PaperLexiconCommittedArtifactV1 | undefined {
  const committed = existing.get(packet.work_unit_id);
  if (!committed
    || committed.artifact_hash !== sha256(stableJson(committed.artifact))
    || committed.artifact.content_hash !== packet.input_hash
    || committed.artifact.route?.version !== "paper_lexicon_artifact_route.v1"
    || committed.artifact.route.role !== "fragment"
    || committed.artifact.route.final
    || stableJson(committed.artifact.route.cluster_keys) !== stableJson(packet.route.cluster_keys)) {
    return undefined;
  }
  return committed;
}

function reducerPacket(input: {
  cluster: PaperLexiconCandidateClusterV1;
  fragments: PaperLexiconCandidatePacketV3[];
  committed: PaperLexiconCommittedArtifactV1[];
  byLid: Map<string, LidNode>;
  maxInputTokens: number;
}): PaperLexiconCandidatePacketV3 {
  const children = input.fragments.map((fragment, index): PaperLexiconReductionChildV1 => ({
    work_unit_id: fragment.work_unit_id,
    artifact_hash: input.committed[index].artifact_hash,
    entries: input.committed[index].artifact.entries,
  }));
  const workUnitId = `lexicon-reduce-${sha256(stableJson({
    version: "paper_lexicon_reduce_identity.v1",
    cluster_key: input.cluster.normalized_key,
    children: children.map((child) => ({
      work_unit_id: child.work_unit_id,
      artifact_hash: child.artifact_hash,
    })),
  })).slice(0, 24)}`;
  const identity: PaperLexiconPacketIdentityV3 = {
    version: "paper_lexicon_candidate_packet.v3",
    router_version: PAPER_LEXICON_ROUTER_VERSION,
    work_unit_id: workUnitId,
    route: {
      version: "paper_lexicon_packet_route.v1",
      role: "reduce",
      cluster_keys: [input.cluster.normalized_key],
      reducer_level: 0,
      child_work_unit_ids: children.map((child) => child.work_unit_id),
    },
    candidate_clusters: [input.cluster],
    visible_lids: orderedLids(input.cluster.occurrence_lids, input.byLid),
    requested_term_types: [...PAPER_TERM_TYPES],
    source_slices: [],
    reduction_children: children,
    text: "",
  };
  const built = finishPacket(identity, input.maxInputTokens);
  if (built.status === "within_limit") return built.packet;
  const parentLid = representativeLids(input.cluster, input.byLid)[0];
  const parent = input.byLid.get(parentLid)!;
  throw new PaperLexiconRoutingBudgetBlock(workUnitId, {
    version: "automatic_build_recovery_draft.v1",
    phase: "routing",
    code: "model_input_unsplittable",
    parent_lid: parentLid,
    lid_kind: parent.kind,
    reason: "renderer_fixed_overhead",
    estimated_tokens: built.estimated_rendered_tokens,
    limit_tokens: built.effective_body_limit_tokens,
    retryable: false,
  });
}

function leafTexts(input: { windows: Window[]; byLid: Map<string, LidNode>; source: string }): LeafText[] {
  const windowByLid = new Map(input.windows.flatMap((window) => window.leafLids.map((lid) => [lid, window.id] as const)));
  const ordered = [...input.byLid.values()]
    .filter((node) => node.children.length === 0)
    .sort((left, right) => left.span.start - right.span.start);
  const excluded = bibliographyExcludedLids(ordered, input.source);
  return ordered
    .filter((node) => !excluded.has(node.lid) && windowByLid.has(node.lid))
    .map((node) => {
      const text = input.source.slice(node.span.start, node.span.end).replace(/\s+/g, " ").trim();
      return { lid: node.lid, text, normalizedText: normalizedText(text), windowId: windowByLid.get(node.lid)! };
    })
    .filter((leaf) => !/SPDX-License-Identifier/i.test(leaf.text));
}

export function analyzePaperLexiconCandidates(input: {
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  existing_artifacts?: ReadonlyMap<string, PaperLexiconCommittedArtifactV1>;
  max_input_tokens?: number;
  max_candidates_per_batch?: number;
}): PaperLexiconRoutingAnalysis {
  const maxInputTokens = input.max_input_tokens ?? DEFAULT_LEXICON_BATCH_INPUT_TOKENS;
  const maxCandidates = input.max_candidates_per_batch ?? DEFAULT_LEXICON_BATCH_CANDIDATES;
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) throw new Error("max_input_tokens must be a positive safe integer");
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("max_candidates_per_batch must be a positive safe integer");
  const leaves = leafTexts(input);
  const clusters = scanCandidates(leaves);
  const packetList: PaperLexiconCandidatePacketV3[] = [];
  const directClusters: PaperLexiconCandidateClusterV1[] = [];
  const cluster_routes: PaperLexiconRoutingAnalysis["cluster_routes"] = {};
  const existingArtifacts = input.existing_artifacts ?? new Map<string, PaperLexiconCommittedArtifactV1>();

  for (const cluster of clusters) {
    const direct = directPacket({
      clusters: [cluster],
      byLid: input.byLid,
      source: input.source,
      maxInputTokens,
    });
    if (direct.status === "within_limit") {
      directClusters.push(cluster);
      continue;
    }
    const routed = routeClusterFragments({
      cluster,
      byLid: input.byLid,
      source: input.source,
      maxInputTokens,
    });
    packetList.push(...routed);
    if (routed.length === 1 && routed[0].route.role === "direct") {
      cluster_routes[cluster.normalized_key] = {
        version: "paper_lexicon_cluster_route.v1",
        normalized_key: cluster.normalized_key,
        role: "direct",
        source_work_unit_ids: [routed[0].work_unit_id],
        final_work_unit_id: routed[0].work_unit_id,
      };
      continue;
    }
    const committed = routed.map((packet) => freshFragmentArtifact(packet, existingArtifacts));
    let finalWorkUnitId: string | undefined;
    if (committed.every((artifact): artifact is PaperLexiconCommittedArtifactV1 => artifact !== undefined)) {
      const reducer = reducerPacket({
        cluster,
        fragments: routed,
        committed,
        byLid: input.byLid,
        maxInputTokens,
      });
      packetList.push(reducer);
      finalWorkUnitId = reducer.work_unit_id;
    }
    cluster_routes[cluster.normalized_key] = {
      version: "paper_lexicon_cluster_route.v1",
      normalized_key: cluster.normalized_key,
      role: "fragment_reduce",
      source_work_unit_ids: routed.map((packet) => packet.work_unit_id),
      ...(finalWorkUnitId ? { final_work_unit_id: finalWorkUnitId } : {}),
    };
  }

  const directPackets = batchDirectClusters({
    clusters: directClusters,
    byLid: input.byLid,
    source: input.source,
    maxInputTokens,
    maxCandidates,
  });
  packetList.unshift(...directPackets);
  for (const packet of directPackets) {
    for (const cluster of packet.candidate_clusters) {
      cluster_routes[cluster.normalized_key] = {
        version: "paper_lexicon_cluster_route.v1",
        normalized_key: cluster.normalized_key,
        role: "direct",
        source_work_unit_ids: [packet.work_unit_id],
        final_work_unit_id: packet.work_unit_id,
      };
    }
  }
  const packets = Object.fromEntries(packetList.map((packet) => [packet.work_unit_id, packet]));
  const candidateLids = new Set(clusters.flatMap((cluster) => cluster.occurrence_lids));
  const skip_windows: PaperLexiconRoutingAnalysis["skip_windows"] = {};
  for (const window of input.windows) {
    if (window.leafLids.some((lid) => candidateLids.has(lid))) continue;
    skip_windows[`lexicon-skip-window-${window.id}`] = {
      code: "no_lexicon_candidate",
      evidence: [...window.leafLids],
      input_hash: pass1ContentHash(buildPass1Input(window, input.byLid, input.source)),
    };
  }
  return {
    version: "paper_lexicon_routing_analysis.v3",
    router_version: PAPER_LEXICON_ROUTER_VERSION,
    clusters,
    packets,
    cluster_routes,
    skip_windows,
  };
}

export function routePaperLexiconWorkUnits(input: {
  target: BuildTargetRefV2;
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
  existing_artifacts?: ReadonlyMap<string, PaperLexiconCommittedArtifactV1>;
  max_input_tokens?: number;
  max_candidates_per_batch?: number;
}): PaperLexiconRoutingPlan {
  const analysis = analyzePaperLexiconCandidates(input);
  const batchUnits = Object.values(analysis.packets).map((packet) => createWorkUnitDescriptor({
    target: input.target,
    stage: "paper_lexicon",
    work_unit_id: packet.work_unit_id,
    kind: "lexicon_candidate_batch",
    input_hash: packet.input_hash,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: packet.visible_lids,
    dependencies: packet.reduction_children.map((child) => ({
      artifact: child.work_unit_id,
      sha256: child.artifact_hash,
    })),
    cost: buildWorkUnitCost({
      estimated_input_tokens: packet.estimated_rendered_tokens,
      visible_lids: packet.visible_lids.length,
      candidate_count: packet.candidate_clusters.length,
      expected_output_items: packet.route.role === "direct" ? packet.candidate_clusters.length : 1,
    }),
    legacy_artifact_ref: `.build/paper-lexicon/${packet.work_unit_id}.json`,
  }));
  const skipUnits = Object.entries(analysis.skip_windows).map(([workUnitId, skip]) => createWorkUnitDescriptor({
    target: input.target,
    stage: "paper_lexicon",
    work_unit_id: workUnitId,
    kind: "lexicon_candidate_batch",
    input_hash: skip.input_hash,
    policy_fingerprint: input.policy_fingerprint,
    evidence_lids: skip.evidence,
    cost: buildWorkUnitCost({ visible_lids: skip.evidence.length }),
    deterministic_skip: { code: skip.code, evidence: skip.evidence },
  }));
  const work_units = [...batchUnits, ...skipUnits];
  return {
    ...analysis,
    version: "paper_lexicon_routing_plan.v3",
    work_units,
    plan_digest: workUnitPlanDigest(work_units),
  };
}

export function routePaperLexiconWorkUnitsWithRecovery(
  input: Parameters<typeof routePaperLexiconWorkUnits>[0],
): AutomaticBuildRouteResult<PaperLexiconRoutingPlan> {
  try {
    return readyAutomaticBuildRoute(routePaperLexiconWorkUnits(input));
  } catch (error) {
    if (!(error instanceof PaperLexiconRoutingBudgetBlock)) throw error;
    return blockedAutomaticBuildRoute(createAutomaticBuildRecoveryEnvelope({
      phase: "routing",
      code: "model_input_unsplittable",
      stage: "paper_lexicon",
      target_ref: input.target,
      router_version: PAPER_LEXICON_ROUTER_VERSION,
      policy_digest: extractionPolicyDigest(input.policy_fingerprint),
      affected_work_units: [{
        work_unit_id: error.work_unit_id,
        evidence_lids: [error.recovery.parent_lid],
        estimated_tokens: error.recovery.estimated_tokens,
        limit_tokens: error.recovery.limit_tokens,
      }],
      retryable: false,
      recovery_actions: ["upgrade_executor"],
    }));
  }
}

function lexiconStatus(
  workUnits: Array<{ work_unit_id: string; input_hash: string; deterministic_skip?: unknown }>,
  existing: ReadonlyMap<string, Pass1ArtifactMeta>,
): PaperLexiconRoutingStatus {
  const done_ids: string[] = [];
  const pending_ids: string[] = [];
  const skipped_ids: string[] = [];
  for (const unit of workUnits) {
    if (unit.deterministic_skip) skipped_ids.push(unit.work_unit_id);
    else if (existing.get(unit.work_unit_id)?.content_hash === unit.input_hash) done_ids.push(unit.work_unit_id);
    else pending_ids.push(unit.work_unit_id);
  }
  return {
    total: workUnits.length,
    eligible: done_ids.length + pending_ids.length,
    committed: done_ids.length,
    pending: pending_ids.length,
    skipped: skipped_ids.length,
    done_ids,
    pending_ids,
    skipped_ids,
  };
}

export function computePaperLexiconRoutingStatus(
  plan: PaperLexiconRoutingPlan,
  existing: ReadonlyMap<string, Pass1ArtifactMeta>,
): PaperLexiconRoutingStatus {
  return lexiconStatus(plan.work_units, existing);
}

export function computePaperLexiconCandidateStatus(input: {
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  existing: ReadonlyMap<string, Pass1ArtifactMeta>;
  existing_artifacts?: ReadonlyMap<string, PaperLexiconCommittedArtifactV1>;
  max_input_tokens?: number;
  max_candidates_per_batch?: number;
}): PaperLexiconCandidateStatus {
  const analysis = analyzePaperLexiconCandidates(input);
  const workUnits = [
    ...Object.values(analysis.packets).map((packet) => ({ work_unit_id: packet.work_unit_id, input_hash: packet.input_hash })),
    ...Object.entries(analysis.skip_windows).map(([workUnitId, skip]) => ({
      work_unit_id: workUnitId,
      input_hash: skip.input_hash,
      deterministic_skip: skip,
    })),
  ];
  return { analysis, ...lexiconStatus(workUnits, input.existing) };
}

function clusterForTerm(packet: PaperLexiconCandidatePacketV3, term: string): PaperLexiconCandidateClusterV1 | undefined {
  const key = normalizedText(term);
  return packet.candidate_clusters.find((cluster) =>
    cluster.normalized_key === key || cluster.surface_forms.some((surface) => normalizedText(surface) === key),
  );
}

export function buildPaperLexiconCandidateArtifact(
  packet: PaperLexiconCandidatePacketV3,
  lidNodes: LidNode[],
  output: PaperLexiconExtractionOutput,
): PaperLexiconArtifact {
  const entries = paperLexiconEntriesFromOutput(output);
  if (packet.route.role !== "direct" && entries.length > 1) {
    throw new Error(`lexicon ${packet.route.role} output must contain at most one entry`);
  }
  const seenClusters = new Set<string>();
  const enriched: PaperLexiconEntry[] = entries.map((entry) => {
    const cluster = clusterForTerm(packet, entry.term);
    if (!cluster) throw new Error(`lexicon candidate out of scope: ${entry.term}`);
    if (seenClusters.has(cluster.normalized_key)) {
      throw new Error(`lexicon output contains duplicate entries for cluster: ${cluster.normalized_key}`);
    }
    seenClusters.add(cluster.normalized_key);
    return {
      ...entry,
      occurrences_lids: packet.route.role === "fragment"
        ? [...entry.occurrences_lids]
        : [...cluster.occurrence_lids],
      ...(entry.defined_at_lid && !cluster.definition_lids.includes(entry.defined_at_lid)
        ? { defined_at_lid: undefined }
        : {}),
    };
  });
  const sidecar = buildPaperLexiconSidecar({
    book_id: "artifact-validation",
    book_version: "v1",
    profile_id: "paper",
    profile_version: "paper_v0",
    core_schema_version: "core_v0",
    generated_at: "1970-01-01T00:00:00.000Z",
  }, enriched, lidNodes);
  return {
    content_hash: packet.input_hash,
    route: {
      version: "paper_lexicon_artifact_route.v1",
      role: packet.route.role,
      cluster_keys: [...packet.route.cluster_keys],
      final: packet.route.role !== "fragment",
    },
    entries: sidecar.entries,
  };
}
