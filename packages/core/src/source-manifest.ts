export type CanonicalSourceKind = "markdown" | "epub";

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

export interface SourceManifestInput {
  book_id: string;
  source_path: string;
  original_pdf_path?: string;
  pdf_source_map_path?: string;
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
