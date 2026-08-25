use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

pub const ARTIFACT_SEARCH_NORMALIZATION_VERSION: &str =
    "nfkc_unicode-normalization-0.1.25__full-casefold_unicode-casefold-0.2.0__whitespace-v1";
pub const DEFAULT_SEARCH_LIMIT: usize = 3;
pub const MAX_SEARCH_RESULT_LIMIT: usize = 3;
pub const MAX_SEARCH_RESULT_BYTES: usize = 12 * 1024;
pub const MAX_SEARCH_QUERY_CHARS: usize = 512;
pub const MAX_SEARCH_ARTIFACT_REFS: usize = 50;
pub const MAX_SEARCH_ANCHOR_LIDS: usize = 64;

const MAX_QUERY_TERMS: usize = 64;
const MAX_TYPO_QUERY_TERMS: usize = 4;
const MAX_TYPO_FIELD_TERMS: usize = 64;
const ANCHOR_SCORE_BONUS: u64 = 500;
const SCORE_TIER_SCALE: u64 = 1_000_000_000_000_000;
const SCORE_WEIGHT_SCALE: u64 = 1_000_000;
const SCORE_COVERAGE_SCALE: u64 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactSearchInput {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 50))]
    pub artifact_refs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub anchor_lids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 3))]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactSearchHitV1 {
    pub artifact_ref: String,
    pub record_ref: String,
    pub data: Map<String, Value>,
    pub evidence_lids: Vec<String>,
    pub matched_fields: Vec<String>,
    pub matched_terms: Vec<String>,
    pub score: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactSearchResultV1 {
    pub version: String,
    pub overlay_revision: String,
    pub hits: Vec<ArtifactSearchHitV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn artifact_search_input_schema() -> Value {
    schema_value::<ArtifactSearchInput>()
}

pub fn validate_artifact_search_input(
    value: Value,
) -> Result<ArtifactSearchInput, ArtifactToolError> {
    let input: ArtifactSearchInput = parse(value)?;
    validate_search_input(&input)?;
    Ok(input)
}

fn validate_search_input(input: &ArtifactSearchInput) -> Result<(), ArtifactToolError> {
    if input.query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(ArtifactToolError::input(format!(
            "search query must contain at most {MAX_SEARCH_QUERY_CHARS} characters"
        )));
    }
    let normalized = normalize(&input.query);
    if normalized.is_empty() || query_terms(&normalized).is_empty() {
        return Err(ArtifactToolError::input(
            "search query must contain searchable text",
        ));
    }
    resolve_limit(
        input.limit,
        DEFAULT_SEARCH_LIMIT,
        MAX_SEARCH_RESULT_LIMIT,
        "search limit",
    )?;
    if input.cursor.as_deref().is_some_and(str::is_empty) {
        return Err(ArtifactToolError::input("search cursor must not be empty"));
    }
    validate_bounded_unique_values(
        input.artifact_refs.as_deref(),
        "artifact_refs",
        MAX_SEARCH_ARTIFACT_REFS,
    )?;
    validate_bounded_unique_values(
        input.anchor_lids.as_deref(),
        "anchor_lids",
        MAX_SEARCH_ANCHOR_LIDS,
    )?;
    Ok(())
}

fn validate_bounded_unique_values(
    values: Option<&[String]>,
    field: &str,
    maximum: usize,
) -> Result<(), ArtifactToolError> {
    let Some(values) = values else {
        return Ok(());
    };
    if values.is_empty() || values.len() > maximum {
        return Err(ArtifactToolError::input(format!(
            "{field} must contain between 1 and {maximum} values"
        )));
    }
    require_unique_non_blank(values, field)?;
    if values.iter().any(|value| value.chars().count() > 256) {
        return Err(ArtifactToolError::input(format!(
            "{field} values must contain at most 256 characters"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryTermKind {
    Word,
    CjkGram,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryTerm {
    text: String,
    kind: QueryTermKind,
}

#[derive(Debug, Clone)]
struct SearchQuery {
    normalized: String,
    compact: String,
    terms: Vec<QueryTerm>,
}

impl SearchQuery {
    fn new(input: &str) -> Self {
        let normalized = normalize(input);
        Self {
            compact: compact(&normalized),
            terms: query_terms(&normalized),
            normalized,
        }
    }
}

/// One model-independent text field consumed by deterministic lexical ranking.
///
/// Weights intentionally share the artifact-search 1..=10 convention. Callers own
/// field selection; this type only supplies the versioned Unicode/CJK analyzer and
/// stable score composition already used by artifact search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeightedTextField<'a> {
    pub name: &'a str,
    pub weight: u8,
    pub value: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeightedTextScore {
    pub score: u64,
    pub matched_fields: Vec<String>,
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct MatchAggregate {
    tier: u64,
    weighted_quality: u64,
    matched_fields: BTreeSet<String>,
    matched_terms: BTreeSet<String>,
    covered_terms: BTreeSet<String>,
}

impl MatchAggregate {
    fn add(&mut self, field: &str, weight: u8, result: FieldMatch) {
        self.tier = self.tier.max(result.tier);
        self.weighted_quality = self
            .weighted_quality
            .saturating_add(result.quality.saturating_mul(u64::from(weight)));
        self.matched_fields.insert(field.into());
        self.matched_terms.extend(result.explanations);
        self.covered_terms.extend(result.covered_terms);
    }

    fn merge(&mut self, other: &Self) {
        self.tier = self.tier.max(other.tier);
        self.weighted_quality = self.weighted_quality.saturating_add(other.weighted_quality);
        self.matched_fields
            .extend(other.matched_fields.iter().cloned());
        self.matched_terms
            .extend(other.matched_terms.iter().cloned());
        self.covered_terms
            .extend(other.covered_terms.iter().cloned());
    }

    fn is_match(&self) -> bool {
        !self.matched_fields.is_empty()
    }
}

/// Score bounded weighted text fields with artifact search's versioned analyzer.
///
/// This helper is deliberately pure: it performs no artifact lookup, pagination,
/// typo fallback, or side effect. A zero-weight field is ignored so a caller cannot
/// report a textual match that contributed no ranking signal.
pub fn score_weighted_text_fields(
    query: &str,
    fields: &[WeightedTextField<'_>],
) -> Option<WeightedTextScore> {
    let query = SearchQuery::new(query);
    if query.terms.is_empty() {
        return None;
    }

    let mut aggregate = MatchAggregate::default();
    for field in fields.iter().filter(|field| field.weight > 0) {
        if let Some(result) = match_text(field.value, &query, ArtifactSearchAnalyzer::Text, false) {
            aggregate.add(field.name, field.weight.min(10), result);
        }
    }
    if !aggregate.is_match() {
        return None;
    }

    let coverage = ((aggregate.covered_terms.len() * 1_000) / query.terms.len()) as u64;
    Some(WeightedTextScore {
        score: aggregate
            .tier
            .saturating_mul(SCORE_TIER_SCALE)
            .saturating_add(
                aggregate
                    .weighted_quality
                    .saturating_mul(SCORE_WEIGHT_SCALE),
            )
            .saturating_add(coverage.saturating_mul(SCORE_COVERAGE_SCALE)),
        matched_fields: aggregate.matched_fields.into_iter().collect(),
        matched_terms: aggregate.matched_terms.into_iter().collect(),
    })
}

struct FieldMatch {
    tier: u64,
    quality: u64,
    explanations: Vec<String>,
    covered_terms: Vec<String>,
}

struct SearchCandidate {
    artifact_index: usize,
    record_index: usize,
    score: u64,
    matched_fields: Vec<String>,
    matched_terms: Vec<String>,
    evidence_lids: Vec<String>,
}

impl ArtifactAccessSnapshot {
    pub fn search(
        &self,
        input: ArtifactSearchInput,
    ) -> Result<ArtifactSearchResultV1, ArtifactToolError> {
        validate_search_input(&input)?;
        let query = SearchQuery::new(&input.query);
        let artifact_indices = self.resolve_search_artifacts(input.artifact_refs.as_deref())?;
        let request_key = search_request_key(
            &query.normalized,
            input.artifact_refs.as_deref(),
            input.anchor_lids.as_deref(),
        );
        let start = match input.cursor.as_deref() {
            Some(cursor) => self.decode_cursor(cursor, "search", Some(&request_key))?,
            None => 0,
        };
        let mut candidates = self.search_candidates(
            &query,
            &artifact_indices,
            input.anchor_lids.as_deref().unwrap_or_default(),
            false,
        );
        if candidates.is_empty() {
            candidates = self.search_candidates(
                &query,
                &artifact_indices,
                input.anchor_lids.as_deref().unwrap_or_default(),
                true,
            );
        }
        if start > candidates.len() {
            return Err(ArtifactToolError::new(
                ARTIFACT_CURSOR_INVALID,
                "search cursor is outside these results",
            ));
        }
        let limit = resolve_limit(
            input.limit,
            DEFAULT_SEARCH_LIMIT,
            MAX_SEARCH_RESULT_LIMIT,
            "search limit",
        )?;
        self.search_page(&candidates, start, limit, &request_key)
    }

    fn resolve_search_artifacts(
        &self,
        references: Option<&[String]>,
    ) -> Result<Vec<usize>, ArtifactToolError> {
        let Some(references) = references else {
            return Ok((0..self.artifacts.len()).collect());
        };
        let mut selected = HashSet::with_capacity(references.len());
        for reference in references {
            let index = self
                .artifact_positions
                .get(reference)
                .copied()
                .ok_or_else(|| {
                    ArtifactToolError::new(
                        ARTIFACT_REF_INVALID,
                        "artifact_ref does not belong to this snapshot",
                    )
                })?;
            selected.insert(index);
        }
        Ok((0..self.artifacts.len())
            .filter(|index| selected.contains(index))
            .collect())
    }

    fn search_candidates(
        &self,
        query: &SearchQuery,
        artifact_indices: &[usize],
        anchor_lids: &[String],
        typo: bool,
    ) -> Vec<SearchCandidate> {
        let mut candidates = Vec::new();
        for artifact_index in artifact_indices {
            let artifact = &self.artifacts[*artifact_index];
            let routing = match_routing_card(&artifact.routing_card, query, typo);
            let mut matches = artifact
                .records
                .iter()
                .map(|record| {
                    let mut aggregate = routing.clone();
                    aggregate.merge(&match_data(
                        &record.input.data,
                        &artifact.search_fields,
                        query,
                        typo,
                        "",
                    ));
                    (aggregate, Vec::<String>::new())
                })
                .collect::<Vec<_>>();

            for relation in &artifact.relations {
                let relation_match = match_data(
                    &relation.input.data,
                    &artifact.search_fields,
                    query,
                    typo,
                    "relation:",
                );
                if !relation_match.is_match() {
                    continue;
                }
                for reference in [&relation.source_reference, &relation.target_reference] {
                    if let Some(position) = artifact.record_positions.get(reference) {
                        matches[*position].0.merge(&relation_match);
                        append_unique(&mut matches[*position].1, &relation.input.evidence_lids);
                    }
                }
            }

            for (record_index, (aggregate, relation_evidence)) in matches.into_iter().enumerate() {
                if !aggregate.is_match() {
                    continue;
                }
                let record = &artifact.records[record_index];
                let mut evidence_lids = record.input.evidence_lids.clone();
                append_unique(&mut evidence_lids, &relation_evidence);
                let coverage = ((aggregate.covered_terms.len() * 1_000) / query.terms.len()) as u64;
                let anchor_bonus = if evidence_lids.iter().any(|evidence| {
                    anchor_lids
                        .iter()
                        .any(|anchor| lid_ranges_overlap(evidence, anchor))
                }) {
                    ANCHOR_SCORE_BONUS
                } else {
                    0
                };
                let score = aggregate
                    .tier
                    .saturating_mul(SCORE_TIER_SCALE)
                    .saturating_add(
                        aggregate
                            .weighted_quality
                            .saturating_mul(SCORE_WEIGHT_SCALE),
                    )
                    .saturating_add(coverage.saturating_mul(SCORE_COVERAGE_SCALE))
                    .saturating_add(anchor_bonus);
                candidates.push(SearchCandidate {
                    artifact_index: *artifact_index,
                    record_index,
                    score,
                    matched_fields: aggregate.matched_fields.into_iter().collect(),
                    matched_terms: aggregate.matched_terms.into_iter().collect(),
                    evidence_lids,
                });
            }
        }
        candidates.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.artifact_index.cmp(&right.artifact_index))
                .then_with(|| left.record_index.cmp(&right.record_index))
        });
        candidates
    }

    fn search_page(
        &self,
        candidates: &[SearchCandidate],
        start: usize,
        limit: usize,
        request_key: &str,
    ) -> Result<ArtifactSearchResultV1, ArtifactToolError> {
        let mut result = ArtifactSearchResultV1 {
            version: "artifact_search.v1".into(),
            overlay_revision: self.overlay_revision.clone(),
            hits: Vec::new(),
            next_cursor: None,
        };
        let end = (start + limit).min(candidates.len());
        let mut next_offset = start;
        for candidate in &candidates[start..end] {
            let artifact = &self.artifacts[candidate.artifact_index];
            let record = &artifact.records[candidate.record_index];
            let full = self.search_hit(candidate, artifact, record, false);
            let mut trial = result.clone();
            trial.hits.push(full);
            next_offset += 1;
            trial.next_cursor = (next_offset < candidates.len())
                .then(|| self.encode_cursor("search", Some(request_key), next_offset));
            if serialized_len(&trial)? <= MAX_SEARCH_RESULT_BYTES {
                result = trial;
                continue;
            }

            let summary = self.search_hit(candidate, artifact, record, true);
            let mut trial = result.clone();
            trial.hits.push(summary);
            trial.next_cursor = (next_offset < candidates.len())
                .then(|| self.encode_cursor("search", Some(request_key), next_offset));
            if serialized_len(&trial)? <= MAX_SEARCH_RESULT_BYTES {
                result = trial;
                continue;
            }

            next_offset -= 1;
            if result.hits.is_empty() {
                return Err(ArtifactToolError::new(
                    ARTIFACT_RESULT_TOO_LARGE,
                    "one search summary exceeds the search result budget",
                ));
            }
            break;
        }
        result.next_cursor = (next_offset < candidates.len())
            .then(|| self.encode_cursor("search", Some(request_key), next_offset));
        Ok(result)
    }

    fn search_hit(
        &self,
        candidate: &SearchCandidate,
        artifact: &SnapshotArtifact,
        record: &SnapshotRecord,
        summary: bool,
    ) -> ArtifactSearchHitV1 {
        ArtifactSearchHitV1 {
            artifact_ref: artifact.reference.clone(),
            record_ref: record.reference.clone(),
            data: if summary {
                select_fields(&record.input.data, Some(&artifact.summary_fields))
            } else {
                record.input.data.clone()
            },
            evidence_lids: candidate.evidence_lids.clone(),
            matched_fields: candidate.matched_fields.clone(),
            matched_terms: candidate.matched_terms.clone(),
            score: candidate.score,
            truncated: summary,
        }
    }
}

fn match_routing_card(
    card: &ArtifactRoutingCardV1,
    query: &SearchQuery,
    typo: bool,
) -> MatchAggregate {
    let mut aggregate = MatchAggregate::default();
    for (field, weight, values) in [
        ("routing.title", 8, std::slice::from_ref(&card.title)),
        ("routing.purpose", 5, std::slice::from_ref(&card.purpose)),
        ("routing.use_when", 6, card.use_when.as_slice()),
        ("routing.covered_topics", 7, card.covered_topics.as_slice()),
        (
            "routing.scope_label",
            2,
            std::slice::from_ref(&card.scope_label),
        ),
    ] {
        for value in values {
            if let Some(result) = match_text(value, query, ArtifactSearchAnalyzer::Text, typo) {
                aggregate.add(field, weight, result);
            }
        }
    }
    aggregate
}

fn match_data(
    data: &Map<String, Value>,
    fields: &[ArtifactSnapshotSearchField],
    query: &SearchQuery,
    typo: bool,
    prefix: &str,
) -> MatchAggregate {
    let mut aggregate = MatchAggregate::default();
    for field in fields {
        let Some(value) = pointer_value(data, &field.path) else {
            continue;
        };
        let Some(text) = scalar_text(value) else {
            continue;
        };
        if let Some(result) = match_text(&text, query, field.analyzer, typo) {
            aggregate.add(&format!("{prefix}{}", field.path), field.weight, result);
        }
    }
    aggregate
}

fn scalar_text(value: &Value) -> Option<Cow<'_, str>> {
    match value {
        Value::String(value) => Some(Cow::Borrowed(value)),
        Value::Number(value) => Some(Cow::Owned(value.to_string())),
        Value::Bool(value) => Some(Cow::Owned(value.to_string())),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn match_text(
    value: &str,
    query: &SearchQuery,
    analyzer: ArtifactSearchAnalyzer,
    typo: bool,
) -> Option<FieldMatch> {
    let normalized = normalize(value);
    if normalized.is_empty() {
        return None;
    }
    if analyzer == ArtifactSearchAnalyzer::Keyword {
        return (normalized == query.normalized).then(|| full_match(5, 5_000, query));
    }
    if normalized == query.normalized {
        return Some(full_match(5, 5_000, query));
    }
    if contains_phrase(&normalized, &query.normalized) {
        return Some(full_match(4, 4_000, query));
    }
    if !query.compact.is_empty() && compact(&normalized).contains(&query.compact) {
        return Some(full_match(3, 3_000, query));
    }
    if typo {
        return typo_match(&normalized, query);
    }
    token_match(&normalized, query)
}

fn full_match(tier: u64, quality: u64, query: &SearchQuery) -> FieldMatch {
    let terms = query
        .terms
        .iter()
        .map(|term| term.text.clone())
        .collect::<Vec<_>>();
    FieldMatch {
        tier,
        quality,
        explanations: terms.clone(),
        covered_terms: terms,
    }
}

fn token_match(value: &str, query: &SearchQuery) -> Option<FieldMatch> {
    let words = word_tokens(value).into_iter().collect::<HashSet<_>>();
    let compact_value = compact(value);
    let matched = query
        .terms
        .iter()
        .filter(|term| match term.kind {
            QueryTermKind::Word => words.contains(term.text.as_str()),
            QueryTermKind::CjkGram => compact_value.contains(&term.text),
        })
        .map(|term| term.text.clone())
        .collect::<Vec<_>>();
    if matched.is_empty() {
        return None;
    }
    Some(FieldMatch {
        tier: 2,
        quality: ((matched.len() * 2_000) / query.terms.len()) as u64,
        explanations: matched.clone(),
        covered_terms: matched,
    })
}

fn typo_match(value: &str, query: &SearchQuery) -> Option<FieldMatch> {
    let eligible = query
        .terms
        .iter()
        .filter(|term| {
            term.kind == QueryTermKind::Word
                && term.text.is_ascii()
                && (5..=32).contains(&term.text.len())
        })
        .take(MAX_TYPO_QUERY_TERMS)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return None;
    }
    let field_terms = word_tokens(value)
        .into_iter()
        .filter(|term| term.is_ascii() && (5..=32).contains(&term.len()))
        .take(MAX_TYPO_FIELD_TERMS)
        .collect::<Vec<_>>();
    let mut explanations = Vec::new();
    let mut covered_terms = Vec::new();
    for query_term in &eligible {
        if let Some(field_term) = field_terms
            .iter()
            .find(|field_term| bounded_edit_distance_one(&query_term.text, field_term))
        {
            explanations.push(format!("{}~{field_term}", query_term.text));
            covered_terms.push(query_term.text.clone());
        }
    }
    if covered_terms.is_empty() {
        return None;
    }
    Some(FieldMatch {
        tier: 1,
        quality: ((covered_terms.len() * 500) / eligible.len()) as u64,
        explanations,
        covered_terms,
    })
}

fn bounded_edit_distance_one(left: &str, right: &str) -> bool {
    if left == right || left.len().abs_diff(right.len()) > 1 {
        return false;
    }
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() == right.len() {
        return left
            .iter()
            .zip(right)
            .filter(|(left, right)| left != right)
            .count()
            == 1;
    }
    let (shorter, longer) = if left.len() < right.len() {
        (left, right)
    } else {
        (right, left)
    };
    let mut short_index = 0;
    let mut long_index = 0;
    let mut skipped = false;
    while short_index < shorter.len() && long_index < longer.len() {
        if shorter[short_index] == longer[long_index] {
            short_index += 1;
            long_index += 1;
        } else if skipped {
            return false;
        } else {
            skipped = true;
            long_index += 1;
        }
    }
    true
}

fn normalize(value: &str) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for value in value.nfkc().case_fold() {
        if value.is_whitespace() {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
                pending_space = false;
            }
            output.push(value);
        }
    }
    output
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_alphanumeric() || is_cjk(*value))
        .collect()
}

fn query_terms(value: &str) -> Vec<QueryTerm> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut word = String::new();
    let mut cjk = Vec::new();

    let flush_word =
        |word: &mut String, output: &mut Vec<QueryTerm>, seen: &mut HashSet<String>| {
            if !word.is_empty() {
                push_query_term(output, seen, std::mem::take(word), QueryTermKind::Word);
            }
        };
    let flush_cjk =
        |cjk: &mut Vec<char>, output: &mut Vec<QueryTerm>, seen: &mut HashSet<String>| {
            if cjk.is_empty() {
                return;
            }
            if cjk.len() == 1 {
                push_query_term(output, seen, cjk.iter().collect(), QueryTermKind::CjkGram);
            } else {
                for size in [2, 3] {
                    if cjk.len() >= size {
                        for window in cjk.windows(size) {
                            push_query_term(
                                output,
                                seen,
                                window.iter().collect(),
                                QueryTermKind::CjkGram,
                            );
                        }
                    }
                }
            }
            cjk.clear();
        };

    for value in value.chars() {
        if is_cjk(value) {
            flush_word(&mut word, &mut output, &mut seen);
            cjk.push(value);
        } else if value.is_alphanumeric() {
            flush_cjk(&mut cjk, &mut output, &mut seen);
            word.push(value);
        } else {
            flush_word(&mut word, &mut output, &mut seen);
            flush_cjk(&mut cjk, &mut output, &mut seen);
        }
        if output.len() >= MAX_QUERY_TERMS {
            break;
        }
    }
    if output.len() < MAX_QUERY_TERMS {
        flush_word(&mut word, &mut output, &mut seen);
    }
    if output.len() < MAX_QUERY_TERMS {
        flush_cjk(&mut cjk, &mut output, &mut seen);
    }
    output.truncate(MAX_QUERY_TERMS);
    output
}

fn push_query_term(
    output: &mut Vec<QueryTerm>,
    seen: &mut HashSet<String>,
    text: String,
    kind: QueryTermKind,
) {
    if output.len() < MAX_QUERY_TERMS && seen.insert(text.clone()) {
        output.push(QueryTerm { text, kind });
    }
}

fn word_tokens(value: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = String::new();
    for value in value.chars() {
        if value.is_alphanumeric() && !is_cjk(value) {
            current.push(value);
        } else if !current.is_empty() {
            output.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        output.push(current);
    }
    output
}

fn contains_phrase(value: &str, query: &str) -> bool {
    value.match_indices(query).any(|(start, matched)| {
        let end = start + matched.len();
        let left_ok = query
            .chars()
            .next()
            .is_none_or(|first| !needs_word_boundary(first))
            || value[..start]
                .chars()
                .next_back()
                .is_none_or(|previous| !needs_word_boundary(previous));
        let right_ok = query
            .chars()
            .next_back()
            .is_none_or(|last| !needs_word_boundary(last))
            || value[end..]
                .chars()
                .next()
                .is_none_or(|next| !needs_word_boundary(next));
        left_ok && right_ok
    })
}

fn needs_word_boundary(value: char) -> bool {
    value.is_alphanumeric() && !is_cjk(value)
}

fn is_cjk(value: char) -> bool {
    matches!(
        value as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2EBEF
            | 0x30000..=0x323AF
    )
}

fn pointer_value<'a>(data: &'a Map<String, Value>, pointer: &str) -> Option<&'a Value> {
    let mut segments = pointer.split('/').skip(1);
    let first = decode_pointer_segment(segments.next()?);
    let mut current = data.get(first.as_ref())?;
    for segment in segments {
        let segment = decode_pointer_segment(segment);
        current = match current {
            Value::Object(object) => object.get(segment.as_ref())?,
            Value::Array(array) => array.get(pointer_index(segment.as_ref())?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn decode_pointer_segment(value: &str) -> Cow<'_, str> {
    if value.contains('~') {
        Cow::Owned(value.replace("~1", "/").replace("~0", "~"))
    } else {
        Cow::Borrowed(value)
    }
}

fn pointer_index(value: &str) -> Option<usize> {
    if value == "0"
        || (!value.starts_with('0') && value.bytes().all(|value| value.is_ascii_digit()))
    {
        value.parse().ok()
    } else {
        None
    }
}

fn append_unique(target: &mut Vec<String>, additions: &[String]) {
    let mut seen = target.iter().cloned().collect::<HashSet<_>>();
    for addition in additions {
        if seen.insert(addition.clone()) {
            target.push(addition.clone());
        }
    }
}

fn lid_ranges_overlap(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('.'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn search_request_key(
    normalized_query: &str,
    artifact_refs: Option<&[String]>,
    anchor_lids: Option<&[String]>,
) -> String {
    let mut artifacts = artifact_refs.unwrap_or_default().to_vec();
    let mut anchors = anchor_lids.unwrap_or_default().to_vec();
    artifacts.sort();
    anchors.sort();
    let mut parts = vec![
        "artifact-search-request.v1",
        ARTIFACT_SEARCH_NORMALIZATION_VERSION,
        normalized_query,
    ];
    parts.extend(artifacts.iter().map(String::as_str));
    parts.push("artifact-search-anchors.v1");
    parts.extend(anchors.iter().map(String::as_str));
    hex_digest(&digest_parts(&parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_and_term_generation_are_versioned_and_stable() {
        assert_eq!(
            normalize("  ＣＡＲＤＩＡＣ\r\nSplicing  "),
            "cardiac splicing"
        );
        assert_eq!(
            query_terms("心脏诊断")
                .into_iter()
                .map(|term| term.text)
                .collect::<Vec<_>>(),
            ["心脏", "脏诊", "诊断", "心脏诊", "脏诊断"]
        );
        assert!(ARTIFACT_SEARCH_NORMALIZATION_VERSION.contains("nfkc"));
    }

    #[test]
    fn shared_weighted_text_search_reuses_unicode_cjk_and_field_weights() {
        let fields = [
            WeightedTextField {
                name: "name",
                weight: 10,
                value: "book.structure",
            },
            WeightedTextField {
                name: "use_when",
                weight: 7,
                value: "查看这本书的结构、主要内容与关键停靠点",
            },
            WeightedTextField {
                name: "avoid_when",
                weight: 1,
                value: "不要用它读取正文",
            },
        ];

        let first = score_weighted_text_fields("这本书主要讲什么", &fields).unwrap();
        let second = score_weighted_text_fields("这本书主要讲什么", &fields).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.matched_fields, vec!["use_when"]);
        assert!(first.matched_terms.iter().any(|term| term == "这本"));
        assert!(first.matched_terms.iter().any(|term| term == "主要"));
        assert!(first.score > 0);
    }

    #[test]
    fn typo_distance_is_ascii_bounded_to_one_edit() {
        assert!(bounded_edit_distance_one("splicng", "splicing"));
        assert!(bounded_edit_distance_one("splicing", "splicang"));
        assert!(!bounded_edit_distance_one("splicing", "splicing"));
        assert!(!bounded_edit_distance_one("splicng", "splitting"));
    }
}
