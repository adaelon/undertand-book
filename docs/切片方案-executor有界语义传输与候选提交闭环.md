# Executor 有界语义传输与候选提交闭环切片方案

日期:2026-08-25。
冻结决策:[ADR-0114](adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md)。
承接边界:[ADR-0084](adr/0084-codex-harness-inference-and-durable-sidecar-task-mailbox.md)、[ADR-0092](adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md)、[ADR-0100](adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md)、[ADR-0101](adr/0101-deterministic-prebuild-protocol-ownership-and-codex-semantic-boundary.md)、[ADR-0103](adr/0103-extractor-contract-coherence-and-policy-scoped-retry-recovery.md)。

本方案只冻结实现顺序与验收合同。本轮不修改运行代码，不写 recovery/reset，不重试当前真实书，不读取或复制语义正文、候选 JSON、LID 清单或私有计划；真实恢复只允许在 T8 的全部前置门禁通过后发生。

Codex subagent 基线以[OpenAI 官方 Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)为准：本地 Codex 只在用户直接要求或适用 project/skill 指令要求时委派；custom agent 未覆盖的 `sandbox_mode`、`mcp_servers` 与 `skills.config` 会继承父配置，父 turn 的 live sandbox/approval override 还会在 spawn 时重新施加；agent thread 可由用户打开检查。因此“专用 prompt”“不同 tool namespace”或“child 默认 read-only”都不能单独证明 capability 或可见性隔离。

## 0. 对齐确认单

**FrozenIntent**:修复 `executor.open` 单次结果内嵌大输入造成的通道截断，给所有模型 work unit 补 transport-aware proof，把超限 BookStructure unit 路由为有界 fragment/reduce，以代码所有的结构化 sink 取代模型生成 PowerShell candidate source，并让失败分类、semantic attempt 与 `retry_current` 恢复语义反映真实阶段。保持 LID、BookStructure 公共产物合同、BuildPlan、既有 artifact、旧 attempt 与用户书源不变。

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| `semantic attempt` | EXISTING | 一轮已获授权的语义模型推理；完整输入只签 grant，`generation.start` 被接受前不得创建 |
| `lease epoch` | EXISTING | executor/owner 中断后的执行所有权世代；输入交付故障不占语义上限 |
| `submit revision` | EXISTING | 同一候选的幂等重传；structured sink replay 不产生新语义推理 |
| `Opaque handoff ref` | EXISTING | root 唯一可转交的动态数据；仍不等同路径或 input ref |
| `Executor open` | EXISTING | 消费端重验入口；V2 只返回有界 manifest/action，不返回完整输入 |
| 预算可路由性 | EXISTING | ADR-0100 的模型输入证明扩展到 carrier/tool-result 与 candidate tool-input |
| candidate mailbox | EXISTING | 代码所有的私有 create-only 候选落点；本次移除模型自建 source 文件 |
| `structure_unit` / `structure_stitch` | EXISTING | BookStructure 当前语义单元与全局收口；超限时增加内部 fragment/reduce 路径 |
| `retry_current` | EXISTING | 只重验恢复前提；新 router/policy scope 发布后才可重新规划 |

**RiskReceipt**:用户在看到“旧 scope 必须保持耗尽、输入协议和路由必须前向发布、真实书只能最后重试、安装态协议必须同步迁移”后明确要求落 ADR 和切片方案，并在上次宿主中断后再次要求继续。

**ChangeType**:`[边界重构]`。修订 Build Engine 与 Codex executor 的 carrier 边界，不改变读时领域模型或公开 BookStructure schema。

领域对齐完成；TermMap 无 `NEW`、`CONFLICT` 或 `UNRESOLVED`，无需修改已有脏改动的 `CONTEXT.md`。

### 0.1 审查准入状态

| 审查面 | 当前结论 | 解除条件 |
|---|---|---|
| 原事故覆盖 | `PASS` | T1-T7 按本文合同实现并保持原门禁 |
| 实现状态 | `PARTIAL (T1-T7)` | T8 受守卫真实恢复实际落地 |
| Codex subagent 合规 | `PASS` | T7 compiled/thin-installed/root-negative/真实 CLI child trace 与 durable commit 已全绿 |

T7 已解除安装态 P0：Build Executor 只登记在 executor agent，locator 单独无法授权，root/project 工具负集、read-only bootstrap、first-terminal multi-ref、compiled Sidecar、薄插件安装缓存与可检查 child trace 均有确定性证据。发布 cachebuster 已前向更新；真实书恢复仍冻结在 T8，未经用户再次授权不得执行 `retry_current`。

## 1. 已证实根因与代码落点

### 1.1 事故事实

下表只保留尺寸、生命周期与类型化元数据，不包含私有语义内容。

| semantic attempt | input bytes | output bytes | writer ms | executor ms | 终止点 |
|---:|---:|---:|---:|---:|---|
| 1 | 317,247 | 0 | 0 | 59,484 | 完整输入超过 executor 工具结果通道 |
| 2 | 317,247 | 0 | 0 | 37,615 | 输入在候选生成前被截断 |
| 3 | 317,247 | 0 | 0 | 71,279 | 模型构造 candidate source 的 PowerShell hashtable 缺少 `}` |

三轮均没有 candidate 进入 mailbox，没有执行 Schema/evidence gate，没有启动 artifact writer。持久化的相同 `writer_failed` digest 不是相同 writer 故障，而是错误分类折叠。

### 1.2 容量模型错位

[automatic-build-executor-session.ts](../packages/core/src/automatic-build-executor-session.ts) 同时定义 `MAX_RECORD_BYTES=1 MiB`、`MAX_STDIN_BYTES=8 KiB` 和 `MAX_CANDIDATE_BYTES=4 MiB`，但 `generateAction()` 把 `runAutomaticBuildTaskInput().stdout` 直接放入 `GENERATE.semantic_input`。317,247 bytes 对 registry 合法，对 Codex 单次工具结果不可交付。

[automatic-build-dispatch.ts](../packages/core/src/automatic-build-dispatch.ts) 把 `structure_unit`、`structure_stitch` 及多个 compatibility kind 的 `max_input_tokens` 设为 `10_000_000`。该字段只限制 dispatch 聚合，既不等于单 work unit 的模型上下文证明，也不等于工具结果 carrier 上限。

[model-input-budget.ts](../packages/core/src/model-input-budget.ts) 的 V1 proof 已绑定 renderer、prompt、上下文 floor 和各类 reserve，但没有 carrier profile、chunk envelope、最大 chunk 数或 candidate tool-input 上限。BookStructure 活跃路径仍在 [build-orchestrator.ts](../packages/core/src/build-orchestrator.ts) 生成 V2 compatibility descriptor；现有“六阶段可路由”测试只证明 shadow route，不证明生产 `structure_unit` 已使用 V3/V4 proof。

### 1.3 候选提交错位

[automatic-build-dispatch-executor.md](../agents/automatic-build-dispatch-executor.md) 要求模型自己创建 executor-private UTF-8 JSON source file，再把 `candidate_path` 交给 `executor.session`。这迫使模型同时承担候选语义、JSON、shell/PowerShell 转义、临时路径和括号平衡；第三轮的 `IncompleteHashLiteral` 发生在 Build Engine 能校验 candidate 之前。

现有 mailbox 的 create-only、hash、strict UTF-8 JSON 和 replay gate 本身应保留。要移除的是“模型负责构造 candidate source 文件”这一层，而不是 candidate mailbox。

### 1.4 诊断与恢复错位

[extractor-contract.ts](../packages/core/src/extractor-contract.ts) 的 `automaticBuildFailureDiagnosticFromCode()` 把所有未知 code 改写为 `internal/writer_failed`。Executor 事故中的三个短码均不在 allowlist，因而产生同一错误 digest。

`failAutomaticBuildExecutorSession()` 虽接收 2 KiB `message`，公共任务路径只持久化映射后的 diagnostic；[automatic-build-mailbox.ts](../packages/core/src/automatic-build-mailbox.ts) 也明确不持久化自由文本。问题不应通过保存任意 message 修复，而应通过“调用阶段 + allowlisted code + bounded metrics”形成稳定事实。

当前 `retry_current -> recovery_not_satisfied` 符合 ADR-0103：旧记录显示 `internal/writer_failed`，所需恢复为 forward fix；同 scope 没有策略变化时不得清零或无限重试。

### 1.5 明确非根因

- 不是 Pass2；当前计划禁用 Pass2，失败阶段为 `book_structure`。
- 不是并发度 3；单个 `structure_unit` 和单 executor session 已足以复现。
- 不是旧 Pass1、metadata、lexicon 或 profile artifact 被写坏。
- 不是 BookStructure Schema、evidence/LID gate 或 writer 权限；三者都未启动。
- 不是 `retry_current` 没执行；它正确拒绝了未完成的 forward fix。
- 不是应通过删除 attempt、覆盖 policy lock 或降低质量门恢复。

## 2. 冻结不变量与非目标

1. Root Codex 始终只转交 `opaque_handoff_ref`，不得读取 prompt、semantic input、candidate、LID allowlist、mailbox 路径或 raw goal；其实际工具集中必须不存在 Build Executor 的 input/sink/session 工具。
2. 模型推理仍在 Codex harness；Build Engine 不引入 provider 凭据，不直连模型。
3. `executor.open`、input read、generation start、candidate submit 的生产者/消费者重验都由代码执行；每次 Build Executor 调用同时要求合法 ref 与非模型参数中的 child-connection-bound capability；agent 不算 hash、不验证路径、不自判 terminal。
4. 任一工具结果必须在写 stdout 前通过版本化 token、byte 与 envelope 上限；不允许依赖调用者请求更大的 `max_output_tokens`。
5. 任一模型 work unit 必须同时证明模型上下文可容纳、input 可分块交付、chunk 数有界、candidate 可经 structured tool-input 提交。
6. 输入 chunk 只改变 transport/session 状态；全部 chunk 交付确认后只签发 generation grant。只有 `generation.start(grant_ref)` 被原子接受时才创建 open semantic attempt；其 response 丢失只能恢复/重放同一 attempt，不得标记失败或递增。
7. semantic generation、candidate submit replay、artifact writer 分阶段记账；`writer_failed` 必须有 writer-start 事实。
8. Candidate 只作为 dedicated executor 的结构化 tool argument 进入代码 sink；它可能出现在用户可检查的专用 child tool request，但不作为工具结果返回，也不经 root、child final、其他 subagent、通用日志或 shell source 文件中转。
9. Candidate mailbox、Schema、evidence、quality、artifact publication 和 freshness gate全部保留，不能因 sink 结构化而跳过。
10. BookStructure 拆分只改变模型执行单元；LID、unit LID、公开 unit card、stitch 输出和 `book_structure.json` 不变。
11. Fragment core coverage 必须完整、无缺口、无重复；overlap 只作可见上下文，不算覆盖。
12. 旧 task/attempt/failure/receipt/artifact append-only；新 release 不回写历史 `writer_failed`，只用新诊断阻止再次误分。
13. 适配新 router/policy 的 scope 在第一次合法 `generation.start` 被接受时从 `semantic_attempt=1` 开始；旧 scope 仍可审计，不能用 reset 伪造迁移。
14. 317,247-byte fixture 必须由确定性 synthetic generator 产生，不把真实书正文或候选签入仓库。
15. 本方案不顺带重构全部 compatibility stage；T1 增加全局 preflight 防线，T4 先完成当前阻塞的 BookStructure 活跃路由，其他 stage 逐独立 policy generation 迁移。
16. Dedicated executor 默认 `read-only`，不得直接写文件或构造任意 shell；只暴露 Build Executor 所需工具并禁用无关 MCP/skills。父 turn live override 可能放宽 child，故真正安全边界必须由 server capability、封闭 schema 与 session-private root 强制执行。
17. Semantic chunks 可出现在专用 child tool-result context，candidate 可出现在其 tool request；用户主动检查 child thread 时可能看到。若产品要求连 child trace 都不含正文，本方案必须判为不满足并改用 Harness 原生私有 I/O。
18. 多个 handoff ref 按 live slot capacity 启动；任一 child terminal 后立即重读 durable Build Engine，同时保留其他 live ref 的所有权，禁止重复 spawn、孤儿 ref 或仅凭 child final 提前收口。

## 3. 目标执行合同

### 3.1 V2 状态机

```text
SPAWN_EXECUTORS(opaque_handoff_ref)
  -> executor.open.v2
       code revalidates ref/handoff/prompt/manifest/current terminal
       creates/reuses delivery session only
  -> DELIVER_INPUT(input_manifest, no body)
       -> executor.input.next(previous_chunk_receipt?)
       -> INPUT_CHUNK(segment, ordinal, bounded payload, tail receipt)
       -> ... ordered replay-safe chunks ...
       -> executor.input.next(final receipt)
            code verifies complete delivery ledger
            promotes reserved ownership to INPUT_COMPLETE
            returns GENERATION_GRANT(generation_grant_ref), attempt=0
  -> executor.generation.start(generation_grant_ref)
       code atomically creates/reuses open semantic_attempt N
       returns bounded GENERATE(output_contract, candidate_sink_ref, no input body)
  -> dedicated model produces one strict JSON value under open attempt N
  -> executor.submit_candidate.v2(candidate_sink_ref, candidate value)
       code serializes once -> private create-only mailbox
       -> schema -> evidence -> writer -> quality/freshness
  -> next DELIVER_INPUT | WAIT | DONE
```

失败分支：

```text
open/ref/manifest invalid before delivery      -> fail-closed; zero lease/attempt
chunk profile overflow before stdout           -> budget block; zero attempt
carrier truncation/missing delivery receipt    -> executor transport failure; zero attempt
generation grant lost/not accepted             -> replay same grant; zero attempt
generation.start/GENERATE response lost        -> replay same open attempt N; no failure/increment
provider/semantic failure after GENERATE       -> terminal semantic failure for attempt N
same candidate submit replay                   -> submit_revision; no new attempt
candidate sink unavailable                     -> keep/recover executor ownership; not writer_failed
writer throws after mailbox accept              -> internal/writer_failed with writer_started=true
```

### 3.2 Transport profile 与预算证明

新增 carrier 权威，不从 agent 自报能力：

```ts
interface ExecutorTransportProfileV1 {
  version: "executor_transport_profile.v1";
  carrier: "codex_executor_mcp";
  session_protocol: "automatic_build_executor_session.v2";
  max_tool_result_tokens: number;
  max_tool_result_bytes: number;
  result_envelope_reserve_tokens: number;
  max_input_chunks: number;
  max_candidate_request_tokens: number;
  max_candidate_request_bytes: number;
  profile_digest: string;
}
```

首个 profile 的保守设计目标为“单个完整工具结果不超过 2,048 estimated tokens 且不超过 8,192 UTF-8 bytes”；payload 大小必须在序列化最终 envelope 后反算，不能把 8 KiB 全给正文。T1 与 compiled evidence 证明实现遵守该值且 8 KiB 路径可达，但没有阶梯探测宿主最大容量；因此它是本地基线，不是 Codex/MCP 硬上限。精确容量与后续 batch 预算由 [ADR-0116](adr/0116-calibrated-executor-transport-budget-and-round-trip-reduction.md) 的 M2 标定，标定前不猜测提高生产值。

V1 模型预算保留兼容读，新增 V2 执行预算证明：

```ts
interface ModelExecutionBudgetProofV2 {
  version: "model_execution_budget_proof.v2";
  estimator_version: string;
  render_contract_version: string;
  router_version: string;
  prompt_sha256: string;
  rendered_input_sha256: string;
  transport_profile_digest: string;
  estimated_prompt_tokens: number;
  estimated_rendered_tokens: number;
  input_chunk_count: number;
  input_delivery_overhead_tokens: number;
  output_reserve_tokens: number;
  max_candidate_tokens: number;
  effective_body_limit_tokens: number;
  proof_digest: string;
}
```

确定性 evaluator 必须同时成立：

```text
stage_fit = rendered_input <= stage_body_limit
context_fit = prompt + rendered_input + chunk/tool overhead
              + output reserve + safety <= executor_context_floor
input_transport_fit = every serialized chunk response <= result token/byte caps
                      AND chunk_count <= max_input_chunks
candidate_transport_fit = candidate contract max <= model output reserve
                          AND candidate tool-input token/byte caps

routable = stage_fit AND context_fit AND input_transport_fit AND candidate_transport_fit
```

Proof 只保存计数、版本、hash 和 digest，不保存 prompt、正文、candidate、路径或 stderr。Planner、doctor、claim 和 input delivery 消费点都重验；dispatch 的 `max_input_tokens` 只作装箱上限，不再冒充 proof。

### 3.3 Input ref 与 chunk 合同

```ts
interface ExecutorInputManifestV2 {
  version: "automatic_build_executor_input_manifest.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  transport_profile_digest: string;
  segments: Array<{
    kind: "semantic_prompt" | "semantic_input";
    byte_length: number;
    sha256: string;
    chunk_count: number;
  }>;
  total_chunk_count: number;
}

interface ExecutorInputNextRequestV2 {
  version: "automatic_build_executor_input_next_request.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  previous_chunk_receipt?: string;
}

interface ExecutorInputChunkV2 {
  version: "automatic_build_executor_input_chunk.v2";
  opaque_session_ref: string;
  generation_input_ref: string;
  segment: "semantic_prompt" | "semantic_input";
  ordinal: number;
  byte_range: { start: number; end: number };
  payload_utf8: string;
  payload_sha256: string;
  final_for_segment: boolean;
  final_for_generation: boolean;
  chunk_receipt: string;
}

interface ExecutorGenerationGrantV1 {
  version: "automatic_build_executor_generation_grant.v1";
  opaque_session_ref: string;
  generation_input_ref: string;
  generation_grant_ref: string;
  output_contract_digest: string;
}

interface ExecutorGenerationStartRequestV1 {
  version: "automatic_build_executor_generation_start_request.v1";
  opaque_session_ref: string;
  generation_grant_ref: string;
}
```

约束：

- `generation_input_ref` 绑定 target、task binding、prompt hash、rendered input hash、session 与 transport profile；它不是路径。
- Chunk 只在 UTF-8 code point 边界切分，序号和 byte range 连续；相同请求逐字节重放，错序/跨 session receipt 失败关闭。
- `chunk_receipt` 是代码签发的 opaque capability，序列化时位于 payload 之后；下一 chunk 只有在前一 receipt 被原样提交后返回。
- 代码必须在返回前验证整个 JSON response 的 token/byte 上限。任何超限成为 preflight/programmer failure，绝不把可能被截断的 response 写到 stdout。
- 交付记录只保存 ref、ordinal、hash、时间和状态，不复制正文；reopen 从第一条未确认 chunk 继续。
- Carrier 明示 truncated、response JSON 不完整或 receipt 不可用时，executor 报类型化 transport interruption；不得猜测缺失正文后继续生成。
- 最后一条 receipt 只把 session 推进到 `INPUT_COMPLETE` 并返回 byte-identical grant；grant 丢失、重复或 agent 在 start 前中断均保持 `semantic_attempt=0`。
- `generation_grant_ref` 绑定完整 delivery ledger、session、task、output contract 与 transport profile，只能由同一 child connection 启动，不能经 root 转交或单独作为授权。
- `generation.start` 首次合法接受时原子创建 open attempt 并返回 `GENERATE`；同一 grant 的串行/并发重放必须返回同一 attempt/action，不得创建第二个 attempt。
- `GENERATION_START` 请求或 `GENERATE` response 丢失不构成 semantic failure；reopen/重放恢复同一 open attempt。只有类型化 provider/schema/evidence/semantic failure 才能关闭并消耗该 attempt。

### 3.4 结构化 candidate sink

V2 dedicated executor 使用隔离的 Build Executor MCP/tool adapter，而不是 Book MCP 或 PowerShell 文件生成：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ExecutorCandidateSubmitV2 {
  version: "automatic_build_executor_candidate_submit.v2";
  opaque_session_ref: string;
  candidate_sink_ref: string;
  candidate: JsonValue;
}
```

Sink 行为固定为：

1. 重验 session、sink ref、当前 open semantic attempt、task binding、contract、lease ownership 与 child connection capability。
2. 对 JSON value 做深度、节点数、token 和 UTF-8 byte 上限检查；拒绝 NaN/Infinity、未知宿主类型与超限值。
3. 由 Build Engine 使用单一 canonical JSON serializer 生成 UTF-8 bytes，create-only 写入当前 attempt 的私有 candidate mailbox。
4. 相同 canonical hash 重放幂等并记 submit revision；不同 hash 冲突失败关闭。
5. 复用现有 Schema、evidence、writer、quality、receipt 与 artifact publication 链。
6. 返回下一个 candidate-free session action；不回显 candidate、摘要、路径、schema error 原值或源文本。

`automatic_build_executor_submit_request.v1(candidate_path)` 只为已经打开的 V1 session 保留兼容读；V2 session 一律拒绝 path submit。Candidate 超过 structured tool-input 合同不是改回文件路径的理由，必须由 router 缩小语义单元或返回 budget recovery。

Build Executor MCP 必须是独立 stdio server/能力面，不把写能力加入只读 [Book MCP](adr/0089-plugin-provided-current-book-mcp-and-setup-sidecar.md)，也不得登记在 root/project `.mcp.json`。它只由 executor custom-agent 的 agent-specific `mcp_servers` 启动；所有工具除 opaque ref 与封闭类型外，还验证不作为模型参数出现的 child-connection-bound capability。没有合法 child connection 时，即使持有真实 handoff/session/sink ref 也不能读 input、启动 generation 或写 candidate。

### 3.5 BookStructure 有界路由

当前直接路径：

```text
BookStructureUnitSource(unit_lid)
  -> structure_unit
  -> BookStructureUnitArtifact(unit_card)

all unit cards
  -> structure_stitch
  -> BookStructureStitchArtifact
  -> book_structure.json
```

新 router `book_structure_unit.v2`：

```text
render full unit
  -> proof fits
       -> structure_unit (whole-unit fast path)
  -> over limit
       -> contiguous LID-range fragments
       -> if auxiliary fan-out still over limit, deterministic typed shards
       -> structure_fragment[*] -> fragment cards
       -> bounded artifact-reduction tree -> one unit card

all unit cards
  -> stitch packet fits
       -> structure_stitch
  -> over limit
       -> bounded stitch fragment/reduction tree
       -> final structure_stitch
```

建议的内部类型：

```ts
type BookStructureWorkUnitKind =
  | "structure_unit"
  | "structure_fragment"
  | "structure_reduce"
  | "structure_stitch_fragment"
  | "structure_stitch_reduce"
  | "structure_stitch";
```

路由规则：

- Whole-unit fast path 与当前 renderer bytes 相同；只有 proof、prompt、schema、quality 和输入字节完全相同的 fresh artifact 才可经 migration receipt 采用。
- Fragment 的 core leaf LID ranges 按原序完整覆盖 unit；标题路径和 profile rules 可作为有界公共 context 重复，但不计 coverage。
- Excerpt/discourse/formula/pass2 item 按真实 evidence LID 分配；graph node 按 occurrence/source LID 分配；跨 fragment edge 只作为带稳定 key 的声明式 context 复制，并在 reducer 去重。
- 若单个不可分记录本身超限，返回 `budget/atomic_input_item_too_large`，不得截断记录或跳过证据。
- Fragment output 只产生局部 summary、candidate key stops、role/dependency hints 与 evidence；不得直接冒充最终 unit card。
- Reducer 输入只来自 proof-bound child artifacts，fan-in 由同一 budget evaluator 决定；最终 reducer 恰好产出一个现有 `BookStructureUnitExtractionOutput`。
- Stitch 的语义归并仍由专用 semantic reducer 完成；确定性代码拥有路由、依赖、覆盖、去重、顺序、hash、Schema/evidence gate 和最终 publication，不能把语义归并伪称纯函数。
- Quality denominator 仍按原 unit/LID 口径，不能因 fragment 数增加而虚高成功率。

### 3.6 类型化失败与账本

新增 V3 diagnostic，V2 保持只读：

```ts
interface AutomaticBuildFailureDiagnosticV3 {
  version: "automatic_build_failure_diagnostic.v3";
  category: "schema" | "evidence" | "provider" | "executor" | "budget" | "internal";
  code: string;
  phase: "input_delivery" | "generation" | "candidate_sink" | "artifact_writer";
  json_pointer?: string;
  expected?: string;
  reported_code_digest?: string;
  diagnostic_digest: string;
}
```

最低分类表：

| phase | category/code | semantic attempt | recovery |
|---|---|---:|---|
| preflight | `budget/input_transport_budget_exceeded` | 不创建 | replan/router migration |
| input delivery | `executor/semantic_input_transport_truncated` | 不创建 | new delivery/lease epoch |
| input delivery | `executor/semantic_input_delivery_interrupted` | 不创建 | recover executor |
| generation | `provider/<allowlisted transient>` | 按既有 provider 规则 | guarded retry |
| generation | `schema/semantic_output_invalid` | 失败一次 | new semantic attempt |
| candidate sink | `executor/candidate_sink_unavailable` | 保持当前 attempt | replay/recover executor |
| artifact writer | `internal/writer_failed` | 失败一次 | forward fix |
| V1 unknown executor report | `executor/executor_failed` | 按调用时阶段 | recover executor/inspect |

实现上禁止继续使用一个无上下文的 `automaticBuildFailureDiagnosticFromCode()` 处理所有来源。至少拆成 executor report、candidate sink、extractor contract 和 writer error 四个入口；只有 writer call 已写入 `writer_started_at` 后的 catch 才能构造 `writer_failed`。

自由文本 message 不参与分支，也不因本次事故改成任意持久化。必要的真实原因必须进入 allowlisted code、phase、计数或 digest；旧未知短码只保留有界 digest，历史 `writer_failed` 文件不重写。

### 3.7 前向 policy 与恢复状态机

```text
old book_structure_unit.v1 scope A
  semantic_attempt 1..3 -> RETRY_EXHAUSTED(A, historical writer_failed)

release protocol v2 + transport profile + book_structure_unit.v2 scope B
  -> old A remains append-only/readable
  -> route current source under B
  -> every active unit has execution budget proof
  -> retry_current validates current scope B != frozen A
  -> REPLAN
  -> complete delivery signs a generation grant with attempt=0
  -> first needed B unit starts semantic_attempt=1 only when generation.start is accepted
```

若发布后 current scope 仍等于 A，`retry_current` 必须继续 `recovery_not_satisfied`；这是 release/policy identity 漏绑，不能靠 reset 绕过。若 T8 遇到新结构化 budget/transport blocker，停止并回到对应切片，不对真实书多次试错。

### 3.8 Codex subagent 能力、权限、可见性与编排

能力集合必须满足：

```text
executor_tools = {
  executor.open,
  executor.input.next,
  executor.generation.start,
  executor.submit_candidate
}

root_toolset ∩ executor_tools = ∅

authorized_executor_call =
  valid_agent_bootstrap_digest
  AND valid_child_connection_capability
  AND valid_ref_and_session_binding
  AND requested_operation_allowed_in_current_phase
```

- Build Executor server 只在 `.codex/agents/understand-book-executor.toml` 及其发布 asset 的 agent-specific `mcp_servers` 中登记；root/project `.mcp.json` 继续只承载 root 可用能力，不得出现 `executor_tools`。
- Launcher 在模型参数之外建立短寿命 `child_connection_capability`，绑定 agent bootstrap digest、server process/connection、protocol generation 与 session-private root。Capability 不进入 prompt、tool schema、tool argument/result、agent final、日志或 root action；`opaque_handoff_ref` 单独永远不足以授权。
- Executor custom agent 显式设置 `sandbox_mode="read-only"`，禁用/移除无关 MCP 与 skills；bootstrap 禁止直接 filesystem write 和任意 shell construction。若安装态工具清单仍出现非必要写能力，T6 必须 fail-closed，不能用 prompt 承诺代替隔离。
- Codex 会把父 turn live sandbox/approval override 重新施加给 child，所以 read-only 只是最小权限默认值，不是最终信任根。即使父 turn 为 `danger-full-access`/`--yolo`，server 仍只能操作 capability 所绑定 session 私有根与封闭 schema；不得接受路径参数或访问 workspace 任意路径。
- Interactive 模式可把 child approval 显示给用户；non-interactive 或无法弹 approval 时，所需新权限不可用必须返回 `bootstrap/protocol_incompatible`，并保持 lease/attempt/candidate/writer 为零，不能等待隐藏 approval 或降级到 shell。

可见性合同：

| 内容 | 允许出现 | 禁止出现 |
|---|---|---|
| semantic prompt/input chunk | 专用 executor child 的 tool-result context；用户主动打开该 thread 时可检查 | root thread/action/final、child final、其他 subagent、通用 stdout/stderr、metrics、failure message、非私有日志 |
| candidate JSON value | 专用 executor child 的 `submit_candidate` tool request；session-private mailbox | tool response、root、child final、其他 subagent、shell/source file、通用日志 |
| digest/phase/count/lifecycle | child lifecycle final、root durable-state projection、allowlisted diagnostics | 不得携带可逆正文、路径或自由文本摘录 |

这里的“私有”只表示与 root/其他 agent/通用日志隔离，不表示对主动检查 child thread 的用户隐藏。若真实产品要求 child thread 也不保存或显示正文/candidate，则当前 MCP chunk/sink 设计直接判为不满足；必须等待或采用 Harness 原生、不会进入 agent thread 的私有 input/structured-output channel。

多 ref 编排写死为 first-terminal + durable reread：

```text
live_by_ref = {}
completed_refs = {}
action = BuildEngine.step()

loop:
  merge action.SPAWN_EXECUTORS.refs into pending_refs
    excluding live_by_ref and completed_refs
  spawn pending refs up to current live-slot capacity

  if live_by_ref:
    wait until the first owned child becomes terminal
    record only its bounded lifecycle result
    move only that ref from live_by_ref to completed_refs
    action = BuildEngine.step() # durable truth, immediately reread
    continue                    # every other live ref remains owned

  if pending_refs and no live slot is available:
    wait for a slot/lifecycle event, recompute capacity, continue

  if action is WAIT:
    wait only retry_after_ms, action = BuildEngine.step(), continue

  if action is NEEDS_USER or DONE:
    assert live_by_ref is empty
    return action to root only now
```

Child interruption、root restart 或 slot 变化后都先重读 Build Engine，再决定是否重新签发/接管；不得根据 child 自述模拟 terminal，不得 wait-all 后才刷新有依赖 DAG 的调度状态，也不得因第一个 child 完成而遗失仍运行的 ref。

## 4. 切片顺序

### T0 ADR 与实施合同

状态:完成，2026-08-25；同日经 Codex subagent 合规审查修订。

**做**:新增 ADR-0114 与本方案，冻结输入 carrier、双预算、candidate sink、失败阶段、BookStructure 路由、前向迁移、subagent capability/可见性/权限、generation grant 和发布门禁。

**输入/输出**:输入为只读事故元数据、当前源码、ADR-0092/0100/0101/0103 与现有测试；输出为两份互相链接、可从零接手的文档。

**触达**:

- `docs/adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md`
- `docs/切片方案-executor有界语义传输与候选提交闭环.md`

**不做**:不改代码、`CONTEXT.md`、`docs/代码链路.md`、构建 workspace、attempt、policy 或插件安装。

**完成判据**:ADR 决策块符合 write-decision 形状，链接和编号唯一，官方 Codex subagent 约束有对应规范性合同，`git diff --check` 与定向 Markdown 检查通过。

**回滚**:只删除两份新增文档；无运行状态或用户数据变化。

### T1 传输画像与红测

状态:已实施并验证（2026-08-25）；profile/proof/packer 与 dormant V4 保持未发布。

**做**:先用 synthetic carrier 冻结五个现有缺口，再实现版本化 transport profile、response packer 与 V2 execution budget evaluator；不接生产 session。

**输入/输出**:输入为当前 `GENERATE` action、Codex 最低已观察工具结果额度、现有 estimator/reserve 与合成 317,247-byte generation input；输出为 `ExecutorTransportProfileV1`、`ModelExecutionBudgetProofV2`、纯函数 chunk packer 和可重复红绿测试。

**触达**:

- 新增 `packages/core/src/executor-transport.ts`
- `packages/core/src/model-input-budget.ts`
- `packages/core/src/model-input-renderer.ts`
- `packages/core/src/stage-work-unit.ts`（只加兼容类型/validator，不切 active router）
- 新增 `packages/core/test/executor-transport.test.ts`
- `packages/core/test/model-input-budget.test.ts`
- `packages/core/test/automatic-build-executor-session.test.ts`

**先红用例**:

1. 当前 `executor.open` 对 317,247-byte fixture 的 serialized response 超过 profile，且含 `semantic_input`。
2. 当前 `structure_unit.max_input_tokens=10_000_000` 不能提供 transport proof。
3. 当前短 fixture 通过不能证明 10k-token 以上结果可达。
4. 同一 payload 在 token cap、byte cap、envelope reserve 或 max chunk count 任一越界时必须 blocked。
5. Proof 修改 transport profile、chunk count、renderer/prompt hash 或 reserve 任一字段后验证失败。

**实现约束**:

- Packer 按最终 canonical response 反算，不能先切 8 KiB payload 再额外包 envelope。
- 同时检查 token 与 byte；UTF-8 code point 不可切断。
- `max_input_chunks` 是硬闸，不能无限工具轮次换取“理论可传输”。
- V1 proof/descriptor 只读兼容；V2 proof 使用新 version，不增加含义模糊的 optional 字段。
- Profile digest 进入 proof 和后续 task binding；profile 改变必须形成新 scope。
- Synthetic generator 通过 seed/目标 byte length 生成，不提交 317 KiB fixture blob。

**不做**:不改变 `executor.open`、不写 task/lease、不加 MCP、不迁移 BookStructure。

**完成判据**:T1 红点逐一转绿；profile/packer/proof 的边界、篡改、Unicode 与 exact-size 测试全绿，旧 V1 tests 和 typecheck 保持绿。

**回滚**:删除新纯函数与未被生产引用的 V2 类型；V1 行为不变。

### T2 有界输入交付协议

状态:已实施并验证（2026-08-25）；V2 仅注册内部 session/Sidecar 命令，生产 V1 默认与 candidate path 未切换。

**做**:实现 `automatic_build_executor_session.v2` 的 manifest/chunk/receipt 循环，移除 V2 `open` 的内嵌 prompt/input；完整交付后先签发 generation grant，再以幂等 `generation.start` 原子创建 open semantic attempt 并返回 `GENERATE`。

**输入/输出**:输入为合法 opaque handoff、T1 transport profile、精确 semantic prompt/rendered input bytes 与 current durable task state；输出为 bounded V2 actions、私有 input-ref/delivery records、`INPUT_COMPLETE`、generation grant 与可重放的 open attempt/`GENERATE`。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/automatic-build-lease.ts`
- `packages/core/src/automatic-build-task-store.ts`
- `packages/core/src/automatic-build-dispatch-runtime.ts`
- `skills/build/automatic-build.ts` 的 input observation/renderer 复用点
- `skills/build/sidecar-entry.ts`（先注册内部命令，不切发布 skill）
- executor session/lease/task-store/dispatch tests

**红绿用例**:

1. `open.v2` response 不含 `semantic_prompt`/`semantic_input`，serialized size 小于 profile。
2. 317,247-byte low-level stream 被分成有界、有序、hash-bound chunks；但因 `max_input_chunks` 应在 preflight blocked 的 work unit 不得靠无限读取绕过。
3. 合法小输入逐 chunk 重构的 SHA-256 与 renderer bytes 完全一致。
4. 重放 next/receipt 返回相同 chunk，不重复创建 delivery record、lease 或 attempt。
5. 错序、跨 session、篡改、过期、未知 receipt 全部 fail-closed。
6. 在第 1 个、中间或最后 chunk 模拟 truncation/interruption，attempt snapshot 仍为零。
7. 最后一条 receipt 首次或并发确认只产生同一个 byte-identical generation grant，`semantic_attempt` 仍为 0。
8. Grant response 丢失、agent 在 grant 后/`generation.start` 前中断、或同一 grant 重放，均保持 attempt 0。
9. `generation.start` 请求丢失时 attempt 0；首次被 code 接受时恰好创建 open attempt 1，并发/串行重放仍指向 attempt 1。
10. `GENERATION_START`/`GENERATE` response 丢失后，reopen 返回同一 open attempt/action；不得记 semantic failure、不得创建 attempt 2。
11. Agent 在 `GENERATE` 后、candidate submit 前中断时，按同一 attempt 的 executor recovery 继续；只有显式类型化 semantic failure 才关闭/消耗该 attempt。
12. reopen 从第一条未确认 chunk 恢复；terminal task 直接 `DONE`，不读 input、不签 grant。

**不做**:不改变 candidate path submit，不切 custom agent/MCP，不迁移 stage router。

**完成判据**:所有 V2 response 均由统一 bounded writer 发出；在 synthetic truncating carrier 下零截断生成、start 前零 attempt、start 后 transport replay 不关闭也不递增 attempt，V1 active session compatibility tests 仍绿。

**回滚**:capability flag 不发布 V2；已写的 delivery records无 artifact 语义且保持只读，V1 session 继续按原路径恢复。

### T3 结构化 candidate sink

状态:已实施并验证（2026-08-25）；Core structured sink、dormant agent-only adapter 与内部 Sidecar alias 已落地，生产 V1、custom agent/plugin/MCP 发布面仍未切换。

**做**:新增结构化 candidate submit Core API 与独立 Build Executor MCP adapter，让 V2 executor 直接提交 JSON value，由代码写 canonical private mailbox；移除 V2 `candidate_path`。

**输入/输出**:输入为 `candidate_sink_ref + JsonValue`；输出为现有 canonical candidate record、Schema/evidence/writer receipt 与 candidate-free next action。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/automatic-build-mailbox.ts`
- 新增或扩展 Build Executor stdio MCP adapter/contract module
- `skills/build/sidecar-entry.ts`
- executor custom-agent `mcp_servers` 的 agent-only 测试 fixture；root/project `.mcp.json` 负向 fixture 必须不含 Build Executor
- executor session/mailbox/MCP contract tests

**红绿用例**:

1. V2 submit schema 不含 `candidate_path`，拒绝 unknown keys、host object、NaN/Infinity、过深和超限 candidate。
2. Code serialization 的 bytes/hash 与 mailbox record 一致；BOM、shell quoting、PowerShell 和临时 source path 不参与。
3. 相同 JSON value replay 幂等并增加/复用合法 submit revision；不同 value 冲突。
4. Candidate 只出现在专用 child 的 tool request 与私有 mailbox；tool response、root projection、root/child final、其他 agent、通用 stderr/stdout 和日志 sentinel 扫描为零。
5. Schema/evidence 错仍由现有 gate 给出类型化 semantic failure，不能被 sink 误记为 transport success。
6. Sink 在写入前/后模拟 crash：写入前可重试，写入后靠 canonical hash replay；不产生半 candidate 或重复 writer。
7. V2 session 拒绝 V1 path submit；已打开 V1 session 仍可按旧合同完成。
8. 缺失/错误 child connection capability 时，即使 handoff/session/sink ref 全部真实也拒绝提交且 mailbox 零 mutation。

**不做**:不修改 Book MCP 的只读工具面，不改变 artifact writer/schema，不发布 custom agent 新 prompt。

**完成判据**:不使用 shell 生成 candidate 文件即可从 open semantic attempt 走到 terminal receipt；capability、可见性、幂等、crash/replay 与现有 writer 矩阵全绿。

**回滚**:关闭 Build Executor MCP capability，尚未发布的 V2 session 不签发 sink ref；V1 mailbox/artifact 不改写。

### T4 BookStructure 有界路由

状态:已实施并验证（2026-08-26）；active snapshot/plan、frozen generation、writer、quality/public close 与 scheduler 均使用 transport-proof-bound V4 BookStructure 路径。生产 executor V2 capability 切换、安装态发布和真实书恢复仍分别属于 T6-T8。

**做**:把活跃 `book_structure` 从 V2 compatibility descriptor 升级为 transport-proof-bound router，增加 whole-unit fast path、fragment、per-unit reduction 与 oversized stitch reduction。

**输入/输出**:输入为现有 `BookStructureUnitSource[]`、真实 renderer、transport/model budget、当前 fresh unit artifacts 与 profile rules；输出为全部可路由的新 descriptor/task binding、coverage manifest、fragment/reducer artifacts和未改变的最终 `BookStructureUnitArtifact/BookStructureStitchArtifact`。

**触达**:

- `packages/core/src/book-structure.ts`
- `packages/core/src/build-orchestrator.ts`
- `packages/core/src/stage-work-unit.ts`
- `packages/core/src/model-input-renderer.ts`
- `packages/core/src/semantic-artifact.ts`
- `packages/core/src/automatic-build-dispatch.ts`
- `skills/build/book-structure-input.ts`
- `skills/build/automatic-build.ts` 的 BookStructure writer/submit 路径
- 新增 fragment/reducer extractor prompts 与 contract tests
- book-structure/model-input-routability/dispatch/quality tests

**路由测试矩阵**:

1. [x] 小 unit 走 whole-unit fast path，renderer/input hash 与旧语义输入字节一致。
2. [x] 317,247-byte legacy-shaped unit 必须拆分；没有一个 child/reducer/stitch unit 超 execution proof。
3. [x] Leaf core ranges 有序、无缺口、无重叠；重复 context 不计 coverage。
4. [x] graph/discourse/formula/pass2 每个稳定 item key 至少被分配一次；非法悬空 evidence 在路由期 blocked。
5. [x] graph fan-out 超限时进入 typed shard；单条原子记录超限返回结构化 budget recovery，不截断。
6. [x] Fragment artifact 缺失、hash 漂移、policy 漂移或 evidence 越界时 reducer 不可领取。
7. [x] Reducer fan-in 超限时形成多层树；层级、group ordinal 与 child hashes 确定性稳定。
8. [x] 最终每个原 unit 恰好一个 unit card；公开 `book_structure.json` schema 与 LID identity 不变。
9. [x] Fragment 数不能改变 quality denominator；空 fragment、重复 key stop 与 cross-fragment dependency 由 gate 明确处理。
10. [x] 现有 fresh 小 unit 只有满足 exact adoption 条件才产生 migration receipt；原事故 unit 不得伪装 adopted。

**不做**:不重切 LID、不把 fragment 变成公开 unit、不重跑已 fresh Pass1/profile sidecar、不降低 BookStructure Schema/evidence/quality floor。

**完成判据**:生产 snapshot/plan 的所有 pending BookStructure work unit 都是有效 execution proof 或整个 stage 返回一个结构化 block；`10_000_000` 不再保护 `structure_*`，317,247-byte fixture 全链可路由。

**收口证据**:T4 40/40、V3 routing/CLI 18/18、T2/T3 session 21/21、mailbox/adapter/transport 15/15 与 Core typecheck 全绿。最终 diff 只覆盖 BookStructure V4 route/generation/dispatch/quality/CLI、对应测试与文档；未修改公开 BookStructure/LID 合同，未进入 T5/T6、custom-agent/plugin/cachebuster 或真实书 `retry_current`。

**回滚**:未发布 policy generation 前关闭 v2 router；一旦新 descriptor/attempt 落盘只允许 forward fix，不能让旧 binary 写同 generation。

### T5 失败账本与恢复语义

状态:已实施并验证（2026-08-26）；V3 writer 与 V2 兼容 reader、四类来源 mapper、阶段 metrics/账本及 driver recovery projection 已闭合。T6 发布与 T8 真实书恢复仍冻结。

**做**:引入 failure diagnostic V3、分来源 mapper 和阶段 metrics；修正 input delivery、candidate sink、semantic generation 与 writer 的 semantic attempt/lease/submit 记账及 driver recovery projection。

**输入/输出**:输入为四个 code-owned failure source 与 V1 legacy report；输出为严格 allowlisted V3 diagnostic、append-only events/metrics 和准确的 `required_recovery`。

**触达**:

- `packages/core/src/extractor-contract.ts`
- `packages/core/src/automatic-build-mailbox.ts`
- `packages/core/src/automatic-build-metrics.ts`
- `packages/core/src/automatic-build-task-store.ts`
- `packages/core/src/automatic-build-attempt-recovery.ts`
- `packages/core/src/automatic-build-executor-session.ts`
- `skills/build/automatic-build-driver.ts`
- failure/mailbox/metrics/task-store/session/driver tests

**红绿用例**:

1. [x] 事故三个未知 V1 executor code 通过 executor 入口后均为 `executor/executor_failed` 或显式 legacy alias，绝不为 `writer_failed`；reported code 只留 digest。
2. [x] 同一未知 code 若来自 writer catch，只有 writer-start 已落盘时才可成为 `internal/writer_failed`。
3. [x] input transport overflow 在 preflight 返回 budget block，attempt/lease/candidate/writer 均为零。
4. [x] chunk truncation/interruption 只推进 delivery/lease recovery；三次也不能形成 semantic `retry_exhausted`。
5. [x] `generation.start` 被接受前的 grant/transport failure 保持 attempt 0；`GENERATE` 后的 schema/provider/semantic failure 才按既有规则关闭或消耗 open attempt。
6. [x] candidate sink 暂时不可用时保持当前 attempt 并允许 same candidate replay；不同 candidate 仍冲突。
7. [x] `output_bytes=0 + writer_started=false` 的 diagnostic 不可能是 writer phase；schema validator 对伪造组合 fail-closed。
8. [x] V2 failure receipt/attempt event 保持可读；旧真实 `writer_failed` bytes/digest 不变。
9. [x] 同 scope deterministic failure 上 `retry_current` 仍零 mutation；scope 已改变时重规划。

**不做**:不持久化自由文本 message、raw stderr、candidate 或正文，不修订旧事故文件。

**完成判据**:失败 category/code/phase、metrics 与 required recovery 一致；没有 mapper 能把 executor/candidate phase 默认为 writer，driver 聚焦测试与 typecheck 全绿。

**收口证据**:session 按 worker 超时边界 23/23、其余 failure/mailbox/metrics/task-store/driver 56/56；扩展 T4 保持门 50/50、mailbox/adapter/transport 15/15、budget/CLI 18/18、prompt suite 6/6、Core typecheck 与 `git diff --check` 全绿。15 个 extractor 的 task/dispatch prompt contract 与 protocol doctor 四门 compatible；V2 reader 只读兼容、旧事故文件与真实书未改，未进入 T6 plugin/cachebuster 或 T8 `retry_current`。

**回滚**:新 writer 已落 V3 diagnostic 后只能用兼容 reader forward fix；切换前可关闭 V3 writer，V2 read 始终保留。

### T6 协议切换与安装态门禁

状态:完成，2026-08-26。T6.1 完成 agent-only MCP 与进程私有 connection capability；T6.2 完成 V2 custom-agent/bootstrap、driver doctor、first-terminal root 合同和 source/agent/plugin/root-negative 静态发布门。Compiled Sidecar、thin-plugin 安装态 parity、cachebuster 与 trace 扫描仍属 T7。

**做**:发布只由 executor custom agent 登记的独立 Build Executor MCP、connection-bound capability、V2 custom-agent/bootstrap contract、driver capability 与 protocol doctor；让薄插件安装态只走 `open -> input.next -> generation.start -> submit_candidate`，并把 multi-ref first-terminal 等待策略写入 root build skill。

**输入/输出**:输入为 compiled Sidecar、transport profile、V2 Core APIs 与现有 agent/plugin assets；输出为字节一致的 repo/release custom-agent contract、agent-only MCP registration、launcher capability、root negative tool contract、doctor evidence 和可回滚的协议选择。

**触达**:

- `agents/automatic-build-dispatch-executor.md`
- `.codex/agents/understand-book-executor.toml`
- `plugins/understand-book/assets/codex-agents/understand-book-executor.toml`
- `skills/executor/SKILL.md`
- `plugins/understand-book/skills/executor/SKILL.md`
- executor custom-agent 内的 agent-specific `mcp_servers`、executor launcher/Sidecar MCP entry 与 connection capability
- 根/发布 project `.mcp.json` 的禁止注册断言（继续不含 Build Executor）
- `skills/build/SKILL.md` 与发布副本中的有界 executor 摘要、first-terminal 等待/重读规则
- `skills/build/automatic-build.ts:automaticBuildProtocolDoctor`
- `apps/desktop/scripts/assert-plugin-release.mjs`
- agent publication/handoff/release/parity tests

**发布合同**:

- Root 仍只收到/转交 `opaque_handoff_ref`；不新增 input/sink ref 到 root action。
- Root 的实际 runtime tool inventory 与 `{executor.open,input.next,generation.start,submit_candidate}` 交集必须为空；root/project `.mcp.json` 不得注册 Build Executor。
- Build Executor 只登记在 `.codex/agents/understand-book-executor.toml` 及发布副本的 agent-specific `mcp_servers`；“分 server/namespace”只是命名边界，不算权限证据。
- Launcher 只为匹配 V2 bootstrap digest 的 child connection 建立短寿命 capability；每个工具调用同时验证 connection capability 与 ref/session/phase。真实 `opaque_handoff_ref` 单独不能建立 input、generation 或 sink session。
- Dedicated agent 显式 `sandbox_mode="read-only"`，不直接写 filesystem，不构造任意 shell，不创建 candidate source，不调用 `candidate_path` submit；无关 MCP/skills 必须 disabled/absent。
- 父 turn live permission override 可能覆盖 child 默认 sandbox，因此 server 仍以 session-private root、无路径参数、封闭 schema 和 capability 强制最小权限；`danger-full-access`/`--yolo` 不能扩大 server 可达路径或操作。
- Build Executor MCP 与只读 Book MCP 分 server、分 tool namespace、分权限说明；executor child 的最终工具清单不得因父配置继承出现非必要写能力。
- Semantic chunks/candidate 只按 §3.8 出现在可检查的专用 child tool 交互；bootstrap 和发布文案不得宣称 child thread 对用户隐藏，也不得使用含糊的“never through chat”。
- Dedicated agent final 只返回 `committed | retryable_failure | interrupted` 与有界 lifecycle metadata；不含正文、candidate、路径或任意日志摘录，root 随后只读 durable Build Engine truth。
- Root build skill 对每个 ref 恰好 spawn 一个专用 agent，按 live slots 填充；任一 child terminal 即 `build.step`，保留其他 live ref，禁止重复/孤儿/提前 final。
- Doctor 在内存中验证 transport profile、V2 action/grant schema、chunk packer、sink schema、agent marker、agent-only MCP launcher、root negative tool inventory、connection capability 和 synthetic proof，且 `dry_run_mutates_state=false`。
- V2 handoff 只能分配给 V2 bootstrap digest；V1 handoff/active session 只读兼容，不混用 action。
- 缺 MCP、旧 agent template、profile digest 漂移、无法建立 child capability、所需权限不可用或 compiled Sidecar 不支持 V2 时，driver 返回 bounded `bootstrap/protocol_incompatible`；lease/attempt/candidate/writer 均为零，不降级 shell/path submit。
- Capability flag 保留一个发布周期；rollback 只能停止签发新 V2 session，不能重写已提交 V2 task。

**完成判据**:repo/release/installed agent 与 agent-only MCP assets parity；root runtime inventory 无 executor tools，root 持合法 ref 的负向调用仍拒绝；read-only/default、interactive、non-interactive 与父权限放宽矩阵符合合同；薄插件没有源码 `agents/` 时 doctor compatible，V2 executor 可完成 synthetic dispatch，trace 只在 §3.8 允许位置命中正文/candidate。

**完成证据**:T6 源码门验证三份 agent 与两份 skill/build 投影字节一致、agent-only MCP/read-only/V2 digest/tool allowlist、root/project negative inventory、四工具 wrapper 与 first-terminal root 合同；root 持合法 ref、跨 handoff/session、额外字段和 candidate 回流负测均拒绝。Compiled/thin-installed/cachebuster/trace 条目按切片边界留给 T7，不作为 T6 伪证据。

**回滚**:停止新 V2 dispatch，等待/中断活动 V2 session后用兼容 binary inspect；不降级写入同一 policy generation。

### T7 真实尺寸门禁与前向发布

状态:完成，2026-08-27；compiled/installed synthetic 门、真实 CLI custom-agent child trace、durable success event 与前向 cachebuster 均已验证，未触碰真实书。

完成证据:`docs/performance/understand-book-t7-codex-cli-release.json` 记录 Codex CLI 0.147.0、安装态插件 `0.1.0+codex.20260827012058`、root executor 工具交集为空、`semantic_attempts=1`、`committed_tasks=1` 与 child-only trace allowlist；完整 installed release assertion、22 条相关 Core 测试、Core typecheck 与 scoped diff check 全绿。

**做**:运行 synthetic 317,247-byte、truncating carrier、installed thin-plugin、compiled Sidecar 与模型短回放矩阵；全部通过后发布新的 transport/router/policy set generation，但仍不碰真实书。

**输入/输出**:输入为 clean checkout/staging install、确定性大输入 generator、已编译 Sidecar 与 V2 plugin；输出为自动门证据、新 release/cachebuster、`book_structure_unit.v2` policy scope 和回滚说明。

**必须证明**:

1. Legacy-shaped 317,247-byte source 不会出现在任何单次 tool result；每个 result 的实测 token/byte 小于 profile。
2. 5k-token truncating carrier 下完整小 unit 可读，大 unit 在路由期拆分；删尾、截中、乱序均不能进入 GENERATE。
3. Input delivery 中断以及最终 receipt/grant 返回后、`generation.start` 被接受前的中断均为 `semantic_attempt=0`；完整交付本身不得创建 attempt。
4. Grant result 丢失、`generation.start` 请求丢失/串行或并发重放、`GENERATE` result 丢失和 agent 在 grant/start 后中断均符合两阶段合同：start 前为零，start 后只恢复同一 open attempt，绝不因 transport 创建 attempt 2 或 `retry_exhausted`。
5. Candidate 通过 structured sink 完成，无 PowerShell 或 candidate source path；candidate 只允许命中专用 child tool request/mailbox，不得命中 response、root chat/final、child final、其他 agent 或通用日志。
6. Writer 未启动的 transport/sink failure 不可能产生 `writer_failed`；真实 writer throw 仍准确分类。
7. BookStructure fragment/reduce/stitch coverage、Schema、evidence、quality 与 publication 全绿。
8. 新 policy/router/transport profile 任一变化都会改变 attempt scope；旧失败 scope 不计入新 scope。
9. Node、compiled Sidecar、薄插件、registered custom agent 和 executor MCP 对 canonical action/grant/proof/diagnostic parity。
10. Root 在真实 app/CLI installed-state runtime tool inventory 中不存在 `executor.open/input.next/generation.start/submit_candidate`；不能只检查 root final 或配置文本。
11. Root 即使持有合法 `opaque_handoff_ref`，也无法取得 child connection capability，不能建立 input/generation/sink session；拒绝过程零 state mutation。
12. Executor 在 default read-only、interactive approval、non-interactive/无法弹 approval 与父 turn live override 放宽四种模式下行为一致；所需权限不存在时返回 `bootstrap/protocol_incompatible` 且 attempt=0。
13. 父 turn 为 `danger-full-access`/`--yolo` 时，恶意/错误 tool arguments 仍不能访问 session-private root 之外路径、接受 path 参数或调用未授权 operation。
14. 真实 Codex app/CLI trace 检查符合 §3.8 visibility matrix：semantic chunks 只命中专用 child tool results，candidate 只命中其 submit request；root、final、其他 child、非协议 stdout/stderr、metrics/failure/logs 全部零命中。
15. 3 个 ref 在 1/2/3 个实际 live slots、乱序完成、child interrupted、root 在首个完成后 re-step 的矩阵中，无重复 spawn、无 live ref 遗失、无 orphan、无提前 final。
16. 一次安装态 semantic smoke 只使用合成输入；agent final 只有 candidate-free lifecycle 状态，root 只根据 durable Build Engine state 收口。
17. 发布资产可从干净 staging 卸载/回滚，书库与历史 task 不删除。

**命令基线**:

```powershell
pnpm -C packages/core test -- executor-transport model-input-budget automatic-build-executor-session automatic-build-mailbox automatic-build-dispatch book-structure automatic-build-driver
pnpm -C packages/core typecheck
node apps/desktop/scripts/build-sidecar.mjs
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
node apps/desktop/scripts/smoke-codex-build-intent.mjs
node apps/desktop/scripts/assert-plugin-release.mjs
git diff --check
```

Vitest filter 若不能精确选文件，拆成逐文件 `vitest run <file>`，不得省略 suite。并发 timeout 必须先用单 worker 重跑区分环境噪声，不能改断言或提高 transport/quality 上限。

**不做**:不运行当前真实书 `retry_current`，不清理旧 task，不用真实用户内容做 fixture。

**完成判据**:自动矩阵与安装态 smoke 全绿，P0 agent-only capability isolation 由实际工具清单和持 ref 负测解除，权限/trace/multi-ref 证据齐全，发布说明明确新/旧 protocol 与 policy scope，clean staging 可复现；否则 Codex subagent compliance 仍为 `BLOCKED`，不得进入 T8。

**回滚**:撤回新签发 capability/cachebuster，保持旧 release 可安装；已写 staging V2 状态仅留在 staging，不迁入用户 workspace。

### T8 当前真实书守卫恢复

状态:已执行至重复 bootstrap blocker，2026-08-28；completed-delivery replacement-child rehydration 与 compiled/installed release gate 仍绿，当前任务的 dedicated V2 child 在首个真实书 ref 上返回 `bootstrap/protocol_incompatible`，尚未到 durable `DONE`。

阶段证据:`docs/performance/understand-book-t8-resume-codex-cli-release.json` 记录三项既有 delivery 全量确认、semantic attempt 均为 1、attempt 2/candidate/failure/receipt/本会话 `retry_current` 均为 0，前后 12-file attempt digest 相同；最新 child 未新增 executor open，installed doctor 将不兼容缩小到 `executor_bootstrap` 与 `plugin_shape`，恢复动作按 bootstrap blocker 停止规则终止。

**做**:对当前书做一次只读前态封存，安装已验收 release，执行一次 `retry_current` 让 driver 识别新 scope，并持续到 `book_structure` closed 或首个新的结构化 blocker。

**输入/输出**:输入为旧耗尽 boundary digest、新 installed release/policy scope 和当前已确认 BuildPlan；输出为新 scope attempt/receipt、fresh `book_structure.json` 或一个不泄露正文的稳定 blocker。

**执行顺序**:

1. 只读记录 target/plan/policy/old boundary/旧 failure files 的 digest 与 stage freshness；不读取 candidate/semantic bodies。
2. 验证 installed doctor、agent template、agent-only MCP、root negative tool inventory、connection capability、Sidecar、transport profile 和 policy set 与 T7 release 完全一致。
3. 调用一次 `retry_current`；预期 current scope B 与旧 boundary A 不同，driver 进入 replan，旧 A 零改写。
4. 观察 BookStructure 新 route；每个 unit 必须带 execution proof，unit `1.6` 必须是 fragment/reduce 而非 317,247-byte direct `GENERATE`。
5. 让 dedicated executor 正常推进；只收集 chunk/grant counts、bytes、attempt/lease、phase code、writer timing 和 artifact/receipt digests，正文只按 §3.8 留在可检查 child tool context。
6. 成功时重验 `book_structure` quality、publication、post-freshness 与最终 `build.step`；只有 durable `DONE` 才完成。
7. 若出现新 block，立即停止，不再次 reset/retry；把稳定 code、phase、scope 和恢复动作落档，回到对应切片。
8. 对比旧 attempt/failure/receipt 原始 digest，证明 append-only；不删除 executor private history。

**成功判据**:

```text
old_scope_unchanged
AND new_scope_delivery_complete_still_attempt_0
AND new_scope_generation_start_created_semantic_attempt_1
AND no_tool_result_exceeded_transport_profile
AND no_input_transport_failure_consumed_semantic_attempt
AND post_start_transport_replay_did_not_fail_or_increment_attempt
AND no_candidate_source_or_powershell_path
AND root_had_no_executor_capability
AND writer_started_iff_writer_phase
AND book_structure_quality_passed
AND publication_receipt_valid
AND post_snapshot_fresh
AND driver_action_done
```

**不做**:不补跑 Pass2、不重建仍 fresh 的上游阶段、不修改 BuildPlan、不手工编辑 candidate/artifact、不把 agent final 当成功证据。

**回滚**:在新 public artifact 发布前停止 dispatch并保留状态，回退签发 capability；一旦新 `book_structure.json` 通过 publication，只能用新 generation/forward fix，不覆盖或删除历史。

## 5. 依赖、提交与回滚边界

```text
T0 docs
  -> T1 transport profile + budget proof
  -> T2 bounded input delivery
  -> T3 structured candidate sink
  -> T4 BookStructure active routing
  -> T5 typed failures + recovery accounting
  -> T6 executor protocol/plugin cutover
  -> T7 synthetic full-size + installed release gate
  -> T8 one guarded real-book recovery
```

T2 与 T3 的 Core 纯函数可以在同一开发周期准备，但必须分 commit、分别保持 tests green；T4 不得在 T2/T3 未完成时切 active policy；T6 不得在 T2-T5 任一红时更新 cachebuster；T8 不能与代码修改混在同一切片。

| Commit | 内容 | 可回滚边界 |
|---|---|---|
| 1 | T1 profile/proof/packer | 未接生产，直接回滚 |
| 2 | T2 session V2 input delivery | capability off，V1 继续 |
| 3 | T3 structured sink/Core MCP | 未发布 MCP，V1 继续 |
| 4 | T4 BookStructure router/prompt/contracts | policy 未发布前回滚；发布后仅 forward fix |
| 5 | T5 diagnostic/accounting | V3 writer 启用后保留兼容 reader |
| 6 | T6 plugin/agent/MCP cutover | 停止新 V2 签发，不改历史 |
| 7 | T7 release evidence/cachebuster | 撤回 release，不迁 staging state |
| 8 | T8 durable recovery evidence | 只前向，不删除旧 scope |

每个代码切片完成后更新 `docs/代码链路.md`；T2/T3/T4/T6 改变主要数据流，同周期更新 `docs/架构.md` 和 ADR 反向索引；跨会话暂停时刷新 `SESSION_CHECKPOINT.md`。这些更新只能在对应实现切片发生，不能提前用本次文档切片覆盖用户已有脏改动。

## 6. 预计文件预算

预计新增：

```text
packages/core/src/executor-transport.ts
packages/core/test/executor-transport.test.ts
packages/core/test/book-structure-routability.test.ts
agents/book-structure-fragment-extractor.md
agents/book-structure-reducer.md
Build Executor MCP adapter/launcher 与对应 tests
synthetic 317247-byte fixture generator（代码，不是正文 blob）
```

预计修改：

```text
packages/core/src/model-input-budget.ts
packages/core/src/model-input-renderer.ts
packages/core/src/stage-work-unit.ts
packages/core/src/book-structure.ts
packages/core/src/build-orchestrator.ts
packages/core/src/automatic-build-dispatch.ts
packages/core/src/automatic-build-executor-session.ts
packages/core/src/automatic-build-mailbox.ts
packages/core/src/automatic-build-task-store.ts
packages/core/src/automatic-build-lease.ts
packages/core/src/automatic-build-metrics.ts
packages/core/src/automatic-build-attempt-recovery.ts
packages/core/src/extractor-contract.ts
packages/core/src/semantic-artifact.ts
skills/build/automatic-build.ts
skills/build/automatic-build-driver.ts
skills/build/sidecar-entry.ts
skills/build/book-structure-input.ts
agents/automatic-build-dispatch-executor.md
.codex/agents/understand-book-executor.toml
skills/executor/SKILL.md
skills/build/SKILL.md
executor agent-only MCP、launcher capability、root negative config、agent/skill 与 cachebuster assets
apps/desktop/scripts/build-sidecar.mjs
apps/desktop/scripts/smoke-automatic-build-parity.mjs
apps/desktop/scripts/assert-plugin-release.mjs
相关 Core/installed-state tests
docs/代码链路.md（各实现切片当场追加）
docs/架构.md（结构改变切片当场更新）
```

明确不改：

```text
canonical source、LID 与 citation identity
BuildIntent / BuildPlan / ArtifactBlueprint 领域语义
公开 BookStructure unit card、stitch 与 book_structure.json schema
Pass2 选择与已 fresh 上游 artifact
旧 attempt / lease / failure / receipt / artifact bytes
Reader/Book MCP 只读内容工具与私人 memory
真实书内容、candidate body 或 raw goal 的日志/fixture
```

## 7. 确定性验收总表

| 维度 | 通过证据 | 失败动作 |
|---|---|---|
| 单次工具结果有界 | serialized token + byte <= profile | preflight/programmer block，零 stdout body |
| 输入完整 | segment/range/hash/receipt 连续 | 不签 grant、不进入 GENERATE |
| Grant/尝试准确 | complete delivery 只签 grant 且 attempt=0；accepted start 恰好一个 open attempt | 同 grant 恢复，不计 transport semantic failure |
| Candidate 无 shell | structured tool-input -> code serializer | V2 拒绝 path/source |
| Mailbox 幂等 | same hash replay / different hash conflict | 无重复 writer |
| Writer 分类真实 | writer_started 与 phase 一致 | forged diagnostic 拒绝 |
| BookStructure 可路由 | 每个 active child/reducer 有 proof | structured budget recovery |
| LID/coverage 不变 | core exact cover + evidence allowlist | quality/coverage fail |
| Scope 前向 | transport/router/policy digest 进入 binding | 旧 scope 保持耗尽 |
| Root capability 隔离 | actual tool inventory 交集为空；持合法 ref 仍拒绝 | release fail，禁止注册 project MCP |
| Child connection 授权 | ref + out-of-band child capability + phase 三者重验 | 零 mutation fail-closed |
| 权限继承防线 | read-only 默认 + broad parent override 下 server scope 不变 | protocol incompatible，attempt=0 |
| 可检查 trace 隐私 | app/CLI trace 只在 §3.8 allowlist 位置命中 | release fail；若 child 也须隐藏则换原生通道 |
| 多 ref 编排 | 1/2/3 slots + 乱序/中断无重复、遗失、孤儿 | reread durable state，不提前 final |
| 安装态同构 | Node/Sidecar/thin plugin/agent-only MCP/root-negative parity | 不更新 cachebuster |
| 恢复守卫 | T7 全绿后一次 T8 retry | 首个新 blocker 即停 |

## 8. 冷启动接手读序

下一会话从零实施时按顺序读取：

1. [ADR-0114](adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md) — 不可逆决策与否决项。
2. 本方案 §2-§4 — 不变量、目标合同与当前待实施切片。
3. [ADR-0092](adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md) — semantic attempt/lease/submit 分账。
4. [ADR-0100](adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md) 与[原切片方案](切片方案-预算可路由模型工作单元与构建恢复闭环.md) — 现有 proof、V3 descriptor 和 shadow-route 基座。
5. [ADR-0101](adr/0101-deterministic-prebuild-protocol-ownership-and-codex-semantic-boundary.md) — root/executor/mailbox 隐私边界。
6. [ADR-0103](adr/0103-extractor-contract-coherence-and-policy-scoped-retry-recovery.md) — typed failure 与 scope recovery。
7. `packages/core/src/automatic-build-executor-session.ts`、`automatic-build-dispatch.ts`、`model-input-budget.ts`、`build-orchestrator.ts` 的当前实现。
8. `packages/core/test/automatic-build-executor-session.test.ts`、`model-input-routability.test.ts`、`automatic-build-driver.test.ts` 的现有行为锁。

接手者先重跑 T1 的 baseline，再声明当刀 A1；不能依赖本次对话中未落盘的信息。

## 9. Definition of Done

```text
done =
  executor_open_never_inlines_unbounded_input
  AND every_tool_result_is_token_and_byte_bounded
  AND every_model_unit_has_context_and_transport_proof
  AND input_delivery_is_ordered_hash_bound_and_resumable
  AND complete_delivery_only_issues_generation_grant_with_attempt_0
  AND generation_start_acceptance_creates_exactly_one_open_attempt
  AND post_start_transport_replay_never_fails_or_increments_that_attempt
  AND candidate_submission_is_structured_and_code_owned
  AND no_candidate_path_or_powershell_is_required_for_v2
  AND mailbox_schema_evidence_writer_quality_gates_remain
  AND executor_sink_writer_failures_have_distinct_typed_phases
  AND unknown_executor_codes_never_become_writer_failed
  AND book_structure_large_units_use_bounded_fragment_reduce
  AND public_book_structure_and_lid_identity_are_unchanged
  AND old_scope_and_history_are_append_only
  AND new_transport_router_policy_scope_starts_attempt_1_only_at_generation_start
  AND root_runtime_toolset_contains_no_executor_tools
  AND opaque_handoff_ref_alone_cannot_authorize_executor_calls
  AND every_executor_call_requires_child_connection_capability
  AND parent_permission_broadening_cannot_expand_executor_server_scope
  AND child_thread_visibility_matches_the_explicit_allowlist
  AND multi_ref_first_terminal_reread_has_no_duplicate_or_orphan
  AND synthetic_317247_byte_and_truncation_tests_pass
  AND compiled_sidecar_thin_plugin_agent_only_mcp_root_negative_parity_passes
  AND guarded_real_book_retry_reaches_durable_done_or_one_new_typed_blocker
```

任一项为 false，不得以“chunk 多读了几次”“agent 说写好了”“清空 attempt 后能跑”“writer_failed 看起来相同”或 LLM 自评宣布完成。
