use crate::{AdapterError, ProviderConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTurnStatus {
    PendingAssistant,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewTurnInput {
    pub turn_id: String,
    pub user_turn_ordinal: u64,
    pub user: String,
    pub assistant_status: ReviewTurnStatus,
    pub assistant_answer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewInput {
    pub job_id: String,
    pub session_id: String,
    pub book_id: String,
    pub from_turn_exclusive: u64,
    pub to_turn_inclusive: u64,
    pub turns: Vec<ReviewTurnInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewExecutionOutput {
    pub value: serde_json::Value,
}

pub trait ReviewExecutor: Send {
    fn execute(&mut self, input: &ReviewInput) -> Result<ReviewExecutionOutput, AdapterError>;
}

pub trait ReviewExecutorFactory: Send + Sync {
    fn create(&self, config: &ProviderConfig) -> Box<dyn ReviewExecutor>;
}

#[derive(Default)]
pub struct UnavailableReviewExecutorFactory;

impl ReviewExecutorFactory for UnavailableReviewExecutorFactory {
    fn create(&self, _config: &ProviderConfig) -> Box<dyn ReviewExecutor> {
        Box::new(UnavailableReviewExecutor)
    }
}

struct UnavailableReviewExecutor;

impl ReviewExecutor for UnavailableReviewExecutor {
    fn execute(&mut self, _input: &ReviewInput) -> Result<ReviewExecutionOutput, AdapterError> {
        Err(AdapterError {
            message: "memory review extractor is not connected until M2.5".into(),
        })
    }
}
