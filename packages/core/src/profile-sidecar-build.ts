import type { LidNode } from "./generated/LidNode";
import type { Window } from "./window";
import { buildPass1Input } from "./pass1-input";
import { pass1ContentHash, type Pass1ArtifactMeta } from "./build-resume";
import {
  PAPER_PROFILE_ID,
  TECHNICAL_LEARNING_PROFILE,
  type ContentProfileDefinition,
  type PaperProfileDefinition,
} from "./content-profile";
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

export function profileSidecarContentHash(window: Window, input: ProfileSidecarWindowInput): string {
  return pass1ContentHash({ windowId: window.id, lids: [...window.leafLids], text: input.text });
}

export function buildProfileSidecarArtifact(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  output: ProfileSidecarExtractionOutput,
  contentProfile: ContentProfileDefinition = TECHNICAL_LEARNING_PROFILE,
): ProfileSidecarArtifact {
  return {
    content_hash: profileSidecarContentHash(window, buildProfileSidecarWindowInput(window, byLid, source, contentProfile)),
    discourse_items: output.discourse_items ?? [],
    formula_semantics: output.formula_semantics ?? [],
  };
}

function renderPaperProfileSidecarInput(profile: PaperProfileDefinition, baseText: string): string {
  return [
    "PAPER_DISCOURSE_RULES",
    `content_profile: ${PAPER_PROFILE_ID}`,
    `paper_subtype: ${profile.paper.paper_subtype}`,
    "discourse_focus: abstract_summary, problem_framing, related_work_positioning, method_description, experiment_setup, evidence_report, result_interpretation, limitation, future_work",
    `argument_slots: ${profile.paper.effective_rules.argument_shape.slots.join(", ")}`,
    "policy: discourse labels are paragraph functions, not final reasoning conclusions; omit low-confidence labels",
    "",
    "TEXT",
    baseText,
  ].join("\n");
}

export function renderProfileSidecarDiscourseText(profile: ContentProfileDefinition, baseText: string): string {
  return profile.id === PAPER_PROFILE_ID ? renderPaperProfileSidecarInput(profile, baseText) : baseText;
}

export function buildProfileSidecarWindowInput(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  contentProfile: ContentProfileDefinition = TECHNICAL_LEARNING_PROFILE,
): ProfileSidecarWindowInput {
  const input = buildPass1Input(window, byLid, source);
  return {
    window_id: window.id,
    visible_lids: [...window.leafLids],
    formula_lids: window.leafLids.filter((lid) => byLid.get(lid)?.kind === "formula"),
    text: renderProfileSidecarDiscourseText(contentProfile, input.text),
  };
}

export function computeProfileSidecarStatus(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  existing: Map<number, Pass1ArtifactMeta>,
  contentProfile: ContentProfileDefinition = TECHNICAL_LEARNING_PROFILE,
): ProfileSidecarStatus {
  const done: number[] = [];
  const pending: number[] = [];
  for (const w of windows) {
    const expected = profileSidecarContentHash(w, buildProfileSidecarWindowInput(w, byLid, source, contentProfile));
    const got = existing.get(w.id);
    if (got && got.content_hash === expected) done.push(w.id);
    else pending.push(w.id);
  }
  return { done, pending };
}
