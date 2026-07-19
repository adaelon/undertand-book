import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyPaperReadingGuideProjection } from "../../packages/core/src/paper-reading-guide-verification";
import { REPRODUCIBLE_ARTIFACT_TIMESTAMP } from "../../packages/core/src/profile-artifact";

const workspace = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!workspace) {
  console.error("usage: tsx skills/build/verify-paper-reading-guide.ts <paper-workspace>");
  process.exit(2);
}

const required = ["source.txt", "base.json", "paper_metadata.json", "paper_lexicon.json", "book_structure.json"];
for (const relative of required) {
  const file = path.join(workspace, relative);
  if (!existsSync(file)) throw new Error(`PaperReadingGuide verification input missing: ${file}`);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const projection = verifyPaperReadingGuideProjection(workspace);
const outputDir = path.join(workspace, ".build", "paper-reading-guide");
mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, "verification.json");
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify({
  version: "paper_reading_guide_verification.v1",
  verified_at: REPRODUCIBLE_ARTIFACT_TIMESTAMP,
  inputs: Object.fromEntries(required.map((relative) => [relative, sha256File(path.join(workspace, relative))])),
  mode: "close",
  stage: "active",
  verifier: "typescript_projection_gate.v1",
  ...projection,
}, null, 2), "utf8");
renameSync(temporary, output);
console.log(JSON.stringify({ verification_path: output, ...projection }));
