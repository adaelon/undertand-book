import {
  PAPER_PROFILE_ID,
  TECHNICAL_LEARNING_PROFILE_ID,
  type ContentProfileDefinition,
  type PaperProfileDefinition,
} from "./content-profile";
import type { LidNode } from "./generated/LidNode";
import { buildPass1Input, type Pass1Input } from "./pass1-input";
import type { Window } from "./window";

function renderPaperRules(profile: PaperProfileDefinition, baseText: string): string {
  const rules = profile.paper.effective_rules;
  return [
    "PAPER_PASS1_RULES",
    `content_profile: ${PAPER_PROFILE_ID}`,
    `paper_subtype: ${profile.paper.paper_subtype}`,
    "graph_shape: use only existing GraphNode types entity | concept | claim and local GraphEdge objects",
    "citation_anchor: LID only; never use PDF page, bbox, or source-map coordinates as evidence",
    `argument_slots: ${rules.argument_shape.slots.join(", ")}`,
    `focus_objects: research_question, hypothesis, method, claim, evidence, limitation, dataset, metric, baseline, result`,
    `paper_edge_rules: ${rules.graph_edge_rules.join(", ")}`,
    "output_policy: degrade paper objects into existing nodes/edges; do not emit metadata, lexicon, cross-paper relations, or paper_argument.json",
    "",
    "TEXT",
    baseText,
  ].join("\n");
}

export function buildProfiledPass1Input(
  window: Window,
  byLid: Map<string, LidNode>,
  source: string,
  contentProfile: ContentProfileDefinition,
): Pass1Input {
  const base = buildPass1Input(window, byLid, source);
  if (contentProfile.id === TECHNICAL_LEARNING_PROFILE_ID) return base;
  return {
    ...base,
    text: renderPaperRules(contentProfile, base.text),
  };
}

export function buildProfiledPass1Inputs(
  windows: Window[],
  nodes: LidNode[],
  source: string,
  contentProfile: ContentProfileDefinition,
): Pass1Input[] {
  const byLid = new Map(nodes.map((node) => [node.lid, node]));
  return windows.map((window) => buildProfiledPass1Input(window, byLid, source, contentProfile));
}
