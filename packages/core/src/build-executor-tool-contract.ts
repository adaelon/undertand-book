export const BUILD_EXECUTOR_SERVER_NAME_V1 = "understand_book_build_executor" as const;

export const BUILD_EXECUTOR_TOOL_NAMES_V1 = [
  "executor.open",
  "executor.input.next",
  "executor.generation.start",
  "executor.submit_candidate",
] as const;

export type BuildExecutorToolNameV1 = (typeof BUILD_EXECUTOR_TOOL_NAMES_V1)[number];
export class BuildExecutorInvalidArgumentsError extends Error {
  readonly diagnostic_code = "invalid_arguments" as const;
  constructor(readonly field: "arguments" | "version" | "opaque_handoff_ref") {
    super(`Build Executor invalid arguments field: ${field}`);
    this.name = "BuildExecutorInvalidArgumentsError";
  }
}
