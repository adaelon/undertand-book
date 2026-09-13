//! Chat-completions wire events. Observers never dispatch tools.
use crate::{run_context::CancellationToken, AdapterError};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read},
};

#[derive(Debug, Clone, PartialEq)]
pub enum ModelDelta {
    Text(String),
    ToolArguments {
        index: usize,
        id: String,
        name: String,
        arguments: String,
    },
    Usage(u32),
    Finish(String),
}
pub trait ModelObserver {
    fn observe(&mut self, delta: ModelDelta);
}
impl<F: FnMut(ModelDelta)> ModelObserver for F {
    fn observe(&mut self, delta: ModelDelta) {
        self(delta);
    }
}
pub fn ignore(_: ModelDelta) {}
fn error(message: impl ToString) -> AdapterError {
    AdapterError {
        message: message.to_string(),
    }
}

pub fn read_response(
    response: ureq::Response,
    cancellation: &CancellationToken,
    observer: &mut dyn ModelObserver,
) -> Result<Value, AdapterError> {
    if response
        .header("Content-Type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        == "text/event-stream"
    {
        read_sse(response.into_reader(), cancellation, observer)
    } else {
        let value: Value = response.into_json().map_err(error)?;
        if let Some(usage) = value["usage"]["total_tokens"].as_u64() {
            observer.observe(ModelDelta::Usage(usage as u32));
        }
        cancellation.check().map_err(|e| error(e.message))?;
        Ok(value)
    }
}

pub fn read_sse(
    reader: impl Read,
    cancellation: &CancellationToken,
    observer: &mut dyn ModelObserver,
) -> Result<Value, AdapterError> {
    let mut reader = BufReader::new(reader);
    let mut data = String::new();
    let mut text = String::new();
    let mut calls: BTreeMap<usize, (String, String, String)> = BTreeMap::new();
    let mut usage = Value::Null;
    let mut finish: Option<String> = None;
    loop {
        cancellation.check().map_err(|e| error(e.message))?;
        let mut line = String::new();
        let count = reader.read_line(&mut line).map_err(error)?;
        cancellation.check().map_err(|e| error(e.message))?;
        if count == 0 {
            if !data.is_empty() || finish.is_none() {
                return Err(error(
                    "Provider stream truncated before a complete finish frame",
                ));
            }
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if !line.is_empty() {
            if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.strip_prefix(' ').unwrap_or(value));
            }
            continue;
        }
        if data.is_empty() {
            continue;
        }
        let frame = std::mem::take(&mut data);
        if frame.trim() == "[DONE]" {
            if finish.is_none() {
                return Err(error("Provider stream DONE without finish reason"));
            }
            break;
        }
        let value: Value = serde_json::from_str(&frame).map_err(error)?;
        if !value["error"].is_null() {
            return Err(error(format!("Provider stream error: {}", value["error"])));
        }
        if let Some(total) = value["usage"]["total_tokens"].as_u64() {
            usage = json!({"total_tokens": total});
        }
        for choice in value["choices"]
            .as_array()
            .ok_or_else(|| error("Provider stream missing choices"))?
        {
            if choice["index"].as_u64().unwrap_or(0) != 0 {
                continue;
            }
            let delta = &choice["delta"];
            if finish.is_some()
                && (delta["content"].as_str().is_some_and(|s| !s.is_empty())
                    || delta["tool_calls"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty()))
            {
                return Err(error("Provider content after finish"));
            }
            if let Some(fragment) = delta["content"].as_str().filter(|s| !s.is_empty()) {
                text.push_str(fragment);
                observer.observe(ModelDelta::Text(fragment.into()));
            }
            if let Some(fragments) = delta["tool_calls"].as_array() {
                for fragment in fragments {
                    let index = fragment["index"]
                        .as_u64()
                        .ok_or_else(|| error("Tool delta missing index"))?
                        as usize;
                    let call = calls.entry(index).or_default();
                    if let Some(id) = fragment["id"].as_str() {
                        call.0.push_str(id);
                    }
                    if let Some(name) = fragment["function"]["name"].as_str() {
                        call.1.push_str(name);
                    }
                    if let Some(args) = fragment["function"]["arguments"].as_str() {
                        call.2.push_str(args);
                    }
                    observer.observe(ModelDelta::ToolArguments {
                        index,
                        id: call.0.clone(),
                        name: call.1.clone(),
                        arguments: call.2.clone(),
                    });
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                if !matches!(reason, "stop" | "tool_calls") {
                    return Err(error(format!("Provider unfinished response: {reason}")));
                }
                finish = Some(reason.into());
            }
        }
    }
    let mut tool_calls = Vec::new();
    for (_, (id, name, arguments)) in calls {
        if id.is_empty() || name.is_empty() {
            return Err(error("Incomplete tool identity"));
        }
        let args: Value = serde_json::from_str(&arguments).map_err(error)?;
        if !args.is_object() {
            return Err(error("Tool arguments must be an object"));
        }
        tool_calls.push(
            json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}}),
        );
    }
    if !tool_calls.is_empty() && finish.as_deref() != Some("tool_calls") {
        return Err(error("Tool calls without tool finish"));
    }
    if let Some(total) = usage["total_tokens"].as_u64() {
        observer.observe(ModelDelta::Usage(total as u32));
    }
    observer.observe(ModelDelta::Finish(finish.clone().unwrap()));
    Ok(
        json!({"choices":[{"message":{"role":"assistant","content": if text.is_empty() { Value::Null } else {json!(text)},"tool_calls":tool_calls},"finish_reason":finish}],"usage":usage}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentRequestPlan, CompletionRequest, Message, ProviderConfig, ProviderRegistry};
    use std::io::Write;
    fn frame(delta: Value, finish: Value) -> String {
        format!(
            "data: {}\n\n",
            json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
        )
    }
    fn fixture(wire: String) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(n) = line.to_lowercase().strip_prefix("content-length:") {
                    length = n.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["stream"], true);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            for byte in wire.as_bytes() {
                if socket.write_all(&[*byte]).is_err() {
                    break;
                }
            }
        });
        (url, worker)
    }
    #[test]
    fn native_react_all_entrypoints_read_real_http_utf8_and_usage() {
        for mode in ["native", "react"] {
            for entry in ["chat", "complete", "structured"] {
                let content = match entry {
                    "chat" if mode == "native" => "中文。[[source:s1]]",
                    "chat" => r#"{"final":"中文。[[source:s1]]"}"#,
                    "complete" => r#"{"sufficient":true,"answer":"中文。","citations":[]}"#,
                    _ => r#"{"answer":"中文。"}"#,
                };
                let mut wire = String::new();
                for ch in content.chars() {
                    wire += &frame(json!({"content":ch.to_string()}), Value::Null);
                }
                wire += &frame(json!({}), json!("stop"));
                wire += "data: {\n";
                wire += "data: \"choices\":[],\"usage\":{\"total_tokens\":17}}\n\ndata: [DONE]\n\n";
                let (url, worker) = fixture(wire);
                let adapter = ProviderRegistry::adapter_from_config_with_timeout(
                    ProviderConfig::from_values(mode, "key", url, "test").unwrap(),
                    std::time::Duration::from_secs(5),
                );
                let mut deltas = Vec::new();
                let mut observe = |d| deltas.push(d);
                let req = || CompletionRequest {
                    system: "test".into(),
                    user: "test".into(),
                };
                match entry {
                    "chat" => {
                        let plan = AgentRequestPlan::for_ad_hoc(
                            adapter.model_runtime_profile(),
                            &[Message::user("test")],
                            &[],
                        );
                        let turn = adapter.chat_observed(&plan, &mut observe).unwrap();
                        assert_eq!(turn.text.as_deref(), Some("中文。[[source:s1]]"));
                        assert_eq!(turn.usage_total_tokens, Some(17));
                    }
                    "complete" => {
                        assert_eq!(
                            adapter
                                .complete_observed(req(), &mut observe)
                                .unwrap()
                                .answer
                                .as_deref(),
                            Some("中文。")
                        );
                    }
                    _ => {
                        assert_eq!(
                            adapter
                                .complete_structured_observed(req(), &mut observe)
                                .unwrap()["answer"],
                            "中文。"
                        );
                    }
                }
                assert_eq!(
                    deltas
                        .iter()
                        .filter(|d| matches!(d, ModelDelta::Usage(_)))
                        .count(),
                    1
                );
                assert_eq!(
                    deltas
                        .iter()
                        .filter_map(|d| if let ModelDelta::Text(t) = d {
                            Some(t.as_str())
                        } else {
                            None
                        })
                        .collect::<String>(),
                    content
                );
                worker.join().unwrap();
            }
        }
    }
    #[test]
    fn tools_are_merged_by_index_and_incomplete_streams_fail() {
        let wire = frame(
            json!({"tool_calls":[{"index":1,"id":"b","function":{"name":"book.text","arguments":"{"}},{"index":0,"id":"a","function":{"name":"reader.state","arguments":"{}"}}]}),
            Value::Null,
        ) + &frame(
            json!({"tool_calls":[{"index":1,"function":{"arguments":"\"lid\":\"1.1\"}"}}]}),
            Value::Null,
        ) + &frame(json!({}), json!("tool_calls"));
        let result = read_sse(wire.as_bytes(), &Default::default(), &mut ignore).unwrap();
        assert_eq!(result["choices"][0]["message"]["tool_calls"][0]["id"], "a");
        assert_eq!(
            result["choices"][0]["message"]["tool_calls"][1]["function"]["arguments"],
            r#"{"lid":"1.1"}"#
        );
        for wire in [
            frame(json!({"content":"中文"}), Value::Null),
            "data: [DONE]\n\n".into(),
            frame(json!({}), json!("length")),
            "data: {bad}\n\n".into(),
        ] {
            assert!(read_sse(wire.as_bytes(), &Default::default(), &mut ignore).is_err());
        }
        let token = CancellationToken::default();
        let cancel = token.clone();
        let wire = frame(json!({"content":"中文"}), Value::Null) + &frame(json!({}), json!("stop"));
        assert!(read_sse(wire.as_bytes(), &token, &mut |_| cancel.cancel()).is_err());
    }
}
