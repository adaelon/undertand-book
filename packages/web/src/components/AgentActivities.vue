<script setup lang="ts">
import { computed } from "vue";
import type { RunActivity } from "../agent-run-state";
const props = defineProps<{ activities: RunActivity[]; diagnostic?: boolean }>();
const labels = { running: "进行中", succeeded: "已完成", no_result: "无结果", rejected: "未执行", failed: "失败", cancelled: "已停止" };
const usage = computed(() => props.activities.filter(a => a.kind === "model").reduce((sum, a) => sum + (a.usage_total_tokens ?? 0), 0));
const missing = computed(() => props.activities.filter(a => a.kind === "model" && a.status !== "running" && a.usage_total_tokens === null).length);
</script>
<template>
  <ol class="agent-activities" aria-label="运行活动">
    <li v-for="activity in activities" :key="activity.step_id" class="agent-activity" :class="{ nested: activity.parent_step_id !== null }" :data-step-id="activity.step_id" :data-status="activity.status">
      <span class="activity-label">{{ activity.label }}</span>
      <span class="activity-status">{{ labels[activity.status] }}</span>
      <small v-if="activity.result_count !== null">{{ activity.result_count }} 项结果</small>
      <small v-if="activity.duration_ms !== null">{{ (activity.duration_ms / 1000).toFixed(1) }} 秒</small>
      <details v-if="diagnostic"><summary>详情</summary><code>{{ activity.name }}</code><span v-if="activity.error_code"> · {{ activity.error_code }}</span><span v-if="activity.parent_step_id !== null"> · 所属步骤 {{ activity.parent_step_id }}</span></details>
    </li>
  </ol>
  <small v-if="diagnostic && activities.length" class="activity-usage">已记录模型用量 {{ usage }} tokens<span v-if="missing"> · {{ missing }} 次请求未提供用量</span></small>
</template>
<style scoped>
.agent-activities { display: grid; gap: 6px; margin: 10px 0; padding: 0; list-style: none; }
.agent-activity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 8px; font-size: 12px; }
.nested { margin-left: 16px; border-left-width: 3px; }
.activity-label { flex: 1; }
.activity-status, small { color: var(--muted, #6b7280); }
[data-status="running"] .activity-status { color: var(--accent, #286da8); }
[data-status="failed"] .activity-status { color: #ad3a36; }
details { flex-basis: 100%; overflow-wrap: anywhere; }
</style>
