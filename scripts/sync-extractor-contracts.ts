import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderExtractorContractMarkdown,
  type ContractedExtractorStage,
} from "../packages/core/src/extractor-contract";

export const EXTRACTOR_CONTRACT_BEGIN_MARKER = "<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->";
export const EXTRACTOR_CONTRACT_END_MARKER = "<!-- END GENERATED EXTRACTOR CONTRACT -->";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TARGETS: ReadonlyArray<{ stage: ContractedExtractorStage; relative_path: string }> = [
  { stage: "paper_metadata", relative_path: "agents/paper-metadata-extractor.md" },
  { stage: "paper_lexicon", relative_path: "agents/paper-lexicon-extractor.md" },
  { stage: "profile_sidecar", relative_path: "agents/profile-sidecar-extractor.md" },
];

function markerOffsets(text: string, marker: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const offset = text.indexOf(marker, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + marker.length;
  }
  return offsets;
}

function normalizedGeneratedBlock(prompt: string, generated: string): string {
  const eol = prompt.includes("\r\n") ? "\r\n" : "\n";
  return generated.replace(/\r\n?|\n/gu, eol);
}

export function replaceGeneratedExtractorContractBlock(
  prompt: string,
  generated: string,
): string {
  const promptBegins = markerOffsets(prompt, EXTRACTOR_CONTRACT_BEGIN_MARKER);
  const promptEnds = markerOffsets(prompt, EXTRACTOR_CONTRACT_END_MARKER);
  const generatedBegins = markerOffsets(generated, EXTRACTOR_CONTRACT_BEGIN_MARKER);
  const generatedEnds = markerOffsets(generated, EXTRACTOR_CONTRACT_END_MARKER);
  if (promptBegins.length !== 1 || promptEnds.length !== 1) {
    throw new Error("extractor prompt must contain exactly one generated contract marker pair");
  }
  if (generatedBegins.length !== 1 || generatedEnds.length !== 1
    || generatedBegins[0] !== 0
    || generatedEnds[0]! + EXTRACTOR_CONTRACT_END_MARKER.length !== generated.length) {
    throw new Error("rendered extractor contract must be exactly one generated marker block");
  }
  const start = promptBegins[0]!;
  const end = promptEnds[0]!;
  if (end <= start) throw new Error("extractor prompt generated contract markers are out of order");
  return [
    prompt.slice(0, start),
    normalizedGeneratedBlock(prompt, generated),
    prompt.slice(end + EXTRACTOR_CONTRACT_END_MARKER.length),
  ].join("");
}

export function syncExtractorContracts(
  mode: "check" | "write",
  repoRoot = REPO_ROOT,
): { checked: number; changed: string[] } {
  const projections = TARGETS.map((target) => {
    const file = path.join(repoRoot, ...target.relative_path.split("/"));
    const current = readFileSync(file, "utf8");
    const generated = renderExtractorContractMarkdown(target.stage);
    const projected = replaceGeneratedExtractorContractBlock(current, generated);
    return { ...target, file, current, projected };
  });
  const changed = projections
    .filter((projection) => projection.current !== projection.projected)
    .map((projection) => projection.relative_path);
  if (mode === "check" && changed.length) {
    throw new Error(`extractor contract blocks are stale: ${changed.join(", ")}`);
  }
  if (mode === "write") {
    for (const projection of projections) {
      if (projection.current !== projection.projected) {
        writeFileSync(projection.file, projection.projected, "utf8");
      }
    }
  }
  return { checked: projections.length, changed };
}

function runCli(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--write")) {
    throw new Error("usage: sync-extractor-contracts.ts <--check|--write>");
  }
  const mode = args[0] === "--check" ? "check" : "write";
  const result = syncExtractorContracts(mode);
  process.stdout.write(
    mode === "check"
      ? `extractor contracts synchronized (${result.checked} checked)\n`
      : `extractor contracts synchronized (${result.changed.length} updated)\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : "extractor contract synchronization failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
