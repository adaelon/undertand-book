import { describe, expect, it } from "vitest";
import {
  readReaderSurfacePreference,
  resolveReaderSurface,
  writeReaderSurfacePreference,
} from "./reader-surface";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("reader surface preference", () => {
  const identity = { bookId: "book/a", sourceFingerprint: "source:v2" };

  it("defaults to PDF only when the source has a usable PDF surface", () => {
    expect(resolveReaderSurface(null, true)).toBe("pdf");
    expect(resolveReaderSurface(null, false)).toBe("markdown");
    expect(resolveReaderSurface("pdf", false)).toBe("markdown");
    expect(resolveReaderSurface("markdown", true)).toBe("markdown");
  });

  it("stores a device-local preference by book and source identity", () => {
    const storage = memoryStorage();
    writeReaderSurfacePreference(storage, identity, "markdown");
    expect(readReaderSurfacePreference(storage, identity)).toBe("markdown");
    expect(readReaderSurfacePreference(storage, { ...identity, sourceFingerprint: "other" })).toBeNull();
    storage.setItem("understand-book:reader-surface:v1:broken", "other");
    expect(readReaderSurfacePreference(storage, { bookId: "broken", sourceFingerprint: "" })).toBeNull();
  });
});
