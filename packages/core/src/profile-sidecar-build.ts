import type { LidNode } from "./generated/LidNode";
import type { Window } from "./window";
import { buildPass1Input } from "./pass1-input";
import { pass1ContentHash, type Pass1ArtifactMeta } from "./build-resume";
import type { TechnicalLearningDiscourseItem } from "./discourse-index";
import type { FormulaSemanticsBuildCandidate } from "./formula-semantics";

export interface ProfileSidecarExtractionOutput {
  discourse_items?: TechnicalLearningDiscourseItem[];
  formula_semantics?: FormulaSemanticsBuildCandidate[];
}

export interface ProfileSidecarArtifact extends Pass1ArtifactMeta {
  discourse_items: TechnicalLearningDiscourseItem[];
  formula_semantics: FormulaSemanticsBuildCandidate[];
}

export interface ProfileSidecarWindowInput {
  window_id: number;
  visible_lids: string[];
  formula_lids: string[];
  text: string;
}

export interface ProfileSidecarStatus {
  done: number[];
  pending: number[];
}

export function buildProfileSidecarArtifact(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  output: ProfileSidecarExtractionOutput,
): ProfileSidecarArtifact {
  return {
    content_hash: pass1ContentHash(buildPass1Input(window, byLid, source)),
    discourse_items: output.discourse_items ?? [],
    formula_semantics: output.formula_semantics ?? [],
  };
}

export function buildProfileSidecarWindowInput(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
): ProfileSidecarWindowInput {
  const input = buildPass1Input(window, byLid, source);
  return {
    window_id: window.id,
    visible_lids: [...window.leafLids],
    formula_lids: window.leafLids.filter((lid) => byLid.get(lid)?.kind === "formula"),
    text: input.text,
  };
}

export function computeProfileSidecarStatus(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  existing: Map<number, Pass1ArtifactMeta>,
): ProfileSidecarStatus {
  const done: number[] = [];
  const pending: number[] = [];
  for (const w of windows) {
    const expected = pass1ContentHash(buildPass1Input(w, byLid, source));
    const got = existing.get(w.id);
    if (got && got.content_hash === expected) done.push(w.id);
    else pending.push(w.id);
  }
  return { done, pending };
}
