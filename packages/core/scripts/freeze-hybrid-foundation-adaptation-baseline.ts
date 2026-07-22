import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createHybridFoundationAdaptationBaseline,
  ExternalBenchmarkDescriptorZ,
  type HybridFoundationAdaptationIssueId,
} from "../src/hybrid-foundation-goldset";
import { validateHybridFoundationV2ArtifactSet, type HybridFoundationV2Artifacts } from "../src/hybrid-foundation-v2";

const DEFAULT_DESCRIPTOR_PATH = fileURLToPath(new URL(
  "../test/fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer.json",
  import.meta.url,
));

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function contentSpan(source: string, span: { start: number; end: number }) {
  const raw = source.slice(span.start, span.end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return { start: span.start + leading, end: span.end - trailing };
}

function isFullyCovered(
  span: { start: number; end: number },
  exactSpans: Array<{ start: number; end: number }>,
): boolean {
  for (let index = span.start; index < span.end; index += 1) {
    if (!exactSpans.some((exact) => index >= exact.start && index < exact.end)) return false;
  }
  return true;
}

function uncoveredSource(
  source: string,
  span: { start: number; end: number },
  exactSpans: Array<{ start: number; end: number }>,
): string {
  let uncovered = "";
  for (let index = span.start; index < span.end; index += 1) {
    if (!exactSpans.some((exact) => index >= exact.start && index < exact.end)) uncovered += source[index];
  }
  return uncovered;
}

function sectionLid(artifacts: HybridFoundationV2Artifacts, lid: string): string {
  const containers = new Set(artifacts.base.lid_nodes
    .filter((node) => node.children.length > 0)
    .map((node) => node.lid));
  const parts = lid.split(".");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join(".");
    if (containers.has(candidate)) return candidate;
  }
  return lid;
}

function classifyIssueIds(
  source: string,
  artifacts: HybridFoundationV2Artifacts,
): Partial<Record<string, HybridFoundationAdaptationIssueId[]>> {
  const nodesByLid = new Map(artifacts.base.lid_nodes.map((node) => [node.lid, node]));
  const result: Partial<Record<string, HybridFoundationAdaptationIssueId[]>> = {};
  for (const entry of artifacts.pdf_source_map.entries) {
    const issues = new Set<HybridFoundationAdaptationIssueId>();
    const raw = source.slice(entry.source_span.start, entry.source_span.end);
    const reason = entry.alignment.reason;
    const node = nodesByLid.get(entry.lid);
    if (node?.kind === "formula" && raw.includes("\\underline")) issues.add("PDF-A001");

    if (reason === "partial monotonic character projection inside located unit") {
      const trimmed = raw.trimStart();
      if (/^#{1,6}\s/u.test(trimmed) || /^[-*+]\s/u.test(trimmed)) {
        issues.add("PDF-A002");
      } else {
        const visibleSpan = contentSpan(source, entry.source_span);
        const uncovered = uncoveredSource(source, visibleSpan, entry.exact_source_spans);
        if (isFullyCovered(visibleSpan, entry.exact_source_spans)) issues.add("PDF-A004");
        else if (/[\p{L}\p{N}]/u.test(uncovered)) issues.add("PDF-A011");
        else issues.add("PDF-A003");
      }
    }
    if (reason === "child has no deterministic projection inside the located unit") issues.add("PDF-A005");
    if (
      reason === "formula has no unique bounded PDF gap"
      || reason === "formula projection is ambiguous inside the located unit"
    ) issues.add("PDF-A006");
    if (
      reason === "formula text is located but lacks same-page same-column anchors"
      || reason === "unique formula region bounded by exact same-page same-column text anchors"
    ) issues.add("PDF-A007");
    if (
      reason === "alignment unit has no exact monotonic candidate"
      || reason === "alignment unit has ambiguous forward candidates"
    ) issues.add("PDF-A008");
    if (reason === "projection discarded because its PDF binding conflicts with another LID") issues.add("PDF-A009");
    const section = sectionLid(artifacts, entry.lid);
    if (node?.kind === "image" || /^[2-8]$/u.test(section)) issues.add("PDF-A010");
    if (issues.size) result[entry.lid] = [...issues];
  }
  return result;
}

export function freezeHybridFoundationAdaptationBaseline(args: string[]) {
  const artifactDir = valueAfter(args, "--artifact-dir");
  if (!artifactDir) throw new Error("--artifact-dir requires an explicit directory");
  const descriptorPath = path.resolve(valueAfter(args, "--descriptor") ?? DEFAULT_DESCRIPTOR_PATH);
  if (!args.includes("--write")) throw new Error("freezing the adaptation baseline requires --write");
  const resolvedArtifactDir = path.resolve(artifactDir);
  const artifacts = validateHybridFoundationV2ArtifactSet(resolvedArtifactDir);
  const source = readFileSync(
    path.join(resolvedArtifactDir, artifacts.source_manifest.canonical_source.path),
    "utf8",
  );
  const previous = JSON.parse(readFileSync(descriptorPath, "utf8")) as Record<string, unknown>;
  const baseline = createHybridFoundationAdaptationBaseline({
    source,
    artifacts,
    issue_ids_by_lid: classifyIssueIds(source, artifacts),
  });
  const descriptor = ExternalBenchmarkDescriptorZ.parse({
    ...previous,
    version: "hybrid_foundation_external_benchmark.v2",
    expected_adaptation_v1: baseline,
  });
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  return {
    descriptor_path: descriptorPath,
    leaf_count: baseline.leaf_count,
    projection_reason_count: Object.keys(baseline.projection_reason_counts).length,
    section_count: baseline.section_stats.length,
    issue_counts: baseline.issue_counts,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(freezeHybridFoundationAdaptationBaseline(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
