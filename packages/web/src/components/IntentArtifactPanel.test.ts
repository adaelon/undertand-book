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
});
