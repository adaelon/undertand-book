use runtime::{presentation_preview::*, run_context::CancellationToken};
use server::presentation_preview::BrowserPreview;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

fn request(html: &str, actions: Vec<PreviewAction>) -> PreviewRequest {
    PreviewRequest {
        candidate_id: "rp1-recall-1".into(),
        html: html.into(),
        actions,
        width: None,
        viewport: None,
    }
}
fn click(selector: &str) -> PreviewAction {
    PreviewAction::Click {
        selector: selector.into(),
    }
}
fn host() -> BrowserPreview {
    BrowserPreview::discover().expect("install preview browser for RP1 execution tests")
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_repeated_launches_release_profiles() {
    let browser = host();
    for _ in 0..3 {
        // preview returns success only after its owned process and profile are removed.
        let report = browser.preview(
            &request("<button id='change' onclick=\"this.textContent='changed'\">change</button>", vec![click("#change")]),
            &CancellationToken::default(),
        ).unwrap();
        assert!(report.observations.last().unwrap().dom["text"].as_str().unwrap().contains("changed"));
    }
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_key_targets_the_requested_control() {
    let actions = serde_json::from_value(serde_json::json!([
        {"kind":"click","selector":"#complete"},
        {"kind":"key","selector":"#count","key":"Home"},
        {"kind":"key","key":"ArrowRight"}
    ])).unwrap();
    let report = host().preview(&request(include_str!("fixtures/presentation-recall.html"), actions), &CancellationToken::default()).unwrap();
    assert!(report.observations[2].dom["text"].as_str().unwrap().contains("0/3 = 0.000"));
    assert!(report.observations[3].dom["text"].as_str().unwrap().contains("1/3 = 0.333"));
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_uses_requested_narrow_viewport() {
    let mut input = request("<style>body{margin:0}.wide{display:block}@media(max-width:400px){.wide{display:none}}</style><p class=wide>Wide layout</p><p>Narrow ready</p>", vec![]);
    input.width = Some(340);
    let report = host().preview(&input, &CancellationToken::default()).unwrap();
    assert_eq!(report.observations[0].layout["cssLayoutViewport"]["clientWidth"], 340);
    assert_eq!(report.environment, PreviewViewport { width: 340, height: 720, input: PreviewInput::Mouse });
    assert!(!report.observations[0].dom["text"].as_str().unwrap().contains("Wide layout"));
    input.width = Some(0);
    assert!(host().preview(&input, &CancellationToken::default()).unwrap_err().message.contains("width"));
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_uses_touch_input_and_reports_environment_layout_issues() {
    let html = r#"<style>body{margin:0;width:900px}button{width:30px;height:30px}</style>
      <button id='tap'>tap</button><input id='tiny-input' style='width:20px;height:20px'><output id='kind'>none</output>
      <script>tap.addEventListener('touchstart',()=>kind.textContent='touch');tap.addEventListener('mousedown',()=>{if(kind.textContent==='none')kind.textContent='mouse'});</script>"#;
    let mut touch = request(html, vec![click("#tap")]);
    touch.viewport = Some(PreviewViewport { width: 320, height: 420, input: PreviewInput::Touch });
    let report = host().preview(&touch, &CancellationToken::default()).unwrap();
    assert_eq!(report.environment_name, "narrow-content");
    assert!(report.observations.last().unwrap().dom["text"].as_str().unwrap().contains("touch"));
    assert!(report.observations[0].issues.iter().any(|issue| issue.kind == "geometry_overflow"));
    assert!(report.observations[0].issues.iter().any(|issue| issue.kind == "touch_target_small"));
    assert!(report.observations[0].issues.iter().any(|issue| issue.kind == "touch_target_small" && issue.message.contains("tiny-input")));

    let mut mouse = request(html, vec![click("#tap")]);
    mouse.viewport = Some(PreviewViewport { width: 960, height: 720, input: PreviewInput::Mouse });
    let report = host().preview(&mouse, &CancellationToken::default()).unwrap();
    assert!(report.observations.last().unwrap().dom["text"].as_str().unwrap().contains("mouse"));

    let mut combined_boundary = request(
        "<style>body{margin:0}button{min-width:44px;min-height:44px;max-width:100%}</style><button>ready</button>",
        vec![],
    );
    combined_boundary.viewport = Some(PreviewViewport { width: 320, height: 240, input: PreviewInput::Touch });
    let report = host().preview(&combined_boundary, &CancellationToken::default()).unwrap();
    assert_eq!(report.observations[0].layout["cssLayoutViewport"]["clientWidth"], 320);
    assert_eq!(report.observations[0].layout["cssLayoutViewport"]["clientHeight"], 240);
    assert!(report.observations[0].issues.is_empty(), "{:?}", report.observations[0].issues);
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_executes_graphics_and_real_input() {
    let report = host()
        .preview(
            &request(
                include_str!("fixtures/presentation-recall.html"),
                vec![
                    click("#irrelevant"),
                    click("#complete"),
                    click("#count"),
                    PreviewAction::Key { key: "End".into(), selector: None },
                    PreviewAction::Key {
                        key: "ArrowLeft".into(),
                        selector: None,
                    },
                ],
            ),
            &CancellationToken::default(),
        )
        .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let observations = &report.observations;
    assert!(observations[0].dom["text"]
        .as_str()
        .unwrap()
        .contains("2/3 = 0.667"));
    assert!(observations[1].dom["text"]
        .as_str()
        .unwrap()
        .contains("2/3 = 0.667"));
    assert!(observations[1].dom["text"]
        .as_str()
        .unwrap()
        .contains("无关材料：1"));
    assert!(observations[2].dom["text"]
        .as_str()
        .unwrap()
        .contains("3/3 = 1.000"));
    assert!(observations[5].dom["text"]
        .as_str()
        .unwrap()
        .contains("2/3 = 0.667"));
    assert_ne!(
        observations[1].screenshot_png_base64,
        observations[2].screenshot_png_base64
    );
    assert!(observations
        .iter()
        .all(|o| o.screenshot_png_base64.starts_with("iVBOR")
            && o.screenshot_png_base64.len() > 1000));
    assert_eq!(
        observations[0].layout["cssLayoutViewport"]["clientWidth"],
        960
    );
    assert!(observations[0].dom["elements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["tag"] == "CANVAS" && e["width"] == 360));
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_attributes_script_errors_and_failed_actions() {
    let report = host().preview(&request("<body><h1>candidate error</h1><script>throw new Error('rp1-deliberate-failure')</script></body>", vec![]), &CancellationToken::default()).unwrap();
    assert_eq!(report.candidate_id, "rp1-recall-1");
    assert!(report
        .errors
        .iter()
        .any(|e| e.to_string().contains("rp1-deliberate-failure")));
    let error = host()
        .preview(
            &request("<body>no button</body>", vec![click("#absent")]),
            &CancellationToken::default(),
        )
        .unwrap_err();
    assert_eq!(error.phase, "interact:1");
    assert_eq!(error.candidate_id, "rp1-recall-1");
    assert!(error.message.contains("control not found"));
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_stops_hung_javascript_on_cancel_and_deadline() {
    let request = request("<body><script>while(true){}</script></body>", vec![]);
    let stop = Arc::new(AtomicBool::new(false));
    let cancellation = CancellationToken::with_host_stop(stop.clone());
    let trigger = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        stop.store(true, std::sync::atomic::Ordering::Release);
    });
    let start = Instant::now();
    let error = host().preview(&request, &cancellation).unwrap_err();
    trigger.join().unwrap();
    assert_eq!(error.message, "AGENT_RUN_CANCELLED");
    assert!(start.elapsed() < Duration::from_secs(8));
    let mut host = host();
    host.timeout = Duration::from_secs(2);
    let error = host
        .preview(&request, &CancellationToken::default())
        .unwrap_err();
    assert_eq!(error.message, "PREVIEW_TIMEOUT");
}

#[test]
fn presentation_preview_pre_cancelled_never_launches_browser() {
    let host = BrowserPreview {
        executable: "missing-browser".into(),
        timeout: Duration::from_secs(1),
    };
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        host.preview(&request("", vec![]), &cancellation)
            .unwrap_err()
            .message,
        "AGENT_RUN_CANCELLED"
    );
}

#[cfg(unix)]
#[test]
fn presentation_preview_reports_browser_startup_stderr() {
    let host = BrowserPreview {
        executable: "/bin/sh".into(),
        timeout: Duration::from_secs(3),
    };
    let error = host
        .preview(
            &request("<body>test</body>", vec![]),
            &CancellationToken::default(),
        )
        .unwrap_err();
    assert_eq!(error.phase, "launch");
    assert_eq!(error.candidate_id, "rp1-recall-1");
    assert!(error.message.contains("exited before ready"));
    assert!(error.message.contains("option"), "{}", error.message);
}

#[test]
#[ignore = "requires a real installed Chromium/Edge browser"]
fn presentation_preview_has_no_reader_access_or_network_side_effects() {
    use std::io::ErrorKind;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let html = format!(
        r#"<body><output id="scope"></output><script>
    scope.value=JSON.stringify({{tauri:typeof window.__TAURI_INTERNALS__,parentIsSelf:parent===window}});
    fetch('http://{}/reader/state').catch(()=>{{}});
    </script></body>"#,
        listener.local_addr().unwrap()
    );
    let report = host()
        .preview(&request(&html, vec![]), &CancellationToken::default())
        .unwrap();
    let text = report.observations[0].dom["text"].as_str().unwrap();
    assert!(
        text.contains("undefined") && text.contains("true"),
        "{text}"
    );
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(report
        .errors
        .iter()
        .any(|e| e["method"] == "Network.loadingFailed"));
}
