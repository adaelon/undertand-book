import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAutomaticBuildSnapshot,
  nextAutomaticBuildAction,
  resolveAutomaticBuildTarget,
  type AutomaticBuildStage,
  type AutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";

const PLUGIN_ROOT = process.env.UNDERSTAND_BOOK_PLUGIN_ROOT
  ? path.resolve(process.env.UNDERSTAND_BOOK_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_CLI = path.join(PLUGIN_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAX_ATTEMPTS = 3;

interface AttemptRecord {
  failures: number;
  last_error?: string;
  updated_at: string;
}

interface AttemptLedger {
  version: "automatic_build_attempts.v1";
  stages: Partial<Record<AutomaticBuildStage, Record<string, AttemptRecord>>>;
}

interface StageCommands {
  input?: string;
  write?: string;
  close: string | null;
  prompt?: string;
}

const STAGE_COMMANDS: Record<AutomaticBuildStage, StageCommands> = {
  pass1: { input: "emit-input.ts", write: "pass1-write.ts", close: "pass1-batch.ts", prompt: "pass1-local-extractor.md" },
  paper_metadata: { input: "paper-metadata-input.ts", write: "paper-metadata-write.ts", close: "paper-metadata-batch.ts", prompt: "paper-metadata-extractor.md" },
  paper_lexicon: { input: "paper-lexicon-input.ts", write: "paper-lexicon-write.ts", close: "paper-lexicon-batch.ts", prompt: "paper-lexicon-extractor.md" },
  profile_sidecar: { input: "profile-sidecar-input.ts", write: "profile-sidecar-write.ts", close: "profile-sidecar-batch.ts", prompt: "profile-sidecar-extractor.md" },
  pass2: { input: "pass2-input.ts", write: "pass2-write.ts", close: "pass2-batch.ts", prompt: "pass2-longrange-linker.md" },
  book_structure: { input: "book-structure-input.ts", write: "book-structure-write.ts", close: "book-structure-batch.ts", prompt: "book-structure-extractor.md" },
  paper_reading_guide: { close: null },
};

function scriptCommand(script: string, args: string[]): string[] {
  const sidecar = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
  if (sidecar) {
    return script === "automatic-build.ts"
      ? [sidecar, ...args]
      : [sidecar, "run-script", script, ...args];
  }
  return [process.execPath, TSX_CLI, path.join(PLUGIN_ROOT, "skills", "build", script), ...args];
}

function commonArgs(target: AutomaticBuildTarget): string[] {
  const result = [target.source_path, "--book-id", target.book_id, "--content-profile", target.profile_id];
  if (target.profile_id === "paper") result.push("--paper-subtype", "research_article");
  return result;
}

function attemptLedgerPath(target: AutomaticBuildTarget): string {
  return path.join(target.workspace_dir, ".build", "automatic-build", "attempts.json");
}

function readAttemptLedger(target: AutomaticBuildTarget): AttemptLedger {
  const file = attemptLedgerPath(target);
  if (!existsSync(file)) return { version: "automatic_build_attempts.v1", stages: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as AttemptLedger;
  if (parsed.version !== "automatic_build_attempts.v1" || !parsed.stages) {
    throw new Error(`invalid automatic build attempt ledger: ${file}`);
  }
  return parsed;
}

function writeAttemptLedger(target: AutomaticBuildTarget, ledger: AttemptLedger): void {
  const file = attemptLedgerPath(target);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

export function recordAutomaticBuildAttempt(
  target: AutomaticBuildTarget,
  stage: AutomaticBuildStage,
  taskId: string,
  outcome: "failure" | "success" | "reset",
  error?: string,
): AttemptRecord | undefined {
  const ledger = readAttemptLedger(target);
  const stageAttempts = ledger.stages[stage] ?? {};
  if (outcome === "failure") {
    stageAttempts[taskId] = {
      failures: (stageAttempts[taskId]?.failures ?? 0) + 1,
      last_error: error,
      updated_at: new Date().toISOString(),
    };
    ledger.stages[stage] = stageAttempts;
  } else {
    delete stageAttempts[taskId];
    if (Object.keys(stageAttempts).length) ledger.stages[stage] = stageAttempts;
    else delete ledger.stages[stage];
  }
  writeAttemptLedger(target, ledger);
  return stageAttempts[taskId];
}

function expandAction(target: AutomaticBuildTarget, maxParallel: number) {
  const snapshot = buildAutomaticBuildSnapshot(target);
  const action = nextAutomaticBuildAction(snapshot, maxParallel);
  if (action.kind === "extract") {
    const attempts = readAttemptLedger(target).stages[action.stage] ?? {};
    const exhausted = action.task_ids
      .map((taskId) => ({ task_id: taskId, ...attempts[taskId] }))
      .filter((item) => (item.failures ?? 0) >= MAX_ATTEMPTS);
    if (exhausted.length) {
      return {
        snapshot,
        action: {
          kind: "needs_user",
          reason: "retry_exhausted",
          stage: action.stage,
          tasks: exhausted,
          message: `semantic extraction failed ${MAX_ATTEMPTS} times; inspect diagnostics before resetting`,
          reset_commands: exhausted.map((item) => scriptCommand("automatic-build.ts", [
            "record-attempt", target.source_path, action.stage, item.task_id, "reset",
            "--root", target.root_dir,
          ])),
        },
      };
    }
    const spec = STAGE_COMMANDS[action.stage];
    if (!spec.input || !spec.write || !spec.prompt) throw new Error(`stage ${action.stage} is not a semantic extraction stage`);
    return {
      snapshot,
      action: {
        ...action,
        cwd: target.root_dir,
        extractor_prompt: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? undefined
          : path.join(PLUGIN_ROOT, "agents", spec.prompt),
        extractor_prompt_command: process.env.UNDERSTAND_BOOK_SIDECAR_SELF
          ? [process.env.UNDERSTAND_BOOK_SIDECAR_SELF, "prompt", spec.prompt]
          : undefined,
        tasks: action.task_ids.map((taskId) => ({
          task_id: taskId,
          attempt_number: (attempts[taskId]?.failures ?? 0) + 1,
          input_command: scriptCommand(spec.input!, [target.source_path, taskId, ...commonArgs(target).slice(1)]),
          write_command: scriptCommand(spec.write!, [target.source_path, taskId, "{output_json}", ...commonArgs(target).slice(1)]),
          record_failure_command: scriptCommand("automatic-build.ts", [
            "record-attempt", target.source_path, action.stage, taskId, "failure",
            "--root", target.root_dir, "--message", "{diagnostic}",
          ]),
          record_success_command: scriptCommand("automatic-build.ts", [
            "record-attempt", target.source_path, action.stage, taskId, "success",
            "--root", target.root_dir,
          ]),
        })),
      },
    };
  }
  if (action.kind === "close_stage") {
    if (action.stage === "paper_reading_guide") {
      return {
        snapshot,
        action: {
          ...action,
          cwd: target.root_dir,
          command: scriptCommand("verify-paper-reading-guide.ts", [target.workspace_dir]),
          verification_path: path.join(target.workspace_dir, ".build", "paper-reading-guide", "verification.json"),
        },
      };
    }
    const closeScript = STAGE_COMMANDS[action.stage].close;
    if (!closeScript) throw new Error(`stage ${action.stage} has no close command`);
    const args = commonArgs(target);
    if (action.stage === "pass1" && target.kind === "paper_workspace") {
      args.push("--preserve-foundation", target.workspace_dir);
    }
    return {
      snapshot,
      action: { ...action, cwd: target.root_dir, command: scriptCommand(closeScript, args) },
    };
  }
  return { snapshot, action };
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function automaticBuildNext(targetInput: string, rootDir: string, maxParallel = 5) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  return {
    version: "automatic_build_next.v1",
    ...expandAction(target, maxParallel),
  };
}

const argv = process.argv.slice(2);
if (argv[0] === "next") {
  const targetInput = argv[1];
  if (!targetInput) {
    console.error("usage: tsx skills/build/automatic-build.ts next <target> [--root <dir>] [--max-parallel <n>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const maxParallel = Number(valueArg(argv, "--max-parallel") ?? "5");
  console.log(JSON.stringify(automaticBuildNext(targetInput, rootDir, maxParallel), null, 2));
} else if (argv[0] === "record-attempt") {
  const [targetInput, stageValue, taskId, outcomeValue] = argv.slice(1, 5);
  const stages: AutomaticBuildStage[] = ["pass1", "paper_metadata", "paper_lexicon", "profile_sidecar", "pass2", "book_structure", "paper_reading_guide"];
  if (!targetInput || !stages.includes(stageValue as AutomaticBuildStage) || !taskId
    || !["failure", "success", "reset"].includes(outcomeValue)) {
    console.error("usage: tsx skills/build/automatic-build.ts record-attempt <target> <stage> <task> <failure|success|reset> [--root <dir>] [--message <text>]");
    process.exit(2);
  }
  const rootDir = path.resolve(valueArg(argv, "--root") ?? process.cwd());
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const record = recordAutomaticBuildAttempt(
    target,
    stageValue as AutomaticBuildStage,
    taskId,
    outcomeValue as "failure" | "success" | "reset",
    valueArg(argv, "--message"),
  );
  console.log(JSON.stringify({ version: "automatic_build_attempt_record.v1", stage: stageValue, task_id: taskId, record }, null, 2));
}
