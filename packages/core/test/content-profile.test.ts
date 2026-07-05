import { describe, expect, it } from "vitest";
import {
  PAPER_BASE_INVARIANTS,
  PAPER_PROFILE_ID,
  resolveContentProfile,
  resolvePaperRulePack,
  TECHNICAL_LEARNING_PROFILE_ID,
} from "../src/content-profile";

describe("content profile rule resolution", () => {
  it("keeps technical_learning as the default content profile", () => {
    expect(resolveContentProfile()).toEqual({
      id: TECHNICAL_LEARNING_PROFILE_ID,
      profile_version: "technical_learning_v0",
    });
    expect(resolveContentProfile("technical_learning")).toEqual(resolveContentProfile());
  });

  it("resolves paper research_article as the default paper subtype", () => {
    const defaults = resolveContentProfile("paper");
    const explicit = resolveContentProfile("paper", { paper_subtype: "research_article" });

    expect(defaults).toEqual(explicit);
    expect(defaults.id).toBe(PAPER_PROFILE_ID);
    if (defaults.id !== PAPER_PROFILE_ID) throw new Error("expected paper profile");
    expect(defaults.paper.paper_subtype).toBe("research_article");
    expect(defaults.paper.effective_rules.argument_shape).toEqual({
      kind: "research_article",
      slots: ["problem", "research_question", "hypothesis", "method", "evidence", "claim", "limitation"],
    });
    expect(defaults.paper.effective_rules.graph_edge_rules).toEqual(
      expect.arrayContaining([
        "paper.base.claim_supported_by_evidence",
        "paper.base.method_supports_result",
        "paper.base.hypothesis_tested_by_experiment",
        "paper.base.related_work_contrasts",
        "paper.base.related_work_builds_on",
        "paper.base.limitation_motivates_future_work",
      ]),
    );
  });

  it("applies the survey subtype overlay without weakening paper base invariants", () => {
    const rulePack = resolvePaperRulePack("survey");

    expect(rulePack.base_invariants).toEqual(PAPER_BASE_INVARIANTS);
    expect(rulePack.overlay_order).toEqual(["paper.base", "paper.subtype.survey"]);
    expect(rulePack.overlay.patched_slots).toEqual([
      "metadata_extra_fields",
      "argument_shape",
      "graph_edge_rules",
      "book_structure_rules",
      "reading_guide_rules",
      "validators",
    ]);
    expect(rulePack.effective_rules.validators).toEqual(
      expect.arrayContaining([
        "paper.base.citation_anchor_is_lid",
        "paper.base.no_paper_argument_sidecar",
        "paper.survey.review_claim_source_defaults_to_review_says",
      ]),
    );
  });

  it("provides a minimal survey argument skeleton with review_says as the default claim source", () => {
    const survey = resolveContentProfile("paper", { paper_subtype: "survey" });

    if (survey.id !== PAPER_PROFILE_ID) throw new Error("expected paper profile");
    expect(survey.paper.effective_rules.argument_shape).toEqual({
      kind: "survey",
      slots: [
        "field_scope",
        "taxonomy_axes",
        "literature_clusters",
        "comparison_dimensions",
        "synthesis_claims",
        "consensus_or_disagreement",
        "gaps_and_future_directions",
      ],
      default_claim_source: "review_says",
    });
    expect(survey.paper.effective_rules.graph_edge_rules).toEqual(
      expect.arrayContaining(["paper.survey.identifies_gap"]),
    );
  });

  it("rejects top-level survey and unknown paper_subtype values", () => {
    expect(() => resolveContentProfile("survey")).toThrow("Unsupported content_profile");
    expect(() => resolveContentProfile("paper", { paper_subtype: "meta_analysis" })).toThrow(
      "Unsupported paper_subtype",
    );
    expect(() => resolveContentProfile("technical_learning", { paper_subtype: "survey" })).toThrow(
      "paper_subtype can only be used with content_profile paper",
    );
  });
});
