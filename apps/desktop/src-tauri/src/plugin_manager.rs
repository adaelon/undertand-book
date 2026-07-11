use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

const PLUGIN_NAME: &str = "understand-book";
const DEFAULT_MARKETPLACE_NAME: &str = "understand-book";

#[derive(Clone, Debug)]
pub struct PluginConfig {
    pub marketplace_source: Option<String>,
    pub marketplace_name: String,
    pub receipt_path: PathBuf,
    pub local_app_data: Option<PathBuf>,
}

impl PluginConfig {
    pub fn from_environment(receipt_path: PathBuf) -> Self {
        Self {
            marketplace_source: env::var("UNDERSTAND_BOOK_MARKETPLACE_SOURCE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    option_env!("UNDERSTAND_BOOK_MARKETPLACE_SOURCE")
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                }),
            marketplace_name: env::var("UNDERSTAND_BOOK_MARKETPLACE_NAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    option_env!("UNDERSTAND_BOOK_MARKETPLACE_NAME")
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| DEFAULT_MARKETPLACE_NAME.into()),
            receipt_path,
            local_app_data: env::var_os("LOCALAPPDATA").map(PathBuf::from),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PluginReceipt {
    pub schema: String,
    pub plugin_name: String,
    pub marketplace_name: String,
    pub marketplace_source: String,
    pub marketplace_added_by_setup: bool,
    pub codex_path: PathBuf,
    pub installed_at_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    InstalledBySetup,
    InstalledExternally,
    PendingConfiguration,
    CodexNotFound,
    NotInstalled,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PluginStatus {
    pub state: PluginState,
    pub codex_path: Option<PathBuf>,
    pub marketplace_name: String,
    pub plugin_name: String,
    pub message: String,
}

pub struct PluginManager {
    config: PluginConfig,
}

impl PluginManager {
    pub fn new(config: PluginConfig) -> Self {
        Self { config }
    }

    pub fn status(&self) -> PluginStatus {
        let Some(codex) = discover_codex(self.config.local_app_data.as_deref()) else {
            return self.result(PluginState::CodexNotFound, None, "Codex CLI was not found");
        };
        if self.config.marketplace_source.is_none() {
            return self.result(
                PluginState::PendingConfiguration,
                Some(codex),
                "This build has no plugin marketplace source configured",
            );
        }
        match plugin_is_installed(&codex, &self.config.marketplace_name) {
            Ok(true) => {
                let owned = read_receipt(&self.config.receipt_path)
                    .map(|receipt| receipt.plugin_name == PLUGIN_NAME)
                    .unwrap_or(false);
                if owned {
                    self.result(
                        PluginState::InstalledBySetup,
                        Some(codex),
                        "Codex plugin is installed",
                    )
                } else {
                    self.result(
                        PluginState::InstalledExternally,
                        Some(codex),
                        "Codex plugin was already installed outside Understand Book Setup",
                    )
                }
            }
            Ok(false) => self.result(
                PluginState::NotInstalled,
                Some(codex),
                "Codex plugin is not installed",
            ),
            Err(error) => self.result(PluginState::Error, Some(codex), &error),
        }
    }

    pub fn install(&self) -> PluginStatus {
        let Some(source) = self.config.marketplace_source.as_deref() else {
            return self.result(
                PluginState::PendingConfiguration,
                None,
                "This build has no plugin marketplace source configured",
            );
        };
        let Some(codex) = discover_codex(self.config.local_app_data.as_deref()) else {
            return self.result(PluginState::CodexNotFound, None, "Codex CLI was not found");
        };
        match plugin_is_installed(&codex, &self.config.marketplace_name) {
            Ok(true) => {
                return self.result(
                    PluginState::InstalledExternally,
                    Some(codex),
                    "Codex plugin was already installed; Setup did not claim ownership",
                )
            }
            Err(error) => return self.result(PluginState::Error, Some(codex), &error),
            Ok(false) => {}
        }

        let marketplace_existed =
            marketplace_exists(&codex, &self.config.marketplace_name).unwrap_or(false);
        if !marketplace_existed {
            let output = run_codex(&codex, &["plugin", "marketplace", "add", source, "--json"]);
            if let Err(error) = require_success(output, "failed to add Codex plugin marketplace") {
                return self.result(PluginState::Error, Some(codex), &error);
            }
        }
        let output = run_codex(
            &codex,
            &[
                "plugin",
                "add",
                PLUGIN_NAME,
                "--marketplace",
                &self.config.marketplace_name,
                "--json",
            ],
        );
        if let Err(error) = require_success(output, "failed to install Codex plugin") {
            if !marketplace_existed {
                let _ = run_codex(
                    &codex,
                    &[
                        "plugin",
                        "marketplace",
                        "remove",
                        &self.config.marketplace_name,
                    ],
                );
            }
            return self.result(PluginState::Error, Some(codex), &error);
        }

        let receipt = PluginReceipt {
            schema: "understand_book.plugin_installation.v1".into(),
            plugin_name: PLUGIN_NAME.into(),
            marketplace_name: self.config.marketplace_name.clone(),
            marketplace_source: source.into(),
            marketplace_added_by_setup: !marketplace_existed,
            codex_path: codex.clone(),
            installed_at_unix_ms: now_unix_ms(),
        };
        if let Err(error) = write_receipt(&self.config.receipt_path, &receipt) {
            let _ = run_codex(
                &codex,
                &[
                    "plugin",
                    "remove",
                    PLUGIN_NAME,
                    "--marketplace",
                    &self.config.marketplace_name,
                    "--json",
                ],
            );
            if !marketplace_existed {
                let _ = run_codex(
                    &codex,
                    &[
                        "plugin",
                        "marketplace",
                        "remove",
                        &self.config.marketplace_name,
                    ],
                );
            }
            return self.result(
                PluginState::Error,
                Some(codex),
                &format!("plugin installation was rolled back because its receipt could not be written: {error}"),
            );
        }
        self.result(
            PluginState::InstalledBySetup,
            Some(codex),
            "Codex plugin was installed",
        )
    }

    pub fn uninstall_owned(&self) -> PluginStatus {
        let Some(receipt) = read_receipt(&self.config.receipt_path) else {
            return self.result(
                PluginState::InstalledExternally,
                None,
                "No Setup receipt exists; the Codex plugin was left unchanged",
            );
        };
        let codex = if verify_codex(&receipt.codex_path) {
            Some(receipt.codex_path.clone())
        } else {
            discover_codex(self.config.local_app_data.as_deref())
        };
        let Some(codex) = codex else {
            return self.result(
                PluginState::CodexNotFound,
                None,
                "Codex CLI was not found; receipt was retained",
            );
        };
        let remove = run_codex(
            &codex,
            &[
                "plugin",
                "remove",
                &receipt.plugin_name,
                "--marketplace",
                &receipt.marketplace_name,
                "--json",
            ],
        );
        if let Err(error) = require_success(remove, "failed to remove Codex plugin") {
            return self.result(PluginState::Error, Some(codex), &error);
        }
        if receipt.marketplace_added_by_setup {
            let remove_marketplace = run_codex(
                &codex,
                &["plugin", "marketplace", "remove", &receipt.marketplace_name],
            );
            if let Err(error) = require_success(
                remove_marketplace,
                "plugin was removed, but its marketplace could not be removed",
            ) {
                return self.result(PluginState::Error, Some(codex), &error);
            }
        }
        if let Err(error) = fs::remove_file(&self.config.receipt_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return self.result(
                    PluginState::Error,
                    Some(codex),
                    &format!("plugin was removed, but receipt cleanup failed: {error}"),
                );
            }
        }
        self.result(
            PluginState::NotInstalled,
            Some(codex),
            "Setup-owned Codex plugin was removed",
        )
    }

    fn result(
        &self,
        state: PluginState,
        codex_path: Option<PathBuf>,
        message: &str,
    ) -> PluginStatus {
        PluginStatus {
            state,
            codex_path,
            marketplace_name: self.config.marketplace_name.clone(),
            plugin_name: PLUGIN_NAME.into(),
            message: message.into(),
        }
    }
}

fn discover_codex(local_app_data: Option<&Path>) -> Option<PathBuf> {
    discover_codex_from(env::var_os("PATH").as_deref(), local_app_data, verify_codex)
}

fn discover_codex_from(
    path: Option<&std::ffi::OsStr>,
    local_app_data: Option<&Path>,
    verify: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = path {
        for directory in env::split_paths(path) {
            candidates.push(directory.join("codex.exe"));
            candidates.push(directory.join("codex.cmd"));
            candidates.push(directory.join("codex"));
        }
    }
    if let Some(root) = local_app_data {
        let app_bin = root.join("OpenAI").join("Codex").join("bin");
        if let Ok(entries) = fs::read_dir(app_bin) {
            let mut app_candidates = entries
                .flatten()
                .map(|entry| entry.path().join("codex.exe"))
                .collect::<Vec<_>>();
            app_candidates.sort_by(|a, b| b.cmp(a));
            candidates.extend(app_candidates);
        }
    }
    let mut seen = HashSet::new();
    candidates.into_iter().find(|candidate| {
        seen.insert(candidate.clone()) && candidate.is_file() && verify(candidate)
    })
}

fn verify_codex(path: &Path) -> bool {
    run_codex(path, &["plugin", "--help"])
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains("Manage Codex plugins")
        })
        .unwrap_or(false)
}

fn run_codex(path: &Path, args: &[&str]) -> std::io::Result<Output> {
    Command::new(path).args(args).output()
}

fn plugin_is_installed(codex: &Path, marketplace: &str) -> Result<bool, String> {
    let output = require_success(
        run_codex(codex, &["plugin", "list", "--json"]),
        "failed to inspect Codex plugins",
    )?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Codex returned invalid plugin JSON: {error}"))?;
    Ok(value
        .get("installed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|plugin| {
            plugin.get("name").and_then(Value::as_str) == Some(PLUGIN_NAME)
                && plugin.get("marketplaceName").and_then(Value::as_str) == Some(marketplace)
                && plugin
                    .get("installed")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
        }))
}

fn marketplace_exists(codex: &Path, marketplace: &str) -> Result<bool, String> {
    let output = require_success(
        run_codex(codex, &["plugin", "marketplace", "list", "--json"]),
        "failed to inspect Codex plugin marketplaces",
    )?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Codex returned invalid marketplace JSON: {error}"))?;
    Ok(value
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|entry| entry.get("name").and_then(Value::as_str) == Some(marketplace)))
}

fn require_success(output: std::io::Result<Output>, context: &str) -> Result<Output, String> {
    let output = output.map_err(|error| format!("{context}: {error}"))?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        context.into()
    } else {
        format!("{context}: {stderr}")
    })
}

fn read_receipt(path: &Path) -> Option<PluginReceipt> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_receipt(path: &Path, receipt: &PluginReceipt) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(receipt).map_err(|error| error.to_string())?;
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn path_candidates_precede_codex_app_candidates() {
        let root =
            env::temp_dir().join(format!("understand-book-codex-discovery-{}", now_unix_ms()));
        let path_dir = root.join("path");
        let app_dir = root
            .join("local")
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("version");
        fs::create_dir_all(&path_dir).unwrap();
        fs::create_dir_all(&app_dir).unwrap();
        let path_codex = path_dir.join("codex.exe");
        let app_codex = app_dir.join("codex.exe");
        fs::write(&path_codex, b"").unwrap();
        fs::write(&app_codex, b"").unwrap();
        let search_path: OsString = env::join_paths([&path_dir]).unwrap();

        let found = discover_codex_from(Some(&search_path), Some(&root.join("local")), |_| true);

        assert_eq!(found, Some(path_codex));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absent_marketplace_source_is_an_explicit_pending_state() {
        let manager = PluginManager::new(PluginConfig {
            marketplace_source: None,
            marketplace_name: DEFAULT_MARKETPLACE_NAME.into(),
            receipt_path: env::temp_dir().join("unused-receipt.json"),
            local_app_data: None,
        });
        let status = manager.install();
        assert_eq!(status.state, PluginState::PendingConfiguration);
    }

    #[test]
    fn receipt_round_trips_ownership_fields() {
        let path = env::temp_dir().join(format!("understand-book-receipt-{}.json", now_unix_ms()));
        let receipt = PluginReceipt {
            schema: "understand_book.plugin_installation.v1".into(),
            plugin_name: PLUGIN_NAME.into(),
            marketplace_name: DEFAULT_MARKETPLACE_NAME.into(),
            marketplace_source: "owner/repo".into(),
            marketplace_added_by_setup: true,
            codex_path: PathBuf::from("codex.exe"),
            installed_at_unix_ms: 42,
        };
        write_receipt(&path, &receipt).unwrap();
        assert_eq!(read_receipt(&path), Some(receipt));
        fs::remove_file(path).unwrap();
    }
}
