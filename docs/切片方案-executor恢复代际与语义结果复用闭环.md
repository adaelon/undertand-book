# Executor 恢复代际与语义结果复用闭环切片方案

日期:2026-09-02。
冻结决策:[ADR-0117](adr/0117-recovery-generation-handoff-and-semantic-result-reuse.md)。
承接边界:[ADR-0092](adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md)、[ADR-0099](adr/0099-installed-plugin-safe-executor-handoff-publication-and-diagnosable-interruption.md)、[ADR-0114](adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md)、[ADR-0115](adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md)、[ADR-0116](adr/0116-calibrated-executor-transport-budget-and-round-trip-reduction.md)。

本方案只修 Executor 控制面恢复、错误表征和候选传输失败闭环。已提交 Pass1 generation artifact、task receipt、dispatch progress、work-unit identity、task binding、attempt scope、policy generation 与 semantic contract 全部冻结。D0 只落文档；RG1-RG8 后续逐刀实施，不在本轮修改运行代码、插件安装或真实构建状态。

## 0. 对齐确认单

**FrozenIntent**:消除“过期 generation.start 被旧记录重放、submit 才发现 lease expired、错误又被伪装成 protocol_incompatible”的稳定循环；插件升级后原样复用仍 fresh 的 Pass1 结果，只重新执行没有成功 artifact/receipt 的工作单元。本轮只落 ADR 与可执行切片，不直接修代码或续跑真实书。

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| `semantic attempt` | EXISTING | 模型语义尝试；物理租约恢复不递增，候选已生成但违反正式 transport contract 才形成可重试语义失败 |
| 租约世代 `lease epoch` | EXISTING | 同一 semantic attempt 的物理执行权世代；过期世代永久不能 submit |
| 语义复用身份 | EXISTING | `target/source + work-unit input + prompt/policy generation + semantic contract`；决定 accepted artifact 是否 fresh |
| 恢复代际身份 | NEW，已落 `CONTEXT.md` | `dispatch_id + dispatch_run_id + current_work_unit_id + semantic_attempt + lease_epoch`；只决定一次可启动 handoff |
| Executor 调度槽身份 | NEW，实现级 | `dispatch_id + dispatch_run_id` 的稳定 Root 占位键；只防同一 dispatch 同时启动两个 child，不传给 child，不进入任何语义或 artifact 身份 |
| V3/V4 handoff | BOUNDARY_CHANGE | 旧 V3 ref/record 的含义不变且只读可读；新 public recovery handoff 写 V4，不原地修改 V3 哈希输入 |
| candidate transport contract | BOUNDARY_CHANGE | 生成侧显式看到 candidate value 与完整 serialized request 的 token/byte 预算；预算不进入 semantic artifact freshness |

**RiskReceipt**:用户已确认“已提交 Pass1 必须复用，只换代失效控制面”，并要求据此落 ADR 和切片。主要风险是 recovery/transport 字段误入 task binding、attempt scope 或 artifact identity，导致升级后错误重跑；另一个现有并发风险是 live child 跨 work unit 时 Driver 已看到新 ref，Root 若只按 ref 去重会重复启动同一 dispatch。本方案分别用身份冻结测试和 dispatch 槽占位关闭。

**ChangeType**:`[边界重构]`。术语零未解析；Executor 调度槽身份是 Root 编排控制键，不是新的领域对象。

领域对齐完成。

## 1. 已冻结事实与修复边界

### 1.1 已证实故障链

```text
epoch 1 generation.start 已写 start/session/sink
  -> lease 过期，task 无 candidate/result/receipt
  -> Driver 仍返回相同 V3 opaque handoff
  -> replacement child 重放相同 delivery/grant/start
  -> generation.start 无条件返回旧 GENERATE
  -> submit_candidate 才执行 active-lease 检查
  -> lease expired
  -> MCP catch-all 映射 bootstrap/protocol_incompatible
  -> durable task state 不前进
  -> build.step 再次返回相同 ref
```

真实 unit 41 的五次失败使用相同 handoff、task session、candidate sink、semantic attempt 1 与 lease epoch 1；请求没有超过当时的 32,768-byte/2,048-token入口。持久 attempt 只有 execution/input-observation/lease/start，没有 candidate、submission、result 或 receipt。

### 1.2 同外观的不同失败

| 事实 | 真实分类 | 本方案动作 |
|---|---|---|
| 旧 start + expired lease + 无 terminal | `stale_generation_session` | 拒绝旧 GENERATE；Driver 发行当前 recovery identity 的新 V4 ref |
| 完整 candidate request 估算 2,477 tokens | `candidate_request_too_large` | 写 `writer_started=false` 的可重试失败；生成侧正式看到预算 |
| child 9-13 秒结束且零 Executor MCP call | `bootstrap_unavailable` 候选 | 与 session 错误分账；没有新的宿主证据前不调 startup timeout |
| 已提交一单元、开始下一 generation 后 child terminal | `executor_lifecycle_ended` | durable state 优先；Root 释放 dispatch 槽并让 Driver 给当前恢复代际的新 ref |
| Root turn 31.783 秒后 `turn_aborted` | 宿主 turn abort | 不归入 Executor task failure，不由本方案猜发起者 |

### 1.3 数据面冻结清单

下列字段、路径和版本不得在 RG1-RG8 中改变：

- Pass1 `work_unit_id` 的生成方式、输入及 `input_hash`；
- `pass1-window.<quality>.v1`、`pass1-source-slice.<quality>.v1`、`pass1-lid-stitch.<quality>.v1` policy generation；
- `semantic_task_artifact.v3` 路径、payload、artifact freshness 与现有 `artifact_hash`；
- `AutomaticBuildAttemptScopeV1`、task binding、semantic contract；
- target 的 workspace/book/profile/input fingerprint；
- 已存在 artifact、receipt、dispatch progress 和 attempt 事件字节；
- candidate Schema、evidence、quality 与 writer 的业务门禁。

允许变化的只有：public opaque handoff 记录/Driver projection 的前向版本、recovery identity、generation replay 的 currentness 判定、同一语义尝试的 replacement session/sink、MCP 有界错误码、candidate transport output contract 与超限失败落账。

### 1.4 复用判定

```text
for work_unit in current Pass1 graph:
  artifact = readPass1GenerationArtifact(current policy_generation_id, work_unit)
  if artifact matches current semantic reuse identity:
    keep artifact bytes and receipt/progress
    do not add work_unit to pending
  else:
    add work_unit to pending

for current pending dispatch task:
  if current lease/session is usable:
    keep current recovery generation
  else:
    derive current semantic_attempt + lease_epoch
    issue one V4 recovery handoff
```

控制面版本变化不得参与第一个分支。测试中可以直接比较 fixture 的 artifact/receipt bytes；正式 workspace 复用只使用现有 snapshot/freshness 判定，不新增 checksum 清单。

## 2. 目标合同

### 2.1 恢复代际与调度槽

建议的精确类型：

```ts
interface AutomaticBuildRecoveryGenerationIdentityV1 {
  version: "automatic_build_recovery_generation_identity.v1";
  dispatch_id: string;
  dispatch_run_id: string;
  current_work_unit_id: string;
  semantic_attempt: number;
  lease_epoch: number;
}

interface AutomaticBuildExecutorLaunchV2 {
  opaque_handoff_ref: string;
  dispatch_slot_ref: string; // Root bookkeeping only; never passed to child
}
```

稳定性规则：

```text
same dispatch/run/work-unit/semantic-attempt/lease-epoch
  -> same V4 opaque_handoff_ref

work unit, semantic attempt, or lease epoch changes
  -> new V4 opaque_handoff_ref

same dispatch/run across those changes
  -> same dispatch_slot_ref
```

`dispatch_slot_ref` 是 owner identity 的不透明 locator，不是完整性证明。Root 以 slot 保证一个 dispatch 最多一个 live child；`completed_refs` 仍保证同一 recovery ref 最多启动一次。

### 2.2 Handoff 前向版本

```ts
interface AutomaticBuildOpaqueHandoffRecordV4 {
  version: "automatic_build_opaque_handoff_record.v4";
  session_protocol: "automatic_build_executor_session.v3";
  opaque_handoff_ref: string;
  kind: "public_dispatch";
  target_ref: BuildTargetRefV2;
  target_locator: AutomaticBuildTargetLocatorV1;
  owner_identity: AutomaticBuildDispatchOwnerIdentityV1;
  recovery_identity: AutomaticBuildRecoveryGenerationIdentityV1;
  handoff_path: string;
  handoff_sha256: string;
  handoff_byte_length: number;
  issued_at: string;
}
```

- V3 reader 按旧 `automatic_build_opaque_handoff_identity.v3` 验证，绝不加字段后仍称 V3。
- V4 ref 由原 V3 大字段 locator 加 `recovery_identity` 派生；`issued_at`、随机数和 startup observation 不参与。
- 新发行只写 V4；旧 V3 record 与关联 delivery/start/session 保持只读。
- V4 open/start 必须把 record recovery identity 与当前 dispatch/task claim projection 直接比较。
- 不创建 V3→V4 迁移器，不覆盖旧 record；当前 durable state 足以发行新的 V4 record。

### 2.3 Root/Driver 编排

```text
pending_by_slot = latest build.step launches grouped by dispatch_slot_ref

for launch in pending_by_slot:
  if launch.dispatch_slot_ref in live_by_slot:
    do not spawn                         // live child may already have advanced units
  else if launch.opaque_handoff_ref in completed_refs:
    do not spawn                         // this recovery generation was already launched
  else if free_slot:
    spawn exactly one child with only launch.opaque_handoff_ref
    live_by_slot[launch.dispatch_slot_ref] = { child, opaque_handoff_ref }

on first owned child terminal:
  completed_refs.add(owned.opaque_handoff_ref)
  live_by_slot.delete(owned.dispatch_slot_ref)
  call build.step immediately
```

一个 live child 可以继续在同一 dispatch 内顺序提交多个 work units；slot 阻止 Root 因其他 child 先结束而为该 dispatch 的新 current ref 再开一个 child。该 child 自己 terminal 后，slot 释放，Driver 当前投影的新 ref 才可启动。

### 2.4 `generation.start` 三分支

```text
resolve delivery + grant + existing start
  -> inspect current dispatch task and task session lease

if existing start belongs to current recovery identity
   and its lease is active
   and task has no terminal result:
     byte-identical replay existing GENERATE

else if task/dispatch is terminal or current work unit advanced:
     project candidate-free current DONE/next state
     never replay old GENERATE

else if existing start lease expired or record recovery identity is stale:
     return bounded stale_generation_session
     do not write candidate/result and do not consume semantic retry
     Driver derives current identity and issues a new V4 handoff

else if V4 recovery ref matches an already-active claim owned by the same dispatch:
     create a new delivery/grant/task-session/sink under this V4 ref
     reuse the same semantic_attempt and lease_epoch
```

末尾 create-only `start.json` 仍保留；区别是不同 recovery handoff 获得不同 delivery/grant/start 存储身份，不覆盖旧 start，也不会被旧 create-only record吸回去。

### 2.5 类型化工具错误

```ts
type ExecutorToolErrorCode =
  | "protocol_incompatible"
  | "bootstrap_unavailable"
  | "stale_generation_session"
  | "lease_expired"
  | "candidate_request_too_large"
  | "candidate_sink_unavailable"
  | "writer_failed"
  | "executor_internal";

interface AutomaticBuildExecutorMcpErrorV2 {
  version: "automatic_build_executor_mcp_error.v2";
  status: "interrupted" | "retryable_failure";
  category: "bootstrap" | "session" | "transport" | "candidate_sink" | "writer" | "internal";
  diagnostic_code: ExecutorToolErrorCode;
  phase: "open" | "input_delivery" | "generation_start" | "candidate_submit";
}
```

错误只带 allowlisted code/phase/status/category，不带异常 message、路径、ref、token、candidate、stack 或自由文本。`protocol_incompatible` 只表示版本/Schema/工具合同不兼容；MCP server 已进入 session 后发生的错误不得再归 bootstrap。真正零调用的 tool absence/startup failure 由 dedicated role 产生 `bootstrap_unavailable` lifecycle，server 无权伪造它已观察到的 bootstrap 事实。

### 2.6 Candidate transport 与持久失败

生成侧 output contract 至少公开：

```ts
interface CandidateTransportContractV1 {
  version: "candidate_transport_contract.v1";
  candidate_value_max_bytes: number;
  candidate_value_max_estimated_tokens: number;
  serialized_request_max_bytes: number;
  serialized_request_max_estimated_tokens: number;
}
```

现有 public/private candidate output contract 必须前向升版后承载该子合同，不得在既有 V2 名义下原地加字段；该 output-contract 版本只约束 Executor transport，不写入 Pass1 semantic artifact freshness。

入口仍量完整 canonical request。校验顺序改为：先验证固定、小型 session/sink/version 字段并解析当前 task，再量完整请求；若超限且 task 可归属，则写 `candidate_request_too_large`、`phase=generation`、`writer_started=false` 的可重试 terminal，返回 candidate-free `DONE retryable_failure`。无法安全归属 session 的畸形请求只返回类型化 transport/protocol 错误，不写任何 task。

本刀不提高 2,048-token/32,768-byte 当前值，不把预算放进 Pass1 semantic contract/policy generation，也不把超限 candidate 写入 mailbox、日志或错误结果。

## 3. 共同验收与停止条件

### 3.1 每刀共同不变量

- public/private semantic input 和 candidate 仍只进入 dedicated child tool interaction 与 code-owned private state；
- Root action/final、MCP error、metrics、release evidence 不出现正文、candidate、路径或 session ref；
- semantic attempt 只因生成被接受或正式 candidate contract 失败而变化，lease recovery 本身不加 attempt；
- 同一 active recovery ref replay byte-identical，同一 dispatch slot 最多一个 live child；
- accepted artifact、receipt、progress 先于 executor lifecycle final，且继续是完成权威；
- V3 record 不改写，V4 record/create-only projection 不使用时间或 nonce 决定身份；
- 每个代码切片先写能命中本刀失败的测试，再改实现使其转绿；
- 每刀完成立即追加 `docs/代码链路.md`；只有 RG3/RG5 真正改变主数据流后更新 `docs/架构.md`。

### 3.2 全局停止条件

任一事实出现即停止当前刀，不进入安装或真实 workspace：

- 旧 accepted Pass1 artifact/receipt 的 bytes、freshness 或 pending 集合被控制面版本改变；
- V4 ref 在相同 recovery identity 下不稳定，或不同 work unit/attempt/epoch 得到相同 ref；
- 同一 dispatch slot 同时出现两个 live dedicated children；
- stale start 再次返回旧 task session/sink，或 expired token 能成功 stage candidate；
- transport 超限没有 durable terminal，或被错误记为 writer 已启动；
- tool error/final/evidence 泄露 candidate、语义正文、路径、ref、stack 或自由文本；
- source、compiled Sidecar、thin plugin、Agent/skill projection 任一合同不一致；
- 安装态 canary 不能从 durable state 证明 attempt/epoch/artifact 的预期跃迁。

## 4. 切片顺序

### D0 决策、术语与实施合同

状态:本切片实施。

**做**:新增 ADR-0117、本方案、`恢复代际身份` 术语与代码链路索引；明确结果身份/恢复身份分离、V4 前向发行、Root 调度槽、三分支 replay、错误分类、候选超限落账和升级复用门。

**不做**:不改生产代码、测试、Agent/skill、Sidecar、插件 cachebuster、workspace、attempt 或 artifact。

**完成判据**:ADR 编号唯一；RG1-RG8 各有输入、触达、红测、绿测、停止条件；本地链接/标题、关键术语检索与 `git diff --check` 通过。

**回滚**:只撤回 D0 新增文档与本次 `CONTEXT.md`/代码链路条目；无运行状态变化。

### RG1 恢复代际只读投影

状态:本切片已实施。

**做**:从当前 dispatch progress、next work unit、task binding 和 task-store 的 `nextAutomaticBuildExecutionIdentity`/active claim 只读投影 `AutomaticBuildRecoveryGenerationIdentityV1`；同时派生稳定 `dispatch_slot_ref`。投影不 claim lease、不写 attempt、不签发 handoff。

**触达**:

- `packages/core/src/automatic-build-dispatch-runtime.ts`
- `packages/core/src/automatic-build-lease.ts` 或最窄的新导出
- `packages/core/test/automatic-build-dispatch-runtime.test.ts`
- `packages/core/test/automatic-build-lease.test.ts`

**红测**:

1. 无历史 task 得到 `semantic_attempt=1/lease_epoch=1`；
2. epoch 1 active 时投影仍为 epoch 1；推进时钟到过期且无 terminal 后投影为同 attempt/epoch 2；
3. retryable semantic failure 后投影为 attempt 2/epoch 1；
4. 前一 work unit committed 后 current work unit 改变；slot 不变、recovery identity 改变；
5. 只读投影前后 task/dispatch 目录 bytes 与文件集合不变。

**绿测/完成判据**:上述测试转绿；现有 lease epoch、retry exhaustion、policy-scope migration 与 dispatch progress 测试仍绿；Core typecheck 通过。

**不做**:不新增 handoff version，不改 Driver/Root，不读 Agent lifecycle，不增加摘要文件。

**停止条件**:若 current identity 只能通过 claim 才能获得，先把 task-store 的现有纯函数结果窄化导出；不允许 RG1 以预占 lease 代替投影。

### RG2 Public V4 recovery handoff

依赖:RG1。

状态:本切片已实施。

**做**:新增 V4 record/identity validator 与 issuer；新 public dispatch/reissue 写 V4，private artifact 路径保持现状；reader 继续按原算法读取 V3。V4 发行前直接核对传入 recovery identity 与 RG1 当前投影。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `skills/build/automatic-build.ts`
- `skills/build/automatic-build-driver.ts`
- `packages/core/test/automatic-build-executor-session.test.ts`
- `packages/core/test/automatic-build-driver.test.ts` 的 issuer fixture

**红测**:

1. 同一恢复五元组重复发行得到同 ref、同 create-only V4 record；
2. work unit、semantic attempt、lease epoch 任一变化都得到新 ref；
3. `issued_at` 变化不改变 ref；
4. 历史 V3 fixture 仍按旧 identity 验证且原 bytes 不变；
5. 伪造 recovery identity 被 current-state direct compare 拒绝。

**绿测/完成判据**:V4 定向测试、全部 V3/private session 回归与 Core typecheck 通过；没有 V3→V4 rewrite/migration 文件。

**不做**:不改变 generation replay，不改 artifact/task identity，不让 V4 record 成为授权 token。

**停止条件**:若 V4 需要修改已存在 V3 ref/record 才能打开，停止并修 issuer/reader 分流；不得原地更名版本。

### RG3 Driver projection V2 与 Root 调度槽

依赖:RG1-RG2。

状态:本切片已实施。

**做**:把 Driver projection 按完整 recovery identity 持久化；旧 V1 projection 只读识别但不再作为 current ref 返回，当前 durable state 发行 V4/V2 projection。前向演进 `build.step` action，使每个 launch 同时携带 `opaque_handoff_ref + dispatch_slot_ref`。更新 root build skill 的 `live_by_ref` 为 `live_by_slot` 所有权表，child payload 仍只有 ref。

**触达**:

- `skills/build/automatic-build-driver.ts`
- `skills/build/automatic-build.ts`
- `skills/build/SKILL.md`
- `packages/core/test/automatic-build-driver.test.ts`
- `packages/core/test/automatic-build-handoff.test.ts`
- `packages/core/test/codex-executor-agent.test.ts`

**红测**:

1. 现有“expired dispatch reuses same opaque handoff”改为断言 epoch 2 ref 不同、slot 相同；
2. 同 recovery identity 的 fresh invocation 仍 replay 同 ref；
3. 仅存在 V1 projection 时不返回旧 V3 ref，而是从 durable state 写一条 V2 projection；
4. live child 在同一 dispatch 内已推进到下一 work unit，另一 child 先 terminal 触发 step 时，Root 因 slot live 不启动新 ref；
5. 原 child terminal、slot 释放后，当前 work unit ref 恰好启动一次；
6. `completed_refs` 继续排除已启动 recovery ref，其他 dispatch slot 不受影响。

**绿测/完成判据**:Driver/root prompt/parity 定向回归全绿；Root action 不含 dispatch id、work unit、attempt、epoch、路径或语义内容，只含两个 opaque locator；同一 slot 的 live child 数上限为 1。

**不做**:不强制一个 child 只处理一个 work unit，不降低 dispatch bundle，不把 slot ref 传入 dedicated child，不把 child final 当 artifact 完成事实。

**停止条件**:若 slot 去重无法由确定性 helper/prompt fixture锁定，先把“待启动 launch 选择”提取成纯函数供 Root 指令与测试共享；不能只靠新增一句自然语言。

### RG4 `generation.start` currentness 与 replacement session

依赖:RG1-RG3。

状态:本切片已实施。

**做**:把 `existingStart` replay 移到 current dispatch/task/lease 判定之后；验证 generation start record 的 task session、semantic attempt、lease epoch 与 handoff recovery identity。active/current 才 replay；terminal/advanced 返回 candidate-free current action；stale/expired 返回类型化 `stale_generation_session`。新 V4 ref 可在同 owner 的当前 active claim上建立新的 delivery/grant/session/sink，不覆盖旧记录。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/automatic-build-lease.ts`
- `packages/core/test/automatic-build-executor-session.test.ts`
- `packages/core/test/automatic-build-driver.test.ts`

**主红测**:

```text
epoch 1 generation.start
  -> save old task session/sink/start
  -> advance clock past expiry, no terminal
  -> fresh Driver step returns different V4 ref for epoch 2
  -> replacement open/input/start
  -> semantic_attempt == 1, lease_epoch == 2
  -> new task session and sink
  -> submit succeeds
```

补充红测：active epoch 1 重放 byte-identical；旧 epoch 1 ref 在过期后不返回 `GENERATE`；task 已 committed/dispatch advanced 后旧 start 不返回 candidate-bearing action；same-owner active claim 的 replacement V4 session 能提交且旧 sink 不能提交；different owner/run 仍拒绝。

**绿测/完成判据**:组合测试转绿；attempt 目录显示 epoch 1 历史只读、epoch 2 新 execution/lease/start/session/sink、最终一个 accepted result/receipt；没有 semantic attempt 2；Core typecheck 通过。

**不做**:不覆盖旧 start/session/sink，不把 lease epoch 放进 task scope/artifact，不用随机 ref 避免碰撞。

**停止条件**:如果同一 old grant 的 create-only start 仍能吸回旧 response，说明新恢复路径没有获得独立 delivery/grant identity；停止修局部 replay，回到 RG2 identity 链检查。

### RG5 MCP 错误与 Executor lifecycle 分账

依赖:RG4 提供结构化 session 错误。

状态:本切片已实施。

**做**:定义 allowlisted Core/MCP tool error；`build-executor-mcp.ts` 按结构化类型输出 v2 有界错误，未知异常为 `internal/executor_internal`，不解析 message。更新 canonical Agent、project Agent、executor fallback skill 与发布副本，使 tool absence/startup failure 返回 `bootstrap_unavailable`，已收到 MCP v2 error 则保留其 category/code/status。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts` 或窄错误合同模块
- `skills/build/build-executor-mcp.ts`
- `agents/automatic-build-dispatch-executor.md`
- `.codex/agents/understand-book-executor.toml`
- `skills/executor/SKILL.md` 及正式发布投影
- `packages/core/test/build-executor-mcp.test.ts`
- `packages/core/test/codex-executor-agent.test.ts`
- `apps/desktop/scripts/smoke-t7-executor-release.ts`

**红测**:

| 注入失败 | 期望 |
|---|---|
| request version/schema 不兼容 | `bootstrap/protocol_incompatible` 仅限调用前合同 |
| stale start | `session/stale_generation_session/generation_start` |
| expired lease submit | `session/lease_expired/candidate_submit` |
| sink mismatch/unavailable | `candidate_sink/candidate_sink_unavailable/candidate_submit` |
| 未知内部异常 | `internal/executor_internal/<current phase>` |
| tool 完全不存在、零 backend call | child lifecycle `bootstrap/bootstrap_unavailable` |

**绿测/完成判据**:每类错误 JSON byte-bounded；candidate/path/ref/stack/message sentinel 零命中；M1/M1b timing 仍记录 `bounded_error` 和正确 operation/phase，不把有界错误算成功；source/Agent/release parity 通过。

**不做**:不提高 `.mcp.json` startup timeout，不把时长推断写成事实，不向用户暴露原异常。

**停止条件**:若某错误没有足够结构化事实分类，归 `internal`；禁止恢复 message regex 分类。

### RG6 Candidate transport 正式合同与超限落账

依赖:RG5。

状态:本切片已实施。

**做**:前向升级 public/private output contract，并加入 candidate value 与 serialized request token/byte预算；入口先解析固定 session/sink 字段，再量完整 canonical request。可归属 task 的超限写类型化、`writer_started=false` 的可重试失败并返回 candidate-free terminal；不可归属请求只返回 MCP v2 error。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/executor-transport.ts`
- `packages/core/src/automatic-build-mailbox.ts`
- `packages/core/src/automatic-build-task-store.ts`
- `packages/core/test/automatic-build-executor-session.test.ts`
- `packages/core/test/automatic-build-mailbox.test.ts`
- `packages/core/test/executor-transport.test.ts`
- Agent/contract parity tests

**红测**:

1. output contract 同时公开 value/request 四个预算，candidate 可用预算扣除固定 envelope reserve；
2. unit 84 同形请求在 active lease 下超过 2,048 estimated tokens，写出 failure/metrics/result/receipt，且无 candidate/submission/artifact；
3. failure 为 `transport/candidate_request_too_large/generation`、`writer_started=false`，下一 recovery identity 为 semantic attempt 2/epoch 1；
4. byte 超限走同一路径；恰好边界通过；
5. 无效/伪造 session ref 的大请求不写任何 task；
6. private artifact task 同样得到有界 retryable terminal，不泄露 candidate；
7. 已提交 Pass1 artifacts 不因 output transport contract 前向版本而失效。

**绿测/完成判据**:超限不再从 validator 裸抛后零状态；Driver 下一步可生成新 attempt；现有 Schema/evidence/writer tests 仍绿；`max_candidate_request_tokens=2_048` 与 byte 常量本刀不变；Core typecheck 通过。

**不做**:不提高预算，不把 transport contract 写入 Pass1 policy generation/semantic contract，不持久化被拒 candidate。

**停止条件**:如果落账必须先写 candidate 或伪造 writer-start，则停止；应新增明确的 pre-writer generation failure入口，而不是穿过 candidate staging。

### RG7 升级复用组合回归

依赖:RG1-RG6。

状态:本切片已实施。

**做**:建立 A/B/C 三单元 Pass1 fixture，先用旧控制记录成功提交 A/B，再让 C 停在 epoch 1 generation start；保留同一 workspace 和全部 durable state，清空只允许清空测试进程易失 registry，加载新 Driver/Executor 后恢复 C。测试直接锁定 A/B bytes 与 pending 集合。

**触达**:

- `packages/core/test/automatic-build-driver.test.ts` 或独立 `automatic-build-upgrade-recovery.test.ts`
- `packages/core/test/build-orchestrator.test.ts`
- 复用现有 fixture helpers，不新增生产迁移代码

**红测/绿测轨迹**:

1. 基线旧路径稳定重放 C 的 epoch 1 session/sink并失败；
2. RG1-RG6 后，fresh snapshot 中 A/B 不在 pending，artifact/receipt bytes 与原值相等；
3. C 的 V4 ref 不等于旧 V3 ref，slot 相同；
4. C 以 semantic attempt 1/lease epoch 2、新 session/sink提交；
5. 最终 Pass1 closed，A/B 没有新 attempt，C 只有一个 accepted artifact；
6. 全程没有 `protocol_incompatible`。

**完成判据**:组合测试独立 clean exit；测试前后文件差异只包含 C 的新 recovery/control记录和最终 accepted结果；不要求真实旧插件二进制作为 test fixture，V3 durable records 已足够表达升级边界。

**不做**:不清理 workspace，不重写 V3，不用 plan id/plugin version 放宽 freshness，不新建 checksum sidecar。

**停止条件**:若 A/B 被 pending，先定位究竟是 semantic identity 真漂移还是恢复字段误入 freshness；不允许在测试里把 A/B 手动标 completed 掩盖。

### RG8 编译发布、安装态 canary 与真实续跑门

依赖:RG1-RG7 全绿。

**做**:同步 source/compiled Sidecar/thin-plugin/Agent/build skill/launcher，更新 cachebuster；用隔离 workspace 跑安装态 canary，再对真实 workspace 先只读 snapshot，确认已完成 Pass1 集合与待恢复单元，最后才允许一次受控 `build.step`/Executor wave。更新架构、代码链路、ADR 状态和 checkpoint。

**不做**:不以真实书作为首个回归，不删除旧控制记录，不全量重跑 Pass1，不因四次零调用样本调整 startup timeout。

**触达**:

- Desktop Build Engine 编译与现有 parity/release scripts
- published thin plugin 与 marketplace cachebuster
- `apps/desktop/scripts/smoke-t7-executor-release.ts`
- `apps/desktop/scripts/smoke-t7-codex-cli-release.ts`
- `docs/架构.md`
- `docs/代码链路.md`
- `SESSION_CHECKPOINT.md`
- ADR-0117/本方案实施回执

**安装态 canary**:

```text
commit A/B
  -> C generation.start epoch 1
  -> terminate dedicated child without lifecycle final
  -> wait/reenter through build.step
  -> receive C current V4 recovery ref exactly once
  -> C submit committed
  -> A/B bytes unchanged
  -> no root Executor call, no semantic body in root/final/evidence
```

另跑一个 candidate request oversize canary，只保存 code/phase/attempt/epoch/count，不保存 payload。零 MCP call bootstrap 只验证 lifecycle 分类；除非能采到明确 startup failure，不改 timeout。

**红测/绿测**:同一安装态 canary 在旧 V3/catch-all 路径必须稳定表现为旧 ref/session replay 或统一 `protocol_incompatible`；切换到 RG1-RG7 构建后，同一 fixture 必须得到新 recovery ref、正确 attempt/epoch、durable commit/typed failure 和零敏感投影。红证据只保留有界状态与计数，不保存语义正文。

**真实 workspace 门**:

1. 新插件第一次只读 snapshot 必须继续把已有 fresh Pass1 work units 判 completed；
2. unit 41 同形未完成任务必须获得新 recovery ref/epoch，不得得到旧 session/sink；
3. unit 84 同形超限必须形成 durable retryable failure和下一生成动作；
4. 每个已完成 unit 不产生新 attempt；
5. Root 同一 dispatch slot 同时最多一个 child；
6. 一旦复用集合缩小、旧 ref 重现或错误退化为总 `protocol_incompatible`，立即停止，不继续 wave。

**完成判据**:Core 定向/全量相关测试、typecheck、Build Engine compile、source/compiled/thin-plugin parity、installed exact-four/Agent projection/canary 全绿；真实 workspace 只在上述门通过后继续 pending units；文档指向实际版本和证据。

**停止条件**:安装态任一投影不一致、canary 仍返回旧 ref/session、复用集合缩小、slot 出现双 live 或错误重新塌缩为总 `protocol_incompatible`，都停止发布和真实续跑，回到对应 RG 修复。

**回滚**:canary 前可撤回未发布代码。V4 控制记录进入真实 workspace 后不承诺旧插件能继续解释它们；此后采用向前修复。accepted artifacts/receipts 仍按既有语义身份可由修复后的新版本复用，禁止为回滚删除 workspace。

## 5. 依赖图与提交边界

```text
D0
  -> RG1 recovery projection
      -> RG2 V4 handoff
          -> RG3 Driver projection + Root slot
              -> RG4 generation replay/replacement
                  -> RG5 typed errors/lifecycle
                      -> RG6 candidate transport durable failure
                          -> RG7 upgrade reuse regression
                              -> RG8 release + canary + guarded real resume
```

每个 RG 独立 commit-ready，只含本刀生产代码、红绿测试和一条代码链路；不得把无关重构、性能优化、startup timeout、真实 workspace 清理或新 transport 数值夹入。RG2-RG4 在全部完成前不得发布；它们是一个跨层恢复闭环的分段实现，不代表中间提交已经允许真实续跑。

## 6. 验证矩阵

| 合同 | 最小确定性证明 | 所属切片 |
|---|---|---|
| 当前 recovery identity 可只读获得 | epoch 1 active/expired、semantic retry、work-unit advance fixture | RG1 |
| V3 不变、V4 稳定换代 | same tuple replay + one-field changes + V3 byte preservation | RG2 |
| Root 不重复启动 live dispatch | 两 dispatch first-terminal + live child跨unit fixture | RG3 |
| stale start 不再返回旧 GENERATE | epoch 1 start→expiry→old replay test | RG4 |
| lease recovery 不消耗 semantic retry | epoch 1→2，semantic attempt 保持 1 | RG4/RG7 |
| 错误不再伪装 bootstrap | allowlisted operation×failure table | RG5 |
| 超限改变 durable state | no candidate/submission，failure/result/receipt present | RG6 |
| 已提交 Pass1 原样复用 | A/B direct bytes + pending/attempt set comparison | RG7 |
| 安装态投影一致 | source/compiled/thin-plugin/Agent/skill parity | RG8 |
| 真实恢复可继续 | current ref/epoch/receipt/artifact 与 root slot evidence | RG8 |

建议的定向命令形状由实施时按仓库现有 Vitest 分组补入每条代码链路；不在 D0 预跑那些尚不能检测新失败的现有绿测试。每次实际检查都必须能回答：失败会阻止哪一切片继续，或会让实现者回改哪个明确合同。

## 7. 明确排除

- 不通过增加重试次数、清空 registry/workspace 或重做 Pass1 掩盖 stale identity；
- 不把 wall clock、random nonce、plugin version 或 plan id 加进 artifact/recovery ref；
- 不重写 V3 record，不建永久 V3/V4 双写层；
- 不把 lease epoch 加入 task binding、attempt scope、policy generation 或 semantic artifact path；
- 不把 candidate transport limit 伪装成模型语义合同；
- 不在没有 MCP startup 原生证据时把 10 秒改大；
- 不用 child final 代替 durable artifact/receipt；
- 不为罕见编码、符号链接竞态、额外攻击者或理论时间竞态增加脚手架。

## 8. 已知限制

- 四次零 MCP call 目前只能定位为 bootstrap/tool availability 类，不能区分 server startup、宿主注入或 interaction-mode failure；RG5 只修分类，不声称找到其唯一根因。
- `dispatch_slot_ref` 防止 Root 在受支持编排中重复启动同一 dispatch；它不是 server 侧 caller-role 鉴权，ADR-0115 的 `caller_role_authenticated=false` 不变。
- RG8 的真实 workspace 续跑验证只证明当前单机、当前支持宿主和该 durable state；不引入跨机迁移或多用户兼容承诺。
- V4 一旦写入真实控制面，旧插件的向后解释能力不成立；数据面 accepted artifacts 仍可复用，控制面采用 roll-forward。
