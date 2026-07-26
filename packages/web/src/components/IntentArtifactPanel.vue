<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw } from "@lucide/vue";
import type {
  IntentArgumentMapPayloadV1,
  IntentArgumentRole,
  IntentArtifactOverlayV1,
  IntentComparisonTablePayloadV1,
  IntentConceptMapPayloadV1,
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

const artifactLabels = {
  timeline: "时间线",
  concept_map: "概念图",
  comparison_table: "对照表",
  argument_map: "论证图",
} as const;

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
          <h4>{{ artifactLabels[artifact.artifact_type] }}</h4>
          <span v-if="artifact.state === 'pending'" class="artifact-pending">准备中</span>
          <span v-else class="artifact-ready">已就绪</span>
        </header>

        <template v-if="artifact.state === 'accepted'">
          <ol v-if="artifact.artifact_type === 'timeline'" class="timeline-list">
            <li v-for="item in artifact.payload.items" :key="item.id" class="timeline-item">
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
              <div v-for="node in artifact.payload.nodes" :key="node.id" class="graph-node">
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
            <div v-if="artifact.payload.links.length" class="relation-list">
              <div v-for="(link, linkIndex) in artifact.payload.links" :key="`${link.source}:${link.target}:${linkIndex}`" class="relation-row">
                <span class="artifact-wrap">{{ conceptLabel(artifact.payload, link.source) }}</span>
                <strong class="artifact-wrap">{{ link.relation }}</strong>
                <span class="artifact-wrap">{{ conceptLabel(artifact.payload, link.target) }}</span>
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
                  <th v-for="dimension in comparisonDimensions(artifact.payload)" :key="dimension">{{ dimension }}</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in artifact.payload.rows" :key="`${row.subject}:${rowIndex}`">
                  <th>{{ row.subject }}</th>
                  <td v-for="dimension in comparisonDimensions(artifact.payload)" :key="dimension">
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

          <div v-else class="artifact-graph argument-graph">
            <div class="claim-list">
              <div v-for="claim in artifact.payload.claims" :key="claim.id" class="claim-row">
                <span class="claim-role">{{ argumentRoleLabels[claim.role] }}</span>
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
            <div v-if="artifact.payload.relations.length" class="relation-list">
              <div v-for="(relation, relationIndex) in artifact.payload.relations" :key="`${relation.source}:${relation.target}:${relationIndex}`" class="relation-row">
                <span class="artifact-wrap">{{ claimLabel(artifact.payload, relation.source) }}</span>
                <strong class="artifact-wrap">{{ relation.relation }}</strong>
                <span class="artifact-wrap">{{ claimLabel(artifact.payload, relation.target) }}</span>
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
        </template>
      </article>
    </div>
  </div>
</template>

<style scoped>
.intent-artifact-panel {
  min-width: 0;
  height: 100%;
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
}
</style>
