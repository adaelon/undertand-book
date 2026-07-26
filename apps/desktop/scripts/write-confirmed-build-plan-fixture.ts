import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileBuildMode } from "../../../packages/core/src/build-capability";
import { transitionBuildPlan } from "../../../packages/core/src/build-intent";
import {
  buildAutomaticBuildSnapshot,
  inspectAutomaticBuildStageFreshness,
  resolveAutomaticBuildTarget,
} from "../../../packages/core/src/build-orchestrator";

const [targetInput, rootDir, outputFile] = process.argv.slice(2);
if (!targetInput || !rootDir || !outputFile) {
  throw new Error("usage: write-confirmed-build-plan-fixture <target> <root> <output>");
}

const target = resolveAutomaticBuildTarget(targetInput, rootDir);
const snapshot = buildAutomaticBuildSnapshot(target, { quality_profile: "full" });
const suffix = createHash("sha256")
  .update(`${target.book_id}:${target.target_ref.input_fingerprint}`, "utf8")
  .digest("hex")
  .slice(0, 12);
const contentProfile = target.profile_id === "paper"
  ? { id: "paper" as const, version: "paper_v0" as const }
  : { id: "technical_learning" as const, version: "technical_learning_v0" as const };
const now = "2026-07-25T09:00:00.000Z";
const draft = compileBuildMode({
  mode: "standard_deep",
  book_id: target.book_id,
  source_fingerprint: target.target_ref.input_fingerprint,
  content_profile: contentProfile,
  plan_id: `smoke-plan-${suffix}`,
  revision: 1,
  created_at: now,
  budget: { on_exceed: "needs_user" },
  public_freshness: inspectAutomaticBuildStageFreshness(snapshot, { quality_profile: "full" }),
}).plan;
if (!draft) throw new Error("standard_deep did not compile a build plan");
const confirmed = transitionBuildPlan(draft, "confirmed", {
  at: now,
  confirmation_source: "reader_ui",
});

const resolvedOutput = path.resolve(outputFile);
mkdirSync(path.dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(confirmed, null, 2)}\n`, "utf8");
