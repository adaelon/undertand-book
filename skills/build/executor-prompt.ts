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

function withoutLegacyExecutorEnvelope(value: string): string {
  const lineEnding = value.includes("\r\n") ? "\r\n" : value.includes("\r") ? "\r" : "\n";
  const lines = value.split(/\r\n|\n|\r/u);
  const heading = "## Automatic Build Executor Envelope";
  const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (matches.length === 0) return value;
  if (matches.length !== 1) throw new Error("extractor_prompt contains duplicate legacy executor envelopes");
  const start = matches[0];
  let contentStart = start + 1;
  while (contentStart < lines.length && lines[contentStart] === "") contentStart += 1;
  let end = contentStart;
  while (end < lines.length && lines[end] !== "") end += 1;
  if (contentStart === end) throw new Error("legacy executor envelope body must not be empty");
  return [...lines.slice(0, start), ...lines.slice(Math.min(end + 1, lines.length))].join(lineEnding);
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
  const dispatchExtractorPrompt = withoutTrailingLineBreaks(withoutLegacyExecutorEnvelope(extractorPrompt));
  return [
    protocolWrapper,
    AUTOMATIC_BUILD_EXECUTOR_PROMPT_SEPARATOR,
    dispatchExtractorPrompt,
  ].join("\n\n") + "\n";
}
