# 开放自然语言能力发现与 Runtime 证据拓扑切片方案

状态:方案冻结；CR0–CR10 已完成。

冻结决策:[ADR-0113](adr/0113-open-natural-language-capability-routing-and-runtime-evidence-topology.md)。延伸:[ADR-0036](adr/0036-反馈信号模型-显式nl主信号-导航讲法二维-结构兜底消歧-viewport模式分裂-人访客两投影.md)、[ADR-0091](adr/0091-model-aware-agent-request-tool-exposure-and-active-context-budget.md)。收窄解释:[ADR-0104](adr/0104-intent-seeded-guided-reading-tool-exposure-and-resident-navigation-policy.md)。

## 0. 对齐确认单

**FrozenIntent**:把 Resident Agent 的开放自然语言需求收敛为有限 `TaskNeed`，由完整能力卡和 Runtime 权威上下文生成工具暴露计划；只读结构概述与 Reader 写入口分层，阻断 blind LID 枚举、无证据的文档级综合和参数变化伪进展。同时把仓库编写的 Resident 模型 prompt、工具 description/schema 与 Runtime prompt scaffold 统一为英文。用户原文、书内内容、记忆/画像值、UI 文案和多语言分类器数据保持原样。本轮只实现文档冻结和英文 prompt 迁移，不提前实现 CR2–CR10 的能力路由/护栏。

**TermMap**:

| 术语 | 状态 | 本方案含义 |
|---|---|---|
| 工具暴露计划 / 延迟工具发现 / 本轮证据账本 | EXISTING | 保留现有 Runtime 所有权，扩展输入和门禁 |
| ExplicitGuidedRead | EXISTING + SCOPE_CLARIFICATION | 仅为高风险带读/Reader 写入口的高精度 bootstrap |
| TaskNeed | NEW | 模型提出语义维度，Runtime 盖章状态维度的单回合需求 |
| Resident Tool Routing Card | NEW | Registry 同源的用途、禁用条件、副作用和前置条件卡片 |
| StructuralIndex | NEW | 只读结构角色与证据规划能力，不等同导航副作用 |
| TurnLocatorLedger | NEW | 允许后续工具使用的 LID 来源账本，不等同正文证据 |
| Prompt authoring language | NEW | 仓库编写的模型指令/发现元数据用英文，动态内容保留原文 |

**RiskReceipt**:用户明确接受能力发现边界重构及 prompt 统一英文。已知风险是工具 schema 体积、prompt wording 和 capability 标签变化会改变真实模型路由；因此每刀独立版本化，结构不变量用确定性测试判定，开放语义泛化只用未进入产品匹配器的真实模型回放判定。

**ChangeType**:`[边界重构]`。

领域对齐完成；TermMap 零未解析符号。

## 1. 当前基线与事故链

| 环节 | 当前实现 | 已确认缺口 |
|---|---|---|
| 首轮 seed | `classify_turn_intent()` 匹配 8 个显式带读短语，显式否定优先 | 适合 Reader 高风险入口，不适合开放语义概述 |
| 初始 Direct 面 | `book.query/synthesize/search_text/text/context/concept + tool.search + source.present` | `has_turn_evidence=false` 时 `source.present` 仍占第八位；`book.structure` 不可见 |
| capability | `BookRead/BookSearch/BookQuery/Navigation/...` | structure、guide path、paper guide 共用 `BookRead + Navigation` |
| discovery | name/description/coarse capability 的 lowercase token 分数 | 连续中文是单 token；`use_when/do_not_use_when` 未索引 |
| LID 校验 | 工具只校验参数合法和 LID 是否存在 | 偶然存在的模型猜测 LID 可继续读取 |
| no-progress | 不同 canonical 参数通常形成不同 fingerprint | `book.text(1.1) -> book.text(1.2)` 可被误判为持续进展 |
| 轮数触顶 | 达上限后返回 `TURN_LIMIT_EXCEEDED` | 最后工具结果可能没有 tools-disabled 终答机会 |
| prompt 语言 | Resident policy、部分内层 book prompt、ReAct wrapper、部分 ToolSpec 为中文 | 同一模型请求包含多套仓库编写语言 |

事故路径被固定为：

```text
document-scope summary + no located evidence
  -> first sample cannot see book.structure
  -> visible book.text appears usable
  -> guessed LID happens to exist or returns LID_NOT_FOUND
  -> another guessed LID has a different fingerprint
  -> no stage progress, but loop budget continues to drain
  -> TURN_LIMIT_EXCEEDED or low-quality partial summary
```

## 2. 目标契约

### 2.1 模型提议与 Runtime 权威字段

```rust
enum Scope {
    Selection,
    Passage,
    Section,
    Document,
    Corpus,
}

enum Operation {
    LocateLiteral,
    ReadSource,
    Explain,
    Compare,
    Summarize,
    Navigate,
    MutateReader,
}

enum EvidenceState {
    UserProvided,
    KnownLids,
    CurrentAnchorOnly,
    Unlocated,
}

enum EffectMode {
    ReadOnly,
    ReaderMutationExplicitlyRequested,
}

// Model-owned proposal. It cannot grant permission or claim evidence exists.
struct CapabilityRequestV2 {
    task: String,
    scope: Scope,
    operation: Operation,
    required_capabilities: Vec<ToolCapability>,
    requested_effect_mode: EffectMode,
    max_results: u8,
}

// Runtime-owned, turn-frozen routing input.
struct TaskNeed {
    request: CapabilityRequestV2,
    evidence_state: EvidenceState,
    authorized_effect_mode: EffectMode,
    content_profile: ContentProfileId,
    permissions: ToolPermissions,
}
```

Runtime 只接受 closed enum 和有界数组。`task` 是合法候选内的排序文本，不参与权限、hidden/profile/effect 判定。`requested_effect_mode=ReaderMutationExplicitlyRequested` 只有在 Runtime 从当前用户原文取得有效显式副作用意图且权限允许时才可变成 `authorized_effect_mode`；否则强制降为 `ReadOnly` 或返回 typed rejection。

### 2.2 Routing Card 与解析结果

```rust
const TOOL_ROUTING_CARD_VERSION: &str = "tool_routing_card.v1";

struct ToolRoutingCard {
    version: &'static str,
    name: String,
    description: String,
    provides: Vec<ToolCapability>,
    scopes: Vec<Scope>,
    operations: Vec<Operation>,
    use_when: Vec<String>,
    avoid_when: Vec<String>,
    effects: ToolEffect,
    preconditions: Vec<Precondition>,
    content_profiles: Vec<ContentProfileId>,
    relative_cost: ToolCost,
}

struct CapabilityPlan {
    matched_tools: Vec<ToolMatch>,
    unmet_capabilities: Vec<ToolCapability>,
    blocked: Vec<CapabilityBlock>,
    visible_from: SamplingBoundary,
}

fn resolve_capabilities(
    need: &TaskNeed,
    registry: &ToolRegistry,
    exposure: &ToolExposureContext,
) -> CapabilityPlan;
```

`BookToolContract.description/use_when/do_not_use_when` 投影进同一 Routing Card；非 Book Resident 工具在 Registry 注册处提供等价字段。handler、validator、ToolSpec schema、output policy 与 permission gate 仍只有一个权威注册项。

### 2.3 LID 来源与进展阶段

```rust
enum LocatorOrigin {
    ExplicitUserLid,
    VerifiedSelection,
    ReaderAnchor,
    StructuralIndexResult,
    LexicalSearchResult,
    SemanticQueryResult,
    ContextResult,
    VerifiedEvidence,
}

struct TurnLocatorLedger {
    entries: BTreeMap<Lid, BTreeSet<LocatorOrigin>>,
    blind_reads_blocked: bool,
}

enum ProgressPhase {
    Unlocated,
    Located,
    EvidenceReady,
    Synthesized,
    Final,
}

fn may_read_lid(lid: &str, ledger: &TurnLocatorLedger) -> bool;
fn advance_phase(before: ProgressPhase, event: RuntimeEvent) -> ProgressPhase;
```

Locator 只允许成为后续参数；只有 `book.text` 或其他证据型结果通过现有证据闸后才进入 `turn evidence ledger`。同一阶段里换一个未授权参数不算进展。

### 2.4 请求时序

```text
user message
  -> Runtime freezes profile, permissions, evidence state
  -> high-risk explicit-effect bootstrap may seed capabilities only
  -> ToolExposurePlan (low-risk Direct + activated)
  -> model sample
       -> final answer
       -> ordinary visible tool call
       -> tool.search(CapabilityRequestV2)
            -> Runtime stamps TaskNeed
            -> resolve_capabilities
            -> next sampling sees newly activated legal tools
  -> every call passes locator/evidence/effect/progress gates
  -> final legal tool batch gets one tools-disabled finalization sample
```

不新增默认的前置 LLM planner；`tool.search.v2` 是模型提交语义需求的结构化入口。只有已有高风险闭集 seed 可以在首个 sampling 前改变 activated set，而且仍不得执行工具。

## 3. 永久不变量

| 编号 | 不变量 | 确定性判据 |
|---|---|---|
| INV-1 | Reader 写必须有当前用户显式副作用意图和权限 | 无授权时 `ReaderWrite` hidden/blocked，dispatch 双重拒绝 |
| INV-2 | 工具发现不能执行目标工具 | discovery trace 只有 `tool.search`；effect 为空；目标下一 sampling 才可见 |
| INV-3 | hidden/profile-mismatch/permission-denied 永不可被 search 激活 | 返回结果和 activated set 均不含该工具 |
| INV-4 | `book.text` LID 必须有 locator provenance | 无 ledger entry 时返回 typed provenance error，不调用 Book reader |
| INV-5 | locator 不自动成为 evidence | 只有证据型 ToolResult 才增加 turn evidence ledger |
| INV-6 | 无既有证据的 section/document synthesis 必须先有 evidence plan | 直接多 LID synthesize 被阻断并返回 required capability |
| INV-7 | `LID_NOT_FOUND` 后禁止继续 blind enumeration | ledger 标记 blocked；新合法 locator 才解除 |
| INV-8 | 参数变化不等于阶段进展 | phase/signature 均未变化时计入 no-progress |
| INV-9 | 结构概述不得引入 Reader 写面 | 首轮/轨迹无 `reader.gotoLid`，无 Goto effect |
| INV-10 | prompt 编写语言与动态内容分离 | 静态资产/ToolSpec scaffold 无 Han；中文 user/source payload 逐字保留 |

## 4. 切片依赖

```text
CR0 docs
  -> CR1 English prompt assets
  -> CR2 incident containment
       -> CR3 Routing Card data model
            -> CR4 capability ontology migration
                 -> CR5 tool.search.v2 semantic discovery
                      -> CR6 TaskNeed resolver integration
                           -> CR7 TurnLocatorLedger
                                -> CR8 evidence-plan + recovery gates
                                     -> CR9 phase progress + finalization/UI
                                          -> CR10 generalized release gate
```

CR3 先建立等价数据结构，不改变 exposure；CR4 只迁移 capability 分类并保持现有可见面；CR5 才切换 discovery 协议；CR7/CR8 分开，便于定位是 locator 收集错误还是证据前置条件错误。不得让两个切片同时重写 `run_with_turn_resources_and_checkpoint_sink` 的同一循环区段。

## 5. CR0 - 决策、术语与切片冻结 [Docs]（本次，已完成）

**输入/输出**:输入为事故分析、ADR-0036/0091/0104 和当前源码；输出为 `CONTEXT.md` 新术语、ADR-0113 与本切片方案。

**做**:冻结模型/Runtime 字段所有权、能力本体下限、风险分层、structured discovery、LID provenance、阶段进展、英文 prompt 边界和 CR1–CR10。

**不做**:不改变工具面、分类词表、dispatch、Reader state、prompt 或测试行为。

**完成判据**:每个目标都有 ADR 决策、实现切片、依赖和确定性验收；TermMap 零未解析符号；链接和 `git diff --check` 通过。

## 6. CR1 - Resident 模型编写文本统一英文 [Runtime/Contracts]（已完成）

**输入/输出**:输入为当前所有 Resident 请求装配路径；输出为语义等价的英文 base/policy、内层 Book completion scaffold、ReAct wrapper、ToolSpec description/schema description，并升级受影响资产/replay revision。

**做**:
- 翻译 `agent_prompt.rs` 的 base 与九个 policy module；保持工具名、JSON 字段、调用顺序和副作用约束不变。
- 翻译 `build_synthesize_prompt`、`build_book_guide_prompt`、`OUTPUT_CONTRACT` 和 ReAct compatibility scaffold。
- 翻译 canonical `BookToolContract.description` 与 Resident 非 Book ToolSpec metadata；MCP/REST 因合同单源同步得到英文 description。
- 将 `resident-agent.base`、policy module 和 navigation replay revision 升级；同步 Native/ReAct snapshot 与 contract tests。
- 增加静态 authored-text 审计；用含中文的 user/task/source fixture 证明动态 payload 不被翻译。

**不做**:不改 `classify_turn_intent`、memory intent/minimap 多语言词表，不翻用户/正文/memory/profile 数据，不改工具暴露、capability、搜索分数、dispatch、UI/日志/错误本地化；不借翻译加入 CR2 的新证据路由规则。

**完成判据**:英文 scaffold 无 Han；中文 payload 字节保留；Native/ReAct 的工具和调用协议等价；book-tool-contracts/runtime/server 相关测试全绿。

**Verify**:
- `cargo test -p book-tool-contracts`
- `cargo test -p runtime authored -- --nocapture`
- `cargo test -p runtime agent_tool_policy -- --nocapture`
- `cargo test -p runtime agent_request_plan_native_and_react_request_snapshots_are_provider_equivalent -- --nocapture`
- `cargo test -p runtime resident_navigation_policy_native_and_react_request_plan_snapshots -- --nocapture`
- `cargo test -p runtime synthesize -- --nocapture`
- `cargo test -p runtime guided_read -- --nocapture`
- `cargo test -p server --lib`
- `cargo test -p server --bin book_mcp`
- `cargo fmt --all -- --check`
- `git diff --check`

**完成回执**:2026-08-23 完成。Book contracts 10/10；Runtime CR1 authored audit 3/3，排除已长期记录的本地真书 LID gold 漂移后 lib 255/255（另 1 个真实 Provider replay 按条件 ignored）；Server lib 230/230；Book MCP 5/5。Native/ReAct 投影、静态无 Han、中文动态 payload 保留、base/policy/navigation asset revision 和三表面合同均由测试锁定。

## 7. CR2 - 事故止血：只读结构首轮面 [Runtime]

**输入/输出**:输入为现有 `ToolExposurePlan` 和事故原始提示；输出为 technical-learning/paper 首轮可见 `book.structure`、仅有证据时 Direct 的 `source.present`，以及文档级未定位问题的通用证据拓扑 policy。

**做**:先写红测试锁定 incident；将 `book.structure` 以 `StructuralIndex + ReadOnly` 候选加入 Direct priority，`source.present` 在 `has_turn_evidence=false` 时降为 Deferred/Hidden；增加“section/document + unlocated 必须先取得结构/索引投影，禁止用 `book.text` 猜 sibling LID”的英文规则并升级 policy revision。

**不做**:不新增摘要短语、不把概述归为 `ExplicitGuidedRead`、不暴露 guide path/route/ReaderWrite、不实现 provenance ledger。

**完成判据**:
- “给我讲讲这本书讲了什么”首轮工具面含 `book.structure`，不含任何 Reader 写工具。
- 选区解释且已有证据时 `source.present` 仍可用；无证据时不占 Direct 名额。
- 原始事故真模回放首个证据规划调用为 `book.structure`，无 blind LID、Goto effect 或 `TURN_LIMIT_EXCEEDED`。

**Verify**:`cargo test -p runtime tool_exposure`;`cargo test -p runtime incident_document_overview`;固定书/模型 guided replay 的 overview 变体。

**完成回执**:2026-08-23 完成。`tool_exposure_plan.v2` 将 `book.structure` 作为只读结构首轮面，并让 `source.present` 仅在本轮已有来源证据后 Direct；`resident-agent.policy.evidence-routing@v3` 将未定位的 section/document 问题固定为 `book.structure -> book.text|book.synthesize`，禁止猜 sibling LID。`tool_exposure` 14/14、事故确定性回放 1/1、Runtime lib 258/258 + integration 6/6（常规运行另 2 个真实 Provider 用例 ignored）全绿；显式执行事故真实 Provider 回放 1/1，确认首调用 `book.structure`、零 Reader effect、零 `TURN_LIMIT_EXCEEDED`。

## 8. CR3 - Routing Card 等价投影 [Contracts/Runtime]

**输入/输出**:输入为 31 个 `ToolRegistration`、BookToolContract 与现有 exposure metadata；输出为版本化 `ToolRoutingCard`，但 ToolExposurePlan 与 `tool.search.v1` 行为保持字节级或结构级等价。

**做**:为所有 Resident 工具补齐 scopes/operations/effects/preconditions/profiles/cost；Book 工具直接消费 `description/use_when/do_not_use_when`；Registry 启动闸拒绝空卡、未知 capability、ReaderWrite 无 effect/precondition、Book 合同漂移。

**不做**:不改变 capability 枚举、不启用新字段搜索、不切 tool.search schema、不改变 direct/deferred/hidden。

**完成判据**:31/31 handler 恰有一张卡；Book use/avoid 字段可从 Registry 读取；现有可见工具 golden、schema budget 和 dispatch tests 不变。

**Verify**:`cargo test -p runtime tool_registry`;`cargo test -p runtime tool_exposure`;Book contract parity tests。

**完成回执**:2026-08-23 完成。`ToolRegistry` 为 31/31 Resident handler 生成 `tool_routing_card.v1`，完整投影 description/provides/scopes/operations/use_when/avoid_when/effects/preconditions/content_profiles/relative_cost；Book description/use/avoid 直接消费 `BookToolContract`。启动闸拒绝空字段、重复/未知或漂移 capability、ReaderWrite 缺 effect/权限/显式意图前置条件，以及 Book schema/description/guidance 漂移。旧 `ToolRegistration.capabilities` 继续驱动 CR3 的 exposure 与 `tool.search.v1`，卡片 `provides` 由它生成并强制等价，因此 visible-tool、schema budget、dispatch 和 discovery result shape 均未改变。Registry 6/6、exposure 15/15、Book contracts 10/10、Runtime 261/261 + integration 6/6（另 2 个真实 Provider 用例 ignored）全绿；Runtime `--no-deps` Clippy 在既有基线类别 allow 后全绿。

## 9. CR4 - 精确 capability 本体迁移 [Runtime]（已完成）

**输入/输出**:输入为 Routing Cards 与粗粒度标签；输出为精确 capability 集及一份 old→new 迁移表，初始 exposure 仍保持 CR2 结果。

**做**:新增 `SourceRead/LexicalLocate/SemanticEvidence/StructuralIndex/Synthesis/NavigationPlan/ReaderRead/ReaderWrite`；逐工具标注多 capability；删除以 `Navigation` 单标签同时代表 structure、plan、effect 的判断；意图 seed 改为列出显式带读所需 capability，而不是扫描大桶。

**不做**:不改 search 排序、不引入 TaskNeed、不改变权限或 dispatch；不删除为兼容审计保留的旧 capability 序列化读取。

**完成判据**:`book.structure` 不含 ReaderWrite/NavigationPlan，`book.guide_path` 不含 ReaderWrite，`reader.gotoLid` 必含 ReaderWrite+explicit-intent precondition；显式带读完整面和普通概述只读面分别 golden。

**Verify**:`cargo test -p runtime tool_registry`;`cargo test -p runtime tool_exposure`;旧 receipt migration tests。

**完成回执**:2026-08-23 完成。旧 `Discovery/BookRead/BookSearch/BookQuery/ArtifactRead/SourcePresentation/Navigation/ProfileRead/ProfileTrace/MemoryRead/MemoryWrite/ReaderRead/ReaderWrite` 冻结为 `LegacyToolCapability`，仅由 `ToolRegistration.capabilities` 服务 `tool.search.v1` 兼容搜索与回执；Routing Card `provides` 改用精确 `ToolCapability`，31/31 handler 由单一 `capability_migration` 表同时声明 legacy 与 precise 序列并受启动闸校验。`book.structure -> StructuralIndex`、`book.guide_path/route* -> NavigationPlan`、`reader.gotoLid -> ReaderWrite + explicit intent/permission/located LID`；显式带读 seed 直接列出 `ReaderRead/StructuralIndex/NavigationPlan/ReaderWrite`，再以 `Navigate + LocatedLid` 只选择 goto 类 Reader 写。CR2 visible-tool/schema golden 与 `tool_search_result.v1` 旧标签/排序不变。迁移红测先按预期失败；实现后 Registry 7/7、exposure 15/15、Book contracts 10/10、Runtime 262/262 + integration 6/6（另 2 个真实 Provider 用例 ignored）、Rust fmt 与既有基线 allow 下的 Runtime `--no-deps` Clippy 全绿。

## 10. CR5 - `tool.search.v2` 结构化发现与 CJK 检索 [Runtime/Artifact Search]

**输入/输出**:输入为 CapabilityRequestV2 与 Routing Cards；输出为精确过滤、Unicode-aware 排序的 `tool_search_result.v2`。

**做**:复用 artifact search 的 normalization/CJK gram/字段权重组件，或先抽为不改变 artifact 行为的共享纯函数；closed schema 接收 task/required_capabilities/scope/effect_mode/max_results；结果报告 matched fields/capabilities/effect/preconditions；v1 receipt 只读兼容，新的调用只产 v2。

**不做**:不做 embedding、LLM rerank、同义词表；不允许文本分数覆盖 capability/profile/permission/hidden filter；不执行目标工具。

**完成判据**:
- `required_capabilities=[structural_index], scope=document` 稳定命中 `book.structure`。
- 中文任务“这本书主要讲什么”即使不含工具名，也能在 structural_index 合法候选中提供排序信号。
- `reader_write` 在无授权/权限时零命中；zero-hit 不激活任何工具。
- 同输入排序、分数、tie-break 与 cursor/预算结果稳定。

**Verify**:`cargo test -p artifact-tools search`;`cargo test -p runtime tool_search_v2`;Native/ReAct schema parity tests。

**完成回执**:2026-08-23 完成。`tool.search` 输入升级为 closed `CapabilityRequestV2(task/required_capabilities/scope/operation/effect_mode/max_results)`，Runtime 先按 Routing Card precise capability、scope、operation、effect、profile、permission 与 hidden gate 确定性过滤，再仅在合法候选内排序；结果 `tool_search_result.v2` 报告 matched fields/terms/capabilities、effect、preconditions 与生效采样，zero-hit 不激活工具。Artifact Search 抽出版本化 weighted Unicode/CJK scorer（NFKC/full casefold、CJK grams、字段权重、稳定 tie-break），既有 artifact gold 不变；v1 receipt 保持 deserialize-only，新调用只产 v2。ReaderWrite discovery 无显式意图或权限时零命中，旧 Runtime/Server 写工具 fixture 改为显式意图与 v2 请求。定向 `tool_search_v2` 6/6、Artifact Search 6/6、Runtime 268/268 + integration 6/6（另 2 个真实 Provider 用例 ignored）、排除 Desktop 特性合并的 Rust workspace、Rust fmt、CR5 `artifact-tools + runtime` Clippy 与 scoped diff check 全绿；包含 Desktop 的 workspace 特性合并会让既有 compaction fixture 连接本机 `127.0.0.1:1594`，该环境性基线未归入 CR5。

## 11. CR6 - TaskNeed 解析与能力目录 [Runtime]

**输入/输出**:输入为模型 CapabilityRequestV2 与回合冻结 context；输出为 Runtime 盖章的 TaskNeed、CapabilityPlan 和下一 sampling 的 activated set。

**做**:常驻 prompt 只列 capability 小目录及证据拓扑规则；Runtime 从 ledger/profile/permissions/显式 effect seed 补全状态字段；resolver 返回 matched/unmet/blocked；审计只记录 enum、工具名和 bounded reason，不保存原始私密 task 文本。

**不做**:不增加独立 planner sampling、不让 Runtime 猜开放语义、不自动执行 plan、不把 model effect request 当授权。

**完成判据**:同一 CapabilityRequest 在 evidence/profile/permission 不同上下文产生预期不同 plan；模型伪报 `KnownLids` 或 Reader authorization 无效；activated tool 仅从下一 sampling 可见。

**Verify**:`cargo test -p runtime task_need`;`cargo test -p runtime capability_resolver`;request audit privacy tests。

**完成回执**:2026-08-24 完成。Resident 常驻 `tool-discovery@v4` 只列有界 capability 小目录与 evidence topology，不暴露隐藏工具名；`TurnEvidenceLedger` 将已验证用户证据与工具观察证据盖章为 Runtime-owned `EvidenceState`，`stamp_task_need` 再以真实 profile、permissions 和显式 Reader effect seed 补全 `TaskNeed`。`resolve_capabilities` 返回 matched/unmet/blocked 与 current/next-sampling visibility，只有合法 deferred match 写入下一 sampling 的 activated set；closed schema 中伪造 evidence/authorization 字段直接拒绝，模型请求 ReaderWrite 不能产生授权。`agent_request_audit.v2` 只追加版本化 enum、工具名与 bounded block reason，私密 task 文本不进入 request audit 或持久 trace arguments。定向 `task_need` 3/3、capability 相关 Runtime 单测 6/6 + integration 1/1、完整 Runtime 274/274 + integration 6/6（另 2 个真实 Provider 用例 ignored）通过；`runtime --all-targets --no-deps` Clippy 在仅 allow 既有基线类别后全绿。排除 Desktop 的 workspace 首跑仅既有 BuildIntent Server 用例瞬时返回 400，精确隔离重跑 1/1 通过，该非 CR6 波动未通过放宽生产门禁处理。

## 12. CR7 - TurnLocatorLedger 与 `book.text` 来源门 [Runtime]

**输入/输出**:输入为当前回合用户/selection/Reader/tool result 事件；输出为 locator entries，并在 dispatch 前校验所有 `book.text` LID。

**做**:为八类合法 origin 建 ledger；用户明确 LID 与 Reader anchor 只登记 locator，结构/搜索/query/context 只登记其合同允许的 LID 字段；证据结果继续走现有 evidence ledger；工具批次并行时先基于 batch 前 ledger 校验，结果在批次完成后原子合并。

**不做**:不把结果 JSON 中任意字符串当 LID、不回填历史回合的未验证 locator、不因 LID 存在自动登记、不改变 source.present 证据要求。

**完成判据**:用户明确 `1.8`、当前 anchor、structure/search/query/context 返回 LID 均可读取；模型凭空 `book.text("1.8")` 被拒绝，即使该 LID 存在；locator-only 仍不能 source.present 或支撑回答。

**Verify**:`cargo test -p runtime locator_ledger`;`cargo test -p runtime book_text_provenance`;并行批次顺序测试。

**完成回执**:2026-08-24 完成。`TurnLocatorLedger` 与正文 `TurnEvidenceLedger` 独立，按八类冻结 origin 登记当前用户明确 LID、已验证选区、Reader anchor、structure/search/query/context 合同允许字段及新验证 evidence；任意结果字符串、历史未验证 locator 与单纯存在的 LID 均不入账。`book.text` dispatch 在执行前同时校验 `lid/end_lid`，无 provenance 返回 `LID_PROVENANCE_REQUIRED` 且不泄露存在性；同一 tool-call batch 始终读取 batch 前快照，所有 locator 观察与最新 Reader anchor 只在 batch 结束后确定性合并，locator-producing call 的最终签名仍受 `AGENT_NO_PROGRESS` 约束。locator-only 不改变 EvidenceState，也不能通过 `source.present`。定向 `locator_ledger` 3/3、`book_text_provenance` 1/1、完整 Runtime 278/278 + integration 6/6（另 2 个真实 Provider 用例 ignored）、排除 Desktop 的 workspace、Rust fmt、scoped diff check 与 Runtime `--all-targets --no-deps` Clippy 全绿。

## 13. CR8 - 文档级 evidence-plan 与 `LID_NOT_FOUND` 恢复 [Runtime]（已完成）

**输入/输出**:输入为 TaskNeed、locator/evidence ledger 和 ToolResult error；输出为 document/section synthesis 前置闸与结构化恢复要求。

**做**:记录本轮 evidence-plan origin；无用户 evidence 且无结构/搜索/query plan 时拒绝 section/document 的多 LID synthesize；`LID_NOT_FOUND` 设置 `blind_lid_reads_blocked=true`，返回 `required_capability=structural_index`；合法 locator result 解除；错误 receipt 保持有界并可审计。

**不做**:不要求 selection/passage 解释仪式性调用 structure；不把所有 synthesize 都强制走 structure；不改变不存在 LID 的底层 Book 错误。

**完成判据**:document summary 不能从猜测 LID 进入 synthesize；not-found 后下一次 blind read 在 adapter/Book 调用前被拒绝；经 structure/search 得到 locator 后恢复；“解释我选中的一句”零结构调用仍成功。

**Verify**:`cargo test -p runtime evidence_plan_gate`;`cargo test -p runtime lid_not_found_recovery`;selection regression tests。

**完成回执**:2026-08-24 完成。`TurnEvidencePlanLedger` 独立记录用户已验证 evidence、成功 structure/search/query 结果与 section/document `TaskNeed`；`book.synthesize` 在 dispatch 前同时读取 batch-start evidence-plan、evidence state 和 locator 快照，多 LID 或 broad synthesis 在无用户 evidence 且无合法 plan 时返回 `EVIDENCE_PLAN_REQUIRED`，合法 plan 仍只能读取其返回的 locator。底层 `LID_NOT_FOUND` receipt 有界追加 `required_capability=structural_index`，批次末把 blind-read recovery 状态置闸；恢复前 `book.text/book.synthesize` 在 Book adapter 前返回 `LID_RECOVERY_REQUIRED`，合法 locator result 只在下一 sampling 解闸。同批次 structure 不能提前授权 synthesize 或恢复 blind read；selection multi-LID 与 passage single-LID 保持零 structure 路径。定向 `evidence_plan_gate` 7/7、`lid_not_found_recovery` 2/2、selection 回归 8/8、完整 Runtime 287/287 + integration 6/6（另 2 个真实 Provider 用例 ignored）、排除 Desktop 的短临时路径 workspace 与 doc tests 全绿。

## 14. CR9 - 阶段进展、最终采样与 UI 口径 [Runtime/Server/Web]（已完成）

**输入/输出**:输入为每次 tool/capability/evidence/effect 事件；输出为 ProgressPhase、阶段化 no-progress、最后一次 tools-disabled finalization 和准确 UI 文案。

**做**:阶段 advance 由 Runtime 事件确定；不同参数但无新 locator/evidence/capability/effect 不算进展；预算保留 finalization sampling；Server diagnostic 区分 loop/active-context/protocol/evidence 错误；Web 将“工具调用次数上限”改为“模型—工具循环次数上限”。

**不做**:不提高默认 loop 上限掩盖问题、不允许 finalization 再调工具、不合并不同错误码、不改变 Provider token 预算。

**完成判据**:blind enumeration 在有界次数内触发 `AGENT_NO_PROGRESS`；最后工具批次仍可产最终回答；finalization 若输出 tool call 则 protocol error；UI 与 trace 显示 loop count 而非 tool-call count。

**Verify**:`cargo test -p runtime agent_progress_phase`;`cargo test -p runtime finalization_sampling`;`cargo test -p server agent_loop_diagnostics`;Web component/unit test 与 typecheck。

**完成回执**:2026-08-24 完成。Runtime 以 `ProgressPhase` 和 locator/evidence/capability/synthesis/effect 状态计算进展，连续两个无变化批次后在下一批 dispatch 前返回 `AGENT_NO_PROGRESS`；参数变化本身不解闸。合法 guided-read 回归发现“本轮首次成功消费 capability”未进入签名会造成误停滞，现以 `completed_capabilities` 只记成功调用且每项只贡献一次进展，失败调用、blind 参数枚举与 exact-repeat 语义保持不变。最后一个合法工具批次后保留一次零工具 finalization，原生或文本工具调用以 `FINALIZATION_TOOL_PROTOCOL_VIOLATION` 失败关闭。`TraceStep.model_tool_loop` 以可选 1-based 序号兼容旧历史；Server 保留 loop/capacity/protocol/evidence 的原始 code/category，Web 分列模型—工具循环数与工具调用数并修正上限文案。定向 Runtime 5/5、Server 1/1、RightRail 14/14 与 Web typecheck 全绿；完整 Runtime 292/292 + integration 6/6（另 2 个真实 Provider 用例 ignored）、Server 231/231 + Book MCP 5/5、Web 38 files / 215 tests、排除 Desktop 的 workspace/doc tests、Rust fmt、既有基线类别 allow 下 scoped Runtime Clippy 与 diff check 全绿。

## 15. CR10 - 语义泛化与发布门 [Runtime/Real model]（已完成）

**输入/输出**:输入为冻结书、模型/profile/prompt/ToolExposurePlan 版本和独立改写集；输出为不含正文/prompt 的有界 release receipts。

**做**:用至少五个互不共享触发短语的中英改写测试 document overview；另测 selection explanation、literal locate、explicit guided read 和“不要带我读，只总结全书”；保存首个 evidence-planning tool、blind-read count、Reader effects、phase transitions、loop result 与 prompt/tool hashes。

**不做**:不把 eval 改写写入产品 classifier/同义词表；不让模型自评成功；不保存书内正文、prompt text、API key、memory/profile 私密内容。

**完成判据**:
- 所有 document-overview 改写首个 evidence planner 为 `book.structure` 或 profile 对应 StructuralIndex；无 ReaderWrite、blind LID、turn limit。
- explicit guided read 仍唯一 goto、目标属于 guide path、先读取同一目标正文。
- selection explanation 在证据充分时零工具或只走局部 Text/Context，不调用 structure/navigation。
- literal locate 首个定位工具为 `book.search_text`，分页完整性不退化。
- deterministic 全量测试、Rust fmt/clippy、Server/Web 邻接测试和真实模型 release gate 全绿。

**完成回执**:2026-08-24 完成。`semantic_release_receipt.v1` 将 prompt、instructions、tool schemas、answer 与书身份投影为 SHA-256，只保留有界工具/LID 摘要、Reader effects、blind-read count、Runtime phase transitions 与 loop result；`semantic_release_bundle.v1` 离线验证五条 prompt digest 唯一且覆盖中英文的 document-overview，以及 selection、literal、guided、negated-summary 各一条，并以既有 `guided_read_route_replay.v1` 加固 guided 场景。evidence-routing/source-delivery 升级为 v4：overview 只复制已授权 locator 中最多六个跨 throughline/key-stop 的代表性 LID，provenance/recovery 或 `SOURCE_NOT_OBSERVED` 后停止派生/邻接重试；eval 原文只存在测试夹具，未进入 classifier/同义词表。`deepseek-v4-flash` Native 真模门 9/9 与 bundle offline verifier 全绿：五条 overview 和 negated-summary 均以 `book.structure` 首开、blind-read=0、Reader effect=0，selection 零工具，literal 首调用 `book.search_text`，guided 唯一 Goto；脱敏 bundle 106,881 bytes，SHA-256 `5a91b989849b8ef0b8667694c63690d97cb7e092b32f028e2cf88d2a07020e89`，禁用 payload marker 零命中。当前工作树复验 Runtime 299/299 + integration 6/6（3 个真模用例 ignored）、Server 231/231 + Book MCP 5/5、Web 38 files / 215 tests + typecheck、Rust fmt、`--no-deps` scoped Runtime Clippy（仅 allow 冻结基线类别）与 `git diff --check` 全绿。

## 16. 测试矩阵

| 场景 | Scope/Operation/Evidence | 必须出现 | 禁止出现 |
|---|---|---|---|
| 全书主线概述 | Document/Summarize/Unlocated | StructuralIndex；定位后的 evidence | ReaderWrite；blind text reads |
| “不要带我读，只总结全书” | Document/Summarize/Unlocated/ReadOnly | `book.structure` | `reader.state/guide_path/gotoLid` |
| 显式带读一章 | Section/Navigate/CurrentAnchor/ExplicitMutation | ReaderRead + StructuralIndex + NavigationPlan + one Goto | unrelated Reader writes |
| 解释已验证选区 | Selection/Explain/UserProvided | zero tool 或局部 Text/Context | Structure/Navigation ceremony |
| 找第一次字面出现 | Document/LocateLiteral/Unlocated | LexicalLocate | SemanticQuery/ReaderWrite |
| 不存在的猜测 LID | Unlocated/ReadSource | provenance rejection/recovery | 第二次 blind enumeration |
| 无权限请求跳转 | Navigate/Reader mutation request | blocked reason | ReaderWrite activation/effect |

开放语义测试只证明模型能把多种表达映射到同一结构；确定性不变量测试才证明错误路径走不通。两者不得互相替代。

## 17. 提交与回滚纪律

- CR0/CR1、CR2、CR3、CR4、CR5、CR6、CR7、CR8、CR9、CR10 各自独立提交；任一红测只回滚当前刀。
- schema/result/replay 版本升级与消费者测试必须同切片提交；禁止先改生产版本后补 migration。
- CR3/CR4 的等价迁移若改变 visible tool golden，先判为回归，不在同切片“顺手修正”策略。
- CR7/CR8 上线前保留 server-only shadow diagnostic 比较“现有允许调用”与“新 gate 判定”，但 shadow 不改变执行结果、不记录正文。
- 真模 receipt 只保存结构化轨迹与 digest；任何 prompt/source/private payload 泄漏均为发布阻断。
