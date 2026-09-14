import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticBuildDispatchSettledError } from "../src/automatic-build-dispatch-runtime";
import { automaticBuildDriverFailureResponse } from "../../../skills/build/automatic-build-driver";

afterEach(() => vi.unstubAllEnvs());

describe("build driver failure boundary", () => {
  it("rereads state when a dispatch finishes during publication instead of reporting an engine failure", () => {
    expect(automaticBuildDriverFailureResponse(new AutomaticBuildDispatchSettledError("dispatch has no current work unit")))
      .toEqual({ version: "automatic_build_step.v1", action: { kind: "WAIT", reason: "backoff", retry_after_ms: 50 } });
  });
  it("keeps bounded diagnostic details local and returns no invented recovery choice", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-driver-diagnostic-"));
    vi.stubEnv("UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT", root);
    const error = new Error(`PRIVATE_CANDIDATE_TEXT ${"x".repeat(20_000)}`);
    const response = automaticBuildDriverFailureResponse(error);
    expect(response.action).toMatchObject({ kind: "NEEDS_USER", reason: "build_engine_failed",
      choices: [], projection: { category: "internal", code: "build_step_failed" } });
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CANDIDATE_TEXT");
    if (response.action.kind !== "NEEDS_USER") throw new Error("expected boundary");
    const diagnostic = JSON.parse(readFileSync(path.join(root, "diagnostics", `${response.action.request_id}.json`), "utf8"));
    expect(diagnostic.error.message).toContain("PRIVATE_CANDIDATE_TEXT");
    expect(diagnostic.error.message.length).toBeLessThanOrEqual(2048);
    expect(diagnostic.error.stack.length).toBeLessThanOrEqual(8192);
  });

  it("reports when the diagnostic cannot be saved without leaking the original error", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-driver-diagnostic-unavailable-"));
    const file = path.join(root, "file-not-directory");
    writeFileSync(file, "occupied");
    vi.stubEnv("UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT", file);
    const response = automaticBuildDriverFailureResponse(new Error("PRIVATE_INPUT"));
    expect(response.action).toMatchObject({ kind: "NEEDS_USER", choices: [],
      projection: { code: "build_step_failed_diagnostic_unavailable" } });
    expect(JSON.stringify(response)).not.toContain("PRIVATE_INPUT");
  });
});
