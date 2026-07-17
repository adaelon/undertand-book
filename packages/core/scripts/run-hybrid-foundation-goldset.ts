import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadGoldsetManifest,
  runExternalGoldsetBenchmark,
  runLicensedGoldsetFixture,
  type HybridFoundationGoldsetReport,
} from "../src/hybrid-foundation-goldset";

const GOLDSET_ROOT = path.resolve(fileURLToPath(new URL("../test/fixtures/hybrid-foundation-goldset/v1", import.meta.url)));
const EXTERNAL_BENCHMARK_ID = "external-formula-dense-transformer";

interface CliOptions {
  fixtures: string[];
  external_book_dir?: string;
  output_path?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { fixtures: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fixture") {
      const fixture = args[++index];
      if (!fixture) throw new Error("--fixture requires an id");
      options.fixtures.push(fixture);
    } else if (arg === "--external") {
      const bookDir = args[++index];
      if (!bookDir) throw new Error("--external requires an explicit book directory");
      options.external_book_dir = path.resolve(bookDir);
    } else if (arg === "--output") {
      const outputPath = args[++index];
      if (!outputPath) throw new Error("--output requires a path");
      options.output_path = path.resolve(outputPath);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function runHybridFoundationGoldsetCli(args: string[]): Promise<HybridFoundationGoldsetReport[]> {
  const options = parseArgs(args);
  const manifest = loadGoldsetManifest(GOLDSET_ROOT);
  const fixtureIds = options.fixtures.length
    ? options.fixtures
    : options.external_book_dir
      ? []
      : manifest.fixtures.map((fixture) => fixture.fixture_id);
  const reports: HybridFoundationGoldsetReport[] = [];
  for (const fixtureId of fixtureIds) {
    reports.push((await runLicensedGoldsetFixture(GOLDSET_ROOT, fixtureId)).report);
  }
  if (options.external_book_dir) {
    reports.push((await runExternalGoldsetBenchmark(
      GOLDSET_ROOT,
      EXTERNAL_BENCHMARK_ID,
      options.external_book_dir,
    )).report);
  }
  if (options.output_path) writeFileSync(options.output_path, JSON.stringify(reports, null, 2), "utf8");
  return reports;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHybridFoundationGoldsetCli(process.argv.slice(2))
    .then((reports) => process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
