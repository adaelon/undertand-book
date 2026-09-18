use super::*;
use runtime::presentation::*;

fn fixture() -> (tempfile::TempDir, AppState, AgentTurnRef) {
    let root = tempfile::tempdir().unwrap();
    let mut state = state_named("rp2-presentation");
    state.history_path = Some(root.path().join("agent-history.json"));
    let turn = next_turn(&mut state);
    (root, state, turn)
}
fn next_turn(state: &mut AppState) -> AgentTurnRef {
    let book_id = state.book.base.book_id.clone();
    precommit_agent_turn(
        state,
        &book_id,
        "Explain recall".into(),
        None,
        None,
        None,
        "2026-09-16T16:00:00Z",
    )
    .unwrap()
}
fn content(state: &AppState, title: &str) -> PresentationContent {
    let evidence_range = EvidenceRange {
        start_lid: "1.1".into(),
        end_lid: "1.1".into(),
        ranges: vec![],
    };
    let source = state
        .book
        .resolve_source(&evidence_range, "zh-CN", None)
        .unwrap();
    PresentationContent {
        title: title.into(),
        content_files: BTreeMap::from([(
            "index.html".into(),
            format!("<h1>{title}</h1><script>window.count=2</script>"),
        )]),
        entrypoint: "index.html".into(),
        readable_content: format!("{title}: two of three pieces of evidence"),
        source_bindings: vec![SourceBinding {
            source_ref_id: "source-rp2".into(),
            book_id: state.book.base.book_id.clone(),
            evidence_range,
            evidence_text_digest: source.evidence_text_digest,
            label_snapshot: source.label,
            preview_snapshot: source.preview,
        }],
        assumptions: vec!["Three required pieces".into()],
        state_contract: json!({"count":"integer from 0 to 3"}),
        initial_state: json!({"count":2}),
    }
}
fn create(
    state: &mut AppState,
    turn: &AgentTurnRef,
    based_on: Option<PresentationRef>,
    title: &str,
) -> PresentationCandidate {
    let content = content(state, title);
    state
        .create_presentation_candidate(&turn.session_id, &turn.turn_id, based_on, content)
        .unwrap()
}
fn persist(
    state: &mut AppState,
    turn: &AgentTurnRef,
    candidate: &PresentationCandidate,
) -> PresentationRef {
    state
        .persist_presentation_candidate(&turn.session_id, &turn.turn_id, &candidate.candidate_id)
        .unwrap()
}
fn outcome(reference: &PresentationRef) -> OuterOutcome {
    OuterOutcome {
        answer: Some("Recall example".into()),
        answer_view: Some(AgentAnswerView {
            parts: vec![AgentAnswerPart::Presentation {
                presentation_id: reference.presentation_id.clone(),
                revision: reference.revision,
            }],
            sources: vec![],
        }),
        incomplete: false,
        warning: None,
        turns: 1,
        tokens_spent: 0,
        effects: vec![],
        trace: vec![],
        profile_usage: Default::default(),
        memory_updates: vec![],
        source_bindings: vec![],
        delivery_diagnostics: None,
        request_audit: Default::default(),
    }
}
fn finish(
    state: &mut AppState,
    turn: &AgentTurnRef,
    reference: &PresentationRef,
) -> Result<(), ToolError> {
    let messages = state.messages.clone();
    finalize_agent_turn_completed(
        state,
        turn,
        &outcome(reference),
        &messages,
        "2026-09-16T16:01:00Z",
    )
}

#[test]
fn presentation_versions_reopen_with_original_history_and_explicit_edit_base() {
    let (_root, mut state, first_turn) = fixture();
    let first = create(&mut state, &first_turn, None, "Original");
    let first_ref = persist(&mut state, &first_turn, &first);
    assert_eq!(first_ref.revision, 1);
    assert_eq!(persist(&mut state, &first_turn, &first), first_ref);
    finish(&mut state, &first_turn, &first_ref).unwrap();
    let original_bytes = std::fs::read(state.history_path.as_ref().unwrap()).unwrap();
    assert!(!String::from_utf8_lossy(&original_bytes).contains("<script>"));

    let second_turn = next_turn(&mut state);
    let second = create(
        &mut state,
        &second_turn,
        Some(first_ref.clone()),
        "Add example",
    );
    let second_ref = persist(&mut state, &second_turn, &second);
    assert_eq!(second_ref.revision, 2);
    assert_eq!(first_ref.presentation_id, second_ref.presentation_id);
    finish(&mut state, &second_turn, &second_ref).unwrap();

    // Reconstruct AppState and reload the actual persisted history and content.
    let mut reopened = state_named("rp2-reopen");
    reopened.history_path = state.history_path.clone();
    reopened.agent_history = load_agent_history(&reopened.history_path).unwrap();
    assert_eq!(
        reopened
            .read_presentation(&first_turn.session_id, &first_ref)
            .unwrap()
            .content,
        first.content
    );
    let version = reopened
        .read_presentation(&first_turn.session_id, &second_ref)
        .unwrap();
    assert_eq!(version.based_on, Some(first_ref.clone()));
    assert_eq!(version.content, second.content);
    assert_eq!(
        reopened
            .read_presentation_candidate(&second_turn.session_id, &second.candidate_id)
            .unwrap(),
        second
    );
    let view = session_view(&reopened.agent_history.sessions[0], &reopened.book);
    assert_eq!(
        view.turns[0]
            .outcome
            .as_ref()
            .unwrap()
            .answer_view
            .as_ref()
            .unwrap()
            .parts,
        outcome(&first_ref).answer_view.unwrap().parts
    );
    assert_eq!(
        view.turns[1]
            .outcome
            .as_ref()
            .unwrap()
            .answer_view
            .as_ref()
            .unwrap()
            .parts,
        outcome(&second_ref).answer_view.unwrap().parts
    );
    // Supported old-version editing: new revision records revision 1 as its base.
    let third_turn = next_turn(&mut reopened);
    let third = create(
        &mut reopened,
        &third_turn,
        Some(first_ref.clone()),
        "Edit old view",
    );
    let third_ref = persist(&mut reopened, &third_turn, &third);
    assert_eq!(third_ref.revision, 3);
    assert_eq!(
        reopened
            .read_presentation(&third_turn.session_id, &third_ref)
            .unwrap()
            .based_on,
        Some(first_ref)
    );
}

#[test]
fn presentation_candidate_is_not_a_deliverable_and_missing_revision_cannot_finalize() {
    let (_root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "Unpublished");
    let invented = PresentationRef {
        presentation_id: candidate.presentation_id.clone(),
        revision: 1,
    };
    let before = std::fs::read(state.history_path.as_ref().unwrap()).unwrap();
    assert_eq!(
        finish(&mut state, &turn, &invented).unwrap_err().error_code,
        "PRESENTATION_NOT_FOUND"
    );
    assert_eq!(
        state.agent_history.sessions[0].turns[0].status,
        AgentAssistantStatus::PendingAssistant
    );
    assert_eq!(
        std::fs::read(state.history_path.as_ref().unwrap()).unwrap(),
        before
    );
    let reference = persist(&mut state, &turn, &candidate);
    finish(&mut state, &turn, &reference).unwrap();
    assert_eq!(
        state
            .persist_presentation_candidate(
                &turn.session_id,
                &turn.turn_id,
                &candidate.candidate_id
            )
            .unwrap_err()
            .error_code,
        "PRESENTATION_TURN_NOT_PENDING"
    );
}

#[test]
fn presentation_failed_saves_preserve_old_version_and_history() {
    let (root, mut state, turn) = fixture();
    let first = create(&mut state, &turn, None, "Original");
    let original = persist(&mut state, &turn, &first);
    finish(&mut state, &turn, &original).unwrap();
    let turn = next_turn(&mut state);
    let edit = create(&mut state, &turn, Some(original.clone()), "Changed");
    let version_dir = root
        .path()
        .join("agent-history.presentations/versions")
        .join(&original.presentation_id);
    // A real filesystem publication failure, without mocking the storage port.
    std::fs::create_dir(version_dir.join("2.json")).unwrap();
    let before = std::fs::read(state.history_path.as_ref().unwrap()).unwrap();
    assert!(state
        .persist_presentation_candidate(&turn.session_id, &turn.turn_id, &edit.candidate_id)
        .is_err());
    assert_eq!(
        state
            .read_presentation(&turn.session_id, &original)
            .unwrap()
            .content,
        first.content
    );
    assert_eq!(
        std::fs::read(state.history_path.as_ref().unwrap()).unwrap(),
        before
    );
    std::fs::remove_dir(version_dir.join("2.json")).unwrap();
    let saved = persist(&mut state, &turn, &edit);
    assert_eq!(saved.revision, 2);

    // Content saved, but the history commit fails: pending in memory/on disk, no answer receipt.
    let temporary = agent_history_temporary_path(state.history_path.as_ref().unwrap());
    std::fs::create_dir(&temporary).unwrap();
    assert!(finish(&mut state, &turn, &saved).is_err());
    assert_eq!(
        state.agent_history.sessions[0].turns[1].status,
        AgentAssistantStatus::PendingAssistant
    );
    assert_eq!(
        std::fs::read(state.history_path.as_ref().unwrap()).unwrap(),
        before
    );
    std::fs::remove_dir(temporary).unwrap();
    finish(&mut state, &turn, &saved).unwrap();

    let turn = next_turn(&mut state);
    let candidates = root.path().join("agent-history.presentations/candidates");
    let parked = root.path().join("saved-candidates");
    std::fs::rename(&candidates, &parked).unwrap();
    std::fs::write(&candidates, b"blocked directory").unwrap();
    let draft = content(&state, "Cannot save");
    assert_eq!(
        state
            .create_presentation_candidate(
                &turn.session_id,
                &turn.turn_id,
                Some(original.clone()),
                draft
            )
            .unwrap_err()
            .error_code,
        "PRESENTATION_STORAGE_FAILED"
    );
    assert_eq!(
        state
            .read_presentation(&turn.session_id, &original)
            .unwrap()
            .content,
        first.content
    );
}

#[test]
fn presentation_ownership_follows_book_session_and_pending_turn() {
    let (_root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "Owned");
    let reference = persist(&mut state, &turn, &candidate);
    let next = next_turn(&mut state);
    assert_eq!(
        state
            .persist_presentation_candidate(
                &next.session_id,
                &next.turn_id,
                &candidate.candidate_id
            )
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    let other = new_agent_session(&state.book.base.book_id, "2026-09-16T17:00:00Z", 1);
    let other_id = other.id.clone();
    state.agent_history.sessions.push(other);
    state
        .agent_history
        .active_by_book
        .insert(state.book.base.book_id.clone(), other_id.clone());
    // Historical, inactive session remains readable within the same book.
    assert!(state
        .read_presentation(&turn.session_id, &reference)
        .is_ok());
    assert_eq!(
        state
            .read_presentation(&other_id, &reference)
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    assert_eq!(
        state
            .read_presentation_candidate(&other_id, &candidate.candidate_id)
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    let other_turn = next_turn(&mut state);
    let draft = content(&state, "Cross-session edit");
    assert_eq!(
        state
            .create_presentation_candidate(
                &other_id,
                &other_turn.turn_id,
                Some(reference.clone()),
                draft
            )
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    assert_eq!(
        finish(&mut state, &other_turn, &reference)
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    let mut other_base = sample_base();
    other_base.book_id = "another-book".into();
    state.book = Book::new(other_base, &"X".repeat(100)).into();
    assert_eq!(
        state
            .read_presentation(&turn.session_id, &reference)
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
    let other_book_turn = next_turn(&mut state);
    assert_eq!(
        state
            .read_presentation(&other_book_turn.session_id, &reference)
            .unwrap_err()
            .error_code,
        "PRESENTATION_OWNER_MISMATCH"
    );
}

#[test]
fn presentation_rejects_invalid_content_and_unavailable_private_storage() {
    let (_root, mut state, turn) = fixture();
    let valid = content(&state, "Valid");
    for change in 0..4 {
        let mut draft = valid.clone();
        match change {
            0 => draft.entrypoint = "missing.html".into(),
            1 => {
                draft
                    .content_files
                    .insert("../outside.html".into(), "bad".into());
            }
            2 => draft.source_bindings[0].book_id = "other-book".into(),
            _ => draft.readable_content.clear(),
        }
        assert_eq!(
            state
                .create_presentation_candidate(&turn.session_id, &turn.turn_id, None, draft)
                .unwrap_err()
                .error_code,
            "PRESENTATION_INVALID"
        );
    }
    assert_eq!(
        state
            .read_presentation_candidate(&turn.session_id, "../history")
            .unwrap_err()
            .error_code,
        "PRESENTATION_INVALID"
    );
    state.history_path = None;
    assert_eq!(
        state
            .create_presentation_candidate(&turn.session_id, &turn.turn_id, None, valid)
            .unwrap_err()
            .error_code,
        "PRESENTATION_STORAGE_UNAVAILABLE"
    );
}

#[test]
fn presentation_cancelled_run_keeps_saved_old_content_without_committing_an_answer() {
    let (_root, mut state, turn) = fixture();
    let first = create(&mut state, &turn, None, "Original");
    let original = persist(&mut state, &turn, &first);
    finish(&mut state, &turn, &original).unwrap();
    let turn = next_turn(&mut state);
    let _edit = create(
        &mut state,
        &turn,
        Some(original.clone()),
        "Cancelled candidate",
    );
    finalize_agent_turn(
        &mut state,
        &turn,
        AgentAssistantStatus::Cancelled,
        None,
        Some(AgentTurnError {
            error_code: "AGENT_RUN_CANCELLED".into(),
            category: "cancelled".into(),
            message: "Stopped".into(),
        }),
        None,
        &[],
        "2026-09-16T17:00:00Z",
    )
    .unwrap();
    let history = load_agent_history(&state.history_path).unwrap();
    assert!(history.sessions[0].turns[1].outcome.is_none());
    assert_eq!(
        state
            .read_presentation(&turn.session_id, &original)
            .unwrap()
            .content,
        first.content
    );
}

#[test]
fn presentation_public_read_observation_and_source_use_delivered_revision() {
    let (_root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "Recall");
    let reference = persist(&mut state, &turn, &candidate);
    let request = json!({"session_id": turn.session_id, "turn_id": turn.turn_id, "reference": reference});
    assert_ne!(post(&mut state, "/agent/presentation.read", &request.to_string()).status, 200);
    finish(&mut state, &turn, &reference).unwrap();
    let response = post(&mut state, "/agent/presentation.read", &request.to_string());
    assert_eq!(response.status, 200);
    let public: Value = serde_json::from_str(&response.body).unwrap();
    assert_eq!(public["reference"]["revision"], 1);
    assert!(public.get("source_bindings").is_none());
    assert!(public.to_string().find("evidence_range").is_none());
    assert_ne!(public["sources"][0]["label"], "1.1");

    let mut observed = request.clone();
    observed["text"] = json!("Recall is 2/3; an unrelated document changes nothing.");
    observed["source_ref_ids"] = json!(["source-rp2"]);
    assert_eq!(post(&mut state, "/agent/presentation.observe", &observed.to_string()).status, 200);
    for text in ["See LID 1.1", "Internal position 1.1", "Claim [[source:invented]]"] {
        observed["text"] = json!(text);
        assert_ne!(post(&mut state, "/agent/presentation.observe", &observed.to_string()).status, 200, "{text}");
    }
    observed["text"] = json!("Recall is 1");
    observed["source_ref_ids"] = json!(["invented"]);
    assert_ne!(post(&mut state, "/agent/presentation.observe", &observed.to_string()).status, 200);
    let source = json!({"turn_id": turn.turn_id, "source_ref_id": "source-rp2"});
    assert_eq!(post(&mut state, "/agent/source.resolve", &source.to_string()).status, 200);
    assert_eq!(post(&mut state, "/agent/source.open", &source.to_string()).status, 200);
    let mut wrong = request.clone();
    wrong["turn_id"] = json!("not-this-turn");
    assert_ne!(post(&mut state, "/agent/presentation.read", &wrong.to_string()).status, 200);
}

#[test]
fn presentation_semantic_failure_cannot_commit_and_source_id_cannot_change_meaning() {
    let (_root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "See LID 1.1");
    let reference = persist(&mut state, &turn, &candidate);
    assert_eq!(finish(&mut state, &turn, &reference).unwrap_err().error_code, "PRESENTATION_PUBLIC_CONTENT_INVALID");
    let candidate = create(&mut state, &turn, None, "Good content");
    let reference = persist(&mut state, &turn, &candidate);
    let mut answer = outcome(&reference);
    let mut conflicting = candidate.content.source_bindings[0].clone();
    conflicting.preview_snapshot = "Different evidence".into();
    answer.source_bindings.push(conflicting);
    let messages = state.messages.clone();
    assert!(finalize_agent_turn_completed(&mut state, &turn, &answer, &messages, "2026-09-17T01:00:00Z").is_err());
    assert_eq!(state.agent_history.sessions[0].turns[0].status, AgentAssistantStatus::PendingAssistant);
}

/// Browser acceptance host: real private files, answer compiler and Reader routes.
#[test]
#[ignore = "starts a bounded HTTP fixture for playwright/agent-presentation.spec.ts"]
fn presentation_browser_host() {
    let (_root, mut state, turn) = fixture();
    let mut draft = content(&state, "证据召回率");
    draft.readable_content = "需要三处证据，找到两处时召回率为 2/3；加入无关材料不改变召回率，补齐第三处后为 1。 [[source:source-rp2]]".into();
    draft.content_files.insert("index.html".into(), std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/presentation-answer.html")
    ).unwrap());
    let candidate = state.create_presentation_candidate(&turn.session_id, &turn.turn_id, None, draft).unwrap();
    let reference = persist(&mut state, &turn, &candidate);
    finish(&mut state, &turn, &reference).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:4175").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    state.adapter = Box::new(ChatRecordingAdapter { seen_messages: seen.clone() });
    let mut fail_state = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    println!("RP3_BROWSER_READY");
    while std::time::Instant::now() < deadline {
        let Some(mut request) = server.recv_timeout(Duration::from_secs(1)).unwrap() else { continue; };
        let path = request.url().to_string();
        let reply = if path == "/fixture" {
            ok_json(&json!({"session_id": turn.session_id, "turn_id": turn.turn_id, "reference": reference, "outcome": outcome(&reference)}))
        } else if path == "/requests" {
            ok_json(&*seen.lock().unwrap())
        } else if path == "/reopen" {
            let history_path = state.history_path.clone();
            state = state_named("rp6-reopened-browser");
            state.history_path = history_path;
            state.agent_history = load_agent_history(&state.history_path).unwrap();
            state.adapter = Box::new(ChatRecordingAdapter { seen_messages: seen.clone() });
            ok_json(&json!({"ok":true}))
        } else if path == "/reset-scene" {
            let directory = _root.path().join("agent-history.presentations/states");
            if directory.exists() { std::fs::remove_dir_all(directory).unwrap(); }
            ok_json(&json!({"ok":true}))
        } else if path == "/fail-next-state" {
            fail_state = true; ok_json(&json!({"ok":true}))
        } else if path == "/agent/presentation.state.save" && fail_state {
            fail_state = false;
            err_reply(&ToolError { error_code:"PRESENTATION_STORAGE_FAILED".into(),category:"internal".into(),message:"验收：现场写入失败".into() })
        } else if path == "/stop" {
            request.respond(tiny_http::Response::from_string("stopped")).unwrap(); break;
        } else {
            let mut body = String::new(); request.as_reader().read_to_string(&mut body).unwrap();
            post(&mut state, &path, &body)
        };
        request.respond(tiny_http::Response::from_string(reply.body).with_status_code(reply.status)
            .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())).unwrap();
    }
}

fn save_scene(state: &mut AppState, turn: &AgentTurnRef, reference: &PresentationRef, count: u32) -> PresentationFollowUp {
    let response = post(state, "/agent/presentation.state.save", &json!({
        "session_id":turn.session_id,"turn_id":turn.turn_id,"reference":reference,
        "state":{"values":{"count":count},"visible_step":"compare","observed_result":format!("Found {count} of 3 required pieces"),"source_ref_ids":["source-rp2"]}
    }).to_string());
    assert_eq!(response.status, 200, "{}", response.body);
    serde_json::from_str(&response.body).unwrap()
}

#[test]
fn presentation_rp6_reopens_exact_version_and_requested_snapshot() {
    let (_root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "Original");
    let original = persist(&mut state, &turn, &candidate);
    finish(&mut state, &turn, &original).unwrap();
    let saved = save_scene(&mut state, &turn, &original, 1);
    save_scene(&mut state, &turn, &original, 2);
    let next = next_turn(&mut state);
    let candidate = create(&mut state, &next, Some(original.clone()), "New version");
    let new = persist(&mut state, &next, &candidate);
    finish(&mut state, &next, &new).unwrap();
    save_scene(&mut state, &next, &new, 3);
    let mut reopened = state_named("rp6-reopened");
    reopened.history_path = state.history_path.clone();
    reopened.agent_history = load_agent_history(&reopened.history_path).unwrap();
    let mut request = json!({"session_id":turn.session_id,"turn_id":turn.turn_id,"reference":original});
    let read = |state: &mut AppState, request: &Value| -> Value {
        let reply = post(state, "/agent/presentation.read", &request.to_string());
        assert_eq!(reply.status, 200, "{}", reply.body);
        serde_json::from_str(&reply.body).unwrap()
    };
    let latest = read(&mut reopened, &request);
    assert_eq!(latest["restored_state"]["values"]["count"], 2);
    assert_eq!(latest["reference"], json!(original));
    request["saved_state"] = json!(saved);
    let exact = read(&mut reopened, &request);
    assert_eq!(exact["restored_state"]["values"]["count"], 1);
    assert_eq!(exact["restored_state_revision"], saved.state_revision);
    request["reference"] = json!(new);
    request["turn_id"] = json!(next.turn_id);
    assert_ne!(post(&mut reopened, "/agent/presentation.read", &request.to_string()).status, 200);
}

#[test]
#[ignore = "requires installed Chromium/Edge"]
fn presentation_rp6_edit_rehearses_inherited_state_and_delivers_new_revision() {
    use crate::agent_run::{BorrowedAppPort, RuntimeStatePort};
    use runtime::{presentation_author::AuthorRequest, run_context::{CancellationToken, ResidentStatePort}};
    let (_root, mut state, first) = fixture();
    let mut draft = content(&state, "Original");
    draft.state_contract = json!({"count":"integer evidence count 0..3"});
    let candidate = state.create_presentation_candidate(&first.session_id, &first.turn_id, None, draft.clone()).unwrap();
    let reference = persist(&mut state, &first, &candidate);
    finish(&mut state, &first, &reference).unwrap();
    state.save_presentation_state(&first.session_id, &first.turn_id, &reference, PresentationState {
        values:json!({"page":{"count":1},"controls":[]}), visible_step:None, observed_result:"Found one piece".into(), source_ref_ids:vec![],
    }).unwrap();
    let turn = next_turn(&mut state);
    let updated;
    {
        let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
        let mut port = RuntimeStatePort { port:&app, turn_ref:&turn, previewed:Default::default() };
        let cancel = CancellationToken::default();
        let read = port.author_presentation(AuthorRequest::Read { reference:reference.clone(), file:None, offset:0 }, &[], &[], &cancel).unwrap();
        assert_eq!(read.body["title"], "Original");
        let write = port.author_presentation(AuthorRequest::Write {
            based_on:Some(reference.clone()), state_contract:draft.state_contract.clone(), initial_state:json!({"count":2}),
            title:"Added example".into(), readable_content:"Updated example with inherited count".into(), source_ref_ids:vec![], assumptions:vec![],
            html:"<h1>Added example</h1><output id='result'></output><script>document.querySelector('#result').textContent='Found '+window.presentation.initialState.count;window.presentation.registerStateRestorer(()=>{});</script>".into(),
        }, &[], &[], &cancel).unwrap();
        let candidate_id = write.body["candidate_id"].as_str().unwrap().to_string();
        let preview = port.author_presentation(AuthorRequest::Preview { width: None, viewport: None, candidate_id:candidate_id.clone(), actions:vec![] }, &[], &[], &cancel).unwrap();
        assert_eq!(preview.body["status"], "preview_ready_for_inspection", "{}", preview.body);
        assert!(preview.body["observations"][0]["dom"]["text"].as_str().unwrap().contains("Found 1"));
        updated = port.author_presentation(AuthorRequest::Deliver { candidate_id }, &[], &[], &cancel).unwrap().delivered.unwrap();
    }
    finish(&mut state, &turn, &updated).unwrap();
    assert_eq!(updated.presentation_id, reference.presentation_id);
    assert_eq!(updated.revision, 2);
    assert_eq!(state.read_presentation(&first.session_id, &reference).unwrap().content, draft);
    assert_eq!(state.read_presentation(&turn.session_id, &updated).unwrap().based_on, Some(reference));
}

#[test]
fn presentation_rp6_author_reads_old_code_and_inherits_only_compatible_frozen_parameters() {
    use crate::agent_run::{BorrowedAppPort, RuntimeStatePort};
    use runtime::{presentation_author::AuthorRequest, run_context::{CancellationToken, ResidentStatePort}};
    let (root, mut state, first) = fixture();
    let mut draft = content(&state, "Original");
    draft.state_contract = json!({"count":"integer evidence count 0..3", "unit":"seconds", "mode":"display mode", "shape":"shape"});
    draft.content_files.insert("details.txt".into(), "参数说明".repeat(1200));
    let original = state.create_presentation_candidate(&first.session_id, &first.turn_id, None, draft.clone()).unwrap();
    let reference = persist(&mut state, &first, &original);
    finish(&mut state, &first, &reference).unwrap();
    let scene = |count| PresentationState { values:json!({"page":{"count":count,"unit":9,"mode":7,"shape":{"old":true}},"controls":[]}), visible_step:Some("explain".into()), observed_result:"Recall experiment".into(), source_ref_ids:vec![] };
    let receipt = state.save_presentation_state(&first.session_id, &first.turn_id, &reference, scene(1)).unwrap();
    let prepared = prepare_agent_chat(&mut state, &json!({"message":"Add an example", "presentation_follow_up":receipt}).to_string(), "now").unwrap_or_else(|r| panic!("{}", r.body));
    assert!(prepared.agent_message.contains(&reference.presentation_id));
    state.save_presentation_state(&first.session_id, &first.turn_id, &reference, scene(3)).unwrap();
    let turn = prepared.turn_ref;
    let id;
    {
        let app = BorrowedAppPort(std::cell::RefCell::new(&mut state));
        let mut port = RuntimeStatePort { port:&app, turn_ref:&turn, previewed:Default::default() };
        let read = port.author_presentation(AuthorRequest::Read { reference:reference.clone(), file:None, offset:0 }, &[], &[], &CancellationToken::default()).unwrap();
        assert_eq!(read.body["text"], draft.content_files["index.html"]);
        assert_eq!(read.body["total_characters"], draft.content_files["index.html"].chars().count());
        assert_eq!(read.body["chunk_characters"], 4000);
        assert_eq!(read.body["source_ref_ids"], json!(["source-rp2"]));
        assert!(read.body.get("source_bindings").is_none());
        let mut offset = 0;
        let mut restored = String::new();
        loop {
            let chunk = port.author_presentation(AuthorRequest::Read { reference:reference.clone(), file:Some("details.txt".into()), offset }, &[], &[], &CancellationToken::default()).unwrap();
            restored.push_str(chunk.body["text"].as_str().unwrap());
            let Some(next) = chunk.body["next_offset"].as_u64() else { break; };
            offset = next as usize;
        }
        assert_eq!(restored, draft.content_files["details.txt"]);
        let written = port.author_presentation(AuthorRequest::Write {
            based_on:Some(reference.clone()), title:"Added example".into(), html:"<p>New example</p>".into(), readable_content:"New example".into(),
            source_ref_ids:vec!["source-rp2".into()], assumptions:vec![],
            state_contract:json!({"count":"integer evidence count 0..3", "unit":"milliseconds", "mode":"display mode", "shape":"shape"}),
            initial_state:json!({"count":2,"unit":100,"mode":"text","shape":{},"new":5}),
        }, &[], &[], &CancellationToken::default()).unwrap();
        assert_eq!(written.body["initial_state"], json!({"count":1,"unit":100,"mode":"text","shape":{},"new":5}));
        id = written.body["candidate_id"].as_str().unwrap().to_string();
    }
    let candidate = state.read_presentation_candidate(&turn.session_id, &id).unwrap();
    assert_eq!(candidate.based_on, Some(reference.clone()));
    assert_eq!(candidate.content.source_bindings, draft.source_bindings);
    let updated = persist(&mut state, &turn, &candidate);
    finish(&mut state, &turn, &updated).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(state.read_presentation(&first.session_id, &reference).unwrap().content, draft);
    let pending = next_turn(&mut state);
    let failed = create(&mut state, &pending, Some(reference.clone()), "Failed edit");
    // Actual version-write failure leaves both committed answers intact.
    let directory = root.path().join("agent-history.presentations/versions").join(&reference.presentation_id).join("3.json");
    std::fs::create_dir(&directory).unwrap();
    assert!(state.persist_presentation_candidate(&pending.session_id, &pending.turn_id, &failed.candidate_id).is_err());
    assert_eq!(state.read_presentation(&first.session_id, &reference).unwrap().content, draft);
    assert_eq!(state.read_presentation(&turn.session_id, &updated).unwrap().reference, updated);
}

#[test]
fn presentation_follow_up_freezes_old_version_and_exact_state_in_model_and_history() {
    let (_root, mut state, first) = fixture();
    let candidate = create(&mut state, &first, None, "Original");
    let original = persist(&mut state, &first, &candidate);
    finish(&mut state, &first, &original).unwrap();
    let saved = save_scene(&mut state, &first, &original, 2);
    let newer_state = save_scene(&mut state, &first, &original, 3);
    assert_eq!(newer_state.state_revision, saved.state_revision + 1);
    let second = next_turn(&mut state);
    let edit = create(&mut state, &second, Some(original.clone()), "Changed");
    let updated = persist(&mut state, &second, &edit);
    finish(&mut state, &second, &updated).unwrap();
    let updated_scene = save_scene(&mut state, &second, &updated, 1);
    assert_eq!(updated_scene.state_revision, 1);
    let seen = Arc::new(Mutex::new(Vec::new()));
    state.adapter = Box::new(ChatRecordingAdapter { seen_messages: seen.clone() });
    let response = post(&mut state, "/agent/chat", &json!({"message":"Explain this result", "presentation_follow_up":saved}).to_string());
    assert_eq!(response.status, 200, "{}", response.body);
    let requests = seen.lock().unwrap();
    let user = requests[0].iter().rev().find(|message| message.role == runtime::Role::User).unwrap().content.as_ref().unwrap();
    assert!(user.contains("Found 2 of 3 required pieces"), "{user}");
    assert!(user.contains(&saved.saved_state_ref));
    assert!(!user.contains(&newer_state.saved_state_ref));
    assert!(!user.contains("<script>"));
    let disk = load_agent_history(&state.history_path).unwrap();
    assert_eq!(disk.sessions[0].turns.last().unwrap().presentation_follow_up.as_ref(), Some(&saved));
    assert!(disk.sessions[0].messages.iter().any(|message| message.content.as_ref().is_some_and(|s| s.contains(&saved.saved_state_ref))));
    let mut reopened = state_named("rp5-reopened");
    reopened.history_path = state.history_path.clone();
    reopened.agent_history = disk;
    assert_eq!(reopened.read_presentation_state(&saved).unwrap().state.values, json!({"count":2}));
}

#[test]
fn presentation_follow_up_rejects_receipt_mixup_before_precommit() {
    let (_root, mut state, first) = fixture();
    let candidate = create(&mut state, &first, None, "Original");
    let original = persist(&mut state, &first, &candidate);
    finish(&mut state, &first, &original).unwrap();
    let saved = save_scene(&mut state, &first, &original, 2);
    let second = next_turn(&mut state);
    let edit = create(&mut state, &second, Some(original.clone()), "Changed");
    let updated = persist(&mut state, &second, &edit);
    finish(&mut state, &second, &updated).unwrap();
    let before = std::fs::read(state.history_path.as_ref().unwrap()).unwrap();
    for kind in 0..5 {
        let mut wrong = saved.clone();
        match kind {
            0 => { wrong.reference = updated.clone(); wrong.turn_id = second.turn_id.clone(); },
            1 => wrong.state_revision += 1,
            2 => wrong.saved_state_ref = "absent".into(),
            3 => wrong.turn_id = second.turn_id.clone(),
            _ => wrong.session_id = "other-session".into(),
        }
        assert!(prepare_agent_chat(&mut state, &json!({"message":"Explain", "presentation_follow_up":wrong}).to_string(), "now").is_err());
        assert_eq!(std::fs::read(state.history_path.as_ref().unwrap()).unwrap(), before);
    }
    let other = new_agent_session(&state.book.base.book_id, "later", 5);
    state.agent_history.active_by_book.insert(state.book.base.book_id.clone(), other.id.clone());
    state.agent_history.sessions.push(other);
    assert!(presentation_api::follow_up_context(&state, &saved).is_err());
}

#[test]
fn presentation_state_save_failure_and_invalid_semantics_return_no_receipt() {
    let (root, mut state, turn) = fixture();
    let candidate = create(&mut state, &turn, None, "Original");
    let reference = persist(&mut state, &turn, &candidate);
    let mut request = json!({"session_id":turn.session_id,"turn_id":turn.turn_id,"reference":reference,
        "state":{"values":{"count":2},"visible_step":null,"observed_result":"Found two pieces","source_ref_ids":[]}});
    assert_ne!(post(&mut state, "/agent/presentation.state.save", &request.to_string()).status, 200);
    finish(&mut state, &turn, &reference).unwrap();
    request["state"]["observed_result"] = json!("Internal position 1.1");
    assert_ne!(post(&mut state, "/agent/presentation.state.save", &request.to_string()).status, 200);
    request["state"]["observed_result"] = json!("Found two pieces");
    std::fs::write(root.path().join("agent-history.presentations/states"), b"blocked directory").unwrap();
    let failed = post(&mut state, "/agent/presentation.state.save", &request.to_string());
    assert_ne!(failed.status, 200);
    let error: Value = serde_json::from_str(&failed.body).unwrap();
    assert_eq!(error["error_code"], "PRESENTATION_STORAGE_FAILED");
    assert!(error.get("saved_state_ref").is_none());
    assert_eq!(state.agent_history.sessions[0].turns.len(), 1);
}
