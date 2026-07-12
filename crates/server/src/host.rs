use crate::{
    ensure_agent_history_for_book, load_agent_history, load_session, mcp::VisitorSessions, route,
    route_book_asset_file, save_session, select_start_book, AppState, Req, UnconfiguredAdapter,
};
use base_schema::{LidNode, NodeKind, ReadOnlyBase, Span};
use memory::MemoryStore;
use read_tools::Book;
use reader::{Reader, DEFAULT_RADIUS};
use runtime::{ModelAdapter, ProviderConfig, ProviderRegistry};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Response, Server};

pub struct ServerHostConfig {
    pub book_dir: Option<PathBuf>,
    pub library_root: Option<PathBuf>,
    pub addr: String,
    pub web_dist: PathBuf,
}

impl ServerHostConfig {
    pub fn from_env(book_dir: impl Into<PathBuf>) -> Self {
        Self {
            book_dir: Some(book_dir.into()),
            library_root: None,
            addr: std::env::var("UNDERSTAND_BOOK_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into()),
            web_dist: std::env::var("UNDERSTAND_BOOK_WEB_DIST")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("packages").join("web").join("dist")),
        }
    }

    pub fn desktop(library_root: PathBuf, web_dist: PathBuf) -> Self {
        Self {
            book_dir: None,
            library_root: Some(library_root),
            addr: "127.0.0.1:0".into(),
            web_dist,
        }
    }
}

pub struct RunningServer {
    pub url: String,
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    state: Arc<Mutex<AppState>>,
}

impl RunningServer {
    pub fn set_library_root(&self, library_root: PathBuf) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.library_root = Some(library_root);
    }

    pub fn library_root(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .library_root
            .clone()
    }

    pub fn set_provider_config(&self, config: ProviderConfig) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.adapter = ProviderRegistry::adapter_from_config(config);
    }

    pub fn wait(mut self) {
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

pub fn start_server(config: ServerHostConfig) -> Result<RunningServer, String> {
    let session_path = MemoryStore::default_path()
        .parent()
        .map(|p| p.join("session.json"));
    let history_path = MemoryStore::default_path()
        .parent()
        .map(|p| p.join("agent-history.json"));
    let session = load_session(&session_path);
    let (dir, book, saved_top) = match config.book_dir {
        Some(book_dir) => {
            let requested = book_dir.to_string_lossy().into_owned();
            let (dir, saved_top) = select_start_book(requested, session.as_ref());
            let book =
                Book::load(&dir).map_err(|error| format!("failed to load book {dir}: {error}"))?;
            (dir, book, saved_top)
        }
        None => {
            if let Some(saved) = session
                .as_ref()
                .filter(|saved| Path::new(&saved.current_book_dir).is_dir())
            {
                if let Ok(book) = Book::load(&saved.current_book_dir) {
                    let dir = saved.current_book_dir.clone();
                    let top = saved.top_lid_for_dir(&dir).map(str::to_string);
                    (dir, book, top)
                } else {
                    bootstrap_book(config.library_root.as_deref())?
                }
            } else {
                bootstrap_book(config.library_root.as_deref())?
            }
        }
    };
    let store = MemoryStore::open(MemoryStore::default_path())
        .map_err(|error| format!("failed to open memory store: {}", error.message))?;
    let mut reader = Reader::new(&book, DEFAULT_RADIUS);
    if let Some(top) = saved_top {
        reader.restore_top_lid(&book, &top);
    }
    crate::restore_saved_paper_minimap_overlay(&mut reader, &book, &session_path)
        .map_err(|error| format!("failed to restore paper minimap overlay: {}", error.message))?;
    let adapter: Box<dyn ModelAdapter + Send> = match ProviderRegistry::adapter_from_env() {
        Ok(adapter) => adapter,
        Err(_) => Box::new(UnconfiguredAdapter),
    };
    let mut agent_history = load_agent_history(&history_path);
    let messages =
        ensure_agent_history_for_book(&mut agent_history, &book.base.book_id, "server-start");
    let state = Arc::new(Mutex::new(AppState {
        book_dir: PathBuf::from(&dir),
        library_root: config.library_root.clone(),
        book,
        reader,
        store,
        adapter,
        messages,
        session_path,
        history_path,
        agent_history,
        visitor_sessions: VisitorSessions::default(),
        workbench_loaded_revision: None,
    }));
    {
        let guard = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !is_bootstrap_dir(&guard.book_dir) {
            let _ = save_session(&guard, Some(dir.as_str()));
        }
    }

    let server = Arc::new(
        Server::http(&config.addr)
            .map_err(|error| format!("failed to bind {}: {error}", config.addr))?,
    );
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "server did not bind an IP address".to_string())?;
    let url = format!("http://{address}");
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    for _ in 0..4 {
        let server = server.clone();
        let state = state.clone();
        let dist = config.web_dist.clone();
        let stop_signal = stop.clone();
        handles.push(thread::spawn(move || {
            while !stop_signal.load(Ordering::Acquire) {
                let Ok(request) = server.recv_timeout(Duration::from_millis(100)) else {
                    break;
                };
                let Some(mut request) = request else { continue };
                let method = request.method().to_string();
                let url = request.url().to_string();
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let response = match static_response(&dist, &method, &url) {
                    Some(reply) => response_from_static(reply),
                    None => {
                        let api_url = normalize_api_url(&url);
                        if method == "GET" {
                            let asset = {
                                let guard = state
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                route_book_asset_file(&guard.book_dir, &api_url)
                            };
                            if let Some(reply) = asset {
                                let _ = request.respond(response_from_binary(reply));
                                continue;
                            }
                        }
                        let reply = {
                            let mut guard = state
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            route(
                                &mut guard,
                                Req {
                                    method: &method,
                                    url: &api_url,
                                    body: &body,
                                    now: &now_ts(),
                                },
                            )
                        };
                        response_from_json(reply.status, reply.body)
                    }
                };
                let _ = request.respond(response);
            }
        }));
    }
    Ok(RunningServer {
        url,
        stop,
        handles,
        state,
    })
}

fn bootstrap_book(library_root: Option<&Path>) -> Result<(String, Book, Option<String>), String> {
    let root = library_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".understand-book"));
    let source = "Select or create a book.";
    let base = ReadOnlyBase {
        book_id: "__desktop_bootstrap__".into(),
        lid_nodes: vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Paragraph,
            span: Span {
                start: 0,
                end: source.encode_utf16().count(),
            },
            children: Vec::new(),
        }],
        graph_nodes: Vec::new(),
        graph_edges: Vec::new(),
    };
    Ok((
        root.join("__desktop_bootstrap__")
            .to_string_lossy()
            .into_owned(),
        Book::new(base, source),
        None,
    ))
}

fn is_bootstrap_dir(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("__desktop_bootstrap__")
}

fn now_ts() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .to_string()
}

struct StaticReply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

fn normalize_api_url(url: &str) -> String {
    let (path, query) = split_url(url);
    path.strip_prefix("/api/")
        .map(|rest| format!("/{rest}{query}"))
        .unwrap_or_else(|| url.to_string())
}

fn is_api_url(url: &str) -> bool {
    let (path, _) = split_url(url);
    let path = path.strip_prefix("/api").unwrap_or(path);
    path.starts_with("/book/")
        || path.starts_with("/reader/")
        || path.starts_with("/memory/")
        || path.starts_with("/agent/")
        || path.starts_with("/profile/")
        || path.starts_with("/desktop/")
}

fn static_response(dist: &Path, method: &str, url: &str) -> Option<StaticReply> {
    if method != "GET" || is_api_url(url) {
        return None;
    }
    let (path, _) = split_url(url);
    let requested = static_path(dist, path)?;
    let file = if requested.is_file() {
        requested
    } else {
        dist.join("index.html")
    };
    Some(match std::fs::read(&file) {
        Ok(body) => StaticReply {
            status: 200,
            content_type: mime_for(&file),
            body,
        },
        Err(_) => StaticReply {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            body: format!("web dist not found: {}", dist.display()).into_bytes(),
        },
    })
}

fn static_path(dist: &Path, path: &str) -> Option<PathBuf> {
    if path.contains('\\') {
        return None;
    }
    let mut out = dist.to_path_buf();
    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." || segment.contains(':') {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

fn split_url(url: &str) -> (&str, &str) {
    url.find('?')
        .map(|index| (&url[..index], &url[index..]))
        .unwrap_or((url, ""))
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn response_from_json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .expect("valid content-type header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn response_from_static(reply: StaticReply) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes())
        .expect("valid content-type header");
    Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(header)
}

fn response_from_binary(reply: crate::BinaryReply) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes())
        .expect("valid content-type header");
    Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_host_uses_random_loopback_address() {
        let config = ServerHostConfig {
            book_dir: Some(PathBuf::from("book")),
            library_root: None,
            addr: "127.0.0.1:0".into(),
            web_dist: PathBuf::from("dist"),
        };
        assert_eq!(config.addr, "127.0.0.1:0");
    }

    #[test]
    fn api_prefix_is_stripped_before_routing() {
        assert_eq!(
            normalize_api_url("/api/book/text?lid=1.1"),
            "/book/text?lid=1.1"
        );
        assert_eq!(
            normalize_api_url("/book/text?lid=1.1"),
            "/book/text?lid=1.1"
        );
    }

    #[test]
    fn api_paths_are_not_static_fallback_candidates() {
        assert!(is_api_url("/api/book/manifest"));
        assert!(is_api_url("/api/profile/manifest"));
        assert!(!is_api_url("/assets/index.js"));
    }

    #[test]
    fn static_path_rejects_traversal() {
        assert!(static_path(Path::new("dist"), "/assets/app.js").is_some());
        assert!(static_path(Path::new("dist"), "/../Cargo.toml").is_none());
        assert!(static_path(Path::new("dist"), "/a\\b").is_none());
    }
}
