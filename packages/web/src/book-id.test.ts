import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateBookIdFromTitle } from "./book-id";

describe("paper book id generation", () => {
  it("derives the server-safe id from the title instead of user input", () => {
    expect(generateBookIdFromTitle(
      "Understanding_Transformer_from_the_Perspective_of_Associative_Memory",
    )).toBe("understanding-transformer-from-the-perspective-of-associative-memory");
    expect(generateBookIdFromTitle("  Café...Model__2  ")).toBe("cafe-model-2");
  });

  it("uses a stable valid fallback for non-ASCII-only titles and respects the server limit", () => {
    const fallback = generateBookIdFromTitle("矛盾论与实践论");
    expect(fallback).toMatch(/^book-[0-9a-f]{8}$/);
    expect(generateBookIdFromTitle("矛盾论与实践论")).toBe(fallback);

    const long = generateBookIdFromTitle("A very long paper title ".repeat(10));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it("wires the title-derived id into creation without an editable id field", () => {
    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toContain("generateBookIdFromTitle(newBookTitle.value)");
    expect(app).not.toContain('v-model="newBookId"');
    expect(app).toContain('book_id: generatedNewBookId.value');
  });
});
