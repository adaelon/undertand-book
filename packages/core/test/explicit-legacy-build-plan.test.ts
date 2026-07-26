import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuildPlanV1 } from "../src/build-intent";
import { prepareExplicitLegacyBuildPlan } from "../../../skills/build/automatic-build";

describe("IP8 explicit legacy full-build compatibility", () => {
  it("persists an auditable standard plan only when the explicit mapping is invoked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-ip8-legacy-"));
    const source = path.join(root, "guide.md");
    writeFileSync(source, "# Guide\n\nA deterministic source paragraph.\n", "utf8");
    const implicitPlanDir = path.join(root, ".understand-book", "guide", ".build", "automatic-build", "v2", "legacy-plans");
    expect(existsSync(implicitPlanDir)).toBe(false);

    const result = prepareExplicitLegacyBuildPlan(source, root, { now: "2026-07-26T04:20:00.000Z" });
    expect(result).toMatchObject({
      version: "explicit_legacy_build_plan.v1",
      invocation: "explicit_full_build",
      plan: {
        recipe_id: "standard_deep",
        status: "confirmed",
        confirmation_source: "explicit_legacy_command",
      },
    });
    expect(path.isAbsolute(result.build_plan_path)).toBe(true);
    expect(validateBuildPlanV1(JSON.parse(readFileSync(result.build_plan_path, "utf8")))).toEqual(result.plan);
  });
});
