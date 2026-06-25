//! read-tools CLI:headless 驱动 4 个确定性叶子工具(切片0:manifest/text)`[ADR-0024]`。
//!   read-tools <book_dir> manifest [lid]       # 无 lid=总览;有 lid=该 LID node+stats
//!   read-tools <book_dir> text <lid> [end_lid] # 取真原文(单 LID 或 LID 区间)
//!   read-tools <book_dir> context <lid> [near|mid|far] [k] # context 纯指针(k=数字|all,默认 DEFAULT_NEAR_K)
//!   read-tools <book_dir> concept <name>       # 概念/实体全量 occurrences + 关联实体
use read_tools::Book;
use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: read-tools <book_dir> manifest [lid] | text <lid> [end_lid] | context <lid> [near|mid|far] [k] | concept <name>");
        exit(2);
    }
    let (dir, cmd) = (&args[1], args[2].as_str());
    let book = match Book::load(dir) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("加载失败: {e}");
            exit(1);
        }
    };
    match cmd {
        "manifest" => {
            let m = book.manifest();
            match args.get(3) {
                Some(lid) => {
                    let node = m.tree.iter().find(|n| &n.lid == lid);
                    let stats = m.stats_by_lid.get(lid);
                    println!(
                        "{}",
                        serde_json::to_string_pretty(
                            &serde_json::json!({ "node": node, "stats": stats })
                        )
                        .unwrap()
                    );
                }
                None => {
                    let tops: Vec<_> = m.tree.iter().filter(|n| !n.lid.contains('.')).collect();
                    println!("tree 节点数={}  顶层={}", m.tree.len(), tops.len());
                    for n in tops.iter().take(5) {
                        let s = &m.stats_by_lid[&n.lid];
                        println!(
                            "  {}  child={} leaf={} anchored={} span=[{},{})",
                            n.lid,
                            s.child_count,
                            s.leaf_count,
                            s.anchored_nodes,
                            n.span.start,
                            n.span.end
                        );
                    }
                }
            }
        }
        "text" => {
            let lid = args.get(3).map(String::as_str).unwrap_or("");
            let end = args.get(4).map(String::as_str);
            match book.text(lid, end) {
                Ok(t) => println!("{t}"),
                Err(e) => {
                    println!("{}", serde_json::to_string_pretty(&e).unwrap());
                    exit(1);
                }
            }
        }
        "context" => {
            let lid = args.get(3).map(String::as_str).unwrap_or("");
            let k = args.get(4).map(|s| {
                if s == "all" {
                    usize::MAX
                } else {
                    s.parse().unwrap_or(read_tools::DEFAULT_NEAR_K)
                }
            });
            match book.context_near(lid, k) {
                Ok(c) => println!("{}", serde_json::to_string_pretty(&c).unwrap()),
                Err(e) => {
                    println!("{}", serde_json::to_string_pretty(&e).unwrap());
                    exit(1);
                }
            }
        }
        "concept" => {
            let name = args.get(3).map(String::as_str).unwrap_or("");
            match book.concept(name) {
                Ok(c) => println!("{}", serde_json::to_string_pretty(&c).unwrap()),
                Err(e) => {
                    println!("{}", serde_json::to_string_pretty(&e).unwrap());
                    exit(1);
                }
            }
        }
        other => {
            eprintln!("未知命令: {other}(切片0 支持 manifest/text/context/concept)");
            exit(2);
        }
    }
}
