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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedIntentArtifactV2 {
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

#[derive(Debug)]
struct ExpectedIntentArtifact {
    artifact_id: String,
    artifact_type: String,
    blueprint_digest: String,
    access_blueprint: ArtifactSnapshotBlueprint,
    reader_blueprint: IntentArtifactDisplayBlueprintV1,
    accepts_legacy_v1: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInstanceForAccessV2 {
    version: String,
    blueprint_digest: String,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyTimelinePayload {
    items: Vec<LegacyTimelineItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyTimelineItem {
    id: String,
    label: String,
    #[serde(default)]
    order_hint: Option<String>,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyConceptMapPayload {
    nodes: Vec<LegacyConceptNode>,
    links: Vec<LegacyRelation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyConceptNode {
    id: String,
    label: String,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyComparisonTablePayload {
    rows: Vec<LegacyComparisonRow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyComparisonRow {
    subject: String,
    dimensions: serde_json::Map<String, Value>,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyArgumentMapPayload {
    claims: Vec<LegacyArgumentClaim>,
    relations: Vec<LegacyRelation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyArgumentClaim {
    id: String,
    claim: String,
    role: String,
    evidence_lids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyRelation {
    source: String,
    target: String,
    relation: String,
    evidence_lids: Vec<String>,
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
                overlay_identity: projection.plan_digest,
            },
            artifacts,
        )
        .map_err(|error| store_corrupt(format!("artifact access snapshot rejected: {error}")))
    }

    fn read_active_overlay_state(
        &self,
        book_id: &str,
        current_source_fingerprint: &str,
    ) -> Result<(IntentArtifactOverlayV1, Vec<ArtifactSnapshotItem>), ToolError> {
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
        let mut access_artifacts = Vec::with_capacity(expected.len());
        for artifact in expected {
            let accepted_path = self
                .artifact_directory(book_id, &active.intent_id, &artifact.artifact_id)?
                .join("accepted.json");
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
            let (payload_digest, accepted_at, payload, access_records, access_relations) =
                match required_string(&accepted_value, "version")? {
                    "intent_artifact_accepted.v1" => {
                        if !artifact.accepts_legacy_v1 {
                            return Err(store_corrupt(
                                "accepted v1 intent artifact cannot satisfy a V2 BuildPlan",
                            ));
                        }
                        let accepted: AcceptedIntentArtifactV1 =
                            serde_json::from_value(accepted_value).map_err(|_| {
                                store_corrupt("accepted v1 intent artifact schema is invalid")
                            })?;
                        validate_accepted_artifact_v1(
                            &accepted,
                            book_id,
                            current_source_fingerprint,
                            &active,
                            intent_digest,
                            plan_digest,
                            &artifact,
                        )?;
                        let (records, relations) =
                            legacy_payload_to_access(&artifact.artifact_type, &accepted.payload)?;
                        (
                            accepted.payload_digest,
                            accepted.accepted_at,
                            accepted.payload,
                            records,
                            relations,
                        )
                    }
                    "intent_artifact_accepted.v2" => {
                        let accepted: AcceptedIntentArtifactV2 =
                            serde_json::from_value(accepted_value).map_err(|_| {
                                store_corrupt("accepted v2 intent artifact schema is invalid")
                            })?;
                        validate_accepted_artifact_v2(
                            &accepted,
                            book_id,
                            current_source_fingerprint,
                            &active,
                            intent_digest,
                            plan_digest,
                            &artifact,
                        )?;
                        let (records, relations) = artifact_instance_to_access(
                            &accepted.payload,
                            &artifact.blueprint_digest,
                        )?;
                        (
                            accepted.payload_digest,
                            accepted.accepted_at,
                            accepted.payload,
                            records,
                            relations,
                        )
                    }
                    _ => {
                        return Err(store_corrupt(
                            "unsupported accepted intent artifact version",
                        ))
                    }
                };
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
            IntentArtifactOverlayV1 {
                version: "intent_artifact_overlay.v1".into(),
                book_id: book_id.into(),
                intent_id: active.intent_id,
                plan_id: active.plan_id,
                plan_digest: plan_digest.into(),
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
    if !matches!(
        required_string(intent, "version")?,
        "build_intent.v1" | "build_intent.v2"
    ) {
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
    if !matches!(
        required_string(plan, "version")?,
        "build_plan.v1" | "build_plan.v2"
    ) {
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
    let intent_version = required_string(intent, "version")?;
    let plan_version = required_string(plan, "version")?;
    if !matches!(
        (intent_version, plan_version),
        ("build_intent.v1", "build_plan.v1") | ("build_intent.v2", "build_plan.v2")
    ) {
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
    let intent_digest =
        canonical_identity_digest(intent, &["created_at", "confirmed_at", "status"])?;
    if required_string(plan, "intent_digest")? != intent_digest {
        return Err(store_corrupt(
            "active BuildPlan intent_digest does not match the stored BuildIntent",
        ));
    }
    let plan_digest = build_plan_identity_digest(plan)?;
    if required_string(plan, "plan_digest")? != plan_digest || plan_entry.plan_digest != plan_digest
    {
        return Err(store_corrupt(
            "active BuildPlan plan_digest does not match its stored identity",
        ));
    }
    Ok(())
}

fn expected_private_artifacts(plan: &Value) -> Result<Vec<ExpectedIntentArtifact>, ToolError> {
    let values = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| store_corrupt("active goal plan private_artifacts are missing"))?;
    if values.is_empty() && plan.get("version").and_then(Value::as_str) != Some("build_plan.v2") {
        return Err(store_corrupt(
            "active goal plan must declare at least one private artifact",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    values
        .iter()
        .map(|value| {
            let artifact_id = required_string(value, "artifact_id")?;
            let is_v2_plan = plan.get("version").and_then(Value::as_str) == Some("build_plan.v2");
            let (
                artifact_type,
                blueprint_digest,
                access_blueprint,
                reader_blueprint,
                accepts_legacy_v1,
            ) = if is_v2_plan {
                let blueprint = value.get("blueprint").ok_or_else(|| {
                    store_corrupt("active V2 goal plan contains no Blueprint snapshot")
                })?;
                let artifact_type =
                    compatibility_artifact_type(required_string(blueprint, "blueprint_id")?);
                let blueprint_digest = required_string(value, "blueprint_digest")?;
                if !is_sha256(blueprint_digest) {
                    return Err(store_corrupt(
                        "active V2 goal plan contains an invalid blueprint_digest",
                    ));
                }
                if canonical_identity_digest(blueprint, &[])? != blueprint_digest {
                    return Err(store_corrupt(
                        "active V2 goal plan blueprint_digest does not match its snapshot",
                    ));
                }
                (
                    artifact_type,
                    blueprint_digest.to_string(),
                    artifact_blueprint_to_access(blueprint, blueprint_digest)?,
                    artifact_blueprint_to_display(blueprint)?,
                    false,
                )
            } else {
                let artifact_type = required_string(value, "artifact_type")?;
                let blueprint_digest = legacy_blueprint_digest(artifact_type).ok_or_else(|| {
                    store_corrupt("active goal plan contains an unsupported private artifact type")
                })?;
                (
                    artifact_type,
                    blueprint_digest.to_string(),
                    legacy_artifact_blueprint(artifact_type)?,
                    legacy_artifact_display_blueprint(artifact_type)?,
                    true,
                )
            };
            validate_path_safe_id(artifact_id, "artifact_id")?;
            if !seen.insert(artifact_id.to_string()) {
                return Err(store_corrupt(
                    "active goal plan contains duplicate private artifact ids",
                ));
            }
            Ok(ExpectedIntentArtifact {
                artifact_id: artifact_id.into(),
                artifact_type: artifact_type.into(),
                blueprint_digest,
                access_blueprint,
                reader_blueprint,
                accepts_legacy_v1,
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

fn legacy_blueprint_digest(artifact_type: &str) -> Option<&'static str> {
    match artifact_type {
        "timeline" => Some("a24d6ff58721c5e64519b1637111f761a037eabf52320e3088504b18857ee37a"),
        "concept_map" => Some("4910a7dc1c0aceaa6ee85fd207f987d5ca8f545ab9db3cfd57a57dd4276c9b13"),
        "comparison_table" => {
            Some("4a331d3b090d20a4a60f354f0637501d88502539a0dbc8cfad6238900c282ff8")
        }
        "argument_map" => Some("0120579090f458afa1cf9236630fb5e2b4ecee887ff21659fa2b65faf5d1dfa9"),
        _ => None,
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

fn legacy_artifact_blueprint(artifact_type: &str) -> Result<ArtifactSnapshotBlueprint, ToolError> {
    let digest = legacy_blueprint_digest(artifact_type)
        .ok_or_else(|| store_corrupt("legacy artifact type has no fixed Blueprint"))?;
    let blueprint = match artifact_type {
        "timeline" => access_blueprint(
            digest,
            "Timeline",
            "Order evidence-backed events or stages from the selected source scope.",
            &["The question depends on chronology, stages, or ordered change."],
            &["The question asks only for a static definition."],
            &["chronology", "stages", "ordered change"],
            &[
                ("/label", 10, ArtifactSearchAnalyzer::Text),
                ("/order_hint", 4, ArtifactSearchAnalyzer::Keyword),
            ],
            &["/label", "/order_hint"],
        ),
        "concept_map" => access_blueprint(
            digest,
            "Concept map",
            "Represent evidence-backed concepts and explicit semantic links between them.",
            &["The question depends on concept relationships or structural dependencies."],
            &["The question asks only for chronological ordering."],
            &["concepts", "relationships", "dependencies"],
            &[
                ("/label", 10, ArtifactSearchAnalyzer::Text),
                ("/relation", 6, ArtifactSearchAnalyzer::Text),
            ],
            &["/label", "/relation"],
        ),
        "comparison_table" => access_blueprint(
            digest,
            "Comparison table",
            "Compare evidence-backed subjects across named dimensions without fixing dimension names in advance.",
            &["The question compares multiple subjects using shared dimensions."],
            &["The question asks for causal or argumentative graph structure."],
            &["comparison", "trade-offs", "dimensions"],
            &[("/subject", 10, ArtifactSearchAnalyzer::Text)],
            &["/subject", "/dimensions"],
        ),
        "argument_map" => access_blueprint(
            digest,
            "Argument map",
            "Represent evidence-backed claims, their discourse roles, and explicit argumentative relations.",
            &["The question depends on claims, support, objections, or qualifications."],
            &["The question asks only for a flat list of concepts."],
            &["claims", "support", "objections", "qualifications"],
            &[
                ("/claim", 10, ArtifactSearchAnalyzer::Text),
                ("/role", 5, ArtifactSearchAnalyzer::Keyword),
                ("/relation", 6, ArtifactSearchAnalyzer::Text),
            ],
            &["/claim", "/role", "/relation"],
        ),
        _ => return Err(store_corrupt("unsupported legacy artifact type")),
    };
    Ok(blueprint)
}

fn legacy_artifact_display_blueprint(
    artifact_type: &str,
) -> Result<IntentArtifactDisplayBlueprintV1, ToolError> {
    let (title, purpose, shape, summary_fields) = match artifact_type {
        "timeline" => (
            "Timeline",
            "Order evidence-backed events or stages from the selected source scope.",
            "sequence",
            &["/label", "/order_hint"][..],
        ),
        "concept_map" => (
            "Concept map",
            "Represent evidence-backed concepts and explicit semantic links between them.",
            "graph",
            &["/label", "/relation"][..],
        ),
        "comparison_table" => (
            "Comparison table",
            "Compare evidence-backed subjects across named dimensions without fixing dimension names in advance.",
            "table",
            &["/subject", "/dimensions"][..],
        ),
        "argument_map" => (
            "Argument map",
            "Represent evidence-backed claims, their discourse roles, and explicit argumentative relations.",
            "graph",
            &["/claim", "/role", "/relation"][..],
        ),
        _ => return Err(store_corrupt("unsupported legacy artifact type")),
    };
    Ok(IntentArtifactDisplayBlueprintV1 {
        title: title.into(),
        purpose: purpose.into(),
        shape: shape.into(),
        summary_fields: summary_fields
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    })
}

#[allow(clippy::too_many_arguments)]
fn access_blueprint(
    blueprint_digest: &str,
    title: &str,
    purpose: &str,
    use_when: &[&str],
    avoid_when: &[&str],
    covered_topics: &[&str],
    search_fields: &[(&str, u8, ArtifactSearchAnalyzer)],
    summary_fields: &[&str],
) -> ArtifactSnapshotBlueprint {
    ArtifactSnapshotBlueprint {
        blueprint_digest: blueprint_digest.into(),
        title: title.into(),
        purpose: purpose.into(),
        use_when: use_when.iter().map(|value| (*value).into()).collect(),
        avoid_when: avoid_when.iter().map(|value| (*value).into()).collect(),
        covered_topics: covered_topics.iter().map(|value| (*value).into()).collect(),
        scope_label: "confirmed build source scope".into(),
        search_fields: search_fields
            .iter()
            .map(|(path, weight, analyzer)| ArtifactSnapshotSearchField {
                path: (*path).into(),
                weight: *weight,
                analyzer: *analyzer,
            })
            .collect(),
        summary_fields: summary_fields.iter().map(|value| (*value).into()).collect(),
    }
}

fn artifact_instance_to_access(
    payload: &Value,
    blueprint_digest: &str,
) -> Result<(Vec<ArtifactSnapshotRecord>, Vec<ArtifactSnapshotRelation>), ToolError> {
    let instance: ArtifactInstanceForAccessV2 = serde_json::from_value(payload.clone())
        .map_err(|_| store_corrupt("accepted v2 ArtifactInstance schema is invalid"))?;
    if instance.version != "artifact_instance.v2" || instance.blueprint_digest != blueprint_digest {
        return Err(store_corrupt(
            "accepted v2 ArtifactInstance identity is invalid",
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

fn legacy_payload_to_access(
    artifact_type: &str,
    payload: &Value,
) -> Result<(Vec<ArtifactSnapshotRecord>, Vec<ArtifactSnapshotRelation>), ToolError> {
    match artifact_type {
        "timeline" => {
            let payload: LegacyTimelinePayload = serde_json::from_value(payload.clone())
                .map_err(|_| store_corrupt("legacy timeline payload schema is invalid"))?;
            Ok((
                payload
                    .items
                    .into_iter()
                    .map(|item| {
                        let mut data = serde_json::Map::new();
                        data.insert("label".into(), Value::String(item.label));
                        if let Some(order_hint) = item.order_hint {
                            data.insert("order_hint".into(), Value::String(order_hint));
                        }
                        ArtifactSnapshotRecord {
                            record_id: item.id,
                            data,
                            evidence_lids: item.evidence_lids,
                        }
                    })
                    .collect(),
                Vec::new(),
            ))
        }
        "concept_map" => {
            let payload: LegacyConceptMapPayload = serde_json::from_value(payload.clone())
                .map_err(|_| store_corrupt("legacy concept map payload schema is invalid"))?;
            let records = payload
                .nodes
                .into_iter()
                .map(|node| ArtifactSnapshotRecord {
                    record_id: node.id,
                    data: string_data("label", node.label),
                    evidence_lids: node.evidence_lids,
                })
                .collect();
            Ok((records, legacy_relations(payload.links)))
        }
        "comparison_table" => {
            let payload: LegacyComparisonTablePayload = serde_json::from_value(payload.clone())
                .map_err(|_| store_corrupt("legacy comparison table payload schema is invalid"))?;
            let records = payload
                .rows
                .into_iter()
                .enumerate()
                .map(|(index, row)| {
                    let mut dimensions = row.dimensions.into_iter().collect::<Vec<_>>();
                    dimensions.sort_by(|(left, _), (right, _)| {
                        left.encode_utf16().cmp(right.encode_utf16())
                    });
                    let dimensions = dimensions
                        .into_iter()
                        .map(|(name, value)| {
                            Ok(Value::Object(serde_json::Map::from_iter([
                                ("name".into(), Value::String(name)),
                                ("value_json".into(), Value::String(canonical_json(&value)?)),
                            ])))
                        })
                        .collect::<Result<Vec<_>, ToolError>>()?;
                    Ok(ArtifactSnapshotRecord {
                        record_id: format!("row-{}", index + 1),
                        data: serde_json::Map::from_iter([
                            ("subject".into(), Value::String(row.subject)),
                            ("dimensions".into(), Value::Array(dimensions)),
                        ]),
                        evidence_lids: row.evidence_lids,
                    })
                })
                .collect::<Result<Vec<_>, ToolError>>()?;
            Ok((records, Vec::new()))
        }
        "argument_map" => {
            let payload: LegacyArgumentMapPayload = serde_json::from_value(payload.clone())
                .map_err(|_| store_corrupt("legacy argument map payload schema is invalid"))?;
            let records = payload
                .claims
                .into_iter()
                .map(|claim| ArtifactSnapshotRecord {
                    record_id: claim.id,
                    data: serde_json::Map::from_iter([
                        ("claim".into(), Value::String(claim.claim)),
                        ("role".into(), Value::String(claim.role)),
                    ]),
                    evidence_lids: claim.evidence_lids,
                })
                .collect();
            Ok((records, legacy_relations(payload.relations)))
        }
        _ => Err(store_corrupt(
            "legacy payload has an unsupported artifact type",
        )),
    }
}

fn string_data(field: &str, value: String) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([(field.into(), Value::String(value))])
}

fn legacy_relations(relations: Vec<LegacyRelation>) -> Vec<ArtifactSnapshotRelation> {
    let mut seen = std::collections::BTreeSet::new();
    relations
        .into_iter()
        .map(|relation| {
            let base = format!(
                "{}:{}:{}",
                relation.source, relation.relation, relation.target
            );
            ArtifactSnapshotRelation {
                relation_id: unique_legacy_relation_id(&base, &mut seen),
                source_record_id: relation.source,
                target_record_id: relation.target,
                data: string_data("relation", relation.relation),
                evidence_lids: relation.evidence_lids,
            }
        })
        .collect()
}

fn unique_legacy_relation_id(base: &str, seen: &mut std::collections::BTreeSet<String>) -> String {
    const MAX_CHARS: usize = 256;
    let mut candidate = truncate_chars(base, MAX_CHARS);
    let mut suffix = 1;
    while seen.contains(&candidate) {
        suffix += 1;
        let marker = format!("#{suffix}");
        candidate = format!(
            "{}{}",
            truncate_chars(base, MAX_CHARS.saturating_sub(marker.chars().count())),
            marker
        );
    }
    seen.insert(candidate.clone());
    candidate
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn validate_accepted_artifact_v1(
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

fn validate_accepted_artifact_v2(
    accepted: &AcceptedIntentArtifactV2,
    book_id: &str,
    current_source_fingerprint: &str,
    active: &ActiveIntentOverlayV1,
    intent_digest: &str,
    plan_digest: &str,
    artifact: &ExpectedIntentArtifact,
) -> Result<(), ToolError> {
    if accepted.version != "intent_artifact_accepted.v2"
        || accepted.book_id != book_id
        || accepted.source_fingerprint != current_source_fingerprint
        || accepted.intent_id != active.intent_id
        || accepted.intent_digest != intent_digest
        || accepted.plan_id != active.plan_id
        || accepted.plan_digest != plan_digest
        || accepted.artifact_id != artifact.artifact_id
        || accepted.blueprint_digest != artifact.blueprint_digest
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
        || payload.get("blueprint_digest").and_then(Value::as_str)
            != Some(artifact.blueprint_digest.as_str())
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
    const ARTIFACT_BLUEPRINT_PRESETS_V1_GOLDEN: &str = include_str!(
        "../../../packages/core/test/fixtures/artifact-blueprint-presets.v1.golden.json"
    );

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

    fn accepted_artifact_v1(plan: &Value, payload: Value) -> Value {
        let artifact = &plan["private_artifacts"][0];
        let payload_digest = crate::sha256_hex(canonical_json(&payload).unwrap().as_bytes());
        json!({
            "version": "intent_artifact_accepted.v1",
            "task_id": "intent-artifact-task-001",
            "book_id": plan["book_id"],
            "source_fingerprint": plan["source_fingerprint"],
            "intent_id": plan["intent_id"],
            "intent_digest": plan["intent_digest"],
            "plan_id": plan["plan_id"],
            "plan_digest": plan["plan_digest"],
            "artifact_id": artifact["artifact_id"],
            "artifact_type": artifact["artifact_type"],
            "payload": payload,
            "payload_digest": payload_digest,
            "accepted_at": "2026-07-26T03:00:00.000Z"
        })
    }

    fn golden_selection(body: &str) -> (Value, Value) {
        let golden: Value = serde_json::from_str(body).unwrap();
        let mut intent = golden["intent"].clone();
        let mut plan = golden["plan"].clone();
        intent["status"] = json!("confirmed");
        intent["confirmed_at"] = json!("2026-07-29T12:01:00.000Z");
        plan["status"] = json!("confirmed");
        plan["confirmation_source"] = json!("reader_ui");
        plan["confirmed_at"] = json!("2026-07-29T12:01:00.000Z");
        (intent, plan)
    }

    fn accepted_artifact_v2(plan: &Value, payload: Value) -> Value {
        let artifact = &plan["private_artifacts"][0];
        let blueprint_digest = artifact["blueprint_digest"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                artifact["artifact_type"]
                    .as_str()
                    .and_then(legacy_blueprint_digest)
                    .map(str::to_string)
            })
            .unwrap();
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
    fn legacy_access_adapter_matches_all_core_preset_goldens() {
        let golden: Value = serde_json::from_str(ARTIFACT_BLUEPRINT_PRESETS_V1_GOLDEN).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let artifact_type = case["artifact_type"].as_str().unwrap();
            let (records, relations) =
                legacy_payload_to_access(artifact_type, &case["legacy_payload"]).unwrap();
            let record_values = records
                .into_iter()
                .map(|record| {
                    json!({
                        "record_id": record.record_id,
                        "data": record.data,
                        "evidence_lids": record.evidence_lids,
                    })
                })
                .collect::<Vec<_>>();
            let relation_values = relations
                .into_iter()
                .map(|relation| {
                    json!({
                        "relation_id": relation.relation_id,
                        "source": relation.source_record_id,
                        "target": relation.target_record_id,
                        "data": relation.data,
                        "evidence_lids": relation.evidence_lids,
                    })
                })
                .collect::<Vec<_>>();
            assert_eq!(Value::Array(record_values), case["mapped_records"]);
            assert_eq!(Value::Array(relation_values), case["mapped_relations"]);
            assert_eq!(
                legacy_artifact_blueprint(artifact_type)
                    .unwrap()
                    .blueprint_digest,
                case["blueprint_digest"].as_str().unwrap()
            );
        }
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
        use artifact_tools::{ArtifactListInput, ArtifactReadInput};

        let root = test_dir("active-artifacts");
        let store = IntentArtifactStore::open(&root).unwrap();
        let (intent, plan) = golden_selection(BUILD_INTENT_V1_GOLDEN);
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
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
        assert_eq!(pending.plan_digest, plan["plan_digest"].as_str().unwrap());
        assert_eq!(pending.artifacts.len(), 1);
        assert_eq!(pending.artifacts[0].state, "pending");
        assert!(pending.artifacts[0].payload.is_none());
        let pending_projection = serde_json::to_value(&pending).unwrap();
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["title"],
            "Comparison table"
        );
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["shape"],
            "table"
        );
        assert_eq!(
            pending_projection["artifacts"][0]["blueprint"]["summary_fields"],
            json!(["/subject", "/dimensions"])
        );

        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", "artifact-001")
            .unwrap()
            .join("accepted.json");
        let private_payload = json!({
            "rows": [{
                "subject": "PRIVATE_STORE_ARTIFACT_SENTINEL",
                "dimensions": { "result": "same canonical identity" },
                "evidence_lids": ["1.1"]
            }]
        });
        write_json_atomically(
            &accepted_path,
            &accepted_artifact_v1(&plan, private_payload.clone()),
        )
        .unwrap();

        let reopened = IntentArtifactStore::open(&root).unwrap();
        let projection = reopened
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].state, "accepted");
        assert_eq!(projection.artifacts[0].payload, Some(private_payload));
        assert!(projection.artifacts[0].payload_digest.is_some());
        let snapshot = reopened
            .read_active_artifact_access_snapshot("paper-a", "source-a")
            .unwrap();
        let list = snapshot.list(ArtifactListInput::default()).unwrap();
        assert_eq!(list.artifacts[0].title, "Comparison table");
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
            read.records[0].data["subject"],
            "PRIVATE_STORE_ARTIFACT_SENTINEL"
        );
        assert!(read.records[0].data["dimensions"].is_array());
        let redacted =
            serde_json::to_string(&reopened.inspect_redacted("paper-a").unwrap()).unwrap();
        assert!(!redacted.contains("Compare the datasets and methods"));
        assert!(!redacted.contains("PRIVATE_STORE_ARTIFACT_SENTINEL"));

        let mut stale = accepted_artifact_v1(&plan, json!({ "rows": [] }));
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
    fn projects_v2_instances_and_rejects_blueprint_or_payload_digest_drift() {
        let root = test_dir("active-artifacts-v2");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = golden_selection(BUILD_INTENT_V2_GOLDEN);
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
                }),
            )
            .unwrap();
        let artifact_id = plan["private_artifacts"][0]["artifact_id"]
            .as_str()
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", artifact_id)
            .unwrap()
            .join("accepted.json");
        let instance = golden["payload"].clone();
        write_json_atomically(
            &accepted_path,
            &accepted_artifact_v2(&plan, instance.clone()),
        )
        .unwrap();
        let projection = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].artifact_type, "timeline");
        assert_eq!(projection.artifacts[0].payload, Some(instance));
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

        let mut drifted = accepted_artifact_v2(&plan, golden["payload"].clone());
        drifted["blueprint_digest"] = json!("e".repeat(64));
        write_json_atomically(&accepted_path, &drifted).unwrap();
        assert_eq!(
            store
                .read_active_overlay_artifacts("paper-a", "source-a")
                .unwrap_err()
                .error_code,
            "INTENT_BUILD_STORE_CORRUPT"
        );

        let mut legacy = accepted_artifact_v2(&plan, golden["payload"].clone());
        legacy["version"] = json!("intent_artifact_accepted.v1");
        legacy.as_object_mut().unwrap().remove("blueprint_digest");
        legacy["artifact_type"] = json!("timeline");
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
    fn builds_a_frozen_bounded_snapshot_only_from_current_accepted_v2_artifacts() {
        use artifact_tools::{ArtifactListInput, ArtifactReadInput};

        let root = test_dir("artifact-access-snapshot-v2");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = golden_selection(BUILD_INTENT_V2_GOLDEN);
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
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
            .join("accepted.json");
        write_json_atomically(
            &accepted_path,
            &accepted_artifact_v2(&plan, golden["payload"].clone()),
        )
        .unwrap();

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
        assert!(!list_body.contains(plan["plan_digest"].as_str().unwrap()));

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
    fn reread_recomputes_intent_plan_blueprint_and_payload_digests_from_disk() {
        let root = test_dir("active-artifacts-v2-canonical-reread");
        let store = IntentArtifactStore::open(&root).unwrap();
        let golden: Value = serde_json::from_str(BUILD_INTENT_V2_GOLDEN).unwrap();
        let (intent, plan) = golden_selection(BUILD_INTENT_V2_GOLDEN);
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
                }),
            )
            .unwrap();
        let artifact_id = plan["private_artifacts"][0]["artifact_id"]
            .as_str()
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", artifact_id)
            .unwrap()
            .join("accepted.json");
        let accepted = accepted_artifact_v2(&plan, golden["payload"].clone());
        write_json_atomically(&accepted_path, &accepted).unwrap();
        store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();

        let intent_path = store.intent_path("paper-a", "intent-001").unwrap();
        let mut drifted_intent = intent.clone();
        drifted_intent["user_goal"] = json!("tampered intent body");
        write_json_atomically(&intent_path, &drifted_intent).unwrap();
        let error = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap_err();
        assert_eq!(error.error_code, "INTENT_BUILD_STORE_CORRUPT");
        assert!(error.message.contains("intent_digest"));
        write_json_atomically(&intent_path, &intent).unwrap();

        let plan_path = store.plan_path("paper-a", "plan-001").unwrap();
        let mut drifted_plan = plan.clone();
        drifted_plan["budget"]["max_total_tokens"] = json!(20_001);
        write_json_atomically(&plan_path, &drifted_plan).unwrap();
        let error = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap_err();
        assert_eq!(error.error_code, "INTENT_BUILD_STORE_CORRUPT");
        assert!(error.message.contains("plan_digest"));
        write_json_atomically(&plan_path, &plan).unwrap();

        let mut drifted_accepted = accepted.clone();
        drifted_accepted["payload"]["records"][0]["data"]["label"] = json!("tampered payload body");
        write_json_atomically(&accepted_path, &drifted_accepted).unwrap();
        let error = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap_err();
        assert_eq!(error.error_code, "INTENT_BUILD_STORE_CORRUPT");
        assert!(error.message.contains("payload_digest"));
        write_json_atomically(&accepted_path, &accepted).unwrap();

        let mut drifted_blueprint_plan = plan;
        drifted_blueprint_plan["revision"] = json!(2);
        drifted_blueprint_plan["private_artifacts"][0]["blueprint"]["title"] =
            json!("tampered Blueprint snapshot");
        drifted_blueprint_plan["plan_digest"] =
            json!(build_plan_identity_digest(&drifted_blueprint_plan).unwrap());
        store.write_plan(&drifted_blueprint_plan).unwrap();
        let error = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap_err();
        assert_eq!(error.error_code, "INTENT_BUILD_STORE_CORRUPT");
        assert!(error.message.contains("blueprint_digest"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_v1_plan_can_finish_with_new_v2_generation_using_the_fixed_preset_digest() {
        let root = test_dir("v1-plan-v2-accepted");
        let store = IntentArtifactStore::open(&root).unwrap();
        let (intent, plan) = golden_selection(BUILD_INTENT_V1_GOLDEN);
        store.write_intent(&intent).unwrap();
        store.write_plan(&plan).unwrap();
        store
            .set_active_overlay(
                "paper-a",
                Some(ActiveIntentOverlayV1 {
                    intent_id: "intent-001".into(),
                    plan_id: "plan-001".into(),
                }),
            )
            .unwrap();
        let accepted_path = store
            .artifact_directory("paper-a", "intent-001", "artifact-001")
            .unwrap()
            .join("accepted.json");
        let preset_digest = legacy_blueprint_digest("comparison_table").unwrap();
        let payload = json!({
            "version": "artifact_instance.v2",
            "blueprint_digest": preset_digest,
            "records": []
        });
        let accepted = accepted_artifact_v2(&plan, payload.clone());
        write_json_atomically(&accepted_path, &accepted).unwrap();
        let projection = store
            .read_active_overlay_artifacts("paper-a", "source-a")
            .unwrap();
        assert_eq!(projection.artifacts[0].artifact_type, "comparison_table");
        assert_eq!(projection.artifacts[0].payload, Some(payload));
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
