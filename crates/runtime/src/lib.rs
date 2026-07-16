//! 模块 E 自建最小运行时。`book.query` 使用 referent-first typed mini-loop；
//! `book.synthesize` 与其他工具保留各自明确的证据所有权。
use base_schema::{GraphNodeType, LidNode, NodeKind};
use memory::{BookReadingState, EngagementSignals};
use read_tools::{
    fair_candidate_quotas, Book, CatalogRecallStrength, CatalogReferentKind, CatalogReferentSource,
    Frontier, NavCategory, RankedStep, ReferentCandidate, ToolError,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use ts_rs::TS;

pub mod goldset;
pub mod memory_intent;
pub mod memory_policy;
pub mod memory_review;
pub mod orchestrator;
pub mod profile_api;
pub mod profile_context;

/// 证据集:lid → 真原文(BTreeMap 保证确定性顺序)。
pub type EvidenceSet = BTreeMap<String, String>;

/// LLM 合一轮的归一化产出(ModelAdapter 出)`[ADR-0016]`。lid 待确定性校验。
#[derive(Debug, Clone)]
pub struct ParsedResponse {
    pub sufficient: bool,
    pub answer: Option<String>,
    pub citations: Vec<RawCitation>,
    pub model_supplement: Vec<Supplement>,
}

#[derive(Debug, Clone)]
pub struct RawCitation {
    pub lid: String,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Clone)]
pub struct Supplement {
    pub text: String,
}

/// 喂给后端的请求(provider 无关)。
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub system: String,
    pub user: String,
}

#[derive(Debug)]
pub struct AdapterError {
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderMode {
    Native,
    ReAct,
}

impl ProviderMode {
    fn parse(s: &str) -> Result<ProviderMode, AdapterError> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "native" | "openai" | "openai-native" => Ok(ProviderMode::Native),
            "react" | "react-adapter" | "openai-react" => Ok(ProviderMode::ReAct),
            other => Err(AdapterError {
                message: format!("未知 UNDERSTAND_BOOK_PROVIDER={other};支持 native / react"),
            }),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderMode::Native => "native",
            ProviderMode::ReAct => "react",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub mode: ProviderMode,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl ProviderConfig {
    pub fn from_values(
        mode: &str,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<ProviderConfig, AdapterError> {
        let mode = ProviderMode::parse(mode)?;
        let api_key = api_key.into().trim().to_string();
        let base_url = base_url.into().trim().trim_end_matches('/').to_string();
        let model = model.into().trim().to_string();
        if api_key.is_empty() {
            return Err(AdapterError {
                message: "Provider API Key 不能为空".into(),
            });
        }
        if model.is_empty() {
            return Err(AdapterError {
                message: "Provider Model 不能为空".into(),
            });
        }
        let parsed = url::Url::parse(&base_url).map_err(|error| AdapterError {
            message: format!("Provider Base URL 非法:{error}"),
        })?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(AdapterError {
                message: "Provider Base URL 必须是带主机名的 http/https URL".into(),
            });
        }
        Ok(ProviderConfig {
            mode,
            api_key,
            base_url,
            model,
        })
    }

    fn from_getter<F>(mut get: F) -> Result<ProviderConfig, AdapterError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let required = |k: &str, get: &mut F| {
            get(k).ok_or_else(|| AdapterError {
                message: format!("缺少环境变量 {k}(填 .env 或 export)"),
            })
        };
        ProviderConfig::from_values(
            &get("UNDERSTAND_BOOK_PROVIDER").unwrap_or_else(|| "native".into()),
            required("OPENCODE_API_KEY", &mut get)?,
            required("OPENCODE_BASE_URL", &mut get)?,
            required("FLUID_LLM_MODEL", &mut get)?,
        )
    }

    pub fn from_env() -> Result<ProviderConfig, AdapterError> {
        dotenvy::dotenv().ok();
        ProviderConfig::from_getter(|k| std::env::var(k).ok())
    }
}

pub struct ProviderRegistry;

impl ProviderRegistry {
    pub fn adapter_from_env() -> Result<Box<dyn ModelAdapter + Send>, AdapterError> {
        let cfg = ProviderConfig::from_env()?;
        Ok(Self::adapter_from_config(cfg))
    }

    pub fn adapter_from_config(cfg: ProviderConfig) -> Box<dyn ModelAdapter + Send> {
        match cfg.mode {
            ProviderMode::Native => Box::new(NativeAdapter::from_config(cfg)),
            ProviderMode::ReAct => Box::new(ReActAdapter::from_config(cfg)),
        }
    }

    pub fn adapter_from_config_with_timeout(
        cfg: ProviderConfig,
        timeout: std::time::Duration,
    ) -> Box<dyn ModelAdapter + Send> {
        match cfg.mode {
            ProviderMode::Native => Box::new(NativeAdapter::from_config_with_timeout(cfg, timeout)),
            ProviderMode::ReAct => Box::new(ReActAdapter::from_config_with_timeout(cfg, timeout)),
        }
    }
}

/// 外层 loop 会话消息角色(OpenAI-兼容)`[ADR-0026]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// 外层 loop 的一条会话消息 `[ADR-0026]`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Option<String>,
    /// assistant 回合请求的工具调用(其余角色为空)。
    pub tool_calls: Vec<ToolCall>,
    /// tool 角色:配对的 assistant tool_call id。
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Message {
        Message {
            role: Role::System,
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
    pub fn user(content: impl Into<String>) -> Message {
        Message {
            role: Role::User,
            content: Some(content.into()),
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
}

/// 模型请求的一次工具调用(arguments = OpenAI 风格的 JSON 字符串)`[ADR-0026]`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 暴露给模型的工具规格(name + 描述 + JSON-Schema 参数)`[ADR-0026]`。
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// 外层 chat 回合的归一化产出 `[ADR-0026]`:文本(终答)或工具调用,二选一/可并存;usage 供停机口径。
#[derive(Debug, Clone)]
pub struct AssistantTurn {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage_total_tokens: Option<u32>,
}

/// loop 与后端之间的薄层 `[ADR-0016/0026]`;loop 控制 provider 无关,只经此触模型。
/// `complete` = 内层 query 合一轮(JSON 契约);`chat` = 外层多轮 tool-calling。
pub trait ModelAdapter {
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError>;
    /// Provider-neutral structured completion for bounded build-time judgments.
    /// Native providers override this to request a JSON object directly. The
    /// default keeps test/legacy adapters usable by parsing `complete().answer`.
    fn complete_structured(
        &self,
        req: CompletionRequest,
    ) -> Result<serde_json::Value, AdapterError> {
        let response = self.complete(req)?;
        let answer = response.answer.ok_or_else(|| AdapterError {
            message: "结构化模型响应缺 answer".into(),
        })?;
        structured_json_from_content(&answer)
    }
    fn chat(&self, messages: &[Message], tools: &[ToolSpec])
        -> Result<AssistantTurn, AdapterError>;
}

/// Message → OpenAI 请求体 JSON(assistant tool_calls / tool 结果按 OpenAI 形拼)。
fn message_to_json(m: &Message) -> serde_json::Value {
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut o = serde_json::json!({ "role": role });
    match &m.content {
        Some(c) => o["content"] = serde_json::json!(c),
        None if m.role == Role::Assistant => o["content"] = serde_json::Value::Null,
        None => {}
    }
    if !m.tool_calls.is_empty() {
        o["tool_calls"] = serde_json::Value::Array(
            m.tool_calls
                .iter()
                .map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": tc.name, "arguments": tc.arguments },
                    })
                })
                .collect(),
        );
    }
    if let Some(id) = &m.tool_call_id {
        o["tool_call_id"] = serde_json::json!(id);
    }
    o
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct Citation {
    pub lid: String,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SupplementOut {
    pub text: String,
    pub source: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum BookQueryIntent {
    Definition,
    Explanation,
    Relation,
    Comparison,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryObligation {
    pub requirement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookQueryRequest {
    pub query: String,
    pub intent: BookQueryIntent,
    pub targets: Vec<String>,
    pub obligations: Vec<QueryObligation>,
    pub anchor_lid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueryBudgets {
    pub version: String,
    pub candidate_top_k_total: usize,
    pub max_search_probes: usize,
    pub retry_rounds: usize,
    pub max_seeds_per_target: usize,
    pub max_evidence_lids_total: usize,
    pub max_evidence_chars_total: usize,
    pub max_expansion_rounds: usize,
    pub max_joint_evidence_lids: usize,
    pub mandatory_overflow_lids: usize,
}

impl Default for QueryBudgets {
    fn default() -> Self {
        Self {
            version: "referent-first-v1".into(),
            candidate_top_k_total: 12,
            max_search_probes: 3,
            retry_rounds: 1,
            max_seeds_per_target: 3,
            max_evidence_lids_total: 12,
            max_evidence_chars_total: 16_000,
            max_expansion_rounds: 1,
            max_joint_evidence_lids: 3,
            mandatory_overflow_lids: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryPlanGateAudit {
    pub valid: bool,
    pub missing_requirements: Vec<String>,
    pub target_issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryTargetCandidatesAudit {
    pub target_index: usize,
    pub target: String,
    pub candidates: Vec<CandidatePreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryCandidateRoundAudit {
    pub round: usize,
    pub targets: Vec<QueryTargetCandidatesAudit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryCandidateFitAudit {
    pub round: usize,
    pub target_index: usize,
    pub candidate_id: String,
    pub fit: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QuerySelectedBindingAudit {
    pub target_index: usize,
    pub candidate_id: String,
    pub round: usize,
    pub rank: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryEvidenceAudit {
    pub seed_lids: Vec<String>,
    pub expansion_lids: Vec<String>,
    #[serde(default)]
    pub expansion_rounds: usize,
    pub skipped_lids: Vec<String>,
    pub chars_used: usize,
    pub mandatory_overflow_used: usize,
    #[serde(default)]
    pub mandatory_overflow_reasons: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryStructuralGateAudit {
    pub bindings_complete: bool,
    pub assessments_complete: bool,
    pub citations_valid: bool,
    pub all_obligations_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryAudit {
    pub budget_version: String,
    #[serde(default)]
    pub model_calls: usize,
    pub request: BookQueryRequest,
    pub plan_gate: QueryPlanGateAudit,
    pub candidate_rounds: Vec<QueryCandidateRoundAudit>,
    pub candidate_fits: Vec<QueryCandidateFitAudit>,
    pub probes: Vec<String>,
    pub bindings: Vec<ReferentBinding>,
    #[serde(default)]
    pub selected_bindings: Vec<QuerySelectedBindingAudit>,
    pub evidence: QueryEvidenceAudit,
    pub assessments: Vec<SupportAssessment>,
    pub structural_gate: QueryStructuralGateAudit,
    pub outcome_status: String,
}

impl QueryAudit {
    fn new(request: &BookQueryRequest, budgets: &QueryBudgets) -> Self {
        Self {
            budget_version: budgets.version.clone(),
            model_calls: 0,
            request: request.clone(),
            plan_gate: QueryPlanGateAudit {
                valid: false,
                missing_requirements: Vec::new(),
                target_issues: Vec::new(),
            },
            candidate_rounds: Vec::new(),
            candidate_fits: Vec::new(),
            probes: Vec::new(),
            bindings: Vec::new(),
            selected_bindings: Vec::new(),
            evidence: QueryEvidenceAudit::default(),
            assessments: Vec::new(),
            structural_gate: QueryStructuralGateAudit::default(),
            outcome_status: "pending".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryRun {
    pub response: QueryOutcome,
    pub audit: QueryAudit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ReferentKind {
    Concept,
    Entity,
    PaperTerm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum ReferentSource {
    Graph,
    PaperLexicon,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum RecallStrength {
    None,
    ContextOnly,
    Approximate,
    Direct,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct CandidateExcerpt {
    pub lid: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct CandidateHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acronym_expansion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chinese_gloss: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct CandidatePreview {
    pub candidate_id: String,
    pub kind: ReferentKind,
    pub sources: Vec<ReferentSource>,
    pub labels: Vec<String>,
    pub aliases: Vec<String>,
    pub recall_strength: RecallStrength,
    pub match_reasons: Vec<String>,
    pub occurrence_count: usize,
    pub excerpts: Vec<CandidateExcerpt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint_only: Option<CandidateHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct ReferentBinding {
    pub target: String,
    pub candidate_id: String,
    pub kind: ReferentKind,
    pub canonical_label: String,
    pub source_lids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum SupportVerdict {
    Supported,
    Uncertain,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SupportAssessment {
    pub obligation_index: usize,
    pub verdict: SupportVerdict,
    pub citation_lids: Vec<String>,
    pub support_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum QueryOutcome {
    Complete {
        answer: Option<String>,
        citations: Vec<Citation>,
        bindings: Vec<ReferentBinding>,
        support: Vec<SupportAssessment>,
        model_supplement: Vec<SupplementOut>,
    },
    Partial {
        answer: Option<String>,
        citations: Vec<Citation>,
        bindings: Vec<ReferentBinding>,
        support: Vec<SupportAssessment>,
        model_supplement: Vec<SupplementOut>,
    },
    Insufficient {
        answer: Option<String>,
        citations: Vec<Citation>,
        bindings: Vec<ReferentBinding>,
        support: Vec<SupportAssessment>,
        model_supplement: Vec<SupplementOut>,
    },
    InvalidPlan {
        missing_requirements: Vec<String>,
        target_issues: Vec<String>,
    },
    Ambiguous {
        target: String,
        candidates: Vec<CandidatePreview>,
    },
    Unresolved {
        target: String,
    },
}

pub fn validate_book_query_request(request: &BookQueryRequest) -> Result<(), QueryOutcome> {
    let mut missing_requirements = Vec::new();
    let mut target_issues = Vec::new();
    if request.query.trim().is_empty() {
        missing_requirements.push("query".into());
    }
    if request.anchor_lid.trim().is_empty() {
        missing_requirements.push("anchor_lid".into());
    }
    if request.targets.is_empty() {
        missing_requirements.push("targets".into());
    }
    if request.obligations.is_empty() {
        missing_requirements.push("obligations".into());
    }

    let target_range = match request.intent {
        BookQueryIntent::Definition | BookQueryIntent::Explanation => 1..=3,
        BookQueryIntent::Relation | BookQueryIntent::Comparison => 2..=3,
    };
    if !request.targets.is_empty() && !target_range.contains(&request.targets.len()) {
        target_issues.push(format!(
            "intent {:?} requires {} targets",
            request.intent,
            if matches!(
                request.intent,
                BookQueryIntent::Definition | BookQueryIntent::Explanation
            ) {
                "1..3"
            } else {
                "2..3"
            }
        ));
    }
    if request
        .targets
        .iter()
        .any(|target| target.trim().is_empty())
    {
        target_issues.push("targets must not contain empty items".into());
    }
    let unique_targets: HashSet<String> = request
        .targets
        .iter()
        .map(|target| target.trim().to_lowercase())
        .collect();
    if unique_targets.len() != request.targets.len() {
        target_issues.push("targets must be unique".into());
    }
    if request.obligations.len() > 3 {
        missing_requirements.push("obligations must contain 1..3 items".into());
    }
    if request
        .obligations
        .iter()
        .any(|obligation| obligation.requirement.trim().is_empty())
    {
        missing_requirements.push("obligations must not contain empty requirements".into());
    }

    if missing_requirements.is_empty() && target_issues.is_empty() {
        Ok(())
    } else {
        Err(QueryOutcome::InvalidPlan {
            missing_requirements,
            target_issues,
        })
    }
}

pub fn parse_book_query_request(
    value: serde_json::Value,
) -> Result<BookQueryRequest, QueryOutcome> {
    let request = serde_json::from_value::<BookQueryRequest>(value).map_err(|error| {
        QueryOutcome::InvalidPlan {
            missing_requirements: vec![error.to_string()],
            target_issues: Vec::new(),
        }
    })?;
    validate_book_query_request(&request)?;
    Ok(request)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CandidateFit {
    DirectMatch,
    SemanticMatch,
    Plausible,
    Reject,
}

impl CandidateFit {
    fn is_strong(self) -> bool {
        matches!(
            self,
            CandidateFit::DirectMatch | CandidateFit::SemanticMatch
        )
    }

    fn is_viable(self) -> bool {
        self != CandidateFit::Reject
    }

    fn as_str(self) -> &'static str {
        match self {
            CandidateFit::DirectMatch => "direct_match",
            CandidateFit::SemanticMatch => "semantic_match",
            CandidateFit::Plausible => "plausible",
            CandidateFit::Reject => "reject",
        }
    }
}

#[derive(Debug, Deserialize)]
struct PlanGateJudgment {
    valid: bool,
    #[serde(default)]
    missing_requirements: Vec<String>,
    #[serde(default)]
    target_issues: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CandidateFitJudgment {
    target_index: usize,
    candidate_id: String,
    fit: CandidateFit,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize)]
struct LexicalProbe {
    target_index: usize,
    query: String,
}

#[derive(Debug, Deserialize)]
struct ResolverJudgment {
    plan_gate: PlanGateJudgment,
    #[serde(default)]
    candidate_fits: Vec<CandidateFitJudgment>,
    #[serde(default)]
    probes: Vec<LexicalProbe>,
}

#[derive(Debug, Clone)]
struct TargetCandidateGroup {
    target_index: usize,
    target: String,
    quota: usize,
    candidates: Vec<ReferentCandidate>,
}

#[derive(Debug, Clone)]
struct ResolvedReferent {
    binding: ReferentBinding,
    target_index: usize,
    round: usize,
    selected_rank: usize,
}

struct ResolutionFailure {
    outcome: Box<QueryOutcome>,
    unresolved_targets: HashSet<usize>,
}

enum ResolutionStage {
    Resolved(Vec<ResolvedReferent>),
    Terminal(QueryOutcome),
}

fn referent_kind(kind: CatalogReferentKind) -> ReferentKind {
    match kind {
        CatalogReferentKind::Concept => ReferentKind::Concept,
        CatalogReferentKind::Entity => ReferentKind::Entity,
        CatalogReferentKind::PaperTerm => ReferentKind::PaperTerm,
    }
}

fn referent_source(source: CatalogReferentSource) -> ReferentSource {
    match source {
        CatalogReferentSource::Graph => ReferentSource::Graph,
        CatalogReferentSource::PaperLexicon => ReferentSource::PaperLexicon,
    }
}

fn recall_strength(strength: CatalogRecallStrength) -> RecallStrength {
    match strength {
        CatalogRecallStrength::None => RecallStrength::None,
        CatalogRecallStrength::ContextOnly => RecallStrength::ContextOnly,
        CatalogRecallStrength::Approximate => RecallStrength::Approximate,
        CatalogRecallStrength::Direct => RecallStrength::Direct,
    }
}

fn candidate_preview(candidate: &ReferentCandidate) -> CandidatePreview {
    CandidatePreview {
        candidate_id: candidate.candidate_id.clone(),
        kind: referent_kind(candidate.kind),
        sources: candidate
            .sources
            .iter()
            .copied()
            .map(referent_source)
            .collect(),
        labels: candidate.labels.clone(),
        aliases: candidate.aliases.clone(),
        recall_strength: recall_strength(candidate.recall_strength),
        match_reasons: candidate.match_reasons.clone(),
        occurrence_count: candidate.occurrence_lids.len(),
        excerpts: candidate
            .excerpts
            .iter()
            .map(|excerpt| CandidateExcerpt {
                lid: excerpt.lid.clone(),
                text: excerpt.text.clone(),
            })
            .collect(),
        hint_only: candidate.hint_only.as_ref().map(|hint| CandidateHint {
            acronym_expansion: hint.acronym_expansion.clone(),
            chinese_gloss: hint.chinese_gloss.clone(),
        }),
    }
}

fn query_candidate_groups(
    book: &Book,
    request: &BookQueryRequest,
    budgets: &QueryBudgets,
) -> Result<Vec<TargetCandidateGroup>, ToolError> {
    let quotas = fair_candidate_quotas(request.targets.len(), budgets.candidate_top_k_total);
    let catalog = book.referent_catalog(&request.anchor_lid)?;
    Ok(request
        .targets
        .iter()
        .enumerate()
        .map(|(target_index, target)| TargetCandidateGroup {
            target_index,
            target: target.clone(),
            quota: quotas[target_index],
            candidates: catalog.search(target, quotas[target_index]),
        })
        .collect())
}

fn resolver_prompt(
    request: &BookQueryRequest,
    groups: &[TargetCandidateGroup],
) -> CompletionRequest {
    let candidates: Vec<serde_json::Value> = groups
        .iter()
        .map(|group| {
            serde_json::json!({
                "target_index": group.target_index,
                "target": group.target,
                "candidates": group.candidates.iter().map(candidate_preview).collect::<Vec<_>>()
            })
        })
        .collect();
    CompletionRequest {
        system: "You are the bounded PlanGate and referent resolver. Return one JSON object. Check that query, targets, and obligations preserve the same request. Classify every candidate as direct_match, semantic_match, plausible, or reject. Do not infer from anchor-neighbor text. If lexical recall failed, emit at most three short lexical probes total. Reasons must be short verdict summaries, never hidden chain-of-thought.".into(),
        user: serde_json::json!({
            "request": request,
            "candidate_groups": candidates,
            "response_schema": {
                "plan_gate": {"valid": true, "missing_requirements": [], "target_issues": []},
                "candidate_fits": [{"target_index": 0, "candidate_id": "id", "fit": "direct_match", "reason": "short"}],
                "probes": [{"target_index": 0, "query": "lexical probe"}]
            }
        })
        .to_string(),
    }
}

fn resolver_judgment(
    request: &BookQueryRequest,
    groups: &[TargetCandidateGroup],
    adapter: &dyn ModelAdapter,
) -> Result<ResolverJudgment, ToolError> {
    let value = adapter
        .complete_structured(resolver_prompt(request, groups))
        .map_err(|error| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: error.message,
        })?;
    serde_json::from_value(value).map_err(|error| ToolError {
        error_code: "QUERY_RESOLVER_PROTOCOL_ERROR".into(),
        category: "provider".into(),
        message: format!("query resolver response invalid: {error}"),
    })
}

fn record_candidate_round(audit: &mut QueryAudit, round: usize, groups: &[TargetCandidateGroup]) {
    audit.candidate_rounds.push(QueryCandidateRoundAudit {
        round,
        targets: groups
            .iter()
            .map(|group| QueryTargetCandidatesAudit {
                target_index: group.target_index,
                target: group.target.clone(),
                candidates: group.candidates.iter().map(candidate_preview).collect(),
            })
            .collect(),
    });
}

fn record_resolver_judgment(audit: &mut QueryAudit, round: usize, judgment: &ResolverJudgment) {
    audit.model_calls += 1;
    audit.plan_gate = QueryPlanGateAudit {
        valid: judgment.plan_gate.valid,
        missing_requirements: judgment.plan_gate.missing_requirements.clone(),
        target_issues: judgment.plan_gate.target_issues.clone(),
    };
    audit.candidate_fits.extend(
        judgment
            .candidate_fits
            .iter()
            .map(|fit| QueryCandidateFitAudit {
                round,
                target_index: fit.target_index,
                candidate_id: fit.candidate_id.clone(),
                fit: fit.fit.as_str().into(),
                reason: fit.reason.clone(),
            }),
    );
}

fn sort_referent_candidates(candidates: &mut [ReferentCandidate]) {
    candidates.sort_by(|left, right| {
        right
            .recall_strength
            .cmp(&left.recall_strength)
            .then_with(|| right.lexical_score.cmp(&left.lexical_score))
            .then_with(|| left.anchor_distance.cmp(&right.anchor_distance))
            .then_with(|| left.candidate_id.cmp(&right.candidate_id))
    });
}

fn replacement_groups(
    book: &Book,
    request: &BookQueryRequest,
    groups: &[TargetCandidateGroup],
    unresolved_targets: &HashSet<usize>,
    probes: &[LexicalProbe],
    budgets: &QueryBudgets,
) -> Result<Option<Vec<TargetCandidateGroup>>, ToolError> {
    let catalog = book.referent_catalog(&request.anchor_lid)?;
    let mut replacement = groups.to_vec();
    let mut used_any = false;
    for group in &mut replacement {
        if !unresolved_targets.contains(&group.target_index) {
            continue;
        }
        let target_probes: Vec<&str> = probes
            .iter()
            .filter(|probe| probe.target_index == group.target_index)
            .map(|probe| probe.query.trim())
            .filter(|probe| !probe.is_empty())
            .take(budgets.max_search_probes)
            .collect();
        if target_probes.is_empty() {
            continue;
        }
        used_any = true;
        let mut by_id = BTreeMap::new();
        for probe in target_probes {
            for candidate in catalog.search(probe, group.quota) {
                by_id
                    .entry(candidate.candidate_id.clone())
                    .or_insert(candidate);
            }
        }
        group.candidates = by_id.into_values().collect();
        sort_referent_candidates(&mut group.candidates);
        group.candidates.truncate(group.quota);
    }
    Ok(used_any.then_some(replacement))
}

fn lid_anchor_distance(book: &Book, anchor_lid: &str, lid: &str) -> usize {
    let anchor_index = book
        .base
        .lid_nodes
        .iter()
        .position(|node| node.lid == anchor_lid);
    let lid_index = book.base.lid_nodes.iter().position(|node| node.lid == lid);
    anchor_index
        .zip(lid_index)
        .map(|(anchor, current)| anchor.abs_diff(current))
        .unwrap_or(usize::MAX)
}

fn ordered_source_lids(
    book: &Book,
    anchor_lid: &str,
    candidate: &ReferentCandidate,
) -> Vec<String> {
    let mut lids = candidate.occurrence_lids.clone();
    if let Some(defined_at) = &candidate.defined_at_lid {
        if !lids.contains(defined_at) {
            lids.push(defined_at.clone());
        }
    }
    lids.sort_by(|left, right| {
        let left_defined = candidate.defined_at_lid.as_ref() == Some(left);
        let right_defined = candidate.defined_at_lid.as_ref() == Some(right);
        right_defined
            .cmp(&left_defined)
            .then_with(|| {
                lid_anchor_distance(book, anchor_lid, left)
                    .cmp(&lid_anchor_distance(book, anchor_lid, right))
            })
            .then_with(|| left.cmp(right))
    });
    lids.dedup();
    lids
}

fn aggregate_resolution(
    book: &Book,
    anchor_lid: &str,
    groups: &[TargetCandidateGroup],
    judgment: &ResolverJudgment,
    round: usize,
) -> Result<Vec<ResolvedReferent>, ResolutionFailure> {
    if !judgment.plan_gate.valid {
        return Err(ResolutionFailure {
            outcome: Box::new(QueryOutcome::InvalidPlan {
                missing_requirements: judgment.plan_gate.missing_requirements.clone(),
                target_issues: judgment.plan_gate.target_issues.clone(),
            }),
            unresolved_targets: HashSet::new(),
        });
    }
    let mut resolved = Vec::new();
    let mut unresolved_targets = HashSet::new();
    for group in groups {
        let fits: BTreeMap<&str, (&CandidateFit, &str)> = judgment
            .candidate_fits
            .iter()
            .filter(|fit| fit.target_index == group.target_index)
            .map(|fit| (fit.candidate_id.as_str(), (&fit.fit, fit.reason.as_str())))
            .collect();
        let omitted = group
            .candidates
            .iter()
            .any(|candidate| !fits.contains_key(candidate.candidate_id.as_str()));
        let viable: Vec<&ReferentCandidate> = group
            .candidates
            .iter()
            .filter(|candidate| {
                fits.get(candidate.candidate_id.as_str())
                    .is_some_and(|(fit, _)| fit.is_viable())
            })
            .collect();
        if viable.len() > 1 {
            return Err(ResolutionFailure {
                outcome: Box::new(QueryOutcome::Ambiguous {
                    target: group.target.clone(),
                    candidates: viable.into_iter().map(candidate_preview).collect(),
                }),
                unresolved_targets: HashSet::new(),
            });
        }
        let Some(candidate) = viable.first().copied() else {
            unresolved_targets.insert(group.target_index);
            continue;
        };
        let fit = *fits[candidate.candidate_id.as_str()].0;
        if omitted || !fit.is_strong() {
            unresolved_targets.insert(group.target_index);
            continue;
        }
        let source_lids = ordered_source_lids(book, anchor_lid, candidate);
        resolved.push(ResolvedReferent {
            binding: ReferentBinding {
                target: group.target.clone(),
                candidate_id: candidate.candidate_id.clone(),
                kind: referent_kind(candidate.kind),
                canonical_label: candidate
                    .labels
                    .first()
                    .cloned()
                    .unwrap_or_else(|| candidate.candidate_id.clone()),
                source_lids,
            },
            target_index: group.target_index,
            round,
            selected_rank: group
                .candidates
                .iter()
                .position(|item| item.candidate_id == candidate.candidate_id)
                .map(|index| index + 1)
                .unwrap_or(0),
        });
    }
    if unresolved_targets.is_empty() {
        Ok(resolved)
    } else {
        let target_index = *unresolved_targets.iter().min().unwrap();
        Err(ResolutionFailure {
            outcome: Box::new(QueryOutcome::Unresolved {
                target: groups[target_index].target.clone(),
            }),
            unresolved_targets,
        })
    }
}

fn resolve_referents(
    book: &Book,
    request: &BookQueryRequest,
    adapter: &dyn ModelAdapter,
    budgets: &QueryBudgets,
    audit: &mut QueryAudit,
) -> Result<ResolutionStage, ToolError> {
    if let Err(outcome) = validate_book_query_request(request) {
        if let QueryOutcome::InvalidPlan {
            missing_requirements,
            target_issues,
        } = &outcome
        {
            audit.plan_gate = QueryPlanGateAudit {
                valid: false,
                missing_requirements: missing_requirements.clone(),
                target_issues: target_issues.clone(),
            };
        }
        return Ok(ResolutionStage::Terminal(outcome));
    }
    let groups = query_candidate_groups(book, request, budgets)?;
    record_candidate_round(audit, 0, &groups);
    let first = resolver_judgment(request, &groups, adapter)?;
    record_resolver_judgment(audit, 0, &first);
    match aggregate_resolution(book, &request.anchor_lid, &groups, &first, 0) {
        Ok(resolved) => Ok(ResolutionStage::Resolved(resolved)),
        Err(failure)
            if matches!(
                failure.outcome.as_ref(),
                QueryOutcome::Ambiguous { .. } | QueryOutcome::InvalidPlan { .. }
            ) =>
        {
            Ok(ResolutionStage::Terminal(*failure.outcome))
        }
        Err(failure) => {
            let outcome = *failure.outcome;
            let unresolved_targets = failure.unresolved_targets;
            let probes: Vec<LexicalProbe> = first
                .probes
                .into_iter()
                .take(budgets.max_search_probes)
                .collect();
            audit.probes = probes.iter().map(|probe| probe.query.clone()).collect();
            if budgets.retry_rounds == 0 {
                return Ok(ResolutionStage::Terminal(outcome));
            }
            let Some(replacement) = replacement_groups(
                book,
                request,
                &groups,
                &unresolved_targets,
                &probes,
                budgets,
            )?
            else {
                return Ok(ResolutionStage::Terminal(outcome));
            };
            record_candidate_round(audit, 1, &replacement);
            let second = resolver_judgment(request, &replacement, adapter)?;
            record_resolver_judgment(audit, 1, &second);
            Ok(
                match aggregate_resolution(book, &request.anchor_lid, &replacement, &second, 1) {
                    Ok(resolved) => ResolutionStage::Resolved(resolved),
                    Err(failure) => ResolutionStage::Terminal(*failure.outcome),
                },
            )
        }
    }
}

#[derive(Debug, Clone, Default)]
struct QueryEvidenceBundle {
    texts: EvidenceSet,
    seed_lids: Vec<String>,
    expansion_lids: Vec<String>,
    expansion_rounds: usize,
    skipped_lids: Vec<String>,
    chars_used: usize,
    mandatory_overflow_used: usize,
    mandatory_overflow_reasons: Vec<String>,
}

impl QueryEvidenceBundle {
    fn add_lid(
        &mut self,
        book: &Book,
        lid: &str,
        budgets: &QueryBudgets,
        expansion: bool,
        mandatory: bool,
    ) -> Result<bool, ToolError> {
        if self.texts.contains_key(lid) {
            return Ok(false);
        }
        let text = book.text(lid, None)?;
        let chars = text.chars().count();
        let within_budget = self.texts.len() < budgets.max_evidence_lids_total
            && self.chars_used.saturating_add(chars) <= budgets.max_evidence_chars_total;
        let overflow = !within_budget
            && mandatory
            && self.mandatory_overflow_used < budgets.mandatory_overflow_lids;
        if !within_budget && !overflow {
            if !self.skipped_lids.iter().any(|skipped| skipped == lid) {
                self.skipped_lids.push(lid.into());
            }
            return Ok(false);
        }
        if overflow {
            self.mandatory_overflow_used += 1;
            self.mandatory_overflow_reasons.push(format!(
                "mandatory source LID {lid} exceeded the evidence LID or character budget"
            ));
        }
        self.chars_used = self.chars_used.saturating_add(chars);
        self.texts.insert(lid.into(), text);
        if expansion {
            self.expansion_lids.push(lid.into());
        } else {
            self.seed_lids.push(lid.into());
        }
        Ok(true)
    }
}

fn build_initial_query_evidence(
    book: &Book,
    resolved: &[ResolvedReferent],
    budgets: &QueryBudgets,
) -> Result<QueryEvidenceBundle, ToolError> {
    let mut evidence = QueryEvidenceBundle::default();
    for referent in resolved {
        let mut added_for_target = 0usize;
        for lid in referent
            .binding
            .source_lids
            .iter()
            .take(budgets.max_seeds_per_target)
        {
            if evidence.add_lid(book, lid, budgets, false, added_for_target == 0)? {
                added_for_target += 1;
            }
        }
    }
    Ok(evidence)
}

fn push_unique_lid(lids: &mut Vec<String>, lid: &str) {
    if !lid.trim().is_empty() && !lids.iter().any(|item| item == lid) {
        lids.push(lid.into());
    }
}

fn related_landmark_lids(
    book: &Book,
    resolved: &[ResolvedReferent],
    anchor_lid: &str,
) -> Vec<String> {
    let mut related = Vec::new();
    let mut binding_source_lids = HashSet::new();
    for referent in resolved {
        binding_source_lids.extend(referent.binding.source_lids.iter().cloned());
        let graph_ids: HashSet<&str> = book
            .base
            .graph_nodes
            .iter()
            .filter(|node| {
                node.id == referent.binding.candidate_id
                    || (node
                        .name
                        .eq_ignore_ascii_case(&referent.binding.canonical_label)
                        && node
                            .source_lid
                            .iter()
                            .chain(node.occurrences.iter())
                            .any(|lid| referent.binding.source_lids.contains(lid)))
            })
            .map(|node| node.id.as_str())
            .collect();
        for edge in &book.base.graph_edges {
            let neighbor_id = if graph_ids.contains(edge.source.as_str()) {
                Some(edge.target.as_str())
            } else if graph_ids.contains(edge.target.as_str()) {
                Some(edge.source.as_str())
            } else {
                None
            };
            let Some(neighbor) =
                neighbor_id.and_then(|id| book.base.graph_nodes.iter().find(|node| node.id == id))
            else {
                continue;
            };
            if let Some(lid) = &neighbor.source_lid {
                push_unique_lid(&mut related, lid);
            }
            for lid in &neighbor.occurrences {
                push_unique_lid(&mut related, lid);
            }
        }

        for lid in &referent.binding.source_lids {
            if let Some(item) = book.discourse_item(lid) {
                for relation in &item.relations {
                    push_unique_lid(&mut related, &relation.target_lid);
                    for evidence_lid in &relation.evidence_lids {
                        push_unique_lid(&mut related, evidence_lid);
                    }
                }
            }
        }
    }

    let mut formula_seeds: Vec<String> = binding_source_lids.iter().cloned().collect();
    formula_seeds.extend(related.iter().cloned());
    formula_seeds.sort();
    formula_seeds.dedup();
    for lid in formula_seeds {
        let Some(semantics) = book.formula_semantics(&lid) else {
            continue;
        };
        push_unique_lid(&mut related, &semantics.composition.source_lid);
        for evidence_lid in &semantics.composition.evidence_lids {
            push_unique_lid(&mut related, evidence_lid);
        }
        for parameter in &semantics.parameters {
            for evidence_lid in &parameter.evidence_lids {
                push_unique_lid(&mut related, evidence_lid);
            }
        }
        for link in &semantics.context_links {
            push_unique_lid(&mut related, &link.target_lid);
            for evidence_lid in &link.evidence_lids {
                push_unique_lid(&mut related, evidence_lid);
            }
        }
    }

    related.retain(|lid| {
        !binding_source_lids.contains(lid)
            && book.base.lid_nodes.iter().any(|node| node.lid == *lid)
    });
    related.sort_by(|left, right| {
        lid_anchor_distance(book, anchor_lid, left)
            .cmp(&lid_anchor_distance(book, anchor_lid, right))
            .then_with(|| left.cmp(right))
    });
    related
}

fn targeted_expansion_lids(
    book: &Book,
    resolved: &[ResolvedReferent],
    budgets: &QueryBudgets,
    anchor_lid: &str,
) -> Vec<String> {
    let mut candidates = Vec::new();
    let max_sources = resolved
        .iter()
        .map(|referent| referent.binding.source_lids.len())
        .max()
        .unwrap_or(0);
    for index in budgets.max_seeds_per_target..max_sources {
        for referent in resolved {
            if let Some(lid) = referent.binding.source_lids.get(index) {
                push_unique_lid(&mut candidates, lid);
            }
        }
    }
    for lid in related_landmark_lids(book, resolved, anchor_lid) {
        push_unique_lid(&mut candidates, &lid);
    }
    candidates.truncate(budgets.max_joint_evidence_lids);
    candidates
}

fn expand_query_evidence(
    book: &Book,
    resolved: &[ResolvedReferent],
    anchor_lid: &str,
    budgets: &QueryBudgets,
    evidence: &mut QueryEvidenceBundle,
) -> Result<bool, ToolError> {
    let mut added = false;
    for lid in targeted_expansion_lids(book, resolved, budgets, anchor_lid) {
        added |= evidence.add_lid(book, &lid, budgets, true, false)?;
    }
    if added {
        evidence.expansion_rounds += 1;
    }
    Ok(added)
}

#[derive(Debug, Deserialize)]
struct ModelSupportCitation {
    lid: String,
    text: String,
    #[serde(default)]
    role: String,
}

#[derive(Debug, Deserialize)]
struct ModelSupportSupplement {
    text: String,
}

#[derive(Debug, Deserialize)]
struct ModelSupportResponse {
    answer: Option<String>,
    #[serde(default)]
    assessments: Vec<SupportAssessment>,
    #[serde(default)]
    citations: Vec<ModelSupportCitation>,
    #[serde(default)]
    model_supplement: Vec<ModelSupportSupplement>,
}

fn support_prompt(
    request: &BookQueryRequest,
    resolved: &[ResolvedReferent],
    evidence: &QueryEvidenceBundle,
) -> CompletionRequest {
    let bindings: Vec<&ReferentBinding> = resolved.iter().map(|item| &item.binding).collect();
    let source: Vec<serde_json::Value> = evidence
        .texts
        .iter()
        .map(|(lid, text)| serde_json::json!({"lid": lid, "text": text}))
        .collect();
    CompletionRequest {
        system: "Answer only from the full source LIDs supplied for frozen referent bindings. Assess every obligation exactly once as supported, uncertain, or unsupported. Each supported assessment must list citation_lids and citations must quote an exact nonempty substring of that source LID. Open semantic support is your judgment; do not expose hidden chain-of-thought. Put outside knowledge only in model_supplement.".into(),
        user: serde_json::json!({
            "request": request,
            "frozen_bindings": bindings,
            "source_evidence": source,
            "response_schema": {
                "answer": "answer or null",
                "assessments": [{
                    "obligation_index": 0,
                    "verdict": "supported",
                    "citation_lids": ["1.2"],
                    "support_note": "short verdict reason"
                }],
                "citations": [{"lid": "1.2", "text": "exact source quote", "role": "support"}],
                "model_supplement": [{"text": "optional outside knowledge"}]
            }
        })
        .to_string(),
    }
}

fn assess_query_support(
    request: &BookQueryRequest,
    resolved: &[ResolvedReferent],
    evidence: &QueryEvidenceBundle,
    adapter: &dyn ModelAdapter,
) -> Result<ModelSupportResponse, ToolError> {
    let value = adapter
        .complete_structured(support_prompt(request, resolved, evidence))
        .map_err(|error| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: error.message,
        })?;
    serde_json::from_value(value).map_err(|error| ToolError {
        error_code: "QUERY_SUPPORT_PROTOCOL_ERROR".into(),
        category: "provider".into(),
        message: format!("query support response invalid: {error}"),
    })
}

fn normalize_source_text(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

struct StructuralSupport {
    answer: Option<String>,
    assessments: Vec<SupportAssessment>,
    citations: Vec<Citation>,
    model_supplement: Vec<SupplementOut>,
    any_supported: bool,
    all_supported: bool,
    assessments_complete: bool,
    citations_valid: bool,
}

fn structural_support_gate(
    request: &BookQueryRequest,
    evidence: &QueryEvidenceBundle,
    response: ModelSupportResponse,
) -> StructuralSupport {
    let citation_count = response.citations.len();
    let valid_citations: Vec<Citation> = response
        .citations
        .into_iter()
        .filter_map(|citation| {
            let source = evidence.texts.get(&citation.lid)?;
            let quote = normalize_source_text(&citation.text);
            let valid = !quote.is_empty() && normalize_source_text(source).contains(&quote);
            valid.then_some(Citation {
                lid: citation.lid,
                text: citation.text,
                role: if citation.role.trim().is_empty() {
                    "support".into()
                } else {
                    citation.role
                },
            })
        })
        .collect();
    let mut citations_valid = valid_citations.len() == citation_count;
    let valid_lids: HashSet<&str> = valid_citations
        .iter()
        .map(|citation| citation.lid.as_str())
        .collect();
    let mut assessments = Vec::with_capacity(request.obligations.len());
    let mut assessments_complete = response
        .assessments
        .iter()
        .all(|assessment| assessment.obligation_index < request.obligations.len());
    for obligation_index in 0..request.obligations.len() {
        let matches: Vec<&SupportAssessment> = response
            .assessments
            .iter()
            .filter(|assessment| assessment.obligation_index == obligation_index)
            .collect();
        let mut assessment = if matches.len() == 1 {
            matches[0].clone()
        } else {
            assessments_complete = false;
            SupportAssessment {
                obligation_index,
                verdict: SupportVerdict::Unsupported,
                citation_lids: Vec::new(),
                support_note: "structural gate requires exactly one assessment".into(),
            }
        };
        if assessment.verdict == SupportVerdict::Supported
            && (assessment.citation_lids.is_empty()
                || assessment
                    .citation_lids
                    .iter()
                    .any(|lid| !valid_lids.contains(lid.as_str())))
        {
            citations_valid = false;
            assessment.verdict = SupportVerdict::Unsupported;
            assessment.support_note = "supported assessment lacks an exact source citation".into();
        }
        assessments.push(assessment);
    }
    let supported_lids: HashSet<&str> = assessments
        .iter()
        .filter(|assessment| assessment.verdict == SupportVerdict::Supported)
        .flat_map(|assessment| assessment.citation_lids.iter().map(String::as_str))
        .collect();
    let citations: Vec<Citation> = valid_citations
        .into_iter()
        .filter(|citation| supported_lids.contains(citation.lid.as_str()))
        .collect();
    let any_supported = assessments
        .iter()
        .any(|assessment| assessment.verdict == SupportVerdict::Supported);
    let obligations_supported = !assessments.is_empty()
        && assessments
            .iter()
            .all(|assessment| assessment.verdict == SupportVerdict::Supported);
    let all_supported = assessments_complete && citations_valid && obligations_supported;
    StructuralSupport {
        answer: response.answer,
        assessments,
        citations,
        model_supplement: response
            .model_supplement
            .into_iter()
            .map(|supplement| SupplementOut {
                text: supplement.text,
                source: "model".into(),
            })
            .collect(),
        any_supported,
        all_supported,
        assessments_complete,
        citations_valid,
    }
}

fn query_outcome_from_support(
    bindings: Vec<ReferentBinding>,
    support: StructuralSupport,
) -> QueryOutcome {
    let StructuralSupport {
        answer,
        assessments,
        citations,
        model_supplement,
        any_supported,
        all_supported,
        assessments_complete: _,
        citations_valid: _,
    } = support;
    if all_supported {
        QueryOutcome::Complete {
            answer,
            citations,
            bindings,
            support: assessments,
            model_supplement,
        }
    } else if any_supported {
        QueryOutcome::Partial {
            answer,
            citations,
            bindings,
            support: assessments,
            model_supplement,
        }
    } else {
        QueryOutcome::Insufficient {
            answer: None,
            citations,
            bindings,
            support: assessments,
            model_supplement,
        }
    }
}

fn query_outcome_status(outcome: &QueryOutcome) -> &'static str {
    match outcome {
        QueryOutcome::Complete { .. } => "complete",
        QueryOutcome::Partial { .. } => "partial",
        QueryOutcome::Insufficient { .. } => "insufficient",
        QueryOutcome::InvalidPlan { .. } => "invalid_plan",
        QueryOutcome::Ambiguous { .. } => "ambiguous",
        QueryOutcome::Unresolved { .. } => "unresolved",
    }
}

fn evidence_audit(evidence: &QueryEvidenceBundle) -> QueryEvidenceAudit {
    QueryEvidenceAudit {
        seed_lids: evidence.seed_lids.clone(),
        expansion_lids: evidence.expansion_lids.clone(),
        expansion_rounds: evidence.expansion_rounds,
        skipped_lids: evidence.skipped_lids.clone(),
        chars_used: evidence.chars_used,
        mandatory_overflow_used: evidence.mandatory_overflow_used,
        mandatory_overflow_reasons: evidence.mandatory_overflow_reasons.clone(),
    }
}

pub(crate) fn query_run_with_budgets(
    book: &Book,
    request: &BookQueryRequest,
    adapter: &dyn ModelAdapter,
    budgets: &QueryBudgets,
) -> Result<QueryRun, ToolError> {
    let mut audit = QueryAudit::new(request, budgets);
    let resolved = match resolve_referents(book, request, adapter, budgets, &mut audit)? {
        ResolutionStage::Terminal(outcome) => {
            audit.outcome_status = query_outcome_status(&outcome).into();
            return Ok(QueryRun {
                response: outcome,
                audit,
            });
        }
        ResolutionStage::Resolved(resolved) => resolved,
    };
    let bindings: Vec<ReferentBinding> = resolved
        .iter()
        .map(|referent| referent.binding.clone())
        .collect();
    audit.bindings = bindings.clone();
    audit.selected_bindings = resolved
        .iter()
        .map(|referent| QuerySelectedBindingAudit {
            target_index: referent.target_index,
            candidate_id: referent.binding.candidate_id.clone(),
            round: referent.round,
            rank: referent.selected_rank,
        })
        .collect();
    let mut evidence = build_initial_query_evidence(book, &resolved, budgets)?;
    if evidence.texts.is_empty() {
        let outcome = QueryOutcome::Insufficient {
            answer: None,
            citations: Vec::new(),
            bindings,
            support: Vec::new(),
            model_supplement: Vec::new(),
        };
        audit.evidence = evidence_audit(&evidence);
        audit.outcome_status = query_outcome_status(&outcome).into();
        return Ok(QueryRun {
            response: outcome,
            audit,
        });
    }
    let first = assess_query_support(request, &resolved, &evidence, adapter)?;
    audit.model_calls += 1;
    let mut structural = structural_support_gate(request, &evidence, first);
    if !structural.all_supported
        && budgets.max_expansion_rounds > 0
        && expand_query_evidence(book, &resolved, &request.anchor_lid, budgets, &mut evidence)?
    {
        let second = assess_query_support(request, &resolved, &evidence, adapter)?;
        audit.model_calls += 1;
        structural = structural_support_gate(request, &evidence, second);
    }
    audit.evidence = evidence_audit(&evidence);
    audit.assessments = structural.assessments.clone();
    audit.structural_gate = QueryStructuralGateAudit {
        bindings_complete: bindings.len() == request.targets.len(),
        assessments_complete: structural.assessments_complete,
        citations_valid: structural.citations_valid,
        all_obligations_supported: structural.all_supported,
    };
    let outcome = query_outcome_from_support(bindings, structural);
    audit.outcome_status = query_outcome_status(&outcome).into();
    Ok(QueryRun {
        response: outcome,
        audit,
    })
}

/// `book.synthesize` 对外响应:复用 query 的 answer/citations/model_supplement 骨架,
/// 但 echo 输入 `source_lids` 并标记是否走分批归并 `[ADR-0017/0033]`。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct SynthesizeResponse {
    pub answer: Option<String>,
    pub citations: Vec<Citation>,
    pub model_supplement: Vec<SupplementOut>,
    pub source_lids: Vec<String>,
    pub batched: bool,
    pub evidence_chain: Vec<String>,
    pub related_concepts: Vec<String>,
    pub suggested_probing: Vec<String>,
}
/// P7 `book_guide`: visitor-facing route guide input. The caller owns session
/// lifecycle and injects the ephemeral session context explicitly.
#[derive(Debug, Clone)]
pub struct BookGuideRequest {
    pub intent: String,
    pub anchor_lid: Option<String>,
}

/// Ephemeral visitor session projection consumed by `book_guide`.
/// This deliberately contains no reader viewport, no memory store, and no
/// reader_profile.
#[derive(Debug, Clone, Default)]
pub struct BookGuideSessionContext {
    pub cursor_at_lid: Option<String>,
    pub last_frontier: Vec<RankedStep>,
    pub transcript_tail: Vec<String>,
}

/// `book_guide` response: route first, prose second. Every route step is a
/// true `RankedStep` from Core route primitives; prose citations are filtered
/// against the supplied route evidence.
#[derive(Debug, Serialize)]
pub struct BookGuideResponse {
    pub intent: String,
    pub entry_lid: String,
    pub refined: bool,
    pub route: Vec<RankedStep>,
    pub frontier: Vec<RankedStep>,
    pub answer: Option<String>,
    pub citations: Vec<Citation>,
    pub model_supplement: Vec<SupplementOut>,
}
fn lid_node<'a>(book: &'a Book, lid: &str) -> Option<&'a LidNode> {
    book.base.lid_nodes.iter().find(|n| n.lid == lid)
}

const SYNTHESIZE_BATCH_TOKEN_LIMIT: usize = 80;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SynthesizeMode {
    Compare,
    Explain,
    Summarize,
    Derive,
    Teach,
    AnswerQuestion,
}

impl SynthesizeMode {
    fn from_task(task: Option<&str>) -> SynthesizeMode {
        let Some(task) = task else {
            return SynthesizeMode::Summarize;
        };
        let lower = task.to_ascii_lowercase();
        if task.contains("比较") || task.contains("对比") || lower.contains("compare") {
            SynthesizeMode::Compare
        } else if task.contains("推导")
            || task.contains("证明")
            || lower.contains("derive")
            || lower.contains("prove")
        {
            SynthesizeMode::Derive
        } else if task.contains("教") || task.contains("讲给") || lower.contains("teach") {
            SynthesizeMode::Teach
        } else if task.contains("解释") || task.contains("说明") || lower.contains("explain") {
            SynthesizeMode::Explain
        } else if task.contains("回答")
            || task.contains("问题")
            || lower.contains("answer")
            || lower.contains("question")
        {
            SynthesizeMode::AnswerQuestion
        } else {
            SynthesizeMode::Summarize
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SynthesizeMode::Compare => "compare",
            SynthesizeMode::Explain => "explain",
            SynthesizeMode::Summarize => "summarize",
            SynthesizeMode::Derive => "derive",
            SynthesizeMode::Teach => "teach",
            SynthesizeMode::AnswerQuestion => "answer_question",
        }
    }

    fn instruction(self) -> &'static str {
        match self {
            SynthesizeMode::Compare => "组织为相同点/差异点/适用边界,不要引入输入 LID 之外的证据。",
            SynthesizeMode::Explain => "优先给定义、机制、例子和限制,证据必须来自输入 LID。",
            SynthesizeMode::Summarize => "按章节/LID 顺序压缩主旨,保留关键限定条件。",
            SynthesizeMode::Derive => {
                "按原文证据给出逐步推导链,缺失步骤必须标为 model_supplement。"
            }
            SynthesizeMode::Teach => "用教学顺序组织解释,可补前置知识但不得把补充当 citation。",
            SynthesizeMode::AnswerQuestion => "直接回答问题,再列支撑证据和必要补充。",
        }
    }
}

fn estimate_tokens(s: &str) -> usize {
    let mut t = 0.0f32;
    for ch in s.chars() {
        t += if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            1.0
        } else {
            0.25
        };
    }
    t.ceil() as usize
}

fn formula_semantics_hint(book: &Book, lid: &str) -> Option<String> {
    let node = lid_node(book, lid)?;
    if !matches!(node.kind, NodeKind::Formula) {
        return None;
    }
    let Some(semantics) = book.formula_semantics(lid) else {
        return Some(format!(
            "[FormulaSemantics] formula_lid={lid}; optional_sidecar=not_attached; use formula text and surrounding supplied evidence only."
        ));
    };

    let mut lines = vec![format!("Formula {}", semantics.formula_lid)];
    lines.push(format!("Composition: {}", semantics.composition.meaning));
    if !semantics.composition.terms.is_empty() {
        lines.push(format!("Terms: {}", semantics.composition.terms.join("; ")));
    }
    if !semantics.parameters.is_empty() {
        lines.push("Parameters:".into());
        for p in &semantics.parameters {
            let label = p
                .label
                .as_ref()
                .map(|label| format!("{} ({label})", p.symbol))
                .unwrap_or_else(|| p.symbol.clone());
            let unit = p
                .unit
                .as_ref()
                .map(|u| format!(" unit={u}"))
                .unwrap_or_default();
            let domain = p
                .domain
                .as_ref()
                .map(|d| format!(" domain={d}"))
                .unwrap_or_default();
            lines.push(format!(
                "- {label}: {meaning}{unit}{domain} [{evidence}]",
                meaning = p.meaning,
                evidence = p.evidence_lids.join(", ")
            ));
        }
    }
    if !semantics.context_links.is_empty() {
        lines.push("Context links:".into());
        for link in &semantics.context_links {
            lines.push(format!(
                "- {relation} {target}: {description} [{evidence}]",
                relation = link.relation,
                target = link.target_lid,
                description = link.description,
                evidence = link.evidence_lids.join(", ")
            ));
        }
    }
    Some(lines.join("\n"))
}

fn discourse_hints(book: &Book, ev: &EvidenceSet) -> Vec<String> {
    let allowed: std::collections::BTreeSet<&str> = ev.keys().map(|lid| lid.as_str()).collect();
    let mut hints = Vec::new();
    for lid in ev.keys() {
        let Some(item) = book.discourse_item(lid) else {
            continue;
        };
        let mut lines = vec![format!("Discourse {}: mode={}", item.lid, item.mode)];
        if let Some(local_function) = &item.local_function {
            lines.push(format!("local_function={local_function}"));
        }
        if let Some(rhetorical_move) = &item.rhetorical_move {
            lines.push(format!("rhetorical_move={rhetorical_move}"));
        }
        if let Some(summary) = &item.local_summary {
            lines.push(format!("summary={summary}"));
        }
        let mut relation_lines = Vec::new();
        for r in &item.relations {
            let target_in_input = allowed.contains(r.target_lid.as_str());
            let evidence_in_input = r.evidence_lids.iter().all(|l| allowed.contains(l.as_str()));
            if target_in_input && evidence_in_input {
                relation_lines.push(format!(
                    "- {ty} -> {target} direction={direction} confidence={confidence:.2} evidence=[{evidence}]",
                    ty = r.relation_type,
                    target = r.target_lid,
                    direction = r.direction,
                    confidence = r.confidence,
                    evidence = r.evidence_lids.join(", ")
                ));
            }
        }
        if !relation_lines.is_empty() {
            lines.push("relations:".into());
            lines.extend(relation_lines);
        }
        hints.push(lines.join("\n"));
    }
    hints
}
fn build_synthesize_prompt(
    task: Option<&str>,
    mode: SynthesizeMode,
    ev: &EvidenceSet,
    formula_hints: &[String],
    discourse_hints: &[String],
    partials: &[String],
) -> CompletionRequest {
    let mut user = String::from("任务:\n");
    user.push_str(task.unwrap_or("综合这些 LID 的内容"));
    user.push_str("\n\nSynthesizePolicy:\n");
    user.push_str("- book_profile=technical_learning\n");
    user.push_str(&format!("- mode={}\n", mode.as_str()));
    user.push_str("- citation_policy=citations_subset_of_input_lids\n");
    user.push_str("- formula_policy=include_formula_semantics_when_formula_lid_present\n");
    user.push_str("- discourse_policy=use_discourse_relations_as_structure_hints\n");
    user.push_str("- reader_profile=not_attached\n");
    user.push_str(&format!("- mode_instruction={}\n", mode.instruction()));
    user.push_str("\n\n输入 LID 范围(只允许引用这些 LID):\n");
    for lid in ev.keys() {
        user.push_str(&format!("- {lid}\n"));
    }
    if !formula_hints.is_empty() {
        user.push_str("\n公式语义上下文(仅作结构提示,不新增 citation):\n");
        for h in formula_hints {
            user.push_str(h);
            user.push('\n');
        }
    }
    if !discourse_hints.is_empty() {
        user.push_str("\n语篇结构提示(仅限输入 LID 范围,不新增 citation):\n");
        for h in discourse_hints {
            user.push_str(h);
            user.push('\n');
        }
    }
    if !partials.is_empty() {
        user.push_str("\n分批局部综合结果(归并时仍只能引用输入 LID):\n");
        for (i, p) in partials.iter().enumerate() {
            user.push_str(&format!("[batch:{}] {p}\n", i + 1));
        }
    }
    user.push_str("\n证据(每条前缀 [LID],citations 只能引用这里出现的 LID):\n");
    for (lid, text) in ev {
        user.push_str(&format!("[{lid}] {text}\n"));
    }
    CompletionRequest {
        system: "你是书内综合器。只依据调用方给定的 LID 范围综合;不得外扩检索。\
                 citations 只能引用输入 LID;原文未覆盖的世界知识补充放 model_supplement(无 LID)。"
            .into(),
        user,
    }
}

fn valid_citations(resp: &ParsedResponse, ev: &EvidenceSet) -> Vec<RawCitation> {
    resp.citations
        .iter()
        .filter(|c| ev.contains_key(&c.lid))
        .cloned()
        .collect()
}

fn related_concepts(book: &Book, source_lids: &[String]) -> Vec<String> {
    let source: std::collections::BTreeSet<&str> = source_lids.iter().map(|s| s.as_str()).collect();
    let mut names = std::collections::BTreeSet::new();
    for node in &book.base.graph_nodes {
        let anchored = match node.node_type {
            GraphNodeType::Claim => node
                .source_lid
                .as_deref()
                .is_some_and(|lid| source.contains(lid)),
            GraphNodeType::Entity | GraphNodeType::Concept => node
                .occurrences
                .iter()
                .any(|lid| source.contains(lid.as_str())),
        };
        if anchored
            && matches!(
                node.node_type,
                GraphNodeType::Entity | GraphNodeType::Concept
            )
        {
            names.insert(node.name.clone());
        }
    }
    names.into_iter().collect()
}

fn suggested_probing(book: &Book, source_lids: &[String]) -> Vec<String> {
    let source: std::collections::BTreeSet<&str> = source_lids.iter().map(|s| s.as_str()).collect();
    let mut suggestions = std::collections::BTreeSet::new();
    for lid in source_lids {
        if book.formula_semantics(lid).is_some() {
            suggestions.insert(format!("解释公式 {lid} 的参数、组合含义和适用条件"));
        }
        if let Some(item) = book.discourse_item(lid) {
            if let Some(local_function) = &item.local_function {
                suggestions.insert(format!("围绕 {lid} 的 {local_function} 功能继续追问"));
            }
            for rel in &item.relations {
                let target_in_input = source.contains(rel.target_lid.as_str());
                let evidence_in_input = rel
                    .evidence_lids
                    .iter()
                    .all(|l| source.contains(l.as_str()));
                if target_in_input && evidence_in_input {
                    suggestions.insert(format!(
                        "追问 {lid} 如何通过 {} 关系连接 {}",
                        rel.relation_type, rel.target_lid
                    ));
                }
            }
        }
    }
    suggestions.into_iter().collect()
}
fn synth_response(
    resp: ParsedResponse,
    valid: Vec<RawCitation>,
    source_lids: Vec<String>,
    batched: bool,
    evidence_chain: Vec<String>,
    related_concepts: Vec<String>,
    suggested_probing: Vec<String>,
) -> SynthesizeResponse {
    SynthesizeResponse {
        answer: resp.answer,
        citations: valid
            .into_iter()
            .map(|c| Citation {
                lid: c.lid,
                text: c.text,
                role: c.role,
            })
            .collect(),
        model_supplement: resp
            .model_supplement
            .into_iter()
            .map(|s| SupplementOut {
                text: s.text,
                source: "model".into(),
            })
            .collect(),
        source_lids,
        batched,
        evidence_chain,
        related_concepts,
        suggested_probing,
    }
}

/// `book.synthesize(lids, task?)` 深路径 `[ADR-0017/0033]`。
/// 调用方显式给定离散 LID 集;系统不外扩,并确定性过滤 citations ⊆ input lids。
pub fn synthesize(
    book: &Book,
    lids: &[String],
    task: Option<&str>,
    adapter: &dyn ModelAdapter,
) -> Result<SynthesizeResponse, ToolError> {
    if lids.is_empty() {
        return Err(ToolError {
            error_code: "INVALID_RANGE".into(),
            category: "validation".into(),
            message: "book.synthesize 需至少一个 LID".into(),
        });
    }
    let mode = SynthesizeMode::from_task(task);
    let mut ev: EvidenceSet = BTreeMap::new();
    let mut formula_hints = Vec::new();
    for lid in lids {
        if !ev.contains_key(lid) {
            ev.insert(lid.clone(), book.text(lid, None)?);
            if let Some(h) = formula_semantics_hint(book, lid) {
                formula_hints.push(h);
            }
        }
    }
    let source_lids: Vec<String> = ev.keys().cloned().collect();
    let total_tokens: usize = ev
        .iter()
        .map(|(lid, text)| estimate_tokens(lid) + estimate_tokens(text))
        .sum();
    if total_tokens <= SYNTHESIZE_BATCH_TOKEN_LIMIT {
        let resp = adapter
            .complete(build_synthesize_prompt(
                task,
                mode,
                &ev,
                &formula_hints,
                &discourse_hints(book, &ev),
                &[],
            ))
            .map_err(|e| ToolError {
                error_code: "PROVIDER_ERROR".into(),
                category: "provider".into(),
                message: e.message,
            })?;
        let valid = valid_citations(&resp, &ev);
        return Ok(synth_response(
            resp,
            valid,
            source_lids.clone(),
            false,
            source_lids.clone(),
            related_concepts(book, &source_lids),
            suggested_probing(book, &source_lids),
        ));
    }

    let mut batches: Vec<EvidenceSet> = Vec::new();
    let mut cur: EvidenceSet = BTreeMap::new();
    let mut cur_tokens = 0usize;
    for (lid, text) in &ev {
        let cost = estimate_tokens(lid) + estimate_tokens(text);
        if !cur.is_empty() && cur_tokens + cost > SYNTHESIZE_BATCH_TOKEN_LIMIT {
            batches.push(cur);
            cur = BTreeMap::new();
            cur_tokens = 0;
        }
        cur.insert(lid.clone(), text.clone());
        cur_tokens += cost;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }

    let mut partials = Vec::new();
    let mut cited_lids = Vec::new();
    for batch in &batches {
        let batch_hints: Vec<String> = batch
            .keys()
            .filter_map(|lid| formula_semantics_hint(book, lid))
            .collect();
        let resp = adapter
            .complete(build_synthesize_prompt(
                task,
                mode,
                batch,
                &batch_hints,
                &discourse_hints(book, batch),
                &[],
            ))
            .map_err(|e| ToolError {
                error_code: "PROVIDER_ERROR".into(),
                category: "provider".into(),
                message: e.message,
            })?;
        for c in valid_citations(&resp, batch) {
            if !cited_lids.iter().any(|l: &String| l == &c.lid) {
                cited_lids.push(c.lid);
            }
        }
        if let Some(answer) = resp.answer {
            partials.push(answer);
        }
    }

    let mut merge_ev: EvidenceSet = BTreeMap::new();
    if cited_lids.is_empty() {
        for lid in &source_lids {
            merge_ev.insert(lid.clone(), ev[lid].clone());
        }
    } else {
        cited_lids.sort();
        for lid in &cited_lids {
            merge_ev.insert(lid.clone(), ev[lid].clone());
        }
    }
    let merge_chain: Vec<String> = merge_ev.keys().cloned().collect();
    let resp = adapter
        .complete(build_synthesize_prompt(
            task,
            mode,
            &merge_ev,
            &formula_hints,
            &discourse_hints(book, &merge_ev),
            &partials,
        ))
        .map_err(|e| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: e.message,
        })?;
    let valid = valid_citations(&resp, &merge_ev);
    Ok(synth_response(
        resp,
        valid,
        source_lids.clone(),
        true,
        merge_chain,
        related_concepts(book, &source_lids),
        suggested_probing(book, &source_lids),
    ))
}
/// Typed M6 referent-first query entrypoint.
pub fn query_run(
    book: &Book,
    request: &BookQueryRequest,
    adapter: &dyn ModelAdapter,
) -> Result<QueryRun, ToolError> {
    query_run_with_budgets(book, request, adapter, &QueryBudgets::default())
}

pub fn query(
    book: &Book,
    request: &BookQueryRequest,
    adapter: &dyn ModelAdapter,
) -> Result<QueryOutcome, ToolError> {
    query_run(book, request, adapter).map(|run| run.response)
}

fn first_leaf_lid(book: &Book) -> Result<String, ToolError> {
    book.base
        .lid_nodes
        .iter()
        .find(|n| n.children.is_empty())
        .or_else(|| book.base.lid_nodes.first())
        .map(|n| n.lid.clone())
        .ok_or_else(|| ToolError {
            error_code: "LID_NOT_FOUND".into(),
            category: "not_found".into(),
            message: "书内没有可导航 LID".into(),
        })
}

fn graph_node_lid(book: &Book, idx: usize) -> Option<String> {
    let node = &book.base.graph_nodes[idx];
    match node.node_type {
        GraphNodeType::Claim => node.source_lid.clone(),
        GraphNodeType::Entity | GraphNodeType::Concept => node.occurrences.first().cloned(),
    }
}

fn guide_entry_lid(
    book: &Book,
    intent: &str,
    anchor_lid: Option<&str>,
) -> Result<String, ToolError> {
    if let Some(anchor) = anchor_lid {
        book.text(anchor, None)?;
        return Ok(anchor.to_string());
    }

    let intent_lower = intent.to_lowercase();
    for (idx, node) in book.base.graph_nodes.iter().enumerate() {
        let name = node.name.trim();
        if !name.is_empty() && intent_lower.contains(&name.to_lowercase()) {
            if let Some(lid) = graph_node_lid(book, idx) {
                book.text(&lid, None)?;
                return Ok(lid);
            }
        }
    }

    first_leaf_lid(book)
}

fn guide_rejects_previous(intent: &str) -> bool {
    let lower = intent.to_lowercase();
    intent.contains("不对")
        || intent.contains("不對")
        || intent.contains("不是")
        || intent.contains("换一个")
        || lower.contains("wrong")
        || lower.contains("not that")
        || lower.contains("try another")
}

fn next_frontier_branch(ctx: &BookGuideSessionContext) -> Option<RankedStep> {
    if ctx.last_frontier.is_empty() {
        return None;
    }
    if let Some(current) = &ctx.cursor_at_lid {
        if let Some(i) = ctx.last_frontier.iter().position(|s| &s.lid == current) {
            return ctx
                .last_frontier
                .get(i + 1)
                .or_else(|| ctx.last_frontier.first())
                .cloned();
        }
    }
    ctx.last_frontier.first().cloned()
}

fn flatten_frontier(f: Frontier) -> Vec<RankedStep> {
    let Frontier {
        back,
        forward,
        concretize,
        cross,
        continue_,
    } = f;
    let mut out = Vec::new();
    out.extend(continue_);
    out.extend(back);
    out.extend(concretize);
    out.extend(forward);
    out.extend(cross);
    out
}

fn insert_guide_evidence(book: &Book, ev: &mut EvidenceSet, lid: &str) -> Result<(), ToolError> {
    if !ev.contains_key(lid) {
        ev.insert(lid.to_string(), book.text(lid, None)?);
    }
    Ok(())
}

fn guide_evidence(
    book: &Book,
    entry_lid: &str,
    route: &[RankedStep],
) -> Result<EvidenceSet, ToolError> {
    let mut ev = EvidenceSet::new();
    insert_guide_evidence(book, &mut ev, entry_lid)?;
    for step in route {
        insert_guide_evidence(book, &mut ev, &step.lid)?;
        for lid in &step.evidence_lids {
            insert_guide_evidence(book, &mut ev, lid)?;
        }
    }
    Ok(ev)
}

fn build_book_guide_prompt(
    intent: &str,
    entry_lid: &str,
    refined: bool,
    route: &[RankedStep],
    ev: &EvidenceSet,
    transcript_tail: &[String],
) -> CompletionRequest {
    let mut user = String::from("访客意图:\n");
    user.push_str(intent);
    user.push_str("\n\n入口 LID:\n");
    user.push_str(entry_lid);
    user.push_str("\n\n本轮状态:\n");
    user.push_str(if refined {
        "访客否定了上一条路线,请中立换到另一条结构分支。\n"
    } else {
        "首次或继续引导,请给出可验证路线。\n"
    });
    if !transcript_tail.is_empty() {
        user.push_str("\n访客会话摘要(仅临时③,不可当书中事实):\n");
        for item in transcript_tail {
            user.push_str("- ");
            user.push_str(item);
            user.push('\n');
        }
    }
    user.push_str("\n路线步骤(每步都是真 LID/真边):\n");
    if route.is_empty() {
        user.push_str("- 当前入口暂无可继续展开的 route 前沿,请围绕入口说明下一步如何核查。\n");
    } else {
        for (idx, step) in route.iter().enumerate() {
            user.push_str(&format!(
                "{}. {} via {}: {} evidence=[{}]\n",
                idx + 1,
                step.lid,
                step.edge_type,
                step.why,
                step.evidence_lids.join(", ")
            ));
        }
    }
    user.push_str("\n证据(每条前缀 [LID],citations 只能引用这里出现的 LID):\n");
    for (lid, text) in ev {
        user.push_str(&format!("[{lid}] {text}\n"));
    }
    CompletionRequest {
        system: "你是书内路线向导。只给访客可独立验证的阅读路线,不使用读者私人记忆、reader viewport 或 memory。\
                 answer 用中立语气说明入口和下一步;citations 只能引用证据 LID。"
            .into(),
        user,
    }
}

/// P7 `book_guide(intent, anchor?, session_ctx?)`: `book.query`'s route sibling.
/// It is a lite LLM command over the read-only book plus explicit visitor
/// session context, and never calls the resident orchestrator `run()`.
pub fn book_guide(
    book: &Book,
    req: BookGuideRequest,
    session_ctx: Option<&BookGuideSessionContext>,
    adapter: &dyn ModelAdapter,
) -> Result<BookGuideResponse, ToolError> {
    let intent = req.intent.trim();
    if intent.is_empty() {
        return Err(ToolError {
            error_code: "INVALID_RANGE".into(),
            category: "validation".into(),
            message: "book_guide 需 intent".into(),
        });
    }

    let refined = session_ctx
        .map(|ctx| guide_rejects_previous(intent) && !ctx.last_frontier.is_empty())
        .unwrap_or(false);
    let previous_branch = if refined {
        session_ctx.and_then(next_frontier_branch)
    } else {
        None
    };
    let entry_lid = match &previous_branch {
        Some(step) => {
            book.text(&step.lid, None)?;
            step.lid.clone()
        }
        None => guide_entry_lid(book, intent, req.anchor_lid.as_deref())?,
    };

    let frontier = flatten_frontier(book.route_from(&entry_lid, None)?);
    let mut route = Vec::new();
    if let Some(step) = previous_branch {
        route.push(step);
    }
    for step in frontier.iter().take(3) {
        if route.iter().all(|s: &RankedStep| s.lid != step.lid) {
            route.push(step.clone());
        }
    }

    let ev = guide_evidence(book, &entry_lid, &route)?;
    let transcript_tail: Vec<String> = session_ctx
        .map(|ctx| ctx.transcript_tail.iter().rev().take(4).cloned().collect())
        .unwrap_or_default();
    let resp = adapter
        .complete(build_book_guide_prompt(
            intent,
            &entry_lid,
            refined,
            &route,
            &ev,
            &transcript_tail,
        ))
        .map_err(|e| ToolError {
            error_code: "PROVIDER_ERROR".into(),
            category: "provider".into(),
            message: e.message,
        })?;
    let valid = valid_citations(&resp, &ev);

    Ok(BookGuideResponse {
        intent: intent.to_string(),
        entry_lid,
        refined,
        route,
        frontier,
        answer: resp.answer,
        citations: valid
            .into_iter()
            .map(|c| Citation {
                lid: c.lid,
                text: c.text,
                role: c.role,
            })
            .collect(),
        model_supplement: resp
            .model_supplement
            .into_iter()
            .map(|s| SupplementOut {
                text: s.text,
                source: "model".into(),
            })
            .collect(),
    })
}

// ─────────────────────────── NativeAdapter(S5b)───────────────────────────
// 读 `.env` 的 OpenAI-兼容端点(BASE_URL/API_KEY/MODEL),POST /chat/completions,
// `response_format=json_object` 拿结构化,解析回 ParsedResponse `[ADR-0025]`。
// 结构红线不在此守:lid 真实性由 loop 的确定性交叉验停过滤,后端乱吐也滤净 `[ADR-0004]`。

/// LLM 合一轮的 JSON 输出契约(拼到 system,约束 glm-5.1 等 OpenAI-兼容后端的 json 形状)。
const OUTPUT_CONTRACT: &str = "只输出一个 JSON 对象,不要 markdown 代码块,形如:\n\
{\"sufficient\": true 或 false, \"answer\": \"答案文本或 null\", \
\"citations\": [{\"lid\": \"证据中的LID\", \"text\": \"引用的原文片段\", \"role\": \"support 或 contrast\"}], \
\"model_supplement\": [{\"text\": \"原文未覆盖的世界知识补充\"}]}\n\
规则:\n\
- 只要证据中有任何片段能支撑你的回答,就把综合答案写进 answer 字段、令 sufficient=true。\n\
- citations 的 lid 必须来自上面 [LID] 标注过的证据,引用支撑答案的原文片段。\n\
- model_supplement 只放证据完全无法支撑、纯靠世界知识的延伸;不要把主答案放这里。\n\
- 只有当证据完全无法支撑任何回答时,才令 sufficient=false、answer=null。";

/// NativeAdapter:对接 `.env` 配置的 OpenAI-兼容后端 `[ADR-0003/0025]`。
pub struct NativeAdapter {
    api_key: String,
    base_url: String,
    model: String,
    request_timeout: Option<std::time::Duration>,
}

impl NativeAdapter {
    pub fn from_config(cfg: ProviderConfig) -> NativeAdapter {
        NativeAdapter {
            api_key: cfg.api_key,
            base_url: cfg.base_url,
            model: cfg.model,
            request_timeout: None,
        }
    }

    pub fn from_config_with_timeout(
        cfg: ProviderConfig,
        timeout: std::time::Duration,
    ) -> NativeAdapter {
        NativeAdapter {
            api_key: cfg.api_key,
            base_url: cfg.base_url,
            model: cfg.model,
            request_timeout: Some(timeout),
        }
    }

    /// 从 `.env` / 进程环境读配置(`OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `FLUID_LLM_MODEL`)。
    pub fn from_env() -> Result<NativeAdapter, AdapterError> {
        let mut cfg = ProviderConfig::from_env()?;
        cfg.mode = ProviderMode::Native;
        Ok(NativeAdapter::from_config(cfg))
    }

    fn post_chat_completions(
        &self,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, AdapterError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let mut retried = false;
        let resp = loop {
            match self.send_chat_completions_once(&url, &body) {
                Ok(resp) => break resp,
                Err(e) if !retried && is_retriable_chat_completion_error(&e) => {
                    retried = true;
                    std::thread::sleep(chat_completion_retry_delay());
                }
                Err(e) => {
                    let prefix = if retried {
                        "HTTP 请求失败(重试一次后仍失败)"
                    } else {
                        "HTTP 请求失败"
                    };
                    return Err(AdapterError {
                        message: adapter_http_error_message(prefix, e),
                    });
                }
            }
        };
        resp.into_json().map_err(|e| AdapterError {
            message: format!("响应非 JSON: {e}"),
        })
    }

    fn send_chat_completions_once(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<ureq::Response, ureq::Error> {
        let request = ureq::post(url)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json");
        let request = match self.request_timeout {
            Some(timeout) => request.timeout(timeout),
            None => request,
        };
        request.send_json(body)
    }
}

const PROVIDER_ERROR_BODY_LIMIT: usize = 4096;

fn adapter_http_error_message(prefix: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(status, response) => {
            let url = response.get_url().to_string();
            let body = response
                .into_string()
                .map(|s| truncate_provider_error_body(&s))
                .unwrap_or_else(|e| format!("<读取错误响应失败: {e}>"));
            if body.trim().is_empty() {
                format!("{prefix}: {url}: status code {status}")
            } else {
                format!("{prefix}: {url}: status code {status}; body: {body}")
            }
        }
        e => format!("{prefix}: {e}"),
    }
}

fn truncate_provider_error_body(body: &str) -> String {
    let mut out = String::new();
    for (idx, ch) in body.chars().enumerate() {
        if idx >= PROVIDER_ERROR_BODY_LIMIT {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}

fn is_retriable_chat_completion_error(err: &ureq::Error) -> bool {
    let ureq::Error::Transport(transport) = err else {
        return false;
    };
    matches!(
        transport.kind(),
        ureq::ErrorKind::Dns
            | ureq::ErrorKind::ConnectionFailed
            | ureq::ErrorKind::BadStatus
            | ureq::ErrorKind::Io
            | ureq::ErrorKind::ProxyConnect
    )
}

#[cfg(test)]
fn chat_completion_retry_delay() -> std::time::Duration {
    std::time::Duration::from_millis(1)
}

#[cfg(not(test))]
fn chat_completion_retry_delay() -> std::time::Duration {
    std::time::Duration::from_millis(250)
}

fn provider_tool_name(original: &str, idx: usize, used: &mut HashSet<String>) -> String {
    let mut base: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if base.is_empty() || !base.chars().any(|c| c.is_ascii_alphanumeric()) {
        base = format!("tool_{}", idx + 1);
    }
    if base.len() > 64 {
        base.truncate(64);
    }

    let mut candidate = base.clone();
    let mut suffix_idx = 2;
    while used.contains(&candidate) {
        let suffix = format!("_{suffix_idx}");
        let keep = 64_usize.saturating_sub(suffix.len()).min(base.len());
        candidate = format!("{}{}", &base[..keep], suffix);
        suffix_idx += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn native_message_to_json(
    m: &Message,
    internal_to_provider: &BTreeMap<String, String>,
) -> serde_json::Value {
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut o = serde_json::json!({ "role": role });
    match &m.content {
        Some(c) => o["content"] = serde_json::json!(c),
        None if m.role == Role::Assistant => o["content"] = serde_json::Value::Null,
        None => {}
    }
    if !m.tool_calls.is_empty() {
        o["tool_calls"] = serde_json::Value::Array(
            m.tool_calls
                .iter()
                .map(|tc| {
                    let provider_name = internal_to_provider
                        .get(&tc.name)
                        .map(String::as_str)
                        .unwrap_or(&tc.name);
                    serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": provider_name, "arguments": tc.arguments },
                    })
                })
                .collect(),
        );
    }
    if let Some(id) = &m.tool_call_id {
        o["tool_call_id"] = serde_json::json!(id);
    }
    o
}

/// 后端 JSON 输出的中间解析形(宽松:缺字段给默认,不静默改 lid)。
#[derive(Deserialize)]
struct LlmOut {
    #[serde(default)]
    sufficient: bool,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    citations: Vec<LlmCite>,
    #[serde(default)]
    model_supplement: Vec<LlmSupp>,
}
#[derive(Deserialize)]
struct LlmCite {
    lid: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    role: String,
}
#[derive(Deserialize)]
struct LlmSupp {
    text: String,
}

/// 剥可能的 markdown ```json fence(json 解析容错,非 LID 降级)。
fn strip_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

/// 鲁棒 JSON 对象抽取(S9 `[ADR-0016 决策5 / ADR-0004]`):从可能含 markdown 围栏 /
/// 前后散文杂质的内容里,抽出**第一个平衡 `{}` 对象子串**(跳过字符串字面量内的括号与
/// `\` 转义,故引号内的 `{`/`}` 不计深度)。抽不到返回 `None`,由调用方诚实报错,
/// **不静默降级**(守 `[ADR-0015]`)。本函数只负责「形状」抽取,值的正确性仍由内层
/// `query` 的确定性交叉验停(`citations⊆证据集`)再校验一遍 `[ADR-0004]`。
/// 仅扫描 `{`/`}`/`"`/`\` 等 ASCII 字节,返回的子串始终落在 char 边界(多字节 UTF-8 续字节 ≥0x80,
/// 不与这些 ASCII 冲突),`&t[start..=i]` 切片安全。
fn extract_json_object(s: &str) -> Option<&str> {
    let t = strip_fence(s);
    let bytes = t.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&t[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

fn response_message_content(v: &serde_json::Value) -> Result<&str, AdapterError> {
    v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| AdapterError {
            message: format!("响应缺 choices[0].message.content: {v}"),
        })
}

fn parsed_response_from_content(content: &str) -> Result<ParsedResponse, AdapterError> {
    // S9:抽不到平衡 JSON 对象(空响应 / 纯散文)→ 显式报错,不静默成功(守禁宽松降级 `[ADR-0015]`)。
    let json = extract_json_object(content).ok_or_else(|| AdapterError {
        message: format!("模型输出抽不到合法 JSON 对象;原文={content}"),
    })?;
    let out: LlmOut = serde_json::from_str(json).map_err(|e| AdapterError {
        message: format!("模型输出非合法 JSON: {e};原文={content}"),
    })?;
    Ok(ParsedResponse {
        sufficient: out.sufficient,
        answer: out.answer,
        citations: out
            .citations
            .into_iter()
            .map(|c| RawCitation {
                lid: c.lid,
                text: c.text,
                role: c.role,
            })
            .collect(),
        model_supplement: out
            .model_supplement
            .into_iter()
            .map(|s| Supplement { text: s.text })
            .collect(),
    })
}

fn structured_json_from_content(content: &str) -> Result<serde_json::Value, AdapterError> {
    let json = extract_json_object(content).ok_or_else(|| AdapterError {
        message: format!("模型输出抽不到合法 JSON 对象;原文={content}"),
    })?;
    serde_json::from_str(json).map_err(|e| AdapterError {
        message: format!("模型输出非合法 JSON: {e};原文={content}"),
    })
}

#[derive(Deserialize)]
struct ReActOut {
    #[serde(default, rename = "final", alias = "answer")]
    final_text: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ReActCall>,
    #[serde(default)]
    tool_call: Option<ReActCall>,
    #[serde(default)]
    usage_total_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct ReActCall {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: serde_json::Value,
}

pub fn parse_react_assistant_turn(content: &str) -> Result<AssistantTurn, AdapterError> {
    let json = extract_json_object(content).ok_or_else(|| AdapterError {
        message: format!("ReAct 输出抽不到合法 JSON 对象;原文={content}"),
    })?;
    let mut out: ReActOut = serde_json::from_str(json).map_err(|e| AdapterError {
        message: format!("ReAct 输出非合法 JSON: {e};原文={content}"),
    })?;
    if let Some(call) = out.tool_call.take() {
        out.tool_calls.push(call);
    }
    let mut calls = Vec::with_capacity(out.tool_calls.len());
    for (idx, c) in out.tool_calls.into_iter().enumerate() {
        let Some(name) = c.name.filter(|name| !name.trim().is_empty()) else {
            return Err(AdapterError {
                message: format!("ReAct tool_calls[{idx}] 缺 name"),
            });
        };
        let arguments = match c.arguments {
            serde_json::Value::Null => "{}".to_string(),
            serde_json::Value::String(s) => s,
            v => serde_json::to_string(&v).map_err(|e| AdapterError {
                message: format!("ReAct tool_calls[{idx}].arguments 序列化失败: {e}"),
            })?,
        };
        calls.push(ToolCall {
            id: c.id.unwrap_or_else(|| format!("react_{}", idx + 1)),
            name,
            arguments,
        });
    }
    if calls.is_empty() && out.final_text.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AdapterError {
            message: "ReAct 输出既无 final/answer,也无 tool_calls".into(),
        });
    }
    Ok(AssistantTurn {
        text: out.final_text,
        tool_calls: calls,
        usage_total_tokens: out.usage_total_tokens,
    })
}

fn react_message_to_json(m: &Message) -> serde_json::Value {
    match m.role {
        Role::System | Role::User => message_to_json(m),
        Role::Assistant => {
            let mut content = m.content.clone().unwrap_or_default();
            if !m.tool_calls.is_empty() {
                let calls: Vec<serde_json::Value> = m
                    .tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "name": tc.name,
                            "arguments": tc.arguments,
                        })
                    })
                    .collect();
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str("已请求工具:");
                content.push_str(&serde_json::to_string(&calls).unwrap_or_else(|_| "[]".into()));
            }
            serde_json::json!({ "role": "assistant", "content": content })
        }
        Role::Tool => serde_json::json!({
            "role": "user",
            "content": format!(
                "工具结果 tool_call_id={}:\n{}",
                m.tool_call_id.as_deref().unwrap_or(""),
                m.content.as_deref().unwrap_or("")
            )
        }),
    }
}

fn build_react_system(tools: &[ToolSpec]) -> String {
    let tool_list: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            })
        })
        .collect();
    format!(
        "你所在的 provider 没有原生 tool-calling。你必须每回合只输出一个 JSON 对象,不要 markdown。\n\
         若要调用工具,输出: {{\"tool_calls\":[{{\"name\":\"book.text\",\"arguments\":{{\"lid\":\"1.1\"}}}}]}}\n\
         若要最终回答,输出: {{\"final\":\"回答文本\"}}\n\
         工具只能从以下列表选择,arguments 必须符合对应 JSON Schema:\n{}",
        serde_json::to_string_pretty(&tool_list).unwrap_or_else(|_| "[]".into())
    )
}

pub struct ReActAdapter {
    native: NativeAdapter,
}

impl ReActAdapter {
    pub fn from_config(cfg: ProviderConfig) -> ReActAdapter {
        ReActAdapter {
            native: NativeAdapter::from_config(cfg),
        }
    }

    pub fn from_config_with_timeout(
        cfg: ProviderConfig,
        timeout: std::time::Duration,
    ) -> ReActAdapter {
        ReActAdapter {
            native: NativeAdapter::from_config_with_timeout(cfg, timeout),
        }
    }

    pub fn from_env() -> Result<ReActAdapter, AdapterError> {
        let mut cfg = ProviderConfig::from_env()?;
        cfg.mode = ProviderMode::ReAct;
        Ok(ReActAdapter::from_config(cfg))
    }
}

impl ModelAdapter for NativeAdapter {
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        let system = format!("{}\n\n{}", req.system, OUTPUT_CONTRACT);
        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": req.user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        });
        let v = self.post_chat_completions(body)?;
        parsed_response_from_content(response_message_content(&v)?)
    }

    fn complete_structured(
        &self,
        req: CompletionRequest,
    ) -> Result<serde_json::Value, AdapterError> {
        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        });
        let response = self.post_chat_completions(body)?;
        structured_json_from_content(response_message_content(&response)?)
    }

    /// 外层多轮 tool-calling:带 `tools` schema 请求,解析 `assistant.tool_calls` + `usage` `[ADR-0026]`。
    fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<AssistantTurn, AdapterError> {
        let mut used_tool_names = HashSet::new();
        let mut provider_to_internal = BTreeMap::new();
        let mut internal_to_provider = BTreeMap::new();
        let tool_specs: Vec<serde_json::Value> = tools
            .iter()
            .enumerate()
            .map(|(idx, t)| {
                let provider_name = provider_tool_name(&t.name, idx, &mut used_tool_names);
                provider_to_internal.insert(provider_name.clone(), t.name.clone());
                internal_to_provider.insert(t.name.clone(), provider_name.clone());
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": provider_name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                })
            })
            .collect();
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| native_message_to_json(m, &internal_to_provider))
            .collect();
        let body = serde_json::json!({
            "model": self.model,
            "messages": msgs,
            "tools": tool_specs,
            "temperature": 0,
        });
        let v = self.post_chat_completions(body)?;
        let msg = &v["choices"][0]["message"];
        let text = msg["content"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let mut tool_calls = Vec::new();
        if let Some(arr) = msg["tool_calls"].as_array() {
            for tc in arr {
                let provider_name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                let name = provider_to_internal
                    .get(&provider_name)
                    .cloned()
                    .unwrap_or(provider_name);
                tool_calls.push(ToolCall {
                    id: tc["id"].as_str().unwrap_or("").to_string(),
                    name,
                    arguments: tc["function"]["arguments"]
                        .as_str()
                        .unwrap_or("{}")
                        .to_string(),
                });
            }
        }
        let usage_total_tokens = v["usage"]["total_tokens"].as_u64().map(|u| u as u32);
        Ok(AssistantTurn {
            text,
            tool_calls,
            usage_total_tokens,
        })
    }
}

impl ModelAdapter for ReActAdapter {
    fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
        let system = format!("{}\n\n{}", req.system, OUTPUT_CONTRACT);
        let body = serde_json::json!({
            "model": self.native.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": req.user},
            ],
            "temperature": 0,
        });
        let v = self.native.post_chat_completions(body)?;
        parsed_response_from_content(response_message_content(&v)?)
    }

    fn complete_structured(
        &self,
        req: CompletionRequest,
    ) -> Result<serde_json::Value, AdapterError> {
        self.native.complete_structured(req)
    }

    fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
    ) -> Result<AssistantTurn, AdapterError> {
        let mut msgs = Vec::with_capacity(messages.len() + 1);
        msgs.push(serde_json::json!({
            "role": "system",
            "content": build_react_system(tools),
        }));
        msgs.extend(messages.iter().map(react_message_to_json));
        let body = serde_json::json!({
            "model": self.native.model,
            "messages": msgs,
            "temperature": 0,
        });
        let v = self.native.post_chat_completions(body)?;
        parse_react_assistant_turn(response_message_content(&v)?)
    }
}

/// technical_learning 教学整形后的有序前沿分组 `[ADR-0037]`。
/// = route_from 5 类前沿按教学序重排 + 剔空组;保分组导航语义(不平铺)。
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct GuidedGroup {
    pub category: NavCategory,
    pub steps: Vec<RankedStep>,
}

/// 无 BookReadingState 信号时的中性默认教学序 `[ADR-0037 决策4]`:主线推进优先,不假设新手。
/// 占位常量,实测 / content profile policy 回填(ADR-0037 何时回头)。
const TEACHING_ORDER: [NavCategory; 5] = [
    NavCategory::Continue,
    NavCategory::Back,
    NavCategory::Concretize,
    NavCategory::Forward,
    NavCategory::Cross,
];

/// technical_learning 教学整形 `[ADR-0037 决策2 / ADR-0038 已读降权 / ADR-0041 qa 活动升权]`:
/// 按 `TEACHING_ORDER` 重排 5 类分组 + 剔空组 + **组内信号整形**。零 LLM、确定性可单测;与 `book.synthesize`「Core+policy」同构。
/// 组内整形分两套:
/// - **非 back 组**:仅已读降权——稳定排序未读在前、已读沉底(保组内原 weight×距离 次序,不剔除)。
/// - **back 组(qa 活动升权,压已读)**`[ADR-0041 决策5/6/7]`:Tier A 问过(`qa_count`>0,按 count 降序)/
///   Tier B 未读+没问过 / Tier C 读过+没问过(沉底)。读过且问过仍落 Tier A(升权压已读);
///   tiebreak 用 route_from 的 score 序(稳定排序)。
///
/// `read_set` / `engagement_by_lid` 空 ⇒ 退化为纯 TEACHING_ORDER 重排(向后兼容)。
fn technical_learning_reorder(
    f: Frontier,
    read_set: &HashSet<String>,
    engagement_by_lid: &BTreeMap<String, EngagementSignals>,
) -> Vec<GuidedGroup> {
    let Frontier {
        back,
        forward,
        concretize,
        cross,
        continue_,
    } = f;
    let mut buckets: Vec<(NavCategory, Vec<RankedStep>)> = vec![
        (NavCategory::Back, back),
        (NavCategory::Forward, forward),
        (NavCategory::Concretize, concretize),
        (NavCategory::Cross, cross),
        (NavCategory::Continue, continue_),
    ];
    for (cat, steps) in buckets.iter_mut() {
        if matches!(cat, NavCategory::Back) {
            // back 组 qa 活动升权(压已读):Tier A 问过(count 降序)/ B 未读 / C 读过沉底;
            // tiebreak 保 route_from score 序(稳定排序)`[ADR-0041]`。
            steps.sort_by_key(|s| {
                let qa_count = engagement_by_lid
                    .get(&s.lid)
                    .map(|signals| signals.qa_count)
                    .unwrap_or(0);
                let read = read_set.contains(&s.lid);
                let tier: u8 = if qa_count > 0 {
                    0
                } else if !read {
                    1
                } else {
                    2
                };
                (tier, std::cmp::Reverse(qa_count))
            });
        } else {
            // 其余组:仅已读降权(未读在前、已读沉底,稳定排序保组内原次序)。
            steps.sort_by_key(|s| read_set.contains(&s.lid));
        }
    }
    TEACHING_ORDER
        .iter()
        .filter_map(|cat| {
            let pos = buckets.iter().position(|(c, _)| c == cat)?;
            let (category, steps) = buckets.remove(pos);
            (!steps.is_empty()).then_some(GuidedGroup { category, steps })
        })
        .collect()
}

/// `book.guided_route_from(at, k?)` `[ADR-0037 决策1 / ADR-0038]`:route_from(Core)+ technical_learning
/// 教学整形 + 单本阅读状态适配(已读降权 + back 组 qa 活动升权 `[ADR-0041/0075]`)。裸
/// `book.route_from` 仍在(访客/高级);住户带读优先用本工具。这里只消费 `read_lids` 与原始
/// `EngagementSignals`,不把 qa/note/highlight 自动解释为认知结论。
pub fn guided_route_from(
    book: &Book,
    at: &str,
    k: Option<usize>,
    reading_state: &BookReadingState,
) -> Result<Vec<GuidedGroup>, ToolError> {
    let read_set: HashSet<String> = reading_state.read_lids.iter().cloned().collect();
    Ok(technical_learning_reorder(
        book.route_from(at, k)?,
        &read_set,
        &reading_state.engagement_by_lid,
    ))
}

/// `book.unvisited_back(at)` `[ADR-0036 决策3]`:裸「没懂」(无 locus)结构兜底的确定性原语。
/// 返回 `route_from(at).back ∩ (全集 \ read_lids)` = **未读前置**(back 类别里读者还没读过的)。
/// 未读过滤在 runtime policy 层消费 `BookReadingState`,route Core 零 LLM 不破(承 guided_route_from)。
/// agent 据返回**空/非空**走分支(空→讲法轴原地重讲 / 非空→可撤销提议「先回看 首项」),
/// **不让 agent 心算 back ∩ 未读 交集**(守 ADR-0036 命门 + 质量优先:未读判定确定性)。
/// 组内保持 route_from 的 weight×距离 序(首项 = 最该回看的未读前置)。
pub fn unvisited_back(
    book: &Book,
    at: &str,
    reading_state: &BookReadingState,
) -> Result<Vec<RankedStep>, ToolError> {
    let read_set: HashSet<String> = reading_state.read_lids.iter().cloned().collect();
    let back = book.route_from(at, None)?.back;
    Ok(back
        .into_iter()
        .filter(|s| !read_set.contains(&s.lid))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::{
        sample_base, Direction, EdgeScope, FormulaComposition, FormulaContextLink,
        FormulaParameter, FormulaSemantics, GraphEdge, GraphNode, GraphNodeType, LidNode, NodeKind,
        ReadOnlyBase, Span,
    };
    use read_tools::{TechnicalLearningDiscourseItem, TechnicalLearningDiscourseRelation};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};

    fn rstep(lid: &str) -> RankedStep {
        RankedStep {
            lid: lid.into(),
            edge_type: "x".into(),
            why: String::new(),
            evidence_lids: vec![],
            score: 1.0,
        }
    }

    // P3-3 教学整形:中性序 continue>back>concretize>forward>cross + 剔空组,确定性。
    #[test]
    fn technical_learning_reorder_neutral_order_and_drops_empty() {
        let f = Frontier {
            back: vec![rstep("1.0")],
            forward: vec![],
            concretize: vec![],
            cross: vec![rstep("9.9")],
            continue_: vec![rstep("1.2")],
        };
        let g = technical_learning_reorder(f, &HashSet::new(), &BTreeMap::new());
        let cats: Vec<NavCategory> = g.iter().map(|x| x.category).collect();
        // 中性序剔空组后 = [Continue, Back, Cross]
        assert_eq!(
            cats,
            vec![NavCategory::Continue, NavCategory::Back, NavCategory::Cross]
        );
        assert_eq!(g[0].steps[0].lid, "1.2"); // continue
        assert_eq!(g[1].steps[0].lid, "1.0"); // back
        assert_eq!(g[2].steps[0].lid, "9.9"); // cross
    }

    // 全空前沿 → 无分组(非 error)。
    #[test]
    fn technical_learning_reorder_empty_frontier_yields_no_groups() {
        let f = Frontier {
            back: vec![],
            forward: vec![],
            concretize: vec![],
            cross: vec![],
            continue_: vec![],
        };
        assert!(technical_learning_reorder(f, &HashSet::new(), &BTreeMap::new()).is_empty());
    }

    // BookReadingState 已读降权 `[ADR-0075]`:组内未读在前、已读沉底(稳定排序保原次序);不剔除。
    #[test]
    fn technical_learning_reorder_demotes_read_within_group() {
        let f = Frontier {
            back: vec![rstep("1.0"), rstep("1.1"), rstep("1.2")], // 1.0/1.2 已读、1.1 未读
            forward: vec![rstep("2.0")],                          // 全未读,不变
            concretize: vec![],
            cross: vec![],
            continue_: vec![],
        };
        let read: HashSet<String> = ["1.0", "1.2"].iter().map(|s| s.to_string()).collect();
        let g = technical_learning_reorder(f, &read, &BTreeMap::new());
        let back = g.iter().find(|x| x.category == NavCategory::Back).unwrap();
        let lids: Vec<&str> = back.steps.iter().map(|s| s.lid.as_str()).collect();
        assert_eq!(lids, vec!["1.1", "1.0", "1.2"]); // 未读升首,已读沉底保原序
        assert_eq!(back.steps.len(), 3); // 已读不剔除(保留回看入口)
        let fwd = g
            .iter()
            .find(|x| x.category == NavCategory::Forward)
            .unwrap();
        assert_eq!(fwd.steps[0].lid, "2.0"); // 全未读不变
    }

    // qa-2 back 组活动升权 `[ADR-0041/0075]`:Tier A 问过(count 降序)/ B 未读 / C 读过沉底;
    // 仅 back 组消费 qa_count,其余组不变;计数本身不声明困惑或掌握。
    #[test]
    fn technical_learning_reorder_back_promotes_qa_activity_over_read() {
        let f = Frontier {
            // back:2.1 读过+问1 / 2.2 读过+问3 / 2.3 未读没问 / 2.4 读过没问
            back: vec![rstep("2.1"), rstep("2.2"), rstep("2.3"), rstep("2.4")],
            forward: vec![rstep("3.1"), rstep("3.2")], // 3.1 问过 ×5,但 forward 不升权
            concretize: vec![],
            cross: vec![],
            continue_: vec![],
        };
        let read: HashSet<String> = ["2.1", "2.2", "2.4"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let engagement: BTreeMap<String, EngagementSignals> =
            [("2.2", 3u32), ("2.1", 1u32), ("3.1", 5u32)]
                .iter()
                .map(|(l, c)| {
                    (
                        l.to_string(),
                        EngagementSignals {
                            qa_count: *c,
                            ..Default::default()
                        },
                    )
                })
                .collect();
        let g = technical_learning_reorder(f, &read, &engagement);
        let back = g.iter().find(|x| x.category == NavCategory::Back).unwrap();
        let lids: Vec<&str> = back.steps.iter().map(|s| s.lid.as_str()).collect();
        // Tier A 按 qa_count:2.2(×3) > 2.1(×1);Tier B 未读:2.3;Tier C 读过没问:2.4。
        assert_eq!(lids, vec!["2.2", "2.1", "2.3", "2.4"]);
        // forward 不受 qa_count 影响:3.1 问过 ×5 也不升,保 route_from 原序(都未读)。
        let fwd = g
            .iter()
            .find(|x| x.category == NavCategory::Forward)
            .unwrap();
        assert_eq!(
            fwd.steps.iter().map(|s| s.lid.as_str()).collect::<Vec<_>>(),
            vec!["3.1", "3.2"]
        );
    }

    /// at="1.1" 经两条 depends_on 长程边指向前置 2.1/2.2(→ route_from(1.1).back=[2.1,2.2])。
    /// entity 各单 occurrence ⇒ 无 co_occurrence cross 噪声;结构邻接不产 back(承 read-tools far-edge fixture)。
    fn book_with_back_prereqs() -> Book {
        let src = "A".repeat(40);
        let para = |lid: &str, p: Vec<u32>, s: usize, e: usize| LidNode {
            lid: lid.into(),
            path: p,
            kind: NodeKind::Paragraph,
            span: Span { start: s, end: e },
            children: vec![],
        };
        let base = ReadOnlyBase {
            book_id: "back-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 20 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                para("1.1", vec![1, 1], 0, 10),
                para("1.2", vec![1, 2], 10, 20),
                LidNode {
                    lid: "2".into(),
                    path: vec![2],
                    kind: NodeKind::Chapter,
                    span: Span { start: 20, end: 40 },
                    children: vec!["2.1".into(), "2.2".into()],
                },
                para("2.1", vec![2, 1], 20, 30),
                para("2.2", vec![2, 2], 30, 40),
            ],
            graph_nodes: vec![
                GraphNode {
                    id: "entity:a".into(),
                    node_type: GraphNodeType::Entity,
                    name: "A".into(),
                    occurrences: vec!["1.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:p1".into(),
                    node_type: GraphNodeType::Entity,
                    name: "P1".into(),
                    occurrences: vec!["2.1".into()],
                    source_lid: None,
                },
                GraphNode {
                    id: "entity:p2".into(),
                    node_type: GraphNodeType::Entity,
                    name: "P2".into(),
                    occurrences: vec!["2.2".into()],
                    source_lid: None,
                },
            ],
            graph_edges: vec![
                GraphEdge {
                    source: "entity:a".into(),
                    target: "entity:p1".into(),
                    edge_type: "depends_on".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.9,
                },
                GraphEdge {
                    source: "entity:a".into(),
                    target: "entity:p2".into(),
                    edge_type: "depends_on".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 0.8,
                },
            ],
        };
        Book::new(base, &src)
    }

    fn reading_state(read: &[&str]) -> BookReadingState {
        BookReadingState {
            book_id: "back-book".into(),
            read_lids: read.iter().map(|s| s.to_string()).collect(),
            engagement_by_lid: BTreeMap::new(),
        }
    }

    // P3-2 裸「没懂」兜底 `[ADR-0036 决策3]`:unvisited_back = route_from(at).back ∩ 未读,确定性。
    // 全未读→两前置都返;读过 2.1→只剩 2.2;两前置都读过→空(agent 走讲法轴);invalid at→not_found。
    #[test]
    fn unvisited_back_filters_read_prereqs_deterministically() {
        let b = book_with_back_prereqs();
        // 全未读:back 两前置都在(确认 fixture 真产 back)。
        let all = unvisited_back(&b, "1.1", &reading_state(&[])).unwrap();
        let mut lids: Vec<&str> = all.iter().map(|s| s.lid.as_str()).collect();
        lids.sort();
        assert_eq!(lids, vec!["2.1", "2.2"]);
        // 读过 2.1:确定性过滤剩未读 2.2(不靠 agent 心算交集)。
        let un = unvisited_back(&b, "1.1", &reading_state(&["2.1"])).unwrap();
        assert_eq!(
            un.iter().map(|s| s.lid.as_str()).collect::<Vec<_>>(),
            vec!["2.2"]
        );
        // 两前置都读过:空 → agent 走讲法轴原地重讲。
        assert!(unvisited_back(&b, "1.1", &reading_state(&["2.1", "2.2"]))
            .unwrap()
            .is_empty());
        // invalid at → not_found(承 route_from,不静默)。
        let err = unvisited_back(&b, "9.9", &reading_state(&[])).unwrap_err();
        assert_eq!(err.error_code, "LID_NOT_FOUND");
        assert_eq!(err.category, "not_found");
    }

    /// 确定性测试替身:按调用次序吐脚本化 ParsedResponse(loop 每轮调一次 complete)。
    struct FakeAdapter {
        scripted: RefCell<VecDeque<ParsedResponse>>,
    }

    struct RecordingAdapter {
        scripted: RefCell<VecDeque<ParsedResponse>>,
        users: RefCell<Vec<String>>,
    }

    struct StructuredResolverAdapter {
        scripted: RefCell<VecDeque<serde_json::Value>>,
        prompts: RefCell<Vec<String>>,
    }

    impl StructuredResolverAdapter {
        fn new(scripted: Vec<serde_json::Value>) -> Self {
            Self {
                scripted: RefCell::new(scripted.into()),
                prompts: RefCell::new(Vec::new()),
            }
        }
    }

    impl ModelAdapter for StructuredResolverAdapter {
        fn complete(&self, _: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Err(AdapterError {
                message: "structured resolver must not use unstructured complete".into(),
            })
        }

        fn complete_structured(
            &self,
            req: CompletionRequest,
        ) -> Result<serde_json::Value, AdapterError> {
            self.prompts.borrow_mut().push(req.user);
            self.scripted
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "structured resolver script exhausted".into(),
                })
        }

        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("resolver tests do not use outer chat")
        }
    }
    impl FakeAdapter {
        fn new(rs: Vec<ParsedResponse>) -> Self {
            FakeAdapter {
                scripted: RefCell::new(rs.into()),
            }
        }
    }
    impl ModelAdapter for FakeAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.scripted
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("query 内层测的 FakeAdapter 不涉及外层 chat")
        }
    }

    impl RecordingAdapter {
        fn new(rs: Vec<ParsedResponse>) -> Self {
            RecordingAdapter {
                scripted: RefCell::new(rs.into()),
                users: RefCell::new(vec![]),
            }
        }
    }
    impl ModelAdapter for RecordingAdapter {
        fn complete(&self, req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.users.borrow_mut().push(req.user);
            self.scripted
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "recording fake 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("synthesize 测不涉及外层 chat")
        }
    }

    fn book() -> Book {
        // sample_base: "1"(容器)+ "1.1"(叶);entity:command occ=["1.1"]、claim source=1.1。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    fn resolver_book() -> Book {
        let texts = [
            "anchor text about mu and sigma",
            "可学习性 learnability is represented by eta",
            "trend_strategy defines the trend 趋势 policy",
            "drift_mu mentions trend only in a different context",
        ];
        let lids = ["1.1", "2.1", "2.2", "2.3"];
        let mut source = String::new();
        let mut lid_nodes = Vec::new();
        let mut offset = 0usize;
        for (index, (lid, text)) in lids.iter().zip(texts).enumerate() {
            let start = offset;
            source.push_str(text);
            offset += text.encode_utf16().count();
            lid_nodes.push(LidNode {
                lid: (*lid).into(),
                path: vec![u32::try_from(index + 1).unwrap()],
                kind: NodeKind::Paragraph,
                span: Span { start, end: offset },
                children: Vec::new(),
            });
        }
        Book::new(
            ReadOnlyBase {
                book_id: "resolver-book".into(),
                lid_nodes,
                graph_nodes: vec![
                    GraphNode {
                        id: "concept:eta".into(),
                        node_type: GraphNodeType::Concept,
                        name: "eta".into(),
                        occurrences: vec!["2.1".into()],
                        source_lid: None,
                    },
                    GraphNode {
                        id: "concept:mu".into(),
                        node_type: GraphNodeType::Concept,
                        name: "mu".into(),
                        occurrences: vec!["1.1".into()],
                        source_lid: None,
                    },
                    GraphNode {
                        id: "concept:sigma".into(),
                        node_type: GraphNodeType::Concept,
                        name: "sigma".into(),
                        occurrences: vec!["1.1".into()],
                        source_lid: None,
                    },
                    GraphNode {
                        id: "concept:trend_strategy".into(),
                        node_type: GraphNodeType::Concept,
                        name: "trend_strategy".into(),
                        occurrences: vec!["2.2".into()],
                        source_lid: None,
                    },
                    GraphNode {
                        id: "concept:drift_mu".into(),
                        node_type: GraphNodeType::Concept,
                        name: "drift_mu".into(),
                        occurrences: vec!["2.3".into()],
                        source_lid: None,
                    },
                ],
                graph_edges: vec![GraphEdge {
                    source: "concept:eta".into(),
                    target: "concept:trend_strategy".into(),
                    edge_type: "related_fixture".into(),
                    direction: Direction::Directed,
                    scope: EdgeScope::LongRange,
                    weight: 1.0,
                }],
            },
            &source,
        )
        .with_discourse_items(vec![TechnicalLearningDiscourseItem {
            lid: "2.1".into(),
            mode: "explanation".into(),
            local_function: None,
            rhetorical_move: None,
            local_summary: None,
            relations: vec![TechnicalLearningDiscourseRelation {
                target_lid: "2.3".into(),
                relation_type: "contrasts".into(),
                family: None,
                direction: "outgoing".into(),
                confidence: 1.0,
                evidence_lids: Vec::new(),
            }],
        }])
        .with_formula_semantics(vec![FormulaSemantics {
            formula_lid: "2.1".into(),
            parameters: vec![FormulaParameter {
                symbol: "eta".into(),
                label: Some("learnability".into()),
                meaning: "fixture".into(),
                unit: None,
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "2.1".into(),
                meaning: "fixture".into(),
                terms: vec!["eta".into()],
                evidence_lids: Vec::new(),
            },
            context_links: vec![FormulaContextLink {
                target_lid: "2.3".into(),
                relation: "contrasts".into(),
                description: "fixture".into(),
                evidence_lids: Vec::new(),
            }],
        }])
    }

    fn definition_request(query: &str, target: &str) -> BookQueryRequest {
        BookQueryRequest {
            query: query.into(),
            intent: BookQueryIntent::Definition,
            targets: vec![target.into()],
            obligations: vec![QueryObligation {
                requirement: format!("define {target}"),
            }],
            anchor_lid: "1.1".into(),
        }
    }

    fn resolver_response(fits: &[(&str, &str)], probes: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "plan_gate": {"valid": true, "missing_requirements": [], "target_issues": []},
            "candidate_fits": fits.iter().map(|(id, fit)| serde_json::json!({
                "target_index": 0,
                "candidate_id": id,
                "fit": fit,
                "reason": "scripted"
            })).collect::<Vec<_>>(),
            "probes": probes.iter().map(|query| serde_json::json!({
                "target_index": 0,
                "query": query
            })).collect::<Vec<_>>()
        })
    }

    fn supported_response(answer: &str, lid: &str, quote: &str) -> serde_json::Value {
        serde_json::json!({
            "answer": answer,
            "assessments": [{
                "obligation_index": 0,
                "verdict": "supported",
                "citation_lids": [lid],
                "support_note": "source directly supports the obligation"
            }],
            "citations": [{"lid": lid, "text": quote, "role": "support"}],
            "model_supplement": []
        })
    }

    fn resolve_for_test(
        book: &Book,
        request: &BookQueryRequest,
        adapter: &dyn ModelAdapter,
    ) -> Result<ResolutionStage, ToolError> {
        let budgets = QueryBudgets::default();
        let mut audit = QueryAudit::new(request, &budgets);
        resolve_referents(book, request, adapter, &budgets, &mut audit)
    }

    fn book_with_cjk_leaves(n: usize) -> Book {
        let leaf_units = 100usize;
        let mut source = String::new();
        let mut children = Vec::new();
        let mut lid_nodes = Vec::new();
        for i in 1..=n {
            children.push(format!("1.{i}"));
            lid_nodes.push(LidNode {
                lid: format!("1.{i}"),
                path: vec![1, i as u32],
                kind: NodeKind::Paragraph,
                span: Span {
                    start: (i - 1) * leaf_units,
                    end: i * leaf_units,
                },
                children: vec![],
            });
            source.push_str(&"汉".repeat(leaf_units));
        }
        lid_nodes.insert(
            0,
            LidNode {
                lid: "1".into(),
                path: vec![1],
                kind: NodeKind::Chapter,
                span: Span {
                    start: 0,
                    end: n * leaf_units,
                },
                children,
            },
        );
        Book::new(
            ReadOnlyBase {
                book_id: "book-cjk".into(),
                lid_nodes,
                graph_nodes: Vec::<GraphNode>::new(),
                graph_edges: Vec::<GraphEdge>::new(),
            },
            &source,
        )
    }
    fn formula_semantics() -> FormulaSemantics {
        FormulaSemantics {
            formula_lid: "1.2".into(),
            parameters: vec![FormulaParameter {
                symbol: "r".into(),
                label: Some("radius".into()),
                meaning: "圆的半径".into(),
                unit: Some("m".into()),
                domain: None,
                evidence_lids: vec!["1.1".into()],
            }],
            composition: FormulaComposition {
                source_lid: "1.2".into(),
                meaning: "圆面积由半径平方和常数 pi 相乘得到".into(),
                terms: vec!["pi".into(), "r^2".into()],
                evidence_lids: vec!["1.1".into()],
            },
            context_links: vec![],
        }
    }

    fn book_with_discourse_index() -> Book {
        let source = "AAAABBBBCCCC";
        let base = ReadOnlyBase {
            book_id: "discourse-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 8 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 4 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 4, end: 8 },
                    children: vec![],
                },
                LidNode {
                    lid: "2.1".into(),
                    path: vec![2, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 8, end: 12 },
                    children: vec![],
                },
            ],
            graph_nodes: Vec::<GraphNode>::new(),
            graph_edges: Vec::<GraphEdge>::new(),
        };
        Book::new(base, source).with_discourse_items(vec![TechnicalLearningDiscourseItem {
            lid: "1.1".into(),
            mode: "informative".into(),
            local_function: Some("definition".into()),
            rhetorical_move: Some("main_point".into()),
            local_summary: Some("定义核心概念".into()),
            relations: vec![
                TechnicalLearningDiscourseRelation {
                    target_lid: "1.2".into(),
                    relation_type: "elaborates".into(),
                    family: Some("expansion".into()),
                    direction: "forward".into(),
                    confidence: 0.9,
                    evidence_lids: vec!["1.1".into(), "1.2".into()],
                },
                TechnicalLearningDiscourseRelation {
                    target_lid: "2.1".into(),
                    relation_type: "depends_on".into(),
                    family: None,
                    direction: "forward".into(),
                    confidence: 0.8,
                    evidence_lids: vec!["1.1".into(), "2.1".into()],
                },
            ],
        }])
    }
    fn book_with_formula_semantics() -> Book {
        let source = "AAAAAAAAAAAABBBBBBBBBBBBBBB";
        let base = ReadOnlyBase {
            book_id: "formula-book".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span { start: 0, end: 27 },
                    children: vec!["1.1".into(), "1.2".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span { start: 0, end: 12 },
                    children: vec![],
                },
                LidNode {
                    lid: "1.2".into(),
                    path: vec![1, 2],
                    kind: NodeKind::Formula,
                    span: Span { start: 12, end: 27 },
                    children: vec![],
                },
            ],
            graph_nodes: Vec::<GraphNode>::new(),
            graph_edges: Vec::<GraphEdge>::new(),
        };
        Book::new(base, source).with_formula_semantics(vec![formula_semantics()])
    }

    fn cite(lid: &str) -> RawCitation {
        RawCitation {
            lid: lid.into(),
            text: "片段".into(),
            role: "support".into(),
        }
    }

    fn resp(sufficient: bool, cites: Vec<RawCitation>) -> ParsedResponse {
        ParsedResponse {
            sufficient,
            answer: if sufficient {
                Some("答案".into())
            } else {
                None
            },
            citations: cites,
            model_supplement: vec![],
        }
    }

    #[test]
    fn synthesize_includes_only_input_scoped_discourse_hints() {
        let b = book_with_discourse_index();
        let fake = RecordingAdapter::new(vec![resp(true, vec![cite("1.1")])]);
        let out = synthesize(&b, &["1.1".into(), "1.2".into()], Some("综合结构"), &fake).unwrap();
        assert_eq!(out.citations[0].lid, "1.1");
        let prompts = fake.users.borrow();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Discourse 1.1: mode=informative"));
        assert!(prompts[0].contains("local_function=definition"));
        assert!(prompts[0].contains("summary=定义核心概念"));
        assert!(prompts[0]
            .contains("- elaborates -> 1.2 direction=forward confidence=0.90 evidence=[1.1, 1.2]"));
        assert!(!prompts[0].contains("depends_on -> 2.1"));
        assert!(!prompts[0].contains("2.1 direction"));
    }
    #[test]
    fn synthesize_includes_formula_semantics_sidecar_in_prompt() {
        let b = book_with_formula_semantics();
        let fake = RecordingAdapter::new(vec![resp(true, vec![cite("1.2")])]);
        let out = synthesize(&b, &["1.2".into()], Some("解释公式"), &fake).unwrap();
        assert_eq!(out.citations[0].lid, "1.2");
        let prompts = fake.users.borrow();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Composition: 圆面积由半径平方和常数 pi 相乘得到"));
        assert!(prompts[0].contains("- r (radius): 圆的半径 unit=m [1.1]"));
        assert!(!prompts[0].contains("optional_sidecar=not_attached"));
        assert!(out
            .suggested_probing
            .contains(&"解释公式 1.2 的参数、组合含义和适用条件".to_string()));
    }
    #[test]
    fn synthesize_filters_citations_outside_input_lids() {
        let b = book();
        let fake = FakeAdapter::new(vec![resp(true, vec![cite("1.1"), cite("9.9")])]);
        let out = synthesize(&b, &["1.1".into()], Some("总结"), &fake).unwrap();
        assert!(!out.batched);
        assert_eq!(out.source_lids, vec!["1.1"]);
        assert_eq!(out.evidence_chain, vec!["1.1"]);
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].lid, "1.1");
    }

    #[test]
    fn synthesize_rejects_empty_or_unknown_lids() {
        let b = book();
        let fake = FakeAdapter::new(vec![]);
        let empty = synthesize(&b, &[], None, &fake).unwrap_err();
        assert_eq!(empty.error_code, "INVALID_RANGE");
        let missing = synthesize(&b, &["9.9".into()], None, &fake).unwrap_err();
        assert_eq!(missing.error_code, "LID_NOT_FOUND");
    }

    #[test]
    fn synthesize_batches_by_lid_order_and_filters_merge_citations() {
        let b = book_with_cjk_leaves(3);
        let fake = FakeAdapter::new(vec![
            ParsedResponse {
                sufficient: true,
                answer: Some("part 1".into()),
                citations: vec![cite("1.1")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("part 2".into()),
                citations: vec![cite("1.2")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("part 3".into()),
                citations: vec![cite("1.3")],
                model_supplement: vec![],
            },
            ParsedResponse {
                sufficient: true,
                answer: Some("merged".into()),
                citations: vec![cite("1.2"), cite("9.9")],
                model_supplement: vec![],
            },
        ]);
        let out = synthesize(
            &b,
            &["1.1".into(), "1.2".into(), "1.3".into()],
            Some("综合"),
            &fake,
        )
        .unwrap();
        assert!(out.batched);
        assert_eq!(out.answer.as_deref(), Some("merged"));
        assert_eq!(out.source_lids, vec!["1.1", "1.2", "1.3"]);
        assert_eq!(out.evidence_chain, vec!["1.1", "1.2", "1.3"]);
        assert_eq!(out.citations.len(), 1);
        assert_eq!(out.citations[0].lid, "1.2");
    }
    const ALL_RESOLVER_IDS: [&str; 5] = [
        "concept:eta",
        "concept:mu",
        "concept:sigma",
        "concept:trend_strategy",
        "concept:drift_mu",
    ];

    fn fits_with<'a>(selected: &'a [(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        ALL_RESOLVER_IDS
            .iter()
            .map(|id| {
                selected
                    .iter()
                    .find(|(selected_id, _)| selected_id == id)
                    .copied()
                    .unwrap_or((id, "reject"))
            })
            .collect()
    }

    #[test]
    fn learnability_resolves_eta_despite_far_anchor() {
        let fits = fits_with(&[("concept:eta", "semantic_match")]);
        let adapter = StructuredResolverAdapter::new(vec![
            resolver_response(&fits, &[]),
            supported_response(
                "eta 表示可学习性",
                "2.1",
                "可学习性 learnability is represented by eta",
            ),
        ]);
        let request =
            definition_request("可学习性 learnability 是什么意思", "可学习性 learnability");
        let run = query_run_with_budgets(
            &resolver_book(),
            &request,
            &adapter,
            &QueryBudgets::default(),
        )
        .unwrap();
        assert_eq!(run.audit.outcome_status, "complete");
        assert_eq!(run.audit.selected_bindings[0].rank, 1);
        assert_eq!(run.audit.evidence.seed_lids, vec!["2.1"]);
        let QueryOutcome::Complete {
            bindings,
            citations,
            ..
        } = run.response
        else {
            panic!("expected complete query");
        };
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].candidate_id, "concept:eta");
        assert_eq!(bindings[0].source_lids, vec!["2.1"]);
        assert_eq!(citations[0].lid, "2.1");
        assert!(!adapter.prompts.borrow()[0].contains("anchor text about mu and sigma"));
    }

    #[test]
    fn trend_resolves_strategy_not_drift() {
        let fits = fits_with(&[("concept:trend_strategy", "direct_match")]);
        let adapter = StructuredResolverAdapter::new(vec![
            resolver_response(&fits, &[]),
            supported_response(
                "trend_strategy 定义趋势策略",
                "2.2",
                "trend_strategy defines the trend 趋势 policy",
            ),
        ]);
        let request = definition_request("trend 趋势 在书中是什么意思", "trend 趋势");
        let run = query_run_with_budgets(
            &resolver_book(),
            &request,
            &adapter,
            &QueryBudgets::default(),
        )
        .unwrap();
        assert_eq!(run.audit.outcome_status, "complete");
        assert_eq!(run.audit.selected_bindings[0].rank, 1);
        assert_eq!(run.audit.evidence.seed_lids, vec!["2.2"]);
        let QueryOutcome::Complete {
            bindings,
            citations,
            ..
        } = run.response
        else {
            panic!("expected complete query");
        };
        assert_eq!(bindings[0].candidate_id, "concept:trend_strategy");
        assert_eq!(bindings[0].source_lids, vec!["2.2"]);
        assert_eq!(citations[0].lid, "2.2");
    }

    #[test]
    fn resolver_preserves_multiple_viable_meanings_as_ambiguous() {
        let ambiguous_fits = fits_with(&[
            ("concept:eta", "semantic_match"),
            ("concept:mu", "plausible"),
        ]);
        let adapter = StructuredResolverAdapter::new(vec![resolver_response(&ambiguous_fits, &[])]);
        let request = definition_request("可学习性是什么", "可学习性");
        let ResolutionStage::Terminal(QueryOutcome::Ambiguous { candidates, .. }) =
            resolve_for_test(&resolver_book(), &request, &adapter).unwrap()
        else {
            panic!("expected ambiguous outcome");
        };
        assert_eq!(candidates.len(), 2);

        let plausible_fits = fits_with(&[("concept:eta", "plausible")]);
        let adapter = StructuredResolverAdapter::new(vec![resolver_response(&plausible_fits, &[])]);
        assert!(matches!(
            resolve_for_test(&resolver_book(), &request, &adapter).unwrap(),
            ResolutionStage::Terminal(QueryOutcome::Unresolved { .. })
        ));
    }

    #[test]
    fn resolver_retries_three_or_fewer_lexical_probes_once_then_unresolved() {
        let rejected = fits_with(&[]);
        let adapter = StructuredResolverAdapter::new(vec![
            resolver_response(
                &rejected,
                &["eta", "learnability", "可学习性", "forbidden-fourth"],
            ),
            resolver_response(&rejected, &[]),
        ]);
        let request = definition_request("unknown referent", "unknown referent");
        assert!(matches!(
            resolve_for_test(&resolver_book(), &request, &adapter).unwrap(),
            ResolutionStage::Terminal(QueryOutcome::Unresolved { .. })
        ));
        assert_eq!(adapter.prompts.borrow().len(), 2);
    }

    #[test]
    fn plan_gate_rejects_missing_target_or_obligation_without_retrieval() {
        let adapter = StructuredResolverAdapter::new(Vec::new());
        let request = BookQueryRequest {
            targets: Vec::new(),
            obligations: Vec::new(),
            ..definition_request("what is eta", "eta")
        };
        assert!(matches!(
            resolve_for_test(&resolver_book(), &request, &adapter).unwrap(),
            ResolutionStage::Terminal(QueryOutcome::InvalidPlan { .. })
        ));
        assert!(adapter.prompts.borrow().is_empty());
    }

    #[test]
    fn target_evidence_respects_seed_total_char_expansion_and_overflow_budgets() {
        let book = resolver_book();
        let resolved = vec![ResolvedReferent {
            binding: ReferentBinding {
                target: "multi".into(),
                candidate_id: "concept:multi".into(),
                kind: ReferentKind::Concept,
                canonical_label: "multi".into(),
                source_lids: vec!["1.1".into(), "2.1".into(), "2.2".into(), "2.3".into()],
            },
            target_index: 0,
            round: 0,
            selected_rank: 1,
        }];
        let budgets = QueryBudgets::default();
        let mut evidence = build_initial_query_evidence(&book, &resolved, &budgets).unwrap();
        assert_eq!(evidence.seed_lids, vec!["1.1", "2.1", "2.2"]);
        assert!(evidence.texts.len() <= budgets.max_evidence_lids_total);
        assert!(evidence.chars_used <= budgets.max_evidence_chars_total);
        assert!(expand_query_evidence(&book, &resolved, "1.1", &budgets, &mut evidence).unwrap());
        assert_eq!(evidence.expansion_lids, vec!["2.3"]);
        assert_eq!(evidence.expansion_rounds, 1);
        assert!(!expand_query_evidence(&book, &resolved, "1.1", &budgets, &mut evidence).unwrap());

        let tight = QueryBudgets {
            max_evidence_chars_total: 1,
            ..QueryBudgets::default()
        };
        let overflow = build_initial_query_evidence(&book, &resolved, &tight).unwrap();
        assert_eq!(overflow.mandatory_overflow_used, 1);
        assert_eq!(overflow.mandatory_overflow_reasons.len(), 1);
        assert_eq!(overflow.texts.len(), 1);
        assert!(!overflow.skipped_lids.is_empty());
    }

    #[test]
    fn source_lids_prioritize_definition_then_anchor_as_peer_tiebreak() {
        let book = resolver_book();
        let candidate = ReferentCandidate {
            candidate_id: "concept:ordered".into(),
            kind: CatalogReferentKind::Concept,
            sources: vec![CatalogReferentSource::Graph],
            labels: vec!["ordered".into()],
            aliases: Vec::new(),
            recall_strength: CatalogRecallStrength::Direct,
            lexical_score: 1,
            match_reasons: Vec::new(),
            occurrence_lids: vec!["2.3".into(), "2.1".into(), "1.1".into()],
            defined_at_lid: Some("2.2".into()),
            excerpts: Vec::new(),
            hint_only: None,
            anchor_distance: 0,
        };
        assert_eq!(
            ordered_source_lids(&book, "1.1", &candidate),
            vec!["2.2", "1.1", "2.1", "2.3"]
        );
    }

    #[test]
    fn targeted_expansion_uses_only_binding_reachable_landmarks_with_fixed_cap() {
        let book = resolver_book();
        let resolved = vec![ResolvedReferent {
            binding: ReferentBinding {
                target: "eta".into(),
                candidate_id: "concept:eta".into(),
                kind: ReferentKind::Concept,
                canonical_label: "eta".into(),
                source_lids: vec!["2.1".into()],
            },
            target_index: 0,
            round: 0,
            selected_rank: 1,
        }];
        let budgets = QueryBudgets::default();
        let mut evidence = build_initial_query_evidence(&book, &resolved, &budgets).unwrap();
        assert!(expand_query_evidence(&book, &resolved, "1.1", &budgets, &mut evidence).unwrap());
        assert_eq!(evidence.expansion_lids, vec!["1.1", "2.2", "2.3"]);
        assert_eq!(
            evidence.expansion_lids.len(),
            budgets.max_joint_evidence_lids
        );
        assert_eq!(evidence.expansion_rounds, 1);
    }

    #[test]
    fn citation_gate_requires_exact_source_quote_and_rejects_routing_artifacts() {
        let request = definition_request("alpha 是什么", "alpha");
        let evidence = QueryEvidenceBundle {
            texts: BTreeMap::from([("1.1".into(), "line one\r\nline two".into())]),
            ..Default::default()
        };
        let exact: ModelSupportResponse = serde_json::from_value(serde_json::json!({
            "answer": "answer",
            "assessments": [{
                "obligation_index": 0,
                "verdict": "supported",
                "citation_lids": ["1.1"],
                "support_note": "exact"
            }],
            "citations": [{"lid": "1.1", "text": "line one\nline two", "role": "support"}],
            "model_supplement": []
        }))
        .unwrap();
        let exact = structural_support_gate(&request, &evidence, exact);
        assert!(exact.all_supported);

        let polluted: ModelSupportResponse = serde_json::from_value(serde_json::json!({
            "answer": "answer",
            "assessments": [
                {"obligation_index": 0, "verdict": "supported", "citation_lids": ["1.1"], "support_note": "exact"},
                {"obligation_index": 1, "verdict": "supported", "citation_lids": ["1.1"], "support_note": "out of range"}
            ],
            "citations": [
                {"lid": "1.1", "text": "line one", "role": "support"},
                {"lid": "9.9", "text": "invalid extra", "role": "support"}
            ],
            "model_supplement": []
        }))
        .unwrap();
        let polluted = structural_support_gate(&request, &evidence, polluted);
        assert!(polluted.any_supported);
        assert!(!polluted.all_supported);
        assert!(!polluted.assessments_complete);
        assert!(!polluted.citations_valid);
        assert!(matches!(
            query_outcome_from_support(Vec::new(), polluted),
            QueryOutcome::Partial { .. }
        ));

        for (lid, text) in [("1.1", "mismatched quote"), ("preview:alpha", "line one")] {
            let invalid: ModelSupportResponse = serde_json::from_value(serde_json::json!({
                "answer": "unsupported answer",
                "assessments": [{
                    "obligation_index": 0,
                    "verdict": "supported",
                    "citation_lids": [lid],
                    "support_note": "claimed"
                }],
                "citations": [{"lid": lid, "text": text, "role": "support"}],
                "model_supplement": []
            }))
            .unwrap();
            let invalid = structural_support_gate(&request, &evidence, invalid);
            assert!(!invalid.any_supported);
            assert!(invalid.citations.is_empty());
        }
    }

    #[test]
    fn query_outcome_aggregates_obligation_support_without_semantic_rule_tables() {
        let request = BookQueryRequest {
            query: "compare alpha and beta".into(),
            intent: BookQueryIntent::Comparison,
            targets: vec!["alpha".into(), "beta".into()],
            obligations: vec![
                QueryObligation {
                    requirement: "define alpha".into(),
                },
                QueryObligation {
                    requirement: "compare beta".into(),
                },
            ],
            anchor_lid: "1.1".into(),
        };
        let evidence = QueryEvidenceBundle {
            texts: BTreeMap::from([("1.1".into(), "alpha source".into())]),
            ..Default::default()
        };
        let response: ModelSupportResponse = serde_json::from_value(serde_json::json!({
            "answer": "partial answer",
            "assessments": [
                {"obligation_index": 0, "verdict": "supported", "citation_lids": ["1.1"], "support_note": "yes"},
                {"obligation_index": 1, "verdict": "unsupported", "citation_lids": [], "support_note": "missing"}
            ],
            "citations": [{"lid": "1.1", "text": "alpha source", "role": "support"}],
            "model_supplement": []
        }))
        .unwrap();
        let partial = structural_support_gate(&request, &evidence, response);
        assert!(matches!(
            query_outcome_from_support(Vec::new(), partial),
            QueryOutcome::Partial { .. }
        ));

        let unsupported: ModelSupportResponse = serde_json::from_value(serde_json::json!({
            "answer": "must be discarded",
            "assessments": [
                {"obligation_index": 0, "verdict": "unsupported", "citation_lids": [], "support_note": "missing"},
                {"obligation_index": 1, "verdict": "uncertain", "citation_lids": [], "support_note": "uncertain"}
            ],
            "citations": [],
            "model_supplement": []
        }))
        .unwrap();
        let insufficient = structural_support_gate(&request, &evidence, unsupported);
        let QueryOutcome::Insufficient { answer, .. } =
            query_outcome_from_support(Vec::new(), insufficient)
        else {
            panic!("expected insufficient");
        };
        assert!(answer.is_none());
    }

    #[test]
    fn book_query_request_validation_enforces_intent_counts_and_atomic_obligations() {
        let valid = BookQueryRequest {
            query: "比较 eta 与 mu".into(),
            intent: BookQueryIntent::Comparison,
            targets: vec!["eta".into(), "mu".into()],
            obligations: vec![QueryObligation {
                requirement: "说明两者差异".into(),
            }],
            anchor_lid: "1.1".into(),
        };
        assert_eq!(validate_book_query_request(&valid), Ok(()));

        let invalid = BookQueryRequest {
            targets: vec!["eta".into()],
            obligations: vec![QueryObligation {
                requirement: " ".into(),
            }],
            ..valid
        };
        let Err(QueryOutcome::InvalidPlan {
            missing_requirements,
            target_issues,
        }) = validate_book_query_request(&invalid)
        else {
            panic!("expected invalid plan");
        };
        assert!(!missing_requirements.is_empty());
        assert!(!target_issues.is_empty());
    }

    #[test]
    fn legacy_book_query_wire_is_not_silently_accepted() {
        let outcome = parse_book_query_request(serde_json::json!({
            "q": "命令模式是什么",
            "anchor_lid": "1.1"
        }))
        .unwrap_err();
        assert!(matches!(outcome, QueryOutcome::InvalidPlan { .. }));
    }

    // S9 判据①:纯 JSON / 带围栏 / 前后包散文 三形态都抽对。
    #[test]
    fn extract_json_three_forms() {
        // 纯 JSON
        let pure = r#"{"sufficient": true, "answer": "x"}"#;
        assert_eq!(extract_json_object(pure), Some(pure));
        // markdown ```json 围栏
        assert_eq!(
            extract_json_object("```json\n{\"a\": 1}\n```"),
            Some("{\"a\": 1}")
        );
        // 前后包散文(模型啰嗦)
        assert_eq!(
            extract_json_object("好的,结果如下:{\"a\": 1} 希望有帮助。"),
            Some("{\"a\": 1}")
        );
    }

    // S9:跳过字符串字面量内的括号与转义 → 不被引号内的 } / { 提前截断。
    #[test]
    fn extract_json_skips_braces_in_strings() {
        let s = r#"前缀 {"text": "含 } 和 { 的引文", "n": 1} 后缀"#;
        assert_eq!(
            extract_json_object(s),
            Some(r#"{"text": "含 } 和 { 的引文", "n": 1}"#)
        );
        // 转义引号不误判字符串结束
        let esc = r#"{"text": "他说 \"x}\" 完"}"#;
        assert_eq!(extract_json_object(esc), Some(esc));
    }

    // S9 判据②前提:空内容 / 纯散文(无对象)→ None → 调用方报 PROVIDER_ERROR 不静默成功。
    #[test]
    fn extract_json_none_when_no_object() {
        assert_eq!(extract_json_object(""), None);
        assert_eq!(extract_json_object("   "), None);
        assert_eq!(extract_json_object("纯散文,没有任何 JSON 对象"), None);
        // 不平衡(只开不闭)→ 扫到末尾 depth>0 → None,不返回半截
        assert_eq!(extract_json_object(r#"{"a": 1"#), None);
    }

    #[test]
    fn provider_config_defaults_native_and_selects_react() {
        let native = ProviderConfig::from_getter(|k| match k {
            "OPENCODE_API_KEY" => Some("key".into()),
            "OPENCODE_BASE_URL" => Some("http://localhost:1234".into()),
            "FLUID_LLM_MODEL" => Some("model".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(native.mode, ProviderMode::Native);

        let react = ProviderConfig::from_getter(|k| match k {
            "UNDERSTAND_BOOK_PROVIDER" => Some("react".into()),
            "OPENCODE_API_KEY" => Some("key".into()),
            "OPENCODE_BASE_URL" => Some("http://localhost:1234".into()),
            "FLUID_LLM_MODEL" => Some("model".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(react.mode, ProviderMode::ReAct);
    }

    #[test]
    fn provider_config_from_values_validates_and_normalizes() {
        let config = ProviderConfig::from_values(
            "react",
            " secret ",
            "https://provider.example/v1/",
            " model-name ",
        )
        .unwrap();
        assert_eq!(config.mode, ProviderMode::ReAct);
        assert_eq!(config.api_key, "secret");
        assert_eq!(config.base_url, "https://provider.example/v1");
        assert_eq!(config.model, "model-name");

        assert!(ProviderConfig::from_values("native", "", "https://example.com", "m").is_err());
        assert!(ProviderConfig::from_values("native", "k", "file:///tmp", "m").is_err());
        assert!(ProviderConfig::from_values("unknown", "k", "https://example.com", "m").is_err());
    }

    #[test]
    fn provider_tool_name_sanitizes_dotted_names_and_collisions() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(provider_tool_name("book.text", 0, &mut used), "book_text");
        assert_eq!(provider_tool_name("book_text", 1, &mut used), "book_text_2");
        assert_eq!(provider_tool_name("工具", 2, &mut used), "tool_3");
        assert!(provider_tool_name(&"a".repeat(80), 3, &mut used).len() <= 64);
    }

    fn accept_with_timeout(listener: &TcpListener) -> TcpStream {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("accept failed: {e}"),
            }
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0_u8; 1024];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&buf[..n]);
                    if http_request_complete(&bytes) {
                        break;
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    break;
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn http_request_complete(bytes: &[u8]) -> bool {
        let Some(header_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            return false;
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end + 4]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        bytes.len() >= header_end + 4 + content_length
    }

    #[test]
    fn native_adapter_requests_and_parses_structured_json() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = std::thread::spawn(move || {
            let mut stream = accept_with_timeout(&listener);
            let request = read_http_request(&mut stream);
            assert!(request.contains(r#""response_format":{"type":"json_object"}"#));
            assert!(request.contains("compare evidence"));
            let content = r#"{"choices":[{"message":{"content":"```json\n{\"summary\":\"different\",\"confidence\":0.8}\n```"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content.len(),
                content
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let adapter = NativeAdapter::from_config(ProviderConfig {
            mode: ProviderMode::Native,
            api_key: "test-key".into(),
            base_url: format!("http://{addr}"),
            model: "test-model".into(),
        });
        let output = adapter
            .complete_structured(CompletionRequest {
                system: "structured system".into(),
                user: "compare evidence".into(),
            })
            .unwrap();

        handle.join().unwrap();
        assert_eq!(output["summary"], "different");
        assert_eq!(output["confidence"], 0.8);
    }

    #[test]
    fn provider_registry_timeout_factory_bounds_native_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = std::thread::spawn(move || {
            let mut stream = accept_with_timeout(&listener);
            let _ = read_http_request(&mut stream);
            std::thread::sleep(Duration::from_millis(300));
        });

        let adapter = ProviderRegistry::adapter_from_config_with_timeout(
            ProviderConfig {
                mode: ProviderMode::Native,
                api_key: "test-key".into(),
                base_url: format!("http://{addr}"),
                model: "test-model".into(),
            },
            Duration::from_millis(50),
        );
        let started = Instant::now();
        let error = adapter
            .complete_structured(CompletionRequest {
                system: "structured system".into(),
                user: "timeout request".into(),
            })
            .unwrap_err();
        let elapsed = started.elapsed();

        handle.join().unwrap();
        assert!(elapsed < Duration::from_millis(250), "elapsed={elapsed:?}");
        assert!(error.message.contains("HTTP 请求失败"), "{error:?}");
    }

    #[test]
    fn native_adapter_retries_once_after_transport_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = Arc::clone(&hits);

        let handle = std::thread::spawn(move || {
            let mut first = accept_with_timeout(&listener);
            server_hits.fetch_add(1, Ordering::SeqCst);
            let _ = read_http_request(&mut first);
            drop(first);

            let mut second = accept_with_timeout(&listener);
            server_hits.fetch_add(1, Ordering::SeqCst);
            let _ = read_http_request(&mut second);
            let content = r#"{"choices":[{"message":{"content":"{\"sufficient\":true,\"answer\":\"ok\",\"citations\":[],\"model_supplement\":[]}"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content.len(),
                content
            );
            second.write_all(response.as_bytes()).unwrap();
        });

        let adapter = NativeAdapter::from_config(ProviderConfig {
            mode: ProviderMode::Native,
            api_key: "test-key".into(),
            base_url: format!("http://{addr}"),
            model: "test-model".into(),
        });
        let out = adapter
            .complete(CompletionRequest {
                system: "system".into(),
                user: "user".into(),
            })
            .unwrap();

        handle.join().unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert!(out.sufficient);
        assert_eq!(out.answer.as_deref(), Some("ok"));
    }

    #[test]
    fn native_adapter_does_not_retry_http_status_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = Arc::clone(&hits);

        let handle = std::thread::spawn(move || {
            let mut stream = accept_with_timeout(&listener);
            server_hits.fetch_add(1, Ordering::SeqCst);
            let _ = read_http_request(&mut stream);
            let content = r#"{"error":{"message":"bad tools"}}"#;
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content.len(),
                content
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let adapter = NativeAdapter::from_config(ProviderConfig {
            mode: ProviderMode::Native,
            api_key: "test-key".into(),
            base_url: format!("http://{addr}"),
            model: "test-model".into(),
        });
        let err = adapter
            .complete(CompletionRequest {
                system: "system".into(),
                user: "user".into(),
            })
            .unwrap_err();

        handle.join().unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(err.message.contains("HTTP 请求失败"));
        assert!(err.message.contains("bad tools"));
        assert!(!err.message.contains("重试一次"));
    }

    #[test]
    fn native_adapter_maps_provider_safe_tool_names_back_to_runtime_names() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = std::thread::spawn(move || {
            let mut stream = accept_with_timeout(&listener);
            let request = read_http_request(&mut stream);
            assert!(request.contains(r#""name":"book_text""#), "{request}");
            assert!(!request.contains(r#""name":"book.text""#), "{request}");
            let content = r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"book_text","arguments":"{\"lid\":\"1.1\"}"}}]}}],"usage":{"total_tokens":3}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content.len(),
                content
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let adapter = NativeAdapter::from_config(ProviderConfig {
            mode: ProviderMode::Native,
            api_key: "test-key".into(),
            base_url: format!("http://{addr}"),
            model: "test-model".into(),
        });
        let out = adapter
            .chat(
                &[
                    Message::user("show text"),
                    Message {
                        role: Role::Assistant,
                        content: None,
                        tool_calls: vec![ToolCall {
                            id: "call_prev".into(),
                            name: "book.text".into(),
                            arguments: "{}".into(),
                        }],
                        tool_call_id: None,
                    },
                    Message {
                        role: Role::Tool,
                        content: Some("previous result".into()),
                        tool_calls: vec![],
                        tool_call_id: Some("call_prev".into()),
                    },
                ],
                &[ToolSpec {
                    name: "book.text".into(),
                    description: "Read text by lid".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {"lid": {"type": "string"}},
                        "required": ["lid"],
                    }),
                }],
            )
            .unwrap();

        handle.join().unwrap();
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(out.tool_calls[0].name, "book.text");
        assert_eq!(out.tool_calls[0].arguments, r#"{"lid":"1.1"}"#);
        assert_eq!(out.usage_total_tokens, Some(3));
    }

    #[test]
    fn react_parser_normalizes_tool_calls_and_final_answer() {
        let turn = parse_react_assistant_turn(
            r#"```json
{"tool_calls":[{"name":"book.text","arguments":{"lid":"1.1"}}],"usage_total_tokens":7}
```"#,
        )
        .unwrap();
        assert_eq!(turn.usage_total_tokens, Some(7));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].id, "react_1");
        assert_eq!(turn.tool_calls[0].name, "book.text");
        assert_eq!(turn.tool_calls[0].arguments, r#"{"lid":"1.1"}"#);

        let final_turn = parse_react_assistant_turn(r#"{"final":"读完了"}"#).unwrap();
        assert_eq!(final_turn.text.as_deref(), Some("读完了"));
        assert!(final_turn.tool_calls.is_empty());
    }

    #[test]
    fn react_parser_rejects_malformed_provider_output() {
        let err = parse_react_assistant_turn("我想调用 book.text").unwrap_err();
        assert!(err.message.contains("ReAct 输出抽不到合法 JSON 对象"));
        let err = parse_react_assistant_turn(r#"{"tool_calls":[{"arguments":{}}]}"#).unwrap_err();
        assert!(err.message.contains("缺 name"));
    }
}
