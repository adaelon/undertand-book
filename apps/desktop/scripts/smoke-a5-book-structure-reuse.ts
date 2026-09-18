import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveAutomaticBuildTarget, prepareAutomaticBuildSnapshot } from "../../../packages/core/src/build-orchestrator";
import { readBookStructureGenerationArtifact, type BookStructureGenerationTaskV1 } from "../../../packages/core/src/book-structure-generation";
import { automaticBuildGenerationArtifactPath } from "../../../packages/core/src/semantic-artifact";
import type { BookStructureCandidate, BookStructureStitchFragmentInputV1 } from "../../../packages/core/src/book-structure";

// A storage overlay preserves frozen target identities; no task, digest, lease,
// artifact or receipt is rewritten to pretend the copy is a different book.
// This is an acceptance harness, not a supported workspace relocation operation.
const [source, library, destination] = process.argv.slice(2);
if (!source || !library || !destination) throw Error("usage: tsx smoke-a5-book-structure-reuse.ts <source> <library> <new-output-directory>");
const original = resolveAutomaticBuildTarget(source, library);
const output = path.resolve(destination);
assert(!existsSync(output), "use a new isolated output directory");
assert(!output.startsWith(path.resolve(original.workspace_dir) + path.sep));
mkdirSync(output, { recursive: true });
const copy = path.join(output, "workspace");
mkdirSync(copy);
console.log("Copying build state into the isolated storage overlay.");
for (const entry of readdirSync(original.workspace_dir, { withFileTypes: true })) {
  if (entry.isFile() || entry.name === ".build") cpSync(path.join(original.workspace_dir, entry.name), path.join(copy, entry.name), { recursive: entry.isDirectory() });
}
const target = { ...original, workspace_dir: copy };
const tasksDir = path.join(copy, ".build/automatic-build/v4/tasks/book_structure/book-structure-stitch-fragment.full.v4");
const before = new Map<string, Buffer>();
function retain(relative: string) { before.set(relative, readFileSync(path.join(copy, relative))); }
function retainTree(relative: string) {
  const dir = path.join(copy, relative);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) retainTree(next); else retain(next);
  }
}
for (const name of ["v4/tasks/book_structure", "v3/artifacts/book_structure", "v2/tasks/book_structure", "v4/policies/book_structure", "v2/legacy-plans"]) {
  retainTree(path.join(".build/automatic-build", name));
}
const admissions = readdirSync(tasksDir).map(file => {
  const task = JSON.parse(readFileSync(path.join(tasksDir, file), "utf8")) as BookStructureGenerationTaskV1;
  const artifact = readBookStructureGenerationArtifact(target, task);
  assert(artifact);
  const input = task.input as BookStructureStitchFragmentInputV1;
  const candidate = artifact.payload as BookStructureCandidate;
  const missing = input.unit_cards.map(card => card.unit_lid).filter(lid => candidate.spine?.filter(unit => unit.lid === lid).length !== 1);
  const artifactFile = automaticBuildGenerationArtifactPath(target, "book_structure", task.policy_generation_id, task.descriptor.work_unit_id);
  assert(readFileSync(artifactFile).equals(readFileSync(path.join(original.workspace_dir, path.relative(copy, artifactFile)))));
  return { work_unit_id: task.descriptor.work_unit_id, identity_fresh: true, core_units: input.unit_cards.length,
    accepted_for_append: missing.length === 0, missing_or_duplicate_core_lids: missing };
});
assert.equal(admissions.length, 29);
console.log(JSON.stringify({ local_results: admissions.length, complete_sources: admissions.filter(item => item.accepted_for_append).length,
  incomplete_sources: admissions.filter(item => !item.accepted_for_append) }));
console.log("Preparing the current production route against the copy; original frozen identities are retained.");
const started = Date.now();
const routed = prepareAutomaticBuildSnapshot(target, "book_structure");
assert.equal(routed.status, "blocked");
if (routed.status !== "blocked") throw Error("expected the known incomplete source to prevent publication");
assert.equal(routed.recovery.code, "source_slice_coverage_invalid");
assert.deepEqual(routed.recovery.affected_work_units, admissions.filter(item => !item.accepted_for_append)
  .map(item => ({ work_unit_id: item.work_unit_id, evidence_lids: item.missing_or_duplicate_core_lids })));
for (const [relative, bytes] of before) {
  assert(readFileSync(path.join(copy, relative)).equals(bytes), `copied history changed: ${relative}`);
  assert(readFileSync(path.join(original.workspace_dir, relative)).equals(bytes), `original history changed: ${relative}`);
}
const registry = path.join(process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT ?? path.join(tmpdir(), "understand-book-automatic-build-driver-v1"), "invocations");
const invocations = existsSync(registry) ? readdirSync(registry).flatMap(file => {
  const record = JSON.parse(readFileSync(path.join(registry, file), "utf8"));
  if (path.resolve(record.initial_target_ref?.workspace_dir ?? ".") !== path.resolve(original.workspace_dir)) return [];
  const plan = JSON.parse(readFileSync(record.input.build_plan_path, "utf8"));
  return [{ invocation_ref: record.invocation_ref, created_at: record.input.created_at, plan_version: plan.version,
    plan_digest_unchanged: plan.plan_digest === record.initial_build_plan_digest,
    binds_internal_descriptor_plan: "descriptor_plan_digest" in plan || "descriptor_plan_digest" in record }];
}) : [];
const report = { date: "2026-09-14", source_workspace: original.workspace_dir, storage_overlay: copy,
  original_workspace_modified: false, original_invocation_executed: false, semantic_model_calls: 0,
  admissions, production_recovery: routed.recovery, historical_files_unchanged: before.size,
  old_reduce_artifacts: [...before.keys()].filter(file => file.includes("v3") && file.includes("book-structure-stitch-reduce.full.v4")).length,
  prior_public_file_present: existsSync(path.join(copy, "book_structure.json")), invocations,
  production_prepare_elapsed_ms: Date.now() - started };
writeFileSync(path.join(output, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ report: path.join(output, "evidence.json"), history_unchanged: before.size, recovery: routed.recovery.code }));
