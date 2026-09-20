use super::config::{ObservabilityConfig, SpoolConfig, SpoolTargetChange};
use super::mapping::export_item;
use super::queue::{ExportItem, ExportOperation};
use runtime::observation::{
    DeliveryState, ExecutionState, ObservationEnvelope, PersistenceState, TimingSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SPOOL_SCHEMA_VERSION: &str = "ub_observation_spool.v1";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetDescriptor {
    endpoint: String,
    project: String,
    workspace_id: Option<String>,
}

impl TargetDescriptor {
    fn from_config(config: &ObservabilityConfig) -> Self {
        Self {
            endpoint: config.endpoint.as_str().trim_end_matches('/').to_owned(),
            project: config.project.clone(),
            workspace_id: config.workspace_id.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpoolManifest {
    schema_version: String,
    config_epoch: String,
    target: TargetDescriptor,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedItem {
    schema_version: String,
    config_epoch: String,
    target: TargetDescriptor,
    persisted_at_unix_ms: u128,
    item: PersistedExportItem,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedExportItem {
    root_run_id: String,
    run_id: String,
    parent_run_id: Option<String>,
    revision: u32,
    operation: PersistedOperation,
    payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedOperation {
    Create,
    Update,
}

impl PersistedExportItem {
    fn from_export(item: &ExportItem) -> Self {
        Self {
            root_run_id: item.root_run_id.clone(),
            run_id: item.run_id.clone(),
            parent_run_id: item.parent_run_id.clone(),
            revision: item.revision,
            operation: match item.operation {
                ExportOperation::Create => PersistedOperation::Create,
                ExportOperation::Update => PersistedOperation::Update,
            },
            payload: item.payload.clone(),
        }
    }

    fn into_export(self) -> ExportItem {
        ExportItem::new(
            self.root_run_id,
            self.run_id,
            self.parent_run_id,
            self.revision,
            match self.operation {
                PersistedOperation::Create => ExportOperation::Create,
                PersistedOperation::Update => ExportOperation::Update,
            },
            self.payload,
        )
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SpoolOpenStats {
    pub recovered: u64,
    pub quarantined: u64,
    pub isolated: u64,
    pub dropped: u64,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SpoolStatus {
    pub pending: usize,
    pub bytes: u64,
}

pub struct SpoolOpen {
    pub spool: Spool,
    pub recovered: Vec<ExportItem>,
    pub stats: SpoolOpenStats,
}

pub struct Spool {
    config: SpoolConfig,
    target: TargetDescriptor,
    config_epoch: String,
}

impl Spool {
    pub fn open(config: &ObservabilityConfig) -> Result<SpoolOpen, String> {
        let spool_config = config
            .spool
            .clone()
            .ok_or_else(|| "spool is not configured".to_owned())?;
        fs::create_dir_all(&spool_config.directory)
            .map_err(|error| format!("create spool directory: {error}"))?;
        let target = TargetDescriptor::from_config(config);
        let manifest_path = spool_config.directory.join(MANIFEST_FILE);
        let mut stats = SpoolOpenStats::default();
        let config_epoch = match read_json::<SpoolManifest>(&manifest_path) {
            Ok(Some(manifest))
                if manifest.schema_version == SPOOL_SCHEMA_VERSION && manifest.target == target =>
            {
                manifest.config_epoch
            }
            Ok(Some(manifest)) if manifest.schema_version == SPOOL_SCHEMA_VERSION => {
                let epoch = uuid::Uuid::now_v7().to_string();
                stats.isolated += handle_target_change(
                    &spool_config,
                    &manifest,
                    &target,
                    &epoch,
                    &mut stats.dropped,
                )?;
                write_manifest(&manifest_path, &epoch, &target)?;
                epoch
            }
            Ok(Some(_)) | Err(_) => {
                if manifest_path.exists() {
                    quarantine(&spool_config.directory, &manifest_path)?;
                    stats.quarantined += 1;
                }
                let epoch = uuid::Uuid::now_v7().to_string();
                write_manifest(&manifest_path, &epoch, &target)?;
                epoch
            }
            Ok(None) => {
                let epoch = uuid::Uuid::now_v7().to_string();
                write_manifest(&manifest_path, &epoch, &target)?;
                epoch
            }
        };
        let mut spool = Self {
            config: spool_config,
            target,
            config_epoch,
        };
        stats.dropped += spool.prune_expired()?;
        let mut persisted = spool.read_active(&mut stats)?;
        stats.dropped += spool.prune_inactive(0, 0)?;
        persisted.sort_by(|left, right| {
            persisted_observation_time(left)
                .cmp(&persisted_observation_time(right))
                .then_with(|| recovery_phase(&left.item).cmp(&recovery_phase(&right.item)))
                .then_with(|| left.persisted_at_unix_ms.cmp(&right.persisted_at_unix_ms))
                .then_with(|| left.item.run_id.cmp(&right.item.run_id))
                .then_with(|| left.item.revision.cmp(&right.item.revision))
        });
        let mut recovered = persisted
            .into_iter()
            .map(|record| record.item.into_export())
            .collect::<Vec<_>>();
        for item in synthesize_interrupted_updates(&recovered, &config.project) {
            match spool.persist(&item) {
                Ok(pruned) => {
                    stats.dropped += pruned;
                    recovered.push(item);
                }
                Err(_) => stats.dropped += 1,
            }
        }
        stats.recovered = recovered.len().min(u64::MAX as usize) as u64;
        Ok(SpoolOpen {
            spool,
            recovered,
            stats,
        })
    }

    pub fn clear_directory(directory: &Path) -> Result<u64, String> {
        if !directory.exists() {
            return Ok(0);
        }
        let mut removed = 0_u64;
        for entry in
            fs::read_dir(directory).map_err(|error| format!("read spool directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read spool entry: {error}"))?;
            let path = entry.path();
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let owned_file = path.is_file()
                && (file_name == MANIFEST_FILE
                    || path.extension().and_then(|value| value.to_str()) == Some("json")
                    || file_name.contains(".tmp-"));
            if owned_file {
                fs::remove_file(&path)
                    .map_err(|error| format!("remove spool file {}: {error}", path.display()))?;
                removed += 1;
            } else if path.is_dir()
                && matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("quarantine" | "stale")
                )
            {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!("remove spool directory {}: {error}", path.display())
                })?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn persist(&mut self, item: &ExportItem) -> Result<u64, String> {
        let final_path = self.config.directory.join(record_file_name(item));
        if final_path.exists() {
            return Ok(0);
        }
        let record = PersistedItem {
            schema_version: SPOOL_SCHEMA_VERSION.into(),
            config_epoch: self.config_epoch.clone(),
            target: self.target.clone(),
            persisted_at_unix_ms: unix_ms(SystemTime::now()),
            item: PersistedExportItem::from_export(item),
        };
        let bytes = serde_json::to_vec(&record)
            .map_err(|error| format!("serialize spool record: {error}"))?;
        let dropped = self.make_room(bytes.len() as u64, &item.root_run_id)?;
        atomic_write(&final_path, &bytes)?;
        Ok(dropped)
    }

    pub fn remove_trace(&mut self, root_run_id: &str) -> Result<(), String> {
        for path in record_paths(&self.config.directory)? {
            let matches = read_json::<PersistedItem>(&path)
                .ok()
                .flatten()
                .is_some_and(|record| record.item.root_run_id == root_run_id);
            if matches {
                fs::remove_file(&path)
                    .map_err(|error| format!("remove spool trace file: {error}"))?;
            }
        }
        Ok(())
    }

    pub fn status(&self) -> SpoolStatus {
        let mut status = SpoolStatus::default();
        if let Ok(paths) = record_paths(&self.config.directory) {
            status.pending = paths.len();
            status.bytes = paths
                .iter()
                .filter_map(|path| fs::metadata(path).ok().map(|value| value.len()))
                .sum();
        }
        status
    }

    fn read_active(&self, stats: &mut SpoolOpenStats) -> Result<Vec<PersistedItem>, String> {
        let mut records = Vec::new();
        for path in record_paths(&self.config.directory)? {
            match read_json::<PersistedItem>(&path) {
                Ok(Some(record))
                    if record.schema_version == SPOOL_SCHEMA_VERSION
                        && record.config_epoch == self.config_epoch
                        && record.target == self.target =>
                {
                    records.push(record)
                }
                _ => {
                    quarantine(&self.config.directory, &path)?;
                    stats.quarantined += 1;
                }
            }
        }
        Ok(records)
    }

    fn prune_expired(&mut self) -> Result<u64, String> {
        let cutoff = unix_ms(SystemTime::now()).saturating_sub(self.config.retention.as_millis());
        let mut expired_roots = HashSet::new();
        for path in record_paths(&self.config.directory)? {
            if let Ok(Some(record)) = read_json::<PersistedItem>(&path) {
                if record.persisted_at_unix_ms < cutoff {
                    expired_roots.insert(record.item.root_run_id);
                }
            }
        }
        for root in &expired_roots {
            self.remove_trace(root)?;
        }
        Ok(expired_roots.len().min(u64::MAX as usize) as u64)
    }

    fn make_room(&mut self, incoming_bytes: u64, protected_root: &str) -> Result<u64, String> {
        if incoming_bytes > self.config.max_bytes {
            return Err("spool record exceeds configured byte capacity".into());
        }
        let mut dropped = self.prune_expired()?;
        dropped = dropped.saturating_add(self.prune_inactive(incoming_bytes, 1)?);
        let inactive = inactive_totals(&self.config.directory)?;
        let mut entries = trace_entries(&self.config.directory)?;
        let mut current_totals = totals(&entries);
        while current_totals
            .0
            .saturating_add(inactive.0)
            .saturating_add(1)
            > self.config.max_files
            || current_totals
                .1
                .saturating_add(inactive.1)
                .saturating_add(incoming_bytes)
                > self.config.max_bytes
        {
            let Some(oldest_root) = entries
                .iter()
                .filter(|(root, _)| root.as_str() != protected_root)
                .min_by_key(|(_, values)| values.iter().map(|entry| entry.persisted_at).min())
                .map(|(root, _)| root.clone())
            else {
                break;
            };
            self.remove_trace(&oldest_root)?;
            entries.remove(&oldest_root);
            current_totals = totals(&entries);
            dropped += 1;
        }
        if current_totals
            .0
            .saturating_add(inactive.0)
            .saturating_add(1)
            > self.config.max_files
            || current_totals
                .1
                .saturating_add(inactive.1)
                .saturating_add(incoming_bytes)
                > self.config.max_bytes
        {
            return Err("spool capacity cannot admit another record for the active trace".into());
        }
        Ok(dropped)
    }

    fn prune_inactive(&self, reserve_bytes: u64, reserve_files: usize) -> Result<u64, String> {
        let cutoff = unix_ms(SystemTime::now()).saturating_sub(self.config.retention.as_millis());
        let active = self.status();
        let mut inactive = inactive_entries(&self.config.directory)?;
        let mut dropped = 0_u64;
        for entry in inactive.iter().filter(|entry| entry.persisted_at < cutoff) {
            fs::remove_file(&entry.path)
                .map_err(|error| format!("remove expired inactive spool record: {error}"))?;
            dropped += 1;
        }
        inactive.retain(|entry| entry.path.exists());
        inactive.sort_by_key(|entry| entry.persisted_at);
        let mut inactive_files = inactive.len();
        let mut inactive_bytes = inactive
            .iter()
            .fold(0_u64, |sum, entry| sum.saturating_add(entry.bytes));
        for entry in inactive {
            let over_files = active
                .pending
                .saturating_add(inactive_files)
                .saturating_add(reserve_files)
                > self.config.max_files;
            let over_bytes = active
                .bytes
                .saturating_add(inactive_bytes)
                .saturating_add(reserve_bytes)
                > self.config.max_bytes;
            if !over_files && !over_bytes {
                break;
            }
            fs::remove_file(&entry.path)
                .map_err(|error| format!("remove bounded inactive spool record: {error}"))?;
            inactive_files = inactive_files.saturating_sub(1);
            inactive_bytes = inactive_bytes.saturating_sub(entry.bytes);
            dropped += 1;
        }
        Ok(dropped)
    }
}

#[derive(Clone)]
struct TraceEntry {
    bytes: u64,
    persisted_at: u128,
}

struct InactiveEntry {
    path: PathBuf,
    bytes: u64,
    persisted_at: u128,
}

fn inactive_entries(directory: &Path) -> Result<Vec<InactiveEntry>, String> {
    let mut entries = Vec::new();
    for name in ["stale", "quarantine"] {
        let root = directory.join(name);
        if !root.exists() {
            continue;
        }
        let mut pending = vec![root];
        while let Some(current) = pending.pop() {
            for entry in fs::read_dir(&current)
                .map_err(|error| format!("read inactive spool directory: {error}"))?
            {
                let path = entry
                    .map_err(|error| format!("read inactive spool entry: {error}"))?
                    .path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !path.is_file() {
                    continue;
                }
                let metadata = fs::metadata(&path)
                    .map_err(|error| format!("read inactive spool metadata: {error}"))?;
                let persisted_at = read_json::<PersistedItem>(&path)
                    .ok()
                    .flatten()
                    .map(|record| record.persisted_at_unix_ms)
                    .or_else(|| metadata.modified().ok().map(unix_ms))
                    .unwrap_or(0);
                entries.push(InactiveEntry {
                    path,
                    bytes: metadata.len(),
                    persisted_at,
                });
            }
        }
    }
    Ok(entries)
}

fn inactive_totals(directory: &Path) -> Result<(usize, u64), String> {
    let entries = inactive_entries(directory)?;
    Ok((
        entries.len(),
        entries
            .iter()
            .fold(0_u64, |sum, entry| sum.saturating_add(entry.bytes)),
    ))
}

fn trace_entries(directory: &Path) -> Result<HashMap<String, Vec<TraceEntry>>, String> {
    let mut entries: HashMap<String, Vec<TraceEntry>> = HashMap::new();
    for path in record_paths(directory)? {
        if let Ok(Some(record)) = read_json::<PersistedItem>(&path) {
            entries
                .entry(record.item.root_run_id)
                .or_default()
                .push(TraceEntry {
                    bytes: fs::metadata(&path).map(|value| value.len()).unwrap_or(0),
                    persisted_at: record.persisted_at_unix_ms,
                });
        }
    }
    Ok(entries)
}

fn totals(entries: &HashMap<String, Vec<TraceEntry>>) -> (usize, u64) {
    entries.values().flatten().fold((0, 0), |total, entry| {
        (total.0 + 1, total.1.saturating_add(entry.bytes))
    })
}

fn handle_target_change(
    config: &SpoolConfig,
    previous: &SpoolManifest,
    target: &TargetDescriptor,
    epoch: &str,
    dropped: &mut u64,
) -> Result<u64, String> {
    let paths = record_paths(&config.directory)?;
    match config.target_change {
        SpoolTargetChange::Isolate => {
            let stale = config.directory.join("stale").join(&previous.config_epoch);
            fs::create_dir_all(&stale)
                .map_err(|error| format!("create stale spool directory: {error}"))?;
            for path in &paths {
                let destination = stale.join(path.file_name().unwrap_or_default());
                fs::rename(path, destination)
                    .map_err(|error| format!("isolate old spool record: {error}"))?;
            }
            Ok(paths.len().min(u64::MAX as usize) as u64)
        }
        SpoolTargetChange::Drop => {
            for path in &paths {
                fs::remove_file(path).map_err(|error| format!("drop old spool record: {error}"))?;
            }
            *dropped += paths.len().min(u64::MAX as usize) as u64;
            Ok(0)
        }
        SpoolTargetChange::Replay => {
            for path in paths {
                let mut record = read_json::<PersistedItem>(&path)?
                    .ok_or_else(|| "old spool record disappeared".to_owned())?;
                record.config_epoch = epoch.to_owned();
                record.target = target.clone();
                if record.item.operation_is_create() {
                    record.item.payload["session_name"] = Value::String(target.project.clone());
                }
                let bytes = serde_json::to_vec(&record)
                    .map_err(|error| format!("serialize replay spool record: {error}"))?;
                atomic_write_replace(&path, &bytes)?;
            }
            Ok(0)
        }
    }
}

impl PersistedExportItem {
    fn operation_is_create(&self) -> bool {
        matches!(self.operation, PersistedOperation::Create)
    }
}

fn synthesize_interrupted_updates(items: &[ExportItem], project: &str) -> Vec<ExportItem> {
    let roots = items
        .iter()
        .filter(|item| {
            item.operation == ExportOperation::Create
                && item.run_id == item.root_run_id
                && item.parent_run_id.is_none()
        })
        .collect::<Vec<_>>();
    let mut updates = Vec::new();
    for root in roots {
        let has_terminal = items.iter().any(|item| {
            item.root_run_id == root.root_run_id
                && item.run_id == root.root_run_id
                && item.operation == ExportOperation::Update
        });
        if has_terminal {
            continue;
        }
        let latest_observation = items
            .iter()
            .filter(|item| item.root_run_id == root.root_run_id)
            .filter_map(observation_from_item)
            .max_by(|left, right| {
                left.observed_at
                    .as_deref()
                    .unwrap_or_default()
                    .cmp(right.observed_at.as_deref().unwrap_or_default())
            });
        let Some(mut observation) = observation_from_item(root) else {
            continue;
        };
        observation.revision = items
            .iter()
            .filter(|item| item.run_id == root.run_id)
            .map(|item| item.revision)
            .max()
            .unwrap_or(1)
            .saturating_add(1);
        observation.observed_at = latest_observation
            .as_ref()
            .and_then(|value| value.observed_at.clone())
            .or_else(|| observation.observed_at.clone());
        observation.elapsed_ms = None;
        observation.duration_ms = None;
        observation.timing_source = TimingSource::LastObserved;
        observation.execution_state = Some(ExecutionState::Interrupted);
        observation.delivery_state = Some(DeliveryState::Unknown);
        observation.persistence_state = Some(PersistenceState::Unknown);
        observation.metadata.error_code = Some("OBSERVATION_INTERRUPTED".into());
        observation.metadata.interruption_detected_at = Some(format_system_time(SystemTime::now()));
        observation.completeness.reconstructed = true;
        updates.push(export_item(observation, ExportOperation::Update, project));
    }
    updates
}

fn observation_from_item(item: &ExportItem) -> Option<ObservationEnvelope> {
    serde_json::from_value(
        item.payload
            .get("extra")?
            .get("metadata")?
            .get("ub_observation")?
            .clone(),
    )
    .ok()
}

fn persisted_observation_time(item: &PersistedItem) -> i128 {
    let observed_at = match item.item.operation {
        PersistedOperation::Create => item.item.payload.get("start_time"),
        PersistedOperation::Update => item.item.payload.get("end_time"),
    };
    observed_at
        .and_then(Value::as_str)
        .and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(time::OffsetDateTime::unix_timestamp_nanos)
        .unwrap_or_else(|| {
            i128::try_from(item.persisted_at_unix_ms)
                .unwrap_or(i128::MAX)
                .saturating_mul(1_000_000)
        })
}

fn recovery_phase(item: &PersistedExportItem) -> u8 {
    if item.run_id != item.root_run_id {
        return 1;
    }
    match item.operation {
        PersistedOperation::Create => 0,
        PersistedOperation::Update => 2,
    }
}

fn record_file_name(item: &ExportItem) -> String {
    let operation = match item.operation {
        ExportOperation::Create => "create",
        ExportOperation::Update => "update",
    };
    format!("{}-{:010}-{operation}.json", item.run_id, item.revision)
}

fn record_paths(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("read spool directory: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.file_name().and_then(|name| name.to_str()) != Some(MANIFEST_FILE)
                && path.extension().and_then(|value| value.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn write_manifest(path: &Path, epoch: &str, target: &TargetDescriptor) -> Result<(), String> {
    let manifest = SpoolManifest {
        schema_version: SPOOL_SCHEMA_VERSION.into(),
        config_epoch: epoch.into(),
        target: target.clone(),
    };
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("serialize spool manifest: {error}"))?;
    atomic_write_replace(path, &bytes)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::now_v7()));
    write_synced(&temporary, bytes)?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) => Err(format!("commit spool record: {error}")),
    }
}

fn atomic_write_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::now_v7()));
    write_synced(&temporary, bytes)?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            fs::remove_file(path).map_err(|error| format!("replace spool file: {error}"))?;
            fs::rename(temporary, path).map_err(|error| format!("commit spool file: {error}"))
        }
        Err(error) => Err(format!("commit spool file: {error}")),
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|error| format!("create spool temporary file: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("write spool temporary file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync spool temporary file: {error}"))
}

fn quarantine(directory: &Path, path: &Path) -> Result<(), String> {
    let quarantine = directory.join("quarantine");
    fs::create_dir_all(&quarantine).map_err(|error| format!("create spool quarantine: {error}"))?;
    let destination = quarantine.join(format!(
        "{}-{}",
        uuid::Uuid::now_v7(),
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("invalid.json")
    ));
    fs::rename(path, destination).map_err(|error| format!("quarantine spool file: {error}"))
}

fn unix_ms(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}

fn format_system_time(value: SystemTime) -> String {
    time::OffsetDateTime::from(value)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::config::ObservabilityMode;
    use tempfile::TempDir;

    fn config(directory: &Path) -> ObservabilityConfig {
        ObservabilityConfig {
            mode: ObservabilityMode::Metadata,
            api_key: "never-persist-this-key".into(),
            endpoint: url::Url::parse("https://smith.example.test").unwrap(),
            project: "project-a".into(),
            workspace_id: Some("workspace-a".into()),
            request_timeout: Duration::from_millis(50),
            shutdown_timeout: Duration::from_millis(50),
            queue_items: 32,
            queue_bytes: 128 * 1024,
            max_item_bytes: 64 * 1024,
            max_trace_spans: 8,
            spool: Some(SpoolConfig {
                directory: directory.to_path_buf(),
                max_bytes: 128 * 1024,
                max_files: 32,
                retention: Duration::from_secs(60),
                target_change: SpoolTargetChange::Isolate,
            }),
        }
    }

    fn root_create() -> ExportItem {
        let identity = crate::observability::lifecycle::RunIdentity::new(
            "opaque-thread".into(),
            "opaque-book".into(),
        );
        export_item(
            crate::observability::lifecycle::root_started(&identity),
            ExportOperation::Create,
            "project-a",
        )
    }

    #[test]
    fn restart_recovers_records_and_closes_open_root_as_interrupted() {
        let temp = TempDir::new().unwrap();
        let config = config(temp.path());
        let mut opened = Spool::open(&config).unwrap();
        opened.spool.persist(&root_create()).unwrap();
        drop(opened);

        let recovered = Spool::open(&config).unwrap();
        assert_eq!(recovered.recovered.len(), 2);
        let update = recovered
            .recovered
            .iter()
            .find(|item| item.operation == ExportOperation::Update)
            .unwrap();
        assert_eq!(
            update.payload["extra"]["metadata"]["ub_observation"]["execution_state"],
            "interrupted"
        );
        assert_eq!(
            update.payload["extra"]["metadata"]["ub_observation"]["timing_source"],
            "last_observed"
        );
        assert_ne!(
            update.payload["extra"]["metadata"]["ub_observation"]["metadata"]
                ["interruption_detected_at"],
            Value::Null
        );
        let disk = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .map(|entry| fs::read_to_string(entry.path()).unwrap())
            .collect::<String>();
        assert!(!disk.contains("never-persist-this-key"));
    }

    #[test]
    fn recovery_orders_children_before_root_terminal_when_persist_times_collide() {
        let temp = TempDir::new().unwrap();
        let config = config(temp.path());
        let identity = crate::observability::lifecycle::RunIdentity::new(
            "opaque-thread".into(),
            "opaque-book".into(),
        );
        let root = export_item(
            crate::observability::lifecycle::root_started(&identity),
            ExportOperation::Create,
            "project-a",
        );
        let mut mapper = crate::observability::mapping::ActivityMapper::new(8);
        let child = mapper
            .map(
                &identity,
                runtime::run_events::RuntimeEvent {
                    elapsed_ms: 1.0,
                    activity: runtime::run_events::RunActivity {
                        step_id: 1,
                        parent_step_id: None,
                        kind: "model".into(),
                        name: "outer".into(),
                        label: "answer".into(),
                        status: runtime::run_events::ActivityStatus::Running,
                        started_ms: Some(1.0),
                        duration_ms: None,
                        result_count: None,
                        error_code: None,
                        usage_total_tokens: None,
                        usage: None,
                        model_first_text_ms: None,
                        model_name: Some("configured-model".into()),
                        model_name_source: Some("configured".into()),
                        accepted_evidence_count: None,
                        evidence_refs: Vec::new(),
                    },
                },
            )
            .map(|(observation, operation)| export_item(observation, operation, "project-a"))
            .unwrap();
        std::thread::sleep(Duration::from_millis(2));
        let terminal = export_item(
            crate::observability::lifecycle::root_finished(
                &identity,
                ExecutionState::Completed,
                DeliveryState::Delivered,
                PersistenceState::Saved,
                false,
                None,
                0,
                None,
            ),
            ExportOperation::Update,
            "project-a",
        );
        let mut opened = Spool::open(&config).unwrap();
        opened.spool.persist(&root).unwrap();
        opened.spool.persist(&child).unwrap();
        opened.spool.persist(&terminal).unwrap();
        drop(opened);

        let same_persisted_at = unix_ms(SystemTime::now());
        for path in record_paths(temp.path()).unwrap() {
            let mut record = read_json::<PersistedItem>(&path).unwrap().unwrap();
            record.persisted_at_unix_ms = same_persisted_at;
            atomic_write_replace(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
        }

        let recovered = Spool::open(&config).unwrap().recovered;
        assert_eq!(recovered.len(), 3);
        assert_eq!(recovered[0].operation, ExportOperation::Create);
        assert_eq!(recovered[0].run_id, recovered[0].root_run_id);
        assert_ne!(recovered[1].run_id, recovered[1].root_run_id);
        assert_eq!(recovered[2].operation, ExportOperation::Update);
        assert_eq!(recovered[2].run_id, recovered[2].root_run_id);
    }

    #[test]
    fn corrupt_record_is_quarantined_without_failing_open() {
        let temp = TempDir::new().unwrap();
        let config = config(temp.path());
        let _ = Spool::open(&config).unwrap();
        fs::write(temp.path().join("broken.json"), b"not-json").unwrap();
        let opened = Spool::open(&config).unwrap();
        assert_eq!(opened.stats.quarantined, 1);
        assert!(temp.path().join("quarantine").is_dir());
    }

    #[test]
    fn target_change_isolates_by_default_and_replays_only_when_explicit() {
        let temp = TempDir::new().unwrap();
        let first = config(temp.path());
        let mut opened = Spool::open(&first).unwrap();
        opened.spool.persist(&root_create()).unwrap();
        drop(opened);

        let mut second = config(temp.path());
        second.project = "project-b".into();
        let isolated = Spool::open(&second).unwrap();
        assert!(isolated.recovered.is_empty());
        assert_eq!(isolated.stats.isolated, 1);
        assert!(temp.path().join("stale").is_dir());

        let replay_dir = TempDir::new().unwrap();
        let first = config(replay_dir.path());
        let mut opened = Spool::open(&first).unwrap();
        opened.spool.persist(&root_create()).unwrap();
        drop(opened);
        let mut replay = config(replay_dir.path());
        replay.project = "project-b".into();
        replay.spool.as_mut().unwrap().target_change = SpoolTargetChange::Replay;
        let replayed = Spool::open(&replay).unwrap();
        assert_eq!(replayed.recovered.len(), 2);
        assert!(replayed
            .recovered
            .iter()
            .filter(|item| item.operation == ExportOperation::Create)
            .all(|item| item.payload["session_name"] == "project-b"));
    }

    #[test]
    fn isolated_records_share_the_active_spool_capacity_across_target_changes() {
        let temp = TempDir::new().unwrap();
        let mut first = config(temp.path());
        first.spool.as_mut().unwrap().max_files = 1;
        let mut opened = Spool::open(&first).unwrap();
        opened.spool.persist(&root_create()).unwrap();
        drop(opened);

        let mut second = first.clone();
        second.project = "project-b".into();
        let mut opened = Spool::open(&second).unwrap();
        assert_eq!(inactive_totals(temp.path()).unwrap().0, 1);
        assert_eq!(opened.spool.persist(&root_create()).unwrap(), 1);
        assert_eq!(inactive_totals(temp.path()).unwrap().0, 0);
        drop(opened);

        let mut third = second;
        third.project = "project-c".into();
        let opened = Spool::open(&third).unwrap();
        assert_eq!(opened.recovered.len(), 0);
        assert_eq!(inactive_totals(temp.path()).unwrap().0, 1);
        assert!(opened.spool.status().pending <= 1);
    }

    #[test]
    fn off_cleanup_removes_only_owned_spool_material() {
        let temp = TempDir::new().unwrap();
        let config = config(temp.path());
        let mut opened = Spool::open(&config).unwrap();
        opened.spool.persist(&root_create()).unwrap();
        fs::write(temp.path().join("keep.txt"), "unrelated").unwrap();
        Spool::clear_directory(&config.spool.as_ref().unwrap().directory).unwrap();
        assert!(temp.path().join("keep.txt").exists());
        assert!(record_paths(temp.path()).unwrap().is_empty());
        assert!(!temp.path().join(MANIFEST_FILE).exists());
    }

    #[test]
    fn file_limit_prunes_whole_oldest_trace_and_retention_drops_expired_trace() {
        let temp = TempDir::new().unwrap();
        let mut config = config(temp.path());
        config.spool.as_mut().unwrap().max_files = 2;
        let mut opened = Spool::open(&config).unwrap();
        let first = root_create();
        let second = root_create();
        let third = root_create();
        opened.spool.persist(&first).unwrap();
        opened.spool.persist(&second).unwrap();
        assert_eq!(opened.spool.persist(&third).unwrap(), 1);
        let records = opened
            .spool
            .read_active(&mut SpoolOpenStats::default())
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(records
            .iter()
            .all(|record| record.item.root_run_id != first.root_run_id));

        for path in record_paths(temp.path()).unwrap() {
            let mut record = read_json::<PersistedItem>(&path).unwrap().unwrap();
            record.persisted_at_unix_ms = 0;
            atomic_write_replace(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
        }
        drop(opened);
        let reopened = Spool::open(&config).unwrap();
        assert!(reopened.recovered.is_empty());
        assert_eq!(reopened.stats.dropped, 2);
    }
}
