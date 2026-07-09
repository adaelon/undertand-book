// PH5 hybrid foundation CLI:
// trusted source.txt + paper.pdf -> base/source_manifest/pdf maps/alignment report.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { extractPdfTextGeometry } from "../../packages/core/src/pdf-geometry";
import { buildHybridFoundation, writeHybridFoundationArtifacts } from "../../packages/core/src/hybrid-foundation";
import {
  AlignmentReportZ,
  PdfSelectionMapManifestZ,
  PdfSelectionMapPageShardZ,
  PdfSourceMapZ,
  ReadOnlyBaseZ,
  SourceManifestV2Z,
} from "../../packages/core/src/zod";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--book-id", "--out-dir", "--pdf-fingerprint"]);
const opts: Record<string, string | undefined> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) opts[a] = args[++i];
  else if (a.startsWith("--")) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}

const sourcePath = positional[0];
const pdfPath = positional[1];
if (!sourcePath || !pdfPath) {
  console.error("usage: tsx skills/build/hybrid-foundation.ts <source.txt> <paper.pdf> [--book-id <id>] [--out-dir <dir>] [--pdf-fingerprint <fp>]");
  process.exit(2);
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const bookId = deriveBookId(sourcePath, opts["--book-id"]);
const outputDir = opts["--out-dir"] ?? `.understand-book/${bookId}`;
const source = readFileSync(sourcePath, "utf8");
const pdfBytes = new Uint8Array(readFileSync(pdfPath));
const pdfGeometry = await extractPdfTextGeometry(pdfBytes);
const artifacts = buildHybridFoundation({
  book_id: bookId,
  source_txt: source,
  original_pdf_path: pdfPath,
  original_pdf_sha256: sha256(pdfBytes),
  original_pdf_fingerprint: opts["--pdf-fingerprint"],
  pdf_geometry: pdfGeometry,
});

ReadOnlyBaseZ.parse(artifacts.base);
SourceManifestV2Z.parse(artifacts.source_manifest);
PdfSourceMapZ.parse(artifacts.pdf_source_map);
PdfSelectionMapManifestZ.parse(artifacts.pdf_selection_map_manifest);
for (const page of artifacts.pdf_selection_map_pages) PdfSelectionMapPageShardZ.parse(page);
AlignmentReportZ.parse(artifacts.alignment_report);

const written = writeHybridFoundationArtifacts(outputDir, source, artifacts);
console.log(`[hybrid-foundation] bookId=${bookId}`);
console.log(`  base: ${written.base_path}`);
console.log(`  source: ${written.source_path}`);
console.log(`  source manifest: ${written.source_manifest_path}`);
console.log(`  pdf source map: ${written.pdf_source_map_path}`);
console.log(`  pdf selection map: ${written.pdf_selection_map_manifest_path} pages=${written.pdf_selection_map_page_paths.length}`);
console.log(`  alignment report: ${written.alignment_report_path}`);
