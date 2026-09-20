use super::config::ObservabilityConfig;
use super::queue::{ExportItem, ExportOperation};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportResult {
    Confirmed,
    Retry { after: Duration, code: &'static str },
    AuthenticationRejected,
    Permanent { code: &'static str },
}

pub trait LangSmithTransport: Send + 'static {
    fn send(&mut self, item: &ExportItem, timeout: Duration) -> TransportResult;
}

pub struct HttpLangSmithTransport {
    config: ObservabilityConfig,
    agent: ureq::Agent,
}

impl HttpLangSmithTransport {
    pub fn new(config: ObservabilityConfig) -> Self {
        let timeout = config.request_timeout;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(timeout)
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build();
        Self { config, agent }
    }

    fn url(&self, item: &ExportItem) -> String {
        let base = self.config.endpoint.as_str().trim_end_matches('/');
        match item.operation {
            ExportOperation::Create => format!("{base}/runs"),
            ExportOperation::Update => format!("{base}/runs/{}", item.run_id),
        }
    }
}

impl LangSmithTransport for HttpLangSmithTransport {
    fn send(&mut self, item: &ExportItem, timeout: Duration) -> TransportResult {
        let method = match item.operation {
            ExportOperation::Create => "POST",
            ExportOperation::Update => "PATCH",
        };
        let mut request = self
            .agent
            .request(method, &self.url(item))
            .timeout(timeout)
            .set("content-type", "application/json")
            .set("x-api-key", &self.config.api_key);
        if let Some(workspace_id) = &self.config.workspace_id {
            request = request.set("X-Tenant-Id", workspace_id);
        }
        match request.send_json(item.payload.clone()) {
            Ok(_) => TransportResult::Confirmed,
            Err(ureq::Error::Status(409, _)) if item.operation == ExportOperation::Create => {
                // A retried UUID may already exist after an ambiguous response. Treating the
                // conflict as confirmation preserves dependency order without allocating a new ID.
                TransportResult::Confirmed
            }
            Err(ureq::Error::Status(401 | 403, _)) => TransportResult::AuthenticationRejected,
            Err(ureq::Error::Status(429, response)) => {
                let after = response
                    .header("Retry-After")
                    .and_then(parse_retry_after)
                    .unwrap_or_else(|| Duration::from_millis(100));
                TransportResult::Retry {
                    after,
                    code: "LANGSMITH_RATE_LIMITED",
                }
            }
            Err(ureq::Error::Status(status, _)) if status >= 500 => TransportResult::Retry {
                after: Duration::from_millis(100),
                code: "LANGSMITH_SERVER_ERROR",
            },
            Err(ureq::Error::Transport(_)) => TransportResult::Retry {
                after: Duration::from_millis(100),
                code: "LANGSMITH_TRANSPORT_ERROR",
            },
            Err(ureq::Error::Status(_, _)) => TransportResult::Permanent {
                code: "LANGSMITH_REQUEST_REJECTED",
            },
        }
    }
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    value
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(value)
                .ok()
                .and_then(|when| when.duration_since(std::time::SystemTime::now()).ok())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::config::ObservabilityMode;
    use crate::observability::queue::ExportOperation;
    use serde_json::json;
    use std::sync::mpsc;

    fn config(endpoint: String) -> ObservabilityConfig {
        ObservabilityConfig {
            mode: ObservabilityMode::Metadata,
            api_key: "local-test-key".into(),
            endpoint: url::Url::parse(&endpoint).unwrap(),
            project: "test-project".into(),
            workspace_id: Some("workspace-1".into()),
            request_timeout: Duration::from_secs(1),
            shutdown_timeout: Duration::from_secs(1),
            queue_items: 8,
            queue_bytes: 16 * 1024,
            max_item_bytes: 8 * 1024,
            max_trace_spans: 8,
            spool: None,
        }
    }

    fn mock_response(
        status: u16,
        retry_after: Option<&str>,
    ) -> (
        String,
        mpsc::Receiver<(String, String, Vec<(String, String)>)>,
    ) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let (send, receive) = mpsc::channel();
        let retry_after = retry_after.map(str::to_owned);
        std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let headers = request
                .headers()
                .iter()
                .map(|header| (header.field.to_string(), header.value.to_string()))
                .collect();
            let _ = send.send((request.method().to_string(), body, headers));
            let mut response = tiny_http::Response::empty(status);
            if let Some(value) = retry_after {
                response.add_header(tiny_http::Header::from_bytes("Retry-After", value).unwrap());
            }
            request.respond(response).unwrap();
        });
        (format!("http://{address}"), receive)
    }

    fn item() -> ExportItem {
        ExportItem::new(
            "root-id".into(),
            "root-id".into(),
            None,
            1,
            ExportOperation::Create,
            json!({
                "id": "root-id",
                "inputs": {},
                "extra": {"metadata": {"execution_state": "running"}}
            }),
        )
    }

    #[test]
    fn http_transport_sends_expected_auth_and_metadata_only_body() {
        let (endpoint, request) = mock_response(202, None);
        let mut transport = HttpLangSmithTransport::new(config(endpoint));
        assert_eq!(
            transport.send(&item(), Duration::from_secs(1)),
            TransportResult::Confirmed
        );
        let (method, body, headers) = request.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(method, "POST");
        assert!(body.contains("execution_state"));
        assert!(!body.contains("local-test-key"));
        assert!(headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("x-api-key") && value == "local-test-key"
        }));
        assert!(headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("x-tenant-id") && value == "workspace-1"
        }));
    }

    #[test]
    fn http_transport_classifies_auth_and_retry_after_without_reading_bodies() {
        let (endpoint, _) = mock_response(401, None);
        let mut transport = HttpLangSmithTransport::new(config(endpoint));
        assert_eq!(
            transport.send(&item(), Duration::from_secs(1)),
            TransportResult::AuthenticationRejected
        );

        let (endpoint, _) = mock_response(429, Some("1"));
        let mut transport = HttpLangSmithTransport::new(config(endpoint));
        assert_eq!(
            transport.send(&item(), Duration::from_secs(1)),
            TransportResult::Retry {
                after: Duration::from_secs(1),
                code: "LANGSMITH_RATE_LIMITED"
            }
        );
    }

    #[test]
    fn http_transport_classifies_connection_failure_as_bounded_retry() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let mut transport = HttpLangSmithTransport::new(config(format!("http://{address}")));
        assert_eq!(
            transport.send(&item(), Duration::from_millis(100)),
            TransportResult::Retry {
                after: Duration::from_millis(100),
                code: "LANGSMITH_TRANSPORT_ERROR"
            }
        );
    }
}
