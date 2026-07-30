// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { IntentArtifactOverlayV1 } from "../api";
import IntentArtifactPanel from "./IntentArtifactPanel.vue";

const overlay: IntentArtifactOverlayV1 = {
  version: "intent_artifact_overlay.v1",
  book_id: "private-book-id",
  intent_id: "private-intent-id",
  plan_id: "private-plan-id",
  plan_digest: "a".repeat(64),
  artifacts: [
    {
      artifact_id: "timeline-1",
      artifact_type: "timeline",
      state: "accepted",
      payload_digest: "b".repeat(64),
      accepted_at: "2026-07-26T02:00:00.000Z",
      payload: {
        items: [{
          id: "event-1",
          label: "A very long event label that must wrap inside the narrow reader rail without resizing the workspace",
          order_hint: "Phase one",
          evidence_lids: ["1.1"],
        }],
      },
    },
    {
      artifact_id: "concept-1",
      artifact_type: "concept_map",
      state: "accepted",
      payload_digest: "c".repeat(64),
      accepted_at: "2026-07-26T02:01:00.000Z",
      payload: {
        nodes: [
          { id: "concept-a", label: "Concept A", evidence_lids: ["1.2"] },
          { id: "concept-b", label: "Concept B", evidence_lids: ["1.3"] },
        ],
        links: [{ source: "concept-a", target: "concept-b", relation: "enables", evidence_lids: ["1.3"] }],
      },
    },
    {
      artifact_id: "comparison-1",
      artifact_type: "comparison_table",
      state: "accepted",
      payload_digest: "d".repeat(64),
      accepted_at: "2026-07-26T02:02:00.000Z",
      payload: {
        rows: [{
          subject: "Method A",
          dimensions: { mechanism: "retrieval", tradeoff: "lower latency" },
          evidence_lids: ["2.1"],
        }],
      },
    },
    {
      artifact_id: "argument-1",
      artifact_type: "argument_map",
      state: "accepted",
      payload_digest: "e".repeat(64),
      accepted_at: "2026-07-26T02:03:00.000Z",
      payload: {
        claims: [
          { id: "claim-a", claim: "The method improves recall.", role: "result", evidence_lids: ["3.1"] },
          { id: "claim-b", claim: "The evaluation is narrow.", role: "limitation", evidence_lids: ["3.2"] },
        ],
        relations: [{ source: "claim-b", target: "claim-a", relation: "qualifies", evidence_lids: ["3.2"] }],
      },
    },
  ],
};

describe("IntentArtifactPanel", () => {
  it("projects all four stable artifact views and navigates through evidence LIDs", async () => {
    const wrapper = mount(IntentArtifactPanel, {
      props: { overlay, loading: false, error: null },
    });

    expect(wrapper.text()).toContain("时间线");
    expect(wrapper.text()).toContain("概念图");
    expect(wrapper.text()).toContain("对照表");
    expect(wrapper.text()).toContain("论证图");
    expect(wrapper.text()).toContain("Phase one");
    expect(wrapper.text()).toContain("Concept A");
    expect(wrapper.text()).toContain("enables");
    expect(wrapper.text()).toContain("mechanism");
    expect(wrapper.text()).toContain("The method improves recall.");
    expect(wrapper.find(".artifact-table-scroll").exists()).toBe(true);
    expect(wrapper.find(".artifact-label").classes()).toContain("artifact-wrap");

    await wrapper.get('button[data-lid="1.1"]').trigger("click");
    expect(wrapper.emitted("goto")?.[0]).toEqual(["1.1"]);
    expect(wrapper.emitted("cite")?.[0]).toEqual(["timeline-1"]);

    const text = wrapper.text();
    expect(text).not.toContain("private-book-id");
    expect(text).not.toContain("private-intent-id");
    expect(text).not.toContain("private-plan-id");
    expect(text).not.toContain("a".repeat(64));
    expect(text).not.toContain("payload_digest");
    expect(text).not.toContain("task");
  });

  it("keeps pending and unavailable overlays quiet and independently refreshable", async () => {
    const pending: IntentArtifactOverlayV1 = {
      ...overlay,
      artifacts: [{ artifact_id: "timeline-2", artifact_type: "timeline", state: "pending" }],
    };
    const wrapper = mount(IntentArtifactPanel, {
      props: { overlay: pending, loading: false, error: null },
    });

    expect(wrapper.text()).toContain("0 / 1 已就绪");
    expect(wrapper.text()).toContain("准备中");
    expect(wrapper.text()).not.toContain("executor");
    expect(wrapper.text()).not.toContain("mailbox");

    await wrapper.get('button[aria-label="刷新目标成果"]').trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);

    await wrapper.setProps({ overlay: null, error: "暂时无法读取目标成果" });
    expect(wrapper.text()).toContain("暂时无法读取目标成果");
    expect(wrapper.find(".artifact-error").exists()).toBe(true);
  });

  it("renders Blueprint-driven collection, table, graph, sequence, and document shapes", async () => {
    const longToken = `LONG_FIELD_${"x".repeat(320)}`;
    const genericOverlay = {
      ...overlay,
      artifacts: [
        {
          artifact_id: "collection-1",
          artifact_type: "custom",
          state: "accepted",
          blueprint: {
            title: "术语索引",
            purpose: "按主题收集关键术语",
            shape: "collection",
            summary_fields: ["/term", "/definition"],
          },
          payload_digest: "1".repeat(64),
          accepted_at: "2026-07-30T01:00:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            blueprint_digest: "c".repeat(64),
            records: [{
              record_id: "term-1",
              data: { term: "Artifact Blueprint", definition: longToken },
              evidence_lids: ["5.1"],
            }],
          },
        },
        {
          artifact_id: "table-1",
          artifact_type: "custom",
          state: "accepted",
          blueprint: {
            title: "实施矩阵",
            purpose: "比较任务状态",
            shape: "table",
            summary_fields: ["/task", "/owner", "/status"],
          },
          payload_digest: "2".repeat(64),
          accepted_at: "2026-07-30T01:01:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "task-1",
              data: { task: "Reader projection", owner: "Web", status: "ready" },
              evidence_lids: ["5.2"],
            }],
          },
        },
        {
          artifact_id: "graph-1",
          artifact_type: "custom",
          state: "accepted",
          blueprint: {
            title: "依赖图",
            purpose: "展示依赖关系",
            shape: "graph",
            summary_fields: ["/label", "/relation"],
          },
          payload_digest: "3".repeat(64),
          accepted_at: "2026-07-30T01:02:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [
              { record_id: "node-a", data: { label: "Blueprint" }, evidence_lids: ["5.3"] },
              { record_id: "node-b", data: { label: "Reader" }, evidence_lids: ["5.4"] },
            ],
            relations: [{
              relation_id: "edge-1",
              source: "node-a",
              target: "node-b",
              data: { relation: "drives" },
              evidence_lids: ["5.4"],
            }],
          },
        },
        {
          artifact_id: "sequence-1",
          artifact_type: "custom",
          state: "accepted",
          blueprint: {
            title: "执行步骤",
            purpose: "展示有序步骤",
            shape: "sequence",
            summary_fields: ["/step", "/detail"],
          },
          payload_digest: "4".repeat(64),
          accepted_at: "2026-07-30T01:03:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "step-1",
              data: { step: "验证", detail: "运行确定性测试" },
              evidence_lids: ["5.5"],
            }],
          },
        },
        {
          artifact_id: "document-1",
          artifact_type: "custom",
          state: "accepted",
          blueprint: {
            title: "阅读摘要",
            purpose: "组织长文档内容",
            shape: "document",
            summary_fields: ["/heading", "/body"],
          },
          payload_digest: "5".repeat(64),
          accepted_at: "2026-07-30T01:04:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "section-1",
              data: { heading: "结论", body: "五种形态共享同一 accepted 实例合同。" },
              evidence_lids: ["5.6"],
            }],
          },
        },
      ],
    } as unknown as IntentArtifactOverlayV1;

    const wrapper = mount(IntentArtifactPanel, {
      props: { overlay: genericOverlay, loading: false, error: null },
    });

    expect(wrapper.findAll('[data-artifact-shape="collection"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-artifact-shape="table"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-artifact-shape="graph"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-artifact-shape="sequence"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-artifact-shape="document"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("Artifact Blueprint");
    expect(wrapper.text()).toContain("Reader projection");
    expect(wrapper.text()).toContain("drives");
    expect(wrapper.text()).toContain("运行确定性测试");
    expect(wrapper.text()).toContain("五种形态共享同一 accepted 实例合同。");
    expect(wrapper.find(".generic-field-value").classes()).toContain("artifact-wrap");
    expect(wrapper.text()).toContain(longToken);
    expect(wrapper.text()).not.toContain("c".repeat(64));
    expect(wrapper.text()).not.toContain("1".repeat(64));

    await wrapper.get('button[data-lid="5.1"]').trigger("click");
    expect(wrapper.emitted("goto")?.[0]).toEqual(["5.1"]);
    expect(wrapper.emitted("cite")?.[0]).toEqual(["collection-1"]);
  });

  it("keeps the four established views when system presets arrive as v2 instances", async () => {
    const v2Overlay = {
      ...overlay,
      artifacts: [
        {
          artifact_id: "timeline-v2",
          artifact_type: "timeline",
          state: "accepted",
          blueprint: { ...legacyBlueprint("Timeline", "sequence"), summary_fields: ["/label", "/order_hint"] },
          payload_digest: "7".repeat(64),
          accepted_at: "2026-07-30T02:00:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "event-v2",
              data: { label: "V2 timeline event", order_hint: "Stage V2" },
              evidence_lids: ["7.1"],
            }],
          },
        },
        {
          artifact_id: "concept-v2",
          artifact_type: "concept_map",
          state: "accepted",
          blueprint: { ...legacyBlueprint("Concept map", "graph"), summary_fields: ["/label", "/relation"] },
          payload_digest: "8".repeat(64),
          accepted_at: "2026-07-30T02:01:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [
              { record_id: "concept-v2-a", data: { label: "V2 concept A" }, evidence_lids: ["7.2"] },
              { record_id: "concept-v2-b", data: { label: "V2 concept B" }, evidence_lids: ["7.3"] },
            ],
            relations: [{
              relation_id: "concept-v2-edge",
              source: "concept-v2-a",
              target: "concept-v2-b",
              data: { relation: "extends" },
              evidence_lids: ["7.3"],
            }],
          },
        },
        {
          artifact_id: "comparison-v2",
          artifact_type: "comparison_table",
          state: "accepted",
          blueprint: { ...legacyBlueprint("Comparison table", "table"), summary_fields: ["/subject", "/dimensions"] },
          payload_digest: "9".repeat(64),
          accepted_at: "2026-07-30T02:02:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "row-v2",
              data: {
                subject: "V2 method",
                dimensions: [{ name: "quality", value_json: '"high"' }],
              },
              evidence_lids: ["7.4"],
            }],
          },
        },
        {
          artifact_id: "argument-v2",
          artifact_type: "argument_map",
          state: "accepted",
          blueprint: { ...legacyBlueprint("Argument map", "graph"), summary_fields: ["/claim", "/role", "/relation"] },
          payload_digest: "a".repeat(64),
          accepted_at: "2026-07-30T02:03:00.000Z",
          payload: {
            version: "artifact_instance.v2",
            records: [{
              record_id: "claim-v2",
              data: { claim: "V2 evidence remains visible.", role: "evidence" },
              evidence_lids: ["7.5"],
            }],
            relations: [],
          },
        },
      ],
    } as unknown as IntentArtifactOverlayV1;

    const wrapper = mount(IntentArtifactPanel, {
      props: { overlay: v2Overlay, loading: false, error: null },
    });

    expect(wrapper.text()).toContain("时间线");
    expect(wrapper.text()).toContain("概念图");
    expect(wrapper.text()).toContain("对照表");
    expect(wrapper.text()).toContain("论证图");
    expect(wrapper.text()).toContain("V2 timeline event");
    expect(wrapper.text()).toContain("extends");
    expect(wrapper.text()).toContain("quality");
    expect(wrapper.text()).toContain("high");
    expect(wrapper.text()).toContain("V2 evidence remains visible.");
    expect(wrapper.findAll(".timeline-list")).toHaveLength(1);
    expect(wrapper.findAll(".artifact-table-scroll")).toHaveLength(1);

    await wrapper.get('button[data-lid="7.1"]').trigger("click");
    expect(wrapper.emitted("goto")?.[0]).toEqual(["7.1"]);
    expect(wrapper.emitted("cite")?.[0]).toEqual(["timeline-v2"]);
  });

  it("falls back safely when display metadata or declared summary fields are unavailable", () => {
    const degradedOverlay = {
      ...overlay,
      artifacts: [{
        artifact_id: "degraded-1",
        artifact_type: "custom",
        state: "accepted",
        blueprint: {
          title: "未知形态",
          purpose: "验证降级",
          shape: "heatmap",
          summary_fields: ["/missing"],
        },
        payload_digest: "6".repeat(64),
        accepted_at: "2026-07-30T01:05:00.000Z",
        payload: {
          version: "artifact_instance.v2",
          records: [{ record_id: "empty-1", data: {}, evidence_lids: ["6.1"] }],
        },
      }],
    } as unknown as IntentArtifactOverlayV1;

    const wrapper = mount(IntentArtifactPanel, {
      props: { overlay: degradedOverlay, loading: false, error: null },
    });

    expect(wrapper.get('[data-artifact-shape="collection"]').text()).toContain("暂无可展示字段");
    expect(wrapper.text()).toContain("未知展示形态，已按列表展示");
    expect(wrapper.text()).not.toContain("payload_digest");
    expect(wrapper.text()).not.toContain("6".repeat(64));
  });
});

function legacyBlueprint(title: string, shape: string) {
  return { title, purpose: `${title} purpose`, shape };
}
