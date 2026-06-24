//! runtime CLI(headless 驱动自建运行时,读 `.env` 的 OpenAI-兼容后端)`[ADR-0025/0026]`。
//!   runtime <book_dir> query <anchor_lid> <question...>   内层 book.query mini-loop(S5b)
//!   runtime <book_dir> chat  <question...>                外层 E 编排 loop(S6c)
//!   runtime <book_dir> goldset <file.json>                金标准集 + 验收闸(S8)`[ADR-0004]`
use memory::MemoryStore;
use read_tools::Book;
use reader::{Reader, DEFAULT_RADIUS};
use runtime::goldset::{run_goldset, GoldItem};
use runtime::orchestrator::{new_session, run, OuterConfig};
use runtime::{query, NativeAdapter};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "usage:\n  runtime <book_dir> query <anchor_lid> <question...>\n  runtime <book_dir> chat <question...>\n  runtime <book_dir> goldset <file.json>"
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
            let mut reader = Reader::new(&book, DEFAULT_RADIUS);
            let mut messages = new_session();
            match run(&book, &mut store, &mut reader, &adapter, &mut messages, &question, &now_ts(), OuterConfig::default()) {
                Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
                Err(e) => {
                    eprintln!("chat 失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            }
        }
        "goldset" => {
            if args.len() < 4 {
                usage();
            }
            let file = &args[3];
            let raw = match std::fs::read_to_string(file) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("读金标准集失败 {file}: {e}");
                    exit(1);
                }
            };
            let items: Vec<GoldItem> = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("金标准集 JSON 解析失败: {e}");
                    exit(1);
                }
            };
            match run_goldset(&book, &adapter, &items) {
                Ok(rep) => {
                    println!("{}", serde_json::to_string_pretty(&rep).unwrap());
                    // 一行汇总到 stderr(结构红线判据 = 100%)。
                    let evaluated = rep.total - rep.errored;
                    eprintln!(
                        "── goldset: 结构红线 {}/{} = {:.1}%(判据 100%,分母=成功应答)| mean_recall {:.2} | mean_precision {:.2} | incomplete {} | errored {}/{}",
                        rep.structural_pass, evaluated, rep.structural_redline_pct,
                        rep.mean_recall, rep.mean_precision, rep.incomplete_count, rep.errored, rep.total
                    );
                    if rep.errored > 0 {
                        eprintln!("!! {} 条 query 失败(provider 偶发,重试后仍失败)——见报告 items[].error", rep.errored);
                    }
                    if rep.structural_redline_pct < 100.0 {
                        eprintln!("!! 结构红线未达 100%:存在悬空 citation,违 [ADR-0004]");
                        exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("goldset 失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            }
        }
        _ => usage(),
    }
}
