import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_EXECUTOR_PROMPT_SEPARATOR,
  composeAutomaticBuildExecutorPrompt,
} from "../../../skills/build/executor-prompt";
import {
  AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES,
  AUTOMATIC_BUILD_SHADOW_EXTRACTOR_PROMPT_NAMES,
  runAutomaticBuildExecutorPromptCli,
} from "../../../skills/build/executor-prompt-cli";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function normalizeBootstrapContract(text: string): string {
  return text.replace(/\r\n?|\n/gu, "\n").replace(/\n+$/u, "");
}

describe("automatic build executor prompt", () => {
  it("keeps one complete canonical bootstrap body for future role projections", () => {
    const wrapper = normalizeBootstrapContract(readFileSync(
      path.join(REPO_ROOT, "agents", "automatic-build-dispatch-executor.md"),
      "utf8",
    ));
    for (const marker of [
      "automatic_build_executor_session.v3",
      "automatic_build_executor_open_request.v3",
      "understand_book_build_executor",
      "executor.open",
      "executor.input.next",
      "executor.generation.start",
      "executor.submit_candidate",
      "action.kind=DELIVER_INPUT",
      "action.kind=INPUT_CHUNK",
      "previous_chunk_ordinal",
      "action.kind=GENERATION_GRANT",
      "action.kind=GENERATE",
      "action.kind=WAIT",
      "action.kind=DONE",
      "Never return candidate JSON to the caller",
      "user actively inspects this dedicated child thread",
    ]) {
      expect(wrapper).toContain(marker);
    }
    expect(wrapper).toMatch(/Make exactly one executor MCP\s+call per tool step/u);
    expect(wrapper).toMatch(/never batch, prefetch, or loop multiple executor\s+calls/u);
    expect(wrapper).toContain(
      "The stdio state machine enforces direct phase, ref, ordinal, and schema checks, "
        + "but it does not authenticate the caller role.",
    );
    expect(wrapper).not.toMatch(
      /automatic_build_executor_session\.v[12]|chunk_receipt|previous_chunk_receipt|agent-only stdio|candidate_path|executor\.session|PowerShell|private candidate source/u,
    );
    expect(wrapper.split("# Automatic Build Executor Session Protocol")).toHaveLength(2);
    expect(wrapper.split("## Semantic extractor instructions")).toHaveLength(2);
  });

  it("composes one deterministic dispatch wrapper and one semantic prompt", () => {
    const input = {
      mode: "dispatch" as const,
      extractor_name: "pass1-local-extractor.md",
      extractor_prompt: "# Extractor\n\nsemantic body\n",
      protocol_wrapper: "# Dispatch\n\nprotocol body\n",
    };
    const first = composeAutomaticBuildExecutorPrompt(input);
    const second = composeAutomaticBuildExecutorPrompt(input);
    expect(first).toBe(second);
    expect(first).toBe(
      `# Dispatch\n\nprotocol body\n\n${AUTOMATIC_BUILD_EXECUTOR_PROMPT_SEPARATOR}\n\n# Extractor\n\nsemantic body\n`,
    );
    expect(first.split("# Extractor")).toHaveLength(2);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("keeps task mode byte-stable apart from one trailing newline", () => {
    expect(composeAutomaticBuildExecutorPrompt({
      mode: "task",
      extractor_name: "pass1-local-extractor.md",
      extractor_prompt: "semantic body\n\n",
      protocol_wrapper: "ignored wrapper",
    })).toBe("semantic body\n");
  });

  it("renders all whitelisted extractors with the closed dispatch protocol", () => {
    const wrapper = readFileSync(
      path.join(REPO_ROOT, "agents", "automatic-build-dispatch-executor.md"),
      "utf8",
    );
    for (const extractorName of AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES) {
      const rawPrompt = readFileSync(path.join(REPO_ROOT, "agents", extractorName), "utf8");
      let stdout = "";
      let stderr = "";
      const status = runAutomaticBuildExecutorPromptCli(
        [extractorName, "--executor-protocol", "dispatch"],
        {
          write_stdout: (text) => { stdout += text; },
          write_stderr: (text) => { stderr += text; },
        },
      );
      expect(status, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(rawPrompt).toContain("## Automatic Build Executor Envelope");
      expect(stdout).toBe(composeAutomaticBuildExecutorPrompt({
        mode: "dispatch",
        extractor_name: extractorName,
        extractor_prompt: rawPrompt,
        protocol_wrapper: wrapper,
      }));
      expect(stdout).toContain(wrapper.replace(/(?:\r\n|\n|\r)+$/u, ""));
      expect(stdout).not.toMatch(
        /automatic_build_executor\.v1|candidate_path|input_command|submit_command|fail_command|heartbeat_command/u,
      );
      expect(stdout).not.toContain(REPO_ROOT);
      expect(stdout.endsWith("\n")).toBe(true);
    }
  });

  it("activates every BR8 fragment/reducer prompt in the production set", () => {
    expect(AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES).toEqual(expect.arrayContaining([
      "pass1-source-fragment-extractor.md",
      "pass1-lid-stitcher.md",
      "profile-sidecar-discourse-fragment-extractor.md",
      "profile-sidecar-discourse-reducer.md",
    ]));
    expect(AUTOMATIC_BUILD_SHADOW_EXTRACTOR_PROMPT_NAMES).toEqual([]);
    for (const extractorName of AUTOMATIC_BUILD_EXTRACTOR_PROMPT_NAMES) {
      const expected = readFileSync(path.join(REPO_ROOT, "agents", extractorName), "utf8")
        .replace(/(?:\r\n|\n|\r)+$/u, "");
      let stdout = "";
      let stderr = "";
      const status = runAutomaticBuildExecutorPromptCli([extractorName], {
        write_stdout: (text) => { stdout += text; },
        write_stderr: (text) => { stderr += text; },
      });
      expect(status, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe(`${expected}\n`);
    }
  });

  it("rejects unknown names, traversal, modes, and extra arguments with exit 2", () => {
    for (const argv of [
      ["unknown.md"],
      ["../pass1-local-extractor.md"],
      ["pass1-local-extractor.md", "--executor-protocol", "unknown"],
      ["pass1-local-extractor.md", "--executor-protocol", "dispatch", "extra"],
    ]) {
      let stdout = "";
      let stderr = "";
      expect(runAutomaticBuildExecutorPromptCli(argv, {
        write_stdout: (text) => { stdout += text; },
        write_stderr: (text) => { stderr += text; },
      })).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).not.toBe("");
    }
  });
});
