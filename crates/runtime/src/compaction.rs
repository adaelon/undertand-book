use crate::model_runtime::{estimate_text_tokens, ModelRuntimeProfile};
use crate::tool_result::HistoricalToolReceipt;
use crate::{CompletionRequest, Message, ModelAdapter, Role};
use read_tools::EvidenceRange;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const COMPACTION_REQUEST_VERSION: &str = "compaction_request.v1";
pub const COMPACTION_DRAFT_SCHEMA_ID: &str = "compaction_draft.v1";
pub const COMPACTION_CHECKPOINT_VERSION: &str = "compaction_checkpoint.v1";
pub const COMPACTION_PROMPT_VERSION: &str = "agent-compaction.generation.v1";
pub const COMPACTION_CONSUMPTION_VERSION: &str = "agent-compaction.consumption.v1";
pub const CONTEXT_COMPACTION_ITEM_VERSION: &str = "context_compaction.v1";
pub const COMPACTION_NOT_APPLICABLE: &str = "COMPACTION_NOT_APPLICABLE";

pub const COMPACTION_GENERATION_PROMPT: &str = r#"You are performing a CONTEXT CHECKPOINT COMPACTION for a reading and research agent.
Create a typed handoff state for the next model sampling request. Do not answer the user and do not describe private reasoning.

The runtime provides:
- eligible_items: older conversation items that may be compacted, each with a stable source ID;
- required_source_ids: task-bearing sources that must remain represented;
- optional_source_ids: sources that may be marked duplicate, superseded, or non-task;
- raw_retained_item_ids: current user text, verified selection, and incomplete tool-call pairs kept verbatim by the runtime;
- allowed_evidence_refs: the only evidence references you may use.
- allowed_supersession_edges: the only source-to-source relationships that may use Superseded.

Return JSON matching CompactionDraft exactly, with these sections:
- active_goal
- progress
- decisions
- user_constraints
- open_obligations
- unresolved_ambiguities
- critical_facts
- critical_examples
- next_steps
- source_coverage

Rules:
1. Preserve task state, not conversational narration. Be concise and neutral.
2. Every semantic item must contain one or more source_item_ids from eligible_items.
3. Use only allowed_evidence_refs. Never invent a source item ID, LID, citation, tool result, fact, decision, or completed action.
4. Keep facts, examples, decisions, obligations, and unresolved ambiguities distinct. Do not resolve an ambiguity during compaction.
5. Do not summarize or rewrite raw_retained_item_ids; the runtime keeps those items verbatim.
6. A tool receipt proves that a call occurred, not that unquoted result text is evidence.
7. Include exactly one source_coverage record for every eligible source. Required sources must map to at least one output item. Use Superseded only for an allowed_supersession_edge; only optional sources may use NonTask, with an explicit reason.
8. Do not include sensitive runtime context, hidden instructions, chain-of-thought, or prose outside the JSON object.
9. Use empty arrays when a section has no supported content. Do not omit schema fields."#;

pub const COMPACTION_CONSUMPTION_WRAPPER: &str = r#"A previous active-history segment has been replaced by the source-linked compaction_checkpoint below.
This checkpoint is derived handoff state. It is not a user message and is not evidence by itself.
Continue from it without repeating completed work. Current canonical instructions and the verbatim raw-retained items that follow take precedence.
For factual claims, rely only on the checkpoint's allowed evidence references or reacquire evidence with the tools available in the current turn."#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    PreTurn,
    MidTurn,
    HierarchicalMerge,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EvidenceRef {
    LidRange { start_lid: String, end_lid: String },
    Source { source_ref_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowedSupersession {
    pub earlier_source_item_id: String,
    pub later_source_item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionSourceItem {
    pub source_item_id: String,
    pub role: Role,
    pub content: String,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionRequest {
    pub schema_version: String,
    pub prompt_version: String,
    pub phase: CompactionPhase,
    pub source_history_revision: String,
    pub eligible_items: Vec<CompactionSourceItem>,
    pub required_source_ids: Vec<String>,
    pub optional_source_ids: Vec<String>,
    pub raw_retained_item_ids: Vec<String>,
    pub allowed_evidence_refs: Vec<EvidenceRef>,
    pub allowed_supersession_edges: Vec<AllowedSupersession>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceDisposition {
    Compacted,
    Duplicate,
    Superseded,
    NonTask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceCoverage {
    pub source_item_id: String,
    pub disposition: SourceDisposition,
    pub target_item_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcedCheckpointItem {
    pub item_id: String,
    pub text: String,
    pub source_item_ids: Vec<String>,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionDraft {
    pub active_goal: Vec<SourcedCheckpointItem>,
    pub progress: Vec<SourcedCheckpointItem>,
    pub decisions: Vec<SourcedCheckpointItem>,
    pub user_constraints: Vec<SourcedCheckpointItem>,
    pub open_obligations: Vec<SourcedCheckpointItem>,
    pub unresolved_ambiguities: Vec<SourcedCheckpointItem>,
    pub critical_facts: Vec<SourcedCheckpointItem>,
    pub critical_examples: Vec<SourcedCheckpointItem>,
    pub next_steps: Vec<SourcedCheckpointItem>,
    pub source_coverage: Vec<SourceCoverage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingEffectRef {
    pub effect_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionCheckpoint {
    pub schema_version: String,
    pub prompt_version: String,
    pub window_id: String,
    pub source_history_revision: String,
    pub raw_retained_item_ids: Vec<String>,
    pub semantic: CompactionDraft,
    pub tool_receipts: Vec<HistoricalToolReceipt>,
    pub pending_effects: Vec<PendingEffectRef>,
    pub context_revisions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionError {
    pub error_code: String,
    pub message: String,
}

impl CompactionError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            error_code: "COMPACTION_VALIDATION_FAILED".into(),
            message: message.into(),
        }
    }

    fn generation(message: impl Into<String>) -> Self {
        Self {
            error_code: "COMPACTION_GENERATION_FAILED".into(),
            message: message.into(),
        }
    }

    fn not_applicable(message: impl Into<String>) -> Self {
        Self {
            error_code: COMPACTION_NOT_APPLICABLE.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequiredSemanticState {
    OpenObligation,
    UnresolvedAmbiguity,
}

#[derive(Debug, Clone)]
pub struct PreparedCompaction {
    request: CompactionRequest,
    raw_messages: Vec<Message>,
    deterministic_messages: Vec<Message>,
    full_turn_source_ids: Vec<Vec<String>>,
    required_semantic_states: BTreeMap<String, RequiredSemanticState>,
    tool_receipts: Vec<HistoricalToolReceipt>,
    pending_effects: Vec<PendingEffectRef>,
    context_revisions: BTreeMap<String, String>,
}

impl PreparedCompaction {
    pub fn request(&self) -> &CompactionRequest {
        &self.request
    }

    #[cfg(test)]
    fn require_open_for_test(&mut self, source_item_id: &str, state: RequiredSemanticState) {
        self.required_semantic_states
            .insert(source_item_id.into(), state);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CompactionLimits {
    pub generation_input_limit_tokens: u32,
    pub target_active_tokens: u32,
}

impl Default for CompactionLimits {
    fn default() -> Self {
        Self {
            generation_input_limit_tokens: 32_000,
            target_active_tokens: 64_000,
        }
    }
}

fn digest(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn source_item_id(index: usize, message: &Message) -> Result<String, CompactionError> {
    let body = serde_json::to_string(message)
        .map_err(|error| CompactionError::invalid(format!("message serialize failed: {error}")))?;
    Ok(format!(
        "source.{index}.{}",
        digest(&body).replace(':', "-")
    ))
}

fn source_history_revision(items: &[(usize, String)]) -> String {
    let body = items
        .iter()
        .map(|(index, id)| format!("{index}:{id}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("history.{}", digest(&body).replace(':', "-"))
}

fn evidence_refs_from_receipt(receipt: &HistoricalToolReceipt) -> Vec<EvidenceRef> {
    let mut refs = receipt
        .accepted_evidence
        .iter()
        .map(|range| EvidenceRef::LidRange {
            start_lid: range.start_lid.clone(),
            end_lid: range.end_lid.clone(),
        })
        .chain(
            receipt
                .source_refs
                .iter()
                .cloned()
                .map(|source_ref_id| EvidenceRef::Source { source_ref_id }),
        )
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}

fn assistant_source_content(message: &Message) -> Result<String, CompactionError> {
    if message.tool_calls.is_empty() {
        return Ok(message.content.clone().unwrap_or_default());
    }
    serde_json::to_string(&serde_json::json!({
        "text": message.content,
        "tool_calls": message.tool_calls,
    }))
    .map_err(|error| CompactionError::invalid(format!("assistant source failed: {error}")))
}

fn validate_message_projection(
    raw: &[Message],
    deterministic: &[Message],
) -> Result<(), CompactionError> {
    if raw.len() != deterministic.len() {
        return Err(CompactionError::invalid(
            "raw and deterministic histories have different lengths",
        ));
    }
    for (index, (raw, deterministic)) in raw.iter().zip(deterministic).enumerate() {
        if raw.role != deterministic.role
            || raw.tool_call_id != deterministic.tool_call_id
            || raw.tool_calls.len() != deterministic.tool_calls.len()
            || raw
                .tool_calls
                .iter()
                .zip(&deterministic.tool_calls)
                .any(|(left, right)| left.id != right.id || left.name != right.name)
        {
            return Err(CompactionError::invalid(format!(
                "deterministic history changed message identity at index {index}"
            )));
        }
    }
    Ok(())
}

fn turn_is_complete(messages: &[Message]) -> Result<bool, CompactionError> {
    let mut calls = BTreeMap::new();
    let mut results = HashSet::new();
    for message in messages {
        match message.role {
            Role::Assistant => {
                for call in &message.tool_calls {
                    if call.id.trim().is_empty() || calls.insert(call.id.clone(), ()).is_some() {
                        return Err(CompactionError::invalid(
                            "tool call IDs must be nonempty and unique within a turn",
                        ));
                    }
                }
            }
            Role::Tool => {
                let id = message
                    .tool_call_id
                    .as_deref()
                    .ok_or_else(|| CompactionError::invalid("tool result has no tool_call_id"))?;
                if !calls.contains_key(id) || !results.insert(id.to_string()) {
                    return Err(CompactionError::invalid(
                        "tool result is orphaned or duplicated",
                    ));
                }
            }
            Role::System | Role::User => {}
        }
    }
    let pairs_complete = calls.keys().all(|id| results.contains(id));
    let has_final = messages
        .last()
        .is_some_and(|message| message.role == Role::Assistant && message.tool_calls.is_empty());
    Ok(pairs_complete && has_final)
}

fn conversation_turns(messages: &[Message]) -> Result<Vec<(usize, usize, bool)>, CompactionError> {
    let system_end = messages
        .iter()
        .position(|message| message.role != Role::System)
        .unwrap_or(messages.len());
    if messages[system_end..]
        .iter()
        .any(|message| message.role == Role::System)
    {
        return Err(CompactionError::invalid(
            "durable system messages may only appear in the canonical prefix",
        ));
    }
    if system_end == messages.len() {
        return Ok(Vec::new());
    }
    if messages[system_end].role != Role::User {
        return Err(CompactionError::invalid(
            "conversation history must start each turn with a user message",
        ));
    }
    let starts = messages
        .iter()
        .enumerate()
        .skip(system_end)
        .filter_map(|(index, message)| (message.role == Role::User).then_some(index))
        .collect::<Vec<_>>();
    let mut turns = Vec::with_capacity(starts.len());
    for (ordinal, start) in starts.iter().copied().enumerate() {
        let end = starts.get(ordinal + 1).copied().unwrap_or(messages.len());
        turns.push((start, end, turn_is_complete(&messages[start..end])?));
    }
    Ok(turns)
}

pub fn prepare_compaction(
    phase: CompactionPhase,
    raw_messages: &[Message],
    deterministic_messages: &[Message],
    allowed_evidence_refs: Vec<EvidenceRef>,
    allowed_supersession_edges: Vec<AllowedSupersession>,
    pending_effects: Vec<PendingEffectRef>,
    context_revisions: BTreeMap<String, String>,
) -> Result<PreparedCompaction, CompactionError> {
    if phase == CompactionPhase::HierarchicalMerge {
        return Err(CompactionError::invalid(
            "hierarchical merge requests are runtime-generated only",
        ));
    }
    validate_message_projection(raw_messages, deterministic_messages)?;
    let turns = conversation_turns(raw_messages)?;
    if turns.is_empty() {
        return Err(CompactionError::not_applicable(
            "history contains no conversation turn to compact",
        ));
    }

    let raw_start = match phase {
        CompactionPhase::MidTurn => turns
            .last()
            .map(|turn| turn.0)
            .unwrap_or(raw_messages.len()),
        CompactionPhase::PreTurn => turns
            .iter()
            .find_map(|(start, _, complete)| (!complete).then_some(*start))
            .unwrap_or(raw_messages.len()),
        CompactionPhase::HierarchicalMerge => unreachable!(),
    };
    let compactable_turns = turns
        .iter()
        .take_while(|(_, end, complete)| *complete && *end <= raw_start)
        .copied()
        .collect::<Vec<_>>();
    if compactable_turns.is_empty() {
        return Err(CompactionError::not_applicable(
            "history contains no complete turn before the raw-retained suffix",
        ));
    }
    if compactable_turns.last().map(|turn| turn.1) != Some(raw_start) {
        return Err(CompactionError::invalid(
            "compaction may not cross an incomplete turn boundary",
        ));
    }

    let all_ids = raw_messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role != Role::System)
        .map(|(index, message)| source_item_id(index, message).map(|id| (index, id)))
        .collect::<Result<Vec<_>, _>>()?;
    let id_by_index = all_ids.iter().cloned().collect::<BTreeMap<_, _>>();
    let mut eligible_items = Vec::new();
    let mut required_source_ids = Vec::new();
    let mut optional_source_ids = Vec::new();
    let mut derived_evidence_refs = BTreeSet::new();
    let mut tool_receipts = Vec::new();
    let mut receipt_calls = HashSet::new();

    for index in compactable_turns
        .iter()
        .flat_map(|(start, end, _)| *start..*end)
    {
        let raw = &raw_messages[index];
        let deterministic = &deterministic_messages[index];
        let id = id_by_index
            .get(&index)
            .cloned()
            .ok_or_else(|| CompactionError::invalid("missing source item identity"))?;
        let (content, evidence_refs, required) = match raw.role {
            Role::User => (raw.content.clone().unwrap_or_default(), Vec::new(), true),
            Role::Assistant => {
                let content = assistant_source_content(raw)?;
                let required = raw
                    .content
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty());
                (content, Vec::new(), required)
            }
            Role::Tool => {
                let receipt = serde_json::from_str::<HistoricalToolReceipt>(
                    deterministic.content.as_deref().unwrap_or_default(),
                )
                .map_err(|error| {
                    CompactionError::invalid(format!(
                        "eligible tool result is not a deterministic receipt: {error}"
                    ))
                })?;
                let call_id = raw.tool_call_id.clone().ok_or_else(|| {
                    CompactionError::invalid("eligible tool result lost its call identity")
                })?;
                if !receipt_calls.insert(call_id) {
                    return Err(CompactionError::invalid(
                        "eligible tool receipt is duplicated",
                    ));
                }
                let refs = evidence_refs_from_receipt(&receipt);
                let required = !refs.is_empty();
                let content = serde_json::to_string(&receipt).map_err(|error| {
                    CompactionError::invalid(format!("receipt serialize failed: {error}"))
                })?;
                tool_receipts.push(receipt);
                (content, refs, required)
            }
            Role::System => continue,
        };
        for evidence_ref in &evidence_refs {
            derived_evidence_refs.insert(evidence_ref.clone());
        }
        if required {
            required_source_ids.push(id.clone());
        } else {
            optional_source_ids.push(id.clone());
        }
        eligible_items.push(CompactionSourceItem {
            source_item_id: id,
            role: raw.role,
            content,
            evidence_refs,
        });
    }

    let mut allowed_evidence_refs = allowed_evidence_refs
        .into_iter()
        .chain(derived_evidence_refs)
        .collect::<Vec<_>>();
    allowed_evidence_refs.sort();
    allowed_evidence_refs.dedup();
    let raw_retained_item_ids = all_ids
        .iter()
        .filter_map(|(index, id)| (*index >= raw_start).then_some(id.clone()))
        .collect::<Vec<_>>();
    let full_turn_source_ids = compactable_turns
        .iter()
        .map(|(start, end, _)| {
            (*start..*end)
                .filter_map(|index| id_by_index.get(&index).cloned())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let request = CompactionRequest {
        schema_version: COMPACTION_REQUEST_VERSION.into(),
        prompt_version: COMPACTION_PROMPT_VERSION.into(),
        phase,
        source_history_revision: source_history_revision(&all_ids),
        eligible_items,
        required_source_ids,
        optional_source_ids,
        raw_retained_item_ids,
        allowed_evidence_refs,
        allowed_supersession_edges,
    };
    validate_request(&request)?;
    Ok(PreparedCompaction {
        request,
        raw_messages: raw_messages.to_vec(),
        deterministic_messages: deterministic_messages.to_vec(),
        full_turn_source_ids,
        required_semantic_states: BTreeMap::new(),
        tool_receipts,
        pending_effects,
        context_revisions,
    })
}

fn validate_request(request: &CompactionRequest) -> Result<(), CompactionError> {
    if request.schema_version != COMPACTION_REQUEST_VERSION
        || request.prompt_version != COMPACTION_PROMPT_VERSION
        || request.source_history_revision.trim().is_empty()
    {
        return Err(CompactionError::invalid(
            "compaction request version or history revision is invalid",
        ));
    }
    let eligible = request
        .eligible_items
        .iter()
        .map(|item| item.source_item_id.as_str())
        .collect::<BTreeSet<_>>();
    if eligible.len() != request.eligible_items.len()
        || request
            .eligible_items
            .iter()
            .any(|item| item.source_item_id.trim().is_empty() || item.content.trim().is_empty())
    {
        return Err(CompactionError::invalid(
            "eligible source IDs/content must be nonempty and unique",
        ));
    }
    let required = request
        .required_source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let optional = request
        .optional_source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if required.len() != request.required_source_ids.len()
        || optional.len() != request.optional_source_ids.len()
        || !required.is_disjoint(&optional)
        || required.union(&optional).copied().collect::<BTreeSet<_>>() != eligible
    {
        return Err(CompactionError::invalid(
            "required and optional source partitions must exactly cover eligible items",
        ));
    }
    let raw = request
        .raw_retained_item_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if raw.len() != request.raw_retained_item_ids.len() || !raw.is_disjoint(&eligible) {
        return Err(CompactionError::invalid(
            "raw-retained IDs must be unique and outside eligible items",
        ));
    }
    let allowed_refs = request
        .allowed_evidence_refs
        .iter()
        .collect::<BTreeSet<_>>();
    if request.eligible_items.iter().any(|item| {
        item.evidence_refs
            .iter()
            .any(|reference| !allowed_refs.contains(reference))
    }) {
        return Err(CompactionError::invalid(
            "source item contains an evidence reference outside the request whitelist",
        ));
    }
    let edges = request
        .allowed_supersession_edges
        .iter()
        .map(|edge| {
            (
                edge.earlier_source_item_id.as_str(),
                edge.later_source_item_id.as_str(),
            )
        })
        .collect::<BTreeSet<_>>();
    if edges.len() != request.allowed_supersession_edges.len()
        || edges
            .iter()
            .any(|(earlier, later)| !eligible.contains(earlier) || !eligible.contains(later))
    {
        return Err(CompactionError::invalid(
            "supersession edges must be unique and refer to eligible sources",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SemanticSection {
    ActiveGoal,
    Progress,
    Decisions,
    UserConstraints,
    OpenObligations,
    UnresolvedAmbiguities,
    CriticalFacts,
    CriticalExamples,
    NextSteps,
}

impl SemanticSection {
    fn as_str(self) -> &'static str {
        match self {
            Self::ActiveGoal => "active_goal",
            Self::Progress => "progress",
            Self::Decisions => "decisions",
            Self::UserConstraints => "user_constraints",
            Self::OpenObligations => "open_obligations",
            Self::UnresolvedAmbiguities => "unresolved_ambiguities",
            Self::CriticalFacts => "critical_facts",
            Self::CriticalExamples => "critical_examples",
            Self::NextSteps => "next_steps",
        }
    }
}

fn semantic_items(draft: &CompactionDraft) -> Vec<(SemanticSection, &SourcedCheckpointItem)> {
    [
        (SemanticSection::ActiveGoal, &draft.active_goal),
        (SemanticSection::Progress, &draft.progress),
        (SemanticSection::Decisions, &draft.decisions),
        (SemanticSection::UserConstraints, &draft.user_constraints),
        (SemanticSection::OpenObligations, &draft.open_obligations),
        (
            SemanticSection::UnresolvedAmbiguities,
            &draft.unresolved_ambiguities,
        ),
        (SemanticSection::CriticalFacts, &draft.critical_facts),
        (SemanticSection::CriticalExamples, &draft.critical_examples),
        (SemanticSection::NextSteps, &draft.next_steps),
    ]
    .into_iter()
    .flat_map(|(section, items)| items.iter().map(move |item| (section, item)))
    .collect()
}

fn semantic_items_mut(
    draft: &mut CompactionDraft,
) -> Vec<(SemanticSection, &mut SourcedCheckpointItem)> {
    let CompactionDraft {
        active_goal,
        progress,
        decisions,
        user_constraints,
        open_obligations,
        unresolved_ambiguities,
        critical_facts,
        critical_examples,
        next_steps,
        source_coverage: _,
    } = draft;
    active_goal
        .iter_mut()
        .map(|item| (SemanticSection::ActiveGoal, item))
        .chain(
            progress
                .iter_mut()
                .map(|item| (SemanticSection::Progress, item)),
        )
        .chain(
            decisions
                .iter_mut()
                .map(|item| (SemanticSection::Decisions, item)),
        )
        .chain(
            user_constraints
                .iter_mut()
                .map(|item| (SemanticSection::UserConstraints, item)),
        )
        .chain(
            open_obligations
                .iter_mut()
                .map(|item| (SemanticSection::OpenObligations, item)),
        )
        .chain(
            unresolved_ambiguities
                .iter_mut()
                .map(|item| (SemanticSection::UnresolvedAmbiguities, item)),
        )
        .chain(
            critical_facts
                .iter_mut()
                .map(|item| (SemanticSection::CriticalFacts, item)),
        )
        .chain(
            critical_examples
                .iter_mut()
                .map(|item| (SemanticSection::CriticalExamples, item)),
        )
        .chain(
            next_steps
                .iter_mut()
                .map(|item| (SemanticSection::NextSteps, item)),
        )
        .collect()
}

fn valid_generated_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn validate_draft(
    request: &CompactionRequest,
    draft: &CompactionDraft,
    required_states: &BTreeMap<String, RequiredSemanticState>,
) -> Result<(), CompactionError> {
    validate_request(request)?;
    let eligible = request
        .eligible_items
        .iter()
        .map(|item| (item.source_item_id.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    let required = request
        .required_source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let optional = request
        .optional_source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let allowed_refs = request
        .allowed_evidence_refs
        .iter()
        .collect::<BTreeSet<_>>();
    let edges = request
        .allowed_supersession_edges
        .iter()
        .map(|edge| {
            (
                edge.earlier_source_item_id.as_str(),
                edge.later_source_item_id.as_str(),
            )
        })
        .collect::<BTreeSet<_>>();

    let items = semantic_items(draft);
    let mut item_ids = BTreeMap::new();
    for (section, item) in &items {
        if !valid_generated_id(&item.item_id)
            || item.text.trim().is_empty()
            || item.text.chars().count() > 4_000
            || item.source_item_ids.is_empty()
        {
            return Err(CompactionError::invalid(format!(
                "{} contains an invalid semantic item",
                section.as_str()
            )));
        }
        if item_ids
            .insert(item.item_id.as_str(), (*section, *item))
            .is_some()
        {
            return Err(CompactionError::invalid(format!(
                "duplicate semantic item_id {}",
                item.item_id
            )));
        }
        let sources = item
            .source_item_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if sources.len() != item.source_item_ids.len()
            || sources.iter().any(|source| !eligible.contains_key(source))
        {
            return Err(CompactionError::invalid(format!(
                "semantic item {} invented or duplicated a source ID",
                item.item_id
            )));
        }
        let refs = item.evidence_refs.iter().collect::<BTreeSet<_>>();
        if refs.len() != item.evidence_refs.len()
            || refs
                .iter()
                .any(|reference| !allowed_refs.contains(reference))
        {
            return Err(CompactionError::invalid(format!(
                "semantic item {} invented or duplicated an evidence reference",
                item.item_id
            )));
        }
    }

    for (source_id, required_state) in required_states {
        let expected = match required_state {
            RequiredSemanticState::OpenObligation => SemanticSection::OpenObligations,
            RequiredSemanticState::UnresolvedAmbiguity => SemanticSection::UnresolvedAmbiguities,
        };
        let matching = items
            .iter()
            .filter(|(_, item)| item.source_item_ids.contains(source_id))
            .map(|(section, _)| *section)
            .collect::<BTreeSet<_>>();
        if !matching.contains(&expected)
            || matching.contains(&SemanticSection::Progress)
            || matching.contains(&SemanticSection::Decisions)
        {
            return Err(CompactionError::invalid(format!(
                "source {source_id} must remain in {} and cannot be marked complete",
                expected.as_str()
            )));
        }
    }

    let mut coverage_by_source = BTreeMap::new();
    for coverage in &draft.source_coverage {
        if coverage_by_source
            .insert(coverage.source_item_id.as_str(), coverage)
            .is_some()
        {
            return Err(CompactionError::invalid(format!(
                "duplicate source coverage for {}",
                coverage.source_item_id
            )));
        }
    }
    if coverage_by_source.len() != eligible.len()
        || eligible
            .keys()
            .any(|source| !coverage_by_source.contains_key(source))
        || coverage_by_source
            .keys()
            .any(|source| !eligible.contains_key(source))
    {
        return Err(CompactionError::invalid(
            "source coverage must contain exactly one record for every eligible source",
        ));
    }

    const OPTIONAL_NON_TASK_REASONS: [&str; 3] =
        ["transport_only", "duplicate_envelope", "status_only"];
    for (source_id, coverage) in coverage_by_source {
        let targets = coverage
            .target_item_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if targets.len() != coverage.target_item_ids.len()
            || targets.iter().any(|target| !item_ids.contains_key(target))
        {
            return Err(CompactionError::invalid(format!(
                "coverage for {source_id} contains an invalid target item",
            )));
        }
        match coverage.disposition {
            SourceDisposition::NonTask => {
                if !optional.contains(source_id)
                    || !targets.is_empty()
                    || !coverage
                        .reason
                        .as_deref()
                        .is_some_and(|reason| OPTIONAL_NON_TASK_REASONS.contains(&reason))
                {
                    return Err(CompactionError::invalid(format!(
                        "NonTask coverage for {source_id} is not an allowed optional disposition"
                    )));
                }
            }
            SourceDisposition::Superseded => {
                if targets.is_empty() || coverage.reason.is_some() {
                    return Err(CompactionError::invalid(format!(
                        "Superseded coverage for {source_id} must have targets and no free-form reason"
                    )));
                }
                let allowed = targets.iter().any(|target| {
                    let (_, item) = item_ids[target];
                    item.source_item_ids.iter().any(|later| {
                        edges.contains(&(source_id, later.as_str()))
                            && item
                                .source_item_ids
                                .iter()
                                .any(|source| source == source_id)
                    })
                });
                if !allowed {
                    return Err(CompactionError::invalid(format!(
                        "Superseded coverage for {source_id} has no allowed edge"
                    )));
                }
            }
            SourceDisposition::Compacted | SourceDisposition::Duplicate => {
                if targets.is_empty()
                    || coverage.reason.is_some()
                    || !targets.iter().all(|target| {
                        let (_, item) = item_ids[target];
                        item.source_item_ids
                            .iter()
                            .any(|source| source == source_id)
                    })
                {
                    return Err(CompactionError::invalid(format!(
                        "coverage for {source_id} does not map to a source-linked semantic item"
                    )));
                }
            }
        }
        if required.contains(source_id) && coverage.disposition == SourceDisposition::NonTask {
            return Err(CompactionError::invalid(format!(
                "required source {source_id} cannot be NonTask"
            )));
        }
    }
    Ok(())
}

pub fn decode_compaction_draft_strict(input: &str) -> Result<CompactionDraft, CompactionError> {
    let value = serde_json::from_str::<serde_json::Value>(input.trim()).map_err(|error| {
        CompactionError::generation(format!(
            "compaction output must be exactly one JSON object: {error}"
        ))
    })?;
    serde_json::from_value(value).map_err(|error| {
        CompactionError::generation(format!("compaction draft schema mismatch: {error}"))
    })
}

fn request_input_tokens(request: &CompactionRequest, system: &str) -> Result<u32, CompactionError> {
    let request = serde_json::to_string(request)
        .map_err(|error| CompactionError::invalid(format!("request serialize failed: {error}")))?;
    Ok(estimate_text_tokens(system).saturating_add(estimate_text_tokens(&request)))
}

fn call_generator(
    adapter: &dyn ModelAdapter,
    system: &str,
    request: &CompactionRequest,
    required_states: &BTreeMap<String, RequiredSemanticState>,
) -> Result<CompactionDraft, CompactionError> {
    let user = serde_json::to_string(request)
        .map_err(|error| CompactionError::invalid(format!("request serialize failed: {error}")))?;
    let value = adapter
        .complete_structured(CompletionRequest {
            system: system.into(),
            user,
        })
        .map_err(|error| CompactionError::generation(error.message))?;
    let draft = serde_json::from_value::<CompactionDraft>(value).map_err(|error| {
        CompactionError::generation(format!("compaction draft schema mismatch: {error}"))
    })?;
    validate_draft(request, &draft, required_states)?;
    Ok(draft)
}

fn child_request(
    original: &CompactionRequest,
    source_ids: &[String],
) -> Result<CompactionRequest, CompactionError> {
    let selected = source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let eligible_items = original
        .eligible_items
        .iter()
        .filter(|item| selected.contains(item.source_item_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let allowed_evidence_refs = original.allowed_evidence_refs.clone();
    let request = CompactionRequest {
        schema_version: original.schema_version.clone(),
        prompt_version: original.prompt_version.clone(),
        phase: original.phase,
        source_history_revision: original.source_history_revision.clone(),
        eligible_items,
        required_source_ids: original
            .required_source_ids
            .iter()
            .filter(|id| selected.contains(id.as_str()))
            .cloned()
            .collect(),
        optional_source_ids: original
            .optional_source_ids
            .iter()
            .filter(|id| selected.contains(id.as_str()))
            .cloned()
            .collect(),
        raw_retained_item_ids: original.raw_retained_item_ids.clone(),
        allowed_evidence_refs,
        allowed_supersession_edges: original
            .allowed_supersession_edges
            .iter()
            .filter(|edge| {
                selected.contains(edge.earlier_source_item_id.as_str())
                    && selected.contains(edge.later_source_item_id.as_str())
            })
            .cloned()
            .collect(),
    };
    validate_request(&request)?;
    Ok(request)
}

#[derive(Debug, Clone)]
struct MergeSource {
    source: CompactionSourceItem,
    original_source_ids: Vec<String>,
    required_state: Option<RequiredSemanticState>,
    child_index: usize,
    child_item_id: String,
}

fn hierarchical_merge_request(
    original: &CompactionRequest,
    child_drafts: &[CompactionDraft],
) -> Result<(CompactionRequest, Vec<MergeSource>), CompactionError> {
    let mut sources = Vec::new();
    for (child_index, draft) in child_drafts.iter().enumerate() {
        for (section, item) in semantic_items(draft) {
            let source_item_id = format!("merge.{child_index}.{}", item.item_id);
            let required_state = match section {
                SemanticSection::OpenObligations => Some(RequiredSemanticState::OpenObligation),
                SemanticSection::UnresolvedAmbiguities => {
                    Some(RequiredSemanticState::UnresolvedAmbiguity)
                }
                _ => None,
            };
            sources.push(MergeSource {
                source: CompactionSourceItem {
                    source_item_id,
                    role: Role::System,
                    content: format!("section={}\n{}", section.as_str(), item.text),
                    evidence_refs: item.evidence_refs.clone(),
                },
                original_source_ids: item.source_item_ids.clone(),
                required_state,
                child_index,
                child_item_id: item.item_id.clone(),
            });
        }
    }
    if sources.is_empty() {
        return Err(CompactionError::invalid(
            "hierarchical child drafts produced no semantic state",
        ));
    }
    let request = CompactionRequest {
        schema_version: COMPACTION_REQUEST_VERSION.into(),
        prompt_version: COMPACTION_PROMPT_VERSION.into(),
        phase: CompactionPhase::HierarchicalMerge,
        source_history_revision: original.source_history_revision.clone(),
        eligible_items: sources.iter().map(|source| source.source.clone()).collect(),
        required_source_ids: sources
            .iter()
            .map(|source| source.source.source_item_id.clone())
            .collect(),
        optional_source_ids: Vec::new(),
        raw_retained_item_ids: original.raw_retained_item_ids.clone(),
        allowed_evidence_refs: original.allowed_evidence_refs.clone(),
        allowed_supersession_edges: Vec::new(),
    };
    validate_request(&request)?;
    Ok((request, sources))
}

fn expand_hierarchical_draft(
    original: &CompactionRequest,
    child_drafts: &[CompactionDraft],
    merge_sources: &[MergeSource],
    mut merged: CompactionDraft,
) -> Result<CompactionDraft, CompactionError> {
    let source_map = merge_sources
        .iter()
        .map(|source| {
            (
                source.source.source_item_id.clone(),
                source.original_source_ids.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let merged_target_map = semantic_items(&merged)
        .into_iter()
        .map(|(_, item)| (item.item_id.clone(), item.source_item_ids.clone()))
        .collect::<BTreeMap<_, _>>();
    for (_, item) in semantic_items_mut(&mut merged) {
        let mut expanded = item
            .source_item_ids
            .iter()
            .flat_map(|source| source_map.get(source).cloned().unwrap_or_default())
            .collect::<Vec<_>>();
        expanded.sort();
        expanded.dedup();
        item.source_item_ids = expanded;
    }

    let child_item_to_merge_source = merge_sources
        .iter()
        .map(|source| {
            (
                (source.child_index, source.child_item_id.as_str()),
                source.source.source_item_id.as_str(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut original_coverage = BTreeMap::new();
    for (child_index, child) in child_drafts.iter().enumerate() {
        for coverage in &child.source_coverage {
            original_coverage.insert(
                coverage.source_item_id.clone(),
                (child_index, coverage.clone()),
            );
        }
    }
    let mut source_coverage = Vec::with_capacity(original.eligible_items.len());
    for source in &original.eligible_items {
        let (child_index, child) = original_coverage
            .get(&source.source_item_id)
            .ok_or_else(|| CompactionError::invalid("hierarchical coverage lost a source"))?;
        if child.disposition == SourceDisposition::NonTask {
            source_coverage.push(child.clone());
            continue;
        }
        let child_merge_sources = child
            .target_item_ids
            .iter()
            .filter_map(|item_id| {
                child_item_to_merge_source
                    .get(&(*child_index, item_id.as_str()))
                    .copied()
            })
            .collect::<BTreeSet<_>>();
        let targets = merged_target_map
            .iter()
            .filter_map(|(item_id, merge_ids)| {
                merge_ids
                    .iter()
                    .any(|source_id| child_merge_sources.contains(source_id.as_str()))
                    .then_some(item_id.clone())
            })
            .collect::<Vec<_>>();
        source_coverage.push(SourceCoverage {
            source_item_id: source.source_item_id.clone(),
            disposition: child.disposition,
            target_item_ids: targets,
            reason: child.reason.clone(),
        });
    }
    merged.source_coverage = source_coverage;
    Ok(merged)
}

fn generate_draft(
    adapter: &dyn ModelAdapter,
    profile: &ModelRuntimeProfile,
    prepared: &PreparedCompaction,
    generation_input_limit_tokens: u32,
) -> Result<CompactionDraft, CompactionError> {
    if profile.compaction.output_schema_id != COMPACTION_DRAFT_SCHEMA_ID {
        return Err(CompactionError::invalid(
            "model profile does not use the canonical compaction draft schema",
        ));
    }
    let system = profile
        .compaction
        .prompt_asset
        .resolve(COMPACTION_GENERATION_PROMPT);
    if request_input_tokens(&prepared.request, &system)? <= generation_input_limit_tokens {
        return call_generator(
            adapter,
            &system,
            &prepared.request,
            &prepared.required_semantic_states,
        );
    }

    let mut chunks = Vec::<Vec<String>>::new();
    for turn in &prepared.full_turn_source_ids {
        let mut candidate = chunks.last().cloned().unwrap_or_default();
        candidate.extend(turn.iter().cloned());
        let candidate_request = child_request(&prepared.request, &candidate)?;
        if request_input_tokens(&candidate_request, &system)? <= generation_input_limit_tokens {
            if let Some(last) = chunks.last_mut() {
                *last = candidate;
            } else {
                chunks.push(candidate);
            }
            continue;
        }
        let single_turn = child_request(&prepared.request, turn)?;
        if request_input_tokens(&single_turn, &system)? > generation_input_limit_tokens {
            return Err(CompactionError {
                error_code: "COMPACTION_SOURCE_TURN_TOO_LARGE".into(),
                message: "one complete source turn cannot fit the compaction generator".into(),
            });
        }
        chunks.push(turn.clone());
    }
    if chunks.len() < 2 {
        return Err(CompactionError::invalid(
            "oversized compaction request did not produce multiple complete-turn chunks",
        ));
    }

    let mut child_drafts = Vec::with_capacity(chunks.len());
    for chunk in &chunks {
        let request = child_request(&prepared.request, chunk)?;
        let states = prepared
            .required_semantic_states
            .iter()
            .filter(|(source, _)| chunk.contains(source))
            .map(|(source, state)| (source.clone(), *state))
            .collect();
        child_drafts.push(call_generator(adapter, &system, &request, &states)?);
    }
    let (merge_request, merge_sources) =
        hierarchical_merge_request(&prepared.request, &child_drafts)?;
    if request_input_tokens(&merge_request, &system)? > generation_input_limit_tokens {
        return Err(CompactionError {
            error_code: "COMPACTION_HIERARCHICAL_MERGE_TOO_LARGE".into(),
            message: "hierarchical child drafts still exceed the merge generator limit".into(),
        });
    }
    let merge_states = merge_sources
        .iter()
        .filter_map(|source| {
            source
                .required_state
                .map(|state| (source.source.source_item_id.clone(), state))
        })
        .collect();
    let merged = call_generator(adapter, &system, &merge_request, &merge_states)?;
    let expanded =
        expand_hierarchical_draft(&prepared.request, &child_drafts, &merge_sources, merged)?;
    validate_draft(
        &prepared.request,
        &expanded,
        &prepared.required_semantic_states,
    )?;
    Ok(expanded)
}

fn message_tokens(messages: &[Message]) -> Result<u32, CompactionError> {
    let body = serde_json::to_string(messages)
        .map_err(|error| CompactionError::invalid(format!("message serialize failed: {error}")))?;
    Ok(estimate_text_tokens(&body))
}

fn checkpoint_window_id(checkpoint: &CompactionCheckpoint) -> Result<String, CompactionError> {
    let identity = serde_json::to_string(&serde_json::json!({
        "schema_version": checkpoint.schema_version,
        "prompt_version": checkpoint.prompt_version,
        "source_history_revision": checkpoint.source_history_revision,
        "raw_retained_item_ids": checkpoint.raw_retained_item_ids,
        "semantic": checkpoint.semantic,
        "tool_receipts": checkpoint.tool_receipts,
        "pending_effects": checkpoint.pending_effects,
        "context_revisions": checkpoint.context_revisions,
    }))
    .map_err(|error| {
        CompactionError::invalid(format!("checkpoint identity serialize failed: {error}"))
    })?;
    Ok(format!("window.{}", digest(&identity).replace(':', "-")))
}

fn validate_checkpoint_structure(checkpoint: &CompactionCheckpoint) -> Result<(), CompactionError> {
    let items = semantic_items(&checkpoint.semantic);
    let item_ids = items
        .iter()
        .map(|(_, item)| item.item_id.as_str())
        .collect::<BTreeSet<_>>();
    if item_ids.len() != items.len()
        || items.iter().any(|(_, item)| {
            !valid_generated_id(&item.item_id)
                || item.text.trim().is_empty()
                || item.source_item_ids.is_empty()
        })
    {
        return Err(CompactionError::invalid(
            "checkpoint semantic items are invalid or duplicated",
        ));
    }
    let coverage_ids = checkpoint
        .semantic
        .source_coverage
        .iter()
        .map(|coverage| coverage.source_item_id.as_str())
        .collect::<BTreeSet<_>>();
    let raw_ids = checkpoint
        .raw_retained_item_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if coverage_ids.len() != checkpoint.semantic.source_coverage.len()
        || raw_ids.len() != checkpoint.raw_retained_item_ids.len()
        || !coverage_ids.is_disjoint(&raw_ids)
    {
        return Err(CompactionError::invalid(
            "checkpoint source coverage/raw identities are duplicated or overlap",
        ));
    }
    if items.iter().any(|(_, item)| {
        item.source_item_ids
            .iter()
            .any(|source| !coverage_ids.contains(source.as_str()))
    }) {
        return Err(CompactionError::invalid(
            "checkpoint semantic item references a source outside coverage",
        ));
    }
    for coverage in &checkpoint.semantic.source_coverage {
        let targets = coverage
            .target_item_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if targets.len() != coverage.target_item_ids.len()
            || targets.iter().any(|target| !item_ids.contains(target))
            || (coverage.disposition == SourceDisposition::NonTask && !targets.is_empty())
            || (coverage.disposition != SourceDisposition::NonTask && targets.is_empty())
        {
            return Err(CompactionError::invalid(
                "checkpoint source coverage targets are invalid",
            ));
        }
    }
    if checkpoint.tool_receipts.iter().any(|receipt| {
        receipt.version != "historical_tool_receipt.v1"
            || receipt.tool.trim().is_empty()
            || receipt.opaque_result_digest.trim().is_empty()
    }) {
        return Err(CompactionError::invalid(
            "checkpoint tool receipts are invalid or duplicated",
        ));
    }
    let effect_ids = checkpoint
        .pending_effects
        .iter()
        .map(|effect| effect.effect_id.as_str())
        .collect::<BTreeSet<_>>();
    if effect_ids.len() != checkpoint.pending_effects.len()
        || checkpoint
            .pending_effects
            .iter()
            .any(|effect| effect.effect_id.trim().is_empty() || effect.kind.trim().is_empty())
        || checkpoint
            .context_revisions
            .iter()
            .any(|(key, revision)| key.trim().is_empty() || revision.trim().is_empty())
    {
        return Err(CompactionError::invalid(
            "checkpoint pending effects or context revisions are invalid",
        ));
    }
    Ok(())
}

pub fn compact_with_adapter(
    adapter: &dyn ModelAdapter,
    profile: &ModelRuntimeProfile,
    prepared: &PreparedCompaction,
    limits: CompactionLimits,
) -> Result<CompactionCheckpoint, CompactionError> {
    let draft = generate_draft(
        adapter,
        profile,
        prepared,
        limits.generation_input_limit_tokens,
    )?;
    validate_draft(
        &prepared.request,
        &draft,
        &prepared.required_semantic_states,
    )?;
    let mut checkpoint = CompactionCheckpoint {
        schema_version: COMPACTION_CHECKPOINT_VERSION.into(),
        prompt_version: prepared.request.prompt_version.clone(),
        window_id: String::new(),
        source_history_revision: prepared.request.source_history_revision.clone(),
        raw_retained_item_ids: prepared.request.raw_retained_item_ids.clone(),
        semantic: draft,
        tool_receipts: prepared.tool_receipts.clone(),
        pending_effects: prepared.pending_effects.clone(),
        context_revisions: prepared.context_revisions.clone(),
    };
    checkpoint.window_id = checkpoint_window_id(&checkpoint)?;
    validate_checkpoint_structure(&checkpoint)?;
    let wrapper = profile
        .compaction
        .consumption_wrapper_asset
        .resolve(COMPACTION_CONSUMPTION_WRAPPER);
    let projected =
        project_compaction_checkpoint_messages(&prepared.raw_messages, &checkpoint, &[], &wrapper)?;
    let original_tokens = message_tokens(&prepared.deterministic_messages)?;
    let replacement_tokens = message_tokens(&projected)?;
    if replacement_tokens >= original_tokens {
        return Err(CompactionError {
            error_code: "COMPACTION_INSUFFICIENT_REDUCTION".into(),
            message: format!(
                "checkpoint uses {replacement_tokens} estimated tokens versus {original_tokens} before compaction"
            ),
        });
    }
    if replacement_tokens > limits.target_active_tokens {
        return Err(CompactionError {
            error_code: "COMPACTION_TARGET_NOT_REACHED".into(),
            message: format!(
                "checkpoint uses {replacement_tokens} estimated tokens, above target {}",
                limits.target_active_tokens
            ),
        });
    }
    Ok(checkpoint)
}

fn checkpoint_source_ids(checkpoint: &CompactionCheckpoint) -> BTreeSet<&str> {
    checkpoint
        .semantic
        .source_coverage
        .iter()
        .map(|coverage| coverage.source_item_id.as_str())
        .chain(checkpoint.raw_retained_item_ids.iter().map(String::as_str))
        .collect()
}

pub fn project_compaction_checkpoint_messages(
    raw_messages: &[Message],
    checkpoint: &CompactionCheckpoint,
    context_messages: &[Message],
    consumption_wrapper: &str,
) -> Result<Vec<Message>, CompactionError> {
    if checkpoint.schema_version != COMPACTION_CHECKPOINT_VERSION
        || checkpoint.prompt_version != COMPACTION_PROMPT_VERSION
        || checkpoint.window_id.trim().is_empty()
    {
        return Err(CompactionError::invalid(
            "checkpoint version or window identity is invalid",
        ));
    }
    validate_checkpoint_structure(checkpoint)?;
    if context_messages
        .iter()
        .any(|message| message.role != Role::System)
    {
        return Err(CompactionError::invalid(
            "checkpoint context fragments must project as system messages",
        ));
    }
    let system_end = raw_messages
        .iter()
        .position(|message| message.role != Role::System)
        .unwrap_or(raw_messages.len());
    let ids = raw_messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role != Role::System)
        .map(|(index, message)| source_item_id(index, message).map(|id| (index, id)))
        .collect::<Result<Vec<_>, _>>()?;
    let by_id = ids
        .iter()
        .map(|(index, id)| (id.as_str(), *index))
        .collect::<BTreeMap<_, _>>();
    let covered = checkpoint_source_ids(checkpoint);
    if covered.len()
        != checkpoint.semantic.source_coverage.len() + checkpoint.raw_retained_item_ids.len()
        || covered.iter().any(|source| !by_id.contains_key(source))
    {
        return Err(CompactionError::invalid(
            "checkpoint source IDs are duplicated or stale",
        ));
    }
    let mut covered_items = covered
        .iter()
        .map(|source| (by_id[source], (*source).to_string()))
        .collect::<Vec<_>>();
    covered_items.sort_by_key(|(index, _)| *index);
    if source_history_revision(&covered_items) != checkpoint.source_history_revision {
        return Err(CompactionError::invalid(
            "checkpoint history revision does not match its source messages",
        ));
    }
    if checkpoint_window_id(checkpoint)? != checkpoint.window_id {
        return Err(CompactionError::invalid(
            "checkpoint window identity does not match its deterministic contents",
        ));
    }
    let max_covered = covered_items
        .iter()
        .map(|(index, _)| *index)
        .max()
        .ok_or_else(|| CompactionError::invalid("checkpoint covers no history messages"))?;
    if ids
        .iter()
        .any(|(index, id)| *index <= max_covered && !covered.contains(id.as_str()))
    {
        return Err(CompactionError::invalid(
            "checkpoint omitted a message inside its covered history prefix",
        ));
    }

    let checkpoint_json = serde_json::to_string(checkpoint).map_err(|error| {
        CompactionError::invalid(format!("checkpoint serialize failed: {error}"))
    })?;
    let checkpoint_message = Message::system(format!(
        "{CONTEXT_COMPACTION_ITEM_VERSION}\n{consumption_wrapper}\ncompaction_checkpoint:\n{checkpoint_json}"
    ));
    let raw_retained = checkpoint
        .raw_retained_item_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut projected = Vec::with_capacity(
        system_end + context_messages.len() + 1 + raw_retained.len() + raw_messages.len(),
    );
    projected.extend_from_slice(&raw_messages[..system_end]);
    projected.extend_from_slice(context_messages);
    projected.push(checkpoint_message);
    for (index, message) in raw_messages.iter().enumerate().skip(system_end) {
        let id = source_item_id(index, message)?;
        if raw_retained.contains(id.as_str()) || index > max_covered {
            projected.push(message.clone());
        }
    }
    Ok(projected)
}

pub fn validate_persisted_checkpoint(
    raw_messages: &[Message],
    checkpoint: &CompactionCheckpoint,
) -> Result<(), CompactionError> {
    project_compaction_checkpoint_messages(
        raw_messages,
        checkpoint,
        &[],
        COMPACTION_CONSUMPTION_WRAPPER,
    )
    .map(|_| ())
}

pub fn evidence_refs_from_ranges(ranges: &[EvidenceRange]) -> Vec<EvidenceRef> {
    ranges
        .iter()
        .map(|range| EvidenceRef::LidRange {
            start_lid: range.start_lid.clone(),
            end_lid: range.end_lid.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_runtime::ProviderToolProtocol;
    use crate::tool_result::HistoricalToolStatus;
    use crate::{AdapterError, AssistantTurn, ParsedResponse, ToolCall};
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    fn assistant(content: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    fn completed_turn(user: &str, answer: &str) -> Vec<Message> {
        vec![Message::user(user), assistant(answer)]
    }

    fn empty_draft() -> CompactionDraft {
        CompactionDraft {
            active_goal: Vec::new(),
            progress: Vec::new(),
            decisions: Vec::new(),
            user_constraints: Vec::new(),
            open_obligations: Vec::new(),
            unresolved_ambiguities: Vec::new(),
            critical_facts: Vec::new(),
            critical_examples: Vec::new(),
            next_steps: Vec::new(),
            source_coverage: Vec::new(),
        }
    }

    fn covering_draft(request: &CompactionRequest, text: &str) -> CompactionDraft {
        let mut draft = empty_draft();
        let item_id = "item.state".to_string();
        draft.active_goal.push(SourcedCheckpointItem {
            item_id: item_id.clone(),
            text: text.into(),
            source_item_ids: request
                .eligible_items
                .iter()
                .map(|item| item.source_item_id.clone())
                .collect(),
            evidence_refs: Vec::new(),
        });
        draft.source_coverage = request
            .eligible_items
            .iter()
            .map(|source| SourceCoverage {
                source_item_id: source.source_item_id.clone(),
                disposition: SourceDisposition::Compacted,
                target_item_ids: vec![item_id.clone()],
                reason: None,
            })
            .collect();
        draft
    }

    struct ScriptedCompactor {
        outputs: RefCell<VecDeque<serde_json::Value>>,
        requests: RefCell<Vec<CompletionRequest>>,
    }

    impl ScriptedCompactor {
        fn new(outputs: Vec<serde_json::Value>) -> Self {
            Self {
                outputs: RefCell::new(outputs.into()),
                requests: RefCell::new(Vec::new()),
            }
        }
    }

    impl ModelAdapter for ScriptedCompactor {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Err(AdapterError {
                message: "compaction must use structured completion".into(),
            })
        }

        fn complete_structured(
            &self,
            req: CompletionRequest,
        ) -> Result<serde_json::Value, AdapterError> {
            self.requests.borrow_mut().push(req);
            self.outputs
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "compaction script exhausted".into(),
                })
        }

        fn chat(&self, _request: &crate::AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
            Err(AdapterError {
                message: "compaction must not call chat or expose tools".into(),
            })
        }
    }

    struct RequestDrivenCompactor {
        calls: Cell<usize>,
    }

    impl ModelAdapter for RequestDrivenCompactor {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Err(AdapterError {
                message: "compaction must use structured completion".into(),
            })
        }

        fn complete_structured(
            &self,
            req: CompletionRequest,
        ) -> Result<serde_json::Value, AdapterError> {
            self.calls.set(self.calls.get() + 1);
            let request =
                serde_json::from_str::<CompactionRequest>(&req.user).map_err(|error| {
                    AdapterError {
                        message: error.to_string(),
                    }
                })?;
            serde_json::to_value(covering_draft(&request, "merged state")).map_err(|error| {
                AdapterError {
                    message: error.to_string(),
                }
            })
        }

        fn chat(&self, _request: &crate::AgentRequestPlan) -> Result<AssistantTurn, AdapterError> {
            Err(AdapterError {
                message: "compaction must not call chat or expose tools".into(),
            })
        }
    }

    fn profile() -> ModelRuntimeProfile {
        ModelRuntimeProfile::fallback("fixture", ProviderToolProtocol::Native)
    }

    #[test]
    fn compaction_checkpoint_prompt_and_schema_are_canonical_and_strict() {
        let profile = profile();
        assert_eq!(
            profile.compaction.prompt_asset.text_override.as_deref(),
            Some(COMPACTION_GENERATION_PROMPT)
        );
        assert_eq!(
            profile
                .compaction
                .consumption_wrapper_asset
                .text_override
                .as_deref(),
            Some(COMPACTION_CONSUMPTION_WRAPPER)
        );
        assert_eq!(
            profile.compaction.output_schema_id,
            COMPACTION_DRAFT_SCHEMA_ID
        );
        let draft = empty_draft();
        let exact = serde_json::to_string(&draft).unwrap();
        assert_eq!(decode_compaction_draft_strict(&exact).unwrap(), draft);
        assert!(decode_compaction_draft_strict(&format!("prose\n{exact}")).is_err());
        let mut unknown = serde_json::to_value(&draft).unwrap();
        unknown["outside_schema"] = serde_json::json!(true);
        assert!(decode_compaction_draft_strict(&unknown.to_string()).is_err());
        let mut missing = serde_json::to_value(&draft).unwrap();
        missing.as_object_mut().unwrap().remove("next_steps");
        assert!(decode_compaction_draft_strict(&missing.to_string()).is_err());
    }

    #[test]
    fn compaction_checkpoint_prepare_keeps_current_text_and_incomplete_pairs_raw() {
        let mut raw = vec![Message::system("base")];
        raw.extend(completed_turn("older question", "older answer"));
        raw.extend(completed_turn("second question", "second answer"));
        raw.push(Message::user(
            "current verbatim selection <selection>Eq. 9</selection>",
        ));
        raw.push(Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![ToolCall {
                id: "pending-call".into(),
                name: "book.text".into(),
                arguments: r#"{"lid":"1.9"}"#.into(),
            }],
            tool_call_id: None,
        });
        let prepared = prepare_compaction(
            CompactionPhase::MidTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(prepared.full_turn_source_ids.len(), 2);
        assert_eq!(prepared.request.raw_retained_item_ids.len(), 2);
        assert!(prepared
            .request
            .eligible_items
            .iter()
            .all(|item| !item.content.contains("Eq. 9")));
        let raw_ids = raw
            .iter()
            .enumerate()
            .skip(5)
            .map(|(index, message)| source_item_id(index, message).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(prepared.request.raw_retained_item_ids, raw_ids);

        let preturn = prepare_compaction(
            CompactionPhase::PreTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(preturn.request.raw_retained_item_ids, raw_ids);
    }

    #[test]
    fn compaction_checkpoint_validator_rejects_forgery_coverage_and_closed_pending_state() {
        let mut raw = vec![Message::system("base")];
        raw.extend(completed_turn("question", "answer"));
        let mut prepared = prepare_compaction(
            CompactionPhase::PreTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let required = prepared.request.required_source_ids[0].clone();
        prepared.require_open_for_test(&required, RequiredSemanticState::OpenObligation);

        let mut forged = covering_draft(&prepared.request, "claims completion");
        forged.active_goal[0]
            .source_item_ids
            .push("source.forged".into());
        assert!(validate_draft(
            &prepared.request,
            &forged,
            &prepared.required_semantic_states
        )
        .is_err());

        let mut missing_coverage = covering_draft(&prepared.request, "state");
        missing_coverage.source_coverage.pop();
        assert!(validate_draft(
            &prepared.request,
            &missing_coverage,
            &prepared.required_semantic_states
        )
        .is_err());

        let closed = covering_draft(&prepared.request, "done");
        assert!(validate_draft(
            &prepared.request,
            &closed,
            &prepared.required_semantic_states
        )
        .is_err());

        let mut still_open = covering_draft(&prepared.request, "pending");
        still_open.open_obligations = std::mem::take(&mut still_open.active_goal);
        assert!(validate_draft(
            &prepared.request,
            &still_open,
            &prepared.required_semantic_states
        )
        .is_ok());
    }

    #[test]
    fn compaction_checkpoint_install_projects_fixed_order_without_mutating_history() {
        let long = "historical detail ".repeat(1_200);
        let mut raw = vec![Message::system("canonical base")];
        raw.extend(completed_turn(&long, &long));
        raw.push(Message::user("current user text must remain byte exact"));
        let before = serde_json::to_vec(&raw).unwrap();
        let prepared = prepare_compaction(
            CompactionPhase::MidTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            vec![PendingEffectRef {
                effect_id: "effect.pending".into(),
                kind: "reader_layout".into(),
            }],
            BTreeMap::from([("reader.profile_snapshot".into(), "revision-7".into())]),
        )
        .unwrap();
        let draft = covering_draft(&prepared.request, "Continue the current explanation.");
        let adapter = ScriptedCompactor::new(vec![serde_json::to_value(draft).unwrap()]);
        let checkpoint = compact_with_adapter(
            &adapter,
            &profile(),
            &prepared,
            CompactionLimits {
                generation_input_limit_tokens: 100_000,
                target_active_tokens: 20_000,
            },
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&raw).unwrap(), before);
        assert_eq!(checkpoint.pending_effects.len(), 1);
        assert_eq!(
            checkpoint.context_revisions["reader.profile_snapshot"],
            "revision-7"
        );
        let context = Message::system("context_fragment.v1\nkey=reader.profile_snapshot");
        let projected = project_compaction_checkpoint_messages(
            &raw,
            &checkpoint,
            &[context.clone()],
            COMPACTION_CONSUMPTION_WRAPPER,
        )
        .unwrap();
        assert_eq!(projected[0].content.as_deref(), Some("canonical base"));
        assert_eq!(projected[1].content, context.content);
        assert!(projected[2]
            .content
            .as_deref()
            .unwrap()
            .starts_with(CONTEXT_COMPACTION_ITEM_VERSION));
        assert_eq!(
            projected[3].content.as_deref(),
            Some("current user text must remain byte exact")
        );
        assert_eq!(adapter.requests.borrow().len(), 1);
        assert_eq!(
            adapter.requests.borrow()[0].system,
            COMPACTION_GENERATION_PROMPT
        );
    }

    #[test]
    fn compaction_checkpoint_failure_is_byte_equivalent_and_stale_history_fails_closed() {
        let long = "old state ".repeat(1_000);
        let mut raw = vec![Message::system("base")];
        raw.extend(completed_turn(&long, &long));
        raw.push(Message::user("current"));
        let before = serde_json::to_vec(&raw).unwrap();
        let prepared = prepare_compaction(
            CompactionPhase::MidTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let mut invalid = covering_draft(&prepared.request, "state");
        invalid.source_coverage.pop();
        let failed = ScriptedCompactor::new(vec![serde_json::to_value(invalid).unwrap()]);
        assert!(compact_with_adapter(
            &failed,
            &profile(),
            &prepared,
            CompactionLimits {
                generation_input_limit_tokens: 100_000,
                target_active_tokens: 20_000,
            }
        )
        .is_err());
        assert_eq!(serde_json::to_vec(&raw).unwrap(), before);

        let valid = covering_draft(&prepared.request, "state");
        let valid_adapter = ScriptedCompactor::new(vec![serde_json::to_value(valid).unwrap()]);
        let checkpoint = compact_with_adapter(
            &valid_adapter,
            &profile(),
            &prepared,
            CompactionLimits {
                generation_input_limit_tokens: 100_000,
                target_active_tokens: 20_000,
            },
        )
        .unwrap();
        let mut appended = raw.clone();
        appended.push(Message::user("a later continuation"));
        let projected = project_compaction_checkpoint_messages(
            &appended,
            &checkpoint,
            &[],
            COMPACTION_CONSUMPTION_WRAPPER,
        )
        .unwrap();
        assert!(projected
            .iter()
            .any(|message| message.content.as_deref() == Some("a later continuation")));
        let mut tampered = raw;
        tampered[1].content = Some("changed old source".into());
        assert!(validate_persisted_checkpoint(&tampered, &checkpoint).is_err());
    }

    #[test]
    fn compaction_checkpoint_receipts_are_runtime_owned_and_evidence_is_whitelisted() {
        let range = EvidenceRange {
            start_lid: "1.9".into(),
            end_lid: "1.10".into(),
            ranges: Vec::new(),
        };
        let receipt = HistoricalToolReceipt {
            version: "historical_tool_receipt.v1".into(),
            tool: "book.text".into(),
            locator_args: serde_json::json!({"lid":"1.9"}),
            status: HistoricalToolStatus::Ok,
            error_code: None,
            accepted_evidence: vec![range.clone()],
            source_refs: Vec::new(),
            opaque_result_digest: "tool-result-digest".into(),
        };
        let mut raw = vec![
            Message::system("base"),
            Message::user(format!("explain {}", "question context ".repeat(700))),
        ];
        raw.push(Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![ToolCall {
                id: "read-1".into(),
                name: "book.text".into(),
                arguments: r#"{"lid":"1.9"}"#.into(),
            }],
            tool_call_id: None,
        });
        raw.push(Message {
            role: Role::Tool,
            content: Some("raw body that the model must not carry as evidence".repeat(500)),
            tool_calls: Vec::new(),
            tool_call_id: Some("read-1".into()),
        });
        raw.push(assistant(&format!(
            "the answer {}",
            "answer context ".repeat(700)
        )));
        let mut deterministic = raw.clone();
        deterministic[3].content = Some(serde_json::to_string(&receipt).unwrap());
        let prepared = prepare_compaction(
            CompactionPhase::PreTurn,
            &raw,
            &deterministic,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let tool_source = prepared
            .request
            .eligible_items
            .iter()
            .find(|item| item.role == Role::Tool)
            .unwrap();
        let evidence_ref = EvidenceRef::LidRange {
            start_lid: "1.9".into(),
            end_lid: "1.10".into(),
        };
        assert_eq!(tool_source.evidence_refs, vec![evidence_ref.clone()]);
        let mut draft = covering_draft(&prepared.request, "supported state");
        draft.active_goal[0].evidence_refs = vec![evidence_ref];
        let adapter = ScriptedCompactor::new(vec![serde_json::to_value(draft).unwrap()]);
        let checkpoint = compact_with_adapter(
            &adapter,
            &profile(),
            &prepared,
            CompactionLimits {
                generation_input_limit_tokens: 100_000,
                target_active_tokens: 20_000,
            },
        )
        .unwrap();
        assert_eq!(checkpoint.tool_receipts, vec![receipt]);
        assert!(!serde_json::to_string(&checkpoint)
            .unwrap()
            .contains("raw body that the model"));
    }

    #[test]
    fn compaction_checkpoint_hierarchical_chunks_preserve_every_complete_turn() {
        let detail = "turn detail ".repeat(350);
        let mut raw = vec![Message::system("base")];
        for ordinal in 0..4 {
            raw.extend(completed_turn(
                &format!("question {ordinal} {detail}"),
                &format!("answer {ordinal} {detail}"),
            ));
        }
        let prepared = prepare_compaction(
            CompactionPhase::PreTurn,
            &raw,
            &raw,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let system = COMPACTION_GENERATION_PROMPT;
        let full_tokens = request_input_tokens(&prepared.request, system).unwrap();
        let largest_child = prepared
            .full_turn_source_ids
            .iter()
            .map(|turn| {
                request_input_tokens(&child_request(&prepared.request, turn).unwrap(), system)
                    .unwrap()
            })
            .max()
            .unwrap();
        assert!(largest_child < full_tokens);
        let adapter = RequestDrivenCompactor {
            calls: Cell::new(0),
        };
        let checkpoint = compact_with_adapter(
            &adapter,
            &profile(),
            &prepared,
            CompactionLimits {
                generation_input_limit_tokens: largest_child + 20,
                target_active_tokens: full_tokens,
            },
        )
        .unwrap();
        assert!(adapter.calls.get() >= 3);
        assert_eq!(
            checkpoint.semantic.source_coverage.len(),
            prepared.request.eligible_items.len()
        );
        let covered = checkpoint
            .semantic
            .source_coverage
            .iter()
            .map(|coverage| coverage.source_item_id.as_str())
            .collect::<BTreeSet<_>>();
        for turn in &prepared.full_turn_source_ids {
            assert!(turn.iter().all(|source| covered.contains(source.as_str())));
        }
    }
}
