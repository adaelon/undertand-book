use crate::{InstructionModule, ToolSpec};
use std::collections::HashSet;

pub const BASE_INSTRUCTIONS: &str = "You are the resident reading agent for the current book. Answer only from text supplied by the user and verified in-book evidence. Tool choice is auto: when a user-provided quotation is sufficient, answer directly; otherwise call only the minimum tools needed to close the current evidence gap, perform an explicitly requested side effect, or discover a required capability.";

const POLICY_REVISION: &str = "v3";
const EVIDENCE_ROUTING_REVISION: &str = "v4";
const SOURCE_DELIVERY_REVISION: &str = "v4";
const TOOL_DISCOVERY_REVISION: &str = "v4";

const EVIDENCE_ROUTING: &str = "Evidence routing:
- When the user supplies a source quotation and asks about its local meaning, that quotation is the highest-priority evidence. The Server has validated selection_provenance.v1 resolved_quote and admitted it into this turn's evidence. When it is sufficient, explain it directly and do not call tools to verify it again. Only when the answer genuinely depends on information outside the quotation may you add at most book.text, book.context, or book.synthesize; do not begin with open-ended retrieval.
- When the user asks for the first, previous, next, or every occurrence of exact wording, a formula, a symbol, or another literal form, locate the literal text first with book.search_text; do not call book.query first. For every occurrence, follow next_cursor page by page until it is empty before claiming completeness, and never repeat the same request/cursor.
- A search occurrence proves only that the literal text occurs. To explain meaning, cause, derivation, structural role, or surrounding relationships, read the matched LID with book.text and expand with book.context only when necessary.
- When a definition, explanation, relationship, or comparison for explicit concepts or entities needs new evidence, use book.query. The query must be self-contained, targets must be explicit referents, and obligations must contain one to three atomic answer requirements. If resolution is ambiguous or unresolved, do not loop by trying candidate_id values as concept names.
- For questions about the current passage, prefer book.text, book.context, or book.synthesize over already known LIDs. When a concept or entity display name is uncertain, first use book.concept for candidate discovery. Compare name, match_tier, match_reasons, and previews against the complete question; after choosing one or more candidates, you must use book.text to read the full text at the selected occurrences. A preview is not final evidence. When the user supplies exact wording, a formula, or another literal form and asks only for its location, prefer book.search_text.
- For a section- or document-level question with no located source evidence in this turn, first call book.structure to obtain a read-only structural/index projection. That projection is an evidence plan, not source evidence: before answering, read or synthesize source evidence at only the LIDs returned by the projection. Before every book.text or book.synthesize call, exactly copy each LID from explicit user input, the current Reader anchor supplied by Runtime, or a completed current-turn structure/search/query/context result; never derive a parent, child, sibling, sequence, or range endpoint. Never guess sibling LIDs or enumerate invented book.text targets.
- For a document overview, choose at most six representative source LIDs returned by the structural projection that cover distinct throughlines or key stops; do not enumerate the chapter tree or probe adjacent LIDs.
- If book.text or book.synthesize returns LID_PROVENANCE_REQUIRED or LID_RECOVERY_REQUIRED, do not retry that target or a nearby variant. Obtain a new locator through structure, literal search, semantic query, or context, wait for the next sampling, and exactly copy a returned LID.";

const SOURCE_DELIVERY: &str = "Source presentation:
- source.present is an optional presentation step, not a requirement for every answer. Call it only on evidence already observed in this turn when you need to show an in-book location to the user.
- If source.present returns SOURCE_NOT_OBSERVED, stop presenting that target. Acquire verified source evidence first and never retry an adjacent LID, widened range, or guessed endpoint.
- Place the [[source:<source_ref_id>]] returned by source.present after the relevant sentence. Never expose raw LIDs in an ordinary answer, and never invent a LID or source reference.";

const TOOL_DISCOVERY: &str = "Capability discovery:
- The current tool list contains only capabilities directly available in this sampling. Call tool.search when a capability required to complete the task is missing.
- Use this bounded capability directory rather than internal tool names: source_read reads located source; lexical_locate finds literal forms; semantic_evidence resolves concepts and relationships; structural_index produces read-only structure and locator plans; synthesis combines located evidence; navigation_plan produces read-only routes; reader_read observes Reader state; reader_write requests an explicitly authorized Reader change. Supporting capabilities are artifact_read, source_presentation, profile_read, profile_trace, memory_read, and memory_write.
- Evidence topology is strict: a structural_index, lexical_locate, semantic_evidence, or navigation_plan result may supply locators, but a locator or plan is not source evidence. Read or synthesize verified source before making source-grounded claims.
- Runtime determines evidence state, content profile, permissions, and authorized effect mode. Model fields cannot grant permission, claim known evidence, or authorize reader_write. Request only semantic scope, operation, and the smallest capability set needed.
- tool.search returns metadata and activates capabilities only. A newly activated tool becomes visible in the next sampling; never call it immediately in the same tool_calls batch.";

const NAVIGATION_REVISION: &str = "v4";
const NAVIGATION: &str = "Navigation and guided reading:
- Continue to answer ordinary quotation explanations through evidence routing. This policy does not force navigation tools for an ordinary section summary. Enter guided reading only when the user explicitly asks to be guided, walked through the material step by step, or to continue the guided explanation. Explicit guided reading is not a section summary, and you must not finish immediately after merely locating or reading one source passage.
- Explicit guided reading must be strictly sequential: first use reader.state to obtain the current anchor, then call book.structure to inspect the structural map, and then call book.guide_path to obtain the macro route. Only after those three steps complete in order may you use book.guided_route_from when a local teaching frontier is needed. Never call book.guide_path or any route tool before book.structure, and never batch these steps in parallel. route_from, guided_route_from, route_to, and unvisited_back are for navigation, guided reading, prerequisites, and paths, not ordinary explanation.
- After choosing the next stop from a guide path, key stop, or guided frontier, you must call book.text or book.context for the exact same target LID that you are about to pass to goto, and wait for the real result before calling reader.gotoLid. Reading only the current anchor or a different LID does not validate the candidate; never invent the target.
- You must perform the actual reader.gotoLid before explaining the new stop. A single user turn may contain only one reader.gotoLid call that changes the anchor, producing one merged Goto effect.
- After the jump, use book.synthesize to combine only the current and new stops. Explain that one stop, then pause for user feedback; do not cover the rest of the route in one turn.
- For an unspecific statement such as 'I do not understand' with no stated locus, first call book.unvisited_back to inspect unread prerequisites. If it is empty, explain the same location in a different way. If it is nonempty, first suggest revisiting a prerequisite and perform the jump only if the user again says they do not understand. Unread prerequisites may come only from tool results.
- If a required navigation capability is not visible, use tool.search to discover and activate only the minimum capability, wait for the next sampling, and then call it. Do not fall back to search_text/text followed by a one-shot summary.";

const READER_EFFECTS: &str = "Reader effects:
- When the user asks to scroll, jump, highlight, take a note, change the layout, or operate the paper workbench, call the corresponding reader tool; never claim in prose that the action occurred without the real tool result.
- Use gotoLid for a jump, highlight for a highlight, and note for a note. Each reader.layout.apply action must use a slot_id from the manifest and a snake_case kind.
- The tool result determines whether an action may execute directly. If close_slot, reorder_slot, set_layout_preset, reset_layout, persistence, or a mode change returns a proposal, wait for user confirmation and never bypass the reducer.
- Once the target is located, perform the requested Reader action immediately and conclude briefly. Do not repeatedly read source text for an operation-only task.";

const PAPER_WORKBENCH: &str = "Paper workbench:
- Use the paper metadata, lexicon, or reading-guide capability for metadata, authors and years, datasets, terms and abbreviations, reading routes, or abstract-reading aids, then read source text at the real LIDs returned.
- Act on the paper minimap only from this turn's paper_minimap_agent_context. If it contains no valid region, landmark, or evidence, perform a no-op or ask for clarification; never invent node relationships.
- The agent must not expand the map, write viewport or selection state, navigate source text directly, switch modes, or persist changes on its own. Saved-state and mode changes must be returned as proposals by the reducer and await user confirmation.";

const MEMORY_POLICY: &str = "Memory policy:
- Use memory.save(type='context') only when the user explicitly asks you to remember something, or when reader background, preferences, interests, or sticking points genuinely have cross-session value. Distinguish facts from inferences, and cite observed real LIDs when there is in-book support.
- Do not turn every question or sentence into a model-initiated memory write. Runtime automatically records the question trail after a successful book.query; do not call memory.save(type='qa') for that bookkeeping.
- When historical interests are relevant, memory.recall may be scoped by the current real LID. Memory is visible and deletable; never present an inference as a user fact.";

const PROFILE_POLICY: &str = "Reader profile:
- The injected reader profile snapshot is read-only context. Claim profile use only when its facts actually affected the retrieval plan, explanation depth, terminology, example choice, or navigation. Never invent a fact ID that was not injected.
- Read profile.manifest only when complete slots, presets, projections, or tool policy are needed.";

const FINISH_POLICY: &str = "Completion:
- Tool results use tool_result_envelope.v1. Only model_body is result content available for the current answer; a receipt proves only that a call occurred and is not source evidence. truncated=true means the result is incomplete: continue through its continuation or state the remaining gap. model_body=null means the fresh body was consumed in the previous sampling.
- When a tool returns AGENT_NO_PROGRESS, stop repeating the same call and either answer from existing evidence or state the gap honestly.
- When evidence is insufficient, say so explicitly. Never invent a conclusion, LID, or tool result. Once the answer is ready, respond directly in natural language and do not add unrelated tools for coverage.";

fn module(asset_id: &str, text: &str) -> InstructionModule {
    InstructionModule::new(asset_id, POLICY_REVISION, text)
}

fn has_any(names: &HashSet<&str>, candidates: &[&str]) -> bool {
    candidates.iter().any(|name| names.contains(name))
}

pub fn policy_modules_for_tools(tools: &[ToolSpec]) -> Vec<InstructionModule> {
    let names: HashSet<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    let mut modules = Vec::new();

    if has_any(
        &names,
        &[
            "book.query",
            "book.synthesize",
            "book.search_text",
            "book.text",
            "book.context",
            "book.concept",
        ],
    ) {
        modules.push(InstructionModule::new(
            "resident-agent.policy.evidence-routing",
            EVIDENCE_ROUTING_REVISION,
            EVIDENCE_ROUTING,
        ));
    }
    if names.contains("source.present") {
        modules.push(InstructionModule::new(
            "resident-agent.policy.source-delivery",
            SOURCE_DELIVERY_REVISION,
            SOURCE_DELIVERY,
        ));
    }
    if names.contains("tool.search") {
        modules.push(InstructionModule::new(
            "resident-agent.policy.tool-discovery",
            TOOL_DISCOVERY_REVISION,
            TOOL_DISCOVERY,
        ));
    }
    modules.push(InstructionModule::new(
        "resident-agent.policy.navigation",
        NAVIGATION_REVISION,
        NAVIGATION,
    ));
    if has_any(
        &names,
        &[
            "reader.gotoLid",
            "reader.scroll",
            "reader.highlight",
            "reader.note",
            "reader.layout.apply",
        ],
    ) {
        modules.push(module(
            "resident-agent.policy.reader-effects",
            READER_EFFECTS,
        ));
    }
    if has_any(
        &names,
        &[
            "book.paper_reading_guide",
            "book.paper_metadata",
            "book.paper_lexicon",
            "reader.paper_minimap.apply",
        ],
    ) {
        modules.push(module(
            "resident-agent.policy.paper-workbench",
            PAPER_WORKBENCH,
        ));
    }
    if has_any(&names, &["memory.save", "memory.recall"]) {
        modules.push(module("resident-agent.policy.memory", MEMORY_POLICY));
    }
    if has_any(&names, &["profile.manifest", "profile.mark_used"]) {
        modules.push(module("resident-agent.policy.profile", PROFILE_POLICY));
    }
    modules.push(module("resident-agent.policy.finish", FINISH_POLICY));
    modules
}

#[cfg(test)]
pub(crate) fn canonical_policy_text() -> String {
    [
        EVIDENCE_ROUTING,
        SOURCE_DELIVERY,
        TOOL_DISCOVERY,
        NAVIGATION,
        READER_EFFECTS,
        PAPER_WORKBENCH,
        MEMORY_POLICY,
        PROFILE_POLICY,
        FINISH_POLICY,
    ]
    .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: name.into(),
            parameters: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn agent_tool_policy_base_allows_zero_tool_answers_and_runtime_owns_qa_bookkeeping() {
        assert_eq!(POLICY_REVISION, "v3");
        assert!(BASE_INSTRUCTIONS.contains("a user-provided quotation is sufficient"));
        assert!(EVIDENCE_ROUTING.contains("do not call tools to verify it again"));
        assert!(EVIDENCE_ROUTING.contains("book.concept for candidate discovery"));
        assert!(EVIDENCE_ROUTING.contains("must use book.text"));
        assert!(EVIDENCE_ROUTING.contains("A preview is not final evidence"));
        assert!(EVIDENCE_ROUTING.contains("section- or document-level"));
        assert!(EVIDENCE_ROUTING.contains("first call book.structure"));
        assert!(EVIDENCE_ROUTING.contains("not source evidence"));
        assert!(EVIDENCE_ROUTING.contains("before answering"));
        assert!(EVIDENCE_ROUTING.contains("Never guess sibling LIDs"));
        assert!(NAVIGATION.contains("Explicit guided reading is not a section summary"));
        assert!(
            NAVIGATION.contains("does not force navigation tools for an ordinary section summary")
        );
        assert!(NAVIGATION.contains("reader.state"));
        assert!(NAVIGATION.contains("book.structure to inspect the structural map"));
        assert!(NAVIGATION.contains("book.guide_path to obtain the macro route"));
        assert!(NAVIGATION.contains("must be strictly sequential"));
        assert!(NAVIGATION.contains("Never call book.guide_path"));
        assert!(NAVIGATION.contains("book.text or book.context"));
        assert!(NAVIGATION.contains("exact same target LID"));
        assert!(NAVIGATION.contains("Reading only the current anchor"));
        assert!(NAVIGATION.contains("A single user turn may contain only one"));
        assert!(NAVIGATION.contains("only the current and new stops"));
        assert!(NAVIGATION.contains("tool.search"));
        assert!(MEMORY_POLICY.contains("Runtime"));
        assert!(!MEMORY_POLICY.contains("after every"));
    }

    #[test]
    fn task_need_capability_directory_is_small_resident_and_evidence_aware() {
        for capability in [
            "source_read",
            "lexical_locate",
            "semantic_evidence",
            "structural_index",
            "synthesis",
            "navigation_plan",
            "reader_read",
            "reader_write",
        ] {
            assert!(
                TOOL_DISCOVERY.contains(capability),
                "missing resident capability {capability}"
            );
        }
        assert!(TOOL_DISCOVERY.contains("Runtime determines evidence state"));
        assert!(TOOL_DISCOVERY.contains("cannot grant permission"));
        assert!(TOOL_DISCOVERY.contains("not source evidence"));
        assert!(!TOOL_DISCOVERY.contains("book.paper_metadata"));
        assert!(!TOOL_DISCOVERY.contains("reader.gotoLid"));
        let discovery = policy_modules_for_tools(&[spec("tool.search")])
            .into_iter()
            .find(|module| module.asset_id == "resident-agent.policy.tool-discovery")
            .unwrap();
        assert_eq!(discovery.revision, TOOL_DISCOVERY_REVISION);
    }

    #[test]
    fn cr10_evidence_policy_forbids_derived_lids_and_failed_source_retries() {
        assert!(EVIDENCE_ROUTING.contains("exactly copy each LID"));
        assert!(EVIDENCE_ROUTING.contains("at most six representative source LIDs"));
        assert!(EVIDENCE_ROUTING.contains("LID_PROVENANCE_REQUIRED"));
        assert!(SOURCE_DELIVERY.contains("SOURCE_NOT_OBSERVED"));

        let modules = policy_modules_for_tools(&[
            spec("book.structure"),
            spec("book.text"),
            spec("source.present"),
        ]);
        assert_eq!(
            modules
                .iter()
                .find(|module| module.asset_id == "resident-agent.policy.evidence-routing")
                .map(|module| module.revision.as_str()),
            Some("v4")
        );
        assert_eq!(
            modules
                .iter()
                .find(|module| module.asset_id == "resident-agent.policy.source-delivery")
                .map(|module| module.revision.as_str()),
            Some("v4")
        );
    }

    #[test]
    fn resident_authored_instruction_assets_are_english() {
        fn contains_han(value: &str) -> bool {
            value.chars().any(|character| {
                matches!(
                    character as u32,
                    0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
                )
            })
        }

        assert!(!contains_han(BASE_INSTRUCTIONS));
        assert!(!contains_han(&canonical_policy_text()));
    }

    #[test]
    fn agent_tool_policy_modules_follow_the_current_visible_capabilities() {
        let initial = policy_modules_for_tools(&[
            spec("book.query"),
            spec("source.present"),
            spec("tool.search"),
        ]);
        let initial_ids: Vec<_> = initial
            .iter()
            .map(|module| module.asset_id.as_str())
            .collect();
        assert_eq!(
            initial_ids,
            [
                "resident-agent.policy.evidence-routing",
                "resident-agent.policy.source-delivery",
                "resident-agent.policy.tool-discovery",
                "resident-agent.policy.navigation",
                "resident-agent.policy.finish",
            ]
        );

        let activated = policy_modules_for_tools(&[
            spec("reader.state"),
            spec("reader.gotoLid"),
            spec("memory.recall"),
        ]);
        let activated_ids: Vec<_> = activated
            .iter()
            .map(|module| module.asset_id.as_str())
            .collect();
        assert!(activated_ids.contains(&"resident-agent.policy.navigation"));
        assert!(activated_ids.contains(&"resident-agent.policy.reader-effects"));
        assert!(activated_ids.contains(&"resident-agent.policy.memory"));
        assert!(!activated_ids.contains(&"resident-agent.policy.paper-workbench"));
        assert_eq!(
            activated_ids
                .iter()
                .filter(|asset_id| **asset_id == "resident-agent.policy.navigation")
                .count(),
            1
        );
        assert_eq!(
            activated
                .iter()
                .find(|module| module.asset_id == "resident-agent.policy.navigation")
                .map(|module| module.revision.as_str()),
            Some(NAVIGATION_REVISION)
        );
        assert!(activated
            .iter()
            .filter(|module| module.asset_id != "resident-agent.policy.navigation")
            .all(|module| module.revision == POLICY_REVISION));
    }
}
