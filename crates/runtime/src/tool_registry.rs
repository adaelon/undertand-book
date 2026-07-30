use crate::ToolSpec;
use artifact_tools::{
    aliases as artifact_aliases, artifact_list_input_schema, artifact_read_input_schema,
    artifact_search_input_schema, validate_artifact_list_input, validate_artifact_read_input,
    validate_artifact_search_input, ArtifactToolId,
};
use book_tool_contracts::{
    contract_for, from_resident_alias, input_schema, validate_input, BookToolId,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolCapability {
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

impl ToolCapability {
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
    pub capabilities: Vec<ToolCapability>,
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

            let registration = registration_for(spec, handler);
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
    use ToolCapability as Capability;
    use ToolHandlerId as Handler;
    use ToolParallelism as Parallelism;
    use ToolResultPolicy as ResultPolicy;

    let (validator, capabilities, result_policy, parallelism) = match handler {
        Handler::Book(id) => {
            let (capabilities, result_policy, parallelism) = match id {
                BookToolId::Query => (
                    vec![Capability::BookQuery],
                    ResultPolicy::QueryResponse,
                    Parallelism::SequentialOnly,
                ),
                BookToolId::SearchText => (
                    vec![Capability::BookSearch],
                    ResultPolicy::EvidenceProjection,
                    Parallelism::ReadOnlyEligible,
                ),
                BookToolId::Structure | BookToolId::GuidePath | BookToolId::PaperReadingGuide => (
                    vec![Capability::BookRead, Capability::Navigation],
                    ResultPolicy::NavigationProjection,
                    Parallelism::ReadOnlyEligible,
                ),
                BookToolId::Synthesize => (
                    vec![Capability::BookRead, Capability::BookQuery],
                    ResultPolicy::QueryResponse,
                    Parallelism::SequentialOnly,
                ),
                _ => (
                    vec![Capability::BookRead],
                    ResultPolicy::EvidenceProjection,
                    Parallelism::ReadOnlyEligible,
                ),
            };
            (
                ToolValidatorId::BookContract(id),
                capabilities,
                result_policy,
                parallelism,
            )
        }
        Handler::Artifact(id) => (
            ToolValidatorId::ArtifactContract(id),
            vec![Capability::ArtifactRead],
            ResultPolicy::ArtifactProjection,
            Parallelism::SequentialOnly,
        ),
        Handler::ToolSearch => (
            ToolValidatorId::JsonSchema,
            vec![Capability::Discovery],
            ResultPolicy::ToolDiscovery,
            Parallelism::SequentialOnly,
        ),
        Handler::SourcePresent => (
            ToolValidatorId::SourcePresentation,
            vec![Capability::SourcePresentation],
            ResultPolicy::SourceReference,
            Parallelism::SequentialOnly,
        ),
        Handler::ProfileManifest => (
            ToolValidatorId::JsonSchema,
            vec![Capability::ProfileRead],
            ResultPolicy::ProfileProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::ProfileMarkUsed => (
            ToolValidatorId::ProfileUsage,
            vec![Capability::ProfileTrace],
            ResultPolicy::ProfileUsageReceipt,
            Parallelism::SequentialOnly,
        ),
        Handler::BookRouteFrom
        | Handler::BookGuidedRouteFrom
        | Handler::BookUnvisitedBack
        | Handler::BookRouteTo => (
            ToolValidatorId::JsonSchema,
            vec![Capability::BookRead, Capability::Navigation],
            ResultPolicy::NavigationProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::MemorySave => (
            ToolValidatorId::JsonSchema,
            vec![Capability::MemoryWrite],
            ResultPolicy::MemoryReceipt,
            Parallelism::SequentialOnly,
        ),
        Handler::MemoryRecall => (
            ToolValidatorId::JsonSchema,
            vec![Capability::MemoryRead],
            ResultPolicy::MemoryProjection,
            Parallelism::ReadOnlyEligible,
        ),
        Handler::ReaderState => (
            ToolValidatorId::JsonSchema,
            vec![Capability::ReaderRead],
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
            vec![Capability::ReaderWrite],
            ResultPolicy::ReaderEffect,
            Parallelism::SequentialOnly,
        ),
    };

    ToolRegistration {
        spec,
        handler,
        validator,
        capabilities,
        output_policy: ToolOutputPolicy::for_result(result_policy),
        parallelism,
    }
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            description: "test".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        }])
        .unwrap_err();
        assert!(drift.message.contains("schema drift"));
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
            capabilities: vec![ToolCapability::ReaderRead],
            output_policy: ToolOutputPolicy::for_result(ToolResultPolicy::ReaderState),
            parallelism: ToolParallelism::ReadOnlyEligible,
        };
        assert!(registration.validate_arguments(r#"{"count": 1}"#).is_ok());
        assert!(registration.validate_arguments(r#"{"count": -1}"#).is_err());
        assert!(registration.validate_arguments(r#"{"other": 1}"#).is_err());
    }
}
