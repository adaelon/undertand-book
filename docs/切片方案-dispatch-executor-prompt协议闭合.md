# Dispatch Executor Prompt 协议闭合切片方案

状态:实施中;S0-S4、S5A 已完成;S5-S6 待实施。

冻结决策:[ADR-0092](adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md)。关联实现:[automatic-build.ts](../skills/build/automatic-build.ts)、[automatic-build-dispatch-runtime.ts](../packages/core/src/automatic-build-dispatch-runtime.ts)、[sidecar-entry.ts](../skills/build/sidecar-entry.ts)。关联契约:[build skill](../skills/build/SKILL.md)、[Pass1 extractor prompt](../agents/pass1-local-extractor.md)。

## 0. 对齐确认单

**FrozenIntent**:修复 Codex 主代理在收到 `automatic_build_dispatch_executor.v1` 后无法直接启动专用 executor、反复澄清 prompt 与 envelope 的协议缺口。完整执行 prompt 必须自描述 dispatch 外层循环和 task 内层抽取契约;不改变语义 work unit、候选 schema、artifact identity、lease/mailbox/receipt 所有权或质量门。成功标准是 root 只需执行 `extractor_prompt_command`、把其 stdout 与一个 dispatch envelope 交给专用 subagent,subagent 即可确定性进入 `dispatch.next -> task -> submit/fail -> ... -> finish`,且 root 永不接触 candidate body。

**TermMap**:

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| Executor 调度执行包 | EXISTING | ADR-0092 定义的同 target/stage/policy/kind 有界 manifest |
| Executor 调度运行 | EXISTING | 由 `dispatch_run_id` 标识的一次 append-only 执行周期 |
| Task executor envelope | EXISTING | `automatic_build_executor.v1`,承载单任务 input/candidate/submit/fail/heartbeat 命令 |
| Dispatch executor envelope | EXISTING | `automatic_build_dispatch_executor.v1`,承载 manifest 与 `next/inspect/finish/interrupt` 命令 |
| Extractor semantic prompt | EXISTING | 六个专用 extractor 的语义规则正文,其完整字节参与 `prompt_sha256` |
| Executor protocol wrapper | BOUNDARY_CHANGE | 运行时附加的调度执行说明;属于 harness 协议,不得进入语义 policy fingerprint |
| Bounded receipt | EXISTING | task/dispatch 的有限回执;禁止携带 candidate payload |

**RiskReceipt**:用户于 2026-07-31 在看到“直接修改六个 extractor prompt 会改变 `prompt_sha256` 并误使已有产物 stale”的风险后,要求先给出切片方案并写入新文档。本方案因此把 executor protocol wrapper 与 extractor semantic prompt 物理分离,并用 hash 边界测试阻止回归。

**ChangeType**:`[边界重构]`。

领域对齐完成;TermMap 零未解析符号。新增 wrapper 只是 ADR-0092 既有执行边界的显式载体,不新增领域 truth,无需新 ADR。

## 1. 根因与复现证据

### 1.1 观察到的卡点

本次真实构建在 accepted Pass1 dispatch 落盘后停在 root 推理阶段:

```text
automatic_build_next.v1
  action.kind = dispatch
  dispatches.length = 1
  next_work_unit_id = 0
  task_receipts = []
```

当时 live agent 列表只有 `/root`;没有专用 subagent 被启动。磁盘 dispatch 为 `active`,但没有 task lease 被领取。因此这不是 Build Engine 死锁、预算阻塞、槽位不足或候选提交失败,而是 handoff 之前的协议表达缺口。

### 1.2 两层契约没有在同一 prompt 闭合

顶层 build skill 要求:

```text
root
  -> 给 subagent: extractor prompt + automatic_build_dispatch_executor.v1
  -> subagent 循环 next_command
  -> next_command 每次返回至多一个 automatic_build_executor.v1 task
```

但当前专用 extractor prompt 的 `Automatic Build Executor Envelope` 只说明单任务 envelope:

```text
automatic_build_executor.v1
  input_command
  candidate_path
  candidate_command
  usage_path
  submit_command
  fail_command
  heartbeat_command
```

dispatch envelope 本身没有 `candidate_path/input_command/submit_command`;它只给 `next_command`。专用 subagent 若只收到 extractor prompt 与 dispatch envelope,无法从该 prompt 得知必须先执行 `dispatch.next`,也无法知道 `waiting/finish/finished` 的处理方式。

### 1.3 现有测试漏检

[automatic-build-handoff.test.ts](../packages/core/test/automatic-build-handoff.test.ts) 当前分别验证:

- build skill 文本包含 `automatic_build_dispatch_executor.v1`;
- 每个 extractor prompt 包含 `Automatic Build Executor Envelope`、`candidate_path` 与 receipt-only 红线;
- handoff envelope 的命令数组包含 `dispatch.next/inspect/finish`。

它没有验证“实际交给同一个 subagent 的完整 prompt 同时包含 dispatch 外层协议和 task 内层协议”,所以两个各自正确但互不闭合的文本通过了测试。

## 2. 冻结边界

### 2.1 Executor wrapper 与语义 prompt 分离

**决策**:Dispatch 执行说明由独立 wrapper 在 handoff 时与原始 extractor prompt 组合,语义 `prompt_sha256` 只继续绑定原始 extractor 文件。

**否决**:
- 直接复制 dispatch 说明到六个 extractor:产生六份漂移点并使所有语义 policy hash 变化。
- 让 root 临时解释 envelope:继续依赖对话推理,无法测试且会复现 clarification loop。
- 把自然语言说明塞进 dispatch JSON:污染版本化数据 envelope,并扩大每次 stdout/receipt 面。

**命门**:组合后的完整 prompt 只用于 executor 控制;不得参与 artifact freshness 或 semantic policy digest。
**何时回头**:如果未来 executor protocol 本身会改变模型语义输出,必须升级 stage policy/version,不得继续伪装成纯 harness wrapper。

### 2.2 全局纪律

每个代码切片必须满足:

1. 不修改六个 extractor semantic prompt 的现有字节,除非另起显式语义 policy migration。
2. `ExtractionPolicyFingerprintV1.prompt_sha256` 继续等于原始 extractor 文件 SHA-256,不等于组合后 prompt hash。
3. Root 只接收 bounded task/dispatch receipt,不得接收、缓存、复述或转发 candidate JSON。
4. Dispatch 仍按 manifest 启动一个专用 subagent,不得退回一 task 一 subagent 作为默认修复。
5. `dispatch.next` 同刻最多激活一个 task lease;task terminal 后才能领取下一 task。
6. Node 开发路径和 packaged Sidecar 必须输出字节级一致的完整 prompt。
7. 任一 runtime action 必须在完整 prompt 中有唯一处理分支;不允许 hidden `needs_user` 或由模型猜 terminal reason。
8. 所有行为变更先红测;每刀完成后跑相关测试并追加 `docs/代码链路.md`。

全局禁止:

- 不通过修改 skill 文案掩盖 runtime 未闭合。
- 不把 wrapper hash 写入 semantic artifact identity。
- 不让 root 代跑 `input/candidate/submit`。
- 不用 `executor_interrupted` 掩盖 `retry_exhausted` 的语义失败。
- 不为恢复当前书删除 workspace、重建计划或开启 Pass2。

## 3. 目标契约

### 3.1 Prompt 组合接口

建议使用纯组合器,不让 `automatic-build.ts` 与 Sidecar 各自拼字符串:

```ts
type AutomaticBuildExecutorPromptMode = "dispatch" | "task";

interface AutomaticBuildExecutorPromptInput {
  mode: AutomaticBuildExecutorPromptMode;
  extractor_name: string;
  extractor_prompt: string;
  protocol_wrapper: string;
}

function composeAutomaticBuildExecutorPrompt(
  input: AutomaticBuildExecutorPromptInput,
): string;
```

约束:

```text
mode=dispatch
  output = versioned dispatch wrapper + extractor semantic prompt

mode=task
  output = task wrapper(若需要) + extractor semantic prompt

extractor_prompt bytes
  unchanged on disk
  hashed by ExtractionPolicyFingerprintV1

composed output bytes
  sent to executor only
  never used as artifact freshness input
```

### 3.2 Dispatch executor 状态机

```text
START
  -> exec envelope.next_command
       |
       +-- action.kind=task
       |     -> exec task.input_command
       |     -> generate private candidate source
       |     -> exec task.candidate_command
       |     -> optional usage receipt
       |     -> exec task.submit_command OR task.fail_command
       |     -> retain bounded task receipt only
       |     -> discard candidate body
       |     -> NEXT
       |
       +-- action.kind=waiting
       |     -> wait exactly retry_after_ms
       |     -> NEXT
       |
       +-- action.kind=finish
       |     -> exec action.finish_command exactly
       |     -> return automatic_build_executor_dispatch_receipt.v1 only
       |
       +-- action.kind=finished
       |     -> return action.receipt only
       |
       +-- command/process/infrastructure failure
             -> exec envelope.interrupt_command immediately
             -> return interrupt dispatch receipt only
```

### 3.3 Terminal 状态映射

当前 `automaticBuildDispatchNext` 还可能返回未在 extractor prompt 中定义的嵌套 `needs_user`。目标是让 executor 侧只消费可完成闭环的状态,root 在收到 dispatch receipt 并 replan 后再看到全局 `needs_user`。

| Runtime inspection | Executor action | `finish_command` terminal reason | Root 下一次 replan |
|---|---|---|---|
| `leased` | `task` | 无 | 等 task terminal |
| `waiting` | `waiting` | 无 | executor 内有界等待 |
| `ready_to_finish` | `finish` | 自动推导 `complete/task_failure` | 继续下个 stage/dispatch |
| `retry_exhausted` | `finish` | `task_failure` | `needs_user(retry_exhausted)` |
| `executor_instability` | `finish` | `executor_interrupted` | `needs_user(executor_instability)` |
| receipt 已存在 | `finished` | 无 | 接受已有 receipt |

`task_failure` 只允许在以下条件下 partial finish:

```text
存在至少一个 canonical retryable_failure receipt
AND 当前失败 work unit 已 terminal
AND receipt 后剩余 work unit 是 manifest 的严格未领取后缀
AND 没有 active running/reserved lease
```

否则 `finishAutomaticBuildDispatch` 必须拒绝,不能用模型判断“看起来已经失败”。

### 3.4 Handoff 形状

Dispatch action 统一返回可执行 prompt 命令,不再在 Node 路径暴露一个缺少 wrapper 的裸文件路径:

```ts
interface AutomaticBuildDispatchActionV1 {
  kind: "dispatch";
  extractor_prompt_command: string[];
  extractor_prompt?: never;
  dispatches: AutomaticBuildDispatchExecutorV1[];
  receipt_aggregation: {
    expected_receipts: number;
    max_receipt_bytes: number;
    max_total_bytes: number;
    candidate_payload_forbidden: true;
  };
}
```

命令语义:

```text
prompt <extractor-name> --executor-protocol dispatch
  stdout: one complete executor prompt
  stderr: diagnostics only
  exit 0: supported extractor + supported protocol
  exit 2: unknown extractor/protocol/path traversal
```

## 4. 切片顺序

### S0 回归测试冻结

状态:已完成(2026-07-31)。红测唯一失败为 Node dispatch 暴露裸 `extractor_prompt`;旧测试与六 prompt 原始 hash 边界保持绿色。

**做**:先用测试表达“同一完整 prompt 必须闭合 dispatch + task 两层契约”,同时冻结 semantic prompt hash 边界。

**输入**:

- 当前 `automaticBuildNext(... protocol=v2_dispatch)` handoff;
- 六个 extractor prompt;
- `automaticBuildExtractionPolicy` 的现有 prompt hash。

**触达**:

- `packages/core/test/automatic-build-handoff.test.ts`
- `packages/core/test/extractor-contract.test.ts`
- 可新增 `packages/core/test/automatic-build-executor-prompt.test.ts`

**测试先红**:

1. Dispatch action 必须总有 `extractor_prompt_command`,当前 Node 路径因只有 `extractor_prompt` 而失败。
2. 执行该命令所得 prompt 必须同时包含两种 envelope version 和 `task/waiting/finish/finished` 分支,当前输出因只有 task 契约而失败。
3. Policy hash 必须继续等于原始 extractor 文件 hash,不得等于 composed prompt hash。
4. 完整 prompt 必须含 candidate-payload 禁止回传与 interrupt 规则。

**不做**:不改 production 实现,不改 prompt 文件,不更新 hash 常量。

**完成判据**:新测试只因已确认的协议缺口失败;旧测试仍绿;失败输出不包含候选正文。

### S1 独立 wrapper 与纯组合器

状态:已完成(2026-07-31)。版本化 wrapper、纯组合器与六名称白名单 CLI 已落盘;组合/CLI 与六 prompt hash 测试 9/9 绿色。

**做**:新增一个版本化 dispatch wrapper 和纯 prompt 组合器。

**触达**:

- 新增 `agents/automatic-build-dispatch-executor.md`
- 新增 `skills/build/executor-prompt.ts`
- 新增 `skills/build/executor-prompt-cli.ts`
- S0 的 prompt 单测

**实现约束**:

- wrapper 自描述 §3.2 状态机与 receipt-only 红线;
- 组合器只做确定性顺序、分隔符、尾换行与合法 mode 校验;
- CLI 只接受白名单 extractor 名,不接受任意相对/绝对路径;
- extractor semantic prompt 在输出中恰好出现一次;
- 不读取 book workspace、candidate mailbox 或 BuildPlan。

**不做**:不改 `automatic-build.ts` handoff,不改 Sidecar 路由,不处理 terminal runtime gap。

**完成判据**:

- 组合器单测全绿;
- 六个 extractor 文件 SHA-256 与 S0 基线一致;
- unknown mode/name 确定性 exit 2;
- 输出无时间戳、随机值或机器路径。

### S2 Node/Sidecar prompt 交付统一

状态:已完成(2026-07-31)。Dispatch action 仅返回完整 prompt 命令;Node/重建 Sidecar prompt 及 automatic-build parity smoke 字节一致，legacy v2 rollback 保持可用。

**做**:让 dispatch handoff 在开发 Node 路径和 packaged Sidecar 路径都只返回完整 prompt 命令。

**触达**:

- `skills/build/automatic-build.ts:expandAction`
- `skills/build/sidecar-entry.ts:command === "prompt"`
- `apps/desktop/scripts/build-sidecar.mjs`(仅在需要纳入新 `.md` asset 时)
- `apps/desktop/scripts/assert-plugin-release.mjs`
- S0/S1 测试

**目标控制流**:

```text
Node:
  automatic-build.ts
    -> executor-prompt-cli.ts <name> --executor-protocol dispatch

Sidecar:
  understand-book-build.exe prompt <name> --executor-protocol dispatch
    -> same composer
    -> bundled wrapper + bundled extractor prompt
```

**不做**:不改变 dispatch manifest/envelope schema,不改变 task claim/lease,不改变 rollback `automatic_build_protocol.v2` 的行为。

**完成判据**:

- Node/Sidecar prompt stdout 字节级相等;
- dispatch action 不再含裸 `extractor_prompt` fallback;
- `extractor_prompt_command` 可从 action.cwd 原样执行;
- S0 的 handoff 红测转绿。

### S3 Terminal 状态闭合

状态:已完成(2026-07-31)。`retry_exhausted/executor_instability` 均映射为 prompt 已定义的 finish action;partial `task_failure` 的 canonical failure、terminal current、无 active lease、严格未领取后缀门禁已由红绿测试冻结。

**做**:消除 dispatch executor 的 hidden `needs_user` 分支,让每个 runtime inspection 都返回 prompt 已定义的 action。

**触达**:

- `skills/build/automatic-build.ts:automaticBuildDispatchNext`
- `packages/core/src/automatic-build-dispatch-runtime.ts:finishAutomaticBuildDispatch`
- `packages/core/test/automatic-build-dispatch-runtime.test.ts`
- `packages/core/test/automatic-build-handoff.test.ts`

**红测场景**:

1. 三次 semantic failure 后返回显式 `finish(task_failure)`,而非 executor 无法处理的 nested `needs_user`。
2. Lease epoch 超限返回显式 `finish(executor_interrupted)`。
3. `task_failure` 允许未领取严格后缀,但拒绝中间空洞、active lease 或无失败 receipt。
4. Finish receipt 的 `unclaimed_work_unit_ids` 精确保留后缀。
5. Root replan 从 durable task state 得出 retry exhaustion,不依赖 dispatch subagent 的自然语言诊断。

**不做**:不增加新 terminal reason,不修改已发布 receipt 的字段形状,不自动 reset retry ledger。

**完成判据**:§3.3 状态表逐项有测试;所有失败判定来自 lease/mailbox/receipt 确定性状态。

### S4 协议与发布验证

**做**:运行单测、类型检查、Node/Sidecar parity 与 release assertion,冻结生产可执行文件行为。

**命令**:

```powershell
pnpm -C packages/core test -- automatic-build-handoff automatic-build-dispatch-runtime extractor-contract
pnpm -C packages/core typecheck
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
node apps/desktop/scripts/build-sidecar.mjs
node apps/desktop/scripts/assert-plugin-release.mjs
```

若测试 runner 的文件筛选语义不同,允许拆成多个等价命令,但不得省略相应 suite。

**验收矩阵**:

| 维度 | 确定性判据 |
|---|---|
| Prompt 完整性 | 同一 stdout 含 dispatch + task 两层协议 |
| Prompt parity | Node/Sidecar 字节一致 |
| Policy freshness | 六个 semantic prompt hash 不变 |
| Candidate 隐私 | action/receipt/stdout marker 扫描无 candidate payload |
| Receipt 上限 | 单 dispatch receipt `<= 16 KiB` |
| 中断恢复 | committed/current/unclaimed 边界保持 |
| Legacy rollback | 显式 `--protocol automatic_build_protocol.v2` 仍可读同一状态 |

**不做**:不以 LLM 自评替代测试,不只验证 TypeScript 路径而跳过 packaged Sidecar。

**完成判据**:全部命令 exit 0;release assertion 能证明新 wrapper 已打包;没有更新 semantic prompt hash 常量。

### S5A Codex Subagent 短调用交接

**做**:把完整 executor prompt 与单个 dispatch envelope 持久化为 run-scoped 私有 handoff,
Codex 启动 subagent 时只发送绝对路径、摘要与固定读取指令,避免长 tool payload 触发 WebSocket idle timeout。

**目标契约**:

```text
accepted next
  -> .build/automatic-build/v2/dispatches/<stage>/<dispatch>/runs/<run>/executor-handoff.json
       version = automatic_build_dispatch_executor_handoff.v1
       prompt = 完整 dispatch wrapper + semantic prompt
       envelope = 恰好一个 automatic_build_dispatch_executor.v1
  -> action.dispatches[i].executor_handoff
       version/path/sha256/byte_length
  -> spawn_agent(path + sha256 + fixed instruction)
```

**触达**:

- `skills/build/automatic-build.ts:persistDispatchExecutorHandoff`
- `skills/build/SKILL.md` 与 `plugins/understand-book/skills/build/SKILL.md`
- `packages/core/test/automatic-build-handoff.test.ts`
- `apps/desktop/scripts/smoke-automatic-build-parity.mjs`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**实现约束**:

- handoff 与 dispatch run 同目录、create-only;同 run replay 必须字节一致,冲突 fail-closed;
- root 与 subagent 均核对 SHA-256/byte length;文件上限 256 KiB;
- spawn tool payload 禁止内联完整 prompt/envelope;
- handoff 不含 candidate/task input/usage/receipt body,不改变 semantic `prompt_sha256`;
- 缺失或摘要漂移停止为 `needs_user(executor_handoff_required)`,不得回退成长调用。

**红测**:dispatch action 当前没有 `executor_handoff`;build skill 当前仍要求内联 prompt+envelope。

**不做**:不修改 Codex 平台/WebSocket,不让 root 代跑 task,不改变 dispatch/task/lease/artifact identity。

**完成判据**:unit test 冻结 handoff schema、摘要、幂等 replay 与 candidate 隐私;Node/Sidecar 生成相同 handoff bytes;
release assertion 证明发布 skill 强制短调用;真实 S5 只通过短引用启动 subagent。

### S5 真实 active dispatch 恢复验收

**做**:先把 S0-S5A 的全部发布文件合并为一个 commit 并推送远端,再从该远端 commit 的干净检出重编译 Windows Setup；Setup 的 `UNDERSTAND_BOOK_MARKETPLACE_SOURCE` 固定为 `adaelon/undertand-book@<remote-commit-sha>`,安装后复用当前未领取 task 的 active Pass1 dispatch 验收真实 Codex 专用 subagent 交接。

**发布来源门禁**:

```text
one S0-S5A release commit
  -> remote branch exposes the exact commit SHA
  -> clean checkout of that remote SHA
  -> package:windows with marketplace source pinned to the same SHA
  -> Setup installs the unique plugin cachebuster from that commit
  -> new Codex task loads the installed skill and starts S5
```

不得直接从当前脏工作区编译 Setup,不得让 Setup 指向未固定的本地 marketplace,也不得用旧 plugin version/cache 代替新提交的发布 skill。

**前置只读检查**:

```text
protocol-doctor.status = compatible
dispatch.inspect.state = active
next_work_unit_id = 0
task_receipts = []
no active task lease
BuildPlan.public_stage_closure = [pass1, profile_sidecar, book_structure]
BuildPlan.excluded contains public.pass2
```

**执行**:

1. 从当前 action 核对 `executor_handoff` 的 path/sha256/byte_length,不把正文展开进 tool payload。
2. 用只含 handoff 绝对路径、摘要与固定读取指令的短调用启动一个专用 subagent;subagent 本地读取完整 prompt 与现有 dispatch envelope。
3. 观察首个 `dispatch.next` 领取 work unit `0`。
4. 等待该 manifest 返回唯一 bounded dispatch receipt。
5. Root 重新 plan/next,继续关闭 Pass1、profile sidecar、BookStructure。

**真实验收**:

- Setup 构建源码 `HEAD`、远端可见 commit 与 marketplace source ref 三者 SHA 完全一致;
- 安装后的 `understand-book@understand-book` 版本等于该 commit 的 release manifest,且不是安装前 cachebuster;
- UI/trace 不再长时间停在 `Clarifying dispatch executor prompt and envelope`;
- subagent 启动后首个有意义动作是执行 `dispatch.next`;
- root 不出现 candidate JSON;
- 四个 Pass1 task 按 manifest 顺序 terminal;
- Pass2 始终不调度;
- 最终 `automatic_build_next.v1.action.kind=done`。

**失败处理**:

- 若 prompt 命令失败:基础设施失败,执行 `interrupt_command`,不得让 root 代跑;
- 若已有 lease 与前置检查不符:停止并重新 inspect,不得重复领取;
- 若 retry exhausted:展示 durable diagnostics/reset commands,等待用户确认后才 reset;
- 若 source/plan digest 漂移:重新 plan,不得继续旧 accepted digest。

**完成判据**:真实书构建完成且无 Pass2;trace、磁盘 receipt 与最终 workspace 状态三者一致。

### S6 文档与续建沉淀

**做**:每刀完成时持续更新代码链路;结构边界完成后同步架构;长任务中断时刷新 checkpoint。

**触达**:

- `docs/代码链路.md`
- `docs/架构.md`
- `SESSION_CHECKPOINT.md`(仅在暂停/切换上下文/收口触发时整页覆写)
- 本文状态行与切片完成标记

**记录要求**:

- 精确到 `file:symbol`,不写“优化了 prompt”;
- 入口写成 `accepted next -> extractor_prompt_command -> dedicated subagent -> dispatch.next`;
- 测试记录真实命令与 suite 数;
- 架构图明确 wrapper 属于 harness 控制面,semantic prompt 属于 policy/freshness 面;
- 不把 candidate、原始书文或私有 mailbox 路径写进公开文档。

**完成判据**:陌生会话只读本文、ADR-0092、代码链路与 checkpoint 即可从任一未完成切片继续,不依赖本次对话记忆。

## 5. 切片依赖与提交纪律

```text
S0(red tests)
  -> S1(wrapper/composer)
  -> S2(handoff wiring)
  -> S3(runtime terminal closure)
  -> S4(package verification)
  -> S5A(short subagent handoff)
  -> S5(real dispatch recovery)
  -> S6(final docs/checkpoint)
```

提交建议:

| Commit | 内容 | 必须为绿的判据 |
|---|---|---|
| 1 | S0 测试 + S1 wrapper/composer | prompt composer/unit tests |
| 2 | S2 Node/Sidecar wiring | handoff + prompt parity tests |
| 3 | S3 terminal closure | dispatch runtime/handoff tests |
| 4 | S4 release artifacts + S6 文档 | typecheck + parity + release assertion |
| 5 | S5 验收记录 | 真实 dispatch receipt + final done |

S0 的红测可以与 S1 同一 commit 形成 red-green,但实现前必须先单独运行并记录预期失败。S2 与 S3 不混在同一刀:前者修 prompt 交付,后者修 runtime terminal 语义,失败定位必须可分。

## 6. 文件变更预算

预计新增:

```text
agents/automatic-build-dispatch-executor.md
skills/build/executor-prompt.ts
skills/build/executor-prompt-cli.ts
packages/core/test/automatic-build-executor-prompt.test.ts
```

预计修改:

```text
skills/build/automatic-build.ts
skills/build/sidecar-entry.ts
packages/core/src/automatic-build-dispatch-runtime.ts
packages/core/test/automatic-build-handoff.test.ts
packages/core/test/automatic-build-dispatch-runtime.test.ts
packages/core/test/extractor-contract.test.ts
apps/desktop/scripts/assert-plugin-release.mjs
docs/代码链路.md
docs/架构.md
SESSION_CHECKPOINT.md  # 仅在触发刷新时
```

明确不改:

```text
agents/pass1-local-extractor.md
agents/paper-metadata-extractor.md
agents/paper-lexicon-extractor.md
agents/profile-sidecar-extractor.md
agents/pass2-longrange-linker.md
agents/book-structure-extractor.md
packages/core/src/semantic-artifact.ts 中现有 prompt_sha256 常量
BuildPlan / work unit / semantic artifact schema
```

## 7. 最终 Definition of Done

全部条件合取成立才算完成:

```text
done =
  complete_prompt_is_self_contained
  AND root_never_interprets_dispatch_protocol
  AND node_sidecar_prompt_bytes_match
  AND semantic_prompt_hashes_unchanged
  AND every_runtime_action_is_prompt_defined
  AND candidate_payload_never_crosses_to_root
  AND dispatch_receipt_is_bounded
  AND interruption_and_retry_state_remain_durable
  AND packaged_sidecar_tests_pass
  AND codex_subagent_spawn_uses_bounded_handoff_ref
  AND real_active_dispatch_reaches_done
  AND pass2_remains_excluded
```

任何一项为 false,不得用“subagent 最终似乎会做对”或 LLM 自评代替确定性验收。
