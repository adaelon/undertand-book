import { createHash } from "node:crypto";
import { compileBuildMode } from "../../src/build-capability";
import { transitionBuildPlan, type BuildPlanBudgetV1, type BuildPlanV1 } from "../../src/build-intent";
import {
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  resolveAutomaticBuildTarget,
} from "../../src/build-orchestrator";

const DEFAULT_NOW = "2026-07-25T09:00:00.000Z";

export function confirmedStandardBuildPlan(
  targetInput: string,
  rootDir: string,
  options: { now?: string; budget?: BuildPlanBudgetV1 } = {},
): BuildPlanV1 {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
  const suffix = createHash("sha256")
    .update(`${target.book_id}:${target.target_ref.input_fingerprint}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const contentProfile = target.profile_id === "paper"
    ? { id: "paper" as const, version: "paper_v0" as const }
    : { id: "technical_learning" as const, version: "technical_learning_v0" as const };
  const draft = compileBuildMode({
    mode: "standard_deep",
    book_id: target.book_id,
    source_fingerprint: target.target_ref.input_fingerprint,
    content_profile: contentProfile,
    plan_id: `plan-${suffix}`,
    revision: 1,
    created_at: options.now ?? DEFAULT_NOW,
    budget: options.budget ?? { on_exceed: "needs_user" },
    public_freshness: inspectAutomaticBuildStageFreshness(snapshot, { quality_profile: "full" }),
  }).plan!;
  return transitionBuildPlan(draft, "confirmed", {
    at: options.now ?? DEFAULT_NOW,
    confirmation_source: "reader_ui",
  });
}
