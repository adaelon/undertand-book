import {
  resolveContentProfile,
  TECHNICAL_LEARNING_PROFILE_ID,
  TECHNICAL_LEARNING_PROFILE_VERSION,
  type ContentProfileId,
} from "./content-profile";

export { TECHNICAL_LEARNING_PROFILE_ID, TECHNICAL_LEARNING_PROFILE_VERSION } from "./content-profile";

export const CORE_SCHEMA_VERSION = "core_v0";
export const DEFAULT_BOOK_VERSION = "v1";

export interface ProfileArtifactHeader {
  book_id: string;
  book_version: string;
  profile_id: ContentProfileId;
  profile_version: string;
  core_schema_version: string;
  generated_at: string;
}

export interface ProfileMetadata {
  header: ProfileArtifactHeader;
}

export interface ProfileArtifactHeaderInput {
  book_id: string;
  content_profile?: string;
  paper_subtype?: string;
  book_version?: string;
  profile_version?: string;
  core_schema_version?: string;
  generated_at?: string;
}

function requireNonEmpty(field: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(`ProfileArtifactHeader.${field} is required`);
  }
  return value;
}

export function buildProfileArtifactHeader(input: ProfileArtifactHeaderInput): ProfileArtifactHeader {
  const profile = resolveContentProfile(input.content_profile, { paper_subtype: input.paper_subtype });
  return {
    book_id: requireNonEmpty("book_id", input.book_id),
    book_version: requireNonEmpty("book_version", input.book_version ?? DEFAULT_BOOK_VERSION),
    profile_id: profile.id,
    profile_version: requireNonEmpty("profile_version", input.profile_version ?? profile.profile_version),
    core_schema_version: requireNonEmpty("core_schema_version", input.core_schema_version ?? CORE_SCHEMA_VERSION),
    generated_at: requireNonEmpty("generated_at", input.generated_at ?? new Date().toISOString()),
  };
}

export function buildProfileMetadata(header: ProfileArtifactHeader): ProfileMetadata {
  return { header };
}
