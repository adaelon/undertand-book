import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveReaderNavigationTarget } from "./reader-navigation";

describe("reader navigation", () => {
  it("keeps neighboring outline containers on their own first leaves", () => {
    const leaves = ["2.47.1", "2.47.23.1", "2.47.24.1", "2.47.25.1"];

    expect(resolveReaderNavigationTarget("2.47.23", leaves)).toBe("2.47.23.1");
    expect(resolveReaderNavigationTarget("2.47.24", leaves)).toBe("2.47.24.1");
    expect(resolveReaderNavigationTarget("2.47.25", leaves)).toBe("2.47.25.1");
  });

  it("preserves leaves and refuses unrelated prefix matches", () => {
    const leaves = ["2.1", "2.10", "20.1"];

    expect(resolveReaderNavigationTarget("2.10", leaves)).toBe("2.10");
    expect(resolveReaderNavigationTarget("2", leaves)).toBe("2.1");
    expect(resolveReaderNavigationTarget("3", leaves)).toBeNull();
  });

  it("keeps the requested outline item active until the reader is used", () => {
    const app = readFileSync("src/App.vue", "utf8");

    expect(app).toContain("const outlineNavigationLid = ref<string | null>(null)");
    expect(app).toContain("outlineNavigationLid.value = lid");
    expect(app).toContain(":anchor-lid=\"outlineAnchorLid\"");
    expect(app).toContain("@viewport-interaction=\"clearOutlineNavigation\"");
  });
});
