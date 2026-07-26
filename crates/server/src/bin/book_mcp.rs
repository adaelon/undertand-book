use memory::{MemoryStore, READER_PRIVATE_STORAGE_UNAVAILABLE};
use read_tools::{Book, ToolError};
use reader::{Reader, DEFAULT_RADIUS};
use runtime::orchestrator::new_session;
use runtime::{ModelAdapter, ProviderRegistry};
use server::mcp::{handle_jsonrpc_message, VisitorSessions};
use server::{load_session, AppState, UnconfiguredAdapter};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let session_path = MemoryStore::default_path()
        .parent()
        .map(|parent| parent.join("session.json"));
    let (dir, book) = match resolve_book(
        std::env::args_os().nth(1).map(PathBuf::from),
        std::env::var_os("UNDERSTAND_BOOK_DIR").map(PathBuf::from),
        session_path,
    ) {
        Ok(resolved) => resolved,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let reader = Reader::new(&book, DEFAULT_RADIUS);
    let store = MemoryStore::unavailable(
        MemoryStore::default_path(),
        ToolError {
            error_code: READER_PRIVATE_STORAGE_UNAVAILABLE.into(),
            category: "permission".into(),
            message: "visitor MCP cannot access resident private memory".into(),
        },
        now_ms(),
    );
    let adapter: Box<dyn ModelAdapter + Send> = match ProviderRegistry::adapter_from_env() {
        Ok(adapter) => adapter,
        Err(_) => Box::new(UnconfiguredAdapter),
    };
    let mut state = AppState {
        book_dir: dir,
        library_root: None,
        book,
        reader,
        store,
        intent_store_root: None,
        adapter,
        messages: new_session(),
        session_path: None,
        history_path: None,
        agent_history: server::AgentHistory::default(),
        profile_context_cache: runtime::profile_context::ProfileContextCache::default(),
        visitor_sessions: VisitorSessions::default(),
        workbench_loaded_revision: None,
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(resp) = handle_jsonrpc_message(&mut state, &line, &now_ms()) {
            let out = serde_json::to_string(&resp).unwrap_or_else(|e| {
                format!(
                    r#"{{"jsonrpc":"2.0","id":null,"error":{{"code":-32603,"message":"serialization failed: {e}"}}}}"#
                )
            });
            let _ = writeln!(stdout, "{out}");
            let _ = stdout.flush();
        }
    }
}

fn resolve_book(
    explicit_dir: Option<PathBuf>,
    environment_dir: Option<PathBuf>,
    session_path: Option<PathBuf>,
) -> Result<(PathBuf, Book), String> {
    if let Some(dir) = explicit_dir {
        return load_book_candidate(dir, "command-line book directory");
    }
    if let Some(dir) = environment_dir {
        return load_book_candidate(dir, "UNDERSTAND_BOOK_DIR");
    }

    let session = load_session(&session_path).ok_or_else(|| {
        let location = session_path
            .as_deref()
            .map(Path::display)
            .map(|path| path.to_string())
            .unwrap_or_else(|| "<unavailable>".into());
        format!(
            "no current Reader book is available from {location}; open a book in Understand Book and start a new Codex thread, pass book_mcp <book_dir>, or set UNDERSTAND_BOOK_DIR"
        )
    })?;
    let current = session.current_book_dir.trim();
    if current.is_empty() {
        return Err(
            "the Reader session has no current book; open a book in Understand Book and start a new Codex thread"
                .into(),
        );
    }
    load_book_candidate(PathBuf::from(current), "Reader current book")
}

fn load_book_candidate(dir: PathBuf, source: &str) -> Result<(PathBuf, Book), String> {
    if dir.as_os_str().is_empty() {
        return Err(format!("{source} is empty"));
    }
    let dir_text = dir
        .to_str()
        .ok_or_else(|| format!("{source} is not valid UTF-8 ({})", dir.display()))?;
    let book = Book::load(dir_text)
        .map_err(|error| format!("failed to load {source} ({}): {error}", dir.display()))?;
    Ok((dir, book))
}

fn now_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "understand-book-mcp-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_book(root: &Path, book_id: &str) -> PathBuf {
        let dir = root.join(book_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("source.txt"), "alpha").unwrap();
        fs::write(
            dir.join("base.json"),
            serde_json::to_vec_pretty(&json!({
                "book_id": book_id,
                "lid_nodes": [{
                    "lid": "1",
                    "path": [1],
                    "kind": "paragraph",
                    "span": { "start": 0, "end": 5 },
                    "children": []
                }],
                "graph_nodes": [],
                "graph_edges": []
            }))
            .unwrap(),
        )
        .unwrap();
        dir
    }

    fn write_session(root: &Path, current_book_dir: &Path) -> PathBuf {
        let path = root.join("session.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "current_book_dir": current_book_dir,
                "books": {}
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    #[test]
    fn explicit_book_precedes_environment_and_session() {
        let root = temp_root("explicit-priority");
        let explicit = write_book(&root, "explicit");
        let environment = write_book(&root, "environment");
        let session = write_book(&root, "session");
        let session_path = write_session(&root, &session);

        let (dir, book) = resolve_book(
            Some(explicit.clone()),
            Some(environment),
            Some(session_path),
        )
        .unwrap();

        assert_eq!(dir, explicit);
        assert_eq!(book.base.book_id, "explicit");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn environment_book_precedes_session() {
        let root = temp_root("environment-priority");
        let environment = write_book(&root, "environment");
        let session = write_book(&root, "session");
        let session_path = write_session(&root, &session);

        let (dir, book) =
            resolve_book(None, Some(environment.clone()), Some(session_path)).unwrap();

        assert_eq!(dir, environment);
        assert_eq!(book.base.book_id, "environment");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reader_session_supplies_the_default_book() {
        let root = temp_root("session-default");
        let session = write_book(&root, "session");
        let session_path = write_session(&root, &session);

        let (dir, book) = resolve_book(None, None, Some(session_path)).unwrap();

        assert_eq!(dir, session);
        assert_eq!(book.base.book_id, "session");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_explicit_book_does_not_fall_through() {
        let root = temp_root("invalid-explicit");
        let session = write_book(&root, "session");
        let session_path = write_session(&root, &session);

        let error = resolve_book(Some(root.join("missing")), None, Some(session_path))
            .err()
            .expect("invalid explicit book must fail");

        assert!(error.contains("command-line book directory"));
        assert!(error.contains("missing"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_session_returns_actionable_startup_error() {
        let root = temp_root("missing-session");
        let session_path = root.join("session.json");

        let error = resolve_book(None, None, Some(session_path))
            .err()
            .expect("missing session must fail");

        assert!(error.contains("open a book in Understand Book"));
        assert!(error.contains("UNDERSTAND_BOOK_DIR"));
        let _ = fs::remove_dir_all(root);
    }
}
