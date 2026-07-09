export type CanonicalSourceKind = "markdown" | "epub";
export type PdfCapabilityStatus = "unavailable" | "available" | "degraded" | "stale" | "failed";
export type PdfCapabilityName =
  | "view_pdf"
  | "project_lid_to_pdf"
  | "resolve_pdf_selection"
  | "project_ranges_to_pdf";

export interface CanonicalSourceManifestEntry {
  kind: CanonicalSourceKind;
  path: string;
  truth_file: "source.txt";
  participates_in_lid: true;
  citation_anchor: "lid";
}

export interface PdfSourceMapManifestEntry {
  status: "not_provided" | "provided";
  path?: string;
  may_project_lid_to_pdf_region: boolean;
  citation_anchor: false;
}

export interface OriginalPdfAttachmentManifestEntry {
  kind: "original_pdf";
  path: string;
  role: "side_preview";
  participates_in_lid: false;
  citation_anchor: false;
  pdf_source_map: PdfSourceMapManifestEntry;
}

export interface SourceManifest {
  book_id: string;
  canonical_source: CanonicalSourceManifestEntry;
  attachments: OriginalPdfAttachmentManifestEntry[];
}

export interface PdfCapability {
  status: PdfCapabilityStatus;
  reason?: string;
  artifact_path?: string;
  report_path?: string;
  config_hash?: string;
}

export interface SourceManifestV2 {
  version: "source_manifest.v2";
  book_id: string;
  canonical_source: {
    kind: "reconciled_markdown";
    path: "source.txt";
    citation_anchor: "lid";
    sha256: string;
  };
  original_pdf?: {
    path: string;
    sha256: string;
    fingerprint?: string;
    citation_anchor: false;
  };
  capabilities: Record<PdfCapabilityName, PdfCapability>;
}

export interface SourceManifestInput {
  book_id: string;
  source_path: string;
  original_pdf_path?: string;
  pdf_source_map_path?: string;
}

export interface SourceManifestV2Input {
  book_id: string;
  source_sha256: string;
  original_pdf_path?: string;
  original_pdf_sha256?: string;
  original_pdf_fingerprint?: string;
  pdf_source_map_path?: string;
  pdf_selection_map_manifest_path?: string;
  alignment_report_path?: string;
  config_hash?: string;
  capability_overrides?: Partial<Record<PdfCapabilityName, PdfCapability>>;
}

function requireNonEmpty(field: string, value: string | undefined): string {
  if (!value || !value.trim()) throw new Error(`SourceManifest.${field} is required`);
  return value;
}

function canonicalSourceKind(sourcePath: string): CanonicalSourceKind {
  return /\.epub$/i.test(sourcePath) ? "epub" : "markdown";
}

function requirePdfPath(path: string): string {
  const value = requireNonEmpty("original_pdf_path", path);
  if (!/\.pdf$/i.test(value)) {
    throw new Error(`SourceManifest.original_pdf_path must point to a .pdf file, got "${value}"`);
  }
  return value;
}

function unavailable(reason: string): PdfCapability {
  return { status: "unavailable", reason };
}

function available(artifact_path: string | undefined, report_path: string | undefined, config_hash: string | undefined): PdfCapability {
  return {
    status: "available",
    ...(artifact_path ? { artifact_path } : {}),
    ...(report_path ? { report_path } : {}),
    ...(config_hash ? { config_hash } : {}),
  };
}

export function buildSourceManifest(input: SourceManifestInput): SourceManifest {
  const bookId = requireNonEmpty("book_id", input.book_id);
  const sourcePath = requireNonEmpty("source_path", input.source_path);
  const canonical_source: CanonicalSourceManifestEntry = {
    kind: canonicalSourceKind(sourcePath),
    path: sourcePath,
    truth_file: "source.txt",
    participates_in_lid: true,
    citation_anchor: "lid",
  };
  const attachments: OriginalPdfAttachmentManifestEntry[] = input.original_pdf_path
    ? [
        {
          kind: "original_pdf",
          path: requirePdfPath(input.original_pdf_path),
          role: "side_preview",
          participates_in_lid: false,
          citation_anchor: false,
          pdf_source_map: input.pdf_source_map_path
            ? {
                status: "provided",
                path: requireNonEmpty("pdf_source_map_path", input.pdf_source_map_path),
                may_project_lid_to_pdf_region: true,
                citation_anchor: false,
              }
            : {
                status: "not_provided",
                may_project_lid_to_pdf_region: false,
                citation_anchor: false,
              },
        },
      ]
    : [];
  if (!input.original_pdf_path && input.pdf_source_map_path) {
    throw new Error("SourceManifest.pdf_source_map_path requires original_pdf_path");
  }
  return {
    book_id: bookId,
    canonical_source,
    attachments,
  };
}

export function buildSourceManifestV2(input: SourceManifestV2Input): SourceManifestV2 {
  const bookId = requireNonEmpty("book_id", input.book_id);
  const sourceSha256 = requireNonEmpty("source_sha256", input.source_sha256);
  const hasPdf = Boolean(input.original_pdf_path);
  if (hasPdf && !input.original_pdf_sha256) {
    throw new Error("SourceManifestV2.original_pdf_sha256 is required when original_pdf_path is provided");
  }
  if (!hasPdf && (input.pdf_source_map_path || input.pdf_selection_map_manifest_path)) {
    throw new Error("SourceManifestV2 PDF map artifacts require original_pdf_path");
  }

  const viewPdf = hasPdf
    ? available(input.original_pdf_path, undefined, input.config_hash)
    : unavailable("original PDF is not available");
  const projectLid = input.pdf_source_map_path
    ? available(input.pdf_source_map_path, input.alignment_report_path, input.config_hash)
    : unavailable("pdf_source_map.v1 is not available");
  const resolveSelection = input.pdf_selection_map_manifest_path
    ? available(input.pdf_selection_map_manifest_path, input.alignment_report_path, input.config_hash)
    : unavailable("pdf_selection_map.v1 is not available");
  const projectRanges = input.pdf_source_map_path
    ? available(input.pdf_source_map_path, input.alignment_report_path, input.config_hash)
    : unavailable("pdf_source_map.v1 is not available");

  return {
    version: "source_manifest.v2",
    book_id: bookId,
    canonical_source: {
      kind: "reconciled_markdown",
      path: "source.txt",
      citation_anchor: "lid",
      sha256: sourceSha256,
    },
    ...(hasPdf
      ? {
          original_pdf: {
            path: requirePdfPath(input.original_pdf_path!),
            sha256: requireNonEmpty("original_pdf_sha256", input.original_pdf_sha256),
            ...(input.original_pdf_fingerprint ? { fingerprint: input.original_pdf_fingerprint } : {}),
            citation_anchor: false,
          },
        }
      : {}),
    capabilities: {
      view_pdf: input.capability_overrides?.view_pdf ?? viewPdf,
      project_lid_to_pdf: input.capability_overrides?.project_lid_to_pdf ?? projectLid,
      resolve_pdf_selection: input.capability_overrides?.resolve_pdf_selection ?? resolveSelection,
      project_ranges_to_pdf: input.capability_overrides?.project_ranges_to_pdf ?? projectRanges,
    },
  };
}
