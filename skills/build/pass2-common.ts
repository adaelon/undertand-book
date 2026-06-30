import { existsSync, readFileSync } from "node:fs";
import type { ReadOnlyBase } from "../../packages/core/src/generated/ReadOnlyBase";
import type { FormulaSemantics } from "../../packages/core/src/generated/FormulaSemantics";
import type { TechnicalLearningDiscourseIndex } from "../../packages/core/src/discourse-index";
import { deriveBookId } from "../../packages/core/src/book-id";
import { buildPass2Candidates, buildPass2WorkPacket } from "../../packages/core/src/pass2-orchestrate";
import type { LongRangeCandidateIndex, Pass2WorkPacket } from "../../packages/core/src/pass2-build";
import { loadBookWindows, windowById, type LoadedBook } from "./load-book";

export interface Pass2BuildContext extends LoadedBook {
  bookId: string;
  baseDir: string;
  base: ReadOnlyBase;
  discourseIndex: TechnicalLearningDiscourseIndex;
  formulaSemantics: FormulaSemantics[];
  candidateIndex: LongRangeCandidateIndex;
  packets: Map<number, Pass2WorkPacket>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} missing: ${path}`);
}

export function loadPass2BuildContext(book: string, override?: string): Pass2BuildContext {
  const loaded = loadBookWindows(book);
  const bookId = deriveBookId(book, override);
  const baseDir = `.understand-book/${bookId}`;
  const basePath = `${baseDir}/base.json`;
  const discoursePath = `${baseDir}/discourse_index.json`;
  const formulaPath = `${baseDir}/formula_semantics.json`;
  requireFile(basePath, "base.json");
  requireFile(discoursePath, "discourse_index.json (run profile-sidecar-batch first)");
  requireFile(formulaPath, "formula_semantics.json (run profile-sidecar-batch first)");

  const base = readJson<ReadOnlyBase>(basePath);
  const discourseIndex = readJson<TechnicalLearningDiscourseIndex>(discoursePath);
  const formulaSidecar = readJson<{ items?: FormulaSemantics[] } | FormulaSemantics[]>(formulaPath);
  const formulaSemantics = Array.isArray(formulaSidecar) ? formulaSidecar : formulaSidecar.items ?? [];
  const candidateIndex = buildPass2Candidates({
    graphNodes: base.graph_nodes,
    windows: loaded.windows,
    discourseIndex,
    formulaSemantics,
  });
  const packets = new Map<number, Pass2WorkPacket>();
  for (const w of loaded.windows) {
    packets.set(
      w.id,
      buildPass2WorkPacket({
        window: windowById(loaded.windows, w.id),
        byLid: loaded.byLid,
        source: loaded.source,
        graphNodes: base.graph_nodes,
        candidates: candidateIndex.candidates,
        discourseIndex,
        formulaSemantics,
      }),
    );
  }
  return { ...loaded, bookId, baseDir, base, discourseIndex, formulaSemantics, candidateIndex, packets };
}

export function parseBookArgs(argv: string[]): { book: string; override?: string; allowPartial: boolean; positional: string[] } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const book = positional[0];
  const bookIdIdx = argv.indexOf("--book-id");
  const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
  return { book, override, allowPartial: argv.includes("--allow-partial"), positional };
}
