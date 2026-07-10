// PH9 natural-language sidecar planning:
// draft confirmable sidecar_plan.json/form_draft.json before any custom sidecar generation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileSidecarBuildSpec,
  confirmSidecarPlan,
  draftSidecarPlan,
  type SidecarTargetView,
} from "../../packages/core/src/sidecar-plan";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--request", "--target-view", "--lids", "--sections", "--now"]);
const BOOL_FLAGS = new Set(["--confirm"]);
const opts: Record<string, string | undefined> = {};
const bools = new Set<string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg)) {
    opts[arg] = args[++i];
  } else if (arg.startsWith("--")) {
    if (!BOOL_FLAGS.has(arg)) {
      console.error(`unknown option ${arg}`);
      process.exit(2);
    }
    bools.add(arg);
  } else {
    positional.push(arg);
  }
}

const bookDir = positional[0];
const request = opts["--request"];
const targetView = opts["--target-view"] as SidecarTargetView | undefined;
const allowedTargetViews = new Set<SidecarTargetView>(["timeline", "concept_map", "comparison_table", "argument_map", "custom"]);
if (!bookDir || !request || (targetView && !allowedTargetViews.has(targetView))) {
  console.error(
    "usage: tsx skills/build/sidecar-plan.ts <book_dir> --request <text> [--target-view timeline|concept_map|comparison_table|argument_map|custom] [--lids a,b] [--sections a,b] [--confirm] [--now iso]",
  );
  process.exit(2);
}

function readBookId(dir: string): string {
  const basePath = path.join(dir, "base.json");
  if (existsSync(basePath)) {
    const base = JSON.parse(readFileSync(basePath, "utf8")) as { book_id?: unknown };
    if (typeof base.book_id === "string" && base.book_id.trim()) return base.book_id;
  }
  const inputManifestPath = path.join(dir, ".build", "input", "manifest.json");
  if (existsSync(inputManifestPath)) {
    const manifest = JSON.parse(readFileSync(inputManifestPath, "utf8")) as { book_id?: unknown };
    if (typeof manifest.book_id === "string" && manifest.book_id.trim()) return manifest.book_id;
  }
  return path.basename(path.resolve(dir));
}

function splitList(value: string | undefined): string[] | undefined {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

const resolvedBookDir = path.resolve(bookDir);
const bookId = readBookId(resolvedBookDir);
const lids = splitList(opts["--lids"]);
const sections = splitList(opts["--sections"]);
const sourceScope = lids || sections ? { ...(lids ? { lids } : {}), ...(sections ? { sections } : {}) } : { whole_book: true };
const plan = draftSidecarPlan({
  book_id: bookId,
  user_request: request,
  source_scope: sourceScope,
  ...(targetView ? { target_view: targetView } : {}),
  now: opts["--now"],
});
const finalPlan = bools.has("--confirm") ? confirmSidecarPlan(plan, opts["--now"] ?? new Date().toISOString()) : plan;

const outDir = path.join(resolvedBookDir, ".build", "sidecar-plan");
mkdirSync(outDir, { recursive: true });
const planPath = path.join(outDir, "sidecar_plan.json");
const formPath = path.join(outDir, "form_draft.json");
writeFileSync(planPath, JSON.stringify(finalPlan, null, 2), "utf8");
writeFileSync(formPath, JSON.stringify(finalPlan.form_draft, null, 2), "utf8");

console.log(`[sidecar-plan] bookId=${bookId} status=${finalPlan.status}`);
console.log(`  plan: ${planPath}`);
console.log(`  form: ${formPath}`);

if (finalPlan.status === "confirmed") {
  const spec = compileSidecarBuildSpec(finalPlan);
  const specPath = path.join(outDir, "sidecar_build_spec.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
  console.log(`  spec: ${specPath}`);
} else {
  console.log("  sidecar generation blocked until the plan is confirmed");
}
