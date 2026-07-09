// PH3 source reconciliation CLI:
// paper.md + paper.pdf -> .build/source-reconciliation/{report,review artifacts,source.txt?}
// Unresolved blocks exit non-zero and never write trusted stage source.txt.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { extractPdfTextGeometry } from "../../packages/core/src/pdf-geometry";
import {
  reconcilePaperSource,
  reviewCandidateAndReconcile,
  type ReviewCandidateKind,
  writeSourceReconciliationArtifacts,
} from "../../packages/core/src/source-reconciliation";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--book-id", "--out-dir", "--reviewed-draft", "--review-kind"]);
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

const markdownPath = positional[0];
const pdfPath = positional[1];
if (!markdownPath || !pdfPath) {
  console.error(
    "usage: tsx skills/build/source-reconcile.ts <paper.md> <paper.pdf> [--book-id <id>] [--out-dir <dir>] [--reviewed-draft <md>] [--review-kind llm_format_repair|manual_review]",
  );
  process.exit(2);
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const bookId = deriveBookId(markdownPath, opts["--book-id"]);
const outputDir = opts["--out-dir"] ?? `.understand-book/${bookId}`;
const markdown = readFileSync(markdownPath, "utf8");
const reviewedDraftPath = opts["--reviewed-draft"];
const reviewKind = (opts["--review-kind"] ?? "manual_review") as ReviewCandidateKind;
if (reviewKind !== "llm_format_repair" && reviewKind !== "manual_review") {
  console.error(`invalid --review-kind ${reviewKind}`);
  process.exit(2);
}
const pdfBytes = new Uint8Array(readFileSync(pdfPath));
const pdfGeometry = await extractPdfTextGeometry(pdfBytes);
const inputFingerprint = {
  paper_md_sha256: sha256(reviewedDraftPath ? readFileSync(reviewedDraftPath, "utf8") : markdown),
  paper_pdf_sha256: sha256(pdfBytes),
  config_hash: "monotonic_forward_fuzzy_v1",
};
const result = reviewedDraftPath
  ? reviewCandidateAndReconcile({
      book_id: bookId,
      original_source: markdown,
      candidate_source: readFileSync(reviewedDraftPath, "utf8"),
      pdf_geometry: pdfGeometry,
      input_fingerprint: inputFingerprint,
      kind: reviewKind,
    }).reconciliation
  : reconcilePaperSource({
  book_id: bookId,
  markdown_source: markdown,
  pdf_geometry: pdfGeometry,
  input_fingerprint: inputFingerprint,
});
if (!result) {
  console.error("review candidate rejected before reconciliation");
  process.exit(1);
}
const reviewedDraft = reviewedDraftPath ? readFileSync(reviewedDraftPath, "utf8") : undefined;
const artifacts = writeSourceReconciliationArtifacts(outputDir, result, reviewedDraft);

console.log(`[source-reconcile] bookId=${bookId} unresolved=${result.report.unresolved.length}`);
console.log(`  report: ${artifacts.report_path}`);
console.log(`  review draft: ${artifacts.review_draft_path}`);
console.log(`  review decisions: ${artifacts.review_decisions_path}`);
if (artifacts.source_path) console.log(`  trusted stage source: ${artifacts.source_path}`);
if (artifacts.reviewed_draft_path) console.log(`  reviewed draft: ${artifacts.reviewed_draft_path}`);

if (result.report.unresolved.length) {
  console.error("  trusted source blocked; resolve review artifacts and rerun");
  process.exit(1);
}
