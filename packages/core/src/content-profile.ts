export const TECHNICAL_LEARNING_PROFILE_ID = "technical_learning" as const;
export const TECHNICAL_LEARNING_PROFILE_VERSION = "technical_learning_v0";
export const PAPER_PROFILE_ID = "paper" as const;
export const PAPER_PROFILE_VERSION = "paper_v0";

export const SUPPORTED_CONTENT_PROFILE_IDS = [TECHNICAL_LEARNING_PROFILE_ID, PAPER_PROFILE_ID] as const;

export type ContentProfileId = (typeof SUPPORTED_CONTENT_PROFILE_IDS)[number];
export type PaperSubtype = "research_article" | "survey";
export type PaperClaimSource = "review_says" | "original_paper_verified";

interface BaseContentProfileDefinition {
  id: ContentProfileId;
  profile_version: string;
}

export interface TechnicalLearningProfileDefinition extends BaseContentProfileDefinition {
  id: typeof TECHNICAL_LEARNING_PROFILE_ID;
}

export interface PaperBaseInvariants {
  canonical_source: "cleaned_markdown";
  citation_anchor: "lid";
  optional_pdf_sidecar: true;
  metadata_sidecar: "paper_metadata.json";
  lexicon_sidecar: "paper_lexicon.json";
  argument_sidecar: false;
  single_paper_mcp_only: true;
}

export interface PaperArgumentShapeSpec {
  kind: PaperSubtype;
  slots: string[];
  default_claim_source?: PaperClaimSource;
}

export interface PaperEffectiveRules {
  detect_rules: string[];
  section_classification_rules: string[];
  metadata_extra_fields: string[];
  argument_shape: PaperArgumentShapeSpec;
  graph_edge_rules: string[];
  book_structure_rules: string[];
  reading_guide_rules: string[];
  validators: string[];
}

export interface PaperSubtypeOverlay {
  paper_subtype: PaperSubtype;
  patched_slots: Array<keyof PaperEffectiveRules>;
  metadata_extra_fields?: string[];
  argument_shape?: PaperArgumentShapeSpec;
  graph_edge_rules?: string[];
  book_structure_rules?: string[];
  reading_guide_rules?: string[];
  validators?: string[];
}

export interface PaperRulePack {
  profile_id: typeof PAPER_PROFILE_ID;
  profile_version: typeof PAPER_PROFILE_VERSION;
  paper_subtype: PaperSubtype;
  base_invariants: PaperBaseInvariants;
  overlay_order: string[];
  overlay: PaperSubtypeOverlay;
  effective_rules: PaperEffectiveRules;
}

export interface PaperProfileDefinition extends BaseContentProfileDefinition {
  id: typeof PAPER_PROFILE_ID;
  paper: PaperRulePack;
}

export type ContentProfileDefinition = TechnicalLearningProfileDefinition | PaperProfileDefinition;

export interface ResolveContentProfileOptions {
  paper_subtype?: string;
}

export const TECHNICAL_LEARNING_PROFILE: TechnicalLearningProfileDefinition = {
  id: TECHNICAL_LEARNING_PROFILE_ID,
  profile_version: TECHNICAL_LEARNING_PROFILE_VERSION,
};

export const PAPER_BASE_INVARIANTS: PaperBaseInvariants = {
  canonical_source: "cleaned_markdown",
  citation_anchor: "lid",
  optional_pdf_sidecar: true,
  metadata_sidecar: "paper_metadata.json",
  lexicon_sidecar: "paper_lexicon.json",
  argument_sidecar: false,
  single_paper_mcp_only: true,
};

const PAPER_BASE_RULES: PaperEffectiveRules = {
  detect_rules: ["paper.base.detect_english_academic_paper"],
  section_classification_rules: [
    "paper.base.section.abstract",
    "paper.base.section.introduction",
    "paper.base.section.method",
    "paper.base.section.results",
    "paper.base.section.discussion",
    "paper.base.section.references",
  ],
  metadata_extra_fields: [],
  argument_shape: {
    kind: "research_article",
    slots: ["problem", "research_question", "hypothesis", "method", "evidence", "claim", "limitation"],
  },
  graph_edge_rules: [
    "paper.base.claim_supported_by_evidence",
    "paper.base.method_supports_result",
    "paper.base.hypothesis_tested_by_experiment",
    "paper.base.related_work_contrasts",
    "paper.base.related_work_builds_on",
    "paper.base.limitation_motivates_future_work",
  ],
  book_structure_rules: [
    "paper.base.spine.abstract_to_conclusion",
    "paper.base.key_stops.contribution_method_result_limitation",
  ],
  reading_guide_rules: ["paper.base.ten_questions", "paper.base.codebook", "paper.base.abstract_reading_aid"],
  validators: [
    "paper.base.canonical_source_is_cleaned_markdown",
    "paper.base.citation_anchor_is_lid",
    "paper.base.metadata_sidecar_is_paper_metadata_json",
    "paper.base.lexicon_sidecar_is_paper_lexicon_json",
    "paper.base.no_paper_argument_sidecar",
    "paper.base.single_paper_mcp_has_no_corpus_graph",
  ],
};

const RESEARCH_ARTICLE_OVERLAY: PaperSubtypeOverlay = {
  paper_subtype: "research_article",
  patched_slots: [],
};

const SURVEY_OVERLAY: PaperSubtypeOverlay = {
  paper_subtype: "survey",
  patched_slots: ["metadata_extra_fields", "argument_shape", "graph_edge_rules", "book_structure_rules", "reading_guide_rules", "validators"],
  metadata_extra_fields: ["review_scope", "taxonomy_axes", "comparison_dimensions"],
  argument_shape: {
    kind: "survey",
    slots: [
      "field_scope",
      "taxonomy_axes",
      "literature_clusters",
      "comparison_dimensions",
      "synthesis_claims",
      "consensus_or_disagreement",
      "gaps_and_future_directions",
    ],
    default_claim_source: "review_says",
  },
  graph_edge_rules: [
    "paper.survey.groups_literature_by_taxonomy_axis",
    "paper.survey.compares_cluster_on_dimension",
    "paper.survey.synthesizes_claim_from_review",
    "paper.survey.identifies_gap",
  ],
  book_structure_rules: ["paper.survey.spine.field_scope_to_gaps"],
  reading_guide_rules: ["paper.survey.map_taxonomy", "paper.survey.compare_clusters", "paper.survey.inspect_gaps"],
  validators: ["paper.survey.review_claim_source_defaults_to_review_says"],
};

function resolvePaperSubtype(paperSubtype?: string): PaperSubtype {
  const subtype = paperSubtype?.trim() || "research_article";
  if (subtype === "research_article" || subtype === "survey") return subtype;
  throw new Error(`Unsupported paper_subtype "${subtype}". Supported paper_subtype values: research_article, survey`);
}

function mergePaperOverlay(base: PaperEffectiveRules, overlay: PaperSubtypeOverlay): PaperEffectiveRules {
  return {
    detect_rules: base.detect_rules,
    section_classification_rules: base.section_classification_rules,
    metadata_extra_fields: [...base.metadata_extra_fields, ...(overlay.metadata_extra_fields ?? [])],
    argument_shape: overlay.argument_shape ?? base.argument_shape,
    graph_edge_rules: [...base.graph_edge_rules, ...(overlay.graph_edge_rules ?? [])],
    book_structure_rules: [...base.book_structure_rules, ...(overlay.book_structure_rules ?? [])],
    reading_guide_rules: [...base.reading_guide_rules, ...(overlay.reading_guide_rules ?? [])],
    validators: [...base.validators, ...(overlay.validators ?? [])],
  };
}

export function resolvePaperRulePack(paperSubtype?: string): PaperRulePack {
  const subtype = resolvePaperSubtype(paperSubtype);
  const overlay = subtype === "survey" ? SURVEY_OVERLAY : RESEARCH_ARTICLE_OVERLAY;
  return {
    profile_id: PAPER_PROFILE_ID,
    profile_version: PAPER_PROFILE_VERSION,
    paper_subtype: subtype,
    base_invariants: PAPER_BASE_INVARIANTS,
    overlay_order: ["paper.base", `paper.subtype.${subtype}`],
    overlay,
    effective_rules: mergePaperOverlay(PAPER_BASE_RULES, overlay),
  };
}

export function resolveContentProfile(contentProfile?: string, options: ResolveContentProfileOptions = {}): ContentProfileDefinition {
  const profile = contentProfile?.trim() || TECHNICAL_LEARNING_PROFILE_ID;
  if (profile === TECHNICAL_LEARNING_PROFILE_ID) {
    if (options.paper_subtype?.trim()) {
      throw new Error("paper_subtype can only be used with content_profile paper");
    }
    return TECHNICAL_LEARNING_PROFILE;
  }
  if (profile === PAPER_PROFILE_ID) {
    return {
      id: PAPER_PROFILE_ID,
      profile_version: PAPER_PROFILE_VERSION,
      paper: resolvePaperRulePack(options.paper_subtype),
    };
  }
  throw new Error(
    `Unsupported content_profile "${profile}". Supported content_profile values: ${SUPPORTED_CONTENT_PROFILE_IDS.join(", ")}`,
  );
}
