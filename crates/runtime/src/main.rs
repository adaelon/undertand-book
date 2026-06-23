//! runtime CLI:headless 驱动 book.query 内层 mini-loop(S5b)`[ADR-0025]`。
//!   runtime <book_dir> query <anchor_lid> <question...>
//! 从 .env 读 OpenAI-兼容后端配置(NativeAdapter),裸调 query 输出 JSON 响应。
use read_tools::Book;
use runtime::{query, NativeAdapter};
use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 || args[2] != "query" {
        eprintln!("usage: runtime <book_dir> query <anchor_lid> <question...>");
        exit(2);
    }
    let dir = &args[1];
    let anchor = &args[3];
    let question = args[4..].join(" ");

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
    match query(&book, &question, anchor, &adapter) {
        Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
        Err(e) => {
            eprintln!("query 失败: [{}/{}] {}", e.category, e.error_code, e.message);
            exit(1);
        }
    }
}
