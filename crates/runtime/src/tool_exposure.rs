use crate::tool_registry::{ToolCapability, ToolHandlerId, ToolRegistry};
use crate::{ModelRuntimeProfile, ToolSpec};
use artifact_tools::ArtifactToolId;
use book_tool_contracts::BookToolId;
use read_tools::ContentProfileId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

pub const TOOL_EXPOSURE_PLAN_VERSION: &str = "tool_exposure_plan.v1";
pub const TOOL_SEARCH_RESULT_VERSION: &str = "tool_search_result.v1";
pub const TURN_INTENT_CLASSIFIER_VERSION: &str = "turn_intent_classifier.v1";
pub const DEFAULT_DIRECT_TOOL_LIMIT: usize = 8;
pub const MAX_DISCOVERY_ACTIVATIONS: usize = 6;

const EXPLICIT_GUIDED_READ_PHRASES_V1: [&str; 8] = [
    "带我读",
    "带着我读",
    "陪我读",
    "一步步讲",
    "接着带我读",
    "接着讲这一节",
    "guide me through",
    "walk me through",
];

const EXPLICIT_GUIDED_READ_NEGATIONS_V1: [&str; 22] = [
    "不要带我读",
    "不用带我读",
    "别带我读",
    "不要带着我读",
    "不用带着我读",
    "别带着我读",
    "不要陪我读",
    "不用陪我读",
    "别陪我读",
    "不要一步步讲",
    "不用一步步讲",
    "别一步步讲",
    "不要接着带我读",
    "不用接着带我读",
    "别接着带我读",
    "不要接着讲这一节",
    "不用接着讲这一节",
    "别接着讲这一节",
    "don't guide me through",
    "do not guide me through",
    "don't walk me through",
    "do not walk me through",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TurnIntentHint {
    ExplicitGuidedRead,
}

pub fn classify_turn_intent(question: &str) -> BTreeSet<TurnIntentHint> {
    let normalized = question.trim().to_lowercase();
    if normalized.is_empty()
        || EXPLICIT_GUIDED_READ_NEGATIONS_V1
            .iter()
            .any(|phrase| normalized.contains(phrase))
    {
        return BTreeSet::new();
    }

    EXPLICIT_GUIDED_READ_PHRASES_V1
        .iter()
        .any(|phrase| normalized.contains(phrase))
        .then_some(TurnIntentHint::ExplicitGuidedRead)
        .into_iter()
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolPermissions {
    pub allow_source_presentation: bool,
    pub allow_profile_read: bool,
    pub allow_memory_read: bool,
    pub allow_memory_write: bool,
    pub allow_reader_read: bool,
    pub allow_reader_write: bool,
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self {
            allow_source_presentation: true,
            allow_profile_read: true,
            allow_memory_read: true,
            allow_memory_write: true,
            allow_reader_read: true,
            allow_reader_write: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExposureContext {
    pub content_profile: ContentProfileId,
    pub permissions: ToolPermissions,
    pub has_turn_evidence: bool,
    pub artifact: ArtifactExposureContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactExposurePhase {
    NoOverlay,
    Routable,
    SearchHit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactExposureContext {
    pub phase: ArtifactExposurePhase,
    pub initial_search_available: bool,
}

impl ArtifactExposureContext {
    pub const fn no_overlay() -> Self {
        Self {
            phase: ArtifactExposurePhase::NoOverlay,
            initial_search_available: false,
        }
    }

    pub const fn routable() -> Self {
        Self {
            phase: ArtifactExposurePhase::Routable,
            initial_search_available: true,
        }
    }

    pub const fn search_hit() -> Self {
        Self {
            phase: ArtifactExposurePhase::SearchHit,
            initial_search_available: false,
        }
    }

    pub const fn search_exhausted() -> Self {
        Self {
            phase: ArtifactExposurePhase::Routable,
            initial_search_available: false,
        }
    }

    fn has_overlay(self) -> bool {
        self.phase != ArtifactExposurePhase::NoOverlay
    }

    fn replaces_book_synthesize(self) -> bool {
        self.initial_search_available || self.phase == ArtifactExposurePhase::SearchHit
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExposureDisposition {
    Direct,
    Deferred,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExposureReason {
    CoreRead,
    Discovery,
    EvidenceAvailable,
    EvidenceRequired,
    CapabilityDeferred,
    ContentProfile,
    ProfileMismatch,
    PermissionDenied,
    RuntimeOwned,
    AwaitingDiscovery,
    Activated,
    DirectLimit,
    SchemaBudget,
    ArtifactOverlayUnavailable,
    ArtifactRoutable,
    ArtifactSearchHit,
    ArtifactCallBudget,
    ArtifactReplaced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolExposureEntry {
    pub name: String,
    pub disposition: ToolExposureDisposition,
    pub exposed: bool,
    pub reason: ToolExposureReason,
    pub schema_bytes: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolExposureState {
    activated: BTreeSet<String>,
}

impl ToolExposureState {
    pub fn is_activated(&self, name: &str) -> bool {
        self.activated.contains(name)
    }

    pub fn activated_names(&self) -> impl Iterator<Item = &str> {
        self.activated.iter().map(String::as_str)
    }

    fn activate(&mut self, name: &str) {
        self.activated.insert(name.to_string());
    }
}

pub fn seed_turn_tool_activations(
    hints: &BTreeSet<TurnIntentHint>,
    registry: &ToolRegistry,
    context: &ToolExposureContext,
    state: &mut ToolExposureState,
) {
    if !hints.contains(&TurnIntentHint::ExplicitGuidedRead) {
        return;
    }

    for registration in registry.registrations() {
        let is_guided_navigation = registration
            .capabilities
            .contains(&ToolCapability::Navigation)
            || matches!(
                registration.handler,
                ToolHandlerId::ReaderState | ToolHandlerId::ReaderGotoLid
            );
        if !is_guided_navigation {
            continue;
        }
        if classify(registration.handler, context).0 == ToolExposureDisposition::Deferred {
            state.activate(&registration.spec.name);
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolExposurePlan {
    pub version: &'static str,
    pub entries: Vec<ToolExposureEntry>,
    pub visible_tools: Vec<ToolSpec>,
    pub schema_bytes: usize,
    pub schema_budget_bytes: usize,
    pub direct_limit: usize,
}

impl ToolExposurePlan {
    pub fn build(
        registry: &ToolRegistry,
        model: &ModelRuntimeProfile,
        context: &ToolExposureContext,
        state: &ToolExposureState,
    ) -> Self {
        let mut entries: Vec<_> = registry
            .registrations()
            .iter()
            .map(|registration| {
                let (disposition, reason) = classify(registration.handler, context);
                ToolExposureEntry {
                    name: registration.spec.name.clone(),
                    disposition,
                    exposed: false,
                    reason,
                    schema_bytes: tool_schema_bytes(&registration.spec),
                }
            })
            .collect();

        let mut selected = HashSet::new();
        let mut schema_bytes = 0_usize;
        let mut direct: Vec<_> = registry
            .registrations()
            .iter()
            .enumerate()
            .filter_map(|(index, registration)| {
                (entries[index].disposition == ToolExposureDisposition::Direct)
                    .then_some((direct_priority(registration.handler), index))
            })
            .collect();
        direct.sort_by_key(|(priority, index)| (*priority, *index));

        for (ordinal, (_, index)) in direct.into_iter().enumerate() {
            if ordinal >= DEFAULT_DIRECT_TOOL_LIMIT {
                entries[index].reason = ToolExposureReason::DirectLimit;
                continue;
            }
            let bytes = entries[index].schema_bytes;
            let projected_bytes = projected_schema_bytes(schema_bytes, selected.len(), bytes);
            if projected_bytes > model.tool_schema_budget_bytes {
                entries[index].reason = ToolExposureReason::SchemaBudget;
                continue;
            }
            entries[index].exposed = true;
            schema_bytes = projected_bytes;
            selected.insert(index);
        }

        for (index, registration) in registry.registrations().iter().enumerate() {
            if entries[index].disposition != ToolExposureDisposition::Deferred
                || !state.is_activated(&registration.spec.name)
            {
                if entries[index].disposition == ToolExposureDisposition::Deferred {
                    entries[index].reason = ToolExposureReason::AwaitingDiscovery;
                }
                continue;
            }
            let bytes = entries[index].schema_bytes;
            let projected_bytes = projected_schema_bytes(schema_bytes, selected.len(), bytes);
            if projected_bytes > model.tool_schema_budget_bytes {
                entries[index].reason = ToolExposureReason::SchemaBudget;
                continue;
            }
            entries[index].exposed = true;
            entries[index].reason = ToolExposureReason::Activated;
            schema_bytes = projected_bytes;
            selected.insert(index);
        }

        let visible_tools = registry
            .registrations()
            .iter()
            .enumerate()
            .filter(|(index, _)| selected.contains(index))
            .map(|(_, registration)| registration.spec.clone())
            .collect();

        Self {
            version: TOOL_EXPOSURE_PLAN_VERSION,
            entries,
            visible_tools,
            schema_bytes,
            schema_budget_bytes: model.tool_schema_budget_bytes,
            direct_limit: DEFAULT_DIRECT_TOOL_LIMIT,
        }
    }

    pub fn is_visible(&self, name: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.name == name && entry.exposed)
    }

    pub fn entry(&self, name: &str) -> Option<&ToolExposureEntry> {
        self.entries.iter().find(|entry| entry.name == name)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolSearchRequest {
    query: String,
    #[serde(default = "default_search_limit")]
    max_results: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchHit {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchOutcome {
    pub version: &'static str,
    pub query: String,
    pub activated: Vec<ToolSearchHit>,
    pub deferred_remaining: usize,
    pub visible_from: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchError {
    pub error_code: &'static str,
    pub category: &'static str,
    pub message: String,
}

pub fn search_and_activate(
    arguments: &str,
    sampled_plan: &ToolExposurePlan,
    registry: &ToolRegistry,
    state: &mut ToolExposureState,
) -> Result<ToolSearchOutcome, ToolSearchError> {
    let request: ToolSearchRequest =
        serde_json::from_str(arguments).map_err(|error| ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!("tool.search arguments are invalid: {error}"),
        })?;
    let query = request.query.trim();
    if query.is_empty() {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: "tool.search query must not be empty".into(),
        });
    }
    if !(1..=MAX_DISCOVERY_ACTIVATIONS).contains(&request.max_results) {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!(
                "tool.search max_results must be between 1 and {MAX_DISCOVERY_ACTIVATIONS}"
            ),
        });
    }

    let mut matches: Vec<(u32, usize)> = registry
        .registrations()
        .iter()
        .enumerate()
        .filter(|(_, registration)| !state.is_activated(&registration.spec.name))
        .filter(|(_, registration)| {
            sampled_plan
                .entry(&registration.spec.name)
                .is_some_and(|entry| entry.disposition == ToolExposureDisposition::Deferred)
        })
        .filter_map(|(index, registration)| {
            search_score(
                query,
                &registration.spec.name,
                &registration.spec.description,
                &registration.capabilities,
            )
            .map(|score| (score, index))
        })
        .collect();
    matches.sort_by(|(left_score, left_index), (right_score, right_index)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_index.cmp(right_index))
    });
    matches.truncate(request.max_results.min(MAX_DISCOVERY_ACTIVATIONS));

    let mut activated = Vec::with_capacity(matches.len());
    for (_, index) in matches {
        let registration = &registry.registrations()[index];
        state.activate(&registration.spec.name);
        activated.push(ToolSearchHit {
            name: registration.spec.name.clone(),
            description: registration.spec.description.clone(),
            capabilities: registration
                .capabilities
                .iter()
                .map(|capability| capability.as_str().to_string())
                .collect(),
        });
    }

    let deferred_remaining = registry
        .registrations()
        .iter()
        .filter(|registration| !state.is_activated(&registration.spec.name))
        .filter(|registration| {
            sampled_plan
                .entry(&registration.spec.name)
                .is_some_and(|entry| entry.disposition == ToolExposureDisposition::Deferred)
        })
        .count();
    Ok(ToolSearchOutcome {
        version: TOOL_SEARCH_RESULT_VERSION,
        query: query.to_string(),
        activated,
        deferred_remaining,
        visible_from: "next_sampling",
    })
}

fn default_search_limit() -> usize {
    MAX_DISCOVERY_ACTIVATIONS
}

fn classify(
    handler: ToolHandlerId,
    context: &ToolExposureContext,
) -> (ToolExposureDisposition, ToolExposureReason) {
    use ToolExposureDisposition as Disposition;
    use ToolExposureReason as Reason;
    use ToolHandlerId as Handler;

    match handler {
        Handler::ToolSearch => (Disposition::Direct, Reason::Discovery),
        Handler::Artifact(_) if !context.artifact.has_overlay() => {
            (Disposition::Hidden, Reason::ArtifactOverlayUnavailable)
        }
        Handler::Artifact(ArtifactToolId::List) => {
            (Disposition::Deferred, Reason::ArtifactRoutable)
        }
        Handler::Artifact(ArtifactToolId::Search) if context.artifact.initial_search_available => {
            (Disposition::Direct, Reason::ArtifactRoutable)
        }
        Handler::Artifact(ArtifactToolId::Search) => {
            (Disposition::Hidden, Reason::ArtifactCallBudget)
        }
        Handler::Artifact(ArtifactToolId::Read)
            if context.artifact.phase == ArtifactExposurePhase::SearchHit =>
        {
            (Disposition::Direct, Reason::ArtifactSearchHit)
        }
        Handler::Artifact(ArtifactToolId::Read) => (Disposition::Hidden, Reason::ArtifactRoutable),
        Handler::Book(BookToolId::Synthesize) if context.artifact.replaces_book_synthesize() => {
            (Disposition::Deferred, Reason::ArtifactReplaced)
        }
        Handler::Book(
            BookToolId::Query
            | BookToolId::Synthesize
            | BookToolId::SearchText
            | BookToolId::Text
            | BookToolId::Context
            | BookToolId::Concept,
        ) => (Disposition::Direct, Reason::CoreRead),
        Handler::SourcePresent if !context.permissions.allow_source_presentation => {
            (Disposition::Hidden, Reason::PermissionDenied)
        }
        Handler::SourcePresent if context.has_turn_evidence => {
            (Disposition::Direct, Reason::EvidenceAvailable)
        }
        Handler::SourcePresent => (Disposition::Direct, Reason::EvidenceRequired),
        Handler::Book(
            BookToolId::PaperMetadata | BookToolId::PaperLexicon | BookToolId::PaperReadingGuide,
        ) if context.content_profile == ContentProfileId::Paper => {
            (Disposition::Deferred, Reason::ContentProfile)
        }
        Handler::Book(
            BookToolId::PaperMetadata | BookToolId::PaperLexicon | BookToolId::PaperReadingGuide,
        ) => (Disposition::Hidden, Reason::ProfileMismatch),
        Handler::Book(BookToolId::Structure | BookToolId::GuidePath)
        | Handler::BookRouteFrom
        | Handler::BookGuidedRouteFrom
        | Handler::BookUnvisitedBack
        | Handler::BookRouteTo => (Disposition::Deferred, Reason::CapabilityDeferred),
        Handler::ProfileManifest if context.permissions.allow_profile_read => {
            (Disposition::Deferred, Reason::CapabilityDeferred)
        }
        Handler::ProfileManifest => (Disposition::Hidden, Reason::PermissionDenied),
        Handler::ProfileMarkUsed => (Disposition::Deferred, Reason::RuntimeOwned),
        Handler::MemoryRecall if context.permissions.allow_memory_read => {
            (Disposition::Deferred, Reason::CapabilityDeferred)
        }
        Handler::MemorySave if context.permissions.allow_memory_write => {
            (Disposition::Deferred, Reason::CapabilityDeferred)
        }
        Handler::MemoryRecall | Handler::MemorySave => {
            (Disposition::Hidden, Reason::PermissionDenied)
        }
        Handler::ReaderState if context.permissions.allow_reader_read => {
            (Disposition::Deferred, Reason::CapabilityDeferred)
        }
        Handler::ReaderGotoLid
        | Handler::ReaderScroll
        | Handler::ReaderHighlight
        | Handler::ReaderNote
        | Handler::ReaderLayoutApply
        | Handler::ReaderPaperMinimapApply
            if context.permissions.allow_reader_write =>
        {
            (Disposition::Deferred, Reason::CapabilityDeferred)
        }
        Handler::ReaderState
        | Handler::ReaderGotoLid
        | Handler::ReaderScroll
        | Handler::ReaderHighlight
        | Handler::ReaderNote
        | Handler::ReaderLayoutApply
        | Handler::ReaderPaperMinimapApply => (Disposition::Hidden, Reason::PermissionDenied),
        Handler::Book(_) => (Disposition::Hidden, Reason::ProfileMismatch),
    }
}

fn direct_priority(handler: ToolHandlerId) -> usize {
    match handler {
        ToolHandlerId::ToolSearch => 0,
        ToolHandlerId::Book(BookToolId::Text) => 1,
        ToolHandlerId::Book(BookToolId::Context) => 2,
        ToolHandlerId::Book(BookToolId::SearchText) => 3,
        ToolHandlerId::Book(BookToolId::Concept) => 4,
        ToolHandlerId::Book(BookToolId::Query) => 5,
        ToolHandlerId::Book(BookToolId::Synthesize) => 6,
        ToolHandlerId::Artifact(ArtifactToolId::Search | ArtifactToolId::Read) => 6,
        ToolHandlerId::SourcePresent => 7,
        _ => usize::MAX,
    }
}

pub fn tool_schema_bytes(spec: &ToolSpec) -> usize {
    serde_json::to_vec(&serde_json::json!({
        "name": spec.name,
        "description": spec.description,
        "parameters": spec.parameters,
    }))
    .map(|value| value.len())
    .unwrap_or(usize::MAX)
}

fn projected_schema_bytes(current: usize, selected_count: usize, next: usize) -> usize {
    if selected_count == 0 {
        next.saturating_add(2)
    } else {
        current.saturating_add(1).saturating_add(next)
    }
}

fn search_score(
    query: &str,
    name: &str,
    description: &str,
    capabilities: &[ToolCapability],
) -> Option<u32> {
    let query = query.to_lowercase();
    let name = name.to_lowercase();
    let description = description.to_lowercase();
    let capability_text = capabilities
        .iter()
        .map(|capability| capability.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let tokens: Vec<_> = query
        .split(|character: char| {
            !character.is_alphanumeric() && character != '.' && character != '_'
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }

    let mut score = 0_u32;
    if query == name {
        score += 1_000;
    } else if name.contains(&query) {
        score += 500;
    }
    for token in &tokens {
        if name.contains(token) {
            score += 80;
        }
        if capability_text.contains(token) {
            score += 50;
        }
        if description.contains(token) {
            score += 20;
        }
    }
    if score == 0
        && tokens
            .iter()
            .any(|token| matches!(*token, "tool" | "tools"))
    {
        score = 1;
    }
    (score > 0).then_some(score)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::resident_tool_registry;
    use crate::{ModelRuntimeCatalog, ProviderToolProtocol};

    fn model() -> ModelRuntimeProfile {
        ModelRuntimeProfile::fallback("test-model", ProviderToolProtocol::Native)
    }

    fn context(content_profile: ContentProfileId) -> ToolExposureContext {
        ToolExposureContext {
            content_profile,
            permissions: ToolPermissions::default(),
            has_turn_evidence: false,
            artifact: ArtifactExposureContext::no_overlay(),
        }
    }

    fn visible_names(plan: &ToolExposurePlan) -> Vec<&str> {
        plan.visible_tools
            .iter()
            .map(|spec| spec.name.as_str())
            .collect()
    }

    #[test]
    fn turn_intent_v1_classifies_only_the_frozen_guided_read_phrases() {
        assert_eq!(TURN_INTENT_CLASSIFIER_VERSION, "turn_intent_classifier.v1");
        for question in [
            "带我读 1.8.1",
            "请带着我读这一节",
            "陪我读第二章",
            "这部分请一步步讲",
            "接着带我读",
            "接着讲这一节",
            "  GUIDE ME THROUGH chapter 2  ",
            "Walk Me Through this proof",
        ] {
            assert_eq!(
                classify_turn_intent(question),
                BTreeSet::from([TurnIntentHint::ExplicitGuidedRead]),
                "question={question:?}"
            );
        }
    }

    #[test]
    fn turn_intent_v1_prioritizes_negation_and_rejects_summary_or_read_aloud() {
        for question in [
            "不要带我读",
            "不用带我读这一章",
            "别带我读，直接总结",
            "不要带着我读",
            "不用陪我读",
            "别一步步讲",
            "不要接着带我读",
            "不用接着讲这一节",
            "Don't guide me through this chapter",
            "Do not walk me through this proof",
            "总结本章",
            "本章讲了什么",
            "read this aloud",
            "解释 1.8.1",
            "",
            "   ",
        ] {
            assert!(
                classify_turn_intent(question).is_empty(),
                "question={question:?}"
            );
        }
    }

    #[test]
    fn turn_intent_seeded_exposure_is_complete_profile_gated_and_budgeted() {
        let registry = resident_tool_registry();
        let catalog = ModelRuntimeCatalog::default();
        let hints = classify_turn_intent("带我读 1.8.1");
        let core_navigation = [
            "book.structure",
            "book.guide_path",
            "book.route_from",
            "book.guided_route_from",
            "book.unvisited_back",
            "book.route_to",
            "reader.gotoLid",
            "reader.state",
        ];

        for protocol in [ProviderToolProtocol::Native, ProviderToolProtocol::ReAct] {
            for model_id in ["glm-5.1", "gpt-5", "unknown-model"] {
                let runtime_profile = catalog.resolve(model_id, protocol, None);
                for content_profile in
                    [ContentProfileId::TechnicalLearning, ContentProfileId::Paper]
                {
                    let is_paper = content_profile == ContentProfileId::Paper;
                    let exposure_context = context(content_profile.clone());
                    let mut state = ToolExposureState::default();
                    seed_turn_tool_activations(&hints, &registry, &exposure_context, &mut state);
                    let plan = ToolExposurePlan::build(
                        &registry,
                        &runtime_profile,
                        &exposure_context,
                        &state,
                    );

                    for name in core_navigation {
                        assert!(
                            plan.is_visible(name),
                            "profile={} protocol={protocol:?} content_profile={content_profile:?} missing={name}",
                            runtime_profile.profile_id
                        );
                    }
                    assert_eq!(plan.is_visible("book.paper_reading_guide"), is_paper);
                    assert!(plan.schema_bytes <= plan.schema_budget_bytes);
                    assert!(plan.entry("book_guide").is_none());
                    for excluded in [
                        "reader.scroll",
                        "reader.highlight",
                        "reader.note",
                        "reader.layout.apply",
                        "reader.paper_minimap.apply",
                        "memory.save",
                        "memory.recall",
                        "profile.manifest",
                    ] {
                        assert!(!state.is_activated(excluded), "unexpected seed={excluded}");
                    }
                }
            }
        }
    }

    #[test]
    fn turn_intent_seed_respects_reader_permissions_and_content_profile() {
        let registry = resident_tool_registry();
        let hints = classify_turn_intent("guide me through chapter 3");
        let mut denied = context(ContentProfileId::TechnicalLearning);
        denied.permissions.allow_reader_read = false;
        denied.permissions.allow_reader_write = false;
        let mut state = ToolExposureState::default();

        seed_turn_tool_activations(&hints, &registry, &denied, &mut state);
        let plan = ToolExposurePlan::build(&registry, &model(), &denied, &state);

        assert!(plan.is_visible("book.structure"));
        assert!(plan.is_visible("book.guide_path"));
        assert!(!state.is_activated("reader.state"));
        assert!(!state.is_activated("reader.gotoLid"));
        assert_eq!(
            plan.entry("reader.state").unwrap().disposition,
            ToolExposureDisposition::Hidden
        );
        assert_eq!(
            plan.entry("reader.gotoLid").unwrap().disposition,
            ToolExposureDisposition::Hidden
        );
        assert!(!state.is_activated("book.paper_reading_guide"));
    }

    #[test]
    fn turn_intent_negative_and_summary_keep_the_initial_eight_tool_golden() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let exposure_context = context(ContentProfileId::TechnicalLearning);
        let expected = vec![
            "book.query",
            "book.synthesize",
            "book.search_text",
            "book.text",
            "tool.search",
            "source.present",
            "book.context",
            "book.concept",
        ];

        for question in ["别带我读", "总结本章", "本章讲了什么", "read this aloud"] {
            let mut state = ToolExposureState::default();
            seed_turn_tool_activations(
                &classify_turn_intent(question),
                &registry,
                &exposure_context,
                &mut state,
            );
            let plan =
                ToolExposurePlan::build(&registry, &runtime_profile, &exposure_context, &state);
            assert_eq!(visible_names(&plan), expected, "question={question:?}");
            assert_eq!(state.activated_names().count(), 0);
        }
    }

    #[test]
    fn tool_exposure_initial_schema_golden_is_small_and_profile_gated() {
        let registry = resident_tool_registry();
        let state = ToolExposureState::default();
        let technical = ToolExposurePlan::build(
            &registry,
            &model(),
            &context(ContentProfileId::TechnicalLearning),
            &state,
        );
        assert_eq!(
            visible_names(&technical),
            vec![
                "book.query",
                "book.synthesize",
                "book.search_text",
                "book.text",
                "tool.search",
                "source.present",
                "book.context",
                "book.concept",
            ]
        );
        assert!(technical.visible_tools.len() <= DEFAULT_DIRECT_TOOL_LIMIT);
        assert!(technical.schema_bytes <= technical.schema_budget_bytes);
        assert_eq!(
            technical.entry("book.paper_metadata").unwrap().disposition,
            ToolExposureDisposition::Hidden
        );
        assert_eq!(
            technical.entry("reader.highlight").unwrap().disposition,
            ToolExposureDisposition::Deferred
        );
        assert_eq!(
            technical.entry("memory.save").unwrap().disposition,
            ToolExposureDisposition::Deferred
        );

        let paper = ToolExposurePlan::build(
            &registry,
            &model(),
            &context(ContentProfileId::Paper),
            &state,
        );
        for name in [
            "book.paper_reading_guide",
            "book.paper_metadata",
            "book.paper_lexicon",
        ] {
            assert_eq!(
                paper.entry(name).unwrap().disposition,
                ToolExposureDisposition::Deferred
            );
            assert!(!paper.is_visible(name));
        }

        let search = registry.registration("tool.search").unwrap();
        assert_eq!(
            search.spec.parameters,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Capability, tool family, or operation to discover"},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 6}
                },
                "required": ["query"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn tool_exposure_search_activates_only_deferred_metadata_for_next_sampling() {
        let registry = resident_tool_registry();
        let model = model();
        let context = context(ContentProfileId::Paper);
        let mut state = ToolExposureState::default();
        let sampled = ToolExposurePlan::build(&registry, &model, &context, &state);

        let outcome = search_and_activate(
            r#"{"query":"book.paper","max_results":3}"#,
            &sampled,
            &registry,
            &mut state,
        )
        .unwrap();
        assert_eq!(outcome.activated.len(), 3);
        assert!(outcome
            .activated
            .iter()
            .all(|hit| hit.name.starts_with("book.paper_")));
        assert!(outcome
            .activated
            .iter()
            .all(|hit| !hit.description.is_empty() && !hit.capabilities.is_empty()));
        assert!(!sampled.is_visible("book.paper_metadata"));

        let next = ToolExposurePlan::build(&registry, &model, &context, &state);
        assert!(next.is_visible("book.paper_metadata"));
        assert!(next.is_visible("book.paper_lexicon"));
        assert!(next.is_visible("book.paper_reading_guide"));
        assert!(next.schema_bytes <= next.schema_budget_bytes);
    }

    #[test]
    fn tool_exposure_search_caps_each_activation_and_never_reveals_hidden_tools() {
        let registry = resident_tool_registry();
        let model = model();
        let mut state = ToolExposureState::default();
        let reader_plan = ToolExposurePlan::build(
            &registry,
            &model,
            &context(ContentProfileId::TechnicalLearning),
            &state,
        );
        let first = search_and_activate(
            r#"{"query":"reader","max_results":6}"#,
            &reader_plan,
            &registry,
            &mut state,
        )
        .unwrap();
        assert_eq!(first.activated.len(), MAX_DISCOVERY_ACTIVATIONS);
        assert!(first
            .activated
            .iter()
            .all(|hit| hit.name.starts_with("reader.")));

        let mut denied = context(ContentProfileId::TechnicalLearning);
        denied.permissions = ToolPermissions {
            allow_source_presentation: false,
            allow_profile_read: false,
            allow_memory_read: false,
            allow_memory_write: false,
            allow_reader_read: false,
            allow_reader_write: false,
        };
        let mut denied_state = ToolExposureState::default();
        let denied_plan = ToolExposurePlan::build(&registry, &model, &denied, &denied_state);
        let hidden = search_and_activate(
            r#"{"query":"reader memory paper","max_results":6}"#,
            &denied_plan,
            &registry,
            &mut denied_state,
        )
        .unwrap();
        assert!(hidden.activated.iter().all(|hit| {
            !hit.name.starts_with("reader.")
                && !hit.name.starts_with("memory.")
                && !hit.name.starts_with("book.paper_")
        }));
    }

    #[test]
    fn tool_exposure_schema_budget_is_hard_and_selection_is_repeatable() {
        let registry = resident_tool_registry();
        let search_bytes = registry
            .registration("tool.search")
            .map(|registration| tool_schema_bytes(&registration.spec))
            .unwrap();
        let text_bytes = registry
            .registration("book.text")
            .map(|registration| tool_schema_bytes(&registration.spec))
            .unwrap();
        let mut constrained = model();
        constrained.tool_schema_budget_bytes = search_bytes + text_bytes + 3;
        let context = context(ContentProfileId::TechnicalLearning);
        let state = ToolExposureState::default();

        let first = ToolExposurePlan::build(&registry, &constrained, &context, &state);
        let second = ToolExposurePlan::build(&registry, &constrained, &context, &state);
        assert_eq!(visible_names(&first), vec!["book.text", "tool.search"]);
        assert_eq!(visible_names(&first), visible_names(&second));
        assert_eq!(first.schema_bytes, constrained.tool_schema_budget_bytes);
        assert_eq!(
            first.schema_bytes,
            first
                .visible_tools
                .iter()
                .map(tool_schema_bytes)
                .sum::<usize>()
                + first.visible_tools.len().saturating_sub(1)
                + 2
        );
        assert!(first
            .entries
            .iter()
            .filter(|entry| entry.exposed)
            .all(|entry| entry.reason != ToolExposureReason::SchemaBudget));
    }

    #[test]
    fn artifact_exposure_replaces_synthesize_without_exceeding_the_direct_budget() {
        let registry = resident_tool_registry();
        let model = model();
        let state = ToolExposureState::default();

        let no_overlay = ToolExposurePlan::build(
            &registry,
            &model,
            &context(ContentProfileId::TechnicalLearning),
            &state,
        );
        for name in ["artifact.list", "artifact.search", "artifact.read"] {
            assert_eq!(
                no_overlay.entry(name).unwrap().disposition,
                ToolExposureDisposition::Hidden
            );
            assert!(!no_overlay.is_visible(name));
        }

        let mut routable_context = context(ContentProfileId::TechnicalLearning);
        routable_context.artifact = ArtifactExposureContext::routable();
        let routable = ToolExposurePlan::build(&registry, &model, &routable_context, &state);
        assert_eq!(
            routable.entry("artifact.list").unwrap().disposition,
            ToolExposureDisposition::Deferred
        );
        assert_eq!(
            routable.entry("artifact.search").unwrap().disposition,
            ToolExposureDisposition::Direct
        );
        assert_eq!(
            routable.entry("artifact.read").unwrap().disposition,
            ToolExposureDisposition::Hidden
        );
        assert!(routable.is_visible("artifact.search"));
        assert!(!routable.is_visible("book.synthesize"));
        assert!(
            routable
                .entries
                .iter()
                .filter(|entry| entry.disposition == ToolExposureDisposition::Direct)
                .count()
                <= DEFAULT_DIRECT_TOOL_LIMIT
        );

        let mut hit_context = context(ContentProfileId::TechnicalLearning);
        hit_context.artifact = ArtifactExposureContext::search_hit();
        let hit = ToolExposurePlan::build(&registry, &model, &hit_context, &state);
        assert!(!hit.is_visible("artifact.search"));
        assert!(hit.is_visible("artifact.read"));
        assert!(!hit.is_visible("book.synthesize"));

        let mut exhausted_context = context(ContentProfileId::TechnicalLearning);
        exhausted_context.artifact = ArtifactExposureContext::search_exhausted();
        let exhausted = ToolExposurePlan::build(&registry, &model, &exhausted_context, &state);
        assert!(!exhausted.is_visible("artifact.search"));
        assert!(!exhausted.is_visible("artifact.read"));
        assert!(exhausted.is_visible("book.synthesize"));
    }
}
