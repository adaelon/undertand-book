import { resolveAutomaticBuildTarget, routeAutomaticBuildSnapshot } from "../../../packages/core/src/build-orchestrator";

// Read-only production routing; semantic packets and artifacts stay inside code.
const target = resolveAutomaticBuildTarget(process.argv[2], process.argv[3]);
const result = routeAutomaticBuildSnapshot(target);
if (result.status === "blocked") {
  console.log(JSON.stringify({ status: result.status, code: result.recovery.code,
    affected_work_units: result.recovery.affected_work_units }));
} else {
  console.log(JSON.stringify({ status: result.status, stages: result.value.stages.map(stage => ({
    stage: stage.stage, pending: stage.pending_tasks, progress: stage.book_structure_progress,
  })) }));
}
