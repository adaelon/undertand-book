use runtime::build_intent::{
    build_planning_context_v1, plan_build_intent_candidate, validate_build_decision_request_v2,
    validate_build_planning_context_v1, ArtifactBlueprintPlannerSummaryV1,
    BuildIntentPlannerRequest, BuildPlanningContextInputV1, BuildPlanningContextV1,
};
use runtime::{
    AdapterError, AgentRequestPlan, AssistantTurn, CompletionRequest, ModelAdapter, ParsedResponse,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::VecDeque;

struct StructuredAdapter {
    outputs: RefCell<VecDeque<Result<Value, AdapterError>>>,
    requests: RefCell<Vec<CompletionRequest>>,
}

impl StructuredAdapter {
    fn output(value: Value) -> Self {
        Self {
            outputs: RefCell::new(VecDeque::from([Ok(value)])),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn failure(message: &str) -> Self {
        Self {
            outputs: RefCell::new(VecDeque::from([Err(AdapterError {
                message: message.into(),
            })])),
            requests: RefCell::new(Vec::new()),
        }
    }
}

impl ModelAdapter for StructuredAdapter {
    fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        Err(AdapterError {
            message: "build intent must use structured completion".into(),
        })
    }

    fn complete_structured(&self, req: CompletionRequest) -> Result<Value, AdapterError> {
        self.requests.borrow_mut().push(req);
        self.outputs
            .borrow_mut()
            .pop_front()
            .expect("structured output")
    }

    fn chat(&self, _request: &AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
        Err(AdapterError {
            message: "build intent must not use chat".into(),
        })
    }
}

fn registry() -> Vec<ArtifactBlueprintPlannerSummaryV1> {
    vec![
        ArtifactBlueprintPlannerSummaryV1 {
            source: "system".into(),
            blueprint_id: "system.comparison_table".into(),
            blueprint_version: "1.0.0".into(),
            digest: "a".repeat(64),
            title: "Comparison table".into(),
            purpose: "Compare subjects across shared dimensions.".into(),
            shape: "table".into(),
            key_fields: vec!["subject".into(), "dimensions".into()],
        },
        ArtifactBlueprintPlannerSummaryV1 {
            source: "system".into(),
            blueprint_id: "system.argument_map".into(),
            blueprint_version: "1.0.0".into(),
            digest: "b".repeat(64),
            title: "Argument map".into(),
            purpose: "Represent claims and argumentative relations.".into(),
            shape: "graph".into(),
            key_fields: vec!["claim".into(), "role".into()],
        },
    ]
}

fn request<'a>(
    goal: &'a str,
    blueprints: &'a [ArtifactBlueprintPlannerSummaryV1],
) -> BuildIntentPlannerRequest<'a> {
    BuildIntentPlannerRequest {
        user_goal: goal,
        content_profile: "technical_learning",
        available_lids: &["1.1", "1.2"],
        available_sections: &["Methods", "Results"],
        available_blueprints: blueprints,
    }
}

#[test]
fn free_text_candidate_is_strict_registry_data_and_does_not_echo_raw_goal() {
    let raw = "PRIVATE_RAW_GOAL_DO_NOT_LOG";
    let blueprints = registry();
    let adapter = StructuredAdapter::output(json!({
        "version": "build_intent_planner_candidate.v2",
        "goal_kind": "compare",
        "source_scope": { "whole_book": false, "lids": ["1.1"], "sections": [] },
        "artifacts": [
            { "source": "system", "blueprint_id": "system.comparison_table", "blueprint_version": "1.0.0" },
            { "source": "system", "blueprint_id": "system.argument_map", "blueprint_version": "1.0.0" }
        ],
        "usage_horizon": "project"
    }));
    let candidate = plan_build_intent_candidate(&adapter, &request(raw, &blueprints)).unwrap();
    let encoded = serde_json::to_string(&candidate).unwrap();
    assert!(!encoded.contains(raw));
    assert_eq!(
        candidate.artifacts[0].blueprint_id,
        "system.comparison_table"
    );
    assert!(adapter.requests.borrow()[0]
        .system
        .contains("free-form string search field"));
    assert!(adapter.requests.borrow()[0]
        .system
        .contains("analyzer=text"));
}

#[test]
fn unknown_custom_and_out_of_scope_values_fail_closed() {
    let blueprints = registry();
    for value in [
        json!({
            "version": "build_intent_planner_candidate.v2",
            "goal_kind": "analyze",
            "source_scope": { "whole_book": true, "lids": [], "sections": [] },
            "artifacts": [{ "source": "system", "blueprint_id": "system.unknown", "blueprint_version": "1.0.0" }],
            "usage_horizon": "one_off"
        }),
        json!({
            "version": "build_intent_planner_candidate.v2",
            "goal_kind": "analyze",
            "source_scope": { "whole_book": false, "lids": ["9.9"], "sections": [] },
            "artifacts": [],
            "usage_horizon": "one_off"
        }),
    ] {
        let error = plan_build_intent_candidate(
            &StructuredAdapter::output(value),
            &request("Analyze privately", &blueprints),
        )
        .unwrap_err();
        assert_eq!(error.error_code, "BUILD_INTENT_CANDIDATE_INVALID");
    }
}

#[test]
fn provider_failure_is_explicit_and_never_defaults_to_a_capability() {
    let blueprints = registry();
    let error = plan_build_intent_candidate(
        &StructuredAdapter::failure("provider unavailable"),
        &request("Make something useful", &blueprints),
    )
    .unwrap_err();
    assert_eq!(error.error_code, "BUILD_INTENT_PROVIDER_ERROR");
    assert!(error.message.contains("provider unavailable"));
}

#[test]
fn large_book_catalog_is_bounded_for_the_provider_but_scope_validation_uses_the_full_book() {
    let owned_lids = (1..=1_981)
        .map(|index| format!("1.{index}"))
        .collect::<Vec<_>>();
    let available_lids = owned_lids.iter().map(String::as_str).collect::<Vec<_>>();
    let adapter = StructuredAdapter::output(json!({
        "version": "build_intent_planner_candidate.v2",
        "goal_kind": "analyze",
        "source_scope": { "whole_book": false, "lids": ["1.1500"], "sections": [] },
        "artifacts": [],
        "usage_horizon": "project"
    }));
    let blueprints = registry();
    let request = BuildIntentPlannerRequest {
        user_goal: "Analyze the evidence near LID 1.1500",
        content_profile: "technical_learning",
        available_lids: &available_lids,
        available_sections: &[],
        available_blueprints: &blueprints,
    };

    let candidate = plan_build_intent_candidate(&adapter, &request).unwrap();

    assert_eq!(candidate.source_scope.lids, vec!["1.1500"]);
    let provider_request: Value = serde_json::from_str(&adapter.requests.borrow()[0].user).unwrap();
    assert_eq!(
        provider_request["scope_catalog"]["available_lid_count"],
        1_981
    );
    assert_eq!(
        provider_request["scope_catalog"]["available_lids"]
            .as_array()
            .unwrap()
            .len(),
        128
    );
    assert_eq!(provider_request["scope_catalog"]["truncated"], true);
    assert_eq!(
        provider_request["blueprint_registry"][0]["blueprint_id"],
        "system.comparison_table"
    );
    assert_eq!(
        provider_request["scope_catalog"]["available_lids"][0],
        "1.1"
    );
    assert_eq!(
        provider_request["scope_catalog"]["available_lids"][127],
        "1.1981"
    );
}

#[test]
fn rust_decision_contract_matches_the_core_golden_and_rejects_scope_confusion() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/core/test/fixtures/build-decision-request.v2.golden.json"
    ))
    .unwrap();
    validate_build_decision_request_v2(&fixture["legacy_stage"]).unwrap();
    validate_build_decision_request_v2(&fixture["build_plan"]).unwrap();
    let mut confused = fixture["build_plan"].clone();
    confused["scope"] = json!({ "kind": "stage", "stage": "pass1" });
    assert_eq!(
        validate_build_decision_request_v2(&confused)
            .unwrap_err()
            .error_code,
        "BUILD_DECISION_INVALID"
    );
}

#[test]
fn rust_planning_context_matches_the_core_golden_and_is_registry_order_independent() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/core/test/fixtures/build-planning-context.v1.golden.json"
    ))
    .unwrap();
    let input = &fixture["input"];
    let lids = input["available_lids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    let sections = input["available_sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    let mut blueprints: Vec<ArtifactBlueprintPlannerSummaryV1> =
        serde_json::from_value(input["blueprint_registry"].clone()).unwrap();
    blueprints.reverse();
    let context = build_planning_context_v1(&BuildPlanningContextInputV1 {
        book_id: input["target"]["book_id"].as_str().unwrap(),
        source_fingerprint: input["target"]["source_fingerprint"].as_str().unwrap(),
        content_profile: input["target"]["content_profile"].as_str().unwrap(),
        available_lids: &lids,
        available_sections: &sections,
        available_blueprints: &blueprints,
    })
    .unwrap();
    let expected: BuildPlanningContextV1 =
        serde_json::from_value(fixture["context"].clone()).unwrap();
    assert_eq!(context, expected);
    validate_build_planning_context_v1(&context).unwrap();

    let mut drifted = context;
    drifted.context_digest = "f".repeat(64);
    assert_eq!(
        validate_build_planning_context_v1(&drifted)
            .unwrap_err()
            .error_code,
        "BUILD_PLANNING_CONTEXT_INVALID"
    );
}
