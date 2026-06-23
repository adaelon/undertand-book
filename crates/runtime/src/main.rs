//! runtime CLI(headless 驱动自建运行时,读 `.env` 的 OpenAI-兼容后端)`[ADR-0025/0026]`。
//!   runtime <book_dir> query <anchor_lid> <question...>   内层 book.query mini-loop(S5b)
//!   runtime <book_dir> chat  <question...>                外层 E 编排 loop(S6c)
use memory::MemoryStore;
use read_tools::Book;
use runtime::orchestrator::{run, OuterConfig};
use runtime::{query, NativeAdapter};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "usage:\n  runtime <book_dir> query <anchor_lid> <question...>\n  runtime <book_dir> chat <question...>"
    );
    exit(2);
}

/// 时间戳(epoch 秒;memory generated_at/last_used 用,不进 mem_id)。
fn now_ts() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        usage();
    }
    let dir = &args[1];
    let cmd = &args[2];

    let book = match Book::load(dir) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("加载失败: {e}");
            exit(1);
        }
    };
    let adapter = match NativeAdapter::from_env() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("adapter 初始化失败: {}", e.message);
            exit(1);
        }
    };

    match cmd.as_str() {
        "query" => {
            if args.len() < 5 {
                usage();
            }
            let anchor = &args[3];
            let question = args[4..].join(" ");
            match query(&book, &question, anchor, &adapter) {
                Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
                Err(e) => {
                    eprintln!("query 失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            }
        }
        "chat" => {
            if args.len() < 4 {
                usage();
            }
            let question = args[3..].join(" ");
            let mut store = match MemoryStore::open(MemoryStore::default_path()) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("memory 打开失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            };
            match run(&book, &mut store, &adapter, &question, &now_ts(), OuterConfig::default()) {
                Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
                Err(e) => {
                    eprintln!("chat 失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            }
        }
        _ => usage(),
    }
}
