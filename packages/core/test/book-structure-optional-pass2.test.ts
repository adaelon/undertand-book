import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

describe("BookStructure optional Pass2 input", () => {
  it("computes status when pass2_audit.json is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "understand-book-structure-no-pass2-"));
    const source = path.join(root, "guide.md");
    const workspace = path.join(root, ".understand-book", "guide");
    writeFileSync(source, "# Guide\n\nA structural explanation.\n", "utf8");
    writeJson(path.join(workspace, "base.json"), { graph_nodes: [], graph_edges: [] });
    writeJson(path.join(workspace, "discourse_index.json"), { items: [] });
    writeJson(path.join(workspace, "formula_semantics.json"), { items: [] });

    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "skills", "build", "book-structure-status.ts"),
      source,
    ], { cwd: root, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[book-structure-status]");
  });
});
