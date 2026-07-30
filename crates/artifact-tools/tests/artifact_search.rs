use artifact_tools::{
    aliases, artifact_search_input_schema, validate_artifact_search_input, ArtifactAccessSnapshot,
    ArtifactSearchAnalyzer, ArtifactSearchInput, ArtifactSnapshotBlueprint, ArtifactSnapshotItem,
    ArtifactSnapshotRecord, ArtifactSnapshotRelation, ArtifactSnapshotScope,
    ArtifactSnapshotSearchField, ArtifactToolId, ARTIFACT_CURSOR_INVALID, ARTIFACT_REF_INVALID,
    ARTIFACT_RESULT_TOO_LARGE, MAX_SEARCH_RESULT_BYTES,
};
use serde_json::{json, Map, Value};

const SEARCH_GOLDEN: &str = include_str!("fixtures/artifact-search.v1.golden.json");

fn record(id: &str, data: Value, evidence_lids: &[&str]) -> ArtifactSnapshotRecord {
    ArtifactSnapshotRecord {
        record_id: id.into(),
        data: data.as_object().unwrap().clone(),
        evidence_lids: evidence_lids.iter().map(|value| (*value).into()).collect(),
    }
}

fn blueprint(
    title: &str,
    search_fields: &[(&str, u8, ArtifactSearchAnalyzer)],
    summary_fields: &[&str],
) -> ArtifactSnapshotBlueprint {
    ArtifactSnapshotBlueprint {
        blueprint_digest: "a".repeat(64),
        title: title.into(),
        purpose: "Find diagnostic concepts.".into(),
        use_when: vec!["questions about cardiac mechanisms".into()],
        avoid_when: vec!["the user requests source text only".into()],
        covered_topics: vec!["cardiac biology".into()],
        scope_label: "confirmed scope".into(),
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

fn item(
    artifact_id: &str,
    blueprint: ArtifactSnapshotBlueprint,
    records: Vec<ArtifactSnapshotRecord>,
    relations: Vec<ArtifactSnapshotRelation>,
) -> ArtifactSnapshotItem {
    ArtifactSnapshotItem {
        artifact_id: artifact_id.into(),
        payload_digest: "c".repeat(64),
        blueprint,
        records,
        relations,
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

fn search(snapshot: &ArtifactAccessSnapshot, query: &str, limit: usize) -> Value {
    serde_json::to_value(
        snapshot
            .search(ArtifactSearchInput {
                query: query.into(),
                artifact_refs: None,
                anchor_lids: None,
                limit: Some(limit),
                cursor: None,
            })
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn search_alias_and_schema_are_closed_and_bounded() {
    assert_eq!(aliases(ArtifactToolId::Search).resident, "artifact.search");
    assert_eq!(aliases(ArtifactToolId::Search).mcp, "artifact_search");
    let schema = artifact_search_input_schema();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["query"]));
    assert!(validate_artifact_search_input(json!({"query": "x", "limit": 4})).is_err());
    assert!(validate_artifact_search_input(json!({"query": "  \n  "})).is_err());
    assert!(validate_artifact_search_input(json!({
        "query": "x",
        "artifact_refs": ["same", "same"]
    }))
    .is_err());
    assert!(validate_artifact_search_input(json!({"query": "x", "unknown": true})).is_err());
}

#[test]
fn golden_scores_lock_phrase_weight_coverage_and_chinese_ngrams() {
    let snapshot = snapshot(vec![item(
        "artifact-golden",
        blueprint(
            "Cardiac analysis",
            &[
                ("/label", 10, ArtifactSearchAnalyzer::Text),
                ("/detail", 4, ArtifactSearchAnalyzer::Text),
            ],
            &["/label"],
        ),
        vec![
            record(
                "record-phrase",
                json!({"label": "Cardiac splicing", "detail": "diagnostic target"}),
                &["1.1"],
            ),
            record(
                "record-coverage",
                json!({"label": "Cardiac remodeling", "detail": "splicing target"}),
                &["1.2"],
            ),
            record(
                "record-low-weight",
                json!({"label": "Unrelated", "detail": "cardiac splicing"}),
                &["1.3"],
            ),
            record(
                "record-chinese",
                json!({"label": "心脏可变剪接用于诊断", "detail": "mechanism"}),
                &["1.4"],
            ),
        ],
        vec![],
    )]);
    let golden: Value = serde_json::from_str(SEARCH_GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let result = search(&snapshot, case["query"].as_str().unwrap(), 3);
        let actual = result["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| {
                json!({
                    "label": hit["data"]["label"],
                    "score": hit["score"],
                    "matched_fields": hit["matched_fields"],
                    "matched_terms": hit["matched_terms"],
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(Value::Array(actual), case["expected"]);
    }
}

#[test]
fn free_form_topic_text_matches_a_natural_partial_query_while_keyword_stays_exact() {
    let topic = "KV Cache 与 Prompt Cache 友好架构";
    let snapshot = snapshot(vec![
        item(
            "artifact-topic-text",
            blueprint(
                "Interview questions",
                &[("/topic", 10, ArtifactSearchAnalyzer::Text)],
                &["/topic"],
            ),
            vec![record(
                "question-text",
                json!({"topic": topic, "analyzer": "text"}),
                &["1.1"],
            )],
            vec![],
        ),
        item(
            "artifact-topic-keyword",
            blueprint(
                "Interview questions",
                &[("/topic", 10, ArtifactSearchAnalyzer::Keyword)],
                &["/topic"],
            ),
            vec![record(
                "question-keyword",
                json!({"topic": topic, "analyzer": "keyword"}),
                &["1.2"],
            )],
            vec![],
        ),
    ]);

    let partial = search(&snapshot, "KV cache", 3);
    assert_eq!(partial["hits"].as_array().unwrap().len(), 1);
    assert_eq!(partial["hits"][0]["data"]["analyzer"], "text");

    let exact = search(&snapshot, topic, 3);
    assert_eq!(exact["hits"].as_array().unwrap().len(), 2);
}

#[test]
fn relation_fields_find_both_endpoints_and_explain_the_match() {
    let snapshot = snapshot(vec![item(
        "artifact-relations",
        blueprint(
            "Argument graph",
            &[("/relation", 9, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![
            record("claim-a", json!({"label": "Claim A"}), &["2.1"]),
            record("claim-b", json!({"label": "Claim B"}), &["2.2"]),
        ],
        vec![ArtifactSnapshotRelation {
            relation_id: "edge-a-b".into(),
            source_record_id: "claim-a".into(),
            target_record_id: "claim-b".into(),
            data: json!({"relation": "supports"}).as_object().unwrap().clone(),
            evidence_lids: vec!["2.3".into()],
        }],
    )]);
    let result = search(&snapshot, "supports", 3);
    assert_eq!(result["hits"].as_array().unwrap().len(), 2);
    for hit in result["hits"].as_array().unwrap() {
        assert_eq!(hit["matched_fields"], json!(["relation:/relation"]));
        assert!(hit["evidence_lids"]
            .as_array()
            .unwrap()
            .contains(&json!("2.3")));
    }
}

#[test]
fn anchor_overlap_is_a_reward_and_evidence_is_never_searchable() {
    let snapshot = snapshot(vec![item(
        "artifact-anchor",
        blueprint(
            "Anchor artifact",
            &[("/label", 10, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![
            record("first", json!({"label": "same match"}), &["2.1.3"]),
            record("second", json!({"label": "same match"}), &["3.1"]),
        ],
        vec![],
    )]);
    let anchored = snapshot
        .search(ArtifactSearchInput {
            query: "same match".into(),
            artifact_refs: None,
            anchor_lids: Some(vec!["2.1".into()]),
            limit: None,
            cursor: None,
        })
        .unwrap();
    assert_eq!(anchored.hits[0].data["label"], "same match");
    assert_eq!(anchored.hits[0].evidence_lids, ["2.1.3"]);
    assert!(anchored.hits[0].score > anchored.hits[1].score);

    let lid_query = search(&snapshot, "2.1.3", 3);
    assert!(lid_query["hits"].as_array().unwrap().is_empty());
}

#[test]
fn typo_fallback_runs_only_when_the_normal_pipeline_has_zero_hits() {
    let fallback = snapshot(vec![item(
        "artifact-typo",
        blueprint(
            "Typo artifact",
            &[("/label", 10, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![record(
            "splicing",
            json!({"label": "splicing mechanism"}),
            &["3.1"],
        )],
        vec![],
    )]);
    let hit = search(&fallback, "splicng", 3);
    assert_eq!(hit["hits"][0]["data"]["label"], "splicing mechanism");
    assert_eq!(hit["hits"][0]["matched_terms"], json!(["splicng~splicing"]));

    let normal_wins = snapshot(vec![item(
        "artifact-typo-normal",
        blueprint(
            "Typo artifact",
            &[("/label", 10, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![
            record("exact", json!({"label": "splicng marker"}), &["3.1"]),
            record("typo", json!({"label": "splicing mechanism"}), &["3.2"]),
        ],
        vec![],
    )]);
    let hit = search(&normal_wins, "splicng", 3);
    assert_eq!(hit["hits"].as_array().unwrap().len(), 1);
    assert_eq!(hit["hits"][0]["data"]["label"], "splicng marker");
}

#[test]
fn only_routing_and_declared_fields_are_searchable() {
    let snapshot = snapshot(vec![item(
        "PRIVATE_GOAL_INTERNAL_ID",
        blueprint(
            "Safe routing title",
            &[("/label", 10, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![record(
            "INTERNAL_RECORD_ID",
            json!({"label": "visible term", "hidden": "RAW_GOAL_PLAN_DIGEST"}),
            &["EVIDENCE_LID_SECRET"],
        )],
        vec![],
    )]);
    for forbidden in [
        "PRIVATE_GOAL_INTERNAL_ID",
        "INTERNAL_RECORD_ID",
        "RAW_GOAL_PLAN_DIGEST",
        "EVIDENCE_LID_SECRET",
    ] {
        assert!(search(&snapshot, forbidden, 3)["hits"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    assert_eq!(
        search(&snapshot, "routing title", 3)["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        search(&snapshot, "visible term", 3)["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn pagination_and_filters_are_bound_to_the_query_and_snapshot() {
    let make = |payload_digest: char| {
        let mut item = item(
            "artifact-page",
            blueprint(
                "Page artifact",
                &[("/label", 10, ArtifactSearchAnalyzer::Text)],
                &["/label"],
            ),
            (0..5)
                .map(|index| {
                    record(
                        &format!("record-{index}"),
                        json!({"label": "shared match", "index": index}),
                        &["4.1"],
                    )
                })
                .collect(),
            vec![],
        );
        item.payload_digest = payload_digest.to_string().repeat(64);
        snapshot(vec![item])
    };
    let first_snapshot = make('c');
    let list = first_snapshot.list(Default::default()).unwrap();
    let first = first_snapshot
        .search(ArtifactSearchInput {
            query: "shared match".into(),
            artifact_refs: Some(vec![list.artifacts[0].artifact_ref.clone()]),
            anchor_lids: None,
            limit: Some(2),
            cursor: None,
        })
        .unwrap();
    assert_eq!(first.hits.len(), 2);
    let cursor = first.next_cursor.clone().unwrap();
    let second = first_snapshot
        .search(ArtifactSearchInput {
            query: "shared match".into(),
            artifact_refs: Some(vec![list.artifacts[0].artifact_ref.clone()]),
            anchor_lids: None,
            limit: Some(2),
            cursor: Some(cursor.clone()),
        })
        .unwrap();
    assert_eq!(second.hits.len(), 2);
    assert_ne!(first.hits[0].record_ref, second.hits[0].record_ref);

    let wrong_query = first_snapshot
        .search(ArtifactSearchInput {
            query: "different".into(),
            artifact_refs: Some(vec![list.artifacts[0].artifact_ref.clone()]),
            anchor_lids: None,
            limit: Some(2),
            cursor: Some(cursor.clone()),
        })
        .unwrap_err();
    assert_eq!(wrong_query.code, ARTIFACT_CURSOR_INVALID);

    let changed = make('d');
    let changed_list = changed.list(Default::default()).unwrap();
    let wrong_snapshot = changed
        .search(ArtifactSearchInput {
            query: "shared match".into(),
            artifact_refs: Some(vec![changed_list.artifacts[0].artifact_ref.clone()]),
            anchor_lids: None,
            limit: Some(2),
            cursor: Some(cursor),
        })
        .unwrap_err();
    assert_eq!(wrong_snapshot.code, ARTIFACT_CURSOR_INVALID);

    let invalid_ref = first_snapshot
        .search(ArtifactSearchInput {
            query: "shared match".into(),
            artifact_refs: Some(vec!["ar1_invalid".into()]),
            anchor_lids: None,
            limit: None,
            cursor: None,
        })
        .unwrap_err();
    assert_eq!(invalid_ref.code, ARTIFACT_REF_INVALID);
}

#[test]
fn oversized_full_records_fall_back_to_summary_and_every_page_stays_bounded() {
    for size in [0, 128, 4_096, 12_000, 24_000] {
        let snapshot = snapshot(vec![item(
            &format!("artifact-budget-{size}"),
            blueprint(
                "Budget artifact",
                &[("/label", 10, ArtifactSearchAnalyzer::Text)],
                &["/label"],
            ),
            (0..4)
                .map(|index| {
                    record(
                        &format!("record-{index}"),
                        json!({"label": "oversized match", "detail": "x".repeat(size)}),
                        &["5.1"],
                    )
                })
                .collect(),
            vec![],
        )]);
        let mut cursor = None;
        let mut seen = 0;
        loop {
            let page = snapshot
                .search(ArtifactSearchInput {
                    query: "oversized match".into(),
                    artifact_refs: None,
                    anchor_lids: None,
                    limit: Some(3),
                    cursor,
                })
                .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_SEARCH_RESULT_BYTES);
            seen += page.hits.len();
            if size >= 12_000 {
                assert!(page.hits.iter().all(|hit| hit.truncated));
                assert!(page.hits.iter().all(|hit| hit.data.get("detail").is_none()));
            }
            let Some(next) = page.next_cursor else {
                break;
            };
            cursor = Some(next);
        }
        assert_eq!(seen, 4);
    }

    let too_large_summary = snapshot(vec![item(
        "artifact-summary-too-large",
        blueprint(
            "Budget artifact",
            &[("/label", 10, ArtifactSearchAnalyzer::Text)],
            &["/label"],
        ),
        vec![record(
            "record",
            json!({"label": format!("match {}", "x".repeat(24_000))}),
            &["5.1"],
        )],
        vec![],
    )]);
    let error = too_large_summary
        .search(ArtifactSearchInput {
            query: "match".into(),
            artifact_refs: None,
            anchor_lids: None,
            limit: None,
            cursor: None,
        })
        .unwrap_err();
    assert_eq!(error.code, ARTIFACT_RESULT_TOO_LARGE);
}

#[allow(dead_code)]
fn _assert_data_shape(_: Map<String, Value>) {}
