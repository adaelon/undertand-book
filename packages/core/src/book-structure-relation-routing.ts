import { createHash } from "node:crypto";
import { z } from "zod";
import { BOOK_STRUCTURE_EXECUTION_BUDGET_V2, evaluateBookStructureExecution, proofBoundBookStructureDescriptor,
  type BookStructureCandidate, type BookStructureExecutionContractV2 } from "./book-structure";
import type { BookStructureReferenceScope } from "./book-structure-evidence";
import type { BookStructureRelationEntry, BookStructureRelationInput } from "./book-structure-relations";
import type { BuildTargetRefV2 } from "./build-orchestrator";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "./executor-transport";
import type { WorkUnitDescriptorV4 } from "./stage-work-unit";
import { ExtractorContractError } from "./extractor-contract";

export const BOOK_STRUCTURE_RELATION_SELECT_PROMPT = `# BookStructure related-entry selection

Examine every delivered index entry, including nonadjacent chapters and different wording.
Select groups with a substantive possible shared theme or reading dependency for further examination.
Names, shared terms and graph links are retrieval hints, not proof. Do not automatically group equal names.
The fixed index tiles cover all batches, including cross-batch pairs. Do not request a whole-book rewrite.
Return exactly {"groups":[{"member_ids":["entry-id","other-entry-id"]}]}.
Use only delivered entry IDs. Each group needs at least two distinct entries. Empty groups is a valid no-relation result.
No markdown or other fields.
`;
export const BOOK_STRUCTURE_RELATION_DELTA_PROMPT = `# BookStructure relationship delta

Judge only the delivered related entries and their anchored evidence. Shared names do not prove identity or dependency.
Return exactly {"new_throughlines":[],"extend_throughlines":[],"merge_throughlines":[],"add_dependencies":[]}.
AnchoredText = {"text":string,"evidence_lids":string[]}; text at most 600 characters, evidence nonempty.
new_throughlines items = {"id":string,"name":string,"summary":AnchoredText,"lids":string[],"key_stop_ids":string[]}.
extend_throughlines items = {"throughline_id":string,"summary":AnchoredText,"lids":string[],"key_stop_ids":string[]}.
merge_throughlines items = {"source_ids":string[],"name":string,"summary":AnchoredText}.
add_dependencies items = {"unit_lid":string,"depends_on":string,"evidence_lids":string[]}.
Use only delivered throughline IDs, key-stop IDs, units and paragraph evidence. IDs are at most 256 UTF-8 bytes; names at most 1024 bytes.
Extensions preserve existing members. Merge at least two delivered themes; the program assigns the surviving identity.
Every theme summary must cite evidence covering all declared or retained members; each dependency cites evidence for both units.
Empty arrays mean no supported change. Never return spine or key_stops tables. No markdown or other fields.
`;

export interface BookStructureRelationSelectionInput {
  version: "book_structure_relation_selection_input.v1";
  work_unit_id: string;
  entries: Array<Pick<BookStructureRelationEntry, "id" | "kind" | "name" | "summary" | "unit_lids">>;
  reference_scope: BookStructureReferenceScope;
}
export interface BookStructureRelationSelection { groups: Array<{ member_ids: string[] }> }
export interface BookStructureRelationRoutedWorkUnit {
  descriptor: WorkUnitDescriptorV4;
  rendered_input: string;
  input: BookStructureRelationSelectionInput | BookStructureRelationInput;
}
export type BookStructureRelationContract = Pick<BookStructureExecutionContractV2, "semantic_prompt" | "policy_fingerprint">;
export function bookStructureRelationContracts(base: BookStructureExecutionContractV2): {
  select: BookStructureRelationContract; delta: BookStructureRelationContract;
} {
  const make = (kind: string, prompt: string) => ({ semantic_prompt: prompt, policy_fingerprint: {
    ...base.policy_fingerprint, stage_policy_version: `book_structure_relation_${kind}.v1`,
    schema_version: `book_structure_relation_${kind}.v1`, prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
  } });
  return { select: make("select", BOOK_STRUCTURE_RELATION_SELECT_PROMPT), delta: make("delta", BOOK_STRUCTURE_RELATION_DELTA_PROMPT) };
}

export function bookStructureRelationEntries(candidate: BookStructureCandidate): BookStructureRelationEntry[] {
  const stops = new Map((candidate.key_stops ?? []).map(stop => [stop.id, stop]));
  const unitsFor = (lids: string[]) => [...new Set(lids.flatMap(lid => candidate.spine?.some(unit => unit.lid === lid) ? [lid]
    : Object.entries(candidate.reference_scope?.evidence_by_unit ?? {}).filter(([, evidence]) => evidence.includes(lid)).map(([unit]) => unit)))].sort();
  return [
    ...(candidate.spine ?? []).map(unit => ({ id: `unit:${unit.lid}`, kind: "unit" as const, name: unit.lid,
      summary: unit.summary, unit_lids: [unit.lid], key_stops: unit.key_stop_ids.map(id => stops.get(id)!) })),
    ...(candidate.throughlines ?? []).map(line => ({ id: `throughline:${line.id}`, kind: "throughline" as const, name: line.name,
      summary: line.summary, unit_lids: unitsFor(line.lids), key_stops: line.key_stop_ids.map(id => stops.get(id)!), throughline: line })),
  ];
}

function scopeFor(entries: BookStructureRelationEntry[], base: BookStructureReferenceScope): BookStructureReferenceScope {
  const units = [...new Set(entries.flatMap(entry => entry.unit_lids))].sort();
  const evidence = new Set(entries.flatMap(entry => [...entry.summary.evidence_lids,
    ...entry.key_stops.flatMap(stop => [stop.lid, ...stop.reason.evidence_lids])]));
  return { unit_lids: units, dependency_target_lids: units,
    evidence_by_unit: Object.fromEntries(units.map(unit => [unit, (base.evidence_by_unit[unit] ?? []).filter(lid => evidence.has(lid))])) };
}

export function renderBookStructureRelationInput(input: BookStructureRelationSelectionInput | BookStructureRelationInput): string {
  return JSON.stringify(input, null, 2) + "\n";
}

function route(input: {
  target: BuildTargetRefV2; packet: BookStructureRelationSelectionInput | BookStructureRelationInput;
  contract: BookStructureRelationContract; dependencies: WorkUnitDescriptorV4["dependencies"];
}): BookStructureRelationRoutedWorkUnit | undefined {
  const rendered = renderBookStructureRelationInput(input.packet);
  const evaluated = evaluateBookStructureExecution({ contract: input.contract, rendered_input: rendered,
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2, budget: BOOK_STRUCTURE_EXECUTION_BUDGET_V2 });
  if (evaluated.status !== "within_limit") return undefined;
  const descriptor = proofBoundBookStructureDescriptor({ target: input.target, work_unit_id: input.packet.work_unit_id,
    kind: input.packet.version === "book_structure_relation_selection_input.v1" ? "structure_relation_select" : "structure_relation_delta",
    rendered_input: rendered, proof: evaluated.proof, policy_fingerprint: input.contract.policy_fingerprint,
    input_basis: { kind: "artifact_reduction", dependency_artifacts: input.dependencies.map(item => ({ work_unit_id: item.artifact, artifact_hash: item.sha256 })), parent_lids: ["stitch"] },
    dependencies: input.dependencies, evidence_lids: ["stitch"], candidate_count: input.packet.entries.length,
    transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 });
  return { descriptor, rendered_input: rendered, input: input.packet };
}

/** Each fixed tile pair is examined once, providing cross-batch recall without name-based filtering. */
export function routeBookStructureRelationSelections(input: {
  target: BuildTargetRefV2; candidate: BookStructureCandidate; contract: BookStructureRelationContract;
  dependencies: WorkUnitDescriptorV4["dependencies"];
}): BookStructureRelationRoutedWorkUnit[] {
  const entries = bookStructureRelationEntries(input.candidate);
  if (entries.length < 2) return [];
  const baseScope = input.candidate.reference_scope!;
  const packet = (items: BookStructureRelationEntry[], ordinal: number): BookStructureRelationSelectionInput => ({
    version: "book_structure_relation_selection_input.v1", work_unit_id: `stitch:select:${String(ordinal).padStart(6, "0")}`,
    entries: items.map(({ id, kind, name, summary, unit_lids }) => ({ id, kind, name, summary, unit_lids })),
    reference_scope: scopeFor(items.map(item => ({ ...item, key_stops: [] })), baseScope),
  });
  const whole = route({ ...input, packet: packet(entries, 0) });
  if (whole) return [whole];
  // Split until every pair of tiles fits; no model is asked to compress a table to make progress.
  let tiles: BookStructureRelationEntry[][] = [entries];
  for (;;) {
    let split = -1;
    const routed: BookStructureRelationRoutedWorkUnit[] = [];
    outer: for (let a = 0; a < tiles.length; a++) for (let b = a; b < tiles.length; b++) {
      const items = a === b ? tiles[a] : [...tiles[a], ...tiles[b]];
      if (items.length < 2) continue;
      const work = route({ ...input, packet: packet(items, routed.length) });
      if (!work) { split = tiles[a].length >= tiles[b].length ? a : b; break outer; }
      routed.push(work);
    }
    if (split < 0) return routed;
    const tile = tiles[split];
    if (tile.length < 2) throw new Error(`BookStructure relation index pair exceeds budget: ${tile[0].id}`);
    const middle = Math.ceil(tile.length / 2);
    tiles.splice(split, 1, tile.slice(0, middle), tile.slice(middle));
  }
}

export function validateBookStructureRelationSelection(value: unknown, input: BookStructureRelationSelectionInput): BookStructureRelationSelection {
  const parsed = z.object({ groups: z.array(z.object({ member_ids: z.array(z.string()).min(2) }).strict()) }).strict().safeParse(value);
  const allowed = new Set(input.entries.map(entry => entry.id));
  if (!parsed.success || parsed.data.groups.some(group => new Set(group.member_ids).size < 2 || group.member_ids.some(id => !allowed.has(id)))) {
    throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1", code: "schema_invalid",
      json_pointer: "/groups", expected: "groups of at least two distinct delivered entry IDs", actual: { type: "invalid_group" } });
  }
  return { groups: parsed.data.groups.map(group => ({ member_ids: [...new Set(group.member_ids)].sort() })) };
}

export function bookStructureSelectedPairs(selections: BookStructureRelationSelection[]): string[][] {
  const pairs = new Map<string, string[]>();
  for (const selection of selections) for (const group of selection.groups) {
    const ids = [...new Set(group.member_ids)].sort();
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const pair = [ids[a], ids[b]]; pairs.set(JSON.stringify(pair), pair);
    }
  }
  return [...pairs].sort(([a], [b]) => a < b ? -1 : 1).map(([, pair]) => pair);
}

export function routeBookStructureRelationDelta(input: {
  target: BuildTargetRefV2; candidate: BookStructureCandidate; member_ids: string[];
  members: Record<string, string>; ordinal: number; contract: BookStructureRelationContract;
  dependencies: WorkUnitDescriptorV4["dependencies"];
}): BookStructureRelationRoutedWorkUnit {
  const all = new Map(bookStructureRelationEntries(input.candidate).map(entry => [entry.id, entry]));
  const ids = [...new Set(input.member_ids.map(id => id.startsWith("throughline:")
    ? `throughline:${input.members[id.slice(12)] ?? id.slice(12)}` : id))];
  const entries = ids.map(id => { const entry = all.get(id); if (!entry) throw new Error(`missing selected relation entry: ${id}`); return entry; });
  const packet: BookStructureRelationInput = { version: "book_structure_relation_input.v1",
    work_unit_id: `stitch:relation:${String(input.ordinal).padStart(6, "0")}`, entries,
    reference_scope: scopeFor(entries, input.candidate.reference_scope!) };
  const work = route({ ...input, packet });
  if (!work) throw new Error(`BookStructure selected relation entries exceed budget: ${ids.join(", ")}`);
  return work;
}
