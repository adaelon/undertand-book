import type { LidNode } from "./generated/LidNode";
import type { ProfileArtifactHeader } from "./profile-artifact";
import { pass1ContentHash, type Pass1ArtifactMeta } from "./build-resume";
import { buildPass1Input } from "./pass1-input";
import type { Window } from "./window";

export const METADATA_SOURCES = ["front_matter", "paper_text", "user_supplied", "filename", "external_resolver"] as const;
export type MetadataSource = (typeof METADATA_SOURCES)[number];

export interface MetadataField<T> {
  value: T;
  source: MetadataSource;
  evidence_lids?: string[];
  confidence?: number;
}

export interface PaperAuthor {
  name: string;
  raw?: string;
}

export interface PaperReference {
  raw: string;
  identifiers?: Record<string, string>;
}

export interface PaperMetadataFields {
  title?: MetadataField<string>;
  authors?: MetadataField<PaperAuthor[]>;
  affiliations?: MetadataField<string[]>;
  venue?: MetadataField<string>;
  year?: MetadataField<number>;
  identifiers?: {
    doi?: MetadataField<string>;
    arxiv?: MetadataField<string>;
    url?: MetadataField<string>;
  };
  keywords?: MetadataField<string[]>;
  field_labels?: MetadataField<string[]>;
  references?: MetadataField<PaperReference[]>;
  datasets?: MetadataField<string[]>;
  code_links?: MetadataField<string[]>;
  funding?: MetadataField<string[]>;
}

export interface PaperMetadataSidecar extends PaperMetadataFields {
  header: ProfileArtifactHeader;
}

export type PaperMetadataExtractionOutput = PaperMetadataFields | { paper_metadata: PaperMetadataFields };

export interface PaperMetadataArtifact extends Pass1ArtifactMeta {
  metadata: PaperMetadataFields;
}

export interface PaperMetadataWindowInput {
  window_id: number;
  visible_lids: string[];
  requested_fields: string[];
  text: string;
}

export interface PaperMetadataStatus {
  done: number[];
  pending: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetadataSource(value: unknown): value is MetadataSource {
  return typeof value === "string" && (METADATA_SOURCES as readonly string[]).includes(value);
}

function paperMetadataFieldsFromOutput(output: PaperMetadataExtractionOutput): PaperMetadataFields {
  const maybeWrapped = output as { paper_metadata?: PaperMetadataFields };
  return maybeWrapped.paper_metadata ?? (output as PaperMetadataFields);
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values)];
}

function assertEvidence(fieldName: string, field: Record<string, unknown>, lidSet: Set<string>): string[] | undefined {
  const source = field.source;
  const evidence = field.evidence_lids;
  if (evidence !== undefined) {
    if (!Array.isArray(evidence) || evidence.some((lid) => typeof lid !== "string" || !lid.trim())) {
      throw new Error(`${fieldName}.evidence_lids must be a string array`);
    }
    if (evidence.length === 0) throw new Error(`${fieldName}.evidence_lids must be non-empty when provided`);
    const dangling = evidence.filter((lid) => !lidSet.has(lid));
    if (dangling.length) throw new Error(`${fieldName}.evidence_lids contains dangling LID(s): ${dangling.join(",")}`);
  }
  if ((source === "front_matter" || source === "paper_text") && evidence === undefined) {
    throw new Error(`${fieldName}.evidence_lids is required for source ${source}`);
  }
  return uniqueStrings(evidence as string[] | undefined);
}

function normalizeMetadataField<T>(
  fieldName: string,
  raw: unknown,
  lidSet: Set<string>,
  isValue: (value: unknown) => value is T,
  valueDescription: string,
): MetadataField<T> {
  if (!isRecord(raw) || !("value" in raw) || !("source" in raw)) {
    throw new Error(`${fieldName} must be a MetadataField envelope with value/source`);
  }
  if (!isMetadataSource(raw.source)) throw new Error(`${fieldName}.source is invalid`);
  if (!isValue(raw.value)) throw new Error(`${fieldName}.value must be ${valueDescription}`);
  if (raw.confidence !== undefined && (typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1)) {
    throw new Error(`${fieldName}.confidence must be between 0 and 1`);
  }
  const evidence_lids = assertEvidence(fieldName, raw, lidSet);
  return {
    value: raw.value,
    source: raw.source,
    ...(evidence_lids ? { evidence_lids } : {}),
    ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isAuthorArray(value: unknown): value is PaperAuthor[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        isString(item.name) &&
        (item.raw === undefined || typeof item.raw === "string"),
    )
  );
}

function isReferenceArray(value: unknown): value is PaperReference[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        isString(item.raw) &&
        (item.identifiers === undefined ||
          (isRecord(item.identifiers) && Object.values(item.identifiers).every((identifier) => typeof identifier === "string"))),
    )
  );
}

function normalizePaperMetadataFields(raw: unknown, lidNodes: LidNode[]): PaperMetadataFields {
  if (!isRecord(raw)) throw new Error("paper_metadata must be an object");
  const lidSet = new Set(lidNodes.map((node) => node.lid));
  const out: PaperMetadataFields = {};
  if (raw.title !== undefined) out.title = normalizeMetadataField("title", raw.title, lidSet, isString, "a non-empty string");
  if (raw.authors !== undefined) out.authors = normalizeMetadataField("authors", raw.authors, lidSet, isAuthorArray, "an author array");
  if (raw.affiliations !== undefined) {
    out.affiliations = normalizeMetadataField("affiliations", raw.affiliations, lidSet, isStringArray, "a string array");
  }
  if (raw.venue !== undefined) out.venue = normalizeMetadataField("venue", raw.venue, lidSet, isString, "a non-empty string");
  if (raw.year !== undefined) out.year = normalizeMetadataField("year", raw.year, lidSet, isNumber, "a number");
  if (raw.identifiers !== undefined) {
    if (!isRecord(raw.identifiers)) throw new Error("identifiers must be an object");
    out.identifiers = {};
    for (const key of ["doi", "arxiv", "url"] as const) {
      if (raw.identifiers[key] !== undefined) {
        out.identifiers[key] = normalizeMetadataField(`identifiers.${key}`, raw.identifiers[key], lidSet, isString, "a non-empty string");
      }
    }
    if (!Object.keys(out.identifiers).length) delete out.identifiers;
  }
  if (raw.keywords !== undefined) out.keywords = normalizeMetadataField("keywords", raw.keywords, lidSet, isStringArray, "a string array");
  if (raw.field_labels !== undefined) {
    out.field_labels = normalizeMetadataField("field_labels", raw.field_labels, lidSet, isStringArray, "a string array");
  }
  if (raw.references !== undefined) {
    out.references = normalizeMetadataField("references", raw.references, lidSet, isReferenceArray, "a reference array");
  }
  if (raw.datasets !== undefined) out.datasets = normalizeMetadataField("datasets", raw.datasets, lidSet, isStringArray, "a string array");
  if (raw.code_links !== undefined) out.code_links = normalizeMetadataField("code_links", raw.code_links, lidSet, isStringArray, "a string array");
  if (raw.funding !== undefined) out.funding = normalizeMetadataField("funding", raw.funding, lidSet, isStringArray, "a string array");
  return out;
}

function mergeEvidence<T>(current: MetadataField<T>, next: MetadataField<T>): MetadataField<T> {
  const evidence_lids = uniqueStrings([...(current.evidence_lids ?? []), ...(next.evidence_lids ?? [])]);
  return {
    ...current,
    ...(evidence_lids?.length ? { evidence_lids } : {}),
    confidence: Math.max(current.confidence ?? 0, next.confidence ?? 0) || undefined,
  };
}

function mergeArrayField<T>(
  current: MetadataField<T[]> | undefined,
  next: MetadataField<T[]> | undefined,
  keyOf: (item: T) => string,
): MetadataField<T[]> | undefined {
  if (!next) return current;
  if (!current) return next;
  const seen = new Set(current.value.map(keyOf));
  const value = [...current.value];
  for (const item of next.value) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.add(key);
      value.push(item);
    }
  }
  return { ...mergeEvidence(current, next), value };
}

function firstField<T>(current: MetadataField<T> | undefined, next: MetadataField<T> | undefined): MetadataField<T> | undefined {
  return current ?? next;
}

function mergeIdentifiers(
  current: PaperMetadataFields["identifiers"],
  next: PaperMetadataFields["identifiers"],
): PaperMetadataFields["identifiers"] {
  if (!next) return current;
  const merged = { ...(current ?? {}) };
  for (const key of ["doi", "arxiv", "url"] as const) {
    merged[key] = firstField(merged[key], next[key]);
  }
  return Object.keys(merged).length ? merged : undefined;
}

function compactFields(fields: PaperMetadataFields): PaperMetadataFields {
  const out: PaperMetadataFields = {};
  if (fields.title) out.title = fields.title;
  if (fields.authors) out.authors = fields.authors;
  if (fields.affiliations) out.affiliations = fields.affiliations;
  if (fields.venue) out.venue = fields.venue;
  if (fields.year) out.year = fields.year;
  if (fields.identifiers) {
    const identifiers: NonNullable<PaperMetadataFields["identifiers"]> = {};
    if (fields.identifiers.doi) identifiers.doi = fields.identifiers.doi;
    if (fields.identifiers.arxiv) identifiers.arxiv = fields.identifiers.arxiv;
    if (fields.identifiers.url) identifiers.url = fields.identifiers.url;
    if (Object.keys(identifiers).length) out.identifiers = identifiers;
  }
  if (fields.keywords) out.keywords = fields.keywords;
  if (fields.field_labels) out.field_labels = fields.field_labels;
  if (fields.references) out.references = fields.references;
  if (fields.datasets) out.datasets = fields.datasets;
  if (fields.code_links) out.code_links = fields.code_links;
  if (fields.funding) out.funding = fields.funding;
  return out;
}

export function buildPaperMetadataSidecar(
  header: ProfileArtifactHeader,
  candidates: PaperMetadataFields[],
  lidNodes: LidNode[],
): PaperMetadataSidecar {
  let merged: PaperMetadataFields = {};
  for (const candidate of candidates) {
    const normalized = normalizePaperMetadataFields(candidate, lidNodes);
    merged = {
      title: firstField(merged.title, normalized.title),
      authors: firstField(merged.authors, normalized.authors),
      affiliations: mergeArrayField(merged.affiliations, normalized.affiliations, (item) => item),
      venue: firstField(merged.venue, normalized.venue),
      year: firstField(merged.year, normalized.year),
      identifiers: mergeIdentifiers(merged.identifiers, normalized.identifiers),
      keywords: mergeArrayField(merged.keywords, normalized.keywords, (item) => item),
      field_labels: mergeArrayField(merged.field_labels, normalized.field_labels, (item) => item),
      references: mergeArrayField(merged.references, normalized.references, (item) => item.raw),
      datasets: mergeArrayField(merged.datasets, normalized.datasets, (item) => item),
      code_links: mergeArrayField(merged.code_links, normalized.code_links, (item) => item),
      funding: mergeArrayField(merged.funding, normalized.funding, (item) => item),
    };
  }
  return { header, ...compactFields(merged) };
}

export function buildPaperMetadataArtifact(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  output: PaperMetadataExtractionOutput,
): PaperMetadataArtifact {
  return {
    content_hash: pass1ContentHash(buildPass1Input(window, byLid, source)),
    metadata: normalizePaperMetadataFields(paperMetadataFieldsFromOutput(output), [...byLid.values()]),
  };
}

export function buildPaperMetadataWindowInput(window: Window, byLid: Map<string, LidNode>, source: string): PaperMetadataWindowInput {
  return {
    window_id: window.id,
    visible_lids: [...window.leafLids],
    requested_fields: [
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
      "references",
      "datasets",
      "code_links",
      "funding",
    ],
    text: buildPass1Input(window, byLid, source).text,
  };
}

export function computePaperMetadataStatus(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  existing: Map<number, Pass1ArtifactMeta>,
): PaperMetadataStatus {
  const done: number[] = [];
  const pending: number[] = [];
  for (const w of windows) {
    const expected = pass1ContentHash(buildPass1Input(w, byLid, source));
    const got = existing.get(w.id);
    if (got && got.content_hash === expected) done.push(w.id);
    else pending.push(w.id);
  }
  return { done, pending };
}
