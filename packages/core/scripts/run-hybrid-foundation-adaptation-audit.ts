import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  auditHybridFoundationAdaptation,
  ExternalBenchmarkDescriptorZ,
  HybridFoundationAdaptationMigrationMapZ,
  serializeHybridFoundationAdaptationAudit,
  type HybridFoundationAdaptationAuditReport,
} from "../src/hybrid-foundation-goldset";
import { validateHybridFoundationV2ArtifactSet } from "../src/hybrid-foundation-v2";

const DEFAULT_DESCRIPTOR_PATH = fileURLToPath(new URL(
  "../test/fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer.json",
  import.meta.url,
));

interface CliOptions {
  artifact_dir: string;
  descriptor_path: string;
  migration_map_path?: string;
  output_path?: string;
}

function parseArgs(args: string[]): CliOptions {
  let artifactDir: string | undefined;
  let descriptorPath = DEFAULT_DESCRIPTOR_PATH;
  let migrationMapPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--artifact-dir") {
      if (!value) throw new Error("--artifact-dir requires an explicit directory");
      artifactDir = path.resolve(value);
      index += 1;
    } else if (arg === "--descriptor") {
      if (!value) throw new Error("--descriptor requires a path");
      descriptorPath = path.resolve(value);
      index += 1;
    } else if (arg === "--migration-map") {
      if (!value) throw new Error("--migration-map requires a path");
      migrationMapPath = path.resolve(value);
      index += 1;
    } else if (arg === "--output") {
      if (!value) throw new Error("--output requires a path");
      outputPath = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!artifactDir) throw new Error("--artifact-dir requires an explicit directory");
  return {
    artifact_dir: artifactDir,
    descriptor_path: descriptorPath,
    ...(migrationMapPath ? { migration_map_path: migrationMapPath } : {}),
    ...(outputPath ? { output_path: outputPath } : {}),
  };
}

export async function runHybridFoundationAdaptationAuditCli(
  args: string[],
): Promise<HybridFoundationAdaptationAuditReport> {
  const options = parseArgs(args);
  const descriptor = ExternalBenchmarkDescriptorZ.parse(JSON.parse(readFileSync(options.descriptor_path, "utf8")));
  const artifacts = validateHybridFoundationV2ArtifactSet(options.artifact_dir, {
    expected_pdf_sha256: descriptor.input_sha256.pdf,
    expected_source_alignment_evidence_sha256:
      descriptor.expected_adaptation_v1.input_fingerprint.source_alignment_evidence_sha256,
  });
  if (artifacts.base.book_id !== descriptor.book_id) {
    throw new Error(`adaptation audit book_id mismatch: ${artifacts.base.book_id}`);
  }
  const source = readFileSync(
    path.join(options.artifact_dir, artifacts.source_manifest.canonical_source.path),
    "utf8",
  );
  const migrationMap = options.migration_map_path
    ? HybridFoundationAdaptationMigrationMapZ.parse(JSON.parse(readFileSync(options.migration_map_path, "utf8")))
    : undefined;
  const report = auditHybridFoundationAdaptation({
    source,
    artifacts,
    baseline: descriptor.expected_adaptation_v1,
    ...(migrationMap ? { lid_migration_map: migrationMap } : {}),
  });
  if (options.output_path) writeFileSync(options.output_path, serializeHybridFoundationAdaptationAudit(report), "utf8");
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHybridFoundationAdaptationAuditCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(serializeHybridFoundationAdaptationAudit(report));
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
