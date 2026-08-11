//! Privacy-bounded evidence and deterministic verification for the GR4
//! real-book / real-provider guided-reading release replay.

use crate::model_runtime::AGENT_REQUEST_PLAN_VERSION;
use crate::orchestrator::{AgentEffect, OuterOutcome};
use crate::tool_exposure::{TOOL_EXPOSURE_PLAN_VERSION, TURN_INTENT_CLASSIFIER_VERSION};
use crate::{
    native_chat_request_projection, react_chat_request_projection, AgentRequestPlan, ProviderMode,
    Role,
};
use read_tools::Book;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const GUIDED_READ_ROUTE_REPLAY_VERSION: &str = "guided_read_route_replay.v1";
pub const GUIDED_READ_REPLAY_MAX_BYTES: usize = 64 * 1024;

const NAVIGATION_ASSET_ID: &str = "resident-agent.policy.navigation";
const NAVIGATION_REVISION: &str = "v3";
const MAX_TRACE_STEPS: usize = 64;
const MAX_ROUTE_LIDS: usize = 512;
const MAX_TOOL_NAMES: usize = 128;
const MAX_IDENTIFIER_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum GuidedReadReplayProtocol {
    Native,
    React,
}

impl From<ProviderMode> for GuidedReadReplayProtocol {
    fn from(value: ProviderMode) -> Self {
        match value {
            ProviderMode::Native => Self::Native,
            ProviderMode::ReAct => Self::React,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayBookIdentity {
    pub book_id_sha256: String,
    pub source_sha256: String,
    pub book_structure_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayProviderIdentity {
    pub protocol: GuidedReadReplayProtocol,
    pub model: String,
    pub runtime_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayContractVersions {
    pub prompt_sha256: String,
    pub agent_request_plan_version: String,
    pub tool_exposure_plan_version: String,
    pub turn_intent_classifier_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayAssetRef {
    pub asset_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadRequestProjectionEvidence {
    pub protocol: GuidedReadReplayProtocol,
    pub request_sha256: String,
    pub message_count: usize,
    pub internal_tool_names: Vec<String>,
    pub provider_tool_names: Vec<String>,
    pub native_tools_field: bool,
    pub tools_embedded_in_prompt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayArgumentSummary {
    pub keys: Vec<String>,
    pub lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayTraceStep {
    pub ordinal: usize,
    pub tool: String,
    pub arguments: GuidedReadReplayArgumentSummary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuidedReadReplayEffectKind {
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
pub struct GuidedReadReplayEffectSummary {
    pub kind: GuidedReadReplayEffectKind,
    pub before_anchor: Option<String>,
    pub after_anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadReplayAnswerSummary {
    pub present: bool,
    pub incomplete: bool,
    pub char_count: usize,
    pub answer_sha256: Option<String>,
    pub turns: usize,
}

/// A deliberately closed receipt schema. It has no field capable of carrying
/// prompt text, source text, Tool bodies, API keys, or Reader private memory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuidedReadRouteReplayReceipt {
    pub version: String,
    pub book: GuidedReadReplayBookIdentity,
    pub provider: GuidedReadReplayProviderIdentity,
    pub contract: GuidedReadReplayContractVersions,
    pub start_lid: String,
    pub expected_stop_lid: String,
    pub first_instruction_assets: Vec<GuidedReadReplayAssetRef>,
    pub first_tool_names: Vec<String>,
    pub request_projections: Vec<GuidedReadRequestProjectionEvidence>,
    pub guide_path_lids: Vec<String>,
    pub guided_frontier_lids: Vec<String>,
    pub trace: Vec<GuidedReadReplayTraceStep>,
    pub effects: Vec<GuidedReadReplayEffectSummary>,
    pub answer: GuidedReadReplayAnswerSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuidedReadReplayVerificationError {
    message: String,
}

impl GuidedReadReplayVerificationError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for GuidedReadReplayVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GuidedReadReplayVerificationError {}

/// Build a privacy-bounded receipt from one completed Resident turn. Full Tool
/// results are inspected only in memory to recover route membership; they are
/// never copied into the returned value.
pub fn build_guided_read_route_replay_receipt(
    book: &Book,
    provider_mode: ProviderMode,
    model: &str,
    prompt: &str,
    start_lid: &str,
    expected_stop_lid: &str,
    plans: &[AgentRequestPlan],
    outcome: &OuterOutcome,
) -> Result<GuidedReadRouteReplayReceipt, GuidedReadReplayVerificationError> {
    let first_plan = plans.first().ok_or_else(|| {
        GuidedReadReplayVerificationError::invalid(
            "guided-read replay recorded no AgentRequestPlan",
        )
    })?;
    let (guide_path_lids, guided_frontier_lids) = observed_route_lids(plans);
    let receipt = GuidedReadRouteReplayReceipt {
        version: GUIDED_READ_ROUTE_REPLAY_VERSION.into(),
        book: GuidedReadReplayBookIdentity {
            book_id_sha256: sha256(book.base.book_id.as_bytes()),
            source_sha256: book.source_fingerprint().into(),
            book_structure_available: book.book_structure().is_some(),
        },
        provider: GuidedReadReplayProviderIdentity {
            protocol: provider_mode.into(),
            model: model.into(),
            runtime_profile_id: first_plan.runtime_profile.profile_id.clone(),
        },
        contract: GuidedReadReplayContractVersions {
            prompt_sha256: sha256(prompt.as_bytes()),
            agent_request_plan_version: first_plan.version.clone(),
            tool_exposure_plan_version: TOOL_EXPOSURE_PLAN_VERSION.into(),
            turn_intent_classifier_version: TURN_INTENT_CLASSIFIER_VERSION.into(),
        },
        start_lid: start_lid.into(),
        expected_stop_lid: expected_stop_lid.into(),
        first_instruction_assets: first_plan
            .instruction_assets
            .iter()
            .map(|asset| GuidedReadReplayAssetRef {
                asset_id: asset.asset_id.clone(),
                revision: asset.revision.clone(),
            })
            .collect(),
        first_tool_names: first_plan
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect(),
        request_projections: request_projection_evidence(model, first_plan)?,
        guide_path_lids,
        guided_frontier_lids,
        trace: outcome
            .trace
            .iter()
            .enumerate()
            .map(|(index, step)| GuidedReadReplayTraceStep {
                ordinal: index + 1,
                tool: step.tool.clone(),
                arguments: summarize_arguments(&step.args),
            })
            .collect(),
        effects: outcome.effects.iter().map(summarize_effect).collect(),
        answer: GuidedReadReplayAnswerSummary {
            present: outcome.answer.is_some(),
            incomplete: outcome.incomplete,
            char_count: outcome
                .answer
                .as_deref()
                .map(str::chars)
                .map(Iterator::count)
                .unwrap_or(0),
            answer_sha256: outcome
                .answer
                .as_deref()
                .map(|text| sha256(text.as_bytes())),
            turns: outcome.turns,
        },
    };
    verify_guided_read_route_replay(&receipt)?;
    Ok(receipt)
}

/// Deterministic, network-free verification of a typed replay receipt.
pub fn verify_guided_read_route_replay(
    receipt: &GuidedReadRouteReplayReceipt,
) -> Result<(), GuidedReadReplayVerificationError> {
    let compact = serde_json::to_vec(receipt).map_err(|error| {
        GuidedReadReplayVerificationError::invalid(format!(
            "guided-read replay receipt cannot serialize: {error}"
        ))
    })?;
    if compact.len() > GUIDED_READ_REPLAY_MAX_BYTES {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "guided-read replay receipt exceeds {GUIDED_READ_REPLAY_MAX_BYTES} bytes"
        )));
    }
    reject_forbidden_payload_markers(&compact)?;

    if receipt.version != GUIDED_READ_ROUTE_REPLAY_VERSION {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay version mismatch",
        ));
    }
    require_sha256("book.book_id_sha256", &receipt.book.book_id_sha256)?;
    require_sha256("book.source_sha256", &receipt.book.source_sha256)?;
    if !receipt.book.book_structure_available {
        return Err(GuidedReadReplayVerificationError::invalid(
            "real replay book has no BookStructure sidecar",
        ));
    }
    require_label("provider.model", &receipt.provider.model)?;
    require_label(
        "provider.runtime_profile_id",
        &receipt.provider.runtime_profile_id,
    )?;
    require_sha256("contract.prompt_sha256", &receipt.contract.prompt_sha256)?;
    if receipt.contract.agent_request_plan_version != AGENT_REQUEST_PLAN_VERSION
        || receipt.contract.tool_exposure_plan_version != TOOL_EXPOSURE_PLAN_VERSION
        || receipt.contract.turn_intent_classifier_version != TURN_INTENT_CLASSIFIER_VERSION
    {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay contract versions do not match the runtime",
        ));
    }
    require_lid("start_lid", &receipt.start_lid)?;
    require_lid("expected_stop_lid", &receipt.expected_stop_lid)?;
    if receipt.start_lid == receipt.expected_stop_lid {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay must advance to a different stop",
        ));
    }

    verify_instruction_assets(&receipt.first_instruction_assets)?;
    verify_first_tool_surface(&receipt.first_tool_names)?;
    verify_request_projections(receipt)?;
    verify_route_membership(receipt)?;
    verify_trace_and_effects(receipt)?;
    verify_answer(&receipt.answer)?;
    Ok(())
}

/// Parse a closed receipt schema and immediately run the offline verifier.
pub fn parse_and_verify_guided_read_route_replay(
    input: &str,
) -> Result<GuidedReadRouteReplayReceipt, GuidedReadReplayVerificationError> {
    if input.len() > GUIDED_READ_REPLAY_MAX_BYTES {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "guided-read replay input exceeds {GUIDED_READ_REPLAY_MAX_BYTES} bytes"
        )));
    }
    let receipt = serde_json::from_str::<GuidedReadRouteReplayReceipt>(input).map_err(|error| {
        GuidedReadReplayVerificationError::invalid(format!(
            "guided-read replay receipt schema is invalid: {error}"
        ))
    })?;
    verify_guided_read_route_replay(&receipt)?;
    Ok(receipt)
}

pub fn serialize_verified_guided_read_route_replay(
    receipt: &GuidedReadRouteReplayReceipt,
) -> Result<String, GuidedReadReplayVerificationError> {
    verify_guided_read_route_replay(receipt)?;
    let serialized = serde_json::to_string_pretty(receipt).map_err(|error| {
        GuidedReadReplayVerificationError::invalid(format!(
            "guided-read replay receipt cannot serialize: {error}"
        ))
    })?;
    if serialized.len() > GUIDED_READ_REPLAY_MAX_BYTES {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "pretty guided-read replay receipt exceeds {GUIDED_READ_REPLAY_MAX_BYTES} bytes"
        )));
    }
    Ok(serialized)
}

fn request_projection_evidence(
    model: &str,
    plan: &AgentRequestPlan,
) -> Result<Vec<GuidedReadRequestProjectionEvidence>, GuidedReadReplayVerificationError> {
    let internal_tool_names = plan
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();

    let (native, _) = native_chat_request_projection(model, plan);
    let native_bytes = serde_json::to_vec(&native).map_err(|error| {
        GuidedReadReplayVerificationError::invalid(format!(
            "native request projection cannot serialize: {error}"
        ))
    })?;
    let native_provider_names = native["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();

    let react = react_chat_request_projection(model, plan);
    let react_bytes = serde_json::to_vec(&react).map_err(|error| {
        GuidedReadReplayVerificationError::invalid(format!(
            "ReAct request projection cannot serialize: {error}"
        ))
    })?;
    Ok(vec![
        GuidedReadRequestProjectionEvidence {
            protocol: GuidedReadReplayProtocol::Native,
            request_sha256: sha256(&native_bytes),
            message_count: native["messages"].as_array().map(Vec::len).unwrap_or(0),
            internal_tool_names: internal_tool_names.clone(),
            provider_tool_names: native_provider_names,
            native_tools_field: native.get("tools").is_some(),
            tools_embedded_in_prompt: false,
        },
        GuidedReadRequestProjectionEvidence {
            protocol: GuidedReadReplayProtocol::React,
            request_sha256: sha256(&react_bytes),
            message_count: react["messages"].as_array().map(Vec::len).unwrap_or(0),
            internal_tool_names: internal_tool_names.clone(),
            provider_tool_names: internal_tool_names,
            native_tools_field: react.get("tools").is_some(),
            tools_embedded_in_prompt: true,
        },
    ])
}

fn observed_route_lids(plans: &[AgentRequestPlan]) -> (Vec<String>, Vec<String>) {
    let mut call_tools = BTreeMap::new();
    for plan in plans {
        for message in &plan.input {
            for call in &message.tool_calls {
                call_tools.insert(call.id.clone(), call.name.clone());
            }
        }
    }

    let mut guide_path_lids = BTreeSet::new();
    let mut guided_frontier_lids = BTreeSet::new();
    for plan in plans {
        for message in &plan.input {
            if message.role != Role::Tool {
                continue;
            }
            let Some(call_id) = message.tool_call_id.as_deref() else {
                continue;
            };
            let Some(tool) = call_tools.get(call_id) else {
                continue;
            };
            let target = match tool.as_str() {
                "book.guide_path" => &mut guide_path_lids,
                "book.guided_route_from" => &mut guided_frontier_lids,
                _ => continue,
            };
            let Some(content) = message.content.as_deref() else {
                continue;
            };
            let Ok(envelope) = serde_json::from_str::<serde_json::Value>(content) else {
                continue;
            };
            let Some(model_body) = envelope.get("model_body").filter(|value| !value.is_null())
            else {
                continue;
            };
            collect_lid_fields(model_body, target);
        }
    }
    (
        guide_path_lids.into_iter().collect(),
        guided_frontier_lids.into_iter().collect(),
    )
}

fn collect_lid_fields(value: &serde_json::Value, output: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if is_lid_field(key) {
                    collect_string_values(child, output);
                }
                collect_lid_fields(child, output);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_lid_fields(item, output);
            }
        }
        _ => {}
    }
}

fn collect_string_values(value: &serde_json::Value, output: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::String(value) => {
            output.insert(value.clone());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_string_values(item, output);
            }
        }
        _ => {}
    }
}

fn is_lid_field(key: &str) -> bool {
    matches!(key, "lid" | "lids") || key.ends_with("_lid") || key.ends_with("_lids")
}

fn summarize_arguments(arguments: &str) -> GuidedReadReplayArgumentSummary {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(arguments) else {
        return GuidedReadReplayArgumentSummary {
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
    GuidedReadReplayArgumentSummary {
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

fn summarize_effect(effect: &AgentEffect) -> GuidedReadReplayEffectSummary {
    match effect {
        AgentEffect::Goto {
            before_anchor,
            after_anchor,
        } => GuidedReadReplayEffectSummary {
            kind: GuidedReadReplayEffectKind::Goto,
            before_anchor: Some(before_anchor.clone()),
            after_anchor: Some(after_anchor.clone()),
        },
        AgentEffect::Highlight { .. } => {
            effect_without_payload(GuidedReadReplayEffectKind::Highlight)
        }
        AgentEffect::Note { .. } => effect_without_payload(GuidedReadReplayEffectKind::Note),
        AgentEffect::Layout { .. } => effect_without_payload(GuidedReadReplayEffectKind::Layout),
        AgentEffect::LayoutProposal { .. } => {
            effect_without_payload(GuidedReadReplayEffectKind::LayoutProposal)
        }
        AgentEffect::PaperMinimap { .. } => {
            effect_without_payload(GuidedReadReplayEffectKind::PaperMinimap)
        }
        AgentEffect::PaperMinimapProposal { .. } => {
            effect_without_payload(GuidedReadReplayEffectKind::PaperMinimapProposal)
        }
    }
}

fn effect_without_payload(kind: GuidedReadReplayEffectKind) -> GuidedReadReplayEffectSummary {
    GuidedReadReplayEffectSummary {
        kind,
        before_anchor: None,
        after_anchor: None,
    }
}

fn verify_instruction_assets(
    assets: &[GuidedReadReplayAssetRef],
) -> Result<(), GuidedReadReplayVerificationError> {
    if assets.is_empty() || assets.len() > 32 {
        return Err(GuidedReadReplayVerificationError::invalid(
            "first instruction asset set is empty or unbounded",
        ));
    }
    for asset in assets {
        require_toolish_identifier("instruction asset id", &asset.asset_id)?;
        require_toolish_identifier("instruction asset revision", &asset.revision)?;
    }
    let navigation = assets
        .iter()
        .filter(|asset| asset.asset_id == NAVIGATION_ASSET_ID)
        .collect::<Vec<_>>();
    if navigation.len() != 1 || navigation[0].revision != NAVIGATION_REVISION {
        return Err(GuidedReadReplayVerificationError::invalid(
            "first request must contain exactly one resident navigation@v3 asset",
        ));
    }
    Ok(())
}

fn verify_first_tool_surface(tools: &[String]) -> Result<(), GuidedReadReplayVerificationError> {
    if tools.is_empty() || tools.len() > MAX_TOOL_NAMES {
        return Err(GuidedReadReplayVerificationError::invalid(
            "first tool surface is empty or unbounded",
        ));
    }
    let mut unique = BTreeSet::new();
    for tool in tools {
        require_toolish_identifier("first tool name", tool)?;
        if !unique.insert(tool.as_str()) {
            return Err(GuidedReadReplayVerificationError::invalid(
                "first tool surface contains duplicates",
            ));
        }
        if is_private_or_forbidden_tool(tool) {
            return Err(GuidedReadReplayVerificationError::invalid(format!(
                "first tool surface contains forbidden tool {tool}"
            )));
        }
    }
    for required in [
        "book.structure",
        "book.guide_path",
        "book.guided_route_from",
        "reader.state",
        "reader.gotoLid",
        "book.synthesize",
    ] {
        if !unique.contains(required) {
            return Err(GuidedReadReplayVerificationError::invalid(format!(
                "first tool surface is missing {required}"
            )));
        }
    }
    Ok(())
}

fn verify_request_projections(
    receipt: &GuidedReadRouteReplayReceipt,
) -> Result<(), GuidedReadReplayVerificationError> {
    if receipt.request_projections.len() != 2 {
        return Err(GuidedReadReplayVerificationError::invalid(
            "replay must retain exactly Native and ReAct projection evidence",
        ));
    }
    let mut protocols = BTreeSet::new();
    for projection in &receipt.request_projections {
        if !protocols.insert(projection.protocol) {
            return Err(GuidedReadReplayVerificationError::invalid(
                "request projection protocol is duplicated",
            ));
        }
        require_sha256("request projection digest", &projection.request_sha256)?;
        if projection.message_count == 0 || projection.message_count > 256 {
            return Err(GuidedReadReplayVerificationError::invalid(
                "request projection message count is invalid",
            ));
        }
        if projection.internal_tool_names != receipt.first_tool_names {
            return Err(GuidedReadReplayVerificationError::invalid(
                "request projection tool surface differs from first AgentRequestPlan",
            ));
        }
        if projection.provider_tool_names.len() != receipt.first_tool_names.len() {
            return Err(GuidedReadReplayVerificationError::invalid(
                "provider request projection lost tool names",
            ));
        }
        for tool in projection
            .internal_tool_names
            .iter()
            .chain(projection.provider_tool_names.iter())
        {
            require_toolish_identifier("projection tool name", tool)?;
            if tool == "book_guide" {
                return Err(GuidedReadReplayVerificationError::invalid(
                    "book_guide leaked into request projection evidence",
                ));
            }
        }
        match projection.protocol {
            GuidedReadReplayProtocol::Native
                if projection.native_tools_field && !projection.tools_embedded_in_prompt => {}
            GuidedReadReplayProtocol::React
                if !projection.native_tools_field && projection.tools_embedded_in_prompt => {}
            _ => {
                return Err(GuidedReadReplayVerificationError::invalid(
                    "request projection evidence has the wrong protocol shape",
                ));
            }
        }
    }
    if protocols
        != BTreeSet::from([
            GuidedReadReplayProtocol::Native,
            GuidedReadReplayProtocol::React,
        ])
        || !protocols.contains(&receipt.provider.protocol)
    {
        return Err(GuidedReadReplayVerificationError::invalid(
            "Native/ReAct projection evidence is incomplete",
        ));
    }
    Ok(())
}

fn verify_route_membership(
    receipt: &GuidedReadRouteReplayReceipt,
) -> Result<(), GuidedReadReplayVerificationError> {
    verify_lid_set("guide_path_lids", &receipt.guide_path_lids)?;
    verify_lid_set("guided_frontier_lids", &receipt.guided_frontier_lids)?;
    if !receipt
        .guide_path_lids
        .iter()
        .any(|lid| lid == &receipt.expected_stop_lid)
    {
        return Err(GuidedReadReplayVerificationError::invalid(
            "observed book.guide_path does not contain the expected stop",
        ));
    }
    let route_member = receipt
        .guide_path_lids
        .iter()
        .chain(receipt.guided_frontier_lids.iter())
        .any(|lid| lid == &receipt.expected_stop_lid);
    if !route_member {
        return Err(GuidedReadReplayVerificationError::invalid(
            "expected stop is not a member of an observed route",
        ));
    }
    Ok(())
}

fn verify_trace_and_effects(
    receipt: &GuidedReadRouteReplayReceipt,
) -> Result<(), GuidedReadReplayVerificationError> {
    if receipt.trace.is_empty() || receipt.trace.len() > MAX_TRACE_STEPS {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read trace is empty or unbounded",
        ));
    }
    for (index, step) in receipt.trace.iter().enumerate() {
        if step.ordinal != index + 1 {
            return Err(GuidedReadReplayVerificationError::invalid(
                "guided-read trace ordinals are not contiguous",
            ));
        }
        require_toolish_identifier("trace tool", &step.tool)?;
        if is_private_or_forbidden_tool(&step.tool) {
            return Err(GuidedReadReplayVerificationError::invalid(format!(
                "guided-read trace contains forbidden tool {}",
                step.tool
            )));
        }
        if step.arguments.keys.len() > 32 || step.arguments.lids.len() > 32 {
            return Err(GuidedReadReplayVerificationError::invalid(
                "trace argument summary is unbounded",
            ));
        }
        for key in &step.arguments.keys {
            require_toolish_identifier("trace argument key", key)?;
        }
        for lid in &step.arguments.lids {
            require_lid("trace argument lid", lid)?;
        }
    }

    let index_of = |tool: &str| receipt.trace.iter().position(|step| step.tool == tool);
    let state = required_index(index_of("reader.state"), "reader.state")?;
    let structure = required_index(index_of("book.structure"), "book.structure")?;
    let guide = required_index(index_of("book.guide_path"), "book.guide_path")?;
    let goto_steps = receipt
        .trace
        .iter()
        .enumerate()
        .filter(|(_, step)| step.tool == "reader.gotoLid")
        .collect::<Vec<_>>();
    if goto_steps.len() != 1 {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read trace must contain exactly one reader.gotoLid",
        ));
    }
    let (goto, goto_step) = goto_steps[0];
    if !goto_step
        .arguments
        .lids
        .iter()
        .any(|lid| lid == &receipt.expected_stop_lid)
    {
        return Err(GuidedReadReplayVerificationError::invalid(
            "reader.gotoLid does not target the expected route member",
        ));
    }
    let candidate = receipt.trace.iter().enumerate().find(|(index, step)| {
        *index > guide
            && *index < goto
            && matches!(step.tool.as_str(), "book.text" | "book.context")
            && step
                .arguments
                .lids
                .iter()
                .any(|lid| lid == &receipt.expected_stop_lid)
    });
    if candidate.is_none() {
        return Err(GuidedReadReplayVerificationError::invalid(
            "expected stop was not checked with book.text/context before goto",
        ));
    }
    let synthesize_steps = receipt
        .trace
        .iter()
        .enumerate()
        .filter(|(_, step)| step.tool == "book.synthesize")
        .collect::<Vec<_>>();
    if synthesize_steps.len() != 1 || synthesize_steps[0].0 <= goto {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read trace must synthesize exactly once after goto",
        ));
    }
    let synthesized = synthesize_steps[0]
        .1
        .arguments
        .lids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let expected = BTreeSet::from([receipt.start_lid.clone(), receipt.expected_stop_lid.clone()]);
    if synthesized != expected {
        return Err(GuidedReadReplayVerificationError::invalid(
            "book.synthesize must cover exactly the current and new stop",
        ));
    }
    if !(state < structure && structure < guide && guide < goto && goto < synthesize_steps[0].0) {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read trace violates state -> structure -> guide -> goto -> synthesize order",
        ));
    }

    if receipt.effects.len() != 1 {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay must contain exactly one effect",
        ));
    }
    let effect = &receipt.effects[0];
    if effect.kind != GuidedReadReplayEffectKind::Goto
        || effect.before_anchor.as_deref() != Some(receipt.start_lid.as_str())
        || effect.after_anchor.as_deref() != Some(receipt.expected_stop_lid.as_str())
    {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay effect is not the expected single merged Goto",
        ));
    }
    Ok(())
}

fn verify_answer(
    answer: &GuidedReadReplayAnswerSummary,
) -> Result<(), GuidedReadReplayVerificationError> {
    if !answer.present || answer.incomplete || answer.char_count == 0 || answer.turns == 0 {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay did not complete with a bounded final answer",
        ));
    }
    let Some(digest) = answer.answer_sha256.as_deref() else {
        return Err(GuidedReadReplayVerificationError::invalid(
            "guided-read replay answer digest is missing",
        ));
    };
    require_sha256("answer.answer_sha256", digest)
}

fn verify_lid_set(field: &str, lids: &[String]) -> Result<(), GuidedReadReplayVerificationError> {
    if lids.len() > MAX_ROUTE_LIDS {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "{field} exceeds {MAX_ROUTE_LIDS} entries"
        )));
    }
    let mut unique = BTreeSet::new();
    for lid in lids {
        require_lid(field, lid)?;
        if !unique.insert(lid) {
            return Err(GuidedReadReplayVerificationError::invalid(format!(
                "{field} contains duplicate LIDs"
            )));
        }
    }
    Ok(())
}

fn required_index(
    value: Option<usize>,
    tool: &str,
) -> Result<usize, GuidedReadReplayVerificationError> {
    value.ok_or_else(|| {
        GuidedReadReplayVerificationError::invalid(format!("guided-read trace is missing {tool}"))
    })
}

fn is_private_or_forbidden_tool(tool: &str) -> bool {
    tool == "book_guide"
        || tool.starts_with("memory.")
        || tool.starts_with("profile.")
        || tool.starts_with("artifact.")
        || matches!(
            tool,
            "reader.scroll"
                | "reader.highlight"
                | "reader.note"
                | "reader.layout.apply"
                | "reader.paper_minimap.apply"
        )
}

fn require_sha256(field: &str, value: &str) -> Result<(), GuidedReadReplayVerificationError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "{field} is not a SHA-256 hex digest"
        )));
    }
    Ok(())
}

fn require_label(field: &str, value: &str) -> Result<(), GuidedReadReplayVerificationError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(char::is_control)
        || value.trim() != value
    {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "{field} is empty, unbounded, or contains control whitespace"
        )));
    }
    Ok(())
}

fn require_toolish_identifier(
    field: &str,
    value: &str,
) -> Result<(), GuidedReadReplayVerificationError> {
    require_label(field, value)?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "{field} contains non-identifier characters"
        )));
    }
    Ok(())
}

fn require_lid(field: &str, value: &str) -> Result<(), GuidedReadReplayVerificationError> {
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(GuidedReadReplayVerificationError::invalid(format!(
            "{field} contains an invalid LID"
        )));
    }
    Ok(())
}

fn reject_forbidden_payload_markers(
    serialized: &[u8],
) -> Result<(), GuidedReadReplayVerificationError> {
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
            return Err(GuidedReadReplayVerificationError::invalid(format!(
                "guided-read replay receipt contains forbidden payload marker {marker}"
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
    use crate::model_runtime::{InstructionModule, ModelRuntimeProfile, ProviderToolProtocol};
    use crate::orchestrator::{ProfileUsageTrace, TraceStep};
    use crate::{Message, ToolCall, ToolSpec};
    use base_schema::{LidNode, NodeKind, ReadOnlyBase, Span};
    use read_tools::{
        AnchoredText, BookStructureKeyStop, BookStructureKeyStopType, BookStructureSidecar,
        BookStructureSpineRole, BookStructureSpineUnit, ProfileArtifactHeader,
    };

    fn replay_book() -> Book {
        let base = ReadOnlyBase {
            book_id: "private-book-title".into(),
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
                book_id: "private-book-title".into(),
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
                    text: "private structure summary".into(),
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
                title: Some("private stop title".into()),
                reason: AnchoredText {
                    text: "private stop reason".into(),
                    evidence_lids: vec!["1.2".into()],
                },
            }],
        }))
    }

    fn tools() -> Vec<ToolSpec> {
        [
            "book.query",
            "book.synthesize",
            "book.search_text",
            "book.text",
            "book.context",
            "book.structure",
            "book.guide_path",
            "book.guided_route_from",
            "reader.gotoLid",
            "reader.state",
        ]
        .into_iter()
        .map(|name| ToolSpec {
            name: name.into(),
            description: "bounded test schema".into(),
            parameters: serde_json::json!({"type":"object"}),
        })
        .collect()
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

    fn trace(tool: &str, args: &str) -> TraceStep {
        TraceStep {
            tool: tool.into(),
            args: args.into(),
            result_digest: "PRIVATE TOOL BODY".into(),
            query_audit: None,
        }
    }

    fn valid_receipt() -> GuidedReadRouteReplayReceipt {
        let book = replay_book();
        let profile = ModelRuntimeProfile::fallback("offline-model", ProviderToolProtocol::Native);
        let modules = vec![InstructionModule::new(
            NAVIGATION_ASSET_ID,
            NAVIGATION_REVISION,
            "private navigation prompt",
        )];
        let first = AgentRequestPlan::for_agent_turn_with_modules(
            profile.clone(),
            &[
                Message::system("private base prompt"),
                Message::user("带我读 1.1"),
            ],
            &tools(),
            &modules,
        );
        let mut messages = vec![
            Message::system("private base prompt"),
            Message::user("带我读 1.1"),
        ];
        for (id, name, arguments, body) in [
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
                serde_json::json!({"answer":"PRIVATE SYNTHESIS BODY"}),
            ),
        ] {
            messages.push(assistant_call(id, name, arguments));
            messages.push(tool_result(id, body));
        }
        let final_plan =
            AgentRequestPlan::for_agent_turn_with_modules(profile, &messages, &tools(), &modules);
        let outcome = OuterOutcome {
            answer: Some("PRIVATE ANSWER BODY".into()),
            answer_view: None,
            incomplete: false,
            warning: None,
            turns: 8,
            tokens_spent: 80,
            effects: vec![AgentEffect::Goto {
                before_anchor: "1.1".into(),
                after_anchor: "1.2".into(),
            }],
            trace: vec![
                trace("reader.state", "{}"),
                trace("book.structure", r#"{"at":"1.1"}"#),
                trace("book.guide_path", r#"{"at":"1.1"}"#),
                trace("book.guided_route_from", r#"{"at":"1.1"}"#),
                trace("book.text", r#"{"lid":"1.2"}"#),
                trace("reader.gotoLid", r#"{"lid":"1.2"}"#),
                trace("book.synthesize", r#"{"lids":["1.1","1.2"]}"#),
            ],
            profile_usage: ProfileUsageTrace::default(),
            memory_updates: Vec::new(),
            source_bindings: Vec::new(),
            delivery_diagnostics: None,
            request_audit: AgentRequestAudit::default(),
        };
        build_guided_read_route_replay_receipt(
            &book,
            ProviderMode::Native,
            "offline-model",
            "带我读 1.1",
            "1.1",
            "1.2",
            &[first, final_plan],
            &outcome,
        )
        .unwrap()
    }

    #[test]
    fn replay_builder_emits_bounded_private_free_receipt_and_verifier_accepts() {
        let receipt = valid_receipt();
        let serialized = serialize_verified_guided_read_route_replay(&receipt).unwrap();
        assert!(serialized.len() <= GUIDED_READ_REPLAY_MAX_BYTES);
        for private in [
            "PRIVATE SOURCE BODY",
            "PRIVATE TOOL BODY",
            "PRIVATE ANSWER BODY",
            "PRIVATE SYNTHESIS BODY",
            "private base prompt",
            "private navigation prompt",
            "private-book-title",
            "model_body",
            "api_key",
            "reader_profile_snapshot",
        ] {
            assert!(!serialized.contains(private), "receipt leaked {private}");
        }
        assert_eq!(
            parse_and_verify_guided_read_route_replay(&serialized).unwrap(),
            receipt
        );
    }

    #[test]
    fn replay_verifier_rejects_early_stop_duplicate_goto_and_visitor_tool() {
        let mut early_stop = valid_receipt();
        early_stop.trace = vec![
            trace("book.search_text", r#"{"query":"x"}"#),
            trace("book.text", r#"{"lid":"1.1"}"#),
        ]
        .iter()
        .enumerate()
        .map(|(index, step)| GuidedReadReplayTraceStep {
            ordinal: index + 1,
            tool: step.tool.clone(),
            arguments: summarize_arguments(&step.args),
        })
        .collect();
        assert!(verify_guided_read_route_replay(&early_stop).is_err());

        let mut duplicate_goto = valid_receipt();
        duplicate_goto
            .effects
            .push(duplicate_goto.effects[0].clone());
        assert!(verify_guided_read_route_replay(&duplicate_goto).is_err());

        let mut visitor = valid_receipt();
        visitor.first_tool_names.push("book_guide".into());
        assert!(verify_guided_read_route_replay(&visitor).is_err());
    }

    #[test]
    fn replay_parser_rejects_unknown_sensitive_payload_fields() {
        let receipt = valid_receipt();
        let mut value = serde_json::to_value(receipt).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("api_key".into(), serde_json::json!("secret"));
        assert!(parse_and_verify_guided_read_route_replay(&value.to_string()).is_err());

        let mut nested = serde_json::to_value(valid_receipt()).unwrap();
        nested["trace"][0]["tool_body"] = serde_json::json!("private text");
        assert!(parse_and_verify_guided_read_route_replay(&nested.to_string()).is_err());
    }

    #[test]
    fn replay_verifier_requires_expected_stop_in_observed_guide_path() {
        let mut receipt = valid_receipt();
        receipt.guide_path_lids.retain(|lid| lid != "1.2");
        assert!(verify_guided_read_route_replay(&receipt).is_err());
    }
}
