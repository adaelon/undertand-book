import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertTrustedPaperProjectionSource } from "./paper-projection-chain";
import {
  BookStructureSidecarZ,
  PaperLexiconZ,
  PaperMetadataZ,
  ReadOnlyBaseZ,
  TechnicalLearningDiscourseIndexZ,
} from "./zod";

const PAPER_READING_GUIDE_REQUIRED_FILES = [
  "source.txt",
  "base.json",
  "paper_metadata.json",
  "paper_lexicon.json",
  "book_structure.json",
] as const;

type PaperMetadata = z.infer<typeof PaperMetadataZ>;
type PaperLexicon = z.infer<typeof PaperLexiconZ>;
type BookStructure = z.infer<typeof BookStructureSidecarZ>;
type ArtifactHeader = PaperMetadata["header"];

export interface PaperReadingGuideVerificationResult {
  available: true;
  book_id: string;
  required_files: string[];
  lid_count: number;
  metadata_field_count: number;
  lexicon_entry_count: number;
  throughline_count: number;
  key_stop_count: number;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${file}: ${message}`);
  }
}

function parseFile<T>(workspace: string, relative: string, schema: z.ZodType<T>): T {
  const file = path.join(workspace, relative);
  if (!existsSync(file)) throw new Error(`PaperReadingGuide verification input missing: ${file}`);
  const result = schema.safeParse(readJson(file));
  if (!result.success) throw new Error(`${relative} failed schema validation: ${result.error.message}`);
  return result.data;
}

function assertHeader(owner: string, header: ArtifactHeader, bookId: string): void {
  if (header.book_id !== bookId) throw new Error(`${owner} header.book_id mismatch: ${header.book_id} != ${bookId}`);
  if (header.profile_id !== "paper") throw new Error(`${owner} header.profile_id must be paper`);
}

function assertLids(owner: string, values: string[], lids: Set<string>, required = false): void {
  if (required && values.length === 0) throw new Error(`${owner} requires evidence LIDs`);
  const dangling = values.filter((lid) => !lids.has(lid));
  if (dangling.length) throw new Error(`${owner} contains dangling LID(s): ${dangling.join(", ")}`);
}

function metadataFields(metadata: PaperMetadata): Array<[string, { source: string; evidence_lids?: string[] }]> {
  const fields: Array<[string, { source: string; evidence_lids?: string[] } | undefined]> = [
    ["title", metadata.title],
    ["authors", metadata.authors],
    ["affiliations", metadata.affiliations],
    ["venue", metadata.venue],
    ["year", metadata.year],
    ["identifiers.doi", metadata.identifiers?.doi],
    ["identifiers.arxiv", metadata.identifiers?.arxiv],
    ["identifiers.url", metadata.identifiers?.url],
    ["keywords", metadata.keywords],
    ["field_labels", metadata.field_labels],
    ["references", metadata.references],
    ["datasets", metadata.datasets],
    ["code_links", metadata.code_links],
    ["funding", metadata.funding],
  ];
  return fields.filter((item): item is [string, { source: string; evidence_lids?: string[] }] => item[1] !== undefined);
}

function validateMetadata(metadata: PaperMetadata, lids: Set<string>): number {
  const fields = metadataFields(metadata);
  for (const [name, field] of fields) {
    const evidence = field.evidence_lids ?? [];
    const evidenceRequired = field.source === "front_matter" || field.source === "paper_text";
    assertLids(`paper_metadata.${name}.evidence_lids`, evidence, lids, evidenceRequired);
  }
  return fields.length;
}

function validateLexicon(lexicon: PaperLexicon, lids: Set<string>): void {
  const terms = new Set<string>();
  for (const entry of lexicon.entries) {
    const key = entry.term.trim().toLocaleLowerCase();
    if (terms.has(key)) throw new Error(`paper_lexicon contains duplicate term: ${entry.term}`);
    terms.add(key);
    assertLids(`paper_lexicon.${entry.term}.occurrences_lids`, entry.occurrences_lids, lids, true);
    if (entry.defined_at_lid) {
      assertLids(`paper_lexicon.${entry.term}.defined_at_lid`, [entry.defined_at_lid], lids);
      if (!entry.occurrences_lids.includes(entry.defined_at_lid)) {
        throw new Error(`paper_lexicon.${entry.term}.defined_at_lid must appear in occurrences_lids`);
      }
    }
  }
}

function validateStructure(structure: BookStructure, lids: Set<string>): void {
  const keyStopIds = new Set<string>();
  for (const stop of structure.key_stops) {
    if (keyStopIds.has(stop.id)) throw new Error(`book_structure contains duplicate key_stop id: ${stop.id}`);
    keyStopIds.add(stop.id);
    assertLids(`book_structure.key_stop.${stop.id}.lid`, [stop.lid], lids);
    assertLids(`book_structure.key_stop.${stop.id}.reason`, stop.reason.evidence_lids, lids, true);
  }

  for (const unit of structure.spine) {
    assertLids(`book_structure.spine.${unit.lid}.lid`, [unit.lid], lids);
    assertLids(`book_structure.spine.${unit.lid}.summary`, unit.summary.evidence_lids, lids, true);
    assertLids(`book_structure.spine.${unit.lid}.depends_on`, unit.depends_on, lids);
    const danglingStops = unit.key_stop_ids.filter((id) => !keyStopIds.has(id));
    if (danglingStops.length) throw new Error(`book_structure.spine.${unit.lid} contains dangling key_stop id(s): ${danglingStops.join(", ")}`);
  }

  const throughlineIds = new Set<string>();
  for (const thread of structure.throughlines) {
    if (throughlineIds.has(thread.id)) throw new Error(`book_structure contains duplicate throughline id: ${thread.id}`);
    throughlineIds.add(thread.id);
    assertLids(`book_structure.throughline.${thread.id}.lids`, thread.lids, lids, true);
    assertLids(`book_structure.throughline.${thread.id}.summary`, thread.summary.evidence_lids, lids, true);
    const danglingStops = thread.key_stop_ids.filter((id) => !keyStopIds.has(id));
    if (danglingStops.length) throw new Error(`book_structure.throughline.${thread.id} contains dangling key_stop id(s): ${danglingStops.join(", ")}`);
  }
}

function validateOptionalDiscourse(workspace: string, bookId: string, lids: Set<string>): void {
  const file = path.join(workspace, "discourse_index.json");
  if (!existsSync(file)) return;
  const result = TechnicalLearningDiscourseIndexZ.safeParse(readJson(file));
  if (!result.success) throw new Error(`discourse_index.json failed schema validation: ${result.error.message}`);
  assertHeader("discourse_index.json", result.data.header, bookId);
  for (const item of result.data.items) {
    assertLids(`discourse_index.${item.lid}.lid`, [item.lid], lids);
    for (const relation of item.relations) {
      assertLids(`discourse_index.${item.lid}.target_lid`, [relation.target_lid], lids);
      assertLids(`discourse_index.${item.lid}.evidence_lids`, relation.evidence_lids, lids, true);
    }
  }
}

export function verifyPaperReadingGuideProjection(workspaceInput: string): PaperReadingGuideVerificationResult {
  const workspace = path.resolve(workspaceInput);
  const trusted = assertTrustedPaperProjectionSource(workspace);
  const source = readFileSync(path.join(workspace, "source.txt"), "utf8");
  const base = parseFile(workspace, "base.json", ReadOnlyBaseZ);
  if (base.book_id !== trusted.book_id) throw new Error(`base.json book_id mismatch: ${base.book_id} != ${trusted.book_id}`);

  const lids = new Set<string>();
  for (const node of base.lid_nodes) {
    if (lids.has(node.lid)) throw new Error(`base.json contains duplicate LID: ${node.lid}`);
    lids.add(node.lid);
    if (node.span.end < node.span.start || node.span.end > source.length) {
      throw new Error(`base.json LID ${node.lid} has invalid UTF-16 span [${node.span.start}, ${node.span.end})`);
    }
  }
  for (const node of base.lid_nodes) assertLids(`base.json.${node.lid}.children`, node.children, lids);

  const metadata = parseFile(workspace, "paper_metadata.json", PaperMetadataZ);
  const lexicon = parseFile(workspace, "paper_lexicon.json", PaperLexiconZ);
  const structure = parseFile(workspace, "book_structure.json", BookStructureSidecarZ);
  assertHeader("paper_metadata.json", metadata.header, trusted.book_id);
  assertHeader("paper_lexicon.json", lexicon.header, trusted.book_id);
  assertHeader("book_structure.json", structure.header, trusted.book_id);

  const metadataFieldCount = validateMetadata(metadata, lids);
  validateLexicon(lexicon, lids);
  validateStructure(structure, lids);
  validateOptionalDiscourse(workspace, trusted.book_id, lids);

  return {
    available: true,
    book_id: trusted.book_id,
    required_files: [...PAPER_READING_GUIDE_REQUIRED_FILES],
    lid_count: lids.size,
    metadata_field_count: metadataFieldCount,
    lexicon_entry_count: lexicon.entries.length,
    throughline_count: structure.throughlines.length,
    key_stop_count: structure.key_stops.length,
  };
}
