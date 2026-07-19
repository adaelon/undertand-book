import type { LidNode } from "./generated/LidNode";
import type { ProfileArtifactHeader } from "./profile-artifact";
import { pass1ContentHash, type Pass1ArtifactMeta } from "./build-resume";
import { buildPass1Input } from "./pass1-input";
import type { Window } from "./window";

export const PAPER_TERM_TYPES = [
  "paper_defined_term",
  "method_name",
  "acronym",
  "domain_term",
  "dataset_name",
  "metric_name",
  "model_name",
  "academic_phrase",
] as const;
export type PaperTermType = (typeof PAPER_TERM_TYPES)[number];

export interface PaperLexiconEntry {
  term: string;
  term_type: PaperTermType;
  occurrences_lids: string[];
  defined_at_lid?: string;
  aliases?: string[];
  acronym_expansion?: string;
  chinese_gloss?: string;
}

export interface PaperLexiconSidecar {
  header: ProfileArtifactHeader;
  entries: PaperLexiconEntry[];
}

export interface PaperLexiconExtractionOutput {
  entries?: PaperLexiconEntry[];
  paper_lexicon?: {
    entries?: PaperLexiconEntry[];
  };
}

export interface PaperLexiconArtifact extends Pass1ArtifactMeta {
  entries: PaperLexiconEntry[];
}

export interface PaperLexiconWindowInput {
  window_id: number;
  visible_lids: string[];
  requested_term_types: PaperTermType[];
  text: string;
}

export interface PaperLexiconStatus {
  done: number[];
  pending: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaperTermType(value: unknown): value is PaperTermType {
  return typeof value === "string" && (PAPER_TERM_TYPES as readonly string[]).includes(value);
}

function requireNonEmptyString(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function normalizeOptionalStringArray(field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a string array`);
  }
  return [...new Set(value)];
}

function normalizeEntry(raw: unknown, lidSet: Set<string>): PaperLexiconEntry {
  if (!isRecord(raw)) throw new Error("paper_lexicon entry must be an object");
  const term = requireNonEmptyString("term", raw.term);
  if (!isPaperTermType(raw.term_type)) throw new Error(`term_type is invalid for term "${term}"`);
  if (!Array.isArray(raw.occurrences_lids) || raw.occurrences_lids.length === 0) {
    throw new Error(`occurrences_lids is required for term "${term}"`);
  }
  const occurrences_lids = normalizeOptionalStringArray("occurrences_lids", raw.occurrences_lids)!;
  const dangling = occurrences_lids.filter((lid) => !lidSet.has(lid));
  if (dangling.length) throw new Error(`occurrences_lids contains dangling LID(s) for term "${term}": ${dangling.join(",")}`);
  const defined_at_lid = raw.defined_at_lid === undefined ? undefined : requireNonEmptyString("defined_at_lid", raw.defined_at_lid);
  if (defined_at_lid) {
    if (!lidSet.has(defined_at_lid)) throw new Error(`defined_at_lid is dangling for term "${term}": ${defined_at_lid}`);
    if (!occurrences_lids.includes(defined_at_lid)) {
      throw new Error(`defined_at_lid must also appear in occurrences_lids for term "${term}"`);
    }
  }
  return {
    term,
    term_type: raw.term_type,
    occurrences_lids,
    ...(defined_at_lid ? { defined_at_lid } : {}),
    ...(raw.aliases !== undefined ? { aliases: normalizeOptionalStringArray("aliases", raw.aliases) } : {}),
    ...(raw.acronym_expansion !== undefined ? { acronym_expansion: requireNonEmptyString("acronym_expansion", raw.acronym_expansion) } : {}),
    ...(raw.chinese_gloss !== undefined ? { chinese_gloss: requireNonEmptyString("chinese_gloss", raw.chinese_gloss) } : {}),
  };
}

export function paperLexiconEntriesFromOutput(output: PaperLexiconExtractionOutput): PaperLexiconEntry[] {
  return output.paper_lexicon?.entries ?? output.entries ?? [];
}

export function normalizePaperLexiconKey(term: string): string {
  return term
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u2010-\u2015_-]+/g, " ")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keyOf(entry: PaperLexiconEntry): string {
  return normalizePaperLexiconKey(entry.term);
}

function mergeEntry(current: PaperLexiconEntry, next: PaperLexiconEntry): PaperLexiconEntry {
  return {
    ...current,
    occurrences_lids: [...new Set([...current.occurrences_lids, ...next.occurrences_lids])],
    aliases: current.aliases || next.aliases ? [...new Set([...(current.aliases ?? []), ...(next.aliases ?? [])])] : undefined,
    defined_at_lid: current.defined_at_lid ?? next.defined_at_lid,
    acronym_expansion: current.acronym_expansion ?? next.acronym_expansion,
    chinese_gloss: current.chinese_gloss ?? next.chinese_gloss,
  };
}

export function buildPaperLexiconSidecar(
  header: ProfileArtifactHeader,
  entries: PaperLexiconEntry[],
  lidNodes: LidNode[],
): PaperLexiconSidecar {
  const lidSet = new Set(lidNodes.map((node) => node.lid));
  const byTerm = new Map<string, PaperLexiconEntry>();
  for (const raw of entries) {
    const entry = normalizeEntry(raw, lidSet);
    const key = keyOf(entry);
    byTerm.set(key, byTerm.has(key) ? mergeEntry(byTerm.get(key)!, entry) : entry);
  }
  return { header, entries: [...byTerm.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) };
}

export function buildPaperLexiconArtifact(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  output: PaperLexiconExtractionOutput,
): PaperLexiconArtifact {
  const lidNodes = [...byLid.values()];
  const sidecar = buildPaperLexiconSidecar(
    {
      book_id: "artifact-validation",
      book_version: "v1",
      profile_id: "paper",
      profile_version: "paper_v0",
      core_schema_version: "core_v0",
      generated_at: "1970-01-01T00:00:00.000Z",
    },
    paperLexiconEntriesFromOutput(output),
    lidNodes,
  );
  return {
    content_hash: pass1ContentHash(buildPass1Input(window, byLid, source)),
    entries: sidecar.entries,
  };
}

export function buildPaperLexiconWindowInput(window: Window, byLid: Map<string, LidNode>, source: string): PaperLexiconWindowInput {
  return {
    window_id: window.id,
    visible_lids: [...window.leafLids],
    requested_term_types: [...PAPER_TERM_TYPES],
    text: buildPass1Input(window, byLid, source).text,
  };
}

export function computePaperLexiconStatus(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  existing: Map<number, Pass1ArtifactMeta>,
): PaperLexiconStatus {
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
