import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
  AUTOMATIC_BUILD_PRODUCTION_DEFAULT,
  AUTOMATIC_BUILD_PROTOCOL_V2,
  AUTOMATIC_BUILD_RELEASE_V1,
} from "../src/automatic-build-protocol";

describe("automatic build v2 production release", () => {
  it("switches only new production builds to the frozen v2 protocol", () => {
    expect(AUTOMATIC_BUILD_PRODUCTION_DEFAULT).toBe(AUTOMATIC_BUILD_PROTOCOL_V2);
    expect(AUTOMATIC_BUILD_RELEASE_V1).toEqual({
      version: "automatic_build_release.v1",
      production_default: "automatic_build_protocol.v2",
      legacy_protocol: AUTOMATIC_BUILD_LEGACY_PROTOCOL_V1,
      max_workers: 3,
      candidate_handoff: "executor_owned_task_mailbox",
      exact_usage_policy: "receipt_or_unknown",
      legacy_policy: "explicit_legacy_resume_or_v2_rebuild",
    });
  });

  it("keeps the Codex manifest on one cachebuster suffix", () => {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe("understand-book");
    expect(manifest.version).toMatch(/^0\.1\.0\+codex\.[0-9A-Za-z.-]+$/);
    expect((manifest.version.match(/\+codex\./g) ?? [])).toHaveLength(1);
  });
});
