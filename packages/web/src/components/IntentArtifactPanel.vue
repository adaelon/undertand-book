<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw } from "@lucide/vue";
import type {
  IntentArgumentMapPayloadV1,
  IntentArgumentRole,
  IntentArtifactDisplayBlueprintV1,
  IntentArtifactInstanceRecordV2,
  IntentArtifactInstanceRelationV2,
  IntentArtifactInstanceV2,
  IntentArtifactOverlayV1,
  IntentArtifactProjectionV1,
  IntentArtifactType,
  IntentComparisonTablePayloadV1,
  IntentConceptMapPayloadV1,
  IntentTimelinePayloadV1,
} from "../api";

const props = defineProps<{
  overlay?: IntentArtifactOverlayV1 | null;
  loading?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "goto", lid: string): void;
  (e: "cite", artifactId: string): void;
}>();

const acceptedCount = computed(() => (
  props.overlay?.artifacts.filter((artifact) => artifact.state === "accepted").length ?? 0
));

const artifactLabels: Record<IntentArtifactType, string> = {
  timeline: "时间线",
  concept_map: "概念图",
  comparison_table: "对照表",
  argument_map: "论证图",
};

const legacyBlueprints: Record<IntentArtifactType, IntentArtifactDisplayBlueprintV1> = {
  timeline: {
    title: "Timeline",
    purpose: "Order evidence-backed events or stages from the selected source scope.",
    shape: "sequence",
    summary_fields: ["/label", "/order_hint"],
  },
  concept_map: {
    title: "Concept map",
    purpose: "Represent evidence-backed concepts and explicit semantic links between them.",
    shape: "graph",
    summary_fields: ["/label", "/relation"],
  },
  comparison_table: {
    title: "Comparison table",
    purpose: "Compare evidence-backed subjects across named dimensions.",
    shape: "table",
    summary_fields: ["/subject", "/dimensions"],
  },
  argument_map: {
    title: "Argument map",
    purpose: "Represent evidence-backed claims and argumentative relations.",
    shape: "graph",
    summary_fields: ["/claim", "/role", "/relation"],
  },
};

const supportedShapes = new Set(["collection", "table", "graph", "sequence", "document"]);

const argumentRoleLabels: Record<IntentArgumentRole, string> = {
  problem: "问题",
  method: "方法",
  evidence: "证据",
  result: "结果",
  limitation: "局限",
  future_work: "后续方向",
};

function conceptLabel(payload: IntentConceptMapPayloadV1, id: string): string {
  return payload.nodes.find((node) => node.id === id)?.label ?? id;
}

function claimLabel(payload: IntentArgumentMapPayloadV1, id: string): string {
  return payload.claims.find((claim) => claim.id === id)?.claim ?? id;
}

function comparisonDimensions(payload: IntentComparisonTablePayloadV1): string[] {
  return [...new Set(payload.rows.flatMap((row) => Object.keys(row.dimensions)))].sort();
}

function displayDimension(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactInstance(payload: unknown): payload is IntentArtifactInstanceV2 {
  return isObject(payload)
    && payload.version === "artifact_instance.v2"
    && Array.isArray(payload.records);
}

function isLegacyType(value: string): value is IntentArtifactType {
  return Object.prototype.hasOwnProperty.call(artifactLabels, value);
}

function blueprintFor(artifact: IntentArtifactProjectionV1): IntentArtifactDisplayBlueprintV1 {
  if (artifact.blueprint) return artifact.blueprint;
  if (isLegacyType(artifact.artifact_type)) return legacyBlueprints[artifact.artifact_type];
  return {
    title: "目标成果",
    purpose: "",
    shape: "collection",
    summary_fields: [],
  };
}

function artifactTitle(artifact: IntentArtifactProjectionV1): string {
  return isLegacyType(artifact.artifact_type)
    ? artifactLabels[artifact.artifact_type]
    : blueprintFor(artifact).title || "目标成果";
}

function artifactShape(artifact: IntentArtifactProjectionV1): IntentArtifactDisplayBlueprintV1["shape"] {
  const shape = blueprintFor(artifact).shape;
  return (supportedShapes.has(shape) ? shape : "collection") as IntentArtifactDisplayBlueprintV1["shape"];
}

function hasUnknownShape(artifact: IntentArtifactProjectionV1): boolean {
  return !supportedShapes.has(String(artifact.blueprint?.shape ?? blueprintFor(artifact).shape));
}

function timelineItems(artifact: IntentArtifactProjectionV1): IntentTimelinePayloadV1["items"] {
  if (artifact.state !== "accepted") return [];
  if (isArtifactInstance(artifact.payload)) {
    return artifact.payload.records.map((record) => ({
      id: record.record_id,
      label: typeof record.data.label === "string" ? record.data.label : displayDimension(record.data.label),
      ...(typeof record.data.order_hint === "string" ? { order_hint: record.data.order_hint } : {}),
      evidence_lids: record.evidence_lids,
    }));
  }
  const payload = artifact.payload as IntentTimelinePayloadV1;
  return Array.isArray(payload.items) ? payload.items : [];
}

function conceptPayload(artifact: IntentArtifactProjectionV1): IntentConceptMapPayloadV1 {
  if (artifact.state !== "accepted") return { nodes: [], links: [] };
  if (isArtifactInstance(artifact.payload)) {
    return {
      nodes: artifact.payload.records.map((record) => ({
        id: record.record_id,
        label: typeof record.data.label === "string" ? record.data.label : displayDimension(record.data.label),
        evidence_lids: record.evidence_lids,
      })),
      links: (artifact.payload.relations ?? []).map((relation) => ({
        source: relation.source,
        target: relation.target,
        relation: typeof relation.data.relation === "string"
          ? relation.data.relation
          : displayDimension(relation.data.relation),
        evidence_lids: relation.evidence_lids,
      })),
    };
  }
  const payload = artifact.payload as IntentConceptMapPayloadV1;
  return {
    nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
    links: Array.isArray(payload.links) ? payload.links : [],
  };
}

function parseDimensionValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function comparisonPayload(artifact: IntentArtifactProjectionV1): IntentComparisonTablePayloadV1 {
  if (artifact.state !== "accepted") return { rows: [] };
  if (isArtifactInstance(artifact.payload)) {
    return {
      rows: artifact.payload.records.map((record) => {
        const dimensions = Array.isArray(record.data.dimensions)
          ? Object.fromEntries(record.data.dimensions.flatMap((value) => {
            if (!isObject(value) || typeof value.name !== "string") return [];
            return [[value.name, parseDimensionValue(value.value_json)]];
          }))
          : isObject(record.data.dimensions) ? record.data.dimensions : {};
        return {
          subject: typeof record.data.subject === "string"
            ? record.data.subject
            : displayDimension(record.data.subject),
          dimensions,
          evidence_lids: record.evidence_lids,
        };
      }),
    };
  }
  const payload = artifact.payload as IntentComparisonTablePayloadV1;
  return { rows: Array.isArray(payload.rows) ? payload.rows : [] };
}

function argumentPayload(artifact: IntentArtifactProjectionV1): IntentArgumentMapPayloadV1 {
  if (artifact.state !== "accepted") return { claims: [], relations: [] };
  if (isArtifactInstance(artifact.payload)) {
    return {
      claims: artifact.payload.records.map((record) => ({
        id: record.record_id,
        claim: typeof record.data.claim === "string" ? record.data.claim : displayDimension(record.data.claim),
        role: (typeof record.data.role === "string" ? record.data.role : "evidence") as IntentArgumentRole,
        evidence_lids: record.evidence_lids,
      })),
      relations: (artifact.payload.relations ?? []).map((relation) => ({
        source: relation.source,
        target: relation.target,
        relation: typeof relation.data.relation === "string"
          ? relation.data.relation
          : displayDimension(relation.data.relation),
        evidence_lids: relation.evidence_lids,
      })),
    };
  }
  const payload = artifact.payload as IntentArgumentMapPayloadV1;
  return {
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    relations: Array.isArray(payload.relations) ? payload.relations : [],
  };
}

function argumentRoleLabel(role: IntentArgumentRole): string {
  return argumentRoleLabels[role] ?? role;
}

interface DisplayField {
  path: string;
  label: string;
  value: string;
}

function pointerValue(input: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (!pointer.startsWith("/")) return { found: false };
  let current = input;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)];
    } else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function fieldLabel(path: string): string {
  const encoded = path.split("/").at(-1) ?? path;
  return encoded.replace(/~1/gu, "/").replace(/~0/gu, "~").replace(/[_-]+/gu, " ") || "内容";
}

function orderedFieldPaths(
  artifact: IntentArtifactProjectionV1,
  values: Array<Record<string, unknown>>,
): string[] {
  const summary = blueprintFor(artifact).summary_fields.filter((path) => (
    values.some((value) => pointerValue(value, path).found)
  ));
  const fallbacks = [...new Set(values.flatMap((value) => Object.keys(value).map((key) => `/${key}`)))].sort();
  return [...new Set([...summary, ...fallbacks])];
}

function fieldsFor(
  artifact: IntentArtifactProjectionV1,
  data: Record<string, unknown>,
): DisplayField[] {
  return orderedFieldPaths(artifact, [data]).flatMap((path) => {
    const resolved = pointerValue(data, path);
    return resolved.found ? [{ path, label: fieldLabel(path), value: displayDimension(resolved.value) }] : [];
  });
}

function genericRecords(artifact: IntentArtifactProjectionV1): IntentArtifactInstanceRecordV2[] {
  if (artifact.state !== "accepted" || !isArtifactInstance(artifact.payload)) return [];
  return artifact.payload.records;
}

function genericRelations(artifact: IntentArtifactProjectionV1): IntentArtifactInstanceRelationV2[] {
  if (artifact.state !== "accepted" || !isArtifactInstance(artifact.payload)) return [];
  return artifact.payload.relations ?? [];
}

function genericTablePaths(artifact: IntentArtifactProjectionV1): string[] {
  return orderedFieldPaths(artifact, genericRecords(artifact).map((record) => record.data));
}

function genericCell(record: IntentArtifactInstanceRecordV2, path: string): string {
  const resolved = pointerValue(record.data, path);
  return resolved.found ? displayDimension(resolved.value) : "-";
}

function genericRecordLabel(artifact: IntentArtifactProjectionV1, recordId: string): string {
  const records = genericRecords(artifact);
  const index = records.findIndex((record) => record.record_id === recordId);
  if (index < 0) return "未知记录";
  return fieldsFor(artifact, records[index].data)[0]?.value || `记录 ${String(index + 1).padStart(2, "0")}`;
}

function relationFields(
  artifact: IntentArtifactProjectionV1,
  relation: IntentArtifactInstanceRelationV2,
): DisplayField[] {
  return fieldsFor(artifact, relation.data);
}

function openEvidence(artifactId: string, lid: string) {
  emit("cite", artifactId);
  emit("goto", lid);
}
</script>

<template>
  <div class="intent-artifact-panel">
    <header class="artifact-panel-head">
      <div>
        <p class="artifact-kicker">目标成果</p>
        <h3 v-if="props.overlay">
          {{ acceptedCount }} / {{ props.overlay.artifacts.length }} 已就绪
        </h3>
        <h3 v-else>尚未生成</h3>
      </div>
      <button
        type="button"
        class="artifact-refresh"
        aria-label="刷新目标成果"
        title="刷新目标成果"
        :disabled="props.loading"
        @click="emit('refresh')"
      >
        <RefreshCw :size="16" :class="{ spinning: props.loading }" aria-hidden="true" />
      </button>
    </header>

    <p v-if="props.error" class="artifact-state artifact-error">{{ props.error }}</p>
    <p v-else-if="props.loading && !props.overlay" class="artifact-state">正在刷新...</p>
    <p v-else-if="!props.overlay || props.overlay.artifacts.length === 0" class="artifact-state">暂无目标成果。</p>

    <div v-else class="artifact-list" :aria-busy="props.loading">
      <article
        v-for="(artifact, artifactIndex) in props.overlay.artifacts"
        :key="artifact.artifact_id"
        class="artifact-section"
      >
        <header class="artifact-section-head">
          <span class="artifact-index">{{ String(artifactIndex + 1).padStart(2, "0") }}</span>
          <h4>{{ artifactTitle(artifact) }}</h4>
          <span v-if="artifact.state === 'pending'" class="artifact-pending">准备中</span>
          <span v-else class="artifact-ready">已就绪</span>
        </header>

        <template v-if="artifact.state === 'accepted'">
          <ol v-if="artifact.artifact_type === 'timeline'" class="timeline-list">
            <li v-for="item in timelineItems(artifact)" :key="item.id" class="timeline-item">
              <span class="timeline-marker" aria-hidden="true"></span>
              <div class="artifact-record">
                <small v-if="item.order_hint">{{ item.order_hint }}</small>
                <p class="artifact-label artifact-wrap">{{ item.label }}</p>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in item.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </div>
            </li>
          </ol>

          <div v-else-if="artifact.artifact_type === 'concept_map'" class="artifact-graph">
            <div class="graph-node-list">
              <div v-for="node in conceptPayload(artifact).nodes" :key="node.id" class="graph-node">
                <p class="artifact-label artifact-wrap">{{ node.label }}</p>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in node.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="conceptPayload(artifact).links.length" class="relation-list">
              <div v-for="(link, linkIndex) in conceptPayload(artifact).links" :key="`${link.source}:${link.target}:${linkIndex}`" class="relation-row">
                <span class="artifact-wrap">{{ conceptLabel(conceptPayload(artifact), link.source) }}</span>
                <strong class="artifact-wrap">{{ link.relation }}</strong>
                <span class="artifact-wrap">{{ conceptLabel(conceptPayload(artifact), link.target) }}</span>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in link.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="artifact.artifact_type === 'comparison_table'" class="artifact-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>对象</th>
                  <th v-for="dimension in comparisonDimensions(comparisonPayload(artifact))" :key="dimension">{{ dimension }}</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in comparisonPayload(artifact).rows" :key="`${row.subject}:${rowIndex}`">
                  <th>{{ row.subject }}</th>
                  <td v-for="dimension in comparisonDimensions(comparisonPayload(artifact))" :key="dimension">
                    {{ displayDimension(row.dimensions[dimension]) }}
                  </td>
                  <td>
                    <div class="evidence-links table-evidence" aria-label="正文依据">
                      <button
                        v-for="lid in row.evidence_lids"
                        :key="lid"
                        type="button"
                        :data-lid="lid"
                        @click="openEvidence(artifact.artifact_id, lid)"
                      >
                        {{ lid }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="artifact.artifact_type === 'argument_map'" class="artifact-graph argument-graph">
            <div class="claim-list">
              <div v-for="claim in argumentPayload(artifact).claims" :key="claim.id" class="claim-row">
                <span class="claim-role">{{ argumentRoleLabel(claim.role) }}</span>
                <p class="artifact-label artifact-wrap">{{ claim.claim }}</p>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in claim.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="argumentPayload(artifact).relations.length" class="relation-list">
              <div v-for="(relation, relationIndex) in argumentPayload(artifact).relations" :key="`${relation.source}:${relation.target}:${relationIndex}`" class="relation-row">
                <span class="artifact-wrap">{{ claimLabel(argumentPayload(artifact), relation.source) }}</span>
                <strong class="artifact-wrap">{{ relation.relation }}</strong>
                <span class="artifact-wrap">{{ claimLabel(argumentPayload(artifact), relation.target) }}</span>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in relation.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <section
            v-else
            class="generic-artifact-shape"
            :data-artifact-shape="artifactShape(artifact)"
          >
            <p v-if="blueprintFor(artifact).purpose" class="artifact-purpose artifact-wrap">
              {{ blueprintFor(artifact).purpose }}
            </p>
            <p v-if="hasUnknownShape(artifact)" class="artifact-fallback-note">
              未知展示形态，已按列表展示
            </p>

            <div v-if="artifactShape(artifact) === 'collection'" class="generic-collection">
              <article
                v-for="(record, recordIndex) in genericRecords(artifact)"
                :key="record.record_id"
                class="generic-card"
              >
                <span class="generic-record-index">{{ String(recordIndex + 1).padStart(2, "0") }}</span>
                <dl v-if="fieldsFor(artifact, record.data).length" class="generic-fields">
                  <template v-for="field in fieldsFor(artifact, record.data)" :key="field.path">
                    <dt class="artifact-wrap">{{ field.label }}</dt>
                    <dd class="generic-field-value artifact-wrap">{{ field.value }}</dd>
                  </template>
                </dl>
                <p v-else class="generic-empty">暂无可展示字段</p>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in record.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </article>
              <p v-if="genericRecords(artifact).length === 0" class="generic-empty">暂无记录</p>
            </div>

            <div v-else-if="artifactShape(artifact) === 'table'" class="artifact-table-scroll generic-table">
              <table v-if="genericRecords(artifact).length">
                <thead>
                  <tr>
                    <th v-for="path in genericTablePaths(artifact)" :key="path">{{ fieldLabel(path) }}</th>
                    <th>依据</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="record in genericRecords(artifact)" :key="record.record_id">
                    <td v-for="path in genericTablePaths(artifact)" :key="path" class="generic-field-value artifact-wrap">
                      {{ genericCell(record, path) }}
                    </td>
                    <td>
                      <div class="evidence-links table-evidence" aria-label="正文依据">
                        <button
                          v-for="lid in record.evidence_lids"
                          :key="lid"
                          type="button"
                          :data-lid="lid"
                          @click="openEvidence(artifact.artifact_id, lid)"
                        >
                          {{ lid }}
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="generic-empty">暂无记录</p>
            </div>

            <div v-else-if="artifactShape(artifact) === 'graph'" class="artifact-graph generic-graph">
              <div class="graph-node-list">
                <article v-for="record in genericRecords(artifact)" :key="record.record_id" class="graph-node generic-card">
                  <dl v-if="fieldsFor(artifact, record.data).length" class="generic-fields">
                    <template v-for="field in fieldsFor(artifact, record.data)" :key="field.path">
                      <dt class="artifact-wrap">{{ field.label }}</dt>
                      <dd class="generic-field-value artifact-wrap">{{ field.value }}</dd>
                    </template>
                  </dl>
                  <p v-else class="generic-empty">暂无可展示字段</p>
                  <div class="evidence-links" aria-label="正文依据">
                    <button
                      v-for="lid in record.evidence_lids"
                      :key="lid"
                      type="button"
                      :data-lid="lid"
                      @click="openEvidence(artifact.artifact_id, lid)"
                    >
                      {{ lid }}
                    </button>
                  </div>
                </article>
              </div>
              <div v-if="genericRelations(artifact).length" class="relation-list">
                <div
                  v-for="relation in genericRelations(artifact)"
                  :key="relation.relation_id"
                  class="relation-row generic-relation"
                >
                  <span class="artifact-wrap">{{ genericRecordLabel(artifact, relation.source) }}</span>
                  <strong class="artifact-wrap">{{ relationFields(artifact, relation)[0]?.value || '关联' }}</strong>
                  <span class="artifact-wrap">{{ genericRecordLabel(artifact, relation.target) }}</span>
                  <div class="evidence-links" aria-label="正文依据">
                    <button
                      v-for="lid in relation.evidence_lids"
                      :key="lid"
                      type="button"
                      :data-lid="lid"
                      @click="openEvidence(artifact.artifact_id, lid)"
                    >
                      {{ lid }}
                    </button>
                  </div>
                </div>
              </div>
              <p v-if="genericRecords(artifact).length === 0" class="generic-empty">暂无记录</p>
            </div>

            <ol v-else-if="artifactShape(artifact) === 'sequence'" class="timeline-list generic-sequence">
              <li v-for="record in genericRecords(artifact)" :key="record.record_id" class="timeline-item">
                <span class="timeline-marker" aria-hidden="true"></span>
                <div class="artifact-record">
                  <dl v-if="fieldsFor(artifact, record.data).length" class="generic-fields">
                    <template v-for="field in fieldsFor(artifact, record.data)" :key="field.path">
                      <dt class="artifact-wrap">{{ field.label }}</dt>
                      <dd class="generic-field-value artifact-wrap">{{ field.value }}</dd>
                    </template>
                  </dl>
                  <p v-else class="generic-empty">暂无可展示字段</p>
                  <div class="evidence-links" aria-label="正文依据">
                    <button
                      v-for="lid in record.evidence_lids"
                      :key="lid"
                      type="button"
                      :data-lid="lid"
                      @click="openEvidence(artifact.artifact_id, lid)"
                    >
                      {{ lid }}
                    </button>
                  </div>
                </div>
              </li>
              <li v-if="genericRecords(artifact).length === 0" class="generic-empty">暂无记录</li>
            </ol>

            <div v-else class="generic-document">
              <article
                v-for="(record, recordIndex) in genericRecords(artifact)"
                :key="record.record_id"
                class="generic-document-section"
              >
                <h5>章节 {{ String(recordIndex + 1).padStart(2, "0") }}</h5>
                <dl v-if="fieldsFor(artifact, record.data).length" class="generic-fields">
                  <template v-for="field in fieldsFor(artifact, record.data)" :key="field.path">
                    <dt class="artifact-wrap">{{ field.label }}</dt>
                    <dd class="generic-field-value artifact-wrap">{{ field.value }}</dd>
                  </template>
                </dl>
                <p v-else class="generic-empty">暂无可展示字段</p>
                <div class="evidence-links" aria-label="正文依据">
                  <button
                    v-for="lid in record.evidence_lids"
                    :key="lid"
                    type="button"
                    :data-lid="lid"
                    @click="openEvidence(artifact.artifact_id, lid)"
                  >
                    {{ lid }}
                  </button>
                </div>
              </article>
              <p v-if="genericRecords(artifact).length === 0" class="generic-empty">暂无记录</p>
            </div>
          </section>
        </template>
      </article>
    </div>
  </div>
</template>

<style scoped>
.intent-artifact-panel {
  min-width: 0;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 1rem;
  color: var(--ink);
}
.artifact-panel-head,
.artifact-section-head {
  min-width: 0;
  display: flex;
  align-items: center;
}
.artifact-panel-head {
  justify-content: space-between;
  gap: 0.75rem;
  padding-bottom: 0.85rem;
}
.artifact-kicker {
  margin: 0 0 0.15rem;
  color: var(--steel);
  font-size: 0.72rem;
  font-weight: 650;
}
.artifact-panel-head h3 {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0;
}
.artifact-refresh {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--canvas);
  color: var(--ink);
}
.artifact-refresh:disabled {
  color: var(--muted);
}
.spinning {
  animation: artifact-spin 900ms linear infinite;
}
.artifact-state {
  margin: 0;
  border-top: 1px solid var(--hairline-soft);
  padding: 1rem 0;
  color: var(--muted);
  font-size: 0.84rem;
}
.artifact-error {
  color: var(--danger, #9d2c23);
}
.artifact-list {
  min-width: 0;
  border-top: 1px solid var(--hairline-soft);
}
.artifact-section {
  min-width: 0;
  padding: 1rem 0 1.15rem;
  border-bottom: 1px solid var(--hairline-soft);
}
.artifact-section-head {
  gap: 0.55rem;
  margin-bottom: 0.75rem;
}
.artifact-index {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.7rem;
}
.artifact-section-head h4 {
  min-width: 0;
  flex: 1;
  margin: 0;
  font-size: 0.88rem;
  letter-spacing: 0;
}
.artifact-pending,
.artifact-ready {
  flex: 0 0 auto;
  font-size: 0.7rem;
  font-weight: 650;
}
.artifact-pending {
  color: #8b5a14;
}
.artifact-ready {
  color: #26734d;
}
.artifact-wrap {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.artifact-label {
  margin: 0;
  color: var(--ink);
  font-size: 0.84rem;
  line-height: 1.45;
}
.timeline-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.timeline-item {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 0.55rem;
  padding-bottom: 0.85rem;
}
.timeline-item:not(:last-child)::before {
  content: "";
  position: absolute;
  top: 11px;
  bottom: -1px;
  left: 5px;
  width: 1px;
  background: var(--hairline);
}
.timeline-marker {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border: 2px solid #26734d;
  border-radius: 50%;
  background: var(--canvas);
  box-sizing: border-box;
  z-index: 1;
}
.artifact-record small {
  display: block;
  margin-bottom: 0.2rem;
  color: var(--steel);
  font-size: 0.7rem;
}
.evidence-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.4rem;
}
.evidence-links button {
  min-height: 28px;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  background: var(--canvas);
  padding: 0.2rem 0.45rem;
  color: #1f5f8b;
  font-family: var(--mono);
  font-size: 0.7rem;
}
.graph-node-list,
.claim-list,
.relation-list {
  display: grid;
  gap: 0;
}
.graph-node,
.claim-row,
.relation-row {
  min-width: 0;
  border-top: 1px solid var(--hairline-soft);
  padding: 0.65rem 0;
}
.graph-node:first-child,
.claim-row:first-child,
.relation-row:first-child {
  border-top: 0;
}
.relation-list {
  margin-top: 0.55rem;
  border-top: 1px solid var(--hairline);
}
.relation-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 0.4rem;
  align-items: start;
  color: var(--slate);
  font-size: 0.75rem;
  line-height: 1.4;
}
.relation-row strong {
  color: #8b4b38;
  font-size: 0.7rem;
}
.relation-row .evidence-links {
  grid-column: 1 / -1;
  margin-top: 0;
}
.claim-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.35rem 0.55rem;
}
.claim-role {
  color: #8b4b38;
  font-size: 0.7rem;
  font-weight: 650;
}
.claim-row .evidence-links {
  grid-column: 2;
  margin-top: 0;
}
.artifact-table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--hairline-soft);
}
.artifact-table-scroll table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}
.artifact-table-scroll th,
.artifact-table-scroll td {
  max-width: 14rem;
  padding: 0.5rem;
  border-right: 1px solid var(--hairline-soft);
  border-bottom: 1px solid var(--hairline-soft);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.artifact-table-scroll tr:last-child th,
.artifact-table-scroll tr:last-child td {
  border-bottom: 0;
}
.artifact-table-scroll th:last-child,
.artifact-table-scroll td:last-child {
  border-right: 0;
}
.artifact-table-scroll thead th {
  background: var(--canvas);
  color: var(--steel);
  font-weight: 650;
}
.table-evidence {
  min-width: 4rem;
  margin-top: 0;
}
.generic-artifact-shape,
.generic-collection,
.generic-card,
.generic-document,
.generic-document-section,
.generic-fields {
  min-width: 0;
}
.artifact-purpose,
.artifact-fallback-note,
.generic-empty {
  margin: 0 0 0.65rem;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.45;
}
.artifact-fallback-note {
  border-left: 2px solid #8b5a14;
  padding-left: 0.55rem;
  color: #8b5a14;
}
.generic-collection {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: 0.65rem;
}
.generic-card,
.generic-document-section {
  border: 1px solid var(--hairline-soft);
  border-radius: 6px;
  padding: 0.7rem;
  background: color-mix(in srgb, var(--canvas) 82%, transparent);
}
.generic-record-index {
  display: block;
  margin-bottom: 0.45rem;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.68rem;
}
.generic-fields {
  display: grid;
  grid-template-columns: minmax(4.5rem, auto) minmax(0, 1fr);
  gap: 0.35rem 0.6rem;
  margin: 0;
}
.generic-fields dt {
  color: var(--steel);
  font-size: 0.7rem;
  font-weight: 650;
}
.generic-fields dd {
  margin: 0;
  color: var(--ink);
  font-size: 0.78rem;
  line-height: 1.45;
}
.generic-field-value {
  max-width: 100%;
  white-space: pre-wrap;
}
.generic-empty {
  margin-bottom: 0;
  padding: 0.45rem 0;
}
.generic-table .generic-empty {
  padding: 0.7rem;
}
.generic-graph .generic-card {
  border-width: 1px;
  border-radius: 6px;
}
.generic-relation strong {
  max-width: 8rem;
}
.generic-sequence .generic-fields {
  margin-top: 0.05rem;
}
.generic-document {
  display: grid;
  gap: 0.7rem;
}
.generic-document-section h5 {
  margin: 0 0 0.55rem;
  color: var(--steel);
  font-size: 0.72rem;
  letter-spacing: 0;
}
@keyframes artifact-spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 640px) {
  .intent-artifact-panel {
    height: auto;
    min-height: 30rem;
    overflow: visible;
    padding: 0.85rem 0.75rem 1.25rem;
  }
  .relation-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .relation-row .evidence-links {
    grid-column: 1;
  }
  .generic-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.15rem;
  }
}
</style>
