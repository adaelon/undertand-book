import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptLocalEvaluation, type EvalAdaptInput } from "../src/eval-adapt.js";
import { validateEvalExport, type UbEvalExportV1 } from "../src/eval-export-contract.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/observability/ub_eval_export.v1-adapter.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Omit<EvalAdaptInput, "options">;
const options = {
  comparison_group_id: "comparison-fixture-1",
  external_experiment_id_prefix: "experiment-fixture",
  external_dataset_id: "dataset-fixture",
  dataset_revision: "dataset-revision-1",
  source_revision_ref: "source-revision-1",
  execution_config_ref: "config-revision-1",
};

describe("ub_eval_export.v1 local adapters", () => {
  it("adapts the checked-in sanitized historical shapes without content fields", () => {
    const packages = adaptLocalEvaluation({ ...fixture, options });
    expect(packages.map((item) => [item.system, item.rows.length])).toEqual([
      ["system-a", 1],
      ["system-b", 3],
    ]);
    expect(packages[0].comparisons).toHaveLength(1);
    expect(packages[0].summary).toMatchObject({
      "quality.total": 1,
      "quality.product_failed": 0,
    });
    expect(packages[1].summary).toMatchObject({
      "quality.total": 1,
      "quality.product_failed": 1,
    });
    const serialized = JSON.stringify(packages);
    expect(serialized).not.toMatch(
      /CANARY_PRIVATE|memory_dir|answer_spans|reference_evidence|highlighted_quote/u,
    );
  });

  it("splits systems while preserving elapsed-only rows, denominators, and missing results", () => {
    const packages = adaptLocalEvaluation({ ...fixture, options });
    expect(packages.map((item) => item.system)).toEqual(["system-a", "system-b"]);
    expect(packages.every((item) => item.timing.source === "recorded")).toBe(true);

    const systemA = packages[0];
    const systemB = packages[1];
    expect(systemA.rows).toHaveLength(1);
    expect(systemB.rows).toHaveLength(3);
    expect(systemA.rows[0]).toMatchObject({
      case_id: "qa:case-1",
      repetition: 1,
      timing: { source: "elapsed_only", elapsed_ms: 1200 },
      execution_status: "delivered",
      quality_status: "unscorable",
      order_disagreement: true,
    });
    const failed = systemB.rows.find((row) => row.case_id === "qa:case-1")!;
    expect(failed).toMatchObject({
      execution_status: "incomplete",
      quality_status: "product_failed",
      order_disagreement: false,
    });
    expect(failed.scores.some((score) => score.key.startsWith("quality.")
      && score.key !== "quality.status")).toBe(false);
    expect(systemA.summary).toMatchObject({
      "agent.count": 1,
      "quality.total": 1,
      "quality.delivered": 1,
      "quality.unscorable": 1,
      "quality.expected_judge_calls": 2,
      "quality.judge_calls": 2,
      "quality.total_tokens": null,
    });
    const serialized = JSON.stringify(packages);
    expect(serialized).not.toMatch(/CANARY_PRIVATE|MUST_NOT_EXPORT/u);
  });

  it("keeps paired identity and each judge order instead of averaging disagreement", () => {
    const first = adaptLocalEvaluation({ ...fixture, options });
    const second = adaptLocalEvaluation({ ...fixture, options });
    expect(second).toEqual(first);
    const row = first[0].rows[0];
    const other = first[1].rows.find((item) => item.case_id === "qa:case-1")!;
    expect(first[0].comparisons).toEqual([{
      case_id: "qa:case-1",
      repetition: 1,
      sample_ids: [row.sample_id, other.sample_id],
      outcome: row.sample_id,
    }]);
    const completeness = row.scores.filter((score) => score.key === "quality.completeness");
    expect(completeness.map((score) => [score.judgment_id, score.value, score.candidate_order])).toEqual([
      ["judge-forward", "met", [row.sample_id, other.sample_id]],
      ["judge-reverse", "partial", [other.sample_id, row.sample_id]],
    ]);
  });

  it("splits ablation arms into independent experiments with shared case identity", () => {
    const run: EvalAdaptInput["run"] = {
      version: "ablation-v1",
      status: "completed",
      experiment: { arms: ["text", "tree", "graph"] },
      qa: ["text", "tree", "graph"].map((system) => ({
        id: "case-1",
        category: "exact",
        system,
        answer: "answer",
        elapsed_ms: 10,
        score: { success: true },
      })),
    };
    const packages = adaptLocalEvaluation({ run, options });
    expect(packages.map((item) => item.system)).toEqual(["text", "tree", "graph"]);
    expect(packages.map((item) => item.rows[0].case_id)).toEqual([
      "qa:case-1", "qa:case-1", "qa:case-1",
    ]);
    expect(new Set(packages.map((item) => item.rows[0].sample_id)).size).toBe(3);
    expect(packages.every((item) => item.timing.source === "unavailable")).toBe(true);
  });

  it("rejects arbitrary nested or oversized permitted records", () => {
    const value = adaptLocalEvaluation({ ...fixture, options })[0];
    const invalid = structuredClone(value) as UbEvalExportV1;
    invalid.rows[0].permitted_inputs = { payload: { answer: "not allowed" } };
    expect(() => validateEvalExport(invalid)).toThrow("bounded primitives");
  });
});
