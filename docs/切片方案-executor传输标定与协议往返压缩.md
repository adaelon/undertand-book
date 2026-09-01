# Executor 传输标定与协议往返压缩切片方案

日期:2026-09-01。
冻结决策:[ADR-0116](adr/0116-calibrated-executor-transport-budget-and-round-trip-reduction.md)。
承接边界:[ADR-0114](adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md)、[ADR-0115](adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md)。

本方案把 P0→P1→P2→P3 拆成独立实验。D0 只落文档；后续每刀单独实施、验证和决定是否继续。本轮不修改运行代码，不执行真实书，不改变候选格式、Schema/evidence/quality/writer 门禁、reader-private 边界、Session V3 durable state 或当前 transport 常量。

## 0. 对齐确认单

**FrozenIntent**:先判清 `2,048 estimated tokens / 8,192 bytes` 的性质，再按“内外计时 → 宿主容量标定 → 输入领取合并 → frozen input 复用 → 调度利用率”逐刀实验。每刀必须能独立判断正确性与时延，不以减少调用次数代替最终产物质量。本轮只落 ADR 和实施切片，不直接改协议或跑真实构建。

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| `semantic attempt` | EXISTING | 只有 `generation.start` 被代码接受才创建；delivery 与 receipt 重放不消耗尝试 |
| Executor 调度执行包 | EXISTING | 一个 executor session 可顺序完成多个 work units；session 数不等于语义任务数 |
| 共享 Executor MCP 注册 | EXISTING | 继续复用现有 exact-four 工具表面与正常路径专用 child 行为合同 |
| 本地响应预算 | NEW/实现级 | `CODEX_EXECUTOR_TRANSPORT_PROFILE_V2` 当前自设的 2,048-token/8,192-byte admission limit，不是领域对象或官方宿主合同 |
| 宿主容量标定 | NEW/实现级 | 在受支持 Codex 路径上用无语义 synthetic payload 测出离散通过/失败档位；不寻找无限理论最大值 |
| 有界输入领取 | BOUNDARY_CHANGE | 不改变 frozen input、ordinal、receipt、replay 与 attempt 边界，只减少模型可见 turn 或 MCP 调用数 |

**RiskReceipt**:P1 会触及 Executor 工具编排，P2 会触及 frozen-input 与 lease-start 边界；用户在看到这些风险与 P0→P3 顺序后明确要求“针对这些 P，落 ADR 和切片方案来做尝试”，并再次要求继续。

**ChangeType**:`[边界重构]`。领域术语全部已解析；两个新增词只描述实现测量，不写入已有脏改动的 `CONTEXT.md`。

领域对齐完成。

## 1. 2,048 的判断

### 1.1 已证实来源

- `packages/core/src/executor-transport.ts` 把 `max_tool_result_tokens=2_048`、`max_tool_result_bytes=8_192` 写入本地 V2 profile；同一组值最初由提交 `4cc345f` 引入。
- ADR-0114 当时把它定义为“保守设计目标”，并写明应由 synthetic carrier probe 冻结。
- 当前单元测试证明 packer、response envelope 和 session 会遵守这组自设常量；它们没有让 Codex 宿主尝试 4K/8K/16K-token 结果，因此不能证明宿主阈值。
- compiled release evidence 证明 4 个 chunk、单次最多 8,192 bytes 的路径成功；它只给出下界 `host accepts 8 KiB`。
- 原事故证明 317,247-byte 单次 `executor.open` 结果在候选、Schema、evidence 与 writer 前失败；它只给出上界 `host does not reliably deliver 317 KiB`。
- 公开 OpenAI MCP 文档没有声明 2,048-token 单次工具结果上限。官方 Programmatic Tool Calling 指南把“无需逐步模型判断的有界工具密集流程”列为适用形状，并要求在代表性任务上同时比较成功、完整性、tokens、延迟与成本。

因此，`2,048` 不是被发现的宿主硬上限，而是一次正确止血中选择的保守本地预算。

### 1.2 它原本解决什么

| 作用 | 是否应保留 | 当前问题 |
|---|---|---|
| 在 stdout 前拒绝超大结果，避免静默截断 | 保留 | 上限数值没有标定 |
| 让 planner 预先证明 input 可交付 | 保留 | carrier 容量与模型 token 预算混在同一 profile |
| 给 envelope 元数据留空间 | 保留 | reserve 应从真实 serialized response 计算，不需要神化 2,048 |
| 控制单次进入 child context 的 token 数 | 保留为模型预算 | 不应冒充 MCP transport 合同 |
| 强制每 2K tokens 一次 MCP/模型 turn | 不保留 | 这是当前主要延迟放大器之一，不是正确性不变量 |

它不提供隐私、授权、完整性或 caller-role 隔离；这些仍由 Session V3 的 ref、phase、ordinal、grant、sink、Schema/evidence 和共享 MCP 行为边界承担。

### 1.3 三类预算必须分开

```ts
interface ExecutorCarrierCapacityV1 {
  version: "executor_carrier_capacity.v1";
  direct_result_max_tested_bytes: number;
  program_output_max_tested_bytes: number;
}

interface ExecutorModelVisibleBudgetV1 {
  max_visible_input_tokens: number;
  output_reserve_tokens: number;
  safety_margin_tokens: number;
}

interface ExecutorDeliveryBatchLimitV1 {
  max_chunks_per_batch: number;
  max_serialized_batch_bytes: number;
  max_batches_per_work_unit: number;
}
```

- Carrier capacity 回答“完整 serialized result 能否穿过受支持宿主”，以精确 byte length、尾哨兵和错误结果判定。
- Model-visible budget 回答“模型上下文是否容纳完整 prompt/input/output”，继续使用 token 预算；若 estimator 不精确，保守性属于模型预算，不伪装成 carrier 事实。
- Batch limit 回答“一次协议动作最多推进多少确定性状态”，同时受前两者约束。
- `max_candidate_request_tokens/bytes` 是模型到工具的请求边界，不随 response 标定自动放宽；它需要自己的候选合同数据再单独决定。
- 不新增 profile digest、宿主指纹或自动迁移层；显式 version 与直接字段比较足够。前 1.0 合同变化继续走 ADR-0115 的前向接管。

### 1.4 当前生产处置

在 M2 完成前：

```text
max_tool_result_tokens = 2_048   // current conservative baseline
max_tool_result_bytes  = 8_192   // current proven passing tier
status                 = local profile, not host hard limit
```

本方案不靠文档判断直接提高生产值。原因不是 2,048 已被证明正确，而是放宽行为必须先有同 carrier 的完整性证据。

## 2. 基线与共同验收

### 2.1 已有性能基线

| 指标 | 当前观测 |
|---|---:|
| 成功 Executor | 8 |
| 完成 semantic candidates | 32 |
| 成功 Executor 活跃时间 | 120.45 agent-min |
| 工具调用时间 | 58.05 min / 48.2% |
| generation.start→submit 语义窗口 | 33.50 min / 27.8% |
| 工具结果后机械协议步进 | 26.65 min / 22.1% |
| 启动与收尾 | 2.25 min / 1.9% |
| `input.next` | 107 calls，13.6 s/call，24.19 min |
| `generation.start` | 32 calls，22.4 s/call，11.92 min |
| `submit_candidate` | 32 calls，28.7 s/call，15.30 min |

这些数字用于选择实验方向，不作为固定性能承诺。新的 A/B 必须用同一批 synthetic work units 重新采样，不能把不同阶段或不同语义产物直接相除。

### 2.2 固定 A/B fixture

建立四个无私人内容的 synthetic work units，分别在当前 profile 下产生 2、3、4、5 个 input chunks；每个 unit 使用固定 output contract、确定性 candidate fixture、同一 writer stub/真实 deterministic writer 路径和独立临时 registry。所有方案都跑同一组次序与重复次数。

每次实验必须同时保留：

- 完整交付 byte length、ordinal/range 连续性、frozen input identity 与 final receipt；
- generation.start 前后 semantic attempt `0 → 1` 的唯一跃迁；
- candidate Schema、evidence、quality、writer 与 durable receipt 结果；
- child/root 隐私 trace 的既有允许/禁止位置；
- operation/server/outer elapsed、response bytes、MCP calls、model-visible turns、总 tokens 与墙钟。

确定性 fixture 要求 candidate 与 writer artifact byte-identical；真实模型抽样只要求同一质量门通过与义务完整，不要求随机生成文本逐字相等。

### 2.3 全局停止条件

任一实验出现下列事实就停止该刀，不推进下一刀：

- 交付字节缺失、重复、乱序或尾哨兵不一致；
- response 丢失/replay 产生新 attempt、重复 candidate 或重复 writer；
- root、其他 child、child final、stderr metric 或公开 evidence 出现语义正文/candidate；
- Schema、evidence、quality、writer 或 durable completion 相对基线退化；
- 计时样本无法按 dedicated child、operation、connection ordinal 一一对应。

## 3. 切片顺序

### D0 决策与实验合同

状态:本切片实施。

**做**:新增 ADR-0116、本方案，并给 ADR-0114 与旧切片方案加修订指针，把 2,048 从“宿主硬闸”纠正为“当前本地基线”。

**不做**:不改代码、测试、profile、Session V3、Agent 模板、插件、构建 workspace 或真实书。

**完成判据**:ADR 编号唯一；P0-P3 均有独立输入、产出、正确性判据与停止条件；本地链接、标题锚、`git diff --check` 通过。

**回滚**:删除 ADR-0116/本方案并撤回两条修订指针；无运行状态变化。

### M1 MCP 内外层计时

映射:P0。

**做**:在真实 `tools/call` handler 内记录无语义 server sample，并从现有 Codex reduced trace 读取对应 outer sample；同一批 fixture 计算每种 operation 的 server total 与 `outer - server` residual。

建议记录：

```ts
interface ExecutorMcpServerTimingV1 {
  version: "executor_mcp_server_timing.v1";
  connection_call_ordinal: number;
  operation: "executor.open" | "executor.input.next"
    | "executor.generation.start" | "executor.submit_candidate";
  server_elapsed_ms: number;
  response_bytes: number;
  response_action_kind: string | null;
  outcome: "ok" | "bounded_error";
}

interface ExecutorOuterTimingV1 {
  thread_id: string;
  connection_call_ordinal: number;
  operation: ExecutorMcpServerTimingV1["operation"];
  outer_tool_call_elapsed_ms: number;
}
```

`server_elapsed_ms` 从进入合法 `tools/call` 分支开始，到完整 JSON-RPC response 序列化完成为止；`response_bytes` 量实际返回行，不量内部 session object。Metric 不含 ref、路径、payload、candidate、错误自由文本或 hash。

**触达**:

- `skills/build/build-executor-mcp.ts`
- `apps/desktop/scripts/r7-rollout-trace.ts`，或新增只读 performance reducer
- `packages/core/test/build-executor-mcp.test.ts`
- 对应 trace reducer 测试与 release evidence schema

**验证**:

1. injected clock 证明 elapsed 边界准确，成功与 bounded error 均产生一条 sample。
2. 实际 serialized response byte length 与 sample 相等。
3. 并发三个 child 时，各自 ordinal 从 1 单调递增；reducer 不跨 child join。
4. outer/server 一一对应且 residual 不为负；长调用后的 wait 归入同一 outer operation，不重复计数。
5. 序列化全部 metrics 后，semantic sentinel、candidate sentinel、ref 和绝对路径均零命中。

**判定**:直接比较 server total 与 residual total，先优化更大的已观测部分；两者接近时分别保留 M1b 与 A1 两个独立 A/B，不用预设评分阈值代替判断。

**不做**:不改 action、profile、输入 chunk、candidate、writer 或调度。

**完成回执（2026-09-01）**:实现完成。`build-executor-mcp.ts` 对每个 thread-owned stdio connection 单独维护 call ordinal，在合法 exact-four `tools/call` 的完整 JSON-RPC 行序列化后写一条 stderr timing sample；成功和 bounded error 共享同一边界，sample 只含 operation、elapsed、response bytes、action kind 与 outcome。`r7-rollout-trace.ts` 从 trace bundle 的原始 start/end wall time 生成 outer sample，并由只读 reducer 按 `thread_id + connection_call_ordinal` 一一归并，拒绝跨 child、operation 漂移、缺失/重复样本与负 residual。确定性六调用 fixture 得到 server total `102 ms`、outer total `288 ms`、residual total `186 ms`；这些注入值只验证边界与算术，不作为 M1b/A1 性能分支证据。分支选择仍须用编译后同批 fixed A/B trace 的真实样本，不能拿测试时钟替代。

**真实标定回执（2026-09-01）**:编译后的 383-module Sidecar 已通过 source/compiled/thin-plugin parity，并由 Codex CLI `0.149.0` 的隔离 `--m1-only` single synthetic fixture 产生 1 条 thread-owned connection、9 个可一一归并的调用。总计 server `4,753.642 ms`、outer `4,996 ms`、residual `242.358 ms`；逐 operation 均为 server 大于 residual，完整 totals 落到 `docs/performance/understand-book-m1-fixed-codex-timing.json`。因此 M1 选择 **M1b**，不进入 A1；该判断只比较同批真实样本，不使用注入时钟、调用数比例或预设评分阈值。既有 parallel R7 调度门仍独立保留，不作为 single M1 timing join 的必要条件。

### M1b 服务端阶段归因

进入条件:M1 显示 server time 是主要部分，或 `generation.start`/`submit_candidate` 内部占时仍无法指导下一刀。

**做**:只给两个长 operation 增加互斥阶段计时：

```text
generation.start = current-state/claim + input-render-or-reuse + persist/response
submit_candidate = candidate-gate + writer/commit + next-work-prepare
```

每次 operation 的阶段和必须等于 server elapsed 的同一计时区间；不采集函数名堆栈或语义内容。

**完成判据**:固定 fixture 的每次长调用都能被完整归入上述阶段；出现的最大阶段直接选择 A2、R1 或 writer 专项，不先拆 submit 接口。

**停止条件**:阶段和无法与 operation total 对齐时，修计时边界，不依据残缺样本改代码。

### M2 宿主容量标定

映射:P0.5，必须先于任何 batch response 设计。

**做**:在隔离 `CODEX_HOME`、仓外 cwd 和 test-only synthetic MCP server 上，沿与 Executor 相同的 stdio MCP + Codex 路径测试完整 serialized result。探针只运行离散档位 `8/16/32/64 KiB`，在第一次失败后停止更大档位；64 KiB 全部通过也停止，不继续寻找理论最大值。

每个 byte 档位测试两种项目真实可达的内容形状：ASCII-heavy JSON 与 CJK-heavy JSON。每个 payload 都带固定长度、首尾哨兵和结构闭合；reduced trace/analyzer 直接验证原始 result 的 byte length 与尾哨兵，dedicated test child 还必须把只存在于 result 尾部的哨兵与精确长度提交给 test-only ack 工具。通过要求 raw result 完整与模型侧 ack 同时成立，不让模型自评“看起来完整”。

分别测：

1. direct MCP result → dedicated child model-visible context；
2. `functions.exec` 程序内部领取若干 MCP result → compact program output；
3. 同一档位的超时、error 与截断表现，记录是宿主拒绝、trace 截断还是模型上下文不可达。

**触达**:

- 新增 `apps/desktop/scripts/smoke-executor-carrier-capacity.ts`
- 对应 deterministic analyzer/test
- `apps/desktop/package.json` 的显式诊断脚本入口
- `docs/performance/` 下不含 payload 的容量证据

**产出**:

```json
{
  "version": "executor_carrier_capacity_evidence.v1",
  "host_release": "<observed release>",
  "direct_result": { "max_tested_passing_bytes": 0, "first_failed_bytes": null },
  "program_output": { "max_tested_passing_bytes": 0, "first_failed_bytes": null }
}
```

证据不保存 payload、摘要或指纹；档位、精确结果长度、尾哨兵是否完整和宿主 release 足以改变下一步。

**判定**:

- 若 8 KiB 以上无一档通过，生产 profile 不变，A1 只能减少模型 turns，A2 batch 不进入。
- 若更高档位完整通过，以“不超过最大已通过档位”为 batch response 边界；该值仍称 tested passing tier，不称宿主绝对上限。
- 若 direct 与 program output 不同，分别保留两个预算，不取一个假装通用的数字。
- Token estimator 继续服务模型上下文；不再用 2,048 estimated tokens 声称 carrier ceiling。

**不做**:不在生产 Executor 增加 probe 工具，不调用真实 handoff，不自动改用户配置，不运行无限二分搜索。

### A1 程序化领取 A/B

映射:P1 低风险实验。

**做**:不改 Session V3 或四个 MCP 工具；只为实验 Executor 指令允许一个有界 `functions.exec` 程序循环调用现有 `executor.input.next`，直到拿到 `GENERATION_GRANT`，再向 child 模型返回按序拼接的完整 prompt/input 与 grant 控制字段。

程序边界：

```text
allowed tool       = executor.input.next only
max calls          = delivery manifest total_chunk_count + 1
stop               = GENERATION_GRANT | bounded failure | call bound
program output     = ordered prompt + input + exact grant fields
direct calls remain= executor.open, generation.start, submit_candidate
```

中间 chunk envelope 只在 program runtime 存活；program output 仍属于同一 dedicated child context，不进入 root。程序不得总结、过滤或改写 semantic bytes。

**触达**:

- canonical Executor instruction source及其已生成/发布副本
- Agent/template parity tests
- installed Codex synthetic A/B smoke

**完成判据**:

- MCP `input.next` 调用数与基线相同；模型可见 delivery turns 从 `chunks + grant` 降为 1。
- 拼接 bytes、attempt、candidate、writer、privacy 与 durable receipt 全部等于基线合同。
- 使用 M1 同批 fixture 比较 protocol-decision gap、outer elapsed、tokens 与总墙钟。

**停止条件**:program output 超过 M2 passing tier、任一 chunk 不可在模型生成前完整恢复，或官方/当前 Codex runtime 不允许该 MCP 工具作为 program caller。

**去留**:只有总墙钟或模型步进成本实际下降且正确性不变才保留；“turn 数更少”本身不算成功。

### A2 有界 batch 与 final-ack start

映射:P1 真正减少 MCP 次数；只有 M2 支持 batch 且 M1/A1 表明 per-call 成本仍显著时进入。

**做**:保持 exact-four 工具表面，前向演进 `executor.input.next` 和 `executor.generation.start`：

```text
executor.input.next.v4(ack_through_ordinal?)
  -> INPUT_BATCH(chunks[contiguous], serialized <= batch budget)
  -> replay same request returns same batch

executor.generation.start.v3(
  generation_input_ref,
  confirmed_through_ordinal = final ordinal
)
  -> code confirms final batch
  -> issues/accepts internal grant
  -> atomically creates or replays attempt N
  -> GENERATE
```

非 final batch 由下一次 `input.next` 的 `ack_through_ordinal` 确认；只有模型已收到 final batch 后才能调用 start。Response 丢失时，未确认 batch 可原样 replay；start response 丢失时仍恢复同一 attempt。

**为什么不新增 `input.drain` 工具**:当前共享 MCP、Agent 模板、release trace 和 exact-four inventory 已围绕四工具闭合；同一 input operation 的批量响应不需要扩大能力表面。

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/build-executor-tool-adapter.ts`
- `packages/core/src/executor-transport.ts`
- `skills/build/build-executor-mcp.ts`
- Executor instructions、plugin assets、compiled release smoke
- session/adapter/transport/replay/privacy tests

**红绿用例**:

1. 2/3/4/5-chunk fixture 在 passing tier 内分别形成最少连续 batches，无缺口无重复。
2. exact batch 边界通过，多 1 byte 进入下一 batch，不截断 payload。
3. 同一未确认请求 replay 返回 byte-identical batch。
4. ack 越界、倒退、跨 session、跨 input 全部失败关闭且 attempt=0。
5. final batch 之前调用 start 被拒绝；final ack + start 首次接受只创建 attempt 1。
6. start 请求/响应丢失、并发 replay 仍指向同一 sink/attempt。
7. M2 passing tier 降低时，packer 产生更多 batch 而不是越过结果边界。
8. 既有 candidate、writer、privacy、root-zero-call 与 durable completion 门全绿。

**完成判据**:同一 fixture 的 input MCP calls 从 `chunks + 1 grant` 降为 `batches`，另有一次原本就需要的 generation.start；总墙钟、server time 和 outer time均实测下降。

**不做**:不把 input 与 candidate 合并，不让 start 接收正文，不删除 frozen record、ordinal、receipt 或 attempt 两阶段语义。

### R1 Public frozen input 复用

映射:P2 第一刀；只改 public dispatch。

**做**:把 `runAutomaticBuildTaskInput()` 中“启动 lease、再次 render、记录 observation”拆开。open/next-work prepare 仍通过 stage input script 渲染一次并持久化 frozen input；generation.start claim lease 后，直接读取该记录、重验 current control identity 与现有 input binding，并按冻结字节登记 observation。

目标控制流：

```text
open/prepare:
  current task + binding validate
  render stage input once
  persist frozen bytes + existing identity fields

generation.start:
  validate current handoff/owner/dispatch/work-unit/policy
  claim/start lease
  read frozen bytes
  direct-compare input ref, byte length and existing input binding
  record observation from frozen bytes
  do not spawn stage input renderer
```

**触达**:

- `packages/core/src/automatic-build-executor-session.ts`
- `skills/build/automatic-build.ts`
- `packages/core/src/automatic-build-metrics.ts`
- public delivery/generation/session/lease tests

**先红用例**:

1. public work unit 从 open 到 start 的 renderer invocation count 当前为 2，目标为 1。
2. source/plan/owner/policy/work-unit 在 open 后失效时，start 仍失败关闭且不创建 attempt。
3. frozen record byte length、input ref 或既有 binding 不匹配时，start 失败且 writer 未启动。
4. 代码/renderer 版本在 delivery 后变化时，当前 attempt 使用模型实际收到的 frozen bytes；新计划才使用新 renderer。
5. observation 的 input bytes/identity 与 delivered bytes 相等，M1 generation.start renderer phase 归零。

**完成判据**:renderer 2→1；generation.start server time 下降；同一 deterministic candidate 的 writer artifact、quality result 与 durable receipt 等于基线。

**停止条件**:发现受支持状态变化只能依赖第二次 renderer 才能检测，且不能由 current task/binding 直接表达；先补真实所有者校验，不用重复子进程兜底。

### R2 Private frozen input 复用

映射:P2 第二刀；R1 全绿后才进入。

**做**:把同一单渲染合同扩到 intent artifact/private delivery；不与 public 刀混改，避免一个失败无法归因。

**验证**:private task identity、schema、candidate sink、replay、attempt 与 artifact commit 的既有测试加 renderer invocation count；其余判据与 R1 相同。

**不做**:不统一 public/private 领域模型，不抽象新兼容层；只复用已由两条路径共同需要的最小 frozen-input helper。

### W1 Submit 主导段专项

映射:P2 后的条件切片，不预设修法。

进入条件:M1b 显示 `submit_candidate` 在 P1/P2 后仍是最大 server operation。

**分支**:

- candidate gate 主导:只优化重复 parse/validation，保持一次 canonical serialization 与现有门禁。
- writer/commit 主导:对具体 stage writer 做独立性能切片；DONE 仍等待 durable commit。
- next-work prepare 主导:评估 submit 返回后再 prepare、受控预取或 bundle 重排；只有总调用/总墙钟下降才采用，不以更快返回一个中间响应冒充完成。

每个分支必须重新声明 A1 切片；本方案不提前授权后台 writer、额外 MCP turn 或整阶段预渲染。

### S1 剩余工作与槽位事实

映射:P3 第一刀。

**做**:从 durable task/dispatch 状态公开无语义聚合：

```ts
interface AutomaticBuildRemainingWorkV1 {
  stage: string;
  kind: string;
  pending: number;
  reserved: number;
  running: number;
  terminal: number;
}

interface ExecutorSlotObservationV1 {
  live_slots: number;
  idle_slots: number;
  idle_reason: "no_ready_work" | "root_refill_gap" | "stage_barrier" | "tail_imbalance";
  observed_ms: number;
}
```

计数直接来自当前 durable records，不计算整本 ETA，不保存正文，不增加 hash。`idle_reason` 由可观察状态判定：有 ready work 且 slot 空闲才是 refill gap；无 ready work但前阶段未终态是 barrier；同 wave 只剩少数长 bundle 是 tail imbalance。

**完成判据**:各 kind 计数之和与 task truth 对齐；slot 时间与 agent lifecycle trace 对齐；32 candidates 不再被报告成 8 semantic work units。

**不做**:不改并发数、bundle size、agent 生命周期或阶段 barrier。

### S2 调度利用率实验

映射:P3 第二刀；S1 后只选择一个最大已观测来源。

**分支**:

- `root_refill_gap`:缩短 durable reread→补发 handoff 的同步空窗，保持一个 child 一个 opaque ref。
- `tail_imbalance`:按当前阶段可观察 work-unit 数把末波 bundle 均匀分配，不跨 stage、不把多个输入合成一次模型判断。
- `stage_barrier`:只在依赖合同允许时缩短收口；不能为利用率删除 Pass1→后续阶段的真实数据依赖。
- `no_ready_work`:不创建长期 worker；空闲是正确状态。

只有在 P1/P2 后 agent startup/refill 成为最大的可避免成本，才另立“长期 worker”ADR；当前 1.9% 启动/收尾证据不足以支持扩大 child 生命周期。

**完成判据**:同一 synthetic stage topology 的 idle cause 对应时间下降，semantic attempt、work-unit 数、candidate 质量和 stage barrier 不变。

## 4. 实施判定树

```text
D0 docs
  -> M1 inner/outer timing
       -> server dominant? -> M1b phase timing
       -> residual dominant? -> A1 programmatic A/B
  -> M2 carrier capacity
       -> aggregate result tier proven? --no--> keep 8 KiB chunks; A2 stops
                                      --yes-> A1, then A2 if per-call cost remains
  -> R1 public render-once
       -> R2 private render-once
  -> W1 only for the measured submit-dominant phase
  -> S1 remaining/slot truth
       -> S2 one measured scheduler cause
```

任何节点失败只回滚本节点；后续节点不能用“理论上会更快”越过前一节点的证据门。

## 5. 预期调用形状

以当前平均 2.34 个实际 chunks 为例：

| 方案 | input.next MCP calls | 模型可见 delivery turns | generation.start | submit |
|---|---:|---:|---:|---:|
| Session V3 基线 | 3.34 | 3.34 | 1 | 1 |
| A1 程序化领取 | 3.34 | 1 | 1 | 1 |
| A2 单 batch + final-ack start | 1 | 1 | 1 | 1 |

A1 只隔离约 26.65 分钟协议步进中的可消除部分；A2 才能减少 107 次 `input.next` 本身。实际加速只能由 M1 同批 A/B 给出，不能把调用数比例直接当墙钟倍数。

## 6. 明确非目标

- 不把 2,048 改成另一个未经标定的魔法数字。
- 不删除单次结果 fail-before-stdout、模型上下文预算或 max batch bound。
- 不把 Programmatic Tool Calling 当成自动加速；它必须通过同任务 A/B。
- 不把输入总结后交给模型；semantic prompt/input bytes 必须完整。
- 不取消 candidate Schema、evidence、quality、writer 与 durable truth。
- 不用提高并发掩盖单 work unit 串行成本。
- 不以 subagent session 数估算 semantic candidates 或整本 ETA。
- 不为宿主版本猜测建立 feature flag、兼容层、自动迁移框架或指纹系统。

## 7. D0 交付清单

- [ADR-0116](adr/0116-calibrated-executor-transport-budget-and-round-trip-reduction.md)
- 本切片方案
- ADR-0114 的修订指针
- 旧 Executor 切片方案中 2,048 证据口径的更正
- `docs/代码链路.md` 的 D0 索引

后续代码、测试和性能 evidence 均不属于 D0；必须按 M1 起逐刀进入。
