import { createHash } from "node:crypto";
import { canonicalBuildJson, validatePathSafeBuildId } from "./build-intent";

export const ARTIFACT_BLUEPRINT_V1_LIMITS = Object.freeze({
  max_schema_depth: 8,
  max_schema_nodes: 256,
  max_object_properties: 64,
  max_array_items: 10_000,
  max_enum_values: 64,
  max_routing_terms: 32,
  max_search_fields: 32,
  max_summary_fields: 32,
  max_field_path_chars: 256,
  max_title_chars: 200,
  max_purpose_chars: 2_000,
  max_routing_term_chars: 400,
  max_scope_label_chars: 200,
  max_schema_string_chars: 100_000,
  max_records: 100_000,
  max_relations: 200_000,
  max_text_chars: 10_000_000,
} as const);

const ARTIFACT_SHAPES = ["collection", "table", "graph", "sequence", "document"] as const;
const ARTIFACT_BLUEPRINT_ORIGINS = ["system", "user_private", "one_off"] as const;
const SEARCH_ANALYZERS = ["text", "keyword"] as const;
const LEGACY_INTENT_ARTIFACT_TYPES = [
  "timeline",
  "concept_map",
  "comparison_table",
  "argument_map",
] as const;

export type ArtifactShape = typeof ARTIFACT_SHAPES[number];
export type ArtifactBlueprintOrigin = typeof ARTIFACT_BLUEPRINT_ORIGINS[number];
export type ArtifactSearchAnalyzer = typeof SEARCH_ANALYZERS[number];
export type LegacyIntentArtifactTypeV1 = typeof LEGACY_INTENT_ARTIFACT_TYPES[number];

export interface RestrictedStringSchemaV1 {
  type: "string";
  min_length?: number;
  max_length: number;
  enum?: string[];
}

export interface RestrictedNumberSchemaV1 {
  type: "number";
  minimum: number;
  maximum: number;
  enum?: number[];
}

export interface RestrictedBooleanSchemaV1 {
  type: "boolean";
  enum?: boolean[];
}

export interface RestrictedNullSchemaV1 {
  type: "null";
}

export interface RestrictedArraySchemaV1 {
  type: "array";
  items: RestrictedSchemaV1;
  min_items?: number;
  max_items: number;
}

export interface RestrictedObjectSchemaV1 {
  type: "object";
  properties: Record<string, RestrictedSchemaV1>;
  required: string[];
  additional_properties: false;
  max_properties: number;
}

export type RestrictedSchemaV1 =
  | RestrictedStringSchemaV1
  | RestrictedNumberSchemaV1
  | RestrictedBooleanSchemaV1
  | RestrictedNullSchemaV1
  | RestrictedArraySchemaV1
  | RestrictedObjectSchemaV1;

export interface ArtifactBlueprintV1 {
  version: "artifact_blueprint.v1";
  blueprint_id: string;
  blueprint_version: string;
  origin: ArtifactBlueprintOrigin;
  title: string;
  purpose: string;
  shape: ArtifactShape;
  record_schema: RestrictedObjectSchemaV1;
  relation_schema?: RestrictedObjectSchemaV1;
  routing: {
    use_when: string[];
    avoid_when: string[];
    covered_topics: string[];
    scope_label: string;
  };
  search_fields: Array<{
    path: string;
    weight: number;
    analyzer: ArtifactSearchAnalyzer;
  }>;
  summary_fields: string[];
  evidence_policy: {
    required_per_record: true;
    anchor: "lid";
  };
  limits: {
    max_records: number;
    max_relations: number;
    max_text_chars: number;
  };
}

export interface SystemArtifactBlueprintEntryV1 {
  legacy_artifact_type: LegacyIntentArtifactTypeV1;
  blueprint: ArtifactBlueprintV1;
  digest: string;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  return value;
}

function assertExactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unknown field: ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
}

function assertAllowedKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
}

function requireString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-blank string`);
  }
  if (value.length > maxLength) throw new Error(`${path} exceeds ${maxLength} characters`);
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function requireUniqueStrings(
  value: unknown,
  path: string,
  options: {
    minimum?: number;
    maximum: number;
    maxStringLength: number;
    allowBlank?: boolean;
  },
): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const minimum = options.minimum ?? 0;
  if (value.length < minimum || value.length > options.maximum) {
    throw new Error(`${path} must contain between ${minimum} and ${options.maximum} entries`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== "string" || (!options.allowBlank && item.trim().length === 0)) {
      throw new Error(`${path}[${index}] must be a non-blank string`);
    }
    if (item.length > options.maxStringLength) {
      throw new Error(`${path}[${index}] exceeds ${options.maxStringLength} characters`);
    }
    if (seen.has(item)) throw new Error(`${path} contains duplicate value: ${item}`);
    seen.add(item);
    return item;
  });
}

function parsePrimitiveEnum<T extends string | number | boolean>(
  value: unknown,
  path: string,
  maximum: number,
  parse: (item: unknown, itemPath: string) => T,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${path} must contain between 1 and ${maximum} values`);
  }
  const parsed = value.map((item, index) => parse(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} must not contain duplicates`);
  return parsed;
}

interface SchemaParseState {
  nodes: number;
  ancestors: Set<object>;
}

function parseRestrictedSchema(
  input: unknown,
  path: string,
  depth: number,
  state: SchemaParseState,
): RestrictedSchemaV1 {
  if (depth > ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_depth) {
    throw new Error(`${path} exceeds maximum schema depth ${ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_depth}`);
  }
  const value = requireObject(input, path);
  if (state.ancestors.has(value)) throw new Error(`${path} contains a cyclic schema reference`);
  state.nodes += 1;
  if (state.nodes > ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_nodes) {
    throw new Error(`${path} exceeds maximum schema node count ${ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_nodes}`);
  }

  state.ancestors.add(value);
  try {
    const type = requireEnum(value.type, ["string", "number", "boolean", "null", "array", "object"] as const, `${path}.type`);
    switch (type) {
      case "string": {
        assertAllowedKeys(value, ["type", "max_length"], ["min_length", "enum"], path);
        const maxLength = requireSafeInteger(
          value.max_length,
          `${path}.max_length`,
          0,
          ARTIFACT_BLUEPRINT_V1_LIMITS.max_schema_string_chars,
        );
        const minLength = value.min_length === undefined
          ? undefined
          : requireSafeInteger(value.min_length, `${path}.min_length`, 0, maxLength);
        const enumeration = parsePrimitiveEnum(
          value.enum,
          `${path}.enum`,
          ARTIFACT_BLUEPRINT_V1_LIMITS.max_enum_values,
          (item, itemPath) => {
            if (typeof item !== "string") throw new Error(`${itemPath} must be a string`);
            if (item.length > maxLength || (minLength !== undefined && item.length < minLength)) {
              throw new Error(`${itemPath} violates the declared string bounds`);
            }
            return item;
          },
        );
        return {
          type,
          ...(minLength === undefined ? {} : { min_length: minLength }),
          max_length: maxLength,
          ...(enumeration === undefined ? {} : { enum: enumeration }),
        };
      }
      case "number": {
        assertAllowedKeys(value, ["type", "minimum", "maximum"], ["enum"], path);
        const minimum = requireFiniteNumber(value.minimum, `${path}.minimum`);
        const maximum = requireFiniteNumber(value.maximum, `${path}.maximum`);
        if (minimum > maximum) throw new Error(`${path}.minimum must not exceed maximum`);
        const enumeration = parsePrimitiveEnum(
          value.enum,
          `${path}.enum`,
          ARTIFACT_BLUEPRINT_V1_LIMITS.max_enum_values,
          (item, itemPath) => {
            const parsed = requireFiniteNumber(item, itemPath);
            if (parsed < minimum || parsed > maximum) throw new Error(`${itemPath} violates the declared numeric bounds`);
            return parsed;
          },
        );
        return {
          type,
          minimum,
          maximum,
          ...(enumeration === undefined ? {} : { enum: enumeration }),
        };
      }
      case "boolean": {
        assertAllowedKeys(value, ["type"], ["enum"], path);
        const enumeration = parsePrimitiveEnum(
          value.enum,
          `${path}.enum`,
          2,
          (item, itemPath) => {
            if (typeof item !== "boolean") throw new Error(`${itemPath} must be boolean`);
            return item;
          },
        );
        return { type, ...(enumeration === undefined ? {} : { enum: enumeration }) };
      }
      case "null":
        assertExactKeys(value, ["type"], path);
        return { type };
      case "array": {
        assertAllowedKeys(value, ["type", "items", "max_items"], ["min_items"], path);
        const maxItems = requireSafeInteger(
          value.max_items,
          `${path}.max_items`,
          0,
          ARTIFACT_BLUEPRINT_V1_LIMITS.max_array_items,
        );
        const minItems = value.min_items === undefined
          ? undefined
          : requireSafeInteger(value.min_items, `${path}.min_items`, 0, maxItems);
        return {
          type,
          items: parseRestrictedSchema(value.items, `${path}.items`, depth + 1, state),
          ...(minItems === undefined ? {} : { min_items: minItems }),
          max_items: maxItems,
        };
      }
      case "object": {
        assertExactKeys(
          value,
          ["type", "properties", "required", "additional_properties", "max_properties"],
          path,
        );
        if (value.additional_properties !== false) {
          throw new Error(`${path}.additional_properties must be false`);
        }
        const propertyInput = requireObject(value.properties, `${path}.properties`);
        const propertyNames = Object.keys(propertyInput);
        if (propertyNames.length > ARTIFACT_BLUEPRINT_V1_LIMITS.max_object_properties) {
          throw new Error(`${path}.properties exceeds ${ARTIFACT_BLUEPRINT_V1_LIMITS.max_object_properties} fields`);
        }
        const maxProperties = requireSafeInteger(
          value.max_properties,
          `${path}.max_properties`,
          propertyNames.length,
          ARTIFACT_BLUEPRINT_V1_LIMITS.max_object_properties,
        );
        if (maxProperties !== propertyNames.length) {
          throw new Error(`${path}.max_properties must equal the closed property count`);
        }
        const required = requireUniqueStrings(value.required, `${path}.required`, {
          maximum: propertyNames.length,
          maxStringLength: ARTIFACT_BLUEPRINT_V1_LIMITS.max_field_path_chars,
        });
        const propertySet = new Set(propertyNames);
        for (const field of required) {
          if (!propertySet.has(field)) throw new Error(`${path}.required references unknown property: ${field}`);
        }
        const properties: Record<string, RestrictedSchemaV1> = {};
        for (const propertyName of propertyNames.sort()) {
          requireString(propertyName, `${path}.properties key`, ARTIFACT_BLUEPRINT_V1_LIMITS.max_field_path_chars);
          properties[propertyName] = parseRestrictedSchema(
            propertyInput[propertyName],
            `${path}.properties.${propertyName}`,
            depth + 1,
            state,
          );
        }
        return {
          type,
          properties,
          required,
          additional_properties: false,
          max_properties: maxProperties,
        };
      }
    }
  } finally {
    state.ancestors.delete(value);
  }
}

export function validateRestrictedSchemaV1(input: unknown, path = "$schema"): RestrictedSchemaV1 {
  return parseRestrictedSchema(input, path, 1, { nodes: 0, ancestors: new Set<object>() });
}

function decodeJsonPointer(path: string, field: string): string[] {
  if (!path.startsWith("/") || path.length > ARTIFACT_BLUEPRINT_V1_LIMITS.max_field_path_chars) {
    throw new Error(`${field} must be a bounded non-root JSON Pointer`);
  }
  return path.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/u.test(token)) throw new Error(`${field} contains invalid JSON Pointer escaping`);
    return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
  });
}

function schemaAtPointer(schema: RestrictedSchemaV1, path: string, field: string): RestrictedSchemaV1 | undefined {
  let current: RestrictedSchemaV1 | undefined = schema;
  for (const token of decodeJsonPointer(path, field)) {
    if (current.type !== "object") return undefined;
    current = current.properties[token];
    if (!current) return undefined;
  }
  return current;
}

function resolveBlueprintField(
  recordSchema: RestrictedObjectSchemaV1,
  relationSchema: RestrictedObjectSchemaV1 | undefined,
  path: string,
  field: string,
): RestrictedSchemaV1 {
  const recordField = schemaAtPointer(recordSchema, path, field);
  const relationField = relationSchema === undefined ? undefined : schemaAtPointer(relationSchema, path, field);
  if (!recordField && !relationField) throw new Error(`${field} does not resolve in record_schema or relation_schema`);
  if (recordField && relationField && canonicalBuildJson(recordField) !== canonicalBuildJson(relationField)) {
    throw new Error(`${field} resolves to conflicting record and relation schemas`);
  }
  return (recordField ?? relationField)!;
}

function parseRouting(input: unknown): ArtifactBlueprintV1["routing"] {
  const value = requireObject(input, "$blueprint.routing");
  assertExactKeys(value, ["use_when", "avoid_when", "covered_topics", "scope_label"], "$blueprint.routing");
  const stringArray = (field: "use_when" | "avoid_when" | "covered_topics", minimum: number) => (
    requireUniqueStrings(value[field], `$blueprint.routing.${field}`, {
      minimum,
      maximum: ARTIFACT_BLUEPRINT_V1_LIMITS.max_routing_terms,
      maxStringLength: ARTIFACT_BLUEPRINT_V1_LIMITS.max_routing_term_chars,
    })
  );
  return {
    use_when: stringArray("use_when", 1),
    avoid_when: stringArray("avoid_when", 0),
    covered_topics: stringArray("covered_topics", 1),
    scope_label: requireString(
      value.scope_label,
      "$blueprint.routing.scope_label",
      ARTIFACT_BLUEPRINT_V1_LIMITS.max_scope_label_chars,
    ),
  };
}

function parseLimits(input: unknown, hasRelationSchema: boolean): ArtifactBlueprintV1["limits"] {
  const value = requireObject(input, "$blueprint.limits");
  assertExactKeys(value, ["max_records", "max_relations", "max_text_chars"], "$blueprint.limits");
  const limits = {
    max_records: requireSafeInteger(
      value.max_records,
      "$blueprint.limits.max_records",
      1,
      ARTIFACT_BLUEPRINT_V1_LIMITS.max_records,
    ),
    max_relations: requireSafeInteger(
      value.max_relations,
      "$blueprint.limits.max_relations",
      0,
      ARTIFACT_BLUEPRINT_V1_LIMITS.max_relations,
    ),
    max_text_chars: requireSafeInteger(
      value.max_text_chars,
      "$blueprint.limits.max_text_chars",
      1,
      ARTIFACT_BLUEPRINT_V1_LIMITS.max_text_chars,
    ),
  };
  if (hasRelationSchema !== (limits.max_relations > 0)) {
    throw new Error("$blueprint relation_schema and positive max_relations must appear together");
  }
  return limits;
}

export function validateArtifactBlueprintV1(input: unknown): ArtifactBlueprintV1 {
  const value = requireObject(input, "$blueprint");
  assertAllowedKeys(
    value,
    [
      "version",
      "blueprint_id",
      "blueprint_version",
      "origin",
      "title",
      "purpose",
      "shape",
      "record_schema",
      "routing",
      "search_fields",
      "summary_fields",
      "evidence_policy",
      "limits",
    ],
    ["relation_schema"],
    "$blueprint",
  );
  if (value.version !== "artifact_blueprint.v1") {
    throw new Error("$blueprint.version must be artifact_blueprint.v1");
  }

  const recordSchema = validateRestrictedSchemaV1(value.record_schema, "$blueprint.record_schema");
  if (recordSchema.type !== "object") throw new Error("$blueprint.record_schema must be an object schema");
  const relationSchemaInput = value.relation_schema;
  const parsedRelationSchema = relationSchemaInput === undefined
    ? undefined
    : validateRestrictedSchemaV1(relationSchemaInput, "$blueprint.relation_schema");
  if (parsedRelationSchema !== undefined && parsedRelationSchema.type !== "object") {
    throw new Error("$blueprint.relation_schema must be an object schema");
  }
  const relationSchema = parsedRelationSchema as RestrictedObjectSchemaV1 | undefined;

  if (!Array.isArray(value.search_fields)
    || value.search_fields.length < 1
    || value.search_fields.length > ARTIFACT_BLUEPRINT_V1_LIMITS.max_search_fields) {
    throw new Error(`$blueprint.search_fields must contain between 1 and ${ARTIFACT_BLUEPRINT_V1_LIMITS.max_search_fields} fields`);
  }
  const searchPaths = new Set<string>();
  const searchFields = value.search_fields.map((inputField, index) => {
    const field = requireObject(inputField, `$blueprint.search_fields[${index}]`);
    assertExactKeys(field, ["path", "weight", "analyzer"], `$blueprint.search_fields[${index}]`);
    const path = requireString(
      field.path,
      `$blueprint.search_fields[${index}].path`,
      ARTIFACT_BLUEPRINT_V1_LIMITS.max_field_path_chars,
    );
    if (searchPaths.has(path)) throw new Error(`$blueprint.search_fields contains duplicate path: ${path}`);
    searchPaths.add(path);
    const target = resolveBlueprintField(
      recordSchema,
      relationSchema,
      path,
      `$blueprint.search_fields[${index}].path`,
    );
    if (!["string", "number", "boolean"].includes(target.type)) {
      throw new Error(`$blueprint.search_fields[${index}].path must resolve to a scalar searchable field`);
    }
    return {
      path,
      weight: requireSafeInteger(field.weight, `$blueprint.search_fields[${index}].weight`, 1, 10),
      analyzer: requireEnum(
        field.analyzer,
        SEARCH_ANALYZERS,
        `$blueprint.search_fields[${index}].analyzer`,
      ),
    };
  });

  const summaryFields = requireUniqueStrings(value.summary_fields, "$blueprint.summary_fields", {
    minimum: 1,
    maximum: ARTIFACT_BLUEPRINT_V1_LIMITS.max_summary_fields,
    maxStringLength: ARTIFACT_BLUEPRINT_V1_LIMITS.max_field_path_chars,
  });
  summaryFields.forEach((path, index) => {
    resolveBlueprintField(recordSchema, relationSchema, path, `$blueprint.summary_fields[${index}]`);
  });

  const evidencePolicy = requireObject(value.evidence_policy, "$blueprint.evidence_policy");
  assertExactKeys(evidencePolicy, ["required_per_record", "anchor"], "$blueprint.evidence_policy");
  if (evidencePolicy.required_per_record !== true || evidencePolicy.anchor !== "lid") {
    throw new Error("$blueprint.evidence_policy must require one or more LID anchors per record");
  }

  const blueprint: ArtifactBlueprintV1 = {
    version: "artifact_blueprint.v1",
    blueprint_id: validatePathSafeBuildId(value.blueprint_id, "blueprint_id"),
    blueprint_version: validatePathSafeBuildId(value.blueprint_version, "blueprint_version"),
    origin: requireEnum(value.origin, ARTIFACT_BLUEPRINT_ORIGINS, "$blueprint.origin"),
    title: requireString(value.title, "$blueprint.title", ARTIFACT_BLUEPRINT_V1_LIMITS.max_title_chars),
    purpose: requireString(value.purpose, "$blueprint.purpose", ARTIFACT_BLUEPRINT_V1_LIMITS.max_purpose_chars),
    shape: requireEnum(value.shape, ARTIFACT_SHAPES, "$blueprint.shape"),
    record_schema: recordSchema,
    ...(relationSchema === undefined ? {} : { relation_schema: relationSchema }),
    routing: parseRouting(value.routing),
    search_fields: searchFields,
    summary_fields: summaryFields,
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: parseLimits(value.limits, relationSchema !== undefined),
  };
  canonicalBuildJson(blueprint);
  return blueprint;
}

export function validatePlannerOneOffArtifactBlueprintV1(input: unknown): ArtifactBlueprintV1 {
  const blueprint = validateArtifactBlueprintV1(input);
  if (blueprint.origin !== "one_off") {
    throw new Error("planner one-off ArtifactBlueprint must have one_off origin");
  }
  blueprint.search_fields.forEach((field, index) => {
    const target = resolveBlueprintField(
      blueprint.record_schema,
      blueprint.relation_schema,
      field.path,
      `$blueprint.search_fields[${index}].path`,
    );
    if (field.analyzer === "keyword" && target.type === "string" && target.enum === undefined) {
      throw new Error(
        `$blueprint.search_fields[${index}] cannot use keyword for a free-form string; use text`,
      );
    }
  });
  return blueprint;
}

export function computeArtifactBlueprintDigest(input: unknown): string {
  const blueprint = validateArtifactBlueprintV1(input);
  return createHash("sha256").update(canonicalBuildJson(blueprint), "utf8").digest("hex");
}

function valueMatchesEnum(value: string | number | boolean, enumeration: readonly unknown[] | undefined): boolean {
  return enumeration === undefined || enumeration.some((item) => Object.is(item, value));
}

function validateSchemaValue(schema: RestrictedSchemaV1, input: unknown, path: string): unknown {
  switch (schema.type) {
    case "string":
      if (typeof input !== "string") throw new Error(`${path} must be a string`);
      if (input.length > schema.max_length || (schema.min_length !== undefined && input.length < schema.min_length)) {
        throw new Error(`${path} violates string length bounds`);
      }
      if (!valueMatchesEnum(input, schema.enum)) throw new Error(`${path} is not in the allowed enum`);
      return input;
    case "number":
      if (typeof input !== "number" || !Number.isFinite(input)) throw new Error(`${path} must be a finite number`);
      if (input < schema.minimum || input > schema.maximum) throw new Error(`${path} violates numeric bounds`);
      if (!valueMatchesEnum(input, schema.enum)) throw new Error(`${path} is not in the allowed enum`);
      return input;
    case "boolean":
      if (typeof input !== "boolean") throw new Error(`${path} must be boolean`);
      if (!valueMatchesEnum(input, schema.enum)) throw new Error(`${path} is not in the allowed enum`);
      return input;
    case "null":
      if (input !== null) throw new Error(`${path} must be null`);
      return null;
    case "array":
      if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
      if (input.length > schema.max_items || (schema.min_items !== undefined && input.length < schema.min_items)) {
        throw new Error(`${path} violates array length bounds`);
      }
      return input.map((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`));
    case "object": {
      const value = requireObject(input, path);
      const keys = Object.keys(value);
      for (const required of schema.required) {
        if (!(required in value)) throw new Error(`${path}.${required} is required`);
      }
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const propertySchema = schema.properties[key];
        if (!propertySchema) throw new Error(`${path} contains additional property: ${key}`);
        result[key] = validateSchemaValue(propertySchema, value[key], `${path}.${key}`);
      }
      if (keys.length > schema.max_properties) throw new Error(`${path} exceeds max_properties`);
      return result;
    }
  }
}

export function validateRestrictedSchemaValueV1(schemaInput: unknown, value: unknown): unknown {
  const schema = validateRestrictedSchemaV1(schemaInput);
  return validateSchemaValue(schema, value, "$value");
}

function objectSchema(
  properties: Record<string, RestrictedSchemaV1>,
  required: string[],
): RestrictedObjectSchemaV1 {
  return {
    type: "object",
    properties,
    required,
    additional_properties: false,
    max_properties: Object.keys(properties).length,
  };
}

const systemBlueprintInputs: Record<LegacyIntentArtifactTypeV1, ArtifactBlueprintV1> = {
  timeline: {
    version: "artifact_blueprint.v1",
    blueprint_id: "system.timeline",
    blueprint_version: "1.0.0",
    origin: "system",
    title: "Timeline",
    purpose: "Order evidence-backed events or stages from the selected source scope.",
    shape: "sequence",
    record_schema: objectSchema({
      label: { type: "string", min_length: 1, max_length: 4_000 },
      order_hint: { type: "string", min_length: 1, max_length: 400 },
    }, ["label"]),
    routing: {
      use_when: ["The question depends on chronology, stages, or ordered change."],
      avoid_when: ["The question asks only for a static definition."],
      covered_topics: ["chronology", "stages", "ordered change"],
      scope_label: "confirmed build source scope",
    },
    search_fields: [
      { path: "/label", weight: 10, analyzer: "text" },
      { path: "/order_hint", weight: 4, analyzer: "keyword" },
    ],
    summary_fields: ["/label", "/order_hint"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 10_000, max_relations: 0, max_text_chars: 2_000_000 },
  },
  concept_map: {
    version: "artifact_blueprint.v1",
    blueprint_id: "system.concept_map",
    blueprint_version: "1.0.0",
    origin: "system",
    title: "Concept map",
    purpose: "Represent evidence-backed concepts and explicit semantic links between them.",
    shape: "graph",
    record_schema: objectSchema({
      label: { type: "string", min_length: 1, max_length: 4_000 },
    }, ["label"]),
    relation_schema: objectSchema({
      relation: { type: "string", min_length: 1, max_length: 400 },
    }, ["relation"]),
    routing: {
      use_when: ["The question depends on concept relationships or structural dependencies."],
      avoid_when: ["The question asks only for chronological ordering."],
      covered_topics: ["concepts", "relationships", "dependencies"],
      scope_label: "confirmed build source scope",
    },
    search_fields: [
      { path: "/label", weight: 10, analyzer: "text" },
      { path: "/relation", weight: 6, analyzer: "text" },
    ],
    summary_fields: ["/label", "/relation"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 10_000, max_relations: 20_000, max_text_chars: 3_000_000 },
  },
  comparison_table: {
    version: "artifact_blueprint.v1",
    blueprint_id: "system.comparison_table",
    blueprint_version: "1.0.0",
    origin: "system",
    title: "Comparison table",
    purpose: "Compare evidence-backed subjects across named dimensions without fixing dimension names in advance.",
    shape: "table",
    record_schema: objectSchema({
      dimensions: {
        type: "array",
        items: objectSchema({
          name: { type: "string", min_length: 1, max_length: 400 },
          value_json: { type: "string", max_length: 10_000 },
        }, ["name", "value_json"]),
        max_items: 64,
      },
      subject: { type: "string", min_length: 1, max_length: 4_000 },
    }, ["subject", "dimensions"]),
    routing: {
      use_when: ["The question compares multiple subjects using shared dimensions."],
      avoid_when: ["The question asks for causal or argumentative graph structure."],
      covered_topics: ["comparison", "trade-offs", "dimensions"],
      scope_label: "confirmed build source scope",
    },
    search_fields: [{ path: "/subject", weight: 10, analyzer: "text" }],
    summary_fields: ["/subject", "/dimensions"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 10_000, max_relations: 0, max_text_chars: 3_000_000 },
  },
  argument_map: {
    version: "artifact_blueprint.v1",
    blueprint_id: "system.argument_map",
    blueprint_version: "1.0.0",
    origin: "system",
    title: "Argument map",
    purpose: "Represent evidence-backed claims, their discourse roles, and explicit argumentative relations.",
    shape: "graph",
    record_schema: objectSchema({
      claim: { type: "string", min_length: 1, max_length: 8_000 },
      role: {
        type: "string",
        max_length: 32,
        enum: ["problem", "method", "evidence", "result", "limitation", "future_work"],
      },
    }, ["claim", "role"]),
    relation_schema: objectSchema({
      relation: { type: "string", min_length: 1, max_length: 400 },
    }, ["relation"]),
    routing: {
      use_when: ["The question depends on claims, support, objections, or qualifications."],
      avoid_when: ["The question asks only for a flat list of concepts."],
      covered_topics: ["claims", "support", "objections", "qualifications"],
      scope_label: "confirmed build source scope",
    },
    search_fields: [
      { path: "/claim", weight: 10, analyzer: "text" },
      { path: "/role", weight: 5, analyzer: "keyword" },
      { path: "/relation", weight: 6, analyzer: "text" },
    ],
    summary_fields: ["/claim", "/role", "/relation"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 10_000, max_relations: 20_000, max_text_chars: 4_000_000 },
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function buildSystemRegistry(): Readonly<Record<LegacyIntentArtifactTypeV1, SystemArtifactBlueprintEntryV1>> {
  const entries = Object.fromEntries(LEGACY_INTENT_ARTIFACT_TYPES.map((legacyType) => {
    const blueprint = deepFreeze(validateArtifactBlueprintV1(systemBlueprintInputs[legacyType]));
    const entry = deepFreeze({
      legacy_artifact_type: legacyType,
      blueprint,
      digest: computeArtifactBlueprintDigest(blueprint),
    });
    return [legacyType, entry];
  })) as Record<LegacyIntentArtifactTypeV1, SystemArtifactBlueprintEntryV1>;
  return deepFreeze(entries);
}

export const SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1 = buildSystemRegistry();

export function getSystemArtifactBlueprintV1(
  artifactType: LegacyIntentArtifactTypeV1,
): SystemArtifactBlueprintEntryV1 {
  const entry = SYSTEM_ARTIFACT_BLUEPRINT_REGISTRY_V1[artifactType];
  if (!entry) throw new Error(`unknown system ArtifactBlueprint preset: ${artifactType}`);
  return entry;
}
