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
        let runner = ProcessCodex { path: &codex };
        self.install_with_runner(source, &codex, &runner)
    }

    fn install_with_runner<R: CodexRunner>(
        &self,
        source: &str,
        codex: &Path,
        runner: &R,
    ) -> PluginStatus {
        let plugin_installed = match plugin_is_installed_with(runner, &self.config.marketplace_name)
        {
            Ok(installed) => installed,
            Err(error) => {
                return self.result(PluginState::Error, Some(codex.to_path_buf()), &error)
            }
        };
        let receipt = read_receipt(&self.config.receipt_path);
        let matching_receipt = receipt
            .as_ref()
            .filter(|receipt| receipt_matches_install(receipt, &self.config.marketplace_name));
        let owned_marketplace =
            matching_receipt.filter(|receipt| receipt.marketplace_added_by_setup);

        if plugin_installed {
            let Some(receipt) = owned_marketplace else {
                let (state, message) = if matching_receipt.is_some() {
                    (
                        PluginState::InstalledBySetup,
                        "Codex plugin is installed; its external marketplace was left unchanged",
                    )
                } else {
                    (
                        PluginState::InstalledExternally,
                        "Codex plugin was already installed; Setup did not claim ownership",
                    )
                };
                return self.result(state, Some(codex.to_path_buf()), message);
            };
            if receipt.marketplace_source != source {
                return self.migrate_owned_marketplace(source, codex, runner, receipt, true);
            }
            let marketplace_exists =
                match marketplace_exists_with(runner, &self.config.marketplace_name) {
                    Ok(exists) => exists,
                    Err(error) => {
                        return self.result(PluginState::Error, Some(codex.to_path_buf()), &error)
                    }
                };
            if !marketplace_exists {
                return self.result(
                    PluginState::Error,
                    Some(codex.to_path_buf()),
                    "Setup-owned Codex plugin is installed but its marketplace is missing; remove the plugin and retry installation",
                );
            }
            if let Err(error) = upgrade_marketplace(runner, &self.config.marketplace_name) {
                return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
            }
            return self.result(
                PluginState::InstalledBySetup,
                Some(codex.to_path_buf()),
                "Codex plugin marketplace was updated",
            );
        }

        let marketplace_existed =
            match marketplace_exists_with(runner, &self.config.marketplace_name) {
                Ok(exists) => exists,
                Err(error) => {
                    return self.result(PluginState::Error, Some(codex.to_path_buf()), &error)
                }
            };
        if marketplace_existed {
            if let Some(receipt) = owned_marketplace {
                if receipt.marketplace_source != source {
                    return self.migrate_owned_marketplace(source, codex, runner, receipt, false);
                }
                if let Err(error) = upgrade_marketplace(runner, &self.config.marketplace_name) {
                    return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
                }
            }
        }

        let mut marketplace_added_now = false;
        if !marketplace_existed {
            if let Err(error) = add_marketplace(runner, source) {
                if marketplace_source_conflict(&error) {
                    if let Some(receipt) = owned_marketplace {
                        return self
                            .migrate_owned_marketplace(source, codex, runner, receipt, false);
                    }
                    return self.result(
                        PluginState::Error,
                        Some(codex.to_path_buf()),
                        &format!(
                            "{error}. The existing '{}' marketplace is not owned by Understand Book; remove it manually before retrying",
                            self.config.marketplace_name
                        ),
                    );
                }
                return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
            }
            marketplace_added_now = true;
        }
        if let Err(error) = add_plugin(runner, &self.config.marketplace_name) {
            if marketplace_added_now {
                let _ = remove_marketplace(runner, &self.config.marketplace_name);
            }
            return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
        }

        let receipt = PluginReceipt {
            schema: "understand_book.plugin_installation.v1".into(),
            plugin_name: PLUGIN_NAME.into(),
            marketplace_name: self.config.marketplace_name.clone(),
            marketplace_source: source.into(),
            marketplace_added_by_setup: marketplace_added_now || owned_marketplace.is_some(),
            codex_path: codex.to_path_buf(),
            installed_at_unix_ms: now_unix_ms(),
        };
        if let Err(error) = write_receipt(&self.config.receipt_path, &receipt) {
            let _ = remove_plugin(runner, &self.config.marketplace_name);
            if marketplace_added_now {
                let _ = remove_marketplace(runner, &self.config.marketplace_name);
            }
            return self.result(
                PluginState::Error,
                Some(codex.to_path_buf()),
                &format!("plugin installation was rolled back because its receipt could not be written: {error}"),
            );
        }
        self.result(
            PluginState::InstalledBySetup,
            Some(codex.to_path_buf()),
            "Codex plugin was installed",
        )
    }

    fn migrate_owned_marketplace<R: CodexRunner>(
        &self,
        source: &str,
        codex: &Path,
        runner: &R,
        previous_receipt: &PluginReceipt,
        plugin_was_installed: bool,
    ) -> PluginStatus {
        if plugin_was_installed {
            if let Err(error) = remove_plugin(runner, &self.config.marketplace_name) {
                return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
            }
        }
        if let Err(error) = remove_marketplace(runner, &self.config.marketplace_name) {
            if plugin_was_installed {
                let _ = add_plugin(runner, &self.config.marketplace_name);
            }
            return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
        }
        if let Err(error) = add_marketplace(runner, source) {
            restore_marketplace(runner, previous_receipt, plugin_was_installed);
            return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
        }
        if let Err(error) = add_plugin(runner, &self.config.marketplace_name) {
            let _ = remove_marketplace(runner, &self.config.marketplace_name);
            restore_marketplace(runner, previous_receipt, plugin_was_installed);
            return self.result(PluginState::Error, Some(codex.to_path_buf()), &error);
        }

        let receipt = PluginReceipt {
            schema: "understand_book.plugin_installation.v1".into(),
            plugin_name: PLUGIN_NAME.into(),
            marketplace_name: self.config.marketplace_name.clone(),
            marketplace_source: source.into(),
            marketplace_added_by_setup: true,
            codex_path: codex.to_path_buf(),
            installed_at_unix_ms: now_unix_ms(),
        };
        if let Err(error) = write_receipt(&self.config.receipt_path, &receipt) {
            let _ = remove_plugin(runner, &self.config.marketplace_name);
            let _ = remove_marketplace(runner, &self.config.marketplace_name);
            restore_marketplace(runner, previous_receipt, plugin_was_installed);
            return self.result(
                PluginState::Error,
                Some(codex.to_path_buf()),
                &format!("marketplace migration was rolled back because its receipt could not be updated: {error}"),
            );
        }
        self.result(
            PluginState::InstalledBySetup,
            Some(codex.to_path_buf()),
            "Codex plugin marketplace source was migrated",
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

trait CodexRunner {
    fn run(&self, args: &[&str]) -> std::io::Result<Output>;
}

struct ProcessCodex<'a> {
    path: &'a Path,
}

impl CodexRunner for ProcessCodex<'_> {
    fn run(&self, args: &[&str]) -> std::io::Result<Output> {
        run_codex(self.path, args)
    }
}

fn add_marketplace<R: CodexRunner>(runner: &R, source: &str) -> Result<(), String> {
    require_success(
        runner.run(&["plugin", "marketplace", "add", source, "--json"]),
        "failed to add Codex plugin marketplace",
    )
    .map(|_| ())
}

fn upgrade_marketplace<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<(), String> {
    require_success(
        runner.run(&["plugin", "marketplace", "upgrade", marketplace, "--json"]),
        "failed to update Codex plugin marketplace",
    )
    .map(|_| ())
}

fn remove_marketplace<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<(), String> {
    require_success(
        runner.run(&["plugin", "marketplace", "remove", marketplace]),
        "failed to remove Codex plugin marketplace",
    )
    .map(|_| ())
}

fn add_plugin<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<(), String> {
    require_success(
        runner.run(&[
            "plugin",
            "add",
            PLUGIN_NAME,
            "--marketplace",
            marketplace,
            "--json",
        ]),
        "failed to install Codex plugin",
    )
    .map(|_| ())
}

fn remove_plugin<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<(), String> {
    require_success(
        runner.run(&[
            "plugin",
            "remove",
            PLUGIN_NAME,
            "--marketplace",
            marketplace,
            "--json",
        ]),
        "failed to remove Codex plugin",
    )
    .map(|_| ())
}

fn restore_marketplace<R: CodexRunner>(runner: &R, receipt: &PluginReceipt, restore_plugin: bool) {
    if add_marketplace(runner, &receipt.marketplace_source).is_ok() && restore_plugin {
        let _ = add_plugin(runner, &receipt.marketplace_name);
    }
}

fn marketplace_source_conflict(error: &str) -> bool {
    error.contains("already added from a different source")
}

fn receipt_matches_install(receipt: &PluginReceipt, marketplace: &str) -> bool {
    receipt.plugin_name == PLUGIN_NAME && receipt.marketplace_name == marketplace
}

fn plugin_is_installed(codex: &Path, marketplace: &str) -> Result<bool, String> {
    plugin_is_installed_with(&ProcessCodex { path: codex }, marketplace)
}

fn plugin_is_installed_with<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<bool, String> {
    let output = require_success(
        runner.run(&["plugin", "list", "--json"]),
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

fn marketplace_exists_with<R: CodexRunner>(runner: &R, marketplace: &str) -> Result<bool, String> {
    let output = require_success(
        runner.run(&["plugin", "marketplace", "list", "--json"]),
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
    let backup = path.with_extension("json.bak");
    fs::read(path)
        .or_else(|_| fs::read(backup))
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
}

fn write_receipt(path: &Path, receipt: &PluginReceipt) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let body = serde_json::to_vec_pretty(receipt).map_err(|error| error.to_string())?;
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    let _ = fs::remove_file(backup);
    Ok(())
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
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::ffi::OsString;

    struct ExpectedCall {
        args: Vec<String>,
        success: bool,
        stdout: String,
        stderr: String,
    }

    struct ScriptedRunner {
        expected: RefCell<VecDeque<ExpectedCall>>,
    }

    impl ScriptedRunner {
        fn new(expected: Vec<ExpectedCall>) -> Self {
            Self {
                expected: RefCell::new(expected.into()),
            }
        }

        fn assert_finished(&self) {
            assert!(
                self.expected.borrow().is_empty(),
                "not all expected Codex commands were called"
            );
        }
    }

    impl CodexRunner for ScriptedRunner {
        fn run(&self, args: &[&str]) -> std::io::Result<Output> {
            let expected = self
                .expected
                .borrow_mut()
                .pop_front()
                .expect("unexpected Codex command");
            let expected_args = expected.args.iter().map(String::as_str).collect::<Vec<_>>();
            assert_eq!(args, expected_args.as_slice());
            Ok(test_output(
                expected.success,
                &expected.stdout,
                &expected.stderr,
            ))
        }
    }

    fn successful_call(args: &[&str], stdout: &str) -> ExpectedCall {
        ExpectedCall {
            args: args.iter().map(|value| (*value).into()).collect(),
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    fn failed_call(args: &[&str], stderr: &str) -> ExpectedCall {
        ExpectedCall {
            args: args.iter().map(|value| (*value).into()).collect(),
            success: false,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    fn test_output(success: bool, stdout: &str, stderr: &str) -> Output {
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(if success { 0 } else { 1 << 8 })
        };
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(if success { 0 } else { 1 })
        };
        Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn manager_with_source(receipt_path: PathBuf, source: &str) -> PluginManager {
        PluginManager::new(PluginConfig {
            marketplace_source: Some(source.into()),
            marketplace_name: DEFAULT_MARKETPLACE_NAME.into(),
            receipt_path,
            local_app_data: None,
        })
    }

    fn owned_receipt(path: &Path, source: &str) {
        write_receipt(
            path,
            &PluginReceipt {
                schema: "understand_book.plugin_installation.v1".into(),
                plugin_name: PLUGIN_NAME.into(),
                marketplace_name: DEFAULT_MARKETPLACE_NAME.into(),
                marketplace_source: source.into(),
                marketplace_added_by_setup: true,
                codex_path: PathBuf::from("codex.exe"),
                installed_at_unix_ms: 42,
            },
        )
        .unwrap();
    }

    fn plugin_list(installed: bool) -> String {
        if installed {
            format!(
                r#"{{"installed":[{{"name":"{PLUGIN_NAME}","marketplaceName":"{DEFAULT_MARKETPLACE_NAME}","installed":true}}]}}"#
            )
        } else {
            r#"{"installed":[]}"#.into()
        }
    }

    fn marketplace_list(exists: bool) -> String {
        if exists {
            format!(r#"{{"marketplaces":[{{"name":"{DEFAULT_MARKETPLACE_NAME}"}}]}}"#)
        } else {
            r#"{"marketplaces":[]}"#.into()
        }
    }

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

    #[test]
    fn setup_owned_source_change_reinstalls_plugin_and_marketplace() {
        let path = env::temp_dir().join(format!(
            "understand-book-source-change-receipt-{}.json",
            now_unix_ms()
        ));
        owned_receipt(&path, "old/repo");
        let manager = manager_with_source(path.clone(), "new/repo");
        let runner = ScriptedRunner::new(vec![
            successful_call(&["plugin", "list", "--json"], &plugin_list(true)),
            successful_call(
                &[
                    "plugin",
                    "remove",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "remove", DEFAULT_MARKETPLACE_NAME],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "add", "new/repo", "--json"],
                "{}",
            ),
            successful_call(
                &[
                    "plugin",
                    "add",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
        ]);

        let status = manager.install_with_runner("new/repo", Path::new("codex.exe"), &runner);

        assert_eq!(status.state, PluginState::InstalledBySetup);
        assert_eq!(read_receipt(&path).unwrap().marketplace_source, "new/repo");
        runner.assert_finished();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn setup_owned_same_source_refreshes_marketplace() {
        let path = env::temp_dir().join(format!(
            "understand-book-source-upgrade-receipt-{}.json",
            now_unix_ms()
        ));
        owned_receipt(&path, "owner/repo");
        let manager = manager_with_source(path.clone(), "owner/repo");
        let runner = ScriptedRunner::new(vec![
            successful_call(&["plugin", "list", "--json"], &plugin_list(true)),
            successful_call(
                &["plugin", "marketplace", "list", "--json"],
                &marketplace_list(true),
            ),
            successful_call(
                &[
                    "plugin",
                    "marketplace",
                    "upgrade",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
        ]);

        let status = manager.install_with_runner("owner/repo", Path::new("codex.exe"), &runner);

        assert_eq!(status.state, PluginState::InstalledBySetup);
        runner.assert_finished();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn external_source_conflict_is_non_destructive_and_actionable() {
        let path = env::temp_dir().join(format!(
            "understand-book-external-conflict-receipt-{}.json",
            now_unix_ms()
        ));
        let manager = manager_with_source(path, "new/repo");
        let runner = ScriptedRunner::new(vec![
            successful_call(&["plugin", "list", "--json"], &plugin_list(false)),
            successful_call(
                &["plugin", "marketplace", "list", "--json"],
                &marketplace_list(false),
            ),
            failed_call(
                &["plugin", "marketplace", "add", "new/repo", "--json"],
                "marketplace 'understand-book' is already added from a different source; remove it before adding this source",
            ),
        ]);

        let status = manager.install_with_runner("new/repo", Path::new("codex.exe"), &runner);

        assert_eq!(status.state, PluginState::Error);
        assert!(status.message.contains("not owned by Understand Book"));
        runner.assert_finished();
    }

    #[test]
    fn setup_owned_hidden_source_conflict_recovers_after_add_failure() {
        let path = env::temp_dir().join(format!(
            "understand-book-hidden-conflict-receipt-{}.json",
            now_unix_ms()
        ));
        owned_receipt(&path, "owner/repo");
        let manager = manager_with_source(path.clone(), "owner/repo");
        let runner = ScriptedRunner::new(vec![
            successful_call(&["plugin", "list", "--json"], &plugin_list(false)),
            successful_call(
                &["plugin", "marketplace", "list", "--json"],
                &marketplace_list(false),
            ),
            failed_call(
                &["plugin", "marketplace", "add", "owner/repo", "--json"],
                "marketplace 'understand-book' is already added from a different source; remove it before adding this source",
            ),
            successful_call(
                &[
                    "plugin",
                    "marketplace",
                    "remove",
                    DEFAULT_MARKETPLACE_NAME,
                ],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "add", "owner/repo", "--json"],
                "{}",
            ),
            successful_call(
                &[
                    "plugin",
                    "add",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
        ]);

        let status = manager.install_with_runner("owner/repo", Path::new("codex.exe"), &runner);

        assert_eq!(status.state, PluginState::InstalledBySetup);
        runner.assert_finished();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn source_migration_failure_restores_previous_marketplace_and_plugin() {
        let path = env::temp_dir().join(format!(
            "understand-book-migration-rollback-receipt-{}.json",
            now_unix_ms()
        ));
        owned_receipt(&path, "old/repo");
        let manager = manager_with_source(path.clone(), "new/repo");
        let runner = ScriptedRunner::new(vec![
            successful_call(&["plugin", "list", "--json"], &plugin_list(true)),
            successful_call(
                &[
                    "plugin",
                    "remove",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "remove", DEFAULT_MARKETPLACE_NAME],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "add", "new/repo", "--json"],
                "{}",
            ),
            failed_call(
                &[
                    "plugin",
                    "add",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "new marketplace plugin is invalid",
            ),
            successful_call(
                &["plugin", "marketplace", "remove", DEFAULT_MARKETPLACE_NAME],
                "{}",
            ),
            successful_call(
                &["plugin", "marketplace", "add", "old/repo", "--json"],
                "{}",
            ),
            successful_call(
                &[
                    "plugin",
                    "add",
                    PLUGIN_NAME,
                    "--marketplace",
                    DEFAULT_MARKETPLACE_NAME,
                    "--json",
                ],
                "{}",
            ),
        ]);

        let status = manager.install_with_runner("new/repo", Path::new("codex.exe"), &runner);

        assert_eq!(status.state, PluginState::Error);
        assert_eq!(read_receipt(&path).unwrap().marketplace_source, "old/repo");
        runner.assert_finished();
        fs::remove_file(path).unwrap();
    }
}
