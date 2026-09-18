use super::*;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, Sender};

const DEADLINE: Duration = Duration::from_secs(15);

struct ProviderStep {
    request: Value,
    response: Sender<Value>,
}
impl ProviderStep {
    fn finish(self, message: Value) {
        self.response.send(json!({"choices":[{"message":message,"finish_reason":"stop"}], "usage":{"total_tokens":1}})).unwrap();
    }
    fn answer(self, text: &str) {
        self.finish(json!({"role":"assistant","content":text}));
    }
    fn tool(self, name: &str, arguments: Value) {
        self.finish(json!({"role":"assistant","content":null,"tool_calls":[{
            "id":"call-test", "type":"function", "function":{"name":name,"arguments":arguments.to_string()}
        }]}));
    }
}
struct Provider {
    config: ProviderConfig,
    steps: Receiver<ProviderStep>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}
impl Provider {
    fn new() -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let (send, steps) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let handle = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let Some(mut request) = server.recv_timeout(Duration::from_millis(100)).unwrap()
                else {
                    continue;
                };
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let (response, receive) = mpsc::channel();
                if send
                    .send(ProviderStep {
                        request: serde_json::from_str(&body).unwrap(),
                        response,
                    })
                    .is_err()
                {
                    break;
                }
                let Ok(body) = receive.recv_timeout(DEADLINE) else {
                    break;
                };
                let _ = request.respond(
                    tiny_http::Response::from_string(body.to_string()).with_header(
                        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                    ),
                );
            }
        });
        Self {
            config: ProviderConfig::from_values(
                "native",
                "test-key",
                format!("http://{address}"),
                "test-model",
            )
            .unwrap(),
            steps,
            stop,
            handle: Some(handle),
        }
    }
    fn next(&self) -> ProviderStep {
        self.steps
            .recv_timeout(DEADLINE)
            .expect("expected model request")
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn fixture(name: &str) -> (RunningServer, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "ub-as2-{name}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let book_dir =
        crate::tests::write_multi_leaf_book(&format!("as2-{name}"), &format!("as2-{name}"), 30);
    let mut config = ServerHostConfig::desktop(root.join("library"), root.join("dist"));
    config.book_dir = Some(book_dir);
    let running = start_server_with_memory_path(config, root.join("memory/memory.json")).unwrap();
    (running, root)
}
fn http(url: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    use std::io::{Read, Write};
    let mut socket = std::net::TcpStream::connect(url.strip_prefix("http://").unwrap()).unwrap();
    socket.set_read_timeout(Some(DEADLINE)).unwrap();
    let body = if method == "GET" {
        String::new()
    } else {
        body.to_string()
    };
    write!(socket, "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    let (header, body) = response.split_once("\r\n\r\n").unwrap();
    (
        header.split_whitespace().nth(1).unwrap().parse().unwrap(),
        serde_json::from_str(body).expect(&response),
    )
}
fn chat(running: &RunningServer, message: &str) -> JoinHandle<(u16, Value)> {
    let url = running.url.clone();
    let message = message.to_string();
    thread::spawn(move || http(&url, "POST", "/agent/chat", json!({"message":message})))
}

#[test]
fn resident_model_wait_releases_state_and_preserves_concurrent_reader_memory_and_history() {
    let provider = Provider::new();
    let (running, root) = fixture("concurrent");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释这段文字");
    let step = provider.next();
    let path = root.join("memory/agent-history.json");
    let pending = std::fs::read(&path).unwrap();
    let history = http(&running.url, "GET", "/agent/history", Value::Null);
    assert_eq!(
        history.1["current"]["turns"][0]["status"],
        "pending_assistant"
    );
    assert_eq!(std::fs::read(&path).unwrap(), pending);
    let busy = http(
        &running.url,
        "POST",
        "/agent/chat",
        json!({"message":"第二轮"}),
    );
    assert_eq!(busy.0, 409);
    assert_eq!(busy.1["error_code"], "AGENT_RUN_BUSY");
    assert_eq!(
        busy.1["turn_id"],
        history.1["current"]["turns"][0]["turn_id"]
    );
    assert_eq!(
        http(&running.url, "POST", "/reader/goto", json!({"lid":"1.30"})).0,
        200
    );
    let note = http(
        &running.url,
        "POST",
        "/reader/note",
        json!({"lid":"1.30","text":"manual note"}),
    );
    assert_eq!(note.0, 200, "{note:?}");
    assert_eq!(
        http(&running.url, "POST", "/reader/state", json!({})).0,
        200
    );
    let manual_anchor = running
        .state
        .lock()
        .unwrap()
        .reader
        .state()
        .viewport
        .anchor_lid;
    step.answer("完成解释。");
    let reply = worker.join().unwrap();
    assert_eq!(reply.0, 200, "{reply:?}");
    assert!(
        reply.1["effects"].as_array().unwrap().is_empty(),
        "manual navigation is not an Agent effect"
    );
    let state = running.state.lock().unwrap();
    assert_eq!(state.reader.state().viewport.anchor_lid, manual_anchor);
    assert!(
        state
            .store
            .recall(&memory::RecallQuery {
                text: Some("manual note".into()),
                ..Default::default()
            })
            .len()
            > 0
    );
    let history = load_agent_history(&state.history_path).unwrap();
    assert_eq!(
        history.sessions[0].turns[0].status,
        AgentAssistantStatus::Completed
    );
    assert!(history.sessions[0]
        .messages
        .iter()
        .any(|message| message.content.as_deref() == Some("完成解释。")));
    drop(state);
    running.shutdown();
}

#[test]
fn resident_cancel_keeps_completed_note_and_blocks_returned_tools_and_later_sampling() {
    let provider = Provider::new();
    let (running, _) = fixture("cancel");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "请在 1.1 保存笔记并高亮这段");
    provider
        .next()
        .tool("reader.note", json!({"lid":"1.1","text":"agent note"}));
    let step = provider.next();
    assert!(step.request.to_string().contains("agent note"));
    let turn_id = running.state.lock().unwrap().agent_history.sessions[0].turns[0]
        .turn_id
        .clone();
    let stream = running.run_coordinator.stream(&turn_id).unwrap();
    let live = stream.snapshot();
    assert_eq!(live.effects.len(), 1);
    assert_eq!(live.effects[0]["effect"]["kind"], "Note");
    let revision = live.reader_state.as_ref().unwrap()["revision"]
        .as_u64()
        .unwrap();
    assert_eq!(
        http(&running.url, "POST", "/reader/goto", json!({"lid":"1.30"})).0,
        200
    );
    assert!(
        http(&running.url, "POST", "/reader/state", json!({})).1["revision"]
            .as_u64()
            .unwrap()
            > revision
    );
    assert_eq!(
        stream.snapshot().effects.len(),
        1,
        "manual operations are not Agent effects"
    );
    assert!(running.run_coordinator.cancel().is_some());
    let busy = http(
        &running.url,
        "POST",
        "/agent/chat",
        json!({"message":"第三轮"}),
    );
    assert_eq!(busy.1["error_code"], "AGENT_RUN_BUSY");
    step.tool("reader.highlight", json!({"lid":"1.1"}));
    let reply = worker.join().unwrap();
    assert_eq!(reply.1["error_code"], "AGENT_RUN_CANCELLED");
    assert!(provider.steps.try_recv().is_err());
    let state = running.state.lock().unwrap();
    let history = load_agent_history(&state.history_path).unwrap();
    let turn = &history.sessions[0].turns[0];
    assert_eq!(turn.status, AgentAssistantStatus::Cancelled);
    let summary = turn.run_summary.as_ref().unwrap();
    assert_eq!(summary.trace.len(), 1);
    let activities = summary.activities.as_ref().unwrap();
    assert_eq!(activities.iter().filter(|a| a.kind == "tool").count(), 1);
    assert_eq!(
        activities.last().unwrap().status,
        runtime::run_events::ActivityStatus::Cancelled
    );
    assert_eq!(activities.last().unwrap().usage_total_tokens, Some(1));

    assert_eq!(summary.trace[0].tool, "reader.note");
    assert!(matches!(
        &summary.effects[..],
        [runtime::orchestrator::AgentEffect::Note { .. }]
    ));
    assert!(
        state
            .store
            .recall(&memory::RecallQuery {
                text: Some("agent note".into()),
                ..Default::default()
            })
            .len()
            > 0
    );
    assert!(state
        .store
        .recall(&memory::RecallQuery {
            mem_type: Some("highlight".into()),
            ..Default::default()
        })
        .is_empty());
    let input = copy_review_input(&state, &state.store.review_state().review_jobs[0]).unwrap();
    assert_eq!(input.turns[0].assistant_status, ReviewTurnStatus::Cancelled);
    assert!(input.turns[0].assistant_answer.is_none());
    drop(state);
    running.shutdown();
}

#[test]
fn resident_profile_judgment_wait_is_outside_state_and_cancel_prevents_apply() {
    let provider = Provider::new();
    let (running, _) = fixture("profile-cancel");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "记住我喜欢详细解释");
    let step = provider.next();
    assert!(step
        .request
        .to_string()
        .contains("explicit reader-profile memory operation"));
    assert_eq!(
        http(&running.url, "POST", "/reader/goto", json!({"lid":"1.30"})).0,
        200
    );
    let revision = running.state.lock().unwrap().store.projection_revision();
    running.run_coordinator.cancel();
    step.answer(r#"{"intent":"remember","scope":"book","applicability_kind":"any","payload":{"kind":"explanation_preference","key":"detail","value":"detailed"}}"#);
    assert_eq!(
        worker.join().unwrap().1["error_code"],
        "AGENT_RUN_CANCELLED"
    );
    assert_eq!(
        running.state.lock().unwrap().store.projection_revision(),
        revision
    );
    assert!(provider.steps.try_recv().is_err());
    running.shutdown();
}

#[test]
fn resident_context_boundary_waits_for_exit_without_holding_state() {
    let provider = Provider::new();
    let (running, _) = fixture("boundary");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释这段文字");
    let step = provider.next();
    let original =
        http(&running.url, "GET", "/agent/history", Value::Null).1["active_session_id"].clone();
    // The already-running adapter stays frozen; the boundary need not request a profile review.
    *running.review_coordinator.provider_config.lock().unwrap() = None;
    let url = running.url.clone();
    let boundary = thread::spawn(move || http(&url, "POST", "/agent/new", json!({})));
    running.run_coordinator.wait_until_cancelling();
    assert_eq!(
        http(&running.url, "POST", "/reader/state", json!({})).0,
        200
    );
    assert_eq!(
        http(&running.url, "GET", "/agent/history", Value::Null).1["active_session_id"],
        original
    );
    step.answer("停止后不交付此候选。");
    assert_eq!(
        worker.join().unwrap().1["error_code"],
        "AGENT_RUN_CANCELLED"
    );
    assert_eq!(boundary.join().unwrap().0, 200);
    let state = running.state.lock().unwrap();
    let original = state
        .agent_history
        .sessions
        .iter()
        .find(|session| Some(session.id.as_str()) == original.as_str())
        .unwrap();
    assert_eq!(original.turns[0].status, AgentAssistantStatus::Cancelled);
    assert!(state
        .messages
        .iter()
        .all(|message| message.role == runtime::Role::System));
    drop(state);
    running.shutdown();
}

#[test]
fn resident_commit_failure_keeps_pending_and_startup_recovers_interrupted() {
    let provider = Provider::new();
    let (running, root) = fixture("commit-failure");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释这段文字");
    let step = provider.next();
    let path = running.state.lock().unwrap().history_path.clone();
    let blocked = root.join("blocked");
    std::fs::write(&blocked, "not a directory").unwrap();
    running.state.lock().unwrap().history_path = Some(blocked.join("agent-history.json"));
    step.answer("无法持久化的答案。");
    assert_eq!(worker.join().unwrap().0, 500);
    let unsaved = running
        .run_coordinator
        .unsaved_run()
        .expect("unsaved completion remains inspectable");
    assert_eq!(
        unsaved.outcome.unwrap().answer.as_deref(),
        Some("无法持久化的答案。")
    );
    let history = load_agent_history(&path).unwrap();
    assert_eq!(
        history.sessions[0].turns[0].status,
        AgentAssistantStatus::PendingAssistant
    );
    assert!(history.sessions[0].turns[0].outcome.is_none());
    running.state.lock().unwrap().history_path = path.clone();
    running.shutdown();
    let mut config = ServerHostConfig::desktop(root.join("library"), root.join("dist"));
    config.book_dir = Some(crate::tests::write_multi_leaf_book(
        "as2-commit-failure",
        "as2-commit-failure",
        30,
    ));
    let restarted = start_server_with_memory_path(config, root.join("memory/memory.json")).unwrap();
    let history = load_agent_history(&path).unwrap();
    assert_eq!(
        history.sessions[0].turns[0].status,
        AgentAssistantStatus::Failed
    );
    assert_eq!(
        history.sessions[0].turns[0]
            .error
            .as_ref()
            .unwrap()
            .error_code,
        "INTERRUPTED"
    );
    restarted.shutdown();
}

#[test]
fn resident_precommit_failure_releases_slot_without_calling_provider() {
    let provider = Provider::new();
    let (running, root) = fixture("precommit-failure");
    running.set_provider_config(provider.config.clone());
    let path = running.state.lock().unwrap().history_path.clone();
    let blocked = root.join("blocked");
    std::fs::write(&blocked, "not a directory").unwrap();
    running.state.lock().unwrap().history_path = Some(blocked.join("agent-history.json"));
    assert_eq!(chat(&running, "解释这段").join().unwrap().0, 500);
    assert!(provider.steps.try_recv().is_err());
    running.state.lock().unwrap().history_path = path;
    let worker = chat(&running, "再次解释这段");
    provider.next().answer("完成。");
    assert_eq!(worker.join().unwrap().0, 200);
    running.shutdown();
}

#[test]
fn resident_nested_synthesis_and_source_repair_release_state() {
    let provider = Provider::new();
    let (running, _) = fixture("nested");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释 1.1 这段文字");
    provider.next().tool("book.text", json!({"lid":"1.1"}));
    provider
        .next()
        .tool("book.synthesize", json!({"lids":["1.1"],"task":"解释"}));
    let synthesis = provider.next();
    assert!(
        synthesis.request.get("tools").is_none(),
        "expected inner complete request"
    );
    assert_eq!(
        http(&running.url, "POST", "/reader/state", json!({})).0,
        200
    );
    synthesis.answer(r#"{"sufficient":true,"answer":"概括","citations":[]}"#);
    provider.next().answer("这位于 LID 1.1。");
    let repair = provider.next();
    assert!(repair.request.to_string().contains("source_answer_repair"));
    assert_eq!(
        http(&running.url, "POST", "/reader/goto", json!({"lid":"1.30"})).0,
        200
    );
    repair.answer("这里给出了相关概括。");
    let reply = worker.join().unwrap();
    assert_eq!(reply.0, 200, "{reply:?}");
    assert_eq!(reply.1["trace"][1]["tool"], "book.synthesize");
    {
        let state = running.state.lock().unwrap();
        let activities = state.agent_history.sessions[0].turns[0]
            .run_summary
            .as_ref()
            .unwrap()
            .activities
            .as_ref()
            .unwrap();
        let tool = activities
            .iter()
            .find(|a| a.name == "book.synthesize")
            .unwrap();
        let nested = activities.iter().find(|a| a.name == "synthesize").unwrap();
        assert_eq!(nested.parent_step_id, Some(tool.step_id));
        assert!(tool.usage_total_tokens.is_none());
        assert_eq!(
            nested.usage_total_tokens,
            Some(1),
            "inner completion records its actual request usage once"
        );
        assert!(activities.iter().any(|a| a.name == "repair"));
        assert!(activities
            .iter()
            .all(|a| a.status != runtime::run_events::ActivityStatus::Running));
    }

    assert!(reply.1["effects"].as_array().unwrap().is_empty());
    running.shutdown();
}

#[test]
fn resident_failure_retains_already_completed_actions() {
    let provider = Provider::new();
    let (running, _) = fixture("failed-note");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "请在 1.1 保存笔记");
    provider.next().tool(
        "reader.note",
        json!({"lid":"1.1","text":"kept after failure"}),
    );
    provider.next().answer("");
    assert_eq!(
        worker.join().unwrap().1["error_code"],
        "PROVIDER_EMPTY_RESPONSE"
    );
    let state = running.state.lock().unwrap();
    let history = load_agent_history(&state.history_path).unwrap();
    let turn = &history.sessions[0].turns[0];
    assert_eq!(turn.status, AgentAssistantStatus::Failed);
    assert_eq!(turn.run_summary.as_ref().unwrap().effects.len(), 1);
    assert_eq!(crate::turn_view(&state.book, turn).effect_labels.len(), 1);
    assert!(!state
        .store
        .recall(&memory::RecallQuery {
            text: Some("kept after failure".into()),
            ..Default::default()
        })
        .is_empty());
    drop(state);
    running.shutdown();
}

#[test]
fn resident_stream_can_finish_after_sixty_seconds() {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(DEADLINE)).unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" { break; }
            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        reader.read_exact(&mut vec![0; length]).unwrap();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
        // The provider is alive throughout; a total 60-second deadline must not cut it off.
        for _ in 0..65 {
            if socket.write_all(b": generating\n\n").is_err() { return; }
            thread::sleep(Duration::from_secs(1));
        }
        let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"完成。\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let _ = socket.write_all(body.as_bytes());
    });
    let (running, _) = fixture("long-resident-stream");
    running.set_provider_config(ProviderConfig::from_values("native", "test-key", format!("http://{address}"), "test-model").unwrap());
    let started = std::time::Instant::now();
    let mut client = std::net::TcpStream::connect(running.url.strip_prefix("http://").unwrap()).unwrap();
    client.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
    let body = json!({"message":"请简短回答完成。"}).to_string();
    write!(client, "POST /agent/chat HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut wire = String::new();
    client.read_to_string(&mut wire).unwrap();
    let response: Value = serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
    provider.join().unwrap();
    assert!(started.elapsed() >= Duration::from_secs(60));
    assert!(response.get("error_code").is_none(), "{response}");
    let state = running.state.lock().unwrap();
    assert_eq!(state.agent_history.sessions[0].turns[0].status, AgentAssistantStatus::Completed);
    drop(state);
    running.shutdown();
}

#[test]
fn resident_failure_keeps_question_but_drops_run_local_tool_transcript_before_retry() {
    let provider = Provider::new();
    let (running, _) = fixture("failed-tool-transcript");
    running.set_provider_config(provider.config.clone());

    let first = chat(&running, "请制作一个交互页面");
    provider.next().tool(
        "tool.search",
        json!({
            "task":"interactive HTML explanation",
            "required_capabilities":["presentation_authoring"],
            "scope":"passage",
            "operation":"explain",
            "effect_mode":"read_only",
            "max_results":1
        }),
    );
    provider.next().answer("");
    assert_eq!(
        first.join().unwrap().1["error_code"],
        "PROVIDER_EMPTY_RESPONSE"
    );

    {
        let state = running.state.lock().unwrap();
        assert!(state
            .messages
            .iter()
            .any(|message| message.role == runtime::Role::User
                && message.content.as_deref() == Some("请制作一个交互页面")));
        assert!(state.messages.iter().all(|message| {
            message.role != runtime::Role::Assistant && message.role != runtime::Role::Tool
        }));
        let history = load_agent_history(&state.history_path).unwrap();
        assert_eq!(
            history.sessions[0].turns[0].status,
            AgentAssistantStatus::Failed
        );
        assert!(history.sessions[0].turns[0]
            .run_summary
            .as_ref()
            .unwrap()
            .trace
            .iter()
            .any(|step| step.tool == "tool.search"));
    }

    let retry = chat(&running, "重试");
    let request = provider.next();
    let projected = request.request.to_string();
    assert!(projected.contains("请制作一个交互页面"));
    assert!(projected.contains("重试"));
    assert!(!projected.contains("tool_search_result.v2"));
    assert!(!projected.contains("call-test"));
    request.answer("已重新开始。");
    assert_eq!(retry.join().unwrap().0, 200);
    running.shutdown();
}

#[test]
fn resident_select_delete_and_book_open_share_the_stop_boundary() {
    for operation in ["select", "delete", "book"] {
        let provider = Provider::new();
        let (running, _) = fixture(&format!("boundary-{operation}"));
        let original =
            http(&running.url, "GET", "/agent/history", Value::Null).1["active_session_id"].clone();
        let current = http(&running.url, "POST", "/agent/new", json!({})).1["history"]
            ["active_session_id"]
            .clone();
        running.set_provider_config(provider.config.clone());
        let worker = chat(&running, "解释这段文字");
        let step = provider.next();
        *running.review_coordinator.provider_config.lock().unwrap() = None;
        let (path, body) = match operation {
            "select" => ("/agent/history/select", json!({"session_id":original})),
            "delete" => ("/agent/history/delete", json!({"session_id":current})),
            _ => (
                "/book/open",
                json!({"dir":crate::tests::write_multi_leaf_book("as2-other", "as2-other", 30)}),
            ),
        };
        let url = running.url.clone();
        let boundary = thread::spawn(move || http(&url, "POST", path, body));
        running.run_coordinator.wait_until_cancelling();
        assert_eq!(
            http(&running.url, "POST", "/reader/state", json!({})).0,
            200
        );
        step.answer("停止后不交付此候选。");
        assert_eq!(
            worker.join().unwrap().1["error_code"],
            "AGENT_RUN_CANCELLED"
        );
        let reply = boundary.join().unwrap();
        assert_eq!(reply.0, 200, "{operation}: {reply:?}");
        let state = running.state.lock().unwrap();
        if operation == "delete" {
            assert!(!state
                .agent_history
                .sessions
                .iter()
                .any(|session| Some(session.id.as_str()) == current.as_str()));
        } else {
            let turn = &state
                .agent_history
                .sessions
                .iter()
                .find(|session| Some(session.id.as_str()) == current.as_str())
                .unwrap()
                .turns[0];
            assert_eq!(turn.status, AgentAssistantStatus::Cancelled);
        }
        assert!(state
            .messages
            .iter()
            .all(|message| message.role == runtime::Role::System));
        drop(state);
        running.shutdown();
    }
}

#[test]
fn resident_shutdown_cancels_and_persists_before_host_exit() {
    let provider = Provider::new();
    let (running, _) = fixture("shutdown");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释这段文字");
    let step = provider.next();
    let coordinator = running.run_coordinator.clone();
    let path = running.state.lock().unwrap().history_path.clone();
    let shutdown = thread::spawn(move || running.shutdown());
    coordinator.wait_until_cancelling();
    step.answer("停止后不交付此候选。");
    assert_eq!(
        worker.join().unwrap().1["error_code"],
        "AGENT_RUN_CANCELLED"
    );
    shutdown.join().unwrap();
    assert_eq!(
        load_agent_history(&path).unwrap().sessions[0].turns[0].status,
        AgentAssistantStatus::Cancelled
    );
    assert!(coordinator.cancel().is_none());
}

#[test]
fn resident_cancel_closes_unexecuted_batch_receipts_and_can_continue_session() {
    let provider = Provider::new();
    let (running, _) = fixture("cancel-batch");
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释 1.1 并保存笔记");
    provider.next().tool("book.text", json!({"lid":"1.1"}));
    provider.next().finish(json!({"role":"assistant", "content":null, "tool_calls":[
        {"id":"synthesis", "type":"function", "function":{"name":"book.synthesize", "arguments":json!({"lids":["1.1"],"task":"解释"}).to_string()}},
        {"id":"unexecuted-note", "type":"function", "function":{"name":"reader.note", "arguments":json!({"lid":"1.1","text":"must not be saved"}).to_string()}}
    ]}));
    let synthesis = provider.next();
    assert!(synthesis.request.get("tools").is_none());
    running.run_coordinator.cancel();
    synthesis.answer(r#"{"sufficient":true,"answer":"概括","citations":[]}"#);
    assert_eq!(
        worker.join().unwrap().1["error_code"],
        "AGENT_RUN_CANCELLED"
    );
    {
        let state = running.state.lock().unwrap();
        let session = &state.agent_history.sessions[0];
        let receipt = session
            .messages
            .iter()
            .find(|message| {
                message.role == runtime::Role::Tool
                    && message.tool_call_id.as_deref() == Some("unexecuted-note")
            })
            .unwrap();
        assert!(receipt
            .content
            .as_ref()
            .unwrap()
            .contains("AGENT_RUN_CANCELLED"));
        assert!(!session.turns[0]
            .run_summary
            .as_ref()
            .unwrap()
            .trace
            .iter()
            .any(|step| step.tool == "reader.note"));
        assert!(state
            .store
            .recall(&memory::RecallQuery {
                text: Some("must not be saved".into()),
                ..Default::default()
            })
            .is_empty());
    }
    let worker = chat(&running, "继续解释");
    let next = provider.next();
    let mut pending = std::collections::BTreeSet::new();
    for message in next.request["messages"].as_array().unwrap() {
        if message["role"] == "assistant" {
            for call in message["tool_calls"].as_array().into_iter().flatten() {
                pending.insert(call["id"].as_str().unwrap());
            }
        } else if message["role"] == "tool" {
            assert!(pending.remove(message["tool_call_id"].as_str().unwrap()));
        } else if message["role"] == "user" {
            assert!(
                pending.is_empty(),
                "next user must not inherit an open tool batch"
            );
        }
    }
    assert!(pending.is_empty());
    next.answer("继续完成。");
    assert_eq!(worker.join().unwrap().0, 200);
    running.shutdown();
}

#[test]
fn resident_commit_preserves_deletion_of_another_session_during_model_wait() {
    let provider = Provider::new();
    let (running, _) = fixture("other-session");
    let old =
        http(&running.url, "GET", "/agent/history", Value::Null).1["active_session_id"].clone();
    let current = http(&running.url, "POST", "/agent/new", json!({})).1["history"]
        ["active_session_id"]
        .clone();
    running.set_provider_config(provider.config.clone());
    let worker = chat(&running, "解释这段文字");
    let step = provider.next();
    assert_eq!(
        http(
            &running.url,
            "POST",
            "/agent/history/delete",
            json!({"session_id":old})
        )
        .0,
        200
    );
    step.answer("完成解释。");
    assert_eq!(worker.join().unwrap().0, 200);
    let state = running.state.lock().unwrap();
    let history = load_agent_history(&state.history_path).unwrap();
    assert_eq!(history.sessions.len(), 1);
    assert_eq!(Some(history.sessions[0].id.as_str()), current.as_str());
    assert_eq!(
        history.sessions[0].turns[0].status,
        AgentAssistantStatus::Completed
    );
    drop(state);
    running.shutdown();
}

fn subscribe(
    url: &str,
    turn: &str,
    suffix: &str,
    header: &str,
) -> std::io::BufReader<std::net::TcpStream> {
    use std::io::{BufRead, Write};
    let mut socket = std::net::TcpStream::connect(url.strip_prefix("http://").unwrap()).unwrap();
    socket.set_read_timeout(Some(DEADLINE)).unwrap();
    write!(socket, "GET /agent/runs/{turn}/events{suffix} HTTP/1.1\r\nHost: localhost\r\n{header}Connection: close\r\n\r\n").unwrap();
    let mut reader = std::io::BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.contains("200"), "{line}");
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
    }
    reader
}
fn next_event(reader: &mut impl std::io::BufRead) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "unexpected SSE EOF"
        );
        if let Some(data) = line.strip_prefix("data: ") {
            return serde_json::from_str(data.trim()).unwrap();
        }
    }
}
fn terminal(running: &RunningServer, id: &str) -> crate::agent_stream::RunSnapshot {
    let stream = running.run_coordinator.stream(id).unwrap();
    let deadline = std::time::Instant::now() + DEADLINE;
    loop {
        let snapshot = stream.snapshot();
        if snapshot.persistence_state != "pending" {
            return snapshot;
        }
        assert!(std::time::Instant::now() < deadline);
        stream.read_after(Some(snapshot.last_seq), Duration::from_secs(1));
    }
}
#[test]
fn resident_sse_streams_before_model_finishes_and_reconnect_never_dispatches() {
    let provider = Provider::new();
    let (running, _) = fixture("sse");
    running.set_provider_config(provider.config.clone());
    let accepted = http(
        &running.url,
        "POST",
        "/api/agent/runs",
        json!({"message":"解释 1.1"}),
    );
    assert_eq!(accepted.0, 202);
    let id = accepted.1["turn_id"].as_str().unwrap();
    let first = provider.next();
    let mut observers = Vec::new();
    for _ in 0..5 {
        let mut observer = subscribe(&running.url, id, "", "");
        let snapshot = next_event(&mut observer);
        assert_eq!(snapshot["type"], "run.snapshot");
        assert!(snapshot["payload"]["activities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["status"] == "running"));
        observers.push(observer);
    }
    assert_eq!(
        http(&running.url, "POST", "/reader/state", json!({})).0,
        200
    );
    let mut observer = observers.remove(0);
    drop(observers); // connection loss only drops observers
    first.tool("book.text", json!({"lid":"1.1"}));
    let second = provider.next();
    let mut seq = 0;
    loop {
        let event = next_event(&mut observer);
        assert!(event["seq"].as_u64().unwrap() > seq);
        seq = event["seq"].as_u64().unwrap();
        if event["type"] == "tool.finished" {
            break;
        }
    }
    let mut resumed = subscribe(
        &running.url,
        id,
        "?after=0",
        &format!("Last-Event-ID: {seq}\r\n"),
    );
    let event = next_event(&mut resumed);
    assert!(
        event["seq"].as_u64().unwrap() > seq,
        "header cursor takes precedence"
    );
    assert_eq!(event["type"], "model.started");
    assert!(provider.steps.try_recv().is_err());
    second.answer("已完成解释。");
    let snapshot = terminal(&running, id);
    assert_eq!(snapshot.execution_state, "completed");
    assert_eq!(
        snapshot.final_view.as_ref().unwrap()["run_summary"]["activities"],
        json!(snapshot.activities)
    );
    assert_eq!(
        snapshot.final_view.as_ref().unwrap()["run_summary"]["last_seq"],
        snapshot.last_seq
    );
    let durable = http(
        &running.url,
        "GET",
        &format!("/agent/runs/{id}"),
        Value::Null,
    );
    assert_eq!(durable.1["last_seq"], snapshot.last_seq);
    assert_eq!(durable.1["final_view"], snapshot.final_view.unwrap());
    running.shutdown();
}
#[test]
fn resident_run_api_cancel_and_persistence_failure_have_distinct_terminal_events() {
    for failure in [false, true] {
        let provider = Provider::new();
        let (running, root) = fixture(if failure { "sse-unsaved" } else { "sse-cancel" });
        running.set_provider_config(provider.config.clone());
        let accepted = http(
            &running.url,
            "POST",
            "/agent/runs",
            json!({"message":"解释这段"}),
        );
        let id = accepted.1["turn_id"].as_str().unwrap();
        let step = provider.next();
        let mut observer = subscribe(&running.url, id, "", "");
        next_event(&mut observer);
        let original = running.state.lock().unwrap().history_path.clone();
        if failure {
            let blocked = root.join("blocked");
            std::fs::write(&blocked, "file").unwrap();
            running.state.lock().unwrap().history_path = Some(blocked.join("history.json"));
        } else {
            let cancelled = http(
                &running.url,
                "POST",
                &format!("/agent/runs/{id}/cancel"),
                json!({}),
            );
            assert_eq!(cancelled.1["execution_state"], "cancelling");
        }
        step.answer("模型结束。");
        let expected = if failure {
            "run.persistence_failed"
        } else {
            "run.cancelled"
        };
        loop {
            let event = next_event(&mut observer);
            if event["type"] == expected {
                break;
            }
            assert_ne!(event["type"], "run.completed");
        }
        let snapshot = terminal(&running, id);
        assert_eq!(
            snapshot.persistence_state,
            if failure { "failed" } else { "saved" }
        );
        let again = http(
            &running.url,
            "POST",
            &format!("/agent/runs/{id}/cancel"),
            json!({}),
        );
        assert_eq!(again.1["last_seq"], snapshot.last_seq);
        running.state.lock().unwrap().history_path = original;
        running.shutdown();
    }
}

#[test]
fn resident_rejected_source_has_no_started_event_and_no_execution_time() {
    let provider = Provider::new();
    let (running, _) = fixture("rejected-source");
    running.set_provider_config(provider.config.clone());
    let accepted = http(
        &running.url,
        "POST",
        "/agent/runs",
        json!({"message":"解释 1.1 并给出来源"}),
    );
    let id = accepted.1["turn_id"].as_str().unwrap();
    provider.next().tool("book.text", json!({"lid":"1.1"}));
    provider
        .next()
        .tool("source.present", json!({"start_lid":"1.20"}));
    let next = provider.next();
    let stream = running.run_coordinator.stream(id).unwrap();
    let activity = stream
        .snapshot()
        .activities
        .into_iter()
        .find(|a| a.name == "source.present")
        .unwrap();
    assert_eq!(
        activity.status,
        runtime::run_events::ActivityStatus::Rejected
    );
    assert_eq!(activity.started_ms, None);
    assert_eq!(activity.duration_ms, None);
    let (events, _) = stream.read_after(Some(0), Duration::ZERO);
    assert!(!events
        .iter()
        .any(|e| e.event_type == "tool.started" && e.payload["name"] == "source.present"));
    next.answer("完成解释。");
    terminal(&running, id);
    running.shutdown();
}
