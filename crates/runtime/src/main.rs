//! runtime CLI(headless 驱动自建运行时,读 `.env` 的 OpenAI-兼容后端)`[ADR-0025/0026]`。
//!   runtime <book_dir> query <request-json>                内层 book.query mini-loop
//!   runtime <book_dir> chat  <question...>                外层 E 编排 loop(S6c)
//!   runtime <book_dir> goldset <file.json>                typed 金标准集 + 验收闸
//!   runtime <book_dir> goldset-topk <file.json>           固定 K=5/8/12/20 回放
use memory::{MemoryStore, SnapshotContext, SnapshotRequest};
use read_tools::{Book, ContentProfileId};
use reader::{Reader, DEFAULT_RADIUS};
use runtime::goldset::{run_goldset, run_topk_replay, GoldItem};
use runtime::orchestrator::{new_session, run, OuterConfig};
use runtime::{parse_book_query_request, query, ProviderRegistry};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "usage:\n  runtime <book_dir> query <request-json>\n  runtime <book_dir> chat <question...>\n  runtime <book_dir> goldset <file.json>\n  runtime <book_dir> goldset-topk <file.json>"
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
    let adapter = match ProviderRegistry::adapter_from_env() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("adapter 初始化失败: {}", e.message);
            exit(1);
        }
    };

    match cmd.as_str() {
        "query" => {
            if args.len() != 4 {
                usage();
            }
            let value = match serde_json::from_str(&args[3]) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("query request JSON 非法: {error}");
                    exit(2);
                }
            };
            let request = match parse_book_query_request(value) {
                Ok(request) => request,
                Err(outcome) => {
                    println!("{}", serde_json::to_string_pretty(&outcome).unwrap());
                    exit(2);
                }
            };
            match query(&book, &request, adapter.as_ref()) {
                Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
                Err(e) => {
                    eprintln!(
                        "query 失败: [{}/{}] {}",
                        e.category, e.error_code, e.message
                    );
                    exit(1);
                }
            }
        }
        "chat" => {
            if args.len() < 4 {
                usage();
            }
            let question = args[3..].join(" ");
            let now = now_ts();
            let memory_path = MemoryStore::default_path();
            let mut store = match MemoryStore::open_private(&memory_path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "memory 不可用，本次 chat 使用空画像: [{}/{}] {}",
                        e.category, e.error_code, e.message
                    );
                    MemoryStore::unavailable(memory_path, e, &now)
                }
            };
            let mut reader = Reader::new(&book, DEFAULT_RADIUS);
            let mut messages = new_session();
            let content_profile = match book.content_profile_id() {
                ContentProfileId::TechnicalLearning => "technical_learning",
                ContentProfileId::Paper => "paper",
            };
            let snapshot =
                store.project_reader_profile_snapshot(&SnapshotRequest::current(SnapshotContext {
                    book_id: Some(book.base.book_id.clone()),
                    content_profile: Some(content_profile.into()),
                    now: Some(now.clone()),
                    ..Default::default()
                }));
            match run(
                &book,
                &mut store,
                &mut reader,
                adapter.as_ref(),
                &mut messages,
                &snapshot,
                &question,
                &now,
                OuterConfig::default(),
            ) {
                Ok(out) => println!("{}", serde_json::to_string_pretty(&out).unwrap()),
                Err(e) => {
                    eprintln!("chat 失败: [{}/{}] {}", e.category, e.error_code, e.message);
                    exit(1);
                }
            }
        }
        "goldset" | "goldset-topk" => {
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
            if cmd == "goldset-topk" {
                match run_topk_replay(&book, adapter.as_ref(), &items, &[5, 8, 12, 20]) {
                    Ok(report) => {
                        println!("{}", serde_json::to_string_pretty(&report).unwrap());
                    }
                    Err(error) => {
                        eprintln!(
                            "goldset Top-K replay failed: [{}/{}] {}",
                            error.category, error.error_code, error.message
                        );
                        exit(1);
                    }
                }
                return;
            }
            match run_goldset(&book, adapter.as_ref(), &items) {
                Ok(rep) => {
                    println!("{}", serde_json::to_string_pretty(&rep).unwrap());
                    eprintln!(
                        "goldset: structural {}/{} = {:.1}% | status {}/{} = {:.1}% | binding recall {:.2} | citation recall {:.2} | calls {:.2} | errored {}/{}",
                        rep.structural_pass, rep.evaluated, rep.structural_redline_pct,
                        rep.status_pass, rep.evaluated, rep.status_match_pct,
                        rep.mean_binding_recall, rep.mean_citation_recall,
                        rep.mean_model_calls, rep.errored, rep.total
                    );
                    if rep.errored > 0 {
                        eprintln!(
                            "!! {} query items failed after one retry; inspect items[].error",
                            rep.errored
                        );
                    }
                    if rep.structural_redline_pct < 100.0 {
                        eprintln!("!! structural citation redline is below 100%");
                        exit(1);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "goldset 失败: [{}/{}] {}",
                        e.category, e.error_code, e.message
                    );
                    exit(1);
                }
            }
        }
        _ => usage(),
    }
}
