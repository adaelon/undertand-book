use crate::intent_build_store::{
    ActiveIntentOverlayV1, IntentArtifactStore, INTENT_BUILD_CONFLICT, INTENT_BUILD_INVALID,
    INTENT_BUILD_NOT_FOUND,
};
use crate::{err_reply, method_not_allowed, ok_json, sha256_hex, workspace_root, AppState, Reply};
use base_schema::NodeKind;
use read_tools::{ContentProfileId, ToolError};
use runtime::build_intent::{
    build_planning_context_v1, plan_build_intent_candidate,
    validate_build_intent_planner_candidate, ArtifactBlueprintPlannerSummaryV1,
    BuildIntentPlannerCandidateV2, BuildIntentPlannerRequest, BuildPlanningContextInputV1,
    BuildPlanningContextV1,
};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const RESPONSE_VERSION: &str = "build_intent_response.v1";

#[derive(Debug)]
struct CoreIntentCommand {
    program: PathBuf,
    prefix_args: Vec<OsString>,
    current_dir: PathBuf,
}

struct DraftRevisionIdentity {
    intent_id: String,
    plan_id: String,
    intent_revision: u64,
    plan_revision: u64,
}

pub(super) fn route_build_intent(
    state: &mut AppState,
    action: &str,
    method: &str,
    body: &str,
    now: &str,
) -> Reply {
    if matches!(
        (action, method),
        ("status" | "artifacts" | "usage", "GET")
            | (
                "draft"
                    | "edit"
                    | "estimate"
                    | "confirm"
                    | "reject"
                    | "delete"
                    | "artifact.prepare"
                    | "artifact.submit"
                    | "usage.event"
                    | "usage.cost",
                "POST"
            )
    ) {
        if let Err(error) = synchronize_active_source(state) {
            return err_reply(&error);
        }
    }
    let result = match action {
        "status" if method == "GET" => status(state),
        "artifacts" if method == "GET" => artifacts(state),
        "usage" if method == "GET" => usage_report(state, now),
        "draft" if method == "POST" => draft(state, body, now),
        "edit" if method == "POST" => edit(state, body, now),
        "estimate" if method == "POST" => estimate(state, body),
        "confirm" if method == "POST" => confirm(state, body, now),
        "reject" if method == "POST" => reject(state, body),
        "delete" if method == "POST" => delete_intent(state, body),
        "artifact.prepare" if method == "POST" => prepare_artifacts(state, body, now),
        "artifact.submit" if method == "POST" => submit_artifact(state, body, now),
        "artifact.fail" if method == "POST" => fail_artifact(state, body, now),
        "artifact.inspect" if method == "POST" => inspect_artifact(state, body),
        "usage.event" if method == "POST" => append_reader_usage_event(state, body),
        "usage.cost" if method == "POST" => append_cost_usage_event(state, body),
        "status" | "artifacts" | "usage" | "draft" | "edit" | "estimate" | "confirm" | "reject"
        | "delete" | "artifact.prepare" | "artifact.submit" | "artifact.fail"
        | "artifact.inspect" | "usage.event" | "usage.cost" => return method_not_allowed(),
        _ => {
            return err_reply(&error(
                "ROUTE_NOT_FOUND",
                "not_found",
                "unknown build intent route",
            ))
        }
    };
    match result {
        Ok(value) => ok_json(&value),
        Err(error) => err_reply(&error),
    }
}

fn status(state: &AppState) -> Result<Value, ToolError> {
    let store = private_store(state)?;
    Ok(json!({
        "version": "build_intent_status_response.v1",
        "inspection": store.inspect_redacted(&state.book.base.book_id)?,
    }))
}

fn artifacts(state: &AppState) -> Result<Value, ToolError> {
    let source_fingerprint = current_source_fingerprint(state)?;
    Ok(json!({
        "version": "intent_artifact_overlay_response.v1",
        "overlay": private_store(state)?.read_active_overlay_artifacts(
            &state.book.base.book_id,
            &source_fingerprint,
        )?,
    }))
}

fn usage_report(state: &AppState, now: &str) -> Result<Value, ToolError> {
    let store = private_store(state)?;
    run_metrics_core(&json!({
        "version": "intent_build_usage_command.v1",
        "operation": "report",
        "input": {
            "private_root": store.root(),
            "book_id": state.book.base.book_id,
            "as_of": now,
            "window_days": 7,
        }
    }))
}

fn prepare_artifacts(state: &AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["plan_id"])?;
    let requested_plan_id = required_string(&input, "plan_id")?;
    let (store, intent, plan) = active_selection(state)?;
    if required_string(&plan, "plan_id")? != requested_plan_id {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "artifact preparation requires the active confirmed plan",
        ));
    }
    store.read_active_overlay_artifacts(
        &state.book.base.book_id,
        &current_source_fingerprint(state)?,
    )?;
    let (available_lids, resolved_scope_lids) = artifact_scope(state, &intent)?;
    let handoff = run_artifact_core(&json!({
        "version": "intent_artifact_mailbox_command.v1",
        "operation": "prepare",
        "input": {
            "private_root": store.root(),
            "intent": intent,
            "plan": plan,
            "available_lids": available_lids,
            "resolved_scope_lids": resolved_scope_lids,
            "created_at": now,
        }
    }))?;
    Ok(json!({
        "version": "intent_artifact_prepare_response.v1",
        "handoff": handoff,
    }))
}

fn submit_artifact(state: &AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["task_path"])?;
    let task_path = required_string(&input, "task_path")?;
    let (store, intent, plan) = active_selection(state)?;
    let source_fingerprint = current_source_fingerprint(state)?;
    let (available_lids, resolved_scope_lids) = artifact_scope(state, &intent)?;
    let receipt = run_artifact_core(&json!({
        "version": "intent_artifact_mailbox_command.v1",
        "operation": "submit",
        "input": {
            "private_root": store.root(),
            "task_path": task_path,
            "current_intent": intent,
            "current_plan": plan,
            "current_source_fingerprint": source_fingerprint,
            "available_lids": available_lids,
            "resolved_scope_lids": resolved_scope_lids,
            "accepted_at": now,
        }
    }))?;
    store.read_active_overlay_artifacts(&state.book.base.book_id, &source_fingerprint)?;
    append_artifact_accepted_usage(state, &plan, &receipt)?;
    Ok(json!({
        "version": "intent_artifact_task_response.v1",
        "receipt": receipt,
    }))
}

fn fail_artifact(state: &AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["task_path", "diagnostic_code", "message"])?;
    let task_path = required_string(&input, "task_path")?;
    let diagnostic_code = required_string(&input, "diagnostic_code")?;
    let store = private_store(state)?;
    let mut command = json!({
        "version": "intent_artifact_mailbox_command.v1",
        "operation": "fail",
        "input": {
            "private_root": store.root(),
            "task_path": task_path,
            "diagnostic_code": diagnostic_code,
            "failed_at": now,
        }
    });
    copy_optional(&input, &mut command["input"], "message");
    let receipt = run_artifact_core(&command)?;
    Ok(json!({
        "version": "intent_artifact_task_response.v1",
        "receipt": receipt,
    }))
}

fn inspect_artifact(state: &AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["task_path"])?;
    let task_path = required_string(&input, "task_path")?;
    let store = private_store(state)?;
    let receipt = run_artifact_core(&json!({
        "version": "intent_artifact_mailbox_command.v1",
        "operation": "inspect",
        "input": {
            "private_root": store.root(),
            "task_path": task_path,
        }
    }))?;
    Ok(json!({
        "version": "intent_artifact_task_response.v1",
        "receipt": receipt,
    }))
}

fn draft(state: &mut AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["mode", "user_goal", "budget"])?;
    let mode = required_string(&input, "mode")?;
    if !matches!(mode, "read_now" | "standard_deep" | "goal_directed") {
        return Err(error(
            INTENT_BUILD_INVALID,
            "validation",
            "unknown build mode",
        ));
    }
    if mode == "goal_directed" {
        let user_goal = required_string(&input, "user_goal")?;
        let candidate = plan_candidate(state, user_goal)?;
        return compile_candidate_draft(
            state,
            user_goal,
            candidate,
            input.get("budget"),
            None,
            None,
            "reader_provider",
            now,
        );
    }
    let mut core_input = build_core_draft_input(state, mode, now)?;
    copy_optional(&input, &mut core_input, "budget");
    let selection = run_core(&json!({ "operation": "draft", "input": core_input }))?;
    persist_selection(state, &selection)?;
    if mode == "read_now" {
        append_plan_selected_usage(state, &selection, now)?;
    }
    response(state, selection, "deterministic")
}

fn edit(state: &mut AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["plan_id", "user_goal", "budget"])?;
    let plan_id = required_string(&input, "plan_id")?;
    let store = private_store(state)?;
    let plan = store.read_plan(&state.book.base.book_id, plan_id)?;
    if plan.get("status").and_then(Value::as_str) != Some("draft") {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "only a draft plan can be edited",
        ));
    }
    let intent_id = plan
        .get("intent_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "standard plans are not editable",
            )
        })?;
    let intent = store.read_intent(&state.book.base.book_id, intent_id)?;
    if intent.get("status").and_then(Value::as_str) != Some("draft") {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "only a draft intent can be edited",
        ));
    }
    let user_goal = input
        .get("user_goal")
        .cloned()
        .unwrap_or_else(|| intent.get("user_goal").cloned().unwrap_or(Value::Null));
    let user_goal_text = user_goal
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error(INTENT_BUILD_INVALID, "validation", "user_goal is required"))?;
    let candidate = plan_candidate(state, user_goal_text)?;
    let revision_identity = DraftRevisionIdentity {
        intent_id: intent_id.to_string(),
        plan_id: plan_id.to_string(),
        intent_revision: required_revision(&intent)? + 1,
        plan_revision: required_revision(&plan)? + 1,
    };
    compile_candidate_draft(
        state,
        user_goal_text,
        candidate,
        input.get("budget"),
        None,
        Some(&revision_identity),
        "reader_provider",
        now,
    )
}

fn estimate(state: &AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    let plan_id = required_string(&input, "plan_id")?;
    let plan = private_store(state)?.read_plan(&state.book.base.book_id, plan_id)?;
    Ok(json!({
        "version": "build_plan_estimate_response.v1",
        "plan_id": plan.get("plan_id").cloned().unwrap_or(Value::Null),
        "plan_digest": plan.get("plan_digest").cloned().unwrap_or(Value::Null),
        "estimate": plan.get("estimate").cloned().unwrap_or(Value::Null),
    }))
}

fn confirm(state: &mut AppState, body: &str, now: &str) -> Result<Value, ToolError> {
    confirm_with_source(state, body, now, "reader_ui")
}

fn confirm_with_source(
    state: &mut AppState,
    body: &str,
    now: &str,
    confirmation_source: &str,
) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    let plan_id = required_string(&input, "plan_id")?;
    let plan_digest = required_string(&input, "plan_digest")?;
    let store = private_store(state)?;
    let plan = store.read_plan(&state.book.base.book_id, plan_id)?;
    if plan.get("status").and_then(Value::as_str) != Some("draft")
        || plan.get("plan_digest").and_then(Value::as_str) != Some(plan_digest)
    {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "confirmation plan id or digest does not match the current draft",
        ));
    }
    validate_plan_blueprints_current(state, &plan)?;
    let intent = read_plan_intent(&store, &state.book.base.book_id, &plan)?;
    let selection = selection_from_artifacts(plan, intent)?;
    let confirmed = run_core(&json!({
        "operation": "confirm",
        "selection": selection,
        "confirmation": {
            "plan_id": plan_id,
            "plan_digest": plan_digest,
            "at": now,
            "confirmation_source": confirmation_source,
        }
    }))?;
    persist_selection(state, &confirmed)?;
    activate_confirmed_selection(state, &confirmed)?;
    append_plan_selected_usage(state, &confirmed, now)?;
    response(state, confirmed, "stored_plan")
}

fn reject(state: &mut AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    let plan_id = required_string(&input, "plan_id")?;
    let store = private_store(state)?;
    let plan = store.read_plan(&state.book.base.book_id, plan_id)?;
    if plan.get("status").and_then(Value::as_str) != Some("draft") {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "only a draft plan can be rejected",
        ));
    }
    let intent = read_plan_intent(&store, &state.book.base.book_id, &plan)?;
    let selection = selection_from_artifacts(plan, intent)?;
    let rejected = run_core(&json!({ "operation": "reject", "selection": selection }))?;
    persist_selection(state, &rejected)?;
    response(state, rejected, "stored_plan")
}

fn delete_intent(state: &AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["intent_id"])?;
    let intent_id = required_string(&input, "intent_id")?;
    let store = private_store(state)?;
    let usage = run_metrics_core(&json!({
        "version": "intent_build_usage_command.v1",
        "operation": "delete_intent",
        "input": {
            "private_root": store.root(),
            "book_id": state.book.base.book_id,
            "intent_id": intent_id,
        }
    }))?;
    let deleted = store.hard_delete_intent(&state.book.base.book_id, intent_id)?;
    Ok(json!({
        "version": "build_intent_delete_response.v1",
        "intent_id": intent_id,
        "deleted": deleted,
        "deleted_usage_event_count": usage.get("deleted_event_count").cloned().unwrap_or(json!(0)),
        "inspection": store.inspect_redacted(&state.book.base.book_id)?,
    }))
}

fn usage_event_id(prefix: &str, identity: &str) -> String {
    format!("{prefix}-{}", &sha256_hex(identity.as_bytes())[..32])
}

fn usage_plan_ref(plan: &Value) -> Result<Value, ToolError> {
    let confirmation_source = required_string(plan, "confirmation_source")?;
    let mut reference = json!({
        "plan_id": required_string(plan, "plan_id")?,
        "revision": required_revision(plan)?,
        "plan_digest": required_string(plan, "plan_digest")?,
        "confirmation_source": confirmation_source,
    });
    copy_optional(plan, &mut reference, "intent_id");
    Ok(reference)
}

fn usage_artifact_ref(plan: &Value, artifact_id: &str) -> Result<Value, ToolError> {
    let artifacts = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "stored plan artifacts are invalid",
            )
        })?;
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.get("artifact_id").and_then(Value::as_str) == Some(artifact_id))
        .ok_or_else(|| {
            error(
                INTENT_BUILD_NOT_FOUND,
                "not_found",
                "artifact does not belong to the selected plan",
            )
        })?;
    let artifact_type = if plan.get("version").and_then(Value::as_str) == Some("build_plan.v2") {
        match artifact
            .get("blueprint")
            .and_then(|blueprint| blueprint.get("blueprint_id"))
            .and_then(Value::as_str)
        {
            Some("system.timeline") => "timeline",
            Some("system.concept_map") => "concept_map",
            Some("system.comparison_table") => "comparison_table",
            Some("system.argument_map") => "argument_map",
            Some(_) => "custom",
            None => {
                return Err(error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "stored V2 plan artifact has no Blueprint identity",
                ))
            }
        }
    } else {
        required_string(artifact, "artifact_type")?
    };
    Ok(json!({
        "artifact_id": artifact_id,
        "artifact_type": artifact_type,
    }))
}

fn append_plan_selected_usage(
    state: &AppState,
    selection: &Value,
    occurred_at: &str,
) -> Result<(), ToolError> {
    let mode = required_string(selection, "mode")?;
    let plan = selection.get("plan").cloned().unwrap_or(Value::Null);
    let identity = if plan.is_null() {
        format!("{}:{mode}:{occurred_at}", state.book.base.book_id)
    } else {
        format!(
            "{}:{}:{}:{}",
            state.book.base.book_id,
            required_string(&plan, "plan_id")?,
            required_revision(&plan)?,
            required_string(&plan, "plan_digest")?,
        )
    };
    let store = private_store(state)?;
    run_metrics_core(&json!({
        "version": "intent_build_usage_command.v1",
        "operation": "append_plan_selected",
        "input": {
            "private_root": store.root(),
            "event_id": usage_event_id("plan-selected", &identity),
            "book_id": state.book.base.book_id,
            "occurred_at": occurred_at,
            "mode": mode,
            "plan": plan,
        }
    }))?;
    Ok(())
}

fn append_artifact_accepted_usage(
    state: &AppState,
    plan: &Value,
    receipt: &Value,
) -> Result<(), ToolError> {
    let artifact_id = required_string(receipt, "artifact_id")?;
    let event = json!({
        "version": "intent_build_usage_event.v1",
        "event_id": usage_event_id(
            "artifact-accepted",
            &format!(
                "{}:{}:{}",
                required_string(receipt, "task_id")?,
                receipt.get("attempt").and_then(Value::as_u64).unwrap_or(0),
                required_string(receipt, "terminal_at")?,
            ),
        ),
        "book_id": state.book.base.book_id,
        "mode": "goal_directed",
        "occurred_at": required_string(receipt, "terminal_at")?,
        "kind": "artifact_accepted",
        "plan": usage_plan_ref(plan)?,
        "artifact": usage_artifact_ref(plan, artifact_id)?,
        "record_count": receipt.get("record_count").cloned().unwrap_or(json!(0)),
    });
    append_usage_event(state, event)?;
    Ok(())
}

fn current_usage_plan(state: &AppState) -> Result<Option<Value>, ToolError> {
    let store = private_store(state)?;
    let source_fingerprint = current_source_fingerprint(state)?;
    let inspection = store.inspect_redacted(&state.book.base.book_id)?;
    let mut candidates = Vec::new();
    for entry in inspection.plans {
        if entry.status != "confirmed" && entry.status != "completed" {
            continue;
        }
        let plan = store.read_plan(&state.book.base.book_id, &entry.plan_id)?;
        if plan.get("source_fingerprint").and_then(Value::as_str)
            != Some(source_fingerprint.as_str())
        {
            continue;
        }
        let selected_at = plan
            .get("confirmed_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        candidates.push((selected_at, entry.revision, entry.plan_id, plan));
    }
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    Ok(candidates.pop().map(|candidate| candidate.3))
}

fn append_reader_usage_event(state: &AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(&input, &["event_id", "occurred_at", "kind", "artifact_id"])?;
    let event_id = required_string(&input, "event_id")?;
    let occurred_at = required_string(&input, "occurred_at")?;
    let kind = required_string(&input, "kind")?;
    let event = if kind == "reader_ready" {
        if input.get("artifact_id").is_some() {
            return Err(error(
                INTENT_BUILD_INVALID,
                "validation",
                "reader_ready cannot name an artifact",
            ));
        }
        if let Some(plan) = current_usage_plan(state)? {
            json!({
                "version": "intent_build_usage_event.v1",
                "event_id": event_id,
                "book_id": state.book.base.book_id,
                "mode": required_string(&plan, "recipe_id")?,
                "occurred_at": occurred_at,
                "kind": kind,
                "plan": usage_plan_ref(&plan)?,
            })
        } else {
            json!({
                "version": "intent_build_usage_event.v1",
                "event_id": event_id,
                "book_id": state.book.base.book_id,
                "mode": "read_now",
                "occurred_at": occurred_at,
                "kind": kind,
                "plan": null,
            })
        }
    } else if kind == "artifact_opened" || kind == "artifact_cited" {
        let artifact_id = required_string(&input, "artifact_id")?;
        let (store, _intent, plan) = active_selection(state)?;
        let overlay = store.read_active_overlay_artifacts(
            &state.book.base.book_id,
            &current_source_fingerprint(state)?,
        )?;
        if !overlay
            .artifacts
            .iter()
            .any(|artifact| artifact.artifact_id == artifact_id && artifact.state == "accepted")
        {
            return Err(error(
                INTENT_BUILD_NOT_FOUND,
                "not_found",
                "accepted artifact does not exist",
            ));
        }
        let mut event = json!({
            "version": "intent_build_usage_event.v1",
            "event_id": event_id,
            "book_id": state.book.base.book_id,
            "mode": "goal_directed",
            "occurred_at": occurred_at,
            "kind": kind,
            "plan": usage_plan_ref(&plan)?,
            "artifact": usage_artifact_ref(&plan, artifact_id)?,
        });
        if kind == "artifact_cited" {
            event["citation_count"] = json!(1);
        }
        event
    } else {
        return Err(error(
            INTENT_BUILD_INVALID,
            "validation",
            "reader usage event kind is not allowed",
        ));
    };
    append_usage_event(state, event)
}

fn append_cost_usage_event(state: &AppState, body: &str) -> Result<Value, ToolError> {
    let input = parse_body(body)?;
    reject_unknown_fields(
        &input,
        &[
            "event_id",
            "occurred_at",
            "plan_id",
            "artifact_id",
            "attempt_id",
            "outcome",
            "wall_clock_ms",
            "usage",
        ],
    )?;
    let store = private_store(state)?;
    let plan = input
        .get("plan_id")
        .and_then(Value::as_str)
        .map(|plan_id| store.read_plan(&state.book.base.book_id, plan_id))
        .transpose()?;
    let (mode, plan_ref) = if let Some(plan) = plan.as_ref() {
        if plan.get("status").and_then(Value::as_str) == Some("draft") {
            return Err(error(
                INTENT_BUILD_CONFLICT,
                "conflict",
                "draft plan cannot receive actual cost",
            ));
        }
        (required_string(plan, "recipe_id")?, usage_plan_ref(plan)?)
    } else {
        ("read_now", Value::Null)
    };
    let mut event = json!({
        "version": "intent_build_usage_event.v1",
        "event_id": required_string(&input, "event_id")?,
        "book_id": state.book.base.book_id,
        "mode": mode,
        "occurred_at": required_string(&input, "occurred_at")?,
        "kind": "cost_observed",
        "plan": plan_ref,
        "attempt_id": required_string(&input, "attempt_id")?,
        "outcome": input.get("outcome").cloned().unwrap_or(Value::Null),
        "wall_clock_ms": input.get("wall_clock_ms").cloned().unwrap_or(Value::Null),
        "usage": input.get("usage").cloned().unwrap_or(Value::Null),
    });
    if let Some(artifact_id) = input.get("artifact_id").and_then(Value::as_str) {
        let plan = plan.as_ref().ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "artifact cost requires a BuildPlan",
            )
        })?;
        event["artifact"] = usage_artifact_ref(plan, artifact_id)?;
    }
    append_usage_event(state, event)
}

fn append_usage_event(state: &AppState, event: Value) -> Result<Value, ToolError> {
    let store = private_store(state)?;
    run_metrics_core(&json!({
        "version": "intent_build_usage_command.v1",
        "operation": "append",
        "input": {
            "private_root": store.root(),
            "event": event,
        }
    }))
}

fn build_core_draft_input(state: &AppState, mode: &str, now: &str) -> Result<Value, ToolError> {
    let (profile_id, profile_version) = match state.book.content_profile_id() {
        ContentProfileId::TechnicalLearning => ("technical_learning", "technical_learning_v0"),
        ContentProfileId::Paper => ("paper", "paper_v0"),
    };
    let source_fingerprint = current_source_fingerprint(state)?;
    let freshness = run_core(&json!({
        "operation": "inspect_freshness",
        "target": {
            "version": "intent_plan_freshness_target.v1",
            "book_id": state.book.base.book_id,
            "source_fingerprint": source_fingerprint,
            "profile_id": profile_id,
            "root_dir": state.library_root.as_deref().unwrap_or(&state.book_dir),
            "workspace_dir": state.book_dir,
            "source_path": state.book_dir.join("source.txt"),
        }
    }))?;
    let public_freshness = freshness
        .get("public_freshness")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "Core freshness inspection returned an invalid response",
            )
        })?;
    Ok(json!({
        "mode": mode,
        "target": {
            "book_id": state.book.base.book_id,
            "source_fingerprint": source_fingerprint,
            "content_profile": { "id": profile_id, "version": profile_version },
            "public_freshness": public_freshness,
        },
        "now": now,
    }))
}

fn apply_active_replan_identity(state: &AppState, core_input: &mut Value) -> Result<(), ToolError> {
    let store = private_store(state)?;
    let inspection = store.inspect_redacted(&state.book.base.book_id)?;
    let lineage = if let Some(active) = inspection.active_overlay {
        Some((active.intent_id, active.plan_id))
    } else {
        inspection
            .intents
            .iter()
            .filter(|intent| intent.status == "stale_source")
            .max_by_key(|intent| intent.revision)
            .and_then(|intent| {
                inspection
                    .plans
                    .iter()
                    .filter(|plan| plan.intent_id.as_deref() == Some(intent.intent_id.as_str()))
                    .max_by_key(|plan| plan.revision)
                    .map(|plan| (intent.intent_id.clone(), plan.plan_id.clone()))
            })
    };
    let Some((intent_id, plan_id)) = lineage else {
        return Ok(());
    };
    let intent = store.read_intent(&state.book.base.book_id, &intent_id)?;
    let plan = store.read_plan(&state.book.base.book_id, &plan_id)?;
    core_input["intent_revision"] = json!(required_revision(&intent)? + 1);
    core_input["plan_revision"] = json!(required_revision(&plan)? + 1);
    core_input["supersedes_intent_id"] = json!(intent_id);
    Ok(())
}

fn synchronize_active_source(state: &AppState) -> Result<(), ToolError> {
    let store = private_store(state)?;
    let inspection = store.inspect_redacted(&state.book.base.book_id)?;
    let current_source = current_source_fingerprint(state)?;
    let mut clear_active = false;
    for entry in inspection
        .plans
        .iter()
        .filter(|plan| matches!(plan.status.as_str(), "draft" | "confirmed" | "completed"))
    {
        let plan = store.read_plan(&state.book.base.book_id, &entry.plan_id)?;
        if required_string(&plan, "source_fingerprint")? == current_source {
            continue;
        }
        let intent = read_plan_intent(&store, &state.book.base.book_id, &plan)?;
        let selection = selection_from_artifacts(plan, intent)?;
        let stale = run_core(&json!({ "operation": "stale_source", "selection": selection }))?;
        persist_selection(state, &stale)?;
        clear_active |= inspection
            .active_overlay
            .as_ref()
            .is_some_and(|active| active.plan_id == entry.plan_id);
    }
    if clear_active {
        store.set_active_overlay(&state.book.base.book_id, None)?;
    }
    Ok(())
}

fn activate_confirmed_selection(state: &AppState, confirmed: &Value) -> Result<(), ToolError> {
    let store = private_store(state)?;
    let next_plan = confirmed
        .get("plan")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "confirmed selection has no plan",
            )
        })?;
    let next_plan_id = required_string(next_plan, "plan_id")?;
    if let Some(active) = store
        .inspect_redacted(&state.book.base.book_id)?
        .active_overlay
    {
        if active.plan_id != next_plan_id {
            let previous_plan = store.read_plan(&state.book.base.book_id, &active.plan_id)?;
            let previous_intent = store.read_intent(&state.book.base.book_id, &active.intent_id)?;
            let previous = selection_from_artifacts(previous_plan, Some(previous_intent))?;
            let superseded = run_core(&json!({
                "operation": "supersede",
                "selection": previous,
            }))?;
            persist_selection(state, &superseded)?;
        }
    }
    let next_active = next_plan
        .get("intent_id")
        .and_then(Value::as_str)
        .map(|intent_id| ActiveIntentOverlayV1 {
            intent_id: intent_id.into(),
            plan_id: next_plan_id.into(),
        });
    store.set_active_overlay(&state.book.base.book_id, next_active)
}

fn current_source_fingerprint(state: &AppState) -> Result<String, ToolError> {
    let source = std::fs::read(state.book_dir.join("source.txt")).map_err(|io_error| {
        error(
            "BUILD_INTENT_SOURCE_UNAVAILABLE",
            "unavailable",
            format!("current source.txt cannot be read: {io_error}"),
        )
    })?;
    Ok(sha256_hex(&source))
}

fn active_selection(state: &AppState) -> Result<(IntentArtifactStore, Value, Value), ToolError> {
    let store = private_store(state)?;
    let inspection = store.inspect_redacted(&state.book.base.book_id)?;
    let active = inspection.active_overlay.ok_or_else(|| {
        error(
            INTENT_BUILD_NOT_FOUND,
            "not_found",
            "active intent artifact overlay does not exist",
        )
    })?;
    let plan = store.read_plan(&state.book.base.book_id, &active.plan_id)?;
    let intent = store.read_intent(&state.book.base.book_id, &active.intent_id)?;
    if required_string(&plan, "status")? != "confirmed"
        || required_string(&intent, "status")? != "confirmed"
        || required_string(&plan, "intent_id")? != active.intent_id
    {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "active intent artifact overlay is not a confirmed selection",
        ));
    }
    let source_fingerprint = current_source_fingerprint(state)?;
    if required_string(&plan, "source_fingerprint")? != source_fingerprint
        || required_string(&intent, "source_fingerprint")? != source_fingerprint
    {
        return Err(error(
            INTENT_BUILD_CONFLICT,
            "conflict",
            "active intent artifact overlay does not match the current source",
        ));
    }
    Ok((store, intent, plan))
}

fn artifact_scope(
    state: &AppState,
    intent: &Value,
) -> Result<(Vec<String>, Vec<String>), ToolError> {
    let available = state
        .book
        .base
        .lid_nodes
        .iter()
        .map(|node| node.lid.clone())
        .collect::<Vec<_>>();
    let scope = intent
        .get("source_scope")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "active intent source_scope is invalid",
            )
        })?;
    let resolved = if scope
        .get("whole_book")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        available.clone()
    } else {
        scope
            .get("lids")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "active intent source_scope lids are invalid",
                )
            })?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    error(
                        INTENT_BUILD_INVALID,
                        "validation",
                        "active intent source_scope contains a non-string LID",
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok((available, resolved))
}

fn plan_candidate(
    state: &AppState,
    user_goal: &str,
) -> Result<runtime::build_intent::BuildIntentPlannerCandidateV2, ToolError> {
    let lids = state
        .book
        .base
        .lid_nodes
        .iter()
        .map(|node| node.lid.as_str())
        .collect::<Vec<_>>();
    let profile = match state.book.content_profile_id() {
        ContentProfileId::TechnicalLearning => "technical_learning",
        ContentProfileId::Paper => "paper",
    };
    let blueprints = blueprint_registry_summaries(state)?;
    plan_build_intent_candidate(
        state.adapter.as_ref(),
        &BuildIntentPlannerRequest {
            user_goal,
            content_profile: profile,
            available_lids: &lids,
            available_sections: &[],
            available_blueprints: &blueprints,
        },
    )
}

fn current_planning_context(state: &AppState) -> Result<BuildPlanningContextV1, ToolError> {
    let source_fingerprint = current_source_fingerprint(state)?;
    let profile = match state.book.content_profile_id() {
        ContentProfileId::TechnicalLearning => "technical_learning",
        ContentProfileId::Paper => "paper",
    };
    let available_lids = state
        .book
        .base
        .lid_nodes
        .iter()
        .map(|node| node.lid.as_str())
        .collect::<Vec<_>>();
    let available_sections = state
        .book
        .base
        .lid_nodes
        .iter()
        .filter(|node| matches!(&node.kind, NodeKind::Chapter | NodeKind::Section))
        .map(|node| node.lid.as_str())
        .collect::<Vec<_>>();
    let blueprints = blueprint_registry_summaries(state)?;
    build_planning_context_v1(&BuildPlanningContextInputV1 {
        book_id: &state.book.base.book_id,
        source_fingerprint: &source_fingerprint,
        content_profile: profile,
        available_lids: &available_lids,
        available_sections: &available_sections,
        available_blueprints: &blueprints,
    })
}

fn validate_candidate_against_current_state(
    state: &AppState,
    user_goal: &str,
    candidate: &BuildIntentPlannerCandidateV2,
) -> Result<(), ToolError> {
    let lids = state
        .book
        .base
        .lid_nodes
        .iter()
        .map(|node| node.lid.as_str())
        .collect::<Vec<_>>();
    let profile = match state.book.content_profile_id() {
        ContentProfileId::TechnicalLearning => "technical_learning",
        ContentProfileId::Paper => "paper",
    };
    let blueprints = blueprint_registry_summaries(state)?;
    validate_build_intent_planner_candidate(
        candidate,
        &BuildIntentPlannerRequest {
            user_goal,
            content_profile: profile,
            available_lids: &lids,
            available_sections: &[],
            available_blueprints: &blueprints,
        },
    )
}

fn compile_candidate_draft(
    state: &mut AppState,
    user_goal: &str,
    candidate: BuildIntentPlannerCandidateV2,
    budget: Option<&Value>,
    expected_context_digest: Option<&str>,
    revision_identity: Option<&DraftRevisionIdentity>,
    planning_source: &str,
    now: &str,
) -> Result<Value, ToolError> {
    let initial_context = current_planning_context(state)?;
    if expected_context_digest.is_some_and(|expected| expected != initial_context.context_digest) {
        return Err(error(
            "BUILD_PLANNING_CONTEXT_DRIFT",
            "needs_user",
            "the BuildPlanningContext changed; inspect the current context and plan again",
        ));
    }
    validate_candidate_against_current_state(state, user_goal, &candidate)?;
    let resolved_blueprints = resolve_candidate_blueprints(state, &candidate, true)?;
    let mut core_input = build_core_draft_input(state, "goal_directed", now)?;
    if let Some(identity) = revision_identity {
        core_input["intent_id"] = json!(identity.intent_id.clone());
        core_input["plan_id"] = json!(identity.plan_id.clone());
        core_input["intent_revision"] = json!(identity.intent_revision);
        core_input["plan_revision"] = json!(identity.plan_revision);
    } else {
        apply_active_replan_identity(state, &mut core_input)?;
    }
    core_input["user_goal"] = json!(user_goal);
    core_input["candidate"] = serde_json::to_value(candidate).map_err(internal_json)?;
    core_input["resolved_blueprints"] = Value::Array(resolved_blueprints);
    if let Some(budget) = budget {
        core_input["budget"] = budget.clone();
    }
    let selection = run_core(&json!({ "operation": "draft", "input": core_input }))?;
    let final_context = current_planning_context(state)?;
    if final_context.context_digest != initial_context.context_digest {
        return Err(error(
            "BUILD_PLANNING_CONTEXT_DRIFT",
            "needs_user",
            "the BuildPlanningContext changed during candidate compilation; inspect and plan again",
        ));
    }
    persist_selection(state, &selection)?;
    response(state, selection, planning_source)
}

fn blueprint_registry_summaries(
    state: &AppState,
) -> Result<Vec<ArtifactBlueprintPlannerSummaryV1>, ToolError> {
    let registry = run_blueprint_core(&json!({
        "version": "artifact_blueprint_registry_command.v1",
        "operation": "list",
        "input": { "private_root": private_store(state)?.root() },
    }))?;
    let mut summaries = Vec::new();
    for field in ["system_presets", "user_candidates"] {
        let entries = registry
            .get(field)
            .and_then(Value::as_array)
            .ok_or_else(|| {
                error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "ArtifactBlueprint Registry returned an invalid list",
                )
            })?;
        for entry in entries {
            if entry.get("status").and_then(Value::as_str) != Some("active") {
                continue;
            }
            let blueprint = entry.get("blueprint").ok_or_else(|| {
                error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "ArtifactBlueprint Registry entry has no snapshot",
                )
            })?;
            let properties = blueprint
                .get("record_schema")
                .and_then(|schema| schema.get("properties"))
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    error(
                        INTENT_BUILD_INVALID,
                        "validation",
                        "ArtifactBlueprint Registry entry has no record fields",
                    )
                })?;
            summaries.push(ArtifactBlueprintPlannerSummaryV1 {
                source: required_string(entry, "source")?.into(),
                blueprint_id: required_string(blueprint, "blueprint_id")?.into(),
                blueprint_version: required_string(blueprint, "blueprint_version")?.into(),
                digest: required_string(entry, "digest")?.into(),
                title: required_string(blueprint, "title")?.into(),
                purpose: required_string(blueprint, "purpose")?.into(),
                shape: required_string(blueprint, "shape")?.into(),
                key_fields: properties.keys().cloned().collect(),
            });
        }
    }
    Ok(summaries)
}

fn resolve_candidate_blueprints(
    state: &AppState,
    candidate: &BuildIntentPlannerCandidateV2,
    planning_candidate: bool,
) -> Result<Vec<Value>, ToolError> {
    let private_root = private_store(state)?.root().to_path_buf();
    candidate
        .artifacts
        .iter()
        .map(|artifact| {
            let mut input = json!({
                "private_root": private_root,
                "blueprint_id": artifact.blueprint_id,
                "blueprint_version": artifact.blueprint_version,
            });
            if let Some(blueprint) = artifact.blueprint.as_ref() {
                input["one_off"] = blueprint.clone();
            }
            if planning_candidate {
                input["planning_candidate"] = json!(true);
            }
            let resolution = run_blueprint_core(&json!({
                "version": "artifact_blueprint_registry_command.v1",
                "operation": "resolve",
                "input": input,
            }))?;
            if resolution.get("source").and_then(Value::as_str) != Some(artifact.source.as_str()) {
                return Err(error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "ArtifactBlueprint resolution source does not match the planner selection",
                ));
            }
            Ok(resolution)
        })
        .collect()
}

fn validate_plan_blueprints_current(state: &AppState, plan: &Value) -> Result<(), ToolError> {
    if plan.get("version").and_then(Value::as_str) != Some("build_plan.v2") {
        return Ok(());
    }
    let artifacts = plan
        .get("private_artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "stored V2 plan artifacts are invalid",
            )
        })?;
    for artifact in artifacts {
        let blueprint = artifact.get("blueprint").ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "stored V2 plan has no Blueprint snapshot",
            )
        })?;
        let source = required_string(blueprint, "origin")?;
        let mut candidate = BuildIntentPlannerCandidateV2 {
            version: "build_intent_planner_candidate.v2".into(),
            goal_kind: "other".into(),
            source_scope: runtime::build_intent::BuildIntentSourceScopeCandidateV1 {
                whole_book: true,
                lids: Vec::new(),
                sections: Vec::new(),
            },
            artifacts: vec![
                runtime::build_intent::BuildIntentPlannerArtifactCandidateV2 {
                    source: source.into(),
                    blueprint_id: required_string(blueprint, "blueprint_id")?.into(),
                    blueprint_version: required_string(blueprint, "blueprint_version")?.into(),
                    blueprint: (source == "one_off").then(|| blueprint.clone()),
                },
            ],
            usage_horizon: "one_off".into(),
        };
        let resolution = resolve_candidate_blueprints(state, &candidate, false)
            .map_err(|_| {
                error(
                    "BUILD_PLAN_BLUEPRINT_DRIFT",
                    "needs_user",
                    "the current ArtifactBlueprint Registry no longer matches this draft plan",
                )
            })?
            .pop()
            .expect("one Blueprint resolution");
        candidate.artifacts.clear();
        if resolution.get("digest") != artifact.get("blueprint_digest")
            || resolution.get("blueprint") != Some(blueprint)
        {
            return Err(error(
                "BUILD_PLAN_BLUEPRINT_DRIFT",
                "needs_user",
                "the current ArtifactBlueprint snapshot or digest changed; replan before confirmation",
            ));
        }
    }
    Ok(())
}

fn selection_from_artifacts(plan: Value, intent: Option<Value>) -> Result<Value, ToolError> {
    let selection_version = match plan.get("version").and_then(Value::as_str) {
        Some("build_plan.v2") => "build_intent_selection.v2",
        Some("build_plan.v1") => "build_intent_selection.v1",
        _ => {
            return Err(error(
                INTENT_BUILD_INVALID,
                "validation",
                "stored BuildPlan version is unsupported",
            ))
        }
    };
    let recipe = required_string(&plan, "recipe_id")?;
    let plan_id = required_string(&plan, "plan_id")?;
    let plan_digest = required_string(&plan, "plan_digest")?;
    let status = plan
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("draft");
    Ok(json!({
        "version": selection_version,
        "mode": recipe,
        "intent": intent,
        "intent_digest": plan.get("intent_digest").cloned().unwrap_or(Value::Null),
        "plan": plan,
        "estimate_input": null,
        "decision_request": {
            "version": "build_decision_request.v2",
            "decision_id": format!("decision-{}", &plan_digest[..16]),
            "scope": { "kind": "build_plan", "plan_id": plan_id, "plan_digest": plan_digest },
            "kind": "build_intent_plan",
            "options": [
                { "id": "confirm", "label": "Confirm plan" },
                { "id": "reject", "label": "Keep reading" }
            ],
            "status": if status == "draft" { "pending" } else { "answered" },
        },
    }))
}

fn read_plan_intent(
    store: &IntentArtifactStore,
    book_id: &str,
    plan: &Value,
) -> Result<Option<Value>, ToolError> {
    plan.get("intent_id")
        .and_then(Value::as_str)
        .map(|intent_id| store.read_intent(book_id, intent_id))
        .transpose()
}

fn persist_selection(state: &AppState, selection: &Value) -> Result<(), ToolError> {
    let store = private_store(state)?;
    if let Some(intent) = selection.get("intent").filter(|value| !value.is_null()) {
        store.write_intent(intent)?;
    }
    if let Some(plan) = selection.get("plan").filter(|value| !value.is_null()) {
        store.write_plan(plan)?;
    }
    Ok(())
}

fn response(state: &AppState, selection: Value, planning_source: &str) -> Result<Value, ToolError> {
    Ok(json!({
        "version": RESPONSE_VERSION,
        "planning_source": planning_source,
        "selection": selection,
        "inspection": private_store(state)?.inspect_redacted(&state.book.base.book_id)?,
    }))
}

fn codex_selection(state: &AppState, input: &Value) -> Result<Option<Value>, ToolError> {
    reject_unknown_fields(input, &["plan_id"])?;
    let store = private_store(state)?;
    let inspection = store.inspect_redacted(&state.book.base.book_id)?;
    let plan_id = if let Some(plan_id) = input.get("plan_id") {
        Some(
            plan_id
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    error(
                        INTENT_BUILD_INVALID,
                        "validation",
                        "plan_id must be a non-blank string",
                    )
                })?
                .to_string(),
        )
    } else {
        let drafts = inspection
            .plans
            .iter()
            .filter(|plan| plan.status == "draft")
            .collect::<Vec<_>>();
        if drafts.len() > 1 {
            return Err(error(
                "CODEX_BUILD_INTENT_AMBIGUOUS",
                "needs_user",
                "multiple current draft plans exist; select an explicit plan_id",
            ));
        }
        drafts
            .first()
            .map(|plan| plan.plan_id.clone())
            .or_else(|| {
                inspection
                    .active_overlay
                    .as_ref()
                    .map(|active| active.plan_id.clone())
            })
            .or_else(|| {
                inspection
                    .plans
                    .iter()
                    .filter(|plan| matches!(plan.status.as_str(), "confirmed" | "completed"))
                    .max_by_key(|plan| plan.revision)
                    .map(|plan| plan.plan_id.clone())
            })
    };
    let Some(plan_id) = plan_id else {
        return Ok(None);
    };
    let plan = store.read_plan(&state.book.base.book_id, &plan_id)?;
    let intent = read_plan_intent(&store, &state.book.base.book_id, &plan)?;
    selection_from_artifacts(plan, intent).map(Some)
}

fn codex_response(state: &AppState, selection: Option<Value>) -> Result<Value, ToolError> {
    let store = private_store(state)?;
    let (projection, build_plan_path) = if let Some(selection) = selection {
        let plan_id = selection
            .get("plan")
            .and_then(|plan| plan.get("plan_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                error(
                    INTENT_BUILD_INVALID,
                    "validation",
                    "Codex selection has no BuildPlan identity",
                )
            })?;
        let path = store.build_plan_path(&state.book.base.book_id, plan_id)?;
        (
            run_core(&json!({ "operation": "project_codex", "selection": selection }))?,
            Value::String(path.to_string_lossy().into_owned()),
        )
    } else {
        (Value::Null, Value::Null)
    };
    Ok(json!({
        "version": "codex_build_intent_response.v1",
        "projection": projection,
        "build_plan_path": build_plan_path,
        "inspection": store.inspect_redacted(&state.book.base.book_id)?,
    }))
}

pub(super) fn run_codex_command(
    state: &mut AppState,
    operation: &str,
    input: Value,
    now: &str,
) -> Result<Value, ToolError> {
    if operation != "planning.context" {
        synchronize_active_source(state)?;
    }
    match operation {
        "planning.context" => {
            reject_unknown_fields(&input, &[])?;
            serde_json::to_value(current_planning_context(state)?).map_err(internal_json)
        }
        "draft.candidate" => {
            reject_unknown_fields(
                &input,
                &[
                    "user_goal",
                    "planning_context_digest",
                    "candidate",
                    "budget",
                ],
            )?;
            let user_goal = required_string(&input, "user_goal")?;
            let context_digest = required_string(&input, "planning_context_digest")?;
            let candidate: BuildIntentPlannerCandidateV2 =
                serde_json::from_value(input.get("candidate").cloned().ok_or_else(|| {
                    error(
                        "BUILD_INTENT_CANDIDATE_INVALID",
                        "validation",
                        "candidate is required",
                    )
                })?)
                .map_err(|_| {
                    error(
                        "BUILD_INTENT_CANDIDATE_INVALID",
                        "validation",
                        "candidate does not match the strict planner schema",
                    )
                })?;
            let drafted = compile_candidate_draft(
                state,
                user_goal,
                candidate,
                input.get("budget"),
                Some(context_digest),
                None,
                "codex",
                now,
            )?;
            codex_response(state, drafted.get("selection").cloned())
        }
        "draft" => {
            reject_unknown_fields(&input, &["user_goal", "budget"])?;
            let mut body = input;
            body["mode"] = json!("goal_directed");
            let drafted = draft(state, &body.to_string(), now)?;
            codex_response(state, drafted.get("selection").cloned())
        }
        "status" => codex_response(state, codex_selection(state, &input)?),
        "confirm" => {
            reject_unknown_fields(&input, &["plan_id", "plan_digest"])?;
            let confirmed =
                confirm_with_source(state, &input.to_string(), now, "codex_conversation")?;
            codex_response(state, confirmed.get("selection").cloned())
        }
        "reject" => {
            reject_unknown_fields(&input, &["plan_id"])?;
            let rejected = reject(state, &input.to_string())?;
            codex_response(state, rejected.get("selection").cloned())
        }
        "artifact.prepare" => {
            reject_unknown_fields(&input, &["plan_id"])?;
            prepare_artifacts(state, &input.to_string(), now)
        }
        "artifact.submit" => {
            reject_unknown_fields(&input, &["task_path"])?;
            submit_artifact(state, &input.to_string(), now)
        }
        "artifact.fail" => {
            reject_unknown_fields(&input, &["task_path", "diagnostic_code", "message"])?;
            fail_artifact(state, &input.to_string(), now)
        }
        "artifact.inspect" => {
            reject_unknown_fields(&input, &["task_path"])?;
            inspect_artifact(state, &input.to_string())
        }
        _ => Err(error(
            "CODEX_BUILD_INTENT_OPERATION_INVALID",
            "validation",
            "unsupported Codex build-intent operation",
        )),
    }
}

fn private_store(state: &AppState) -> Result<IntentArtifactStore, ToolError> {
    let root = state.intent_store_root.as_ref().ok_or_else(|| {
        error(
            "READER_PRIVATE_STORAGE_UNAVAILABLE",
            "permission",
            "this host cannot access reader-private build intents",
        )
    })?;
    IntentArtifactStore::open(root)
}

fn resolve_core_command() -> Result<CoreIntentCommand, ToolError> {
    resolve_named_core_command("intent.plan", "intent-plan.ts")
}

fn resolve_artifact_core_command() -> Result<CoreIntentCommand, ToolError> {
    resolve_named_core_command("intent.artifact", "intent-artifact.ts")
}

fn resolve_metrics_core_command() -> Result<CoreIntentCommand, ToolError> {
    resolve_named_core_command("intent.metrics", "intent-metrics.ts")
}

fn resolve_blueprint_core_command() -> Result<CoreIntentCommand, ToolError> {
    resolve_named_core_command("intent.blueprint", "intent-blueprint.ts")
}

fn resolve_named_core_command(
    packaged_subcommand: &str,
    development_script: &str,
) -> Result<CoreIntentCommand, ToolError> {
    if let Some(configured) = std::env::var_os("UNDERSTAND_BOOK_BUILD_SIDECAR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return packaged_core_command(&configured, packaged_subcommand);
    }
    if let Some(executable_dir) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
    {
        let sidecar = executable_dir.join(format!(
            "understand-book-build{}",
            std::env::consts::EXE_SUFFIX
        ));
        if sidecar.is_file() {
            return packaged_core_command(&sidecar, packaged_subcommand);
        }
    }
    let root = workspace_root();
    let tsx = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let script = root.join("skills").join("build").join(development_script);
    if !tsx.is_file() || !script.is_file() {
        return Err(error(
            "BUILD_INTENT_CORE_UNAVAILABLE",
            "internal",
            "the build intent Core sidecar is not installed",
        ));
    }
    Ok(CoreIntentCommand {
        program: PathBuf::from(
            std::env::var_os("UNDERSTAND_BOOK_NODE").unwrap_or_else(|| OsString::from("node")),
        ),
        prefix_args: vec![tsx.into_os_string(), script.into_os_string()],
        current_dir: root,
    })
}

fn packaged_core_command(
    sidecar: &Path,
    packaged_subcommand: &str,
) -> Result<CoreIntentCommand, ToolError> {
    if !sidecar.is_file() {
        return Err(error(
            "BUILD_INTENT_CORE_UNAVAILABLE",
            "internal",
            "UNDERSTAND_BOOK_BUILD_SIDECAR does not point to a file",
        ));
    }
    Ok(CoreIntentCommand {
        program: sidecar.to_path_buf(),
        prefix_args: vec![OsString::from(packaged_subcommand)],
        current_dir: sidecar
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
    })
}

fn run_core(request: &Value) -> Result<Value, ToolError> {
    let command = resolve_core_command()?;
    run_core_command(command, request)
}

fn run_artifact_core(request: &Value) -> Result<Value, ToolError> {
    let command = resolve_artifact_core_command()?;
    run_core_command(command, request)
}

fn run_metrics_core(request: &Value) -> Result<Value, ToolError> {
    let command = resolve_metrics_core_command()?;
    run_core_command(command, request)
}

fn run_blueprint_core(request: &Value) -> Result<Value, ToolError> {
    let command = resolve_blueprint_core_command()?;
    run_core_command(command, request)
}

fn run_core_command(command: CoreIntentCommand, request: &Value) -> Result<Value, ToolError> {
    let mut child = Command::new(&command.program)
        .args(&command.prefix_args)
        .current_dir(&command.current_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error_value| {
            error(
                "BUILD_INTENT_CORE_UNAVAILABLE",
                "internal",
                format!("build intent Core sidecar could not start: {error_value}"),
            )
        })?;
    let input = serde_json::to_vec(request).map_err(internal_json)?;
    child
        .stdin
        .take()
        .ok_or_else(|| {
            error(
                "BUILD_INTENT_CORE_ERROR",
                "internal",
                "Core stdin is unavailable",
            )
        })?
        .write_all(&input)
        .map_err(|write_error| {
            error(
                "BUILD_INTENT_CORE_ERROR",
                "internal",
                format!("build intent Core request could not be written: {write_error}"),
            )
        })?;
    let output = child.wait_with_output().map_err(|wait_error| {
        error(
            "BUILD_INTENT_CORE_ERROR",
            "internal",
            format!("build intent Core sidecar could not finish: {wait_error}"),
        )
    })?;
    if !output.status.success() {
        return Err(error(
            INTENT_BUILD_INVALID,
            "validation",
            "build intent request was rejected by the Core contract",
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|parse_error| {
        error(
            "BUILD_INTENT_CORE_ERROR",
            "internal",
            format!("build intent Core response is invalid JSON: {parse_error}"),
        )
    })
}

fn parse_body(body: &str) -> Result<Value, ToolError> {
    serde_json::from_str(body).map_err(|_| {
        error(
            INTENT_BUILD_INVALID,
            "validation",
            "request body must be a JSON object",
        )
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ToolError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                format!("{field} is required"),
            )
        })
}

fn required_revision(value: &Value) -> Result<u64, ToolError> {
    value
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            error(
                INTENT_BUILD_INVALID,
                "validation",
                "stored revision is invalid",
            )
        })
}

fn reject_unknown_fields(value: &Value, allowed: &[&str]) -> Result<(), ToolError> {
    let object = value.as_object().ok_or_else(|| {
        error(
            INTENT_BUILD_INVALID,
            "validation",
            "request body must be a JSON object",
        )
    })?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(error(
            INTENT_BUILD_INVALID,
            "validation",
            "request body contains an unrecognized field",
        ));
    }
    Ok(())
}

fn copy_optional(source: &Value, target: &mut Value, field: &str) {
    if let Some(value) = source.get(field) {
        target[field] = value.clone();
    }
}

fn internal_json(error_value: serde_json::Error) -> ToolError {
    error(
        "BUILD_INTENT_INTERNAL",
        "internal",
        format!("build intent JSON conversion failed: {error_value}"),
    )
}

fn error(
    code: impl Into<String>,
    category: impl Into<String>,
    message: impl Into<String>,
) -> ToolError {
    ToolError {
        error_code: code.into(),
        category: category.into(),
        message: message.into(),
    }
}
