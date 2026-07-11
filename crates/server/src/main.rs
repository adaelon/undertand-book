use server::host::{start_server, ServerHostConfig};

fn main() {
    let book_dir = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("UNDERSTAND_BOOK_DIR").ok())
        .unwrap_or_else(|| {
            eprintln!("usage: server <book_dir> (or set UNDERSTAND_BOOK_DIR)");
            std::process::exit(2);
        });
    let config = ServerHostConfig::from_env(book_dir);
    match start_server(config) {
        Ok(server) => {
            eprintln!("understand-book server listening at {}", server.url);
            server.wait();
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
