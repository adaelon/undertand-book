//! An ephemeral Chromium process owned by one bounded preview call.
//! No Reader URL, Tauri IPC, provider settings or user browser profile enters the page.
use runtime::{presentation_preview::*, run_context::CancellationToken};
use serde_json::{json, Value};
use std::{
    fs, io,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};

pub struct BrowserPreview {
    pub executable: PathBuf,
    pub timeout: Duration,
}

impl BrowserPreview {
    /// Same discovery in the installed desktop and Linux Server. No Node/Playwright runtime.
    pub fn discover() -> Result<Self, String> {
        if let Some(path) = std::env::var_os("UNDERSTAND_BOOK_PREVIEW_BROWSER") {
            let executable = PathBuf::from(path);
            return executable.is_file().then_some(Self { executable, timeout: Duration::from_secs(30) })
                .ok_or_else(|| "UNDERSTAND_BOOK_PREVIEW_BROWSER must name an installed Chromium/Edge executable".into());
        }
        let mut paths = Vec::new();
        if cfg!(windows) {
            for root in ["PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"] {
                if let Some(root) = std::env::var_os(root) {
                    paths.push(PathBuf::from(root).join("Microsoft/Edge/Application/msedge.exe"));
                }
            }
        } else {
            paths.extend(
                [
                    "/usr/bin/chromium",
                    "/usr/bin/chromium-browser",
                    "/usr/bin/google-chrome",
                ]
                .map(PathBuf::from),
            );
        }
        paths.into_iter().find(|p| p.is_file())
            .map(|executable| Self { executable, timeout: Duration::from_secs(30) })
            .ok_or_else(|| "Preview browser unavailable: install Edge/Chromium or set UNDERSTAND_BOOK_PREVIEW_BROWSER".into())
    }
}

struct BrowserProcess {
    child: Child,
    profile: Option<tempfile::TempDir>,
}

impl BrowserProcess {
    fn stop(&mut self) -> Result<(), String> {
        if self.profile.is_none() {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Only this preview's process tree. Never touch a user's existing browser.
            let output = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;
            // taskkill may report an already-exited renderer as a failure while the
            // root is still completing termination. Observe the owned process exit.
            let until = Instant::now() + Duration::from_secs(3);
            while self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                if Instant::now() >= until {
                    return Err(format!(
                        "could not terminate preview browser tree ({}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
        #[cfg(unix)]
        unsafe {
            // The child starts a new process group; renderers are stopped even if JS is hung.
            if libc::kill(-(self.child.id() as i32), libc::SIGKILL) != 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            {
                return Err(io::Error::last_os_error().to_string());
            }
        }
        self.child.wait().map_err(|e| e.to_string())?;
        // Windows may release profile handles shortly after process termination.
        let path = self.profile.as_ref().unwrap().path();
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match fs::remove_dir_all(path) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => break,
                Err(_) if Instant::now() < until => thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(format!("preview profile cleanup: {e}")),
            }
        }
        self.profile.take();
        Ok(())
    }
}
impl Drop for BrowserProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct Cdp<'a> {
    socket: WebSocket<TcpStream>,
    next_id: u64,
    session: Option<String>,
    errors: Vec<Value>,
    cancellation: &'a CancellationToken,
    deadline: Instant,
}

fn check(cancellation: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancellation.is_cancelled() {
        return Err("AGENT_RUN_CANCELLED".into());
    }
    if Instant::now() >= deadline {
        return Err("PREVIEW_TIMEOUT".into());
    }
    Ok(())
}

impl Cdp<'_> {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        check(self.cancellation, self.deadline)?;
        self.next_id += 1;
        let id = self.next_id;
        let mut command = json!({"id":id,"method":method,"params":params});
        if let Some(session) = &self.session {
            command["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(command.to_string().into()))
            .map_err(|e| e.to_string())?;
        loop {
            check(self.cancellation, self.deadline)?;
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    if event["method"] == "Runtime.exceptionThrown"
                        || (event["method"] == "Runtime.consoleAPICalled"
                            && event["params"]["type"] == "error")
                        || event["method"] == "Network.loadingFailed"
                    {
                        if self.errors.len() < 64 {
                            self.errors.push(event.clone());
                        }
                    }
                    if event["id"] == id {
                        if let Some(error) = event.get("error") {
                            return Err(format!("{method}: {error}"));
                        }
                        return Ok(event["result"].clone());
                    }
                }
                Ok(Message::Close(_)) => return Err("preview browser disconnected".into()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.call(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        )?;
        if let Some(error) = result.get("exceptionDetails") {
            return Err(format!("page inspection: {error}"));
        }
        Ok(result["result"]["value"].clone())
    }

    fn observe(
        &mut self,
        step: usize,
        environment: PreviewViewport,
    ) -> Result<PreviewObservation, String> {
        // Wait for real rendering work rather than accepting a page-reported ready flag.
        self.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")?;
        let dom = self.evaluate(r#"(() => ({
          text: document.body.innerText.slice(0, 16000),
          semantic_text: (()=>{const copy=document.body.cloneNode(true);copy.querySelectorAll('script,style,[data-source-ref]').forEach(e=>e.remove());return [copy.textContent,...[...document.querySelectorAll('[alt],[title],[aria-label],input,textarea,select')].map(e=>[e.getAttribute('alt'),e.getAttribute('title'),e.getAttribute('aria-label'),e.value].filter(Boolean).join(' '))].join('\n');})(),
          source_ref_ids: [...document.querySelectorAll('[data-source-ref]')].map(e=>e.getAttribute('data-source-ref')),
          unsupported_assets: [...document.querySelectorAll('script[src],script[type=module],link[rel=stylesheet],img:not([src^="data:"]),iframe,object,embed')].map(e=>e.outerHTML.slice(0,200)),
          controls: [...document.querySelectorAll('input,select,textarea,button,output')].slice(0,128).map(e => ({
            id:e.id,tag:e.tagName,value:e.value,checked:e.checked,text:e.textContent.slice(0,256)})),
          elements: [...document.querySelectorAll('body > *,svg,canvas')].slice(0,128).map(e => {
            const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,x:r.x,y:r.y,width:r.width,height:r.height};
          })
        }))()"#)?;
        let layout = self.call("Page.getLayoutMetrics", json!({}))?;
        let audit = self.evaluate(&format!(r#"(() => {{
          const width=document.documentElement.clientWidth;
          const controls=[...document.querySelectorAll('button,a[href],[role=button],input,select,textarea')].slice(0,128).map((e,index)=>{{
            const r=e.getBoundingClientRect();return {{index,tag:e.tagName,id:e.id,width:r.width,height:r.height,hidden:!r.width||!r.height,small_touch:{}&&(r.width<44||r.height<44)}};
          }});
          return {{horizontal_overflow:document.documentElement.scrollWidth>width+1,scroll_width:document.documentElement.scrollWidth,client_width:width,controls}};
        }})()"#, matches!(environment.input, PreviewInput::Touch)))?;
        let mut issues = Vec::new();
        if audit["horizontal_overflow"].as_bool() == Some(true) {
            issues.push(PreviewIssue {
                kind: "geometry_overflow".into(),
                message: format!(
                    "document scroll width {} exceeds content viewport {}",
                    audit["scroll_width"], audit["client_width"]
                ),
            });
        }
        for control in audit["controls"].as_array().into_iter().flatten() {
            if control["hidden"].as_bool() == Some(true) {
                issues.push(PreviewIssue {
                    kind: "control_unactionable".into(),
                    message: format!("control {} has no actionable box", control["id"]),
                });
            } else if control["small_touch"].as_bool() == Some(true) {
                issues.push(PreviewIssue {
                    kind: "touch_target_small".into(),
                    message: format!(
                        "control {} is {}x{} CSS pixels",
                        control["id"], control["width"], control["height"]
                    ),
                });
            }
        }
        let screenshot = self.call(
            "Page.captureScreenshot",
            json!({"format":"png","captureBeyondViewport":false}),
        )?;
        Ok(PreviewObservation {
            step,
            dom,
            layout,
            screenshot_png_base64: screenshot["data"]
                .as_str()
                .ok_or("missing screenshot")?
                .into(),
            issues,
        })
    }

    fn interact(&mut self, action: &PreviewAction, input: PreviewInput) -> Result<(), String> {
        match action {
            PreviewAction::Click { selector } => {
                let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
                let point = self.evaluate(&format!(r#"(() => {{
                  const e=document.querySelector({selector});if(!e) throw new Error('control not found');
                  e.scrollIntoView({{block:'center'}});const r=e.getBoundingClientRect();
                  if(!r.width || !r.height || e.disabled) throw new Error('control not actionable');
                  const x=r.x+r.width/2,y=r.y+r.height/2;
                  if(!e.contains(document.elementFromPoint(x,y))) throw new Error('control covered');
                  return {{x,y}};
                }})()"#))?;
                if matches!(input, PreviewInput::Touch) {
                    self.call("Input.dispatchTouchEvent", json!({"type":"touchStart","touchPoints":[{"x":point["x"],"y":point["y"],"radiusX":1,"radiusY":1,"force":1}]}))?;
                    self.call("Input.dispatchTouchEvent", json!({"type":"touchEnd","touchPoints":[]}))?;
                } else {
                    for kind in ["mousePressed", "mouseReleased"] {
                        self.call("Input.dispatchMouseEvent", json!({"type":kind,"x":point["x"],"y":point["y"],"button":"left","clickCount":1}))?;
                    }
                }
            }
            PreviewAction::Key { key, selector } => {
                if let Some(selector) = selector {
                    let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
                    self.evaluate(&format!(r#"(() => {{
                      const e=document.querySelector({selector});if(!e) throw new Error('control not found');
                      e.scrollIntoView({{block:'center'}});const r=e.getBoundingClientRect();
                      if(!r.width || !r.height || e.disabled) throw new Error('control not actionable');
                      e.focus();if(document.activeElement!==e) throw new Error('control not focusable');
                      return true;
                    }})()"#))?;
                }
                let code = match key.as_str() {
                    "ArrowLeft" => 37,
                    "ArrowUp" => 38,
                    "ArrowRight" => 39,
                    "ArrowDown" => 40,
                    "Home" => 36,
                    "End" => 35,
                    "Enter" => 13,
                    "Tab" => 9,
                    _ => return Err("unsupported preview key".into()),
                };
                for kind in ["keyDown", "keyUp"] {
                    self.call(
                        "Input.dispatchKeyEvent",
                        json!({"type":kind,"key":key,"code":key,"windowsVirtualKeyCode":code}),
                    )?;
                }
            }
        }
        Ok(())
    }
}

impl PresentationPreviewPort for BrowserPreview {
    fn preview(
        &self,
        request: &PreviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<PreviewReport, PreviewError> {
        let mut phase = "launch".to_string();
        let result = (|| -> Result<PreviewReport, String> {
            let deadline = Instant::now() + self.timeout;
            check(cancellation, deadline)?;
            let environment = request.environment()?;
            if request.candidate_id.is_empty()
                || request.html.len() > 2 * 1024 * 1024
                || request.actions.len() > 16
            {
                return Err(
                    "preview requires candidate_id, at most 2 MiB HTML and 16 actions".into(),
                );
            }
            let profile = tempfile::Builder::new()
                .prefix("understand-book-preview-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            let log_path = profile.path().join("browser.log");
            let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
            let mut command = Command::new(&self.executable);
            command
                .args([
                    "--headless=new",
                    "--remote-debugging-port=0",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-networking",
                ])
                .arg(format!("--user-data-dir={}", profile.path().display()))
                .arg("about:blank")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // Edge otherwise may relaunch through its compatibility layer and
                // exit this owned PID, leaving the real browser/profile orphaned.
                command.arg("--edge-skip-compat-layer-relaunch");
                command.creation_flags(0x08000000);
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
                // The Reader service's home may be root-owned. Crashpad and browser
                // settings must live with this preview, not in the service home.
                command.env("XDG_CONFIG_HOME", profile.path().join("config"));
                command.env("XDG_CACHE_HOME", profile.path().join("cache"));
            }
            let child = command
                .spawn()
                .map_err(|e| format!("preview browser launch: {e}"))?;
            drop(command);
            let mut process = BrowserProcess {
                child,
                profile: Some(profile),
            };
            let run = (|| -> Result<PreviewReport, String> {
                let port_file = process
                    .profile
                    .as_ref()
                    .unwrap()
                    .path()
                    .join("DevToolsActivePort");
                let (port, endpoint) = loop {
                    check(cancellation, deadline)?;
                    if let Ok(text) = fs::read_to_string(&port_file) {
                        let mut lines = text.lines();
                        if let (Some(port), Some(endpoint)) = (lines.next(), lines.next()) {
                            break (port.to_string(), endpoint.to_string());
                        }
                    }
                    if let Some(status) = process.child.try_wait().map_err(|e| e.to_string())? {
                        use std::io::Read;
                        let mut diagnostic = String::new();
                        if let Ok(file) = fs::File::open(&log_path) {
                            let _ = file.take(4096).read_to_string(&mut diagnostic);
                        }
                        return Err(format!(
                            "preview browser exited before ready ({status}): {diagnostic}"
                        ));
                    }
                    thread::sleep(Duration::from_millis(25));
                };
                let address: SocketAddr = format!("127.0.0.1:{port}")
                    .parse()
                    .map_err(|e| format!("debugging address: {e}"))?;
                let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|e| e.to_string())?;
                let (socket, _) = tungstenite::client(format!("ws://{address}{endpoint}"), stream)
                    .map_err(|e| e.to_string())?;
                socket
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .map_err(|e| e.to_string())?;
                let mut cdp = Cdp {
                    socket,
                    next_id: 0,
                    session: None,
                    errors: Vec::new(),
                    cancellation,
                    deadline,
                };
                let version = cdp.call("Browser.getVersion", json!({}))?;
                let target = cdp.call("Target.createTarget", json!({"url":"about:blank"}))?;
                let session = cdp.call(
                    "Target.attachToTarget",
                    json!({"targetId":target["targetId"],"flatten":true}),
                )?;
                cdp.session = Some(
                    session["sessionId"]
                        .as_str()
                        .ok_or("missing browser session")?
                        .into(),
                );
                for method in ["Page.enable", "Runtime.enable", "Network.enable"] {
                    cdp.call(method, json!({}))?;
                }
                // Candidates are self-contained; do not let generated code reach Reader localhost or external services.
                cdp.call(
                    "Network.setBlockedURLs",
                    json!({"urls":["http://*","https://*","ws://*","wss://*","file://*"]}),
                )?;
                cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    json!({"width":environment.width,"height":environment.height,"deviceScaleFactor":1,"mobile":false}),
                )?;
                cdp.call(
                    "Emulation.setTouchEmulationEnabled",
                    json!({"enabled":matches!(environment.input, PreviewInput::Touch),"maxTouchPoints":if matches!(environment.input, PreviewInput::Touch) {5} else {1}}),
                )?;
                phase = "load".into();
                let frame = cdp.call("Page.getFrameTree", json!({}))?;
                cdp.call(
                    "Page.setDocumentContent",
                    json!({"frameId":frame["frameTree"]["frame"]["id"],"html":request.html}),
                )?;
                phase = "inspect:0".into();
                let mut observations = vec![cdp.observe(0, environment)?];
                for (index, action) in request.actions.iter().enumerate() {
                    phase = format!("interact:{}", index + 1);
                    cdp.interact(action, environment.input)?;
                    phase = format!("inspect:{}", index + 1);
                    observations.push(cdp.observe(index + 1, environment)?);
                }
                Ok(PreviewReport {
                    candidate_id: request.candidate_id.clone(),
                    browser: version["product"].as_str().unwrap_or("Chromium").into(),
                    environment,
                    environment_name: preview_environment_name(environment),
                    observations,
                    errors: cdp.errors,
                })
            })();
            let cleanup = process.stop();
            match (run, cleanup) {
                (Ok(report), Ok(())) => Ok(report),
                (Err(error), Ok(())) => Err(error),
                (result, Err(error)) => {
                    phase = "cleanup".into();
                    Err(format!("{error}; execution error: {:?}", result.err()))
                }
            }
        })();
        result.map_err(|message| PreviewError {
            candidate_id: request.candidate_id.clone(),
            phase,
            message,
        })
    }
}

/// Installation probe: one PreviewRequest on stdin, report/error JSON on stdout.
/// Uses exactly the production discovery and execution port, without opening a book.
pub fn run_probe() -> i32 {
    run_probe_with_cancellation(&CancellationToken::default())
}

pub fn run_probe_with_cancellation(cancellation: &CancellationToken) -> i32 {
    use std::io::Read;
    let mut input = String::new();
    let result = (|| -> Result<PreviewReport, PreviewError> {
        let invalid = |message: String| PreviewError {
            candidate_id: String::new(),
            phase: "input".into(),
            message,
        };
        io::stdin()
            .take(3 * 1024 * 1024)
            .read_to_string(&mut input)
            .map_err(|e| invalid(e.to_string()))?;
        let request: PreviewRequest =
            serde_json::from_str(&input).map_err(|e| invalid(e.to_string()))?;
        let host = BrowserPreview::discover().map_err(|message| PreviewError {
            candidate_id: request.candidate_id.clone(),
            phase: "discovery".into(),
            message,
        })?;
        host.preview(&request, cancellation)
    })();
    match result {
        Ok(report) => {
            println!("{}", serde_json::to_string(&report).unwrap());
            0
        }
        Err(error) => {
            println!("{}", serde_json::to_string(&error).unwrap());
            1
        }
    }
}
