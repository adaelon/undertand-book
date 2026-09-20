import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseObservation } from "../src/contract.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/observability/ub_observation.v1.json", import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  valid: unknown[];
  invalid: unknown[];
};

describe("ub_observation.v1", () => {
  it("accepts the shared metadata-only fixtures", () => {
    expect(fixtures.valid.map(parseObservation)).toHaveLength(fixtures.valid.length);
  });

  it("rejects unknown content fields and dishonest usage values", () => {
    for (const fixture of fixtures.invalid) {
      expect(() => parseObservation(fixture)).toThrow();
    }
  });
});
