import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES,
  composeAutomaticBuildExecutorPrompt,
  type AutomaticBuildExecutorPromptMode,
} from "./executor-prompt";

export const AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES = [
  "pass1-local-extractor.md",
  "paper-metadata-extractor.md",
  "paper-lexicon-extractor.md",
  "profile-sidecar-extractor.md",
  "pass2-longrange-linker.md",
  "book-structure-extractor.md",
] as const;

export type AutomaticBuildExtractorPromptName =
  (typeof AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES)[number];

interface ExecutorPromptCliIo {
  write_stdout: (text: string) => void;
  write_stderr: (text: string) => void;
}

class ExecutorPromptCliUsageError extends Error {}

function isExtractorPromptName(value: string): value is AutomaticBuildExtractorPromptName {
  return (AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES as readonly string[]).includes(value);
}

function parseExecutorPromptArgs(argv: string[]): {
  extractor_name: AutomaticBuildExtractorPromptName;
  mode: AutomaticBuildExecutorPromptMode;
} {
  const extractorName = argv[0] ?? "";
  if (!isExtractorPromptName(extractorName)) {
    throw new ExecutorPromptCliUsageError(`unsupported extractor prompt: ${extractorName}`);
  }
  if (argv.length === 1) return { extractor_name: extractorName, mode: "task" };
  if (argv.length !== 3 || argv[1] !== "--executor-protocol") {
    throw new ExecutorPromptCliUsageError(
      "usage: executor-prompt-cli <extractor-name> [--executor-protocol dispatch|task]",
    );
  }
  const mode = argv[2] ?? "";
  if (!(AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES as readonly string[]).includes(mode)) {
    throw new ExecutorPromptCliUsageError(`unsupported executor protocol: ${mode}`);
  }
  return { extractor_name: extractorName, mode: mode as AutomaticBuildExecutorPromptMode };
}

function pluginRoot(): string {
  return process.env.UNDERSTAND_BOOK_PLUGIN_ROOT
    ? path.resolve(process.env.UNDERSTAND_BOOK_PLUGIN_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function runAutomaticBuildExecutorPromptCli(
  argv: string[],
  io: ExecutorPromptCliIo = {
    write_stdout: (text) => process.stdout.write(text),
    write_stderr: (text) => process.stderr.write(text),
  },
): number {
  try {
    const parsed = parseExecutorPromptArgs(argv);
    const agentsDir = path.join(pluginRoot(), "agents");
    const extractorPrompt = readFileSync(path.join(agentsDir, parsed.extractor_name), "utf8");
    const protocolWrapper = parsed.mode === "dispatch"
      ? readFileSync(path.join(agentsDir, "automatic-build-dispatch-executor.md"), "utf8")
      : "";
    io.write_stdout(composeAutomaticBuildExecutorPrompt({
      mode: parsed.mode,
      extractor_name: parsed.extractor_name,
      extractor_prompt: extractorPrompt,
      protocol_wrapper: protocolWrapper,
    }));
    return 0;
  } catch (error) {
    if (error instanceof ExecutorPromptCliUsageError) {
      io.write_stderr(`${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.write_stderr(`failed to compose automatic build executor prompt: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runAutomaticBuildExecutorPromptCli(process.argv.slice(2));
}
