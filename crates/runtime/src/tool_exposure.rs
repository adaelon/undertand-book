use crate::tool_registry::{
    ToolCapability, ToolEffect, ToolHandlerId, ToolOperation, ToolPrecondition, ToolRegistry,
    ToolRoutingCard, ToolScope, TOOL_SEARCH_MAX_RESULTS, TOOL_SEARCH_MAX_TASK_CHARS,
};
use crate::{ModelRuntimeProfile, ToolSpec};
use artifact_tools::{
    score_weighted_text_fields, ArtifactToolId, WeightedTextField,
    ARTIFACT_SEARCH_NORMALIZATION_VERSION,
};
use book_tool_contracts::BookToolId;
use read_tools::ContentProfileId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::fmt;

pub const TOOL_EXPOSURE_PLAN_VERSION: &str = "tool_exposure_plan.v2";
pub const TOOL_SEARCH_RESULT_VERSION: &str = "tool_search_result.v2";
pub const TURN_INTENT_CLASSIFIER_VERSION: &str = "turn_intent_classifier.v1";
pub const CAPABILITY_REQUEST_AUDIT_VERSION: &str = "capability_request_audit.v1";
pub const CAPABILITY_BLOCK_REASON_MAX_CHARS: usize = 48;
pub const DEFAULT_DIRECT_TOOL_LIMIT: usize = 8;
pub const MAX_DISCOVERY_ACTIVATIONS: usize = TOOL_SEARCH_MAX_RESULTS;

const EXPLICIT_GUIDED_READ_CAPABILITY_SEED: [ToolCapability; 4] = [
    ToolCapability::ReaderRead,
    ToolCapability::StructuralIndex,
    ToolCapability::NavigationPlan,
    ToolCapability::ReaderWrite,
];

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceState {
    UserProvided,
    KnownLids,
    CurrentAnchorOnly,
    #[default]
    Unlocated,
}

impl EvidenceState {
    fn has_observed_evidence(self) -> bool {
        matches!(self, Self::UserProvided | Self::KnownLids)
    }

    fn has_locator(self) -> bool {
        self != Self::Unlocated
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExposureContext {
    pub content_profile: ContentProfileId,
    pub permissions: ToolPermissions,
    pub evidence_state: EvidenceState,
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
    StructuralIndex,
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
    explicit_reader_mutation_intent: bool,
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

    fn has_explicit_reader_mutation_intent(&self) -> bool {
        self.explicit_reader_mutation_intent
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

    state.explicit_reader_mutation_intent = true;

    for registration in registry.registrations() {
        if !supports_explicit_guided_read(&registration.routing_card) {
            continue;
        }
        if classify(registration.handler, context).0 == ToolExposureDisposition::Deferred {
            state.activate(&registration.spec.name);
        }
    }
}

fn supports_explicit_guided_read(card: &ToolRoutingCard) -> bool {
    if !card
        .provides
        .iter()
        .any(|capability| EXPLICIT_GUIDED_READ_CAPABILITY_SEED.contains(capability))
    {
        return false;
    }

    !card.provides.contains(&ToolCapability::ReaderWrite)
        || (card.operations.contains(&ToolOperation::Navigate)
            && card.preconditions.contains(&ToolPrecondition::LocatedLid))
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSearchHitV1 {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

/// Historical receipt shape. CR5 keeps this deserialize-only so persisted v1
/// traces remain readable while no production call can emit a new v1 receipt.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSearchOutcomeV1 {
    pub version: String,
    pub query: String,
    pub activated: Vec<ToolSearchHitV1>,
    pub deferred_remaining: usize,
    pub visible_from: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSearchEffectMode {
    ReadOnly,
    ReaderMutationExplicitlyRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityRequestV2 {
    pub task: String,
    pub required_capabilities: Vec<ToolCapability>,
    pub scope: ToolScope,
    pub operation: ToolOperation,
    pub effect_mode: ToolSearchEffectMode,
    pub max_results: u8,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TaskNeed {
    pub request: CapabilityRequestV2,
    pub evidence_state: EvidenceState,
    pub authorized_effect_mode: ToolSearchEffectMode,
    pub content_profile: ContentProfileId,
    pub permissions: ToolPermissions,
}

impl fmt::Debug for TaskNeed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskNeed")
            .field("scope", &self.request.scope)
            .field("operation", &self.request.operation)
            .field("required_capabilities", &self.request.required_capabilities)
            .field("requested_effect_mode", &self.request.effect_mode)
            .field("max_results", &self.request.max_results)
            .field("evidence_state", &self.evidence_state)
            .field("authorized_effect_mode", &self.authorized_effect_mode)
            .field("content_profile", &self.content_profile)
            .field("permissions", &self.permissions)
            .finish_non_exhaustive()
    }
}

pub fn stamp_task_need(
    request: CapabilityRequestV2,
    context: &ToolExposureContext,
    state: &ToolExposureState,
) -> TaskNeed {
    let evidence_state = if context.evidence_state == EvidenceState::Unlocated
        && state.has_explicit_reader_mutation_intent()
    {
        EvidenceState::CurrentAnchorOnly
    } else {
        context.evidence_state
    };
    let authorized_effect_mode = if request.effect_mode
        == ToolSearchEffectMode::ReaderMutationExplicitlyRequested
        && state.has_explicit_reader_mutation_intent()
        && context.permissions.allow_reader_write
    {
        ToolSearchEffectMode::ReaderMutationExplicitlyRequested
    } else {
        ToolSearchEffectMode::ReadOnly
    };
    TaskNeed {
        request,
        evidence_state,
        authorized_effect_mode,
        content_profile: context.content_profile.clone(),
        permissions: context.permissions,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSearchVisibility {
    CurrentSampling,
    NextSampling,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchMatchV2 {
    pub name: String,
    pub description: String,
    pub score: u64,
    pub matched_fields: Vec<String>,
    pub matched_terms: Vec<String>,
    pub matched_capabilities: Vec<ToolCapability>,
    pub effect_mode: ToolEffect,
    pub preconditions: Vec<ToolPrecondition>,
    pub visibility: ToolSearchVisibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityBlockReason {
    EvidenceRequired,
    PermissionDenied,
    ProfileMismatch,
    ExplicitEffectIntentRequired,
    EffectNotAuthorized,
    LocatorRequired,
    ScopeUnsupported,
    OperationUnsupported,
    RuntimeHidden,
    PreconditionsUnavailable,
}

impl CapabilityBlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EvidenceRequired => "evidence_required",
            Self::PermissionDenied => "permission_denied",
            Self::ProfileMismatch => "profile_mismatch",
            Self::ExplicitEffectIntentRequired => "explicit_effect_intent_required",
            Self::EffectNotAuthorized => "effect_not_authorized",
            Self::LocatorRequired => "locator_required",
            Self::ScopeUnsupported => "scope_unsupported",
            Self::OperationUnsupported => "operation_unsupported",
            Self::RuntimeHidden => "runtime_hidden",
            Self::PreconditionsUnavailable => "preconditions_unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CapabilityBlock {
    pub capability: ToolCapability,
    pub tool: String,
    pub reason: CapabilityBlockReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precondition: Option<ToolPrecondition>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityPlan {
    pub matched_tools: Vec<ToolSearchMatchV2>,
    pub unmet_capabilities: Vec<ToolCapability>,
    pub blocked: Vec<CapabilityBlock>,
    pub visible_from: ToolSearchVisibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CapabilityRequestAudit {
    pub version: &'static str,
    pub required_capabilities: Vec<ToolCapability>,
    pub scope: ToolScope,
    pub operation: ToolOperation,
    pub requested_effect_mode: ToolSearchEffectMode,
    pub authorized_effect_mode: ToolSearchEffectMode,
    pub evidence_state: EvidenceState,
    pub content_profile: ContentProfileId,
    pub matched_tools: Vec<String>,
    pub unmet_capabilities: Vec<ToolCapability>,
    pub blocked: Vec<CapabilityBlock>,
    pub visible_from: ToolSearchVisibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchOutcomeV2 {
    pub version: &'static str,
    pub normalization: &'static str,
    pub task: String,
    pub matches: Vec<ToolSearchMatchV2>,
    pub activated: Vec<String>,
    pub deferred_remaining: usize,
    pub visible_from: &'static str,
    #[serde(skip)]
    pub task_need: TaskNeed,
    #[serde(skip)]
    pub capability_plan: CapabilityPlan,
    #[serde(skip)]
    pub request_audit: CapabilityRequestAudit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolSearchError {
    pub error_code: &'static str,
    pub category: &'static str,
    pub message: String,
}

fn exposure_block_reason(reason: ToolExposureReason) -> CapabilityBlockReason {
    match reason {
        ToolExposureReason::PermissionDenied => CapabilityBlockReason::PermissionDenied,
        ToolExposureReason::ProfileMismatch => CapabilityBlockReason::ProfileMismatch,
        ToolExposureReason::EvidenceRequired => CapabilityBlockReason::EvidenceRequired,
        ToolExposureReason::ArtifactOverlayUnavailable
        | ToolExposureReason::ArtifactRoutable
        | ToolExposureReason::ArtifactCallBudget => CapabilityBlockReason::PreconditionsUnavailable,
        _ => CapabilityBlockReason::RuntimeHidden,
    }
}

fn unmet_precondition(
    precondition: ToolPrecondition,
    need: &TaskNeed,
) -> Option<CapabilityBlockReason> {
    use ToolPrecondition as Precondition;

    match precondition {
        Precondition::LocatedLid if !need.evidence_state.has_locator() => {
            Some(CapabilityBlockReason::LocatorRequired)
        }
        Precondition::ObservedTurnEvidence if !need.evidence_state.has_observed_evidence() => {
            Some(CapabilityBlockReason::EvidenceRequired)
        }
        Precondition::SourcePresentationPermission
            if !need.permissions.allow_source_presentation =>
        {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::PaperContentProfile if need.content_profile != ContentProfileId::Paper => {
            Some(CapabilityBlockReason::ProfileMismatch)
        }
        Precondition::ProfileReadPermission if !need.permissions.allow_profile_read => {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::MemoryReadPermission if !need.permissions.allow_memory_read => {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::MemoryWritePermission if !need.permissions.allow_memory_write => {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::ReaderReadPermission if !need.permissions.allow_reader_read => {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::ReaderWritePermission if !need.permissions.allow_reader_write => {
            Some(CapabilityBlockReason::PermissionDenied)
        }
        Precondition::ExplicitReaderMutationIntent
            if need.authorized_effect_mode
                != ToolSearchEffectMode::ReaderMutationExplicitlyRequested =>
        {
            Some(CapabilityBlockReason::ExplicitEffectIntentRequired)
        }
        _ => None,
    }
}

fn block_priority(reason: CapabilityBlockReason) -> usize {
    match reason {
        CapabilityBlockReason::PermissionDenied => 0,
        CapabilityBlockReason::ExplicitEffectIntentRequired => 1,
        CapabilityBlockReason::EvidenceRequired => 2,
        CapabilityBlockReason::ProfileMismatch => 3,
        CapabilityBlockReason::LocatorRequired => 4,
        CapabilityBlockReason::EffectNotAuthorized => 5,
        CapabilityBlockReason::RuntimeHidden => 6,
        CapabilityBlockReason::PreconditionsUnavailable => 7,
        CapabilityBlockReason::ScopeUnsupported => 8,
        CapabilityBlockReason::OperationUnsupported => 9,
    }
}

pub fn resolve_capabilities(
    need: &TaskNeed,
    sampled_plan: &ToolExposurePlan,
    registry: &ToolRegistry,
) -> CapabilityPlan {
    struct Candidate {
        score: u64,
        index: usize,
        matched_fields: Vec<String>,
        matched_terms: Vec<String>,
        matched_capabilities: Vec<ToolCapability>,
        visibility: ToolSearchVisibility,
    }

    let mut candidates = Vec::new();
    let mut blocked = Vec::new();
    for (index, registration) in registry.registrations().iter().enumerate() {
        if registration.handler == ToolHandlerId::ToolSearch {
            continue;
        }
        let card = &registration.routing_card;
        let matched_capabilities = card
            .provides
            .iter()
            .copied()
            .filter(|capability| need.request.required_capabilities.contains(capability))
            .collect::<Vec<_>>();
        if matched_capabilities.is_empty() {
            continue;
        }

        let entry = sampled_plan
            .entry(&registration.spec.name)
            .expect("sampled exposure plan must cover every registered tool");
        let blocked_by = if !card.scopes.contains(&need.request.scope) {
            Some((CapabilityBlockReason::ScopeUnsupported, None))
        } else if !card.operations.contains(&need.request.operation) {
            Some((CapabilityBlockReason::OperationUnsupported, None))
        } else if matches!(
            entry.reason,
            ToolExposureReason::DirectLimit | ToolExposureReason::SchemaBudget
        ) || entry.disposition == ToolExposureDisposition::Hidden
            || (entry.disposition == ToolExposureDisposition::Direct && !entry.exposed)
        {
            Some((exposure_block_reason(entry.reason), None))
        } else if card.effects == ToolEffect::ReaderWrite
            && need.request.effect_mode == ToolSearchEffectMode::ReadOnly
        {
            Some((CapabilityBlockReason::EffectNotAuthorized, None))
        } else if card.effects == ToolEffect::ReaderWrite && !need.permissions.allow_reader_write {
            Some((CapabilityBlockReason::PermissionDenied, None))
        } else if card.effects == ToolEffect::ReaderWrite
            && need.authorized_effect_mode
                != ToolSearchEffectMode::ReaderMutationExplicitlyRequested
        {
            Some((
                CapabilityBlockReason::ExplicitEffectIntentRequired,
                Some(ToolPrecondition::ExplicitReaderMutationIntent),
            ))
        } else {
            card.preconditions.iter().find_map(|precondition| {
                unmet_precondition(*precondition, need).map(|reason| (reason, Some(*precondition)))
            })
        };
        if let Some((reason, precondition)) = blocked_by {
            blocked.extend(
                matched_capabilities
                    .into_iter()
                    .map(|capability| CapabilityBlock {
                        capability,
                        tool: registration.spec.name.clone(),
                        reason,
                        precondition,
                    }),
            );
            continue;
        }

        let mut text_fields = vec![
            WeightedTextField {
                name: "name",
                weight: 10,
                value: &registration.spec.name,
            },
            WeightedTextField {
                name: "description",
                weight: 8,
                value: &registration.spec.description,
            },
        ];
        text_fields.extend(card.use_when.iter().map(|value| WeightedTextField {
            name: "use_when",
            weight: 7,
            value,
        }));
        let lexical = score_weighted_text_fields(&need.request.task, &text_fields);
        let mut matched_fields = BTreeSet::from([
            "authorized_effect_mode".to_string(),
            "content_profile".to_string(),
            "evidence_state".to_string(),
            "operation".to_string(),
            "permissions".to_string(),
            "required_capabilities".to_string(),
            "scope".to_string(),
        ]);
        let matched_terms = lexical
            .as_ref()
            .map(|matched| matched.matched_terms.clone())
            .unwrap_or_default();
        if let Some(matched) = &lexical {
            matched_fields.extend(matched.matched_fields.iter().cloned());
        }
        let structured_score = (matched_capabilities.len() as u64)
            .saturating_mul(100)
            .saturating_add(7);
        candidates.push(Candidate {
            score: lexical
                .as_ref()
                .map(|matched| matched.score)
                .unwrap_or_default()
                .saturating_add(structured_score),
            index,
            matched_fields: matched_fields.into_iter().collect(),
            matched_terms,
            matched_capabilities,
            visibility: if entry.exposed {
                ToolSearchVisibility::CurrentSampling
            } else {
                ToolSearchVisibility::NextSampling
            },
        });
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.index.cmp(&right.index))
    });
    let result_limit = usize::from(need.request.max_results).min(MAX_DISCOVERY_ACTIVATIONS);
    let mut uncovered = need.request.required_capabilities.clone();
    let mut selected = Vec::new();
    while selected.len() < result_limit && !uncovered.is_empty() {
        let best_coverage = candidates
            .iter()
            .map(|candidate| {
                candidate
                    .matched_capabilities
                    .iter()
                    .filter(|capability| uncovered.contains(capability))
                    .count()
            })
            .max()
            .unwrap_or_default();
        if best_coverage == 0 {
            break;
        }
        let best_index = candidates
            .iter()
            .position(|candidate| {
                candidate
                    .matched_capabilities
                    .iter()
                    .filter(|capability| uncovered.contains(capability))
                    .count()
                    == best_coverage
            })
            .expect("a positive coverage candidate must exist");
        let candidate = candidates.remove(best_index);
        uncovered.retain(|capability| !candidate.matched_capabilities.contains(capability));
        selected.push(candidate);
    }
    selected.extend(candidates.into_iter().take(result_limit - selected.len()));
    let matched_tools = selected
        .into_iter()
        .map(|candidate| {
            let registration = &registry.registrations()[candidate.index];
            ToolSearchMatchV2 {
                name: registration.spec.name.clone(),
                description: registration.spec.description.clone(),
                score: candidate.score,
                matched_fields: candidate.matched_fields,
                matched_terms: candidate.matched_terms,
                matched_capabilities: candidate.matched_capabilities,
                effect_mode: registration.routing_card.effects,
                preconditions: registration.routing_card.preconditions.clone(),
                visibility: candidate.visibility,
            }
        })
        .collect::<Vec<_>>();
    let unmet_capabilities = need
        .request
        .required_capabilities
        .iter()
        .copied()
        .filter(|capability| {
            !matched_tools
                .iter()
                .any(|matched| matched.matched_capabilities.contains(capability))
        })
        .collect::<Vec<_>>();
    blocked.retain(|block| unmet_capabilities.contains(&block.capability));
    blocked.sort_by_key(|block| {
        (
            need.request
                .required_capabilities
                .iter()
                .position(|capability| *capability == block.capability)
                .unwrap_or(usize::MAX),
            block_priority(block.reason),
        )
    });
    blocked.dedup_by(|right, left| {
        left.capability == right.capability
            && left.tool == right.tool
            && left.reason == right.reason
            && left.precondition == right.precondition
    });
    blocked.truncate(ToolCapability::ALL.len().saturating_mul(2));
    let visible_from = if matched_tools
        .iter()
        .any(|matched| matched.visibility == ToolSearchVisibility::NextSampling)
    {
        ToolSearchVisibility::NextSampling
    } else {
        ToolSearchVisibility::CurrentSampling
    };

    CapabilityPlan {
        matched_tools,
        unmet_capabilities,
        blocked,
        visible_from,
    }
}

pub fn search_and_activate(
    arguments: &str,
    context: &ToolExposureContext,
    sampled_plan: &ToolExposurePlan,
    registry: &ToolRegistry,
    state: &mut ToolExposureState,
) -> Result<ToolSearchOutcomeV2, ToolSearchError> {
    let mut request: CapabilityRequestV2 =
        serde_json::from_str(arguments).map_err(|error| ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!("tool.search arguments are invalid: {error}"),
        })?;
    request.task = request.task.trim().to_string();
    if request.task.is_empty() {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: "tool.search task must not be empty".into(),
        });
    }
    if request.task.chars().count() > TOOL_SEARCH_MAX_TASK_CHARS {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!(
                "tool.search task must contain at most {TOOL_SEARCH_MAX_TASK_CHARS} characters"
            ),
        });
    }
    if request.required_capabilities.is_empty()
        || request.required_capabilities.len() > ToolCapability::ALL.len()
        || request
            .required_capabilities
            .iter()
            .enumerate()
            .any(|(index, capability)| request.required_capabilities[..index].contains(capability))
    {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!(
                "tool.search required_capabilities must contain 1 to {} unique values",
                ToolCapability::ALL.len()
            ),
        });
    }
    if !(1..=MAX_DISCOVERY_ACTIVATIONS).contains(&usize::from(request.max_results)) {
        return Err(ToolSearchError {
            error_code: "INVALID_TOOL_SEARCH",
            category: "validation",
            message: format!(
                "tool.search max_results must be between 1 and {MAX_DISCOVERY_ACTIVATIONS}"
            ),
        });
    }

    let task_need = stamp_task_need(request, context, state);
    let capability_plan = resolve_capabilities(&task_need, sampled_plan, registry);
    let mut activated = Vec::new();
    for matched in &capability_plan.matched_tools {
        if matched.visibility == ToolSearchVisibility::NextSampling {
            state.activate(&matched.name);
            activated.push(matched.name.clone());
        }
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
    let visible_from = match capability_plan.visible_from {
        ToolSearchVisibility::CurrentSampling => "current_sampling",
        ToolSearchVisibility::NextSampling => "next_sampling",
    };
    let request_audit = CapabilityRequestAudit {
        version: CAPABILITY_REQUEST_AUDIT_VERSION,
        required_capabilities: task_need.request.required_capabilities.clone(),
        scope: task_need.request.scope,
        operation: task_need.request.operation,
        requested_effect_mode: task_need.request.effect_mode,
        authorized_effect_mode: task_need.authorized_effect_mode,
        evidence_state: task_need.evidence_state,
        content_profile: task_need.content_profile.clone(),
        matched_tools: capability_plan
            .matched_tools
            .iter()
            .map(|matched| matched.name.clone())
            .collect(),
        unmet_capabilities: capability_plan.unmet_capabilities.clone(),
        blocked: capability_plan.blocked.clone(),
        visible_from: capability_plan.visible_from,
    };
    Ok(ToolSearchOutcomeV2 {
        version: TOOL_SEARCH_RESULT_VERSION,
        normalization: ARTIFACT_SEARCH_NORMALIZATION_VERSION,
        task: task_need.request.task.clone(),
        matches: capability_plan.matched_tools.clone(),
        activated,
        deferred_remaining,
        visible_from,
        task_need,
        capability_plan,
        request_audit,
    })
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
        Handler::SourcePresent if context.evidence_state.has_observed_evidence() => {
            (Disposition::Direct, Reason::EvidenceAvailable)
        }
        Handler::SourcePresent => (Disposition::Hidden, Reason::EvidenceRequired),
        Handler::Book(
            BookToolId::PaperMetadata | BookToolId::PaperLexicon | BookToolId::PaperReadingGuide,
        ) if context.content_profile == ContentProfileId::Paper => {
            (Disposition::Deferred, Reason::ContentProfile)
        }
        Handler::Book(
            BookToolId::PaperMetadata | BookToolId::PaperLexicon | BookToolId::PaperReadingGuide,
        ) => (Disposition::Hidden, Reason::ProfileMismatch),
        Handler::Book(BookToolId::Structure) => (Disposition::Direct, Reason::StructuralIndex),
        Handler::Book(BookToolId::GuidePath)
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
        ToolHandlerId::Book(BookToolId::Structure) => 8,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::resident_tool_registry;
    use crate::{
        native_chat_request_projection, react_chat_request_projection, AgentRequestPlan, Message,
        ModelRuntimeCatalog, ProviderToolProtocol,
    };

    fn model() -> ModelRuntimeProfile {
        ModelRuntimeProfile::fallback("test-model", ProviderToolProtocol::Native)
    }

    fn context(content_profile: ContentProfileId) -> ToolExposureContext {
        ToolExposureContext {
            content_profile,
            permissions: ToolPermissions::default(),
            evidence_state: EvidenceState::Unlocated,
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
    fn turn_intent_negative_and_summary_keep_the_read_only_structural_first_surface() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let exposure_context = context(ContentProfileId::TechnicalLearning);
        let expected = vec![
            "book.query",
            "book.synthesize",
            "book.search_text",
            "book.text",
            "tool.search",
            "book.context",
            "book.concept",
            "book.structure",
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
        assert_eq!(technical.version, "tool_exposure_plan.v2");
        assert_eq!(
            visible_names(&technical),
            vec![
                "book.query",
                "book.synthesize",
                "book.search_text",
                "book.text",
                "tool.search",
                "book.context",
                "book.concept",
                "book.structure",
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
        assert!(paper.is_visible("book.structure"));
        assert!(!paper.is_visible("source.present"));
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
            crate::tool_registry::tool_search_input_schema_v2()
        );
    }

    #[test]
    fn tool_search_v2_schema_is_closed_bounded_and_provider_equivalent() {
        let registry = resident_tool_registry();
        let search = registry.registration("tool.search").unwrap();
        let capabilities = ToolCapability::ALL
            .iter()
            .map(|capability| serde_json::Value::String(capability.as_str().into()))
            .collect::<Vec<_>>();
        let expected = serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512,
                    "description": "Natural-language task used only to rank already-authorized candidates"
                },
                "required_capabilities": {
                    "type": "array",
                    "items": {"type": "string", "enum": capabilities},
                    "minItems": 1,
                    "maxItems": ToolCapability::ALL.len(),
                    "uniqueItems": true
                },
                "scope": {
                    "type": "string",
                    "enum": ["selection", "passage", "section", "document", "corpus"]
                },
                "operation": {
                    "type": "string",
                    "enum": [
                        "locate_literal", "read_source", "explain", "compare", "summarize",
                        "navigate", "mutate_reader"
                    ]
                },
                "effect_mode": {
                    "type": "string",
                    "enum": ["read_only", "reader_mutation_explicitly_requested"]
                },
                "max_results": {"type": "integer", "minimum": 1, "maximum": 6}
            },
            "required": [
                "task", "required_capabilities", "scope", "operation", "effect_mode",
                "max_results"
            ],
            "additionalProperties": false
        });
        assert_eq!(search.spec.parameters, expected);

        let request = AgentRequestPlan::for_agent_turn(
            model(),
            &[Message::system("base")],
            std::slice::from_ref(&search.spec),
        );
        let (native, _) = native_chat_request_projection("snapshot-model", &request);
        assert_eq!(native["tools"][0]["function"]["parameters"], expected);

        let react = react_chat_request_projection("snapshot-model", &request);
        let protocol = react["messages"][0]["content"].as_str().unwrap();
        let react_tool = serde_json::json!([{
            "name": search.spec.name,
            "description": search.spec.description,
            "parameters": expected,
        }]);
        assert!(protocol.contains(&serde_json::to_string_pretty(&react_tool).unwrap()));
    }

    #[test]
    fn task_need_rejects_model_spoofing_and_stamps_runtime_authority() {
        let spoofed_evidence = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"private reader request","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":1,"evidence_state":"known_lids"}"#,
        );
        let spoofed_authority = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"private reader request","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":1,"authorized_effect_mode":"reader_mutation_explicitly_requested"}"#,
        );
        assert!(spoofed_evidence.is_err());
        assert!(spoofed_authority.is_err());

        let request = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"private reader request","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":1}"#,
        )
        .unwrap();
        let mut runtime_context = context(ContentProfileId::TechnicalLearning);
        runtime_context.evidence_state = EvidenceState::KnownLids;
        runtime_context.permissions.allow_reader_write = false;
        let need = stamp_task_need(request, &runtime_context, &ToolExposureState::default());

        assert_eq!(need.evidence_state, EvidenceState::KnownLids);
        assert_eq!(need.authorized_effect_mode, ToolSearchEffectMode::ReadOnly);
        assert_eq!(need.content_profile, ContentProfileId::TechnicalLearning);
        assert!(!need.permissions.allow_reader_write);
        assert!(!format!("{need:?}").contains("private reader request"));
    }

    #[test]
    fn capability_resolver_changes_plan_with_runtime_evidence_profile_and_permissions() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let source_request = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"present the private passage","required_capabilities":["source_presentation"],"scope":"document","operation":"read_source","effect_mode":"read_only","max_results":1}"#,
        )
        .unwrap();

        let unlocated = context(ContentProfileId::TechnicalLearning);
        let unlocated_sample = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &unlocated,
            &ToolExposureState::default(),
        );
        let unlocated_need = stamp_task_need(
            source_request.clone(),
            &unlocated,
            &ToolExposureState::default(),
        );
        let unlocated_plan = resolve_capabilities(&unlocated_need, &unlocated_sample, &registry);
        assert!(unlocated_plan.matched_tools.is_empty());
        assert_eq!(
            unlocated_plan.unmet_capabilities,
            vec![ToolCapability::SourcePresentation]
        );
        assert_eq!(
            unlocated_plan.blocked[0].reason,
            CapabilityBlockReason::EvidenceRequired
        );

        let mut observed = unlocated.clone();
        observed.evidence_state = EvidenceState::KnownLids;
        let observed_sample = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &observed,
            &ToolExposureState::default(),
        );
        let observed_need = stamp_task_need(
            source_request.clone(),
            &observed,
            &ToolExposureState::default(),
        );
        let observed_plan = resolve_capabilities(&observed_need, &observed_sample, &registry);
        assert_eq!(observed_plan.matched_tools[0].name, "source.present");
        assert!(observed_plan.unmet_capabilities.is_empty());
        assert!(observed_plan.blocked.is_empty());

        let mut denied = observed;
        denied.permissions.allow_source_presentation = false;
        let denied_sample = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &denied,
            &ToolExposureState::default(),
        );
        let denied_need = stamp_task_need(source_request, &denied, &ToolExposureState::default());
        let denied_plan = resolve_capabilities(&denied_need, &denied_sample, &registry);
        assert!(denied_plan.matched_tools.is_empty());
        assert_eq!(
            denied_plan.blocked[0].reason,
            CapabilityBlockReason::PermissionDenied
        );

        let paper_request = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"read private paper metadata","required_capabilities":["source_read"],"scope":"document","operation":"read_source","effect_mode":"read_only","max_results":1}"#,
        )
        .unwrap();
        let technical = context(ContentProfileId::TechnicalLearning);
        let technical_sample = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &technical,
            &ToolExposureState::default(),
        );
        let technical_need = stamp_task_need(
            paper_request.clone(),
            &technical,
            &ToolExposureState::default(),
        );
        let technical_plan = resolve_capabilities(&technical_need, &technical_sample, &registry);
        assert!(technical_plan.matched_tools.is_empty());
        assert_eq!(
            technical_plan.blocked[0].reason,
            CapabilityBlockReason::ProfileMismatch
        );

        let paper = context(ContentProfileId::Paper);
        let paper_sample = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &paper,
            &ToolExposureState::default(),
        );
        let paper_need = stamp_task_need(paper_request, &paper, &ToolExposureState::default());
        let paper_plan = resolve_capabilities(&paper_need, &paper_sample, &registry);
        assert_eq!(paper_plan.matched_tools[0].name, "book.paper_metadata");
    }

    #[test]
    fn capability_resolver_requires_runtime_effect_seed_and_audits_without_task_text() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let request_json = r#"{"task":"highlight private phrase that must never enter capability audit","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":1}"#;
        let runtime_context = context(ContentProfileId::TechnicalLearning);
        let sampled = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &runtime_context,
            &ToolExposureState::default(),
        );
        let mut unseeded_state = ToolExposureState::default();
        let unseeded = search_and_activate(
            request_json,
            &runtime_context,
            &sampled,
            &registry,
            &mut unseeded_state,
        )
        .unwrap();
        assert!(unseeded.matches.is_empty());
        assert_eq!(
            unseeded.capability_plan.blocked[0].reason,
            CapabilityBlockReason::ExplicitEffectIntentRequired
        );
        assert_eq!(unseeded_state.activated_names().count(), 0);

        let mut seeded_state = ToolExposureState::default();
        seed_turn_tool_activations(
            &classify_turn_intent("guide me through this passage"),
            &registry,
            &runtime_context,
            &mut seeded_state,
        );
        let seeded_sample =
            ToolExposurePlan::build(&registry, &runtime_profile, &runtime_context, &seeded_state);
        let seeded = search_and_activate(
            request_json,
            &runtime_context,
            &seeded_sample,
            &registry,
            &mut seeded_state,
        )
        .unwrap();
        assert_eq!(seeded.capability_plan.matched_tools.len(), 1);
        assert_eq!(
            seeded.capability_plan.visible_from,
            ToolSearchVisibility::NextSampling
        );
        assert!(!seeded_sample.is_visible(&seeded.activated[0]));
        let next =
            ToolExposurePlan::build(&registry, &runtime_profile, &runtime_context, &seeded_state);
        assert!(next.is_visible(&seeded.activated[0]));

        let audit = serde_json::to_string(&seeded.request_audit).unwrap();
        assert!(!audit.contains("private phrase"));
        assert!(audit.contains("reader_write"));
        assert!(audit.contains("reader_mutation_explicitly_requested"));
        assert!(seeded
            .request_audit
            .blocked
            .iter()
            .all(|block| block.reason.as_str().len() <= CAPABILITY_BLOCK_REASON_MAX_CHARS));
    }

    #[test]
    fn capability_resolver_covers_a_multi_tool_task_need_before_filling_alternatives() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let runtime_context = context(ContentProfileId::TechnicalLearning);
        let mut state = ToolExposureState::default();
        seed_turn_tool_activations(
            &classify_turn_intent("guide me through this document"),
            &registry,
            &runtime_context,
            &mut state,
        );
        let sampled =
            ToolExposurePlan::build(&registry, &runtime_profile, &runtime_context, &state);
        let request = serde_json::from_str::<CapabilityRequestV2>(
            r#"{"task":"guide me through this document","required_capabilities":["structural_index","navigation_plan","reader_read","reader_write"],"scope":"document","operation":"navigate","effect_mode":"reader_mutation_explicitly_requested","max_results":6}"#,
        )
        .unwrap();
        let need = stamp_task_need(request, &runtime_context, &state);
        let plan = resolve_capabilities(&need, &sampled, &registry);

        assert!(plan.unmet_capabilities.is_empty());
        assert!(plan.blocked.is_empty());
        assert!(plan.matched_tools.len() <= 6);
        for capability in [
            ToolCapability::StructuralIndex,
            ToolCapability::NavigationPlan,
            ToolCapability::ReaderRead,
            ToolCapability::ReaderWrite,
        ] {
            assert!(
                plan.matched_tools
                    .iter()
                    .any(|matched| matched.matched_capabilities.contains(&capability)),
                "missing capability {capability:?}"
            );
        }
    }

    #[test]
    fn tool_search_v2_filters_then_matches_structural_index_for_a_cjk_task() {
        let registry = resident_tool_registry();
        let runtime_context = context(ContentProfileId::TechnicalLearning);
        let sampled = ToolExposurePlan::build(
            &registry,
            &model(),
            &runtime_context,
            &ToolExposureState::default(),
        );
        let mut state = ToolExposureState::default();

        let outcome = search_and_activate(
            r#"{"task":"这本书主要讲什么","required_capabilities":["structural_index"],"scope":"document","operation":"summarize","effect_mode":"read_only","max_results":3}"#,
            &runtime_context,
            &sampled,
            &registry,
            &mut state,
        )
        .unwrap();
        let value = serde_json::to_value(outcome).unwrap();

        assert_eq!(value["version"], "tool_search_result.v2");
        assert_eq!(value["matches"][0]["name"], "book.structure");
        assert_eq!(
            value["matches"][0]["matched_capabilities"],
            serde_json::json!(["structural_index"])
        );
        assert_eq!(value["matches"][0]["effect_mode"], "read_only");
        assert!(value["matches"][0]["preconditions"]
            .as_array()
            .is_some_and(|values| !values.is_empty()));
        assert!(value["matches"][0]["score"].as_u64().is_some());
        assert!(!state.is_activated("book.structure"));
    }

    #[test]
    fn tool_search_v2_reader_write_requires_authority_and_permission_and_zero_hit_is_inert() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let default_context = context(ContentProfileId::TechnicalLearning);
        let sampled = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &default_context,
            &ToolExposureState::default(),
        );
        let arguments = r#"{"task":"highlight this passage","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":6}"#;
        let mut unauthorized_state = ToolExposureState::default();
        let unauthorized = search_and_activate(
            arguments,
            &default_context,
            &sampled,
            &registry,
            &mut unauthorized_state,
        )
        .unwrap();
        assert!(serde_json::to_value(unauthorized).unwrap()["matches"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(unauthorized_state.activated_names().count(), 0);

        let mut denied_context = default_context;
        denied_context.permissions.allow_reader_write = false;
        let denied_plan = ToolExposurePlan::build(
            &registry,
            &runtime_profile,
            &denied_context,
            &ToolExposureState::default(),
        );
        let mut denied_state = ToolExposureState::default();
        let denied = search_and_activate(
            r#"{"task":"highlight this passage","required_capabilities":["reader_write"],"scope":"passage","operation":"mutate_reader","effect_mode":"reader_mutation_explicitly_requested","max_results":6}"#,
            &denied_context,
            &denied_plan,
            &registry,
            &mut denied_state,
        )
        .unwrap();
        assert!(serde_json::to_value(denied).unwrap()["matches"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(denied_state.activated_names().count(), 0);
    }

    #[test]
    fn tool_search_v2_keeps_v1_receipts_readable_without_producing_them() {
        let legacy: ToolSearchOutcomeV1 = serde_json::from_value(serde_json::json!({
            "version": "tool_search_result.v1",
            "query": "book.paper",
            "activated": [{
                "name": "book.paper_metadata",
                "description": "Read paper metadata",
                "capabilities": ["book_read"]
            }],
            "deferred_remaining": 2,
            "visible_from": "next_sampling"
        }))
        .unwrap();

        assert_eq!(legacy.version, "tool_search_result.v1");
        assert_eq!(legacy.activated[0].capabilities, vec!["book_read"]);
    }

    #[test]
    fn tool_search_v2_order_score_and_max_results_are_repeatable() {
        let registry = resident_tool_registry();
        let mut runtime_context = context(ContentProfileId::TechnicalLearning);
        runtime_context.evidence_state = EvidenceState::KnownLids;
        let sampled = ToolExposurePlan::build(
            &registry,
            &model(),
            &runtime_context,
            &ToolExposureState::default(),
        );
        let arguments = r#"{"task":"plan a route through the document","required_capabilities":["navigation_plan"],"scope":"document","operation":"navigate","effect_mode":"read_only","max_results":2}"#;
        let mut first_state = ToolExposureState::default();
        let mut second_state = ToolExposureState::default();

        let first = serde_json::to_value(
            search_and_activate(
                arguments,
                &runtime_context,
                &sampled,
                &registry,
                &mut first_state,
            )
            .unwrap(),
        )
        .unwrap();
        let second = serde_json::to_value(
            search_and_activate(
                arguments,
                &runtime_context,
                &sampled,
                &registry,
                &mut second_state,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(first, second);
        assert_eq!(first["matches"].as_array().unwrap().len(), 2);
        assert_eq!(
            first_state.activated_names().collect::<Vec<_>>(),
            second_state.activated_names().collect::<Vec<_>>()
        );
    }

    #[test]
    fn tool_exposure_source_presentation_is_direct_only_with_turn_evidence() {
        let registry = resident_tool_registry();
        let runtime_profile = model();
        let state = ToolExposureState::default();
        let without_evidence = context(ContentProfileId::TechnicalLearning);

        let initial =
            ToolExposurePlan::build(&registry, &runtime_profile, &without_evidence, &state);
        assert_eq!(
            initial.entry("source.present").unwrap().disposition,
            ToolExposureDisposition::Hidden
        );
        assert_eq!(
            initial.entry("source.present").unwrap().reason,
            ToolExposureReason::EvidenceRequired
        );
        assert!(!initial.is_visible("source.present"));
        assert!(initial.is_visible("book.structure"));

        let mut discovery_state = ToolExposureState::default();
        let discovery = search_and_activate(
            r#"{"task":"present the observed source","required_capabilities":["source_presentation"],"scope":"document","operation":"read_source","effect_mode":"read_only","max_results":1}"#,
            &without_evidence,
            &initial,
            &registry,
            &mut discovery_state,
        )
        .unwrap();
        assert!(discovery.matches.is_empty());
        assert!(discovery.activated.is_empty());
        assert!(!discovery_state.is_activated("source.present"));

        let mut with_evidence = without_evidence;
        with_evidence.evidence_state = EvidenceState::KnownLids;
        let after_read =
            ToolExposurePlan::build(&registry, &runtime_profile, &with_evidence, &state);
        assert_eq!(
            after_read.entry("source.present").unwrap().disposition,
            ToolExposureDisposition::Direct
        );
        assert_eq!(
            after_read.entry("source.present").unwrap().reason,
            ToolExposureReason::EvidenceAvailable
        );
        assert!(after_read.is_visible("source.present"));
        assert!(after_read.visible_tools.len() <= DEFAULT_DIRECT_TOOL_LIMIT);
    }

    #[test]
    fn tool_exposure_search_activates_only_deferred_metadata_for_next_sampling() {
        let registry = resident_tool_registry();
        let model = model();
        let context = context(ContentProfileId::Paper);
        let mut state = ToolExposureState::default();
        let sampled = ToolExposurePlan::build(&registry, &model, &context, &state);

        let outcome = search_and_activate(
            r#"{"task":"read paper metadata","required_capabilities":["source_read"],"scope":"document","operation":"read_source","effect_mode":"read_only","max_results":1}"#,
            &context,
            &sampled,
            &registry,
            &mut state,
        )
        .unwrap();
        assert_eq!(outcome.activated, vec!["book.paper_metadata"]);
        assert_eq!(outcome.matches[0].name, "book.paper_metadata");
        assert!(!outcome.matches[0].description.is_empty());
        assert_eq!(
            outcome.matches[0].matched_capabilities,
            vec![ToolCapability::SourceRead]
        );
        assert!(!sampled.is_visible("book.paper_metadata"));

        let next = ToolExposurePlan::build(&registry, &model, &context, &state);
        assert!(next.is_visible("book.paper_metadata"));
        assert!(!next.is_visible("book.paper_lexicon"));
        assert!(!next.is_visible("book.paper_reading_guide"));
        assert!(next.schema_bytes <= next.schema_budget_bytes);
    }

    #[test]
    fn precise_routing_cards_keep_tool_search_v1_legacy_result_shape_equivalent() {
        let receipt: ToolSearchOutcomeV1 = serde_json::from_value(serde_json::json!({
            "version": "tool_search_result.v1",
            "query": "book.paper",
            "activated": [
                {
                    "name": "book.paper_reading_guide",
                    "description": "legacy reading guide",
                    "capabilities": ["book_read", "navigation"]
                },
                {
                    "name": "book.paper_metadata",
                    "description": "legacy metadata",
                    "capabilities": ["book_read"]
                },
                {
                    "name": "book.paper_lexicon",
                    "description": "legacy lexicon",
                    "capabilities": ["book_read"]
                }
            ],
            "deferred_remaining": 0,
            "visible_from": "next_sampling"
        }))
        .unwrap();

        assert_eq!(receipt.version, "tool_search_result.v1");
        assert_eq!(
            receipt
                .activated
                .iter()
                .map(|hit| (hit.name.as_str(), hit.capabilities.clone()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "book.paper_reading_guide",
                    vec!["book_read".into(), "navigation".into()]
                ),
                ("book.paper_metadata", vec!["book_read".into()]),
                ("book.paper_lexicon", vec!["book_read".into()]),
            ]
        );
    }

    #[test]
    fn tool_exposure_search_caps_each_activation_and_never_reveals_hidden_tools() {
        let registry = resident_tool_registry();
        let model = model();
        let reader_context = context(ContentProfileId::TechnicalLearning);
        let mut state = ToolExposureState::default();
        let reader_plan = ToolExposurePlan::build(&registry, &model, &reader_context, &state);
        let first = search_and_activate(
            r#"{"task":"read current Reader state","required_capabilities":["reader_read"],"scope":"document","operation":"navigate","effect_mode":"read_only","max_results":1}"#,
            &reader_context,
            &reader_plan,
            &registry,
            &mut state,
        )
        .unwrap();
        assert_eq!(first.activated, vec!["reader.state"]);
        assert_eq!(first.matches[0].name, "reader.state");

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
            r#"{"task":"read current Reader state","required_capabilities":["reader_read"],"scope":"document","operation":"navigate","effect_mode":"read_only","max_results":6}"#,
            &denied,
            &denied_plan,
            &registry,
            &mut denied_state,
        )
        .unwrap();
        assert!(hidden.matches.is_empty());
        assert!(hidden.activated.is_empty());
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
