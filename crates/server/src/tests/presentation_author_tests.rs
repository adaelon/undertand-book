use super::*;
use crate::agent_run::{AppStatePort, BorrowedAppPort, RuntimeStatePort};
use runtime::{
    presentation_author::*,
    presentation_preview::{PreviewAction, REQUIRED_PREVIEW_ENVIRONMENTS},
    run_context::{CancellationToken, ResidentStatePort},
};

fn setup() -> (tempfile::TempDir, AppState, AgentTurnRef) {
    let root = tempfile::tempdir().unwrap();
    let mut state = state_named("rp4-authoring");
    state.history_path = Some(root.path().join("history.json"));
    let book = state.book.base.book_id.clone();
    let turn = precommit_agent_turn(
        &mut state,
        &book,
        "interactive example".into(),
        None,
        None,
        None,
        "2026-09-17T00:00:00Z",
    )
    .unwrap();
    (root, state, turn)
}
fn write(html: &str) -> AuthorRequest {
    AuthorRequest::Write {
        based_on: None,
        state_contract: json!({}),
        title: "参数实验".into(),
        html: html.into(),
        readable_content: "已找到两处证据，共需三处。补齐后为一。".into(),
        source_ref_ids: vec![],
        assumptions: vec![],
        initial_state: json!({"count":2}),
    }
}
fn candidate(port: &mut impl ResidentStatePort, html: &str) -> String {
    port.author_presentation(write(html), &[], &[], &CancellationToken::default())
        .unwrap()
        .body["candidate_id"]
        .as_str()
        .unwrap()
        .into()
}
fn working() -> String {
    std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/presentation-author.html"),
    )
    .unwrap()
}

#[test]
fn presentation_author_requires_preview_and_current_source_bindings() {
    let (_root, mut state, turn) = setup();
    let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
    let mut port = RuntimeStatePort {
        port: &app,
        turn_ref: &turn,
        previewed: Default::default(),
    };
    let id = candidate(&mut port, &working());
    let error = port
        .author_presentation(
            AuthorRequest::Deliver { candidate_id: id },
            &[],
            &[],
            &CancellationToken::default(),
        )
        .err()
        .unwrap();
    assert!(error.message.contains("Preview"));
    let mut request = write(&working());
    if let AuthorRequest::Write { source_ref_ids, .. } = &mut request {
        source_ref_ids.push("invented".into());
    }
    assert_eq!(
        port.author_presentation(request, &[], &[], &CancellationToken::default())
            .err()
            .unwrap()
            .error_code,
        "PRESENTATION_SOURCE_UNKNOWN"
    );
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        port.author_presentation(write(&working()), &[], &[], &cancellation)
            .err()
            .unwrap()
            .error_code,
        "AGENT_RUN_CANCELLED"
    );
}

#[test]
#[ignore = "requires installed Chromium/Edge"]
fn presentation_author_browser_correction_and_private_delivery() {
    let (_root, mut state, turn) = setup();
    let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
    let mut port = RuntimeStatePort {
        port: &app,
        turn_ref: &turn,
        previewed: Default::default(),
    };
    let cancellation = CancellationToken::default();
    let broken = candidate(
        &mut port,
        &format!(
            "{}<script>throw new Error('RP4_BROKEN')</script>",
            working()
        ),
    );
    let failure = port
        .author_presentation(
            AuthorRequest::Preview { width: None, viewport: None,
                candidate_id: broken.clone(),
                actions: vec![],
            },
            &[],
            &[],
            &cancellation,
        )
        .unwrap();
    assert_eq!(failure.body["status"], "preview_failed");
    assert!(failure.body.to_string().contains("RP4_BROKEN"));
    assert!(port
        .author_presentation(
            AuthorRequest::Deliver {
                candidate_id: broken
            },
            &[],
            &[],
            &cancellation
        )
        .is_err());
    let fixed = candidate(&mut port, &working());
    let preview = port
        .author_presentation(
            AuthorRequest::Preview { width: None, viewport: None,
                candidate_id: fixed.clone(),
                actions: vec![PreviewAction::Click {
                    selector: "#add".into(),
                }],
            },
            &[],
            &[],
            &cancellation,
        )
        .unwrap();
    assert_eq!(
        preview.body["status"], "preview_ready_for_inspection",
        "{}",
        preview.body
    );
    assert!(preview.body["observations"][0]["dom"]["text"]
        .as_str()
        .unwrap()
        .contains("0.666666"));
    assert!(preview.body["observations"][1]["dom"]["text"]
        .as_str()
        .unwrap()
        .contains("1"));
    assert_eq!(preview.images.len(), 2);
    assert!(preview
        .images
        .iter()
        .all(|i| i.png_base64.starts_with("iVBOR")));
    let saved = port
        .author_presentation(
            AuthorRequest::Deliver {
                candidate_id: fixed,
            },
            &[],
            &[],
            &cancellation,
        )
        .unwrap()
        .delivered
        .unwrap();
    app.with_app(|state| {
        assert!(state.read_presentation(&turn.session_id, &saved).is_ok());
        let reply = crate::presentation_api::route(
            state,
            &json!({"session_id":turn.session_id,"turn_id":turn.turn_id,"reference":saved})
                .to_string(),
            false,
        );
        assert_ne!(reply.status, 200, "saved is not committed");
    });
}

#[test]
#[ignore = "requires installed Chromium/Edge"]
fn presentation_author_requires_three_explicit_environment_receipts() {
    let (_root, mut state, turn) = setup();
    let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
    let mut port = RuntimeStatePort {
        port: &app,
        turn_ref: &turn,
        previewed: Default::default(),
    };
    let candidate_id = candidate(
        &mut port,
        &format!("<style>button{{min-width:44px;min-height:44px}}</style>{}", working()),
    );
    let cancellation = CancellationToken::default();
    for (index, (name, viewport)) in REQUIRED_PREVIEW_ENVIRONMENTS.iter().enumerate() {
        let result = port.author_presentation(
            AuthorRequest::Preview {
                candidate_id: candidate_id.clone(),
                width: None,
                viewport: Some(*viewport),
                actions: vec![PreviewAction::Click { selector: "#add".into() }],
            },
            &[],
            &[],
            &cancellation,
        ).unwrap();
        assert_eq!(result.body["environment_name"], *name);
        assert_eq!(result.body["environment"], serde_json::to_value(viewport).unwrap());
        assert_eq!(
            result.body["status"],
            if index + 1 == REQUIRED_PREVIEW_ENVIRONMENTS.len() {
                "preview_ready_for_inspection"
            } else {
                "preview_environment_recorded"
            },
            "{}",
            result.body,
        );
    }
    assert!(port.author_presentation(
        AuthorRequest::Deliver { candidate_id },
        &[],
        &[],
        &cancellation,
    ).unwrap().delivered.is_some());
}

#[test]
#[ignore = "requires installed Chromium/Edge"]
fn presentation_author_browser_dynamic_semantics_and_cancel() {
    let (_root, mut state, turn) = setup();
    let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
    let mut port = RuntimeStatePort {
        port: &app,
        turn_ref: &turn,
        previewed: Default::default(),
    };
    let cancellation = CancellationToken::default();
    let id = candidate(
        &mut port,
        "<button id='bad' onclick=\"this.textContent='[[source:invented]]'\">运行</button>",
    );
    let result = port
        .author_presentation(
            AuthorRequest::Preview { width: None, viewport: None,
                candidate_id: id.clone(),
                actions: vec![PreviewAction::Click {
                    selector: "#bad".into(),
                }],
            },
            &[],
            &[],
            &cancellation,
        )
        .unwrap();
    assert_eq!(result.body["status"], "preview_failed");
    assert!(port
        .author_presentation(
            AuthorRequest::Deliver { candidate_id: id },
            &[],
            &[],
            &cancellation
        )
        .is_err());
    let id = candidate(&mut port, "<h1>停止测试</h1><script>while(true){}</script>");
    let stop = cancellation.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        stop.cancel();
    });
    let started = std::time::Instant::now();
    let error = port
        .author_presentation(
            AuthorRequest::Preview { width: None, viewport: None,
                candidate_id: id,
                actions: vec![],
            },
            &[],
            &[],
            &cancellation,
        )
        .err()
        .unwrap();
    stopper.join().unwrap();
    assert!(
        error.message.contains("AGENT_RUN_CANCELLED"),
        "{}",
        error.message
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

/// Real model owns generation, actions, repair and delivery. Only the first generated
/// candidate is deliberately corrupted, after generation and before actual execution.
struct FaultInjectionAdapter {
    inner: Box<dyn ModelAdapter + Send>,
    writes: std::sync::atomic::AtomicUsize,
    saw_failure: std::sync::atomic::AtomicBool,
    saw_images: std::sync::atomic::AtomicBool,
    evidence: std::path::PathBuf,
}
impl ModelAdapter for FaultInjectionAdapter {
    fn model_runtime_profile(&self) -> runtime::ModelRuntimeProfile {
        self.inner.model_runtime_profile()
    }
    fn set_run_cancellation(&self, cancellation: CancellationToken) {
        self.inner.set_run_cancellation(cancellation);
    }
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, runtime::AdapterError> {
        self.inner.complete(req)
    }
    fn complete_structured(&self, req: CompletionRequest) -> Result<Value, runtime::AdapterError> {
        self.inner.complete_structured(req)
    }
    fn chat(
        &self,
        request: &runtime::AgentRequestPlan,
    ) -> Result<runtime::AssistantTurn, runtime::AdapterError> {
        use std::sync::atomic::Ordering::SeqCst;
        for message in &request.input {
            if message
                .content
                .as_deref()
                .is_some_and(|s| s.contains("RP4_INJECTED_RUNTIME_FAILURE"))
            {
                self.saw_failure.store(true, SeqCst);
            }
        }
        if !request.preview_images.is_empty() {
            self.saw_images.store(true, SeqCst);
            for (index, image) in request.preview_images.iter().enumerate() {
                std::fs::write(
                    self.evidence.join(format!(
                        "write-{}-step-{index}.base64",
                        self.writes.load(SeqCst)
                    )),
                    &image.png_base64,
                )
                .unwrap();
            }
        }
        let mut turn = self.inner.chat(request)?;
        { use std::io::Write; let mut log=std::fs::OpenOptions::new().create(true).append(true).open(self.evidence.join("calls.jsonl")).unwrap();
          writeln!(log,"{}",json!({"tools":turn.tool_calls,"text":turn.text,"images":request.preview_images.len()})).unwrap(); }

        for call in &mut turn.tool_calls {
            if call.name != "presentation.author" {
                continue;
            }
            let mut args: Value = serde_json::from_str(&call.arguments).unwrap();
            if args["operation"] == "write" && args["html"].is_string() && self.writes.fetch_add(1, SeqCst) == 0 {
                args["html"] = json!(format!(
                    "{}<script>throw new Error('RP4_INJECTED_RUNTIME_FAILURE')</script>",
                    args["html"].as_str().unwrap()
                ));
                call.arguments = args.to_string();
            }
        }
        Ok(turn)
    }
}

#[test]
#[ignore = "real configured model plus installed browser; writes isolated evidence"]
fn presentation_author_real_model_repairs_and_delivers() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    let root = std::path::PathBuf::from(
        std::env::var("RP4_EVIDENCE_DIR").expect("set isolated RP4_EVIDENCE_DIR"),
    );
    std::fs::create_dir_all(&root).unwrap();
    let mut state = state_named("rp4-live-model");
    state.history_path = Some(root.join("history.json"));
    let config = ProviderConfig::from_env().unwrap();
    let model = config.model.clone();
    let adapter = FaultInjectionAdapter {
        inner: ProviderRegistry::adapter_from_config(config),
        writes: AtomicUsize::new(0),
        saw_failure: AtomicBool::new(false),
        saw_images: AtomicBool::new(false),
        evidence: root.clone(),
    };
    let request = json!({"message":"请现场制作一个中文交互页面，帮助我比较找到证据与忠实使用证据。采用我给定的实验假设：共需三处证据，起初找到两处，召回率2/3；加入无关材料不改变召回率；补齐第三处后为1。用两张并排卡片说明区别，并提供‘加入无关材料’和‘补齐证据’两个按钮、联动数值和图形。所有规则是本问题提供的假设，不需要书内检索。请实际操作两个按钮，检查运行错误及截图；发现错误则修改后重跑，完成后交付可交互内容。"});
    let prepared = prepare_agent_chat(&mut state, &request.to_string(), "2026-09-17T00:00:00Z")
        .unwrap_or_else(|r| panic!("prepare: {}", r.body));
    let turn_ref = prepared.turn_ref.clone();
    let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
    let started = std::time::Instant::now();
    let report =
        crate::agent_run::execute_prepared(&app, &adapter, prepared, CancellationToken::default());
    std::fs::write(root.join("outcome.json"), &report.reply.body).unwrap();
    std::fs::write(root.join("summary.json"),serde_json::to_vec_pretty(&json!({"model":model,"elapsed_ms":started.elapsed().as_millis(),"writes":adapter.writes.load(SeqCst),"saw_failure":adapter.saw_failure.load(SeqCst),"saw_images":adapter.saw_images.load(SeqCst),"http_status":report.reply.status})).unwrap()).unwrap();
    assert_eq!(report.reply.status, 200, "{}", report.reply.body);
    assert!(adapter.writes.load(SeqCst) >= 2, "model did not rewrite");
    assert!(adapter.saw_failure.load(SeqCst));
    assert!(adapter.saw_images.load(SeqCst));
    let outcome: OuterOutcome = serde_json::from_str(&report.reply.body).unwrap();
    let reference = outcome
        .answer_view
        .unwrap()
        .parts
        .into_iter()
        .find_map(|p| match p {
            AgentAnswerPart::Presentation {
                presentation_id,
                revision,
            } => Some(runtime::presentation::PresentationRef {
                presentation_id,
                revision,
            }),
            _ => None,
        })
        .expect("no delivered presentation");
    app.with_app(|state| {
        let version = state.read_presentation(&turn_ref.session_id,&reference).unwrap();
        assert!(!version.content.content_files[&version.content.entrypoint].contains("RP4_INJECTED_RUNTIME_FAILURE"));
        let response = crate::presentation_api::route(state,&json!({"session_id":turn_ref.session_id,"turn_id":turn_ref.turn_id,"reference":reference}).to_string(),false);
        assert_eq!(response.status,200,"{}",response.body);
        std::fs::write(root.join("view.json"),&response.body).unwrap();
    });
    let history = std::fs::read_to_string(root.join("history.json")).unwrap();
    assert!(!history.contains("<script>"));
    assert!(!history.contains("iVBOR"));
}

#[test]
#[ignore = "serves the already completed real model run for a bounded browser mount check"]
fn presentation_author_mount_host() {
    let root = std::path::PathBuf::from(std::env::var("RP4_EVIDENCE_DIR").unwrap());
    let mut state = state_named("rp4-mount");
    state.history_path = Some(root.join("history.json"));
    state.agent_history = load_agent_history(&state.history_path).unwrap();
    let session = state.agent_history.sessions.last().unwrap();
    let turn = session.turns.last().unwrap();
    let fixture = json!({"session_id":session.id,"turn_id":turn.turn_id,"outcome":turn.outcome});
    let server = tiny_http::Server::http("127.0.0.1:4175").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    println!("RP4_MOUNT_READY");
    while std::time::Instant::now() < deadline {
        let Some(mut request) = server.recv_timeout(Duration::from_secs(1)).unwrap() else {
            continue;
        };
        let path = request.url().to_string();
        if path == "/stop" {
            request
                .respond(tiny_http::Response::from_string("stopped"))
                .unwrap();
            break;
        }
        let reply = if path == "/fixture" {
            ok_json(&fixture)
        } else {
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            post(&mut state, &path, &body)
        };
        request
            .respond(
                tiny_http::Response::from_string(reply.body)
                    .with_status_code(reply.status)
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                    ),
            )
            .unwrap();
    }
}
