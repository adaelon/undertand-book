import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  inspectPaperLexiconCommittedArtifact,
  type PaperLexiconCommittedArtifactV1,
} from "./paper-lexicon-router";

export function readPaperLexiconCommittedArtifacts(
  directory: string,
): Map<string, PaperLexiconCommittedArtifactV1> {
  const artifacts = new Map<string, PaperLexiconCommittedArtifactV1>();
  if (!existsSync(directory)) return artifacts;
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const value = JSON.parse(readFileSync(path.join(directory, name), "utf8").replace(/^\uFEFF/, "")) as unknown;
    const committed = inspectPaperLexiconCommittedArtifact(value);
    if (!committed) continue;
    artifacts.set(name.slice(0, -".json".length), committed);
  }
  return artifacts;
}
