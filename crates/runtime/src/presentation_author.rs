//! Resident authoring contract. The host owns files and browser lifetime.
use crate::{
    orchestrator::SourceBinding, presentation::PresentationRef,
    presentation_preview::{PreviewAction, PreviewViewport}, ToolSpec,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorRequest {
    Read {
        reference: PresentationRef,
        #[serde(default)]
        file: Option<String>,
        #[serde(default)]
        offset: usize,
    },
    Write {
        #[serde(default)]
        based_on: Option<PresentationRef>,
        #[serde(default)]
        state_contract: Value,
        title: String,
        html: String,
        readable_content: String,
        #[serde(default)]
        source_ref_ids: Vec<String>,
        #[serde(default)]
        assumptions: Vec<String>,
        #[serde(default)]
        initial_state: Value,
    },
    Preview {
        candidate_id: String,
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        viewport: Option<PreviewViewport>,
        #[serde(default)]
        actions: Vec<PreviewAction>,
    },
    Deliver {
        candidate_id: String,
    },
}

pub struct AuthorResult {
    pub body: Value,
    pub images: Vec<PreviewImage>,
    pub previewed_candidate: Option<String>,
    pub delivered: Option<PresentationRef>,
}

#[derive(Debug, Clone)]
pub struct PreviewImage {
    pub caption: String,
    pub png_base64: String,
}

pub fn unavailable() -> read_tools::ToolError {
    read_tools::ToolError {
        error_code: "PRESENTATION_UNAVAILABLE".into(),
        category: "unavailable".into(),
        message: "This host has no private presentation authoring storage".into(),
    }
}

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "presentation.author".into(),
        description: "Create or revise rich answers or interactive HTML. read requires an exact reference and returns the saved code on demand. To edit, write with based_on set to that reference; revisions never replace old answers. state_contract declares compatible scalar page parameters. write requires title, html and readable_content and saves an immutable candidate. preview executes real actions and returns environment-bound DOM, layout issues and screenshots. For a new candidate, preview exactly these three required viewports: 320x420 touch, 640x240 touch, and 960x720 mouse; fix any failed environment before deliver. The legacy width field remains available for old callers and cannot be combined with viewport. deliver saves a candidate only after the applicable preview contract is complete. Correct errors by writing a new candidate and previewing again. HTML must be self-contained with inline CSS/JS and data images. No external dependencies. Sources use data-source-ref buttons and refs from source.present, or unchanged refs from the based_on version. Never pass source binding metadata.".into(),
        parameters: json!({"type":"object","properties":{
            "operation":{"type":"string","enum":["read","write","preview","deliver"]},
            "reference":{"type":"object","properties":{"presentation_id":{"type":"string"},"revision":{"type":"integer"}},"required":["presentation_id","revision"],"additionalProperties":false},
            "based_on":{"type":"object","properties":{"presentation_id":{"type":"string"},"revision":{"type":"integer"}},"required":["presentation_id","revision"],"additionalProperties":false},
            "state_contract":{"type":"object","description":"Parameter name -> semantic definition string, including units and allowed range. Preserve a definition only when old values retain exactly the same meaning and domain. Saved page parameters with identical definitions and JSON types replace matching initial_state fields; all others keep new defaults."},
            "file":{"type":"string","description":"read: logical file name; defaults to entrypoint"},
            "offset":{"type":"integer","minimum":0,"description":"read: character offset; follow next_offset until null to read the complete file"},
            "title":{"type":"string"}, "html":{"type":"string"},
            "readable_content":{"type":"string"},
            "source_ref_ids":{"type":"array","items":{"type":"string"}},
            "assumptions":{"type":"array","items":{"type":"string"}},
            "initial_state":{}, "candidate_id":{"type":"string"},
            "width":{"type":"integer","minimum":240,"maximum":1920,"description":"preview viewport width in CSS pixels; defaults to 960. Use 340 to inspect narrow layout on this same candidate."},
            "viewport":{"type":"object","description":"Explicit content-container environment. Do not provide width at the same time.","properties":{
                "width":{"type":"integer","minimum":240,"maximum":1920},
                "height":{"type":"integer","minimum":160,"maximum":2160},
                "input":{"type":"string","enum":["mouse","touch"]}
            },"required":["width","height","input"],"additionalProperties":false},
            "actions":{"type":"array","maxItems":4,"items":{"type":"object","properties":{
                "kind":{"type":"string","enum":["click","key"]}, "selector":{"type":"string","description":"Required click target; optional key target to focus before pressing. Without a key target, the current focus receives the key."},
                "key":{"type":"string","enum":["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","Enter","Tab"]}
            },"required":["kind"],"additionalProperties":false}}
        },"required":["operation"],"additionalProperties":false}),
    }
}

pub fn bindings_for(
    ids: &[String],
    bindings: &[SourceBinding],
) -> Result<Vec<SourceBinding>, read_tools::ToolError> {
    ids.iter()
        .map(|id| {
            bindings
                .iter()
                .find(|b| &b.source_ref_id == id)
                .cloned()
                .ok_or_else(|| read_tools::ToolError {
                    error_code: "PRESENTATION_SOURCE_UNKNOWN".into(),
                    category: "validation".into(),
                    message: format!("Use a source.present ref observed in this run: {id}"),
                })
        })
        .collect()
}

/// Preserve identities and receipts, not generated source code, in future conversation context.
pub fn redact_history(messages: &mut [crate::Message]) {
    for message in messages {
        for call in &mut message.tool_calls {
            if call.name == "presentation.author" {
                if let Ok(value) = serde_json::from_str::<Value>(&call.arguments) {
                    call.arguments = json!({"operation":value["operation"],"title":value["title"],"reference":value["reference"],"based_on":value["based_on"]}).to_string();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{tool_exposure::*, ModelRuntimeProfile, ProviderToolProtocol};

    #[test]
    fn presentation_history_keeps_versions_without_stale_candidate_handles() {
        let reference = json!({"presentation_id":"p","revision":2});
        let mut message = crate::Message::user("edit");
        message.tool_calls.push(crate::ToolCall { id:"call".into(), name:"presentation.author".into(), arguments:json!({"operation":"write","candidate_id":"old-candidate","based_on":reference,"html":"old code"}).to_string() });
        super::redact_history(std::slice::from_mut(&mut message));
        let args: Value = serde_json::from_str(&message.tool_calls[0].arguments).unwrap();
        assert_eq!(args["based_on"], reference);
        assert!(args.get("candidate_id").is_none());
        assert!(args.get("html").is_none());
    }

    #[test]
    fn presentation_author_discovery_is_deferred_and_operation_scoped() {
        let registry = crate::orchestrator::resident_tool_registry();
        let profile = ModelRuntimeProfile::fallback("test", ProviderToolProtocol::Native);
        let context = ToolExposureContext {
            content_profile: read_tools::ContentProfileId::TechnicalLearning,
            permissions: ToolPermissions::default(),
            evidence_state: EvidenceState::Unlocated,
            artifact: ArtifactExposureContext::no_overlay(),
        };
        let mut state = ToolExposureState::default();
        let before = ToolExposurePlan::build(&registry, &profile, &context, &state);
        assert!(!before.is_visible("presentation.author"));
        let result = search_and_activate(&json!({"task":"interactive HTML explanation", "required_capabilities":["presentation_authoring"],"scope":"passage","operation":"explain","effect_mode":"read_only","max_results":1}).to_string(),&context,&before,&registry,&mut state).unwrap();
        assert_eq!(result.activated, vec!["presentation.author"]);
        assert!(
            ToolExposurePlan::build(&registry, &profile, &context, &state)
                .is_visible("presentation.author")
        );
    }

    #[test]
    fn presentation_images_reach_native_and_react_without_entering_history() {
        let profile = ModelRuntimeProfile::fallback("test", ProviderToolProtocol::Native);
        let mut plan = crate::AgentRequestPlan::for_agent_turn(
            profile,
            &[crate::Message::user("explain")],
            &[],
        );
        plan.preview_images.push(PreviewImage {
            caption: "candidate c1 step 0".into(),
            png_base64: "test-png".into(),
        });
        for body in [
            crate::native_chat_request_projection("test", &plan).0,
            crate::react_chat_request_projection("test", &plan),
        ] {
            let last = body["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(last["content"][0]["text"], "candidate c1 step 0");
            assert_eq!(
                last["content"][1]["image_url"]["url"],
                "data:image/png;base64,test-png"
            );
        }
        assert!(!serde_json::to_string(&plan.ordered_messages())
            .unwrap()
            .contains("test-png"));
    }

    #[test]
    fn presentation_author_schema_keeps_legacy_width_and_describes_explicit_viewport() {
        let parameters = spec().parameters;
        let properties = parameters["properties"].as_object().unwrap();
        assert_eq!(properties["width"]["minimum"], 240);
        assert_eq!(properties["width"]["maximum"], 1920);
        assert_eq!(properties["viewport"]["properties"]["height"]["minimum"], 160);
        assert_eq!(
            properties["viewport"]["properties"]["input"]["enum"],
            json!(["mouse", "touch"])
        );
        assert_eq!(
            properties["viewport"]["required"],
            json!(["width", "height", "input"])
        );
    }
}
