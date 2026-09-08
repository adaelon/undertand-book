//! Linux reader service model calls stop at the next request boundary.
use runtime::memory_review::{ProviderReviewExecutorFactory, ReviewExecutor, ReviewExecutorFactory};
use runtime::{AdapterError, AgentRequestPlan, AssistantTurn, CompletionRequest, ModelAdapter,
    ModelRuntimeProfile, ParsedResponse, ProviderConfig, ProviderRegistry};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

pub(crate) const SERVICE_PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) struct ServiceAdapter {
    inner: Box<dyn ModelAdapter + Send>,
    stop: Arc<AtomicBool>,
}

impl ServiceAdapter {
    pub(crate) fn from_config(config: ProviderConfig, stop: Arc<AtomicBool>) -> Box<dyn ModelAdapter + Send> {
        Box::new(Self { inner: ProviderRegistry::adapter_from_config_with_timeout(config, SERVICE_PROVIDER_TIMEOUT), stop })
    }
    fn check_running(&self) -> Result<(), AdapterError> {
        if self.stop.load(Ordering::Acquire) {
            Err(AdapterError { message: "Reader service is stopping".into() })
        } else { Ok(()) }
    }
}

impl ModelAdapter for ServiceAdapter {
    fn complete(&self, request: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        self.check_running()?;
        self.inner.complete(request)
    }
    fn complete_structured(&self, request: CompletionRequest) -> Result<serde_json::Value, AdapterError> {
        self.check_running()?;
        self.inner.complete_structured(request)
    }
    fn chat(&self, request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
        self.check_running()?;
        self.inner.chat(request)
    }
    fn model_runtime_profile(&self) -> ModelRuntimeProfile { self.inner.model_runtime_profile() }
}

pub(crate) struct ServiceReviewFactory(pub Arc<AtomicBool>);
impl ReviewExecutorFactory for ServiceReviewFactory {
    fn create(&self, config: &ProviderConfig) -> Box<dyn ReviewExecutor> {
        ProviderReviewExecutorFactory::with_adapter(ServiceAdapter::from_config(config.clone(), self.0.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_prevents_further_provider_requests() {
        let stop = Arc::new(AtomicBool::new(true));
        let adapter = ServiceAdapter { inner: Box::new(crate::UnconfiguredAdapter), stop };
        let error = adapter.complete_structured(CompletionRequest { system: String::new(), user: String::new() }).unwrap_err();
        assert_eq!(error.message, "Reader service is stopping");
    }

    #[test]
    fn inflight_http_finishes_then_stop_rejects_the_next_call() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (entered, received) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let provider = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).unwrap(); request.push(byte[0]); }
            let headers = String::from_utf8_lossy(&request);
            let length: usize = headers.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
            socket.read_exact(&mut vec![0; length]).unwrap();
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = r#"{"choices":[{"message":{"content":"{\"ok\":true}"}}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let stop = Arc::new(AtomicBool::new(false));
        let config = ProviderConfig::from_values("native", "test-key", format!("http://{address}"), "test-model").unwrap();
        let adapter = ServiceAdapter::from_config(config, stop.clone());
        let request = CompletionRequest { system: "test".into(), user: "test".into() };
        let worker = std::thread::spawn(move || {
            assert_eq!(adapter.complete_structured(request.clone()).unwrap()["ok"], true);
            assert_eq!(adapter.complete_structured(request).unwrap_err().message, "Reader service is stopping");
        });
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        stop.store(true, Ordering::Release);
        release.send(()).unwrap();
        worker.join().unwrap();
        provider.join().unwrap();
    }
}
