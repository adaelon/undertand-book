use crate::compaction::{CompactionCheckpoint, CompactionError};
use crate::{AgentRequestPlan, Message};

pub const COMPACTION_FAILED: &str = "COMPACTION_FAILED";
pub const ACTIVE_CONTEXT_EXHAUSTED: &str = "ACTIVE_CONTEXT_EXHAUSTED";
pub const TURN_LIMIT_EXCEEDED: &str = "TURN_LIMIT_EXCEEDED";
pub const LEGACY_CONTEXT_BUDGET_EXCEEDED: &str = "CONTEXT_BUDGET_EXCEEDED";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveContextBudget {
    pub estimated_input_tokens: u32,
    pub reserved_tokens: u32,
    pub pressure_tokens: u32,
    pub high_watermark_tokens: u32,
    pub target_input_tokens: u32,
    pub over_high_watermark: bool,
    pub fits: bool,
}

impl ActiveContextBudget {
    pub fn from_plan(plan: &AgentRequestPlan) -> Self {
        let profile = &plan.runtime_profile;
        let reserved_tokens = profile
            .output_reserve_tokens
            .saturating_add(profile.safety_margin_tokens);
        let pressure_tokens = plan
            .active_context
            .estimated_input_tokens
            .saturating_add(reserved_tokens);
        let ratio = profile.compaction.high_watermark_ratio.clamp(0.0, 1.0);
        let high_watermark_tokens =
            ((profile.context_window_tokens as f64) * f64::from(ratio)).floor() as u32;
        let target_input_tokens = high_watermark_tokens.saturating_sub(reserved_tokens);
        Self {
            estimated_input_tokens: plan.active_context.estimated_input_tokens,
            reserved_tokens,
            pressure_tokens,
            high_watermark_tokens,
            target_input_tokens,
            over_high_watermark: pressure_tokens >= high_watermark_tokens,
            fits: plan.active_context.fits,
        }
    }
}

pub trait CompactionCheckpointSink {
    fn install(
        &mut self,
        checkpoint: &CompactionCheckpoint,
        raw_messages: &[Message],
    ) -> Result<(), CompactionError>;
}

#[derive(Debug, Default)]
pub struct EphemeralCompactionCheckpointSink {
    pub installed: Option<CompactionCheckpoint>,
}

impl CompactionCheckpointSink for EphemeralCompactionCheckpointSink {
    fn install(
        &mut self,
        checkpoint: &CompactionCheckpoint,
        _raw_messages: &[Message],
    ) -> Result<(), CompactionError> {
        self.installed = Some(checkpoint.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_runtime::{ModelRuntimeProfile, ProviderToolProtocol};

    #[test]
    fn active_context_budget_uses_current_request_and_reserves_not_cumulative_usage() {
        let mut profile =
            ModelRuntimeProfile::fallback("budget-fixture", ProviderToolProtocol::Native);
        profile.context_window_tokens = 1_000;
        profile.output_reserve_tokens = 100;
        profile.safety_margin_tokens = 50;
        profile.compaction.high_watermark_ratio = 0.75;
        let messages = vec![Message::user("x".repeat(2_500))];
        let plan = AgentRequestPlan::for_agent_turn(profile, &messages, &[]);
        let budget = ActiveContextBudget::from_plan(&plan);
        assert_eq!(budget.reserved_tokens, 150);
        assert_eq!(budget.high_watermark_tokens, 750);
        assert_eq!(budget.target_input_tokens, 600);
        assert!(budget.over_high_watermark);
        assert!(budget.fits);
    }
}
