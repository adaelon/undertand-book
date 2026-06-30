// PB6 profile-sidecar batch: close the independent sidecar pass only.
//   tsx skills/build/profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { FormulaSemanticsSidecarZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import {
  computeProfileSidecarStatus,
  type ProfileSidecarArtifact,
} from "../../packages/core/src/profile-sidecar-build";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { loadBookWindows } from "./load-book";

const argv = process.argv.slice(2);
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const allowPartial = argv.includes("--allow-partial");
if (!book) {
  console.error("usage: tsx profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]");
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const buildDir = `.understand-book/${bookId}/.build/profile-sidecar`;
const existing = new Map<number, Pass1ArtifactMeta>();
const artifacts = new Map<number, ProfileSidecarArtifact>();
for (const w of windows) {
  const f = `${buildDir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const artifact = JSON.parse(readFileSync(f, "utf8")) as ProfileSidecarArtifact;
  artifacts.set(w.id, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(w.id, { content_hash: artifact.content_hash });
}

const { done, pending } = computeProfileSidecarStatus(windows, byLid, source, existing);
if (pending.length && !allowPartial) {
  console.error(`[profile-sidecar-batch] refusing close: ${pending.length}/${windows.length} windows pending`);
  console.error(`  pending ids: ${pending.join(",")}`);
  console.error("  resume with profile-sidecar-input + extractor + profile-sidecar-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const discourseItems: TechnicalLearningDiscourseItem[] = [];
const formulaCandidates: FormulaSemanticsBuildCandidate[] = [];
for (const id of done) {
  const artifact = artifacts.get(id)!;
  discourseItems.push(...(artifact.discourse_items ?? []));
  formulaCandidates.push(...(artifact.formula_semantics ?? []));
}

const header = buildProfileArtifactHeader({ book_id: bookId });
const discourse = buildTechnicalLearningDiscourseIndex(header, discourseItems, lidNodes);
const formula = buildFormulaSemanticsSidecar(header, formulaCandidates, lidNodes);
TechnicalLearningDiscourseIndexZ.parse(discourse.sidecar);
FormulaSemanticsSidecarZ.parse(formula.sidecar);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/discourse_index.json`, JSON.stringify(discourse.sidecar, null, 2), "utf8");
writeFileSync(`${outDir}/formula_semantics.json`, JSON.stringify(formula.sidecar, null, 2), "utf8");

console.log(`[profile-sidecar-batch] ${book}  bookId=${bookId}${allowPartial && pending.length ? "  [--allow-partial]" : ""}`);
console.log(`  windows=${windows.length} done=${done.length} pending=${pending.length}`);
console.log(`  discourse_index.json items=${discourse.sidecar.items.length} dropped=${discourse.dropped.length}`);
console.log(`  formula_semantics.json items=${formula.sidecar.items.length} pending=${formula.pending.length}`);
