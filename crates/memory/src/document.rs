use crate::Record;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const MEMORY_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryDocument {
    pub schema_version: u32,
    pub document_revision: u64,
    pub projection_revision: u64,
    pub records: Vec<Record>,
    #[serde(default)]
    pub(crate) profile_facts: Vec<Value>,
    #[serde(default)]
    pub(crate) review_state: BTreeMap<String, Value>,
    #[serde(default)]
    pub(crate) exclusions: Vec<Value>,
}

impl MemoryDocument {
    pub(crate) fn empty() -> MemoryDocument {
        MemoryDocument {
            schema_version: MEMORY_SCHEMA_VERSION,
            document_revision: 0,
            projection_revision: 0,
            records: Vec::new(),
            profile_facts: Vec::new(),
            review_state: BTreeMap::new(),
            exclusions: Vec::new(),
        }
    }

    pub(crate) fn from_legacy(records: Vec<Record>) -> MemoryDocument {
        MemoryDocument {
            schema_version: MEMORY_SCHEMA_VERSION,
            document_revision: 1,
            projection_revision: 1,
            records,
            profile_facts: Vec::new(),
            review_state: BTreeMap::new(),
            exclusions: Vec::new(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != MEMORY_SCHEMA_VERSION {
            return Err(format!(
                "不支持的 memory schema_version: {} (expected {})",
                self.schema_version, MEMORY_SCHEMA_VERSION
            ));
        }
        if self.projection_revision > self.document_revision {
            return Err(format!(
                "memory projection_revision {} 超过 document_revision {}",
                self.projection_revision, self.document_revision
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum StoredMemory {
    Document(MemoryDocument),
    Legacy(Vec<Record>),
}
