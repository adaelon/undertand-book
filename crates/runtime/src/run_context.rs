//! Turn-owned data and the operation-scoped authoritative Reader/Memory port.
use crate::{
    orchestrator::{
        AnswerProvenanceLedger, OuterConfig, TurnEvidenceLedger, TurnEvidencePlanLedger,
        TurnLocatorLedger, TurnProgressLedger,
    },
    tool_exposure::ToolExposureState,
    tool_result::ActiveToolResultLedger,
    Message, ModelRuntimeProfile,
};
use memory::MemoryStore;
use reader::Reader;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct CancellationToken {
    requested: Arc<AtomicBool>,
    host_stop: Option<Arc<AtomicBool>>,
}

impl CancellationToken {
    pub fn with_host_stop(host_stop: Arc<AtomicBool>) -> Self {
        Self {
            host_stop: Some(host_stop),
            ..Self::default()
        }
    }
    pub fn cancel(&self) {
        self.requested.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.requested.load(Ordering::Acquire)
            || self
                .host_stop
                .as_ref()
                .is_some_and(|stop| stop.load(Ordering::Acquire))
    }
    pub fn check(&self) -> Result<(), read_tools::ToolError> {
        if self.is_cancelled() {
            Err(read_tools::ToolError {
                error_code: "AGENT_RUN_CANCELLED".into(),
                category: "cancelled".into(),
                message: "Agent run was cancelled".into(),
            })
        } else {
            Ok(())
        }
    }
}

/// Every model purpose (including nested query, compaction and repair) uses this adapter.
pub struct CancellableAdapter<'a> {
    pub inner: &'a dyn crate::ModelAdapter,
    pub cancellation: CancellationToken,
}

impl CancellableAdapter<'_> {
    fn check(&self) -> Result<(), crate::AdapterError> {
        self.cancellation
            .check()
            .map_err(|error| crate::AdapterError {
                message: error.message,
            })
    }
}

impl crate::ModelAdapter for CancellableAdapter<'_> {
    fn stream_text_is_structured(&self) -> bool { self.inner.stream_text_is_structured() }
    fn complete_observed(&self, request: crate::CompletionRequest, observer: &mut dyn crate::provider_stream::ModelObserver) -> Result<crate::ParsedResponse, crate::AdapterError> { self.check()?; let result = self.inner.complete_observed(request, observer); self.check()?; result }

    fn complete_structured_observed(&self, request: crate::CompletionRequest, observer: &mut dyn crate::provider_stream::ModelObserver) -> Result<serde_json::Value, crate::AdapterError> { self.check()?; let result = self.inner.complete_structured_observed(request, observer); self.check()?; result }

    fn chat_observed(&self, request: &crate::AgentRequestPlan, observer: &mut dyn crate::provider_stream::ModelObserver) -> Result<crate::AssistantTurn, crate::AdapterError> { self.check()?; let result = self.inner.chat_observed(request, observer); self.check()?; result }

    fn run_events(&self) -> Option<crate::run_events::RunEvents> { self.inner.run_events() }
    fn set_run_cancellation(&self, cancellation: CancellationToken) {
        self.inner.set_run_cancellation(cancellation);
    }
    fn model_runtime_profile(&self) -> ModelRuntimeProfile {
        self.inner.model_runtime_profile()
    }
    fn complete(
        &self,
        request: crate::CompletionRequest,
    ) -> Result<crate::ParsedResponse, crate::AdapterError> {
        self.check()?;
        let result = self.inner.complete(request);
        self.check()?;
        result
    }
    fn complete_structured(
        &self,
        request: crate::CompletionRequest,
    ) -> Result<serde_json::Value, crate::AdapterError> {
        self.check()?;
        let result = self.inner.complete_structured(request);
        self.check()?;
        result
    }
    fn chat(
        &self,
        request: &crate::AgentRequestPlan,
    ) -> Result<crate::AssistantTurn, crate::AdapterError> {
        self.check()?;
        let result = self.inner.chat(request);
        self.check()?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompletionRequest, ProviderConfig, ProviderRegistry};
    use std::io::Read;

    #[test]
    fn cancelled_native_and_react_transport_do_not_retry_after_connection_loss() {
        for mode in ["native", "react"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let cancellation = CancellationToken::default();
            let stop = cancellation.clone();
            let provider = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let length: usize = String::from_utf8_lossy(&headers)
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse().unwrap())
                    })
                    .unwrap();
                socket.read_exact(&mut vec![0; length]).unwrap();
                stop.cancel();
                drop(socket); // normal supported transport retry trigger, after cancellation
                listener
            });
            let config = ProviderConfig::from_values(
                mode,
                "test-key",
                format!("http://{address}"),
                "test-model",
            )
            .unwrap();
            let adapter = ProviderRegistry::adapter_from_config_with_timeout(
                config,
                std::time::Duration::from_secs(2),
            );
            adapter.set_run_cancellation(cancellation);
            let error = adapter
                .complete(CompletionRequest {
                    system: "test".into(),
                    user: "test".into(),
                })
                .unwrap_err();
            assert_eq!(error.message, "Agent run was cancelled");
            let listener = provider.join().unwrap();
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock,
                "{mode} retried after cancellation"
            );
        }
    }
}

/// An operation must be deterministic: model calls run after this borrow ends.
pub trait ResidentStatePort {
    fn author_presentation(&mut self, _request: crate::presentation_author::AuthorRequest,
        _bindings: &[crate::orchestrator::SourceBinding], _messages: &[Message],
        _cancellation: &CancellationToken) -> Result<crate::presentation_author::AuthorResult, read_tools::ToolError> {
        Err(crate::presentation_author::unavailable())
    }

    fn with_state<R>(&mut self, operation: impl FnOnce(&mut MemoryStore, &mut Reader) -> R) -> R;
}

pub struct BorrowedResidentState<'a> {
    pub store: &'a mut MemoryStore,
    pub reader: &'a mut Reader,
}

impl ResidentStatePort for BorrowedResidentState<'_> {
    fn with_state<R>(&mut self, operation: impl FnOnce(&mut MemoryStore, &mut Reader) -> R) -> R {
        operation(self.store, self.reader)
    }
}

pub struct RunContext {
    pub(crate) presentation_images: Vec<crate::presentation_author::PreviewImage>,
    pub(crate) pending_preview: Option<String>,
    pub(crate) inspected_presentations: std::collections::HashSet<String>,
    pub(crate) delivered_presentations: Vec<crate::presentation::PresentationRef>,
    pub messages: Vec<Message>,
    pub config: OuterConfig,
    pub runtime_profile: ModelRuntimeProfile,
    pub cancellation: CancellationToken,
    pub events: crate::run_events::RunEvents,
    pub effects: Vec<crate::orchestrator::AgentEffect>,
    pub trace: Vec<crate::orchestrator::TraceStep>,
    pub navigation: Option<(String, String)>,
    pub(crate) evidence_ledger: TurnEvidenceLedger,
    pub(crate) evidence_plan_ledger: TurnEvidencePlanLedger,
    pub(crate) locator_ledger: TurnLocatorLedger,
    pub(crate) progress_ledger: TurnProgressLedger,
    pub(crate) answer_provenance: AnswerProvenanceLedger,
    pub(crate) tool_exposure_state: ToolExposureState,
    pub(crate) active_tool_results: ActiveToolResultLedger,
}

impl RunContext {
    /// Close the provider protocol for the unexecuted suffix of a cancelled tool batch.
    /// These are cancellation receipts, not executed tools or activity records.
    pub fn close_cancelled_tool_calls(&mut self) {
        let start = self
            .messages
            .iter()
            .rposition(|message| message.role == crate::Role::User)
            .unwrap_or(0);
        let mut pending = Vec::new();
        for message in &self.messages[start..] {
            if message.role == crate::Role::Assistant {
                pending.extend(message.tool_calls.iter().map(|call| call.id.clone()));
            } else if message.role == crate::Role::Tool {
                pending.retain(|id| Some(id) != message.tool_call_id.as_ref());
            }
        }
        for id in pending {
            self.messages.push(Message {
                role: crate::Role::Tool,
                tool_call_id: Some(id),
                tool_calls: Vec::new(),
                content: Some(
                    serde_json::json!({"error_code":"AGENT_RUN_CANCELLED", "category":"cancelled",
                    "message":"Tool was not executed because the run was cancelled"})
                    .to_string(),
                ),
            });
        }
    }

    pub fn new(
        messages: Vec<Message>,
        config: OuterConfig,
        runtime_profile: ModelRuntimeProfile,
    ) -> Self {
        Self {
            presentation_images: Vec::new(),
            pending_preview: None,
            inspected_presentations: Default::default(),
            delivered_presentations: Vec::new(),
            messages,
            config,
            runtime_profile,
            cancellation: Default::default(),
            events: Default::default(),
            effects: Vec::new(),
            trace: Vec::new(),
            navigation: None,
            evidence_ledger: Default::default(),
            evidence_plan_ledger: Default::default(),
            locator_ledger: Default::default(),
            progress_ledger: Default::default(),
            answer_provenance: Default::default(),
            tool_exposure_state: Default::default(),
            active_tool_results: Default::default(),
        }
    }
}
