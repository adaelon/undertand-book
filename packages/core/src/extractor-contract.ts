import { z, type ZodTypeAny } from "zod";
import { METADATA_SOURCES, type PaperMetadataExtractionOutput } from "./paper-metadata";
import { PAPER_TERM_TYPES, type PaperLexiconExtractionOutput } from "./paper-lexicon";
import type { ProfileSidecarExtractionOutput } from "./profile-sidecar-build";

export type ContractedExtractorStage = "paper_metadata" | "paper_lexicon" | "profile_sidecar";

export const EXTRACTOR_CONTRACT_SCHEMA_VERSIONS = {
  paper_metadata: "paper_metadata_output.v2",
  paper_lexicon: "paper_lexicon_output.v2",
  profile_sidecar: "profile_sidecar_output.v2",
} as const;

export interface ExtractorContractContext {
  allowed_evidence_lids: string[];
  formula_lids?: string[];
}

export interface ExtractorContractDiagnosticV1 {
  version: "automatic_build_extractor_diagnostic.v1";
  code: string;
  json_pointer: string;
  expected: string;
  actual: unknown;
  evidence_violation?: {
    kind: "required" | "out_of_scope" | "cross_field";
    offending_lids?: string[];
    allowed_lids?: string[];
    detail?: string;
  };
}

export class ExtractorContractError extends Error {
  readonly diagnostic: ExtractorContractDiagnosticV1;

  constructor(diagnostic: ExtractorContractDiagnosticV1) {
    super(JSON.stringify(diagnostic));
    this.name = "ExtractorContractError";
    this.diagnostic = diagnostic;
  }
}

const nonEmptyString = z.string().min(1);
const lidArray = z.array(nonEmptyString).min(1);
const metadataSource = z.enum(METADATA_SOURCES);
const metadataField = <T extends ZodTypeAny>(value: T) => z.object({
  value,
  source: metadataSource,
  evidence_lids: lidArray.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

const author = z.object({ name: nonEmptyString, raw: z.string().optional() }).strict();
const reference = z.object({ raw: nonEmptyString, identifiers: z.record(z.string()).optional() }).strict();
const metadataFieldsSchema = z.object({
  title: metadataField(nonEmptyString).optional(),
  authors: metadataField(z.array(author)).optional(),
  affiliations: metadataField(z.array(nonEmptyString)).optional(),
  venue: metadataField(nonEmptyString).optional(),
  year: metadataField(z.number().int()).optional(),
  identifiers: z.object({
    doi: metadataField(nonEmptyString).optional(),
    arxiv: metadataField(nonEmptyString).optional(),
    url: metadataField(nonEmptyString).optional(),
  }).strict().optional(),
  keywords: metadataField(z.array(nonEmptyString)).optional(),
  field_labels: metadataField(z.array(nonEmptyString)).optional(),
  references: metadataField(z.array(reference)).optional(),
  datasets: metadataField(z.array(nonEmptyString)).optional(),
  code_links: metadataField(z.array(nonEmptyString)).optional(),
  funding: metadataField(z.array(nonEmptyString)).optional(),
}).strict();

const lexiconEntry = z.object({
  term: nonEmptyString,
  term_type: z.enum(PAPER_TERM_TYPES),
  occurrences_lids: lidArray,
  defined_at_lid: nonEmptyString.optional(),
  aliases: z.array(nonEmptyString).optional(),
  acronym_expansion: nonEmptyString.optional(),
  chinese_gloss: nonEmptyString.optional(),
}).strict();
const lexiconOutput = z.union([
  z.object({ entries: z.array(lexiconEntry) }).strict(),
  z.object({ paper_lexicon: z.object({ entries: z.array(lexiconEntry) }).strict() }).strict(),
]);

const discourseModes = ["informative", "argumentative", "procedural", "descriptive", "meta"] as const;
const localFunctions = [
  "definition", "description", "classification", "explanation", "cause", "effect", "example", "counterexample",
  "comparison", "contrast", "procedure_step", "application", "warning", "limitation", "question", "answer",
  "summary", "research_question", "hypothesis", "related_work", "method_description", "experiment_setup",
  "evidence_report", "result_interpretation", "future_work", "transition",
] as const;
const rhetoricalMoves = [
  "chapter_setup", "problem_framing", "prerequisite", "main_point", "concept_elaboration", "worked_example",
  "case_analysis", "argument_support", "objection", "resolution", "recap", "abstract_summary",
  "related_work_positioning", "method_setup", "experiment_report", "result_claim", "limitation_acknowledgement",
  "future_work_projection", "bridge_to_next",
] as const;
const relationTypes = [
  "elaborates", "exemplifies", "explains", "causes", "results_in", "contrasts", "concedes", "supports",
  "rebuts", "summarizes", "restates", "prepares", "continues", "answers", "depends_on",
] as const;
const relation = z.object({
  target_lid: nonEmptyString,
  type: z.enum(relationTypes),
  family: z.enum(["temporal", "contingency", "comparison", "expansion"]).optional(),
  direction: z.enum(["backward", "forward", "lateral"]),
  confidence: z.number().min(0).max(1),
  evidence_lids: lidArray,
}).strict();
const discourseItem = z.object({
  lid: nonEmptyString,
  mode: z.enum(discourseModes),
  local_function: z.enum(localFunctions).optional(),
  rhetorical_move: z.enum(rhetoricalMoves).optional(),
  local_summary: nonEmptyString.max(200).optional(),
  relations: z.array(relation),
}).strict();
const formulaParameter = z.object({
  symbol: nonEmptyString,
  label: z.string().nullable(),
  meaning: nonEmptyString,
  unit: z.string().nullable(),
  domain: z.string().nullable(),
  evidence_lids: lidArray,
}).strict();
const formulaComposition = z.object({
  source_lid: nonEmptyString,
  meaning: nonEmptyString,
  terms: z.array(nonEmptyString),
  evidence_lids: z.array(nonEmptyString),
}).strict();
const formulaContextLink = z.object({
  target_lid: nonEmptyString,
  relation: nonEmptyString,
  description: nonEmptyString,
  evidence_lids: lidArray,
}).strict();
const formulaCandidate = z.object({
  formula_lid: nonEmptyString,
  context_lids: z.array(nonEmptyString).optional(),
  parameters: z.array(formulaParameter).optional(),
  composition: formulaComposition.optional(),
  context_links: z.array(formulaContextLink).optional(),
}).strict();
const profileSidecarOutput = z.object({
  discourse_items: z.array(discourseItem).optional(),
  formula_semantics: z.array(formulaCandidate).optional(),
}).strict();

interface ExtractorContractDefinition {
  schema_version: string;
  schema: ZodTypeAny;
  example: unknown;
  constraints: string[];
  invariants: string[];
}

const CONTRACTS: Record<ContractedExtractorStage, ExtractorContractDefinition> = {
  paper_metadata: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_metadata,
    schema: metadataFieldsSchema,
    example: {
      paper_metadata: {
        title: { value: "Paper title", source: "front_matter", evidence_lids: ["1.1"], confidence: 0.98 },
        authors: { value: [{ name: "Author Name", raw: "Author Name" }], source: "front_matter", evidence_lids: ["1.1"] },
        affiliations: { value: ["Example University"], source: "front_matter", evidence_lids: ["1.1"] },
        venue: { value: "Example Conference", source: "paper_text", evidence_lids: ["1.1"] },
        year: { value: 2026, source: "paper_text", evidence_lids: ["1.1"] },
        identifiers: {
          doi: { value: "10.x/example", source: "paper_text", evidence_lids: ["1.1"] },
          arxiv: { value: "2607.00001", source: "paper_text", evidence_lids: ["1.1"] },
          url: { value: "https://example.test", source: "paper_text", evidence_lids: ["1.1"] },
        },
        keywords: { value: ["retrieval"], source: "paper_text", evidence_lids: ["1.2"] },
        field_labels: { value: ["information retrieval"], source: "paper_text", evidence_lids: ["1.2"] },
        references: { value: [{ raw: "Smith 2020", identifiers: { doi: "10.x/ref" } }], source: "paper_text", evidence_lids: ["1.3"] },
        datasets: { value: ["Dataset A"], source: "paper_text", evidence_lids: ["1.2"] },
        code_links: { value: ["https://example.test/code"], source: "paper_text", evidence_lids: ["1.2"] },
        funding: { value: ["Grant A"], source: "paper_text", evidence_lids: ["1.2"] },
      },
    },
    constraints: [
      "Every business field is a strict MetadataField {value,source,evidence_lids?,confidence?}.",
      "references.value is Array<{raw:string,identifiers?:Record<string,string>}>, never string[].",
      `source is one of: ${METADATA_SOURCES.join(" | ")}.`,
    ],
    invariants: [
      "front_matter and paper_text fields require non-empty evidence_lids.",
      "Every evidence LID must be in the input visible_lids set.",
    ],
  },
  paper_lexicon: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.paper_lexicon,
    schema: lexiconOutput,
    example: {
      entries: [{
        term: "Retrieval-Augmented Generation",
        term_type: "method_name",
        occurrences_lids: ["1.4", "2.1"],
        defined_at_lid: "1.4",
        aliases: ["RAG"],
        acronym_expansion: "Retrieval-Augmented Generation",
        chinese_gloss: "检索增强生成",
      }],
    },
    constraints: [
      `term_type is one of: ${PAPER_TERM_TYPES.join(" | ")}.`,
      "occurrences_lids is a non-empty string array; all optional strings are non-empty when present.",
    ],
    invariants: [
      "defined_at_lid, when present, must also occur in the same entry's occurrences_lids.",
      "Every occurrence and definition LID must be in the input visible_lids set.",
    ],
  },
  profile_sidecar: {
    schema_version: EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.profile_sidecar,
    schema: profileSidecarOutput,
    example: {
      discourse_items: [{
        lid: "3.2.1",
        mode: "informative",
        local_function: "definition",
        rhetorical_move: "main_point",
        local_summary: "Defines the local concept.",
        relations: [{
          target_lid: "3.2.2",
          type: "explains",
          family: "expansion",
          direction: "forward",
          confidence: 0.9,
          evidence_lids: ["3.2.1", "3.2.2"],
        }],
      }],
      formula_semantics: [{
        formula_lid: "3.2.4",
        context_lids: ["3.2.3"],
        parameters: [{ symbol: "E", label: "能量", meaning: "能量项", unit: null, domain: null, evidence_lids: ["3.2.4"] }],
        composition: { source_lid: "3.2.4", meaning: "表达能量关系。", terms: ["E"], evidence_lids: ["3.2.4"] },
        context_links: [{ target_lid: "3.2.3", relation: "explained_by", description: "上下文解释公式。", evidence_lids: ["3.2.4", "3.2.3"] }],
      }],
    },
    constraints: [
      `mode is one of: ${discourseModes.join(" | ")}.`,
      `local_function is one of: ${localFunctions.join(" | ")}.`,
      `rhetorical_move is one of: ${rhetoricalMoves.join(" | ")}.`,
      `relation.type is one of: ${relationTypes.join(" | ")}; confidence is 0..1.`,
    ],
    invariants: [
      "A profile_sidecar_discourse unit emits only discourse_items; a profile_sidecar_formula unit emits only formula_semantics.",
      "All discourse and relation evidence LIDs must be visible; relation evidence includes source lid and target_lid.",
      "formula_lid must be in formula_lids; context_lids must be visible; formula evidence stays inside formula_lid + context_lids.",
      "composition.source_lid must equal formula_lid.",
    ],
  },
};

function pointer(path: Array<string | number>): string {
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function valueAt(input: unknown, path: Array<string | number>): unknown {
  let value = input;
  for (const part of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

function boundedActual(value: unknown): unknown {
  if (typeof value === "string") return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  return { type: "object", keys: Object.keys(value as object).slice(0, 12) };
}

function fail(input: Omit<ExtractorContractDiagnosticV1, "version">): never {
  throw new ExtractorContractError({ version: "automatic_build_extractor_diagnostic.v1", ...input });
}

function parseSchema(schema: ZodTypeAny, input: unknown): unknown {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  let issue = parsed.error.issues[0];
  if (issue.code === "invalid_union") {
    issue = issue.unionErrors.flatMap((error) => error.issues).sort((left, right) => right.path.length - left.path.length)[0] ?? issue;
  }
  const expected = issue.code === "invalid_type"
    ? issue.expected
    : issue.code === "invalid_enum_value"
      ? issue.options.join(" | ")
      : issue.message;
  fail({
    code: "schema_invalid",
    json_pointer: pointer(issue.path),
    expected,
    actual: boundedActual(valueAt(input, issue.path)),
  });
}

function assertAllowedLids(lids: string[], pathValue: string, allowed: Set<string>): void {
  const offending = [...new Set(lids.filter((lid) => !allowed.has(lid)))];
  if (offending.length) {
    fail({
      code: "evidence_out_of_scope",
      json_pointer: pathValue,
      expected: "subset of input visible_lids",
      actual: { type: "array", length: lids.length },
      evidence_violation: {
        kind: "out_of_scope",
        offending_lids: offending,
        allowed_lids: [...allowed],
      },
    });
  }
}

function metadataFields(output: PaperMetadataExtractionOutput): Record<string, unknown> {
  return ((output as { paper_metadata?: Record<string, unknown> }).paper_metadata ?? output) as Record<string, unknown>;
}

function validateMetadata(output: PaperMetadataExtractionOutput, context: ExtractorContractContext): void {
  const allowed = new Set(context.allowed_evidence_lids);
  const fields = metadataFields(output);
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [name, value] of Object.entries(fields)) {
    if (name === "identifiers") {
      for (const [identifier, field] of Object.entries(value as Record<string, unknown>)) {
        entries.push([`/paper_metadata/identifiers/${identifier}`, field as Record<string, unknown>]);
      }
    } else entries.push([`/paper_metadata/${name}`, value as Record<string, unknown>]);
  }
  for (const [fieldPath, field] of entries) {
    const evidence = field.evidence_lids as string[] | undefined;
    if ((field.source === "front_matter" || field.source === "paper_text") && !evidence) {
      fail({
        code: "evidence_required",
        json_pointer: `${fieldPath}/evidence_lids`,
        expected: `non-empty evidence_lids for source ${field.source}`,
        actual: undefined,
        evidence_violation: { kind: "required", detail: "text-derived metadata must cite visible source LIDs" },
      });
    }
    if (evidence) assertAllowedLids(evidence, `${fieldPath}/evidence_lids`, allowed);
  }
}

function lexiconEntries(output: PaperLexiconExtractionOutput): Array<Record<string, unknown>> {
  return ((output.entries ?? output.paper_lexicon?.entries) ?? []) as unknown as Array<Record<string, unknown>>;
}

function validateLexicon(output: PaperLexiconExtractionOutput, context: ExtractorContractContext): void {
  const allowed = new Set(context.allowed_evidence_lids);
  for (const [index, entry] of lexiconEntries(output).entries()) {
    const occurrences = entry.occurrences_lids as string[];
    assertAllowedLids(occurrences, `/entries/${index}/occurrences_lids`, allowed);
    const definedAt = entry.defined_at_lid as string | undefined;
    if (definedAt && !occurrences.includes(definedAt)) {
      fail({
        code: "defined_at_not_occurrence",
        json_pointer: `/entries/${index}/defined_at_lid`,
        expected: `one of /entries/${index}/occurrences_lids`,
        actual: boundedActual(definedAt),
        evidence_violation: {
          kind: "cross_field",
          offending_lids: [definedAt],
          allowed_lids: occurrences,
        },
      });
    }
  }
}

function validateProfile(output: ProfileSidecarExtractionOutput, context: ExtractorContractContext): void {
  const visible = new Set(context.allowed_evidence_lids);
  const formulaLids = new Set(context.formula_lids ?? []);
  for (const [itemIndex, item] of (output.discourse_items ?? []).entries()) {
    assertAllowedLids([item.lid], `/discourse_items/${itemIndex}/lid`, visible);
    for (const [relationIndex, itemRelation] of item.relations.entries()) {
      assertAllowedLids([itemRelation.target_lid], `/discourse_items/${itemIndex}/relations/${relationIndex}/target_lid`, visible);
      const evidencePath = `/discourse_items/${itemIndex}/relations/${relationIndex}/evidence_lids`;
      assertAllowedLids(itemRelation.evidence_lids, evidencePath, visible);
      const required = [item.lid, itemRelation.target_lid].filter((lid) => !itemRelation.evidence_lids.includes(lid));
      if (required.length) {
        fail({
          code: "relation_evidence_incomplete",
          json_pointer: evidencePath,
          expected: "evidence_lids containing source lid and target_lid",
          actual: { type: "array", length: itemRelation.evidence_lids.length },
          evidence_violation: { kind: "required", offending_lids: required, allowed_lids: [...visible] },
        });
      }
    }
  }
  for (const [formulaIndex, formula] of (output.formula_semantics ?? []).entries()) {
    if (!formulaLids.has(formula.formula_lid)) {
      fail({
        code: "formula_lid_not_eligible",
        json_pointer: `/formula_semantics/${formulaIndex}/formula_lid`,
        expected: "one of input formula_lids",
        actual: boundedActual(formula.formula_lid),
        evidence_violation: { kind: "out_of_scope", offending_lids: [formula.formula_lid], allowed_lids: [...formulaLids] },
      });
    }
    const contextLids = formula.context_lids ?? [];
    assertAllowedLids(contextLids, `/formula_semantics/${formulaIndex}/context_lids`, visible);
    const formulaEvidence = new Set([formula.formula_lid, ...contextLids]);
    if (formula.composition?.source_lid !== undefined && formula.composition.source_lid !== formula.formula_lid) {
      fail({
        code: "composition_source_mismatch",
        json_pointer: `/formula_semantics/${formulaIndex}/composition/source_lid`,
        expected: formula.formula_lid,
        actual: boundedActual(formula.composition.source_lid),
        evidence_violation: { kind: "cross_field", offending_lids: [formula.composition.source_lid], allowed_lids: [formula.formula_lid] },
      });
    }
    const evidenceArrays: Array<[string, string[]]> = [
      ...((formula.parameters ?? []).map((item, index) => [`/formula_semantics/${formulaIndex}/parameters/${index}/evidence_lids`, item.evidence_lids] as [string, string[]])),
      ...(formula.composition ? [[`/formula_semantics/${formulaIndex}/composition/evidence_lids`, formula.composition.evidence_lids] as [string, string[]]] : []),
      ...((formula.context_links ?? []).flatMap((item, index) => [
        [`/formula_semantics/${formulaIndex}/context_links/${index}/target_lid`, [item.target_lid]] as [string, string[]],
        [`/formula_semantics/${formulaIndex}/context_links/${index}/evidence_lids`, item.evidence_lids] as [string, string[]],
      ])),
    ];
    for (const [evidencePath, lids] of evidenceArrays) assertAllowedLids(lids, evidencePath, formulaEvidence);
  }
}

export function parseExtractorCandidate(
  stage: "paper_metadata",
  input: unknown,
  context: ExtractorContractContext,
): PaperMetadataExtractionOutput;
export function parseExtractorCandidate(
  stage: "paper_lexicon",
  input: unknown,
  context: ExtractorContractContext,
): PaperLexiconExtractionOutput;
export function parseExtractorCandidate(
  stage: "profile_sidecar",
  input: unknown,
  context: ExtractorContractContext,
): ProfileSidecarExtractionOutput;
export function parseExtractorCandidate(
  stage: ContractedExtractorStage,
  input: unknown,
  context: ExtractorContractContext,
): PaperMetadataExtractionOutput | PaperLexiconExtractionOutput | ProfileSidecarExtractionOutput {
  const schema = stage === "paper_metadata" && typeof input === "object" && input !== null && "paper_metadata" in input
    ? z.object({ paper_metadata: metadataFieldsSchema }).strict()
    : CONTRACTS[stage].schema;
  const parsed = parseSchema(schema, input) as PaperMetadataExtractionOutput | PaperLexiconExtractionOutput | ProfileSidecarExtractionOutput;
  if (stage === "paper_metadata") validateMetadata(parsed as PaperMetadataExtractionOutput, context);
  else if (stage === "paper_lexicon") validateLexicon(parsed as PaperLexiconExtractionOutput, context);
  else validateProfile(parsed as ProfileSidecarExtractionOutput, context);
  return parsed;
}

export function renderExtractorContractMarkdown(stage: ContractedExtractorStage): string {
  const contract = CONTRACTS[stage];
  return [
    "<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->",
    `## Machine Contract: ${contract.schema_version}`,
    "",
    "The writer validates this exact shape before semantic gating:",
    "",
    "```json",
    JSON.stringify(contract.example, null, 2),
    "```",
    "",
    "Field constraints:",
    ...contract.constraints.map((item) => `- ${item}`),
    "",
    "Cross-field invariants:",
    ...contract.invariants.map((item) => `- ${item}`),
    "<!-- END GENERATED EXTRACTOR CONTRACT -->",
  ].join("\n");
}
