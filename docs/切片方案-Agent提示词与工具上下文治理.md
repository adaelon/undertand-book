# Agent 提示词与工具上下文治理切片方案

状态:方案冻结;AP0-AP10 全部完成;发布硬门禁通过。

冻结决策:[ADR-0091](adr/0091-model-aware-agent-request-tool-exposure-and-active-context-budget.md)。修订关系:[ADR-0026](adr/0026-外层E编排loop-原生toolcalling-adapter扩chat-双重停机usage口径-memory独立json落盘.md)、[ADR-0087](adr/0087-provenance-aware-answer-delivery-and-compact-provider-history.md)。

## 0. 对齐确认单

**FrozenIntent**:把模型专属指令、结构化动态上下文、按需工具暴露、auto 工具选择、有界结构化工具结果、自动上下文压缩和活动上下文预算全部落入 Resident Agent;AP0 只冻结文档,不修改运行代码。最终以简单局部解释不再拉起无关工具链、长会话通过语义 compact 在同一回合续接且不按上下文截断,同时复杂检索与 Reader 副作用不退化为成功标准。

**TermMap**:

| 术语 | 状态 | 本方案定义 |
|---|---|---|
| ModelAdapter / ToolSpec / Provider 历史投影 | EXISTING | 保留现有边界,调整请求投影 |
| 模型运行时配置 | NEW | 模型专属指令、窗口和能力的版本化配置 |
| Agent 请求计划 | NEW | 一次采样的结构化、Provider 无关输入 |
| 上下文片段账本 | NEW | key/revision/scope 管理的模型可见上下文 |
| 工具暴露计划 / 延迟工具发现 | NEW | registry 与本轮可见工具面的分离机制 |
| 自动上下文压缩 | NEW | 高水位生成可验证检查点并原子替换活动历史 |
| 压缩检查点 / 压缩草稿 | NEW | Runtime 组装的可信交接状态 / 模型生成的待校验语义部分 |
| 活动上下文预算 | BOUNDARY_CHANGE | 取代累计 token 停机语义 |
| Provider 历史投影 | BOUNDARY_CHANGE | 从历史回执扩展到活动工具结果治理 |

**RiskReceipt**:用户于 2026-07-23 明确确认表中七项全部实施,并追加要求自动 compact、禁止以上下文截断换空间;随后确认采用面向任务交接的结构化 compact prompt。已知风险是模型摘要可能遗漏细节或伪造引用,因此模型只生成待校验语义草稿,检查点必须由 Runtime 组装、结构化校验、原子安装且保留原历史,只允许按 AP1-AP10 独立切片推进。

**ChangeType**:`[边界重构]`。

领域对齐完成;TermMap 零未解析符号。

## 1. 当前链路与根因

| 环节 | 当前实现 | 问题 |
|---|---|---|
| 基础指令 | `orchestrator.rs::SYSTEM_PROMPT` 单一巨型字符串 | 模型能力、工具模式和窗口策略无法独立变化 |
| 动态画像 | `messages_with_profile_snapshot` 每次 Provider 请求插一份冻结 snapshot | 逻辑身份与 revision 不可见,无法做片段级更新/审计 |
| 工具面 | `tool_specs()` 固定返回 27 个工具 | 普通解释同时看到论文、地图、布局、记忆和导航工具 |
| 工具路由 | prompt 含大量“必须/紧接着调”链路 | 模型容易为满足流程而多调工具 |
| Tool body | 活动回合原始 JSON 持续留在 messages | 多轮读取的 prompt 体积线性增长 |
| Provider 协议 | Native 已发 schema;ReAct 把所见 schema 再拼成文本列表 | 内核基本结构化,但缺统一请求/暴露计划 |
| 停机 | `spent += usage.total_tokens`,超过 120k 即 `CONTEXT_BUDGET_EXCEEDED` | 重复计算每轮历史输入,与当前窗口是否装得下无关 |

```text
当前:
SYSTEM_PROMPT + snapshot + durable messages + all ToolSpec
  -> adapter.chat
  -> raw Tool body append
  -> cumulative usage stop

目标:
ModelRuntimeProfile + ContextFragmentLedger + ToolExposurePlan
  -> AgentRequestPlan
  -> Provider adapter
  -> ToolRegistry validate/dispatch
  -> ToolResultEnvelope + ActiveContextManager
  -> next AgentRequestPlan | final answer
  -> high water: AutoCompactionEngine -> CompactionCheckpoint -> next AgentRequestPlan
```

## 2. 目标契约

```rust
struct ModelRuntimeProfile {
    profile_id: String,
    model_match: ModelSelector,
    base_instructions: InstructionAsset,
    context_window_tokens: u32,
    output_reserve_tokens: u32,
    supports_native_tools: bool,
    supports_continuation: bool,
    supports_parallel_tools: bool,
    tool_schema_budget_bytes: usize,
    truncation_policy: ToolTruncationPolicy,
    compaction: CompactionProfile,
}

struct CompactionProfile {
    prompt_asset: InstructionAsset,
    consumption_wrapper_asset: InstructionAsset,
    output_schema_id: String,
    high_watermark_ratio: f32,
}

struct AgentRequestPlan {
    instructions: String,
    input: Vec<Message>,
    tools: Vec<ToolSpec>,
    tool_choice: ToolChoice, // Auto by default
    parallel_tool_calls: bool,
    active_context: ActiveContextStatus,
}
```

```rust
struct ContextFragment {
    key: String,
    revision: String,
    scope: FragmentScope, // SessionStable | TurnFrozen | Dynamic
    role: Role,
    content: String,
    sensitivity: Sensitivity,
}

struct ToolRegistration {
    spec: ToolSpec,
    exposure: ToolExposure, // Direct | Deferred | Hidden
    capability_tags: BTreeSet<String>,
    output_policy: ToolOutputPolicy,
    supports_parallel: bool,
    handler: ToolHandlerId,
}

struct ToolResultEnvelope {
    status: ToolResultStatus,
    model_body: serde_json::Value,
    receipt: HistoricalToolReceipt,
    truncated: bool,
    continuation: Option<ToolContinuation>,
}

struct CompactionRequest {
    prompt_version: String,
    phase: CompactionPhase, // PreTurn | MidTurn | HierarchicalMerge
    source_history_revision: String,
    eligible_items: Vec<CompactionSourceItem>,
    required_source_ids: Vec<String>,
    optional_source_ids: Vec<String>,
    raw_retained_item_ids: Vec<String>,
    allowed_evidence_refs: Vec<EvidenceRef>,
    allowed_supersession_edges: Vec<AllowedSupersession>,
}

struct AllowedSupersession {
    earlier_source_item_id: String,
    later_source_item_id: String,
}

struct CompactionSourceItem {
    source_item_id: String,
    role: Role,
    content: String,
    evidence_refs: Vec<EvidenceRef>,
}

enum SourceDisposition {
    Compacted,
    Duplicate,
    Superseded,
    NonTask,
}

struct SourceCoverage {
    source_item_id: String,
    disposition: SourceDisposition,
    target_item_ids: Vec<String>,
    reason: Option<String>,
}

struct SourcedCheckpointItem {
    item_id: String,
    text: String,
    source_item_ids: Vec<String>,
    evidence_refs: Vec<EvidenceRef>,
}

struct CompactionDraft {
    active_goal: Vec<SourcedCheckpointItem>,
    progress: Vec<SourcedCheckpointItem>,
    decisions: Vec<SourcedCheckpointItem>,
    user_constraints: Vec<SourcedCheckpointItem>,
    open_obligations: Vec<SourcedCheckpointItem>,
    unresolved_ambiguities: Vec<SourcedCheckpointItem>,
    critical_facts: Vec<SourcedCheckpointItem>,
    critical_examples: Vec<SourcedCheckpointItem>,
    next_steps: Vec<SourcedCheckpointItem>,
    source_coverage: Vec<SourceCoverage>,
}

struct CompactionCheckpoint {
    schema_version: String,
    prompt_version: String,
    window_id: String,
    source_history_revision: String,
    raw_retained_item_ids: Vec<String>,
    semantic: CompactionDraft,
    tool_receipts: Vec<HistoricalToolReceipt>,
    pending_effects: Vec<PendingEffectRef>,
    context_revisions: BTreeMap<String, String>,
}
```

模型不生成 `CompactionCheckpoint`。Runtime 先生成 `CompactionRequest` 和确定性字段,模型只返回 `CompactionDraft`;validator 通过后才组装最终检查点。所有自由文本 user/assistant item 与证据承载 item 都进入 `required_source_ids`;`optional_source_ids` 只接收 Runtime 已类型化的 transport/status/重复 envelope,不得由模型把自然语言消息降级为 optional。每个 eligible source 必须恰有一条 `SourceCoverage`;required source 只允许 `Compacted | Duplicate | Superseded` 且必须映射到至少一个真实 `item_id`,其中 `Superseded` 还必须命中 Runtime 提供的 `allowed_supersession_edges`;optional source 才允许 `NonTask` 且必须给出受限原因。所有 target、`source_item_ids` 与 `evidence_refs` 必须来自本次草稿或请求白名单,模型不得创建外部 ID。

### 2.1 Canonical compact prompt v1

本地生成器使用下面的模型专属 `prompt_asset`;请求不暴露业务工具、不注入动态画像,并通过 Provider 的 strict output schema 或等价 JSON validator 约束 `CompactionDraft`。远端 compaction 只有能返回或确定性转换成同一草稿契约时才可启用,否则回退本地生成器。

```text
You are performing a CONTEXT CHECKPOINT COMPACTION for a reading and research agent.
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
9. Use empty arrays when a section has no supported content. Do not omit schema fields.
```

该 prompt 借鉴 Codex 的四个有效目标:进展/决定、上下文/约束、剩余工作、关键引用;但不沿用自由文本摘要、`thinking process` 措辞或压缩失败后删除最旧消息的行为。我们的增强点是 raw 保留、typed draft、来源白名单、逐项覆盖和原子安装。

### 2.2 Checkpoint consumption wrapper v1

安装后的检查点使用内部 `ContextCompaction` item,Provider 不支持专用 item 时映射为 synthetic developer context,不得写成 user/assistant 原话或进入公开 history。下一次采样的稳定顺序是:`base instructions -> 当前 context fragments -> checkpoint wrapper + JSON -> raw retained items(原顺序) -> 当前 continuation`。

```text
A previous active-history segment has been replaced by the source-linked compaction_checkpoint below.
This checkpoint is derived handoff state. It is not a user message and is not evidence by itself.
Continue from it without repeating completed work. Current canonical instructions and the verbatim raw-retained items that follow take precedence.
For factual claims, rely only on the checkpoint's allowed evidence references or reacquire evidence with the tools available in the current turn.
```

Provider 传输分两种,但共享同一个 `AgentRequestPlan`:

```text
StatelessFull: 每次发送当前活动投影;稳定前缀可缓存,不得称为 wire delta
StatefulDelta: 首次发送完整计划;后续用受支持的 continuation ID 发送变更
```

## 3. 七项追踪矩阵

| 已确认目标 | 冻结落点 | 实现切片 | 验收证据 |
|---|---|---|---|
| 静态通用 prompt -> 模型专属配置 | ADR-0091 §1 | AP2、AP6 | 两个模型 fixture 解析不同能力/指令,同回合不漂移 |
| 重复画像 -> 初始/变更片段 | ADR-0091 §2 | AP3、AP10 | 每个 fragment key 仅一个活动 revision;敏感 snapshot 不持久 |
| 全工具可见 -> 条件/延迟发现 | ADR-0091 §3 | AP4、AP5 | 普通问答初始面不含 paper/reader/memory 工具;可按需发现 |
| prompt 强制工具 -> auto | ADR-0091 §4 | AP6 | 显式引文解释允许零工具;Reader 命令仍产生真实 effect/proposal |
| Tool body 撑爆 -> 有界/compact | ADR-0091 §6 | AP7、AP8 | 超限结果显式 truncated+continuation;旧 body 自动降格 |
| 文本协议 -> typed schema/call/result | ADR-0091 §5 | AP2、AP4、AP10 | Native/ReAct 归一到同一 call/result;非法参数同一错误 |
| 累计 token -> 活动窗口 + 自动 compact | ADR-0091 §7 | AP8、AP9 | 高水位自动续接;累计超 120k 但活动窗口可容纳时仍正常终答 |

任何目标在实现中只能标记 `covered` 或被新 ADR `superseded`;不得无名 deferred。

## 4. 切片依赖

```text
AP0 docs
  -> AP1 characterization + request audit
      -> AP2 model profile + AgentRequestPlan
          -> AP3 context fragment ledger
          -> AP4 single ToolRegistry
              -> AP5 demand-driven exposure + tool.search
                  -> AP6 auto routing + prompt modules
              -> AP7 bounded ToolResultEnvelope
                  -> AP8 compaction checkpoint engine
                      -> AP9 pre/mid-turn auto compact + stop semantics
                          -> AP10 provider parity + real-book release gates
```

AP3 与 AP4 可在 AP2 后分别开发,但 AP5 必须等 AP4,AP8 必须等 AP3 与 AP7,AP9 必须等 AP8。不得让两个切片同时修改 `run_with_ephemeral_context` 的同一控制流区段。

## 5. AP0 - 决策与切片冻结 [Docs] (本次)

**Do**:新增 ADR-0091、TermMap、当前链路、目标契约、七项追踪矩阵、AP1-AP10 与硬门禁;追加文档代码链路。

**Do not**:不修改 Rust/TypeScript/Vue、生成类型、Provider 配置、会话历史、测试或现有用户 dirty diff。

**Done**:七项全部有 ADR 落点、实现切片和确定性验收;ADR 修订关系明确;文档链接与 `git diff --check` 通过。

## 6. AP1 - 现状刻画与请求审计 [Runtime/Server]

**Do**:用 scripted adapter 冻结当前 request messages、27-tool surface、snapshot 次数、每轮 active-input 估算、schema/body 字节与累计 usage;增加 server-only `AgentRequestAudit`,不得进入公开 View/Provider history。

**Do not**:不改 prompt、工具集合、停机、持久消息或用户文案;不把真实书正文写入 fixture。

**Done**:局部引文、Eq.9 缺口、全文 occurrence、Reader 副作用和长 Tool body 五类夹具可重复;能分开报告 active input、cumulative billed tokens、tool schema 与 tool body 占用。

**Verify**:`cargo test -p runtime agent_request_audit`;`cargo test -p server agent_request_audit`。

## 7. AP2 - 模型配置与 AgentRequestPlan [Runtime/Provider]

**Do**:新增版本化 `ModelRuntimeProfile` 目录、未知模型回退和解析优先级;把 adapter 输入收敛为 `AgentRequestPlan`;显式投影 instructions/input/tools/tool_choice/parallel capability,先保持现有行为等价。

**Do not**:不缩工具面、不改 `SYSTEM_PROMPT` 内容、不启用并行执行、不改 budget warning。

**Done**:配置覆盖/目录匹配/默认回退、回合冻结、模型切换边界和 Native/ReAct 请求快照均有测试;adapter 不再自行决定业务 prompt 或工具。

**Verify**:`cargo test -p runtime agent_request_plan`;Native/ReAct request snapshot tests。

## 8. AP3 - 上下文片段账本 [Runtime/Server]

**Do**:将基础指令之外的画像、ephemeral memory context、paper minimap context 等变为 keyed fragments;同 key 只投影最新 revision;snapshot 在回合开始冻结,变更只在下一用户回合生成新 revision。

**Do not**:不把 ReaderProfileSnapshot 写入 durable messages/history;不引入 Provider continuation;不改工具面。

**Done**:一次工具循环内 snapshot 序列化值稳定且逻辑上只出现一次;跨回合无变化复用 revision,变化产生单个替换;重启/历史 JSON 均无 snapshot 正文。

**Verify**:`cargo test -p runtime context_fragment`;`cargo test -p server profile_snapshot`。

## 9. AP4 - ToolRegistry 单源 [Runtime]

**Do**:把 `tool_specs`、参数校验、dispatch、结果策略和 capability tags 合并为注册表;生成当前 27-tool 等价可见面,先不改变模型行为;为重复名、无 handler、schema/alias 漂移建启动时硬闸。

**Do not**:不做 deferred search、不删工具、不改公开 book tool contracts、不改执行顺序。

**Done**:每个 model-visible ToolSpec 恰有一个 handler 和结果策略;每个可调 handler 恰有一个注册项;Native/ReAct/dispatch 的名称与 schema 来自同一对象。

**Verify**:`cargo test -p runtime tool_registry`;`cargo test -p runtime book_tool_characterization`。

## 10. AP5 - 工具暴露计划与延迟发现 [Runtime]

**Do**:实现 direct/deferred/hidden、模型/profile/权限/证据 gate 和回合级 activated set;新增只搜元数据的 `tool.search`;默认 direct 最多 8 项,单次发现最多激活 6 项,总 schema 不超过模型配置预算。

**Do not**:不让 search 执行目标工具;不按工具结果里的任意字符串自动激活;不让模型看到 hidden 工具;不手写第二份工具说明。

**Done**:普通局部解释初始面只有通用读取、来源和 discovery 能力;paper/reader/memory 工具在相关 profile/查询下可发现并于下一采样可见;超预算选择稳定且可解释。

**Verify**:`cargo test -p runtime tool_exposure`;模型可见 schema golden tests。

## 11. AP6 - Auto 路由与提示词模块 [Runtime]

**Do**:把巨型 `SYSTEM_PROMPT` 拆成模型 base instructions + capability/policy fragments;请求显式 `tool_choice=auto`;删除“book.query 后必须 memory.save qa”等记账型强制链,由 Runtime 旁路记录;加入通用 tool-call fingerprint 无进展闸。

**Do not**:不降低来源闸、LID 真实性、Reader reducer/proposal 或明确副作用必须真执行的约束;不以关键词硬编码最终答案。

**Done**:显式引文足够时 scripted model 可零工具终答;Eq.9 缺口只补最小证据;重复同参/同 cursor 不形成开放循环;Reader goto/highlight/note/layout 仍有真实 effect 或 proposal。

**Verify**:`cargo test -p runtime agent_tool_policy`;现有 source_presentation/reader effect tests。

**实现状态(2026-07-24)**:完成。`agent_prompt.rs` 将 base instructions 与证据、来源、discovery、导航、Reader、论文、记忆、画像、收敛策略拆为版本化资产,并只按当前 sampled tools 选择策略;`AgentRequestPlan` 记录实际 instruction asset refs 且继续显式投影 `tool_choice=auto`。Runtime 在成功 `book.query` 后旁路幂等记录 QA,模型不再承担 `memory.save(type='qa')` 记账链。通用 fingerprint 以 canonical 参数和证据/工具激活/Reader/Memory 进展签名阻断重复调用,取代 search 专用游标集合。

**实现验证**:`cargo test -p runtime agent_tool_policy` 7/7;`cargo test -p runtime source_presentation` 14/14;Runtime 全量 200/200;Server 全量 187/187 + book_mcp 5/5;Rust fmt/diff check 全绿。

## 12. AP7 - 有界 ToolResultEnvelope [Runtime]

**Do**:所有 handler 返回 status/model_body/receipt/truncated/continuation;按工具配置限制单结果和活动回合 Tool body 总量;新鲜有界正文只保证下一次采样,之后可降格为工具感知回执。

**Do not**:不静默截断 JSON、不把 receipt 当证据正文、不递归搜集 LID、不改公开工具响应契约或轨迹 digest;工具级分页不得冒充上下文截断。

**Done**:book.text/search/query/paper/profile/error 各有专用 projector;截断结果 JSON 合法、明确未完成且可继续;证据账本只接受实际进入 model_body 且通过原有白名单的范围。

**Verify**:`cargo test -p runtime tool_result_projection`;provider history/source ledger regressions。

**实现状态(2026-07-24)**:完成。`tool_result.rs` 在 Runtime 内新增 `tool_result_envelope.v1`,所有 handler 的原始 JSON 先按注册表 `ToolOutputPolicy` 投影为 typed status/model_body/receipt/truncated/continuation。`book.text` 按完整 leaf LID 边界截断并生成下一段调用,`book.search_text` 明确区分原生 cursor 与上下文截断,query/paper/profile/error 走各自的合法有界 JSON projector。活动 Tool body 总预算为 48 KiB:新鲜正文至少进入下一次采样,仅在后续压力下把最旧已采样正文降为 receipt-only;durable tool message 与 trace digest 仍使用原始结果。

**实现验证**:`cargo test -p runtime tool_result_projection` 7/7;Runtime 全量 207/207;Server 全量 187/187 + book_mcp 5/5;Rust fmt/diff check 全绿。集成测试证明 20 KiB 原始尾部仍持久化且参与 trace digest,但未进入 model_body 的 LID 不能进入 evidence ledger 或通过 `source.present`。

## 13. AP8 - CompactionCheckpoint 引擎 [Runtime/Server]

**Do**:新增版本化 `CompactionRequest -> CompactionDraft -> CompactionCheckpoint`;将 canonical compact prompt v1 与 consumption wrapper v1 落为模型专属 asset,生成请求不带业务工具或敏感动态片段。当前用户原文、已验证选区和未完成 ToolCall 配对作为 raw 保留区;Runtime 先确定性投影已完成 Tool receipts、最新 context revisions 和完整回合边界,模型只压缩更早的目标、进展、决定、约束、未决义务、歧义、公开事实、关键示例、证据 ref 与下一步。每条语义项必须带 source item/ref,每个 required source 必须有覆盖去向。单请求放不下时按完整回合分块生成子草稿再归并;校验通过且 token 降到目标水位后原子安装活动 replacement history,按 wrapper/checkpoint/raw 的固定顺序投影给下一次采样。

**Do not**:不让模型生成 window/history/context revision、Tool receipt 或 raw 保留项;不在缺少 checkpoint 来源覆盖时删除或截断活动消息,不摘要当前用户原文/已验证选区/未完成工具链,不让草稿自由发明 source item ID/LID/source ref,不要求思维过程,不把检查点伪装成 user/assistant 原话,不改写 durable messages,不把敏感画像正文写入检查点,不在校验前替换活动历史。

**Done**:generation/consumption prompt 与 schema golden、必填 source 覆盖、optional disposition、引用存在性、ToolCall 配对、history revision、synthetic role/投影顺序和 token 降幅均有红绿测试;无论单次还是分层 compact,每个原始完整回合都有检查点去向;伪造 ID/ref、把未决项写成已完成、遗漏 required source、输出 schema 外 prose 均 fail closed;失败保持原活动历史 byte-equivalent;重启可从 server-only checkpoint 续接且原消息不变。

**Verify**:`cargo test -p runtime compaction_checkpoint`;`cargo test -p server agent_compaction_checkpoint`。

**实现状态(2026-07-24)**:完成。`compaction.rs` 落下 versioned request/draft/checkpoint、canonical generation/consumption assets、完整回合分组、current/incomplete raw suffix、严格 schema/source/evidence/supersession/未决状态 validator、分层子草稿与 transitive source coverage、Runtime-owned window digest 及 token 降幅闸。模型只经无业务工具的 structured completion 生成 draft;Runtime 组装 history revision、raw IDs、Tool receipts、pending effects 与 context revisions。采样固定投影为 base -> latest context fragments -> synthetic checkpoint -> raw/new suffix,checkpoint 不写入 `Message`。

**持久化与验证**:`AgentChatSession.compaction_checkpoint` 只存在于 server-private history 文件,不进入公开 history view;candidate 通过 source revision/window digest/结构闸后才沿既有原子文件事务安装,原 `session.messages`/`state.messages` byte-equivalent。重启 smoke 从 sidecar 恢复并完成真实 `/agent/chat` 采样;失败或 stale checkpoint 保持文件与活动历史不变。`cargo test -p runtime compaction_checkpoint` 7/7;`cargo test -p server agent_compaction_checkpoint` 1/1;Runtime 全量 214/214;Server 全量 188/188 + book_mcp 5/5;Rust fmt/diff check 全绿。

## 14. AP9 - 回合前/回合中自动 compact 与停机语义 [Runtime/Server/Web]

**Do**:按 ModelRuntimeProfile 在每次请求前计算 active input + output reserve + safety margin;75% 高水位自动 compact。新用户消息采样前先压既有历史;工具结果后仍需 follow-up 时执行 mid-turn compact,安装检查点、重注入当前 context fragments、重算 token 并在同一回合继续;保留 cumulative tokens 作 cost telemetry;拆分 `COMPACTION_FAILED`、`ACTIVE_CONTEXT_EXHAUSTED` 与 `TURN_LIMIT_EXCEEDED`。

**Do not**:不以累计 billed tokens 停机;不在 successful compact 后向用户显示“上下文不足”;不把 compaction 算进业务 ToolCall trace;不在 compact 失败时回退到删历史。

**Done**:累计 usage 超 120k 但活动窗口可容纳时正常结束;pre-turn 与 mid-turn 均可自动续接并保留当前目标/证据/副作用状态;只有 compact 失败或 compact 后仍物理放不下才返回对应 typed failure;轮数触顶不再显示“上下文不足”;旧 `CONTEXT_BUDGET_EXCEEDED` 仍可读取。

**Verify**:`cargo test -p runtime auto_compaction`;`cargo test -p runtime active_context_budget`;`cargo test -p server agent_warning_projection`;`pnpm -C packages/web test`。

**实现状态(2026-07-24)**:完成。Runtime 在每次 Provider sampling 前用 `AgentRequestPlan.active_context` 计算 input + output reserve + safety margin,达到 profile 高水位即调用 AP8 引擎。pre-turn 只压既有完整历史,checkpoint 原子安装成功后才把新用户消息加入 durable messages;mid-turn 在 Tool result 回填后只压更早完整回合,当前 user/assistant/ToolCall pair 保持 raw,重注入最新 ContextFragment 并在同一业务回合继续。compact 不进入 Tool trace/request audit/业务 turns;累计 billed usage 只保留在 `tokens_spent` telemetry,不再作为停机条件。

**停机与验证**:draft/校验/安装失败统一 `COMPACTION_FAILED`;无可压历史或成功 checkpoint 后仍超物理窗口为 `ACTIVE_CONTEXT_EXHAUSTED`;业务工具轮数触顶为 `TURN_LIMIT_EXCEEDED`。Server 原子 sink 随 checkpoint 同步当前 raw messages,四种新/旧 warning 跨文件、重启和公开 history 投影保持可读;RightRail 分别显示整理失败、物理容量和轮数上限,仅 legacy `CONTEXT_BUDGET_EXCEEDED` 显示“上下文不足”。`cargo test -p runtime auto_compaction` 6/6;`cargo test -p runtime active_context_budget` 1/1;`cargo test -p server agent_warning_projection` 1/1;Runtime 220/220;Server 189/189 + book_mcp 5/5;Web 26 files / 151 tests;Rust fmt/diff check 全绿。

## 15. AP10 - Provider 等价与真实书发布门禁 [Cross-cutting]

**Do**:Native 显式发送 auto 和可见 schemas;ReAct 只收到同一 exposure plan 并解析为同一结构;Native/ReAct/local/remote compaction 输出全部归一为 `CompactionDraft` 并进入同一 validator。声明支持 continuation/remote compaction 且能满足 prompt v1 语义与来源覆盖契约的 Provider 才启用相应能力,否则使用本地生成器;stateless Provider 保持 current projection。执行 Transformer 真书、长会话 compact 与副作用回归,更新架构、代码链路和 checkpoint。

**Do not**:不把 delta 能力猜给未知 Provider;不以 mock-only 或 token 降幅替代语义验收;不在本片引入工具并发执行。

**Done**:两种 adapter 的 call/result/error/stop/compaction fixture 等价,remote capability 不可猜测;真实 normalization 问题完成回答且不触发无关 profile/memory/navigation 链,证据调用不超过 2 次;长历史在 pre-turn 与 mid-turn 自动 compact 后继续;全文检索仍能翻页到 exhaustive;Reader 副作用和来源交付全绿。

**Verify**:Rust workspace;Web test/typecheck/build;Native/ReAct real-provider smoke;Transformer real-book replay;Windows sidecar/Setup release gates。

**实现状态(2026-07-24)**:完成。Native/ReAct 继续消费同一 `AgentRequestPlan`、sampled schema 和 Runtime validator;未知模型的 continuation/remote-compaction 能力明确 fail closed,所有 compaction 生成路径统一进入 `CompactionDraft` schema 与同一 validator。ReAct 协议示例由本次实际 sampled tools 动态生成,无工具面时显式禁止 `tool_calls`;Provider 返回未暴露、并行或空工具回合时由 Runtime 过滤、限一并以 typed protocol failure 收敛,不得生成 `answer=null,incomplete=false`。

**真实选区收敛**:对 Transformer 真书选区 `1.19.86.58.18` 和原始 normalization 问题,Runtime 识别 server-validated `selection_provenance.v1`,最多进行两次顺序证据获取:首轮只允许 `book.context`,次轮只允许 `book.text`;随后退出工具协议,以 provider-neutral `selection_answer_synthesis.v1` 严格 JSON 契约生成同语言直接答案。Native 在 3 个 sampling 中只调用 `book.context`、`book.text` 各一次并正常终答;ReAct 在首个 sampling 直接使用已验证选区终答,零工具调用。两条路径均无 profile、memory、navigation 调用,无“上下文不足”。

**发布验证**:`cargo test --workspace`、Rust fmt、Web 26 files / 151 tests 与 typecheck/build 全绿;真实全文检索 5 页 exhaustive、32 条命中,真实来源交付跨重启稳定且不改 history/book;Node/Bun v2 自动构建一致性、plugin parity、workbench sidecar、打包 Book MCP、Rust release 与 NSIS 全绿。最终 `dist/UnderstandBookSetup.exe` 为 37,599,143 bytes,SHA-256 `AD0119C3FECB4B6C93CE3937AE8835B24CF2934A0F4B2A9EF9E0A1DE213AF0C0`。

## 16. 发布硬门禁

1. 普通回答允许零 ToolCall;不得为满足 prompt 仪式调用工具。
2. 模型可见工具只能来自 ToolRegistry 和本轮 ToolExposurePlan。
3. `tool.search` 只激活 deferred schema,不得执行、修改权限或返回隐藏参数。
4. Native/ReAct 不得拥有不同工具名、schema、校验或错误语义。
5. Reader 副作用必须继续经过真实工具和 reducer/proposal。
6. ReaderProfileSnapshot 和其他敏感片段不得进入 durable messages、公开 history 或 trace。
7. 每个 context fragment key 在一个请求中最多一个活动 revision。
8. Tool result 的有界返回必须显式且可继续;它是工具级分页,不得演变成对话上下文截断。
9. 对话消息不得因 token 压力按最旧优先删除、截断或静默跳过;旧消息必须有 checkpoint 来源覆盖,过大时按完整回合分层 compact。
10. 当前用户原文、已验证选区和未完成 ToolCall 配对必须 raw 保留,不得交给摘要改写。
11. CompactionCheckpoint 必须通过 schema、来源覆盖、引用、配对、revision 与 token 降幅闸后原子安装;失败不得改变活动历史。
12. 历史 Tool 回执和 compacted active receipt 不得扩大本轮证据账本。
13. 当前未决义务、待决副作用与最终回答交付闸不得被 compaction 删除。
14. 成功 auto compact 后必须在同一用户回合继续,不得向用户返回“上下文不足”。
15. 累计 Provider token 只能计费/观测,不得触发上下文失败。
16. `COMPACTION_FAILED`、`ACTIVE_CONTEXT_EXHAUSTED`、`TURN_LIMIT_EXCEEDED`、delivery failure 必须可区分。
17. 旧持久历史不得批量改写;旧 warning 只读兼容。
18. 显式“全文所有出现”仍须完整分页;局部解释优化不得削弱 exhaustive 语义。
19. 真书 normalization 回归必须生成答案,不得再次以“上下文不足”结束。
20. compact 模型只生成 `CompactionDraft`;运行时身份、revision、Tool receipt、raw 保留项和敏感 context fragment 不得交给模型编造或复述。
21. 每个 required source 必须进入 `source_coverage` 并映射到语义条目;任何未知 source item ID/evidence ref、未获准 `Superseded`、schema 外文本或未决状态升级都必须 fail closed。

## 17. AP0 验证命令

```powershell
git diff --check -- CONTEXT.md docs/adr/0091-model-aware-agent-request-tool-exposure-and-active-context-budget.md docs/切片方案-Agent提示词与工具上下文治理.md docs/代码链路.md
rg -n "ADR-0091|AP(10|[0-9])|COMPACTION_FAILED|ACTIVE_CONTEXT_EXHAUSTED|TURN_LIMIT_EXCEEDED" CONTEXT.md docs/adr/0091-model-aware-agent-request-tool-exposure-and-active-context-budget.md docs/切片方案-Agent提示词与工具上下文治理.md docs/代码链路.md
```

AP0 是纯文档切片,不运行或声称代码测试。
