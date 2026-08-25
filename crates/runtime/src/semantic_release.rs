//! Privacy-bounded CR10 semantic-routing release receipts.
//!
//! The live prompt, source text, Tool bodies, API credentials, and Reader profile
//! values are inspected only in memory. The persisted receipt keeps closed enums,
//! bounded identifiers, structural trace summaries, and SHA-256 digests.

use crate::guided_read_replay::{
    verify_guided_read_route_replay, GuidedReadReplayEffectKind, GuidedReadRouteReplayReceipt,
};
use crate::model_runtime::AGENT_REQUEST_PLAN_VERSION;
use crate::orchestrator::{AgentEffect, OuterOutcome};
use crate::tool_exposure::TOOL_EXPOSURE_PLAN_VERSION;
use crate::{AgentRequestPlan, ProviderMode};
use read_tools::Book;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

pub const SEMANTIC_RELEASE_RECEIPT_VERSION: &str = "semantic_release_receipt.v1";
pub const SEMANTIC_RELEASE_BUNDLE_VERSION: &str = "semantic_release_bundle.v1";
pub const SEMANTIC_RELEASE_RECEIPT_MAX_BYTES: usize = 64 * 1024;
pub const SEMANTIC_RELEASE_BUNDLE_MAX_BYTES: usize = 512 * 1024;

const MAX_CASES: usize = 32;
const MAX_REQUESTS: usize = 64;
const MAX_TRACE_STEPS: usize = 64;
const MAX_TOOL_NAMES: usize = 128;
const MAX_ASSET_REFS: usize = 32;
const MAX_IDENTIFIER_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReleaseProtocol {
    Native,
    React,
}

impl From<ProviderMode> for SemanticReleaseProtocol {
    fn from(value: ProviderMode) -> Self {
        match value {
            ProviderMode::Native => Self::Native,
            ProviderMode::ReAct => Self::React,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReleaseLocale {
    ZhCn,
    En,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReleaseScenario {
    DocumentOverview,
    SelectionExplanation,
    LiteralLocate,
    ExplicitGuidedRead,
    NegatedGuidedOverview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseBookIdentity {
    pub book_id_sha256: String,
    pub source_sha256: String,
    pub book_structure_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseProviderIdentity {
    pub protocol: SemanticReleaseProtocol,
    pub model: String,
    pub runtime_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseContractVersions {
    pub prompt_sha256: String,
    pub agent_request_plan_version: String,
    pub tool_exposure_plan_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseAssetRef {
    pub asset_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseRequestFingerprint {
    pub ordinal: usize,
    pub instructions_sha256: String,
    pub tool_schema_sha256: String,
    pub instruction_assets: Vec<SemanticReleaseAssetRef>,
    pub tool_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseArgumentSummary {
    pub keys: Vec<String>,
    pub lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseTraceStep {
    pub ordinal: usize,
    pub model_tool_loop: Option<usize>,
    pub tool: String,
    pub arguments: SemanticReleaseArgumentSummary,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReleaseEffectKind {
    Goto,
    Highlight,
    Note,
    Layout,
    LayoutProposal,
    PaperMinimap,
    PaperMinimapProposal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseEffectSummary {
    pub kind: SemanticReleaseEffectKind,
    pub before_anchor: Option<String>,
    pub after_anchor: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReleaseProgressPhase {
    Unlocated,
    Located,
    EvidenceReady,
    Synthesized,
    Final,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleasePhaseTransition {
    pub phase: SemanticReleaseProgressPhase,
    pub after_trace_ordinal: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseLoopResult {
    pub answer_present: bool,
    pub answer_sha256: Option<String>,
    pub answer_char_count: usize,
    pub incomplete: bool,
    pub warning_code: Option<String>,
    pub turns: usize,
    pub max_model_tool_loop: Option<usize>,
}

/// A closed per-case receipt. No field can carry prompt/source/Tool body text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseReceipt {
    pub version: String,
    pub case_id: String,
    pub scenario: SemanticReleaseScenario,
    pub locale: SemanticReleaseLocale,
    pub book: SemanticReleaseBookIdentity,
    pub provider: SemanticReleaseProviderIdentity,
    pub contract: SemanticReleaseContractVersions,
    pub requests: Vec<SemanticReleaseRequestFingerprint>,
    pub first_evidence_planning_tool: Option<String>,
    pub blind_read_count: usize,
    pub trace: Vec<SemanticReleaseTraceStep>,
    pub reader_effects: Vec<SemanticReleaseEffectSummary>,
    pub phase_transitions: Vec<SemanticReleasePhaseTransition>,
    pub loop_result: SemanticReleaseLoopResult,
}

/// CR10 release evidence is accepted only as a complete scenario bundle. The
/// existing GR4 route receipt remains the stronger guided-read route/effect proof.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticReleaseBundle {
    pub version: String,
    pub cases: Vec<SemanticReleaseReceipt>,
    pub guided_read_route: GuidedReadRouteReplayReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticReleaseVerificationError {
    message: String,
}

impl SemanticReleaseVerificationError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for SemanticReleaseVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SemanticReleaseVerificationError {}

#[allow(clippy::too_many_arguments)]
pub fn build_semantic_release_receipt(
    book: &Book,
    provider_mode: ProviderMode,
    model: &str,
    case_id: &str,
    scenario: SemanticReleaseScenario,
    locale: SemanticReleaseLocale,
    prompt: &str,
    plans: &[AgentRequestPlan],
    outcome: &OuterOutcome,
) -> Result<SemanticReleaseReceipt, SemanticReleaseVerificationError> {
    let first_plan = plans.first().ok_or_else(|| {
        SemanticReleaseVerificationError::invalid(
            "semantic release case recorded no AgentRequestPlan",
        )
    })?;
    let trace = outcome
        .trace
        .iter()
        .enumerate()
        .map(|(index, step)| SemanticReleaseTraceStep {
            ordinal: index + 1,
            model_tool_loop: step.model_tool_loop,
            tool: step.tool.clone(),
            arguments: summarize_arguments(&step.args),
            error_code: trace_error_code(&step.result_digest),
        })
        .collect::<Vec<_>>();
    let answer = outcome.answer.as_deref();
    let receipt = SemanticReleaseReceipt {
        version: SEMANTIC_RELEASE_RECEIPT_VERSION.into(),
        case_id: case_id.into(),
        scenario,
        locale,
        book: SemanticReleaseBookIdentity {
            book_id_sha256: sha256(book.base.book_id.as_bytes()),
            source_sha256: book.source_fingerprint().into(),
            book_structure_available: book.book_structure().is_some(),
        },
        provider: SemanticReleaseProviderIdentity {
            protocol: provider_mode.into(),
            model: model.into(),
            runtime_profile_id: first_plan.runtime_profile.profile_id.clone(),
        },
        contract: SemanticReleaseContractVersions {
            prompt_sha256: sha256(prompt.as_bytes()),
            agent_request_plan_version: first_plan.version.clone(),
            tool_exposure_plan_version: TOOL_EXPOSURE_PLAN_VERSION.into(),
        },
        requests: plans
            .iter()
            .enumerate()
            .map(|(index, plan)| SemanticReleaseRequestFingerprint {
                ordinal: index + 1,
                instructions_sha256: sha256(plan.instructions.as_bytes()),
                tool_schema_sha256: tool_schema_sha256(plan),
                instruction_assets: plan
                    .instruction_assets
                    .iter()
                    .map(|asset| SemanticReleaseAssetRef {
                        asset_id: asset.asset_id.clone(),
                        revision: asset.revision.clone(),
                    })
                    .collect(),
                tool_names: plan.tools.iter().map(|tool| tool.name.clone()).collect(),
            })
            .collect(),
        first_evidence_planning_tool: trace
            .iter()
            .find(|step| is_evidence_planning_tool(&step.tool))
            .map(|step| step.tool.clone()),
        blind_read_count: trace.iter().filter(|step| is_blind_read(step)).count(),
        phase_transitions: derive_phase_transitions(scenario, &trace, answer.is_some()),
        trace,
        reader_effects: outcome.effects.iter().map(summarize_effect).collect(),
        loop_result: SemanticReleaseLoopResult {
            answer_present: answer.is_some(),
            answer_sha256: answer.map(|value| sha256(value.as_bytes())),
            answer_char_count: answer.map(str::chars).map(Iterator::count).unwrap_or(0),
            incomplete: outcome.incomplete,
            warning_code: outcome.warning.clone(),
            turns: outcome.turns,
            max_model_tool_loop: outcome
                .trace
                .iter()
                .filter_map(|step| step.model_tool_loop)
                .max(),
        },
    };
    verify_semantic_release_receipt(&receipt)?;
    Ok(receipt)
}

pub fn verify_semantic_release_receipt(
    receipt: &SemanticReleaseReceipt,
) -> Result<(), SemanticReleaseVerificationError> {
    let compact = serde_json::to_vec(receipt).map_err(|error| {
        SemanticReleaseVerificationError::invalid(format!(
            "semantic release receipt cannot serialize: {error}"
        ))
    })?;
    if compact.len() > SEMANTIC_RELEASE_RECEIPT_MAX_BYTES {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "semantic release receipt exceeds {SEMANTIC_RELEASE_RECEIPT_MAX_BYTES} bytes"
        )));
    }
    reject_forbidden_payload_markers(&compact)?;

    if receipt.version != SEMANTIC_RELEASE_RECEIPT_VERSION {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release receipt version mismatch",
        ));
    }
    require_identifier("case_id", &receipt.case_id)?;
    require_sha256("book.book_id_sha256", &receipt.book.book_id_sha256)?;
    require_sha256("book.source_sha256", &receipt.book.source_sha256)?;
    if !receipt.book.book_structure_available
        && matches!(
            receipt.scenario,
            SemanticReleaseScenario::DocumentOverview
                | SemanticReleaseScenario::ExplicitGuidedRead
                | SemanticReleaseScenario::NegatedGuidedOverview
        )
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "structure-dependent semantic release case has no BookStructure sidecar",
        ));
    }
    require_label("provider.model", &receipt.provider.model)?;
    require_identifier(
        "provider.runtime_profile_id",
        &receipt.provider.runtime_profile_id,
    )?;
    require_sha256("contract.prompt_sha256", &receipt.contract.prompt_sha256)?;
    if receipt.contract.agent_request_plan_version != AGENT_REQUEST_PLAN_VERSION
        || receipt.contract.tool_exposure_plan_version != TOOL_EXPOSURE_PLAN_VERSION
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release contract versions do not match the runtime",
        ));
    }

    verify_requests(&receipt.requests)?;
    verify_trace(&receipt.trace)?;
    verify_effects(&receipt.reader_effects)?;
    verify_loop_result(&receipt.loop_result)?;

    let first_planner = receipt
        .trace
        .iter()
        .find(|step| is_evidence_planning_tool(&step.tool))
        .map(|step| step.tool.as_str());
    if receipt.first_evidence_planning_tool.as_deref() != first_planner {
        return Err(SemanticReleaseVerificationError::invalid(
            "first evidence-planning tool does not match the trace",
        ));
    }
    let blind_read_count = receipt
        .trace
        .iter()
        .filter(|step| is_blind_read(step))
        .count();
    if receipt.blind_read_count != blind_read_count {
        return Err(SemanticReleaseVerificationError::invalid(
            "blind-read count does not match the trace",
        ));
    }
    let expected_phases = derive_phase_transitions(
        receipt.scenario,
        &receipt.trace,
        receipt.loop_result.answer_present,
    );
    if receipt.phase_transitions != expected_phases {
        return Err(SemanticReleaseVerificationError::invalid(
            "phase transitions do not match the bounded trace",
        ));
    }

    match receipt.scenario {
        SemanticReleaseScenario::DocumentOverview => verify_document_overview(receipt, false),
        SemanticReleaseScenario::NegatedGuidedOverview => verify_document_overview(receipt, true),
        SemanticReleaseScenario::SelectionExplanation => verify_selection_explanation(receipt),
        SemanticReleaseScenario::LiteralLocate => verify_literal_locate(receipt),
        SemanticReleaseScenario::ExplicitGuidedRead => verify_guided_case(receipt),
    }
}

pub fn verify_semantic_release_bundle(
    bundle: &SemanticReleaseBundle,
) -> Result<(), SemanticReleaseVerificationError> {
    let compact = serde_json::to_vec(bundle).map_err(|error| {
        SemanticReleaseVerificationError::invalid(format!(
            "semantic release bundle cannot serialize: {error}"
        ))
    })?;
    if compact.len() > SEMANTIC_RELEASE_BUNDLE_MAX_BYTES {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "semantic release bundle exceeds {SEMANTIC_RELEASE_BUNDLE_MAX_BYTES} bytes"
        )));
    }
    reject_forbidden_payload_markers(&compact)?;
    if bundle.version != SEMANTIC_RELEASE_BUNDLE_VERSION {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release bundle version mismatch",
        ));
    }
    if bundle.cases.len() < 9 || bundle.cases.len() > MAX_CASES {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release bundle must contain the complete bounded CR10 matrix",
        ));
    }

    let mut case_ids = BTreeSet::new();
    let mut prompt_hashes = BTreeSet::new();
    let mut overview_locales = BTreeSet::new();
    let mut overview_count = 0_usize;
    let mut selection_count = 0_usize;
    let mut literal_count = 0_usize;
    let mut guided_count = 0_usize;
    let mut negated_count = 0_usize;
    for receipt in &bundle.cases {
        verify_semantic_release_receipt(receipt)?;
        if !case_ids.insert(receipt.case_id.as_str()) {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release case_id is duplicated",
            ));
        }
        if !prompt_hashes.insert(receipt.contract.prompt_sha256.as_str()) {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release prompt digest is duplicated",
            ));
        }
        match receipt.scenario {
            SemanticReleaseScenario::DocumentOverview => {
                overview_count += 1;
                overview_locales.insert(receipt.locale);
            }
            SemanticReleaseScenario::SelectionExplanation => selection_count += 1,
            SemanticReleaseScenario::LiteralLocate => literal_count += 1,
            SemanticReleaseScenario::ExplicitGuidedRead => guided_count += 1,
            SemanticReleaseScenario::NegatedGuidedOverview => negated_count += 1,
        }
    }
    if overview_count < 5
        || overview_locales
            != BTreeSet::from([SemanticReleaseLocale::ZhCn, SemanticReleaseLocale::En])
        || selection_count != 1
        || literal_count != 1
        || guided_count != 1
        || negated_count != 1
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release bundle does not cover the required bilingual CR10 scenario matrix",
        ));
    }

    verify_guided_read_route_replay(&bundle.guided_read_route).map_err(|error| {
        SemanticReleaseVerificationError::invalid(format!(
            "guided-read route receipt failed verification: {error}"
        ))
    })?;
    let guided = bundle
        .cases
        .iter()
        .find(|receipt| receipt.scenario == SemanticReleaseScenario::ExplicitGuidedRead)
        .expect("guided count was verified above");
    verify_guided_receipt_binding(guided, &bundle.guided_read_route)
}

pub fn parse_and_verify_semantic_release_bundle(
    input: &str,
) -> Result<SemanticReleaseBundle, SemanticReleaseVerificationError> {
    if input.len() > SEMANTIC_RELEASE_BUNDLE_MAX_BYTES {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "semantic release bundle input exceeds {SEMANTIC_RELEASE_BUNDLE_MAX_BYTES} bytes"
        )));
    }
    let bundle = serde_json::from_str::<SemanticReleaseBundle>(input).map_err(|error| {
        SemanticReleaseVerificationError::invalid(format!(
            "semantic release bundle schema is invalid: {error}"
        ))
    })?;
    verify_semantic_release_bundle(&bundle)?;
    Ok(bundle)
}

pub fn serialize_verified_semantic_release_bundle(
    bundle: &SemanticReleaseBundle,
) -> Result<String, SemanticReleaseVerificationError> {
    verify_semantic_release_bundle(bundle)?;
    let serialized = serde_json::to_string_pretty(bundle).map_err(|error| {
        SemanticReleaseVerificationError::invalid(format!(
            "semantic release bundle cannot serialize: {error}"
        ))
    })?;
    if serialized.len() > SEMANTIC_RELEASE_BUNDLE_MAX_BYTES {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "pretty semantic release bundle exceeds {SEMANTIC_RELEASE_BUNDLE_MAX_BYTES} bytes"
        )));
    }
    Ok(serialized)
}

fn verify_requests(
    requests: &[SemanticReleaseRequestFingerprint],
) -> Result<(), SemanticReleaseVerificationError> {
    if requests.is_empty() || requests.len() > MAX_REQUESTS {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release request fingerprints are empty or unbounded",
        ));
    }
    for (index, request) in requests.iter().enumerate() {
        if request.ordinal != index + 1 {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release request ordinals are not contiguous",
            ));
        }
        require_sha256("request.instructions_sha256", &request.instructions_sha256)?;
        require_sha256("request.tool_schema_sha256", &request.tool_schema_sha256)?;
        if request.instruction_assets.is_empty()
            || request.instruction_assets.len() > MAX_ASSET_REFS
        {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release instruction asset set is empty or unbounded",
            ));
        }
        for asset in &request.instruction_assets {
            require_identifier("instruction asset id", &asset.asset_id)?;
            require_identifier("instruction asset revision", &asset.revision)?;
        }
        if request.tool_names.len() > MAX_TOOL_NAMES {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release tool surface is unbounded",
            ));
        }
        let mut unique = BTreeSet::new();
        for tool in &request.tool_names {
            require_identifier("request tool name", tool)?;
            if !unique.insert(tool.as_str()) {
                return Err(SemanticReleaseVerificationError::invalid(
                    "semantic release request tool surface contains duplicates",
                ));
            }
        }
    }
    Ok(())
}

fn verify_trace(
    trace: &[SemanticReleaseTraceStep],
) -> Result<(), SemanticReleaseVerificationError> {
    if trace.len() > MAX_TRACE_STEPS {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release trace is unbounded",
        ));
    }
    for (index, step) in trace.iter().enumerate() {
        if step.ordinal != index + 1 {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release trace ordinals are not contiguous",
            ));
        }
        if step.model_tool_loop.is_some_and(|value| value == 0) {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release model-tool loop ordinals must be 1-based",
            ));
        }
        require_identifier("trace tool", &step.tool)?;
        if is_private_called_tool(&step.tool) {
            return Err(SemanticReleaseVerificationError::invalid(format!(
                "semantic release trace called private tool {}",
                step.tool
            )));
        }
        if step.arguments.keys.len() > 32 || step.arguments.lids.len() > 32 {
            return Err(SemanticReleaseVerificationError::invalid(
                "semantic release trace argument summary is unbounded",
            ));
        }
        for key in &step.arguments.keys {
            require_identifier("trace argument key", key)?;
        }
        for lid in &step.arguments.lids {
            require_lid("trace argument lid", lid)?;
        }
        if let Some(error_code) = &step.error_code {
            require_identifier("trace error code", error_code)?;
        }
    }
    Ok(())
}

fn verify_effects(
    effects: &[SemanticReleaseEffectSummary],
) -> Result<(), SemanticReleaseVerificationError> {
    if effects.len() > 16 {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release Reader effect summary is unbounded",
        ));
    }
    for effect in effects {
        if effect.kind == SemanticReleaseEffectKind::Goto {
            let before = effect.before_anchor.as_deref().ok_or_else(|| {
                SemanticReleaseVerificationError::invalid("Goto effect is missing before_anchor")
            })?;
            let after = effect.after_anchor.as_deref().ok_or_else(|| {
                SemanticReleaseVerificationError::invalid("Goto effect is missing after_anchor")
            })?;
            require_lid("Goto before_anchor", before)?;
            require_lid("Goto after_anchor", after)?;
        } else if effect.before_anchor.is_some() || effect.after_anchor.is_some() {
            return Err(SemanticReleaseVerificationError::invalid(
                "non-Goto effect retained an anchor payload",
            ));
        }
    }
    Ok(())
}

fn verify_loop_result(
    result: &SemanticReleaseLoopResult,
) -> Result<(), SemanticReleaseVerificationError> {
    if !result.answer_present
        || result.answer_char_count == 0
        || result.incomplete
        || result.warning_code.is_some()
        || result.turns == 0
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release case did not finish with a complete bounded answer",
        ));
    }
    let answer_sha256 = result.answer_sha256.as_deref().ok_or_else(|| {
        SemanticReleaseVerificationError::invalid("semantic release answer digest is missing")
    })?;
    require_sha256("loop_result.answer_sha256", answer_sha256)?;
    if result
        .max_model_tool_loop
        .is_some_and(|model_tool_loop| model_tool_loop > result.turns)
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic release loop ordinal exceeds the recorded turn count",
        ));
    }
    Ok(())
}

fn verify_document_overview(
    receipt: &SemanticReleaseReceipt,
    negated_guided_read: bool,
) -> Result<(), SemanticReleaseVerificationError> {
    if receipt.trace.first().map(|step| step.tool.as_str()) != Some("book.structure")
        || receipt.first_evidence_planning_tool.as_deref() != Some("book.structure")
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "document overview must begin evidence planning with book.structure",
        ));
    }
    if !receipt.trace.iter().skip(1).any(|step| {
        step.error_code.is_none()
            && matches!(
                step.tool.as_str(),
                "book.text" | "book.search_text" | "book.query" | "book.synthesize"
            )
    }) {
        return Err(SemanticReleaseVerificationError::invalid(
            "document overview did not acquire evidence after structural planning",
        ));
    }
    if receipt.blind_read_count != 0
        || !receipt.reader_effects.is_empty()
        || receipt
            .trace
            .iter()
            .any(|step| step.tool.starts_with("reader."))
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "document overview crossed the read-only or locator boundary",
        ));
    }
    if negated_guided_read
        && receipt.trace.iter().any(|step| {
            matches!(
                step.tool.as_str(),
                "reader.state" | "book.guide_path" | "book.guided_route_from" | "reader.gotoLid"
            )
        })
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "negated guided-read overview entered navigation ceremony",
        ));
    }
    Ok(())
}

fn verify_selection_explanation(
    receipt: &SemanticReleaseReceipt,
) -> Result<(), SemanticReleaseVerificationError> {
    if receipt.first_evidence_planning_tool.is_some()
        || receipt.blind_read_count != 0
        || !receipt.reader_effects.is_empty()
        || receipt.trace.len() > 2
        || receipt
            .trace
            .iter()
            .any(|step| !matches!(step.tool.as_str(), "book.context" | "book.text"))
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "selection explanation exceeded the zero/local Text/Context boundary",
        ));
    }
    Ok(())
}

fn verify_literal_locate(
    receipt: &SemanticReleaseReceipt,
) -> Result<(), SemanticReleaseVerificationError> {
    if receipt.trace.first().map(|step| step.tool.as_str()) != Some("book.search_text")
        || receipt.blind_read_count != 0
        || !receipt.reader_effects.is_empty()
        || receipt
            .trace
            .iter()
            .any(|step| step.tool == "book.query" || step.tool.starts_with("reader."))
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "literal locate did not preserve lexical-first read-only routing",
        ));
    }
    Ok(())
}

fn verify_guided_case(
    receipt: &SemanticReleaseReceipt,
) -> Result<(), SemanticReleaseVerificationError> {
    let goto_trace_count = receipt
        .trace
        .iter()
        .filter(|step| step.tool == "reader.gotoLid")
        .count();
    let goto_effect_count = receipt
        .reader_effects
        .iter()
        .filter(|effect| effect.kind == SemanticReleaseEffectKind::Goto)
        .count();
    if receipt.blind_read_count != 0 || goto_trace_count != 1 || goto_effect_count != 1 {
        return Err(SemanticReleaseVerificationError::invalid(
            "guided-read semantic case lacks the unique bounded Goto path",
        ));
    }
    Ok(())
}

fn verify_guided_receipt_binding(
    semantic: &SemanticReleaseReceipt,
    guided: &GuidedReadRouteReplayReceipt,
) -> Result<(), SemanticReleaseVerificationError> {
    let guided_protocol = match guided.provider.protocol {
        crate::guided_read_replay::GuidedReadReplayProtocol::Native => {
            SemanticReleaseProtocol::Native
        }
        crate::guided_read_replay::GuidedReadReplayProtocol::React => {
            SemanticReleaseProtocol::React
        }
    };
    if semantic.contract.prompt_sha256 != guided.contract.prompt_sha256
        || semantic.book.book_id_sha256 != guided.book.book_id_sha256
        || semantic.book.source_sha256 != guided.book.source_sha256
        || semantic.provider.protocol != guided_protocol
        || semantic.provider.model != guided.provider.model
        || semantic.provider.runtime_profile_id != guided.provider.runtime_profile_id
        || semantic
            .trace
            .iter()
            .map(|step| step.tool.as_str())
            .collect::<Vec<_>>()
            != guided
                .trace
                .iter()
                .map(|step| step.tool.as_str())
                .collect::<Vec<_>>()
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic guided case is not bound to the verified GR4 route receipt",
        ));
    }
    let semantic_goto = semantic
        .reader_effects
        .iter()
        .find(|effect| effect.kind == SemanticReleaseEffectKind::Goto);
    let guided_goto = guided
        .effects
        .iter()
        .find(|effect| effect.kind == GuidedReadReplayEffectKind::Goto);
    if semantic_goto.map(|effect| (&effect.before_anchor, &effect.after_anchor))
        != guided_goto.map(|effect| (&effect.before_anchor, &effect.after_anchor))
    {
        return Err(SemanticReleaseVerificationError::invalid(
            "semantic guided effect is not bound to the verified GR4 Goto",
        ));
    }
    Ok(())
}

fn derive_phase_transitions(
    scenario: SemanticReleaseScenario,
    trace: &[SemanticReleaseTraceStep],
    answer_present: bool,
) -> Vec<SemanticReleasePhaseTransition> {
    let initial = if scenario == SemanticReleaseScenario::SelectionExplanation {
        SemanticReleaseProgressPhase::EvidenceReady
    } else {
        // Resident turns always seed the current valid Reader anchor in the
        // TurnLocatorLedger before the first provider request.
        SemanticReleaseProgressPhase::Located
    };
    let mut current = initial;
    let mut transitions = vec![SemanticReleasePhaseTransition {
        phase: initial,
        after_trace_ordinal: None,
    }];
    for step in trace.iter().filter(|step| step.error_code.is_none()) {
        let candidate = match step.tool.as_str() {
            "book.text" | "book.search_text" => Some(SemanticReleaseProgressPhase::EvidenceReady),
            "book.synthesize" => Some(SemanticReleaseProgressPhase::Synthesized),
            _ => None,
        };
        if let Some(candidate) = candidate.filter(|candidate| *candidate > current) {
            current = candidate;
            transitions.push(SemanticReleasePhaseTransition {
                phase: candidate,
                after_trace_ordinal: Some(step.ordinal),
            });
        }
    }
    if answer_present && current < SemanticReleaseProgressPhase::Final {
        transitions.push(SemanticReleasePhaseTransition {
            phase: SemanticReleaseProgressPhase::Final,
            after_trace_ordinal: None,
        });
    }
    transitions
}

fn summarize_arguments(arguments: &str) -> SemanticReleaseArgumentSummary {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(arguments) else {
        return SemanticReleaseArgumentSummary {
            keys: Vec::new(),
            lids: Vec::new(),
        };
    };
    let keys = value
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    let mut lids = BTreeSet::new();
    collect_argument_lids(&value, None, &mut lids);
    SemanticReleaseArgumentSummary {
        keys,
        lids: lids.into_iter().collect(),
    }
}

fn collect_argument_lids(
    value: &serde_json::Value,
    parent_key: Option<&str>,
    output: &mut BTreeSet<String>,
) {
    match value {
        serde_json::Value::String(value) if parent_key.is_some_and(is_lid_argument_field) => {
            output.insert(value.clone());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_argument_lids(item, parent_key, output);
            }
        }
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                collect_argument_lids(child, Some(key), output);
            }
        }
        _ => {}
    }
}

fn is_lid_argument_field(key: &str) -> bool {
    matches!(key, "at" | "from" | "target" | "lid" | "lids")
        || key.ends_with("_lid")
        || key.ends_with("_lids")
}

fn summarize_effect(effect: &AgentEffect) -> SemanticReleaseEffectSummary {
    match effect {
        AgentEffect::Goto {
            before_anchor,
            after_anchor,
        } => SemanticReleaseEffectSummary {
            kind: SemanticReleaseEffectKind::Goto,
            before_anchor: Some(before_anchor.clone()),
            after_anchor: Some(after_anchor.clone()),
        },
        AgentEffect::Highlight { .. } => {
            effect_without_payload(SemanticReleaseEffectKind::Highlight)
        }
        AgentEffect::Note { .. } => effect_without_payload(SemanticReleaseEffectKind::Note),
        AgentEffect::Layout { .. } => effect_without_payload(SemanticReleaseEffectKind::Layout),
        AgentEffect::LayoutProposal { .. } => {
            effect_without_payload(SemanticReleaseEffectKind::LayoutProposal)
        }
        AgentEffect::PaperMinimap { .. } => {
            effect_without_payload(SemanticReleaseEffectKind::PaperMinimap)
        }
        AgentEffect::PaperMinimapProposal { .. } => {
            effect_without_payload(SemanticReleaseEffectKind::PaperMinimapProposal)
        }
    }
}

fn effect_without_payload(kind: SemanticReleaseEffectKind) -> SemanticReleaseEffectSummary {
    SemanticReleaseEffectSummary {
        kind,
        before_anchor: None,
        after_anchor: None,
    }
}

fn tool_schema_sha256(plan: &AgentRequestPlan) -> String {
    let tools = plan
        .tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        })
        .collect::<Vec<_>>();
    sha256(&serde_json::to_vec(&tools).unwrap_or_default())
}

fn trace_error_code(result_digest: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(result_digest) {
        if let Some(error_code) = value.get("error_code").and_then(serde_json::Value::as_str) {
            return Some(error_code.into());
        }
    }
    let marker = "\"error_code\":\"";
    let start = result_digest.find(marker)? + marker.len();
    let tail = &result_digest[start..];
    let end = tail.find('"')?;
    let value = &tail[..end];
    (!value.is_empty()).then(|| value.into())
}

fn is_evidence_planning_tool(tool: &str) -> bool {
    tool == "book.structure"
}

fn is_blind_read(step: &SemanticReleaseTraceStep) -> bool {
    step.tool == "book.text"
        && matches!(
            step.error_code.as_deref(),
            Some("LID_PROVENANCE_REQUIRED" | "LID_RECOVERY_REQUIRED")
        )
}

fn is_private_called_tool(tool: &str) -> bool {
    tool == "book_guide"
        || tool.starts_with("memory.")
        || tool.starts_with("profile.")
        || tool.starts_with("artifact.")
}

fn require_sha256(field: &str, value: &str) -> Result<(), SemanticReleaseVerificationError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "{field} is not a SHA-256 hex digest"
        )));
    }
    Ok(())
}

fn require_label(field: &str, value: &str) -> Result<(), SemanticReleaseVerificationError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(char::is_control)
        || value.trim() != value
    {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "{field} is empty, unbounded, or contains control whitespace"
        )));
    }
    Ok(())
}

fn require_identifier(field: &str, value: &str) -> Result<(), SemanticReleaseVerificationError> {
    require_label(field, value)?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "{field} contains non-identifier characters"
        )));
    }
    Ok(())
}

fn require_lid(field: &str, value: &str) -> Result<(), SemanticReleaseVerificationError> {
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(SemanticReleaseVerificationError::invalid(format!(
            "{field} contains an invalid LID"
        )));
    }
    Ok(())
}

fn reject_forbidden_payload_markers(
    serialized: &[u8],
) -> Result<(), SemanticReleaseVerificationError> {
    let lower = String::from_utf8_lossy(serialized).to_ascii_lowercase();
    for marker in [
        "\"api_key\"",
        "\"authorization\"",
        "\"model_body\"",
        "\"tool_body\"",
        "\"source_text\"",
        "\"prompt_text\"",
        "\"answer_text\"",
        "reader_profile_snapshot",
        "memory_document",
        "bearer ",
    ] {
        if lower.contains(marker) {
            return Err(SemanticReleaseVerificationError::invalid(format!(
                "semantic release evidence contains forbidden payload marker {marker}"
            )));
        }
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_request_audit::AgentRequestAudit;
    use crate::guided_read_replay::build_guided_read_route_replay_receipt;
    use crate::model_runtime::{InstructionModule, ModelRuntimeProfile, ProviderToolProtocol};
    use crate::orchestrator::{ProfileUsageTrace, TraceStep};
    use crate::{Message, Role, ToolCall, ToolSpec};
    use base_schema::{LidNode, NodeKind, ReadOnlyBase, Span};
    use read_tools::{
        AnchoredText, BookStructureKeyStop, BookStructureKeyStopType, BookStructureSidecar,
        BookStructureSpineRole, BookStructureSpineUnit, ProfileArtifactHeader,
    };

    const NAVIGATION_ASSET_ID: &str = "resident-agent.policy.navigation";
    const NAVIGATION_REVISION: &str = "v4";

    fn release_book() -> Book {
        let base = ReadOnlyBase {
            book_id: "PRIVATE BOOK TITLE".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Section,
                    span: Span { start: 0, end: 20 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 10 },
                    children: Vec::new(),
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 10, end: 20 },
                    children: Vec::new(),
                },
            ],
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        };
        Book::new(base, "PRIVATE SOURCE BODY!").with_book_structure(Some(BookStructureSidecar {
            header: ProfileArtifactHeader {
                book_id: "PRIVATE BOOK TITLE".into(),
                book_version: "v1".into(),
                profile_id: "technical_learning".into(),
                profile_version: "technical_learning_v1".into(),
                core_schema_version: "core_v1".into(),
                generated_at: "t0".into(),
            },
            spine: vec![BookStructureSpineUnit {
                lid: "1".into(),
                role: BookStructureSpineRole::Foundation,
                summary: AnchoredText {
                    text: "PRIVATE STRUCTURE SUMMARY".into(),
                    evidence_lids: vec!["1.1".into(), "1.2".into()],
                },
                key_stop_ids: vec!["next".into()],
                depends_on: Vec::new(),
            }],
            throughlines: Vec::new(),
            key_stops: vec![BookStructureKeyStop {
                id: "next".into(),
                lid: "1.2".into(),
                stop_type: BookStructureKeyStopType::Definition,
                title: Some("PRIVATE STOP TITLE".into()),
                reason: AnchoredText {
                    text: "PRIVATE STOP REASON".into(),
                    evidence_lids: vec!["1.2".into()],
                },
            }],
        }))
    }

    fn tool_specs() -> Vec<ToolSpec> {
        [
            "book.structure",
            "book.search_text",
            "book.text",
            "book.context",
            "book.query",
            "book.synthesize",
            "book.guide_path",
            "book.guided_route_from",
            "reader.state",
            "reader.gotoLid",
        ]
        .into_iter()
        .map(|name| ToolSpec {
            name: name.into(),
            description: "PRIVATE TOOL DESCRIPTION".into(),
            parameters: serde_json::json!({"type":"object"}),
        })
        .collect()
    }

    fn profile() -> ModelRuntimeProfile {
        ModelRuntimeProfile::fallback("offline-model", ProviderToolProtocol::Native)
    }

    fn modules() -> Vec<InstructionModule> {
        vec![InstructionModule::new(
            NAVIGATION_ASSET_ID,
            NAVIGATION_REVISION,
            "PRIVATE PROMPT TEXT",
        )]
    }

    fn plan(messages: &[Message]) -> AgentRequestPlan {
        AgentRequestPlan::for_agent_turn_with_modules(
            profile(),
            messages,
            &tool_specs(),
            &modules(),
        )
    }

    fn trace(tool: &str, arguments: &str, ordinal: usize) -> TraceStep {
        TraceStep {
            model_tool_loop: Some(ordinal),
            tool: tool.into(),
            args: arguments.into(),
            result_digest: "{}".into(),
            query_audit: None,
        }
    }

    fn outcome(trace: Vec<TraceStep>, effects: Vec<AgentEffect>) -> OuterOutcome {
        OuterOutcome {
            answer: Some("PRIVATE ANSWER TEXT".into()),
            answer_view: None,
            incomplete: false,
            warning: None,
            turns: trace
                .iter()
                .filter_map(|step| step.model_tool_loop)
                .max()
                .unwrap_or(1),
            tokens_spent: 10,
            effects,
            trace,
            profile_usage: ProfileUsageTrace::default(),
            memory_updates: Vec::new(),
            source_bindings: Vec::new(),
            delivery_diagnostics: None,
            request_audit: AgentRequestAudit::default(),
        }
    }

    fn receipt(
        case_id: &str,
        scenario: SemanticReleaseScenario,
        locale: SemanticReleaseLocale,
        prompt: &str,
        trace: Vec<TraceStep>,
    ) -> SemanticReleaseReceipt {
        build_semantic_release_receipt(
            &release_book(),
            ProviderMode::Native,
            "offline-model",
            case_id,
            scenario,
            locale,
            prompt,
            &[plan(&[Message::user(prompt)])],
            &outcome(trace, Vec::new()),
        )
        .unwrap()
    }

    fn assistant_call(id: &str, name: &str, arguments: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: arguments.into(),
            }],
            tool_call_id: None,
        }
    }

    fn tool_result(id: &str, model_body: serde_json::Value) -> Message {
        Message {
            role: Role::Tool,
            content: Some(
                serde_json::json!({
                    "version": "tool_result_envelope.v1",
                    "model_body": model_body,
                })
                .to_string(),
            ),
            tool_calls: Vec::new(),
            tool_call_id: Some(id.into()),
        }
    }

    fn guided_pair() -> (SemanticReleaseReceipt, GuidedReadRouteReplayReceipt) {
        let book = release_book();
        let prompt = "带我读 1.1";
        let first = plan(&[Message::user(prompt)]);
        let mut messages = vec![Message::user(prompt)];
        let fixture = [
            (
                "state",
                "reader.state",
                "{}",
                serde_json::json!({"anchor":"1.1"}),
            ),
            (
                "structure",
                "book.structure",
                r#"{"at":"1.1"}"#,
                serde_json::json!({"spine_unit":{"lid":"1"}}),
            ),
            (
                "guide",
                "book.guide_path",
                r#"{"at":"1.1"}"#,
                serde_json::json!({"segments":[{"key_stops":[{"lid":"1.2"}]}]}),
            ),
            (
                "frontier",
                "book.guided_route_from",
                r#"{"at":"1.1"}"#,
                serde_json::json!({"groups":[{"steps":[{"lid":"1.2"}]}]}),
            ),
            (
                "text",
                "book.text",
                r#"{"lid":"1.2"}"#,
                serde_json::json!({"lid":"1.2","text":"PRIVATE SOURCE BODY"}),
            ),
            (
                "goto",
                "reader.gotoLid",
                r#"{"lid":"1.2"}"#,
                serde_json::json!({"anchor":"1.2"}),
            ),
            (
                "synthesize",
                "book.synthesize",
                r#"{"lids":["1.1","1.2"]}"#,
                serde_json::json!({"citations":[],"answer":"PRIVATE SYNTHESIS"}),
            ),
        ];
        for (id, name, arguments, body) in &fixture {
            messages.push(assistant_call(id, name, arguments));
            messages.push(tool_result(id, body.clone()));
        }
        let final_plan = plan(&messages);
        let trace = fixture
            .iter()
            .enumerate()
            .map(|(index, (_, name, arguments, _))| trace(name, arguments, index + 1))
            .collect::<Vec<_>>();
        let guided_outcome = outcome(
            trace,
            vec![AgentEffect::Goto {
                before_anchor: "1.1".into(),
                after_anchor: "1.2".into(),
            }],
        );
        let plans = vec![first, final_plan];
        let semantic = build_semantic_release_receipt(
            &book,
            ProviderMode::Native,
            "offline-model",
            "guided",
            SemanticReleaseScenario::ExplicitGuidedRead,
            SemanticReleaseLocale::ZhCn,
            prompt,
            &plans,
            &guided_outcome,
        )
        .unwrap();
        let route = build_guided_read_route_replay_receipt(
            &book,
            ProviderMode::Native,
            "offline-model",
            prompt,
            "1.1",
            "1.2",
            &plans,
            &guided_outcome,
        )
        .unwrap();
        (semantic, route)
    }

    fn valid_bundle() -> SemanticReleaseBundle {
        let mut cases = [
            ("overview-zh-1", SemanticReleaseLocale::ZhCn, "总览甲"),
            ("overview-zh-2", SemanticReleaseLocale::ZhCn, "总览乙"),
            ("overview-zh-3", SemanticReleaseLocale::ZhCn, "总览丙"),
            ("overview-en-1", SemanticReleaseLocale::En, "overview alpha"),
            ("overview-en-2", SemanticReleaseLocale::En, "overview beta"),
        ]
        .into_iter()
        .map(|(case_id, locale, prompt)| {
            receipt(
                case_id,
                SemanticReleaseScenario::DocumentOverview,
                locale,
                prompt,
                vec![
                    trace("book.structure", "{}", 1),
                    trace("book.text", r#"{"lid":"1.1"}"#, 2),
                ],
            )
        })
        .collect::<Vec<_>>();
        cases.push(receipt(
            "selection",
            SemanticReleaseScenario::SelectionExplanation,
            SemanticReleaseLocale::En,
            "selection prompt",
            Vec::new(),
        ));
        cases.push(receipt(
            "literal",
            SemanticReleaseScenario::LiteralLocate,
            SemanticReleaseLocale::En,
            "literal prompt",
            vec![trace("book.search_text", r#"{"query":"PRIVATE"}"#, 1)],
        ));
        cases.push(receipt(
            "negated",
            SemanticReleaseScenario::NegatedGuidedOverview,
            SemanticReleaseLocale::ZhCn,
            "negated prompt",
            vec![
                trace("book.structure", "{}", 1),
                trace("book.text", r#"{"lid":"1.1"}"#, 2),
            ],
        ));
        let (guided, guided_read_route) = guided_pair();
        cases.push(guided);
        SemanticReleaseBundle {
            version: SEMANTIC_RELEASE_BUNDLE_VERSION.into(),
            cases,
            guided_read_route,
        }
    }

    #[test]
    fn semantic_release_bundle_is_closed_bounded_private_free_and_offline_verifiable() {
        let bundle = valid_bundle();
        let serialized = serialize_verified_semantic_release_bundle(&bundle).unwrap();
        assert!(serialized.len() <= SEMANTIC_RELEASE_BUNDLE_MAX_BYTES);
        for private in [
            "PRIVATE SOURCE BODY",
            "PRIVATE ANSWER TEXT",
            "PRIVATE PROMPT TEXT",
            "PRIVATE TOOL DESCRIPTION",
            "PRIVATE BOOK TITLE",
            "PRIVATE STRUCTURE SUMMARY",
            "PRIVATE STOP TITLE",
            "model_body",
            "api_key",
            "reader_profile_snapshot",
        ] {
            assert!(!serialized.contains(private), "bundle leaked {private}");
        }
        assert_eq!(
            parse_and_verify_semantic_release_bundle(&serialized).unwrap(),
            bundle
        );
    }

    #[test]
    fn semantic_release_verifier_rejects_wrong_scenario_routes_and_phase_tampering() {
        let mut overview = valid_bundle().cases.remove(0);
        overview.trace.swap(0, 1);
        assert!(verify_semantic_release_receipt(&overview).is_err());

        let mut selection = valid_bundle()
            .cases
            .into_iter()
            .find(|case| case.scenario == SemanticReleaseScenario::SelectionExplanation)
            .unwrap();
        selection.trace.push(SemanticReleaseTraceStep {
            ordinal: 1,
            model_tool_loop: Some(1),
            tool: "book.structure".into(),
            arguments: summarize_arguments("{}"),
            error_code: None,
        });
        selection.first_evidence_planning_tool = Some("book.structure".into());
        selection.phase_transitions = derive_phase_transitions(
            selection.scenario,
            &selection.trace,
            selection.loop_result.answer_present,
        );
        assert!(verify_semantic_release_receipt(&selection).is_err());

        let mut literal = valid_bundle()
            .cases
            .into_iter()
            .find(|case| case.scenario == SemanticReleaseScenario::LiteralLocate)
            .unwrap();
        literal.trace[0].tool = "book.query".into();
        assert!(verify_semantic_release_receipt(&literal).is_err());

        let mut phase = valid_bundle().cases.remove(0);
        phase.phase_transitions.pop();
        assert!(verify_semantic_release_receipt(&phase).is_err());
    }

    #[test]
    fn semantic_release_bundle_requires_unique_bilingual_overviews_and_exact_adjacent_cases() {
        let mut duplicate = valid_bundle();
        duplicate.cases[1].contract.prompt_sha256 =
            duplicate.cases[0].contract.prompt_sha256.clone();
        assert!(verify_semantic_release_bundle(&duplicate).is_err());

        let mut monolingual = valid_bundle();
        for case in &mut monolingual.cases {
            if case.scenario == SemanticReleaseScenario::DocumentOverview {
                case.locale = SemanticReleaseLocale::ZhCn;
            }
        }
        assert!(verify_semantic_release_bundle(&monolingual).is_err());

        let mut missing = valid_bundle();
        missing
            .cases
            .retain(|case| case.scenario != SemanticReleaseScenario::LiteralLocate);
        assert!(verify_semantic_release_bundle(&missing).is_err());
    }

    #[test]
    fn semantic_release_parser_rejects_unknown_sensitive_payload_fields() {
        let mut value = serde_json::to_value(valid_bundle()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("prompt_text".into(), serde_json::json!("secret"));
        assert!(parse_and_verify_semantic_release_bundle(&value.to_string()).is_err());

        let mut nested = serde_json::to_value(valid_bundle()).unwrap();
        nested["cases"][0]["trace"][0]["tool_body"] = serde_json::json!("secret");
        assert!(parse_and_verify_semantic_release_bundle(&nested.to_string()).is_err());
    }

    #[test]
    fn blind_read_count_tracks_provenance_gates_not_authorized_missing_locators() {
        let provenance_block = SemanticReleaseTraceStep {
            ordinal: 1,
            model_tool_loop: Some(1),
            tool: "book.text".into(),
            arguments: summarize_arguments(r#"{"lid":"1.2"}"#),
            error_code: Some("LID_PROVENANCE_REQUIRED".into()),
        };
        let authorized_but_missing = SemanticReleaseTraceStep {
            ordinal: 2,
            model_tool_loop: Some(2),
            tool: "book.text".into(),
            arguments: summarize_arguments(r#"{"lid":"1.2"}"#),
            error_code: Some("LID_NOT_FOUND".into()),
        };

        assert!(is_blind_read(&provenance_block));
        assert!(!is_blind_read(&authorized_but_missing));
    }
}
