export const AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES = ["dispatch", "task"] as const;

export type AutomaticBuildExecutorPromptMode =
  (typeof AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES)[number];

export interface AutomaticBuildExecutorPromptInput {
  mode: AutomaticBuildExecutorPromptMode;
  extractor_name: string;
  extractor_prompt: string;
  protocol_wrapper: string;
}

export const AUTOMATIC_BUILD_EXECUTOR_PROMPT_SEPARATOR =
  "<!-- AUTOMATIC_BUILD_EXECUTOR_SEMANTIC_PROMPT -->";

function withoutTrailingLineBreaks(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)+$/u, "");
}

function assertPromptText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
  return withoutTrailingLineBreaks(value);
}

export function composeAutomaticBuildExecutorPrompt(
  input: AutomaticBuildExecutorPromptInput,
): string {
  if (!AUTOMATIC_BUILD_EXECUTOR_PROMPT_MODES.includes(input.mode)) {
    throw new Error(`unsupported automatic build executor prompt mode: ${String(input.mode)}`);
  }
  if (!input.extractor_name.trim()) throw new Error("extractor_name must not be empty");
  const extractorPrompt = assertPromptText(input.extractor_prompt, "extractor_prompt");
  if (input.mode === "task") return `${extractorPrompt}\n`;

  const protocolWrapper = assertPromptText(input.protocol_wrapper, "protocol_wrapper");
  return [
    protocolWrapper,
    AUTOMATIC_BUILD_EXECUTOR_PROMPT_SEPARATOR,
    extractorPrompt,
  ].join("\n\n") + "\n";
}
