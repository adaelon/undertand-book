import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { detectBuildReadiness, readBuildWorkbenchSnapshot } from "../src/build-workbench";
import { hybridFoundationArtifactSetDigest } from "../src/hybrid-foundation-apply";
import { validateHybridFoundationV2ArtifactSet } from "../src/hybrid-foundation-v2";
import { runWorkbenchStage } from "../src/workbench-stage-runner";

interface ExternalDescriptor {
  book_id: string;
  input_sha256: { source: string; pdf: string };
  annotations: Array<{
    annotation_id: string;
    source_span: { start: number; end: number };
    expected_page_index: number;
  }>;
  expected_v1: { mapped_text_ratio: number };
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const external = argument("--external");
if (!external) throw new Error("usage: run-hybrid-foundation-release-gate --external <book-dir> [--keep]");
const externalDir = path.resolve(external);
const descriptorPath = fileURLToPath(new URL(
  "../test/fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer.json",
  import.meta.url,
));
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as ExternalDescriptor;
const sourcePath = path.join(externalDir, ".build", "source-reconciliation", "source.txt");
const pdfPath = path.join(externalDir, "paper.pdf");
const source = readFileSync(sourcePath);
const pdf = readFileSync(pdfPath);
if (sha256(source) !== descriptor.input_sha256.source || sha256(pdf) !== descriptor.input_sha256.pdf) {
  throw new Error("external release-gate input hashes differ from the frozen descriptor");
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "understand-book-hf2-release-"));
const isolatedBook = path.join(tempRoot, descriptor.book_id);
const keep = process.argv.includes("--keep");
try {
  cpSync(externalDir, isolatedBook, { recursive: true });
  const jobFiles = readdirSync(path.join(isolatedBook, ".build", "jobs"))
    .filter((name) => name.endsWith(".json"));
  if (jobFiles.length !== 1) throw new Error("external release gate requires exactly one durable build job");
  const jobId = path.basename(jobFiles[0], ".json");
  const manifest = JSON.parse(readFileSync(path.join(isolatedBook, ".build", "input", "manifest.json"), "utf8"));

  const sourceJob = await runWorkbenchStage({
    book_dir: isolatedBook,
    job_id: jobId,
    stage: "source_reconciliation",
    now: "hf2-release-source",
  });
  if (sourceJob.status !== "ready" && sourceJob.status !== "done") {
    throw new Error(`isolated source reconciliation did not complete: ${sourceJob.failure_summary?.message ?? sourceJob.status}`);
  }
  const foundationJob = await runWorkbenchStage({
    book_dir: isolatedBook,
    job_id: jobId,
    stage: "hybrid_foundation",
    now: "hf2-release-foundation-1",
  });
  if (foundationJob.status !== "done") {
    throw new Error(`isolated hybrid foundation did not complete: ${foundationJob.failure_summary?.message ?? foundationJob.status}`);
  }
  const artifacts = validateHybridFoundationV2ArtifactSet(isolatedBook);
  const firstDigest = hybridFoundationArtifactSetDigest(isolatedBook);
  const repeatedJob = await runWorkbenchStage({
    book_dir: isolatedBook,
    job_id: jobId,
    stage: "hybrid_foundation",
    now: "hf2-release-foundation-2",
  });
  if (repeatedJob.status !== "done") {
    throw new Error(`repeated hybrid foundation did not complete: ${repeatedJob.failure_summary?.message ?? repeatedJob.status}`);
  }
  const secondDigest = hybridFoundationArtifactSetDigest(isolatedBook);

  const wrongPages = descriptor.annotations.filter((annotation) => {
    const entry = artifacts.pdf_source_map.entries.find((candidate) => (
      candidate.source_span.start <= annotation.source_span.start
      && candidate.source_span.end >= annotation.source_span.end
    ));
    const pages = new Set(entry?.regions.map((region) => region.pageIndex) ?? []);
    return !pages.has(annotation.expected_page_index);
  }).map((annotation) => annotation.annotation_id);
  const regionOwners = new Map<string, Set<string>>();
  for (const entry of artifacts.pdf_source_map.entries) {
    for (const region of entry.regions) {
      const key = `${region.pageIndex}:${region.bbox.join(",")}`;
      const owners = regionOwners.get(key) ?? new Set<string>();
      owners.add(entry.lid);
      regionOwners.set(key, owners);
    }
  }
  const duplicateRegionBindings = [...regionOwners.values()].filter((owners) => owners.size > 1).length;
  const selectionBindings = new Set<string>();
  let duplicateSelectionBindings = 0;
  for (const page of artifacts.pdf_selection_map_pages) {
    for (const char of page.chars) {
      const key = `${page.pageIndex}:${char.char_index}`;
      if (selectionBindings.has(key)) duplicateSelectionBindings += 1;
      selectionBindings.add(key);
    }
  }
  const readiness = detectBuildReadiness(readBuildWorkbenchSnapshot(isolatedBook, {
    current_input_fingerprint: manifest.fingerprint,
  }));
  const report = {
    version: "hybrid_foundation_release_gate.v1",
    book_id: artifacts.base.book_id,
    isolated_book_dir: keep ? isolatedBook : null,
    artifact_versions: {
      source_map: artifacts.pdf_source_map.version,
      selection_map: artifacts.pdf_selection_map_manifest.version,
      alignment_report: artifacts.alignment_report.version,
    },
    integrity: artifacts.alignment_report.integrity,
    quality: artifacts.alignment_report.quality,
    diagnostics: artifacts.alignment_report.diagnostics,
    wrong_page_annotations: wrongPages,
    duplicate_region_bindings: duplicateRegionBindings,
    duplicate_selection_bindings: duplicateSelectionBindings,
    readiness: { route: readiness.route, status: readiness.status },
    repeatability: { first_digest: firstDigest, second_digest: secondDigest, equal: firstDigest === secondDigest },
  };
  const passed = Object.values(report.integrity).every(Boolean)
    && report.quality.exact_text_span_ratio > descriptor.expected_v1.mapped_text_ratio
    && wrongPages.length === 0
    && duplicateRegionBindings === 0
    && duplicateSelectionBindings === 0
    && readiness.route === "reader"
    && firstDigest === secondDigest;
  if (!passed) throw new Error(`hybrid foundation release gate failed: ${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (!keep) rmSync(tempRoot, { recursive: true, force: true });
}
