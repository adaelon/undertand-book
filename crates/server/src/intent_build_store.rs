use artifact_tools::{
    ArtifactAccessSnapshot, ArtifactSearchAnalyzer, ArtifactSnapshotBlueprint,
    ArtifactSnapshotItem, ArtifactSnapshotRecord, ArtifactSnapshotRelation, ArtifactSnapshotScope,
    ArtifactSnapshotSearchField, ARTIFACT_OVERLAY_UNAVAILABLE,
};
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

const INDEX_VERSION: &str = "intent_artifact_store_index.v2";
const ACTIVE_POINTER_VERSION: &str = "intent_artifact_active_pointer.v2";
const LEGACY_INDEX_VERSION: &str = "intent_artifact_store_index.v1";
const V3_INDEX_FILE: &str = "index.v2.json";
const V3_ACTIVE_FILE: &str = "active.v2.json";
const V2_PLANNING_CONTEXT_FILE: &str = "planning-context.v2.json";
const V3_INTENT_FILE: &str = "intent.v3.json";
const V3_PLAN_SUFFIX: &str = ".v3.json";
const V3_ACCEPTED_FILE: &str = "accepted.v3.json";
const LEGACY_INDEX_FILE: &str = "index.json";
const LEGACY_INTENT_FILE: &str = "intent.json";
const LEGACY_ACCEPTED_FILE: &str = "accepted.json";
static WRITE_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IntentIndexEntryV2 {
    pub intent_id: String,
    pub intent_revision: u64,
    pub status: String,
    pub source_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanIndexEntryV2 {
    pub plan_id: String,
    pub plan_revision: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveIntentOverlayV2 {
    pub intent_id: String,
    pub intent_revision: u64,
    pub plan_id: String,
    pub plan_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IntentArtifactStoreIndexV2 {
    version: String,
    book_id: String,
    store_revision: u64,
    #[serde(default)]
    intents: BTreeMap<String, IntentIndexEntryV2>,
    #[serde(default)]
    plans: BTreeMap<String, PlanIndexEntryV2>,
}

impl IntentArtifactStoreIndexV2 {
    fn empty(book_id: &str) -> Self {
        Self {
            version: INDEX_VERSION.into(),
            book_id: book_id.into(),
            store_revision: 0,
            intents: BTreeMap::new(),
            plans: BTreeMap::new(),
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
#[serde(deny_unknown_fields)]
struct ActiveIntentPointerFileV2 {
    version: String,
    book_id: String,
    intent_id: String,
    intent_revision: u64,
    plan_id: String,
    plan_revision: u64,
}

impl ActiveIntentPointerFileV2 {
    fn from_overlay(book_id: &str, active: &ActiveIntentOverlayV2) -> Self {
        Self {
            version: ACTIVE_POINTER_VERSION.into(),
            book_id: book_id.into(),
            intent_id: active.intent_id.clone(),
            intent_revision: active.intent_revision,
            plan_id: active.plan_id.clone(),
            plan_revision: active.plan_revision,
        }
    }

    fn overlay(&self) -> ActiveIntentOverlayV2 {
        ActiveIntentOverlayV2 {
            intent_id: self.intent_id.clone(),
            intent_revision: self.intent_revision,
            plan_id: self.plan_id.clone(),
            plan_revision: self.plan_revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyIntentIndexEntryV1 {
    intent_id: String,
    revision: u64,
    status: String,
    source_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyPlanIndexEntryV1 {
    plan_id: String,
    revision: u64,
    status: String,
    plan_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyActiveIntentOverlayV1 {
    intent_id: String,
    plan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyIntentArtifactStoreIndexV1 {
    version: String,
    book_id: String,
    store_revision: u64,
    #[serde(default)]
    intents: BTreeMap<String, LegacyIntentIndexEntryV1>,
    #[serde(default)]
    plans: BTreeMap<String, LegacyPlanIndexEntryV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_overlay: Option<LegacyActiveIntentOverlayV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanningControlMigrationReceiptV2ToV3 {
    pub version: String,
    pub book_id: String,
    pub intent_count: usize,
    pub plan_count: usize,
    pub accepted_artifact_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_overlay: Option<ActiveIntentOverlayV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RedactedIntentBuildInspectionV2 {
    pub version: String,
    pub book_id: String,
    pub store_revision: u64,
    pub intents: Vec<IntentIndexEntryV2>,
    pub plans: Vec<PlanIndexEntryV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_overlay: Option<ActiveIntentOverlayV2>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IntentArtifactOverlayV2 {
    pub version: String,
    pub book_id: String,
    pub intent_id: String,
    pub intent_revision: u64,
    pub plan_id: String,
    pub plan_revision: u64,
    pub artifacts: Vec<IntentArtifactProjectionV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IntentArtifactProjectionV1 {
    pub artifact_id: String,
    pub artifact_type: String,
    pub state: String,
    pub blueprint: IntentArtifactDisplayBlueprintV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IntentArtifactDisplayBlueprintV1 {
    pub title: String,
    pub purpose: String,
    pub shape: String,
    pub summary_fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyAcceptedIntentArtifactV2 {
    version: String,
    task_id: String,
    book_id: String,
    source_fingerprint: String,
    intent_id: String,
    intent_digest: String,
    plan_id: String,
    plan_digest: String,
    artifact_id: String,
    blueprint_digest: String,
    payload: Value,
    payload_digest: String,
    accepted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedIntentArtifactV3 {
    version: String,
    task_id: String,
    book_id: String,
    source_fingerprint: String,
    intent_id: String,
    intent_revision: u64,
    plan_id: String,
    plan_revision: u64,
    artifact_id: String,
    blueprint_id: String,
    blueprint_version: String,
    payload: Value,
    payload_digest: String,
    accepted_at: String,
}

#[derive(Debug)]
struct ExpectedIntentArtifact {
    artifact_id: String,
    artifact_type: String,
    blueprint_id: String,
    blueprint_version: String,
    access_blueprint: ArtifactSnapshotBlueprint,
    reader_blueprint: IntentArtifactDisplayBlueprintV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInstanceForAccessV3 {
    version: String,
    blueprint_id: String,
    blueprint_version: String,
    records: Vec<ArtifactInstanceRecordForAccessV2>,
    #[serde(default)]
    relations: Vec<ArtifactInstanceRelationForAccessV2>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInstanceRecordForAccessV2 {
    record_id: String,
    data: serde_json::Map<String, Value>,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInstanceRelationForAccessV2 {
    relation_id: String,
    source: String,
    target: String,
    data: serde_json::Map<String, Value>,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactBlueprintForAccessV1 {
    version: String,
    blueprint_id: String,
    blueprint_version: String,
    origin: String,
    title: String,
    purpose: String,
    shape: String,
    record_schema: Value,
    #[serde(default)]
    relation_schema: Option<Value>,
    routing: ArtifactBlueprintRoutingForAccessV1,
    search_fields: Vec<ArtifactBlueprintSearchFieldForAccessV1>,
    summary_fields: Vec<String>,
    evidence_policy: Value,
    limits: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactBlueprintRoutingForAccessV1 {
    use_when: Vec<String>,
    avoid_when: Vec<String>,
    covered_topics: Vec<String>,
    scope_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactBlueprintSearchFieldForAccessV1 {
    path: String,
    weight: u64,
    analyzer: String,
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

    pub fn issue_planning_context_v2(
        &self,
        book_id: &str,
        body: &Value,
    ) -> Result<Value, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let mut candidate = body
            .as_object()
            .cloned()
            .ok_or_else(|| store_corrupt("BuildPlanningContext body must be an object"))?;
        if candidate.contains_key("context_id")
            || candidate.contains_key("context_revision")
            || candidate.contains_key("context_digest")
        {
            return Err(store_corrupt(
                "BuildPlanningContext body must not issue its own identity",
            ));
        }
        let context_id = format!("context-{book_id}");
        validate_path_safe_id(&context_id, "context_id")?;
        candidate.insert("context_id".into(), Value::String(context_id.clone()));
        candidate.insert("context_revision".into(), Value::from(1));

        let path = self.planning_context_path(book_id)?;
        if path.exists() {
            let previous: Value = read_json(&path)?;
            let previous_revision =
                validate_owned_planning_context_v2(&previous, book_id, &context_id)?;
            candidate.insert("context_revision".into(), Value::from(previous_revision));
            let candidate = Value::Object(candidate.clone());
            if candidate == previous {
                return Ok(previous);
            }
            let next_revision = previous_revision
                .checked_add(1)
                .ok_or_else(|| store_corrupt("BuildPlanningContext revision overflow"))?;
            let mut changed = candidate
                .as_object()
                .expect("candidate remains an object")
                .clone();
            changed.insert("context_revision".into(), Value::from(next_revision));
            let changed = Value::Object(changed);
            validate_owned_planning_context_v2(&changed, book_id, &context_id)?;
            write_json_atomically(&path, &changed)?;
            return Ok(changed);
        }

        let first = Value::Object(candidate);
        validate_owned_planning_context_v2(&first, book_id, &context_id)?;
        write_json_atomically(&path, &first)?;
        Ok(first)
    }

    pub fn migrate_planning_control_v2_to_v3(
        &self,
        book_id: &str,
    ) -> Result<PlanningControlMigrationReceiptV2ToV3, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let legacy_index_path = self.legacy_index_path(book_id)?;
        if !legacy_index_path.exists() {
            return Err(not_found("legacy V2 planning index does not exist"));
        }
        let legacy_index: LegacyIntentArtifactStoreIndexV1 = read_json(&legacy_index_path)?;
        validate_legacy_index(&legacy_index, book_id)?;

        let mut migrated_index = IntentArtifactStoreIndexV2 {
            version: INDEX_VERSION.into(),
            book_id: book_id.into(),
            store_revision: legacy_index.store_revision,
            intents: BTreeMap::new(),
            plans: BTreeMap::new(),
        };
        let mut intent_digests = BTreeMap::new();
        let mut migrated_intents = Vec::with_capacity(legacy_index.intents.len());
        for (intent_id, legacy_entry) in &legacy_index.intents {
            let legacy_path = self.legacy_intent_path(book_id, intent_id)?;
            let legacy: Value = read_required_json(&legacy_path, "legacy V2 intent")?;
            let digest = validate_legacy_intent_v2(&legacy, book_id, legacy_entry)?;
            let migrated = migrate_legacy_intent_v2(&legacy)?;
            let entry = parse_intent_entry(&migrated)?;
            intent_digests.insert(intent_id.clone(), digest);
            migrated_index.intents.insert(intent_id.clone(), entry);
            migrated_intents.push((self.intent_path(book_id, intent_id)?, migrated));
        }

        let mut migrated_plans = Vec::with_capacity(legacy_index.plans.len());
        let mut legacy_plans = BTreeMap::new();
        let mut migrated_plan_values = BTreeMap::new();
        for (plan_id, legacy_entry) in &legacy_index.plans {
            let legacy_path = self.legacy_plan_path(book_id, plan_id)?;
            let legacy: Value = read_required_json(&legacy_path, "legacy V2 plan")?;
            validate_legacy_plan_v2(
                &legacy,
                book_id,
                legacy_entry,
                &legacy_index,
                &intent_digests,
            )?;
            let migrated = migrate_legacy_plan_v2(&legacy, &legacy_index)?;
            let entry = parse_plan_entry(&migrated)?;
            migrated_index.plans.insert(plan_id.clone(), entry);
            legacy_plans.insert(plan_id.clone(), legacy);
            migrated_plan_values.insert(plan_id.clone(), migrated.clone());
            migrated_plans.push((self.plan_path(book_id, plan_id)?, migrated));
        }
        validate_index(&migrated_index, book_id)?;

        let active_overlay = legacy_index
            .active_overlay
            .as_ref()
            .map(|active| migrate_legacy_active_overlay(active, &migrated_index))
            .transpose()?;
        let mut migrated_accepted = Vec::new();
        if let (Some(legacy_active), Some(active)) = (
            legacy_index.active_overlay.as_ref(),
            active_overlay.as_ref(),
        ) {
            let legacy_plan = legacy_plans
                .get(&legacy_active.plan_id)
                .ok_or_else(|| store_corrupt("legacy active plan body is missing"))?;
            let migrated_plan = migrated_plan_values
                .get(&legacy_active.plan_id)
                .ok_or_else(|| store_corrupt("migrated active plan body is missing"))?;
            let expected = expected_private_artifacts(migrated_plan)?;
            let legacy_plan_digest = required_string(legacy_plan, "plan_digest")?;
            let intent_digest = intent_digests
                .get(&legacy_active.intent_id)
                .ok_or_else(|| store_corrupt("legacy active intent digest is missing"))?;
            for artifact in &expected {
                let legacy_path = self
                    .artifact_directory(book_id, &legacy_active.intent_id, &artifact.artifact_id)?
                    .join(LEGACY_ACCEPTED_FILE);
                if !legacy_path.exists() {
                    continue;
                }
                let legacy: LegacyAcceptedIntentArtifactV2 = read_json(&legacy_path)?;
                let legacy_blueprint_digest = legacy_plan
                    .get("private_artifacts")
                    .and_then(Value::as_array)
                    .and_then(|artifacts| {
                        artifacts.iter().find(|candidate| {
                            candidate.get("artifact_id").and_then(Value::as_str)
                                == Some(artifact.artifact_id.as_str())
                        })
                    })
                    .and_then(|artifact| artifact.get("blueprint_digest"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        store_corrupt("legacy active artifact Blueprint digest is missing")
                    })?;
                validate_legacy_accepted_artifact_v2(
                    &legacy,
                    book_id,
                    required_string(legacy_plan, "source_fingerprint")?,
                    legacy_active,
                    intent_digest,
                    legacy_plan_digest,
                    &artifact.artifact_id,
                    legacy_blueprint_digest,
                )?;
                let migrated = migrate_legacy_accepted_artifact_v2(&legacy, active, artifact)?;
                let parsed: AcceptedIntentArtifactV3 = serde_json::from_value(migrated.clone())
                    .map_err(|_| store_corrupt("migrated accepted artifact schema is invalid"))?;
                validate_accepted_artifact_v3(
                    &parsed,
                    book_id,
                    required_string(legacy_plan, "source_fingerprint")?,
                    active,
                    artifact,
                )?;
                migrated_accepted.push((
                    self.artifact_directory(book_id, &active.intent_id, &artifact.artifact_id)?
                        .join(V3_ACCEPTED_FILE),
                    migrated,
                ));
            }
        }

        let mut targets = migrated_intents
            .iter()
            .chain(migrated_plans.iter())
            .chain(migrated_accepted.iter())
            .map(|(path, _)| path)
            .collect::<Vec<_>>();
        let index_path = self.index_path(book_id)?;
        let active_path = self.active_pointer_path(book_id)?;
        targets.push(&index_path);
        if active_overlay.is_some() {
            targets.push(&active_path);
        }
        if targets.iter().any(|path| path.exists()) {
            return Err(conflict(
                "V3 planning/control migration target already exists; migration is create-only",
            ));
        }

        for (path, value) in &migrated_intents {
            write_json_create_only(path, value)?;
        }
        for (path, value) in &migrated_plans {
            write_json_create_only(path, value)?;
        }
        for (path, value) in &migrated_accepted {
            write_json_create_only(path, value)?;
        }
        write_json_create_only(&index_path, &migrated_index)?;
        if let Some(active) = active_overlay.as_ref() {
            write_json_create_only(
                &active_path,
                &ActiveIntentPointerFileV2::from_overlay(book_id, active),
            )?;
        }

        Ok(PlanningControlMigrationReceiptV2ToV3 {
            version: "planning_control_migration.v2_to_v3".into(),
            book_id: book_id.into(),
            intent_count: migrated_index.intents.len(),
            plan_count: migrated_index.plans.len(),
            accepted_artifact_count: migrated_accepted.len(),
            active_overlay,
        })
    }

    pub fn write_intent(&self, intent: &Value) -> Result<IntentIndexEntryV2, ToolError> {
        self.ensure_private()?;
        let entry = parse_intent_entry(intent)?;
        let book_id = required_string(intent, "book_id")?;
        let path = self.intent_path(book_id, &entry.intent_id)?;
        let mut index = self.load_index(book_id)?;
        if let Some(current) = index.intents.get(&entry.intent_id) {
            reject_invalid_revision_step("intent", entry.intent_revision, current.intent_revision)?;
        }
        let body_changed = reconcile_existing_revision(
            &path,
            "intent",
            "intent_revision",
            entry.intent_revision,
            intent,
        )?;
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

    pub fn write_plan(&self, plan: &Value) -> Result<PlanIndexEntryV2, ToolError> {
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
            if entry.intent_revision != Some(intent.intent_revision) {
                return Err(invalid(
                    "plan intent_revision must match the referenced intent owner revision",
                ));
            }
        }
        validate_plan_blueprint_versions(&index, self, book_id, plan)?;
        if let Some(current) = index.plans.get(&entry.plan_id) {
            reject_invalid_revision_step("plan", entry.plan_revision, current.plan_revision)?;
        }
        let body_changed =
            reconcile_existing_revision(&path, "plan", "plan_revision", entry.plan_revision, plan)?;
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
    ) -> Result<RedactedIntentBuildInspectionV2, ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let index = self.load_index(book_id)?;
        let active_overlay = self.load_active_pointer(book_id, &index)?;
        Ok(RedactedIntentBuildInspectionV2 {
            version: "intent_build_inspection.v2".into(),
            book_id: book_id.into(),
            store_revision: index.store_revision,
            intents: index.intents.into_values().collect(),
            plans: index.plans.into_values().collect(),
            active_overlay,
        })
    }

    pub fn set_active_overlay(
        &self,
        book_id: &str,
        active: Option<ActiveIntentOverlayV2>,
    ) -> Result<(), ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let index = self.load_index(book_id)?;
        if let Some(reference) = &active {
            validate_path_safe_id(&reference.intent_id, "active intent_id")?;
            validate_path_safe_id(&reference.plan_id, "active plan_id")?;
            let intent = index
                .intents
                .get(&reference.intent_id)
                .ok_or_else(|| not_found("active intent does not exist"))?;
            let plan = index
                .plans
                .get(&reference.plan_id)
                .ok_or_else(|| not_found("active plan does not exist"))?;
            if intent.intent_revision != reference.intent_revision
                || plan.plan_revision != reference.plan_revision
                || plan.intent_id.as_deref() != Some(reference.intent_id.as_str())
                || plan.intent_revision != Some(reference.intent_revision)
            {
                return Err(invalid(
                    "active pointer does not match the selected intent and plan revisions",
                ));
            }
            if plan.status != "confirmed" && plan.status != "completed" {
                return Err(invalid("active plan must be confirmed or completed"));
            }
        }
        let path = self.active_pointer_path(book_id)?;
        let current = self.load_active_pointer_unchecked(book_id)?;
        if current != active {
            if let Some(active) = active.as_ref() {
                write_json_atomically(
                    &path,
                    &ActiveIntentPointerFileV2::from_overlay(book_id, active),
                )?;
            } else {
                remove_private_path(&path)?;
            }
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
    ) -> Result<IntentArtifactOverlayV2, ToolError> {
        self.read_active_overlay_state(book_id, current_source_fingerprint)
            .map(|(projection, _)| projection)
    }

    pub fn read_active_artifact_access_snapshot(
        &self,
        book_id: &str,
        current_source_fingerprint: &str,
    ) -> Result<ArtifactAccessSnapshot, ToolError> {
        let (projection, artifacts) = self
            .read_active_overlay_state(book_id, current_source_fingerprint)
            .map_err(|error| {
                if error.error_code == INTENT_BUILD_NOT_FOUND {
                    artifact_overlay_unavailable(error.message)
                } else {
                    error
                }
            })?;
        if artifacts.is_empty() {
            return Err(artifact_overlay_unavailable(
                "current active overlay has no accepted artifacts",
            ));
        }
        ArtifactAccessSnapshot::new(
            ArtifactSnapshotScope {
                book_id: projection.book_id,
                source_fingerprint: current_source_fingerprint.into(),
                overlay_identity: format!("{}@{}", projection.plan_id, projection.plan_revision),
            },
            artifacts,
        )
        .map_err(|error| store_corrupt(format!("artifact access snapshot rejected: {error}")))
    }

    fn read_active_overlay_state(
        &self,
        book_id: &str,
        current_source_fingerprint: &str,
    ) -> Result<(IntentArtifactOverlayV2, Vec<ArtifactSnapshotItem>), ToolError> {
        self.ensure_private()?;
        validate_path_safe_id(book_id, "book_id")?;
        let index = self.load_index(book_id)?;
        let active = self
            .load_active_pointer(book_id, &index)?
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
        let mut artifacts = Vec::with_capacity(expected.len());
        let mut access_artifacts = Vec::with_capacity(expected.len());
        for artifact in expected {
            let accepted_path = self
                .artifact_directory(book_id, &active.intent_id, &artifact.artifact_id)?
                .join(V3_ACCEPTED_FILE);
            if !accepted_path.exists() {
                artifacts.push(IntentArtifactProjectionV1 {
                    artifact_id: artifact.artifact_id,
                    artifact_type: artifact.artifact_type,
                    state: "pending".into(),
                    blueprint: artifact.reader_blueprint,
                    payload_digest: None,
                    accepted_at: None,
                    payload: None,
                });
                continue;
            }
            let accepted_value: Value = read_json(&accepted_path)?;
            let accepted: AcceptedIntentArtifactV3 = serde_json::from_value(accepted_value)
                .map_err(|_| store_corrupt("accepted v3 intent artifact schema is invalid"))?;
            validate_accepted_artifact_v3(
                &accepted,
                book_id,
                current_source_fingerprint,
                &active,
                &artifact,
            )?;
            let (access_records, access_relations) = artifact_instance_to_access(
                &accepted.payload,
                &artifact.blueprint_id,
                &artifact.blueprint_version,
            )?;
            let payload_digest = accepted.payload_digest;
            let accepted_at = accepted.accepted_at;
            let payload = accepted.payload;
            access_artifacts.push(ArtifactSnapshotItem {
                artifact_id: artifact.artifact_id.clone(),
                payload_digest: payload_digest.clone(),
                blueprint: artifact.access_blueprint.clone(),
                records: access_records,
                relations: access_relations,
            });
            artifacts.push(IntentArtifactProjectionV1 {
                artifact_id: artifact.artifact_id,
                artifact_type: artifact.artifact_type,
                state: "accepted".into(),
                blueprint: artifact.reader_blueprint,
                payload_digest: Some(payload_digest),
                accepted_at: Some(accepted_at),
                payload: Some(payload),
            });
        }
        Ok((
            IntentArtifactOverlayV2 {
                version: "intent_artifact_overlay.v2".into(),
                book_id: book_id.into(),
                intent_id: active.intent_id,
                intent_revision: active.intent_revision,
                plan_id: active.plan_id,
                plan_revision: active.plan_revision,
                artifacts,
            },
            access_artifacts,
        ))
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
            remove_private_path(&self.legacy_plan_path(book_id, plan_id)?)?;
        }
        index.intents.remove(intent_id);
        for plan_id in plan_ids {
            index.plans.remove(&plan_id);
        }
        if self
            .load_active_pointer_unchecked(book_id)?
            .as_ref()
            .is_some_and(|active| active.intent_id == intent_id)
        {
            remove_private_path(&self.active_pointer_path(book_id)?)?;
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
        Ok(self.book_directory(book_id)?.join(V3_INDEX_FILE))
    }

    fn legacy_index_path(&self, book_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self.book_directory(book_id)?.join(LEGACY_INDEX_FILE))
    }

    fn active_pointer_path(&self, book_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self.book_directory(book_id)?.join(V3_ACTIVE_FILE))
    }

    fn planning_context_path(&self, book_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self.book_directory(book_id)?.join(V2_PLANNING_CONTEXT_FILE))
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
            .join(V3_INTENT_FILE))
    }

    fn legacy_intent_path(&self, book_id: &str, intent_id: &str) -> Result<PathBuf, ToolError> {
        Ok(self
            .intent_directory(book_id, intent_id)?
            .join(LEGACY_INTENT_FILE))
    }

    fn plan_path(&self, book_id: &str, plan_id: &str) -> Result<PathBuf, ToolError> {
        validate_path_safe_id(plan_id, "plan_id")?;
        Ok(self
            .book_directory(book_id)?
            .join("plans")
            .join(format!("{plan_id}{V3_PLAN_SUFFIX}")))
    }

    fn legacy_plan_path(&self, book_id: &str, plan_id: &str) -> Result<PathBuf, ToolError> {
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

    fn load_index(&self, book_id: &str) -> Result<IntentArtifactStoreIndexV2, ToolError> {
        validate_path_safe_id(book_id, "book_id")?;
        let path = self.index_path(book_id)?;
        if !path.exists() {
            return Ok(IntentArtifactStoreIndexV2::empty(book_id));
        }
        let index: IntentArtifactStoreIndexV2 = read_json(&path)?;
        validate_index(&index, book_id)?;
        Ok(index)
    }

    fn write_index(&self, index: &IntentArtifactStoreIndexV2) -> Result<(), ToolError> {
        validate_index(index, &index.book_id)?;
        write_json_atomically(&self.index_path(&index.book_id)?, index)
    }

    fn load_active_pointer_unchecked(
        &self,
        book_id: &str,
    ) -> Result<Option<ActiveIntentOverlayV2>, ToolError> {
        let path = self.active_pointer_path(book_id)?;
        if !path.exists() {
            return Ok(None);
        }
        let pointer: ActiveIntentPointerFileV2 = read_json(&path)?;
        if pointer.version != ACTIVE_POINTER_VERSION || pointer.book_id != book_id {
            return Err(store_corrupt("active intent pointer identity mismatch"));
        }
        validate_path_safe_id(&pointer.intent_id, "active intent_id")?;
        validate_path_safe_id(&pointer.plan_id, "active plan_id")?;
        if pointer.intent_revision == 0 || pointer.plan_revision == 0 {
            return Err(store_corrupt(
                "active intent pointer revisions must be positive",
            ));
        }
        Ok(Some(pointer.overlay()))
    }

    fn load_active_pointer(
        &self,
        book_id: &str,
        index: &IntentArtifactStoreIndexV2,
    ) -> Result<Option<ActiveIntentOverlayV2>, ToolError> {
        let Some(active) = self.load_active_pointer_unchecked(book_id)? else {
            return Ok(None);
        };
        let intent = index
            .intents
            .get(&active.intent_id)
            .ok_or_else(|| store_corrupt("active intent pointer has no index intent"))?;
        let plan = index
            .plans
            .get(&active.plan_id)
            .ok_or_else(|| store_corrupt("active intent pointer has no index plan"))?;
        if intent.intent_revision != active.intent_revision
            || plan.plan_revision != active.plan_revision
            || plan.intent_id.as_deref() != Some(active.intent_id.as_str())
            || plan.intent_revision != Some(active.intent_revision)
        {
            return Err(store_corrupt(
                "active intent pointer does not match indexed owner revisions",
            ));
        }
        Ok(Some(active))
    }
}

fn validate_legacy_index(
    index: &LegacyIntentArtifactStoreIndexV1,
    book_id: &str,
) -> Result<(), ToolError> {
    if index.version != LEGACY_INDEX_VERSION || index.book_id != book_id {
        return Err(store_corrupt("legacy planning index identity mismatch"));
    }
    validate_path_safe_id(&index.book_id, "legacy index book_id")?;
    for (key, entry) in &index.intents {
        if key != &entry.intent_id || entry.revision == 0 || entry.status.trim().is_empty() {
            return Err(store_corrupt(
                "legacy planning index has an invalid intent entry",
            ));
        }
        validate_path_safe_id(key, "legacy index intent_id")?;
    }
    for (key, entry) in &index.plans {
        if key != &entry.plan_id
            || entry.revision == 0
            || entry.status.trim().is_empty()
            || !is_sha256(&entry.plan_digest)
        {
            return Err(store_corrupt(
                "legacy planning index has an invalid plan entry",
            ));
        }
        validate_path_safe_id(key, "legacy index plan_id")?;
        if entry
            .intent_id
            .as_ref()
            .is_some_and(|intent_id| !index.intents.contains_key(intent_id))
        {
            return Err(store_corrupt(
                "legacy planning index plan has a dangling intent",
            ));
        }
    }
    if let Some(active) = &index.active_overlay {
        let intent = index
            .intents
            .get(&active.intent_id)
            .ok_or_else(|| store_corrupt("legacy active overlay intent is missing"))?;
        let plan = index
            .plans
            .get(&active.plan_id)
            .ok_or_else(|| store_corrupt("legacy active overlay plan is missing"))?;
        if plan.intent_id.as_deref() != Some(intent.intent_id.as_str()) {
            return Err(store_corrupt(
                "legacy active overlay plan does not reference its intent",
            ));
        }
    }
    Ok(())
}

fn validate_legacy_intent_v2(
    intent: &Value,
    book_id: &str,
    entry: &LegacyIntentIndexEntryV1,
) -> Result<String, ToolError> {
    if required_string(intent, "version")? != "build_intent.v2"
        || required_string(intent, "intent_id")? != entry.intent_id
        || required_positive_u64(intent, "revision")? != entry.revision
        || required_string(intent, "book_id")? != book_id
        || required_string(intent, "status")? != entry.status
        || required_string(intent, "source_fingerprint")? != entry.source_fingerprint
    {
        return Err(store_corrupt(
            "legacy V2 intent does not match its index entry",
        ));
    }
    canonical_identity_digest(intent, &["created_at", "confirmed_at", "status"])
}

fn validate_legacy_plan_v2(
    plan: &Value,
    book_id: &str,
    entry: &LegacyPlanIndexEntryV1,
    index: &LegacyIntentArtifactStoreIndexV1,
    intent_digests: &BTreeMap<String, String>,
) -> Result<(), ToolError> {
    if required_string(plan, "version")? != "build_plan.v2"
        || required_string(plan, "plan_id")? != entry.plan_id
        || required_positive_u64(plan, "revision")? != entry.revision
        || required_string(plan, "book_id")? != book_id
        || required_string(plan, "status")? != entry.status
        || required_string(plan, "plan_digest")? != entry.plan_digest
        || build_plan_identity_digest(plan)? != entry.plan_digest
    {
        return Err(store_corrupt(
            "legacy V2 plan does not match its index entry or identity",
        ));
    }
    let plan_intent_id = optional_string(plan, "intent_id")?;
    if plan_intent_id != entry.intent_id.as_deref() {
        return Err(store_corrupt(
            "legacy V2 plan intent does not match its index entry",
        ));
    }
    if let Some(intent_id) = plan_intent_id {
        let indexed_intent = index
            .intents
            .get(intent_id)
            .ok_or_else(|| store_corrupt("legacy V2 plan intent is missing"))?;
        if required_string(plan, "source_fingerprint")? != indexed_intent.source_fingerprint
            || required_string(plan, "intent_digest")?
                != intent_digests
                    .get(intent_id)
                    .ok_or_else(|| store_corrupt("legacy V2 plan intent digest is missing"))?
        {
            return Err(store_corrupt(
                "legacy V2 plan does not match its fully read intent",
            ));
        }
    } else if plan.get("intent_digest").is_some() {
        return Err(store_corrupt(
            "legacy standard plan must not contain an intent digest",
        ));
    }
    let artifacts = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| store_corrupt("legacy V2 plan private_artifacts are missing"))?;
    for artifact in artifacts {
        let blueprint = artifact
            .get("blueprint")
            .filter(|value| value.is_object())
            .ok_or_else(|| store_corrupt("legacy V2 plan Blueprint snapshot is missing"))?;
        let expected = canonical_identity_digest(blueprint, &[])?;
        if required_string(artifact, "blueprint_digest")? != expected {
            return Err(store_corrupt(
                "legacy V2 plan Blueprint digest does not match its schema",
            ));
        }
        validate_path_safe_id(required_string(blueprint, "blueprint_id")?, "blueprint_id")?;
        validate_path_safe_id(
            required_string(blueprint, "blueprint_version")?,
            "blueprint_version",
        )?;
    }
    Ok(())
}

fn migrate_legacy_intent_v2(intent: &Value) -> Result<Value, ToolError> {
    let mut migrated = intent
        .as_object()
        .cloned()
        .ok_or_else(|| store_corrupt("legacy V2 intent must be an object"))?;
    let revision = migrated
        .remove("revision")
        .and_then(|value| value.as_u64())
        .filter(|revision| *revision > 0)
        .ok_or_else(|| store_corrupt("legacy V2 intent revision is invalid"))?;
    migrated.insert("version".into(), Value::String("build_intent.v3".into()));
    migrated.insert("intent_revision".into(), Value::from(revision));
    Ok(Value::Object(migrated))
}

fn migrate_legacy_plan_v2(
    plan: &Value,
    index: &LegacyIntentArtifactStoreIndexV1,
) -> Result<Value, ToolError> {
    let mut migrated = plan
        .as_object()
        .cloned()
        .ok_or_else(|| store_corrupt("legacy V2 plan must be an object"))?;
    let revision = migrated
        .remove("revision")
        .and_then(|value| value.as_u64())
        .filter(|revision| *revision > 0)
        .ok_or_else(|| store_corrupt("legacy V2 plan revision is invalid"))?;
    migrated.remove("plan_digest");
    migrated.remove("intent_digest");
    migrated.insert("version".into(), Value::String("build_plan.v3".into()));
    migrated.insert("plan_revision".into(), Value::from(revision));
    if let Some(intent_id) = migrated.get("intent_id").and_then(Value::as_str) {
        let intent_revision = index
            .intents
            .get(intent_id)
            .ok_or_else(|| store_corrupt("legacy V2 plan intent is missing"))?
            .revision;
        migrated.insert("intent_revision".into(), Value::from(intent_revision));
    }
    let artifacts = migrated
        .get_mut("private_artifacts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| store_corrupt("legacy V2 plan private_artifacts are missing"))?;
    for artifact in artifacts {
        let artifact = artifact
            .as_object_mut()
            .ok_or_else(|| store_corrupt("legacy V2 plan artifact must be an object"))?;
        let blueprint = artifact
            .get("blueprint")
            .ok_or_else(|| store_corrupt("legacy V2 plan Blueprint snapshot is missing"))?;
        let blueprint_id = required_string(blueprint, "blueprint_id")?.to_string();
        let blueprint_version = required_string(blueprint, "blueprint_version")?.to_string();
        artifact.remove("blueprint_digest");
        artifact.insert("blueprint_id".into(), Value::String(blueprint_id));
        artifact.insert("blueprint_version".into(), Value::String(blueprint_version));
    }
    Ok(Value::Object(migrated))
}

fn migrate_legacy_active_overlay(
    active: &LegacyActiveIntentOverlayV1,
    index: &IntentArtifactStoreIndexV2,
) -> Result<ActiveIntentOverlayV2, ToolError> {
    let intent = index
        .intents
        .get(&active.intent_id)
        .ok_or_else(|| store_corrupt("migrated active intent is missing"))?;
    let plan = index
        .plans
        .get(&active.plan_id)
        .ok_or_else(|| store_corrupt("migrated active plan is missing"))?;
    if plan.intent_id.as_deref() != Some(active.intent_id.as_str())
        || plan.intent_revision != Some(intent.intent_revision)
        || !matches!(plan.status.as_str(), "confirmed" | "completed")
        || intent.status != "confirmed"
    {
        return Err(store_corrupt(
            "legacy active overlay does not identify a confirmed selection",
        ));
    }
    Ok(ActiveIntentOverlayV2 {
        intent_id: active.intent_id.clone(),
        intent_revision: intent.intent_revision,
        plan_id: active.plan_id.clone(),
        plan_revision: plan.plan_revision,
    })
}

fn migrate_legacy_accepted_artifact_v2(
    accepted: &LegacyAcceptedIntentArtifactV2,
    active: &ActiveIntentOverlayV2,
    artifact: &ExpectedIntentArtifact,
) -> Result<Value, ToolError> {
    let mut payload = accepted
        .payload
        .as_object()
        .cloned()
        .ok_or_else(|| store_corrupt("legacy V2 accepted payload must be an object"))?;
    payload.remove("blueprint_digest");
    payload.insert(
        "version".into(),
        Value::String("artifact_instance.v3".into()),
    );
    payload.insert(
        "blueprint_id".into(),
        Value::String(artifact.blueprint_id.clone()),
    );
    payload.insert(
        "blueprint_version".into(),
        Value::String(artifact.blueprint_version.clone()),
    );
    let payload = Value::Object(payload);
    let payload_digest = crate::sha256_hex(canonical_json(&payload)?.as_bytes());
    Ok(serde_json::json!({
        "version": "intent_artifact_accepted.v3",
        "task_id": accepted.task_id,
        "book_id": accepted.book_id,
        "source_fingerprint": accepted.source_fingerprint,
        "intent_id": active.intent_id,
        "intent_revision": active.intent_revision,
        "plan_id": active.plan_id,
        "plan_revision": active.plan_revision,
        "artifact_id": artifact.artifact_id,
        "blueprint_id": artifact.blueprint_id,
        "blueprint_version": artifact.blueprint_version,
        "payload": payload,
        "payload_digest": payload_digest,
        "accepted_at": accepted.accepted_at,
    }))
}

fn parse_intent_entry(intent: &Value) -> Result<IntentIndexEntryV2, ToolError> {
    if required_string(intent, "version")? != "build_intent.v3" {
        return Err(invalid(
            "production intent storage requires build_intent.v3",
        ));
    }
    let intent_id = required_string(intent, "intent_id")?;
    validate_path_safe_id(intent_id, "intent_id")?;
    let book_id = required_string(intent, "book_id")?;
    validate_path_safe_id(book_id, "book_id")?;
    let intent_revision = required_positive_u64(intent, "intent_revision")?;
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
    Ok(IntentIndexEntryV2 {
        intent_id: intent_id.into(),
        intent_revision,
        status: status.into(),
        source_fingerprint: source_fingerprint.into(),
    })
}

fn parse_plan_entry(plan: &Value) -> Result<PlanIndexEntryV2, ToolError> {
    if required_string(plan, "version")? != "build_plan.v3" {
        return Err(invalid("production plan storage requires build_plan.v3"));
    }
    let plan_id = required_string(plan, "plan_id")?;
    validate_path_safe_id(plan_id, "plan_id")?;
    validate_path_safe_id(required_string(plan, "book_id")?, "book_id")?;
    let plan_revision = required_positive_u64(plan, "plan_revision")?;
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
    let intent_id = optional_string(plan, "intent_id")?;
    if let Some(intent_id) = intent_id {
        validate_path_safe_id(intent_id, "intent_id")?;
    }
    let intent_revision = optional_positive_u64(plan, "intent_revision")?;
    if intent_id.is_some() != intent_revision.is_some() {
        return Err(invalid(
            "plan intent_id and intent_revision must be present together",
        ));
    }
    validate_private_artifact_identities(plan)?;
    Ok(PlanIndexEntryV2 {
        plan_id: plan_id.into(),
        plan_revision,
        status: status.into(),
        intent_id: intent_id.map(str::to_string),
        intent_revision,
    })
}

fn plan_blueprints(plan: &Value) -> Result<BTreeMap<(String, String), Value>, ToolError> {
    let artifacts = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("BuildPlan private_artifacts must be an array"))?;
    let mut blueprints = BTreeMap::new();
    for artifact in artifacts {
        let blueprint = artifact
            .get("blueprint")
            .filter(|value| value.is_object())
            .ok_or_else(|| invalid("BuildPlan artifact requires a Blueprint snapshot"))?;
        let blueprint_id = required_string(artifact, "blueprint_id")?;
        let blueprint_version = required_string(artifact, "blueprint_version")?;
        validate_path_safe_id(blueprint_id, "blueprint_id")?;
        validate_path_safe_id(blueprint_version, "blueprint_version")?;
        if required_string(blueprint, "blueprint_id")? != blueprint_id
            || required_string(blueprint, "blueprint_version")? != blueprint_version
        {
            return Err(invalid(
                "BuildPlan Blueprint id/version does not match its frozen schema",
            ));
        }
        let key = (blueprint_id.to_string(), blueprint_version.to_string());
        if let Some(existing) = blueprints.get(&key) {
            if existing != blueprint {
                return Err(conflict(
                    "same Blueprint id/version has different schema in one BuildPlan",
                ));
            }
        } else {
            blueprints.insert(key, blueprint.clone());
        }
    }
    Ok(blueprints)
}

fn validate_private_artifact_identities(plan: &Value) -> Result<(), ToolError> {
    plan_blueprints(plan).map(|_| ())
}

fn validate_plan_blueprint_versions(
    index: &IntentArtifactStoreIndexV2,
    store: &IntentArtifactStore,
    book_id: &str,
    candidate: &Value,
) -> Result<(), ToolError> {
    let candidate_blueprints = plan_blueprints(candidate)?;
    if candidate_blueprints.is_empty() {
        return Ok(());
    }
    for entry in index.plans.values() {
        let existing = store.read_plan(book_id, &entry.plan_id)?;
        for (identity, schema) in plan_blueprints(&existing)? {
            if candidate_blueprints
                .get(&identity)
                .is_some_and(|candidate_schema| candidate_schema != &schema)
            {
                return Err(conflict(
                    "same Blueprint id/version already exists with different schema",
                ));
            }
        }
    }
    Ok(())
}

fn validate_active_selection(
    book_id: &str,
    current_source_fingerprint: &str,
    active: &ActiveIntentOverlayV2,
    plan_entry: &PlanIndexEntryV2,
    plan: &Value,
    intent: &Value,
) -> Result<(), ToolError> {
    let intent_version = required_string(intent, "version")?;
    let plan_version = required_string(plan, "version")?;
    if intent_version != "build_intent.v3" || plan_version != "build_plan.v3" {
        return Err(store_corrupt(
            "active intent artifact overlay contract versions do not match",
        ));
    }
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
        || required_positive_u64(intent, "intent_revision")? != active.intent_revision
        || required_positive_u64(plan, "intent_revision")? != active.intent_revision
        || required_positive_u64(plan, "plan_revision")? != active.plan_revision
        || plan_entry.plan_revision != active.plan_revision
        || plan_entry.intent_revision != Some(active.intent_revision)
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
    if required_string(plan, "version")? != "build_plan.v3" {
        return Err(store_corrupt(
            "active planning state must use build_plan.v3",
        ));
    }
    let values = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| store_corrupt("active goal plan private_artifacts are missing"))?;
    let mut seen = std::collections::BTreeSet::new();
    values
        .iter()
        .map(|value| {
            let artifact_id = required_string(value, "artifact_id")?;
            let blueprint = value.get("blueprint").ok_or_else(|| {
                store_corrupt("active V3 goal plan contains no Blueprint snapshot")
            })?;
            let blueprint_id = required_string(value, "blueprint_id")?;
            let blueprint_version = required_string(value, "blueprint_version")?;
            if required_string(blueprint, "blueprint_id")? != blueprint_id
                || required_string(blueprint, "blueprint_version")? != blueprint_version
            {
                return Err(store_corrupt(
                    "active V3 plan Blueprint identity does not match its frozen schema",
                ));
            }
            let artifact_type = compatibility_artifact_type(blueprint_id);
            // ArtifactAccessSnapshot still consumes one compact schema content identity. It is
            // derived only for that downstream snapshot and is not persisted as planning identity.
            let access_blueprint_digest = canonical_identity_digest(blueprint, &[])?;
            validate_path_safe_id(artifact_id, "artifact_id")?;
            if !seen.insert(artifact_id.to_string()) {
                return Err(store_corrupt(
                    "active goal plan contains duplicate private artifact ids",
                ));
            }
            Ok(ExpectedIntentArtifact {
                artifact_id: artifact_id.into(),
                artifact_type: artifact_type.into(),
                blueprint_id: blueprint_id.into(),
                blueprint_version: blueprint_version.into(),
                access_blueprint: artifact_blueprint_to_access(
                    blueprint,
                    &access_blueprint_digest,
                )?,
                reader_blueprint: artifact_blueprint_to_display(blueprint)?,
            })
        })
        .collect()
}

fn canonical_identity_digest(value: &Value, omitted_fields: &[&str]) -> Result<String, ToolError> {
    let mut identity = value
        .as_object()
        .cloned()
        .ok_or_else(|| store_corrupt("reader-private identity must be a JSON object"))?;
    for field in omitted_fields {
        identity.remove(*field);
    }
    let canonical = canonical_json(&Value::Object(identity))?;
    Ok(crate::sha256_hex(canonical.as_bytes()))
}

fn build_plan_identity_digest(plan: &Value) -> Result<String, ToolError> {
    let object = plan
        .as_object()
        .ok_or_else(|| store_corrupt("stored BuildPlan must be a JSON object"))?;
    let mut identity = serde_json::Map::new();
    for field in [
        "source_fingerprint",
        "content_profile",
        "recipe_id",
        "public_stage_closure",
        "private_artifacts",
        "reuse",
        "create",
        "excluded",
        "budget",
    ] {
        identity.insert(
            field.into(),
            object
                .get(field)
                .cloned()
                .ok_or_else(|| store_corrupt(format!("stored BuildPlan is missing {field}")))?,
        );
    }
    if let Some(intent_digest) = object.get("intent_digest") {
        identity.insert("intent_digest".into(), intent_digest.clone());
    }
    canonical_identity_digest(&Value::Object(identity), &[])
}

fn compatibility_artifact_type(blueprint_id: &str) -> &str {
    match blueprint_id {
        "system.timeline" => "timeline",
        "system.concept_map" => "concept_map",
        "system.comparison_table" => "comparison_table",
        "system.argument_map" => "argument_map",
        _ => "custom",
    }
}

fn artifact_blueprint_to_access(
    input: &Value,
    blueprint_digest: &str,
) -> Result<ArtifactSnapshotBlueprint, ToolError> {
    let blueprint: ArtifactBlueprintForAccessV1 = serde_json::from_value(input.clone())
        .map_err(|_| store_corrupt("active V2 goal plan Blueprint schema is invalid"))?;
    if blueprint.version != "artifact_blueprint.v1"
        || blueprint.blueprint_id.trim().is_empty()
        || blueprint.blueprint_version.trim().is_empty()
        || !matches!(
            blueprint.origin.as_str(),
            "system" | "user_private" | "one_off"
        )
        || !matches!(
            blueprint.shape.as_str(),
            "collection" | "table" | "graph" | "sequence" | "document"
        )
        || !blueprint.record_schema.is_object()
        || blueprint
            .relation_schema
            .as_ref()
            .is_some_and(|schema| !schema.is_object())
        || !blueprint.evidence_policy.is_object()
        || !blueprint.limits.is_object()
        || blueprint.search_fields.iter().any(|field| {
            !(1..=10).contains(&field.weight)
                || !matches!(field.analyzer.as_str(), "text" | "keyword")
        })
    {
        return Err(store_corrupt(
            "active V2 goal plan Blueprint access metadata is invalid",
        ));
    }
    Ok(ArtifactSnapshotBlueprint {
        blueprint_digest: blueprint_digest.into(),
        title: blueprint.title,
        purpose: blueprint.purpose,
        use_when: blueprint.routing.use_when,
        avoid_when: blueprint.routing.avoid_when,
        covered_topics: blueprint.routing.covered_topics,
        scope_label: blueprint.routing.scope_label,
        search_fields: blueprint
            .search_fields
            .into_iter()
            .map(|field| ArtifactSnapshotSearchField {
                path: field.path,
                weight: field.weight as u8,
                analyzer: if field.analyzer == "text" {
                    ArtifactSearchAnalyzer::Text
                } else {
                    ArtifactSearchAnalyzer::Keyword
                },
            })
            .collect(),
        summary_fields: blueprint.summary_fields,
    })
}

fn artifact_blueprint_to_display(
    input: &Value,
) -> Result<IntentArtifactDisplayBlueprintV1, ToolError> {
    let blueprint: ArtifactBlueprintForAccessV1 = serde_json::from_value(input.clone())
        .map_err(|_| store_corrupt("active V2 goal plan Blueprint display metadata is invalid"))?;
    if !matches!(
        blueprint.shape.as_str(),
        "collection" | "table" | "graph" | "sequence" | "document"
    ) {
        return Err(store_corrupt(
            "active V2 goal plan Blueprint display shape is invalid",
        ));
    }
    Ok(IntentArtifactDisplayBlueprintV1 {
        title: blueprint.title,
        purpose: blueprint.purpose,
        shape: blueprint.shape,
        summary_fields: blueprint.summary_fields,
    })
}

fn artifact_instance_to_access(
    payload: &Value,
    blueprint_id: &str,
    blueprint_version: &str,
) -> Result<(Vec<ArtifactSnapshotRecord>, Vec<ArtifactSnapshotRelation>), ToolError> {
    let instance: ArtifactInstanceForAccessV3 = serde_json::from_value(payload.clone())
        .map_err(|_| store_corrupt("accepted v3 ArtifactInstance schema is invalid"))?;
    if instance.version != "artifact_instance.v3"
        || instance.blueprint_id != blueprint_id
        || instance.blueprint_version != blueprint_version
    {
        return Err(store_corrupt(
            "accepted v3 ArtifactInstance identity is invalid",
        ));
    }
    Ok((
        instance
            .records
            .into_iter()
            .map(|record| ArtifactSnapshotRecord {
                record_id: record.record_id,
                data: record.data,
                evidence_lids: record.evidence_lids,
            })
            .collect(),
        instance
            .relations
            .into_iter()
            .map(|relation| ArtifactSnapshotRelation {
                relation_id: relation.relation_id,
                source_record_id: relation.source,
                target_record_id: relation.target,
                data: relation.data,
                evidence_lids: relation.evidence_lids,
            })
            .collect(),
    ))
}

fn validate_legacy_accepted_artifact_v2(
    accepted: &LegacyAcceptedIntentArtifactV2,
    book_id: &str,
    current_source_fingerprint: &str,
    active: &LegacyActiveIntentOverlayV1,
    intent_digest: &str,
    plan_digest: &str,
    artifact_id: &str,
    blueprint_digest: &str,
) -> Result<(), ToolError> {
    if accepted.version != "intent_artifact_accepted.v2"
        || accepted.book_id != book_id
        || accepted.source_fingerprint != current_source_fingerprint
        || accepted.intent_id != active.intent_id
        || accepted.intent_digest != intent_digest
        || accepted.plan_id != active.plan_id
        || accepted.plan_digest != plan_digest
        || accepted.artifact_id != artifact_id
        || accepted.blueprint_digest != blueprint_digest
        || accepted.task_id.trim().is_empty()
        || accepted.accepted_at.trim().is_empty()
        || !is_sha256(&accepted.payload_digest)
    {
        return Err(store_corrupt(
            "accepted v2 intent artifact identity does not match the active overlay",
        ));
    }
    let payload = accepted.payload.as_object().ok_or_else(|| {
        store_corrupt("accepted v2 intent artifact payload must be an ArtifactInstance object")
    })?;
    if payload.get("version").and_then(Value::as_str) != Some("artifact_instance.v2")
        || payload.get("blueprint_digest").and_then(Value::as_str) != Some(blueprint_digest)
        || !payload.get("records").is_some_and(Value::is_array)
        || payload
            .get("relations")
            .is_some_and(|relations| !relations.is_array())
    {
        return Err(store_corrupt(
            "accepted v2 intent artifact payload identity is invalid",
        ));
    }
    let canonical = canonical_json(&accepted.payload)?;
    if crate::sha256_hex(canonical.as_bytes()) != accepted.payload_digest {
        return Err(store_corrupt(
            "accepted v2 intent artifact payload_digest does not match payload",
        ));
    }
    Ok(())
}

fn validate_accepted_artifact_v3(
    accepted: &AcceptedIntentArtifactV3,
    book_id: &str,
    current_source_fingerprint: &str,
    active: &ActiveIntentOverlayV2,
    artifact: &ExpectedIntentArtifact,
) -> Result<(), ToolError> {
    if accepted.version != "intent_artifact_accepted.v3"
        || accepted.book_id != book_id
        || accepted.source_fingerprint != current_source_fingerprint
        || accepted.intent_id != active.intent_id
        || accepted.intent_revision != active.intent_revision
        || accepted.plan_id != active.plan_id
        || accepted.plan_revision != active.plan_revision
        || accepted.artifact_id != artifact.artifact_id
        || accepted.blueprint_id != artifact.blueprint_id
        || accepted.blueprint_version != artifact.blueprint_version
        || accepted.task_id.trim().is_empty()
        || accepted.accepted_at.trim().is_empty()
        || !is_sha256(&accepted.payload_digest)
    {
        return Err(store_corrupt(
            "accepted v3 intent artifact identity does not match the active pointer",
        ));
    }
    let payload = accepted.payload.as_object().ok_or_else(|| {
        store_corrupt("accepted v3 intent artifact payload must be an ArtifactInstance object")
    })?;
    if payload.get("version").and_then(Value::as_str) != Some("artifact_instance.v3")
        || payload.get("blueprint_id").and_then(Value::as_str)
            != Some(artifact.blueprint_id.as_str())
        || payload.get("blueprint_version").and_then(Value::as_str)
            != Some(artifact.blueprint_version.as_str())
        || !payload.get("records").is_some_and(Value::is_array)
        || payload
            .get("relations")
            .is_some_and(|relations| !relations.is_array())
    {
        return Err(store_corrupt(
            "accepted v3 intent artifact payload identity is invalid",
        ));
    }
    let canonical = canonical_json(&accepted.payload)?;
    if crate::sha256_hex(canonical.as_bytes()) != accepted.payload_digest {
        return Err(store_corrupt(
            "accepted v3 intent artifact payload_digest does not match payload",
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

fn validate_owned_planning_context_v2(
    context: &Value,
    book_id: &str,
    context_id: &str,
) -> Result<u64, ToolError> {
    if required_string(context, "version")? != "build_planning_context.v2"
        || required_string(context, "context_id")? != context_id
        || context
            .get("target")
            .and_then(|target| target.get("book_id"))
            .and_then(Value::as_str)
            != Some(book_id)
        || context.get("context_digest").is_some()
        || context
            .get("blueprint_registry")
            .and_then(Value::as_array)
            .is_none_or(|entries| entries.iter().any(|entry| entry.get("digest").is_some()))
    {
        return Err(store_corrupt(
            "owned BuildPlanningContext identity or body is invalid",
        ));
    }
    required_positive_u64(context, "context_revision")
}

fn validate_index(index: &IntentArtifactStoreIndexV2, book_id: &str) -> Result<(), ToolError> {
    if index.version != INDEX_VERSION || index.book_id != book_id {
        return Err(store_corrupt("intent artifact index identity mismatch"));
    }
    validate_path_safe_id(&index.book_id, "index book_id")?;
    for (key, entry) in &index.intents {
        if key != &entry.intent_id || entry.intent_revision == 0 {
            return Err(store_corrupt(
                "intent artifact index contains an invalid intent entry",
            ));
        }
        validate_path_safe_id(key, "index intent_id")?;
    }
    for (key, entry) in &index.plans {
        if key != &entry.plan_id
            || entry.plan_revision == 0
            || entry.intent_id.is_some() != entry.intent_revision.is_some()
        {
            return Err(store_corrupt(
                "intent artifact index contains an invalid plan entry",
            ));
        }
        validate_path_safe_id(key, "index plan_id")?;
        if let (Some(intent_id), Some(intent_revision)) = (&entry.intent_id, entry.intent_revision)
        {
            let intent = index
                .intents
                .get(intent_id)
                .ok_or_else(|| store_corrupt("intent artifact index plan has a dangling intent"))?;
            if intent.intent_revision < intent_revision {
                return Err(store_corrupt(
                    "intent artifact index plan references a future intent revision",
                ));
            }
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

fn required_positive_u64(value: &Value, field: &str) -> Result<u64, ToolError> {
    value
        .as_object()
        .and_then(|object| object.get(field))
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| invalid(format!("{field} must be a positive integer")))
}

fn optional_positive_u64(value: &Value, field: &str) -> Result<Option<u64>, ToolError> {
    let Some(field_value) = value.as_object().and_then(|object| object.get(field)) else {
        return Ok(None);
    };
    field_value
        .as_u64()
        .filter(|revision| *revision > 0)
        .map(Some)
        .ok_or_else(|| invalid(format!("{field} must be a positive integer when present")))
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

fn reject_invalid_revision_step(kind: &str, candidate: u64, current: u64) -> Result<(), ToolError> {
    if candidate < current {
        return Err(conflict(format!("{kind} revision cannot move backward")));
    }
    if candidate > current.saturating_add(1) {
        return Err(conflict(format!(
            "{kind} revision must be issued monotonically"
        )));
    }
    Ok(())
}

fn reconcile_existing_revision(
    path: &Path,
    kind: &str,
    revision_field: &str,
    candidate_revision: u64,
    candidate: &Value,
) -> Result<bool, ToolError> {
    if !path.exists() {
        return Ok(true);
    }
    let existing: Value = read_json(path)?;
    let existing_revision = required_positive_u64(&existing, revision_field)?;
    reject_invalid_revision_step(kind, candidate_revision, existing_revision)?;
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

fn write_json_create_only<T: Serialize>(path: &Path, value: &T) -> Result<(), ToolError> {
    if path.exists() {
        return Err(conflict(
            "V3 planning/control migration target already exists; migration is create-only",
        ));
    }
    write_json_atomically(path, value)
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

fn artifact_overlay_unavailable(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: ARTIFACT_OVERLAY_UNAVAILABLE.into(),
        category: "unavailable".into(),
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

    const BUILD_INTENT_V1_GOLDEN: &str =
        include_str!("../../../packages/core/test/fixtures/build-intent.v1.golden.json");
    const BUILD_INTENT_V2_GOLDEN: &str =
        include_str!("../../../packages/core/test/fixtures/build-intent.v2.golden.json");
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
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let mut intent = golden["intent"].clone();
        intent["version"] = json!("build_intent.v3");
        intent["intent_id"] = json!(intent_id);
        intent["intent_revision"] = json!(revision);
        intent["book_id"] = json!(book_id);
        intent["user_goal"] = json!(goal);
        intent.as_object_mut().unwrap().remove("revision");
        intent
    }

    fn plan(book_id: &str, plan_id: &str, intent_id: &str, revision: u64) -> serde_json::Value {
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let mut plan = golden["plan"].clone();
        plan["version"] = json!("build_plan.v3");
        plan["plan_id"] = json!(plan_id);
        plan["plan_revision"] = json!(revision);
        plan["book_id"] = json!(book_id);
        plan["intent_id"] = json!(intent_id);
        plan["intent_revision"] = json!(revision);
        plan.as_object_mut().unwrap().remove("revision");
        plan.as_object_mut().unwrap().remove("intent_digest");
        plan.as_object_mut().unwrap().remove("plan_digest");
        let artifact = plan["private_artifacts"][0].as_object_mut().unwrap();
        artifact.remove("blueprint_digest");
        let blueprint = artifact["blueprint"].clone();
        artifact.insert("blueprint_id".into(), blueprint["blueprint_id"].clone());
        artifact.insert(
            "blueprint_version".into(),
            blueprint["blueprint_version"].clone(),
        );
        plan
    }

    fn v3_selection() -> (Value, Value) {
        (
            intent("paper-a", "intent-001", 1, "private v2 goal"),
            plan("paper-a", "plan-001", "intent-001", 1),
        )
    }

    fn legacy_v2_selection() -> (Value, Value) {
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        (golden["intent"].clone(), golden["plan"].clone())
    }

    fn v3_payload(plan: &Value, legacy_payload: Value) -> Value {
        let artifact = &plan["private_artifacts"][0];
        let mut payload = legacy_payload.as_object().cloned().unwrap();
        payload.remove("blueprint_digest");
        payload.insert("version".into(), json!("artifact_instance.v3"));
        payload.insert("blueprint_id".into(), artifact["blueprint_id"].clone());
        payload.insert(
            "blueprint_version".into(),
            artifact["blueprint_version"].clone(),
        );
        Value::Object(payload)
    }

    fn accepted_artifact_v3(plan: &Value, payload: Value) -> Value {
        let artifact = &plan["private_artifacts"][0];
        let payload_digest = crate::sha256_hex(canonical_json(&payload).unwrap().as_bytes());
        json!({
            "version": "intent_artifact_accepted.v3",
            "task_id": "intent-artifact-task-001",
            "book_id": plan["book_id"],
            "source_fingerprint": plan["source_fingerprint"],
            "intent_id": plan["intent_id"],
            "intent_revision": plan["intent_revision"],
            "plan_id": plan["plan_id"],
            "plan_revision": plan["plan_revision"],
            "artifact_id": artifact["artifact_id"],
            "blueprint_id": artifact["blueprint_id"],
            "blueprint_version": artifact["blueprint_version"],
            "payload": payload,
            "payload_digest": payload_digest,
            "accepted_at": "2026-07-29T12:00:00.000Z"
        })
    }

    fn legacy_accepted_artifact_v2(plan: &Value, payload: Value) -> Value {
        let artifact = &plan["private_artifacts"][0];
        let blueprint_digest = artifact["blueprint_digest"].as_str().unwrap();
        let payload_digest = crate::sha256_hex(canonical_json(&payload).unwrap().as_bytes());
        json!({
            "version": "intent_artifact_accepted.v2",
            "task_id": "intent-artifact-task-001",
            "book_id": plan["book_id"],
            "source_fingerprint": plan["source_fingerprint"],
            "intent_id": plan["intent_id"],
            "intent_digest": plan["intent_digest"],
            "plan_id": plan["plan_id"],
            "plan_digest": plan["plan_digest"],
            "artifact_id": artifact["artifact_id"],
            "blueprint_digest": blueprint_digest,
            "payload": payload,
            "payload_digest": payload_digest,
            "accepted_at": "2026-07-29T12:00:00.000Z"
        })
    }

    #[test]
    fn issues_planning_context_revision_only_when_the_bounded_body_changes() {
        let root = test_dir("planning-context-revision");
        let store = IntentArtifactStore::open(&root).unwrap();
        let body = json!({
            "version": "build_planning_context.v2",
            "target": {
                "book_id": "paper-a",
                "source_fingerprint": "a".repeat(64),
                "content_profile": "paper",
                "candidate_contract_version": "build_intent_planner_candidate.v2"
            },
            "scope_catalog": {
                "available_lids": ["1.1"],
                "available_lid_count": 1,
                "available_sections": [],
                "available_section_count": 0,
                "truncated": false,
                "whole_book_allowed": true
            },
            "blueprint_registry": [],
            "blueprint_registry_count": 0,
            "blueprint_registry_truncated": false,
            "candidate_contract": {
                "version": "build_intent_planner_candidate.v2",
                "max_artifacts": 16,
                "allowed_shapes": ["collection", "table", "graph", "sequence", "document"],
                "one_off_blueprint_version": "artifact_blueprint.v1"
            }
        });

        let first = store.issue_planning_context_v2("paper-a", &body).unwrap();
        assert_eq!(first["context_id"], "context-paper-a");
        assert_eq!(first["context_revision"], 1);
        assert!(first.get("context_digest").is_none());
        assert_eq!(
            store.issue_planning_context_v2("paper-a", &body).unwrap(),
            first
        );

        let mut changed = body;
        changed["scope_catalog"]["available_lids"] = json!(["1.1", "1.2"]);
        changed["scope_catalog"]["available_lid_count"] = json!(2);
        let second = store
            .issue_planning_context_v2("paper-a", &changed)
            .unwrap();
        assert_eq!(second["context_revision"], 2);

        let reopened = IntentArtifactStore::open(&root).unwrap();
        assert_eq!(
            reopened
                .issue_planning_context_v2("paper-a", &changed)
                .unwrap(),
            second
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_identity_digests_match_core_v1_and_v2_goldens() {
        for body in [BUILD_INTENT_V1_GOLDEN, BUILD_INTENT_V2_GOLDEN] {
            let golden: Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                canonical_identity_digest(
                    &golden["intent"],
                    &["created_at", "confirmed_at", "status"]
                )
                .unwrap(),
                golden["intent_digest"].as_str().unwrap()
            );
            assert_eq!(
                build_plan_identity_digest(&golden["plan"]).unwrap(),
                golden["plan"]["plan_digest"].as_str().unwrap()
            );
        }

        let v2: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let artifact = &v2["plan"]["private_artifacts"][0];
        assert_eq!(
            canonical_identity_digest(&artifact["blueprint"], &[]).unwrap(),
            artifact["blueprint_digest"].as_str().unwrap()
        );
        assert_eq!(
            canonical_identity_digest(&v2["payload"], &[]).unwrap(),
            v2["payload_digest"].as_str().unwrap()
        );
        assert_eq!(
            canonical_json(&v2["canonical_number_cases"]["values"]).unwrap(),
            v2["canonical_number_cases"]["json"].as_str().unwrap()
        );
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
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 1))
            .unwrap();
        store
            .write_intent(&intent("paper-a", "intent-001", 2, "revised private goal"))
            .unwrap();
        store
            .write_plan(&plan("paper-a", "plan-001", "intent-001", 2))
            .unwrap();

        assert!(!book_dir.join("intents").exists());
        assert!(!book_dir.join("plans").exists());
        assert!(root
            .join("paper-a/intents/intent-001/intent.v3.json")
            .exists());
        let reopened = IntentArtifactStore::open(&root).unwrap();
        assert_eq!(
            reopened.read_intent("paper-a", "intent-001").unwrap()["intent_revision"],
            2
        );
        assert_eq!(
            reopened.read_plan("paper-a", "plan-001").unwrap()["plan_revision"],
            2
        );
        let inspection = reopened.inspect_redacted("paper-a").unwrap();
        let public_json = serde_json::to_string(&inspection).unwrap();
        assert_eq!(inspection.intents[0].intent_revision, 2);
        assert_eq!(inspection.plans[0].plan_revision, 2);
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
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 1,
                }),
            )
            .unwrap();

        let accepted = root.join("paper-a/artifacts/intent-001/artifact-001/accepted.v3.json");
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
        assert!(!root.join("paper-a/plans/plan-001.v3.json").exists());
        assert!(!root.join("paper-a/artifacts/intent-001").exists());
        assert!(!store.hard_delete_intent("paper-a", "intent-001").unwrap());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_only_identity_valid_v3_artifacts_from_the_active_overlay_and_reopens() {
        use artifact_tools::{ArtifactListInput, ArtifactReadInput};

        let root = test_dir("active-artifacts");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = v3_selection();
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 1,
                }),
            )
            .unwrap();

        let pending = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(pending.version, "intent_artifact_overlay.v2");
        assert_eq!(pending.intent_revision, 1);
        assert_eq!(pending.plan_revision, 1);
        assert_eq!(pending.artifacts.len(), 1);
        assert_eq!(pending.artifacts[0].state, "pending");
        assert!(pending.artifacts[0].payload.is_none());
        let pending_projection = serde_json::to_value(&pending).unwrap();
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["title"],
            "Timeline"
        );
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["shape"],
            "sequence"
        );
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["summary_fields"],
            json!(["/label", "/order_hint"])
        );

        let accepted_path = store
            .artifact_directory(
                "paper-a",
                "intent-001",
                plan["private_artifacts"][0]["artifact_id"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .join("accepted.v3.json");
        let private_payload = v3_payload(&plan, golden["payload"].clone());
        write_json_atomically(
            &accepted_path,
            &accepted_artifact_v3(&plan, private_payload.clone()),
        )
        .unwrap();

        let reopened = IntentArtifactStore::open(&root).unwrap();
        let projection = reopened
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].state, "accepted");
        assert_eq!(
            projection.artifacts[0].payload,
            Some(private_payload.clone())
        );
        assert!(projection.artifacts[0].payload_digest.is_some());
        let snapshot = reopened
            .read_active_artifact_access_snapshot("paper-a", "source-a")
            .unwrap();
        let list = snapshot.list(ArtifactListInput::default()).unwrap();
        assert_eq!(list.artifacts[0].title, "Timeline");
        let read = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: None,
            })
            .unwrap();
        assert_eq!(
            read.records[0].data["label"],
            "PRIVATE_V2_ARTIFACT_SENTINEL"
        );
        let redacted =
            serde_json::to_string(&reopened.inspect_redacted("paper-a").unwrap()).unwrap();
        assert!(!redacted.contains("private v2 goal"));
        assert!(!redacted.contains("PRIVATE_V2_ARTIFACT_SENTINEL"));

        let mut stale = accepted_artifact_v3(&plan, private_payload);
        stale["plan_revision"] = json!(2);
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
    fn projects_v3_instances_and_rejects_blueprint_identity_or_payload_drift() {
        let root = test_dir("active-artifacts-v3");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = v3_selection();
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 1,
                }),
            )
            .unwrap();
        let artifact_id = plan["private_artifacts"][0]["artifact_id"]
            .as_str()
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", artifact_id)
            .unwrap()
            .join("accepted.v3.json");
        let instance = v3_payload(&plan, golden["payload"].clone());
        write_json_atomically(
            &accepted_path,
            &accepted_artifact_v3(&plan, instance.clone()),
        )
        .unwrap();
        let projection = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].artifact_type, "timeline");
        assert_eq!(projection.artifacts[0].payload, Some(instance.clone()));
        let reader_projection = serde_json::to_value(&projection).unwrap();
        assert_eq!(
            reader_projection["artifacts"][0]["blueprint"]["title"],
            "Timeline"
        );
        assert_eq!(
            reader_projection["artifacts"][0]["blueprint"]["shape"],
            "sequence"
        );
        assert!(reader_projection["artifacts"][0]["blueprint"]
            .get("blueprint_digest")
            .is_none());

        let mut drifted = accepted_artifact_v3(&plan, instance.clone());
        drifted["blueprint_version"] = json!("2.0.0");
        write_json_atomically(&accepted_path, &drifted).unwrap();
        assert_eq!(
            store
                .read_active_overlay_artifacts("paper-a", "source-a")
                .unwrap_err()
                .error_code,
            "INTENT_BUILD_STORE_CORRUPT"
        );

        let (_, legacy_plan) = legacy_v2_selection();
        let legacy = legacy_accepted_artifact_v2(&legacy_plan, golden["payload"].clone());
        write_json_atomically(&accepted_path, &legacy).unwrap();
        assert_eq!(
            store
                .read_active_overlay_artifacts("paper-a", "source-a")
                .unwrap_err()
                .error_code,
            "INTENT_BUILD_STORE_CORRUPT"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn builds_a_frozen_bounded_snapshot_only_from_current_accepted_v3_artifacts() {
        use artifact_tools::{ArtifactListInput, ArtifactReadInput};

        let root = test_dir("artifact-access-snapshot-v3");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = v3_selection();
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 1,
                }),
            )
            .unwrap();
        assert_eq!(
            store
                .read_active_artifact_access_snapshot("paper-a", "source-a")
                .err()
                .unwrap()
                .error_code,
            ARTIFACT_OVERLAY_UNAVAILABLE
        );

        let artifact_id = plan["private_artifacts"][0]["artifact_id"]
            .as_str()
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", artifact_id)
            .unwrap()
            .join("accepted.v3.json");
        let payload = v3_payload(&plan, golden["payload"].clone());
        write_json_atomically(&accepted_path, &accepted_artifact_v3(&plan, payload)).unwrap();

        let snapshot = store
            .read_active_artifact_access_snapshot("paper-a", "source-a")
            .unwrap();
        let list = snapshot.list(ArtifactListInput::default()).unwrap();
        assert_eq!(list.artifacts.len(), 1);
        assert_eq!(list.artifacts[0].title, "Timeline");
        assert_eq!(list.artifacts[0].record_count, 1);
        let list_body = serde_json::to_string(&list).unwrap();
        assert!(!list_body.contains(artifact_id));
        assert!(!list_body.contains("private v2 goal"));
        assert!(!list_body.contains(plan["plan_id"].as_str().unwrap()));

        let read = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: None,
            })
            .unwrap();
        assert_eq!(read.records.len(), 1);
        assert_eq!(
            read.records[0].data["label"],
            "PRIVATE_V2_ARTIFACT_SENTINEL"
        );
        assert_eq!(read.records[0].evidence_lids, ["1.1"]);

        store.hard_delete_intent("paper-a", "intent-001").unwrap();
        assert_eq!(
            store
                .read_active_artifact_access_snapshot("paper-a", "source-a")
                .err()
                .unwrap()
                .error_code,
            ARTIFACT_OVERLAY_UNAVAILABLE
        );
        let frozen = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: None,
            })
            .unwrap();
        assert_eq!(frozen.records, read.records);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_same_version_blueprint_body_and_recomputes_payload_identity() {
        let root = test_dir("active-artifacts-v3-direct-identity");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = v3_selection();
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 1,
                }),
            )
            .unwrap();
        let artifact_id = plan["private_artifacts"][0]["artifact_id"]
            .as_str()
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", artifact_id)
            .unwrap()
            .join("accepted.v3.json");
        let accepted = accepted_artifact_v3(&plan, v3_payload(&plan, golden["payload"].clone()));
        write_json_atomically(&accepted_path, &accepted).unwrap();
        store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();

        let mut drifted_accepted = accepted.clone();
        drifted_accepted["payload"]["records"][0]["data"]["label"] = json!("tampered payload body");
        write_json_atomically(&accepted_path, &drifted_accepted).unwrap();
        let error = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap_err();
        assert_eq!(error.error_code, "INTENT_BUILD_STORE_CORRUPT");
        assert!(error.message.contains("payload_digest"));
        write_json_atomically(&accepted_path, &accepted).unwrap();

        let mut drifted_blueprint_plan = plan.clone();
        drifted_blueprint_plan["plan_id"] = json!("plan-002");
        drifted_blueprint_plan["private_artifacts"][0]["blueprint"]["title"] =
            json!("tampered Blueprint snapshot");
        let error = store.write_plan(&drifted_blueprint_plan).unwrap_err();
        assert_eq!(error.error_code, INTENT_BUILD_CONFLICT);
        assert!(error.message.contains("same Blueprint id/version"));

        let error = store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV2 {
                    intent_id: "intent-001".into(),
                    intent_revision: 1,
                    plan_id: "plan-001".into(),
                    plan_revision: 2,
                }),
            )
            .unwrap_err();
        assert_eq!(error.error_code, INTENT_BUILD_INVALID);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrates_one_locked_v2_fixture_to_create_only_v3_state_with_parity() {
        let root = test_dir("v2-to-v3-migration");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = legacy_v2_selection();
        let legacy_index = LegacyIntentArtifactStoreIndexV1 {
            version: LEGACY_INDEX_VERSION.into(),
            book_id: "paper-a".into(),
            store_revision: 2,
            intents: BTreeMap::from([(
                "intent-001".into(),
                LegacyIntentIndexEntryV1 {
                    intent_id: "intent-001".into(),
                    revision: 1,
                    status: "confirmed".into(),
                    source_fingerprint: "source-a".into(),
                },
            )]),
            plans: BTreeMap::from([(
                "plan-001".into(),
                LegacyPlanIndexEntryV1 {
                    plan_id: "plan-001".into(),
                    revision: 1,
                    status: "confirmed".into(),
                    plan_digest: plan["plan_digest"].as_str().unwrap().into(),
                    intent_id: Some("intent-001".into()),
                },
            )]),
            active_overlay: Some(LegacyActiveIntentOverlayV1 {
                intent_id: "intent-001".into(),
                plan_id: "plan-001".into(),
            }),
        };
        write_json_atomically(&store.legacy_index_path("paper-a").unwrap(), &legacy_index).unwrap();
        write_json_atomically(
            &store.legacy_intent_path("paper-a", "intent-001").unwrap(),
            &intent,
        )
        .unwrap();
        write_json_atomically(
            &store.legacy_plan_path("paper-a", "plan-001").unwrap(),
            &plan,
        )
        .unwrap();
        let legacy_accepted_path = store
            .artifact_directory(
                "paper-a",
                "intent-001",
                plan["private_artifacts"][0]["artifact_id"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .join(LEGACY_ACCEPTED_FILE);
        let legacy_accepted = legacy_accepted_artifact_v2(&plan, golden["payload"].clone());
        write_json_atomically(&legacy_accepted_path, &legacy_accepted).unwrap();

        let receipt = store.migrate_planning_control_v2_to_v3("paper-a").unwrap();
        assert_eq!(receipt.version, "planning_control_migration.v2_to_v3");
        assert_eq!(receipt.intent_count, 1);
        assert_eq!(receipt.plan_count, 1);
        assert_eq!(receipt.accepted_artifact_count, 1);
        assert_eq!(
            receipt.active_overlay,
            Some(ActiveIntentOverlayV2 {
                intent_id: "intent-001".into(),
                intent_revision: 1,
                plan_id: "plan-001".into(),
                plan_revision: 1,
            })
        );

        let migrated_intent = store.read_intent("paper-a", "intent-001").unwrap();
        let migrated_plan = store.read_plan("paper-a", "plan-001").unwrap();
        let migrated_accepted_path = store
            .artifact_directory(
                "paper-a",
                "intent-001",
                plan["private_artifacts"][0]["artifact_id"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .join(V3_ACCEPTED_FILE);
        let migrated_accepted: Value = read_json(&migrated_accepted_path).unwrap();
        assert_eq!(migrated_intent["version"], "build_intent.v3");
        assert_eq!(migrated_intent["intent_revision"], intent["revision"]);
        for field in [
            "book_id",
            "source_fingerprint",
            "content_profile",
            "user_goal",
            "goal_kind",
            "source_scope",
            "usage_horizon",
            "privacy",
            "status",
            "created_at",
            "confirmed_at",
        ] {
            assert_eq!(migrated_intent[field], intent[field]);
        }
        assert_eq!(migrated_plan["version"], "build_plan.v3");
        assert_eq!(migrated_plan["plan_revision"], plan["revision"]);
        assert_eq!(migrated_plan["intent_revision"], intent["revision"]);
        for field in [
            "book_id",
            "source_fingerprint",
            "content_profile",
            "recipe_id",
            "intent_id",
            "public_stage_closure",
            "reuse",
            "create",
            "excluded",
            "estimate",
            "budget",
            "status",
            "confirmation_source",
            "created_at",
            "confirmed_at",
        ] {
            assert_eq!(migrated_plan[field], plan[field]);
        }
        assert_eq!(
            migrated_plan["private_artifacts"][0]["blueprint"],
            plan["private_artifacts"][0]["blueprint"]
        );
        assert_eq!(
            migrated_accepted["payload"]["records"],
            legacy_accepted["payload"]["records"]
        );
        assert_eq!(migrated_accepted["intent_revision"], 1);
        assert_eq!(migrated_accepted["plan_revision"], 1);
        let migrated_body = serde_json::to_string(&json!({
            "intent": migrated_intent,
            "plan": migrated_plan,
            "accepted": migrated_accepted,
        }))
        .unwrap();
        assert!(!migrated_body.contains("intent_digest"));
        assert!(!migrated_body.contains("plan_digest"));
        assert!(!migrated_body.contains("blueprint_digest"));
        assert!(legacy_accepted_path.exists());
        assert_eq!(
            read_json::<Value>(&legacy_accepted_path).unwrap(),
            legacy_accepted
        );

        let projection = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].artifact_type, "timeline");
        assert_eq!(
            projection.artifacts[0].payload.as_ref().unwrap()["records"],
            golden["payload"]["records"]
        );
        assert_eq!(
            store
                .migrate_planning_control_v2_to_v3("paper-a")
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
