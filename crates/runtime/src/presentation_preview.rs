//! Host-independent preview execution contract. RP4 will expose this to Resident tools.
use crate::run_context::CancellationToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewRequest {
    pub candidate_id: String,
    /// Self-contained HTML, including inline CSS/JS and data assets.
    pub html: String,
    pub actions: Vec<PreviewAction>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub viewport: Option<PreviewViewport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewInput {
    Mouse,
    Touch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewViewport {
    pub width: u32,
    pub height: u32,
    pub input: PreviewInput,
}

impl PreviewRequest {
    pub fn environment(&self) -> Result<PreviewViewport, String> {
        if self.width.is_some() && self.viewport.is_some() {
            return Err("preview request cannot provide both width and viewport".into());
        }
        let viewport = self.viewport.unwrap_or(PreviewViewport {
            width: self.width.unwrap_or(960),
            height: 720,
            input: PreviewInput::Mouse,
        });
        if !(240..=1920).contains(&viewport.width) {
            return Err("preview width must be between 240 and 1920 CSS pixels".into());
        }
        if !(160..=2160).contains(&viewport.height) {
            return Err("preview height must be between 160 and 2160 CSS pixels".into());
        }
        Ok(viewport)
    }
}

pub const REQUIRED_PREVIEW_ENVIRONMENTS: [(&str, PreviewViewport); 3] = [
    ("narrow-content", PreviewViewport { width: 320, height: 420, input: PreviewInput::Touch }),
    ("short-content", PreviewViewport { width: 640, height: 240, input: PreviewInput::Touch }),
    ("desktop-content", PreviewViewport { width: 960, height: 720, input: PreviewInput::Mouse }),
];

pub fn preview_environment_name(viewport: PreviewViewport) -> String {
    REQUIRED_PREVIEW_ENVIRONMENTS
        .iter()
        .find_map(|(name, candidate)| (*candidate == viewport).then_some((*name).to_string()))
        .unwrap_or_else(|| format!("custom-{}x{}-{:?}", viewport.width, viewport.height, viewport.input).to_lowercase())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewAction {
    Click {
        selector: String,
    },
    /// Focus the optional target, then use real browser key events.
    Key {
        key: String,
        #[serde(default)]
        selector: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreviewObservation {
    /// Zero is initial load; subsequent observations follow each action.
    pub step: usize,
    pub dom: Value,
    pub layout: Value,
    pub screenshot_png_base64: String,
    #[serde(default)]
    pub issues: Vec<PreviewIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewIssue {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreviewReport {
    pub candidate_id: String,
    pub browser: String,
    pub environment: PreviewViewport,
    pub environment_name: String,
    pub observations: Vec<PreviewObservation>,
    /// Browser protocol events, not a candidate's success assertion.
    pub errors: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreviewError {
    pub candidate_id: String,
    pub phase: String,
    pub message: String,
}

pub trait PresentationPreviewPort: Send + Sync {
    /// Execute one bounded rehearsal, then release its browser and temporary profile.
    /// The caller passes the current RunContext cancellation (including host shutdown).
    fn preview(
        &self,
        request: &PreviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<PreviewReport, PreviewError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_width_and_explicit_viewport_have_unambiguous_environments() {
        let legacy: PreviewRequest = serde_json::from_value(serde_json::json!({
            "candidate_id":"c1","html":"<p>x</p>","actions":[],"width":340
        })).unwrap();
        assert_eq!(legacy.environment().unwrap(), PreviewViewport {
            width: 340,
            height: 720,
            input: PreviewInput::Mouse,
        });

        let touch: PreviewRequest = serde_json::from_value(serde_json::json!({
            "candidate_id":"c1","html":"<p>x</p>","actions":[],
            "viewport":{"width":320,"height":420,"input":"touch"}
        })).unwrap();
        assert_eq!(touch.environment().unwrap(), PreviewViewport {
            width: 320,
            height: 420,
            input: PreviewInput::Touch,
        });
    }

    #[test]
    fn conflicting_or_out_of_range_dimensions_are_rejected() {
        let conflict: PreviewRequest = serde_json::from_value(serde_json::json!({
            "candidate_id":"c1","html":"<p>x</p>","actions":[],"width":340,
            "viewport":{"width":320,"height":420,"input":"touch"}
        })).unwrap();
        assert!(conflict.environment().unwrap_err().contains("both"));

        let short: PreviewRequest = serde_json::from_value(serde_json::json!({
            "candidate_id":"c1","html":"<p>x</p>","actions":[],
            "viewport":{"width":320,"height":159,"input":"touch"}
        })).unwrap();
        assert!(short.environment().unwrap_err().contains("height"));
    }
}
