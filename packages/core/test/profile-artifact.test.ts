import { describe, expect, it } from "vitest";
import {
  buildProfileArtifactHeader,
  buildProfileMetadata,
  CORE_SCHEMA_VERSION,
  DEFAULT_BOOK_VERSION,
  TECHNICAL_LEARNING_PROFILE_ID,
  TECHNICAL_LEARNING_PROFILE_VERSION,
} from "../src/profile-artifact";

describe("PB0 profile artifact metadata", () => {
  it("builds the shared technical_learning profile header", () => {
    const header = buildProfileArtifactHeader({
      book_id: "book-a",
      generated_at: "2026-06-26T00:00:00.000Z",
    });

    expect(header).toEqual({
      book_id: "book-a",
      book_version: DEFAULT_BOOK_VERSION,
      profile_id: TECHNICAL_LEARNING_PROFILE_ID,
      profile_version: TECHNICAL_LEARNING_PROFILE_VERSION,
      core_schema_version: CORE_SCHEMA_VERSION,
      generated_at: "2026-06-26T00:00:00.000Z",
    });
    expect(buildProfileMetadata(header)).toEqual({ header });
  });

  it("fails before writing metadata when required fields are blank", () => {
    expect(() => buildProfileArtifactHeader({ book_id: "" })).toThrow("book_id");
    expect(() =>
      buildProfileArtifactHeader({
        book_id: "book-a",
        book_version: " ",
      }),
    ).toThrow("book_version");
  });
});