export const TECHNICAL_LEARNING_PROFILE_ID = "technical_learning" as const;
export const TECHNICAL_LEARNING_PROFILE_VERSION = "technical_learning_v0";
export const CORE_SCHEMA_VERSION = "core_v0";
export const DEFAULT_BOOK_VERSION = "v1";

export interface ProfileArtifactHeader {
  book_id: string;
  book_version: string;
  profile_id: typeof TECHNICAL_LEARNING_PROFILE_ID;
  profile_version: string;
  core_schema_version: string;
  generated_at: string;
}

export interface ProfileMetadata {
  header: ProfileArtifactHeader;
}

export interface ProfileArtifactHeaderInput {
  book_id: string;
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
  return {
    book_id: requireNonEmpty("book_id", input.book_id),
    book_version: requireNonEmpty("book_version", input.book_version ?? DEFAULT_BOOK_VERSION),
    profile_id: TECHNICAL_LEARNING_PROFILE_ID,
    profile_version: requireNonEmpty("profile_version", input.profile_version ?? TECHNICAL_LEARNING_PROFILE_VERSION),
    core_schema_version: requireNonEmpty("core_schema_version", input.core_schema_version ?? CORE_SCHEMA_VERSION),
    generated_at: requireNonEmpty("generated_at", input.generated_at ?? new Date().toISOString()),
  };
}

export function buildProfileMetadata(header: ProfileArtifactHeader): ProfileMetadata {
  return { header };
}