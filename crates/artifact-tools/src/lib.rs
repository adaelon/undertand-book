use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use schemars::{gen::SchemaGenerator, JsonSchema};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

mod search;

pub use search::{
    artifact_search_input_schema, score_weighted_text_fields, validate_artifact_search_input,
    ArtifactSearchHitV1, ArtifactSearchInput, ArtifactSearchResultV1, WeightedTextField,
    WeightedTextScore, ARTIFACT_SEARCH_NORMALIZATION_VERSION, DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_ANCHOR_LIDS, MAX_SEARCH_ARTIFACT_REFS, MAX_SEARCH_QUERY_CHARS,
    MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_RESULT_LIMIT,
};

pub const ARTIFACT_TOOL_CONTRACT_VERSION: &str = "artifact_tool_contract.v1";
pub const ARTIFACT_LIST_RESIDENT_ALIAS: &str = "artifact.list";
pub const ARTIFACT_SEARCH_RESIDENT_ALIAS: &str = "artifact.search";
pub const ARTIFACT_READ_RESIDENT_ALIAS: &str = "artifact.read";
pub const ARTIFACT_LIST_MCP_ALIAS: &str = "artifact_list";
pub const ARTIFACT_SEARCH_MCP_ALIAS: &str = "artifact_search";
pub const ARTIFACT_READ_MCP_ALIAS: &str = "artifact_read";

pub const ARTIFACT_OVERLAY_UNAVAILABLE: &str = "ARTIFACT_OVERLAY_UNAVAILABLE";
pub const ARTIFACT_TOOL_INPUT_INVALID: &str = "ARTIFACT_TOOL_INPUT_INVALID";
pub const ARTIFACT_REF_INVALID: &str = "ARTIFACT_REF_INVALID";
pub const ARTIFACT_RECORD_REF_INVALID: &str = "ARTIFACT_RECORD_REF_INVALID";
pub const ARTIFACT_CURSOR_INVALID: &str = "ARTIFACT_CURSOR_INVALID";
pub const ARTIFACT_RESULT_TOO_LARGE: &str = "ARTIFACT_RESULT_TOO_LARGE";
pub const ARTIFACT_SNAPSHOT_INVALID: &str = "ARTIFACT_SNAPSHOT_INVALID";

pub const DEFAULT_LIST_LIMIT: usize = 20;
pub const MAX_LIST_LIMIT: usize = 50;
pub const MAX_LIST_RESULT_BYTES: usize = 64 * 1024;
pub const DEFAULT_READ_LIMIT: usize = 3;
pub const MAX_READ_LIMIT: usize = 3;
pub const MAX_READ_FIELD_PATHS: usize = 32;
pub const MAX_READ_RELATIONS: usize = 32;
pub const MAX_READ_RESULT_BYTES: usize = 12 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactToolError {
    pub code: &'static str,
    pub message: String,
}

impl ArtifactToolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn input(message: impl Into<String>) -> Self {
        Self::new(ARTIFACT_TOOL_INPUT_INVALID, message)
    }

    fn snapshot(message: impl Into<String>) -> Self {
        Self::new(ARTIFACT_SNAPSHOT_INVALID, message)
    }
}

impl fmt::Display for ArtifactToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ArtifactToolError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactToolId {
    List,
    Search,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactToolAliases {
    pub resident: &'static str,
    pub mcp: &'static str,
}

pub fn aliases(tool: ArtifactToolId) -> ArtifactToolAliases {
    match tool {
        ArtifactToolId::List => ArtifactToolAliases {
            resident: ARTIFACT_LIST_RESIDENT_ALIAS,
            mcp: ARTIFACT_LIST_MCP_ALIAS,
        },
        ArtifactToolId::Search => ArtifactToolAliases {
            resident: ARTIFACT_SEARCH_RESIDENT_ALIAS,
            mcp: ARTIFACT_SEARCH_MCP_ALIAS,
        },
        ArtifactToolId::Read => ArtifactToolAliases {
            resident: ARTIFACT_READ_RESIDENT_ALIAS,
            mcp: ARTIFACT_READ_MCP_ALIAS,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct ArtifactListInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadInput {
    pub artifact_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 3))]
    pub record_refs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32))]
    pub field_paths: Option<Vec<String>>,
    #[serde(default)]
    pub include_relations: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 3))]
    pub limit: Option<usize>,
}

pub fn artifact_list_input_schema() -> Value {
    schema_value::<ArtifactListInput>()
}

pub fn artifact_read_input_schema() -> Value {
    schema_value::<ArtifactReadInput>()
}

pub fn validate_artifact_list_input(value: Value) -> Result<ArtifactListInput, ArtifactToolError> {
    let input: ArtifactListInput = parse(value)?;
    resolve_limit(
        input.limit,
        DEFAULT_LIST_LIMIT,
        MAX_LIST_LIMIT,
        "list limit",
    )?;
    if input.cursor.as_deref().is_some_and(str::is_empty) {
        return Err(ArtifactToolError::input("list cursor must not be empty"));
    }
    Ok(input)
}

pub fn validate_artifact_read_input(value: Value) -> Result<ArtifactReadInput, ArtifactToolError> {
    let input: ArtifactReadInput = parse(value)?;
    validate_read_input(&input)?;
    Ok(input)
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, ArtifactToolError> {
    serde_json::from_value(value).map_err(|error| ArtifactToolError::input(error.to_string()))
}

fn schema_value<T: JsonSchema>() -> Value {
    let root = SchemaGenerator::default().into_root_schema_for::<T>();
    let mut value = serde_json::to_value(root).expect("artifact tool schema must serialize");
    if let Some(object) = value.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
        object.remove("definitions");
    }
    value
}

fn resolve_limit(
    limit: Option<usize>,
    default: usize,
    maximum: usize,
    field: &str,
) -> Result<usize, ArtifactToolError> {
    let limit = limit.unwrap_or(default);
    if !(1..=maximum).contains(&limit) {
        return Err(ArtifactToolError::input(format!(
            "{field} must be between 1 and {maximum}"
        )));
    }
    Ok(limit)
}

fn validate_read_input(input: &ArtifactReadInput) -> Result<(), ArtifactToolError> {
    if input.artifact_ref.trim().is_empty() {
        return Err(ArtifactToolError::input("artifact_ref must not be empty"));
    }
    let limit = resolve_limit(
        input.limit,
        DEFAULT_READ_LIMIT,
        MAX_READ_LIMIT,
        "read limit",
    )?;
    if input.record_refs.is_some() && input.cursor.is_some() {
        return Err(ArtifactToolError::input(
            "record_refs and cursor are mutually exclusive",
        ));
    }
    if let Some(record_refs) = &input.record_refs {
        if record_refs.is_empty() || record_refs.len() > MAX_READ_LIMIT {
            return Err(ArtifactToolError::input(format!(
                "record_refs must contain between 1 and {MAX_READ_LIMIT} refs"
            )));
        }
        if record_refs.len() > limit {
            return Err(ArtifactToolError::input(
                "record_refs count exceeds the requested read limit",
            ));
        }
        require_unique_non_blank(record_refs, "record_refs")?;
    }
    if input.cursor.as_deref().is_some_and(str::is_empty) {
        return Err(ArtifactToolError::input("read cursor must not be empty"));
    }
    if let Some(field_paths) = &input.field_paths {
        if field_paths.is_empty() || field_paths.len() > MAX_READ_FIELD_PATHS {
            return Err(ArtifactToolError::input(format!(
                "field_paths must contain between 1 and {MAX_READ_FIELD_PATHS} paths"
            )));
        }
        require_unique_non_blank(field_paths, "field_paths")?;
        for path in field_paths {
            validate_json_pointer(path)?;
        }
    }
    Ok(())
}

fn require_unique_non_blank(values: &[String], field: &str) -> Result<(), ArtifactToolError> {
    let mut seen = HashSet::new();
    for value in values {
        if value.trim().is_empty() {
            return Err(ArtifactToolError::input(format!(
                "{field} must not contain blank values"
            )));
        }
        if !seen.insert(value) {
            return Err(ArtifactToolError::input(format!(
                "{field} must not contain duplicates"
            )));
        }
    }
    Ok(())
}

fn validate_json_pointer(path: &str) -> Result<(), ArtifactToolError> {
    if !path.starts_with('/') || path.len() > 256 || invalid_pointer_escape(path) {
        return Err(ArtifactToolError::input(
            "field_paths must contain bounded non-root JSON Pointers",
        ));
    }
    Ok(())
}

fn invalid_pointer_escape(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.iter().enumerate().any(|(index, byte)| {
        *byte == b'~'
            && bytes
                .get(index + 1)
                .is_none_or(|next| *next != b'0' && *next != b'1')
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactSnapshotScope {
    pub book_id: String,
    pub source_fingerprint: String,
    pub overlay_identity: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSnapshotBlueprint {
    pub blueprint_digest: String,
    pub title: String,
    pub purpose: String,
    pub use_when: Vec<String>,
    pub avoid_when: Vec<String>,
    pub covered_topics: Vec<String>,
    pub scope_label: String,
    pub search_fields: Vec<ArtifactSnapshotSearchField>,
    pub summary_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactSearchAnalyzer {
    Text,
    Keyword,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactSnapshotSearchField {
    pub path: String,
    pub weight: u8,
    pub analyzer: ArtifactSearchAnalyzer,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSnapshotRecord {
    pub record_id: String,
    pub data: Map<String, Value>,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSnapshotRelation {
    pub relation_id: String,
    pub source_record_id: String,
    pub target_record_id: String,
    pub data: Map<String, Value>,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSnapshotItem {
    pub artifact_id: String,
    pub payload_digest: String,
    pub blueprint: ArtifactSnapshotBlueprint,
    pub records: Vec<ArtifactSnapshotRecord>,
    pub relations: Vec<ArtifactSnapshotRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRoutingCardV1 {
    pub artifact_ref: String,
    pub overlay_revision: String,
    pub title: String,
    pub purpose: String,
    pub use_when: Vec<String>,
    pub avoid_when: Vec<String>,
    pub covered_topics: Vec<String>,
    pub scope_label: String,
    pub searchable_fields: Vec<String>,
    pub record_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactListResultV1 {
    pub version: String,
    pub overlay_revision: String,
    pub artifacts: Vec<ArtifactRoutingCardV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadRecordV1 {
    pub record_ref: String,
    pub data: Map<String, Value>,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadRelationV1 {
    pub relation_ref: String,
    pub source_record_ref: String,
    pub target_record_ref: String,
    pub data: Map<String, Value>,
    pub evidence_lids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadResultV1 {
    pub version: String,
    pub overlay_revision: String,
    pub records: Vec<ArtifactReadRecordV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<ArtifactReadRelationV1>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub relations_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

struct SnapshotRecord {
    reference: String,
    input: ArtifactSnapshotRecord,
}

struct SnapshotRelation {
    reference: String,
    source_reference: String,
    target_reference: String,
    input: ArtifactSnapshotRelation,
}

struct SnapshotArtifact {
    reference: String,
    routing_card: ArtifactRoutingCardV1,
    records: Vec<SnapshotRecord>,
    record_positions: HashMap<String, usize>,
    relations: Vec<SnapshotRelation>,
    // Frozen now so AA7 search can consume the same snapshot without re-reading Blueprint state.
    search_fields: Vec<ArtifactSnapshotSearchField>,
    summary_fields: Vec<String>,
}

pub struct ArtifactAccessSnapshot {
    overlay_revision: String,
    artifacts: Vec<SnapshotArtifact>,
    artifact_positions: HashMap<String, usize>,
}

impl ArtifactAccessSnapshot {
    pub fn new(
        scope: ArtifactSnapshotScope,
        artifacts: Vec<ArtifactSnapshotItem>,
    ) -> Result<Self, ArtifactToolError> {
        validate_scope(&scope)?;
        validate_artifact_inputs(&artifacts)?;
        let overlay_revision = overlay_revision(&scope, &artifacts);
        let mut artifact_positions = HashMap::new();
        let mut snapshot_artifacts = Vec::with_capacity(artifacts.len());
        for artifact in artifacts {
            let artifact_reference = opaque_reference(
                "ar1_",
                &[
                    "artifact-ref.v1",
                    &scope.book_id,
                    &scope.source_fingerprint,
                    &overlay_revision,
                    &artifact.artifact_id,
                    &artifact.blueprint.blueprint_digest,
                    &artifact.payload_digest,
                ],
            );
            if artifact_positions
                .insert(artifact_reference.clone(), snapshot_artifacts.len())
                .is_some()
            {
                return Err(ArtifactToolError::snapshot(
                    "artifact references must be unique within a snapshot",
                ));
            }
            let mut record_positions = HashMap::new();
            let mut records = Vec::with_capacity(artifact.records.len());
            let mut record_refs_by_id = HashMap::new();
            for record in artifact.records {
                let reference = opaque_reference(
                    "rr1_",
                    &[
                        "record-ref.v1",
                        &scope.book_id,
                        &scope.source_fingerprint,
                        &artifact.artifact_id,
                        &artifact.blueprint.blueprint_digest,
                        &artifact.payload_digest,
                        &record.record_id,
                    ],
                );
                if record_positions
                    .insert(reference.clone(), records.len())
                    .is_some()
                {
                    return Err(ArtifactToolError::snapshot(
                        "record references must be unique within an artifact",
                    ));
                }
                record_refs_by_id.insert(record.record_id.clone(), reference.clone());
                records.push(SnapshotRecord {
                    reference,
                    input: record,
                });
            }
            let mut relation_refs = HashSet::new();
            let relations = artifact
                .relations
                .into_iter()
                .map(|relation| {
                    let reference = opaque_reference(
                        "rl1_",
                        &[
                            "relation-ref.v1",
                            &scope.book_id,
                            &scope.source_fingerprint,
                            &artifact.artifact_id,
                            &artifact.blueprint.blueprint_digest,
                            &artifact.payload_digest,
                            &relation.relation_id,
                        ],
                    );
                    if !relation_refs.insert(reference.clone()) {
                        return Err(ArtifactToolError::snapshot(
                            "relation references must be unique within an artifact",
                        ));
                    }
                    Ok(SnapshotRelation {
                        source_reference: record_refs_by_id[&relation.source_record_id].clone(),
                        target_reference: record_refs_by_id[&relation.target_record_id].clone(),
                        reference,
                        input: relation,
                    })
                })
                .collect::<Result<Vec<_>, ArtifactToolError>>()?;
            let routing_card = ArtifactRoutingCardV1 {
                artifact_ref: artifact_reference.clone(),
                overlay_revision: overlay_revision.clone(),
                title: artifact.blueprint.title,
                purpose: artifact.blueprint.purpose,
                use_when: artifact.blueprint.use_when,
                avoid_when: artifact.blueprint.avoid_when,
                covered_topics: artifact.blueprint.covered_topics,
                scope_label: artifact.blueprint.scope_label,
                searchable_fields: artifact
                    .blueprint
                    .search_fields
                    .iter()
                    .map(|field| field.path.clone())
                    .collect(),
                record_count: records.len(),
            };
            snapshot_artifacts.push(SnapshotArtifact {
                reference: artifact_reference,
                routing_card,
                records,
                record_positions,
                relations,
                search_fields: artifact.blueprint.search_fields,
                summary_fields: artifact.blueprint.summary_fields,
            });
        }
        Ok(Self {
            overlay_revision,
            artifacts: snapshot_artifacts,
            artifact_positions,
        })
    }

    pub fn overlay_revision(&self) -> &str {
        &self.overlay_revision
    }

    pub fn is_empty(&self) -> bool {
        self.artifacts.is_empty()
    }

    pub fn list(
        &self,
        input: ArtifactListInput,
    ) -> Result<ArtifactListResultV1, ArtifactToolError> {
        resolve_limit(
            input.limit,
            DEFAULT_LIST_LIMIT,
            MAX_LIST_LIMIT,
            "list limit",
        )?;
        let start = match input.cursor {
            Some(cursor) => self.decode_cursor(&cursor, "list", None)?,
            None => 0,
        };
        if start > self.artifacts.len() {
            return Err(ArtifactToolError::new(
                ARTIFACT_CURSOR_INVALID,
                "list cursor is outside this snapshot",
            ));
        }
        let maximum = resolve_limit(
            input.limit,
            DEFAULT_LIST_LIMIT,
            MAX_LIST_LIMIT,
            "list limit",
        )?
        .min(self.artifacts.len().saturating_sub(start));
        let mut best = self.list_result(start, 0);
        for count in 1..=maximum {
            let candidate = self.list_result(start, count);
            if serialized_len(&candidate)? > MAX_LIST_RESULT_BYTES {
                break;
            }
            best = candidate;
        }
        if maximum > 0 && best.artifacts.is_empty() {
            return Err(ArtifactToolError::new(
                ARTIFACT_RESULT_TOO_LARGE,
                "one routing card exceeds the list result budget",
            ));
        }
        Ok(best)
    }

    fn list_result(&self, start: usize, count: usize) -> ArtifactListResultV1 {
        let end = start + count;
        ArtifactListResultV1 {
            version: "artifact_list.v1".into(),
            overlay_revision: self.overlay_revision.clone(),
            artifacts: self.artifacts[start..end]
                .iter()
                .map(|artifact| artifact.routing_card.clone())
                .collect(),
            next_cursor: (end < self.artifacts.len())
                .then(|| self.encode_cursor("list", None, end)),
        }
    }

    pub fn read(
        &self,
        input: ArtifactReadInput,
    ) -> Result<ArtifactReadResultV1, ArtifactToolError> {
        validate_read_input(&input)?;
        let artifact_index = self
            .artifact_positions
            .get(&input.artifact_ref)
            .copied()
            .ok_or_else(|| {
                ArtifactToolError::new(
                    ARTIFACT_REF_INVALID,
                    "artifact_ref does not belong to this snapshot",
                )
            })?;
        let artifact = &self.artifacts[artifact_index];
        let limit = resolve_limit(
            input.limit,
            DEFAULT_READ_LIMIT,
            MAX_READ_LIMIT,
            "read limit",
        )?;
        let field_paths = input.field_paths.as_deref();
        if let Some(record_refs) = input.record_refs {
            let positions = record_refs
                .iter()
                .map(|reference| {
                    artifact
                        .record_positions
                        .get(reference)
                        .copied()
                        .ok_or_else(|| {
                            ArtifactToolError::new(
                                ARTIFACT_RECORD_REF_INVALID,
                                "record_ref does not belong to the requested artifact",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut result = self.read_result(
                artifact,
                &positions,
                field_paths,
                input.include_relations,
                None,
            )?;
            self.fit_relations(&mut result)?;
            if serialized_len(&result)? > MAX_READ_RESULT_BYTES {
                return Err(ArtifactToolError::new(
                    ARTIFACT_RESULT_TOO_LARGE,
                    "requested records exceed the read result budget; select narrower field_paths",
                ));
            }
            return Ok(result);
        }

        let start = match input.cursor {
            Some(cursor) => self.decode_cursor(&cursor, "read", Some(&artifact.reference))?,
            None => 0,
        };
        if start > artifact.records.len() {
            return Err(ArtifactToolError::new(
                ARTIFACT_CURSOR_INVALID,
                "read cursor is outside the requested artifact",
            ));
        }
        let maximum = limit.min(artifact.records.len().saturating_sub(start));
        let mut best = self.read_result(
            artifact,
            &[],
            field_paths,
            input.include_relations,
            (start < artifact.records.len()).then_some(start),
        )?;
        for count in 1..=maximum {
            let positions = (start..start + count).collect::<Vec<_>>();
            let mut candidate = self.read_result(
                artifact,
                &positions,
                field_paths,
                input.include_relations,
                (start + count < artifact.records.len()).then_some(start + count),
            )?;
            self.fit_relations(&mut candidate)?;
            if serialized_len(&candidate)? > MAX_READ_RESULT_BYTES {
                break;
            }
            best = candidate;
        }
        if maximum > 0 && best.records.is_empty() {
            return Err(ArtifactToolError::new(
                ARTIFACT_RESULT_TOO_LARGE,
                "one record exceeds the read result budget; select narrower field_paths",
            ));
        }
        Ok(best)
    }

    fn read_result(
        &self,
        artifact: &SnapshotArtifact,
        positions: &[usize],
        field_paths: Option<&[String]>,
        include_relations: bool,
        next_offset: Option<usize>,
    ) -> Result<ArtifactReadResultV1, ArtifactToolError> {
        let records = positions
            .iter()
            .map(|position| {
                let record = &artifact.records[*position];
                Ok(ArtifactReadRecordV1 {
                    record_ref: record.reference.clone(),
                    data: select_fields(&record.input.data, field_paths),
                    evidence_lids: record.input.evidence_lids.clone(),
                })
            })
            .collect::<Result<Vec<_>, ArtifactToolError>>()?;
        let selected = records
            .iter()
            .map(|record| record.record_ref.as_str())
            .collect::<HashSet<_>>();
        let relation_candidates = if include_relations {
            artifact
                .relations
                .iter()
                .filter(|relation| {
                    selected.contains(relation.source_reference.as_str())
                        && selected.contains(relation.target_reference.as_str())
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let relations_truncated = relation_candidates.len() > MAX_READ_RELATIONS;
        let relations = relation_candidates
            .into_iter()
            .take(MAX_READ_RELATIONS)
            .map(|relation| ArtifactReadRelationV1 {
                relation_ref: relation.reference.clone(),
                source_record_ref: relation.source_reference.clone(),
                target_record_ref: relation.target_reference.clone(),
                data: select_fields(&relation.input.data, field_paths),
                evidence_lids: relation.input.evidence_lids.clone(),
            })
            .collect();
        Ok(ArtifactReadResultV1 {
            version: "artifact_read.v1".into(),
            overlay_revision: self.overlay_revision.clone(),
            records,
            relations,
            relations_truncated,
            next_cursor: next_offset
                .map(|offset| self.encode_cursor("read", Some(&artifact.reference), offset)),
        })
    }

    fn fit_relations(&self, result: &mut ArtifactReadResultV1) -> Result<(), ArtifactToolError> {
        while serialized_len(result)? > MAX_READ_RESULT_BYTES && !result.relations.is_empty() {
            result.relations.pop();
            result.relations_truncated = true;
        }
        Ok(())
    }

    fn encode_cursor(&self, operation: &str, artifact_ref: Option<&str>, offset: usize) -> String {
        let offset = offset as u64;
        let offset_bytes = offset.to_be_bytes();
        let offset_text = offset.to_string();
        let signature = digest_parts(&[
            "artifact-cursor.v1",
            &self.overlay_revision,
            operation,
            artifact_ref.unwrap_or(""),
            &offset_text,
        ]);
        let mut token = Vec::with_capacity(24);
        token.extend_from_slice(&offset_bytes);
        token.extend_from_slice(&signature[..16]);
        format!("ac1_{}", URL_SAFE_NO_PAD.encode(token))
    }

    fn decode_cursor(
        &self,
        cursor: &str,
        operation: &str,
        artifact_ref: Option<&str>,
    ) -> Result<usize, ArtifactToolError> {
        let body = cursor.strip_prefix("ac1_").ok_or_else(|| {
            ArtifactToolError::new(ARTIFACT_CURSOR_INVALID, "cursor has an invalid envelope")
        })?;
        let token = URL_SAFE_NO_PAD.decode(body).map_err(|_| {
            ArtifactToolError::new(ARTIFACT_CURSOR_INVALID, "cursor has invalid encoding")
        })?;
        if token.len() != 24 {
            return Err(ArtifactToolError::new(
                ARTIFACT_CURSOR_INVALID,
                "cursor has an invalid length",
            ));
        }
        let mut offset_bytes = [0_u8; 8];
        offset_bytes.copy_from_slice(&token[..8]);
        let offset = u64::from_be_bytes(offset_bytes);
        let offset_text = offset.to_string();
        let expected = digest_parts(&[
            "artifact-cursor.v1",
            &self.overlay_revision,
            operation,
            artifact_ref.unwrap_or(""),
            &offset_text,
        ]);
        if token[8..] != expected[..16] {
            return Err(ArtifactToolError::new(
                ARTIFACT_CURSOR_INVALID,
                "cursor does not belong to this snapshot or operation",
            ));
        }
        usize::try_from(offset).map_err(|_| {
            ArtifactToolError::new(ARTIFACT_CURSOR_INVALID, "cursor offset is unsupported")
        })
    }
}

fn validate_scope(scope: &ArtifactSnapshotScope) -> Result<(), ArtifactToolError> {
    for (field, value) in [
        ("book_id", &scope.book_id),
        ("source_fingerprint", &scope.source_fingerprint),
        ("overlay_identity", &scope.overlay_identity),
    ] {
        if value.trim().is_empty() {
            return Err(ArtifactToolError::snapshot(format!(
                "snapshot {field} must not be blank"
            )));
        }
    }
    Ok(())
}

fn validate_artifact_inputs(artifacts: &[ArtifactSnapshotItem]) -> Result<(), ArtifactToolError> {
    let mut artifact_ids = HashSet::new();
    for artifact in artifacts {
        if artifact.artifact_id.trim().is_empty() || !artifact_ids.insert(&artifact.artifact_id) {
            return Err(ArtifactToolError::snapshot(
                "snapshot artifact ids must be non-blank and unique",
            ));
        }
        if !is_sha256(&artifact.payload_digest) || !is_sha256(&artifact.blueprint.blueprint_digest)
        {
            return Err(ArtifactToolError::snapshot(
                "snapshot payload and Blueprint digests must be lowercase SHA-256",
            ));
        }
        for (field, value) in [
            ("title", &artifact.blueprint.title),
            ("purpose", &artifact.blueprint.purpose),
            ("scope_label", &artifact.blueprint.scope_label),
        ] {
            if value.trim().is_empty() {
                return Err(ArtifactToolError::snapshot(format!(
                    "snapshot routing {field} must not be blank"
                )));
            }
        }
        if artifact.blueprint.use_when.is_empty()
            || artifact.blueprint.covered_topics.is_empty()
            || artifact.blueprint.search_fields.is_empty()
            || artifact.blueprint.summary_fields.is_empty()
        {
            return Err(ArtifactToolError::snapshot(
                "snapshot Blueprint routing/search/summary metadata is incomplete",
            ));
        }
        let searchable_fields = artifact
            .blueprint
            .search_fields
            .iter()
            .map(|field| field.path.clone())
            .collect::<Vec<_>>();
        require_snapshot_unique(&searchable_fields, "search_fields")?;
        require_snapshot_unique(&artifact.blueprint.summary_fields, "summary_fields")?;
        if artifact
            .blueprint
            .search_fields
            .iter()
            .any(|field| !(1..=10).contains(&field.weight))
        {
            return Err(ArtifactToolError::snapshot(
                "snapshot Blueprint search field weights must be between 1 and 10",
            ));
        }
        for path in searchable_fields
            .iter()
            .chain(artifact.blueprint.summary_fields.iter())
        {
            validate_json_pointer(path).map_err(|error| {
                ArtifactToolError::snapshot(format!(
                    "snapshot Blueprint path is invalid: {}",
                    error.message
                ))
            })?;
        }
        let mut record_ids = HashSet::new();
        for record in &artifact.records {
            validate_snapshot_entity(
                &record.record_id,
                &record.evidence_lids,
                "record",
                &mut record_ids,
            )?;
        }
        let mut relation_ids = HashSet::new();
        for relation in &artifact.relations {
            validate_snapshot_entity(
                &relation.relation_id,
                &relation.evidence_lids,
                "relation",
                &mut relation_ids,
            )?;
            if !record_ids.contains(&relation.source_record_id)
                || !record_ids.contains(&relation.target_record_id)
            {
                return Err(ArtifactToolError::snapshot(
                    "snapshot relation endpoints must resolve to records in the same artifact",
                ));
            }
        }
    }
    Ok(())
}

fn validate_snapshot_entity(
    id: &str,
    evidence_lids: &[String],
    kind: &str,
    seen: &mut HashSet<String>,
) -> Result<(), ArtifactToolError> {
    if id.trim().is_empty() || !seen.insert(id.to_owned()) {
        return Err(ArtifactToolError::snapshot(format!(
            "snapshot {kind} ids must be non-blank and unique"
        )));
    }
    if evidence_lids.is_empty() || evidence_lids.iter().any(|lid| lid.trim().is_empty()) {
        return Err(ArtifactToolError::snapshot(format!(
            "snapshot {kind} evidence_lids must be non-empty and non-blank"
        )));
    }
    Ok(())
}

fn require_snapshot_unique(values: &[String], field: &str) -> Result<(), ArtifactToolError> {
    let unique = values.iter().collect::<HashSet<_>>();
    if unique.len() != values.len() {
        return Err(ArtifactToolError::snapshot(format!(
            "snapshot Blueprint {field} must be unique"
        )));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn overlay_revision(scope: &ArtifactSnapshotScope, artifacts: &[ArtifactSnapshotItem]) -> String {
    let mut parts = vec![
        "artifact-overlay-revision.v1",
        scope.book_id.as_str(),
        scope.source_fingerprint.as_str(),
        scope.overlay_identity.as_str(),
    ];
    for artifact in artifacts {
        parts.push(artifact.artifact_id.as_str());
        parts.push(artifact.blueprint.blueprint_digest.as_str());
        parts.push(artifact.payload_digest.as_str());
    }
    hex_digest(&digest_parts(&parts))
}

fn opaque_reference(prefix: &str, parts: &[&str]) -> String {
    let digest = digest_parts(parts);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(&digest[..18]))
}

fn digest_parts(parts: &[&str]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        let bytes = part.as_bytes();
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    digest.finalize().into()
}

fn hex_digest(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn select_fields(data: &Map<String, Value>, field_paths: Option<&[String]>) -> Map<String, Value> {
    let Some(paths) = field_paths else {
        return data.clone();
    };
    let value = Value::Object(data.clone());
    paths
        .iter()
        .filter_map(|path| {
            value
                .pointer(path)
                .cloned()
                .map(|value| (path.clone(), value))
        })
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .collect()
}

fn serialized_len<T: Serialize>(value: &T) -> Result<usize, ArtifactToolError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| ArtifactToolError::snapshot("artifact tool result failed to serialize"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ARTIFACT_ACCESS_GOLDEN: &str =
        include_str!("../../../packages/core/test/fixtures/artifact-access.v1.golden.json");

    fn item(artifact_id: &str, payload_digest: &str, records: usize) -> ArtifactSnapshotItem {
        ArtifactSnapshotItem {
            artifact_id: artifact_id.into(),
            payload_digest: payload_digest.into(),
            blueprint: ArtifactSnapshotBlueprint {
                blueprint_digest: "a".repeat(64),
                title: "Test artifact".into(),
                purpose: "Route a bounded test artifact.".into(),
                use_when: vec!["the question matches the artifact".into()],
                avoid_when: vec!["the user requests source text only".into()],
                covered_topics: vec!["test".into()],
                scope_label: "confirmed scope".into(),
                search_fields: vec![ArtifactSnapshotSearchField {
                    path: "/label".into(),
                    weight: 10,
                    analyzer: ArtifactSearchAnalyzer::Text,
                }],
                summary_fields: vec!["/label".into()],
            },
            records: (0..records)
                .map(|index| ArtifactSnapshotRecord {
                    record_id: format!("record-{index}"),
                    data: json!({"label": format!("record {index}"), "detail": "private"})
                        .as_object()
                        .unwrap()
                        .clone(),
                    evidence_lids: vec![format!("1.{}", index + 1)],
                })
                .collect(),
            relations: if records >= 2 {
                vec![ArtifactSnapshotRelation {
                    relation_id: "relation-1".into(),
                    source_record_id: "record-0".into(),
                    target_record_id: "record-1".into(),
                    data: json!({"relation": "enables"}).as_object().unwrap().clone(),
                    evidence_lids: vec!["1.2".into()],
                }]
            } else {
                vec![]
            },
        }
    }

    fn snapshot(items: Vec<ArtifactSnapshotItem>) -> ArtifactAccessSnapshot {
        ArtifactAccessSnapshot::new(
            ArtifactSnapshotScope {
                book_id: "paper-a".into(),
                source_fingerprint: "source-a".into(),
                overlay_identity: "b".repeat(64),
            },
            items,
        )
        .unwrap()
    }

    #[test]
    fn aliases_and_schemas_are_closed_and_bounded() {
        assert_eq!(aliases(ArtifactToolId::List).resident, "artifact.list");
        assert_eq!(aliases(ArtifactToolId::List).mcp, "artifact_list");
        assert_eq!(aliases(ArtifactToolId::Read).resident, "artifact.read");
        assert_eq!(aliases(ArtifactToolId::Read).mcp, "artifact_read");
        assert_eq!(artifact_list_input_schema()["additionalProperties"], false);
        assert_eq!(artifact_read_input_schema()["additionalProperties"], false);
        assert_eq!(
            artifact_read_input_schema()["required"],
            json!(["artifact_ref"])
        );
        assert!(validate_artifact_list_input(json!({"limit": 51})).is_err());
        assert!(validate_artifact_read_input(json!({
            "artifact_ref": "a",
            "record_refs": ["r"],
            "cursor": "c"
        }))
        .is_err());
    }

    #[test]
    fn list_and_read_are_paginated_bounded_and_hide_internal_ids() {
        let snapshot = snapshot(vec![item("private-artifact-a", &"c".repeat(64), 4)]);
        let list = snapshot
            .list(ArtifactListInput {
                limit: Some(1),
                cursor: None,
            })
            .unwrap();
        assert_eq!(list.artifacts.len(), 1);
        assert!(list.artifacts[0].artifact_ref.starts_with("ar1_"));
        assert!(!serde_json::to_string(&list)
            .unwrap()
            .contains("private-artifact-a"));

        let first = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: Some(vec!["/label".into()]),
                include_relations: true,
                limit: Some(2),
            })
            .unwrap();
        assert_eq!(first.records.len(), 2);
        assert_eq!(
            first.records[0].data,
            json!({"/label": "record 0"}).as_object().unwrap().clone()
        );
        assert_eq!(first.relations.len(), 1);
        assert!(first.records[0].record_ref.starts_with("rr1_"));
        assert!(serialized_len(&first).unwrap() <= MAX_READ_RESULT_BYTES);
        let second = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: first.next_cursor,
                field_paths: None,
                include_relations: false,
                limit: Some(2),
            })
            .unwrap();
        assert_eq!(second.records.len(), 2);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn refs_and_cursors_are_bound_to_book_artifact_payload_and_revision() {
        let original = snapshot(vec![item("artifact-a", &"c".repeat(64), 4)]);
        let changed = snapshot(vec![item("artifact-a", &"d".repeat(64), 4)]);
        assert_ne!(original.overlay_revision(), changed.overlay_revision());
        let original_list = original.list(ArtifactListInput::default()).unwrap();
        let changed_list = changed.list(ArtifactListInput::default()).unwrap();
        assert_ne!(
            original_list.artifacts[0].artifact_ref,
            changed_list.artifacts[0].artifact_ref
        );

        let first = original
            .read(ArtifactReadInput {
                artifact_ref: original_list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: Some(1),
            })
            .unwrap();
        let error = changed
            .read(ArtifactReadInput {
                artifact_ref: changed_list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: first.next_cursor,
                field_paths: None,
                include_relations: false,
                limit: Some(1),
            })
            .unwrap_err();
        assert_eq!(error.code, ARTIFACT_CURSOR_INVALID);
        let error = changed
            .read(ArtifactReadInput {
                artifact_ref: original_list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: Some(1),
            })
            .unwrap_err();
        assert_eq!(error.code, ARTIFACT_REF_INVALID);
    }

    #[test]
    fn result_budget_requires_field_selection_for_an_oversized_record() {
        let mut oversized = item("artifact-a", &"c".repeat(64), 1);
        oversized.records[0].data.insert(
            "detail".into(),
            Value::String("x".repeat(MAX_READ_RESULT_BYTES)),
        );
        let snapshot = snapshot(vec![oversized]);
        let artifact_ref = snapshot
            .list(ArtifactListInput::default())
            .unwrap()
            .artifacts[0]
            .artifact_ref
            .clone();
        let error = snapshot
            .read(ArtifactReadInput {
                artifact_ref: artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: None,
            })
            .unwrap_err();
        assert_eq!(error.code, ARTIFACT_RESULT_TOO_LARGE);
        let selected = snapshot
            .read(ArtifactReadInput {
                artifact_ref,
                record_refs: None,
                cursor: None,
                field_paths: Some(vec!["/label".into()]),
                include_relations: false,
                limit: None,
            })
            .unwrap();
        assert_eq!(selected.records.len(), 1);
    }

    #[test]
    fn opaque_identity_and_cursor_bytes_match_the_cross_language_golden() {
        let golden: Value = serde_json::from_str(ARTIFACT_ACCESS_GOLDEN).unwrap();
        let scope = ArtifactSnapshotScope {
            book_id: golden["scope"]["book_id"].as_str().unwrap().into(),
            source_fingerprint: golden["scope"]["source_fingerprint"]
                .as_str()
                .unwrap()
                .into(),
            overlay_identity: golden["scope"]["overlay_identity"].as_str().unwrap().into(),
        };
        let identities = golden["artifacts"].as_array().unwrap();
        let mut first = item(
            identities[0]["artifact_id"].as_str().unwrap(),
            identities[0]["payload_digest"].as_str().unwrap(),
            2,
        );
        first.blueprint.blueprint_digest =
            identities[0]["blueprint_digest"].as_str().unwrap().into();
        first.records[0].record_id = "event-1".into();
        first.relations[0].relation_id = "edge-1".into();
        first.relations[0].source_record_id = "event-1".into();
        let mut second = item(
            identities[1]["artifact_id"].as_str().unwrap(),
            identities[1]["payload_digest"].as_str().unwrap(),
            0,
        );
        second.blueprint.blueprint_digest =
            identities[1]["blueprint_digest"].as_str().unwrap().into();
        let snapshot = ArtifactAccessSnapshot::new(scope, vec![first, second]).unwrap();
        assert_eq!(
            snapshot.overlay_revision(),
            golden["expected"]["overlay_revision"].as_str().unwrap()
        );
        let list = snapshot
            .list(ArtifactListInput {
                limit: Some(1),
                cursor: None,
            })
            .unwrap();
        assert_eq!(
            list.artifacts[0].artifact_ref,
            golden["expected"]["artifact_refs"][0].as_str().unwrap()
        );
        assert_eq!(
            list.next_cursor.as_deref(),
            golden["expected"]["list_cursor_after_1"].as_str()
        );
        let second_page = snapshot
            .list(ArtifactListInput {
                limit: Some(1),
                cursor: list.next_cursor.clone(),
            })
            .unwrap();
        assert_eq!(
            second_page.artifacts[0].artifact_ref,
            golden["expected"]["artifact_refs"][1].as_str().unwrap()
        );
        assert!(second_page.next_cursor.is_none());
        let read = snapshot
            .read(ArtifactReadInput {
                artifact_ref: list.artifacts[0].artifact_ref.clone(),
                record_refs: None,
                cursor: None,
                field_paths: None,
                include_relations: false,
                limit: Some(1),
            })
            .unwrap();
        assert_eq!(
            read.records[0].record_ref,
            golden["expected"]["record_ref"].as_str().unwrap()
        );
        assert_eq!(
            read.next_cursor.as_deref(),
            golden["expected"]["read_cursor_after_1"].as_str()
        );
        assert_eq!(
            snapshot.artifacts[0].relations[0].reference,
            golden["expected"]["relation_ref"].as_str().unwrap()
        );
    }
}
