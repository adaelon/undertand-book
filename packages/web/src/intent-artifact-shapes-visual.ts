import { createApp, defineComponent, h, ref } from "vue";
import type {
  ArtifactBlueprintShape,
  IntentArtifactDisplayBlueprintV1,
  IntentArtifactInstanceRecordV2,
  IntentArtifactInstanceRelationV2,
  IntentArtifactOverlayV1,
} from "./api";
import IntentArtifactPanel from "./components/IntentArtifactPanel.vue";
import "./style.css";
import "./intent-artifact-shapes-visual.css";

const longField = `LONG_FIELD_${"deterministic-reader-overflow".repeat(24)}`;

function blueprint(
  title: string,
  purpose: string,
  shape: ArtifactBlueprintShape,
  summaryFields: string[],
): IntentArtifactDisplayBlueprintV1 {
  return { title, purpose, shape, summary_fields: summaryFields };
}

function artifact(
  artifactId: string,
  display: IntentArtifactDisplayBlueprintV1,
  records: IntentArtifactInstanceRecordV2[],
  relations: IntentArtifactInstanceRelationV2[] = [],
) {
  return {
    artifact_id: artifactId,
    artifact_type: "custom" as const,
    state: "accepted" as const,
    blueprint: display,
    payload_digest: artifactId.padEnd(64, "0").slice(0, 64),
    accepted_at: "2026-07-30T03:00:00.000Z",
    payload: {
      version: "artifact_instance.v2" as const,
      records,
      ...(relations.length ? { relations } : {}),
    },
  };
}

const overlay: IntentArtifactOverlayV1 = {
  version: "intent_artifact_overlay.v1",
  book_id: "visual-private-book",
  intent_id: "visual-private-intent",
  plan_id: "visual-private-plan",
  plan_digest: "f".repeat(64),
  artifacts: [
    artifact(
      "collection-visual",
      blueprint("术语索引", "按主题收集可回到正文核验的关键术语。", "collection", ["/term", "/definition"]),
      [{
        record_id: "term-1",
        data: { term: "Artifact Blueprint", definition: longField },
        evidence_lids: ["10.1"],
      }],
    ),
    artifact(
      "table-visual",
      blueprint("实施矩阵", "对比任务、责任面与当前状态。", "table", ["/task", "/owner", "/status"]),
      [
        { record_id: "task-1", data: { task: "Reader projection", owner: "Web", status: "ready" }, evidence_lids: ["10.2"] },
        { record_id: "task-2", data: { task: "Deterministic gate", owner: "Runtime", status: "accepted" }, evidence_lids: ["10.3"] },
      ],
    ),
    artifact(
      "graph-visual",
      blueprint("依赖图", "显示 Blueprint 如何驱动 Reader 投影。", "graph", ["/label", "/relation"]),
      [
        { record_id: "blueprint", data: { label: "Blueprint" }, evidence_lids: ["10.4"] },
        { record_id: "reader", data: { label: "Reader" }, evidence_lids: ["10.5"] },
      ],
      [{
        relation_id: "drives",
        source: "blueprint",
        target: "reader",
        data: { relation: "驱动" },
        evidence_lids: ["10.5"],
      }],
    ),
    artifact(
      "sequence-visual",
      blueprint("执行步骤", "按顺序展示验证动作。", "sequence", ["/step", "/detail"]),
      [
        { record_id: "step-1", data: { step: "红测", detail: "先锁定五形态与降级行为" }, evidence_lids: ["10.6"] },
        { record_id: "step-2", data: { step: "绿测", detail: "运行 unit、typecheck 与 build" }, evidence_lids: ["10.7"] },
      ],
    ),
    artifact(
      "document-visual",
      blueprint("阅读摘要", "把长内容组织为可核验的文档段落。", "document", ["/heading", "/body"]),
      [{
        record_id: "section-1",
        data: { heading: "结论", body: "五种通用形态共享同一个 accepted 数据合同，并保留逐记录正文依据。" },
        evidence_lids: ["10.8"],
      }],
    ),
  ],
};

const VisualHarness = defineComponent({
  setup() {
    const eventStatus = ref("尚未打开正文依据");
    return () => h("main", { class: "intent-artifact-visual" }, [
      h("header", { class: "visual-heading" }, [
        h("p", "AA10 · READER PROJECTION"),
        h("h1", "Blueprint 五形态"),
        h("span", { "data-testid": "event-status" }, eventStatus.value),
      ]),
      h("section", { class: "visual-panel" }, [
        h(IntentArtifactPanel, {
          overlay,
          loading: false,
          error: null,
          onGoto: (lid: string) => { eventStatus.value = `已定位 ${lid}`; },
          onCite: (artifactId: string) => { eventStatus.value = `已记录 ${artifactId}`; },
        }),
      ]),
    ]);
  },
});

createApp(VisualHarness).mount("#app");
