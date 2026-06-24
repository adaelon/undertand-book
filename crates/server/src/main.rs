//! understand-book localhost 服务入口 `[ADR-0028]`:tiny_http 同步、worker 线程每连接,
//! 共享 `Arc<Mutex<AppState>>`(单会话单书)。单用户 localhost 并发近零,不上 tokio `[ADR-0024]`。
//! 用法:`server <book_dir>`(或设 `UNDERSTAND_BOOK_DIR`);可选 `UNDERSTAND_BOOK_ADDR`(默认 127.0.0.1:8787)。
use read_tools::Book;
use server::{route, AppState};
use std::sync::{Arc, Mutex};
use std::thread;
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
    let addr = std::env::var("UNDERSTAND_BOOK_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state = Arc::new(Mutex::new(AppState { book }));
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
            let rq = match s.recv() {
                Ok(r) => r,
                Err(_) => break,
            };
            let method = rq.method().to_string();
            // 锁只在路由这一刻持有(纯函数,无阻塞 I/O)。
            let reply = {
                let guard = st.lock().unwrap_or_else(|p| p.into_inner());
                route(&guard, &method, rq.url())
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
