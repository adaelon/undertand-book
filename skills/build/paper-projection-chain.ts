// PH8 paper projection chain:
// trusted .understand-book/<book_id>/source.txt -> existing paper sidecar batches.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertPaperProjectionWorkspaceTarget,
  buildPaperProjectionChainPlan,
  type PaperProjectionChainPlan,
  type PaperProjectionChainStage,
} from "../../packages/core/src/paper-projection-chain";
import { resolveContentProfile } from "../../packages/core/src/content-profile";
import {
  buildBookStructureStitchArtifact,
  buildBookStructureStitchPacket,
  buildBookStructureUnitArtifact,
  type BookStructureCandidate,
  type BookStructureUnitArtifact,
} from "../../packages/core/src/book-structure";
import {
  loadBookStructureBuildContext,
  stitchArtifactPath,
  unitArtifactPath,
} from "./book-structure-common";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--paper-subtype"]);
const BOOL_FLAGS = new Set(["--allow-partial", "--run", "--seed-book-structure-smoke", "--skip-reading-guide-smoke"]);
const opts: Record<string, string | undefined> = {};
const positional: string[] = [];
const bools = new Set<string>();
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
const paperSubtype = opts["--paper-subtype"] ?? "research_article";
if (!bookDir || (paperSubtype !== "research_article" && paperSubtype !== "survey")) {
  console.error(
    "usage: tsx skills/build/paper-projection-chain.ts <.understand-book/book_id> [--paper-subtype research_article|survey] [--allow-partial] [--run] [--seed-book-structure-smoke] [--skip-reading-guide-smoke]",
  );
  process.exit(2);
}

function spawnCommand(stage: PaperProjectionChainStage): { command: string; args: string[] } {
  if (stage.command === "pnpm" && stage.args[0] === "exec" && stage.args[1] === "tsx") {
    return {
      command: process.execPath,
      args: [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), ...stage.args.slice(2)],
    };
  }
  return { command: stage.command, args: stage.args };
}

function runStage(stage: PaperProjectionChainStage): void {
  const child = spawnCommand(stage);
  const result = spawnSync(child.command, child.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function seedBookStructureSmokeArtifacts(plan: PaperProjectionChainPlan): void {
  const profile = resolveContentProfile("paper", { paper_subtype: plan.paper_subtype });
  const ctx = loadBookStructureBuildContext(plan.trusted_source_path, plan.book_id, profile);
  const unitArtifacts: BookStructureUnitArtifact[] = [];
  mkdirSync(ctx.unitDir, { recursive: true });

  ctx.unitSources.forEach((source, index) => {
    const evidenceLid = source.leaf_lids[0] ?? source.unit_lid;
    const excerpt = source.excerpts.find((item) => item.lid === evidenceLid)?.text.trim() ?? "Smoke fixture unit.";
    const artifact = buildBookStructureUnitArtifact(source, {
      unit_card: {
        unit_lid: source.unit_lid,
        role: index === 0 ? "setup" : "application",
        summary: {
          text: excerpt.slice(0, 160) || "Smoke fixture unit.",
          evidence_lids: [evidenceLid],
        },
        candidate_key_stops: [],
        depends_on: index === 0 ? [] : [ctx.unitSources[index - 1].unit_lid],
        evidence_lids: [evidenceLid],
      },
    });
    unitArtifacts.push(artifact);
    writeFileSync(unitArtifactPath(ctx, source.unit_lid), JSON.stringify(artifact, null, 2), "utf8");
  });

  const stitchPacket = buildBookStructureStitchPacket(unitArtifacts, ctx.pass2Audit, profile);
  const stitchOutput: BookStructureCandidate = {
    spine: unitArtifacts.map((artifact) => ({
      lid: artifact.output.unit_card.unit_lid,
      role: artifact.output.unit_card.role,
      summary: artifact.output.unit_card.summary,
      key_stop_ids: [],
      depends_on: artifact.output.unit_card.depends_on,
    })),
    throughlines: [],
    key_stops: [],
  };
  const stitchArtifact = buildBookStructureStitchArtifact(stitchPacket, stitchOutput);
  mkdirSync(ctx.buildDir, { recursive: true });
  writeFileSync(stitchArtifactPath(ctx), JSON.stringify(stitchArtifact, null, 2), "utf8");
  console.log(`[paper-projection-chain] seeded BookStructure smoke artifacts units=${unitArtifacts.length}`);
}

const plan = buildPaperProjectionChainPlan(bookDir, {
  allow_partial: bools.has("--allow-partial"),
  paper_subtype: paperSubtype,
});
const planDir = path.join(plan.book_dir, ".build", "paper-projection-chain");
mkdirSync(planDir, { recursive: true });
const planPath = path.join(planDir, "plan.json");
writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");

console.log(`[paper-projection-chain] bookId=${plan.book_id}`);
console.log(`  trusted source: ${plan.trusted_source_path}`);
console.log(`  plan: ${planPath}`);
for (const stage of plan.stages) {
  console.log(`  stage ${stage.stage}: ${stage.kind}`);
}

if (!bools.has("--run")) process.exit(0);

assertPaperProjectionWorkspaceTarget(plan);
for (const stage of plan.stages) {
  if (stage.stage === "book_structure" && bools.has("--seed-book-structure-smoke")) {
    seedBookStructureSmokeArtifacts(plan);
  }
  if (stage.stage === "paper_reading_guide" && bools.has("--skip-reading-guide-smoke")) {
    console.log("[paper-projection-chain] skipped PaperReadingGuide smoke");
    continue;
  }
  console.log(`[paper-projection-chain] running ${stage.stage}`);
  runStage(stage);
}
