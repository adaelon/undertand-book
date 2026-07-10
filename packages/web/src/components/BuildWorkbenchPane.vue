<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import type {
  BuildDecisionRequest,
  BuildJobEvent,
  BuildJobState,
  BuildJobStatus,
  BuildReadinessStatus,
  BuildStageId,
  BuildStageStatus,
  BuildWorkbenchSnapshot,
  ExecutorId,
  ExecutorPermissionRequest,
  SidecarFormDraft,
  SourceReviewDecisionKind,
  SourceReviewLlmSuggestion,
  WorkbenchAdapterMode,
} from "../api";
import {
  getSourceReviewManualOverride,
  sourceReviewDecisionSetMatchesReport,
  type SourceReviewLlmBatchState,
} from "../source-review-batch";
import FileDropField from "./FileDropField.vue";
import SourceReviewWorkspace from "./SourceReviewWorkspace.vue";

const props = defineProps<{
  snapshot: BuildWorkbenchSnapshot | null;
  loading: boolean;
  error: string | null;
  confirming: boolean;
  importing: boolean;
  actioning: boolean;
  pdfUrl: string;
  sourceReviewLlmSuggestions?: Record<string, SourceReviewLlmSuggestion>;
  sourceReviewLlmAnalyzingBlockId?: string | null;
  sourceReviewLlmErrors?: Record<string, string>;
  sourceReviewLlmBatch?: SourceReviewLlmBatchState | null;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "import-input", payload: {
    target_dir?: string;
    book_id?: string;
    display_title?: string;
    paper_md_path?: string;
    paper_pdf_path?: string;
    paper_md_text?: string;
    paper_pdf_base64?: string;
  }): void;
  (e: "create-job"): void;
  (e: "start-job", payload: {
    job_id?: string;
    stage: BuildStageId;
    executor: ExecutorId;
    run_id?: string;
    adapter_mode?: WorkbenchAdapterMode;
  }): void;
  (e: "resume-job", jobId: string): void;
  (e: "resolve-decision", payload: { job_id: string; decision_id: string; answer: string }): void;
  (e: "resolve-permission", payload: { job_id: string; request_id: string; granted: boolean }): void;
  (e: "resolve-source-review", payload: {
    job_id?: string;
    block_id: string;
    decision: SourceReviewDecisionKind;
    replacement_text?: string;
    note?: string;
  }): void;
  (e: "analyze-source-review", payload: { block_id: string }): void;
  (e: "apply-all-source-review-with-llm"): void;
  (e: "draft-sidecar-plan", payload: { request: string }): void;
  (e: "confirm-sidecar-plan", fields: Record<string, unknown>): void;
}>();

const stageOrder: BuildStageId[] = [
  "source_reconciliation",
  "hybrid_foundation",
  "pass1",
  "paper_metadata",
  "paper_lexicon",
  "profile_sidecar",
  "pass2",
  "book_structure",
  "paper_reading_guide",
];
const executorOptions: ExecutorId[] = ["codex", "manual", "opencode", "claude"];
const adapterModeOptions: WorkbenchAdapterMode[] = ["builtin", "contract_only", "fake_success", "fake_failure", "fake_permission"];

const editableFields = reactive<Record<string, string>>({});
const importMode = ref<"upload" | "path">("upload");
const importError = ref<string | null>(null);
const importFields = reactive({
  target_dir: "",
  book_id: "",
  display_title: "",
  paper_md_path: "",
  paper_pdf_path: "",
});
const paperMdFile = ref<File | null>(null);
const paperPdfFile = ref<File | null>(null);
const selectedStage = ref<BuildStageId>("source_reconciliation");
const selectedExecutor = ref<ExecutorId>("codex");
const selectedAdapterMode = ref<WorkbenchAdapterMode>("builtin");
const runId = ref("");
const pollingEnabled = ref(false);
const sidecarRequest = ref("");
let pollingTimer: number | null = null;

const latestJob = computed<BuildJobState | null>(() => {
  return [...(props.snapshot?.jobs ?? [])].sort((left, right) => left.updated_at.localeCompare(right.updated_at)).at(-1) ?? null;
});
const currentGateJobs = computed(() => (
  (props.snapshot?.jobs ?? []).filter((job) => job.status !== "stale_input")
));
const pendingDecisionItems = computed<Array<{ job: BuildJobState; request: BuildDecisionRequest }>>(() =>
  currentGateJobs.value.flatMap((job) =>
    job.decision_requests
      .filter((request) => request.status === "pending")
      .map((request) => ({ job, request })),
  ),
);
const pendingPermissionItems = computed<Array<{ job: BuildJobState; request: ExecutorPermissionRequest }>>(() =>
  currentGateJobs.value.flatMap((job) =>
    job.permission_requests
      .filter((request) => request.status === "pending")
      .map((request) => ({ job, request })),
  ),
);
const recentEvents = computed<BuildJobEvent[]>(() =>
  (props.snapshot?.jobs ?? [])
    .flatMap((job) => job.events)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-8)
    .reverse(),
);
const sidecarForm = computed<SidecarFormDraft | null>(() =>
  props.snapshot?.sidecar_plan.form_draft ?? props.snapshot?.sidecar_plan.plan?.form_draft ?? null,
);
const sidecarPlanStatus = computed(() => props.snapshot?.sidecar_plan.plan?.status ?? "missing");
const currentInputManifest = computed(() => props.snapshot?.input.manifest ?? null);
const sourceReview = computed(() => props.snapshot?.source_review ?? null);
const sourceReviewStale = computed(() => props.snapshot?.readiness.stages.source_reconciliation?.status === "stale");
const operationalWarnings = computed(() => props.snapshot?.operations.warnings ?? []);
const recentPermissionAudit = computed(() => [...(props.snapshot?.operations.permission_audit ?? [])].slice(-10).reverse());
const sourceReviewBlocks = computed(() => sourceReview.value?.unresolved ?? []);
const activeRun = computed(() => latestJob.value?.active_run ?? null);
const sourceReviewDecisionSetCurrent = computed(() => (
  props.snapshot ? sourceReviewDecisionSetMatchesReport(props.snapshot) : true
));
const sourceReviewManualOverride = computed(() => (
  props.snapshot ? getSourceReviewManualOverride(props.snapshot) : null
));
const sourceReviewVisible = computed(() => (
  !sourceReviewManualOverride.value
  && (
    sourceReviewStale.value
    || !!(sourceReview.value
      && (sourceReviewBlocks.value.length || sourceReview.value.review_draft_markdown || sourceReview.value.decisions)
      && props.snapshot?.readiness.stages.source_reconciliation?.status !== "done")
  )
));
const sourceReviewRerunning = computed(() => (
  sourceReview.value?.ready_for_rerun === true
  && latestJob.value?.status === "running"
  && activeRun.value?.stage === "source_reconciliation"
));
const hasPendingUserGate = computed(() => pendingDecisionItems.value.length > 0 || pendingPermissionItems.value.length > 0);
const selectedModeSupported = computed(() => selectedAdapterMode.value !== "builtin" || selectedStage.value !== "pass1");
const canStartJob = computed(() =>
  !!props.snapshot?.input.ready
  && !props.actioning
  && !hasPendingUserGate.value
  && selectedModeSupported.value
  && latestJob.value?.status !== "running",
);
const canResumeJob = computed(() => !!latestJob.value?.active_run && !props.actioning && !hasPendingUserGate.value);
const selectedStageReadiness = computed(() => props.snapshot?.readiness.stages[selectedStage.value] ?? null);
let foundationAutoSelectedForBook: string | null = null;

watch(
  () => [
    props.snapshot?.book_id,
    props.snapshot?.readiness.stages.source_reconciliation?.status,
    props.snapshot?.readiness.stages.hybrid_foundation?.status,
  ] as const,
  ([bookId, sourceStatus, foundationStatus]) => {
    if (
      !bookId
      || foundationAutoSelectedForBook === bookId
      || sourceStatus !== "done"
      || foundationStatus !== "missing"
    ) return;
    foundationAutoSelectedForBook = bookId;
    if (selectedStage.value === "source_reconciliation") selectedStage.value = "hybrid_foundation";
  },
  { immediate: true },
);

const stageLabels: Record<BuildStageId, string> = {
  source_reconciliation: "来源对齐",
  hybrid_foundation: "混合阅读基座",
  pass1: "Pass1 局部抽取",
  paper_metadata: "论文元数据",
  paper_lexicon: "论文术语表",
  profile_sidecar: "Profile 辅助产物",
  pass2: "Pass2 长程关联",
  book_structure: "书结构",
  paper_reading_guide: "论文阅读指南",
};
const executorLabels: Record<ExecutorId, string> = {
  codex: "Codex",
  opencode: "opencode",
  claude: "Claude",
  manual: "手动",
};
const adapterModeLabels: Record<WorkbenchAdapterMode, string> = {
  builtin: "运行内置阶段",
  contract_only: "只写执行契约",
  fake_success: "模拟完成",
  fake_failure: "模拟失败",
  fake_permission: "模拟权限请求",
};
const readinessStatusLabels: Record<BuildReadinessStatus, string> = {
  trusted_book: "可进入阅读",
  missing: "缺少基座",
  incomplete: "基座不完整",
  needs_review: "需要复核",
  stale_input: "输入已过期",
};
const stageStatusLabels: Record<BuildStageStatus, string> = {
  blocked: "等待上游",
  missing: "缺失",
  done: "完成",
  needs_review: "待复核",
  stale: "已过期",
  incomplete: "不完整",
};
const jobStatusLabels: Record<BuildJobStatus, string> = {
  ready: "就绪",
  running: "运行中",
  needs_user: "等待用户",
  failed: "失败",
  done: "完成",
  stale_input: "输入已过期",
  interrupted: "运行已中断",
};
const eventTypeLabels: Record<BuildJobEvent["type"], string> = {
  job_created: "创建构建任务",
  job_reused: "复用构建任务",
  job_marked_stale: "标记输入过期",
  job_resumed: "恢复构建任务",
  job_event_appended: "记录构建事件",
  executor_started: "执行器已启动",
  stage_runner_spawned: "阶段运行器已启动",
  stage_started: "阶段开始",
  stage_completed: "阶段完成",
  stage_blocked: "阶段等待复核",
  stage_failed: "阶段失败",
  readiness_recomputed: "已重算阅读门禁",
  run_interrupted: "检测到运行中断",
  job_recovered: "已恢复构建任务",
  executor_contract_written: "执行契约已写入",
  executor_completed: "执行器已完成",
  executor_failed: "执行器失败",
  source_review_decision_recorded: "来源复核决策已记录",
  decision_requested: "请求构建决策",
  decision_resolved: "构建决策已处理",
  permission_requested: "请求执行权限",
  permission_resolved: "执行权限已处理",
};
const decisionKindLabels: Record<BuildDecisionRequest["kind"], string> = {
  source_reconciliation_mode: "来源对齐方式",
  hybrid_source_strategy: "混合来源策略",
  alignment_repair_strategy: "对齐修复策略",
  executor_selection: "执行器选择",
  review_acceptance: "复核采纳",
  artifact_conflict_resolution: "产物冲突处理",
  continue_or_restart: "继续或重启",
  sidecar_plan: "辅助产物计划",
};
const permissionCategoryLabels: Record<ExecutorPermissionRequest["category"], string> = {
  sandbox_escalation: "沙箱提权",
  network: "网络访问",
  filesystem: "文件系统",
  mcp_tool: "MCP 工具",
  skill_script: "Skill 脚本",
  shell_command: "Shell 命令",
  destructive_action: "破坏性操作",
  other: "其他",
};
const permissionScopeLabels: Record<ExecutorPermissionRequest["scope_hint"], string> = {
  once: "单次",
  stage: "当前阶段",
  job: "当前任务",
  profile: "当前 profile",
};
const sidecarStatusLabels: Record<string, string> = {
  draft: "待确认",
  confirmed: "已确认",
  rejected: "已拒绝",
  missing: "暂无计划",
};
const sidecarFieldLabels: Record<string, string> = {
  target_view: "目标视图",
  source_scope: "来源范围",
  sidecar_id: "辅助产物 ID",
  schema: "输出 schema",
  visualization: "可视化形式",
  required_evidence: "证据要求",
};
const knownReasonLabels: Record<string, string> = {
  "source reconciliation report is missing": "缺少来源对齐报告。",
  "source reconciliation has unresolved blocks": "来源对齐仍有未解决片段。",
  "trusted source.txt is missing": "缺少可信正文 source.txt。",
  "base.json is missing": "缺少阅读基座 base.json。",
  "source_manifest.json is missing": "缺少 source_manifest.json。",
  "upstream stage is not trusted yet": "上游阶段尚未可信，暂不能运行。",
  "derived paper projection stage artifact is missing": "缺少派生的论文投影阶段产物。",
  "alignment_report config hash does not match source_manifest capabilities": "alignment_report 的配置哈希与 source_manifest capabilities 不一致。",
  "source reconciliation needs review": "来源对齐需要人工复核。",
  "build input or artifacts are stale": "构建输入或产物已过期。",
  "trusted source foundation is missing": "缺少可信正文基座。",
  "trusted source foundation is incomplete": "可信正文基座不完整。",
  "trusted source foundation is not ready": "可信正文基座尚未就绪。",
};
const capabilityLabels: Record<string, string> = {
  project_lid_to_pdf: "LID 到 PDF 投影",
  project_ranges_to_pdf: "范围到 PDF 投影",
  resolve_pdf_selection: "PDF 选区解析",
};

watch(
  sidecarForm,
  (form) => {
    for (const key of Object.keys(editableFields)) delete editableFields[key];
    for (const field of form?.fields ?? []) {
      editableFields[field.id] = fieldValueText(field.value);
    }
  },
  { immediate: true },
);

function stageLabel(stage: string): string {
  return stageLabels[stage as BuildStageId] ?? stage.replaceAll("_", " ");
}

function readinessStatusLabel(status: BuildReadinessStatus): string {
  return readinessStatusLabels[status] ?? status;
}

function stageStatusLabel(status: BuildStageStatus): string {
  return stageStatusLabels[status] ?? status;
}

function jobStatusLabel(status: BuildJobStatus): string {
  return jobStatusLabels[status] ?? status;
}

function executorLabel(executor: ExecutorId): string {
  return executorLabels[executor] ?? executor;
}

function adapterModeLabel(mode: WorkbenchAdapterMode): string {
  return adapterModeLabels[mode] ?? mode;
}

function sidecarPlanStatusLabel(status: string): string {
  return sidecarStatusLabels[status] ?? status;
}

function sidecarFieldLabel(field: { id: string; label: string }): string {
  return sidecarFieldLabels[field.id] ?? field.label;
}

function capabilityLabel(name: string): string {
  return capabilityLabels[name] ?? name;
}

function reasonText(reason: string): string {
  if (
    sourceReview.value?.ready_for_rerun
    && (reason === "source reconciliation has unresolved blocks" || reason === "source reconciliation needs review")
  ) {
    return sourceReviewRerunning.value
      ? "来源复核已完成，正在重新运行来源对齐。"
      : "来源复核已完成，系统将自动重新运行来源对齐。";
  }
  if (knownReasonLabels[reason]) return knownReasonLabels[reason];
  const missingArtifact = /^(.+) declares an artifact that is missing$/.exec(reason);
  if (missingArtifact) return `${capabilityLabel(missingArtifact[1])} 声明了产物，但文件缺失。`;
  const staleArtifact = /^(.+) config hash does not match its artifact$/.exec(reason);
  if (staleArtifact) return `${capabilityLabel(staleArtifact[1])} 的配置哈希与产物不一致。`;
  const degraded = /^(.+) is degraded without an explicit reason$/.exec(reason);
  if (degraded) return `${capabilityLabel(degraded[1])} 降级可用，但缺少明确原因。`;
  return reason;
}

function fieldValueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "", null, 2);
}

function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "true" || trimmed === "false" || trimmed === "null") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取 Markdown 文件失败"));
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      resolve(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取 PDF 文件失败"));
    reader.readAsDataURL(file);
  });
}

async function importWorkbenchInput() {
  importError.value = null;
  const payload: {
    target_dir?: string;
    book_id?: string;
    display_title?: string;
    paper_md_path?: string;
    paper_pdf_path?: string;
    paper_md_text?: string;
    paper_pdf_base64?: string;
  } = {
    target_dir: optionalText(importFields.target_dir),
    book_id: optionalText(importFields.book_id),
    display_title: optionalText(importFields.display_title),
  };
  try {
    if (importMode.value === "path") {
      const mdPath = optionalText(importFields.paper_md_path);
      const pdfPath = optionalText(importFields.paper_pdf_path);
      if (!mdPath || !pdfPath) {
        importError.value = "请填写 paper.md 和 paper.pdf 的服务器本机路径。";
        return;
      }
      payload.paper_md_path = mdPath;
      payload.paper_pdf_path = pdfPath;
    } else {
      if (!paperMdFile.value || !paperPdfFile.value) {
        importError.value = "请选择 paper.md 和 paper.pdf 文件。";
        return;
      }
      payload.paper_md_text = await readFileAsText(paperMdFile.value);
      payload.paper_pdf_base64 = await readFileAsBase64(paperPdfFile.value);
      payload.display_title ??= paperMdFile.value.name.replace(/\.md$/i, "");
    }
    emit("import-input", payload);
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error);
  }
}

function createBuildJob() {
  emit("create-job");
}

function startSelectedJob() {
  emit("start-job", {
    job_id: latestJob.value?.job_id,
    stage: selectedStage.value,
    executor: selectedExecutor.value,
    run_id: optionalText(runId.value),
    adapter_mode: selectedAdapterMode.value,
  });
}

function resumeLatestJob() {
  if (latestJob.value) emit("resume-job", latestJob.value.job_id);
}

function resolveDecision(item: { job: BuildJobState; request: BuildDecisionRequest }, answer: string) {
  emit("resolve-decision", {
    job_id: item.job.job_id,
    decision_id: item.request.decision_id,
    answer,
  });
}

function resolvePermission(item: { job: BuildJobState; request: ExecutorPermissionRequest }, granted: boolean) {
  emit("resolve-permission", {
    job_id: item.job.job_id,
    request_id: item.request.request_id,
    granted,
  });
}

function telemetryText(value: string | number | undefined, fallback = "暂无"): string {
  if (value === undefined || value === "") return fallback;
  return String(value);
}

function clearPollingTimer() {
  if (pollingTimer !== null) {
    window.clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

watch(pollingEnabled, (enabled) => {
  clearPollingTimer();
  if (enabled) {
    pollingTimer = window.setInterval(() => {
      if (!props.loading && !props.actioning) emit("refresh");
    }, 4000);
  }
});

watch(
  () => latestJob.value?.status,
  (status) => {
    if (status === "running") pollingEnabled.value = true;
    else if (status && status !== "needs_user") pollingEnabled.value = false;
  },
  { immediate: true },
);

onBeforeUnmount(clearPollingTimer);

function confirmSidecarPlan() {
  const fields: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(editableFields)) fields[id] = parseFieldValue(raw);
  emit("confirm-sidecar-plan", fields);
}

function draftSidecarPlan() {
  const request = optionalText(sidecarRequest.value);
  if (request) emit("draft-sidecar-plan", { request });
}
</script>

<template>
  <main class="workbench-pane">
    <header class="workbench-head">
      <div>
        <p class="workbench-kicker">构建工作台</p>
        <h1>{{ props.snapshot?.book_id ?? "当前书" }}</h1>
      </div>
      <div class="workbench-actions">
        <span v-if="props.snapshot" class="workbench-status" :data-status="props.snapshot.readiness.status">
          {{ readinessStatusLabel(props.snapshot.readiness.status) }}
        </span>
        <label class="poll-toggle">
          <input v-model="pollingEnabled" type="checkbox" />
          自动轮询
        </label>
        <button :disabled="props.loading || props.actioning" @click="emit('refresh')">{{ props.loading ? "刷新中" : "刷新" }}</button>
      </div>
    </header>

    <p v-if="props.error" class="workbench-error">{{ props.error }}</p>
    <p v-else-if="props.loading && !props.snapshot" class="workbench-empty">正在加载构建状态...</p>

    <template v-if="props.snapshot">
      <SourceReviewWorkspace
        v-if="sourceReviewVisible"
        :blocks="sourceReviewBlocks"
        :decisions="sourceReview?.decisions?.decisions ?? []"
        :pdf-url="props.pdfUrl"
        :job-id="latestJob?.job_id"
        :actioning="props.actioning"
        :stale="sourceReviewStale"
        :ready-for-rerun="sourceReview?.ready_for_rerun ?? false"
        :review-draft="sourceReview?.review_draft_markdown"
        :llm-suggestions="props.sourceReviewLlmSuggestions"
        :llm-analyzing-block-id="props.sourceReviewLlmAnalyzingBlockId"
        :llm-errors="props.sourceReviewLlmErrors"
        :llm-batch-state="props.sourceReviewLlmBatch"
        :decision-set-current="sourceReviewDecisionSetCurrent"
        :rerunning="sourceReviewRerunning"
        @resolve="emit('resolve-source-review', $event)"
        @analyze="emit('analyze-source-review', $event)"
        @analyze-all="emit('apply-all-source-review-with-llm')"
      />

      <section v-if="sourceReviewManualOverride" class="workbench-section source-review-override">
        <div>
          <h2>已采用人工终裁正文</h2>
          <p>
            一次来源验证仍有 {{ sourceReviewManualOverride.residual_unresolved_count }} 个残余差异；
            系统已保留诊断报告，并按已记录的复核决定继续后续构建。
          </p>
        </div>
        <small v-if="sourceReviewManualOverride.accepted_at">终裁时间 {{ sourceReviewManualOverride.accepted_at }}</small>
      </section>

      <section class="workbench-section input-section">
        <div class="section-headline">
          <h2>论文输入</h2>
          <p v-if="currentInputManifest" class="workbench-meta">
            {{ currentInputManifest.display_title }} · {{ currentInputManifest.inputs.paper_md.size_bytes }}B MD ·
            {{ currentInputManifest.inputs.paper_pdf.size_bytes }}B PDF
          </p>
          <p v-else class="workbench-meta">尚未导入 paper.md + paper.pdf</p>
        </div>
        <div v-if="props.snapshot.input.fingerprint" class="fingerprint-grid">
          <code>MD {{ props.snapshot.input.fingerprint.paper_md_sha256.slice(0, 12) }}</code>
          <code>PDF {{ props.snapshot.input.fingerprint.paper_pdf_sha256.slice(0, 12) }}</code>
          <code>配置 {{ props.snapshot.input.fingerprint.config_hash.slice(0, 12) }}</code>
        </div>
        <div class="import-mode">
          <label><input v-model="importMode" type="radio" value="upload" /> 上传文件</label>
          <label><input v-model="importMode" type="radio" value="path" /> 服务器路径</label>
        </div>
        <div class="input-grid">
          <label>
            <span>草稿工作区</span>
            <input v-model="importFields.target_dir" placeholder="留空则使用当前工作区" />
          </label>
          <label>
            <span>书籍 ID</span>
            <input v-model="importFields.book_id" placeholder="留空自动沿用目录名" />
          </label>
          <label>
            <span>显示标题</span>
            <input v-model="importFields.display_title" placeholder="留空自动生成" />
          </label>
        </div>
        <div v-if="importMode === 'upload'" class="file-input-grid">
          <FileDropField
            v-model="paperMdFile"
            label="paper.md"
            accept=".md,text/markdown,text/plain"
            accept-label=".md"
            kind="markdown"
            :disabled="props.importing"
          />
          <FileDropField
            v-model="paperPdfFile"
            label="paper.pdf"
            accept="application/pdf,.pdf"
            accept-label=".pdf"
            kind="pdf"
            :disabled="props.importing"
          />
        </div>
        <div v-else class="input-grid">
          <label>
            <span>paper.md 路径</span>
            <input v-model="importFields.paper_md_path" placeholder="E:\\papers\\paper.md" />
          </label>
          <label>
            <span>paper.pdf 路径</span>
            <input v-model="importFields.paper_pdf_path" placeholder="E:\\papers\\paper.pdf" />
          </label>
        </div>
        <p v-if="importError" class="workbench-error">{{ importError }}</p>
        <button class="primary-action" :disabled="props.importing" @click="importWorkbenchInput">
          {{ props.importing ? "导入中" : "导入输入" }}
        </button>
      </section>

      <section class="workbench-section">
        <div class="section-headline">
          <h2>运行控制</h2>
          <p v-if="latestJob" class="workbench-meta">{{ latestJob.job_id }} · {{ jobStatusLabel(latestJob.status) }}</p>
          <p v-else class="workbench-meta">尚未创建构建任务</p>
        </div>
        <div class="run-control-grid">
          <label>
            <span>阶段</span>
            <select v-model="selectedStage">
              <option v-for="stage in stageOrder" :key="stage" :value="stage">{{ stageLabel(stage) }}</option>
            </select>
          </label>
          <label>
            <span>执行器</span>
            <select v-model="selectedExecutor">
              <option v-for="executor in executorOptions" :key="executor" :value="executor">
                {{ executorLabel(executor) }}
              </option>
            </select>
          </label>
          <label>
            <span>执行模式</span>
            <select v-model="selectedAdapterMode">
              <option v-for="mode in adapterModeOptions" :key="mode" :value="mode">
                {{ adapterModeLabel(mode) }}
              </option>
            </select>
          </label>
          <label>
            <span>运行 ID</span>
            <input v-model="runId" placeholder="留空自动生成" />
          </label>
        </div>
        <p v-if="selectedStageReadiness?.reason" class="workbench-meta">
          当前阶段: {{ stageStatusLabel(selectedStageReadiness.status) }} · {{ reasonText(selectedStageReadiness.reason) }}
        </p>
        <p v-if="hasPendingUserGate" class="workbench-meta">
          当前任务正在等待下方的构建决策或执行权限处理。
        </p>
        <p v-if="!selectedModeSupported" class="workbench-meta">
          Pass1 需要 executor 先生成逐窗抽取产物，请选择“只写执行契约”交给执行器。
        </p>
        <div class="action-row">
          <button :disabled="props.actioning || !props.snapshot.input.ready" @click="createBuildJob">
            创建/复用任务
          </button>
          <button class="primary-action" :disabled="!canStartJob" @click="startSelectedJob">
            {{ props.actioning ? "处理中" : "启动所选阶段" }}
          </button>
          <button :disabled="!canResumeJob" @click="resumeLatestJob">
            恢复活动任务
          </button>
        </div>
        <p v-if="latestJob?.failure_summary" class="workbench-error">
          {{ latestJob.failure_summary.message }}
          <template v-if="latestJob.failure_summary.recoverable">可使用“恢复活动任务”重新执行当前阶段。</template>
        </p>
        <div v-if="latestJob?.failure_summary?.stdout_path || latestJob?.failure_summary?.stderr_path" class="failure-paths">
          <code v-if="latestJob.failure_summary.stdout_path">stdout {{ latestJob.failure_summary.stdout_path }}</code>
          <code v-if="latestJob.failure_summary.stderr_path">stderr {{ latestJob.failure_summary.stderr_path }}</code>
        </div>
      </section>

      <section v-if="activeRun" class="workbench-section">
        <h2>活动执行器</h2>
        <dl class="telemetry-grid">
          <div>
            <dt>运行 ID</dt>
            <dd>{{ activeRun.run_id }}</dd>
          </div>
          <div>
            <dt>阶段</dt>
            <dd>{{ stageLabel(activeRun.stage) }}</dd>
          </div>
          <div>
            <dt>执行器</dt>
            <dd>{{ executorLabel(activeRun.executor) }}</dd>
          </div>
          <div>
            <dt>进程 ID</dt>
            <dd>{{ telemetryText(activeRun.telemetry?.pid) }}</dd>
          </div>
          <div>
            <dt>启动时间</dt>
            <dd>{{ telemetryText(activeRun.telemetry?.started_at) }}</dd>
          </div>
          <div>
            <dt>心跳</dt>
            <dd>{{ telemetryText(activeRun.telemetry?.last_heartbeat_at) }}</dd>
          </div>
          <div>
            <dt>令牌用量</dt>
            <dd>{{ telemetryText(activeRun.telemetry?.tokens_used) }}</dd>
          </div>
          <div>
            <dt>成本</dt>
            <dd>{{ telemetryText(activeRun.telemetry?.cost_usd) }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="props.snapshot.readiness.reasons.length" class="workbench-section">
        <h2>构建就绪状态</h2>
        <ul class="workbench-reasons">
          <li v-for="reason in props.snapshot.readiness.reasons" :key="reason">{{ reasonText(reason) }}</li>
        </ul>
      </section>

      <section v-if="operationalWarnings.length" class="workbench-section">
        <h2>运行警告</h2>
        <ul class="workbench-reasons">
          <li v-for="warning in operationalWarnings" :key="`${warning.code}:${warning.job_id ?? ''}`">
            {{ warning.message }}
          </li>
        </ul>
      </section>

      <section class="workbench-section">
        <h2>阶段流程</h2>
        <ol class="stage-dag">
          <li
            v-for="stage in stageOrder"
            :key="stage"
            :data-status="props.snapshot.readiness.stages[stage]?.status ?? 'blocked'"
          >
            <span>{{ stageLabel(stage) }}</span>
            <strong>{{ stageStatusLabel(props.snapshot.readiness.stages[stage]?.status ?? "blocked") }}</strong>
            <small v-if="props.snapshot.readiness.stages[stage]?.reason">
              {{ reasonText(props.snapshot.readiness.stages[stage]?.reason ?? "") }}
            </small>
          </li>
        </ol>
      </section>

      <section class="workbench-flows">
        <div class="workbench-section">
          <h2>待处理构建决策</h2>
          <ul v-if="pendingDecisionItems.length" class="request-list">
            <li v-for="item in pendingDecisionItems" :key="item.request.decision_id">
              <strong>{{ decisionKindLabels[item.request.kind] ?? item.request.kind }}</strong>
              <p>{{ item.request.prompt }}</p>
              <div v-if="item.request.options.length" class="request-options">
                <button
                  v-for="option in item.request.options"
                  :key="option.id"
                  :disabled="props.actioning"
                  @click="resolveDecision(item, option.id)"
                >
                  {{ option.label }}
                </button>
              </div>
              <p v-else class="workbench-empty">这个决策暂未提供可选答案。</p>
            </li>
          </ul>
          <p v-else class="workbench-empty">暂无待处理构建决策。</p>
        </div>

        <div class="workbench-section">
          <h2>待授权执行权限</h2>
          <ul v-if="pendingPermissionItems.length" class="request-list">
            <li v-for="item in pendingPermissionItems" :key="item.request.request_id">
              <strong>{{ executorLabel(item.request.executor) }} · {{ permissionCategoryLabels[item.request.category] ?? item.request.category }}</strong>
              <p>{{ item.request.action_summary }}</p>
              <small>授权范围: {{ permissionScopeLabels[item.request.scope_hint] ?? item.request.scope_hint }}</small>
              <div class="action-row compact">
                <button :disabled="props.actioning" @click="resolvePermission(item, true)">批准</button>
                <button :disabled="props.actioning" @click="resolvePermission(item, false)">拒绝</button>
              </div>
            </li>
          </ul>
          <p v-else class="workbench-empty">暂无待授权执行权限。</p>
        </div>
      </section>

      <section class="workbench-section">
        <h2>辅助产物计划</h2>
        <p class="workbench-meta">状态 {{ sidecarPlanStatusLabel(sidecarPlanStatus) }}</p>
        <div class="sidecar-request">
          <textarea
            v-model="sidecarRequest"
            rows="2"
            placeholder="描述需要的时间线、概念图、比较表或论证图"
          ></textarea>
          <button :disabled="props.actioning || !sidecarRequest.trim()" @click="draftSidecarPlan">
            生成计划草稿
          </button>
        </div>
        <div v-if="sidecarForm" class="sidecar-form">
          <label v-for="field in sidecarForm.fields" :key="field.id">
            <span>{{ sidecarFieldLabel(field) }}</span>
            <textarea
              v-if="field.editable"
              v-model="editableFields[field.id]"
              rows="3"
              spellcheck="false"
            ></textarea>
            <code v-else>{{ fieldValueText(field.value) }}</code>
          </label>
          <button :disabled="props.confirming || sidecarPlanStatus === 'confirmed'" @click="confirmSidecarPlan">
            {{ props.confirming ? "确认中" : "确认计划" }}
          </button>
        </div>
        <p v-else class="workbench-empty">暂无辅助产物计划草稿。</p>
      </section>

      <section class="workbench-section">
        <h2>构建事件</h2>
        <p v-if="latestJob" class="workbench-meta">{{ latestJob.job_id }} · {{ jobStatusLabel(latestJob.status) }}</p>
        <ol v-if="recentEvents.length" class="event-list">
          <li v-for="event in recentEvents" :key="`${event.job_id}:${event.event_id}`">
            <span>{{ eventTypeLabels[event.type] ?? event.type }}</span>
            <strong v-if="event.stage">{{ stageLabel(event.stage) }}</strong>
            <small>{{ event.created_at }}</small>
            <p v-if="event.message">{{ reasonText(event.message) }}</p>
          </li>
        </ol>
        <p v-else class="workbench-empty">暂无构建事件。</p>
      </section>

      <section class="workbench-section">
        <h2>权限审计</h2>
        <ol v-if="recentPermissionAudit.length" class="event-list">
          <li v-for="entry in recentPermissionAudit" :key="entry.audit_id">
            <span>{{ entry.granted ? "已批准" : "已拒绝" }}</span>
            <strong>{{ entry.executor ? executorLabel(entry.executor) : "执行器" }}</strong>
            <small>{{ entry.resolved_at }}</small>
            <p>{{ entry.action_summary ?? entry.request_id }}</p>
          </li>
        </ol>
        <p v-else class="workbench-empty">暂无权限审计记录。</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.workbench-pane {
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem;
  background: var(--reader-canvas);
  border-left: 1px solid var(--hairline-soft);
  border-right: 1px solid var(--hairline-soft);
}
.workbench-head,
.workbench-actions,
.workbench-flows {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.workbench-head {
  margin-bottom: 1rem;
}
.workbench-kicker,
.workbench-meta {
  margin: 0 0 0.25rem;
  color: var(--steel);
  font-size: 0.75rem;
  text-transform: uppercase;
}
.workbench-head h1,
.workbench-section h2 {
  margin: 0;
  color: var(--ink);
  letter-spacing: 0;
}
.workbench-head h1 {
  font-size: 1.25rem;
}
.workbench-section h2 {
  margin-bottom: 0.65rem;
  font-size: 0.92rem;
}
.workbench-actions {
  align-items: center;
}
.workbench-actions button,
.action-row button,
.sidecar-form button,
.primary-action {
  min-height: 38px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0 0.75rem;
}
.failure-paths {
  display: grid;
  gap: 0.3rem;
  margin-top: 0.5rem;
}
.failure-paths code {
  overflow-wrap: anywhere;
  color: var(--steel);
  font-size: 0.72rem;
}
.poll-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--slate);
  font-size: 0.78rem;
  white-space: nowrap;
}
.workbench-status {
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--slate);
  padding: 0.28rem 0.65rem;
  font-size: 0.76rem;
}
.workbench-status[data-status="needs_review"],
.stage-dag li[data-status="needs_review"] strong {
  color: #8a4a12;
}
.workbench-status[data-status="stale_input"],
.stage-dag li[data-status="stale"] strong {
  color: #9f2f2f;
}
.workbench-section {
  margin-bottom: 1rem;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: rgba(255, 253, 248, 0.78);
  padding: 0.9rem;
}
.source-review-override {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-color: #c9dcd7;
  background: #f3faf8;
}
.source-review-override h2 {
  margin-bottom: 0.25rem;
}
.source-review-override p {
  margin: 0;
  color: var(--slate);
  font-size: 0.8rem;
  line-height: 1.5;
}
.source-review-override small {
  flex: 0 0 auto;
  color: var(--steel);
  font-size: 0.68rem;
}
.workbench-flows .workbench-section {
  flex: 1 1 0;
}
.section-headline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}
.input-section {
  display: grid;
  gap: 0.7rem;
}
.fingerprint-grid,
.input-grid,
.import-mode,
.run-control-grid,
.telemetry-grid {
  display: grid;
  gap: 0.55rem;
}
.fingerprint-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.fingerprint-grid code {
  overflow: hidden;
  border: 1px solid var(--hairline-soft);
  border-radius: 7px;
  background: var(--surface-code);
  color: var(--slate);
  padding: 0.45rem 0.55rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.input-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.file-input-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.input-grid label,
.import-mode label,
.run-control-grid label {
  display: grid;
  gap: 0.3rem;
  color: var(--slate);
  font-size: 0.78rem;
  font-weight: 650;
}
.import-mode {
  grid-template-columns: repeat(2, max-content);
}
.import-mode label {
  display: flex;
  align-items: center;
  font-weight: 500;
}
.input-grid input,
.run-control-grid input,
.run-control-grid select {
  min-width: 0;
  min-height: 36px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0 0.55rem;
}
.run-control-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 0.65rem;
}
.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.65rem;
}
.action-row.compact {
  margin-top: 0.5rem;
}
.telemetry-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
}
.telemetry-grid div {
  min-width: 0;
  border: 1px solid var(--hairline-soft);
  border-radius: 7px;
  background: #fff;
  padding: 0.52rem 0.6rem;
}
.telemetry-grid dt {
  color: var(--steel);
  font-size: 0.7rem;
}
.telemetry-grid dd {
  overflow: hidden;
  margin: 0.18rem 0 0;
  color: var(--ink);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.primary-action {
  justify-self: start;
  background: var(--ink);
  color: #fff;
}
.workbench-error,
.workbench-empty,
.workbench-reasons {
  margin: 0;
  color: var(--steel);
  font-size: 0.86rem;
}
.workbench-error {
  color: var(--brand-error);
}
.workbench-reasons {
  padding-left: 1.2rem;
}
.stage-dag,
.event-list,
.request-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.stage-dag {
  display: grid;
  gap: 0.45rem;
}
.stage-dag li,
.request-list li,
.event-list li {
  border: 1px solid var(--hairline-soft);
  border-radius: 7px;
  background: #fff;
  padding: 0.62rem 0.7rem;
}
.stage-dag li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.3rem 0.7rem;
}
.stage-dag span,
.event-list span {
  color: var(--ink);
  font-size: 0.86rem;
  text-transform: capitalize;
}
.stage-dag strong,
.request-list strong,
.event-list strong {
  color: var(--slate);
  font-size: 0.76rem;
}
.stage-dag small {
  grid-column: 1 / -1;
  color: var(--steel);
  line-height: 1.35;
}
.request-list,
.event-list,
.sidecar-form {
  display: grid;
  gap: 0.55rem;
}
.request-list p,
.event-list p {
  margin: 0.24rem 0 0;
  color: var(--steel);
  font-size: 0.82rem;
}
.request-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.45rem;
}
.request-options button {
  border: 1px solid var(--hairline-soft);
  border-radius: 999px;
  background: #fff;
  color: var(--slate);
  padding: 0.14rem 0.45rem;
  font-size: 0.72rem;
}
.sidecar-form label {
  display: grid;
  gap: 0.3rem;
}
.sidecar-request {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  margin-bottom: 0.7rem;
}
.sidecar-request textarea {
  min-width: 0;
  resize: vertical;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0.55rem 0.65rem;
}
.sidecar-request button {
  min-height: 38px;
  align-self: end;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0 0.75rem;
}
.sidecar-form label span {
  color: var(--slate);
  font-size: 0.78rem;
  font-weight: 650;
}
.sidecar-form textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  padding: 0.55rem 0.65rem;
  font-family: var(--mono);
  font-size: 0.78rem;
}
.sidecar-form code {
  display: block;
  overflow-wrap: anywhere;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  background: var(--surface-code);
  padding: 0.55rem 0.65rem;
  color: var(--slate);
  font-size: 0.78rem;
}

@media (max-width: 900px) {
  .workbench-head,
  .workbench-flows,
  .section-headline,
  .source-review-override {
    display: grid;
  }
  .fingerprint-grid,
  .input-grid,
  .file-input-grid,
  .run-control-grid,
  .telemetry-grid {
    grid-template-columns: 1fr;
  }
  .sidecar-request {
    grid-template-columns: 1fr;
  }
}
</style>
