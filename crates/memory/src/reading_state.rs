use crate::Record;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EngagementSignals {
    pub read_count: u32,
    pub qa_count: u32,
    pub note_count: u32,
    pub highlight_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BookReadingState {
    pub book_id: String,
    pub read_lids: Vec<String>,
    pub engagement_by_lid: BTreeMap<String, EngagementSignals>,
}

impl BookReadingState {
    pub(crate) fn from_records(
        book_id: &str,
        read_lids: Vec<String>,
        records: &[Record],
    ) -> BookReadingState {
        let mut engagement_by_lid = BTreeMap::new();
        for record in records.iter().filter(|record| record.book_id == book_id) {
            if !matches!(
                record.mem_type.as_str(),
                "read" | "qa" | "note" | "highlight"
            ) {
                continue;
            }
            let Some(lid) = &record.anchor.lid else {
                continue;
            };
            let signals: &mut EngagementSignals = engagement_by_lid.entry(lid.clone()).or_default();
            match record.mem_type.as_str() {
                "read" => signals.read_count = signals.read_count.max(record.usage.count),
                "qa" => signals.qa_count += 1,
                "note" => signals.note_count += 1,
                "highlight" => signals.highlight_count += 1,
                _ => unreachable!("record type filtered above"),
            }
            if signals
                .last_seen_at
                .as_ref()
                .is_none_or(|last_seen| record.generated_at > *last_seen)
            {
                signals.last_seen_at = Some(record.generated_at.clone());
            }
        }
        BookReadingState {
            book_id: book_id.into(),
            read_lids,
            engagement_by_lid,
        }
    }

    pub fn legacy_reader_profile(&self) -> LegacyReaderProfileProjection {
        let focus_lids = self
            .engagement_by_lid
            .iter()
            .filter(|(_, signals)| signals.note_count > 0 || signals.highlight_count > 0)
            .map(|(lid, _)| lid.clone())
            .collect();
        let puzzle_heat = self
            .engagement_by_lid
            .iter()
            .filter(|(_, signals)| signals.qa_count > 0)
            .map(|(lid, signals)| (lid.clone(), signals.qa_count))
            .collect();
        LegacyReaderProfileProjection {
            book_id: self.book_id.clone(),
            read_lids: self.read_lids.clone(),
            focus_lids,
            puzzle_heat,
        }
    }
}

impl Serialize for BookReadingState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.legacy_reader_profile().serialize(serializer)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LegacyReaderProfileProjection {
    pub book_id: String,
    pub read_lids: Vec<String>,
    pub focus_lids: Vec<String>,
    pub puzzle_heat: BTreeMap<String, u32>,
}
