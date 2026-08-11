import { createHash } from "node:crypto";
import bookStructurePrompt from "../../agents/book-structure-extractor.md";
import dispatchExecutorPrompt from "../../agents/automatic-build-dispatch-executor.md";
import canvasGeometry from "@napi-rs/canvas/geometry.js";
import paperLexiconPrompt from "../../agents/paper-lexicon-extractor.md";
import paperMetadataPrompt from "../../agents/paper-metadata-extractor.md";
import pass1Prompt from "../../agents/pass1-local-extractor.md";
import pass1SourceFragmentPrompt from "../../agents/pass1-source-fragment-extractor.md";
import pass1LidStitcherPrompt from "../../agents/pass1-lid-stitcher.md";
import pass2Prompt from "../../agents/pass2-longrange-linker.md";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import profileSidecarDiscourseFragmentPrompt from "../../agents/profile-sidecar-discourse-fragment-extractor.md";
import profileSidecarDiscourseReducerPrompt from "../../agents/profile-sidecar-discourse-reducer.md";
import profileSidecarPrompt from "../../agents/profile-sidecar-extractor.md";
import { AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1 } from "../../packages/core/src/automatic-build-protocol";
import {
  AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES,
  composeAutomaticBuildExecutorPrompt,
  type AutomaticBuildExecutorPromptMode,
} from "./executor-prompt";

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvasGeometry.DOMMatrix as typeof DOMMatrix;

const argv = process.argv.slice(2);
const command = argv[0];

const PROMPTS: Record<string, string> = {
  "book-structure-extractor.md": bookStructurePrompt,
  "paper-lexicon-extractor.md": paperLexiconPrompt,
  "paper-metadata-extractor.md": paperMetadataPrompt,
  "pass1-local-extractor.md": pass1Prompt,
  "pass1-source-fragment-extractor.md": pass1SourceFragmentPrompt,
  "pass1-lid-stitcher.md": pass1LidStitcherPrompt,
  "pass2-longrange-linker.md": pass2Prompt,
  "profile-sidecar-discourse-fragment-extractor.md": profileSidecarDiscourseFragmentPrompt,
  "profile-sidecar-discourse-reducer.md": profileSidecarDiscourseReducerPrompt,
  "profile-sidecar-extractor.md": profileSidecarPrompt,
};

function releaseValidatedPrompt(promptName: string, prompt: string): string {
  const releaseHashes = new Set(AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1
    .filter((member) => member.prompt_name === promptName)
    .map((member) => member.prompt_sha256));
  if (releaseHashes.size > 1) {
    throw new Error("packaged extractor prompt has conflicting release hashes");
  }
  const expected = releaseHashes.values().next().value as string | undefined;
  if (expected !== undefined
    && createHash("sha256").update(prompt, "utf8").digest("hex") !== expected) {
    throw new Error("packaged extractor prompt does not match its release hash");
  }
  return prompt;
}

function forwardedArgs(offset: number): string[] {
  return argv.slice(offset);
}

function prepare(scriptName: string, args: string[]): void {
  process.env.UNDERSTAND_BOOK_SIDECAR_SELF = process.execPath;
  const pluginRootIndex = args.indexOf("--plugin-root");
  if (pluginRootIndex >= 0 && args[pluginRootIndex + 1]) {
    process.env.UNDERSTAND_BOOK_PLUGIN_ROOT = args[pluginRootIndex + 1];
    args.splice(pluginRootIndex, 2);
  }
  process.argv = [process.execPath, scriptName, ...args];
}

async function runScript(script: string, args: string[]): Promise<void> {
  prepare(script, args);
  switch (script) {
    case "emit-input.ts": await import("./emit-input"); break;
    case "pass1-write.ts": await import("./pass1-write"); break;
    case "pass1-batch.ts": await import("./pass1-batch"); break;
    case "paper-metadata-input.ts": await import("./paper-metadata-input"); break;
    case "paper-metadata-write.ts": await import("./paper-metadata-write"); break;
    case "paper-metadata-batch.ts": await import("./paper-metadata-batch"); break;
    case "paper-lexicon-input.ts": await import("./paper-lexicon-input"); break;
    case "paper-lexicon-write.ts": await import("./paper-lexicon-write"); break;
    case "paper-lexicon-batch.ts": await import("./paper-lexicon-batch"); break;
    case "profile-sidecar-input.ts": await import("./profile-sidecar-input"); break;
    case "profile-sidecar-write.ts": await import("./profile-sidecar-write"); break;
    case "profile-sidecar-batch.ts": await import("./profile-sidecar-batch"); break;
    case "pass2-input.ts": await import("./pass2-input"); break;
    case "pass2-write.ts": await import("./pass2-write"); break;
    case "pass2-batch.ts": await import("./pass2-batch"); break;
    case "book-structure-input.ts": await import("./book-structure-input"); break;
    case "book-structure-write.ts": await import("./book-structure-write"); break;
    case "book-structure-batch.ts": await import("./book-structure-batch"); break;
    case "verify-paper-reading-guide.ts": await import("./verify-paper-reading-guide"); break;
    case "workbench-stage-runner.ts": await import("./workbench-stage-runner"); break;
    default:
      console.error(`unsupported sidecar script: ${script}`);
      process.exit(2);
  }
}

if (command === "prompt") {
  const promptName = argv[1] ?? "";
  const registeredPrompt = PROMPTS[promptName];
  if (!registeredPrompt) {
    console.error(`unsupported extractor prompt: ${promptName}`);
    process.exit(2);
  }
  let prompt = registeredPrompt;
  try {
    prompt = releaseValidatedPrompt(promptName, registeredPrompt);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "packaged extractor prompt validation failed");
    process.exit(2);
  }
  if (argv.length === 2) {
    process.stdout.write(prompt);
  } else {
    const mode = argv[2] === "--executor-protocol" ? argv[3] : undefined;
    if (argv.length !== 4
      || !mode
      || !(AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES as readonly string[]).includes(mode)) {
      console.error("usage: understand-book-build prompt <extractor-name> [--executor-protocol dispatch|task]");
      process.exit(2);
    }
    process.stdout.write(composeAutomaticBuildExecutorPrompt({
      mode: mode as AutomaticBuildExecutorPromptMode,
      extractor_name: promptName,
      extractor_prompt: prompt,
      protocol_wrapper: mode === "dispatch" ? dispatchExecutorPrompt : "",
    }));
  }
} else if ([
  "protocol-doctor",
  "legacy-plan",
  "plan",
  "next",
  "dispatch.next",
  "dispatch.inspect",
  "dispatch.finish",
  "audit-legacy",
  "migration-mode",
  "quality",
  "metrics",
  "record-attempt",
  "heartbeat",
  "candidate",
  "submit",
  "legacy-submit",
  "fail",
  "inspect",
  "input",
  "write",
  "close",
].includes(command ?? "")) {
  prepare("automatic-build.ts", argv);
  await import("./automatic-build");
} else if (command === "run-script") {
  const script = argv[1];
  if (!script) {
    console.error("usage: understand-book-build run-script <script> [...args]");
    process.exit(2);
  }
  await runScript(script, forwardedArgs(2));
} else if (command === "workbench-stage") {
  await runScript("workbench-stage-runner.ts", forwardedArgs(1));
} else if (command === "build.step") {
  if (argv.length !== 1) {
    console.error("usage: understand-book-build build.step < request.json");
    process.exit(2);
  }
  prepare("automatic-build-driver.ts", []);
  await import("./automatic-build-driver");
} else if (command === "executor.open" || command === "executor.session") {
  if (argv.length !== 1) {
    console.error(`usage: understand-book-build ${command} < request.json`);
    process.exit(2);
  }
  prepare("automatic-build-executor-session.ts", []);
  await import("../../packages/core/src/automatic-build-executor-session");
} else if (command === "intent.plan") {
  prepare("intent-plan.ts", forwardedArgs(1));
  await import("./intent-plan");
} else if (command === "intent.artifact") {
  prepare("intent-artifact.ts", forwardedArgs(1));
  await import("./intent-artifact");
} else if (command === "intent.metrics") {
  prepare("intent-metrics.ts", forwardedArgs(1));
  await import("./intent-metrics");
} else if (command === "intent.blueprint") {
  prepare("intent-blueprint.ts", forwardedArgs(1));
  await import("./intent-blueprint");
} else {
  console.error("usage: understand-book-build <legacy-plan|protocol-doctor|plan|next|dispatch.next|dispatch.inspect|dispatch.finish|audit-legacy|migration-mode|quality|metrics|record-attempt|heartbeat|candidate|submit|legacy-submit|fail|inspect|input|write|close|run-script|prompt|workbench-stage|build.step|executor.open|executor.session|intent.plan|intent.artifact|intent.metrics|intent.blueprint> [...args]");
  process.exit(2);
}
