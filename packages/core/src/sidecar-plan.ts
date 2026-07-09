import { createHash } from "node:crypto";

export type SidecarTargetView = "timeline" | "concept_map" | "comparison_table" | "argument_map" | "custom";
export type SidecarVisualization = "timeline" | "graph" | "table" | "cards";
export type SidecarPlanStatus = "draft" | "confirmed" | "rejected";

export interface JsonSchemaObject {
  type: "object";
  required?: string[];
  properties: Record<string, unknown>;
  additionalProperties?: boolean;
}

export interface SidecarSourceScope {
  lids?: string[];
  sections?: string[];
  whole_book?: boolean;
}

export interface SidecarOutputContract {
  sidecar_id: string;
  schema: JsonSchemaObject;
  required_evidence: "lid_required";
  visualization: SidecarVisualization;
}

export interface SidecarPlanOption {
  target_view: SidecarTargetView;
  label: string;
  description: string;
  output_contract: Omit<SidecarOutputContract, "sidecar_id">;
  validation_rules: string[];
}

export interface SidecarBuildIntent {
  version: "sidecar_build_intent.v1";
  user_request: string;
  target_view: SidecarTargetView;
  source_scope: SidecarSourceScope;
  output_contract: SidecarOutputContract;
}

export interface SidecarFormDraft {
  version: "sidecar_form_draft.v1";
  fields: Array<{
    id: "target_view" | "source_scope" | "sidecar_id" | "schema" | "visualization" | "required_evidence";
    label: string;
    value: unknown;
    editable: boolean;
  }>;
  default_options: SidecarPlanOption[];
}

export interface SidecarPlan {
  version: "sidecar_plan.v1";
  plan_id: string;
  book_id: string;
  stage: "custom_sidecar";
  status: SidecarPlanStatus;
  confirmation_required: true;
  sidecar_generation_allowed: boolean;
  selected_option: SidecarTargetView;
  intent: SidecarBuildIntent;
  form_draft: SidecarFormDraft;
  validation_rules: string[];
  created_at: string;
  confirmed_at?: string;
}

export interface DraftSidecarPlanInput {
  book_id: string;
  user_request: string;
  source_scope?: SidecarSourceScope;
  target_view?: SidecarTargetView;
  now?: string;
}

export interface ConfirmSidecarPlanEdits {
  source_scope?: SidecarSourceScope;
  output_contract?: Partial<SidecarOutputContract>;
}

export interface SidecarBuildSpec {
  version: "sidecar_build_spec.v1";
  sidecar_id: string;
  stage: "custom_sidecar";
  input_lids: string[];
  source_scope: SidecarSourceScope;
  extractor_prompt: string;
  output_schema: JsonSchemaObject;
  validation_rules: string[];
  visualization_hint: SidecarVisualization;
}

function evidenceArraySchema(): Record<string, unknown> {
  return {
    evidence_lids: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
  };
}

function recordSchema(properties: Record<string, unknown>, required: string[]): JsonSchemaObject {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties,
  };
}

export const DEFAULT_SIDECAR_OPTIONS: SidecarPlanOption[] = [
  {
    target_view: "timeline",
    label: "Timeline",
    description: "Chronological events, stages, or paper narrative checkpoints.",
    output_contract: {
      required_evidence: "lid_required",
      visualization: "timeline",
      schema: recordSchema(
        {
          items: {
            type: "array",
            items: recordSchema(
              {
                id: { type: "string" },
                label: { type: "string" },
                order_hint: { type: "string" },
                ...evidenceArraySchema(),
              },
              ["id", "label", "evidence_lids"],
            ),
          },
        },
        ["items"],
      ),
    },
    validation_rules: ["lid_required", "items_have_unique_ids", "timeline_items_have_evidence"],
  },
  {
    target_view: "concept_map",
    label: "Concept Map",
    description: "Concept nodes and evidence-backed links.",
    output_contract: {
      required_evidence: "lid_required",
      visualization: "graph",
      schema: recordSchema(
        {
          nodes: {
            type: "array",
            items: recordSchema({ id: { type: "string" }, label: { type: "string" }, ...evidenceArraySchema() }, [
              "id",
              "label",
              "evidence_lids",
            ]),
          },
          links: {
            type: "array",
            items: recordSchema(
              {
                source: { type: "string" },
                target: { type: "string" },
                relation: { type: "string" },
                ...evidenceArraySchema(),
              },
              ["source", "target", "relation", "evidence_lids"],
            ),
          },
        },
        ["nodes", "links"],
      ),
    },
    validation_rules: ["lid_required", "links_reference_nodes", "nodes_have_evidence"],
  },
  {
    target_view: "comparison_table",
    label: "Comparison Table",
    description: "Rows of comparable entities with evidence-backed dimensions.",
    output_contract: {
      required_evidence: "lid_required",
      visualization: "table",
      schema: recordSchema(
        {
          rows: {
            type: "array",
            items: recordSchema(
              {
                subject: { type: "string" },
                dimensions: { type: "object" },
                ...evidenceArraySchema(),
              },
              ["subject", "dimensions", "evidence_lids"],
            ),
          },
        },
        ["rows"],
      ),
    },
    validation_rules: ["lid_required", "rows_have_subjects", "rows_have_evidence"],
  },
  {
    target_view: "argument_map",
    label: "Argument Map",
    description: "Claims, evidence, limitations, and their relationships.",
    output_contract: {
      required_evidence: "lid_required",
      visualization: "graph",
      schema: recordSchema(
        {
          claims: {
            type: "array",
            items: recordSchema(
              {
                id: { type: "string" },
                claim: { type: "string" },
                role: { type: "string", enum: ["problem", "method", "evidence", "result", "limitation", "future_work"] },
                ...evidenceArraySchema(),
              },
              ["id", "claim", "role", "evidence_lids"],
            ),
          },
          relations: {
            type: "array",
            items: recordSchema(
              {
                source: { type: "string" },
                target: { type: "string" },
                relation: { type: "string" },
                ...evidenceArraySchema(),
              },
              ["source", "target", "relation", "evidence_lids"],
            ),
          },
        },
        ["claims", "relations"],
      ),
    },
    validation_rules: ["lid_required", "relations_reference_claims", "claims_have_evidence"],
  },
  {
    target_view: "custom",
    label: "Custom",
    description: "Escape hatch for a user-edited schema after reviewing defaults.",
    output_contract: {
      required_evidence: "lid_required",
      visualization: "cards",
      schema: recordSchema(
        {
          records: {
            type: "array",
            items: recordSchema({ id: { type: "string" }, label: { type: "string" }, ...evidenceArraySchema() }, [
              "id",
              "label",
              "evidence_lids",
            ]),
          },
        },
        ["records"],
      ),
    },
    validation_rules: ["lid_required", "records_have_evidence", "custom_schema_requires_confirmation"],
  },
];

function optionFor(targetView: SidecarTargetView): SidecarPlanOption {
  const option = DEFAULT_SIDECAR_OPTIONS.find((item) => item.target_view === targetView);
  if (!option) throw new Error(`unsupported sidecar target view: ${targetView}`);
  return option;
}

function inferTargetView(request: string): SidecarTargetView {
  const text = request.toLowerCase();
  if (/\b(timeline|chronology|sequence|evolution|history)\b/.test(text)) return "timeline";
  if (/\b(compare|comparison|versus|vs\.?|table|benchmark)\b/.test(text)) return "comparison_table";
  if (/\b(argument|claim|evidence|limitation|hypothesis)\b/.test(text)) return "argument_map";
  if (/\b(concept|map|relationship|graph|taxonomy)\b/.test(text)) return "concept_map";
  return "concept_map";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
}

function sidecarId(bookId: string, targetView: SidecarTargetView, userRequest: string): string {
  return `${slug(bookId) || "book"}_${targetView}_${hash(userRequest)}`;
}

function buildFormDraft(intent: SidecarBuildIntent): SidecarFormDraft {
  return {
    version: "sidecar_form_draft.v1",
    fields: [
      { id: "target_view", label: "Target view", value: intent.target_view, editable: true },
      { id: "source_scope", label: "Source scope", value: intent.source_scope, editable: true },
      { id: "sidecar_id", label: "Sidecar id", value: intent.output_contract.sidecar_id, editable: true },
      { id: "schema", label: "Output schema", value: intent.output_contract.schema, editable: true },
      { id: "visualization", label: "Visualization", value: intent.output_contract.visualization, editable: true },
      { id: "required_evidence", label: "Required evidence", value: intent.output_contract.required_evidence, editable: false },
    ],
    default_options: DEFAULT_SIDECAR_OPTIONS,
  };
}

export function draftSidecarPlan(input: DraftSidecarPlanInput): SidecarPlan {
  if (!input.user_request.trim()) throw new Error("sidecar plan requires a user_request");
  const targetView = input.target_view ?? inferTargetView(input.user_request);
  const option = optionFor(targetView);
  const outputContract: SidecarOutputContract = {
    sidecar_id: sidecarId(input.book_id, targetView, input.user_request),
    ...option.output_contract,
  };
  const intent: SidecarBuildIntent = {
    version: "sidecar_build_intent.v1",
    user_request: input.user_request,
    target_view: targetView,
    source_scope: input.source_scope ?? { whole_book: true },
    output_contract: outputContract,
  };
  const createdAt = input.now ?? new Date().toISOString();
  return {
    version: "sidecar_plan.v1",
    plan_id: `plan_${hash(`${input.book_id}:${input.user_request}:${targetView}`)}`,
    book_id: input.book_id,
    stage: "custom_sidecar",
    status: "draft",
    confirmation_required: true,
    sidecar_generation_allowed: false,
    selected_option: targetView,
    intent,
    form_draft: buildFormDraft(intent),
    validation_rules: option.validation_rules,
    created_at: createdAt,
  };
}

export function confirmSidecarPlan(plan: SidecarPlan, now: string, edits: ConfirmSidecarPlanEdits = {}): SidecarPlan {
  const outputContract: SidecarOutputContract = {
    ...plan.intent.output_contract,
    ...edits.output_contract,
    required_evidence: "lid_required",
  };
  const intent: SidecarBuildIntent = {
    ...plan.intent,
    source_scope: edits.source_scope ?? plan.intent.source_scope,
    output_contract: outputContract,
  };
  return {
    ...plan,
    status: "confirmed",
    sidecar_generation_allowed: true,
    intent,
    form_draft: buildFormDraft(intent),
    confirmed_at: now,
  };
}

export function compileSidecarBuildSpec(plan: SidecarPlan): SidecarBuildSpec {
  if (plan.status !== "confirmed" || !plan.sidecar_generation_allowed) {
    throw new Error("sidecar generation requires a confirmed sidecar_plan.json");
  }
  const scope = plan.intent.source_scope;
  const inputLids = [...(scope.lids ?? [])];
  return {
    version: "sidecar_build_spec.v1",
    sidecar_id: plan.intent.output_contract.sidecar_id,
    stage: "custom_sidecar",
    input_lids: inputLids,
    source_scope: scope,
    extractor_prompt: [
      `User request: ${plan.intent.user_request}`,
      `Target view: ${plan.intent.target_view}`,
      "Extract only records supported by real LID evidence.",
      "Every accepted record must include non-empty evidence_lids.",
    ].join("\n"),
    output_schema: plan.intent.output_contract.schema,
    validation_rules: plan.validation_rules,
    visualization_hint: plan.intent.output_contract.visualization,
  };
}
