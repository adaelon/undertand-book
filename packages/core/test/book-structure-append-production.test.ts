import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { buildAutomaticBuildSnapshot, prepareAutomaticBuildSnapshot, resolveAutomaticBuildTarget, routeAutomaticBuildSnapshot } from "../src/build-orchestrator";
import { freezeBookStructureGenerationTask, writeBookStructureGenerationCandidate, renderBookStructureGenerationTaskInput } from "../src/book-structure-generation";
import { bookStructureReferenceScope } from "../src/book-structure-evidence";
import { runAutomaticBuildCloseStage, automaticBuildNext, automaticBuildPlan, prepareExplicitLegacyBuildPlan } from "../../../skills/build/automatic-build";
import { collectAutomaticBuildStageQuality } from "../src/automatic-build-quality";
import { estimateTokens } from "../src/window";
import { freezeAutomaticBuildStagePolicySet } from "../src/automatic-build-policy-generation";
import { freezePass1ShadowTask } from "../src/pass1-reduction";
import { writePass1ProductionTaskArtifact } from "./helpers/model-input-routability-fixture";
import { freezeProfileSidecarSemanticFastPathTask, writeProfileSidecarSemanticFastPathCandidate } from "../src/profile-sidecar-reduction";
import { openAutomaticBuildExecutorSessionV3, nextAutomaticBuildExecutorInput, startAutomaticBuildExecutorGeneration, submitAutomaticBuildExecutorCandidateV3 } from "../src/automatic-build-executor-session";
import { createAutomaticBuildInvocation, automaticBuildStep } from "../../../skills/build/automatic-build-driver";
import { buildReproducibleProfileArtifactHeader } from "../src/profile-artifact";
import { automaticBuildGenerationArtifactPath, buildSemanticArtifactEnvelopeV3 } from "../src/semantic-artifact";
import { routeBookStructureStitchReductionLevelV2, createBookStructureExecutionContractsV2, BOOK_STRUCTURE_EXECUTION_PROMPTS_V2 } from "../src/book-structure";
import { resolveContentProfile } from "../src/content-profile";
import { createBookStructureGenerationTask, readBookStructureGenerationArtifact } from "../src/book-structure-generation";

it("routes local contributions through selection/deltas and atomically publishes a large structure, never a reduce root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ub-append-production-"));
  const oldRegistry = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
  process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = path.join(root, "driver-registry");
  onTestFinished(() => { if (oldRegistry === undefined) delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT; else process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = oldRegistry; });
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "book.md");
  writeFileSync(source, Array.from({ length: 29 }, (_, i) => `# Chapter ${i + 1}\n\nGrounded evidence for chapter ${i + 1}, ownership and resource release.\n`).join("\n"));
  const target = resolveAutomaticBuildTarget(source, root);
  mkdirSync(target.workspace_dir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(path.join(target.workspace_dir, name), JSON.stringify(value));
  const header = { book_id: target.book_id, profile_id: target.profile_id };
  write("base.json", { graph_nodes: [], graph_edges: [] });
  write("discourse_index.json", { header, items: [] });
  write("formula_semantics.json", { header, items: [] });
  for (const prerequisite of ["pass1", "profile_sidecar"] as const) {
    for (let round = 0; round < 8; round++) {
      const state = buildAutomaticBuildSnapshot(target).stages.find(item => item.stage === prerequisite)!;
      if (!state.pending_tasks.length) break;
      freezeAutomaticBuildStagePolicySet(target, state.policy_set!);
      for (const id of state.pending_tasks) {
        const generation = state.generation_tasks![id];
        if (generation.kind === "pass1") {
          freezePass1ShadowTask(target, generation.task);
          writePass1ProductionTaskArtifact({ target, policy_generation_id: generation.task.policy_generation_id, work_unit_id: id, marker: "Grounded ownership claim" });
        } else if (generation.kind === "profile_sidecar_fast_path") {
          freezeProfileSidecarSemanticFastPathTask(target, generation.task);
          writeProfileSidecarSemanticFastPathCandidate({ target, source: readFileSync(source, "utf8"), task: generation.task,
            candidate: { discourse_items: [{ lid: generation.task.packet.visible_lids[0], mode: "informative", relations: [] }] },
            provenance: { executor: "append-prerequisite", attempt: 1, generated_at: "2026-09-14T00:00:00.000Z" } });
        } else throw Error("unexpected prerequisite task");
      }
    }
    expect(runAutomaticBuildCloseStage(source, root, prerequisite, { quality_profile: "full" })).toMatchObject({ status: "closed" });
  }
  const get = () => {
    const stage = buildAutomaticBuildSnapshot(target).stages.find(stage => stage.stage === "book_structure");
    if (!stage) throw Error("BookStructure stage absent");
    expect(stage.work_units?.some(unit => unit.kind === "structure_stitch_reduce")).toBe(false);
    return stage;
  };
  expect(prepareAutomaticBuildSnapshot(target, "book_structure").status).toBe("ready");
  let stage = get();
  const originalUnitIds = stage.pending_tasks.map(id => {
    const generation = stage.generation_tasks![id];
    if (generation.kind !== "book_structure") throw Error("unit expected");
    return `unit:${generation.task.parent_unit_lid}`;
  });
  const counts: Record<string, number> = {};
  const inputs: Record<string, { bytes: number; estimated_tokens: number }> = {};
  let relationSeen = false;
  const executed = new Set<string>();
  const buildPlan = prepareExplicitLegacyBuildPlan(source, root, { pass2: "disabled", now: "2026-09-14T00:00:00.000Z" }).plan;
  const planFile = path.join(root, "confirmed-plan.json");
  writeFileSync(planFile, JSON.stringify(buildPlan));
  const planBytes = readFileSync(planFile);
  // The same invocation survives the local/reduce -> append transition.
  const invocation = createAutomaticBuildInvocation({ version: "automatic_build_invocation_create.v1", target_input: source,
    root_dir: root, build_plan_path: planFile, quality_profile: "full", max_parallel: 1, created_at: "2026-09-14T00:00:00.000Z" });
  let oldReduceFile: string | undefined;
  let oldReduceBytes: Buffer | undefined;
  let incompleteFile: string | undefined;
  let incompleteBytes: Buffer | undefined;
  for (let turn = 0; turn < 12 && stage.pending_tasks.length; turn++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    let handoff: { id: string; ref: string } | undefined;
    const kind = stage.pending_work_units![0].kind;
    const now = `2026-09-14T00:${String(turn + 1).padStart(2, "0")}:00.000Z`;
    if (kind.startsWith("structure_relation_") && !executed.has(kind)) {
      const plan = automaticBuildPlan(source, root, { build_plan: buildPlan, requested_workers: 1, available_agent_slots: 1 });
      const next = automaticBuildNext(source, root, 1, { build_plan: buildPlan, accepted_plan_digest: plan.preflight!.descriptor_plan_digest,
        available_agent_slots: 1, executor_dispatches: true, now });
      if (!("dispatches" in next.action) || !next.action.dispatches?.length) throw Error("expected relation dispatch");
      const dispatch = next.action.dispatches[0];
      handoff = { id: dispatch.manifest.ordered_work_unit_ids[0], ref: dispatch.opaque_handoff_ref };
      executed.add(kind);
    }
    for (const id of stage.pending_tasks) {
      const generation = stage.generation_tasks?.[id];
      if (generation?.kind !== "book_structure") throw Error("wrong generation");
      const task = generation.task;
      const scope = bookStructureReferenceScope(task.input);
      let candidate: unknown;
      if (task.output_role === "unit_artifact") {
        const lid = task.parent_unit_lid; const evidence = scope.evidence_by_unit[lid][0];
        candidate = { unit_card: { unit_lid: lid, role: "foundation", summary: { text: "章节阐明资源所有权与作用域释放之间的关系。".repeat(22), evidence_lids: [evidence] },
          candidate_key_stops: [{ id: "stop-1", lid: evidence, type: "definition", reason: { text: "本节给出资源释放规则及其具体适用条件。".repeat(18), evidence_lids: [evidence] } }], depends_on: [], evidence_lids: [evidence] } };
      } else if (task.output_role === "stitch_candidate") {
        if (!("unit_cards" in task.input)) throw Error("fragment cards absent");
        // Multiple local units may use the same stop name; the local writer requires uniqueness.
        candidate = { spine: task.input.unit_cards.map((card, i) => ({ lid: card.unit_lid, role: card.role, summary: card.summary, key_stop_ids: [`stop-${i}`], depends_on: [] })),
          key_stops: task.input.unit_cards.map((card, i) => ({ ...card.candidate_key_stops[0], id: `stop-${i}` })), throughlines: [] };
      } else if (task.output_role === "relation_selection") {
        if (!("entries" in task.input)) throw Error("index absent");
        const ids = new Set(task.input.entries.map(entry => entry.id));
        candidate = { groups: [[originalUnitIds[0], originalUnitIds[1]], [originalUnitIds[0], originalUnitIds.at(-1)!]]
          .filter(pair => pair.every(id => ids.has(id))).map(member_ids => ({ member_ids })) };
      } else if (task.output_role === "relation_delta") {
        relationSeen = true;
        expect(stage.closed).toBe(false);
        expect(stage.book_structure_materialized).toBeUndefined();
        if (!("entries" in task.input)) throw Error("relation absent");
        const units = [...new Set(task.input.entries.flatMap(entry => entry.unit_lids))];
        candidate = { new_throughlines: [], extend_throughlines: [], merge_throughlines: [], add_dependencies: units.length >= 2 && !id.endsWith("000001")
          ? [{ unit_lid: units[0], depends_on: units[1], evidence_lids: [scope.evidence_by_unit[units[0]][0], scope.evidence_by_unit[units[1]][0]] }] : [] };
      } else throw Error(`unexpected output role ${task.output_role}`);
      counts[task.output_role] = (counts[task.output_role] ?? 0) + 1;
      const measured = inputs[task.output_role] ??= { bytes: 0, estimated_tokens: 0 };
      measured.bytes += Buffer.byteLength(renderBookStructureGenerationTaskInput(task));
      measured.estimated_tokens += task.descriptor.execution_budget_proof.estimated_rendered_tokens;
      freezeBookStructureGenerationTask(target, task);
      if (handoff?.id === id) {
        let response = openAutomaticBuildExecutorSessionV3(handoff.ref, { now });
        for (let delivery = 0; delivery < 100; delivery++) {
          const action = response.action;
          if (action.kind === "DELIVER_INPUT") response = nextAutomaticBuildExecutorInput(action.next_request, { now });
          else if (action.kind === "INPUT_BATCH") response = action.batch.final_for_generation
            ? startAutomaticBuildExecutorGeneration({ version: "automatic_build_executor_generation_start_request.v3", opaque_session_ref: action.batch.opaque_session_ref,
                generation_input_ref: action.batch.generation_input_ref, confirmed_through_ordinal: action.batch.last_ordinal }, { now })
            : nextAutomaticBuildExecutorInput({ version: "automatic_build_executor_input_next_request.v4", opaque_session_ref: action.batch.opaque_session_ref,
                generation_input_ref: action.batch.generation_input_ref, ack_through_ordinal: action.batch.last_ordinal }, { now });
          else if (action.kind === "GENERATE") {
            response = submitAutomaticBuildExecutorCandidateV3({ version: "automatic_build_executor_candidate_submit.v3", opaque_session_ref: action.opaque_session_ref,
              candidate_sink_ref: action.candidate_sink_ref, candidate: candidate as any, now });
            expect(response.action.kind).toBe("DONE");
            break;
          } else throw Error(`unexpected executor state ${action.kind}`);
        }
      } else writeBookStructureGenerationCandidate({ target, task, candidate, provenance: { executor: "append-integration-fixture", attempt: 1, generated_at: "2026-09-14T00:00:00.000Z" } });
    }
    if (kind === "structure_stitch_fragment" && !oldReduceFile) {
      const locals = stage.pending_tasks.map(id => {
        const generation = stage.generation_tasks![id];
        if (generation.kind !== "book_structure") throw Error("expected local task");
        const artifact = readBookStructureGenerationArtifact(target, generation.task)!;
        return { task: generation.task, artifact };
      });
      const first = locals[0];
      const file = automaticBuildGenerationArtifactPath(target, "book_structure", first.task.policy_generation_id, first.task.descriptor.work_unit_id);
      const bytes = readFileSync(file);
      const bad = structuredClone(first.artifact);
      if (!("spine" in bad.payload)) throw Error("expected local spine");
      const omitted = bad.payload.spine!.shift()!.lid;
      writeFileSync(file, JSON.stringify(buildSemanticArtifactEnvelopeV3(bad)));
      const recovery = routeAutomaticBuildSnapshot(target);
      expect(recovery.status).toBe("ready");
      const repairStage = get();
      expect(repairStage.pending_tasks).toEqual(Array.from({ length: first.task.source_range.end_ordinal_exclusive - first.task.source_range.start_ordinal },
        (_, i) => first.task.descriptor.work_unit_id + ":core-repair:" + String(i).padStart(4, "0")));
      const repair = repairStage.generation_tasks![repairStage.pending_tasks[0]];
      if (repair.kind !== "book_structure") throw Error("expected repair task");
      expect(() => writeBookStructureGenerationCandidate({ target, task: repair.task,
        candidate: { spine: [], throughlines: [], key_stops: [] },
        provenance: { executor: "invalid-repair", attempt: 1, generated_at: now } })).toThrow(/core/);
      incompleteFile = file;
      incompleteBytes = readFileSync(file);
      const reduction = routeBookStructureStitchReductionLevelV2({ target: target.target_ref,
        unit_card_count: 29, reducer_level: 1,
        contracts: createBookStructureExecutionContractsV2({ profile: resolveContentProfile("technical_learning"), quality_profile: "full", prompts: BOOK_STRUCTURE_EXECUTION_PROMPTS_V2 }),
        children: locals.map(({ task, artifact }) => {
          // A smaller historical version, before the current large local candidates.
          const payload = structuredClone(artifact.payload) as any;
          for (const unit of payload.spine) unit.summary.text = "Historical chapter summary";
          for (const stop of payload.key_stops) stop.reason.text = "Historical grounded reason";
          return { work_unit_id: task.descriptor.work_unit_id, artifact_hash: artifact.artifact_hash,
            unit_card_range: task.source_range, payload };
        }) });
      if (reduction.status !== "ready") throw Error("historical reduction fixture must route");
      const old = reduction.work_units[0];
      const oldTask = createBookStructureGenerationTask({ target_ref: target.target_ref, policy_generation_id: "book-structure-stitch-reduce.full.v4",
        descriptor: old.descriptor, generation_input: old.input, parent_unit_lid: "stitch", parent_content_hash: first.task.parent_content_hash,
        source_range: old.route.unit_card_range, allowed_evidence_lids: old.descriptor.evidence_lids, output_role: old.route.role === "final" ? "stitch_artifact" : "stitch_candidate" });
      freezeBookStructureGenerationTask(target, oldTask);
      const localPayload = first.artifact.payload as any;
      const { reference_scope: _scope, context_units: _context, ...candidate } = localPayload;
      writeBookStructureGenerationCandidate({ target, task: oldTask, candidate,
        provenance: { executor: "historical-reduce", attempt: 1, generated_at: "2026-09-13T00:00:00.000Z" } });
      oldReduceFile = automaticBuildGenerationArtifactPath(target, "book_structure", oldTask.policy_generation_id, oldTask.descriptor.work_unit_id);
      oldReduceBytes = readFileSync(oldReduceFile);
    }
    stage = get();
  }
  expect(stage.pending_tasks).toEqual([]);
  expect(relationSeen).toBe(true);
  expect([...executed].sort()).toEqual(["structure_relation_delta", "structure_relation_select"]);
  expect(stage.book_structure_materialized!.output.spine).toHaveLength(29);
  expect(estimateTokens(JSON.stringify(stage.book_structure_materialized))).toBeGreaterThan(6000);
  const quality = collectAutomaticBuildStageQuality(target, stage, "full");
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(quality.gate_status, JSON.stringify(quality)).toBe("passed");
  const outputFile = path.join(target.workspace_dir, "book_structure.json");
  const local = stage.book_structure_materialized!.output;
  writeFileSync(outputFile, JSON.stringify({ header: buildReproducibleProfileArtifactHeader({ book_id: target.book_id, content_profile: target.profile_id }),
    spine: local.spine, throughlines: local.throughlines, key_stops: local.key_stops }, null, 2));
  expect(get().closed).toBe(false);
  rmSync(outputFile);
  const blockedPublication = path.join(target.workspace_dir, ".build", "automatic-build", "v2", "publication", "book_structure");
  writeFileSync(blockedPublication, "publication directory is unavailable");
  let failure: unknown;
  try { failure = runAutomaticBuildCloseStage(source, root, "book_structure", { quality_profile: "full" }); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(get().closed).toBe(false);
  rmSync(blockedPublication);
  const closed = runAutomaticBuildCloseStage(source, root, "book_structure", { quality_profile: "full" });
  expect(closed).toMatchObject({ status: "closed", postcondition: { stage_closed: true } });
  const bytes = readFileSync(outputFile, "utf8");
  expect(get().book_structure_progress?.publication).toBe("published");
  expect(runAutomaticBuildCloseStage(source, root, "book_structure", { quality_profile: "full" })).toMatchObject({ status: "closed" });
  expect(readFileSync(outputFile, "utf8")).toBe(bytes);
  await new Promise<void>(resolve => setImmediate(resolve));
  const done = automaticBuildStep({ version: "automatic_build_step_request.v1", invocation_ref: invocation.invocation_ref, available_agent_slots: 0 });
  expect(done.action, JSON.stringify(done)).toMatchObject({ kind: "DONE" });
  expect(done.book_structure_progress).toMatchObject({ relation: { done: 2, total: 2 }, publication: "published" });
  expect(JSON.stringify(done)).not.toContain("evidence_lids");
  expect(readFileSync(planFile)).toEqual(planBytes);
  expect(oldReduceFile).toBeDefined();
  expect(readFileSync(oldReduceFile!)).toEqual(oldReduceBytes);
  expect(readFileSync(incompleteFile!)).toEqual(incompleteBytes);
  const stale = JSON.parse(bytes); stale.spine[0].summary.text = "old public result"; write("book_structure.json", stale);
  expect(get().closed).toBe(false);
  console.info("append production accounting", JSON.stringify({ counts, inputs, output_bytes: Buffer.byteLength(bytes), progress: stage.book_structure_progress }));
}, 120_000);
