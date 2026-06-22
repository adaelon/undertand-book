import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSampleBase } from "../src/sample";
import { ReadOnlyBaseZ } from "../src/zod";

const here = dirname(fileURLToPath(import.meta.url));

describe("基座 schema TS↔Rust 链路 (S0)", () => {
  it("样例基座通过 zod 产出前自检(失配抛错,非静默)", () => {
    const base = buildSampleBase();
    const parsed = ReadOnlyBaseZ.parse(base);
    expect(parsed.book_id).toBe("sample-book");
    expect(parsed.lid_nodes).toHaveLength(2);
    expect(parsed.graph_nodes).toHaveLength(2);
  });

  it("写出 fixture 供 Rust 跨语言闸读回", () => {
    const base = buildSampleBase();
    ReadOnlyBaseZ.parse(base); // 产出前再过一次自检
    const out = resolve(here, "../../../crates/base-schema/fixtures/sample-base.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(base, null, 2) + "\n", "utf8");
    expect(out).toContain("sample-base.json");
  });
});
