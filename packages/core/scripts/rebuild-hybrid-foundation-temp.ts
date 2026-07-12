import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractPdfTextGeometry } from "../src/pdf-geometry";
import {
  assertHybridFoundationHardGates,
  buildHybridFoundation,
  writeHybridFoundationArtifacts,
  type HybridFoundationArtifacts,
} from "../src/hybrid-foundation";

interface ExistingSourceManifest {
  book_id: string;
  canonical_source: { path: string; sha256: string };
  original_pdf: { path: string; sha256: string };
}

interface ExistingBase {
  lid_nodes: Array<{
    lid: string;
    span: { start: number; end: number };
    children: string[];
  }>;
}

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const DEFAULT_LIDS = ["2.47.23", "2.47.23.1", "2.47.24", "2.47.24.1"];

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function officialCoreHashes(bookDir: string): Record<string, string> {
  const files = [
    "base.json",
    "source.txt",
    "source_manifest.json",
    "pdf_source_map.json",
    "pdf_selection_map/manifest.json",
    "alignment_report.json",
  ];
  return Object.fromEntries(files.map((relativePath) => {
    const file = path.join(bookDir, relativePath);
    return [relativePath, existsSync(file) ? sha256(readFileSync(file)) : "missing"];
  }));
}

function firstLeafLid(lid: string, nodes: Map<string, ExistingBase["lid_nodes"][number]>): string | undefined {
  const node = nodes.get(lid);
  if (!node) return undefined;
  if (!node.children.length) return lid;
  for (const child of node.children) {
    const leaf = firstLeafLid(child, nodes);
    if (leaf) return leaf;
  }
  return undefined;
}

function mappingSummary(
  artifacts: HybridFoundationArtifacts,
  source: string,
  requestedLids: string[],
): Record<string, unknown> {
  const nodes = new Map(artifacts.base.lid_nodes.map((node) => [node.lid, node]));
  const entries = new Map(artifacts.pdf_source_map.entries.map((entry) => [entry.lid, entry]));
  const outlineNodes = artifacts.base.lid_nodes.filter((node) => node.children.length > 0);
  const mappedOutlineCount = outlineNodes.filter((node) => {
    const leaf = firstLeafLid(node.lid, nodes);
    return leaf ? entries.get(leaf)?.status !== "unmapped" : false;
  }).length;

  let previousPage = -1;
  const pageRegressions: Array<{ lid: string; previous_page: number; page: number }> = [];
  for (const entry of artifacts.pdf_source_map.entries) {
    const page = entry.primary_region?.pageIndex;
    if (page === undefined) continue;
    if (page < previousPage) pageRegressions.push({ lid: entry.lid, previous_page: previousPage, page });
    previousPage = page;
  }

  return {
    diagnostics: artifacts.alignment_report.diagnostics,
    hard_gates: artifacts.alignment_report.hard_gates,
    outline_mapping: {
      total: outlineNodes.length,
      mapped: mappedOutlineCount,
      ratio: outlineNodes.length ? mappedOutlineCount / outlineNodes.length : 1,
    },
    page_regressions: pageRegressions,
    requested_lids: requestedLids.map((requestedLid) => {
      const resolvedLid = firstLeafLid(requestedLid, nodes);
      const node = resolvedLid ? nodes.get(resolvedLid) : undefined;
      const entry = resolvedLid ? entries.get(resolvedLid) : undefined;
      return {
        requested_lid: requestedLid,
        resolved_lid: resolvedLid,
        source_text: node ? source.slice(node.span.start, node.span.end) : undefined,
        status: entry?.status,
        page: entry?.primary_region?.pageIndex,
        regions: entry?.regions,
        alignment: entry?.alignment,
      };
    }),
  };
}

async function main(): Promise<void> {
  const bookDir = path.resolve(process.argv[2] ?? path.join(WORKSPACE_ROOT, ".understand-book", "1"));
  const requestedLids = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_LIDS;
  const manifestPath = path.join(bookDir, "source_manifest.json");
  const oldBasePath = path.join(bookDir, "base.json");
  if (!existsSync(manifestPath) || !existsSync(oldBasePath)) {
    throw new Error(`book directory is missing official foundation artifacts: ${bookDir}`);
  }

  const manifest = readJson<ExistingSourceManifest>(manifestPath);
  const oldBase = readJson<ExistingBase>(oldBasePath);
  const sourcePath = path.resolve(bookDir, manifest.canonical_source.path);
  const pdfPath = path.resolve(bookDir, manifest.original_pdf.path);
  const source = readFileSync(sourcePath, "utf8");
  const pdfBytes = new Uint8Array(readFileSync(pdfPath));
  if (sha256(source) !== manifest.canonical_source.sha256) throw new Error("canonical source hash mismatch");
  if (sha256(pdfBytes) !== manifest.original_pdf.sha256) throw new Error("original PDF hash mismatch");

  const officialBefore = officialCoreHashes(bookDir);
  const geometry = await extractPdfTextGeometry(pdfBytes);
  const artifacts = buildHybridFoundation({
    book_id: manifest.book_id,
    source_txt: source,
    original_pdf_path: manifest.original_pdf.path.replaceAll("\\", "/"),
    original_pdf_sha256: manifest.original_pdf.sha256,
    pdf_geometry: geometry,
  });
  const tempDir = mkdtempSync(path.join(WORKSPACE_ROOT, ".tmp-hybrid-foundation-v2-"));
  writeFileSync(
    path.join(tempDir, "candidate-pdf-lines.json"),
    JSON.stringify(geometry.pages.map((page) => ({
      pageIndex: page.pageIndex,
      lines: page.lines.map((line) => ({ lineIndex: line.lineIndex, text: line.text, bbox: line.bbox })),
    })), null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(tempDir, "candidate-pdf-source-map.json"),
    JSON.stringify(artifacts.pdf_source_map, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(tempDir, "candidate-alignment-report.json"),
    JSON.stringify(artifacts.alignment_report, null, 2),
    "utf8",
  );
  let gatesPassed = true;
  let gateError: string | undefined;
  try {
    assertHybridFoundationHardGates(artifacts);
    writeHybridFoundationArtifacts(tempDir, source, artifacts);
  } catch (error) {
    gatesPassed = false;
    gateError = error instanceof Error ? error.message : String(error);
  }

  const oldLids = oldBase.lid_nodes.map((node) => node.lid);
  const newLids = artifacts.base.lid_nodes.map((node) => node.lid);
  const officialAfter = officialCoreHashes(bookDir);
  const summary = {
    version: "temp_hybrid_foundation_rebuild.v1",
    book_dir: bookDir,
    output_dir: tempDir,
    official_core_files_unchanged: JSON.stringify(officialBefore) === JSON.stringify(officialAfter),
    source_hash_verified: true,
    pdf_hash_verified: true,
    lid_identity_equal: JSON.stringify(oldLids) === JSON.stringify(newLids),
    old_lid_count: oldLids.length,
    new_lid_count: newLids.length,
    gates_passed: gatesPassed,
    ...(gateError ? { gate_error: gateError } : {}),
    ...mappingSummary(artifacts, source, requestedLids),
  };
  writeFileSync(path.join(tempDir, "temp-rebuild-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
