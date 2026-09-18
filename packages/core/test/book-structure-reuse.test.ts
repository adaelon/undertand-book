import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { BOOK_STRUCTURE_EXECUTION_BUDGET_V2, BOOK_STRUCTURE_EXECUTION_PROMPTS_V2, createBookStructureExecutionContractsV2,
  evaluateBookStructureExecution, proofBoundBookStructureDescriptor, type BookStructureCandidate, type BookStructureStitchFragmentInputV1 } from "../src/book-structure";
import { createBookStructureGenerationTask, freezeBookStructureGenerationTask, readBookStructureGenerationArtifact,
  writeBookStructureGenerationCandidate } from "../src/book-structure-generation";
import { materializeBookStructureContributions } from "../src/book-structure-materialization";
import { bookStructureRelationContracts, routeBookStructureRelationSelections } from "../src/book-structure-relation-routing";
import { automaticBuildGenerationArtifactPath } from "../src/semantic-artifact";
import { createAutomaticBuildStagePolicySet, freezeAutomaticBuildStagePolicySet, automaticBuildPolicyGenerationPath } from "../src/automatic-build-policy-generation";
import { resolveContentProfile } from "../src/content-profile";
import { renderBookStructureStitchFragmentModelInput } from "../src/model-input-renderer";
import { CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 } from "../src/executor-transport";
import { automaticBuildExtractorForWorkUnitKind, type AutomaticBuildTarget } from "../src/build-orchestrator";
import { publishAutomaticBuildArtifactSet } from "../src/automatic-build-publication";
import { buildReproducibleProfileArtifactHeader } from "../src/profile-artifact";
import { BookStructureSidecarZ } from "../src/zod";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ub-a5-reuse-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const target: AutomaticBuildTarget = { kind: "source_file", root_dir: root, workspace_dir: root,
    source_path: path.join(root, "book.md"), book_id: "reuse", profile_id: "technical_learning",
    target_ref: { version: "build_target_ref.v2", workspace_dir: root, book_id: "reuse", profile_id: "technical_learning", input_fingerprint: "a".repeat(64) } };
  const contracts = createBookStructureExecutionContractsV2({ profile: resolveContentProfile("technical_learning"), quality_profile: "full", prompts: BOOK_STRUCTURE_EXECUTION_PROMPTS_V2 });
  const policy = "book-structure-stitch-fragment.full.v4";
  const member = { kind: "structure_stitch_fragment" as const, extractor: automaticBuildExtractorForWorkUnitKind("book_structure", "structure_stitch_fragment"),
    policy_generation_id: policy, policy_fingerprint: contracts.stitch_fragment.policy_fingerprint };
  const old = createAutomaticBuildStagePolicySet({ target_ref: target.target_ref, stage: "book_structure", frozen_at: "2026-09-13T00:00:00Z", members: [member] });
  freezeAutomaticBuildStagePolicySet(target, old);
  const task = (i: number, text = "Local chapter evidence", contract = contracts.stitch_fragment) => {
    const lid = String(i + 1), range = { start_ordinal: i, end_ordinal_exclusive: i + 1 };
    const packet: BookStructureStitchFragmentInputV1 = { version: "book_structure_stitch_fragment_input.v1", work_unit_id: `stitch:fragment:${String(i).padStart(4, "0")}`,
      fragment_ordinal: i, unit_card_range: range, unit_cards: [{ unit_lid: lid, role: "foundation",
        summary: { text, evidence_lids: [lid + ".1"] }, candidate_key_stops: [], depends_on: [], evidence_lids: [lid + ".1"] }], long_range_edges: [] };
    const rendered = renderBookStructureStitchFragmentModelInput(packet);
    const evaluation = evaluateBookStructureExecution({ contract, rendered_input: rendered, budget: BOOK_STRUCTURE_EXECUTION_BUDGET_V2, transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 });
    if (evaluation.status !== "within_limit") throw Error("fixture exceeds input budget");
    const descriptor = proofBoundBookStructureDescriptor({ target: target.target_ref, work_unit_id: packet.work_unit_id, kind: "structure_stitch_fragment",
      rendered_input: rendered, proof: evaluation.proof, policy_fingerprint: contract.policy_fingerprint,
      input_basis: { kind: "semantic_projection", projection_kind: "book_structure", source_fingerprint: target.target_ref.input_fingerprint,
        projection_sha256: evaluation.proof.rendered_input_sha256, parent_lids: ["stitch", lid, lid + ".1"], core_range: range },
      evidence_lids: ["stitch", lid, lid + ".1"], aggregation: { parent_lid: "stitch", role: "fragment" }, transport_profile: CODEX_EXECUTOR_TRANSPORT_PROFILE_V2 });
    return createBookStructureGenerationTask({ target_ref: target.target_ref, policy_generation_id: policy, descriptor, generation_input: packet,
      parent_unit_lid: "stitch", parent_content_hash: "b".repeat(64), source_range: range, allowed_evidence_lids: descriptor.evidence_lids, output_role: "stitch_candidate" });
  };
  const tasks = Array.from({ length: 29 }, (_, i) => task(i));
  const files = tasks.flatMap((t, i) => {
    const taskFile = freezeBookStructureGenerationTask(target, t);
    const lid = String(i + 1);
    writeBookStructureGenerationCandidate({ target, task: t, provenance: { executor: "historical-executor", attempt: 1, generated_at: "2026-09-13T00:00:00Z" },
      candidate: { spine: [{ lid, role: "foundation", summary: { text: "Grounded chapter", evidence_lids: [lid + ".1"] }, key_stop_ids: ["stop-1"], depends_on: [] }],
        key_stops: [{ id: "stop-1", lid: lid + ".1", type: "definition", reason: { text: "Grounded stop", evidence_lids: [lid + ".1"] } }], throughlines: [] } });
    return [taskFile, automaticBuildGenerationArtifactPath(target, "book_structure", policy, t.descriptor.work_unit_id)];
  });
  files.push(automaticBuildPolicyGenerationPath(target, "book_structure", policy));
  const before = files.map(file => readFileSync(file));
  const children = () => tasks.map(t => {
    const artifact = readBookStructureGenerationArtifact(target, t)!;
    return { work_unit_id: t.descriptor.work_unit_id, artifact_hash: artifact.artifact_hash, unit_card_range: t.source_range, payload: artifact.payload as BookStructureCandidate };
  });
  return { target, contracts, member, task, tasks, files, before, children };
}

it("admits 29 v4 local results after adding only post-stitch policies and reconstructs the same selection plan", () => {
  const f = fixture();
  const relation = bookStructureRelationContracts(f.contracts.stitch_fragment);
  freezeAutomaticBuildStagePolicySet(f.target, createAutomaticBuildStagePolicySet({ target_ref: f.target.target_ref, stage: "book_structure", frozen_at: "2026-09-14T00:00:00Z",
    members: [f.member, ...(["select", "delta"] as const).map(kind => ({ kind: `structure_relation_${kind}` as const,
      extractor: automaticBuildExtractorForWorkUnitKind("book_structure", `structure_relation_${kind}`), policy_generation_id: `book-structure-relation-${kind}.full.v1`, policy_fingerprint: relation[kind].policy_fingerprint }))] }));
  const order = f.tasks.map((_, i) => String(i + 1));
  const reconstruct = () => {
    const children = f.children();
    const materialized = materializeBookStructureContributions(children, order);
    const selections = routeBookStructureRelationSelections({ target: f.target.target_ref, candidate: materialized.candidate, contract: relation.select,
      dependencies: children.map(item => ({ artifact: item.work_unit_id, sha256: item.artifact_hash })) });
    return { materialized, selections };
  };
  const first = reconstruct();
  expect(first.materialized.candidate.spine).toHaveLength(29);
  expect(first.materialized.identities).toHaveLength(29);
  expect(reconstruct()).toEqual(first);
  expect(f.files.map(file => readFileSync(file))).toEqual(f.before);
});

it("rejects the changed local input or semantic contract while retaining every unaffected contribution", () => {
  const f = fixture();
  expect(() => readBookStructureGenerationArtifact(f.target, f.task(3, "Changed local input"))).toThrow(/stale/);
  const revised = { ...f.contracts.stitch_fragment, policy_fingerprint: { ...f.contracts.stitch_fragment.policy_fingerprint, stage_policy_version: "changed-local-contract.v5" } };
  expect(() => readBookStructureGenerationArtifact(f.target, f.task(3, undefined, revised))).toThrow(/stale/);
  for (const task of f.tasks.filter((_, i) => i !== 3)) expect(readBookStructureGenerationArtifact(f.target, task)).toBeDefined();
  expect(f.files.map(file => readFileSync(file))).toEqual(f.before);
});

it("keeps the last valid public structure readable when append publication is interrupted", () => {
  const f = fixture();
  const { candidate } = materializeBookStructureContributions(f.children(), f.tasks.map((_, i) => String(i + 1)));
  const sidecar = BookStructureSidecarZ.parse({ header: buildReproducibleProfileArtifactHeader({ book_id: f.target.book_id, content_profile: f.target.profile_id }),
    spine: candidate.spine, throughlines: candidate.throughlines, key_stops: candidate.key_stops });
  const previous = JSON.stringify(sidecar);
  publishAutomaticBuildArtifactSet({ workspace_dir: f.target.workspace_dir, stage: "book_structure", artifacts: { "book_structure.json": previous } });
  sidecar.spine[0].summary.text = "A new accepted relationship version";
  expect(() => publishAutomaticBuildArtifactSet({ workspace_dir: f.target.workspace_dir, stage: "book_structure",
    artifacts: { "book_structure.json": JSON.stringify(sidecar) }, fault_injection: { fail_after_promotions: 1 } })).toThrow(/injected publication failure/);
  const retained = readFileSync(path.join(f.target.workspace_dir, "book_structure.json"), "utf8");
  expect(retained).toBe(previous);
  expect(BookStructureSidecarZ.parse(JSON.parse(retained)).spine).toHaveLength(29);
});
