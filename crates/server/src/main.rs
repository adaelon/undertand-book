use server::host::{start_server, ServerHostConfig};

#[cfg(target_os = "linux")]
static STOP_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "linux")]
extern "C" fn request_stop(_: libc::c_int) {
    STOP_REQUESTED.store(true, std::sync::atomic::Ordering::Release);
}

fn main() {
    #[cfg(target_os = "linux")]
    unsafe {
        // The handler only sets an atomic notification; shutdown runs on the main thread.
        for signal in [libc::SIGINT, libc::SIGTERM] {
            if libc::signal(signal, request_stop as *const () as libc::sighandler_t) == libc::SIG_ERR {
                eprintln!("failed to install stop signal handler: {}", std::io::Error::last_os_error());
                std::process::exit(1);
            }
        }
    }
    let (book_dir, reader_only) = parse_args(std::env::args().skip(1), std::env::var("UNDERSTAND_BOOK_DIR").ok())
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    let mut config = ServerHostConfig::from_env(book_dir);
    config.reader_only = reader_only;
    match start_server(config) {
        Ok(server) => {
            eprintln!("understand-book server listening at {}", server.url);
            #[cfg(target_os = "linux")]
            {
                while !STOP_REQUESTED.load(std::sync::atomic::Ordering::Acquire) {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                server.shutdown();
                eprintln!("understand-book server stopped cleanly");
            }
            #[cfg(not(target_os = "linux"))]
            server.wait();
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn parse_args(args: impl IntoIterator<Item = String>, env_book: Option<String>) -> Result<(String, bool), String> {
    let mut book = None;
    let mut reader_only = false;
    let mut positional = false;
    for arg in args {
        if !positional && arg == "--" { positional = true; continue; }
        if !positional && arg == "--reader-only" { reader_only = true; continue; }
        if !positional && arg.starts_with('-') { return Err(format!("unknown option: {arg}")); }
        if book.replace(arg).is_some() { return Err("expected one book directory".into()); }
    }
    book.or(env_book).filter(|value| !value.is_empty())
        .map(|book| (book, reader_only))
        .ok_or_else(|| "usage: server [--reader-only] <book_dir> (or set UNDERSTAND_BOOK_DIR)".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_and_reader_cli_preserve_book_selection() {
        for (args, env, book, mode) in [
            (vec!["C:\\books\\demo"], None, "C:\\books\\demo", false),
            (vec![], Some("env-book"), "env-book", false),
            (vec!["--reader-only", "/books/中文 空格"], None, "/books/中文 空格", true),
            (vec!["--reader-only"], Some("env-book"), "env-book", true),
            (vec!["book", "--reader-only"], Some("ignored"), "book", true),
        ] {
            assert_eq!(parse_args(args.into_iter().map(str::to_string), env.map(str::to_string)).unwrap(), (book.into(), mode));
        }
        assert!(parse_args(vec![], None).is_err());
        assert!(parse_args(vec!["--typo".into()], Some("book".into())).is_err());
        assert!(parse_args(vec!["one".into(), "two".into()], None).is_err());
    }
}
