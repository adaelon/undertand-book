//! Typed `book.query` goldset evaluation and fixed Top-K replay.
//!
//! Expected bindings, outcome status, and citation LIDs are external fixtures.
//! Model self-scores never participate in the report.

use crate::{
    query_run_with_budgets, BookQueryRequest, ModelAdapter, QueryBudgets, QueryOutcome, QueryRun,
    ReferentBinding,
};
use read_tools::{Book, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoldBindingExpectation {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoldItem {
    pub id: String,
    pub request: BookQueryRequest,
    pub expect_bindings: Vec<GoldBindingExpectation>,
    pub expect_cite: Vec<String>,
    pub expect_status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemResult {
    pub id: String,
    pub anchor_lid: String,
    pub expect_status: String,
    pub returned_status: String,
    pub status_ok: bool,
    pub expect_bindings: Vec<GoldBindingExpectation>,
    pub returned_bindings: Vec<ReferentBinding>,
    pub binding_recall: f32,
    pub binding_precision: f32,
    pub expect_cite: Vec<String>,
    pub returned_cite: Vec<String>,
    pub structural_ok: bool,
    pub dangling: Vec<String>,
    pub citation_recall: f32,
    pub citation_precision: f32,
    pub evidence_chars: usize,
    pub model_calls: usize,
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoldReport {
    pub total: usize,
    pub evaluated: usize,
    pub errored: usize,
    pub structural_pass: usize,
    pub structural_redline_pct: f32,
    pub status_pass: usize,
    pub status_match_pct: f32,
    pub mean_binding_recall: f32,
    pub mean_binding_precision: f32,
    pub mean_citation_recall: f32,
    pub mean_citation_precision: f32,
    pub complete_count: usize,
    pub partial_count: usize,
    pub insufficient_count: usize,
    pub ambiguous_count: usize,
    pub unresolved_count: usize,
    pub invalid_plan_count: usize,
    pub mean_evidence_chars: f32,
    pub mean_model_calls: f32,
    pub items: Vec<ItemResult>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopKReplayRow {
    pub candidate_top_k_total: usize,
    pub total: usize,
    pub errored: usize,
    pub mean_binding_recall: f32,
    pub ambiguous_count: usize,
    pub unresolved_count: usize,
    pub complete_count: usize,
    pub partial_count: usize,
    pub mean_evidence_chars: f32,
    pub mean_model_calls: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopKReplayReport {
    pub budget_version: String,
    pub default_candidate_top_k_total: usize,
    pub rows: Vec<TopKReplayRow>,
}

fn is_real_lid(book: &Book, lid: &str) -> bool {
    book.base.lid_nodes.iter().any(|node| node.lid == lid)
}

pub fn structural_check(book: &Book, returned: &[String]) -> (bool, Vec<String>) {
    let dangling: Vec<String> = returned
        .iter()
        .filter(|lid| !is_real_lid(book, lid))
        .cloned()
        .collect();
    (dangling.is_empty(), dangling)
}

pub fn semantic_metrics(returned: &[String], expect: &[String]) -> (f32, f32) {
    let expected: HashSet<&String> = expect.iter().collect();
    let intersection = returned
        .iter()
        .filter(|item| expected.contains(item))
        .count();
    let recall = if expect.is_empty() {
        1.0
    } else {
        intersection as f32 / expect.len() as f32
    };
    let precision = if returned.is_empty() {
        if expect.is_empty() {
            1.0
        } else {
            0.0
        }
    } else {
        intersection as f32 / returned.len() as f32
    };
    (recall, precision)
}

fn binding_matches(expectation: &GoldBindingExpectation, binding: &ReferentBinding) -> bool {
    expectation.target == binding.target
        && expectation
            .candidate_id
            .as_ref()
            .is_none_or(|expected| expected == &binding.candidate_id)
        && expectation
            .canonical_label
            .as_ref()
            .is_none_or(|expected| expected == &binding.canonical_label)
}

fn binding_metrics(returned: &[ReferentBinding], expect: &[GoldBindingExpectation]) -> (f32, f32) {
    let matched_expectations = expect
        .iter()
        .filter(|expected| {
            returned
                .iter()
                .any(|binding| binding_matches(expected, binding))
        })
        .count();
    let matched_bindings = returned
        .iter()
        .filter(|binding| {
            expect
                .iter()
                .any(|expected| binding_matches(expected, binding))
        })
        .count();
    let recall = if expect.is_empty() {
        1.0
    } else {
        matched_expectations as f32 / expect.len() as f32
    };
    let precision = if returned.is_empty() {
        if expect.is_empty() {
            1.0
        } else {
            0.0
        }
    } else {
        matched_bindings as f32 / returned.len() as f32
    };
    (recall, precision)
}

fn outcome_status(outcome: &QueryOutcome) -> &'static str {
    match outcome {
        QueryOutcome::Complete { .. } => "complete",
        QueryOutcome::Partial { .. } => "partial",
        QueryOutcome::Insufficient { .. } => "insufficient",
        QueryOutcome::InvalidPlan { .. } => "invalid_plan",
        QueryOutcome::Ambiguous { .. } => "ambiguous",
        QueryOutcome::Unresolved { .. } => "unresolved",
    }
}

fn outcome_payload(
    outcome: &QueryOutcome,
) -> Option<(&Option<String>, &[crate::Citation], &[ReferentBinding])> {
    match outcome {
        QueryOutcome::Complete {
            answer,
            citations,
            bindings,
            ..
        }
        | QueryOutcome::Partial {
            answer,
            citations,
            bindings,
            ..
        }
        | QueryOutcome::Insufficient {
            answer,
            citations,
            bindings,
            ..
        } => Some((answer, citations, bindings)),
        QueryOutcome::InvalidPlan { .. }
        | QueryOutcome::Ambiguous { .. }
        | QueryOutcome::Unresolved { .. } => None,
    }
}

fn returned_lids(outcome: &QueryOutcome) -> Vec<String> {
    let mut seen = HashSet::new();
    outcome_payload(outcome)
        .map(|(_, citations, _)| {
            citations
                .iter()
                .filter(|citation| seen.insert(citation.lid.clone()))
                .map(|citation| citation.lid.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn evaluate_run(book: &Book, item: &GoldItem, run: QueryRun) -> ItemResult {
    let returned_status = outcome_status(&run.response).to_string();
    let status_ok = returned_status == item.expect_status;
    let returned_cite = returned_lids(&run.response);
    let (structural_ok, dangling) = structural_check(book, &returned_cite);
    let (citation_recall, citation_precision) = semantic_metrics(&returned_cite, &item.expect_cite);
    let (answer, returned_bindings) = outcome_payload(&run.response)
        .map(|(answer, _, bindings)| (answer.clone(), bindings.to_vec()))
        .unwrap_or_default();
    let (binding_recall, binding_precision) =
        binding_metrics(&returned_bindings, &item.expect_bindings);
    ItemResult {
        id: item.id.clone(),
        anchor_lid: item.request.anchor_lid.clone(),
        expect_status: item.expect_status.clone(),
        returned_status,
        status_ok,
        expect_bindings: item.expect_bindings.clone(),
        returned_bindings,
        binding_recall,
        binding_precision,
        expect_cite: item.expect_cite.clone(),
        returned_cite,
        structural_ok,
        dangling,
        citation_recall,
        citation_precision,
        evidence_chars: run.audit.evidence.chars_used,
        model_calls: run.audit.model_calls,
        answer,
        error: None,
    }
}

fn evaluate_item_with_budgets(
    book: &Book,
    adapter: &dyn ModelAdapter,
    item: &GoldItem,
    budgets: &QueryBudgets,
) -> Result<ItemResult, ToolError> {
    query_run_with_budgets(book, &item.request, adapter, budgets)
        .map(|run| evaluate_run(book, item, run))
}

pub fn evaluate_item(
    book: &Book,
    adapter: &dyn ModelAdapter,
    item: &GoldItem,
) -> Result<ItemResult, ToolError> {
    evaluate_item_with_budgets(book, adapter, item, &QueryBudgets::default())
}

fn errored_item(item: &GoldItem, message: String) -> ItemResult {
    ItemResult {
        id: item.id.clone(),
        anchor_lid: item.request.anchor_lid.clone(),
        expect_status: item.expect_status.clone(),
        returned_status: String::new(),
        status_ok: false,
        expect_bindings: item.expect_bindings.clone(),
        returned_bindings: Vec::new(),
        binding_recall: 0.0,
        binding_precision: 0.0,
        expect_cite: item.expect_cite.clone(),
        returned_cite: Vec::new(),
        structural_ok: false,
        dangling: Vec::new(),
        citation_recall: 0.0,
        citation_precision: 0.0,
        evidence_chars: 0,
        model_calls: 0,
        answer: None,
        error: Some(message),
    }
}

pub fn build_report(results: Vec<ItemResult>) -> GoldReport {
    let total = results.len();
    let errored = results
        .iter()
        .filter(|result| result.error.is_some())
        .count();
    let evaluated = total - errored;
    let structural_pass = results
        .iter()
        .filter(|result| result.error.is_none() && result.structural_ok)
        .count();
    let status_pass = results
        .iter()
        .filter(|result| result.error.is_none() && result.status_ok)
        .count();
    let pct = |count: usize| {
        if evaluated == 0 {
            100.0
        } else {
            count as f32 / evaluated as f32 * 100.0
        }
    };
    let mean = |field: &dyn Fn(&ItemResult) -> f32| {
        if evaluated == 0 {
            0.0
        } else {
            results
                .iter()
                .filter(|result| result.error.is_none())
                .map(field)
                .sum::<f32>()
                / evaluated as f32
        }
    };
    let status_count = |status: &str| {
        results
            .iter()
            .filter(|result| result.error.is_none() && result.returned_status == status)
            .count()
    };
    GoldReport {
        total,
        evaluated,
        errored,
        structural_pass,
        structural_redline_pct: pct(structural_pass),
        status_pass,
        status_match_pct: pct(status_pass),
        mean_binding_recall: mean(&|result| result.binding_recall),
        mean_binding_precision: mean(&|result| result.binding_precision),
        mean_citation_recall: mean(&|result| result.citation_recall),
        mean_citation_precision: mean(&|result| result.citation_precision),
        complete_count: status_count("complete"),
        partial_count: status_count("partial"),
        insufficient_count: status_count("insufficient"),
        ambiguous_count: status_count("ambiguous"),
        unresolved_count: status_count("unresolved"),
        invalid_plan_count: status_count("invalid_plan"),
        mean_evidence_chars: mean(&|result| result.evidence_chars as f32),
        mean_model_calls: mean(&|result| result.model_calls as f32),
        items: results,
    }
}

pub fn run_goldset(
    book: &Book,
    adapter: &dyn ModelAdapter,
    items: &[GoldItem],
) -> Result<GoldReport, ToolError> {
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let result = match evaluate_item(book, adapter, item) {
            Ok(result) => result,
            Err(_) => match evaluate_item(book, adapter, item) {
                Ok(result) => result,
                Err(error) => errored_item(
                    item,
                    format!(
                        "[{}/{}] {}",
                        error.category, error.error_code, error.message
                    ),
                ),
            },
        };
        results.push(result);
    }
    Ok(build_report(results))
}

pub fn run_topk_replay(
    book: &Book,
    adapter: &dyn ModelAdapter,
    items: &[GoldItem],
    top_ks: &[usize],
) -> Result<TopKReplayReport, ToolError> {
    let defaults = QueryBudgets::default();
    let mut rows = Vec::with_capacity(top_ks.len());
    for &top_k in top_ks {
        let budgets = QueryBudgets {
            candidate_top_k_total: top_k,
            ..defaults.clone()
        };
        let results = items
            .iter()
            .map(|item| evaluate_item_with_budgets(book, adapter, item, &budgets))
            .collect::<Result<Vec<_>, _>>()?;
        let report = build_report(results);
        rows.push(TopKReplayRow {
            candidate_top_k_total: top_k,
            total: report.total,
            errored: report.errored,
            mean_binding_recall: report.mean_binding_recall,
            ambiguous_count: report.ambiguous_count,
            unresolved_count: report.unresolved_count,
            complete_count: report.complete_count,
            partial_count: report.partial_count,
            mean_evidence_chars: report.mean_evidence_chars,
            mean_model_calls: report.mean_model_calls,
        });
    }
    Ok(TopKReplayReport {
        budget_version: defaults.version,
        default_candidate_top_k_total: defaults.candidate_top_k_total,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AdapterError, AssistantTurn, BookQueryIntent, CompletionRequest, Message, ParsedResponse,
        QueryObligation, ToolSpec,
    };
    use base_schema::sample_base;
    use read_tools::{PaperLexiconEntry, PaperLexiconSidecar, ProfileArtifactHeader};

    fn technical_book() -> Book {
        Book::new(sample_base(), &("command ".to_string() + &"X".repeat(192)))
    }

    fn paper_book() -> Book {
        let base = sample_base();
        let book_id = base.book_id.clone();
        Book::new(base, &("RAG ".to_string() + &"X".repeat(196))).with_paper_lexicon(Some(
            PaperLexiconSidecar {
                header: ProfileArtifactHeader {
                    book_id,
                    book_version: "1".into(),
                    profile_id: "paper".into(),
                    profile_version: "1".into(),
                    core_schema_version: "1".into(),
                    generated_at: "fixture".into(),
                },
                entries: vec![PaperLexiconEntry {
                    term: "RAG".into(),
                    term_type: "acronym".into(),
                    occurrences_lids: vec!["1.1".into()],
                    defined_at_lid: Some("1.1".into()),
                    aliases: vec!["Retrieval Augmented Generation".into()],
                    acronym_expansion: Some("Retrieval Augmented Generation".into()),
                    chinese_gloss: None,
                }],
            },
        ))
    }

    fn item(target: &str, canonical_label: &str) -> GoldItem {
        GoldItem {
            id: format!("fixture-{target}"),
            request: BookQueryRequest {
                query: format!("what is {target}"),
                intent: BookQueryIntent::Definition,
                targets: vec![target.into()],
                obligations: vec![QueryObligation {
                    requirement: format!("define {target}"),
                }],
                anchor_lid: "1.1".into(),
            },
            expect_bindings: vec![GoldBindingExpectation {
                target: target.into(),
                candidate_id: None,
                canonical_label: Some(canonical_label.into()),
            }],
            expect_cite: vec!["1.1".into()],
            expect_status: "complete".into(),
        }
    }

    struct DeterministicAdapter;

    impl ModelAdapter for DeterministicAdapter {
        fn complete(&self, _: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Err(AdapterError {
                message: "typed query must use complete_structured".into(),
            })
        }

        fn complete_structured(
            &self,
            request: CompletionRequest,
        ) -> Result<serde_json::Value, AdapterError> {
            let input: serde_json::Value =
                serde_json::from_str(&request.user).map_err(|error| AdapterError {
                    message: error.to_string(),
                })?;
            if let Some(groups) = input
                .get("candidate_groups")
                .and_then(|value| value.as_array())
            {
                let mut fits = Vec::new();
                for group in groups {
                    let target_index = group["target_index"].as_u64().unwrap_or_default();
                    for (index, candidate) in group["candidates"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .enumerate()
                    {
                        fits.push(serde_json::json!({
                            "target_index": target_index,
                            "candidate_id": candidate["candidate_id"],
                            "fit": if index == 0 { "direct_match" } else { "reject" },
                            "reason": "deterministic gold fixture"
                        }));
                    }
                }
                return Ok(serde_json::json!({
                    "plan_gate": {
                        "valid": true,
                        "missing_requirements": [],
                        "target_issues": []
                    },
                    "candidate_fits": fits,
                    "probes": []
                }));
            }

            let evidence = input["source_evidence"]
                .as_array()
                .and_then(|items| items.first())
                .ok_or_else(|| AdapterError {
                    message: "missing source evidence".into(),
                })?;
            let lid = evidence["lid"].as_str().unwrap_or("1.1");
            let quote: String = evidence["text"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(4)
                .collect();
            let assessments = input["request"]["obligations"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, _)| {
                    serde_json::json!({
                        "obligation_index": index,
                        "verdict": "supported",
                        "citation_lids": [lid],
                        "support_note": "deterministic source support"
                    })
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "answer": "fixture answer",
                "assessments": assessments,
                "citations": [{"lid": lid, "text": quote, "role": "support"}],
                "model_supplement": []
            }))
        }

        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("goldset calls the inner typed query only")
        }
    }

    #[test]
    fn structural_check_flags_dangling() {
        let book = technical_book();
        assert_eq!(structural_check(&book, &["1.1".into()]), (true, vec![]));
        assert_eq!(
            structural_check(&book, &["1.1".into(), "9.9".into()]),
            (false, vec!["9.9".into()])
        );
    }

    #[test]
    fn semantic_metrics_recall_precision() {
        assert_eq!(
            semantic_metrics(&["a".into(), "b".into()], &["a".into(), "b".into()]),
            (1.0, 1.0)
        );
        assert_eq!(
            semantic_metrics(&["a".into(), "c".into()], &["a".into(), "b".into()]),
            (0.5, 0.5)
        );
    }

    #[test]
    fn run_goldset_uses_expected_binding_status_and_lids() {
        let report = run_goldset(
            &technical_book(),
            &DeterministicAdapter,
            &[item("command", "command")],
        )
        .unwrap();
        assert_eq!(report.structural_redline_pct, 100.0);
        assert_eq!(report.status_match_pct, 100.0);
        assert_eq!(report.mean_binding_recall, 1.0);
        assert_eq!(report.mean_citation_recall, 1.0);
        assert_eq!(report.mean_model_calls, 2.0);
    }

    #[test]
    fn bundled_goldset_uses_typed_query_contract() {
        let items: Vec<GoldItem> =
            serde_json::from_str(include_str!("../goldset/game-programming-patterns.json"))
                .unwrap();
        assert_eq!(items.len(), 12);
        assert!(items.iter().all(|item| {
            !item.request.targets.is_empty()
                && !item.request.obligations.is_empty()
                && !item.expect_bindings.is_empty()
                && !item.expect_status.is_empty()
        }));
    }

    #[test]
    fn referent_topk_replay_reports_k_5_8_12_20_without_mutating_defaults() {
        let top_ks = [5, 8, 12, 20];
        let technical = run_topk_replay(
            &technical_book(),
            &DeterministicAdapter,
            &[item("command", "command")],
            &top_ks,
        )
        .unwrap();
        let paper = run_topk_replay(
            &paper_book(),
            &DeterministicAdapter,
            &[item("RAG", "RAG")],
            &top_ks,
        )
        .unwrap();

        for report in [&technical, &paper] {
            assert_eq!(report.default_candidate_top_k_total, 12);
            assert_eq!(
                report
                    .rows
                    .iter()
                    .map(|row| row.candidate_top_k_total)
                    .collect::<Vec<_>>(),
                top_ks
            );
            assert!(report
                .rows
                .iter()
                .all(|row| row.mean_binding_recall == 1.0 && row.complete_count == 1));
            assert!(report
                .rows
                .iter()
                .all(|row| row.ambiguous_count == 0 && row.unresolved_count == 0));
            assert!(report
                .rows
                .iter()
                .all(|row| row.mean_evidence_chars > 0.0 && row.mean_model_calls == 2.0));
        }
        assert_eq!(QueryBudgets::default().candidate_top_k_total, 12);
    }
}
