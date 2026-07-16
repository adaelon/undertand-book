# 切片方案 · Runtime-owned 可靠画像 memory

> **定位**:把现有“Agent 自愿 save/recall”的 memory 升级为 runtime 可靠写入、可靠消费、证据可追溯、按 `content_profile` 适配的读者画像系统。
> **冻结决策**:[ADR-0075](adr/0075-runtime-owned-evidence-backed-profile-memory.md)。
> **状态**:M0-M6 已完成;M5 AgentHistory 修复与独立 M6 query 修复均已通过各自发布闸。

---

## 0. 对齐确认单

**FrozenIntent**:在保留 `memory.json` 单一真相源、现有 note/highlight/qa/read 与 LID/citation 红线的前提下,补齐全局画像、单本阅读状态、自动快照消费、显式前台记忆和可恢复后台整理;最终用户无需提醒 Agent 调 memory,且能看见它何时整理、记了什么、哪次回答用了什么。

**明确不做**:

- M0-M5 不改 `book.query` 能力与证据算法;后续独立 M6 以自己的 FrozenIntent 修复该边界。
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

### M5 · AgentHistory 兼容与防覆写修复（已完成）

**缺陷基线**:`a3a7093` 在 M1.4 为持久化 `OuterOutcome` 新增必填 `profile_usage`/`memory_updates`,pre-M history 因缺字段反序列化失败;`load_agent_history` 又把读取/解码/迁移错误静默折叠为默认空历史,启动创建 `server-start` 会话后由 `GET /agent/history` 写回,最终覆盖原文件。现有 legacy test 从当前 outcome 删 turn 字段,未覆盖真实 pre-M outcome shape。

**边界**:M5 只防止再次丢失并兼容仍存在的旧文件;已经被覆盖的完整对话不能从新空历史或画像 memory 反推,恢复须依赖外部备份并另立任务。

#### M5.1 真实 pre-M fixture 与加法兼容

- **做**:从 pre-M 持久化 shape 固定不可变 `agent-history-pre-m.json` fixture;为 M1.4 新增字段定义字段级 serde default,缺失 usage trace 映射为 revision=0/空 ID/空 influences,`memory_updates` 映射为空数组。
- **不做**:不伪造历史画像使用或更新,不把“未记录 trace”解释成“确定未使用画像”,不丢 session/turn/message/outcome 旧字段。
- **判据**:fixture 可完整加载;旧 session/turn/message 计数与原值保持,既有 outcome 字段逐项相等;兼容占位只出现在新增字段;重复加载结果稳定。
- **触达**:`crates/runtime/src/orchestrator.rs`,`crates/server/tests/fixtures/agent-history-pre-m.json`,`crates/server/src/lib.rs` tests。

#### M5.2 可失败加载与启动阻断

- **做**:`load_agent_history` 返回 `Result`;仅路径未配置或文件不存在可产生新历史,备份恢复/读取/JSON 解码/migration/validation 失败均携带 path+stage 返回错误;host 在创建默认会话、初始化 watermark 或启动 worker 前传播失败。
- **不做**:不再使用 `.ok()`/`unwrap_or_default()` 吞错,不自动删除、隔离或重写故障源文件,不以“服务可启动”为由降级为空历史。
- **判据**:malformed JSON、不可兼容 schema、非法 turn 三类 fixture 都使启动确定性失败;原文件 bytes/hash 不变,无 `server-start` 会话、无后台 job、无 history 写调用;文件不存在仍可正常首启。
- **触达**:`crates/server/src/lib.rs`,`crates/server/src/host.rs`,loader/host tests。

#### M5.3 查询写入隔离与回归闸

- **做**:把 `agent_history_response` 拆为纯查询 projection 与显式 session command;`GET /agent/history` 不再调用 `save_agent_history`;只有 new/select/delete/chat/切书等已校验 mutation 可原子写入。
- **不做**:不把首次 GET 当迁移提交点,不让 API 刷新改变 history bytes,不扩展到历史语义回填或画像恢复。
- **判据**:有效旧文件经启动+重复 GET 后 bytes 不变;显式 mutation 仍原子持久化;未来给持久化 outcome 增无 default 字段时,pre-M fixture gate 必须失败并阻止发布。
- **触达**:`crates/server/src/lib.rs`,`crates/server/src/host.rs`,route/integration tests。

**M5 总闸**:MEM-E22~E24 全绿,定向 server/runtime tests 与 `cargo test --workspace -- --test-threads=1` 通过;不得改写 M4.5 已完成的 21/21 历史账本。

**完成记录（2026-07-16）**:M5.1~M5.3 分别以 `c414dc2`、`2d0d3f3`、`1418dae` 独立提交;MEM-E22~E24 全绿。`cargo test -p runtime -p server -- --test-threads=1` 为 runtime 144/144、server 153/153;`cargo test --workspace -- --test-threads=1` 全绿;`git diff --check` 通过。M4.5 的 MEM-E01~E21 与 M6 的 QRY-E01~E14 账本未改写。

### M6 · `book.query` 指代优先与来源取证修复（已完成）

**状态**:2026-07-15 §0.5 Grill 已收口;M6 是 M5 之后的独立 query 修复,不回写 M0-M5 的 memory FrozenIntent,也不改变 M4.5 已完成账本。

**M6 FrozenIntent**:把 `book.query` 从“围绕 anchor 扩大上下文后作答”改为“先解析外层 Agent 指定的 referent,再围绕冻结 referent 读取来源证据并回答”;成功标准是远 anchor 不再覆盖正确概念、歧义不静默折叠、每项回答可回溯到真实来源与可检查轨迹。

**明确不做**:
- 不引入向量检索、服务端 embedding 或穷举别名表;候选搜索保持本地词法/结构检索。
- 不让 query 承担章节主旨、整篇贡献、当前段综合或导航;这些分别走 `book.structure`/`book.guide_path`/`book.paper_reading_guide`、`book.text`/`book.context`/`book.synthesize`、route。
- 不在程序中枚举因果、类比、定义、机制等开放语义关系;LLM 继续判断语义相关性与支持度。
- 不把 graph、paper lexicon、gloss、candidate preview 当最终证据;citation 只认回读后的来源 LID。
- 不保留旧 `{query,anchor_lid}` 的静默兼容算法;缺 targets/obligations 必须显式失败。

**缺陷基线**:
- `可学习性 learnability 是什么意思` + anchor `1.18.13.43` 被附近 μ/σ 上下文吸走,未解析到 `可学习性 eta` 的真实出现处。
- `trend 趋势 在书中是什么意思` + anchor `1.18.13` 被附近漂移项 μ 吸走,未解析到 `trend_strategy` / `1.2.7`。

**RiskReceipt**:用户接受开放语义支持度仍由 LLM 判断,程序只能确定性保证请求结构、referent 冻结、来源范围、citation 真实性、义务覆盖和诚实状态;真实正确性通过固定金标准、真实回放和可见 QueryAudit 持续观察。

**ChangeType**:`[边界重构]`。

**M6 TermMap**:

| 术语 | 状态 | 最终含义 |
| --- | --- | --- |
| `book.query` | BOUNDARY_CHANGE | 仅处理显式 referent 的自含语义问答,先解析指代再取来源证据 |
| `anchor_lid` | BOUNDARY_CHANGE | 同级候选/证据排序先验,不是检索边界或默认主题 |
| Query referent / target | NEW | 外层 Agent 声明、等待解析的自然语言逻辑对象 |
| ReferentCatalog | NEW | book graph 或 paper lexicon+graph 的本地候选路由索引 |
| frozen referent binding | NEW | Resolver 唯一选定且取证阶段不可替换的 referent 映射 |
| Query obligation | NEW | 外层 Agent 声明的原子回答清单,不承载关系规则表 |
| PlanGate | NEW | 对 query/targets/obligations 无损一致性的内层语义 veto |
| semantic support assessment | NEW | LLM 对来源证据能否支持 obligation 的开放判断 |
| Query structural gate | NEW | 程序对 plan/binding/coverage/citation 的确定性检查与状态聚合 |
| QueryAudit | NEW | 不进入模型上下文、随回合历史持久化的旁路结构化审计 |
| `book.synthesize` | EXISTING | 只综合调用方给定 LID,不检索、不外扩 |

零 `UNRESOLVED` 术语;定义与 CONTEXT.md、ADR-0077 一致。

#### M6 请求、路由与结果契约

```ts
type BookQueryIntent = "definition" | "explanation" | "relation" | "comparison";

type QueryObligation = {
  requirement: string;
};

type BookQueryRequest = {
  query: string;
  intent: BookQueryIntent;
  targets: string[];
  obligations: QueryObligation[];
  anchor_lid: string;
};

type SupportAssessment = {
  obligation_index: number;
  verdict: "supported" | "uncertain" | "unsupported";
  citation_lids: string[];
  support_note: string;
};
```

- `query`、targets 与 obligations 都由外层 Agent 生成,不是把用户原话直接塞给内层;`query` 必须自含,不得依赖对话中的“它/这里/刚才”。
- definition/explanation 需 `1..3` targets;relation/comparison 需 `2..3`;所有 intent 都需 `1..3` 个原子 obligation。`targets=[]` 是外层路由错误。
- `intent` 只提示检索侧重与回答形态,不规定事物间可推导关系,也不覆盖 obligations。
- `PlanGate` 对照 query 检查 targets/obligations 是否无损且原子;缺项返回 `invalid_plan{missing_requirements,target_issues}`,由外层 Agent 修正重发,内层不得自动补写。
- 文档级问题先经 `book.structure`/`book.guide_path`(technical book)或 `book.paper_reading_guide`(paper)选 LID,再由 `book.synthesize` 综合;当前 passage 用 `book.text`/`book.context` 或已知 LID 的 synthesize;query 只处理显式 referent 的语义问答。
- query 自己完成回答,不得答完再调用 synthesize;`book.synthesize` 仍只消费调用方给定 LID,不检索、不外扩。

```ts
type QueryOutcome =
  | { status: "complete" | "partial" | "insufficient"; answer?: string; citations: Citation[]; bindings: ReferentBinding[]; support: SupportAssessment[] }
  | { status: "invalid_plan"; missing_requirements: string[]; target_issues: string[] }
  | { status: "ambiguous"; target: string; candidates: CandidatePreview[] }
  | { status: "unresolved"; target: string };
```

`complete` 要求全部 targets 已冻结、全部 obligations 被 LLM 判为 supported、全部 citations 通过确定性来源校验;部分 supported 为 `partial`;零 supported 且定向扩展耗尽为 `insufficient`。ambiguous/unresolved/invalid_plan 不生成语义答案。

#### M6 ReferentCatalog 与 Resolver

`ReferentCatalog.search(target, limit) -> Vec<ReferentCandidate>` 是本地 routing API:technical book 搜 graph Concept/Entity;paper 先搜 `paper_lexicon`,再以 graph Concept/Entity 兜底。搜索字段只含名称/id/显式 alias/acronym 与自身 occurrence 文本;paper 中文 gloss 仅作 hint。候选按严格字典序排序:

```text
RecallStrength(DIRECT > APPROXIMATE > CONTEXT_ONLY > NONE)
  -> lexical_score
  -> anchor_proximity 仅最终同级 tie-break
```

anchor 不得跨 RecallStrength、不得挤掉明显更强词法命中,Resolver 也不得看到 anchor 邻段文本。paper lexicon 与 graph 候选仅在“规范名或显式 alias 相容”且“共享 occurrence/defined_at LID”同时成立时合并;不按名称相似或同段出现做语义猜合并。

```ts
type CandidatePreview = {
  candidate_id: string;
  kind: "concept" | "entity" | "paper_term";
  sources: Array<"graph" | "paper_lexicon">;
  labels: string[];
  aliases: string[];
  recall_strength: "direct" | "approximate" | "context_only" | "none";
  match_reasons: string[];
  occurrence_count: number;
  excerpts: Array<{ lid: string; text: string }>;
  hint_only?: { acronym_expansion?: string; chinese_gloss?: string };
};
```

preview 每候选最多 6 aliases、2 excerpts;每 excerpt 最多 180 Unicode 字符,优先完整命中句,过长则以真实命中位置居中截取,无正文命中而来自 defined_at 时才回退开头。preview 即使含原文摘录也仍是 routing artifact;冻结候选后必须回读完整 LID 才能引用。

Resolver 对每个 target 的全部候选逐项输出 `direct_match | semantic_match | plausible | reject`,不输出数值 confidence。唯一 strong(`direct_match | semantic_match`) 且其余全 reject 才 `resolved`;两个以上非 reject 为 `ambiguous`;仅一个 plausible 或全部 reject 为 `unresolved`。context-only/none 或首轮全 reject 时,Resolver 最多生成 3 个词法 probe,本地重搜一次并替换原 Top-K;不追加第二批、不循环。Resolved bindings 在取证前冻结。

#### M6 目标取证、结构硬闸与开放语义

```text
validated request
  -> local candidates
  -> PlanGate + Resolver
  -> frozen bindings
  -> target-first source seeds
  -> LLM obligation support + answer
  -> at most one targeted expansion
  -> structural gate + QueryOutcome
```

- 取证先读 frozen referent 的 defined_at/occurrences 与 obligation 相关位置;defined_at 只是优先路标,必须由完整来源原文验证。anchor 只在同级 seed 间排序。
- 附近段落只有明确属于 frozen referent 的 occurrence,或由该 referent 的 graph/discourse/formula 路标可达时才可进入证据包;禁止回到“anchor 附近全捞”。
- 首轮缺支持时只围绕同一 frozen referent 和未满足 obligations 定向扩展一次;不读取全部 occurrences,不恢复 chapter/global 全书 anchored 叶扫描。
- LLM 自由判断任意开放关系是否被证据支持,输出 supported/uncertain/unsupported 与短 support_note;程序不判断因果、定义或推导逻辑。
- 确定性结构闸检查 PlanGate 通过、bindings 冻结、每个 obligation 有唯一 assessment、citation LID 属于最终证据包、citation text 在 CRLF 归一化后是完整 `book.text(lid)` 的精确子串。sidecar/gloss/preview/model_supplement 均不能满足 obligation。
- RankScore 只能决定候选与证据顺序,不能补救 plan/binding/citation/coverage 失败。模型世界知识可留 `model_supplement`,但不参与 complete/partial 判定。

#### M6 旁路 QueryAudit

```ts
type QueryRun = {
  response: QueryOutcome;
  audit: QueryAudit;
};

type TraceStep = {
  tool: string;
  args: string;
  result_digest: string;
  query_audit?: QueryAudit;
};
```

QueryAudit 记录 validated request、PlanGate、初始/重搜候选、逐候选 fit、聚合 outcome、frozen bindings、证据 seed/扩展/跳过项、obligation assessments、结构闸各维结果与预算实耗。audit 走 dispatch 旁路,不得进入 tool result/messages 或后续模型上下文;resident Agent 将其随现有 `OuterOutcome.trace` 持久化进 AgentHistory,前端轨迹可展开。不得记录隐藏思维链,只记录结构字段、短 verdict 理由和来源文本摘录。

#### M6 V1 可调预算

**决策**:候选与证据预算集中版本化。

**否决**:
- 常量散落各检索阶段:无法复现实验或判断哪项调参生效。
- 无上限读取 occurrences/global scope:成本不可控且放大近邻误配。

**命门**:唯一必需的完整 LID 可单条受控越界,但必须记录原因和实际字符数。
**何时回头**:固定金标准与真实 QueryAudit 回放显示召回、完整率或成本异常时,一次只调整一个参数。

| 参数 | V1 默认值 | 统计口径 |
| --- | ---: | --- |
| `definition/explanation targets` | `1..3` | 外层 Agent 提供的逻辑 referent 数 |
| `relation/comparison targets` | `2..3` | anchor 不计入 target |
| `max_obligations` | `3/query` | 每项原子化且可独立检查覆盖 |
| `candidate_top_k_total` | `12` | 全部 targets 合计,probe 重试替换而非追加 |
| `candidate_quota_by_target_count` | `1→12; 2→6+6; 3→4+4+4` | target 间公平配额 |
| `max_search_probes` / `retry_rounds` | `3 / 1` | LLM 词法 probes / 本地重搜轮数 |
| `max_preview_aliases` / `excerpts` | `6 / 2` | 每 candidate |
| `preview_excerpt_chars` | `180/excerpt` | Unicode 字符,命中居中 |
| `max_seeds_per_target` | `3` | 首轮完整来源 LID |
| `max_evidence_lids_total` | `12` | 去重后的最终证据包 |
| `max_evidence_chars_total` | `16,000` | 完整来源文本 Unicode 字符 |
| `max_expansion_rounds` | `1` | 首轮 assessment 后定向扩展 |
| `max_joint_evidence_lids` | `3` | relation/comparison 的共享 seed,计入总 12 |
| `mandatory_overflow_lids` | `1` | 唯一必需完整 LID 的受控越界 |

QueryAudit 必须记录 `budget_version`、每 target 候选数与 selected rank、probe 数、证据 LID/字符实耗、预算跳过项、越界原因、扩展轮数和结构闸结果。Top-K 首轮固定对照 `K∈{5,8,12,20}`,默认 `12`;调参不得同时改 K 与证据预算。

#### M6.1 Typed request/outcome 与路由 fail-fast

- **做**:新增 BookQueryRequest/QueryOutcome/QueryObligation/SupportAssessment 权威 Rust DTO 与校验;工具 prompt、REST、MCP 缺 targets/obligations 时返回 invalid_plan/validation,不走旧算法。
- **不做**:本刀不实现 candidate search 或模型 Resolver。
- **判据**:数量/intent/空项/legacy 缺字段测试全绿;document-level 与 current-passage 路由 prompt contract 固定;所有旧 wire fixture 显式迁移。
- **触达**:`crates/runtime/src/lib.rs`,`crates/runtime/src/orchestrator.rs`,`crates/server/src/{lib.rs,mcp.rs}`,generated TS。

#### M6.2 本地 ReferentCatalog 与 CandidatePreview

- **做**:在 read-tools 建 book/paper 本地 catalog search、严格排序、公平 Top-K、paper 双源去重、命中居中 preview。
- **不做**:不调用 provider,不建向量,不物化新 sidecar,不扩充构建期 alias schema。
- **判据**:相同 artifact 输入字节稳定;anchor 只能同级 tie-break;paper 合并双条件与 180 字符边界测试全绿。
- **触达**:`crates/read-tools/src/lib.rs`,base/paper fixture tests。

#### M6.3 PlanGate、Resolver 与一次 probe 重搜

- **做**:结构化 LLM 一轮同时检查 plan 与逐候选 fit;确定性聚合 invalid/resolved/ambiguous/unresolved;仅失败路径允许一次 probes 重搜。
- **不做**:不自动改 obligations,不按数值 confidence 选 winner,不把 anchor 邻文喂 Resolver。
- **判据**:可学习性 eta、trend_strategy 两条 red-green 绑定测试通过;PlanGate 拒绝非原子/漏项义务;同强度多义返回 ambiguous;唯一 plausible 不冒充 resolved;retry 次数硬闸可断言。
- **触达**:`crates/runtime/src/lib.rs`,structured FakeAdapter/gold fixtures。

#### M6.4 Target-first evidence、support map 与 citation gate

- **做**:从 frozen bindings 组 seed,按 obligations 取证并定向扩展一次;产生 obligation support map 与 typed outcome;精确校验 citation quote。
- **不做**:不再执行 local→chapter→cross_chapter→global scope ladder,不让 routing artifact 充证据,不编码开放关系规则。
- **判据**:两条缺陷基线引用远处正确来源且不引用 anchor 近邻替代物;partial/insufficient、预算越界、sidecar 非证据和 quote mismatch 均有确定性测试。
- **触达**:`crates/runtime/src/lib.rs`,`crates/runtime/src/goldset.rs`。

#### M6.5 QueryAudit 旁路、历史持久化与轨迹 UI

- **做**:dispatch 返回 response+audit,TraceStep 加可选 typed detail;AgentHistory 原子持久化并由 RightRail 展开候选/绑定/证据/闸结果。
- **不做**:audit 不进入 Message/tool result,不另建服务端日志,不记录 chain-of-thought。
- **判据**:provider 收到的 messages 不含 audit sentinel;历史 reload 后 audit 等值;pre-M/M5 缺字段兼容;桌面/移动 trace 无溢出。
- **触达**:`crates/runtime/src/orchestrator.rs`,`crates/server/src/lib.rs`,`packages/web/src/{api.ts,components/RightRail.vue}`。

#### M6.6 Surface 迁移、固定回放与调参基线

- **做**:迁移 resident/REST/MCP/goldset 全入口;固定 technical book + paper 回放;比较 K=5/8/12/20 的 binding recall、ambiguous/unresolved、complete/partial、证据字符数与调用次数。
- **不做**:不以 LLM 自评分替代 expected binding/LID/status;不在首轮自动调参或批量候选调用。
- **判据**:QRY-E01~E14 全绿,workspace/Web 构建通过;真实 provider 回放仅作补充报告,默认值变更须单变量 diff + QueryAudit 证据。
- **触达**:runtime/server/read-tools tests,Web tests,`docs/代码链路.md`,`docs/架构.md`。

**完成记录（2026-07-15）**:resident/REST/MCP/CLI/Web/goldset 已统一 typed request/outcome；旧 anchor-scope query 实现与 `QueryResponse` 已删除。内置 12 条 goldset 固定 expected binding/status/LID，`goldset-topk` 与 QRY-E14 对 technical book、paper 分别输出 K=5/8/12/20 的 binding recall、歧义/未解析、complete/partial、证据字符与模型调用数，默认 K 保持 12。QueryAudit 显式记录 selected rank、模型调用数、扩展轮次与 mandatory overflow 原因；eta/trend 两条缺陷基线直接断言 frozen binding、citation、seed 与 audit 终态。真实 provider 回放未执行，它仍是补充观察项而非自动发布判据。

**M6 总闸**:QRY-E01~E14 全绿;`cargo test -p read-tools -p runtime -p server`、Web test/typecheck/build 与目标 clippy/diff check 通过;两条缺陷基线的 frozen binding、citation LID 和 QueryAudit 可人工展开复核。

**总闸结果（2026-07-15）**:`read-tools` 125/125、`runtime` 143/143、`server` 137/137；core 210/210、Web 100/100；Web typecheck 与 production build（1906 modules）通过；`git diff --check` 通过。临时 Vite fixture + Playwright 在 1440×900/390×844 展开真实 QueryAuditPanel，document/panel 横向溢出均为 0，长 target/candidate ID、rank、预算与闸结果可见；fixture/截图/进程验后清理。三目标普通 clippy 通过且 M6 新代码零 clippy 告警；`-D warnings` 仍被 read-tools 既有 6 条非 M6 告警阻断，全仓 rustfmt check 仍只命中 checkpoint 已记录的 `memory_review.rs`、`profile_api.rs`、`server/host.rs` 格式债务，本刀未批量改写这些文件。

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

pre-M AgentHistory outcome
  -> 字段级兼容解码(legacy usage trace=未记录,memory_updates=[])
  -> stable-turn migration + 全量 validation
  -> 全部成功后才可进入原子写路径
```

- `memory.save/recall/delete/replace` 内容记录 API 保持兼容;profile mutation 使用独立 typed API。
- 旧 `reader-profile.md` / `reading-handbook.md` 在第一次 v2 mutation 后由新 projector 覆写。
- 迁移前保留原文件直到 v2 原子切换成功;失败返回错误且不启动后台 worker。
- 所有新 TS 类型继续由 Rust `ts-rs` 生成,禁止手编 generated files。

### §7.1 AgentHistory 迁移失败边界
**决策**:解码失败保留原文件并阻断覆写。
**否决**:
- 静默空历史:将兼容错误变成数据丢失。
- 仅补字段默认值:无法防住未来 schema 破坏。
**命门**:完整解码、迁移、校验成功前,启动/GET/切书均不得落盘。
**何时回头**:引入显式版本 envelope 与只读恢复工具时。

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
| MEM-E22 | pre-M AgentHistory outcome 缺画像字段 | transcript/outcome 原值保留,新增 trace/update 仅取兼容占位 |
| MEM-E23 | history 读取/解码/迁移失败 | 显式失败且源文件 bytes 不变,不创建默认会话或后台 job |
| MEM-E24 | 重复 `GET /agent/history` | 查询不写盘;文件 bytes 不变,显式 mutation 仍原子提交 |

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

### 8.2 M5 completed coverage ledger

以下 ID 均已由自动测试验收,仍不计入 §8.1 的 M4.5 完成状态;测试名是稳定定位符,最终发布闸以实际 runner 结果为准。

| ID | 自动验收测试 ID | 覆盖面 |
| --- | --- | --- |
| MEM-E22 | `server::tests::pre_m_agent_history_fixture_migrates_without_losing_transcript` | 真实 pre-M outcome 缺字段兼容、旧 transcript/outcome 守恒、重复加载稳定 |
| MEM-E23 | `server::host::tests::agent_history_load_failure_preserves_source_and_blocks_startup` | recovery/read/decode/migration/validation 分阶段报错,源 bytes 不变且 worker 未启动 |
| MEM-E24 | `server::tests::agent_history_get_is_read_only_and_mutations_remain_atomic` | startup+重复 GET 零写入,显式 command 仍通过原子提交 |

### 8.3 M6 completed coverage ledger

以下 QRY ID 属于独立 query 修复,不计入 MEM-E01~E24 的 memory 完成状态。语义判断用 scripted structured adapter 固定输入输出以验证控制流;真实 provider 回放只验证产品效果并保留原始 QueryAudit,不以模型自评分作验收。

| ID | 计划自动验收测试 ID | 覆盖面 |
| --- | --- | --- |
| QRY-E01 | `runtime::tests::learnability_resolves_eta_despite_far_anchor` | “可学习性”候选含并冻结 eta,证据不从 μ/σ anchor 邻文替代 |
| QRY-E02 | `runtime::tests::trend_resolves_strategy_not_drift` | “trend 趋势”冻结 trend_strategy/1.2.7,不等同漂移 μ |
| QRY-E03 | `read_tools::tests::referent_ranking_uses_anchor_only_as_peer_tiebreak` | 改 anchor 不跨 RecallStrength/词法层,强候选 binding 不变 |
| QRY-E04 | `runtime::tests::resolver_preserves_multiple_viable_meanings_as_ambiguous` | 两个非 reject 候选返回 ambiguous,零答案/零取证 |
| QRY-E05 | `runtime::tests::resolver_retries_three_or_fewer_lexical_probes_once_then_unresolved` | probes≤3、重搜=1、替换 Top-K、耗尽后 unresolved |
| QRY-E06 | `runtime::tests::plan_gate_rejects_missing_target_or_obligation_without_retrieval` | 漏 target/obligation 返回 invalid_plan,不自动补写、不读证据 |
| QRY-E07 | `read_tools::tests::candidate_preview_enforces_fair_topk_and_match_centered_caps` | Top-12 公平配额、aliases≤6、excerpts≤2、每条≤180 Unicode 字符 |
| QRY-E08 | `read_tools::tests::paper_referent_catalog_merges_only_alias_and_shared_lid_matches` | paper lexicon 优先、graph 兜底、双条件去重、gloss 仅 hint |
| QRY-E09 | `runtime::tests::target_evidence_respects_seed_total_char_expansion_and_overflow_budgets` | seeds/target≤3、总 LID≤12、字符≤16000、扩展≤1、单条受控越界 |
| QRY-E10 | `runtime::tests::citation_gate_requires_exact_source_quote_and_rejects_routing_artifacts` | citation 属于证据 LID 且 quote 精确;preview/sidecar/gloss 不充证据 |
| QRY-E11 | `runtime::tests::query_outcome_aggregates_obligation_support_without_semantic_rule_tables` | 全 supported=complete、部分=partial、零=insufficient,无关系枚举 |
| QRY-E12 | `server::tests::query_audit_is_out_of_band_persisted_and_backward_compatible` | audit 不进 messages,历史 reload 等值,M5/pre-M 缺 detail 可解码 |
| QRY-E13 | `runtime::orchestrator::tests::query_routing_keeps_document_and_passage_questions_on_owned_tools` | 文档级走 structure/guide 投影+synthesize,当前段优先 text/context,referent QA 才 query |
| QRY-E14 | `runtime::goldset::tests::referent_topk_replay_reports_k_5_8_12_20_without_mutating_defaults` | 固定 book/paper 候选集输出各 K 召回/歧义/成本报告,默认仍 K=12 |

---

## 9. 实施顺序

```text
M0.1 -> M0.2 -> M0.3 -> M0.4
  -> M1.1 -> M1.2 -> M1.3 -> M1.4
  -> M2.1 -> M2.2 -> M2.3 -> M2.4 -> M2.5 -> M2.6
  -> M3.1 -> M3.2 -> M3.3 -> M3.4
  -> M4.1 -> M4.2 -> M4.3 -> M4.4 -> M4.5
  -> M5.1 -> M5.2 -> M5.3
  -> M6.1 -> M6.2 -> M6.3 -> M6.4 -> M6.5 -> M6.6
```

每个子刀完成时必须:

1. 跑本刀相关的确定性测试,不得把红测推给下一刀。
2. 追加 `docs/代码链路.md` 的文件/符号/入口/测试索引。
3. 若模块或主数据流已改变,同周期更新 `docs/架构.md`。
4. 单独 commit;不得把纯重构 M0.4 与功能刀混交。
5. 大阶段 commit 后刷新 `SESSION_CHECKPOINT.md`,使下一会话只靠文件即可接手。

**领域对齐完成**:M0-M5 与 ADR-0075/0076、M6 与 ADR-0077 及 CONTEXT.md 使用同一组术语,零未解析边界。实现已按 M5.1~M5.3 与 M6.1~M6.6 独立切片、测试和提交完成。
