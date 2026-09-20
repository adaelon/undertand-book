use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservabilityMode {
    Off,
    Metadata,
}

impl ObservabilityMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Metadata => "metadata",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoolTargetChange {
    Isolate,
    Drop,
    Replay,
}

#[derive(Clone)]
pub struct SpoolConfig {
    pub directory: PathBuf,
    pub max_bytes: u64,
    pub max_files: usize,
    pub retention: Duration,
    pub target_change: SpoolTargetChange,
}

impl SpoolConfig {
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        Self::from_getter(|key| std::env::var(key).ok())
    }

    pub fn directory_from_env() -> Option<PathBuf> {
        std::env::var("UB_OBSERVABILITY_SPOOL_DIR")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    pub(crate) fn from_getter(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Option<Self>, ConfigError> {
        let Some(directory) = get("UB_OBSERVABILITY_SPOOL_DIR")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        let max_bytes = parse_positive(
            "UB_OBSERVABILITY_SPOOL_MAX_BYTES",
            get("UB_OBSERVABILITY_SPOOL_MAX_BYTES"),
            64 * 1024 * 1024_u64,
        )?;
        let max_files = parse_positive(
            "UB_OBSERVABILITY_SPOOL_MAX_FILES",
            get("UB_OBSERVABILITY_SPOOL_MAX_FILES"),
            4_096_usize,
        )?;
        let retention_hours = parse_positive(
            "UB_OBSERVABILITY_SPOOL_RETENTION_HOURS",
            get("UB_OBSERVABILITY_SPOOL_RETENTION_HOURS"),
            24_u64,
        )?;
        let target_change = match get("UB_OBSERVABILITY_SPOOL_TARGET_CHANGE")
            .unwrap_or_else(|| "isolate".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "isolate" => SpoolTargetChange::Isolate,
            "drop" => SpoolTargetChange::Drop,
            "replay" => SpoolTargetChange::Replay,
            value => {
                return Err(ConfigError {
                    code: "OBSERVABILITY_CONFIG_INVALID",
                    message: format!(
                        "unknown UB_OBSERVABILITY_SPOOL_TARGET_CHANGE={value}; expected isolate, drop or replay"
                    ),
                })
            }
        };
        Ok(Some(Self {
            directory: PathBuf::from(directory),
            max_bytes,
            max_files,
            retention: Duration::from_secs(retention_hours.saturating_mul(60 * 60)),
            target_change,
        }))
    }
}

fn parse_positive<T>(key: &'static str, value: Option<String>, default: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr + PartialOrd + From<u8> + Copy,
{
    let Some(value) = value else {
        return Ok(default);
    };
    let parsed = value.trim().parse::<T>().map_err(|_| ConfigError {
        code: "OBSERVABILITY_CONFIG_INVALID",
        message: format!("{key} must be a positive integer"),
    })?;
    if parsed <= T::from(0) {
        return Err(ConfigError {
            code: "OBSERVABILITY_CONFIG_INVALID",
            message: format!("{key} must be a positive integer"),
        });
    }
    Ok(parsed)
}

#[derive(Clone)]
pub struct ObservabilityConfig {
    pub mode: ObservabilityMode,
    pub api_key: String,
    pub endpoint: url::Url,
    pub project: String,
    pub workspace_id: Option<String>,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub queue_items: usize,
    pub queue_bytes: usize,
    pub max_item_bytes: usize,
    pub max_trace_spans: usize,
    pub spool: Option<SpoolConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub code: &'static str,
    pub message: String,
}

impl ObservabilityConfig {
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        Self::from_getter(|key| std::env::var(key).ok(), false)
    }

    pub(crate) fn from_getter(
        mut get: impl FnMut(&str) -> Option<String>,
        allow_http: bool,
    ) -> Result<Option<Self>, ConfigError> {
        let mode = match get("UB_OBSERVABILITY_MODE")
            .unwrap_or_else(|| "off".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "off" => return Ok(None),
            "metadata" => ObservabilityMode::Metadata,
            value => {
                return Err(ConfigError {
                    code: "OBSERVABILITY_CONFIG_INVALID",
                    message: format!(
                        "unknown UB_OBSERVABILITY_MODE={value}; expected off or metadata"
                    ),
                })
            }
        };
        let spool = SpoolConfig::from_getter(|key| get(key))?;
        let required = |key: &'static str,
                        get: &mut dyn FnMut(&str) -> Option<String>|
         -> Result<String, ConfigError> {
            get(key)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ConfigError {
                    code: "OBSERVABILITY_CONFIG_MISSING",
                    message: format!("{key} is required when observability is enabled"),
                })
        };
        let api_key = required("LANGSMITH_API_KEY", &mut get)?;
        let project = required("LANGSMITH_PROJECT", &mut get)?;
        let endpoint_text =
            get("LANGSMITH_ENDPOINT").unwrap_or_else(|| "https://api.smith.langchain.com".into());
        let endpoint = url::Url::parse(endpoint_text.trim()).map_err(|error| ConfigError {
            code: "OBSERVABILITY_CONFIG_INVALID",
            message: format!("LANGSMITH_ENDPOINT is invalid: {error}"),
        })?;
        if endpoint.host_str().is_none()
            || (!allow_http && endpoint.scheme() != "https")
            || (allow_http && !matches!(endpoint.scheme(), "http" | "https"))
        {
            return Err(ConfigError {
                code: "OBSERVABILITY_CONFIG_INVALID",
                message: "LANGSMITH_ENDPOINT must be an HTTPS origin".into(),
            });
        }
        Ok(Some(Self {
            mode,
            api_key,
            endpoint,
            project,
            workspace_id: get("LANGSMITH_WORKSPACE_ID")
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            request_timeout: Duration::from_secs(2),
            shutdown_timeout: Duration::from_secs(2),
            queue_items: 1_024,
            queue_bytes: 4 * 1024 * 1024,
            max_item_bytes: 64 * 1024,
            max_trace_spans: 512,
            spool,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn off_ignores_global_langsmith_environment() {
        let values = HashMap::from([
            ("LANGSMITH_API_KEY", "should-not-enable"),
            ("LANGSMITH_TRACING", "true"),
            ("UB_OBSERVABILITY_SPOOL_DIR", "C:/safe/ub-observation-spool"),
            ("UB_OBSERVABILITY_SPOOL_MAX_BYTES", "invalid-while-off"),
        ]);
        let config = ObservabilityConfig::from_getter(
            |key| values.get(key).map(|value| (*value).to_owned()),
            false,
        )
        .unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn optional_spool_has_bounded_defaults_and_explicit_target_change() {
        let values = HashMap::from([
            ("UB_OBSERVABILITY_SPOOL_DIR", "C:/safe/ub-observation-spool"),
            ("UB_OBSERVABILITY_SPOOL_TARGET_CHANGE", "replay"),
        ]);
        let spool =
            SpoolConfig::from_getter(|key| values.get(key).map(|value| (*value).to_owned()))
                .unwrap()
                .unwrap();
        assert_eq!(spool.max_bytes, 64 * 1024 * 1024);
        assert_eq!(spool.max_files, 4_096);
        assert_eq!(spool.retention, Duration::from_secs(24 * 60 * 60));
        assert_eq!(spool.target_change, SpoolTargetChange::Replay);
    }

    #[test]
    fn metadata_requires_project_key_and_https() {
        let values = HashMap::from([
            ("UB_OBSERVABILITY_MODE", "metadata"),
            ("LANGSMITH_API_KEY", "secret"),
            ("LANGSMITH_PROJECT", "reader-dev"),
            ("LANGSMITH_ENDPOINT", "https://smith.example.test"),
        ]);
        let config = ObservabilityConfig::from_getter(
            |key| values.get(key).map(|value| (*value).to_owned()),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.mode, ObservabilityMode::Metadata);
        assert_eq!(config.project, "reader-dev");
    }
}
