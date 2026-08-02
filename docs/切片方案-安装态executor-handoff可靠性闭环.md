# 安装态 Executor Handoff 可靠性闭环切片方案

状态:实施中；S0-S6 已完成；S7 待实施。

冻结决策:[ADR-0099](adr/0099-installed-plugin-safe-executor-handoff-publication-and-diagnosable-interruption.md)。延伸边界:[ADR-0068](adr/0068-windows-desktop-reader-and-codex-plugin-distribution.md)、[ADR-0092](adr/0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md)。本方案取代[旧 prompt 闭合方案](切片方案-dispatch-executor-prompt协议闭合.md)尚未完成的 S5-S6 安装态验收，不重做其已完成的 wrapper、组合器和 terminal 状态闭合。

## 0. 对齐确认单

**FrozenIntent**:修复真实薄插件安装下 executor handoff 无法生成、protocol doctor 假阳性、dispatch run 半发布、`executor_interrupted` 不可诊断及恢复口径失真。只写实施方案并冻结后续代码边界；本轮不修改运行代码、不继续当前书构建、不重建语义产物。成功标准是每个后续切片都能从文件状态独立实施和验证，最终由安装态自动 smoke 与真实中断恢复共同闭环。

**TermMap**:

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| Codex plugin | EXISTING | ADR-0068 定义的薄 harness 外壳；生产包不携带 `agents/` |
| Build Engine Sidecar | EXISTING | Windows Setup 安装、内嵌 prompts 与确定性 pipeline 的 `understand-book-build.exe` |
| Executor protocol wrapper | EXISTING | 只控制 dispatch/task 循环、不进入 semantic policy hash 的 prompt 外层 |
| Executor 调度运行 | EXISTING | ADR-0092 定义的 run-scoped append-only 执行周期 |
| Semantic attempt | EXISTING | 只有重新进行语义推理才递增 |
| Lease epoch | EXISTING | 同一语义尝试因执行所有权中断而重新领取的世代 |
| Bounded receipt | EXISTING | 禁止 candidate/raw stderr/正文越界的有限回执 |
| Protocol doctor | EXISTING | 只读检查生产协议和目标兼容性的 sidecar 命令 |

**RiskReceipt**:用户在确认安装态资产错配、非原子发布和中断诊断缺口后，于 2026-08-02 明确要求写 ADR 与切片方案；接受以边界重构修复 plugin/sidecar/dispatch/receipt 四处契约，但本轮只落文档。

**ChangeType**:`[边界重构]`。

领域对齐完成；TermMap 零未解析符号。

## 1. 已证实根因与非根因

### 1.1 安装态 prompt 资产错配

生产发布路径是:

```text
.agents/plugins/marketplace.json
  -> plugins/understand-book/
       .codex-plugin/plugin.json
       .mcp.json
       scripts/start-book-mcp.cmd
       skills/build/SKILL.md
       # intentionally no agents/

Windows Setup
  -> understand-book-build.exe
       # extractor prompts are embedded by sidecar-entry.ts
```

当前 `automatic-build.ts:completeExecutorPrompt` 却执行:

```text
readFileSync(<--plugin-root>/agents/<extractor>.md)
readFileSync(<--plugin-root>/agents/automatic-build-dispatch-executor.md)
```

所以同一发布物出现“`sidecar prompt` 成功、accepted `next` 生成 handoff 失败”。完整仓库根可运行只是开发态偶合，不是生产契约。

### 1.2 Doctor 与测试覆盖错位

当前 doctor 只组合 plan/audit 状态后固定返回 compatible，没有调用 handoff 的 prompt 准备路径。现有 parity smoke 又显式传入 `repoRoot`，release assertion 只单独执行 `sidecar prompt`；二者都没有用真实薄插件根跑 accepted `next`。

```text
current checks
  repoRoot + prompt command                 -> pass
  repoRoot + accepted next + handoff        -> pass

missing check
  thinPluginRoot + accepted next + handoff  -> fails
```

### 1.3 Dispatch run 半发布

当前顺序是:

```text
persist manifest.json      # run 已被 runtime 看见
compose complete prompt    # 此处可能 ENOENT
persist executor-handoff.json
```

因此“handoff 失败前没有持久化 dispatch”不是可靠事实。ADR-0099 后创建的 run 必须满足:

```text
published(run) => manifest.exists && handoff.exists && handoff.digest_valid
runtime_visible(run) = published(run)
```

### 1.4 中断证据被压平

真实 receipt 已证明某次 run 为:

```text
task_receipts = []
unclaimed_work_unit_ids = [0, 1, 2, 3]
terminal_reason = executor_interrupted
```

它只证明执行器在首个 task claim 前终止；现有 schema 无法区分命令无法启动、非零退出、输出无效、Harness 取消或 executor 丢失。后续同输入 run 全部 committed，故 EPUB、Pass2 选择、Pass1 语义规则和短路径 handoff 不是该次确定性根因。

### 1.5 恢复计数口径

```text
unclaimed interruption
  -> no task lease
  -> no semantic_attempt increment
  -> no lease_epoch increment

claimed infrastructure interruption
  -> next ownership uses lease_epoch + 1
  -> same semantic_attempt

canonical semantic/provider/schema failure
  -> semantic_attempt + 1
```

Root 的用户可见汇报必须按此分账，不再把所有 executor interruption 称为“第 N 次语义重试”。同一显式全书调用还必须复用原 `build_plan_path`，不得为普通 resume 再次执行 `legacy-plan`。

## 2. 冻结边界

### 2.1 必须保持

1. Windows Codex plugin 继续是薄外壳，`agents/` 不进入发布包。
2. Sidecar 继续内嵌六个 extractor prompt 与 dispatch wrapper。
3. 原始 extractor bytes 继续决定 semantic `prompt_sha256`；组合后的 executor prompt 不使 artifact stale。
4. Root 与 spawn payload 不接触 prompt 正文、task input、candidate 或 raw tool output。
5. 每个 work unit 继续拥有独立 lease、candidate mailbox、receipt 与 artifact identity。
6. `executor_interrupted` 继续表示 terminal class；新增诊断只解释基础设施中断，不改 semantic failure 含义。
7. 旧 `automatic_build_executor_dispatch_receipt.v1` 必须可读，receipt 总大小继续 `<=16 KiB`。
8. Doctor 保持只读，不创建 plan acceptance、dispatch、task、lease、handoff 或 receipt。

### 2.2 明确不做

- 不把仓库根、Git checkout 或 `agents/` 设为 Windows 运行期依赖。
- 不删除或改写历史 dispatch run。
- 不用 cleanup 删除半发布目录作为一致性手段。
- 不在 receipt 写原始 stderr、异常栈、命令全文、书名、正文或 candidate。
- 不修改 BuildPlan、work unit、artifact schema 或 Pass2 选择语义。
- 不以人工“这次跑通了”替代安装态自动回归。
- 不为恢复当前书重新导入 EPUB、重开 Pass2 或 reset semantic ledger。

## 3. 目标契约

### 3.1 Prompt 解析接口

生产和开发路径共享一个有界结果:

```ts
type AutomaticBuildPromptSource = "packaged_sidecar" | "node_source";

interface ResolvedAutomaticBuildExecutorPromptV1 {
  version: "resolved_automatic_build_executor_prompt.v1";
  extractor_name: AutomaticBuildExtractorPromptName;
  mode: "dispatch" | "task";
  source: AutomaticBuildPromptSource;
  bytes: Uint8Array;
  sha256: string;
  byte_length: number;
}

function resolveAutomaticBuildExecutorPrompt(
  extractorName: AutomaticBuildExtractorPromptName,
  mode: "dispatch" | "task",
): ResolvedAutomaticBuildExecutorPromptV1;
```

路由:

```text
UNDERSTAND_BOOK_SIDECAR_SELF exists
  -> execute <sidecar> prompt <name> --executor-protocol <mode>
  -> source = packaged_sidecar

otherwise
  -> execute executor-prompt-cli.ts through Node/tsx
  -> source = node_source
```

校验:

```text
exit_status == 0
stderr == empty
0 < byte_length <= MAX_DISPATCH_EXECUTOR_PROMPT_BYTES
sha256 == SHA256(bytes)
required wrapper/task markers exist
```

`automatic-build.ts` 禁止再直接读取 `PLUGIN_ROOT/agents`。`UNDERSTAND_BOOK_PLUGIN_ROOT` 只服务 Node 开发回退与插件元数据解析，不是 packaged prompt 资产根。

Resolver 在 publication 前失败时，accepted `next` 返回结构化 `needs_user(executor_prompt_unavailable)` 且不创建 run 文件；不得抛出裸 ENOENT 后留下半发布状态。

### 3.2 Run 发布状态机

```text
ABSENT
  -> resolve prompt in memory
  -> build persisted manifest bytes in memory
  -> build final envelope using deterministic manifest path
  -> build handoff bytes in memory
  -> write executor-handoff.json create-only
       |
       +-- failure -> PREPARED_OR_ABSENT, run 不可见，可重放
       |
       +-- success -> write manifest.json create-only  # publication marker
                         |
                         +-- success -> PUBLISHED
                         +-- same existing bytes -> PUBLISHED_REPLAY
                         +-- conflicting bytes -> FAIL_CLOSED
```

读取不变量:

```text
PUBLISHED(run) =
  manifest.exists
  AND handoff.exists
  AND SHA256(handoff.bytes) == action.executor_handoff.sha256
  AND handoff.envelope.dispatch_run_id == manifest.dispatch_run_id
```

handoff-only 目录不是 active run，不领取 task；重放可验证相同 bytes 后补写 manifest。旧版本留下的 manifest-only run 标记为 `legacy_partial_dispatch_run`：无该 owner task claim 时写有界 interruption receipt 后创建新 run；已有 claim/progress 时停止为显式恢复门禁，不自动回填当前 prompt。

### 3.3 Doctor 返回

保持顶层版本 `automatic_build_protocol_doctor.v1`，增加向后兼容的 checks:

```ts
interface AutomaticBuildProtocolDoctorChecksV1 {
  prompt_provider: {
    status: "compatible" | "incompatible";
    source: AutomaticBuildPromptSource;
    checked_extractors: string[];
    diagnostic_code?: string;
  };
  handoff_preparation: {
    status: "compatible" | "incompatible";
    byte_length?: number;
    diagnostic_code?: string;
  };
  plugin_shape: {
    status: "compatible" | "incompatible";
    thin_plugin: boolean;
    agents_required: false;
  };
}
```

```text
doctor.status = compatible
  iff protocol versions compatible
  AND every supported extractor resolves through the production provider
  AND an in-memory synthetic handoff passes schema/hash/size checks
  AND plugin shape matches the selected runtime
```

Doctor 失败只输出 allowlisted diagnostic code 与必要路径角色，不回显 prompt、异常栈或原始输入。

### 3.4 中断诊断

`automatic_build_executor_dispatch_receipt.v1` 增加可选字段，旧 receipt 缺失时仍可读:

```ts
interface AutomaticBuildExecutorInterruptionV1 {
  version: "automatic_build_executor_interruption.v1";
  diagnostic_code:
    | "command_start_failed"
    | "command_nonzero_exit"
    | "command_output_invalid"
    | "harness_cancelled"
    | "executor_lost"
    | "legacy_handoff_missing"
    | "unknown";
  phase:
    | "before_first_claim"
    | "task_reserved"
    | "task_running"
    | "between_tasks"
    | "finishing";
  reporter: "executor" | "root_supervisor" | "build_engine";
  last_command_role:
    | "dispatch_next"
    | "task_input"
    | "candidate_stage"
    | "task_submit"
    | "dispatch_finish"
    | "unknown";
  last_completed_ordinal: number;
  active_work_unit_id?: string;
  observed_at: string;
}
```

约束:

- `phase`、ordinal 与 active work unit 由持久化 progress/lease 确定性派生，调用者不可伪造。
- `diagnostic_code`、reporter、command role 只接受枚举；无可靠证据时必须写 `unknown`。
- 新生成的 `executor_interrupted` receipt 必须携带 interruption；历史 receipt 可缺失。
- 只有 `terminal_reason=executor_interrupted` 可带 interruption。
- raw message/stderr/stack/command/candidate 字段一律拒绝。
- executor 未能自行收口时，root supervisor 必须先 inspect，再用有界原因关闭 run；不得从聊天正文推断 task 成败。

### 3.5 Root 恢复与汇报

```text
receipt complete
  -> replan and continue stage closure

receipt task_failure
  -> inspect semantic_attempt ledger
  -> retry or needs_user(retry_exhausted)

receipt executor_interrupted + before_first_claim
  -> no semantic retry consumed
  -> reuse exact BuildPlan and accepted policy
  -> create/reuse a recoverable new dispatch run

receipt executor_interrupted + task_reserved/task_running
  -> wait for or expire old lease epoch
  -> next lease_epoch, same semantic_attempt

legacy partial run with active claim
  -> needs_user(legacy_partial_dispatch_run)
```

用户可见状态必须说清“阶段、phase、已完成/未领取数量、semantic attempt、lease epoch、下一动作”，不得只写“执行器仍在处理”或“准备第三次重试”。

## 4. 切片顺序

### S0 安装态红测冻结

状态:已完成(2026-08-02)。Core 新增断言 3 条按预期分别红于 manifest 先发布、interruption 缺结构字段与 doctor 假阳性；薄插件 packaged parity 精确红于 accepted `next` 读取不存在的 `agents/pass1-local-extractor.md`，其余既有断言保持绿色。

**做**:先用最小 fixture 复现薄插件 root、半发布和无诊断 interruption 三个失败。

**触达**:

- `packages/core/test/automatic-build-handoff.test.ts`
- `packages/core/test/automatic-build-dispatch-runtime.test.ts`
- `apps/desktop/scripts/smoke-automatic-build-parity.mjs`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**红测**:

1. staged plugin fixture 逐字复制 `plugins/understand-book`，断言没有 `agents/`。
2. packaged Sidecar 用该 fixture 先执行返回 compatible 的 `protocol-doctor`，再执行 accepted `next`；组合断言要求 handoff 可生成，当前在 next 的 ENOENT 处先红并证明 doctor 假阳性。
3. Node 开发路径显式使用不可用 prompt provider，doctor 必须 incompatible；当前固定 compatible 路径先红。
4. 注入 handoff 准备失败，断言 run manifest 不得可见；当前 manifest-first 路径先红。
5. 新 interruption receipt 必须含结构诊断；当前 schema 测试先红。

**不做**:不改实现、不更新 cachebuster、不碰真实安装缓存。

**完成判据**:每条红测只因对应已证实缺口失败；现有 prompt composer、dispatch runtime 与 semantic hash 测试仍绿。

### S1 Prompt 权威统一

状态:已完成(2026-08-02)。Handoff 与 action command 统一通过生产 provider 解析完整 prompt；packaged Sidecar 在无 `agents/` 的薄插件 fixture 上完成 accepted next，Node/Sidecar bytes、semantic hash 与 rollback parity 全绿。

**做**:实现 §3.1 resolver，让 handoff 与 `extractor_prompt_command` 消费同一 prompt 提供者。

**触达**:

- `skills/build/automatic-build.ts:completeExecutorPrompt`
- `skills/build/executor-prompt-cli.ts`
- `skills/build/sidecar-entry.ts:command === "prompt"`
- `packages/core/test/automatic-build-executor-prompt.test.ts`
- S0 安装态 handoff 测试

**实现约束**:

- 删除 handoff 路径中的 `readFileSync(path.join(PLUGIN_ROOT, "agents", ...))`。
- Sidecar self command 失败时返回结构化 infrastructure diagnostic，不回退到 plugin 文件。
- Node/Sidecar 对六个 extractor 的 dispatch/task prompt 保持字节 parity。
- 原始 extractor 文件及 `ExtractionPolicyFingerprintV1.prompt_sha256` 不变。

**不做**:不改 run 写入顺序、不加 receipt 字段、不调整 plugin 内容。

**完成判据**:S0 薄插件 accepted-next prompt 解析转绿；prompt 单测、extractor hash 契约和 Node/Sidecar byte parity 全绿。

### S2 Run 原子发布

状态:已完成(2026-08-02)。新 run 先 prepare、create-only 写 handoff、最后以带 handoff ref 的 manifest 发布；runtime 校验完整 pair，handoff-only 不可见、冲突 replay fail-closed。历史无 ref 但 handoff 有效的 run 只读兼容；真正 manifest-only 零 claim 关闭后转新 run，有 claim 返回恢复门禁。结构化 `legacy_handoff_missing` 诊断归 S4 写入。

**做**:把 dispatch run 拆成 prepare 与 publish 两阶段，manifest 成为最后写入的 commit marker。

**触达**:

- `skills/build/automatic-build.ts:persistDispatchExecutorHandoff`
- `packages/core/src/automatic-build-dispatch-runtime.ts:persistAutomaticBuildDispatch`
- `packages/core/src/automatic-build-dispatch-runtime.ts:readAutomaticBuildDispatch`
- `packages/core/src/automatic-build-dispatch-runtime.ts:dispatchPlanRuntimeState`
- dispatch runtime/handoff tests

**故障注入矩阵**:

| 注入点 | 磁盘允许状态 | Runtime 可见状态 | Replay |
|---|---|---|---|
| prompt resolve 前 | 无 run 文件 | absent | 重新 prepare |
| handoff 写入前 | 无 manifest | absent | 重新 prepare |
| handoff 后、manifest 前 | handoff-only | absent | 验证同 bytes 后发布 |
| manifest 写入后 | handoff + manifest | published | 字节一致则幂等 |
| 同 run 冲突 bytes | 旧文件保持 | fail-closed | 禁止覆盖 |

**兼容处理**:

- 旧 manifest-only 且零 claim:写 `legacy_handoff_missing` interruption receipt，后续新 run 恢复。
- 旧 manifest-only 且有 claim/progress:返回 `needs_user(legacy_partial_dispatch_run)`。
- 不删除、覆盖或伪造旧 run handoff。

**不做**:不领取 task、不修改 dispatch/work-unit identity、不清理历史目录。

**完成判据**:`manifest.exists => valid handoff` 在所有故障注入下成立；并发 replay 只有一份相同 published bytes。

### S3 Doctor 真实兼容性

状态:已完成(2026-08-02)。Doctor 对六个 extractor 的 dispatch/task prompt 复用 S1 resolver，并用生产 handoff builder 做内存 hash/size 演练；Node repo、packaged thin、missing provider、Node thin 四格矩阵与只读快照门禁全绿。

**做**:让 doctor 通过 S1 resolver 在内存中检查所有 prompt 与 synthetic handoff。

**触达**:

- `skills/build/automatic-build.ts:automaticBuildProtocolDoctor`
- `packages/core/test/automatic-build-release.test.ts`
- `apps/desktop/scripts/smoke-automatic-build-parity.mjs`
- root/public `skills/build/SKILL.md`

**测试矩阵**:

| Runtime | Plugin root | Prompt source | 期望 |
|---|---|---|---|
| Node dev | repo root | filesystem CLI | compatible |
| Packaged Sidecar | thin fixture | embedded | compatible |
| Node dev | repo root + missing sidecar override | unavailable | incompatible code |
| Node dev | thin fixture without sidecar | unavailable | incompatible code |

每次调用前后比较 automatic-build 状态树摘要，证明 `dry_run_mutates_state=false`。

**不做**:不创建真实 dispatch、不把 exception message 原样写入 JSON。

**完成判据**:旧 doctor 假阳性红测转绿；任一生产 prompt/handoff prerequisite 缺失都不能返回 compatible。

### S4 中断诊断与恢复口径

状态:已完成(2026-08-02)。新写入的 executor interruption 只接受 allowlist 输入，phase/ordinal/active work unit 由 progress、lease 与 start 文件派生；reserved/running/between-tasks/before-first-claim、旧 v1 兼容、raw 字段拒绝与 16 KiB 门禁全绿，root/public skill 已按 semantic attempt 与 lease epoch 分账。

**做**:实现 §3.4 schema、CLI gate、确定性 phase 派生和 root 汇报规则。

**触达**:

- `packages/core/src/automatic-build-dispatch-runtime.ts`
- `skills/build/automatic-build.ts:automaticBuildDispatchFinish`
- `agents/automatic-build-dispatch-executor.md`
- root/public `skills/build/SKILL.md`
- dispatch runtime/handoff tests

**红绿用例**:

1. 首次 `dispatch.next` 前中断 -> `before_first_claim`，无 task attempt。
2. reserved lease 中断 -> `task_reserved`，后续只增加 lease epoch。
3. running lease 中断 -> `task_running`，旧 token 永久不可 submit。
4. 已提交 N 个任务后中断 -> `between_tasks + last_completed_ordinal=N-1`。
5. raw stderr/message/extra key -> schema 拒绝。
6. 旧 v1 receipt 无 interruption -> 仍可读。
7. 新 interrupted receipt 无 interruption -> 写入拒绝。
8. 最大 manifest receipt 仍 `<=16 KiB`。

**不做**:不推断未落盘的精确平台原因；证据不足写 `unknown`，不伪造确定性。

**完成判据**:同一 receipt 足以判断中断阶段、计数影响与下一恢复动作，同时不含私有正文或无界诊断。

### S5 薄插件发布矩阵

状态:已完成(2026-08-02)。Parity 与 release assertion 都以逐字发布快照的无 `agents/` 薄 fixture 覆盖 doctor、plan、accepted next、handoff/manifest inspect、首 claim 与有界 pre-claim interruption；installed root 可选门禁锁定 skill hash、cachebuster 与 thin shape，`package:windows` 强制串联两道 smoke。

**做**:把真实发布目录而非 repo root 设为 release smoke 的主要 plugin-root fixture。

**触达**:

- `apps/desktop/scripts/assert-plugin-release.mjs`
- `apps/desktop/scripts/smoke-automatic-build-parity.mjs`
- `plugins/understand-book/**`
- `.agents/plugins/marketplace.json`
- `.codex-plugin/plugin.json`
- `apps/desktop/package.json:package:windows`

**自动 smoke**:

```text
build packaged sidecar
  -> stage exact plugins/understand-book snapshot
  -> assert agents/ absent
  -> legacy-plan on disposable source
  -> protocol-doctor --plugin-root <thin fixture>
  -> plan
  -> accepted next
  -> verify executor-handoff path/hash/size/prompt markers
  -> dispatch.inspect validates published handoff + manifest pair
  -> dispatch.next first claim
  -> bounded interrupt/finish receipt
```

Node/repoRoot parity 仍保留，但不能代替上述安装态链路。`UNDERSTAND_BOOK_INSTALLED_PLUGIN_ROOT` 存在时还要验证 installed skill hash、thin shape 与 packaged smoke 使用的 release snapshot 一致。

**不做**:不把 `agents/` 加入 plugin 使测试“碰巧通过”，不读取用户真实个人插件缓存作为 CI fixture。

**完成判据**:`test:automatic-build-parity` 与 `test:plugin-release` 在无 `agents/` 的薄 fixture 上覆盖 accepted next；`package:windows` 强制执行这两道门禁。

### S6 Skill 恢复纪律与短引用

状态:已完成(2026-08-02)。Root/public skill 已冻结单次 `legacy-plan` 与持久 `build_plan_path` 复用；spawn 前先验证 absolute handoff 位于 manifest workspace，再仅携带 `action.cwd` 相对短路径、摘要、长度与固定指令；未领取、租约中断、canonical failure 三种计数口径由 Core contract test 与 release markers 同步锁定。

**做**:修订 root/public build skill，使恢复只信磁盘计划/dispatch 状态，并把 spawn payload 保持为工作区内短引用。

**触达**:

- `skills/build/SKILL.md`
- `plugins/understand-book/skills/build/SKILL.md`
- `apps/desktop/scripts/assert-plugin-release.mjs:protocolMarkers`
- skill contract tests

**冻结规则**:

1. 首次显式全书调用只执行一次 `legacy-plan`，保存并复用 `build_plan_path`。
2. executor interruption 后先 inspect/replan，不重建等价 legacy plan。
3. spawn 前核对 persisted absolute handoff 位于 workspace 内，再传 `cwd` 相对短路径 + sha256 + 固定读取指令。
4. spawn payload 禁止 prompt/envelope/candidate/原始命令清单与书路径。
5. 未领取中断汇报为“零语义尝试、零 lease epoch 消耗”。
6. 有 lease 中断明确报告当前 semantic attempt 与下一 lease epoch。
7. 只有 canonical failure 才使用“语义重试/重试耗尽”。

**不做**:不让 root 代执行 task，不从对话文本推断 durable state。

**完成判据**:root/public skill hash 一致；release assertion 锁定计划复用、短引用、诊断字段和三类计数口径。

### S7 真实安装恢复与文档收口

**做**:从干净远端 commit 构建 Setup，在新 Codex task 中完成两次中断恢复和一次无 Pass2 全闭包构建。

**发布门禁**:

```text
one release commit
  -> remote commit SHA 可见
  -> clean checkout exact SHA
  -> UNDERSTAND_BOOK_MARKETPLACE_SOURCE pinned to exact ref
  -> pnpm -C apps/desktop package:windows
  -> install Setup + unique plugin cachebuster
  -> new Codex task loads installed thin plugin
```

**真实场景**:

1. accepted dispatch 在首个 claim 前由 root supervisor 中断，receipt 为 `before_first_claim`，恢复后 attempt 不增加。
2. work unit running 时中断，旧 lease 失效后以同 semantic attempt、新 lease epoch 恢复。
3. `standard_deep + pass2=disabled` 从薄插件入口完成 `pass1 -> profile_sidecar -> book_structure -> done`。

**验收证据**:

- installed plugin 无 `agents/`，doctor 仍 compatible。
- 每个 published manifest 都已有有效 handoff。
- spawn 调用只含相对短路径、摘要和固定读取指令。
- root 永不出现 candidate/body/raw stderr。
- interruption receipt 与 task/lease 目录一致。
- 未重复创建等价 BuildPlan。
- Pass2 始终 excluded。
- 最终 action 为 `done`。

**文档收口**:

- 更新 `docs/代码链路.md`，逐切片写 `file:symbol` 与测试。
- 结构边界落地后更新 `docs/架构.md` 的 plugin -> sidecar -> prompt -> handoff -> manifest 数据流。
- 把旧 prompt 闭合方案 S5-S6 标记为由本方案取代。
- 长任务暂停或最终收口时整页覆写 `SESSION_CHECKPOINT.md`。

**完成判据**:自动 smoke、真实安装 trace、持久化 receipt/lease 和最终 workspace 状态四者一致。

## 5. 依赖、提交与验证

### 5.1 依赖图

```text
S0 red tests
  -> S1 prompt authority
       -> S2 atomic publication
       -> S3 doctor compatibility
  -> S4 interruption diagnostics

S1 + S2 + S3 + S4
  -> S5 thin-plugin release matrix
  -> S6 skill recovery discipline

S5 + S6
  -> S7 real install acceptance + docs
```

S2 与 S4 不混为一刀：前者修发布一致性，后者扩展诊断契约。S3 必须复用 S1 provider，禁止复制检查逻辑。S7 前不允许用当前脏工作区生成正式 Setup。

### 5.2 建议提交

| Commit | 内容 | 必须为绿的判据 |
|---|---|---|
| 1 | S0 + S1 red-green | prompt/extractor/handoff tests |
| 2 | S2 | fault-injection + dispatch runtime tests |
| 3 | S3 | doctor read-only + compatibility matrix |
| 4 | S4 | interruption/retry/privacy/size tests |
| 5 | S5 + S6 | packaged smoke + release assertion + skill parity |
| 6 | S7 | real acceptance evidence + architecture/code-chain docs |

### 5.3 确定性验证命令

```powershell
pnpm -C packages/core test -- automatic-build-executor-prompt automatic-build-handoff automatic-build-dispatch-runtime automatic-build-release extractor-contract
pnpm -C packages/core typecheck
pnpm -C apps/desktop test:automatic-build-parity
pnpm -C apps/desktop test:plugin-release
git diff --check
```

正式发布前另跑:

```powershell
$env:UNDERSTAND_BOOK_MARKETPLACE_SOURCE='adaelon/undertand-book@<exact-remote-sha>'
pnpm -C apps/desktop package:windows
```

若 Vitest 文件筛选语义导致未命中，必须拆成明确文件名重跑并记录 suite/test 数，不得把“exit 0 但零测试”当通过。

## 6. 文件变更预算

预计修改:

```text
skills/build/automatic-build.ts
skills/build/executor-prompt-cli.ts
skills/build/sidecar-entry.ts
skills/build/SKILL.md
plugins/understand-book/skills/build/SKILL.md
packages/core/src/automatic-build-dispatch-runtime.ts
packages/core/test/automatic-build-executor-prompt.test.ts
packages/core/test/automatic-build-handoff.test.ts
packages/core/test/automatic-build-dispatch-runtime.test.ts
packages/core/test/automatic-build-release.test.ts
packages/core/test/extractor-contract.test.ts
apps/desktop/scripts/smoke-automatic-build-parity.mjs
apps/desktop/scripts/assert-plugin-release.mjs
docs/代码链路.md
docs/架构.md
docs/切片方案-dispatch-executor-prompt协议闭合.md
SESSION_CHECKPOINT.md  # 仅在触发时整页覆写
```

可能新增:

```text
packages/core/src/automatic-build-interruption.ts  # 仅当 runtime 文件继续膨胀时拆出纯 schema/validator
```

明确不改:

```text
plugins/understand-book/agents/**  # 不创建
agents/*-extractor.md              # semantic prompt bytes 不变
BuildPlan / work-unit / semantic-artifact schema
现有 accepted artifact 与用户书库 truth
```

## 7. Definition of Done

```text
done =
  thin_plugin_remains_thin
  AND packaged_sidecar_is_prompt_authority
  AND node_sidecar_prompt_bytes_match
  AND semantic_prompt_hashes_unchanged
  AND doctor_uses_production_preparation_path
  AND doctor_is_read_only
  AND published_manifest_implies_valid_handoff
  AND partial_publication_is_fault_injection_safe
  AND interrupted_receipt_is_bounded_and_diagnosable
  AND semantic_attempt_and_lease_epoch_are_not_conflated
  AND legacy_build_plan_is_reused_on_resume
  AND spawn_payload_is_workspace_relative_and_bounded
  AND candidate_and_raw_diagnostics_never_reach_root
  AND thin_plugin_release_smoke_passes
  AND real_installed_build_reaches_done_without_pass2
```

任一条件为 false，都不得用完整仓库 `plugin-root`、复制 `agents/`、人工补 handoff、重跑 legacy plan 或 LLM 自评绕过。
