import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDECAR_OPTIONS,
  compileSidecarBuildSpec,
  confirmSidecarPlan,
  draftSidecarPlan,
} from "../src/sidecar-plan";

describe("PH9 natural-language sidecar planning", () => {
  it("offers default sidecar options before the custom escape hatch", () => {
    expect(DEFAULT_SIDECAR_OPTIONS.map((option) => option.target_view)).toEqual([
      "timeline",
      "concept_map",
      "comparison_table",
      "argument_map",
      "custom",
    ]);
    expect(DEFAULT_SIDECAR_OPTIONS.at(-1)?.target_view).toBe("custom");
    expect(DEFAULT_SIDECAR_OPTIONS.slice(0, -1).every((option) => option.output_contract.required_evidence === "lid_required")).toBe(true);
  });

  it("drafts a confirmable sidecar_plan and form from a natural-language request", () => {
    const plan = draftSidecarPlan({
      book_id: "paper-a",
      user_request: "Compare the datasets and methods used in the paper.",
      source_scope: { lids: ["1.1", "2.1"] },
      now: "2026-07-09T00:00:00.000Z",
    });

    expect(plan.version).toBe("sidecar_plan.v1");
    expect(plan.status).toBe("draft");
    expect(plan.confirmation_required).toBe(true);
    expect(plan.sidecar_generation_allowed).toBe(false);
    expect(plan.selected_option).toBe("comparison_table");
    expect(plan.intent.output_contract.required_evidence).toBe("lid_required");
    expect(plan.intent.output_contract.visualization).toBe("table");
    expect(plan.form_draft.default_options.map((option) => option.target_view)).toContain("custom");
    expect(() => compileSidecarBuildSpec(plan)).toThrow("confirmed sidecar_plan");
  });

  it("compiles a sidecar build spec only after confirmation", () => {
    const draft = draftSidecarPlan({
      book_id: "paper-a",
      user_request: "Build an argument map of claims and evidence.",
      source_scope: { lids: ["1.1", "1.2"] },
      now: "2026-07-09T00:00:00.000Z",
    });
    const confirmed = confirmSidecarPlan(draft, "2026-07-09T00:01:00.000Z", {
      output_contract: { sidecar_id: "paper_argument_map_reviewed" },
    });
    const spec = compileSidecarBuildSpec(confirmed);

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.sidecar_generation_allowed).toBe(true);
    expect(confirmed.confirmed_at).toBe("2026-07-09T00:01:00.000Z");
    expect(spec).toMatchObject({
      version: "sidecar_build_spec.v1",
      stage: "custom_sidecar",
      sidecar_id: "paper_argument_map_reviewed",
      input_lids: ["1.1", "1.2"],
      visualization_hint: "graph",
    });
    expect(spec.extractor_prompt).toContain("Every accepted record must include non-empty evidence_lids");
    expect(spec.validation_rules).toContain("lid_required");
  });

  it("keeps custom plans confirmable and evidence-gated", () => {
    const plan = draftSidecarPlan({
      book_id: "paper-a",
      user_request: "Create a bespoke rubric for novelty.",
      target_view: "custom",
      now: "2026-07-09T00:00:00.000Z",
    });

    expect(plan.selected_option).toBe("custom");
    expect(plan.status).toBe("draft");
    expect(plan.sidecar_generation_allowed).toBe(false);
    expect(plan.validation_rules).toContain("custom_schema_requires_confirmation");
    expect(plan.intent.output_contract.required_evidence).toBe("lid_required");
  });
});
