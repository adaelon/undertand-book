// PH3 source reconciliation CLI:
// paper.md + paper.pdf -> .build/source-reconciliation/{report,review artifacts,source.txt?}
// Unresolved blocks exit non-zero and never write trusted stage source.txt.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { extractPdfTextGeometry } from "../../packages/core/src/pdf-geometry";
import { reconcilePaperSource, writeSourceReconciliationArtifacts } from "../../packages/core/src/source-reconciliation";

const VALUE_FLAGS = new Set(["--book-id", "--out-dir"]);
const opts: Record<string, string | undefined> = {};
const positional: string[] = [];
for (let i = 0; i < process.argv.slice(2).length; i++) {
  const a = process.argv.slice(2)[i];
  if (VALUE_FLAGS.has(a)) opts[a] = process.argv.slice(2)[++i];
  else if (a.startsWith("--")) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}

const markdownPath = positional[0];
const pdfPath = positional[1];
if (!markdownPath || !pdfPath) {
  console.error("usage: tsx skills/build/source-reconcile.ts <paper.md> <paper.pdf> [--book-id <id>] [--out-dir <dir>]");
  process.exit(2);
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const bookId = deriveBookId(markdownPath, opts["--book-id"]);
const outputDir = opts["--out-dir"] ?? `.understand-book/${bookId}`;
const markdown = readFileSync(markdownPath, "utf8");
const pdfBytes = new Uint8Array(readFileSync(pdfPath));
const pdfGeometry = await extractPdfTextGeometry(pdfBytes);
const result = reconcilePaperSource({
  book_id: bookId,
  markdown_source: markdown,
  pdf_geometry: pdfGeometry,
  input_fingerprint: {
    paper_md_sha256: sha256(markdown),
    paper_pdf_sha256: sha256(pdfBytes),
    config_hash: "monotonic_forward_fuzzy_v1",
  },
});
const artifacts = writeSourceReconciliationArtifacts(outputDir, result);

console.log(`[source-reconcile] bookId=${bookId} unresolved=${result.report.unresolved.length}`);
console.log(`  report: ${artifacts.report_path}`);
console.log(`  review draft: ${artifacts.review_draft_path}`);
console.log(`  review decisions: ${artifacts.review_decisions_path}`);
if (artifacts.source_path) console.log(`  trusted stage source: ${artifacts.source_path}`);

if (result.report.unresolved.length) {
  console.error("  trusted source blocked; resolve review artifacts and rerun");
  process.exit(1);
}
