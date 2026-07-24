use crate::compaction::{
    COMPACTION_CONSUMPTION_WRAPPER, COMPACTION_DRAFT_SCHEMA_ID, COMPACTION_GENERATION_PROMPT,
};
use crate::{Message, ProviderMode, Role, ToolSpec};
use serde::{Deserialize, Serialize};

pub const MODEL_RUNTIME_PROFILE_VERSION: &str = "model_runtime_profile.v1";
pub const AGENT_REQUEST_PLAN_VERSION: &str = "agent_request_plan.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderToolProtocol {
    Native,
    ReAct,
}

impl From<ProviderMode> for ProviderToolProtocol {
    fn from(value: ProviderMode) -> Self {
        match value {
            ProviderMode::Native => Self::Native,
            ProviderMode::ReAct => Self::ReAct,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelSelector {
    Exact(String),
    Prefix(String),
    Default,
}

impl ModelSelector {
    fn match_rank(&self, model: &str) -> Option<(u8, usize)> {
        let model = model.to_ascii_lowercase();
        match self {
            Self::Exact(expected) if model == expected.to_ascii_lowercase() => {
                Some((2, expected.len()))
            }
            Self::Prefix(prefix) if model.starts_with(&prefix.to_ascii_lowercase()) => {
                Some((1, prefix.len()))
            }
            Self::Default => Some((0, 0)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelProfileResolution {
    ExplicitOverride,
    CatalogMatch,
    DefaultFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionAsset {
    pub asset_id: String,
    pub revision: String,
    /// `None` means that this profile inherits the session's canonical base instructions.
    pub text_override: Option<String>,
}

impl InstructionAsset {
    pub fn inherited(asset_id: impl Into<String>) -> Self {
        Self {
            asset_id: asset_id.into(),
            revision: "v1".into(),
            text_override: None,
        }
    }

    pub fn inline(asset_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            asset_id: asset_id.into(),
            revision: "v1".into(),
            text_override: Some(text.into()),
        }
    }

    pub(crate) fn resolve(&self, inherited: &str) -> String {
        self.text_override
            .clone()
            .unwrap_or_else(|| inherited.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionModule {
    pub asset_id: String,
    pub revision: String,
    pub text: String,
}

impl InstructionModule {
    pub fn new(
        asset_id: impl Into<String>,
        revision: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            asset_id: asset_id.into(),
            revision: revision.into(),
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionAssetRef {
    pub asset_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolTruncationPolicy {
    PreserveCurrentBodies,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactionProfile {
    pub prompt_asset: InstructionAsset,
    pub consumption_wrapper_asset: InstructionAsset,
    pub output_schema_id: String,
    pub high_watermark_ratio: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRuntimeProfile {
    pub version: String,
    pub profile_id: String,
    pub matched_model: String,
    pub model_match: ModelSelector,
    pub resolution: ModelProfileResolution,
    pub base_instructions: InstructionAsset,
    pub context_window_tokens: u32,
    pub output_reserve_tokens: u32,
    pub safety_margin_tokens: u32,
    pub supports_native_tools: bool,
    pub supports_continuation: bool,
    pub supports_parallel_tools: bool,
    pub tool_schema_budget_bytes: usize,
    pub truncation_policy: ToolTruncationPolicy,
    pub compaction: CompactionProfile,
}

impl ModelRuntimeProfile {
    pub fn fallback(model: impl Into<String>, protocol: ProviderToolProtocol) -> Self {
        let model = model.into();
        Self {
            version: MODEL_RUNTIME_PROFILE_VERSION.into(),
            profile_id: "resident-agent-default-v1".into(),
            matched_model: model,
            model_match: ModelSelector::Default,
            resolution: ModelProfileResolution::DefaultFallback,
            base_instructions: InstructionAsset::inherited("resident-agent.base.v1"),
            context_window_tokens: 128_000,
            output_reserve_tokens: 8_000,
            safety_margin_tokens: 4_000,
            supports_native_tools: protocol == ProviderToolProtocol::Native,
            supports_continuation: false,
            supports_parallel_tools: false,
            tool_schema_budget_bytes: 256 * 1024,
            truncation_policy: ToolTruncationPolicy::PreserveCurrentBodies,
            compaction: CompactionProfile {
                prompt_asset: InstructionAsset::inline(
                    "agent-compaction.generation.v1",
                    COMPACTION_GENERATION_PROMPT,
                ),
                consumption_wrapper_asset: InstructionAsset::inline(
                    "agent-compaction.consumption.v1",
                    COMPACTION_CONSUMPTION_WRAPPER,
                ),
                output_schema_id: COMPACTION_DRAFT_SCHEMA_ID.into(),
                high_watermark_ratio: 0.75,
            },
        }
    }

    fn resolve_for(
        mut self,
        model: &str,
        protocol: ProviderToolProtocol,
        resolution: ModelProfileResolution,
    ) -> Self {
        self.matched_model = model.into();
        self.resolution = resolution;
        if protocol == ProviderToolProtocol::ReAct {
            self.supports_native_tools = false;
            self.supports_parallel_tools = false;
        }
        self
    }
}

#[derive(Debug, Clone)]
pub struct ModelRuntimeCatalog {
    profiles: Vec<ModelRuntimeProfile>,
    fallback: ModelRuntimeProfile,
}

impl Default for ModelRuntimeCatalog {
    fn default() -> Self {
        let mut glm = ModelRuntimeProfile::fallback("glm-5.1", ProviderToolProtocol::Native);
        glm.profile_id = "resident-agent-glm-5.1-v1".into();
        glm.model_match = ModelSelector::Exact("glm-5.1".into());
        glm.base_instructions = InstructionAsset::inherited("resident-agent.glm-5.1.v1");
        glm.supports_parallel_tools = true;

        let mut gpt = ModelRuntimeProfile::fallback("gpt-5", ProviderToolProtocol::Native);
        gpt.profile_id = "resident-agent-gpt-5-v1".into();
        gpt.model_match = ModelSelector::Prefix("gpt-5".into());
        gpt.base_instructions = InstructionAsset::inherited("resident-agent.gpt-5.v1");
        gpt.supports_parallel_tools = true;

        Self {
            profiles: vec![glm, gpt],
            fallback: ModelRuntimeProfile::fallback("unknown-model", ProviderToolProtocol::Native),
        }
    }
}

impl ModelRuntimeCatalog {
    pub fn new(profiles: Vec<ModelRuntimeProfile>, fallback: ModelRuntimeProfile) -> Self {
        Self { profiles, fallback }
    }

    pub fn resolve(
        &self,
        model: &str,
        protocol: ProviderToolProtocol,
        explicit_override: Option<ModelRuntimeProfile>,
    ) -> ModelRuntimeProfile {
        if let Some(profile) = explicit_override {
            return profile.resolve_for(model, protocol, ModelProfileResolution::ExplicitOverride);
        }

        let matched = self
            .profiles
            .iter()
            .filter_map(|profile| {
                profile
                    .model_match
                    .match_rank(model)
                    .map(|rank| (rank, profile))
            })
            .max_by_key(|(rank, _)| *rank)
            .map(|(_, profile)| profile.clone());

        matched
            .unwrap_or_else(|| self.fallback.clone())
            .resolve_for(
                model,
                protocol,
                if self
                    .profiles
                    .iter()
                    .any(|profile| profile.model_match.match_rank(model).is_some())
                {
                    ModelProfileResolution::CatalogMatch
                } else {
                    ModelProfileResolution::DefaultFallback
                },
            )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolChoice {
    Auto,
    None,
}

impl ToolChoice {
    pub fn as_provider_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveContextStatus {
    pub estimated_input_tokens: u32,
    pub context_window_tokens: u32,
    pub output_reserve_tokens: u32,
    pub safety_margin_tokens: u32,
    pub remaining_tokens: i64,
    pub fits: bool,
}

#[derive(Debug, Clone)]
pub struct AgentRequestPlan {
    pub version: String,
    pub runtime_profile: ModelRuntimeProfile,
    pub instructions: String,
    pub instruction_assets: Vec<InstructionAssetRef>,
    pub input: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub tool_choice: ToolChoice,
    pub parallel_tool_calls: bool,
    pub active_context: ActiveContextStatus,
}

impl AgentRequestPlan {
    pub fn for_agent_turn(
        runtime_profile: ModelRuntimeProfile,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Self {
        Self::from_messages(runtime_profile, messages, tools, &[], true)
    }

    pub fn for_agent_turn_with_modules(
        runtime_profile: ModelRuntimeProfile,
        messages: &[Message],
        tools: &[ToolSpec],
        modules: &[InstructionModule],
    ) -> Self {
        Self::from_messages(runtime_profile, messages, tools, modules, true)
    }

    pub fn for_ad_hoc(
        runtime_profile: ModelRuntimeProfile,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Self {
        Self::from_messages(runtime_profile, messages, tools, &[], false)
    }

    fn from_messages(
        runtime_profile: ModelRuntimeProfile,
        messages: &[Message],
        tools: &[ToolSpec],
        modules: &[InstructionModule],
        use_profile_instructions: bool,
    ) -> Self {
        let (inherited_instructions, input) = match messages.first() {
            Some(message) if message.role == Role::System => (
                message.content.clone().unwrap_or_default(),
                messages[1..].to_vec(),
            ),
            _ => (String::new(), messages.to_vec()),
        };
        let mut instruction_assets = Vec::with_capacity(modules.len() + 1);
        let mut instructions = if use_profile_instructions {
            instruction_assets.push(InstructionAssetRef {
                asset_id: runtime_profile.base_instructions.asset_id.clone(),
                revision: runtime_profile.base_instructions.revision.clone(),
            });
            runtime_profile
                .base_instructions
                .resolve(&inherited_instructions)
        } else {
            if !inherited_instructions.is_empty() {
                instruction_assets.push(InstructionAssetRef {
                    asset_id: "session.instructions".into(),
                    revision: "v1".into(),
                });
            }
            inherited_instructions
        };
        for module in modules {
            let text = module.text.trim();
            if text.is_empty() {
                continue;
            }
            if !instructions.is_empty() {
                instructions.push_str("\n\n");
            }
            instructions.push_str(text);
            instruction_assets.push(InstructionAssetRef {
                asset_id: module.asset_id.clone(),
                revision: module.revision.clone(),
            });
        }
        let tools = tools.to_vec();
        let tool_choice = if tools.is_empty() {
            ToolChoice::None
        } else {
            ToolChoice::Auto
        };
        let projected_messages = ordered_messages(&instructions, &input);
        let estimated_input_tokens = estimate_request_tokens(&projected_messages, &tools);
        let available = i64::from(runtime_profile.context_window_tokens)
            - i64::from(runtime_profile.output_reserve_tokens)
            - i64::from(runtime_profile.safety_margin_tokens);

        Self {
            version: AGENT_REQUEST_PLAN_VERSION.into(),
            active_context: ActiveContextStatus {
                estimated_input_tokens,
                context_window_tokens: runtime_profile.context_window_tokens,
                output_reserve_tokens: runtime_profile.output_reserve_tokens,
                safety_margin_tokens: runtime_profile.safety_margin_tokens,
                remaining_tokens: available - i64::from(estimated_input_tokens),
                fits: i64::from(estimated_input_tokens) <= available,
            },
            runtime_profile,
            instructions,
            instruction_assets,
            input,
            tools,
            tool_choice,
            parallel_tool_calls: false,
        }
    }

    pub fn ordered_messages(&self) -> Vec<Message> {
        ordered_messages(&self.instructions, &self.input)
    }
}

fn ordered_messages(instructions: &str, input: &[Message]) -> Vec<Message> {
    let mut messages = Vec::with_capacity(input.len() + usize::from(!instructions.is_empty()));
    if !instructions.is_empty() {
        messages.push(Message::system(instructions));
    }
    messages.extend_from_slice(input);
    messages
}

fn estimate_request_tokens(messages: &[Message], tools: &[ToolSpec]) -> u32 {
    let message_payload = serde_json::to_string(messages).unwrap_or_default();
    let tool_payload = serde_json::to_string(
        &tools
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "name": &tool.name,
                    "description": &tool.description,
                    "parameters": &tool.parameters,
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    estimate_text_tokens(&message_payload).saturating_add(estimate_text_tokens(&tool_payload))
}

pub(crate) fn estimate_text_tokens(text: &str) -> u32 {
    let mut estimate = 0.0_f32;
    for character in text.chars() {
        estimate += if character as u32 >= 0x2e80 {
            1.0
        } else {
            0.25
        };
    }
    estimate.ceil() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(
        id: &str,
        selector: ModelSelector,
        instructions: &str,
        context_window_tokens: u32,
    ) -> ModelRuntimeProfile {
        let mut profile = ModelRuntimeProfile::fallback(id, ProviderToolProtocol::Native);
        profile.profile_id = id.into();
        profile.model_match = selector;
        profile.base_instructions =
            InstructionAsset::inline(format!("{id}.instructions"), instructions);
        profile.context_window_tokens = context_window_tokens;
        profile
    }

    #[test]
    fn agent_request_plan_resolves_override_catalog_and_default_in_priority_order() {
        let prefix = profile(
            "prefix-profile",
            ModelSelector::Prefix("model-".into()),
            "prefix instructions",
            64_000,
        );
        let exact = profile(
            "exact-profile",
            ModelSelector::Exact("model-a".into()),
            "exact instructions",
            96_000,
        );
        let fallback = profile(
            "fallback-profile",
            ModelSelector::Default,
            "fallback instructions",
            32_000,
        );
        let catalog = ModelRuntimeCatalog::new(vec![prefix, exact], fallback);

        let exact = catalog.resolve("MODEL-A", ProviderToolProtocol::Native, None);
        assert_eq!(exact.profile_id, "exact-profile");
        assert_eq!(exact.resolution, ModelProfileResolution::CatalogMatch);
        assert_eq!(exact.context_window_tokens, 96_000);

        let prefix = catalog.resolve("model-b", ProviderToolProtocol::Native, None);
        assert_eq!(prefix.profile_id, "prefix-profile");
        assert_eq!(prefix.resolution, ModelProfileResolution::CatalogMatch);

        let fallback = catalog.resolve("other", ProviderToolProtocol::Native, None);
        assert_eq!(fallback.profile_id, "fallback-profile");
        assert_eq!(fallback.resolution, ModelProfileResolution::DefaultFallback);

        let explicit = profile(
            "explicit-profile",
            ModelSelector::Default,
            "explicit instructions",
            48_000,
        );
        let explicit = catalog.resolve("model-a", ProviderToolProtocol::ReAct, Some(explicit));
        assert_eq!(explicit.profile_id, "explicit-profile");
        assert_eq!(
            explicit.resolution,
            ModelProfileResolution::ExplicitOverride
        );
        assert!(!explicit.supports_native_tools);
    }

    #[test]
    fn provider_capabilities_unknown_models_fail_closed_without_guessed_continuation() {
        let catalog = ModelRuntimeCatalog::default();
        let native = catalog.resolve("unknown-future-model", ProviderToolProtocol::Native, None);
        let react = catalog.resolve("unknown-future-model", ProviderToolProtocol::ReAct, None);

        assert_eq!(native.resolution, ModelProfileResolution::DefaultFallback);
        assert_eq!(react.resolution, ModelProfileResolution::DefaultFallback);
        assert!(native.supports_native_tools);
        assert!(!react.supports_native_tools);
        assert!(!native.supports_continuation);
        assert!(!react.supports_continuation);
        assert!(!native.supports_parallel_tools);
        assert!(!react.supports_parallel_tools);
        assert_eq!(
            native.compaction.output_schema_id,
            COMPACTION_DRAFT_SCHEMA_ID
        );
        assert_eq!(
            react.compaction.output_schema_id,
            COMPACTION_DRAFT_SCHEMA_ID
        );
    }

    #[test]
    fn agent_request_plan_projects_instructions_input_tools_and_auto_without_parallelism() {
        let profile = profile(
            "fixture-profile",
            ModelSelector::Default,
            "model-specific instructions",
            32_000,
        );
        let messages = vec![
            Message::system("legacy instructions"),
            Message::system("reader_profile_snapshot.v1 synthetic"),
            Message::user("question"),
        ];
        let tools = vec![ToolSpec {
            name: "book.text".into(),
            description: "read".into(),
            parameters: serde_json::json!({"type": "object"}),
        }];

        let plan = AgentRequestPlan::for_agent_turn(profile, &messages, &tools);

        assert_eq!(plan.version, AGENT_REQUEST_PLAN_VERSION);
        assert_eq!(plan.instructions, "model-specific instructions");
        assert_eq!(plan.input.len(), 2);
        assert_eq!(plan.input[0].role, Role::System);
        assert_eq!(plan.tool_choice, ToolChoice::Auto);
        assert!(!plan.parallel_tool_calls);
        assert_eq!(plan.tools.len(), 1);
        assert_eq!(
            plan.ordered_messages()[0].content.as_deref(),
            Some("model-specific instructions")
        );
        assert!(plan.active_context.estimated_input_tokens > 0);
        assert!(plan.active_context.fits);
    }

    #[test]
    fn agent_tool_policy_request_plan_tracks_versioned_modules_and_explicit_auto_choice() {
        let profile = profile(
            "fixture-profile",
            ModelSelector::Default,
            "base instructions",
            32_000,
        );
        let tools = vec![ToolSpec {
            name: "book.text".into(),
            description: "read".into(),
            parameters: serde_json::json!({"type": "object"}),
        }];
        let modules = vec![InstructionModule::new(
            "resident-agent.policy.evidence-routing",
            "v7",
            "evidence routing",
        )];

        let plan = AgentRequestPlan::for_agent_turn_with_modules(
            profile,
            &[Message::system("legacy"), Message::user("question")],
            &tools,
            &modules,
        );

        assert_eq!(plan.tool_choice, ToolChoice::Auto);
        assert_eq!(plan.instructions, "base instructions\n\nevidence routing");
        assert_eq!(
            plan.instruction_assets,
            vec![
                InstructionAssetRef {
                    asset_id: "fixture-profile.instructions".into(),
                    revision: "v1".into(),
                },
                InstructionAssetRef {
                    asset_id: "resident-agent.policy.evidence-routing".into(),
                    revision: "v7".into(),
                },
            ]
        );
    }
}
