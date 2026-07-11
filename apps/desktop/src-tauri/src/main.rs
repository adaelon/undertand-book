mod plugin_manager;

use plugin_manager::{PluginConfig, PluginManager, PluginState};
use server::host::{start_server, RunningServer, ServerHostConfig};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct DesktopServer(Mutex<Option<RunningServer>>);

fn plugin_manager() -> Result<PluginManager, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let receipt = local_app_data
        .join("UnderstandBook")
        .join("plugin-installation.json");
    Ok(PluginManager::new(PluginConfig::from_environment(receipt)))
}

fn handle_maintenance_command() -> Option<i32> {
    let command = std::env::args().nth(1);
    let (status, failure_states) = match command.as_deref() {
        Some("--codex-plugin-status") => (plugin_manager().map(|manager| manager.status()), false),
        Some("--install-codex-plugin") => (plugin_manager().map(|manager| manager.install()), true),
        Some("--uninstall-owned-codex-plugin") => (
            plugin_manager().map(|manager| manager.uninstall_owned()),
            true,
        ),
        _ => return None,
    };
    let exit_code = match status {
        Ok(status) => {
            let failed = failure_states
                && matches!(
                    status.state,
                    PluginState::PendingConfiguration
                        | PluginState::CodexNotFound
                        | PluginState::Error
                );
            match serde_json::to_string(&status) {
                Ok(json) => println!("{json}"),
                Err(error) => {
                    eprintln!("{error}");
                    return Some(2);
                }
            }
            if failed {
                2
            } else {
                0
            }
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    };
    Some(exit_code)
}

#[tauri::command]
fn codex_plugin_status() -> Result<plugin_manager::PluginStatus, String> {
    plugin_manager().map(|manager| manager.status())
}

#[tauri::command]
fn install_codex_plugin() -> Result<plugin_manager::PluginStatus, String> {
    plugin_manager().map(|manager| manager.install())
}

fn web_dist(app: &tauri::App) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/web/dist"));
    }
    app.path()
        .resource_dir()
        .map(|dir| dir.join("resources/web-dist"))
        .map_err(|error| format!("failed to resolve app resources: {error}"))
}

fn main() {
    if let Some(exit_code) = handle_maintenance_command() {
        std::process::exit(exit_code);
    }
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            codex_plugin_status,
            install_codex_plugin
        ])
        .setup(|app| {
            let documents = app
                .path()
                .document_dir()
                .map_err(|error| format!("failed to resolve Documents directory: {error}"))?;
            let library_root = documents.join("UnderstandBook").join(".understand-book");
            let initial_book = std::env::args().nth(1).map(PathBuf::from);
            let server = match initial_book {
                Some(book_dir) => start_server(ServerHostConfig {
                    book_dir: Some(book_dir),
                    library_root: Some(library_root),
                    addr: "127.0.0.1:0".into(),
                    web_dist: web_dist(app)?,
                })?,
                None => start_server(ServerHostConfig::desktop(library_root, web_dist(app)?))?,
            };
            let url = server
                .url
                .parse()
                .map_err(|error| format!("invalid reader URL: {error}"))?;
            app.manage(DesktopServer(Mutex::new(Some(server))));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Understand Book")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0)
                .build()
                .map_err(|error| format!("failed to create reader window: {error}"))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Understand Book desktop app");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = handle.try_state::<DesktopServer>() {
                if let Some(server) = state
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    server.shutdown();
                }
            }
        }
    });
}
