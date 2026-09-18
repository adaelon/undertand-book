//! Short private storage borrows surround a browser rehearsal outside AppState's lock.
use crate::{
    agent_run::{AppStatePort, RuntimeStatePort},
    *,
};
use runtime::{
    presentation::*, presentation_author::*, presentation_preview::*,
    run_context::CancellationToken,
};

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: "PRESENTATION_AUTHORING_FAILED".into(),
        category: "validation".into(),
        message: message.into(),
    }
}

fn missing_preview_environments(receipts: &std::collections::HashSet<String>) -> Vec<String> {
    REQUIRED_PREVIEW_ENVIRONMENTS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .filter(|name| !receipts.contains(name))
        .collect()
}

fn preview_contract_complete(receipts: &std::collections::HashSet<String>) -> bool {
    receipts.contains("legacy") || missing_preview_environments(receipts).is_empty()
}

impl<P: AppStatePort> RuntimeStatePort<'_, P> {
    pub(crate) fn author(
        &mut self,
        request: AuthorRequest,
        bindings: &[SourceBinding],
        messages: &[Message],
        cancellation: &CancellationToken,
    ) -> Result<AuthorResult, ToolError> {
        cancellation.check()?;
        let mut result = AuthorResult {
            body: Value::Null,
            images: vec![],
            previewed_candidate: None,
            delivered: None,
        };
        match request {
            AuthorRequest::Read { reference, file, offset } => {
                let version = self.port.with_app(|state| state.read_presentation(&self.turn_ref.session_id, &reference))?;
                let content = version.content;
                let file = file.unwrap_or_else(|| content.entrypoint.clone());
                let source = content.content_files.get(&file).ok_or_else(|| invalid("Content file not found"))?;
                let length = source.chars().count();
                if offset > length { return Err(invalid("Offset exceeds file length")); }
                let text: String = source.chars().skip(offset).take(4000).collect();
                let end = offset + text.chars().count();
                let next_offset = (end < length).then_some(end);
                result.body = json!({"status":"version_read","reference":reference,"based_on":version.based_on,
                    "title":content.title,"files":content.content_files.keys().collect::<Vec<_>>(),"entrypoint":content.entrypoint,
                    "file":file,"offset":offset,"text":text,"next_offset":next_offset,"total_characters":length,"chunk_characters":4000,
                    "readable_content":content.readable_content,"assumptions":content.assumptions,
                    "source_ref_ids":content.source_bindings.iter().map(|b| &b.source_ref_id).collect::<Vec<_>>(),
                    "state_contract":content.state_contract,"initial_state":content.initial_state});
            }
            AuthorRequest::Write {
                based_on,
                state_contract,
                title,
                html,
                readable_content,
                source_ref_ids,
                assumptions,
                mut initial_state,
            } => {
                if html.len() > 1024 * 1024 {
                    return Err(invalid("HTML exceeds 1 MiB"));
                }
                let mut available_bindings = bindings.to_vec();
                if let Some(reference) = &based_on {
                    let (base, saved) = self.port.with_app(|state| {
                        let base = state.read_presentation(&self.turn_ref.session_id, reference)?;
                        let receipt = state.agent_history.sessions.iter().find(|s| s.id == self.turn_ref.session_id)
                            .and_then(|s| s.turns.iter().find(|t| t.turn_id == self.turn_ref.turn_id))
                            .and_then(|t| t.presentation_follow_up.as_ref());
                        if receipt.is_some_and(|r| &r.reference != reference) { return Err(invalid("Edit the exact version selected by the presentation follow-up receipt")); }
                        let saved = match receipt {
                            Some(receipt) => Some(state.read_presentation_state(receipt)?),
                            None => state.latest_presentation_state(&self.turn_ref.session_id, reference)?,
                        };
                        Ok::<_, ToolError>((base, saved))
                    })?;
                    if let Some(saved) = saved { inherit_parameters(&mut initial_state, &state_contract, &base.content.state_contract, &saved.state); }
                    for binding in base.content.source_bindings {
                        if !available_bindings.iter().any(|b| b.source_ref_id == binding.source_ref_id) { available_bindings.push(binding); }
                    }
                }
                let content = PresentationContent {
                    title,
                    content_files: [("index.html".into(), html)].into(),
                    entrypoint: "index.html".into(),
                    readable_content,
                    source_bindings: bindings_for(&source_ref_ids, &available_bindings)?,
                    assumptions,
                    state_contract,
                    initial_state,
                };
                validate_content_semantics(&content, messages)?;
                let candidate = self.port.with_app(|state| {
                    state.create_presentation_candidate(
                        &self.turn_ref.session_id,
                        &self.turn_ref.turn_id,
                        based_on,
                        content,
                    )
                })?;
                result.body = json!({"candidate_id":candidate.candidate_id,"based_on":candidate.based_on,"initial_state":candidate.content.initial_state,"status":"candidate_saved","next":"preview with real actions; inspect returned screenshots before deliver"});
            }
            AuthorRequest::Preview {
                candidate_id,
                width,
                viewport,
                actions,
            } => {
                if actions.len() > 4 {
                    return Err(invalid("At most four actions per rehearsal; preview further paths in a new rehearsal"));
                }
                let candidate = self.port.with_app(|state| {
                    state.read_presentation_candidate(&self.turn_ref.session_id, &candidate_id)
                })?;
                if candidate.created_by_turn_id != self.turn_ref.turn_id {
                    return Err(invalid("Candidate belongs to a different run"));
                }
                let html = preview_document(&candidate.content);
                let request = PreviewRequest {
                    candidate_id: candidate_id.clone(),
                    html,
                    actions,
                    width,
                    viewport,
                };
                let environment = request.environment().map_err(invalid)?;
                let environment_name = preview_environment_name(environment);
                let legacy_request = request.viewport.is_none();
                let browser =
                    crate::presentation_preview::BrowserPreview::discover().map_err(invalid)?;
                let report = browser
                    .preview(&request, cancellation)
                    .map_err(|error| invalid(format!("{}: {}", error.phase, error.message)))?;
                cancellation.check()?;
                let mut problems = report
                    .errors
                    .iter()
                    .map(|error| {
                        json!({"kind":"candidate_execution","message":error,"environment":report.environment_name})
                    })
                    .collect::<Vec<_>>();
                for observation in &report.observations {
                    problems.extend(observation.issues.iter().map(|issue| {
                        json!({"step":observation.step,"kind":issue.kind,"message":issue.message,"environment":report.environment_name})
                    }));
                    if let Err(error) =
                        validate_observation(&candidate.content, &observation.dom, messages)
                    {
                        problems.push(json!({"step":observation.step,"kind":"result_mismatch","message":error.message,"environment":report.environment_name}));
                    }
                }
                let clean = problems.is_empty() && !report.observations.is_empty();
                let receipt = if legacy_request { "legacy".to_string() } else { environment_name.clone() };
                if clean {
                    self.previewed.entry(candidate_id.clone()).or_default().insert(receipt.clone());
                } else if let Some(receipts) = self.previewed.get_mut(&candidate_id) {
                    receipts.remove(&receipt);
                }
                let receipts = self.previewed.get(&candidate_id).cloned().unwrap_or_default();
                let missing_environments = missing_preview_environments(&receipts);
                let complete = clean && preview_contract_complete(&receipts);
                let mut recorded_environments = receipts.into_iter().collect::<Vec<_>>();
                recorded_environments.sort();
                for observation in &report.observations {
                    result.images.push(PreviewImage { caption: format!("Browser observation of candidate {candidate_id} in {} ({}x{} {:?}), step {}. Inspect layout, graphics and agreement with readable content before delivery.", report.environment_name, report.environment.width, report.environment.height, report.environment.input, observation.step), png_base64: observation.screenshot_png_base64.clone() });
                }
                if complete { result.previewed_candidate = Some(candidate_id.clone()); }
                result.body = json!({"candidate_id":candidate_id,"status":if !clean {"preview_failed"} else if complete {"preview_ready_for_inspection"} else {"preview_environment_recorded"},"errors":problems,
                    "environment_name":report.environment_name,"environment":report.environment,"recorded_environments":recorded_environments,"missing_environments":missing_environments,
                    "observations":report.observations.iter().map(|o| json!({"step":o.step,"dom":o.dom,"layout":o.layout,"issues":o.issues})).collect::<Vec<_>>()});
                if !clean {
                    result.body["error_code"] = json!("PRESENTATION_PREVIEW_FAILED");
                    result.body["category"] = json!("execution");
                }
            }
            AuthorRequest::Deliver { candidate_id } => {
                let ready = self.previewed.get(&candidate_id).is_some_and(preview_contract_complete);
                if !ready {
                    return Err(invalid(
                        "Preview this exact candidate successfully before delivery",
                    ));
                }
                let reference = self.port.with_app(|state| {
                    let candidate = state
                        .read_presentation_candidate(&self.turn_ref.session_id, &candidate_id)?;
                    validate_content_semantics(&candidate.content, messages)?;
                    cancellation.check()?;
                    state.persist_presentation_candidate(
                        &self.turn_ref.session_id,
                        &self.turn_ref.turn_id,
                        &candidate_id,
                    )
                })?;
                result.body = json!({"status":"version_saved","reference":reference,"next":"Conclude normally; Runtime attaches this version to the final answer. History commit is still pending."});
                result.delivered = Some(reference);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod preview_contract_tests {
    use super::*;

    #[test]
    fn explicit_preview_contract_requires_all_three_bound_environments() {
        let mut receipts = std::collections::HashSet::new();
        receipts.insert("narrow-content".to_string());
        receipts.insert("short-content".to_string());
        assert_eq!(missing_preview_environments(&receipts), vec!["desktop-content"]);
        assert!(!preview_contract_complete(&receipts));
        receipts.insert("desktop-content".to_string());
        assert!(preview_contract_complete(&receipts));
    }

    #[test]
    fn legacy_preview_receipt_remains_deliverable() {
        assert!(preview_contract_complete(&["legacy".to_string()].into()));
    }
}

fn inherit_parameters(initial: &mut Value, contract: &Value, old_contract: &Value, saved: &PresentationState) {
    let (Some(defaults), Some(parameters)) = (initial.as_object_mut(), saved.values.get("page").and_then(Value::as_object)) else { return; };
    for (key, default) in defaults {
        let Some(definition) = contract.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else { continue; };
        if old_contract.get(key).and_then(Value::as_str) != Some(definition) { continue; }
        if let Some(value) = parameters.get(key) {
            let same_type = matches!((&*default, value), (Value::Bool(_), Value::Bool(_)) | (Value::Number(_), Value::Number(_)) | (Value::String(_), Value::String(_)));
            if same_type { *default = value.clone(); }
        }
    }
}

fn compile(
    text: &str,
    content: &PresentationContent,
    messages: &[Message],
    allow_refs: bool,
) -> Result<(), ToolError> {
    let view =
        runtime::orchestrator::compile_presentation_text(text, &content.source_bindings, messages)
            .map_err(|issues| invalid(format!("Public content rejected: {issues:?}")))?;
    if !allow_refs
        && view
            .parts
            .iter()
            .any(|p| matches!(p, AgentAnswerPart::Sources { .. }))
    {
        return Err(invalid(
            "Use data-source-ref controls, not raw source markup in page text",
        ));
    }
    Ok(())
}
fn validate_content_semantics(
    content: &PresentationContent,
    messages: &[Message],
) -> Result<(), ToolError> {
    compile(&content.readable_content, content, messages, true)?;
    for text in std::iter::once(&content.title).chain(content.assumptions.iter()) {
        compile(text, content, messages, false)?;
    }
    Ok(())
}
fn validate_observation(
    content: &PresentationContent,
    dom: &Value,
    messages: &[Message],
) -> Result<(), ToolError> {
    if dom["unsupported_assets"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        return Err(invalid("Use inline CSS/JS, inline SVG or data images; external/local asset dependencies are unsupported by authoring"));
    }
    for id in dom["source_ref_ids"].as_array().into_iter().flatten() {
        if !content
            .source_bindings
            .iter()
            .any(|b| Some(b.source_ref_id.as_str()) == id.as_str())
        {
            return Err(invalid("Page contains an unbound source ref"));
        }
    }
    compile(
        dom["semantic_text"]
            .as_str()
            .ok_or_else(|| invalid("Missing browser semantics"))?,
        content,
        messages,
        false,
    )
}

fn preview_document(content: &PresentationContent) -> String {
    let sources: Vec<_> = content
        .source_bindings
        .iter()
        .map(|b| json!({"source_ref_id":b.source_ref_id,"label":b.label_snapshot}))
        .collect();
    let config = json!({"initialState":content.initial_state,"sources":sources})
        .to_string()
        .replace('<', "\\u003c");
    // Same common CSS, initial-state and source-label contract as the Reader iframe.
    format!(
        r#"<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>{}</style><script>
(()=>{{const config={config};window.presentation=Object.freeze({{initialState:config.initialState,restoredState:null,registerStateReader:()=>{{}},registerStateRestorer:()=>{{}},commitState:()=>{{}}}});
document.addEventListener('DOMContentLoaded',()=>{{
 const label=()=>document.querySelectorAll('[data-source-ref]').forEach(e=>{{const s=config.sources.find(s=>s.source_ref_id===e.getAttribute('data-source-ref'));const t=s?s.label:'来源不可用';if(e.textContent!==t)e.textContent=t;}});
 label();new MutationObserver(label).observe(document.body,{{subtree:true,childList:true,attributes:true}});
 document.addEventListener('click',e=>{{if(e.target.closest('[data-source-ref],a'))e.preventDefault();}},true);
 document.addEventListener('submit',e=>e.preventDefault(),true);
}});}})();</script>{}"#,
        include_str!("../../../packages/web/src/presentation.css"),
        content.content_files[&content.entrypoint]
    )
}
