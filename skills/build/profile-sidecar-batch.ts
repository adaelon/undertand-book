// PB6 profile-sidecar batch: close the independent sidecar pass only.
//   tsx skills/build/profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] [--content-profile technical_learning]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { FormulaSemanticsSidecarZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import type { ProfileSidecarArtifact } from "../../packages/core/src/profile-sidecar-build";
import { computeProfileSidecarCandidateStatus } from "../../packages/core/src/profile-sidecar-router";
import type { Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows } from "./load-book";
import { semanticArtifactPayload } from "../../packages/core/src/semantic-artifact";
import { publishAutomaticBuildArtifactSet } from "../../packages/core/src/automatic-build-publication";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const allowPartial = argv.includes("--allow-partial");
if (!book) {
  console.error(`usage: tsx profile-sidecar-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, override);
const buildDir = `.understand-book/${bookId}/.build/profile-sidecar`;
const initial = computeProfileSidecarCandidateStatus({ windows, byLid, source, content_profile: parsedProfile.contentProfile, existing: new Map() });
const existing = new Map<string, Pass1ArtifactMeta>();
const artifacts = new Map<string, ProfileSidecarArtifact>();
for (const workUnitId of Object.keys(initial.analysis.packets)) {
  const f = `${buildDir}/${workUnitId}.json`;
  if (!existsSync(f)) continue;
  const artifact = semanticArtifactPayload<ProfileSidecarArtifact>(JSON.parse(readFileSync(f, "utf8")));
  artifacts.set(workUnitId, artifact);
  if (typeof artifact?.content_hash === "string") existing.set(workUnitId, { content_hash: artifact.content_hash });
}

const status = computeProfileSidecarCandidateStatus({ windows, byLid, source, content_profile: parsedProfile.contentProfile, existing });
if (status.pending && !allowPartial) {
  console.error(`[profile-sidecar-batch] refusing close: ${status.pending}/${status.eligible} semantic units pending`);
  console.error(`  pending ids: ${status.pending_ids.join(",")}`);
  console.error("  resume with profile-sidecar-input + extractor + profile-sidecar-write; use --allow-partial only for smoke/emergency");
  process.exit(1);
}

const discourseItems: TechnicalLearningDiscourseItem[] = [];
const formulaCandidates: FormulaSemanticsBuildCandidate[] = [];
for (const id of status.done_ids) {
  const artifact = artifacts.get(id)!;
  discourseItems.push(...(artifact.discourse_items ?? []));
  formulaCandidates.push(...(artifact.formula_semantics ?? []));
}

const header = buildReproducibleProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const discourse = buildTechnicalLearningDiscourseIndex(header, discourseItems, lidNodes);
const formula = buildFormulaSemanticsSidecar(header, formulaCandidates, lidNodes);
TechnicalLearningDiscourseIndexZ.parse(discourse.sidecar);
FormulaSemanticsSidecarZ.parse(formula.sidecar);

const outDir = `.understand-book/${bookId}`;
mkdirSync(outDir, { recursive: true });
publishAutomaticBuildArtifactSet({
  workspace_dir: outDir,
  stage: "profile_sidecar",
  artifacts: {
    "discourse_index.json": JSON.stringify(discourse.sidecar, null, 2),
    "formula_semantics.json": JSON.stringify(formula.sidecar, null, 2),
  },
});

console.log(`[profile-sidecar-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && status.pending ? "  [--allow-partial]" : ""}`);
console.log(`  discourse_lids=${status.analysis.accounting.discourse_eligible_lids} groups=${status.analysis.accounting.discourse_groups} formula_total=${status.analysis.accounting.formula_total} formula_eligible=${status.analysis.accounting.formula_eligible} skipped=${status.skipped} done=${status.committed} pending=${status.pending}`);
console.log(`  discourse_index.json items=${discourse.sidecar.items.length} dropped=${discourse.dropped.length}`);
console.log(`  formula_semantics.json items=${formula.sidecar.items.length} pending=${formula.pending.length}`);
