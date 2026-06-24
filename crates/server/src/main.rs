//! understand-book localhost 服务入口 `[ADR-0028]`:tiny_http 同步、worker 线程每连接,
//! 共享 `Arc<Mutex<AppState>>`(单会话单书)。单用户 localhost 并发近零,不上 tokio `[ADR-0024]`。
//! 用法:`server <book_dir>`(或设 `UNDERSTAND_BOOK_DIR`);可选 `UNDERSTAND_BOOK_ADDR`(默认 127.0.0.1:8787)。
//! S10e:同端口同时服务打包后的 SPA 静态文件(`UNDERSTAND_BOOK_WEB_DIST`,默认 `packages/web/dist`)
//! 与 API(`/api/*` 会剥前缀后投影到冻结命令面)。
//! memory 库走 `MemoryStore::default_path()`(用户私有、与只读基座物理隔离 `[ADR-0006]`)。
use memory::MemoryStore;
use read_tools::Book;
use reader::{Reader, DEFAULT_RADIUS};
use runtime::orchestrator::new_session;
use runtime::{ModelAdapter, NativeAdapter};
use server::{route, AppState, Req, UnconfiguredAdapter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Response, Server};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("UNDERSTAND_BOOK_DIR").ok())
        .unwrap_or_else(|| {
            eprintln!("用法: server <book_dir>  (或设 UNDERSTAND_BOOK_DIR 环境变量)");
            std::process::exit(2);
        });
    let book = match Book::load(&dir) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("加载书失败({dir}): {e}");
            std::process::exit(1);
        }
    };
    let store = match MemoryStore::open(MemoryStore::default_path()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("打开记忆库失败: {}", e.message);
            std::process::exit(1);
        }
    };
    let reader = Reader::new(&book, DEFAULT_RADIUS);
    // book.query 的 LLM 后端:读 .env;缺配置则兜底 UnconfiguredAdapter
    // (book/reader/memory 浏览照常,仅 query 触模型时报 PROVIDER_ERROR)`[ADR-0028]`。
    let adapter: Box<dyn ModelAdapter + Send> = match NativeAdapter::from_env() {
        Ok(a) => Box::new(a),
        Err(e) => {
            eprintln!(
                "⚠ 未配置 LLM 后端({});book.query 将返 PROVIDER_ERROR,其余命令正常",
                e.message
            );
            Box::new(UnconfiguredAdapter)
        }
    };
    let addr = std::env::var("UNDERSTAND_BOOK_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let messages = new_session(); // 外层 E agent 会话 messages(/agent/new 重置)`[ADR-0030]`
    let state = Arc::new(Mutex::new(AppState {
        book,
        reader,
        store,
        adapter,
        messages,
    }));
    let web_dist = web_dist_dir();
    let server = match Server::http(&addr) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("绑定 {addr} 失败: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "understand-book server 监听 http://{addr}  (book={dir}, web={})",
        web_dist.display()
    );

    let mut handles = Vec::new();
    for _ in 0..4 {
        let s = server.clone();
        let st = state.clone();
        let dist = web_dist.clone();
        handles.push(thread::spawn(move || loop {
            let mut rq = match s.recv() {
                Ok(r) => r,
                Err(_) => break,
            };
            let method = rq.method().to_string();
            let url = rq.url().to_string();
            let mut body = String::new();
            let _ = rq.as_reader().read_to_string(&mut body); // GET 无 body,读空即可
            let now = now_ts();
            let resp = match static_response(&dist, &method, &url) {
                Some(reply) => response_from_static(reply),
                None => {
                    // 锁只在 API 路由这一刻持有;静态文件 I/O 不占 AppState 锁。
                    let api_url = normalize_api_url(&url);
                    let reply = {
                        let mut guard = st.lock().unwrap_or_else(|p| p.into_inner());
                        route(
                            &mut guard,
                            Req {
                                method: &method,
                                url: &api_url,
                                body: &body,
                                now: &now,
                            },
                        )
                    };
                    response_from_json(reply.status, reply.body)
                }
            };
            let _ = rq.respond(resp);
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

/// memory.save 的 generated_at/last_used 时间戳(epoch 毫秒串;ISO 格式化留后)。
fn now_ts() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    ms.to_string()
}

struct StaticReply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

/// `/api/*` 是打包 SPA 的同源 API 前缀;传给纯路由前剥掉,保持 `lib.rs` 的冻结命令面不变。
fn normalize_api_url(url: &str) -> String {
    let (path, query) = split_url(url);
    if let Some(rest) = path.strip_prefix("/api/") {
        format!("/{}{}", rest, query)
    } else {
        url.to_string()
    }
}

/// API 前缀必须走 JSON 路由,不能被 SPA `index.html` fallback 吃掉。
fn is_api_url(url: &str) -> bool {
    let (path, _) = split_url(url);
    let p = path.strip_prefix("/api").unwrap_or(path);
    p.starts_with("/book/")
        || p.starts_with("/reader/")
        || p.starts_with("/memory/")
        || p.starts_with("/agent/")
}

/// 非 API 的 GET 请求服务 SPA 静态文件;找不到具体文件时 fallback 到 `index.html`。
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
    match std::fs::read(&file) {
        Ok(body) => Some(StaticReply {
            status: 200,
            content_type: mime_for(&file),
            body,
        }),
        Err(_) => Some(StaticReply {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            body: format!("web dist not found: {}", dist.display()).into_bytes(),
        }),
    }
}

fn static_path(dist: &Path, path: &str) -> Option<PathBuf> {
    if path.contains('\\') {
        return None;
    }
    let mut out = dist.to_path_buf();
    for seg in path.trim_start_matches('/').split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg == "." || seg == ".." || seg.contains(':') {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

fn split_url(url: &str) -> (&str, &str) {
    match url.find('?') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
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

fn web_dist_dir() -> PathBuf {
    if let Ok(p) = std::env::var("UNDERSTAND_BOOK_WEB_DIST") {
        return PathBuf::from(p);
    }
    PathBuf::from("packages").join("web").join("dist")
}

fn response_from_json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .expect("静态 header 合法");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn response_from_static(reply: StaticReply) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes())
        .expect("静态 header 合法");
    Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(header)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(is_api_url("/reader/state"));
        assert!(!is_api_url("/assets/index.js"));
        assert!(!is_api_url("/chapter/one"));
    }

    #[test]
    fn static_path_rejects_traversal() {
        let root = Path::new("dist");
        assert!(static_path(root, "/assets/app.js")
            .unwrap()
            .ends_with("assets/app.js"));
        assert!(static_path(root, "/../Cargo.toml").is_none());
        assert!(static_path(root, "/a\\b").is_none());
    }

    #[test]
    fn mime_types_cover_vite_outputs() {
        assert_eq!(
            mime_for(Path::new("index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_for(Path::new("app.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("style.css")), "text/css; charset=utf-8");
    }
}
