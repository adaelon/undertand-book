import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  BOOK_STRUCTURE_EXECUTION_PROMPTS_V2,
  createBookStructureExecutionContractsV2,
  routeBookStructureUnitWorkUnitsV2,
  type BookStructureUnitSource,
} from "../src/book-structure";
import { createBookStructureGenerationTask, writeBookStructureGenerationCandidate } from "../src/book-structure-generation";
import type { AutomaticBuildTarget } from "../src/build-orchestrator";
import { resolveContentProfile } from "../src/content-profile";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "../src/executor-transport";

for (const [kind, prompt] of Object.entries(BOOK_STRUCTURE_EXECUTION_PROMPTS_V2)) {
  it(`the production ${kind} prompt supplies examples accepted by the real candidate writer`, () => {
    const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]));
    expect(examples.length, "the executor needs a complete output example, not unit_card: ...").toBeGreaterThan(0);
    for (const candidate of examples) {
      const root = mkdtempSync(path.join(tmpdir(), "ub-structure-prompt-"));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      const profile = resolveContentProfile("technical_learning");
      const target: AutomaticBuildTarget = {
        kind: "source_file", profile_id: profile.id, book_id: "prompt-test",
        root_dir: root, workspace_dir: root, source_path: path.join(root, "source.md"),
        target_ref: {
          version: "build_target_ref.v2", workspace_dir: root, book_id: "prompt-test",
          profile_id: profile.id, input_fingerprint: "b".repeat(64),
        },
      };
      const source: BookStructureUnitSource = {
        job_id: "unit:1", unit_lid: "1", unit_kind: "chapter", title_path: [], leaf_lids: ["1.1"],
        excerpts: [{ lid: "1.1", text: "A definition supporting the chapter summary." }],
        graph_nodes: [], graph_edges: [], discourse_items: [], formula_semantics: [], pass2_edges: [],
      };
      const contracts = createBookStructureExecutionContractsV2({
        profile, quality_profile: "full", prompts: BOOK_STRUCTURE_EXECUTION_PROMPTS_V2,
      });
      const routed = routeBookStructureUnitWorkUnitsV2({
        target: target.target_ref, source,
        lid_nodes: [{ lid: "1.1", path: [1, 1], kind: "paragraph", span: { start: 0, end: 1 }, children: [] }],
        source_fingerprint: target.target_ref.input_fingerprint, contracts,
        transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2,
      });
      expect(routed.status).toBe("ready");
      if (routed.status !== "ready") throw new Error("production prompt must fit the transport budget");
      const descriptor = routed.work_units[0].descriptor;
      const task = createBookStructureGenerationTask({
        target_ref: target.target_ref, policy_generation_id: "prompt-contract.v1", descriptor,
        generation_input: source, parent_unit_lid: "1", parent_content_hash: "c".repeat(64),
        source_range: { start_ordinal: 0, end_ordinal_exclusive: 1 }, allowed_evidence_lids: ["1", "1.1"],
        output_role: candidate.unit_card ? "unit_artifact"
          : candidate.version === "book_structure_fragment_observation.v1" ? "unit_observation" : "stitch_candidate",
      });
      const write = (value: unknown) => writeBookStructureGenerationCandidate({
        target, task, candidate: value,
        provenance: { executor: "prompt-contract-test", attempt: 1, generated_at: "2026-09-08T10:00:00.000Z" },
      });
      if (candidate.unit_card) {
        expect(() => write({ unit_card: {
          unit_lid: "1", role: "front_matter", summary: "Cover", key_stops: [],
        } })).toThrow();
      }
      expect(() => write(candidate)).not.toThrow();
    }
  });
}
