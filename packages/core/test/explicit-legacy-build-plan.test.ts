import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuildPlanV1 } from "../src/build-intent";
import { buildSourceManifest } from "../src/source-manifest";
import { prepareExplicitLegacyBuildPlan } from "../../../skills/build/automatic-build";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function writeTechnicalLearningWorkspace(root: string): string {
  const bookId = "guide";
  const source = path.join(root, "guide.md");
  const workspace = path.join(root, ".understand-book", bookId);
  const body = "# Guide\n\nA deterministic source paragraph.\n";
  mkdirSync(workspace, { recursive: true });
  writeFileSync(source, body, "utf8");
  writeFileSync(path.join(workspace, "source.txt"), body, "utf8");
  writeJson(path.join(workspace, "base.json"), { book_id: bookId, lid_nodes: [], graph_nodes: [], graph_edges: [] });
  writeJson(path.join(workspace, "source_manifest.json"), buildSourceManifest({ book_id: bookId, source_path: source }));
  writeJson(path.join(workspace, "profile_metadata.json"), {
    header: { book_id: bookId, profile_id: "technical_learning" },
  });
  return workspace;
}

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

  it("persists the standard plan for an existing technical-learning workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-ip8-existing-"));
    const workspace = writeTechnicalLearningWorkspace(root);

    const result = prepareExplicitLegacyBuildPlan(workspace, root, { now: "2026-07-30T12:00:00.000Z" });

    expect(result).toMatchObject({
      version: "explicit_legacy_build_plan.v1",
      target_ref: {
        workspace_dir: path.resolve(workspace),
        book_id: "guide",
        profile_id: "technical_learning",
      },
      plan: {
        recipe_id: "standard_deep",
        status: "confirmed",
        confirmation_source: "explicit_legacy_command",
      },
    });
    expect(validateBuildPlanV1(JSON.parse(readFileSync(result.build_plan_path, "utf8")))).toEqual(result.plan);
  });
});
