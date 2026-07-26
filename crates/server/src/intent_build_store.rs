use memory::{ReaderPrivateStorageGate, READER_PRIVATE_STORAGE_UNAVAILABLE};
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const INTENT_BUILD_INVALID: &str = "INTENT_BUILD_INVALID";
pub const INTENT_BUILD_CONFLICT: &str = "INTENT_BUILD_CONFLICT";
pub const INTENT_BUILD_NOT_FOUND: &str = "INTENT_BUILD_NOT_FOUND";

const INDEX_VERSION: &str = "intent_artifact_store_index.v1";
static WRITE_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IntentIndexEntryV1 {
    pub intent_id: String,
    pub revision: u64,
    pub status: String,
    pub source_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanIndexEntryV1 {
    pub plan_id: String,
    pub revision: u64,
    pub status: String,
    pub plan_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveIntentOverlayV1 {
    pub intent_id: String,
    pub plan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IntentArtifactStoreIndexV1 {
    version: String,
    book_id: String,
    store_revision: u64,
    #[serde(default)]
    intents: BTreeMap<String, IntentIndexEntryV1>,
    #[serde(default)]
    plans: BTreeMap<String, PlanIndexEntryV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_overlay: Option<ActiveIntentOverlayV1>,
}

impl IntentArtifactStoreIndexV1 {
    fn empty(book_id: &str) -> Self {
        Self {
            version: INDEX_VERSION.into(),
            book_id: book_id.into(),
            store_revision: 0,
            intents: BTreeMap::new(),
            plans: BTreeMap::new(),
            active_overlay: None,
        }
    }

    fn bump(&mut self) -> Result<(), ToolError> {
        self.store_revision = self
            .store_revision
            .checked_add(1)
            .ok_or_else(|| store_corrupt("intent artifact store revision overflow"))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RedactedIntentBuildInspectionV1 {
    pub version: String,
    pub book_id: String,
    pub store_revision: u64,
    pub intents: Vec<IntentIndexEntryV1>,
    pub plans: Vec<PlanIndexEntryV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_overlay: Option<ActiveIntentOverlayV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IntentArtifactOverlayV1 {
    pub version: String,
    pub book_id: String,
    pub intent_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub artifacts: Vec<IntentArtifactProjectionV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IntentArtifactProjectionV1 {
    pub artifact_id: String,
    pub artifact_type: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedIntentArtifactV1 {
    version: String,
    task_id: String,
    book_id: String,
    source_fingerprint: String,
    intent_id: String,
    intent_digest: String,
    plan_id: String,
    plan_digest: String,
    artifact_id: String,
    artifact_type: String,
    payload: Value,
    payload_digest: String,
    accepted_at: String,
}

#[derive(Debug)]
struct ExpectedIntentArtifact {
    artifact_id: String,
    artifact_type: String,
}

#[derive(Debug, Clone)]
pub struct IntentArtifactStore {
    root: PathBuf,
}

pub fn resolve_intent_artifact_root(
    override_root: Option<&Path>,
    user_profile: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, ToolError> {
    if let Some(root) = override_root {
        return validate_private_root(root);
    }
    let base = user_profile.or(home).ok_or_else(|| {
        private_storage_error(
            "reader-private intent root cannot be resolved because USERPROFILE and HOME are unavailable",
        )
    })?;
    validate_private_root(
        &base
            .join(".understand-book")
            .join("private")
            .join("build-intents"),
    )
}

fn validate_private_root(root: &Path) -> Result<PathBuf, ToolError> {
    if root.as_os_str().is_empty() || !root.is_absolute() {
        return Err(private_storage_error(
            "reader-private intent root must be an absolute path",
        ));
    }
    Ok(root.to_path_buf())
}

impl IntentArtifactStore {
    pub fn default_root() -> Result<PathBuf, ToolError> {
        let override_root = std::env::var_os("UNDERSTAND_BOOK_PRIVATE_DIR").map(PathBuf::from);
        let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let home = std::env::var_os("HOME").map(PathBuf::from);
        resolve_intent_artifact_root(
            override_root.as_deref(),
            user_profile.as_deref(),
            home.as_deref(),
        )
    }

    pub fn open_default() -> Result<Self, ToolError> {
        Self::open(Self::default_root()?)
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self, ToolError> {
        let root = validate_private_root(&root.into())?;
        ReaderPrivateStorageGate::enforce(&root.join(".intent-store-gate"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_intent(&self, intent: &Value) -> Result<IntentIndexEntryV1, ToolError> {
        self.ensure_private()?;
        let entry = parse_intent_entry(intent)?;
        let book_id = required_string(intent, "book_id")?;
        let path = self.intent_path(book_id, &entry.intent_id)?;
        let mut index = self.load_index(book_id)?;
        if let Some(current) = index.intents.get(&entry.intent_id) {
            reject_older_revision("intent", entry.revision, current.revision)?;
        }
        let body_changed = reconcile_existing_revision(&path, "intent", entry.revision, intent)?;
        let index_changed = index.intents.get(&entry.intent_id) != Some(&entry);
        if body_changed {
            write_json_atomically(&path, intent)?;
        }
        if index_changed {
            index.intents.insert(entry.intent_id.clone(), entry.clone());
            index.bump()?;
            self.write_index(&index)?;
        }
        Ok(entry)
    }

    pub fn write_plan(&self, plan: &Value) -> Result<PlanIndexEntryV1, ToolError> {
        self.ensure_private()?;
        let entry = parse_plan_entry(plan)?;
        let book_id = required_string(plan, "book_id")?;
        let path = self.plan_path(book_id, &entry.plan_id)?;
        let mut index = self.load_index(book_id)?;
        if let Some(intent_id) = &entry.intent_id {
            let intent = index
                .intents
                .get(intent_id)
                .ok_or_else(|| not_found("plan intent does not exist"))?;
            if intent.source_fingerprint != required_string(plan, "source_fingerprint")? {
                return Err(invalid(
                    "plan source_fingerprint must match the referenced intent",
                ));
            }
        }
        if let Some(current) = index.plans.get(&entry.plan_id) {
            reject_older_revision("plan", entry.revision, current.revision)?;
        }
        let body_changed = reconcile_existing_revision(&path, "plan", entry.revision, plan)?;
        let index_changed = index.plans.get(&entry.plan_id) != Some(&entry);
        if body_changed {
            write_json_atomically(&path, plan)?;
        }
        if index_changed {
            index.plans.insert(entry.plan_id.clone(), entry.clone());
            index.bump()?;
            self.write_index(&index)?;
        }
        Ok(entry)
    }

    pub fn read_intent(&self, book_id: &str, intent_id: &str) -> Result<Value, ToolError> {
        self.ensure_private()?;
        let path = self.intent_path(book_id, intent_id)?;
        read_required_json(&path, "intent")
    }

    pub fn read_plan(&self, book_id: &str, plan_id: &str) -> Result<Value, ToolError> {
        self.ensure_private()?;
        let path = self.plan_path(book_id, plan_id)?;
        read_required_json(&path, "plan")
    }

    pub fn build_plan_path(&self, book_id: &str, plan_id: &str) -> Result<PathBuf, ToolError> {
        self.ensure_private()?;
        let path = self.plan_path(book_id, plan_id)?;
        read_required_json(&path, "plan")?;
        Ok(path)
    }

    pub fn inspect_redacted(
        &self,
        book_id: &str,
    ) -> Result<RedactedIntentBuildInspectionV1, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let index = self.load_index(book_id)?;
        Ok(RedactedIntentBuildInspectionV1 {
            version: "intent_build_inspection.v1".into(),
            book_id: book_id.into(),
            store_revision: index.store_revision,
            intents: index.intents.into_values().collect(),
            plans: index.plans.into_values().collect(),
            active_overlay: index.active_overlay,
        })
    }

    pub fn set_active_overlay(
        &self,
        book_id: &str,
        active: Option<ActiveIntentOverlayV1>,
    ) -> Result<(), ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let mut index = self.load_index(book_id)?;
        if let Some(reference) = &active {
            validate_path_safe_id(&reference.intent_id, "active intent_id")?;
            validate_path_safe_id(&reference.plan_id, "active plan_id")?;
            if !index.intents.contains_key(&reference.intent_id) {
                return Err(not_found("active intent does not exist"));
            }
            let plan = index
                .plans
                .get(&reference.plan_id)
                .ok_or_else(|| not_found("active plan does not exist"))?;
            if plan.intent_id.as_deref() != Some(reference.intent_id.as_str()) {
                return Err(invalid(
                    "active plan does not belong to the selected intent",
                ));
            }
            if plan.status != "confirmed" && plan.status != "completed" {
                return Err(invalid("active plan must be confirmed or completed"));
            }
        }
        if index.active_overlay != active {
            index.active_overlay = active;
            index.bump()?;
            self.write_index(&index)?;
        }
        Ok(())
    }

    pub fn artifact_directory(
        &self,
        book_id: &str,
        intent_id: &str,
        artifact_id: &str,
    ) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(artifact_id, "artifact_id")?;
        Ok(self
            .artifact_intent_directory(book_id, intent_id)?
            .join(artifact_id))
    }

    pub fn read_active_overlay_artifacts(
        &self,
        book_id: &str,
        current_source_fingerprint: &str,
    ) -> Result<IntentArtifactOverlayV1, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let index = self.load_index(book_id)?;
        let active = index
            .active_overlay
            .ok_or_else(|| not_found("active intent artifact overlay does not exist"))?;
        let plan_entry = index
            .plans
            .get(&active.plan_id)
            .ok_or_else(|| store_corrupt("active overlay plan index entry is missing"))?;
        let intent_entry = index
            .intents
            .get(&active.intent_id)
            .ok_or_else(|| store_corrupt("active overlay intent index entry is missing"))?;
        if intent_entry.source_fingerprint != current_source_fingerprint {
            return Err(conflict(
                "active intent artifact overlay does not match the current source",
            ));
        }
        let plan = self.read_plan(book_id, &active.plan_id)?;
        let intent = self.read_intent(book_id, &active.intent_id)?;
        validate_active_selection(
            book_id,
            current_source_fingerprint,
            &active,
            plan_entry,
            &plan,
            &intent,
        )?;
        let expected = expected_private_artifacts(&plan)?;
        let intent_digest = required_string(&plan, "intent_digest")?;
        let plan_digest = required_string(&plan, "plan_digest")?;
        let mut artifacts = Vec::with_capacity(expected.len());
        for artifact in expected {
            let accepted_path = self
                .artifact_directory(book_id, &active.intent_id, &artifact.artifact_id)?
                .join("accepted.json");
            if !accepted_path.exists() {
                artifacts.push(IntentArtifactProjectionV1 {
                    artifact_id: artifact.artifact_id,
                    artifact_type: artifact.artifact_type,
                    state: "pending".into(),
                    payload_digest: None,
                    accepted_at: None,
                    payload: None,
                });
                continue;
            }
            let accepted: AcceptedIntentArtifactV1 = read_json(&accepted_path)?;
            validate_accepted_artifact(
                &accepted,
                book_id,
                current_source_fingerprint,
                &active,
                intent_digest,
                plan_digest,
                &artifact,
            )?;
            artifacts.push(IntentArtifactProjectionV1 {
                artifact_id: artifact.artifact_id,
                artifact_type: artifact.artifact_type,
                state: "accepted".into(),
                payload_digest: Some(accepted.payload_digest),
                accepted_at: Some(accepted.accepted_at),
                payload: Some(accepted.payload),
            });
        }
        Ok(IntentArtifactOverlayV1 {
            version: "intent_artifact_overlay.v1".into(),
            book_id: book_id.into(),
            intent_id: active.intent_id,
            plan_id: active.plan_id,
            plan_digest: plan_digest.into(),
            artifacts,
        })
    }

    pub fn hard_delete_intent(&self, book_id: &str, intent_id: &str) -> Result<bool, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        validate_path_safe_id(intent_id, "intent_id")?;
        let mut index = self.load_index(book_id)?;
        let intent_dir = self.intent_directory(book_id, intent_id)?;
        let artifact_dir = self.artifact_intent_directory(book_id, intent_id)?;
        let plan_ids = index
            .plans
            .values()
            .filter(|plan| plan.intent_id.as_deref() == Some(intent_id))
            .map(|plan| plan.plan_id.clone())
            .collect::<Vec<_>>();
        let existed = index.intents.contains_key(intent_id)
            || intent_dir.exists()
            || artifact_dir.exists()
            || !plan_ids.is_empty();
        if !existed {
            return Ok(false);
        }

        remove_private_path(&intent_dir)?;
        remove_private_path(&artifact_dir)?;
        for plan_id in &plan_ids {
            remove_private_path(&self.plan_path(book_id, plan_id)?)?;
        }
        index.intents.remove(intent_id);
        for plan_id in plan_ids {
            index.plans.remove(&plan_id);
        }
        if index
            .active_overlay
            .as_ref()
            .is_some_and(|active| active.intent_id == intent_id)
        {
            index.active_overlay = None;
        }
        index.bump()?;
        self.write_index(&index)?;
        Ok(true)
    }

    fn ensure_private(&self) -> Result<(), ToolError> {
        ReaderPrivateStorageGate::enforce(&self.root.join(".intent-store-gate"))
    }

    fn book_directory(&self, book_id: &str) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(book_id, "book_id")?;
        Ok(self.root.join(book_id))
    }

    fn index_path(&self, book_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self.book_directory(book_id)?.join("index.json"))
    }

    fn intent_directory(&self, book_id: &str, intent_id: &str) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(intent_id, "intent_id")?;
        Ok(self
            .book_directory(book_id)?
            .join("intents")
            .join(intent_id))
    }

    fn intent_path(&self, book_id: &str, intent_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self
            .intent_directory(book_id, intent_id)?
            .join("intent.json"))
    }

    fn plan_path(&self, book_id: &str, plan_id: &str) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(plan_id, "plan_id")?;
        Ok(self
            .book_directory(book_id)?
            .join("plans")
            .join(format!("{plan_id}.json")))
    }

    fn artifact_intent_directory(
        &self,
        book_id: &str,
        intent_id: &str,
    ) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(intent_id, "intent_id")?;
        Ok(self
            .book_directory(book_id)?
            .join("artifacts")
            .join(intent_id))
    }

    fn load_index(&self, book_id: &str) -> Result<IntentArtifactStoreIndexV1, ToolError> {
        validate_path_safe_id(book_id, "book_id")?;
        let path = self.index_path(book_id)?;
        if !path.exists() {
            return Ok(IntentArtifactStoreIndexV1::empty(book_id));
        }
        let index: IntentArtifactStoreIndexV1 = read_json(&path)?;
        validate_index(&index, book_id)?;
        Ok(index)
    }

    fn write_index(&self, index: &IntentArtifactStoreIndexV1) -> Result<(), ToolError> {
        validate_index(index, &index.book_id)?;
        write_json_atomically(&self.index_path(&index.book_id)?, index)
    }
}

fn parse_intent_entry(intent: &Value) -> Result<IntentIndexEntryV1, ToolError> {
    if required_string(intent, "version")? != "build_intent.v1" {
        return Err(invalid("unsupported BuildIntent version"));
    }
    let intent_id = required_string(intent, "intent_id")?;
    validate_path_safe_id(intent_id, "intent_id")?;
    let book_id = required_string(intent, "book_id")?;
    validate_path_safe_id(book_id, "book_id")?;
    let revision = required_revision(intent)?;
    let status = required_string(intent, "status")?;
    if ![
        "draft",
        "confirmed",
        "superseded",
        "stale_source",
        "deleted",
    ]
    .contains(&status)
    {
        return Err(invalid("unsupported BuildIntent status"));
    }
    let source_fingerprint = required_string(intent, "source_fingerprint")?;
    Ok(IntentIndexEntryV1 {
        intent_id: intent_id.into(),
        revision,
        status: status.into(),
        source_fingerprint: source_fingerprint.into(),
    })
}

fn parse_plan_entry(plan: &Value) -> Result<PlanIndexEntryV1, ToolError> {
    if required_string(plan, "version")? != "build_plan.v1" {
        return Err(invalid("unsupported BuildPlan version"));
    }
    let plan_id = required_string(plan, "plan_id")?;
    validate_path_safe_id(plan_id, "plan_id")?;
    validate_path_safe_id(required_string(plan, "book_id")?, "book_id")?;
    let revision = required_revision(plan)?;
    let status = required_string(plan, "status")?;
    if ![
        "draft",
        "confirmed",
        "superseded",
        "stale_source",
        "completed",
    ]
    .contains(&status)
    {
        return Err(invalid("unsupported BuildPlan status"));
    }
    let plan_digest = required_string(plan, "plan_digest")?;
    if !is_sha256(plan_digest) {
        return Err(invalid("plan_digest must be a lowercase SHA-256 digest"));
    }
    let intent_id = optional_string(plan, "intent_id")?;
    if let Some(intent_id) = intent_id {
        validate_path_safe_id(intent_id, "intent_id")?;
    }
    Ok(PlanIndexEntryV1 {
        plan_id: plan_id.into(),
        revision,
        status: status.into(),
        plan_digest: plan_digest.into(),
        intent_id: intent_id.map(str::to_string),
    })
}

fn validate_active_selection(
    book_id: &str,
    current_source_fingerprint: &str,
    active: &ActiveIntentOverlayV1,
    plan_entry: &PlanIndexEntryV1,
    plan: &Value,
    intent: &Value,
) -> Result<(), ToolError> {
    let plan_status = required_string(plan, "status")?;
    let intent_status = required_string(intent, "status")?;
    if !matches!(plan_status, "confirmed" | "completed") || intent_status != "confirmed" {
        return Err(store_corrupt(
            "active intent artifact overlay is not bound to a confirmed selection",
        ));
    }
    if required_string(plan, "book_id")? != book_id
        || required_string(intent, "book_id")? != book_id
        || required_string(plan, "intent_id")? != active.intent_id
        || required_string(intent, "intent_id")? != active.intent_id
        || required_string(plan, "plan_id")? != active.plan_id
        || required_string(plan, "plan_digest")? != plan_entry.plan_digest
    {
        return Err(store_corrupt(
            "active intent artifact overlay identity does not match stored selection",
        ));
    }
    if required_string(plan, "source_fingerprint")? != current_source_fingerprint
        || required_string(intent, "source_fingerprint")? != current_source_fingerprint
    {
        return Err(conflict(
            "active intent artifact overlay does not match the current source",
        ));
    }
    Ok(())
}

fn expected_private_artifacts(plan: &Value) -> Result<Vec<ExpectedIntentArtifact>, ToolError> {
    let values = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| store_corrupt("active goal plan private_artifacts are missing"))?;
    if values.is_empty() {
        return Err(store_corrupt(
            "active goal plan must declare at least one private artifact",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    values
        .iter()
        .map(|value| {
            let artifact_id = required_string(value, "artifact_id")?;
            let artifact_type = required_string(value, "artifact_type")?;
            validate_path_safe_id(artifact_id, "artifact_id")?;
            if !matches!(
                artifact_type,
                "timeline" | "concept_map" | "comparison_table" | "argument_map"
            ) {
                return Err(store_corrupt(
                    "active goal plan contains an unsupported private artifact type",
                ));
            }
            if !seen.insert(artifact_id.to_string()) {
                return Err(store_corrupt(
                    "active goal plan contains duplicate private artifact ids",
                ));
            }
            Ok(ExpectedIntentArtifact {
                artifact_id: artifact_id.into(),
                artifact_type: artifact_type.into(),
            })
        })
        .collect()
}

fn validate_accepted_artifact(
    accepted: &AcceptedIntentArtifactV1,
    book_id: &str,
    current_source_fingerprint: &str,
    active: &ActiveIntentOverlayV1,
    intent_digest: &str,
    plan_digest: &str,
    artifact: &ExpectedIntentArtifact,
) -> Result<(), ToolError> {
    if accepted.version != "intent_artifact_accepted.v1"
        || accepted.book_id != book_id
        || accepted.source_fingerprint != current_source_fingerprint
        || accepted.intent_id != active.intent_id
        || accepted.intent_digest != intent_digest
        || accepted.plan_id != active.plan_id
        || accepted.plan_digest != plan_digest
        || accepted.artifact_id != artifact.artifact_id
        || accepted.artifact_type != artifact.artifact_type
        || accepted.task_id.trim().is_empty()
        || accepted.accepted_at.trim().is_empty()
        || !is_sha256(&accepted.payload_digest)
    {
        return Err(store_corrupt(
            "accepted intent artifact identity does not match the active overlay",
        ));
    }
    let canonical = canonical_json(&accepted.payload)?;
    if crate::sha256_hex(canonical.as_bytes()) != accepted.payload_digest {
        return Err(store_corrupt(
            "accepted intent artifact payload_digest does not match payload",
        ));
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<String, ToolError> {
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value)
            .map_err(|_| store_corrupt("accepted intent artifact string is invalid")),
        Value::Array(values) => {
            let values = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let entries = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key)
                        .map_err(|_| store_corrupt("accepted intent artifact key is invalid"))?;
                    Ok(format!("{key}:{}", canonical_json(value)?))
                })
                .collect::<Result<Vec<_>, ToolError>>()?;
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

fn validate_index(index: &IntentArtifactStoreIndexV1, book_id: &str) -> Result<(), ToolError> {
    if index.version != INDEX_VERSION || index.book_id != book_id {
        return Err(store_corrupt("intent artifact index identity mismatch"));
    }
    validate_path_safe_id(&index.book_id, "index book_id")?;
    for (key, entry) in &index.intents {
        if key != &entry.intent_id || entry.revision == 0 {
            return Err(store_corrupt(
                "intent artifact index contains an invalid intent entry",
            ));
        }
        validate_path_safe_id(key, "index intent_id")?;
    }
    for (key, entry) in &index.plans {
        if key != &entry.plan_id || entry.revision == 0 || !is_sha256(&entry.plan_digest) {
            return Err(store_corrupt(
                "intent artifact index contains an invalid plan entry",
            ));
        }
        validate_path_safe_id(key, "index plan_id")?;
    }
    if let Some(active) = &index.active_overlay {
        if !index.intents.contains_key(&active.intent_id)
            || !index.plans.contains_key(&active.plan_id)
        {
            return Err(store_corrupt(
                "intent artifact index has a dangling active overlay",
            ));
        }
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ToolError> {
    value
        .as_object()
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>, ToolError> {
    let Some(field_value) = value.as_object().and_then(|object| object.get(field)) else {
        return Ok(None);
    };
    let string = field_value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string when present")))?;
    Ok(Some(string))
}

fn required_revision(value: &Value) -> Result<u64, ToolError> {
    value
        .as_object()
        .and_then(|object| object.get("revision"))
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| invalid("revision must be a positive integer"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_path_safe_id(value: &str, field: &str) -> Result<(), ToolError> {
    let bytes = value.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 128
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-'));
    let base = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
    if !valid || reserved {
        return Err(invalid(format!("{field} must be a path-safe ASCII id")));
    }
    Ok(())
}

fn reject_older_revision(kind: &str, candidate: u64, current: u64) -> Result<(), ToolError> {
    if candidate < current {
        return Err(conflict(format!("{kind} revision cannot move backward")));
    }
    Ok(())
}

fn reconcile_existing_revision(
    path: &Path,
    kind: &str,
    candidate_revision: u64,
    candidate: &Value,
) -> Result<bool, ToolError> {
    if !path.exists() {
        return Ok(true);
    }
    let existing: Value = read_json(path)?;
    let existing_revision = required_revision(&existing)?;
    reject_older_revision(kind, candidate_revision, existing_revision)?;
    if candidate_revision == existing_revision {
        if &existing == candidate {
            return Ok(false);
        }
        if same_revision_lifecycle_update(kind, &existing, candidate) {
            return Ok(true);
        }
        return Err(conflict(format!(
            "{kind} revision already exists with different content"
        )));
    }
    Ok(true)
}

fn same_revision_lifecycle_update(kind: &str, existing: &Value, candidate: &Value) -> bool {
    let Some(from) = existing.get("status").and_then(Value::as_str) else {
        return false;
    };
    let Some(to) = candidate.get("status").and_then(Value::as_str) else {
        return false;
    };
    let transition_allowed = match kind {
        "intent" => match from {
            "draft" => matches!(to, "confirmed" | "superseded" | "stale_source" | "deleted"),
            "confirmed" => matches!(to, "superseded" | "stale_source" | "deleted"),
            "superseded" | "stale_source" => to == "deleted",
            _ => false,
        },
        "plan" => match from {
            "draft" => matches!(to, "confirmed" | "superseded" | "stale_source"),
            "confirmed" => matches!(to, "completed" | "superseded" | "stale_source"),
            "completed" => matches!(to, "superseded" | "stale_source"),
            "stale_source" => to == "superseded",
            _ => false,
        },
        _ => false,
    };
    if !transition_allowed {
        return false;
    }

    lifecycle_identity(kind, existing) == lifecycle_identity(kind, candidate)
}

fn lifecycle_identity(kind: &str, value: &Value) -> Option<Value> {
    let mut object = value.as_object()?.clone();
    object.remove("status");
    object.remove("confirmed_at");
    if kind == "plan" {
        object.remove("confirmation_source");
    }
    Some(Value::Object(object))
}

fn read_required_json(path: &Path, kind: &str) -> Result<Value, ToolError> {
    if !path.exists() {
        return Err(not_found(format!("{kind} does not exist")));
    }
    read_json(path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ToolError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        private_storage_error(format!("reader-private file cannot be inspected: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(private_storage_error(
            "reader-private JSON path must be a real file",
        ));
    }
    let body = std::fs::read(path).map_err(|error| {
        private_storage_error(format!("reader-private file cannot be read: {error}"))
    })?;
    serde_json::from_slice(&body)
        .map_err(|_| store_corrupt("reader-private intent JSON is invalid"))
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), ToolError> {
    ReaderPrivateStorageGate::enforce(path)?;
    let mut body = serde_json::to_vec_pretty(value)
        .map_err(|_| store_corrupt("reader-private intent JSON cannot be serialized"))?;
    body.push(b'\n');
    let temporary = sibling_transaction_path(path, "tmp")?;
    let backup = sibling_transaction_path(path, "bak")?;
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&body)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(private_storage_error(format!(
            "reader-private temporary file cannot be written: {error}"
        )));
    }
    if let Err(error) = ReaderPrivateStorageGate::secure_file(&temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }

    let had_original = path.exists();
    if had_original {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            private_storage_error(format!(
                "reader-private target cannot be inspected: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            let _ = std::fs::remove_file(&temporary);
            return Err(private_storage_error(
                "reader-private target must be a real file",
            ));
        }
        std::fs::rename(path, &backup).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            private_storage_error(format!(
                "reader-private target cannot be backed up: {error}"
            ))
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        if had_original {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(private_storage_error(format!(
            "reader-private snapshot cannot be committed: {error}"
        )));
    }
    if let Err(error) = ReaderPrivateStorageGate::secure_file(path) {
        if had_original {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::rename(&backup, path);
        }
        return Err(error);
    }
    if had_original {
        std::fs::remove_file(&backup).map_err(|error| {
            private_storage_error(format!("reader-private backup cannot be removed: {error}"))
        })?;
    }
    Ok(())
}

fn sibling_transaction_path(path: &Path, suffix: &str) -> Result<PathBuf, ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| private_storage_error("reader-private file has no parent"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| private_storage_error("reader-private file name is invalid"))?;
    let nonce = WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.{}.{}.{suffix}", std::process::id(), nonce)))
}

fn remove_private_path(path: &Path) -> Result<(), ToolError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(private_storage_error(format!(
                "reader-private deletion target cannot be inspected: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(private_storage_error(
            "symbolic links are not allowed in reader-private deletion",
        ));
    }
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else if metadata.is_file() {
        std::fs::remove_file(path)
    } else {
        return Err(private_storage_error(
            "unsupported reader-private deletion target",
        ));
    }
    .map_err(|error| {
        private_storage_error(format!(
            "reader-private data cannot be hard deleted: {error}"
        ))
    })
}

fn private_storage_error(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: READER_PRIVATE_STORAGE_UNAVAILABLE.into(),
        category: "permission".into(),
        message: message.into(),
    }
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: INTENT_BUILD_INVALID.into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: INTENT_BUILD_CONFLICT.into(),
        category: "conflict".into(),
        message: message.into(),
    }
}

fn not_found(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: INTENT_BUILD_NOT_FOUND.into(),
        category: "not_found".into(),
        message: message.into(),
    }
}

fn store_corrupt(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "INTENT_BUILD_STORE_CORRUPT".into(),
        category: "data".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use memory::{ReaderPrivateStorageGate, READER_PRIVATE_STORAGE_UNAVAILABLE};
    use serde_json::json;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ub-intent-store-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn intent(book_id: &str, intent_id: &str, revision: u64, goal: &str) -> serde_json::Value {
        json!({
            "version": "build_intent.v1",
            "intent_id": intent_id,
            "revision": revision,
            "book_id": book_id,
            "source_fingerprint": "source-a",
            "status": "confirmed",
            "user_goal": goal
        })
    }

    fn plan(book_id: &str, plan_id: &str, intent_id: &str, revision: u64) -> serde_json::Value {
        json!({
            "version": "build_plan.v1",
            "plan_id": plan_id,
            "revision": revision,
            "book_id": book_id,
            "source_fingerprint": "source-a",
            "intent_id": intent_id,
            "intent_digest": "b".repeat(64),
            "private_artifacts": [{
                "artifact_id": "artifact-001",
                "artifact_type": "timeline",
                "source_scope": { "whole_book": false, "lids": ["1.1"], "sections": [] },
                "required_public_capabilities": [],
                "evidence_policy": "lid_required"
            }],
            "status": "confirmed",
            "plan_digest": "c".repeat(64)
        })
    }

    fn accepted_artifact(payload: serde_json::Value) -> serde_json::Value {
        let payload_digest = crate::sha256_hex(&serde_json::to_vec(&payload).unwrap());
        json!({
            "version": "intent_artifact_accepted.v1",
            "task_id": "intent-artifact-task-001",
            "book_id": "paper-a",
            "source_fingerprint": "source-a",
            "intent_id": "intent-001",
            "intent_digest": "b".repeat(64),
            "plan_id": "plan-001",
            "plan_digest": "c".repeat(64),
            "artifact_id": "artifact-001",
            "artifact_type": "timeline",
            "payload": payload,
            "payload_digest": payload_digest,
            "accepted_at": "2026-07-26T03:00:00.000Z"
        })
    }

    #[test]
    fn resolves_override_and_home_roots_without_falling_back_to_the_workspace() {
        let override_root = test_dir("override-root");
        assert_eq!(
            resolve_intent_artifact_root(Some(&override_root), None, None).unwrap(),
            override_root
        );
        let home = test_dir("home-root");
        assert_eq!(
            resolve_intent_artifact_root(None, Some(&home), None).unwrap(),
            home.join(".understand-book")
                .join("private")
                .join("build-intents")
        );
        assert_eq!(
            resolve_intent_artifact_root(Some(Path::new("relative")), None, None)
                .unwrap_err()
                .error_code,
            READER_PRIVATE_STORAGE_UNAVAILABLE
        );
        assert_eq!(
            resolve_intent_artifact_root(None, None, None)
                .unwrap_err()
                .error_code,
            READER_PRIVATE_STORAGE_UNAVAILABLE
        );
    }

    #[test]
    fn persists_monotonic_revisions_outside_the_book_and_reopens_redacted_state() {
        let parent = test_dir("revision");
        let root = parent.join("private");
        let book_dir = parent.join("library").join("paper-a");
        std::fs::create_dir_all(&book_dir).unwrap();
        std::fs::write(book_dir.join("source.txt"), "public source").unwrap();
        let store = IntentArtifactStore::open(&root).unwrap();

        store
            .write_intent(&intent("paper-a", "intent-001", 1, "private goal"))
            .unwrap();
        store
            .write_intent(&intent("paper-a", "intent-001", 2, "revised private goal"))
            .unwrap();
        store
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 1))
            .unwrap();
        store
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 2))
            .unwrap();

        assert!(!book_dir.join("intents").exists());
        assert!(!book_dir.join("plans").exists());
        assert!(root.join("paper-a/intents/intent-001/intent.json").exists());
        let reopened = IntentArtifactStore::open(&root).unwrap();
        assert_eq!(
            reopened.read_intent("paper-a", "intent-001").unwrap()["revision"],
            2
        );
        assert_eq!(
            reopened.read_plan("paper-a", "plan-001").unwrap()["revision"],
            2
        );
        let inspection = reopened.inspect_redacted("paper-a").unwrap();
        let public_json = serde_json::to_string(&inspection).unwrap();
        assert_eq!(inspection.intents[0].revision, 2);
        assert_eq!(inspection.plans[0].revision, 2);
        assert!(!public_json.contains("private goal"));
        assert!(!public_json.contains("revised private goal"));

        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn rejects_path_escape_and_same_revision_conflicts() {
        let root = test_dir("validation");
        let store = IntentArtifactStore::open(&root).unwrap();
        assert_eq!(
            store
                .write_intent(&intent("../paper", "intent-001", 1, "goal"))
                .unwrap_err()
                .error_code,
            INTENT_BUILD_INVALID
        );
        assert_eq!(
            store
                .write_intent(&intent("paper-a", "../intent", 1, "goal"))
                .unwrap_err()
                .error_code,
            INTENT_BUILD_INVALID
        );

        let original = intent("paper-a", "intent-001", 1, "first");
        store.write_intent(&original).unwrap();
        store.write_intent(&original).unwrap();
        assert_eq!(
            store
                .write_intent(&intent("paper-a", "intent-001", 1, "conflict"))
                .unwrap_err()
                .error_code,
            INTENT_BUILD_CONFLICT
        );
        assert_eq!(
            store
                .write_intent(&intent("paper-a", "intent-001", 0, "older"))
                .unwrap_err()
                .error_code,
            INTENT_BUILD_INVALID
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn allows_same_revision_lifecycle_transitions_but_not_identity_changes() {
        let root = test_dir("lifecycle-transition");
        let store = IntentArtifactStore::open(&root).unwrap();
        let draft_intent = intent("paper-a", "intent-001", 1, "private goal");
        let mut draft_intent = draft_intent;
        draft_intent["status"] = json!("draft");
        store.write_intent(&draft_intent).unwrap();
        let mut confirmed_intent = draft_intent.clone();
        confirmed_intent["status"] = json!("confirmed");
        confirmed_intent["confirmed_at"] = json!("2026-07-25T00:00:00.000Z");
        store.write_intent(&confirmed_intent).unwrap();

        let mut draft_plan = plan("paper-a", "plan-001", "intent-001", 1);
        draft_plan["status"] = json!("draft");
        store.write_plan(&draft_plan).unwrap();
        let mut confirmed_plan = draft_plan.clone();
        confirmed_plan["status"] = json!("confirmed");
        confirmed_plan["confirmed_at"] = json!("2026-07-25T00:00:00.000Z");
        confirmed_plan["confirmation_source"] = json!("reader_ui");
        store.write_plan(&confirmed_plan).unwrap();

        assert_eq!(
            store.read_intent("paper-a", "intent-001").unwrap()["status"],
            "confirmed"
        );
        assert_eq!(
            store.read_plan("paper-a", "plan-001").unwrap()["status"],
            "confirmed"
        );

        let mut changed_identity = confirmed_intent;
        changed_identity["user_goal"] = json!("different goal");
        assert_eq!(
            store
                .write_intent(&changed_identity)
                .unwrap_err()
                .error_code,
            INTENT_BUILD_CONFLICT
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_dangling_or_source_mismatched_intent_plan_references() {
        let root = test_dir("plan-reference");
        let store = IntentArtifactStore::open(&root).unwrap();
        let dangling = plan("paper-a", "plan-001", "intent-missing", 1);
        assert_eq!(
            store.write_plan(&dangling).unwrap_err().error_code,
            INTENT_BUILD_NOT_FOUND
        );

        store
            .write_intent(&intent("paper-a", "intent-001", 1, "goal"))
            .unwrap();
        let mut mismatched = plan("paper-a", "plan-001", "intent-001", 1);
        mismatched["source_fingerprint"] = json!("source-b");
        assert_eq!(
            store.write_plan(&mismatched).unwrap_err().error_code,
            INTENT_BUILD_INVALID
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_overlay_and_hard_delete_remove_index_plan_intent_and_artifact_body() {
        let root = test_dir("delete");
        let store = IntentArtifactStore::open(&root).unwrap();
        store
            .write_intent(&intent("paper-a", "intent-001", 1, "delete me"))
            .unwrap();
        store
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 1))
            .unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
                }),
            )
            .unwrap();

        let accepted = root.join("paper-a/artifacts/intent-001/artifact-001/accepted.json");
        ReaderPrivateStorageGate::enforce(&accepted).unwrap();
        std::fs::write(&accepted, r#"{"body":"private artifact"}"#).unwrap();
        ReaderPrivateStorageGate::secure_file(&accepted).unwrap();
        let attempt =
            root.join("paper-a/artifacts/intent-001/artifact-001/attempts/000001/candidate.json");
        ReaderPrivateStorageGate::enforce(&attempt).unwrap();
        std::fs::write(&attempt, r#"{"body":"private candidate"}"#).unwrap();
        ReaderPrivateStorageGate::secure_file(&attempt).unwrap();
        let receipt = attempt.parent().unwrap().join("receipt.json");
        std::fs::write(&receipt, r#"{"state":"committed"}"#).unwrap();
        ReaderPrivateStorageGate::secure_file(&receipt).unwrap();
        assert!(accepted.exists());
        assert!(attempt.exists());
        assert!(receipt.exists());

        assert!(store.hard_delete_intent("paper-a", "intent-001").unwrap());
        let inspection = store.inspect_redacted("paper-a").unwrap();
        assert!(inspection.intents.is_empty());
        assert!(inspection.plans.is_empty());
        assert!(inspection.active_overlay.is_none());
        assert!(!root.join("paper-a/intents/intent-001").exists());
        assert!(!root.join("paper-a/plans/plan-001.json").exists());
        assert!(!root.join("paper-a/artifacts/intent-001").exists());
        assert!(!store.hard_delete_intent("paper-a", "intent-001").unwrap());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_only_digest_valid_artifacts_from_the_active_overlay_and_reopens() {
        let root = test_dir("active-artifacts");
        let store = IntentArtifactStore::open(&root).unwrap();
        store
            .write_intent(&intent("paper-a", "intent-001", 1, "PRIVATE_STORE_GOAL"))
            .unwrap();
        store
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 1))
            .unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
                }),
            )
            .unwrap();

        let pending = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(pending.version, "intent_artifact_overlay.v1");
        assert_eq!(pending.plan_digest, "c".repeat(64));
        assert_eq!(pending.artifacts.len(), 1);
        assert_eq!(pending.artifacts[0].state, "pending");
        assert!(pending.artifacts[0].payload.is_none());

        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", "artifact-001")
            .unwrap()
            .join("accepted.json");
        let private_payload = json!({
            "items": [{
                "id": "event-1",
                "label": "PRIVATE_STORE_ARTIFACT_SENTINEL",
                "evidence_lids": ["1.1"]
            }]
        });
        write_json_atomically(&accepted_path, &accepted_artifact(private_payload.clone())).unwrap();

        let reopened = IntentArtifactStore::open(&root).unwrap();
        let projection = reopened
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].state, "accepted");
        assert_eq!(projection.artifacts[0].payload, Some(private_payload));
        assert!(projection.artifacts[0].payload_digest.is_some());
        let redacted =
            serde_json::to_string(&reopened.inspect_redacted("paper-a").unwrap()).unwrap();
        assert!(!redacted.contains("PRIVATE_STORE_GOAL"));
        assert!(!redacted.contains("PRIVATE_STORE_ARTIFACT_SENTINEL"));

        let mut stale = accepted_artifact(json!({ "items": [] }));
        stale["plan_digest"] = json!("d".repeat(64));
        write_json_atomically(&accepted_path, &stale).unwrap();
        assert_eq!(
            reopened
                .read_active_overlay_artifacts("paper-a", "source-a")
                .unwrap_err()
                .error_code,
            "INTENT_BUILD_STORE_CORRUPT"
        );
        assert_eq!(
            reopened
                .read_active_overlay_artifacts("paper-a", "source-old")
                .unwrap_err()
                .error_code,
            INTENT_BUILD_CONFLICT
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fails_closed_when_private_root_is_a_regular_file() {
        let root = test_dir("file-root");
        std::fs::write(&root, "not a directory").unwrap();
        let error = IntentArtifactStore::open(&root).unwrap_err();
        assert_eq!(error.error_code, READER_PRIVATE_STORAGE_UNAVAILABLE);
        std::fs::remove_file(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fails_closed_when_private_root_is_a_symlink() {
        use std::os::unix::fs::symlink;

        let parent = test_dir("symlink-root");
        let target = parent.join("target");
        let root = parent.join("private");
        std::fs::create_dir_all(&target).unwrap();
        symlink(&target, &root).unwrap();
        let error = IntentArtifactStore::open(&root).unwrap_err();
        assert_eq!(error.error_code, READER_PRIVATE_STORAGE_UNAVAILABLE);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn tightens_wide_private_root_permissions_before_use() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_dir("permissions");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        IntentArtifactStore::open(&root).unwrap();
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
