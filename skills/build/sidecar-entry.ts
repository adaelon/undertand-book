import bookStructurePrompt from "../../agents/book-structure-extractor.md";
import canvasGeometry from "@napi-rs/canvas/geometry.js";
import paperLexiconPrompt from "../../agents/paper-lexicon-extractor.md";
import paperMetadataPrompt from "../../agents/paper-metadata-extractor.md";
import pass1Prompt from "../../agents/pass1-local-extractor.md";
import pass2Prompt from "../../agents/pass2-longrange-linker.md";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import profileSidecarPrompt from "../../agents/profile-sidecar-extractor.md";

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvasGeometry.DOMMatrix as typeof DOMMatrix;

const argv = process.argv.slice(2);
const command = argv[0];

const PROMPTS: Record<string, string> = {
  "book-structure-extractor.md": bookStructurePrompt,
  "paper-lexicon-extractor.md": paperLexiconPrompt,
  "paper-metadata-extractor.md": paperMetadataPrompt,
  "pass1-local-extractor.md": pass1Prompt,
  "pass2-longrange-linker.md": pass2Prompt,
  "profile-sidecar-extractor.md": profileSidecarPrompt,
};

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
  const prompt = argv[1] ? PROMPTS[argv[1]] : undefined;
  if (!prompt) {
    console.error(`unsupported extractor prompt: ${argv[1] ?? ""}`);
    process.exit(2);
  }
  process.stdout.write(prompt);
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
} else if (command === "intent.plan") {
  prepare("intent-plan.ts", forwardedArgs(1));
  await import("./intent-plan");
} else if (command === "intent.artifact") {
  prepare("intent-artifact.ts", forwardedArgs(1));
  await import("./intent-artifact");
} else if (command === "intent.metrics") {
  prepare("intent-metrics.ts", forwardedArgs(1));
  await import("./intent-metrics");
} else {
  console.error("usage: understand-book-build <legacy-plan|protocol-doctor|plan|next|dispatch.next|dispatch.inspect|dispatch.finish|audit-legacy|migration-mode|quality|metrics|record-attempt|heartbeat|candidate|submit|legacy-submit|fail|inspect|input|write|close|run-script|prompt|workbench-stage|intent.plan|intent.artifact|intent.metrics> [...args]");
  process.exit(2);
}
