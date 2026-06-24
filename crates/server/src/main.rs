//! understand-book localhost 服务入口 `[ADR-0028]`:tiny_http 同步、worker 线程每连接,
//! 共享 `Arc<Mutex<AppState>>`(单会话单书)。单用户 localhost 并发近零,不上 tokio `[ADR-0024]`。
//! 用法:`server <book_dir>`(或设 `UNDERSTAND_BOOK_DIR`);可选 `UNDERSTAND_BOOK_ADDR`(默认 127.0.0.1:8787)。
//! memory 库走 `MemoryStore::default_path()`(用户私有、与只读基座物理隔离 `[ADR-0006]`)。
use memory::MemoryStore;
use read_tools::Book;
use reader::{Reader, DEFAULT_RADIUS};
use runtime::{ModelAdapter, NativeAdapter};
use server::{route, AppState, Req, UnconfiguredAdapter};
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
            eprintln!("⚠ 未配置 LLM 后端({});book.query 将返 PROVIDER_ERROR,其余命令正常", e.message);
            Box::new(UnconfiguredAdapter)
        }
    };
    let addr = std::env::var("UNDERSTAND_BOOK_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state = Arc::new(Mutex::new(AppState { book, reader, store, adapter }));
    let server = match Server::http(&addr) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("绑定 {addr} 失败: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("understand-book server 监听 http://{addr}  (book={dir})");

    let mut handles = Vec::new();
    for _ in 0..4 {
        let s = server.clone();
        let st = state.clone();
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
            // 锁只在路由这一刻持有(纯函数,无阻塞 I/O)。
            let reply = {
                let mut guard = st.lock().unwrap_or_else(|p| p.into_inner());
                route(
                    &mut guard,
                    Req { method: &method, url: &url, body: &body, now: &now },
                )
            };
            let header = Header::from_bytes(
                &b"Content-Type"[..],
                &b"application/json; charset=utf-8"[..],
            )
            .expect("静态 header 合法");
            let resp = Response::from_string(reply.body)
                .with_status_code(reply.status)
                .with_header(header);
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
