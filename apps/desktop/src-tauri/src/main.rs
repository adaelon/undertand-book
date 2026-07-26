mod library_settings;
mod plugin_manager;

use library_settings::{LibrarySettingsStore, PersistedProviderSettings};
use plugin_manager::{PluginConfig, PluginManager, PluginState};
use runtime::{ModelAdapter, ProviderConfig, ProviderRegistry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::host::{start_server, RunningServer, ServerHostConfig};
use server::{
    run_codex_build_intent_command, CodexBuildIntentControllerConfig, UnconfiguredAdapter,
};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

struct DesktopServer {
    server: Mutex<Option<RunningServer>>,
    library_settings: LibrarySettingsStore,
}

#[derive(Serialize)]
struct DesktopLibrarySelection {
    library_root: String,
}

#[derive(Deserialize)]
struct DesktopProviderInput {
    mode: String,
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Debug, Serialize)]
struct DesktopProviderStatus {
    configured: bool,
    source: &'static str,
    mode: String,
    base_url: String,
    model: String,
    api_key_configured: bool,
}

const CODEX_BUILD_INTENT_REQUEST_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CodexBuildIntentCommand {
    version: String,
    operation: String,
    target: CodexBuildIntentTarget,
    input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CodexBuildIntentTarget {
    workspace_dir: PathBuf,
}

fn persisted_provider_config(
    settings: &PersistedProviderSettings,
) -> Result<ProviderConfig, String> {
    ProviderConfig::from_values(
        &settings.mode,
        settings.api_key.clone(),
        settings.base_url.clone(),
        settings.model.clone(),
    )
    .map_err(|error| error.message)
}

fn provider_status(config: &ProviderConfig, source: &'static str) -> DesktopProviderStatus {
    DesktopProviderStatus {
        configured: true,
        source,
        mode: config.mode.as_str().into(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        api_key_configured: !config.api_key.is_empty(),
    }
}

fn unconfigured_provider_status() -> DesktopProviderStatus {
    DesktopProviderStatus {
        configured: false,
        source: "unconfigured",
        mode: "native".into(),
        base_url: String::new(),
        model: String::new(),
        api_key_configured: false,
    }
}

fn load_desktop_provider_env(local_app_data: &std::path::Path) {
    let _ = dotenvy::from_path(local_app_data.join("UnderstandBook").join(".env"));
    if cfg!(debug_assertions) {
        let repository_env = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
        let _ = dotenvy::from_path(repository_env);
    }
}

fn plugin_manager() -> Result<PluginManager, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let receipt = local_app_data
        .join("UnderstandBook")
        .join("plugin-installation.json");
    Ok(PluginManager::new(PluginConfig::from_environment(receipt)))
}

fn read_codex_build_intent_command(reader: impl Read) -> Result<CodexBuildIntentCommand, String> {
    let mut body = Vec::new();
    reader
        .take((CODEX_BUILD_INTENT_REQUEST_MAX_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| "failed to read Codex build-intent request from stdin".to_string())?;
    if body.len() > CODEX_BUILD_INTENT_REQUEST_MAX_BYTES {
        return Err("Codex build-intent request exceeds 64 KiB".into());
    }
    let command: CodexBuildIntentCommand = serde_json::from_slice(&body)
        .map_err(|error| format!("Codex build-intent request is invalid JSON: {error}"))?;
    if command.version != "codex_build_intent_command.v1" {
        return Err("unsupported Codex build-intent command version".into());
    }
    if !command.target.workspace_dir.is_absolute() {
        return Err("Codex build-intent workspace_dir must be absolute".into());
    }
    Ok(command)
}

fn codex_build_intent_adapter(
    settings: &LibrarySettingsStore,
) -> Result<Box<dyn ModelAdapter + Send>, String> {
    if let Some(settings) = settings.provider_settings()? {
        return persisted_provider_config(&settings).map(ProviderRegistry::adapter_from_config);
    }
    Ok(ProviderConfig::from_env()
        .map(ProviderRegistry::adapter_from_config)
        .unwrap_or_else(|_| Box::new(UnconfiguredAdapter)))
}

fn codex_build_intent_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .to_string()
}

fn redact_codex_private_text(message: &str, private_goal: Option<&str>) -> String {
    let Some(goal) = private_goal.filter(|goal| !goal.is_empty()) else {
        return message.to_string();
    };
    let redacted = message.replace(goal, "[redacted]");
    let escaped = serde_json::to_string(goal).unwrap_or_default();
    let escaped = escaped
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(&escaped);
    if escaped.is_empty() {
        redacted
    } else {
        redacted.replace(escaped, "[redacted]")
    }
}

fn handle_codex_build_intent_command() -> i32 {
    let command = match read_codex_build_intent_command(std::io::stdin().lock()) {
        Ok(command) => command,
        Err(message) => {
            eprintln!(
                "{}",
                serde_json::json!({
                    "error_code": "CODEX_BUILD_INTENT_REQUEST_INVALID",
                    "category": "validation",
                    "message": message,
                })
            );
            return 2;
        }
    };
    let private_goal = command
        .input
        .get("user_goal")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        eprintln!(
            "{}",
            serde_json::json!({
                "error_code": "CODEX_BUILD_INTENT_SETTINGS_UNAVAILABLE",
                "category": "unavailable",
                "message": "LOCALAPPDATA is unavailable",
            })
        );
        return 2;
    };
    load_desktop_provider_env(&local_app_data);
    let settings =
        LibrarySettingsStore::new(local_app_data.join("UnderstandBook").join("settings.json"));
    let documents = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|path| path.join("Documents").join("UnderstandBook"))
        .unwrap_or_else(|| local_app_data.join("UnderstandBook").join("library"));
    let result = (|| {
        let library_root = settings.initial_root(&documents)?;
        let adapter = codex_build_intent_adapter(&settings)?;
        run_codex_build_intent_command(
            CodexBuildIntentControllerConfig {
                book_dir: command.target.workspace_dir,
                library_root,
                intent_store_root: None,
            },
            adapter,
            &command.operation,
            command.input,
            &codex_build_intent_now(),
        )
        .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| {
            r#"{"error_code":"CODEX_BUILD_INTENT_FAILED","category":"internal","message":"Codex build-intent command failed"}"#.into()
        }))
    })();
    match result {
        Ok(response) => match serde_json::to_string(&response) {
            Ok(response) => {
                println!("{response}");
                0
            }
            Err(_) => {
                eprintln!(
                    "{}",
                    r#"{"error_code":"CODEX_BUILD_INTENT_SERIALIZE_FAILED","category":"internal","message":"Codex build-intent response serialization failed"}"#
                );
                2
            }
        },
        Err(error) => {
            eprintln!(
                "{}",
                redact_codex_private_text(&error, private_goal.as_deref())
            );
            2
        }
    }
}

fn handle_maintenance_command() -> Option<i32> {
    let command = std::env::args().nth(1);
    if command.as_deref() == Some("--codex-build-intent") {
        return Some(handle_codex_build_intent_command());
    }
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

#[tauri::command]
fn set_desktop_library_directory(
    selected_dir: String,
    desktop: State<'_, DesktopServer>,
) -> Result<DesktopLibrarySelection, String> {
    let selected = PathBuf::from(selected_dir);
    let mut server = desktop
        .server
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(server) = server.as_mut() else {
        return Err("desktop server is unavailable".into());
    };
    let root = desktop.library_settings.apply_selection(&selected)?;
    server.set_library_root(root.clone());
    Ok(DesktopLibrarySelection {
        library_root: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn desktop_provider_status(
    desktop: State<'_, DesktopServer>,
) -> Result<DesktopProviderStatus, String> {
    if let Some(settings) = desktop.library_settings.provider_settings()? {
        let config = persisted_provider_config(&settings)?;
        return Ok(provider_status(&config, "settings"));
    }
    Ok(match ProviderConfig::from_env() {
        Ok(config) => provider_status(&config, "environment"),
        Err(_) => unconfigured_provider_status(),
    })
}

#[tauri::command]
fn save_desktop_provider_settings(
    input: DesktopProviderInput,
    desktop: State<'_, DesktopServer>,
) -> Result<DesktopProviderStatus, String> {
    let existing = desktop.library_settings.provider_settings()?;
    let environment = ProviderConfig::from_env().ok();
    let api_key = if input.api_key.trim().is_empty() {
        existing
            .as_ref()
            .map(|settings| settings.api_key.clone())
            .or_else(|| environment.as_ref().map(|config| config.api_key.clone()))
            .ok_or_else(|| "Provider API Key 不能为空".to_string())?
    } else {
        input.api_key
    };
    let config = ProviderConfig::from_values(&input.mode, api_key, input.base_url, input.model)
        .map_err(|error| error.message)?;
    let persisted = PersistedProviderSettings {
        mode: config.mode.as_str().into(),
        api_key: config.api_key.clone(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
    };
    let mut server = desktop
        .server
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(server) = server.as_mut() else {
        return Err("desktop server is unavailable".into());
    };
    let library_root = server
        .library_root()
        .ok_or_else(|| "desktop library root is unavailable".to_string())?;
    desktop
        .library_settings
        .apply_provider(&library_root, persisted)?;
    server.set_provider_config(config.clone());
    Ok(provider_status(&config, "settings"))
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            codex_plugin_status,
            install_codex_plugin,
            set_desktop_library_directory,
            desktop_provider_status,
            save_desktop_provider_settings
        ])
        .setup(|app| {
            let documents = app
                .path()
                .document_dir()
                .map_err(|error| format!("failed to resolve Documents directory: {error}"))?;
            let local_app_data = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
            load_desktop_provider_env(&local_app_data);
            let library_settings = LibrarySettingsStore::new(
                local_app_data.join("UnderstandBook").join("settings.json"),
            );
            let library_root = library_settings.initial_root(&documents.join("UnderstandBook"))?;
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
            if let Some(settings) = library_settings.provider_settings()? {
                if let Ok(config) = persisted_provider_config(&settings) {
                    server.set_provider_config(config);
                }
            }
            let url = server
                .url
                .parse()
                .map_err(|error| format!("invalid reader URL: {error}"))?;
            app.manage(DesktopServer {
                server: Mutex::new(Some(server)),
                library_settings,
            });
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
                    .server
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn provider_status_never_serializes_the_api_key() {
        let config = ProviderConfig::from_values(
            "native",
            "super-secret",
            "https://provider.example/v1",
            "model-a",
        )
        .unwrap();

        let json = serde_json::to_string(&provider_status(&config, "settings")).unwrap();

        assert!(!json.contains("super-secret"));
        assert!(json.contains("\"api_key_configured\":true"));
    }

    #[test]
    fn codex_build_intent_command_is_strict_and_never_uses_argv_for_goal() {
        let workspace = std::env::current_dir().unwrap();
        let parsed = read_codex_build_intent_command(Cursor::new(
            serde_json::json!({
                "version": "codex_build_intent_command.v1",
                "operation": "draft",
                "target": { "workspace_dir": workspace },
                "input": { "user_goal": "private goal" },
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(parsed.operation, "draft");
        assert_eq!(parsed.input["user_goal"], "private goal");

        let unknown = serde_json::json!({
            "version": "codex_build_intent_command.v1",
            "operation": "status",
            "target": { "workspace_dir": workspace },
            "input": {},
            "raw_goal": "must be rejected",
        })
        .to_string();
        assert!(read_codex_build_intent_command(Cursor::new(unknown)).is_err());
        let private_goal = "line one\nline two";
        let provider_error = format!(
            r#"{{"message":"provider echoed {}"}}"#,
            serde_json::to_string(private_goal)
                .unwrap()
                .trim_matches('"')
        );
        let redacted = redact_codex_private_text(&provider_error, Some(private_goal));
        assert!(!redacted.contains("line one"));
        assert!(redacted.contains("[redacted]"));
    }
}
