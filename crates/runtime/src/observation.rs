//! Vendor-neutral, metadata-only observation contract for Resident runs.
//!
//! This module deliberately contains no transport or credentials. Hosts may project these
//! records to an external backend, but the runtime never serializes model text, tool arguments,
//! tool results, profile facts, provider bodies, or rendered presentation content here.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const OBSERVATION_SCHEMA_VERSION: &str = "ub_observation.v1";
pub const MAX_OBSERVATION_SOURCE_REFS: usize = 32;
pub const MAX_OBSERVATION_ERROR_CODES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSurface {
    Resident,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    Run,
    Model,
    Tool,
    Activity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TimingSource {
    RuntimeAnchor,
    LastObserved,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Pending,
    Delivered,
    Failed,
    NotDelivered,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PersistenceState {
    Pending,
    Saved,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    ProviderReported,
    ExecutorReported,
    Estimated,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum UsageCompleteness {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObservationCoverage {
    Complete,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TokenUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cached_input_tokens: Option<u32>,
    pub cache_creation_input_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub source: UsageSource,
    pub completeness: UsageCompleteness,
}

impl TokenUsage {
    pub fn unknown() -> Self {
        Self {
            input_tokens: None,
            output_tokens: None,
            cached_input_tokens: None,
            cache_creation_input_tokens: None,
            total_tokens: None,
            source: UsageSource::Unavailable,
            completeness: UsageCompleteness::Unavailable,
        }
    }

    pub fn provider_reported(
        usage: crate::provider_stream::ModelUsage,
        execution_complete: bool,
    ) -> Self {
        let has_input_output = usage.input_tokens.is_some() && usage.output_tokens.is_some();
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cached_input_tokens: usage.cached_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            total_tokens: usage.total_tokens,
            source: UsageSource::ProviderReported,
            completeness: if execution_complete && has_input_output {
                UsageCompleteness::Complete
            } else {
                UsageCompleteness::Partial
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ObservationCompleteness {
    pub sampled: bool,
    pub dropped_count: u64,
    pub coverage: ObservationCoverage,
    pub reconstructed: bool,
}

impl Default for ObservationCompleteness {
    fn default() -> Self {
        Self {
            sampled: true,
            dropped_count: 0,
            coverage: ObservationCoverage::Complete,
            reconstructed: false,
        }
    }
}

/// The complete metadata allow-list for `ub_observation.v1` Resident records.
///
/// Every field is an identifier, state, count, or source coordinate. Values containing user or
/// provider content do not have a slot in this type and therefore cannot reach a queue by generic
/// serialization.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ObservationMetadata {
    pub thread_id: Option<String>,
    pub book_ref: Option<String>,
    pub source_revision_ref: Option<String>,
    pub registered_tool_name: Option<String>,
    pub purpose: Option<String>,
    pub error_code: Option<String>,
    pub result_count: Option<u32>,
    pub model_first_text_ms: Option<f64>,
    pub model_first_text_at: Option<String>,
    pub answer_first_patch_ms: Option<f64>,
    pub model_name: Option<String>,
    pub model_name_source: Option<String>,
    pub accepted_evidence_count: Option<u32>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub final_source_ref_count: Option<u32>,
    pub delivery_initial_issue_count: Option<u32>,
    pub delivery_repair_issue_count: Option<u32>,
    pub delivery_classification: Option<String>,
    #[serde(default)]
    pub delivery_error_codes: Vec<String>,
    pub request_count: Option<u32>,
    pub request_message_count: Option<u32>,
    pub request_tool_schema_count: Option<u32>,
    pub request_estimated_input_tokens: Option<u32>,
    pub request_estimate_source: Option<String>,
    #[serde(default)]
    pub interruption_detected_at: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<String>,
    #[serde(default)]
    pub executed: bool,
    #[serde(default)]
    pub incomplete: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ObservationEnvelope {
    pub schema_version: String,
    pub local_run_ref: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub revision: u32,
    pub surface: ObservationSurface,
    pub kind: ObservationKind,
    pub observed_at: Option<String>,
    pub elapsed_ms: Option<f64>,
    pub duration_ms: Option<f64>,
    pub timing_source: TimingSource,
    pub execution_state: Option<ExecutionState>,
    pub delivery_state: Option<DeliveryState>,
    pub persistence_state: Option<PersistenceState>,
    pub usage: TokenUsage,
    pub completeness: ObservationCompleteness,
    pub metadata: ObservationMetadata,
}

impl ObservationEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != OBSERVATION_SCHEMA_VERSION {
            return Err("unsupported observation schema version");
        }
        if self.local_run_ref.is_empty() || self.span_id.is_empty() {
            return Err("observation identity must not be empty");
        }
        if self.revision == 0 {
            return Err("observation revision starts at one");
        }
        let usage_values = [
            self.usage.input_tokens,
            self.usage.output_tokens,
            self.usage.cached_input_tokens,
            self.usage.cache_creation_input_tokens,
            self.usage.total_tokens,
        ];
        if self.usage.source == UsageSource::Unavailable && usage_values.iter().any(Option::is_some)
        {
            return Err("unavailable usage must not carry token values");
        }
        if self.usage.source == UsageSource::Unavailable
            && self.usage.completeness != UsageCompleteness::Unavailable
        {
            return Err("unavailable usage must have unavailable completeness");
        }
        if self.usage.source != UsageSource::Unavailable
            && !usage_values.iter().any(Option::is_some)
        {
            return Err("known usage source requires at least one token value");
        }
        if self.usage.source != UsageSource::Unavailable
            && self.usage.completeness == UsageCompleteness::Unavailable
        {
            return Err("known usage source requires known completeness");
        }
        if self.metadata.source_refs.len() > MAX_OBSERVATION_SOURCE_REFS {
            return Err("observation source reference limit exceeded");
        }
        if self.metadata.evidence_refs.len() > MAX_OBSERVATION_SOURCE_REFS {
            return Err("observation evidence reference limit exceeded");
        }
        if self.metadata.delivery_error_codes.len() > MAX_OBSERVATION_ERROR_CODES {
            return Err("observation delivery error code limit exceeded");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct ContractFixtures {
        valid: Vec<serde_json::Value>,
        invalid: Vec<serde_json::Value>,
    }

    fn fixtures() -> ContractFixtures {
        serde_json::from_str(include_str!(
            "../../../fixtures/observability/ub_observation.v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn shared_fixtures_enforce_allow_list_and_unknown_usage() {
        let fixtures = fixtures();
        assert!(!fixtures.valid.is_empty());
        assert!(!fixtures.invalid.is_empty());
        for value in fixtures.valid {
            let observation: ObservationEnvelope = serde_json::from_value(value).unwrap();
            observation.validate().unwrap();
        }
        for value in fixtures.invalid {
            let rejected = serde_json::from_value::<ObservationEnvelope>(value)
                .map_err(|error| error.to_string())
                .and_then(|observation| observation.validate().map_err(str::to_owned));
            assert!(rejected.is_err(), "invalid fixture was accepted");
        }
    }

    #[test]
    fn observation_types_export_without_transport_fields() {
        let directory = "../../packages/observability/src/generated";
        ObservationEnvelope::export_all_to(directory).unwrap();
        ObservationMetadata::export_all_to(directory).unwrap();
        let serialized = serde_json::to_string(&ObservationMetadata::default()).unwrap();
        for forbidden in [
            "message_content",
            "tool_arguments",
            "provider_error_body",
            "preview_snapshot",
            "label_snapshot",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}
