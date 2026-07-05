import { describe, expect, it } from "vitest";
import {
  buildProfileArtifactHeader,
  buildProfileMetadata,
  CORE_SCHEMA_VERSION,
  DEFAULT_BOOK_VERSION,
  TECHNICAL_LEARNING_PROFILE_ID,
  TECHNICAL_LEARNING_PROFILE_VERSION,
} from "../src/profile-artifact";
import { PAPER_PROFILE_ID, PAPER_PROFILE_VERSION, resolveContentProfile } from "../src/content-profile";

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

  it("treats omitted content_profile as explicit technical_learning", () => {
    const defaults = buildProfileArtifactHeader({
      book_id: "book-a",
      generated_at: "2026-06-26T00:00:00.000Z",
    });
    const explicit = buildProfileArtifactHeader({
      book_id: "book-a",
      content_profile: "technical_learning",
      generated_at: "2026-06-26T00:00:00.000Z",
    });

    expect(defaults).toEqual(explicit);
    expect(resolveContentProfile()).toEqual(resolveContentProfile("technical_learning"));
  });

  it("builds paper profile headers after PP0.5 resolver support", () => {
    const header = buildProfileArtifactHeader({
      book_id: "paper-a",
      content_profile: "paper",
      generated_at: "2026-07-05T00:00:00.000Z",
    });

    expect(header.profile_id).toBe(PAPER_PROFILE_ID);
    expect(header.profile_version).toBe(PAPER_PROFILE_VERSION);
  });

  it("rejects unsupported content_profile values before writing profile artifacts", () => {
    expect(() => resolveContentProfile("survey")).toThrow("Unsupported content_profile");
    expect(() =>
      buildProfileArtifactHeader({
        book_id: "book-a",
        content_profile: "survey",
      }),
    ).toThrow("Unsupported content_profile");
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
