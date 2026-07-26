use runtime::build_intent::{
    plan_build_intent_candidate, validate_build_decision_request_v2, BuildIntentPlannerRequest,
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

fn request<'a>(goal: &'a str) -> BuildIntentPlannerRequest<'a> {
    BuildIntentPlannerRequest {
        user_goal: goal,
        content_profile: "technical_learning",
        available_lids: &["1.1", "1.2"],
        available_sections: &["Methods", "Results"],
    }
}

#[test]
fn free_text_candidate_is_strict_registry_data_and_does_not_echo_raw_goal() {
    let raw = "PRIVATE_RAW_GOAL_DO_NOT_LOG";
    let adapter = StructuredAdapter::output(json!({
        "version": "build_intent_planner_candidate.v1",
        "goal_kind": "compare",
        "source_scope": { "whole_book": false, "lids": ["1.1"], "sections": [] },
        "desired_artifacts": ["comparison_table", "argument_map"],
        "usage_horizon": "project"
    }));
    let candidate = plan_build_intent_candidate(&adapter, &request(raw)).unwrap();
    let encoded = serde_json::to_string(&candidate).unwrap();
    assert!(!encoded.contains(raw));
    assert_eq!(
        candidate.desired_artifacts,
        vec!["comparison_table", "argument_map"]
    );
}

#[test]
fn unknown_custom_and_out_of_scope_values_fail_closed() {
    for value in [
        json!({
            "version": "build_intent_planner_candidate.v1",
            "goal_kind": "analyze",
            "source_scope": { "whole_book": true, "lids": [], "sections": [] },
            "desired_artifacts": ["custom"],
            "usage_horizon": "one_off"
        }),
        json!({
            "version": "build_intent_planner_candidate.v1",
            "goal_kind": "analyze",
            "source_scope": { "whole_book": false, "lids": ["9.9"], "sections": [] },
            "desired_artifacts": ["concept_map"],
            "usage_horizon": "one_off"
        }),
    ] {
        let error = plan_build_intent_candidate(
            &StructuredAdapter::output(value),
            &request("Analyze privately"),
        )
        .unwrap_err();
        assert_eq!(error.error_code, "BUILD_INTENT_CANDIDATE_INVALID");
    }
}

#[test]
fn provider_failure_is_explicit_and_never_defaults_to_a_capability() {
    let error = plan_build_intent_candidate(
        &StructuredAdapter::failure("provider unavailable"),
        &request("Make something useful"),
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
        "version": "build_intent_planner_candidate.v1",
        "goal_kind": "analyze",
        "source_scope": { "whole_book": false, "lids": ["1.1500"], "sections": [] },
        "desired_artifacts": ["concept_map"],
        "usage_horizon": "project"
    }));
    let request = BuildIntentPlannerRequest {
        user_goal: "Analyze the evidence near LID 1.1500",
        content_profile: "technical_learning",
        available_lids: &available_lids,
        available_sections: &[],
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
