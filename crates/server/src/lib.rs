//! 读时 localhost 服务:把冻结命令面投影成 REST `[ADR-0028]`。
//! S10a 只投影 `book.*` 四只读叶子工具 → GET,端点名 = 命令名,错误原样透传 §4.4 信封。
//! 路由是**纯函数 `route(&AppState, method, url) -> Reply`**,脱离 socket 可单测(守 A2);
//! socket 绑定 / worker 线程 / Mutex 锁在 `main.rs`(bin)。
//! reader/memory(S10b)、query(S10c)、静态资源(S10e)、agent(S10f)留后续子切片。
use read_tools::{Book, ToolError};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;

/// 服务的单会话共享状态(切片0 单用户单书)`[ADR-0028 决策2]`。
/// S10a 只持只读 `Book`;S10b 起扩 `Reader` + `MemoryStore`(届时 main 的 Mutex 兑现可变性)。
pub struct AppState {
    pub book: Book,
}

/// 路由产物:HTTP 状态码 + JSON body(传输无关,main 负责写回 socket)。
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// 纯函数路由:给定状态 + 方法 + 原始 url(含 query)→ Reply,无任何 I/O `[ADR-0028 决策3]`。
/// `book.*` 只读 → 仅接受 GET;非 GET 返 405。
pub fn route(state: &AppState, method: &str, url: &str) -> Reply {
    let (path, q) = parse_query(url);
    if method != "GET" {
        return method_not_allowed();
    }
    let book = &state.book;
    match path.as_str() {
        "/book/manifest" => ok_json(&book.manifest()),
        "/book/text" => {
            let Some(lid) = q.get("lid") else {
                return validation("INVALID_RANGE", "book.text 需 lid 查询参数");
            };
            match book.text(lid, q.get("end").map(|s| s.as_str())) {
                Ok(t) => ok_json(&json!({ "lid": lid, "text": t })),
                Err(e) => err_reply(&e),
            }
        }
        "/book/context" => {
            let Some(lid) = q.get("lid") else {
                return validation("INVALID_RANGE", "book.context 需 lid 查询参数");
            };
            let k = match q.get("k") {
                None => None,
                Some(s) => match s.parse::<usize>() {
                    Ok(n) => Some(n),
                    Err(_) => return validation("INVALID_K", "k 须为非负整数"),
                },
            };
            match book.context_near(lid, k) {
                Ok(c) => ok_json(&c),
                Err(e) => err_reply(&e),
            }
        }
        "/book/concept" => {
            let Some(name) = q.get("name") else {
                return validation("INVALID_RANGE", "book.concept 需 name 查询参数");
            };
            match book.concept(name) {
                Ok(c) => ok_json(&c),
                Err(e) => err_reply(&e),
            }
        }
        // 传输层未知路由(非冻结 command 错误枚举,HTTP 层信封形透传)。
        _ => route_not_found(&path),
    }
}

/// url → (path, query map);query 值经 percent 解码(支持 CJK 概念名 / 空格)。
fn parse_query(url: &str) -> (String, HashMap<String, String>) {
    let (path, qs) = match url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (url, ""),
    };
    let mut map = HashMap::new();
    for pair in qs.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        map.insert(percent_decode(k), percent_decode(v));
    }
    (path.to_string(), map)
}

/// 最小 percent 解码:`%XX` 十六进制字节 + `+`→空格;非法 `%` 序列原样保留。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn ok_json<T: Serialize>(v: &T) -> Reply {
    Reply {
        status: 200,
        body: to_body(v),
    }
}

/// 错误信封透传 §4.4 + category→HTTP status 映射 `[ADR-0028 决策3]`。
fn err_reply(e: &ToolError) -> Reply {
    Reply {
        status: status_for(&e.category),
        body: to_body(e),
    }
}

fn validation(code: &str, msg: &str) -> Reply {
    err_reply(&ToolError {
        error_code: code.into(),
        category: "validation".into(),
        message: msg.into(),
    })
}

fn route_not_found(path: &str) -> Reply {
    err_reply(&ToolError {
        error_code: "ROUTE_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("未知路由: {path}"),
    })
}

fn method_not_allowed() -> Reply {
    Reply {
        status: 405,
        body: to_body(&ToolError {
            error_code: "METHOD_NOT_ALLOWED".into(),
            category: "validation".into(),
            message: "book.* 只支持 GET".into(),
        }),
    }
}

fn to_body<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        format!("{{\"error_code\":\"INTERNAL_ERROR\",\"category\":\"internal\",\"message\":\"序列化失败: {e}\"}}")
    })
}

/// §4.4 category → HTTP status(瞬时 5xx / 永久 4xx)。
fn status_for(category: &str) -> u16 {
    match category {
        "validation" => 400,
        "not_found" => 404,
        "provider" => 502,
        "budget" => 429,
        "internal" => 500,
        _ => 500,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::sample_base;

    fn state() -> AppState {
        // sample_base:容器 "1" + 叶 "1.1";entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        AppState {
            book: Book::new(sample_base(), &src),
        }
    }

    fn get(s: &AppState, url: &str) -> Reply {
        route(s, "GET", url)
    }

    #[test]
    fn manifest_ok() {
        let r = get(&state(), "/book/manifest");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"tree\""));
        assert!(r.body.contains("\"stats_by_lid\""));
    }

    #[test]
    fn text_valid_lid_returns_original() {
        let r = get(&state(), "/book/text?lid=1.1");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"lid\":\"1.1\""));
        assert!(r.body.contains(&"X".repeat(100)));
    }

    #[test]
    fn text_missing_lid_is_validation_400() {
        let r = get(&state(), "/book/text");
        assert_eq!(r.status, 400);
        assert!(r.body.contains("INVALID_RANGE"));
        assert!(r.body.contains("validation"));
    }

    #[test]
    fn text_unknown_lid_passes_through_not_found_404() {
        let r = get(&state(), "/book/text?lid=9.9");
        assert_eq!(r.status, 404);
        assert!(r.body.contains("LID_NOT_FOUND"));
        assert!(r.body.contains("not_found"));
    }

    #[test]
    fn context_ok_and_bad_k_is_400() {
        let ok = get(&state(), "/book/context?lid=1.1");
        assert_eq!(ok.status, 200);
        assert!(ok.body.contains("\"anchor\":\"1.1\""));
        let bad = get(&state(), "/book/context?lid=1.1&k=abc");
        assert_eq!(bad.status, 400);
        assert!(bad.body.contains("INVALID_K"));
    }

    #[test]
    fn concept_found_missing_param_and_unknown() {
        let found = get(&state(), "/book/concept?name=command");
        assert_eq!(found.status, 200);
        assert!(found.body.contains("\"occurrences\""));
        assert!(found.body.contains("1.1"));

        let missing = get(&state(), "/book/concept");
        assert_eq!(missing.status, 400);
        assert!(missing.body.contains("INVALID_RANGE"));

        let unknown = get(&state(), "/book/concept?name=nope");
        assert_eq!(unknown.status, 404);
        assert!(unknown.body.contains("CONCEPT_NOT_FOUND"));
    }

    #[test]
    fn unknown_route_is_404_envelope() {
        let r = get(&state(), "/book/nope");
        assert_eq!(r.status, 404);
        assert!(r.body.contains("ROUTE_NOT_FOUND"));
    }

    #[test]
    fn non_get_is_405() {
        let r = route(&state(), "POST", "/book/manifest");
        assert_eq!(r.status, 405);
        assert!(r.body.contains("METHOD_NOT_ALLOWED"));
    }

    #[test]
    fn percent_decode_cjk_and_space() {
        assert_eq!(percent_decode("%E5%91%BD%E4%BB%A4"), "命令");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%2F"), "/");
        // 非法 % 序列原样保留
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn parse_query_splits_path_and_decodes() {
        let (p, q) = parse_query("/book/concept?name=%E5%91%BD%E4%BB%A4");
        assert_eq!(p, "/book/concept");
        assert_eq!(q.get("name").map(|s| s.as_str()), Some("命令"));
    }
}
