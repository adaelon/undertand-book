use crate::ToolSpec;
use artifact_tools::{
    aliases as artifact_aliases, artifact_list_input_schema, artifact_read_input_schema,
    artifact_search_input_schema, validate_artifact_list_input, validate_artifact_read_input,
    validate_artifact_search_input, ArtifactToolId,
};
use book_tool_contracts::{
    contract_for, from_resident_alias, input_schema, validate_input, BookToolId,
};
use read_tools::ContentProfileId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;

pub const TOOL_ROUTING_CARD_VERSION: &str = "tool_routing_card.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolHandlerId {
    Book(BookToolId),
    Artifact(ArtifactToolId),
    ToolSearch,
    SourcePresent,
    ProfileManifest,
    ProfileMarkUsed,
    BookRouteFrom,
    BookGuidedRouteFrom,
    BookUnvisitedBack,
    BookRouteTo,
    MemorySave,
    MemoryRecall,
    ReaderGotoLid,
    ReaderScroll,
    ReaderHighlight,
    ReaderNote,
    ReaderLayoutApply,
    ReaderPaperMinimapApply,
    ReaderState,
}

impl ToolHandlerId {
    pub const ALL: [ToolHandlerId; 31] = [
        ToolHandlerId::Book(BookToolId::Query),
        ToolHandlerId::Book(BookToolId::Synthesize),
        ToolHandlerId::Book(BookToolId::SearchText),
        ToolHandlerId::Book(BookToolId::Text),
        ToolHandlerId::ToolSearch,
        ToolHandlerId::Artifact(ArtifactToolId::List),
        ToolHandlerId::Artifact(ArtifactToolId::Search),
        ToolHandlerId::Artifact(ArtifactToolId::Read),
        ToolHandlerId::SourcePresent,
        ToolHandlerId::Book(BookToolId::Context),
        ToolHandlerId::Book(BookToolId::Concept),
        ToolHandlerId::Book(BookToolId::Structure),
        ToolHandlerId::Book(BookToolId::GuidePath),
        ToolHandlerId::Book(BookToolId::PaperReadingGuide),
        ToolHandlerId::Book(BookToolId::PaperMetadata),
        ToolHandlerId::Book(BookToolId::PaperLexicon),
        ToolHandlerId::ProfileManifest,
        ToolHandlerId::ProfileMarkUsed,
        ToolHandlerId::BookRouteFrom,
        ToolHandlerId::BookGuidedRouteFrom,
        ToolHandlerId::BookUnvisitedBack,
        ToolHandlerId::BookRouteTo,
        ToolHandlerId::MemorySave,
        ToolHandlerId::MemoryRecall,
        ToolHandlerId::ReaderGotoLid,
        ToolHandlerId::ReaderScroll,
        ToolHandlerId::ReaderHighlight,
        ToolHandlerId::ReaderNote,
        ToolHandlerId::ReaderLayoutApply,
        ToolHandlerId::ReaderPaperMinimapApply,
        ToolHandlerId::ReaderState,
    ];

    pub fn canonical_name(self) -> &'static str {
        match self {
            ToolHandlerId::Book(id) => contract_for(id)
                .aliases
                .resident
                .expect("registered Book handler must have a Resident alias"),
            ToolHandlerId::Artifact(id) => artifact_aliases(id).resident,
            ToolHandlerId::ToolSearch => "tool.search",
            ToolHandlerId::SourcePresent => "source.present",
            ToolHandlerId::ProfileManifest => "profile.manifest",
            ToolHandlerId::ProfileMarkUsed => "profile.mark_used",
            ToolHandlerId::BookRouteFrom => "book.route_from",
            ToolHandlerId::BookGuidedRouteFrom => "book.guided_route_from",
            ToolHandlerId::BookUnvisitedBack => "book.unvisited_back",
            ToolHandlerId::BookRouteTo => "book.route_to",
            ToolHandlerId::MemorySave => "memory.save",
            ToolHandlerId::MemoryRecall => "memory.recall",
            ToolHandlerId::ReaderGotoLid => "reader.gotoLid",
            ToolHandlerId::ReaderScroll => "reader.scroll",
            ToolHandlerId::ReaderHighlight => "reader.highlight",
            ToolHandlerId::ReaderNote => "reader.note",
            ToolHandlerId::ReaderLayoutApply => "reader.layout.apply",
            ToolHandlerId::ReaderPaperMinimapApply => "reader.paper_minimap.apply",
            ToolHandlerId::ReaderState => "reader.state",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        if let Some(id) = from_resident_alias(name) {
            return Some(ToolHandlerId::Book(id));
        }
        for id in [
            ArtifactToolId::List,
            ArtifactToolId::Search,
            ArtifactToolId::Read,
        ] {
            if artifact_aliases(id).resident == name {
                return Some(ToolHandlerId::Artifact(id));
            }
        }
        Self::ALL
            .iter()
            .copied()
            .find(|handler| handler.canonical_name() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyToolCapability {
    Discovery,
    BookRead,
    BookSearch,
    BookQuery,
    ArtifactRead,
    SourcePresentation,
    Navigation,
    ProfileRead,
    ProfileTrace,
    MemoryRead,
    MemoryWrite,
    ReaderRead,
    ReaderWrite,
}

impl LegacyToolCapability {
    pub const ALL: [LegacyToolCapability; 13] = [
        Self::Discovery,
        Self::BookRead,
        Self::BookSearch,
        Self::BookQuery,
        Self::ArtifactRead,
        Self::SourcePresentation,
        Self::Navigation,
        Self::ProfileRead,
        Self::ProfileTrace,
        Self::MemoryRead,
        Self::MemoryWrite,
        Self::ReaderRead,
        Self::ReaderWrite,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::BookRead => "book_read",
            Self::BookSearch => "book_search",
            Self::BookQuery => "book_query",
            Self::ArtifactRead => "artifact_read",
            Self::SourcePresentation => "source_presentation",
            Self::Navigation => "navigation",
            Self::ProfileRead => "profile_read",
            Self::ProfileTrace => "profile_trace",
            Self::MemoryRead => "memory_read",
            Self::MemoryWrite => "memory_write",
            Self::ReaderRead => "reader_read",
            Self::ReaderWrite => "reader_write",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCapability {
    Discovery,
    SourceRead,
    LexicalLocate,
    SemanticEvidence,
    StructuralIndex,
    Synthesis,
    NavigationPlan,
    ArtifactRead,
    SourcePresentation,
    ProfileRead,
    ProfileTrace,
    MemoryRead,
    MemoryWrite,
    ReaderRead,
    ReaderWrite,
}

impl ToolCapability {
    pub const ALL: [ToolCapability; 15] = [
        Self::Discovery,
        Self::SourceRead,
        Self::LexicalLocate,
        Self::SemanticEvidence,
        Self::StructuralIndex,
        Self::Synthesis,
        Self::NavigationPlan,
        Self::ArtifactRead,
        Self::SourcePresentation,
        Self::ProfileRead,
        Self::ProfileTrace,
        Self::MemoryRead,
        Self::MemoryWrite,
        Self::ReaderRead,
        Self::ReaderWrite,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::SourceRead => "source_read",
            Self::LexicalLocate => "lexical_locate",
            Self::SemanticEvidence => "semantic_evidence",
            Self::StructuralIndex => "structural_index",
            Self::Synthesis => "synthesis",
            Self::NavigationPlan => "navigation_plan",
            Self::ArtifactRead => "artifact_read",
            Self::SourcePresentation => "source_presentation",
            Self::ProfileRead => "profile_read",
            Self::ProfileTrace => "profile_trace",
            Self::MemoryRead => "memory_read",
            Self::MemoryWrite => "memory_write",
            Self::ReaderRead => "reader_read",
            Self::ReaderWrite => "reader_write",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolScope {
    Selection,
    Passage,
    Section,
    Document,
    Corpus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOperation {
    LocateLiteral,
    ReadSource,
    Explain,
    Compare,
    Summarize,
    Navigate,
    MutateReader,
}

pub const TOOL_SEARCH_MAX_RESULTS: usize = 6;
pub const TOOL_SEARCH_MAX_TASK_CHARS: usize = 512;

pub fn tool_search_input_schema_v2() -> Value {
    let capabilities = ToolCapability::ALL
        .iter()
        .map(|capability| Value::String(capability.as_str().into()))
        .collect::<Vec<_>>();
    json!({
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "minLength": 1,
                "maxLength": TOOL_SEARCH_MAX_TASK_CHARS,
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
            "max_results": {
                "type": "integer",
                "minimum": 1,
                "maximum": TOOL_SEARCH_MAX_RESULTS
            }
        },
        "required": [
            "task", "required_capabilities", "scope", "operation", "effect_mode",
            "max_results"
        ],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    ReadOnly,
    ToolActivation,
    ProfileUsageTrace,
    MemoryWrite,
    ReaderWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPrecondition {
    BookAvailable,
    LocatedLid,
    DeferredCapabilityAvailable,
    ActiveArtifactOverlay,
    ArtifactSearchHit,
    ObservedTurnEvidence,
    SourcePresentationPermission,
    PaperContentProfile,
    ProfileReadPermission,
    ProfileSnapshotAvailable,
    MemoryReadPermission,
    MemoryWritePermission,
    ReaderReadPermission,
    ReaderWritePermission,
    ExplicitReaderMutationIntent,
    CurrentReaderState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCost {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolRoutingCard {
    pub version: &'static str,
    pub name: String,
    pub description: String,
    pub provides: Vec<ToolCapability>,
    pub scopes: Vec<ToolScope>,
    pub operations: Vec<ToolOperation>,
    pub use_when: Vec<String>,
    pub avoid_when: Vec<String>,
    pub effects: ToolEffect,
    pub preconditions: Vec<ToolPrecondition>,
    pub content_profiles: Vec<ContentProfileId>,
    pub relative_cost: ToolCost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolValidatorId {
    BookContract(BookToolId),
    ArtifactContract(ArtifactToolId),
    SourcePresentation,
    ProfileUsage,
    JsonSchema,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolResultPolicy {
    ToolDiscovery,
    QueryResponse,
    EvidenceProjection,
    ArtifactProjection,
    SourceReference,
    NavigationProjection,
    ProfileProjection,
    ProfileUsageReceipt,
    MemoryReceipt,
    MemoryProjection,
    ReaderEffect,
    ReaderState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolOutputPolicy {
    pub result_policy: ToolResultPolicy,
    pub max_model_body_bytes: usize,
}

impl ToolOutputPolicy {
    fn for_result(result_policy: ToolResultPolicy) -> Self {
        let max_model_body_bytes = match result_policy {
            ToolResultPolicy::QueryResponse | ToolResultPolicy::EvidenceProjection => 16 * 1024,
            ToolResultPolicy::ArtifactProjection => 12 * 1024,
            ToolResultPolicy::ProfileProjection => 12 * 1024,
            ToolResultPolicy::NavigationProjection
            | ToolResultPolicy::MemoryProjection
            | ToolResultPolicy::ReaderState => 8 * 1024,
            ToolResultPolicy::ToolDiscovery
            | ToolResultPolicy::SourceReference
            | ToolResultPolicy::ProfileUsageReceipt
            | ToolResultPolicy::MemoryReceipt
            | ToolResultPolicy::ReaderEffect => 4 * 1024,
        };
        Self {
            result_policy,
            max_model_body_bytes,
        }
    }

    pub(crate) fn bounded_error() -> Self {
        Self {
            result_policy: ToolResultPolicy::ProfileUsageReceipt,
            max_model_body_bytes: 4 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolParallelism {
    SequentialOnly,
    ReadOnlyEligible,
}

#[derive(Debug, Clone)]
pub struct ToolRegistration {
    pub spec: ToolSpec,
    pub handler: ToolHandlerId,
    pub validator: ToolValidatorId,
    /// Frozen legacy ordering used only by the `tool.search.v1` compatibility surface.
    pub capabilities: Vec<LegacyToolCapability>,
    pub routing_card: ToolRoutingCard,
    pub output_policy: ToolOutputPolicy,
    pub parallelism: ToolParallelism,
}

impl ToolRegistration {
    pub fn validate_arguments(&self, arguments: &str) -> Result<(), ToolArgumentError> {
        let value: Value = serde_json::from_str(arguments).map_err(|error| ToolArgumentError {
            message: format!("tool arguments are not valid JSON: {error}"),
        })?;
        match self.validator {
            ToolValidatorId::BookContract(id) => {
                validate_input(id, value).map_err(|error| ToolArgumentError {
                    message: error.message,
                })?;
            }
            ToolValidatorId::ArtifactContract(id) => {
                let result = match id {
                    ArtifactToolId::List => validate_artifact_list_input(value).map(|_| ()),
                    ArtifactToolId::Search => validate_artifact_search_input(value).map(|_| ()),
                    ArtifactToolId::Read => validate_artifact_read_input(value).map(|_| ()),
                };
                result.map_err(|error| ToolArgumentError {
                    message: error.message,
                })?;
            }
            ToolValidatorId::SourcePresentation
            | ToolValidatorId::ProfileUsage
            | ToolValidatorId::JsonSchema => {
                validate_schema(&self.spec.parameters, &value, "$")?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ToolRegistry {
    registrations: Vec<ToolRegistration>,
    by_name: HashMap<String, usize>,
}

impl ToolRegistry {
    pub fn try_new(specs: Vec<ToolSpec>) -> Result<Self, ToolRegistryError> {
        let mut registrations = Vec::with_capacity(specs.len());
        let mut by_name = HashMap::with_capacity(specs.len());
        let mut handlers = HashSet::with_capacity(specs.len());

        for spec in specs {
            let name = spec.name.clone();
            if by_name.contains_key(&name) {
                return Err(ToolRegistryError::new(format!(
                    "duplicate model-visible tool name: {name}"
                )));
            }
            let handler = ToolHandlerId::from_name(&name).ok_or_else(|| {
                ToolRegistryError::new(format!("model-visible tool has no handler: {name}"))
            })?;
            if handler.canonical_name() != name {
                return Err(ToolRegistryError::new(format!(
                    "tool alias drift: {name} is registered for {}",
                    handler.canonical_name()
                )));
            }
            if !handlers.insert(handler) {
                return Err(ToolRegistryError::new(format!(
                    "handler is registered more than once: {handler:?}"
                )));
            }
            if spec.description.trim().is_empty() {
                return Err(ToolRegistryError::new(format!(
                    "tool has no description: {name}"
                )));
            }
            if !spec.parameters.is_object() {
                return Err(ToolRegistryError::new(format!(
                    "tool parameters are not an object schema: {name}"
                )));
            }
            if let ToolHandlerId::Book(id) = handler {
                if spec.description != contract_for(id).description {
                    return Err(ToolRegistryError::new(format!(
                        "Book tool description drift: {name}"
                    )));
                }
                if spec.parameters != input_schema(id) {
                    return Err(ToolRegistryError::new(format!(
                        "Book tool schema drift: {name}"
                    )));
                }
            }
            if let ToolHandlerId::Artifact(id) = handler {
                let expected = match id {
                    ArtifactToolId::List => artifact_list_input_schema(),
                    ArtifactToolId::Search => artifact_search_input_schema(),
                    ArtifactToolId::Read => artifact_read_input_schema(),
                };
                if spec.parameters != expected {
                    return Err(ToolRegistryError::new(format!(
                        "artifact tool schema drift: {name}"
                    )));
                }
            }
            if handler == ToolHandlerId::ToolSearch
                && spec.parameters != tool_search_input_schema_v2()
            {
                return Err(ToolRegistryError::new("tool.search v2 schema drift".into()));
            }

            let registration = registration_for(spec, handler);
            validate_routing_card(&registration)?;
            by_name.insert(name, registrations.len());
            registrations.push(registration);
        }

        for handler in ToolHandlerId::ALL {
            if !handlers.contains(&handler) {
                return Err(ToolRegistryError::new(format!(
                    "callable handler has no model-visible registration: {handler:?}"
                )));
            }
        }
        if registrations.len() != ToolHandlerId::ALL.len() {
            return Err(ToolRegistryError::new(format!(
                "registry has {} entries; expected {}",
                registrations.len(),
                ToolHandlerId::ALL.len()
            )));
        }

        Ok(Self {
            registrations,
            by_name,
        })
    }

    pub fn registration(&self, name: &str) -> Option<&ToolRegistration> {
        self.by_name
            .get(name)
            .and_then(|index| self.registrations.get(*index))
    }

    pub fn registrations(&self) -> &[ToolRegistration] {
        &self.registrations
    }

    pub fn routing_card(&self, name: &str) -> Option<&ToolRoutingCard> {
        self.registration(name)
            .map(|registration| &registration.routing_card)
    }

    pub fn visible_specs(&self) -> Vec<ToolSpec> {
        self.registrations
            .iter()
            .map(|registration| registration.spec.clone())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRegistryError {
    pub message: String,
}

impl ToolRegistryError {
    fn new(message: String) -> Self {
        Self { message }
    }
}

impl fmt::Display for ToolRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolRegistryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolArgumentError {
    pub message: String,
}

impl fmt::Display for ToolArgumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ToolArgumentError {}

fn registration_for(spec: ToolSpec, handler: ToolHandlerId) -> ToolRegistration {
    use ToolHandlerId as Handler;
    use ToolParallelism as Parallelism;
    use ToolResultPolicy as ResultPolicy;

    let (validator, result_policy, parallelism) = match handler {
        Handler::Book(id) => {
            let (result_policy, parallelism) = match id {
                BookToolId::Query => (ResultPolicy::QueryResponse, Parallelism::SequentialOnly),
                BookToolId::SearchText => (
                    ResultPolicy::EvidenceProjection,
                    Parallelism::ReadOnlyEligible,
                ),
                BookToolId::Structure | BookToolId::GuidePath | BookToolId::PaperReadingGuide => (
                    ResultPolicy::NavigationProjection,
                    Parallelism::ReadOnlyEligible,
                ),
                BookToolId::Synthesize => {
                    (ResultPolicy::QueryResponse, Parallelism::SequentialOnly)
                }
                _ => (
                    ResultPolicy::EvidenceProjection,
                    Parallelism::ReadOnlyEligible,
                ),
            };
            (
                ToolValidatorId::BookContract(id),
                result_policy,
                parallelism,
            )
        }
        Handler::Artifact(id) => (
            ToolValidatorId::ArtifactContract(id),
            ResultPolicy::ArtifactProjection,
            Parallelism::SequentialOnly,
        ),
        Handler::ToolSearch => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::ToolDiscovery,
            Parallelism::SequentialOnly,
        ),
        Handler::SourcePresent => (
            ToolValidatorId::SourcePresentation,
            ResultPolicy::SourceReference,
            Parallelism::SequentialOnly,
        ),
        Handler::ProfileManifest => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::ProfileProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::ProfileMarkUsed => (
            ToolValidatorId::ProfileUsage,
            ResultPolicy::ProfileUsageReceipt,
            Parallelism::SequentialOnly,
        ),
        Handler::BookRouteFrom
        | Handler::BookGuidedRouteFrom
        | Handler::BookUnvisitedBack
        | Handler::BookRouteTo => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::NavigationProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::MemorySave => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::MemoryReceipt,
            Parallelism::SequentialOnly,
        ),
        Handler::MemoryRecall => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::MemoryProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::ReaderState => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::ReaderState,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::ReaderGotoLid
        | Handler::ReaderScroll
        | Handler::ReaderHighlight
        | Handler::ReaderNote
        | Handler::ReaderLayoutApply
        | Handler::ReaderPaperMinimapApply => (
            ToolValidatorId::JsonSchema,
            ResultPolicy::ReaderEffect,
            Parallelism::SequentialOnly,
        ),
    };

    let migration = capability_migration(handler);
    let routing_card = routing_card_for(&spec, handler, &migration.precise);
    ToolRegistration {
        spec,
        handler,
        validator,
        capabilities: migration.legacy,
        routing_card,
        output_policy: ToolOutputPolicy::for_result(result_policy),
        parallelism,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CapabilityMigration {
    legacy: Vec<LegacyToolCapability>,
    precise: Vec<ToolCapability>,
}

fn capability_migration(handler: ToolHandlerId) -> CapabilityMigration {
    use LegacyToolCapability as Legacy;
    use ToolCapability as Capability;
    use ToolHandlerId as Handler;

    let migration = |legacy, precise| CapabilityMigration { legacy, precise };

    match handler {
        Handler::Book(id) => match id {
            BookToolId::Query => migration(
                vec![Legacy::BookQuery],
                vec![Capability::SemanticEvidence, Capability::Synthesis],
            ),
            BookToolId::Synthesize => migration(
                vec![Legacy::BookRead, Legacy::BookQuery],
                vec![Capability::SourceRead, Capability::Synthesis],
            ),
            BookToolId::SearchText => {
                migration(vec![Legacy::BookSearch], vec![Capability::LexicalLocate])
            }
            BookToolId::Text => migration(vec![Legacy::BookRead], vec![Capability::SourceRead]),
            BookToolId::Context | BookToolId::Concept => {
                migration(vec![Legacy::BookRead], vec![Capability::SemanticEvidence])
            }
            BookToolId::Structure => migration(
                vec![Legacy::BookRead, Legacy::Navigation],
                vec![Capability::StructuralIndex],
            ),
            BookToolId::GuidePath => migration(
                vec![Legacy::BookRead, Legacy::Navigation],
                vec![Capability::NavigationPlan],
            ),
            BookToolId::PaperReadingGuide => migration(
                vec![Legacy::BookRead, Legacy::Navigation],
                vec![
                    Capability::StructuralIndex,
                    Capability::Synthesis,
                    Capability::NavigationPlan,
                ],
            ),
            BookToolId::PaperMetadata => migration(
                vec![Legacy::BookRead],
                vec![Capability::SourceRead, Capability::SemanticEvidence],
            ),
            BookToolId::PaperLexicon => migration(
                vec![Legacy::BookRead],
                vec![Capability::LexicalLocate, Capability::SemanticEvidence],
            ),
            BookToolId::Manifest => migration(
                vec![Legacy::BookRead],
                vec![Capability::SourceRead, Capability::StructuralIndex],
            ),
            BookToolId::Guide => {
                migration(vec![Legacy::BookRead], vec![Capability::NavigationPlan])
            }
        },
        Handler::Artifact(_) => {
            migration(vec![Legacy::ArtifactRead], vec![Capability::ArtifactRead])
        }
        Handler::ToolSearch => migration(vec![Legacy::Discovery], vec![Capability::Discovery]),
        Handler::SourcePresent => migration(
            vec![Legacy::SourcePresentation],
            vec![Capability::SourcePresentation],
        ),
        Handler::ProfileManifest => {
            migration(vec![Legacy::ProfileRead], vec![Capability::ProfileRead])
        }
        Handler::ProfileMarkUsed => {
            migration(vec![Legacy::ProfileTrace], vec![Capability::ProfileTrace])
        }
        Handler::BookRouteFrom
        | Handler::BookGuidedRouteFrom
        | Handler::BookUnvisitedBack
        | Handler::BookRouteTo => migration(
            vec![Legacy::BookRead, Legacy::Navigation],
            vec![Capability::NavigationPlan],
        ),
        Handler::MemorySave => migration(vec![Legacy::MemoryWrite], vec![Capability::MemoryWrite]),
        Handler::MemoryRecall => migration(vec![Legacy::MemoryRead], vec![Capability::MemoryRead]),
        Handler::ReaderState => migration(vec![Legacy::ReaderRead], vec![Capability::ReaderRead]),
        Handler::ReaderGotoLid
        | Handler::ReaderScroll
        | Handler::ReaderHighlight
        | Handler::ReaderNote
        | Handler::ReaderLayoutApply
        | Handler::ReaderPaperMinimapApply => {
            migration(vec![Legacy::ReaderWrite], vec![Capability::ReaderWrite])
        }
    }
}

#[derive(Debug)]
struct RoutingShape {
    scopes: Vec<ToolScope>,
    operations: Vec<ToolOperation>,
    effects: ToolEffect,
    preconditions: Vec<ToolPrecondition>,
    content_profiles: Vec<ContentProfileId>,
    relative_cost: ToolCost,
}

fn routing_card_for(
    spec: &ToolSpec,
    handler: ToolHandlerId,
    capabilities: &[ToolCapability],
) -> ToolRoutingCard {
    let shape = routing_shape(handler);
    let (use_when, avoid_when) = match handler {
        ToolHandlerId::Book(id) => {
            let contract = contract_for(id);
            (contract.use_when, contract.do_not_use_when)
        }
        _ => non_book_routing_guidance(handler),
    };

    ToolRoutingCard {
        version: TOOL_ROUTING_CARD_VERSION,
        name: spec.name.clone(),
        description: spec.description.clone(),
        provides: capabilities.to_vec(),
        scopes: shape.scopes,
        operations: shape.operations,
        use_when: vec![use_when.to_string()],
        avoid_when: vec![avoid_when.to_string()],
        effects: shape.effects,
        preconditions: shape.preconditions,
        content_profiles: shape.content_profiles,
        relative_cost: shape.relative_cost,
    }
}

fn routing_shape(handler: ToolHandlerId) -> RoutingShape {
    use ToolCost as Cost;
    use ToolEffect as Effect;
    use ToolHandlerId as Handler;
    use ToolOperation as Operation;
    use ToolPrecondition as Precondition;
    use ToolScope as Scope;

    let all_profiles = || vec![ContentProfileId::TechnicalLearning, ContentProfileId::Paper];
    let paper_profile = || vec![ContentProfileId::Paper];
    let shape = |scopes, operations, effects, preconditions, content_profiles, relative_cost| {
        RoutingShape {
            scopes,
            operations,
            effects,
            preconditions,
            content_profiles,
            relative_cost,
        }
    };

    match handler {
        Handler::Book(id) => match id {
            BookToolId::Query => shape(
                vec![Scope::Passage, Scope::Section, Scope::Document],
                vec![Operation::Explain, Operation::Compare],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::High,
            ),
            BookToolId::Synthesize => shape(
                vec![Scope::Passage, Scope::Section, Scope::Document],
                vec![Operation::Explain, Operation::Compare, Operation::Summarize],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable, Precondition::LocatedLid],
                all_profiles(),
                Cost::High,
            ),
            BookToolId::SearchText => shape(
                vec![
                    Scope::Selection,
                    Scope::Passage,
                    Scope::Section,
                    Scope::Document,
                    Scope::Corpus,
                ],
                vec![Operation::LocateLiteral],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::Low,
            ),
            BookToolId::Text => shape(
                vec![Scope::Selection, Scope::Passage, Scope::Section],
                vec![Operation::ReadSource],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable, Precondition::LocatedLid],
                all_profiles(),
                Cost::Low,
            ),
            BookToolId::Context => shape(
                vec![Scope::Passage, Scope::Section, Scope::Document],
                vec![Operation::Navigate],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable, Precondition::LocatedLid],
                all_profiles(),
                Cost::Low,
            ),
            BookToolId::Concept => shape(
                vec![
                    Scope::Passage,
                    Scope::Section,
                    Scope::Document,
                    Scope::Corpus,
                ],
                vec![Operation::Explain, Operation::Compare, Operation::Navigate],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::Medium,
            ),
            BookToolId::Structure => shape(
                vec![Scope::Section, Scope::Document],
                vec![Operation::Summarize, Operation::Navigate],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::Low,
            ),
            BookToolId::GuidePath => shape(
                vec![Scope::Section, Scope::Document],
                vec![Operation::Navigate],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::Low,
            ),
            BookToolId::PaperReadingGuide => shape(
                vec![Scope::Document],
                vec![Operation::Summarize, Operation::Navigate],
                Effect::ReadOnly,
                vec![
                    Precondition::BookAvailable,
                    Precondition::PaperContentProfile,
                ],
                paper_profile(),
                Cost::Medium,
            ),
            BookToolId::PaperMetadata => shape(
                vec![Scope::Document],
                vec![Operation::ReadSource],
                Effect::ReadOnly,
                vec![
                    Precondition::BookAvailable,
                    Precondition::PaperContentProfile,
                ],
                paper_profile(),
                Cost::Low,
            ),
            BookToolId::PaperLexicon => shape(
                vec![Scope::Document, Scope::Corpus],
                vec![Operation::LocateLiteral, Operation::Explain],
                Effect::ReadOnly,
                vec![
                    Precondition::BookAvailable,
                    Precondition::PaperContentProfile,
                ],
                paper_profile(),
                Cost::Low,
            ),
            BookToolId::Manifest | BookToolId::Guide => shape(
                vec![Scope::Document],
                vec![Operation::ReadSource],
                Effect::ReadOnly,
                vec![Precondition::BookAvailable],
                all_profiles(),
                Cost::Low,
            ),
        },
        Handler::ToolSearch => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::LocateLiteral,
                Operation::ReadSource,
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
                Operation::Navigate,
                Operation::MutateReader,
            ],
            Effect::ToolActivation,
            vec![Precondition::DeferredCapabilityAvailable],
            all_profiles(),
            Cost::Low,
        ),
        Handler::Artifact(ArtifactToolId::List) => shape(
            vec![Scope::Document, Scope::Corpus],
            vec![Operation::Summarize],
            Effect::ReadOnly,
            vec![Precondition::ActiveArtifactOverlay],
            all_profiles(),
            Cost::Low,
        ),
        Handler::Artifact(ArtifactToolId::Search) => shape(
            vec![
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::LocateLiteral,
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
            ],
            Effect::ReadOnly,
            vec![Precondition::ActiveArtifactOverlay],
            all_profiles(),
            Cost::Low,
        ),
        Handler::Artifact(ArtifactToolId::Read) => shape(
            vec![Scope::Passage, Scope::Section, Scope::Document],
            vec![Operation::Explain, Operation::Compare, Operation::Summarize],
            Effect::ReadOnly,
            vec![
                Precondition::ActiveArtifactOverlay,
                Precondition::ArtifactSearchHit,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::SourcePresent => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
            ],
            vec![Operation::ReadSource],
            Effect::ReadOnly,
            vec![
                Precondition::ObservedTurnEvidence,
                Precondition::SourcePresentationPermission,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ProfileManifest => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::ReadSource,
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
                Operation::Navigate,
            ],
            Effect::ReadOnly,
            vec![Precondition::ProfileReadPermission],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ProfileMarkUsed => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
                Operation::Navigate,
            ],
            Effect::ProfileUsageTrace,
            vec![Precondition::ProfileSnapshotAvailable],
            all_profiles(),
            Cost::Low,
        ),
        Handler::BookRouteFrom | Handler::BookGuidedRouteFrom | Handler::BookRouteTo => shape(
            vec![Scope::Passage, Scope::Section, Scope::Document],
            vec![Operation::Navigate],
            Effect::ReadOnly,
            vec![Precondition::BookAvailable, Precondition::LocatedLid],
            all_profiles(),
            Cost::Low,
        ),
        Handler::BookUnvisitedBack => shape(
            vec![Scope::Passage, Scope::Section],
            vec![Operation::Navigate],
            Effect::ReadOnly,
            vec![
                Precondition::BookAvailable,
                Precondition::LocatedLid,
                Precondition::CurrentReaderState,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::MemorySave => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
                Operation::Navigate,
            ],
            Effect::MemoryWrite,
            vec![
                Precondition::MemoryWritePermission,
                Precondition::LocatedLid,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::MemoryRecall => shape(
            vec![
                Scope::Selection,
                Scope::Passage,
                Scope::Section,
                Scope::Document,
                Scope::Corpus,
            ],
            vec![
                Operation::Explain,
                Operation::Compare,
                Operation::Summarize,
                Operation::Navigate,
            ],
            Effect::ReadOnly,
            vec![Precondition::MemoryReadPermission],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderState => shape(
            vec![Scope::Passage, Scope::Section, Scope::Document],
            vec![Operation::Navigate],
            Effect::ReadOnly,
            vec![Precondition::ReaderReadPermission],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderGotoLid => shape(
            vec![Scope::Passage, Scope::Section, Scope::Document],
            vec![Operation::Navigate, Operation::MutateReader],
            Effect::ReaderWrite,
            vec![
                Precondition::ReaderWritePermission,
                Precondition::ExplicitReaderMutationIntent,
                Precondition::LocatedLid,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderScroll => shape(
            vec![Scope::Passage, Scope::Section, Scope::Document],
            vec![Operation::Navigate, Operation::MutateReader],
            Effect::ReaderWrite,
            vec![
                Precondition::ReaderWritePermission,
                Precondition::ExplicitReaderMutationIntent,
                Precondition::CurrentReaderState,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderHighlight | Handler::ReaderNote => shape(
            vec![Scope::Selection, Scope::Passage],
            vec![Operation::MutateReader],
            Effect::ReaderWrite,
            vec![
                Precondition::ReaderWritePermission,
                Precondition::ExplicitReaderMutationIntent,
                Precondition::LocatedLid,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderLayoutApply => shape(
            vec![Scope::Document],
            vec![Operation::MutateReader],
            Effect::ReaderWrite,
            vec![
                Precondition::ReaderWritePermission,
                Precondition::ExplicitReaderMutationIntent,
                Precondition::CurrentReaderState,
            ],
            all_profiles(),
            Cost::Low,
        ),
        Handler::ReaderPaperMinimapApply => shape(
            vec![Scope::Document],
            vec![Operation::Navigate, Operation::MutateReader],
            Effect::ReaderWrite,
            vec![
                Precondition::ReaderWritePermission,
                Precondition::ExplicitReaderMutationIntent,
                Precondition::CurrentReaderState,
                Precondition::PaperContentProfile,
            ],
            all_profiles(),
            Cost::Low,
        ),
    }
}

fn non_book_routing_guidance(handler: ToolHandlerId) -> (&'static str, &'static str) {
    use ToolHandlerId as Handler;

    match handler {
        Handler::ToolSearch => (
            "Discover a deferred Resident capability that is absent from the current sampled tool surface.",
            "Do not use when visible tools can complete the task or to execute a matched tool in the same sampling.",
        ),
        Handler::Artifact(ArtifactToolId::List) => (
            "Inspect bounded routing metadata for the active accepted artifact overlay.",
            "Do not treat Routing Cards as book evidence or call without an active overlay.",
        ),
        Handler::Artifact(ArtifactToolId::Search) => (
            "Search a relevant active accepted artifact after its Routing Card matches the task.",
            "Do not retry rewritten guesses after zero hits or use artifact data as canonical book evidence.",
        ),
        Handler::Artifact(ArtifactToolId::Read) => (
            "Read bounded artifact records returned by artifact.search or its continuation.",
            "Do not invent opaque refs or treat artifact records as canonical book evidence.",
        ),
        Handler::SourcePresent => (
            "Present an opaque user-visible source reference for evidence already observed in this turn.",
            "Do not present an unobserved LID or use source presentation as evidence retrieval.",
        ),
        Handler::ProfileManifest => (
            "Read profile slots, presets, projections, or tool policy needed for the current task.",
            "Do not read a profile manifest when the frozen profile snapshot is already sufficient.",
        ),
        Handler::ProfileMarkUsed => (
            "Trace profile facts that actually changed the current retrieval or answer.",
            "Do not claim use of facts absent from the frozen profile snapshot.",
        ),
        Handler::BookRouteFrom => (
            "Inspect deterministic navigation choices from a verified LID.",
            "Do not use navigation edges as source evidence.",
        ),
        Handler::BookGuidedRouteFrom => (
            "Inspect a teaching-ordered navigation frontier from a verified LID.",
            "Do not use outside guided reading or treat navigation edges as source evidence.",
        ),
        Handler::BookUnvisitedBack => (
            "Find unread prerequisites for an unspecific statement of non-understanding.",
            "Do not call when the user named a specific locus, example, relation, or prerequisite.",
        ),
        Handler::BookRouteTo => (
            "Find a deterministic route between two already resolved LIDs.",
            "Do not use unresolved targets or treat the route as source evidence.",
        ),
        Handler::MemorySave => (
            "Save user-requested or genuinely reusable reader context with an honest source anchor.",
            "Do not write routine question history or present an inference as a user fact.",
        ),
        Handler::MemoryRecall => (
            "Recall reader memory that is relevant to the current book task.",
            "Do not treat memory as canonical book evidence.",
        ),
        Handler::ReaderGotoLid => (
            "Perform an explicitly requested or explicitly authorized Reader jump to a verified LID.",
            "Do not mutate the Reader for a read-only request or jump to an unverified LID.",
        ),
        Handler::ReaderScroll => (
            "Perform an explicitly requested Reader scroll from current state.",
            "Do not mutate the Reader for a read-only request.",
        ),
        Handler::ReaderHighlight => (
            "Highlight a verified LID when the user explicitly requests it.",
            "Do not create a highlight without explicit Reader-mutation intent.",
        ),
        Handler::ReaderNote => (
            "Attach a user-requested note to a verified LID.",
            "Do not create a note without explicit Reader-mutation intent.",
        ),
        Handler::ReaderLayoutApply => (
            "Apply an explicitly requested typed Reader layout action through the reducer.",
            "Do not bypass proposals or mutate layout for a read-only request.",
        ),
        Handler::ReaderPaperMinimapApply => (
            "Apply an explicitly requested paper-minimap command allowed by current agent context.",
            "Do not invent minimap evidence, bypass proposals, or mutate a non-paper Reader.",
        ),
        Handler::ReaderState => (
            "Read current Reader state for resynchronization or an authorized navigation flow.",
            "Do not use Reader state as source evidence.",
        ),
        Handler::Book(_) => unreachable!("Book tools consume BookToolContract routing guidance"),
    }
}

fn validate_routing_card(registration: &ToolRegistration) -> Result<(), ToolRegistryError> {
    let card = &registration.routing_card;
    let name = registration.spec.name.as_str();

    if card.version != TOOL_ROUTING_CARD_VERSION {
        return Err(ToolRegistryError::new(format!(
            "routing card version drift for {name}: {}",
            card.version
        )));
    }
    if card.name != registration.spec.name {
        return Err(ToolRegistryError::new(format!(
            "routing card name drift for {name}: {}",
            card.name
        )));
    }
    if card.description.trim().is_empty() {
        return Err(ToolRegistryError::new(format!(
            "routing card description is empty: {name}"
        )));
    }
    if card.description != registration.spec.description {
        return Err(ToolRegistryError::new(format!(
            "routing card description drift: {name}"
        )));
    }
    for (field, is_empty) in [
        ("provides", card.provides.is_empty()),
        ("scopes", card.scopes.is_empty()),
        ("operations", card.operations.is_empty()),
        ("use_when", card.use_when.is_empty()),
        ("avoid_when", card.avoid_when.is_empty()),
        ("preconditions", card.preconditions.is_empty()),
        ("content_profiles", card.content_profiles.is_empty()),
    ] {
        if is_empty {
            return Err(ToolRegistryError::new(format!(
                "routing card {field} is empty: {name}"
            )));
        }
    }
    for (field, values) in [
        ("use_when", card.use_when.as_slice()),
        ("avoid_when", card.avoid_when.as_slice()),
    ] {
        if values.iter().any(|value| value.trim().is_empty()) {
            return Err(ToolRegistryError::new(format!(
                "routing card {field} contains an empty entry: {name}"
            )));
        }
    }
    let migration = capability_migration(registration.handler);
    if registration.capabilities.as_slice() != migration.legacy.as_slice()
        || registration
            .capabilities
            .iter()
            .any(|capability| !LegacyToolCapability::ALL.contains(capability))
    {
        return Err(ToolRegistryError::new(format!(
            "legacy capability migration drift: {name}"
        )));
    }
    if card.provides.as_slice() != migration.precise.as_slice()
        || card
            .provides
            .iter()
            .any(|capability| !ToolCapability::ALL.contains(capability))
    {
        return Err(ToolRegistryError::new(format!(
            "precise capability migration drift: {name}"
        )));
    }
    for (field, has_duplicates) in [
        ("provides", has_duplicates(&card.provides)),
        ("scopes", has_duplicates(&card.scopes)),
        ("operations", has_duplicates(&card.operations)),
        ("preconditions", has_duplicates(&card.preconditions)),
        ("content_profiles", has_duplicates(&card.content_profiles)),
    ] {
        if has_duplicates {
            return Err(ToolRegistryError::new(format!(
                "routing card {field} contains duplicates: {name}"
            )));
        }
    }

    if card.provides.contains(&ToolCapability::ReaderWrite) {
        if card.effects != ToolEffect::ReaderWrite {
            return Err(ToolRegistryError::new(format!(
                "ReaderWrite tool has no ReaderWrite effect: {name}"
            )));
        }
        if !card
            .preconditions
            .contains(&ToolPrecondition::ReaderWritePermission)
        {
            return Err(ToolRegistryError::new(format!(
                "ReaderWrite tool has no permission precondition: {name}"
            )));
        }
        if !card
            .preconditions
            .contains(&ToolPrecondition::ExplicitReaderMutationIntent)
        {
            return Err(ToolRegistryError::new(format!(
                "ReaderWrite tool has no explicit mutation precondition: {name}"
            )));
        }
    } else if card.effects == ToolEffect::ReaderWrite {
        return Err(ToolRegistryError::new(format!(
            "non-ReaderWrite tool declares a ReaderWrite effect: {name}"
        )));
    }

    if let ToolHandlerId::Book(id) = registration.handler {
        let contract = contract_for(id);
        if registration.spec.description != contract.description {
            return Err(ToolRegistryError::new(format!(
                "Book contract description drift: {name}"
            )));
        }
        if card.use_when.len() != 1
            || card.use_when[0] != contract.use_when
            || card.avoid_when.len() != 1
            || card.avoid_when[0] != contract.do_not_use_when
        {
            return Err(ToolRegistryError::new(format!(
                "Book contract guidance drift: {name}"
            )));
        }
    }

    Ok(())
}

fn has_duplicates<T: PartialEq>(values: &[T]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(index, value)| values[..index].contains(value))
}

fn validate_schema(schema: &Value, value: &Value, path: &str) -> Result<(), ToolArgumentError> {
    let fail = |message: String| ToolArgumentError { message };
    if let Some(expected) = schema.get("type").and_then(Value::as_str) {
        let valid = match expected {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            _ => true,
        };
        if !valid {
            return Err(fail(format!("{path} must be a JSON {expected}")));
        }
    }

    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(fail(format!("{path} is not an allowed value")));
        }
    }

    if let Some(string) = value.as_str() {
        let length = string.chars().count();
        if let Some(min_length) = schema.get("minLength").and_then(Value::as_u64) {
            if length < min_length as usize {
                return Err(fail(format!(
                    "{path} must contain at least {min_length} characters"
                )));
            }
        }
        if let Some(max_length) = schema.get("maxLength").and_then(Value::as_u64) {
            if length > max_length as usize {
                return Err(fail(format!(
                    "{path} must contain at most {max_length} characters"
                )));
            }
        }
    }

    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for field in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(field) {
                    return Err(fail(format!("{path}.{field} is required")));
                }
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                if let Some(field) = object.keys().find(|field| !properties.contains_key(*field)) {
                    return Err(fail(format!("{path}.{field} is not allowed")));
                }
            }
            for (field, child_schema) in properties {
                if let Some(child) = object.get(field) {
                    validate_schema(child_schema, child, &format!("{path}.{field}"))?;
                }
            }
        }
    }

    if let Some(array) = value.as_array() {
        if let Some(min_items) = schema.get("minItems").and_then(Value::as_u64) {
            if array.len() < min_items as usize {
                return Err(fail(format!(
                    "{path} must contain at least {min_items} items"
                )));
            }
        }
        if let Some(max_items) = schema.get("maxItems").and_then(Value::as_u64) {
            if array.len() > max_items as usize {
                return Err(fail(format!(
                    "{path} must contain at most {max_items} items"
                )));
            }
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (index, item) in array.iter().enumerate() {
                if array[..index].contains(item) {
                    return Err(fail(format!("{path} must contain unique items")));
                }
            }
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in array.iter().enumerate() {
                validate_schema(item_schema, item, &format!("{path}[{index}]"))?;
            }
        }
    }

    if let (Some(minimum), Some(number)) = (
        schema.get("minimum").and_then(Value::as_f64),
        value.as_f64(),
    ) {
        if number < minimum {
            return Err(fail(format!("{path} must be at least {minimum}")));
        }
    }
    if let (Some(maximum), Some(number)) = (
        schema.get("maximum").and_then(Value::as_f64),
        value.as_f64(),
    ) {
        if number > maximum {
            return Err(fail(format!("{path} must be at most {maximum}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::resident_tool_registry;

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: "test".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        }
    }

    #[test]
    fn rejects_unknown_and_duplicate_handlers() {
        let unknown = ToolRegistry::try_new(vec![spec("unknown")]).unwrap_err();
        assert!(unknown.message.contains("no handler"));

        let duplicate =
            ToolRegistry::try_new(vec![spec("reader.state"), spec("reader.state")]).unwrap_err();
        assert!(duplicate.message.contains("duplicate"));
    }

    #[test]
    fn rejects_missing_handlers_and_book_schema_drift() {
        let missing = ToolRegistry::try_new(vec![spec("reader.state")]).unwrap_err();
        assert!(missing
            .message
            .contains("has no model-visible registration"));

        let drift = ToolRegistry::try_new(vec![ToolSpec {
            name: "book.text".into(),
            description: contract_for(BookToolId::Text).description.into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        }])
        .unwrap_err();
        assert!(drift.message.contains("schema drift"));

        let description_drift = ToolRegistry::try_new(vec![ToolSpec {
            name: "book.text".into(),
            description: "drifted description".into(),
            parameters: input_schema(BookToolId::Text),
        }])
        .unwrap_err();
        assert!(description_drift.message.contains("description drift"));
    }

    #[test]
    fn routing_cards_cover_every_handler_and_reuse_book_contract_guidance() {
        let registry = resident_tool_registry();
        assert_eq!(TOOL_ROUTING_CARD_VERSION, "tool_routing_card.v1");
        assert_eq!(registry.registrations().len(), ToolHandlerId::ALL.len());

        for registration in registry.registrations() {
            let card = &registration.routing_card;
            let migration = capability_migration(registration.handler);
            assert_eq!(card.version, TOOL_ROUTING_CARD_VERSION);
            assert_eq!(card.name, registration.spec.name);
            assert_eq!(card.description, registration.spec.description);
            assert_eq!(registration.capabilities, migration.legacy);
            assert_eq!(card.provides, migration.precise);
            assert!(!card.provides.is_empty(), "{} provides", card.name);
            assert!(!card.scopes.is_empty(), "{} scopes", card.name);
            assert!(!card.operations.is_empty(), "{} operations", card.name);
            assert!(!card.use_when.is_empty(), "{} use_when", card.name);
            assert!(!card.avoid_when.is_empty(), "{} avoid_when", card.name);
            assert!(
                !card.preconditions.is_empty(),
                "{} preconditions",
                card.name
            );
            assert!(
                !card.content_profiles.is_empty(),
                "{} content_profiles",
                card.name
            );

            if let ToolHandlerId::Book(id) = registration.handler {
                let contract = contract_for(id);
                assert_eq!(registration.spec.description, contract.description);
                assert_eq!(card.use_when, vec![contract.use_when.to_string()]);
                assert_eq!(card.avoid_when, vec![contract.do_not_use_when.to_string()]);
            }
        }

        let book_text = registry.routing_card("book.text").unwrap();
        let contract = contract_for(BookToolId::Text);
        assert_eq!(book_text.description, contract.description);
        assert_eq!(book_text.use_when, vec![contract.use_when.to_string()]);
        assert_eq!(
            book_text.avoid_when,
            vec![contract.do_not_use_when.to_string()]
        );
    }

    #[test]
    fn precise_capability_migration_maps_every_legacy_registration() {
        let registry = resident_tool_registry();
        let cases: &[(&str, &[&str], &[&str])] = &[
            (
                "book.query",
                &["book_query"],
                &["semantic_evidence", "synthesis"],
            ),
            (
                "book.synthesize",
                &["book_read", "book_query"],
                &["source_read", "synthesis"],
            ),
            ("book.search_text", &["book_search"], &["lexical_locate"]),
            ("book.text", &["book_read"], &["source_read"]),
            ("tool.search", &["discovery"], &["discovery"]),
            ("artifact.list", &["artifact_read"], &["artifact_read"]),
            ("artifact.search", &["artifact_read"], &["artifact_read"]),
            ("artifact.read", &["artifact_read"], &["artifact_read"]),
            (
                "source.present",
                &["source_presentation"],
                &["source_presentation"],
            ),
            ("book.context", &["book_read"], &["semantic_evidence"]),
            ("book.concept", &["book_read"], &["semantic_evidence"]),
            (
                "book.structure",
                &["book_read", "navigation"],
                &["structural_index"],
            ),
            (
                "book.guide_path",
                &["book_read", "navigation"],
                &["navigation_plan"],
            ),
            (
                "book.paper_reading_guide",
                &["book_read", "navigation"],
                &["structural_index", "synthesis", "navigation_plan"],
            ),
            (
                "book.paper_metadata",
                &["book_read"],
                &["source_read", "semantic_evidence"],
            ),
            (
                "book.paper_lexicon",
                &["book_read"],
                &["lexical_locate", "semantic_evidence"],
            ),
            ("profile.manifest", &["profile_read"], &["profile_read"]),
            ("profile.mark_used", &["profile_trace"], &["profile_trace"]),
            (
                "book.route_from",
                &["book_read", "navigation"],
                &["navigation_plan"],
            ),
            (
                "book.guided_route_from",
                &["book_read", "navigation"],
                &["navigation_plan"],
            ),
            (
                "book.unvisited_back",
                &["book_read", "navigation"],
                &["navigation_plan"],
            ),
            (
                "book.route_to",
                &["book_read", "navigation"],
                &["navigation_plan"],
            ),
            ("memory.save", &["memory_write"], &["memory_write"]),
            ("memory.recall", &["memory_read"], &["memory_read"]),
            ("reader.gotoLid", &["reader_write"], &["reader_write"]),
            ("reader.scroll", &["reader_write"], &["reader_write"]),
            ("reader.highlight", &["reader_write"], &["reader_write"]),
            ("reader.note", &["reader_write"], &["reader_write"]),
            ("reader.layout.apply", &["reader_write"], &["reader_write"]),
            (
                "reader.paper_minimap.apply",
                &["reader_write"],
                &["reader_write"],
            ),
            ("reader.state", &["reader_read"], &["reader_read"]),
        ];

        assert_eq!(cases.len(), ToolHandlerId::ALL.len());
        for (name, legacy, precise) in cases {
            let registration = registry.registration(name).unwrap();
            assert_eq!(
                registration
                    .capabilities
                    .iter()
                    .map(|capability| capability.as_str())
                    .collect::<Vec<_>>(),
                *legacy,
                "legacy capability sequence drift for {name}"
            );
            assert_eq!(
                registration
                    .routing_card
                    .provides
                    .iter()
                    .map(|capability| capability.as_str())
                    .collect::<Vec<_>>(),
                *precise,
                "precise capability migration drift for {name}"
            );
        }
    }

    #[test]
    fn routing_card_gate_rejects_empty_unknown_reader_write_and_book_drift() {
        let registry = resident_tool_registry();

        let mut empty = registry.registration("book.text").unwrap().clone();
        empty.routing_card.scopes.clear();
        assert!(validate_routing_card(&empty)
            .unwrap_err()
            .message
            .contains("scopes"));

        let mut unknown = registry.registration("book.text").unwrap().clone();
        unknown
            .routing_card
            .provides
            .push(ToolCapability::ReaderWrite);
        assert!(validate_routing_card(&unknown)
            .unwrap_err()
            .message
            .contains("precise capability migration drift"));

        let mut missing_effect = registry.registration("reader.gotoLid").unwrap().clone();
        missing_effect.routing_card.effects = ToolEffect::ReadOnly;
        assert!(validate_routing_card(&missing_effect)
            .unwrap_err()
            .message
            .contains("ReaderWrite effect"));

        let mut missing_precondition = registry.registration("reader.gotoLid").unwrap().clone();
        missing_precondition
            .routing_card
            .preconditions
            .retain(|precondition| *precondition != ToolPrecondition::ExplicitReaderMutationIntent);
        assert!(validate_routing_card(&missing_precondition)
            .unwrap_err()
            .message
            .contains("explicit mutation precondition"));

        let mut book_drift = registry.registration("book.text").unwrap().clone();
        book_drift.routing_card.use_when = vec!["Drifted guidance".into()];
        assert!(validate_routing_card(&book_drift)
            .unwrap_err()
            .message
            .contains("Book contract guidance drift"));
    }

    #[test]
    fn tool_search_v2_registry_validation_enforces_closed_bounds() {
        let registry = resident_tool_registry();
        let registration = registry.registration("tool.search").unwrap();
        let valid = serde_json::json!({
            "task": "summarize this book",
            "required_capabilities": ["structural_index"],
            "scope": "document",
            "operation": "summarize",
            "effect_mode": "read_only",
            "max_results": 3
        })
        .to_string();
        assert!(registration.validate_arguments(&valid).is_ok());

        for invalid in [
            serde_json::json!({
                "task": "",
                "required_capabilities": ["structural_index"],
                "scope": "document",
                "operation": "summarize",
                "effect_mode": "read_only",
                "max_results": 3
            }),
            serde_json::json!({
                "task": "summarize this book",
                "required_capabilities": ["structural_index", "structural_index"],
                "scope": "document",
                "operation": "summarize",
                "effect_mode": "read_only",
                "max_results": 3
            }),
            serde_json::json!({
                "task": "summarize this book",
                "required_capabilities": ["structural_index"],
                "scope": "document",
                "operation": "summarize",
                "effect_mode": "read_only",
                "max_results": 7
            }),
            serde_json::json!({
                "task": "summarize this book",
                "required_capabilities": ["structural_index"],
                "scope": "document",
                "operation": "summarize",
                "effect_mode": "read_only",
                "max_results": 3,
                "extra": true
            }),
        ] {
            assert!(
                registration
                    .validate_arguments(&invalid.to_string())
                    .is_err(),
                "unexpectedly accepted {invalid}"
            );
        }
    }

    #[test]
    fn json_schema_validator_checks_required_types_and_unknown_fields() {
        let registration = ToolRegistration {
            spec: ToolSpec {
                name: "test".into(),
                description: "test".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {"count": {"type": "integer", "minimum": 0}},
                    "required": ["count"]
                }),
            },
            handler: ToolHandlerId::ReaderState,
            validator: ToolValidatorId::JsonSchema,
            capabilities: vec![LegacyToolCapability::ReaderRead],
            routing_card: ToolRoutingCard {
                version: TOOL_ROUTING_CARD_VERSION,
                name: "test".into(),
                description: "test".into(),
                provides: vec![ToolCapability::ReaderRead],
                scopes: vec![ToolScope::Passage],
                operations: vec![ToolOperation::Navigate],
                use_when: vec!["Read test state".into()],
                avoid_when: vec!["Do not mutate test state".into()],
                effects: ToolEffect::ReadOnly,
                preconditions: vec![ToolPrecondition::ReaderReadPermission],
                content_profiles: vec![ContentProfileId::TechnicalLearning],
                relative_cost: ToolCost::Low,
            },
            output_policy: ToolOutputPolicy::for_result(ToolResultPolicy::ReaderState),
            parallelism: ToolParallelism::ReadOnlyEligible,
        };
        assert!(registration.validate_arguments(r#"{"count": 1}"#).is_ok());
        assert!(registration.validate_arguments(r#"{"count": -1}"#).is_err());
        assert!(registration.validate_arguments(r#"{"other": 1}"#).is_err());
    }
}
