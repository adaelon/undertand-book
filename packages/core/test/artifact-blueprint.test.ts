import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BLUEPRINT_V1_LIMITS,
  SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1,
  computeArtifactBlueprintDigest,
  getSystemArtifactBlueprintV1,
  validateArtifactBlueprintV1,
  validatePlannerOneOffArtifactBlueprintV1,
  validateRestrictedSchemaValueV1,
  type ArtifactBlueprintV1,
  type LegacyIntentArtifactTypeV1,
} from "../src/artifact-blueprint";
import { canonicalBuildJson } from "../src/build-intent";

interface PresetGolden {
  version: "artifact_blueprint_presets.v1.golden";
  cases: Array<{
    artifact_type: LegacyIntentArtifactTypeV1;
    blueprint_id: string;
    blueprint_digest: string;
    legacy_payload: unknown;
    mapped_records: Array<{
      record_id: string;
      data: unknown;
      evidence_lids: string[];
    }>;
    mapped_relations: Array<{
      relation_id: string;
      source: string;
      target: string;
      data: unknown;
      evidence_lids: string[];
    }>;
  }>;
}

function readGolden(): PresetGolden {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL("./fixtures/artifact-blueprint-presets.v1.golden.json", import.meta.url)),
    "utf8",
  )) as PresetGolden;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function validBlueprint(): ArtifactBlueprintV1 {
  return {
    version: "artifact_blueprint.v1",
    blueprint_id: "test.checklist",
    blueprint_version: "1.0.0",
    origin: "one_off",
    title: "Implementation checklist",
    purpose: "Track bounded implementation actions.",
    shape: "collection",
    record_schema: {
      type: "object",
      properties: {
        action: { type: "string", max_length: 200 },
        done: { type: "boolean" },
      },
      required: ["action", "done"],
      additional_properties: false,
      max_properties: 2,
    },
    routing: {
      use_when: ["The user asks what remains to implement."],
      avoid_when: ["The user asks for verbatim source evidence."],
      covered_topics: ["implementation"],
      scope_label: "confirmed source scope",
    },
    search_fields: [{ path: "/action", weight: 10, analyzer: "text" }],
    summary_fields: ["/action", "/done"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: {
      max_records: 100,
      max_relations: 0,
      max_text_chars: 20_000,
    },
  };
}

function mapLegacyGolden(
  artifactType: LegacyIntentArtifactTypeV1,
  input: unknown,
): {
  records: PresetGolden["cases"][number]["mapped_records"];
  relations: PresetGolden["cases"][number]["mapped_relations"];
} {
  switch (artifactType) {
    case "timeline": {
      const payload = input as {
        items: Array<{ id: string; label: string; order_hint?: string; evidence_lids: string[] }>;
      };
      return {
        records: payload.items.map((item) => ({
          record_id: item.id,
          data: {
            label: item.label,
            ...(item.order_hint === undefined ? {} : { order_hint: item.order_hint }),
          },
          evidence_lids: item.evidence_lids,
        })),
        relations: [],
      };
    }
    case "concept_map": {
      const payload = input as {
        nodes: Array<{ id: string; label: string; evidence_lids: string[] }>;
        links: Array<{ source: string; target: string; relation: string; evidence_lids: string[] }>;
      };
      return {
        records: payload.nodes.map((node) => ({
          record_id: node.id,
          data: { label: node.label },
          evidence_lids: node.evidence_lids,
        })),
        relations: payload.links.map((link) => ({
          relation_id: `${link.source}:${link.relation}:${link.target}`,
          source: link.source,
          target: link.target,
          data: { relation: link.relation },
          evidence_lids: link.evidence_lids,
        })),
      };
    }
    case "comparison_table": {
      const payload = input as {
        rows: Array<{ subject: string; dimensions: Record<string, unknown>; evidence_lids: string[] }>;
      };
      return {
        records: payload.rows.map((row, index) => ({
          record_id: `row-${index + 1}`,
          data: {
            subject: row.subject,
            dimensions: Object.entries(row.dimensions)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, value]) => ({ name, value_json: canonicalBuildJson(value) })),
          },
          evidence_lids: row.evidence_lids,
        })),
        relations: [],
      };
    }
    case "argument_map": {
      const payload = input as {
        claims: Array<{ id: string; claim: string; role: string; evidence_lids: string[] }>;
        relations: Array<{ source: string; target: string; relation: string; evidence_lids: string[] }>;
      };
      return {
        records: payload.claims.map((claim) => ({
          record_id: claim.id,
          data: { claim: claim.claim, role: claim.role },
          evidence_lids: claim.evidence_lids,
        })),
        relations: payload.relations.map((relation) => ({
          relation_id: `${relation.source}:${relation.relation}:${relation.target}`,
          source: relation.source,
          target: relation.target,
          data: { relation: relation.relation },
          evidence_lids: relation.evidence_lids,
        })),
      };
    }
  }
}

describe("ArtifactBlueprintV1", () => {
  it("validates a bounded fail-closed DSL and rejects executable, recursive, remote, and oversized schemas", () => {
    expect(validateArtifactBlueprintV1(validBlueprint())).toEqual(validBlueprint());

    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: { $ref: "https://example.com/schema.json" },
    })).toThrow();
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: { type: "string", max_length: 20, pattern: ".*" },
    })).toThrow();
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      render: () => "unsafe",
    })).toThrow();

    const recursive: Record<string, unknown> = {
      type: "array",
      max_items: 1,
    };
    recursive.items = recursive;
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: recursive,
    })).toThrow(/cyclic/i);

    let tooDeep: unknown = { type: "string", max_length: 1 };
    for (let index = 0; index <= ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_depth; index += 1) {
      tooDeep = { type: "array", items: tooDeep, max_items: 1 };
    }
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: tooDeep,
    })).toThrow(/depth/i);

    const oversized = validBlueprint();
    oversized.routing.covered_topics = Array.from(
      { length: ARTIFACT_BLUEPRINT_V1_LIMITS.max_routing_terms + 1 },
      (_, index) => `topic-${index}`,
    );
    expect(() => validateArtifactBlueprintV1(oversized)).toThrow();
  });

  it("enforces schema bounds, required fields, pointer targets, and runtime values", () => {
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: { type: "string" },
    })).toThrow(/max_length/i);
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      record_schema: {
        type: "object",
        properties: {},
        required: ["missing"],
        additional_properties: false,
        max_properties: 0,
      },
    })).toThrow(/required/i);
    expect(() => validateArtifactBlueprintV1({
      ...validBlueprint(),
      search_fields: [{ path: "/missing", weight: 1, analyzer: "text" }],
    })).toThrow(/search_fields/i);

    const blueprint = validateArtifactBlueprintV1(validBlueprint());
    expect(validateRestrictedSchemaValueV1(blueprint.record_schema, {
      action: "Implement AA1",
      done: false,
    })).toEqual({ action: "Implement AA1", done: false });
    expect(() => validateRestrictedSchemaValueV1(blueprint.record_schema, {
      action: "Implement AA1",
      done: false,
      code: "() => unsafe",
    })).toThrow(/additional/i);
  });

  it("requires text search for free-form strings in newly planned one-off Blueprints", () => {
    const legacyFreeFormKeyword: ArtifactBlueprintV1 = {
      ...validBlueprint(),
      blueprint_id: "one-off.interview_questions",
      title: "Interview questions",
      record_schema: {
        type: "object",
        properties: {
          topic: { type: "string", max_length: 400 },
        },
        required: ["topic"],
        additional_properties: false,
        max_properties: 1,
      },
      search_fields: [{ path: "/topic", weight: 10, analyzer: "keyword" }],
      summary_fields: ["/topic"],
    };

    expect(validateArtifactBlueprintV1(legacyFreeFormKeyword)).toEqual(legacyFreeFormKeyword);
    expect(() => validatePlannerOneOffArtifactBlueprintV1(legacyFreeFormKeyword))
      .toThrow(/free-form string.*text/i);

    const boundedKeyword: ArtifactBlueprintV1 = {
      ...legacyFreeFormKeyword,
      record_schema: {
        ...legacyFreeFormKeyword.record_schema,
        properties: {
          topic: {
            type: "string",
            max_length: 32,
            enum: ["architecture", "inference", "training"],
          },
        },
      },
    };
    expect(validatePlannerOneOffArtifactBlueprintV1(boundedKeyword)).toEqual(boundedKeyword);
  });

  it("computes one canonical digest for semantically identical key order", () => {
    const blueprint = validBlueprint();
    const reordered = reverseObjectKeys(blueprint);
    expect(computeArtifactBlueprintDigest(reordered)).toBe(computeArtifactBlueprintDigest(blueprint));
    expect(computeArtifactBlueprintDigest({
      ...blueprint,
      title: "Changed title",
    })).not.toBe(computeArtifactBlueprintDigest(blueprint));
  });
});

describe("system ArtifactBlueprint registry", () => {
  it("contains stable, immutable entries for the four legacy artifact types", () => {
    const expected = ["argument_map", "comparison_table", "concept_map", "timeline"];
    expect(Object.keys(SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1).sort()).toEqual(expected);
    expect(Object.isFrozen(SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1)).toBe(true);

    for (const artifactType of expected as LegacyIntentArtifactTypeV1[]) {
      const entry = SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1[artifactType];
      expect(entry.blueprint.origin).toBe("system");
      expect(entry.digest).toBe(computeArtifactBlueprintDigest(entry.blueprint));
      expect(getSystemArtifactBlueprintV1(artifactType)).toBe(entry);
      expect(Object.isFrozen(entry.blueprint)).toBe(true);
    }
  });

  it("expresses golden mappings of all four accepted v1 payload shapes", () => {
    const golden = readGolden();
    expect(golden.version).toBe("artifact_blueprint_presets.v1.golden");

    for (const sample of golden.cases) {
      const entry = getSystemArtifactBlueprintV1(sample.artifact_type);
      const mapped = mapLegacyGolden(sample.artifact_type, sample.legacy_payload);
      expect(entry.blueprint.blueprint_id).toBe(sample.blueprint_id);
      expect(entry.digest).toBe(sample.blueprint_digest);
      expect(mapped).toEqual({
        records: sample.mapped_records,
        relations: sample.mapped_relations,
      });
      expect(sample.mapped_records.length).toBeLessThanOrEqual(entry.blueprint.limits.max_records);
      expect(sample.mapped_relations.length).toBeLessThanOrEqual(entry.blueprint.limits.max_relations);

      for (const record of sample.mapped_records) {
        expect(record.record_id).not.toBe("");
        expect(record.evidence_lids.length).toBeGreaterThan(0);
        expect(validateRestrictedSchemaValueV1(entry.blueprint.record_schema, record.data)).toEqual(record.data);
      }
      for (const relation of sample.mapped_relations) {
        expect(entry.blueprint.relation_schema).toBeDefined();
        expect(relation.relation_id).not.toBe("");
        expect(relation.source).not.toBe("");
        expect(relation.target).not.toBe("");
        expect(relation.evidence_lids.length).toBeGreaterThan(0);
        expect(validateRestrictedSchemaValueV1(entry.blueprint.relation_schema!, relation.data)).toEqual(relation.data);
      }
    }
  });
});
