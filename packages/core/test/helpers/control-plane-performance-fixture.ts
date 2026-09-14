import { writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { buildAutomaticBuildSnapshot, prepareAutomaticBuildSnapshot, resolveAutomaticBuildTarget } from "../../src/build-orchestrator";
import { freezePass1ShadowTask } from "../../src/pass1-reduction";
import { freezeProfileSidecarSemanticFastPathTask, writeProfileSidecarSemanticFastPathCandidate } from "../../src/profile-sidecar-reduction";
import { writePass1ProductionTaskArtifact } from "./model-input-routability-fixture";
import { confirmedStandardBuildPlan } from "./confirmed-build-plan";
import { automaticBuildNext, automaticBuildPlan, runAutomaticBuildCloseStage } from "../../../../skills/build/automatic-build";
import { createAutomaticBuildInvocation } from "../../../../skills/build/automatic-build-driver";

/** Independent top-level windows, with 110 additional formula tasks. No real book data. */
export async function createControlPlanePerformanceFixture(root: string) {
  const registry = path.join(root, "registry");
  process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = registry;
  const sourceFile = path.join(root, "control-plane.md");
  const source = Array.from({ length: 205 }, (_, index) => (
    `# Chapter ${index + 1}\n\nIndependent synthetic explanation ${index + 1}: the measured value increases with its input.\n\n`
    + (index < 110 ? `$$\ny_{${index + 1}} = x_{${index + 1}} + ${index + 2}\n$$\n\n` : "")
  )).join("");
  writeFileSync(sourceFile, source);
  const target = resolveAutomaticBuildTarget(sourceFile, root);
  if (prepareAutomaticBuildSnapshot(target, "pass1").status !== "ready") throw new Error("B1 Pass1 preparation failed");
  const pass1 = buildAutomaticBuildSnapshot(target).stages[0];
  await setImmediate();
  if (pass1.work_units?.length !== 205) throw new Error(`B1 Pass1 scale: ${pass1.work_units?.length}`);
  for (const unit of pass1.pending_work_units ?? []) {
    const generation = pass1.generation_tasks?.[unit.work_unit_id];
    if (generation?.kind !== "pass1") throw new Error("B1 requires independent Pass1 tasks");
    freezePass1ShadowTask(target, generation.task);
    writePass1ProductionTaskArtifact({
      target, policy_generation_id: generation.task.policy_generation_id,
      work_unit_id: unit.work_unit_id, marker: `Synthetic claim ${unit.work_unit_id}`,
    });
  }
  runAutomaticBuildCloseStage(sourceFile, root, "pass1");
  await setImmediate();
  if (prepareAutomaticBuildSnapshot(target, "profile_sidecar").status !== "ready") throw new Error("B1 sidecar preparation failed");
  const sidecar = buildAutomaticBuildSnapshot(target).stages.find((stage) => stage.stage === "profile_sidecar");
  if (sidecar?.work_units?.length !== 315) throw new Error(`B1 sidecar scale: ${sidecar?.work_units?.length}`);
  const discourse = (sidecar.pending_work_units ?? []).filter((unit) => unit.kind === "profile_sidecar_discourse");
  if (discourse.length < 67) throw new Error("B1 needs independent discourse candidates");
  for (const unit of discourse.slice(0, 64)) {
    const generation = sidecar.generation_tasks?.[unit.work_unit_id];
    if (generation?.kind !== "profile_sidecar_fast_path") throw new Error("B1 expected fast-path sidecar");
    freezeProfileSidecarSemanticFastPathTask(target, generation.task);
    writeProfileSidecarSemanticFastPathCandidate({
      target, source, task: generation.task,
      candidate: { discourse_items: generation.task.packet.visible_lids.map((lid) => ({ lid, mode: "informative", relations: [] })) },
      provenance: { executor: "b1-fixture", attempt: 1, generated_at: "2026-09-07T12:00:00.000Z" },
    });
  }
  const buildPlan = confirmedStandardBuildPlan(sourceFile, root);
  await setImmediate();
  const buildPlanPath = path.join(root, "plan.json");
  writeFileSync(buildPlanPath, JSON.stringify(buildPlan));
  const invocation = createAutomaticBuildInvocation({
    version: "automatic_build_invocation_create.v1", target_input: sourceFile, root_dir: root,
    build_plan_path: buildPlanPath, quality_profile: "full", max_parallel: 3,
    created_at: new Date().toISOString(),
  });
  await setImmediate();
  const plan = automaticBuildPlan(sourceFile, root, { requested_workers: 3, available_agent_slots: 3, build_plan: buildPlan });
  if (!plan.preflight) throw new Error("B1 preflight missing");
  await setImmediate();
  const next = automaticBuildNext(sourceFile, root, 3, {
    accepted_plan_digest: plan.preflight.descriptor_plan_digest,
    available_agent_slots: 3, executor_dispatches: true, build_plan: buildPlan,
  });
  if (!("dispatches" in next.action) || next.action.dispatches?.length !== 3) {
    throw new Error(`B1 requires three active dispatches: ${next.action.kind}`);
  }
  return { root, registry, sourceFile, target, buildPlan, invocation, dispatches: next.action.dispatches };
}
