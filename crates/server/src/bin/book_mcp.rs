use memory::{MemoryStore, READER_PRIVATE_STORAGE_UNAVAILABLE};
use read_tools::{Book, ToolError};
use reader::{Reader, DEFAULT_RADIUS};
use runtime::orchestrator::new_session;
use runtime::{ModelAdapter, ProviderRegistry};
use server::mcp::{handle_jsonrpc_message, VisitorSessions};
use server::{AppState, UnconfiguredAdapter};
use std::io::{BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("UNDERSTAND_BOOK_DIR").ok())
        .unwrap_or_else(|| {
            eprintln!("usage: book_mcp <book_dir>  (or set UNDERSTAND_BOOK_DIR)");
            std::process::exit(2);
        });
    let book = match Book::load(&dir) {
        Ok(book) => book,
        Err(e) => {
            eprintln!("failed to load book {dir}: {e}");
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
        book_dir: std::path::PathBuf::from(&dir),
        library_root: None,
        book,
        reader,
        store,
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

fn now_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string()
}
