# 切片方案 · Runtime-owned 可靠画像 memory

> **定位**:把现有“Agent 自愿 save/recall”的 memory 升级为 runtime 可靠写入、可靠消费、证据可追溯、按 `content_profile` 适配的读者画像系统。
> **冻结决策**:[ADR-0075](adr/0075-runtime-owned-evidence-backed-profile-memory.md)。
> **状态**:§0.5 Grill 已收口,仅完成 ADR/方案落档;尚未声明任何代码 A1 切片。

---

## 0. 对齐确认单

**FrozenIntent**:在保留 `memory.json` 单一真相源、现有 note/highlight/qa/read 与 LID/citation 红线的前提下,补齐全局画像、单本阅读状态、自动快照消费、显式前台记忆和可恢复后台整理;最终用户无需提醒 Agent 调 memory,且能看见它何时整理、记了什么、哪次回答用了什么。

**明确不做**:

- 不改 `book.query` 能力与证据算法。
- 不做账户、多用户、跨设备同步或云端画像。
- 不做应用级加密;MVP 保持本地明文并执行敏感信息边界。
- 不实现 `InteractionRoutine`;只保留非生效 intent 观察及后续晋升路径。
- 不把 Book Profile、Reader Profile 或私人事实写进只读 book base。
- 不让 visitor/MCP/build-workbench 会话读取、生成或修改读者私人画像。

**成功标准**:§8 的确定性契约全部通过,并至少跑通“显式记住 → 新对话自动注入”“普通自我表达 → 后台审核 → 下一对话生效”“paper 专属偏好不污染 technical_learning”“崩溃后 watermark 补跑”“忘记后所有派生物消失”五条端到端路径。

**RiskReceipt**:用户已接受重新审视 ADR-0038/0039 对后台抽取的否决;风险由来源/作用域分级、证据引用、pending 全局推断、可见 job 状态、纠正/硬忘记和 profile policy 隔离控制,但 LLM 推断仍不是确定事实。

**ChangeType**:`[边界重构]`。

### 0.1 TermMap

| 术语 | 状态 | 最终含义 |
| --- | --- | --- |
| `memory` / `memory.json` | EXISTING | 本地单用户、跨书、与 book base 隔离的私人记忆真相源 |
| `Record` | EXISTING | note/highlight/qa/read/context 等内容记忆记录 |
| `MemoryDocument` | BOUNDARY_CHANGE | `memory.json` 的版本化文档信封 |
| `ProfileFact` | NEW | 带 scope/applicability/source/evidence/status 的画像事实 |
| `GlobalReaderProfile` | NEW | 跨书稳定画像的派生视图 |
| `BookReadingState` | BOUNDARY_CHANGE | 旧代码级 `ReaderProfile` 的正式含义,含原始行为信号与 profile 投影 |
| `ReaderProfileSnapshot` | NEW | runtime 自动注入、token 有界、可重建的当前读者上下文 |
| `MemoryIntentGate` | NEW | 显式记忆意图的 runtime 前台入口 |
| `ReviewJob` | NEW | 未审核 resident 回合的持久增量抽取任务 |
| `MemoryPolicy` | NEW | `content_profile` 提供的私人信号解释与排序策略 |
| `ProfileUsageTrace` | NEW | 区分 injected 与 claimed-used 的回答使用轨迹 |
| `InteractionRoutine` | DEFERRED | 只有稳定多步流程证明价值后才晋升的未来能力,本轮不实现 |

零 `UNRESOLVED` 术语;可调数字阈值属于运行参数,不改变领域语义。

---

## 1. 当前代码基线

| 路径 | 当前事实 | 本方案改动方向 |
| --- | --- | --- |
| `crates/memory/src/lib.rs:MemoryStore` | 内存持有裸 `Vec<Record>`;默认落 `~/.understand-book/memory/memory.json` | 改持 `MemoryDocument`;旧数组确定性迁移 |
| `MemoryStore::save/delete/replace` | save/delete 有直接整文件写;replace 有临时文件 + backup 切换 | 所有 mutation 统一走原子文档提交 |
| `MemoryStore::derive_reader_profile` | `{book_id,read_lids,focus_lids,puzzle_heat}` | 行为保持后重命名为 `BookReadingState`;qa 变原始 activity |
| `render_reader_profile_md` / `render_handbook_md` | 从 Record 确定性导出只读 Markdown | 保留单向派生;增加画像状态/ID,敏感值脱敏 |
| `orchestrator::SYSTEM_PROMPT` | 提示主 Agent 自行调用 `memory.save/recall` | 不再把画像正确性托付给 prompt/tool motivation |
| `orchestrator::new_session` | 只放静态 system prompt | 每个 resident 用户回合由 runtime 临时装配 snapshot,不写历史 |
| `AgentHistory` | 按 book 保存 transcript + backend messages;当前 turn 无稳定 ID,成功回答后才整体入历史 | resident 用户 turn 获得稳定 ID 并在模型调用前持久化,成为 EvidenceRef;历史本身仍非 memory truth |
| `server::AppState` | `Arc<Mutex<AppState>>`;LLM 调用期间持共享锁 | 后台 review 的模型调用不得持该锁 |
| `ProfileManifest` registry | 已有 `technical_learning` / `paper` | 增加 versioned MemoryPolicy 标识与中性降级 |
| Web reader | 有 memory 注释 API,无画像治理面 | 增加状态、画像、候选、纠正/忘记与 trace UI |

---

## 2. 核心数据契约

### 2.1 MemoryDocument v2

```rust
const MEMORY_SCHEMA_VERSION: u32 = 2;

struct MemoryDocument {
    schema_version: u32,
    document_revision: u64,
    projection_revision: u64,
    records: Vec<Record>,
    profile_facts: Vec<ProfileFact>,
    review_state: ReviewState,
    exclusions: Vec<EvidenceExclusion>,
}
```

约束:

- `document_revision` 在任一完整 mutation 原子提交成功后递增;`projection_revision` 只在 records/facts/exclusions 改变可注入投影时递增,job 状态变化不得令 snapshot 假失效。
- 本方案未特别注明的 `source_revision` / `snapshot_revision` 都固定引用 `projection_revision`;治理 mutation 的乐观并发检查才使用 `document_revision`。
- 旧裸 `Vec<Record>` 首次打开时迁移;迁移失败不得覆盖原文件。
- `Record` 的 JSON 兼容形状与现有 mem_id/citation/selection 语义不变。
- facts/jobs/watermark 必须在同一文档提交中保持一致;派生 Markdown 不参与提交成功判定。
- hard forget 允许物理删除,因此“账本”表示证据化演化模型,不承诺永不删的 event log。

### 2.2 ProfileFact

```rust
struct ProfileFact {
    fact_id: String,
    scope: ProfileScope,
    applicability: Applicability,
    payload: ProfilePayload,
    source: FactSource,
    evidence: Vec<EvidenceRef>,
    status: FactStatus,
    confidence: Option<Confidence>,
    sensitivity: Sensitivity,
    created_at: String,
    updated_at: String,
    valid_until: Option<String>,
    supersedes: Vec<String>,
}

enum ProfileScope {
    Global,
    Book { book_id: String },
}

enum Applicability {
    Any,
    ContentProfile { profile_id: ContentProfileId },
    PaperSubtype { subtype: String },
    Domain { domain: String },
}

enum ProfilePayload {
    Background(BackgroundClaim),
    Capability(CapabilityClaim),
    Goal(GoalClaim),
    ExplanationPreference(PreferenceClaim),
    Constraint(ConstraintClaim),
    Extension { namespace: String, key: String, value: serde_json::Value },
}

enum FactSource {
    DeterministicBehavior,
    UserStated,
    AgentInferred,
}

enum FactStatus {
    Confirmed,
    Provisional,
    Pending,
    Superseded,
    Expired,
}

enum Confidence { Low, Medium, High }
enum Sensitivity { Normal, Sensitive }
```

核心 payload 强类型;`Extension` 必须由命名空间 schema 校验。`confidence` 只允许用于 `AgentInferred`;不得用浮点分数覆盖用户明确陈述。

### 2.3 EvidenceRef

```rust
enum EvidenceRef {
    Turn { session_id: String, turn_id: String },
    MemoryRecord { mem_id: String },
    BookLocation { book_id: String, lid: String },
}

struct EvidenceExclusion {
    evidence_id: String,
    reason: ExclusionReason,
    created_at: String,
}
```

- `ProfileFact` 不复制整段对话原文;UI 按引用解开。
- Assistant/tool/web 内容可帮助 extractor 理解语境,但不得成为用户画像的唯一根证据。
- 推断事实失去全部有效证据后退出 snapshot;用户明确事实可保留规范化结论并显示“来源已删除”。
- “忘记”删除事实和值,只保留不含内容的 exclusion,防止旧 turn 被再次抽取。

#### §2.3.1 显式画像证据

**决策**:M1 将明确 remember/correct 原话作为内部 `profile_evidence` Record,与引用它的 `ProfileFact` 在同一 `MemoryDocument` mutation 中原子提交。

**否决**:
- 提前实现 M2.2 turn precommit:越过 M1 边界。
- 无 evidence 的明确事实:无法审计或防止 forget 后重抽取。

**命门**:内部 evidence 不进普通 recall/snapshot;forget 必须物理删值并只留 content-free exclusion。
**何时回头**:M2.2 提供可恢复 turn evidence 后,普通后台抽取直接使用 `EvidenceRef::Turn`。

### 2.4 ReviewState

```rust
struct ReviewState {
    review_jobs: Vec<ReviewJob>,
    consolidation_jobs: Vec<GlobalConsolidationJob>,
    intent_observations: Vec<IntentObservation>,
    reviewed_through: BTreeMap<String, u64>, // session_id -> user turn ordinal
    last_success_at: Option<String>,
    last_error: Option<ReviewErrorState>,
}

struct ReviewJob {
    job_id: String,
    session_id: String,
    book_id: String,
    from_turn_exclusive: u64,
    to_turn_inclusive: u64,
    status: ReviewJobStatus,
    attempts: u32,
    next_attempt_at: Option<String>,
    created_at: String,
    updated_at: String,
}

enum ReviewJobStatus { Queued, Running, Retryable, Completed }

struct GlobalConsolidationJob {
    job_id: String,
    affected_keys: Vec<String>,
    source_revision: u64,
    status: ReviewJobStatus,
    attempts: u32,
    next_attempt_at: Option<String>,
}

struct IntentObservation {
    observation_id: String,
    intent_key: String,
    content_profile: ContentProfileId,
    evidence: Vec<EvidenceRef>,
    created_at: String,
}
```

`job_id`、intent observation 与 extractor candidate ID 必须内容寻址。单机只允许一个 review executor;进程启动时把遗留 `Running` 恢复为 `Queued`,不引入分布式 lease/全局锁/git baseline。`IntentObservation` 不进入 snapshot、不影响回答、不触发动作,只供后续评估是否值得晋升 `InteractionRoutine`。

### 2.5 BookReadingState

```rust
struct BookReadingState {
    book_id: String,
    content_profile: ProfileRef,
    read_lids: Vec<String>,
    engagement_by_lid: BTreeMap<String, EngagementSignals>,
    active_book_fact_ids: Vec<String>,
    profile_state: ProfileStateEnvelope,
}

struct EngagementSignals {
    qa_count: u32,
    note_count: u32,
    highlight_count: u32,
    last_seen_at: Option<String>,
}

struct ProfileStateEnvelope {
    profile_id: ContentProfileId,
    profile_version: String,
    source_revision: u64,
    state: serde_json::Value,
}
```

`ProfileStateEnvelope` 是可重建投影,不写入 `profile_facts`;MVP 只进程内缓存。旧 `focus_lids` 与 `puzzle_heat` 通过原始 signal 派生兼容消费,不再表达全局语义。

### 2.6 ReaderProfileSnapshot

```rust
struct ReaderProfileSnapshot {
    source_revision: u64,
    profile_status: ProfileStatus,
    global_core: Vec<SnapshotItem>,
    applicable_global: Vec<SnapshotItem>,
    book_state_core: Vec<SnapshotItem>,
    profile_projection: Vec<SnapshotItem>,
    pending_context: Vec<PendingTurnRef>,
}

struct SnapshotItem {
    fact_id: String,
    status: FactStatus,
    text: String,
}

enum ProfileStatus { Current, Stale }
```

Core 为每区设置独立 token budget,只序列化规范化结论、状态和 ID。当前用户指令不属于 snapshot budget,且始终优先。

#### §2.6.1 Snapshot 预算计量

**决策**:各区对实际序列化的 ID、状态与文本独立使用确定性估算单位(CJK=1,其他字符=0.25,向上取整)。

**否决**:
- Provider tokenizer:无法为多 Provider 提供稳定的 Core 契约。
- 只计文本:会忽略真实注入的 ID 与状态开销。

**何时回头**:产品锁定单一 Provider tokenizer 且可保持跨版本稳定时。

#### §2.6.2 Snapshot 分区所有权

**决策**:M1 Core 过滤并分区 ledger facts,同时以 typed input 接收 profile candidates 与 pending context;M1 生产路径后两区先为空。

**否决**:
- M1 内建 `MemoryPolicy`:会提前侵入 M3 边界。
- M1 内建 ReviewJob pending:会提前侵入 M2 边界。

**命门**:五区输入都必须经过 Core 统一序列化与独立预算。
**何时回头**:M2/M3 接入时只替换候选生产者,不改 snapshot 分区契约。

#### §2.6.3 Snapshot 文本边界

**决策**:M1 只把内建 typed payload 按 `status + fact_id + kind.key + JSON-escaped value` 序列化为只读数据,不注入未验证 `Extension`。

**否决**:
- 自由文本 prompt:无法区分画像数据与指令。
- 直接注入 `Extension`:M3 namespace schema validator 尚不存在。

**命门**:snapshot 外层必须明示“只读数据、当前用户指令优先”。
**何时回头**:M3 为命名空间提供已验证的 typed serializer 时。

### 2.7 ProfileUsageTrace

```rust
struct ProfileUsageTrace {
    snapshot_revision: u64,
    injected_fact_ids: Vec<String>,
    claimed_used_fact_ids: Vec<String>,
    influences: Vec<ProfileInfluence>,
}

enum ProfileInfluence {
    RetrievalPlan,
    ExplanationDepth,
    Terminology,
    ExampleChoice,
    Navigation,
}
```

runtime 记录 injected;模型只能从 injected 子集中声明 used。声明用于解释和弱统计,不得单独驱动删除、晋升或事实判定。

`claimed_used` 通过 resident-only 的可选内部工具 `profile.mark_used({fact_ids,influences})` 收集;它不修改 memory。模型未调用时该列表为空,runtime 不猜测实际使用,而 `injected_fact_ids` 仍始终完整可查。

---

## 3. 写入、审核与读取状态机

### 3.1 前台 MemoryIntentGate

```text
UserMessage
  -> structured UI memory action?
       yes -> deterministic MemoryOp
       no  -> explicit phrase fast scan
                 miss -> main agent immediately
                 hit  -> structured foreground extractor -> MemoryOp

MemoryOp
  -> schema + source + scope + sensitivity policy
  -> atomic MemoryDocument mutation
  -> main agent receives operation result
```

显式短语包括“记住/记下/以后都/我纠正一下/忘记/不要记录”等。fast scan 不做语义画像判断;只有命中后才调用结构化 extractor。未命中的自我表达由 ReviewJob 最终审核,当前回合直接使用原始用户消息。

主 Agent 的 `memory.save(type=context)` 保留为普通 context memory;它不再直接创建或修改 ProfileFact。若保留 agent profile proposal 工具,也只能提交 CandidateFact,经过同一 validator。

### 3.2 每回合可靠入队

```text
user_message_received
  -> 1. 分配稳定 turn_id
  -> 2. 以 PendingAssistant 状态原子保存用户 turn
  -> 3. 执行 MemoryIntentGate 与 main agent

assistant_finished_or_failed
  -> 4. 回填 Completed/Failed outcome 并原子保存 AgentHistory
  -> 5. 对 reviewed_through..latest_turn 创建/合并 ReviewJob
  -> 6. 原子保存 MemoryDocument.review_state
```

用户原话必须先于 provider 调用持久化,因此回答失败也不能丢失自我表达。两个文件无法跨文件事务,启动/边界时必须按 `AgentHistory turn ordinal - reviewed_through` 重建漏入队 job;重复入队、重复 extractor 输出和重复 commit 均由稳定 ID 去重。

### 3.3 ReviewJob 执行

```text
short lock:
  claim queued job + copy immutable ReviewInput
unlock
  structured model extraction
  deterministic candidate validation
short lock:
  append/upsert facts + advance watermark + complete job in one document commit
```

模型调用期间严禁持有 `Arc<Mutex<AppState>>`。后台 executor 使用与 resident agent 同一 provider 配置的独立 adapter/executor seam;provider hot reload 同步更新该配置,但 review 串行执行。

ReviewInput 可含必要的 assistant/tool 语境,但 candidate evidence 至少包含一个 resident user turn 或确定性用户动作。visitor/MCP/build-workbench 全部不 eligible。

### 3.4 触发与失败

| 事件 | 动作 |
| --- | --- |
| 最后一次交互后空闲 60 秒 | 合并运行所有 queued ReviewJob |
| 未审核用户回合达到 8 | 当前回答持久化后强制运行 |
| 新对话 / 切书 / context compression | 发起 drain,最长等待可配置边界超时(初始 10 秒) |
| 正常退出 | 只保证 job 已持久入队;来不及执行则下次启动补跑,不得依赖退出瞬间网络调用 |
| 崩溃 / 强制关闭 | 下次启动按 watermark 重建并补跑 |
| provider/rate limit/解析失败 | job 进入 Retryable,记录错误并退避 |

边界超时后使用 `last_good_snapshot + token 有界 PendingMemoryContext`,标记 `profile_status=stale` 并继续重试;不得静默使用旧画像。

### 3.5 两级整理

```text
ReviewJob(session, book, turn_range)
  -> CandidateFact[]
  -> validator
  -> ProfileFact ledger

affected profile key changes
  -> distinct books >= 2
  -> independent evidence >= 3
  -> GlobalConsolidationJob
  -> pending global promotion candidate
```

用户明确的全局表达直接按 `UserStated + Global` 处理,不等阈值。全局 consolidation 不扫描全部原始聊天,也不能让 agent-inferred global fact 跳过用户确认。

---

## 4. 信任、冲突与生命周期

### 4.1 信任矩阵

| source × scope | 写入状态 | 可否自动进入 snapshot |
| --- | --- | --- |
| deterministic behavior × book | Confirmed | 可以,作为行为事实 |
| user stated × global/book | Confirmed | 可以,低打扰通知 + undo |
| agent inferred × book | Provisional | 可以,仅作当前书弱提示 |
| agent inferred × global | Pending | 不可以,等待用户确认 |
| historical backfill candidate | Pending | 不可以,集中预览确认 |

敏感信息例外:secret 永拒;敏感画像永不自动推断;用户明确保存须二次确认本地明文风险。

#### §4.1.1 画像隐私分类

**决策**:确定性 validator 将写入分为 Normal、Sensitive 与 Secret;Secret 永拒,Sensitive 只在用户明示后经下一条消息确认才写本地明文。

**否决**:
- 仅由 extractor 判风险:模型不能作隐私终闸。
- Secret 确认后保存:确认不能解锁凭据类数据。

**命门**:validator 可将 extractor 结果升级为 Sensitive/Secret,绝不得降级;非确认的下一条消息取消 pending sensitive op。
**何时回头**:当新法域、产品同步或加密改变数据保管边界时。

### 4.2 scope 与 applicability

- 明确“以后都/我一直”可写 Global。
- 明确当前书/章节/概念写 Book。
- 阅读语境中的含糊陈述默认 Book。
- 跨书重复只生成 Global pending candidate。
- `scope=Global + applicability=ContentProfile(paper)` 表示跨论文复用但不影响技术书。

### 4.3 确定性冲突解析

```text
current explicit instruction (ephemeral)
  > current-book scoped active fact
  > applicable global active fact

subjective profile authority:
  user correction > user statement > agent inference

objective reading state:
  deterministic event reducer only
```

同 scope/authority 取最近明确表达;无法判定的冲突并列进入审核,模型不得猜。单本覆盖不反向改写全局。

### 4.4 生命周期

| 类型 | 生命周期 |
| --- | --- |
| 用户明确长期画像 | 不自动衰减;纠正/忘记/新陈述改变 |
| 有期限目标/约束 | 到期或完成后退出 snapshot |
| BookReadingState | 离开书后归档,重返恢复 |
| book provisional hypothesis | 随活跃度衰减;完成/长期不用后退出 snapshot |
| pending global inference | 审核窗口过期后放弃 |
| deterministic behavior | 原记录保留;影响力由当前 policy/recency 决定 |

衰减不改写原始证据;只改变 active projection。

### 4.5 纠正与忘记

- `Correct`:创建新 fact 并 supersede 旧 fact,旧值不进 snapshot但保留审计。
- `Forget`:物理清除 fact、证据副本、候选、索引、缓存和派生 Markdown内容;保留 content-free exclusion。
- 删除原聊天不自动等于 forget;失去全部证据的 inferred fact 自动退出 snapshot。
- “以后不要记这类信息”是 collection rule,不是普通画像事实。

---

## 5. Content Profile MemoryPolicy

### 5.1 统一边界

```rust
trait MemoryPolicy {
    fn profile_id(&self) -> ContentProfileId;
    fn profile_version(&self) -> &str;
    fn validate_extension(&self, fact: &CandidateFact) -> Result<(), PolicyError>;
    fn derive_book_state(&self, input: &PolicyProjectionInput) -> ProfileStateEnvelope;
    fn rank_snapshot_items(&self, input: &[SnapshotCandidate]) -> Vec<RankedSnapshotCandidate>;
    fn reading_hints(&self, state: &ProfileStateEnvelope) -> ReadingHints;
}
```

policy 只能消费 Core 提供的 typed facts/signals,输出 versioned state/candidate IDs/hints;不得直接写 memory、改变 trust/delete/citation、或返回自由 prompt 文本。

### 5.2 NeutralMemoryPolicy

插件缺失、版本不兼容或新书类未实现时只提供:

- read_lids 与 qa/note/highlight 原始 activity;
- `applicability=Any`/匹配 domain 的确认画像;
- 明确的单本事实。

旧 profile state 标为 orphaned 并退出 snapshot;原始事实不丢。若存在 migrator则迁移,否则从 ledger 重建。

### 5.3 technical_learning

```rust
struct TechnicalLearningMemoryState {
    concept_activity: BTreeMap<String, ConceptActivity>,
    learning_hypotheses: Vec<LearningHypothesis>,
    current_goal_fact_ids: Vec<String>,
    requested_prerequisites: Vec<String>,
}

enum ConceptActivity { Unseen, Encountered, Revisited, UserConfirmedUnderstood }
```

- read 只证明 Encountered;重复访问只证明 Revisited。
- 行为只能产 book-scoped provisional hypothesis,如 `LikelyFamiliar/NeedsReview/WantsMoreExamples/WantsMoreDerivation`。
- novice/expert 或 concept mastery 只允许用户自述或明确有效评测,并保留 domain/evidence。
- 当前指令优先;不能仅因画像跳过关键内容。

### 5.4 paper

```rust
struct PaperMemoryState {
    last_selected_mode: Option<ExplicitChoice<PaperReadingMode>>,
    last_selected_stage: Option<ExplicitChoice<PaperReadingStage>>,
    question_progress: BTreeMap<String, QuestionActivity>,
    terminology_assistance: BTreeMap<String, EngagementSignals>,
    facet_attention: BTreeMap<PaperFacet, Vec<EvidenceRef>>,
}
```

- skim/close/deep 与 passive/active/critical/creative 是显式阅读镜头,不是能力等级或自动升级路线。
- 论文十问只记录 unvisited/explored/user_reflected 等活动,不自动声称“已理解”。
- terminology/method/claim/evidence/limitation 分开;公共论文事实继续留在 paper sidecar。
- policy 可建议 mode/stage,建议本身不写画像。

---

## 6. A4 实施切片

以下 M0-M4 是五个高层阶段;每个子刀单独 A1 声明、单独测试、单独 commit。任何子刀不得夹带下一个阶段的功能。

### M0 · 数据地基

#### M0.1 当前行为 characterization

- **做**:增加 legacy `Vec<Record>` fixture,锁住 save/recall/delete/replace、mem_id、citation、selection、ReaderProfile 和 Markdown 当前行为。
- **不做**:不改生产代码和文件格式。
- **判据**:`cargo test -p memory` 通过;fixture 能被当前 `MemoryStore::open` 读取。
- **触达**:`crates/memory` tests/fixtures。

#### M0.2 MemoryDocument envelope + 原子迁移

- **做**:引入 v2 envelope、`document_revision` 与 `projection_revision`;legacy open 后原子迁移;所有 mutation 统一原子提交。
- **不做**:不新增 ProfileFact mutation API,不改 Agent 行为。
- **判据**:legacy 无损迁移;模拟写失败保留原文件;重复打开不重复迁移;现有 Record 测试全绿。
- **触达**:`crates/memory/src/lib.rs`,新 `document.rs`,fixtures。

#### M0.3 ProfileFact reducer

- **做**:落 typed fact/evidence/status/scope/applicability/sensitivity;实现 create/confirm/correct/expire/forget 与确定性 resolver。
- **不做**:不接 LLM、不注入 prompt、不写 UI。
- **判据**:信任矩阵、scope 优先级、supersede、hard forget、exclusion、stable ID 均有单测。
- **触达**:`crates/memory/src/profile.rs`, `crates/memory/src/lib.rs`。

#### M0.4 ReaderProfile → BookReadingState 纯重构

- **做**:在行为不变前提下重命名 code-level ReaderProfile;把 read/focus/puzzle 输入改表述为 read + EngagementSignals,给现有 guided route 兼容投影。
- **不做**:不增加画像推断,不改变现有 route 排序结果。
- **判据**:重构前 characterization 与 runtime guided-route tests 全绿;序列化变化有明确兼容层。
- **触达**:`crates/memory`, `crates/runtime`, `crates/server`。

**M0 总闸**:`cargo test -p memory && cargo test -p runtime && cargo test -p server`。

### M1 · 显式记忆闭环

#### M1.1 ReaderProfileSnapshot 纯投影

- **做**:实现全局/适用/单本/profile/pending 分区、预算裁剪、`projection_revision` cache invalidation;用 seeded facts 生成 snapshot。
- **不做**:不接对话、不调用模型。
- **判据**:状态/authority/applicability/recency 排序与各区 token 上限可确定性测试。
- **触达**:`crates/memory/src/projection.rs`, `crates/runtime/src/profile_context.rs`。

#### M1.2 每回合 ephemeral 注入

- **做**:resident `run()` 每回合装配 snapshot,所有 tool loop 请求可见同一 `source_revision`;不把 snapshot 写进 AgentHistory/messages。
- **不做**:不后台抽取、不改 visitor/MCP。
- **判据**:新对话 seeded fact 自动出现;history JSON 不含 snapshot;visitor 工具面无私人事实。
- **触达**:`crates/runtime/src/orchestrator.rs`, `crates/server/src/lib.rs`。

#### M1.3 MemoryIntentGate + MemoryOp

- **做**:结构化 UI op、确定性短语快筛、命中后的 structured extractor、统一 validator;实现 remember/correct/forget。
- **不做**:未命中消息不额外调用模型;不做普通表达后台抽取。
- **判据**:显式记住同回合 Confirmed;模糊 target 返回澄清;secret 拒绝;敏感事实要求二次确认;普通问题零 gate 模型调用。
- **触达**:`crates/runtime/src/memory_intent.rs`, `crates/memory`, server routes/tests。

#### M1.4 Usage trace + API 状态

- **做**:OuterOutcome 增 `ProfileUsageTrace`/memory updates;增加可选 `profile.mark_used` telemetry 工具;暴露 snapshot/status/facts 最小只读 API。
- **不做**:不做最终治理 UI。
- **判据**:claimed IDs 必须是 injected 子集;不存在 ID 被拒;API 可验证显式记忆跨新对话生效。
- **触达**:`crates/runtime`, `crates/server`, generated TS types。

**M1 总闸**:脚本化两会话测试证明“remember X → new chat → 无 recall 自动注入 X”。

### M2 · 增量后台整理

#### M2.1 ReviewState + watermark reducer

- **做**:落 ReviewJob/status/watermark/error/idempotency;实现启动时 Running→Queued 与 history 差量 reconciliation。
- **不做**:不启动线程、不调模型。
- **判据**:模拟 transcript-save/job-save 任一侧崩溃都能重建唯一 job;completed job 不重跑出重复 fact。
- **触达**:`crates/memory/src/review.rs`, server fixtures。

#### M2.2 AgentHistory stable turn + precommit

- **做**:给 resident user turn 增稳定 `turn_id` 与 PendingAssistant/Completed/Failed 状态;在 provider 调用前原子持久化用户原话,完成后再回填 outcome。
- **不做**:不创建 ReviewJob,不改 visitor history。
- **判据**:fake provider 失败后重启仍能读取同一 user turn/evidence ID;旧 history 确定性补 ID 且重复加载稳定。
- **触达**:`crates/server/src/lib.rs`, AgentHistory migration/tests。

#### M2.3 resident turn commit 入队

- **做**:AgentHistory 成功持久化后立即创建/合并 job;book switch/new chat 先登记边界 drain。
- **不做**:不执行 extraction;visitor/build-workbench 不入队。
- **判据**:每个 eligible user ordinal 最终被某 job 覆盖且无间隙;不合格会话 job 数恒零。
- **触达**:`crates/server/src/lib.rs`, agent history tests。

#### M2.4 独立 ReviewExecutor seam

- **做**:建立不持 AppState lock 的结构化 review executor/provider 配置通道;一次只执行一个 job。
- **不做**:不实现 profile-specific semantics。
- **判据**:阻塞 fake executor 时 `/reader/state` 等纯本地请求仍可获取 state;provider hot reload 后新 job 用新配置。
- **触达**:`crates/server/src/host.rs`, `crates/runtime/src/memory_review.rs`。

#### M2.5 Incremental extractor + validator

- **做**:ReviewInput→CandidateFact[] + 非生效 IntentObservation[] 结构化 prompt/parser;证据资格、scope local-first、trust/sensitivity 校验;原子 facts/observations+watermark commit。
- **不做**:不做 global consolidation。
- **判据**:assistant/tool 自说不能成画像;user-stated 可 confirmed;book inference 只能 provisional;global inference 只能 pending;intent observation 永不进入 snapshot 或触发动作。
- **触达**:`crates/runtime/src/memory_review.rs`, `crates/memory`。

#### M2.6 调度、重试与 stale 降级

- **做**:60 秒 idle、8 回合兜底、边界有限等待、retry backoff、startup resume、PendingMemoryContext。
- **不做**:不靠真实 sleep 验证;不静默吞错误。
- **判据**:注入 fake clock/scheduler 覆盖所有触发;边界超时返回 stale + pending;重启后 watermark 补齐。
- **触达**:`crates/server/src/host.rs`, review coordinator tests。

**M2 总闸**:崩溃恢复集成测试 + fake-clock 时序测试全绿,且后台模型调用不阻塞本地 reader API。

### M3 · Profile 适配与全局归并

#### M3.1 MemoryPolicy registry + Neutral

- **做**:给 ProfileManifest/registry 增 memory policy ID/version;实现 NeutralMemoryPolicy、版本失配/缺插件降级与 orphaned projection。
- **不做**:不实现 technical/paper 私有字段。
- **判据**:未知 profile 仍能返回 read/activity + 通用 confirmed facts;原始账本不丢。
- **触达**:`crates/read-tools`, `crates/runtime/src/memory_policy.rs`, generated TS。

#### M3.2 technical_learning policy

- **做**:实现 ConceptActivity、LearningHypothesis、目标/前置/讲法 hint;保留现有 route Core。
- **不做**:不从 read/qa 自动生成 mastery 或 novice/expert。
- **判据**:read→Encountered;qa 可影响相关回看但不产 Confirmed 困惑;当前指令覆盖画像 hint。
- **触达**:`crates/runtime`, `crates/memory`, technical policy tests。

#### M3.3 paper policy

- **做**:实现显式 mode/stage、十问活动、术语辅助与 facet attention;消费现有 paper manifest/guide IDs。
- **不做**:不复制 paper metadata/claims/evidence 公共事实到私人 memory,不自动 stage 晋级。
- **判据**:paper 专属偏好只匹配 paper;切 technical_learning 后 snapshot 不含它;mode/stage 只有显式动作才改变。
- **触达**:`crates/runtime`, `crates/read-tools`, paper fixtures/tests。

#### M3.4 Event-driven global consolidation

- **做**:affected-key 索引、2 books/3 evidence eligibility、pending promotion、confirm/reject/expiry、纠正/forget 反向重算。
- **不做**:不扫描全部历史 transcript,不自动确认 global inference。
- **判据**:单书重复永不晋升;满足阈值只产 Pending;确认后下一 snapshot 生效;证据删除后候选撤销。
- **触达**:`crates/memory`, `crates/runtime/src/global_consolidation.rs`。

**M3 总闸**:Neutral/technical/paper 三组 contract tests + cross-profile leakage tests + global promotion tests 全绿。

### M4 · 治理体验与发布验收

#### M4.1 Profile governance API

- **做**:暴露全局/当前书 facts、pending candidates、evidence refs、status、confirm/reject/correct/forget/change-scope 与 collection rules。
- **不做**:不允许 API 直接编辑派生 snapshot/profile state。
- **判据**:所有 mutation 都走 MemoryOp/validator;stale `document_revision` 返回冲突而非覆盖新状态。
- **触达**:`crates/server`, `packages/web/src/api.ts`, generated types。

#### M4.2 Web 画像与状态 UI

- **做**:低打扰 update+undo、ReviewJob 状态、全局/当前书 tab、pending 集中审核、evidence 展开、usage trace 折叠入口。
- **不做**:不逐条弹窗审批,不把功能说明文字常驻主阅读面。
- **判据**:用户可完成查看来源、纠正、忘记、改 scope、确认 global candidate;错误/stale 可见且不遮挡阅读。
- **触达**:`packages/web/src/App.vue` 或拆出的 memory/profile components,组件测试。

#### M4.3 派生 Markdown v2

- **做**:保持 `reader-profile.md` / `reading-handbook.md` 单向覆写;展示 active fact ID/status、Global/Book 分区和 raw activity;敏感值脱敏。
- **不做**:不新增 `USER.md`/`MEMORY.md`,不从 Markdown 反向写回。
- **判据**:same `projection_revision` 输出字节稳定;forget 后值不可 grep;Markdown 写失败不回滚真相源但状态可诊断。
- **触达**:`crates/memory` renderer/tests。

#### M4.4 显式历史回填

- **做**:提供“从历史会话构建画像”预览任务;记录范围/progress;所有候选 Pending;可中止/重跑/清除。
- **不做**:升级时不自动扫历史 context/transcript。
- **判据**:旧 read/note/highlight/qa 已由 M0 自动可用;未 opt-in 时历史语义候选数为零;回填不越过选择范围。
- **触达**:`crates/server`, review pipeline, Web governance UI。

#### M4.5 隐私与端到端发布闸

- **做**:当前 OS 用户文件权限、secret/sensitive cases、全 §8 契约、前后端构建与必要 Playwright。
- **不做**:不声称明文文件已应用级加密。
- **判据**:`cargo test --workspace`, `pnpm test`, `pnpm --filter @understand-book/web build` 通过;§8 每行均有测试 ID 或明确人工验收记录。

**完成记录（2026-07-15）**:当前 OS 用户私有存储 gate 与安全降级已落地;§8.1 为 21/21 自动测试账本。`cargo test --workspace -- --test-threads=1`、`pnpm test`（core 210 + web 99）及 Web production build 全绿。真实 production server 在强制私有存储失败时经 Playwright 验收 1440x900/390x844:Profile stale 诊断可见、PDF 阅读面保留 14 个页面项、document/panel 横向溢出为零、无 page error/request failure/非预期 HTTP 错误;9 个 `formula_semantics` 404 是前端显式处理的可选侧车缺失。

---

## 7. 迁移与兼容

```text
legacy Vec<Record>
  -> MemoryDocument.records (无损)
  -> deterministic BookReadingState from read/note/highlight/qa

legacy context Record
  -> 保持普通 context memory
  -> 不自动变成 ProfileFact

historical AgentHistory
  -> 新 watermark 从升级点开始
  -> 只有显式 backfill 才回扫,且全部 Pending
```

- `memory.save/recall/delete/replace` 内容记录 API 保持兼容;profile mutation 使用独立 typed API。
- 旧 `reader-profile.md` / `reading-handbook.md` 在第一次 v2 mutation 后由新 projector 覆写。
- 迁移前保留原文件直到 v2 原子切换成功;失败返回错误且不启动后台 worker。
- 所有新 TS 类型继续由 Rust `ts-rs` 生成,禁止手编 generated files。

---

## 8. 发布契约矩阵

| ID | 输入场景 | 确定性断言 |
| --- | --- | --- |
| MEM-E01 | 用户明确“记住 X” | 当前回合产生 Confirmed fact + 可见 update |
| MEM-E02 | 普通自我表达 | idle/8-turn 后 watermark 覆盖对应 user ordinal |
| MEM-E03 | extractor 中途崩溃 | restart 后唯一 job 补跑,无重复 fact |
| MEM-E04 | 新对话 | 无 `memory.recall` tool call 仍注入 confirmed fact |
| MEM-E05 | 单本 fact | 其他 book snapshot 不含该 ID |
| MEM-E06 | paper applicability | technical_learning snapshot 不含该 ID |
| MEM-E07 | inferred global | confirm 前 injected_fact_ids 不含该 ID |
| MEM-E08 | correction | 新 snapshot 只选 superseding fact |
| MEM-E09 | forget | document/index/cache/Markdown/candidate 均无原值 |
| MEM-E10 | usage trace | claimed_used ⊆ injected,不存在 ID 被拒 |
| MEM-E11 | review failure | status=stale + error + pending context,用户流程继续 |
| MEM-E12 | ambiguous reading statement | scope=Book,不得自动 Global |
| MEM-E13 | two books/three evidence | 只生成 Pending promotion candidate |
| MEM-E14 | qa activity | 只增加 qa_count,不自动写 mastery/confusion confirmed fact |
| MEM-E15 | paper mode/stage | 只有 explicit choice 改变,行为不自动晋级 |
| MEM-E16 | visitor/MCP turn | reader-private facts/jobs 均不变化 |
| MEM-E17 | secret input | mutation 拒绝且落盘中不可搜索到 secret |
| MEM-E18 | sensitive input | 自动推断拒绝;显式保存等待明文确认 |
| MEM-E19 | legacy migration | Record 逐字段相等,旧文件在失败时保持可读 |
| MEM-E20 | unknown profile | Neutral projection 可用且不丢原始事实 |
| MEM-E21 | repeated intent observation | 可记录 `intent_key`,但 snapshot/动作/回答 contract 均不变化 |

回答“风格是否更合适”另做有/无 snapshot 成对行为评测;LLM-as-judge 只能辅助,不能替代以上 document/watermark/snapshot/trace 断言。

### 8.1 M4.5 coverage ledger

以下 ID 均由自动测试验收;测试名是稳定定位符,最终发布闸仍以实际 runner 结果为准。

| ID | 自动验收测试 ID | 覆盖面 |
| --- | --- | --- |
| MEM-E01 | `server::tests::explicit_remember_commits_before_same_turn_snapshot_and_survives_new_chat` | 当前回合 Confirmed、visible update、同回合 snapshot 与新会话复用 |
| MEM-E02 | `server::host::tests::{fake_clock_triggers_idle_review_only_after_sixty_seconds,fake_clock_forces_review_after_eight_unreviewed_turns}` | 60s idle 与 8-turn 两个调度阈值及 watermark |
| MEM-E03 | `server::host::tests::startup_resume_replays_interrupted_job_once_without_duplicate_fact` | Running crash 后 resume、attempt 与 fact 唯一性 |
| MEM-E04 | `server::tests::new_resident_chat_injects_seeded_profile_without_persisting_snapshot` | 新会话不调用 recall 仍注入,且 snapshot 不落 history |
| MEM-E05 | `memory::profile::tests::resolver_prefers_book_scope_specific_applicability_and_authority`;`memory::projection::tests::partitions_active_facts_and_excludes_pending_expired_and_extensions` | Book scope resolver 与最终 snapshot 双层排除其他书 ID/值 |
| MEM-E06 | `runtime::memory_policy::tests::paper_specific_preference_does_not_leak_into_technical_snapshot` | paper applicability 不进入 technical_learning snapshot |
| MEM-E07 | `memory::global_consolidation::tests::two_books_three_evidence_create_pending_then_confirmed_snapshot` | inferred Global 在 confirm 前不进入 injected IDs |
| MEM-E08 | `memory::profile::tests::correction_supersedes_old_fact_and_resolver_selects_replacement`;`memory::projection::tests::correction_authority_outranks_a_newer_user_statement` | correction chain 与新 snapshot 只选 replacement |
| MEM-E09 | `memory::operation::tests::forget_deletes_correction_chain_evidence_and_disk_values`;`memory::markdown::tests::forget_removes_values_from_both_materialized_views`;`memory::backfill::tests::forget_scrubs_backfill_candidates_that_share_excluded_evidence`;`server::tests::profile_governance_http_enforces_revision_replay_and_all_mutation_actions` | document/evidence、Markdown、backfill candidate 与 resident cache/API 均移除原值 |
| MEM-E10 | `runtime::orchestrator::tests::profile_mark_used_accepts_only_injected_ids_and_is_atomic_on_error` | claimed_used 子集约束与不存在 ID 原子拒绝 |
| MEM-E11 | `server::host::tests::fake_boundary_timeout_projects_stale_pending_context_and_visible_error` | stale/error/pending context 可见且 reader goto 继续成功 |
| MEM-E12 | `runtime::memory_review::tests::user_statement_is_typed_and_ambiguous_scope_defaults_to_book` | 含糊陈述固定 local-first Book scope |
| MEM-E13 | `memory::global_consolidation::tests::two_books_three_evidence_create_pending_then_confirmed_snapshot` | 2 books/3 evidence 只先生成 Pending promotion |
| MEM-E14 | `memory::tests::derive_book_reading_state_keeps_engagement_dimensions_separate`;`server::tests::profile_memory_state_includes_technical_activity_and_raw_projection` | QA 只增加 qa_count,不产生 mastery/confusion confirmed fact |
| MEM-E15 | `runtime::memory_policy::tests::paper_policy_uses_explicit_choices_and_keeps_activity_non_semantic` | mode/stage 只接受 explicit UserStated choice,行为不晋级 |
| MEM-E16 | `server::mcp::tests::{visitor_dispatch_has_no_reader_or_memory_branch,visitor_guide_never_reads_or_injects_reader_private_profile}` | visitor 无私有工具入口,不读画像且 facts/jobs revision 不变 |
| MEM-E17 | `server::tests::secret_memory_request_never_calls_provider_or_reaches_disk_or_history` | Secret 在 extractor/history/disk 前拒绝且不可搜索 |
| MEM-E18 | `runtime::memory_review::tests::sensitive_and_secret_candidates_are_rejected_without_echoing_values`;`server::tests::sensitive_memory_waits_for_exact_next_message_without_second_extraction` | 自动候选拒绝,显式敏感保存等待精确明文确认 |
| MEM-E19 | `memory::tests::{legacy_open_migrates_losslessly_once_to_v2_document,legacy_migration_write_failure_preserves_original_file}` | Record 逐字段迁移与失败时原文件可读 |
| MEM-E20 | `runtime::memory_policy::tests::{missing_and_mismatched_policies_fall_back_and_mark_state_orphaned,fallback_snapshot_keeps_core_facts_and_does_not_mutate_the_ledger}` | unknown profile 回退 Neutral,保留 Core/raw ledger |
| MEM-E21 | `runtime::memory_review::tests::intent_observation_is_typed_separately_from_profile_facts`;`memory::review::tests::repeated_intent_observations_do_not_change_profile_snapshot`;`runtime::orchestrator::tests::profile_snapshot_is_ephemeral_and_frozen_across_the_tool_loop` | 重复 intent_key 可持久记录但 projection revision/snapshot 不变,动作与回答只消费同一 frozen snapshot contract |

---

## 9. 实施顺序

```text
M0.1 -> M0.2 -> M0.3 -> M0.4
  -> M1.1 -> M1.2 -> M1.3 -> M1.4
  -> M2.1 -> M2.2 -> M2.3 -> M2.4 -> M2.5 -> M2.6
  -> M3.1 -> M3.2 -> M3.3 -> M3.4
  -> M4.1 -> M4.2 -> M4.3 -> M4.4 -> M4.5
```

每个子刀完成时必须:

1. 跑本刀相关的确定性测试,不得把红测推给下一刀。
2. 追加 `docs/代码链路.md` 的文件/符号/入口/测试索引。
3. 若模块或主数据流已改变,同周期更新 `docs/架构.md`。
4. 单独 commit;不得把纯重构 M0.4 与功能刀混交。
5. 大阶段 commit 后刷新 `SESSION_CHECKPOINT.md`,使下一会话只靠文件即可接手。

**领域对齐完成**:本方案与 ADR-0075、CONTEXT.md 使用同一组术语,无未解析边界;A1 从 M0.1 开始,但必须由后续实现回合单独声明。
