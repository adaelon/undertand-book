use schemars::{gen::SchemaGenerator, JsonSchema};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use ts_rs::TS;

pub const BOOK_TOOL_CONTRACT_VERSION: &str = "book_tool_contract.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub enum BookToolId {
    Manifest,
    Text,
    SearchText,
    Context,
    Concept,
    Structure,
    GuidePath,
    PaperMetadata,
    PaperLexicon,
    PaperReadingGuide,
    Query,
    Synthesize,
    Guide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceAliases {
    pub resident: Option<&'static str>,
    pub mcp: Option<&'static str>,
    pub rest: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookToolContract {
    pub id: BookToolId,
    pub version: &'static str,
    pub aliases: SurfaceAliases,
    pub description: &'static str,
    pub use_when: &'static str,
    pub do_not_use_when: &'static str,
    pub result_contract: &'static str,
}

const CONTRACTS: &[BookToolContract] = &[
    contract(
        BookToolId::Manifest,
        None,
        Some("book_manifest"),
        Some("manifest"),
        "Return the read-only book manifest.",
        "Inspect public book identity and structure metadata.",
        "Do not expose the full manifest to the Resident model surface.",
        "book_manifest.v1",
    ),
    contract(
        BookToolId::Text,
        Some("book.text"),
        Some("book_text"),
        Some("text"),
        "按 LID 或 LID 区间取真原文。",
        "Read source text after a LID has been located.",
        "Do not use for lexical discovery when no LID is known.",
        "book_text.v1",
    ),
    contract(
        BookToolId::SearchText,
        Some("book.search_text"),
        Some("book_search_text"),
        Some("search_text"),
        "在规范全文中枚举字面文本的完整 occurrence 集,返回稳定原文 UTF-16 ranges、总数与分页游标。",
        "Locate the first, previous, or every lexical occurrence before interpreting it.",
        "Do not use lexical exhaustiveness as proof of semantic exhaustiveness.",
        "search_text.v1",
    ),
    contract(
        BookToolId::Context,
        Some("book.context"),
        Some("book_context"),
        Some("context"),
        "取某 LID 的上下文指针:near=树邻接+local 边,mid=near+概念/实体其他 occurrences,far=mid+long_range 边;不带原文,用 book.text 取内容。",
        "Expand around a verified LID through deterministic context links.",
        "Do not treat pointers as source text.",
        "book_context.v1",
    ),
    contract(
        BookToolId::Concept,
        Some("book.concept"),
        Some("book_concept"),
        Some("concept"),
        "按名查概念/实体,返回全量出现 LID + 关联实体。",
        "Resolve an indexed concept or entity name.",
        "Do not use for arbitrary literal full-text search.",
        "book_concept.v1",
    ),
    contract(
        BookToolId::Structure,
        Some("book.structure"),
        Some("book_structure"),
        Some("structure"),
        "BookStructure 结构投影:说明某 LID 在全书 spine/throughline/key_stop 中的结构意义。缺 at 时返回全书结构概览;缺 sidecar 时显式 unavailable。",
        "Inspect the structural role of a LID or the whole-book overview.",
        "Do not use as a source-text search surface.",
        "book_structure.v1",
    ),
    contract(
        BookToolId::GuidePath,
        Some("book.guide_path"),
        Some("book_guide_path"),
        Some("guide_path"),
        "BookStructure 宏观带读路线:按 spine 分段展开 key_stops,不理解自然语言、不读取 reader/memory。缺 sidecar 时显式 unavailable。",
        "Choose macro reading stops from BookStructure.",
        "Do not use for semantic question answering.",
        "book_guide_path.v1",
    ),
    contract(
        BookToolId::PaperMetadata,
        Some("book.paper_metadata"),
        Some("book_paper_metadata"),
        Some("paper_metadata"),
        "返回当前单篇 paper 的 metadata projection,保留 value/source/evidence_lids/confidence;缺 sidecar 时 explicit unavailable,不生成跨论文关系。",
        "Read the current paper metadata projection.",
        "Do not infer cross-paper relations.",
        "paper_metadata_projection.v1",
    ),
    contract(
        BookToolId::PaperLexicon,
        Some("book.paper_lexicon"),
        Some("book_paper_lexicon"),
        Some("paper_lexicon"),
        "返回当前单篇 paper 的 lexicon projection,用于术语/缩写/数据集候选对齐;缺 sidecar 时 explicit unavailable。",
        "Align paper terms, abbreviations, and dataset candidates.",
        "Do not treat candidates as verified definitions without source text.",
        "paper_lexicon_projection.v1",
    ),
    contract(
        BookToolId::PaperReadingGuide,
        Some("book.paper_reading_guide"),
        Some("book_paper_reading_guide"),
        Some("paper_reading_guide"),
        "PaperReadingGuide 只读投影:组合 paper metadata/lexicon、BookStructure、graph、discourse 与原文,返回论文十问、Codebook、摘要阅读辅助。不会新增或修改持久 truth。",
        "Read a deterministic paper-reading projection.",
        "Do not use it to mutate persistent truth.",
        "paper_reading_guide.v1",
    ),
    contract(
        BookToolId::Query,
        Some("book.query"),
        Some("book_query"),
        Some("query"),
        "对显式 referent 做自含语义问答:先解析 targets,再围绕冻结指代读取来源证据。",
        "Answer definition, explanation, relation, or comparison obligations for explicit referents.",
        "Do not use for literal occurrence location.",
        "book_query.v1",
    ),
    contract(
        BookToolId::Synthesize,
        Some("book.synthesize"),
        Some("book_synthesize"),
        Some("synthesize"),
        "对调用方给定的离散 LID 集做综合;不外扩检索,返回 citations ⊆ 输入 lids 的综合回答。",
        "Synthesize a caller-supplied, frozen set of LIDs.",
        "Do not expand evidence beyond the supplied LIDs.",
        "book_synthesize.v1",
    ),
    contract(
        BookToolId::Guide,
        None,
        Some("book_guide"),
        None,
        "Open, refine, or close an ephemeral visitor guide session.",
        "Maintain a visitor-only ephemeral guided-reading cursor.",
        "Do not read Resident reader or memory state.",
        "book_guide.v1",
    ),
];

const fn contract(
    id: BookToolId,
    resident: Option<&'static str>,
    mcp: Option<&'static str>,
    rest: Option<&'static str>,
    description: &'static str,
    use_when: &'static str,
    do_not_use_when: &'static str,
    result_contract: &'static str,
) -> BookToolContract {
    BookToolContract {
        id,
        version: BOOK_TOOL_CONTRACT_VERSION,
        aliases: SurfaceAliases {
            resident,
            mcp,
            rest,
        },
        description,
        use_when,
        do_not_use_when,
        result_contract,
    }
}

pub fn contracts() -> &'static [BookToolContract] {
    CONTRACTS
}

pub fn contract_for(id: BookToolId) -> &'static BookToolContract {
    CONTRACTS
        .iter()
        .find(|contract| contract.id == id)
        .expect("every BookToolId must have a contract")
}

pub fn from_resident_alias(name: &str) -> Option<BookToolId> {
    from_alias(name, |aliases| aliases.resident)
}

pub fn from_mcp_alias(name: &str) -> Option<BookToolId> {
    from_alias(name, |aliases| aliases.mcp)
}

pub fn from_rest_alias(name: &str) -> Option<BookToolId> {
    from_alias(name, |aliases| aliases.rest)
}

fn from_alias(
    name: &str,
    projection: impl Fn(SurfaceAliases) -> Option<&'static str>,
) -> Option<BookToolId> {
    CONTRACTS
        .iter()
        .find(|contract| projection(contract.aliases) == Some(name))
        .map(|contract| contract.id)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EmptyInput {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextInput {
    pub lid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_lid: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextGranularity {
    Near,
    Mid,
    Far,
}

impl ContextGranularity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Near => "near",
            Self::Mid => "mid",
            Self::Far => "far",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextInput {
    pub lid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granularity: Option<ContextGranularity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConceptInput {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AtInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaperMode {
    Skim,
    Close,
    Deep,
}

impl PaperMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skim => "skim",
            Self::Close => "close",
            Self::Deep => "deep",
        }
    }
}

impl Default for PaperMode {
    fn default() -> Self {
        Self::Skim
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaperStage {
    Passive,
    Active,
    Critical,
    Creative,
}

impl PaperStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passive => "passive",
            Self::Active => "active",
            Self::Critical => "critical",
            Self::Creative => "creative",
        }
    }
}

impl Default for PaperStage {
    fn default() -> Self {
        Self::Passive
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PaperReadingGuideInput {
    #[serde(default)]
    pub mode: PaperMode,
    #[serde(default)]
    pub stage: PaperStage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub enum BookQueryIntent {
    Definition,
    Explanation,
    Relation,
    Comparison,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct QueryObligation {
    pub requirement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct BookQueryRequest {
    pub query: String,
    pub intent: BookQueryIntent,
    #[schemars(length(min = 1, max = 3))]
    pub targets: Vec<String>,
    #[schemars(length(min = 1, max = 3))]
    pub obligations: Vec<QueryObligation>,
    pub anchor_lid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SynthesizeInput {
    #[schemars(length(min = 1))]
    pub lids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuideAction {
    Guide,
    Close,
}

impl Default for GuideAction {
    fn default() -> Self {
        Self::Guide
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuideInput {
    #[serde(default)]
    pub action: GuideAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_lid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchMatchMode {
    Exact,
    Normalized,
}

impl Default for SearchMatchMode {
    fn default() -> Self {
        Self::Exact
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchRelativeDirection {
    Before,
    After,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchRelativeScope {
    pub lid: String,
    pub direction: SearchRelativeDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct SearchTextScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within_lid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_to: Option<SearchRelativeScope>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchOrder {
    Document,
    ReverseDocument,
}

impl Default for SearchOrder {
    fn default() -> Self {
        Self::Document
    }
}

fn default_search_page_size() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchTextInput {
    pub query: String,
    #[serde(default)]
    pub match_mode: SearchMatchMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<SearchTextScope>,
    #[serde(default)]
    pub order: SearchOrder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_search_page_size")]
    #[schemars(range(min = 1, max = 50))]
    pub page_size: usize,
}

pub fn search_text_input_schema() -> Value {
    schema_value::<SearchTextInput>()
}

pub fn validate_search_text_input(
    value: Value,
) -> Result<SearchTextInput, ContractValidationError> {
    let input: SearchTextInput = parse(value)?;
    validate_search_text_semantics(&input)?;
    Ok(input)
}

fn validate_search_text_semantics(input: &SearchTextInput) -> Result<(), ContractValidationError> {
    let query_length = input.query.chars().count();
    if input.query.trim().is_empty() {
        return Err(ContractValidationError {
            code: "SEARCH_QUERY_EMPTY",
            message: "search query must contain non-whitespace text".into(),
        });
    }
    if query_length > 4096 {
        return Err(ContractValidationError {
            code: "SEARCH_QUERY_TOO_LONG",
            message: "search query must contain at most 4096 Unicode scalar values".into(),
        });
    }
    if !(1..=50).contains(&input.page_size) {
        return Err(ContractValidationError {
            code: "BOOK_TOOL_INPUT_INVALID",
            message: "page_size must be between 1 and 50".into(),
        });
    }
    if let Some(scope) = &input.scope {
        if scope
            .within_lid
            .as_deref()
            .is_some_and(|lid| lid.trim().is_empty())
            || scope
                .relative_to
                .as_ref()
                .is_some_and(|relative| relative.lid.trim().is_empty())
        {
            return Err(ContractValidationError {
                code: "SEARCH_SCOPE_INVALID",
                message: "scope LIDs must not be empty".into(),
            });
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookToolInput {
    Empty(EmptyInput),
    Text(TextInput),
    SearchText(SearchTextInput),
    Context(ContextInput),
    Concept(ConceptInput),
    At(AtInput),
    PaperReadingGuide(PaperReadingGuideInput),
    Query(BookQueryRequest),
    Synthesize(SynthesizeInput),
    Guide(GuideInput),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractValidationError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryValidationIssues {
    pub missing_requirements: Vec<String>,
    pub target_issues: Vec<String>,
}

pub fn input_schema(id: BookToolId) -> Value {
    match id {
        BookToolId::Manifest | BookToolId::PaperMetadata | BookToolId::PaperLexicon => {
            schema_value::<EmptyInput>()
        }
        BookToolId::Text => schema_value::<TextInput>(),
        BookToolId::SearchText => search_text_input_schema(),
        BookToolId::Context => schema_value::<ContextInput>(),
        BookToolId::Concept => schema_value::<ConceptInput>(),
        BookToolId::Structure | BookToolId::GuidePath => schema_value::<AtInput>(),
        BookToolId::PaperReadingGuide => schema_value::<PaperReadingGuideInput>(),
        BookToolId::Query => schema_value::<BookQueryRequest>(),
        BookToolId::Synthesize => schema_value::<SynthesizeInput>(),
        BookToolId::Guide => schema_value::<GuideInput>(),
    }
}

fn schema_value<T: JsonSchema>() -> Value {
    let root = SchemaGenerator::default().into_root_schema_for::<T>();
    let mut value = serde_json::to_value(root).expect("JsonSchema must serialize");
    let definitions = value
        .get("definitions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    inline_tool_schema(&mut value, &definitions);
    if let Some(object) = value.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
        object.remove("definitions");
    }
    value
}

fn inline_tool_schema(value: &mut Value, definitions: &serde_json::Map<String, Value>) {
    let referenced = value
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix("#/definitions/"))
        .and_then(|name| definitions.get(name))
        .cloned();
    if let Some(mut referenced) = referenced {
        if let (Some(target), Some(source)) = (referenced.as_object_mut(), value.as_object()) {
            for (key, value) in source {
                if key != "$ref" {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        *value = referenced;
        inline_tool_schema(value, definitions);
        return;
    }

    let single_all_of = value
        .get("allOf")
        .and_then(Value::as_array)
        .filter(|variants| variants.len() == 1)
        .and_then(|variants| variants.first())
        .cloned();
    if let Some(mut single_all_of) = single_all_of {
        if let (Some(target), Some(source)) = (single_all_of.as_object_mut(), value.as_object()) {
            for (key, value) in source {
                if key != "allOf" {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        *value = single_all_of;
        inline_tool_schema(value, definitions);
        return;
    }

    let optional_inner = value
        .get("anyOf")
        .and_then(Value::as_array)
        .filter(|variants| variants.len() == 2)
        .and_then(|variants| {
            let has_null = variants
                .iter()
                .any(|variant| variant.get("type") == Some(&Value::String("null".into())));
            has_null
                .then(|| {
                    variants
                        .iter()
                        .find(|variant| variant.get("type") != Some(&Value::String("null".into())))
                        .cloned()
                })
                .flatten()
        });
    if let Some(optional_inner) = optional_inner {
        *value = optional_inner;
        inline_tool_schema(value, definitions);
        return;
    }

    match value {
        Value::Array(values) => {
            for value in values {
                inline_tool_schema(value, definitions);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                inline_tool_schema(value, definitions);
            }
        }
        _ => {}
    }
}

pub fn validate_input(
    id: BookToolId,
    value: Value,
) -> Result<BookToolInput, ContractValidationError> {
    let input = match id {
        BookToolId::Manifest | BookToolId::PaperMetadata | BookToolId::PaperLexicon => {
            BookToolInput::Empty(parse(value)?)
        }
        BookToolId::Text => BookToolInput::Text(parse(value)?),
        BookToolId::SearchText => BookToolInput::SearchText(parse(value)?),
        BookToolId::Context => BookToolInput::Context(parse(value)?),
        BookToolId::Concept => BookToolInput::Concept(parse(value)?),
        BookToolId::Structure | BookToolId::GuidePath => BookToolInput::At(parse(value)?),
        BookToolId::PaperReadingGuide => BookToolInput::PaperReadingGuide(parse(value)?),
        BookToolId::Query => BookToolInput::Query(parse(value)?),
        BookToolId::Synthesize => BookToolInput::Synthesize(parse(value)?),
        BookToolId::Guide => BookToolInput::Guide(parse(value)?),
    };
    validate_semantics(id, &input)?;
    Ok(input)
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, ContractValidationError> {
    serde_json::from_value(value).map_err(|error| ContractValidationError {
        code: "BOOK_TOOL_INPUT_INVALID",
        message: error.to_string(),
    })
}

fn validate_semantics(
    id: BookToolId,
    input: &BookToolInput,
) -> Result<(), ContractValidationError> {
    let invalid = |message: String| ContractValidationError {
        code: "BOOK_TOOL_INPUT_INVALID",
        message,
    };
    match (id, input) {
        (BookToolId::Text, BookToolInput::Text(input)) => {
            require_non_empty("lid", &input.lid)?;
            if let Some(end_lid) = &input.end_lid {
                require_non_empty("end_lid", end_lid)?;
            }
        }
        (BookToolId::SearchText, BookToolInput::SearchText(input)) => {
            validate_search_text_semantics(input)?;
        }
        (BookToolId::Context, BookToolInput::Context(input)) => {
            require_non_empty("lid", &input.lid)?;
        }
        (BookToolId::Concept, BookToolInput::Concept(input)) => {
            require_non_empty("name", &input.name)?;
        }
        (BookToolId::Structure | BookToolId::GuidePath, BookToolInput::At(input)) => {
            if let Some(at) = &input.at {
                require_non_empty("at", at)?;
            }
        }
        (BookToolId::Query, BookToolInput::Query(input)) => {
            if let Err(issues) = validate_query_request(input) {
                return Err(invalid(format!(
                    "query validation failed: missing={:?}; targets={:?}",
                    issues.missing_requirements, issues.target_issues
                )));
            }
        }
        (BookToolId::Synthesize, BookToolInput::Synthesize(input)) => {
            if input.lids.is_empty() {
                return Err(invalid("lids must contain at least one item".into()));
            }
            for lid in &input.lids {
                require_non_empty("lids[]", lid)?;
            }
        }
        (BookToolId::Guide, BookToolInput::Guide(input)) => match input.action {
            GuideAction::Guide => {
                let intent = input.intent.as_deref().unwrap_or_default();
                require_non_empty("intent", intent)?;
            }
            GuideAction::Close => {
                let session_id = input.session_id.as_deref().unwrap_or_default();
                require_non_empty("session_id", session_id)?;
            }
        },
        _ => {}
    }
    Ok(())
}

fn require_non_empty(field: &str, value: &str) -> Result<(), ContractValidationError> {
    if value.trim().is_empty() {
        Err(ContractValidationError {
            code: "BOOK_TOOL_INPUT_INVALID",
            message: format!("{field} must not be empty"),
        })
    } else {
        Ok(())
    }
}

pub fn validate_query_request(request: &BookQueryRequest) -> Result<(), QueryValidationIssues> {
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
        Err(QueryValidationIssues {
            missing_requirements,
            target_issues,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aliases_are_unique_per_surface() {
        fn assert_unique(values: Vec<&'static str>) {
            let unique: HashSet<_> = values.iter().copied().collect();
            assert_eq!(unique.len(), values.len());
        }
        assert_unique(
            contracts()
                .iter()
                .filter_map(|contract| contract.aliases.resident)
                .collect(),
        );
        assert_unique(
            contracts()
                .iter()
                .filter_map(|contract| contract.aliases.mcp)
                .collect(),
        );
        assert_unique(
            contracts()
                .iter()
                .filter_map(|contract| contract.aliases.rest)
                .collect(),
        );
    }

    #[test]
    fn resident_contract_schema_is_closed_and_typed() {
        for contract in contracts()
            .iter()
            .filter(|contract| contract.aliases.resident.is_some())
        {
            assert_eq!(
                input_schema(contract.id)["additionalProperties"],
                Value::Bool(false),
                "{}",
                contract.aliases.resident.unwrap()
            );
        }
        assert_eq!(input_schema(BookToolId::Text)["required"], json!(["lid"]));
        assert_eq!(
            input_schema(BookToolId::Context)["properties"]["granularity"]["enum"],
            json!(["near", "mid", "far"])
        );
        assert_eq!(
            input_schema(BookToolId::PaperReadingGuide)["properties"]["mode"]["default"],
            "skim"
        );
        assert_eq!(
            input_schema(BookToolId::PaperReadingGuide)["properties"]["mode"]["enum"],
            json!(["skim", "close", "deep"])
        );
        assert_eq!(
            input_schema(BookToolId::PaperReadingGuide)["properties"]["stage"]["default"],
            "passive"
        );
    }

    #[test]
    fn query_validator_enforces_intent_dependent_target_count() {
        let value = json!({
            "query": "How are alpha and beta related?",
            "intent": "relation",
            "targets": ["alpha"],
            "obligations": [{"requirement": "Explain the relation"}],
            "anchor_lid": "1.1"
        });
        let error = validate_input(BookToolId::Query, value).unwrap_err();
        assert!(error.message.contains("requires 2..3 targets"));
    }

    #[test]
    fn validator_rejects_unknown_fields_and_applies_defaults() {
        assert!(
            validate_input(BookToolId::Text, json!({"lid": "1.1", "unexpected": true})).is_err()
        );
        assert_eq!(
            validate_input(BookToolId::PaperReadingGuide, json!({})).unwrap(),
            BookToolInput::PaperReadingGuide(PaperReadingGuideInput {
                mode: PaperMode::Skim,
                stage: PaperStage::Passive,
            })
        );
    }

    #[test]
    fn concept_v1_contract_characterization() {
        let contract = contract_for(BookToolId::Concept);
        assert_eq!(contract.aliases.resident, Some("book.concept"));
        assert_eq!(contract.aliases.mcp, Some("book_concept"));
        assert_eq!(contract.aliases.rest, Some("concept"));
        assert_eq!(contract.result_contract, "book_concept.v1");

        let schema = input_schema(BookToolId::Concept);
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["name"]));
        assert_eq!(
            schema["properties"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["name"]
        );
        assert_eq!(
            validate_input(BookToolId::Concept, json!({"name": "command"})).unwrap(),
            BookToolInput::Concept(ConceptInput {
                name: "command".into()
            })
        );
        assert!(validate_input(BookToolId::Concept, json!({"query": "command"})).is_err());
    }

    #[test]
    fn search_text_contract_applies_defaults_and_rejects_invalid_bounds() {
        let contract = contract_for(BookToolId::SearchText);
        assert_eq!(contract.aliases.resident, Some("book.search_text"));
        assert_eq!(contract.aliases.mcp, Some("book_search_text"));
        assert_eq!(contract.aliases.rest, Some("search_text"));
        assert_eq!(contract.result_contract, "search_text.v1");
        let input = validate_search_text_input(json!({"query": "Alpha"})).unwrap();
        assert_eq!(input.match_mode, SearchMatchMode::Exact);
        assert_eq!(input.order, SearchOrder::Document);
        assert_eq!(input.page_size, 20);
        assert_eq!(search_text_input_schema()["additionalProperties"], false);
        assert_eq!(search_text_input_schema()["required"], json!(["query"]));
        assert_eq!(
            search_text_input_schema()["properties"]["match_mode"]["default"],
            "exact"
        );
        assert_eq!(
            validate_search_text_input(json!({"query": "x", "page_size": 0}))
                .unwrap_err()
                .message,
            "page_size must be between 1 and 50"
        );
        assert_eq!(
            validate_search_text_input(json!({"query": "   "}))
                .unwrap_err()
                .code,
            "SEARCH_QUERY_EMPTY"
        );
        assert!(matches!(
            validate_input(
                BookToolId::SearchText,
                json!({
                    "query": "alpha",
                    "scope": {"relative_to": {"lid": "1.2", "direction": "before"}}
                })
            )
            .unwrap(),
            BookToolInput::SearchText(SearchTextInput {
                match_mode: SearchMatchMode::Exact,
                order: SearchOrder::Document,
                page_size: 20,
                ..
            })
        ));
    }
}
