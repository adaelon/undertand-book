import type { BuildTargetRefV2 } from "./build-orchestrator";
import type { Pass1ArtifactMeta } from "./build-resume";
import { pass1ContentHash } from "./build-resume";
import type { LidNode } from "./generated/LidNode";
import {
  buildPaperMetadataWindowInput,
  type PaperMetadataFields,
  type PaperMetadataWindowInput,
  type PaperReference,
} from "./paper-metadata";
import { buildPass1Input } from "./pass1-input";
import type { ExtractionPolicyFingerprintV1 } from "./semantic-artifact";
import {
  buildWorkUnitCost,
  createWorkUnitDescriptor,
  workUnitPlanDigest,
  type WorkUnitDescriptorV2,
} from "./stage-work-unit";
import { estimateTokens, type Window } from "./window";

export const PAPER_METADATA_ROUTER_VERSION = "paper_metadata_candidate.v2" as const;

export const PAPER_METADATA_SIGNAL_TYPES = [
  "front_matter",
  "bibliography_ambiguous",
  "identifier",
  "dataset",
  "code_link",
  "funding",
] as const;

export type PaperMetadataSignalType = (typeof PAPER_METADATA_SIGNAL_TYPES)[number];

export interface PaperMetadataCandidatePacket extends PaperMetadataWindowInput {
  work_unit_id: string;
  signal_types: PaperMetadataSignalType[];
}

export interface PaperMetadataRoutingAnalysis {
  version: "paper_metadata_routing_analysis.v2";
  router_version: typeof PAPER_METADATA_ROUTER_VERSION;
  packets: Record<string, PaperMetadataCandidatePacket>;
  deterministic_metadata: PaperMetadataFields;
  skip_reasons: Record<string, { code: "no_metadata_signal" | "deterministic_metadata_extracted"; evidence: string[] }>;
}

export interface PaperMetadataRoutingPlan extends Omit<PaperMetadataRoutingAnalysis, "version"> {
  version: "paper_metadata_routing_plan.v2";
  work_units: WorkUnitDescriptorV2[];
  plan_digest: string;
}

export interface PaperMetadataRoutingStatus {
  total: number;
  eligible: number;
  committed: number;
  pending: number;
  skipped: number;
  done_ids: number[];
  pending_ids: number[];
  skipped_ids: number[];
}

export interface PaperMetadataCandidateStatus extends PaperMetadataRoutingStatus {
  analysis: PaperMetadataRoutingAnalysis;
}

interface ReferenceGroup {
  number?: number;
  fragments: string[];
  evidence_lids: string[];
}

interface WindowSignals {
  signalTypes: Set<PaperMetadataSignalType>;
  requestedFields: Set<string>;
}

const FRONT_MATTER_FIELDS = [
  "title",
  "authors",
  "affiliations",
  "venue",
  "year",
  "identifiers.doi",
  "identifiers.arxiv",
  "identifiers.url",
  "keywords",
  "field_labels",
] as const;

const REQUESTED_FIELD_ORDER = [
  ...FRONT_MATTER_FIELDS,
  "references",
  "datasets",
  "code_links",
  "funding",
] as const;

function normalizedLeafText(node: LidNode, source: string): string {
  return source.slice(node.span.start, node.span.end).replace(/\s+/g, " ").trim();
}

function heading(text: string): { level: number; name: string } | undefined {
  const match = text.match(/^(#{1,6})\s+(.+?)\s*$/);
  return match ? { level: match[1].length, name: match[2].trim() } : undefined;
}

function isBibliographyHeading(name: string): boolean {
  return /^(?:references|bibliography|works cited)(?:\s+continued)?$/i.test(name);
}

function normalizeReferenceFragment(fragment: string): string {
  return fragment
    .replace(/\$?\s*\\underline\{\\text\{([^{}]*)\}\}\s*\$?/g, "$1")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function referenceIdentifiers(raw: string): Record<string, string> | undefined {
  const identifiers: Record<string, string> = {};
  const doi = raw.match(/(?:doi\s*:\s*|https?:\/\/doi\.org\/)(10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+)/i);
  if (doi) identifiers.doi = doi[1].replace(/[.,;]+$/, "");
  const arxiv = raw.match(/(?:arxiv\s*:?\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (arxiv) identifiers.arxiv = arxiv[1];
  const url = raw.match(/https?:\/\/[^\s)]+/i);
  if (url) identifiers.url = url[0].replace(/[.,;]+$/, "");
  return Object.keys(identifiers).length ? identifiers : undefined;
}

function finalizeReferenceGroup(
  group: ReferenceGroup | undefined,
  structured: Array<{ reference: PaperReference; evidence_lids: string[] }>,
  ambiguous: ReferenceGroup[],
): void {
  if (!group || group.fragments.length === 0) return;
  const body = group.fragments.map(normalizeReferenceFragment).filter(Boolean).join(" ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  const raw = group.number === undefined ? body : `[${group.number}] ${body}`;
  const hasBibliographicAnchor = /\b(?:19|20)\d{2}[a-z]?\b/.test(raw) || referenceIdentifiers(raw) !== undefined;
  if (group.number !== undefined && raw.length >= 40 && hasBibliographicAnchor) {
    const identifiers = referenceIdentifiers(raw);
    structured.push({
      reference: { raw, ...(identifiers ? { identifiers } : {}) },
      evidence_lids: [...group.evidence_lids],
    });
  } else {
    ambiguous.push(group);
  }
}

function bibliographyGroups(
  orderedLeaves: LidNode[],
  source: string,
): {
  structured: Array<{ reference: PaperReference; evidence_lids: string[] }>;
  ambiguous: ReferenceGroup[];
  bibliographyLids: Set<string>;
} {
  const structured: Array<{ reference: PaperReference; evidence_lids: string[] }> = [];
  const ambiguous: ReferenceGroup[] = [];
  const bibliographyLids = new Set<string>();
  let bibliographyLevel: number | undefined;
  let current: ReferenceGroup | undefined;

  for (const node of orderedLeaves) {
    const text = normalizedLeafText(node, source);
    const parsedHeading = heading(text);
    if (parsedHeading) {
      if (bibliographyLevel !== undefined && parsedHeading.level <= bibliographyLevel) {
        finalizeReferenceGroup(current, structured, ambiguous);
        current = undefined;
        bibliographyLevel = undefined;
      }
      if (isBibliographyHeading(parsedHeading.name)) {
        bibliographyLevel = parsedHeading.level;
        bibliographyLids.add(node.lid);
      }
      continue;
    }
    if (bibliographyLevel === undefined || !text) continue;
    bibliographyLids.add(node.lid);
    const numbered = text.match(/^\[(\d+)]\s*(.*)$/s);
    if (numbered) {
      finalizeReferenceGroup(current, structured, ambiguous);
      current = {
        number: Number(numbered[1]),
        fragments: numbered[2] ? [numbered[2]] : [],
        evidence_lids: [node.lid],
      };
    } else if (current) {
      current.fragments.push(text);
      current.evidence_lids.push(node.lid);
    } else {
      current = { fragments: [text], evidence_lids: [node.lid] };
    }
  }
  finalizeReferenceGroup(current, structured, ambiguous);
  return { structured, ambiguous, bibliographyLids };
}

function windowForLid(windows: Window[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const window of windows) for (const lid of window.leafLids) result.set(lid, window.id);
  return result;
}

function addSignal(
  signals: Map<number, WindowSignals>,
  windowId: number,
  signalType: PaperMetadataSignalType,
  fields: readonly string[],
): void {
  const current = signals.get(windowId) ?? { signalTypes: new Set(), requestedFields: new Set() };
  current.signalTypes.add(signalType);
  for (const field of fields) current.requestedFields.add(field);
  signals.set(windowId, current);
}

function signalEvidenceByWindow(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  bibliographyLids: ReadonlySet<string>,
): Map<number, Array<{ lid: string; text: string }>> {
  return new Map(windows.map((window) => [
    window.id,
    window.leafLids
      .filter((lid) => !bibliographyLids.has(lid))
      .map((lid) => ({ lid, text: normalizedLeafText(byLid.get(lid)!, source) })),
  ]));
}

function orderedSignals(signals: ReadonlySet<PaperMetadataSignalType>): PaperMetadataSignalType[] {
  return PAPER_METADATA_SIGNAL_TYPES.filter((signal) => signals.has(signal));
}

function orderedFields(fields: ReadonlySet<string>): string[] {
  return REQUESTED_FIELD_ORDER.filter((field) => fields.has(field));
}

export function analyzePaperMetadataCandidates(input: {
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
}): PaperMetadataRoutingAnalysis {
  const orderedLeaves = [...input.byLid.values()]
    .filter((node) => node.children.length === 0)
    .sort((left, right) => left.span.start - right.span.start);
  const lidWindows = windowForLid(input.windows);
  const bibliography = bibliographyGroups(orderedLeaves, input.source);
  const signals = new Map<number, WindowSignals>();

  const firstWindow = input.windows[0];
  if (firstWindow) addSignal(signals, firstWindow.id, "front_matter", FRONT_MATTER_FIELDS);

  for (const group of bibliography.ambiguous) {
    const affectedWindows = new Set(group.evidence_lids.map((lid) => lidWindows.get(lid)).filter((id): id is number => id !== undefined));
    for (const windowId of affectedWindows) addSignal(signals, windowId, "bibliography_ambiguous", ["references"]);
  }

  const nonBibliographyEvidence = signalEvidenceByWindow(input.windows, input.byLid, input.source, bibliography.bibliographyLids);
  for (const window of input.windows) {
    const evidence = nonBibliographyEvidence.get(window.id) ?? [];
    const text = evidence.map((item) => item.text).join("\n");
    if (/(?:doi\s*:\s*|https?:\/\/doi\.org\/)10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+|(?:arxiv\s*:?\s*|arxiv\.org\/(?:abs|pdf)\/)\d{4}\.\d{4,5}/i.test(text)) {
      addSignal(signals, window.id, "identifier", ["identifiers.doi", "identifiers.arxiv", "identifiers.url"]);
    }
    if (/\bclass\s+[A-Za-z_]\w*Dataset\s*\(|^#{1,6}\s+(?:data|dataset) availability\b/im.test(text)) {
      addSignal(signals, window.id, "dataset", ["datasets"]);
    }
    if (/https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co\/(?:datasets|spaces)|zenodo\.org\/record)[^\s)]*/i.test(text)
      || /^#{1,6}\s+code availability\b/im.test(text)) {
      addSignal(signals, window.id, "code_link", ["code_links"]);
    }
    if (/\bfunded by\b|\bfinancial(?:ly)? supported by\b|\bgrant\s+(?:no\.?\s*)?[A-Za-z0-9-]+|^#{1,6}\s+acknowledg(?:e)?ments?\b/im.test(text)) {
      addSignal(signals, window.id, "funding", ["funding"]);
    }
  }

  const deterministicEvidence = bibliography.structured.flatMap((entry) => entry.evidence_lids);
  const deterministic_metadata: PaperMetadataFields = bibliography.structured.length ? {
    references: {
      value: bibliography.structured.map((entry) => entry.reference),
      source: "paper_text",
      evidence_lids: [...new Set(deterministicEvidence)],
      confidence: 1,
    },
  } : {};
  const structuredByWindow = new Map<number, string[]>();
  for (const lid of deterministicEvidence) {
    const windowId = lidWindows.get(lid);
    if (windowId === undefined) continue;
    structuredByWindow.set(windowId, [...(structuredByWindow.get(windowId) ?? []), lid]);
  }

  const packets: Record<string, PaperMetadataCandidatePacket> = {};
  const skip_reasons: PaperMetadataRoutingAnalysis["skip_reasons"] = {};
  for (const window of input.windows) {
    const windowSignals = signals.get(window.id);
    if (windowSignals?.requestedFields.size) {
      const base = buildPaperMetadataWindowInput(window, input.byLid, input.source);
      packets[String(window.id)] = {
        ...base,
        work_unit_id: String(window.id),
        signal_types: orderedSignals(windowSignals.signalTypes),
        requested_fields: orderedFields(windowSignals.requestedFields),
      };
      continue;
    }
    const structuredEvidence = structuredByWindow.get(window.id);
    skip_reasons[String(window.id)] = structuredEvidence?.length ? {
      code: "deterministic_metadata_extracted",
      evidence: [...structuredEvidence],
    } : {
      code: "no_metadata_signal",
      evidence: [...window.leafLids],
    };
  }

  return {
    version: "paper_metadata_routing_analysis.v2",
    router_version: PAPER_METADATA_ROUTER_VERSION,
    packets,
    deterministic_metadata,
    skip_reasons,
  };
}

export function routePaperMetadataWorkUnits(input: {
  target: BuildTargetRefV2;
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  policy_fingerprint: ExtractionPolicyFingerprintV1;
}): PaperMetadataRoutingPlan {
  const analysis = analyzePaperMetadataCandidates(input);
  const work_units = input.windows.map((window) => {
    const pass1Input = buildPass1Input(window, input.byLid, input.source);
    const packet = analysis.packets[String(window.id)];
    const skip = analysis.skip_reasons[String(window.id)];
    return createWorkUnitDescriptor({
      target: input.target,
      stage: "paper_metadata",
      work_unit_id: String(window.id),
      kind: "metadata_region",
      input_hash: pass1ContentHash(pass1Input),
      policy_fingerprint: input.policy_fingerprint,
      evidence_lids: window.leafLids,
      cost: buildWorkUnitCost({
        estimated_input_tokens: estimateTokens(packet?.text ?? pass1Input.text),
        visible_lids: window.leafLids.length,
        formula_lids: window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "formula").length,
        table_fragments: window.leafLids.filter((lid) => input.byLid.get(lid)?.kind === "table").length,
        candidate_count: packet?.signal_types.length ?? 0,
        expected_output_items: packet?.requested_fields.length ?? 0,
      }),
      ...(skip ? { deterministic_skip: skip } : {}),
      legacy_artifact_ref: `.build/paper-metadata/${window.id}.json`,
    });
  });
  return {
    ...analysis,
    version: "paper_metadata_routing_plan.v2",
    work_units,
    plan_digest: workUnitPlanDigest(work_units),
  };
}

export function computePaperMetadataRoutingStatus(
  plan: PaperMetadataRoutingPlan,
  existing: ReadonlyMap<number, Pass1ArtifactMeta>,
): PaperMetadataRoutingStatus {
  const done_ids: number[] = [];
  const pending_ids: number[] = [];
  const skipped_ids: number[] = [];
  for (const unit of plan.work_units) {
    const id = Number(unit.work_unit_id);
    if (!Number.isInteger(id)) throw new Error(`paper metadata work unit id must be numeric: ${unit.work_unit_id}`);
    if (unit.deterministic_skip) {
      skipped_ids.push(id);
      continue;
    }
    if (existing.get(id)?.content_hash === unit.input_hash) done_ids.push(id);
    else pending_ids.push(id);
  }
  return {
    total: plan.work_units.length,
    eligible: done_ids.length + pending_ids.length,
    committed: done_ids.length,
    pending: pending_ids.length,
    skipped: skipped_ids.length,
    done_ids,
    pending_ids,
    skipped_ids,
  };
}

export function computePaperMetadataCandidateStatus(input: {
  windows: Window[];
  byLid: Map<string, LidNode>;
  source: string;
  existing: ReadonlyMap<number, Pass1ArtifactMeta>;
}): PaperMetadataCandidateStatus {
  const analysis = analyzePaperMetadataCandidates(input);
  const done_ids: number[] = [];
  const pending_ids: number[] = [];
  const skipped_ids: number[] = [];
  for (const window of input.windows) {
    if (analysis.skip_reasons[String(window.id)]) {
      skipped_ids.push(window.id);
      continue;
    }
    const inputHash = pass1ContentHash(buildPass1Input(window, input.byLid, input.source));
    if (input.existing.get(window.id)?.content_hash === inputHash) done_ids.push(window.id);
    else pending_ids.push(window.id);
  }
  return {
    analysis,
    total: input.windows.length,
    eligible: done_ids.length + pending_ids.length,
    committed: done_ids.length,
    pending: pending_ids.length,
    skipped: skipped_ids.length,
    done_ids,
    pending_ids,
    skipped_ids,
  };
}
