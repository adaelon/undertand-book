use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SETTINGS_SCHEMA: &str = "understand_book.desktop_settings.v1";

#[derive(Clone, Debug)]
pub struct LibrarySettingsStore {
    path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PersistedProviderSettings {
    pub mode: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct DesktopSettings {
    schema: String,
    library_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<PersistedProviderSettings>,
}

impl LibrarySettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn initial_root(&self, default_parent: &Path) -> Result<PathBuf, String> {
        match self.load()? {
            Some(root) => Ok(root),
            None => {
                fs::create_dir_all(default_parent).map_err(|error| {
                    format!(
                        "failed to create default library parent ({}): {error}",
                        default_parent.display()
                    )
                })?;
                let root = resolve_library_root(default_parent)?;
                ensure_library_root(&root)?;
                Ok(root)
            }
        }
    }

    pub fn apply_selection(&self, selected: &Path) -> Result<PathBuf, String> {
        let root = resolve_library_root(selected)?;
        ensure_library_root(&root)?;
        let mut settings = self.load_settings()?.unwrap_or_else(|| DesktopSettings {
            schema: SETTINGS_SCHEMA.into(),
            library_root: root.clone(),
            provider: None,
        });
        settings.library_root = root.clone();
        self.write(&settings)?;
        Ok(root)
    }

    pub fn provider_settings(&self) -> Result<Option<PersistedProviderSettings>, String> {
        Ok(self.load_settings()?.and_then(|settings| settings.provider))
    }

    pub fn apply_provider(
        &self,
        library_root: &Path,
        provider: PersistedProviderSettings,
    ) -> Result<(), String> {
        let mut settings = self.load_settings()?.unwrap_or_else(|| DesktopSettings {
            schema: SETTINGS_SCHEMA.into(),
            library_root: library_root.to_path_buf(),
            provider: None,
        });
        settings.library_root = library_root.to_path_buf();
        settings.provider = Some(provider);
        self.write(&settings)
    }

    fn load(&self) -> Result<Option<PathBuf>, String> {
        Ok(self.load_settings()?.map(|settings| settings.library_root))
    }

    fn load_settings(&self) -> Result<Option<DesktopSettings>, String> {
        let body = match fs::read(&self.path) {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "failed to read desktop settings ({}): {error}",
                    self.path.display()
                ))
            }
        };
        let settings: DesktopSettings = serde_json::from_slice(&body).map_err(|error| {
            format!(
                "desktop settings are invalid ({}): {error}",
                self.path.display()
            )
        })?;
        if settings.schema != SETTINGS_SCHEMA || !settings.library_root.is_absolute() {
            return Err(format!(
                "desktop settings have an unsupported schema or relative library path ({})",
                self.path.display()
            ));
        }
        Ok(Some(settings))
    }

    fn write(&self, settings: &DesktopSettings) -> Result<(), String> {
        let Some(parent) = self.path.parent() else {
            return Err("desktop settings path has no parent directory".into());
        };
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create desktop settings directory ({}): {error}",
                parent.display()
            )
        })?;
        let body = serde_json::to_vec_pretty(settings)
            .map_err(|error| format!("failed to serialize desktop settings: {error}"))?;
        let temporary = self
            .path
            .with_extension(format!("json.tmp-{}", std::process::id()));
        fs::write(&temporary, body).map_err(|error| {
            format!(
                "failed to write desktop settings temporary file ({}): {error}",
                temporary.display()
            )
        })?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "failed to replace desktop settings ({}): {error}",
                self.path.display()
            ));
        }
        Ok(())
    }
}

pub fn resolve_library_root(selected: &Path) -> Result<PathBuf, String> {
    if !selected.is_absolute() {
        return Err("library directory must be an absolute path".into());
    }
    if !selected.is_dir() {
        return Err(format!(
            "selected library parent is not an available directory ({})",
            selected.display()
        ));
    }
    let is_library_root = selected
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(".understand-book"));
    Ok(if is_library_root {
        selected.to_path_buf()
    } else {
        selected.join(".understand-book")
    })
}

fn ensure_library_root(root: &Path) -> Result<(), String> {
    if root.exists() && !root.is_dir() {
        return Err(format!(
            "library root exists but is not a directory ({})",
            root.display()
        ));
    }
    fs::create_dir_all(root).map_err(|error| {
        format!(
            "failed to create library root ({}): {error}",
            root.display()
        )
    })?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let probe = root.join(format!(".write-test-{}-{nonce}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("library root is not writable ({}): {error}", root.display()))?;
    if let Err(error) = file.write_all(b"understand-book") {
        let _ = fs::remove_file(&probe);
        return Err(format!(
            "library root is not writable ({}): {error}",
            root.display()
        ));
    }
    drop(file);
    fs::remove_file(&probe).map_err(|error| {
        format!(
            "failed to clean up library write probe ({}): {error}",
            probe.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "understand-book-library-settings-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parent_selection_appends_library_directory() {
        let parent = temp_dir("parent");
        assert_eq!(
            resolve_library_root(&parent).unwrap(),
            parent.join(".understand-book")
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn existing_library_root_is_used_directly() {
        let parent = temp_dir("existing");
        let root = parent.join(".understand-book");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("marker"), "keep").unwrap();

        assert_eq!(resolve_library_root(&root).unwrap(), root);
        assert_eq!(fs::read_to_string(root.join("marker")).unwrap(), "keep");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn apply_selection_creates_root_and_round_trips_settings() {
        let parent = temp_dir("round-trip");
        let store = LibrarySettingsStore::new(parent.join("config/settings.json"));

        let root = store.apply_selection(&parent).unwrap();

        assert!(root.is_dir());
        assert_eq!(store.load().unwrap(), Some(root));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn invalid_selection_keeps_previous_settings() {
        let parent = temp_dir("rollback");
        let store = LibrarySettingsStore::new(parent.join("config/settings.json"));
        let original = store.apply_selection(&parent).unwrap();
        let file = parent.join("not-a-directory");
        fs::write(&file, "x").unwrap();

        assert!(store.apply_selection(&file).is_err());
        assert_eq!(store.load().unwrap(), Some(original));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn unavailable_saved_root_is_not_recreated_or_replaced() {
        let parent = temp_dir("unavailable");
        let store = LibrarySettingsStore::new(parent.join("config/settings.json"));
        let selected = parent.join("selected");
        fs::create_dir_all(&selected).unwrap();
        let root = store.apply_selection(&selected).unwrap();
        fs::remove_dir_all(&selected).unwrap();

        assert_eq!(store.initial_root(&parent).unwrap(), root);
        assert!(!root.exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn provider_round_trip_preserves_library_and_key_is_explicitly_stored() {
        let parent = temp_dir("provider");
        let store = LibrarySettingsStore::new(parent.join("config/settings.json"));
        let root = store.apply_selection(&parent).unwrap();
        let provider = PersistedProviderSettings {
            mode: "native".into(),
            api_key: "plain-text-key".into(),
            base_url: "https://provider.example/v1".into(),
            model: "model-a".into(),
        };

        store.apply_provider(&root, provider.clone()).unwrap();

        assert_eq!(store.load().unwrap(), Some(root));
        assert_eq!(store.provider_settings().unwrap(), Some(provider));
        assert!(fs::read_to_string(parent.join("config/settings.json"))
            .unwrap()
            .contains("plain-text-key"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn changing_library_preserves_provider_settings() {
        let parent = temp_dir("provider-library-change");
        let other = temp_dir("provider-library-change-other");
        let store = LibrarySettingsStore::new(parent.join("config/settings.json"));
        let first_root = store.apply_selection(&parent).unwrap();
        let provider = PersistedProviderSettings {
            mode: "react".into(),
            api_key: "key".into(),
            base_url: "https://provider.example/v1".into(),
            model: "model-b".into(),
        };
        store.apply_provider(&first_root, provider.clone()).unwrap();

        let second_root = store.apply_selection(&other).unwrap();

        assert_eq!(store.load().unwrap(), Some(second_root));
        assert_eq!(store.provider_settings().unwrap(), Some(provider));
        fs::remove_dir_all(parent).unwrap();
        fs::remove_dir_all(other).unwrap();
    }
}
