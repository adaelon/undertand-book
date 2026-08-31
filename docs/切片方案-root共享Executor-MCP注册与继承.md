# Root 共享 Executor MCP 注册与继承切片方案

日期:2026-08-30。
冻结决策:[ADR-0115](adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md)。
承接边界:[ADR-0089](adr/0089-plugin-provided-current-book-mcp-and-setup-sidecar.md)、[ADR-0099](adr/0099-installed-plugin-safe-executor-handoff-publication-and-diagnosable-interruption.md)、[ADR-0100](adr/0100-budget-routable-model-work-units-and-truthful-build-recovery.md)、[ADR-0102](adr/0102-dedicated-executor-bootstrap-role-isolation-and-distribution.md)、[ADR-0114](adr/0114-bounded-executor-semantic-transport-and-code-owned-candidate-submission.md)。

本方案只冻结实现顺序、迁移边界与验收合同。本轮只写文档，不修改运行代码、Codex 配置、插件发布号或用户书库，不重启当前构建，不消费任何 `opaque_handoff_ref`，不读取语义 chunk/candidate，也不执行真实书 `retry_current`。实现阶段把哈希清理拆成 H0-H4，不把规划身份、budget proof、policy generation、transport 变更和共享注册混成一刀。

官方基线以 [OpenAI Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)为准：custom-agent 文件可以包含 `mcp_servers`，省略的 session 设置从 parent 继承。本机 `0.149.0-alpha.4.3` 的已验证行为不是完整合并 Agent TOML，而是克隆 parent config 后应用不含 `mcp_servers` 的 `AgentRoleOverrides`；本方案只把这一版本实测当作迁移动因，不把它冒充官方长期合同。

## 0. 对齐确认单

**FrozenIntent**:正式把 `understand_book_build_executor` MCP 注册到 parent/root 的插件配置层，使 `understand_book_executor` subagent 在 Codex 0.149 通过父配置继承四个 Executor 工具；采用 AGENTS.md 的 HERO 范围门，删除 Bootstrap、Agent 注册、规划/政策身份、budget proof、transport、receipt/evidence 与 release 中不代表大型内容身份、只包装小控制对象或执行证据的摘要层，以显式 version/revision/generation、规范化全文和原值比较替代；将 Executor transport/session 前向升级为 V3。保留每 ref 一 child、`fork_turns=none`、并发上限 3、最多 100 个 work unit、lease/attempt/owner generation、candidate mailbox、schema/LID/evidence/budget/quality gate，以及真正决定语义结果复用、fresh/stale、snapshot 或幂等 replay 的 source/input/prompt/artifact/payload/candidate/published-handoff 内容 hash 和仅作 locator 的 opaque ref。不得另设兼容模式，不得声称与旧 root 能力隔离安全等价。本次成功标准是 ADR、术语与可执行切片完整落盘，代码和运行配置保持不变。

| 术语 | 状态 | 冻结口径 |
|---|---|---|
| 共享 Executor MCP 注册 | BOUNDARY_CHANGE | 插件 `.mcp.json` 在 parent/root 注册一个只含四工具的 Executor server，child 从 parent 继承 |
| Executor role registration | BOUNDARY_CHANGE | 继续把 custom-agent TOML 注册为 `understand_book_executor`；只注册角色，幂等与已知前代迁移均直接比较规范化全文，不计算 digest |
| 非 Executor 调用禁令 | BOUNDARY_CHANGE | root 与其他继承者能发现并在宿主能力上调用四工具，但协议只允许专用 child 调用；正常路径用 0.149 opt-in rollout trace（`CODEX_ROLLOUT_TRACE_ROOT` → `codex debug trace-reduce`）按 thread/role 审计零调用 |
| Connection capability | BOUNDARY_CHANGE | 继续绑定一个 stdio connection 内的 ref/phase/session/grant/sink；不再声称它能鉴别 root/child |
| `automatic_build_executor_session.v3` | BOUNDARY_CHANGE | open → ordinal chunk delivery → grant → generation → structured submit；删除 transport/profile/pack/ledger/output-contract 摘要，按原值、顺序、范围与显式版本验证 |
| HERO 哈希用途门 | NEW | H 去无决策用途摘要，E 不虚构攻击面，R 每项检查绑定具体失败与动作，O 不叠 guard-on-guard；只保留大型正文/集合的真实分支哈希与 opaque locator 派生值 |
| 显式控制身份 | BOUNDARY_CHANGE | context/intent/plan/blueprint 用 id + revision/version；policy 用 stage + generation + semantic contract；不再用小对象 digest 充当代际 |
| 语义复用身份 | BOUNDARY_CHANGE | source/input、一次 prompt 内容身份与显式 semantic contract 决定语义 freshness；budget proof、estimator、reserve、lease 与 receipt 只作执行证据 |
| Opaque handoff ref | EXISTING | root 唯一转交给 child 的动态值；locator 不是路径，也不是单独授权 |
| Candidate mailbox | EXISTING | candidate 仍只经 child tool request 进入代码所有的私有 create-only sink |
| Public/reader-private target | EXISTING | 不因共享注册拆成两种运行模式；同一风险回执覆盖既有构建类型 |

**RiskReceipt**:用户在获知 root 将同时拥有四工具和有效 handoff、可能误领租约、接收语义正文、受 prompt injection 诱导并膨胀上下文，且无法由 stock 0.149 的 MCP server 可信区分 caller role 后，明确回复“同意这个方案，但是无需变成兼容方案，不过我们要记录下这个风险”；在进一步获知删除 transport 与控制身份摘要会改变持久合同、必须换发零-open 的旧 handoff 且不能继续声称 Executor V2 字节不变后，又明确回复“同意，那就把所有无用的哈希都删掉，开始修改方案吧”。该指令也覆盖源码扫描后归入同一类的 budget `proof_digest` 与 policy/receipt/evidence 外层摘要：estimator 或 reserve 改变只影响后续执行预算，不再单独使既有语义 artifact stale。

**R8RevisionReceipt**:用户在获知真实旧 handoff 已经 generation.start、没有 candidate 可恢复，完整迁移只会扩大兼容面后，明确同意把 R8 收缩为发布换代、旧历史只读与新 V3 计划接管，并把真实运行目标改为一份新的 `standard_deep` EPUB；该回执取代上段“换发零-open 旧 handoff”在 R8 的执行授权，不改 root-shared 风险回执。

**ChangeType**:`[边界重构]`。修订能力与隐私证明、控制身份、语义 freshness/执行证据分界和 Executor transport/session 合同；不修改语义抽取输出 schema、读时领域模型，或 source/input/prompt/semantic-contract 真实变化触发重算的规则。

领域对齐完成；TermMap 零 `CONFLICT`、`UNRESOLVED`。`CONTEXT.md` 已即时加入“共享 Executor MCP 注册”“HERO 哈希用途门”和“语义复用身份”，并把控制身份改为显式 revision/version/generation。

### 0.1 A1 切片总声明

本大切片用 H0-H4 分别冻结红契约、规划身份、budget proof、policy generation 与 transport，再把 Executor MCP 从 agent-only 配置迁到插件 parent/root 配置，并把所有旧证明、发布测试与安装态 smoke 同步到真实边界。不重跑身份仍 fresh 的语义 work unit、不新增 supervisor、不建立 V2/V3 双协议兼容层。完成判据是源码门、compiled Sidecar、thin-plugin 安装态和 Codex 0.149 parent/child trace 同时通过，证据明确记录 root 有四工具、root 调用为 0、能力隔离为 false，且现行控制面不再含已判定无用的 hash/digest 字段。

### 0.2 HERO 范围门与哈希审计

```text
keep_hash(x) =
  x compactly identifies a large source, model input, published handoff,
    candidate, or accepted artifact whose body would otherwise be duplicated
  AND match changes reuse/regenerate, fresh/stale, snapshot, or idempotent-replay action
  OR x derives a bounded durable opaque locator
```

第二个分支只允许把派生值当 locator；不得用它证明正文完整、配置兼容、caller role 或安全隔离。除此之外的摘要一律删除，不以“历史上已有”作为保留理由。

| 因素 | 本方案约束 | 失败后动作 |
|---|---|---|
| H | 小配置、版本、证据，以及已在同一路径完整读取且不承担大型正文持久身份的 payload/response 不计算 hash/checksum/fingerprint | 改成字段、全文、原值、ordinal 或 revision 直接比较 |
| E | 默认操作者是本机合作者；只保留项目已声明的 reader-private 与模型边界 | 不新增账号、攻击者模型、签名链或部署安全层 |
| R | 每项测试必须写明能发现的具体失败及结果改变的下一动作 | 没有独立失败分支的重复 gate 删除 |
| O | 一层守卫不能只因上一层守卫存在而成立 | 删除 hash-of-hash、copy 后重哈希和 raw equality 后再摘要复验 |

**保留**:

- model input、window content 与 source content hash：命中跳过昂贵语义生成或大输入重存；
- prompt/rendered-input content hash：semantic contract 只保留一次 prompt 内容身份，不在 proof/receipt 中复制完整模型可见正文；变化时使旧语义结果失效；
- semantic artifact/accepted payload hash：依赖闭包与 active snapshot 以它决定 fresh/stale，避免复制完整产物；
- candidate 与 published handoff content hash：create-only mailbox/replay 或 handoff registry 不保存第二份大型正文，比较结果决定幂等复用或拒绝；
- stage-close coverage/freshness/artifact-set 与 publication receipt content hash：只在压缩大型有序集合或 receipt body，且比较结果决定 close/recovery 时保留；
- opaque handoff/session/input/grant/sink ref 的派生值：只作有界 registry locator 与幂等键。

**删除或替换**:

- `bootstrap_digest`、`--agent-bootstrap-digest` → `--bootstrap-version` 与结构化字段；
- Agent raw/canonical/template digest 与复制后复哈希 → 规范化全文或原始字节直接相等；
- `context_digest`、`intent_digest`、`plan_digest`、`blueprint_digest` → 各对象 id + revision/version；
- budget `proof_digest`、plan-budget `preflight_evaluation_digest/receipt_digest` 及其 lease/mailbox/metrics/artifact 传播 → claim/execution 时直接重算预算字段，用户授权仍只绑定 `plan_id + plan_revision`；
- `policy_digest`、`policy_set_digest`、`current_route_digest`、`current_policy_digest`、`current_proof_digest`、migration `receipt_digest/resolution_digest/evidence_digest/file_sha256` → `stage + policy_generation_id`、work-unit kind/input hash 与原字段直接比较；已解析 artifact 只保留自身 `artifact_hash`；
- 小型 task/accepted/control receipt 的 `task_digest`、`accepted_sha256` 与同类外层摘要 → 直接比较 task/accepted 原字段；大型 `candidate_sha256` 与 accepted `payload_digest` 仍按上述内容身份用途保留；
- `transport_profile_digest`、chunk `payload_sha256`、`serialized_response_sha256`、`pack_digest`、`delivery_ledger_digest`、`output_contract_digest` → 显式版本、ordinal/range/长度、拼接原文与 schema version；
- Agent/release 的 `template digest`、`skill_sha256`、`manifest_sha256`、`compiled_sidecar_sha256`、`root_final_sha256` 与 config/file snapshot hash → closed fields、全文/字节或真实执行结果直接比较。

H0-H4 的每项删除都必须有一条“旧字段存在即红”与一条直接替代判据；不得为已删摘要建立兼容读取层。

## 1. 根因、冲突与不变量

### 1.1 已证实断点

| 层 | 0.149 已证实事实 | 判定 |
|---|---|---|
| BuildPlan / invocation | 已创建并锁定 | 不是计划或确认故障 |
| Engine dispatch | 已签发三个 handoff | 不是并发或 work-unit 故障 |
| Agent role | canonical developer instructions 与投影白名单内的缩减生效；当前模板的可执行缩减仅为 `shell_tool=false`、`apps=false` | Agent TOML 被部分读取，不是完整 child config |
| Parent 普通工具 | child 可继承 Book MCP 等 parent 工具 | 不是全局 MCP 故障 |
| MCP connection ownership | 每个 spawned `Session` 新建 thread-owned `McpRuntime`，其发布过程新建自己的 `McpConnectionSet` | child 继承 server 注册/配置，不复用 parent connection；每个 child 拥有独立 stdio process/connection |
| Agent 新增 MCP | 四个 Executor 工具均不在 child `ALL_TOOLS` | Agent role 投影丢弃 `mcp_servers` |
| `executor.open` | 从未调用 | handoff 未消费，lease 未因本次 child 推进 |
| generation / candidate / writer | 从未开始 | 没有语义 attempt、candidate 或 artifact 写入 |

本机版本差分还表明：0.147 的同形 custom agent 能发现并调用四工具；0.149 的 `AgentRoleOverrides` 不含 `mcp_servers`，最终 child 只得到 parent 已有能力。因此本次修复目标是让：

```text
parent.executor_tools = {
  executor.open,
  executor.input.next,
  executor.generation.start,
  executor.submit_candidate
}

child.executor_tools = inherit(parent.executor_server_registration)
child.executor_connection = new_thread_owned_stdio_connection()
```

而不是继续要求 child 从 Agent TOML 新增能力。

`main@6478a751` 与 `0.149@e8f485bd` 在角色投影边界上相同：child 合同不得依赖 Agent 资产中的 `sandbox_mode="read-only"`、`approval_policy="never"`、`web_search="disabled"`、`tools.view_image=false`，也不得依赖 `unified_exec=false`、`multi_agent=false`、`skill_mcp_dependency_install=false`。`skills.config=[]` 在两版都会归约为空，不会关闭 parent 已有技能。三份 Agent 资产可以继续保留这些声明并接受发布 parity 检查，但 validator、evidence 与 DoD 不得把它们报告为 effective child restriction。

### 1.2 明确修订的旧证明

| 旧声明 | 新声明 | 后续动作 |
|---|---|---|
| `registration_scope=agent_only` | `registration_scope=root_shared` | Bootstrap 与 MCP contract 前向升级 |
| `root_toolset ∩ executor_tools = ∅` | `root_toolset ∩ executor_tools = executor_tools` | root-negative 测试改为共享正向 inventory |
| child-process capability 可拒绝 root | stdio capability 只约束本连接调用序列 | 删除 caller-role 证明，保留 ref/phase 门 |
| Agent TOML 拥有 transport | 插件 `.mcp.json` 拥有 transport | 三份 Agent TOML 删除 MCP 段 |
| root 工具缺失证明隐私 | root 指令禁止 + 正常路径 trace 零调用 | evidence 明示 `capability_isolation=false` |
| 小型控制对象以 digest 标识代际 | id + revision/version/generation | H1 一次性前向迁移，不保留双读 |
| transport/profile/chunk/pack/ledger 摘要链 | 原值 + ordinal/range/长度 + schema version | H2 升级 Session V3 并删除重复字段 |

### 1.3 保持不变的合同

```text
Build root
  -> build.step(available_agent_slots <= 3)
  -> SPAWN_EXECUTORS[opaque_handoff_ref]
  -> spawn_agent(agent_type=understand_book_executor, fork_turns=none)

Dedicated child
  -> executor.open
  -> executor.input.next*
  -> executor.generation.start
  -> executor.submit_candidate
  -> bounded lifecycle final

Build root
  -> reread build.step durable truth
```

以下不变：一个 handoff 对应一个短生命周期 child；root 不接收 prompt、chunk、candidate 或私有路径；最多三个 child 同时 live；100 个 work unit 只是可顺序复用 slot 的生命周期总量，不是 100 个侧边栏顶层任务；Engine 仍拥有计划、租约、attempt、generation grant、mailbox、Schema、LID evidence、budget、quality、writer、receipt 与 recovery。Source/input/prompt/semantic-contract 变化仍触发语义 stale，artifact/payload/candidate/published-handoff 的真实内容身份消费者仍保留；只移除外围控制、调度证据和 transport 摘要。

## 2. 目标拓扑与合同

### 2.1 配置所有权

```text
understand-book plugin
├─ .mcp.json
│  ├─ book                              # 既有只读 Book MCP
│  └─ understand_book_build_executor    # 新的 root-shared Executor MCP
├─ scripts/start-build-executor-mcp.cmd # transport launcher 单一发布入口
├─ assets/codex-agents/
│  └─ understand-book-executor.toml     # 只含角色，不含 mcp_servers
└─ skills/
   ├─ build/SKILL.md                     # root orchestration + 零调用禁令
   ├─ executor/SKILL.md                  # custom agent 缺失时的 child-only fallback
   └─ register-executor/SKILL.md         # 只注册角色模板
```

插件根与 `plugins/understand-book/` 发布投影继续字节一致。不得向 `~/.codex/config.toml`、用户项目 `.codex/config.toml` 或 Setup registry 写第二份 MCP transport。

### 2.2 共享 MCP 配置形状

实现切片应把下列语义投影进两份 `.mcp.json`；字段拼写以 Codex 0.149 实际 schema 测试为准，值域不得放宽：

```json
{
  "mcpServers": {
    "understand_book_build_executor": {
      "type": "stdio",
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "scripts\\start-build-executor-mcp.cmd"],
      "cwd": ".",
      "required": false,
      "enabled_tools": [
        "executor.open",
        "executor.input.next",
        "executor.generation.start",
        "executor.submit_candidate"
      ],
      "default_tools_approval_mode": "approve",
      "startup_timeout_sec": 10,
      "tool_timeout_sec": 120,
      "env_vars": [
        "UNDERSTAND_BOOK_BUILD_EXE",
        "UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT",
        "USERPROFILE"
      ]
    }
  }
}
```

`required=false` 保护普通 root task：binary、registry 或环境变量缺失时，不让所有装有插件的 Codex 会话启动失败；Build doctor、child bootstrap 与安装态 smoke 负责把构建路径失败关闭为 `executor_mcp_unavailable`/既有有界 bootstrap diagnostic。`default_tools_approval_mode=approve` 只定义 shared server 的工具审批形状，不证明 Agent 资产中的 `approval_policy="never"` 已投影给 child；它同时扩大 root 可调用面，属于已接受风险。

`root_shared` 只描述插件配置/catalog 对 parent 与 spawned child 可见，不表示二者共享 MCP runtime 或连接。固定两版实现都会为 fresh child 新建 `Session`、thread-owned `McpRuntime` 与 `McpConnectionSet`，因此 stdio process/connection 以及其上的 ref、phase、receipt、grant、sink 状态按 child 隔离；方案、doctor 与 evidence 均不得把“继承工具”写成“继承 parent connection”。

### 2.3 Bootstrap V3 身份

```ts
type AutomaticBuildExecutorBootstrapV3 = {
  version: "automatic_build_executor_bootstrap.v3";
  agent_name: "understand_book_executor";
  server_name: "understand_book_build_executor";
  registration_scope: "root_shared";
  role_projection: "bounded_agent_role_overrides";
  projected_role_reductions: readonly [
    "shell_tool=false",
    "apps=false"
  ];
  unprojected_agent_fields_are_child_contract: false;
  session_protocol: "automatic_build_executor_session.v3";
  capability_binding: "stdio_connection";
  caller_role_authenticated: false;
  tools: readonly [
    "executor.open",
    "executor.input.next",
    "executor.generation.start",
    "executor.submit_candidate"
  ];
};
```

Launcher 只传 `--bootstrap-version automatic_build_executor_bootstrap.v3 --protocol-generation automatic_build_executor_session.v3`。Server 直接比较这两个值；role/shared-MCP validator 分别检查其余结构化字段。不得生成、传递或报告 bootstrap digest。

V3 同时承载 H2 的 transport 简化：四个工具名保持不变，但 `executor.input.next` 用 `previous_chunk_ordinal` 代替 hash receipt，chunk/grant/sink 响应删除 transport/profile/payload/pack/ledger/output-contract digest。Opaque ref 格式保持 locator 语义；不声明与 V2 请求/响应字节兼容。

### 2.4 Root 非调用合同

Root build 指令必须在第一次 `build.step` 前给出不可误解的禁令：

```text
The four understand_book_build_executor tools are visible to root and may be inherited by other
subagents. Only a dedicated understand_book_executor child may call them. Root and every
non-executor subagent must never call, probe, enumerate, or diagnose executor.open,
executor.input.next, executor.generation.start, or executor.submit_candidate. Pass only the exact
opaque_handoff_ref to a dedicated child and reread durable build.step state.
```

“不枚举”指模型不得主动用 Executor 工具做 capability probe；Codex 自身的静态 inventory、doctor 和发布测试仍可由确定性程序检查。Root 也不得把 `opaque_handoff_ref` 与 tool schema 组合成一次试调用。

### 2.5 调用与数据流矩阵

| 主体 | 可发现四工具 | 合同允许调用 | 可接收 semantic chunk | 可发送 candidate | 硬门 |
|---|---:|---:|---:|---:|---|
| root | 是 | 否 | 否 | 否 | 无 caller-role 硬拒绝；靠指令与 trace 审计 |
| dedicated child | 是，继承 | 是 | 是，仅 child tool result | 是，仅 structured tool request | stdio phase/ref/ordinal/grant/sink/schema 门 |
| other subagent | 可能继承 | 否 | 否 | 否 | 无 caller-role 硬拒绝；不得得到 handoff，tool description 明禁调用 |
| Build Engine | 不适用 | 代码执行 | 生成并分块 | 校验并入 mailbox | durable state、显式 revision/freshness、lease、owner generation |

Root 或其他 subagent 理论上若同时取得有效 ref，server 无法仅凭连接识别其角色。这是本决策保留的残余风险，不得在注释、doctor 或 evidence 中改写为“已验证隔离”。

## 3. 风险、保护面与停止条件

### 3.1 风险账本

| 风险 | 可能后果 | 现有/新增缓解 | 仍未解决 |
|---|---|---|---|
| root 误调 `executor.open` | 语义 chunk 进入 root；child WAIT/conflict；租约被占 | root 明禁、零调用 trace、phase/ref/lease 审计 | server 不能在调用前识别 root |
| prompt injection 诱导调用 | root 消费合法 handoff | root 不探测工具、不解释 Executor schema、只转发 ref | 指令隔离不是硬能力隔离 |
| root 上下文膨胀 | 长构建编排质量下降 | chunk 永不在正常 root 路径投影；trace 扫敏感 sentinel | 一次越界调用已足以污染上下文 |
| reader-private 语义泄露 | 私人 goal/overlay 进入 root | 正常路径仍 child-only；candidate mailbox 与日志禁写不变 | 本方案不提供 reader-private 的能力级证明 |
| optional MCP 启动失败 | child 无工具、构建停住 | `required=false` 保护普通 task；doctor/child fail closed | 不能靠 root 亲自调用诊断 |
| 旧证明继续显示 PASS | 发布证据误导 | V3 显式字段、字段改名、删除 root-negative/agent-only 文案 | 历史证据只能标记旧代际，不能改写 |
| 删除摘要后复用了陈旧语义结果 | 旧模型输出进入新构建 | source/input/prompt/artifact 内容身份与 semantic contract 保留 | 新 prompt 必须改变 prompt content hash 或 policy generation；纯 estimator/reserve 变化只影响下一次执行预算 |

### 3.2 引擎仍可确定性保护的内容

以下保护不依赖 caller role，必须保留其行为，但按 HERO 用最小直接表达：

- ref 形状、session-private root、source/input/prompt/artifact/candidate content hash，以及 plan/policy 的显式 revision/generation；
- handoff、session、input、chunk ordinal、grant、sink 的绑定与顺序；
- lease epoch、owner generation、attempt、submit revision 和幂等 replay；
- claim/execution 时按显式 estimator/render/router/profile/limit 字段重算预算，不把 budget proof 摘要传播成 artifact freshness；
- candidate JSON 闭合 schema、byte/token budget、LID/evidence allowlist；
- create-only mailbox、writer、quality gate、receipt 与 accepted artifact；
- 过期 grant/lease/candidate 拒绝，跨 handoff 与跨 session 调用拒绝；
- stderr、metrics、root final 与通用日志不包含 semantic/candidate body。

不再保留 transport profile、payload、serialized response、pack、delivery ledger 或 output contract digest；原 payload/response 已在同一路径中读取，ordinal/range/长度/schema version 足以决定拒绝或继续。这些门保护构建完整性和越权写入，不阻止 root 用自己合法的 MCP connection 打开一个合法 ref。

### 3.3 立即停止真实构建的条件

任一条件成立即停止，不得把失败折叠成普通 semantic retry：

```text
root_executor_dispatch_attempt_count > 0
OR root_executor_backend_call_count > 0
OR non_executor_child_executor_dispatch_attempt_count > 0
OR non_executor_child_executor_backend_call_count > 0
OR root_trace_contains_semantic_or_candidate_body
OR child_executor_tool_inventory != exact_four_tools
OR root_executor_tool_inventory != exact_four_tools
OR caller_thread_attribution == unverifiable during release smoke
OR bootstrap_evidence.capability_isolation != false
OR bootstrap_evidence.caller_role_authenticated != false
OR shared_mcp_config.required != false
OR custom_agent_contains_mcp_servers
OR active_session_protocol != automatic_build_executor_session.v3
OR current_contract_contains_forbidden_control_transport_or_evidence_digest
```

安装态 trace 无法区分 root/child 时，状态记为 `root_executor_boundary_unverifiable`，不得继续真实书恢复。运行中的偶发 server 不可用记 bootstrap/transport failure，不增加 semantic attempt。

### 3.4 证据最小形状

证据只保存版本、布尔值、数量和有限枚举，不保存 snapshot/config/file 哈希、ref、路径、chunk、candidate、prompt 或 reader goal：

```json
{
  "version": "understand_book_root_shared_executor_evidence.v1",
  "status": "passed",
  "codex_version": "0.149.x",
  "executor_registration_scope": "root_shared",
  "session_protocol": "automatic_build_executor_session.v3",
  "hash_utility_gate": "passed",
  "forbidden_digest_field_count": 0,
  "root_executor_tool_count": 4,
  "child_executor_tool_count": 4,
  "capability_isolation": false,
  "caller_role_authenticated": false,
  "canonical_role_instructions_projected": true,
  "projected_role_reductions": ["shell_tool=false", "apps=false"],
  "unprojected_agent_fields_claimed": false,
  "root_executor_dispatch_attempt_count": 0,
  "root_executor_backend_call_count": 0,
  "non_executor_child_executor_dispatch_attempt_count": 0,
  "non_executor_child_executor_backend_call_count": 0,
  "child_first_executor_dispatch": "executor.open",
  "child_first_executor_backend_call": "executor.open",
  "semantic_attempts": 1,
  "durable_commits": 1,
  "root_sensitive_hits": 0,
  "stderr_sensitive_hits": 0
}
```

`root_executor_dispatch_attempt_count=0` 与 `root_executor_backend_call_count=0` 只证明这次受测正常路径没有发起或执行 Executor 调用，不证明 root 在所有未来 prompt 下没有调用能力。

## 4. 切片顺序

### R0 决策与术语落盘

状态:本轮完成。

**做**:冻结共享注册、root 非调用、HERO 哈希用途门、显式控制身份、语义复用/执行证据分界、Session V3、风险回执与恢复边界。

**触达**:

- `CONTEXT.md`
- `docs/adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md`
- `docs/切片方案-root共享Executor-MCP注册与继承.md`

**不做**:不改 `.mcp.json`、Agent TOML、skill、Core、Sidecar、release smoke、cachebuster 或真实构建状态。

**完成判据**:三份文档术语一致；ADR 明确修订 ADR-0093/0094/0096 与 ADR-0114 §6-§8；`git diff --check`、相对链接和旧术语冲突扫描通过。

### H0 HERO 哈希用途红契约

状态:完成（2026-08-30；预期红合同）。

**做**:先把“保留有消费者的昂贵复用哈希”和“删除无消费者或可直接比较的摘要”写成失败测试，不动生产实现。

**触达**:

- `packages/core/test/build-resume.test.ts`
- `packages/core/test/semantic-artifact.test.ts`
- `packages/core/test/model-input-budget.test.ts`
- `packages/core/test/automatic-build-budget.test.ts`
- `packages/core/test/automatic-build-policy-generation.test.ts`
- `packages/core/test/intent-artifact-mailbox.test.ts`
- `packages/core/test/build-intent-v2.test.ts`
- `packages/core/test/executor-transport.test.ts`
- `packages/core/test/codex-executor-agent.test.ts`
- `packages/core/test/automatic-build-executor-session.test.ts`

**红测**:

1. Pass1/metadata/lexicon/profile/Pass2 的 input/content hash 命中仍产生 `done/reuse`，失配仍产生 `pending/regenerate`；这组先保持绿。
2. Artifact dependency/accepted payload hash 命中仍为 fresh/same snapshot、失配仍为 stale/new snapshot；candidate/published handoff hash 仍决定 create-only replay 或拒绝；opaque ref 仍是有界 locator。这组先保持绿。
3. Active planning/control/task/accepted schema 出现 `context_digest`、`intent_digest`、`plan_digest`、`blueprint_digest`、`task_digest` 或 `accepted_sha256` 即红；明确保留的 candidate/payload 大正文身份不在此列。
4. Budget proof、plan-budget receipt、lease、mailbox、metrics 或 semantic artifact 出现 `proof_digest`/预算 `preflight_evaluation_digest/receipt_digest` 即红；estimator/reserve 变化不得单独使既有语义 artifact stale，下一次 claim 必须按原字段重算。
5. Active policy generation 出现 `policy_digest`、`policy_set_digest`、`current_route_digest`、`current_policy_digest`、`current_proof_digest`、`receipt_digest`、`resolution_digest`、`evidence_digest` 或外层 `file_sha256` 即红。
6. Bootstrap/Agent/release 输出出现 template/skill/manifest/compiled-sidecar/root-final digest 或 SHA-256 snapshot 常量即红。
7. Transport/session schema 出现 `transport_profile_digest`、chunk `payload_sha256`、`serialized_response_sha256`、`pack_digest`、`delivery_ledger_digest` 或 `output_contract_digest` 即红；segment 级 prompt/input content hash 与明确保留的大正文 hash 不在此列。
8. 每个原 digest mismatch 测试必须先映射到一个直接替代失败：revision/version 不同、预算原字段不同、正文不同、ordinal/range 不连续、原 payload 不同或 schema version 不同；映射不出的重复测试删除。

**不做**:不建立通用 hash allowlist 扫描框架，不扫描无关 memory/PDF/reader 域，不把保留哈希重新包装成“完整性证明”。

**完成判据**:保留项的真实 reuse/stale/snapshot/idempotent-replay 分支仍绿；删除项只因生产合同仍含旧字段而红；每条红测都写出通过后会改变的具体生产动作。

**实施证据**:十个点名测试文件共 94 项，82 项保留/既有行为绿，12 项仅因旧生产字段仍存在而按预期红；Core typecheck 与定向 `git diff --check` 通过。为避开长 session 文件在默认 fork pool 的既有 `onTaskUpdate` 收尾超时，最终证据使用 threads singleThread 分成 session 25 绿 + 1 预期红、其余九文件 57 绿 + 11 预期红；无其他断言失败或未处理 runner 错误。生产源码、配置、发布资产与真实构建状态均未修改。

### R1 共享边界红测

状态:完成（2026-08-30；预期红合同）。

**做**:先把旧 agent-only/root-negative 发布断言改成新合同的失败测试，不动生产实现。

**触达**:

- `packages/core/test/codex-executor-agent.test.ts`
- `packages/core/test/build-executor-tool-adapter.test.ts`
- `packages/core/test/build-executor-mcp.test.ts`
- `packages/core/test/automatic-build-release.test.ts`
- `packages/core/test/automatic-build-release-v3.test.ts`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**红测**:

1. 两份插件 `.mcp.json` 必须包含一个 `understand_book_build_executor`，当前红。
2. 共享 server 必须 `required=false` 且只 allowlist 四工具，当前红。
3. 三份 Agent TOML 必须不含任何 `mcp_servers`，当前红。
4. Bootstrap/MCP contract 必须报告 `root_shared` 与 `caller_role_authenticated=false`，当前红。
5. Root build skill 必须逐名禁止四工具，当前红。
6. Doctor 必须给共享正向 inventory，不再给 root-negative PASS，当前红。
7. Release evidence 必须显式写 `capability_isolation=false`，当前红。
8. 四个 tool description 必须逐项声明仅专用 Executor 可调用，当前欠规格而红。
9. H0 保留的语义 freshness、large-body idempotency 与 opaque locator 测试保持绿；H1-H4 将删除的 control/budget/policy/transport 字段仍按预期红。

**不做**:不为让红测通过而改 production；不删除旧安全测试，只把应保留的 ref/phase/schema 部分与应废弃的 caller-role 断言拆开。

**完成判据**:新增测试只因共享配置、显式 V3 身份、指令、Session V3 与 evidence 尚未实现而红；所有无关 suite 仍绿。

**实施证据**:Core typecheck 与定向 `git diff --check` 通过；R1 名称过滤得到 11 项且仅 11 项预期红，分别落在双插件 shared server/exact-four/optional、三份 role-only Agent、Bootstrap/MCP `root_shared` 与 caller-role 诚实字段、Root 逐名禁调用、Doctor shared inventory、release evidence 和四工具 description。五个点名 Core 文件全量为 22 绿、11 个 R1 预期红、2 个 H0 预期红；H0 十文件独立回归仍为 82 绿 + 12 个既有预期红。生产源码、配置、Agent/Skill 资产与真实构建状态均未修改。

### R2 Bootstrap V3 与验证器拆分

状态:完成（2026-08-30）。

**做**:把“角色模板正确”“共享 MCP transport 正确”“stdio 调用序列正确”拆成三个互不冒充的合同。

**触达**:

- `packages/core/src/build-executor-connection-capability.ts`
- `packages/core/src/build-executor-tool-adapter.ts`
- `packages/core/test/build-executor-tool-adapter.test.ts`
- `packages/core/test/build-executor-mcp.test.ts`
- `packages/core/test/codex-executor-agent.test.ts`

**目标 API**:

```ts
BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3
BUILD_EXECUTOR_MCP_CONTRACT_V3
validateBuildExecutorRoleConfigV3(agentToml)
validateBuildExecutorSharedMcpConfigV3(pluginMcpJson)
validateBuildExecutorRegistrationPlacementV3(input)
createBuildExecutorStdioConnectionCapability(input)
```

**实现约束**:

- V3 identity 使用 `version="automatic_build_executor_bootstrap.v3"`、`registration_scope="root_shared"`、`session_protocol="automatic_build_executor_session.v3"`、`capability_binding="stdio_connection"`、`caller_role_authenticated=false`；不含 digest。
- Role validator 的可执行 child 合同只要求完整 canonical instructions、`shell_tool=false`、`apps=false`，并拒绝任意 `[mcp_servers.*]`。
- `sandbox_mode`、`approval_policy`、`web_search`、`tools.view_image`、`skills.config` 与非白名单 feature 若保留，只能由发布检查验证三份资产 parity；不得进入 effective-child 报告。尤其不得把 `skills.config=[]` 翻译成“禁用继承技能”。
- Shared MCP validator 要求插件 server 唯一、launcher 相对插件根、exact-four allowlist、`required=false`、`default_tools_approval_mode="approve"` 与固定 timeout/env surface。
- Registration placement validator 要求插件 parent surface 有 server、Agent TOML 与用户/项目 `config.toml` 无复制 transport；不得再用含混的 `root|project|agent` 枚举把插件层和用户配置层混为一谈。
- Registration inheritance 只表示 server 配置进入 child effective config；validator 与 evidence 必须报告 fresh child 自有 stdio connection，不得报告 parent/child connection shared。
- Connection capability 保留 symbol 不可序列化、单 handoff、phase、previous ordinal、grant、sink 与 private root；它绑定单个 thread-owned stdio connection，接口和错误信息不再含 child-only/root-auth 断言。
- 四个 tool description 都以专用 `understand_book_executor` 限定句开头，明确 parent/root 与其他 agent 不得调用；description 只是指令缓解，不计入 caller-role 鉴权。
- Tool name 常量不变；Session V3 的直接值合同由 H4 独立实现，R2 只提供 bootstrap/shared/role 验证器入口。

**不做**:不改 `.mcp.json` 或 Agent 资产；不更新 cachebuster；不恢复真实任务。

**完成判据**:R1 的纯合同测试中 V3/validator/capability 部分转绿；跨 handoff、乱序、非法 ref、非法 schema 和 replay 行为测试保持绿，但不再依赖摘要字段。

**实施证据**:`BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3` 与 `BUILD_EXECUTOR_MCP_CONTRACT_V3` 直接报告 `root_shared`、Session V3、stdio connection、thread-owned connection 和 caller-role 未认证；role/shared/placement 三个 validator 已拆开，V3 capability 以 `previous_chunk_ordinal`、ref/phase/grant/sink/private-root 原值约束连接，四工具 description 均以专用 Executor 限定句开头。Core typecheck 与 R2 过滤 7 项全绿；三个目标测试文件全量为 20 绿 + 8 个后续 R3/R4/R6/R7 预期红；R1 原 11 项收敛为 3 绿 + 8 个后续预期红。H0 回归仍为 Session 25 绿 + 1 红、其余九文件 58 绿 + 11 个 H0 红 + 5 个已知 R1 红；旧 V2 运行入口保留给 H4/R3 后续迁移，本片未改配置、Agent/Skill、Doctor 或真实书状态。

### H1 显式规划与控制身份迁移

状态:已完成（2026-08-30）。

**做**:把小型 context/intent/plan/blueprint 身份从 digest 改为所有者签发的 id + revision/version，并删除 task/accepted control receipt 对已读取正文的外层摘要。

**触达**:

- `packages/core/src/build-planning-context.ts`
- `packages/core/src/build-intent.ts`
- `packages/core/src/build-intent-v2.ts`
- `packages/core/src/build-intent-controller.ts`
- `packages/core/src/artifact-blueprint.ts`
- `packages/core/src/artifact-blueprint-registry.ts`
- `packages/core/src/book-structure-generation.ts`
- `packages/core/src/intent-artifact.ts`
- `packages/core/src/intent-artifact-mailbox.ts`
- `crates/server/src/build_intent_api.rs`
- `crates/server/src/intent_build_store.rs`
- 对应 Core/Rust tests 与一次性迁移 fixture

**目标身份**:

```ts
type BuildPlanningContextIdentityV2 = { context_id: string; context_revision: number };
type BuildIntentIdentityV3 = { intent_id: string; intent_revision: number };
type BuildPlanIdentityV3 = { plan_id: string; plan_revision: number };
type ArtifactBlueprintIdentityV2 = { blueprint_id: string; blueprint_version: string };
```

**实现约束**:

- revision 由拥有该对象的 Core/store 单调签发；调用方不得提交自算 revision。
- Codex candidate 绑定 `context_id + context_revision`；用户确认绑定 `plan_id + plan_revision`；overlay、task、handoff 和 accepted artifact 保存同一显式身份。
- 同一 blueprint id/version 的 schema 直接结构比较；不得对 schema 再计算 digest。
- `task_digest`、`accepted_sha256` 与同类 control receipt 摘要删除；当前 task 与 accepted record 已完整读取时直接比较其有限身份字段和 canonical body。大型 candidate/accepted payload 内容身份仍留给 mailbox/snapshot 的真实幂等消费者。
- V2 reader 与一次性迁移入口先完整读出并验证旧对象，再 create-only 写 V3；成功切换 active pointer 后生产路径只读 V3，旧对象留作历史证据但不参与运行。
- 本切片只用 synthetic fixture 证明迁移；不读取或改写用户当前 V2 plan/overlay。真实状态只在 R8 获得单独授权后调用同一入口。
- 不创建 migration registry、通用版本图、后台双写或 V2/V3 双读模式。

**不做**:不重编译计划、不重新询问用户、不使仍 fresh 的公共/私有语义产物失效、不删除 source/input/prompt/artifact/payload/candidate 内容 hash。

**完成判据**:H0 的 planning/control 红测转绿；V3 planning/control state 使用显式身份，只有 H0 点名保留的大正文内容 hash 仍存在；同 revision 不同正文、旧 revision 确认与同 blueprint version 不同 schema 均直接失败；locked V2 fixture 迁移前后业务字段、预算、依赖与授权逐项相等，用户真实状态零写入。

**实施证据**:`BuildPlanningContext`、`BuildIntent`、`BuildPlan` 与 `ArtifactBlueprint` 已改用 owner-issued id + revision/version，candidate、确认、overlay、task、handoff 与 accepted artifact 透传同一显式身份；task/accepted control receipt 摘要已删除，大正文 candidate/payload replay 身份保留。Core H1 七文件 41 项、plan-budget recovery authority 1 项与 Rust store 14 项全绿；Core typecheck、Rust crate 编译和定向 `git diff --check` 通过。locked V2→V3 只在 synthetic 临时根验证 create-only 迁移与业务字段 parity，未读取或写入用户真实状态；budget/policy/transport 仍留给 H2-H4。

### H2 Budget proof 去摘要与执行证据分离

状态:已完成（2026-08-30）。

**做**:删除 `proof_digest` 和 plan-budget `preflight_evaluation_digest/receipt_digest`，让预算字段只在 planning/claim/execution 时直接重算，不再传播进 lease、mailbox、metrics 或 semantic artifact freshness。

**触达**:

- `packages/core/src/model-input-budget.ts`
- `packages/core/src/automatic-build-budget.ts`
- `packages/core/src/stage-work-unit.ts`
- `packages/core/src/semantic-artifact.ts`
- `packages/core/src/automatic-build-task-store.ts`
- `packages/core/src/automatic-build-lease.ts`
- `packages/core/src/automatic-build-mailbox.ts`
- `packages/core/src/automatic-build-metrics.ts`
- `packages/core/src/automatic-build-quality.ts`
- `packages/core/src/build-orchestrator.ts`
- `skills/build/automatic-build.ts`
- `skills/build/automatic-build-driver.ts`
- 对应 budget/routing/lease/mailbox/quality tests 与迁移 fixture

**目标形状**:

```ts
type ModelInputBudgetEvidenceV2 =
  Omit<ModelInputBudgetProofV1, "version" | "proof_digest"> & {
    version: "model_input_budget_evidence.v2";
  };

type ModelExecutionBudgetEvidenceV3 = {
  version: "model_execution_budget_evidence.v3";
  estimator_version: string;
  render_contract_version: string;
  router_version: string;
  prompt_sha256: string;
  rendered_input_sha256: string;
  estimated_prompt_tokens: number;
  estimated_rendered_tokens: number;
  input_chunk_count: number;
  input_delivery_overhead_tokens: number;
  output_reserve_tokens: number;
  max_candidate_tokens: number;
  effective_body_limit_tokens: number;
};
```

**实现约束**:

- Read-side validator 逐字段验证版本、有限整数和 `effective_body_limit` 计算关系，不再对小 proof 对象整体求摘要。
- Executor-side verify 使用当前 semantic prompt/rendered input 重新估算，并把完整 evidence 字段直接比较；prompt/rendered-input hash 继续避免在 proof 中复制大型正文。
- Task/lease/mailbox/metrics/quality 只绑定 work unit、input hash、当前显式 policy 字段、attempt/epoch/revision；`proof_digest` 不再成为语义 artifact 或 candidate 身份。H3 再把 policy 字段收敛为显式 generation + semantic contract。
- Estimator、reserve 或 transport limit 变化会改变下一次 routing/claim 结果，但不会让 source/input/prompt/semantic contract 仍相同的 accepted artifact stale。
- Plan budget 授权直接绑定 `plan_id + plan_revision` 及计划内预算字段；删除 preflight evaluation/receipt digest，不增加新的 receipt id 包装层。
- V2 proof 只由迁移 fixture 读取；真实 descriptor/lease/artifact 的切换推迟到 R8 单独授权。

**不做**:不放宽 token/byte/candidate 上限，不删除 prompt/rendered-input/input 内容 hash，不改变超预算时的 `needs_user/blocked` 动作，不在 artifact 中复制完整模型输入。

**完成判据**:H0 budget 红测转绿；同一 evidence 任一原字段漂移仍直接失败；claim 对当前正文重算；仅 estimator/reserve 变化不再触发语义 stale；V2 fixture 迁移后语义 freshness 只由 source/input/prompt/semantic contract 决定。

**实施证据**:`ModelInputBudgetEvidenceV2`、`ModelExecutionBudgetEvidenceV3`、Preflight/plan-budget V2 evidence 已改为逐字段验证与直接比较；task/lease/mailbox/metrics/quality/orchestrator 不再传播 `proof_digest`，plan-budget 授权绑定 `plan_id + plan_revision`，prompt/rendered-input 大正文 hash 保留。Core H2 合同六文件 43/43、传播面九文件 80/80、driver H2 过滤 4/4、lease 12/12、Core typecheck 与定向 `git diff --check` 全绿；V1/V2 migration 仅由 synthetic fixture 覆盖，未读取或写入真实书状态。

### H3 Policy generation 去套娃

状态:已完成（2026-08-30）。

**做**:用显式 `stage + policy_generation_id + semantic_contract` 取代 policy/policy-set 及 migration receipt/resolution 的摘要链。

**触达**:

- `packages/core/src/automatic-build-policy-generation.ts`
- `packages/core/src/semantic-artifact.ts`
- `packages/core/src/stage-work-unit.ts`
- `packages/core/src/automatic-build-quality.ts`
- `packages/core/src/automatic-build-close.ts`
- 相关 router/reduction consumers、policy generation tests 与一次性迁移 fixture

**目标身份**:

```ts
type PolicyGenerationIdentityV1 = {
  stage: SemanticBuildStage;
  policy_generation_id: string;
};

type SemanticContractV1 = {
  profile_version: string;
  stage_policy_version: string;
  router_version: string;
  prompt_sha256: string;
  schema_version: string;
  quality_profile: string;
};
```

**实现约束**:

- `policy_generation_id` 由 policy owner 显式签发并作为目录代际；同一 id 下 semantic contract 逐字段直接相等，不由 hash-of-fields 反推 generation。
- 单个 policy member 变化只影响使用该 member 的 work unit；删除 `policy_set_digest` 对整 stage 的连坐失效。
- Migration receipt 直接保存 from/to generation、work-unit kind、input hash、decision/reason 与必要的 bounded evidence refs；删除 `current_route/current_policy/current_proof/receipt/resolution/evidence` digest。
- Adopted artifact 已完整读取并解析时直接验证 envelope/work-unit 与保留的 `artifact_hash`；删除其外层 `file_sha256`。
- Semantic artifact 保留 input hash、一次 prompt hash、semantic contract 与自身 artifact hash；不再携带 budget proof 或 policy-set 摘要。
- 本切片只运行 synthetic migration fixture；用户当前 policy locks、receipts 与 artifacts 到 R8 授权后才前向切换。

**不做**:不删除 source/input/prompt/artifact hash，不改变 schema/LID/evidence/quality gate，不为 policy generation 新建通用迁移框架。

**完成判据**:H0 policy 红测转绿；同 generation 不同 semantic contract 直接失败；仅其他 policy member、budget estimator 或 reserve 变化不使本 work unit stale；receipt replay 与 adopted-artifact 判断不依赖任何外层摘要。

**实施证据**:stage/task/attempt/lease 已绑定 owner-issued `policy_generation_id + semantic_contract`，generation-specific lock 直接比较语义合同；migration receipt/resolution 保存 from/to generation、work-unit/input 与 decision/reason 原字段，adopted artifact 直接核对 envelope/work-unit 和保留的 `artifact_hash`，不再依赖 policy/policy-set/route/proof/receipt/resolution/evidence/file 外层摘要。Synthetic migration、routing/reduction、artifact freshness、quality/close 与 legacy batch 验收 14 文件 77/77，Core typecheck 与 H3 定向 `git diff --check` 全绿；未读取或迁移真实 policy lock、receipt 或 artifact。

### H4 Executor Transport/Session V3

状态:已完成（2026-08-30）。

**做**:删除 transport/profile/chunk/pack/ledger/output-contract 摘要链，用原值、ordinal/range、长度与显式 schema version 保留同一有界传输行为。

**触达**:

- `packages/core/src/executor-transport.ts`
- `packages/core/src/model-input-budget.ts`
- `packages/core/src/automatic-build-executor-session.ts`
- `packages/core/src/build-executor-tool-contract.ts`
- `packages/core/src/build-executor-tool-adapter.ts`
- `skills/build/build-executor-mcp.ts`
- 对应 transport/session/MCP/budget tests

**目标形状**:

```ts
type ExecutorTransportProfileV2 = {
  version: "executor_transport_profile.v2";
  max_tool_result_tokens: number;
  max_tool_result_bytes: number;
  result_envelope_reserve_tokens: number;
  max_input_chunks: number;
  max_candidate_request_tokens: number;
  max_candidate_request_bytes: number;
};

type ExecutorInputChunkV3 = {
  ordinal: number;
  byte_range: { start: number; end: number };
  payload_utf8: string;
  final_for_segment: boolean;
  final_for_generation: boolean;
};

type ExecutorInputNextV3 = {
  opaque_session_ref: string;
  generation_input_ref: string;
  previous_chunk_ordinal?: number;
};
```

**实现约束**:

- Pack validator 直接检查 chunk ordinal 连续、byte range 连续、UTF-8 byte length、final 位置、token/byte 上限，并拼接 payload 与 server-owned prompt/input 原文直接相等。
- Response measurement 直接比较 canonical serialized response、bytes、tokens 与 envelope overhead；删除 serialized-response hash。
- Delivery receipt 只记录 session/input ref、ordinal 与时间；grant 绑定 `final_delivered_ordinal` 和显式 `output_schema_version`。
- Segment 级 semantic prompt/input content hash、published handoff content hash 与 candidate content hash 继续作为大型正文身份；chunk/pack/ledger 不再逐层复制它们的摘要。
- Opaque ref 继续是有界 locator；允许从直接身份字段派生 ref，但不得把派生方式投影成 transport 完整性或 caller-role 证明。
- Tool names 保持 exact-four，session version 升为 `automatic_build_executor_session.v3`；所有 active V2 response/request 字段测试改为 V3。
- 当前 public issuer 直接写 Session V3 handoff record；legacy V1/V2 record 只由历史 reader 读取或拒绝，不提供 supersession writer，也不标记、换发或改写真实旧 handoff。

**不做**:不删除 semantic source/input/artifact/prompt/published-handoff/candidate 内容 hash，不放宽 byte/token cap，不改变 candidate schema、lease、attempt、owner generation 或 mailbox 写入语义。

**完成判据**:H0 transport 红测转绿；原 payload/response/range/ordinal/schema 任一实际不匹配仍确定性失败；仅摘要字段变化不再存在测试分支；新 public dispatch 直接签发无 predecessor 字段的 V3 ref，用户真实旧 handoff 零写入。

**实施证据**:transport profile/pack/response 已按显式 V2 profile 与 Session V3 的 ordinal、byte range、UTF-8 长度、拼接原文和 schema version 直接验证；public delivery/session、exact-four tool schema、thread-owned stdio connection 与 MCP 载体均使用 V3 request/response，delivery receipt 只保存 session/input ref、ordinal 与时间，grant 绑定 final ordinal 和 output schema。R8 修订后 current public issuer 直接生成 V3 locator，zero-open supersession API 与 synthetic 转换步骤已删除；legacy V1 测试记录只由 test fixture 播种，未扫描、标记或换发任何真实 ref。定向 V3 4/4、driver rehydrate 1/1、private S4 2/2、compiled T7 executor smoke 与 Core typecheck 全绿。

### R3 共享注册与插件 launcher

状态:已完成（2026-08-30）。

**做**:把 Executor MCP transport 移到根/发布插件 `.mcp.json`，并新增插件自有 Windows launcher。

**触达**:

- `.mcp.json`
- `plugins/understand-book/.mcp.json`
- 新增 `scripts/start-build-executor-mcp.cmd`
- 新增 `plugins/understand-book/scripts/start-build-executor-mcp.cmd`
- `.codex/agents/understand-book-executor.toml`
- `assets/codex-agents/understand-book-executor.toml`
- `plugins/understand-book/assets/codex-agents/understand-book-executor.toml`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**实现约束**:

- Launcher 只按 `UNDERSTAND_BOOK_BUILD_EXE` → Setup `HKCU\Software\UnderstandBook\InstallDir\understand-book-build.exe` 解析 executable。
- Launcher 固定调用 `executor.mcp --bootstrap-version automatic_build_executor_bootstrap.v3 --protocol-generation automatic_build_executor_session.v3`，stderr 只给有界启动诊断。
- Root/release `.mcp.json` 字节等价；root/release launcher 字节等价。
- Agent 三投影字节等价且完全删除 MCP 段、transport 启动参数与 tool allowlist；角色正文仍保留 exact-four 使用合同。
- Registration/release 输出不再包含 template/skill/manifest/sidecar snapshot hash；同次验收直接比较规范化全文、原始字节或执行后的结构化字段。
- Book MCP 配置与 launcher 不变。
- `required=false` 明写；binary 不可用时普通 root session 可继续，构建路径失败关闭。

**不做**:不改用户 `config.toml`，不静默注册/覆盖 custom agent，不合并 Book/Executor 两个进程，不把 executable 打包进 Git 插件。

**完成判据**:R1 的配置/asset/red release 断言转绿；插件 loader 能解析两 server；裸 MCP `initialize + tools/list` 只列四个 Executor 工具；缺 binary 的普通 plugin inventory 不被 required server 拖垮。

**实施证据**:根与发布 `.mcp.json` 已字节等价地登记 `required=false`、exact-four、approve、固定 timeout/env 的 shared Executor server；双 launcher 按环境变量后 Setup registry 的顺序解析 binary，固定传 Bootstrap V3 + Session V3，缺 binary 以 code 2 和单行有界 stderr 失败。三份 Agent 资产字节等价且零 local MCP/transport 参数/allowlist；定向 R3 配置、Agent 与 launcher 6/6、裸 MCP 4/4、Core typecheck 和目标 `git diff --check` 全绿。相关两文件全量为 22 绿，剩余 4 红均落在 R4 root 禁调用/source gate、R6 release snapshot 输出和 R7 trace 风险字段；真实 handoff、session、书状态与用户配置零读写。

### R4 角色投影与 Root 非调用合同

状态:已完成（2026-08-30）。

**做**:同步 canonical Executor wrapper、custom agent、fallback skill、register skill 与 root build skill 的新边界措辞。

**触达**:

- `agents/automatic-build-dispatch-executor.md`
- `.codex/agents/understand-book-executor.toml`
- `assets/codex-agents/understand-book-executor.toml`
- `plugins/understand-book/assets/codex-agents/understand-book-executor.toml`
- `assets/codex-agents/understand-book-executor.known-predecessor.toml`
- `plugins/understand-book/assets/codex-agents/understand-book-executor.known-predecessor.toml`
- `skills/executor/SKILL.md`
- `plugins/understand-book/skills/executor/SKILL.md`
- `skills/build/SKILL.md`
- `plugins/understand-book/skills/build/SKILL.md`
- `skills/register-executor/SKILL.md`
- `plugins/understand-book/skills/register-executor/SKILL.md`
- `scripts/register-executor-agent.ps1`
- `plugins/understand-book/scripts/register-executor-agent.ps1`
- `apps/desktop/scripts/assert-plugin-release.mjs`
- 相关 bootstrap/prompt/handoff tests

**实现约束**:

- Wrapper 删除“agent-only stdio connection owns authorization”，改为“stdio state machine enforces direct phase/ordinal/schema checks but does not authenticate caller role”。
- Executor 角色仍只能调用 exact-four，不得 shell/files/skills/other MCP，不得把 chunk/candidate 放入 final。
- Root skill 在进入 action loop 前及 hard boundaries 各有一处明确禁令；不得调用、probe、枚举或用四工具诊断 handoff。
- `SPAWN_EXECUTORS` 仍 custom-agent-first、executor-skill fallback；payload 仍只有 exact ref 与 bounded final 要求。
- Register skill/script 继续只做 custom-agent role 注册，文档明确 transport 随已启用插件进入 parent；absent/same 语义不变，未知正文仍 conflict-no-overwrite。
- 发布包携带当前已发布 agent-only 模板的完整前代正文，只在用户显式选择 `-MigrateKnownPredecessor` 且现文件规范化全文与该正文直接相等时迁移；规范化只把 CRLF/CR 统一为 LF。迁移先按原始字节在固定同目录 create-only 备份路径写入；已有备份必须与原始字节直接相等才可幂等复用，冲突备份或任一步失败保持原文件。输出只含 `source_state="known_predecessor"`、`target_version`、`backup` 与 `new_task_required`。
- Root/release skill、agent/asset、fallback projection 的完整正文/字节 parity 保持；复制完成后不重哈希，读取目标并直接比较原始字节。
- Register receipt 不再返回 `digest`；只返回 source state、目标版本、备份路径与是否需要新 task。

**不做**:不把 V3 stdin schema复制到 root，不删除 fallback skill，不让 root 在 provider 缺失时自执行，不改变 max parallel 或 wait-first-terminal 算法。

**完成判据**:全文投影测试转绿；静态扫描找不到旧 `agent-only`/root-negative 安全声明；root build skill 中四个禁用调用名各出现且早于 action loop；absent/same/known-migrate/unknown-conflict 四态注册测试全绿；既有 spawn payload shape 测试保持绿。

**实施证据**:canonical wrapper、双 executor fallback、三 role-only Agent 与双 root build skill 已前向到 Session V3；stdio 文案只声明 phase/ref/ordinal/schema 原值检查并明确不鉴别 caller role，root 在 action loop 前和 hard boundaries 各明禁四个工具，custom-agent-first/fallback payload 与 first-terminal 算法不变。双 register skill/script 只注册角色，使用 current/known-predecessor 两份随包全文做 LF-only 规范化比较；synthetic absent、CRLF same、未授权前代拒绝、create-only 原始字节备份、显式前代迁移、未知正文与冲突备份不覆盖均通过。Prompt 6/6、角色/注册/构建定向 13/13、七组原始字节 parity 与 Core typecheck 全绿；source gate 已穿过 R4 并按计划首停于 R7 trace 风险字段，R6 snapshot 输出与 R7-R8 仍未收口，真实用户配置、handoff/session 与书状态零读写。

### R5 Doctor 与证据语义迁移

状态:已完成（2026-08-30）。

**做**:让 protocol doctor 和 release projection 报告真实的共享能力边界，而非继续输出旧 PASS。

**触达**:

- `skills/build/automatic-build.ts`
- `packages/core/src/automatic-build-protocol.ts`
- `packages/core/test/automatic-build-release.test.ts`
- `packages/core/test/automatic-build-release-v3.test.ts`
- 相关 protocol doctor fixtures/snapshots
- `skills/build/book-structure-batch.ts`
- `packages/core/test/build-orchestrator.test.ts`
- `apps/desktop/scripts/smoke-t7-executor-release.ts`
- `apps/desktop/scripts/smoke-t7-codex-cli-release.ts`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**目标检查形状**:

```ts
checks.executor_role = {
  status: "compatible",
  agent_name: "understand_book_executor",
  mcp_servers_in_role: 0
};

checks.shared_executor_mcp = {
  status: "compatible",
  registration_scope: "root_shared",
  bootstrap_version: "automatic_build_executor_bootstrap.v3",
  session_protocol: "automatic_build_executor_session.v3",
  required: false,
  default_tools_approval_mode: "approve",
  executor_tool_count: 4
};

checks.connection_integrity = {
  status: "compatible",
  model_parameter: false,
  caller_role_authenticated: false,
  cross_handoff_rejected: true,
  session_private_root_bound: true,
  forbidden_digest_field_count: 0
};

checks.semantic_reuse_identity = {
  status: "compatible",
  budget_proof_is_freshness_identity: false,
  policy_generation_is_explicit: true,
  large_content_hash_consumers_present: true
};
```

**实现约束**:

- 删除 `root_tool_inventory.server_registered=false` 与 `executor_tool_intersection=[]` 的通过语义。
- 缺 shared server、工具不是 exact-four、`required=true`、`default_tools_approval_mode!="approve"`、role 仍含 MCP、bootstrap/session version 不符或 active control/budget/policy/transport/evidence schema 含 H0 禁止字段均 fail closed。
- `caller_role_authenticated=false` 是兼容成功的一部分，不能因其为 false 判失败；它是诚实风险字段。
- 静态 doctor 不声称 root 零调用；root/非 Executor child 的 dispatch-attempt 与 backend-call 计数只由 thread-aware live smoke 生成。
- 历史 V2/root-negative evidence 保持只读，不覆盖成 V3 PASS。

**不做**:不从 root 调用 Executor 做 live preflight；不读取任何真实 handoff；不将 trace body写入 doctor output。

**完成判据**:源码与 compiled Sidecar doctor 都返回 V3/shared/semantic-reuse 字段；scope、required、allowlist、bootstrap version、session version、launcher、role MCP 段、budget/policy generation 或直接正文不匹配的 fixture 各有一个确定性失败测试；没有 digest-tamper fixture。

**实施证据**:`automaticBuildProtocolDoctor` 已删除旧 `executor_bootstrap/root_tool_inventory/connection_capability` PASS，改由 role-only Agent、root/release `.mcp.json`、双 launcher 原文、Bootstrap/MCP/transport 直接常量、thread-owned stdio 行为与 release policy member 共同产生四块 V3 检查；active release projection 同步直报 policy-set V3、migration-receipt V2 与 close-result V2；`caller_role_authenticated=false` 作为 compatible 风险事实，静态输出不声明 root 零调用。十个负向 fixture 分别覆盖 shared scope、required、exact-four、bootstrap/session、launcher、role-local MCP、budget proof 字段、显式 policy generation 与投影正文失配，没有篡改摘要值。Compiled executor smoke 已前向到 Session V3 ordinal/grant/candidate 请求并输出 direct transport profile；Codex CLI smoke 改验 shared server、注册原始字节与 exact-four，二者均明写 capability isolation false 且不输出 manifest/skill/sidecar/root-final snapshot hash。扩展验证发现 BookStructure close 仍从 generation wrapper 读取已迁出的字段；现改为读取 `generation.task.policy_generation_id`，原受支持场景由红转为 14/14。Release 20/20、prompt 6/6、BookStructure/orchestrator 14/14、Core typecheck、source release gate 与 R5 定向 `git diff --check` 全绿；未运行 R6 compiled parity、R7 live trace 或任何真实 handoff/session/书状态。

### R6 静态与 compiled 发布门

状态:已完成（2026-08-31；R8 预置红与 Vitest worker RPC 限制按下述证据隔离）。

**做**:完成 source、Sidecar、thin-plugin 与 launcher 的确定性 parity，不启动真实 Codex semantic task。

**自动验证**:

```powershell
pnpm -C packages/core test
pnpm -C packages/core typecheck
cargo test -p server
node apps/desktop/scripts/assert-plugin-release.mjs --source-contract-only
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
```

**验收面**:

- Root/published `.mcp.json` 与两个 launcher 精确 parity。
- Agent 三投影无 MCP；register absent/same/conflict 仍绿。
- Sidecar `executor.agent-template` 输出 role-only V3 模板。
- Sidecar `executor.mcp` 接受显式 Bootstrap V3 + Session V3，列出 exact-four，拒绝 V2 version 或未知字段。
- Shared server optional；Book MCP 不受影响。
- No-source thin plugin 不访问 repo `agents/`、`packages/core/src` 或 cwd fallback。
- 所有 revision/budget/policy/ref/phase/ordinal/grant/sink/candidate/recovery 行为测试绿；旧 V2 文件只作为迁移前历史 fixture，不进入 active server。
- Release assertion 直接比较安装文件/字段并执行 compiled Sidecar；stdout/evidence 无 skill/manifest/sidecar/root-final snapshot hash。

**不做**:不更新 marketplace/cachebuster，不启动 Codex child，不消费当前失败任务。

**完成判据**:上述命令全部 exit 0；`git diff --check` 通过；静态扫描只允许历史 ADR/切片保留旧 `agent_only/root-negative` 叙述，现行源码、asset、skill 与 release assertion 不得保留。

**实施证据**:source gate、重建后的 383-module compiled Sidecar、仓外 cwd thin-plugin Node/Sidecar parity 和 full compiled release assertion 均 exit 0；MCP config、launcher 与 Agent template 以字段或原始字节直接比较，compiled synthetic Executor 使用 Bootstrap/Session V3 exact-four，evidence 不输出 skill/manifest/sidecar/root-final snapshot hash。R6 还修复了 source fingerprint 变化时旧 snapshot recovery 错入 public freshness、optional Sidecar boundary asset 让 doctor 抛异常，以及显式 policy generation 变化的 `retry_current` 被旧 plan 内容比较误拦三条受支持回归。Core typecheck、`cargo test -p server`（231 + 5）与 source-change 7/7 全绿；Core 的 822 个非 R8 用例全部通过，因单文件 99 秒会触发 Vitest 3.2.6 不可配置的 60 秒 `onTaskUpdate` RPC，最终以 112 文件 794 项 exit 0 加 Executor Session 15 + 7 + 6 三段 exit 0 验收，checkpoint 点名的两个 S4 private-artifact 用例继续留给 R8。静态扫描命中仅为 removed-marker/negative evidence guards；未启动 Codex child，未读取或修改真实 handoff/session/书状态，R7 installed trace 与 R8 真实迁移仍冻结。

### R7 Codex 0.149 安装态黑盒

状态:已完成（2026-08-31；Codex CLI `0.149.0-alpha.4.3` 隔离安装态）。

**做**:在隔离 `CODEX_HOME` 和仓外工作目录安装新 thin plugin、注册 role-only custom agent，验证 parent 共享 inventory 与 child 继承的真实调用路径。

**前置**:

1. H0-H4 与 R1-R6 全绿并生成新的 plugin cachebuster 候选，但尚不触碰用户真实安装。
2. 使用 synthetic registry/task，semantic body 只含唯一 sentinel，不含书、goal、LID 或 reader-private 数据。
3. 新 task 启动后记录精确 Codex 版本；必须覆盖本次故障版本族 `0.149.x`。
4. 启动 task 前把 `CODEX_ROLLOUT_TRACE_ROOT` 指向本次 smoke 独占的空目录；未生成唯一 root trace bundle 时场景直接失败。

**场景 A：安装态配置与 parent/child inventory**:

1. `codex plugin list --json` 只用于证明新插件已启用；待验证的安装根由本次隔离安装 harness 的已知目标解析，不依赖该命令是否序列化路径字段。
2. `codex mcp list --json` 含 `understand_book_build_executor`，只据此证明插件 server 已进入 parent effective catalog；该输出不用于证明 allowlist、`required` 或默认审批模式。
3. `codex mcp get understand_book_build_executor --json` 报告 exact-four `enabled_tools` 与固定 startup/tool timeout；该输出不用于证明它未序列化的 `required` 与 `default_tools_approval_mode`。
4. 对已安装插件的 `.mcp.json` 运行 R2/R6 同一 compiled static validator，证明 `required=false`、`default_tools_approval_mode="approve"`、exact-four、launcher/cwd 与 env surface；CLI 输出不得替代这一步。
5. 对已安装 Agent TOML 运行 role validator，证明 canonical role、两项 effective reduction 与零 agent-local MCP；随后 spawn `agent_type=understand_book_executor, fork_turns=none`。
6. reduced trace 把 child 归属为 `agent_role="understand_book_executor"`。`root_executor_tool_count=4` 由 installed `mcp get` allowlist 与 R6 server `tools/list` exact-four 合取；`child_executor_tool_count=4` 再合取零 agent-local MCP、配置继承和场景 B 对四工具的 backend 成功调用。Raw inference tool surface 与 Agent `ALL_TOOLS` 自述只可诊断，不单独计作 inventory 证据。

**场景 B：单 ref durable commit**:

1. Root 只 spawn child，不调用或 probe Executor。
2. Child 首个 Executor dispatch 与首个到达 backend 的调用都必须是 `executor.open`，随后完成 input.next/grant/start/submit。
3. Durable state 显示一个 semantic attempt、一个 committed synthetic task。
4. Root final 只有固定 bounded marker；root/stderr 无 sentinel、candidate 或 ref。

**场景 C：三 slot 继承与 first-terminal**:

1. Driver 返回三个 synthetic ref，root 同时最多 spawn 三 child。
2. 每个 child 只继承 server 注册/配置，并从 unopened phase 建立独立 stdio process/connection；不得复用 parent 或 sibling 的 MCP runtime、session/ref 状态。
3. 任一 child terminal 后 root 立即 `build.step`，不等待整 wave 后才重读。
4. 第四个 pending unit 只能在 slot 释放后启动，证明并发 3 与生命周期复用未变。

**Thread-aware 负向断言**:

- 场景结束后必须执行 `codex debug trace-reduce <trace-bundle>`；确定性 analyzer 读取 `state.json` 与其引用的 raw payload，不解析 Agent 自述。
- Thread 归属以 `state.json.threads` 的 root/spawned provenance 与 `agent_role` 为准；工具归属以 `tool_calls[*].thread_id` 为准。
- Executor dispatch attempt 由 `tool_call.raw_invocation_payload_id` 指向的 `{tool_namespace, tool_name}` 是否命中场景 A 冻结的四个 Executor callable definitions 判定，不要求已有 `mcp_call_id`；这样 backend 前失败/拒绝的尝试也不会漏计。
- Executor backend call 是上述 dispatch 中 `mcp_call_id != null` 且 runtime begin payload 的 `invocation.server == "understand_book_build_executor"`、`invocation.tool` 属于 exact-four 的子集。0.149 reduced `kind` 可能仍是 `other`，不得依赖 `kind.type == "mcp"` 计数。
- Parent/root thread 的 Executor dispatch-attempt 与 backend-call 数都精确为 0。
- 任何非 `understand_book_executor` child 的 Executor dispatch-attempt 与 backend-call 数都精确为 0。
- 只有 dedicated child thread 出现 open/input/start/submit dispatch 与 backend call；其 first dispatch 和 first backend call 都是 `executor.open`。
- Sentinel 只允许出现在 child input-next result 或 child submit request 的预定 trace shape。
- 证据序列化后不包含 sentinel、ref、registry root、Codex home、workspace path 或 candidate body。
- Evidence 明示 `capability_isolation=false`、`caller_role_authenticated=false`，不得写 `root isolation verified`。
- Evidence 明示 `session_protocol="automatic_build_executor_session.v3"`、`forbidden_digest_field_count=0`、`budget_proof_is_freshness_identity=false`，不得序列化 config/file/manifest/sidecar/root-final snapshot hash。
- 缺 trace bundle、reducer 失败、thread/role 无法归属、MCP correlation 或 runtime invocation 缺失时，结果必须是 `root_executor_boundary_unverifiable` 并使 R7 失败，不能把“未观察到”计作 0。

**不做**:不在源码 cwd 跑，不借用预先存在的用户 agent/config，不读取当前真实 handoff，不用 root 自调来证明 server 可用。

**完成判据**:场景 A-C 全绿并产生 `understand_book_root_shared_executor_evidence.v1`；安装包隐藏配置字段由 compiled static validator 判定，root/child inventory 由 installed CLI 配置、R6 server `tools/list` 与 child backend 成功调用的上述合取判定，零 dispatch attempt、零 backend call、child 首 dispatch/首 backend call 与敏感信息去向由 reduced rollout trace analyzer 判定，durable commit 由 synthetic registry state 判定。各证据面不得互相冒充。

**实施证据**:从只含 `auth.json` 的隔离 `CODEX_HOME` 安装 thin plugin、注册 role-only Agent，并在仓外 cwd 对 Codex CLI `0.149.0-alpha.4.3` 完整执行 A-C，最终生成 `understand_book_root_shared_executor_evidence.v1` 且 exit 0。场景 B 为 1 semantic attempt/1 durable commit；场景 C 为 4/4、最大 live child=3，parent 先从 `list_agents` 观察到初始 wave 的 partial terminal 再重读 synthetic driver，第四 child 在首个 thread end 后、最后一个初始 thread end 前启动，累计观察四 child terminal 后才请求 DONE。Reduced trace 证明 root 与非 Executor child 的 Executor dispatch/backend 均为 0，专用 child 首 dispatch/首 backend 均为 `executor.open`，四工具全部成功，四个 sentinel 只命中 input/submit、专用 child inference 与等值 bounded response wrapper。0.149 对内建 `exec_command` 允许 `tool_namespace=null`，但任何 Executor-shaped invocation 缺 namespace 仍记不可验证；较早 terminal Agent 会从后续 live inventory 裁剪，因此 parent terminal 观察以显式 `completed` 或“先 running、后从完整 live inventory 消失”累计，成功仍只由独立 durable 4/4 判定。Synthetic driver 仅由隔离 home 的精确 exec-policy 放行 `initial/refill/done` 三种只读命令；真实 handoff/session/书状态、用户配置、cachebuster 与 R8 恢复零触达。验证包括 R7/Agent 26/26、Core typecheck、source release gate 与全工作树 `git diff --check`。

### R8 守卫恢复与发布收口

状态:按发布接管边界重写，待实施；用户已授权换代后改跑一份新的 `standard_deep` 目标，精确 BuildPlan 仍须按 build skill 单独确认。

**做**:发布新 cachebuster、安装新 plugin/role，启动新 parent task 并通过 synthetic doctor；旧 V1/V2 控制历史保持只读，新的已确认 BuildPlan 与 Session V3 接管后续执行。只按语义复用身份引用仍有效的 accepted artifact，不迁移旧 control envelope。

**发布触达**:

- `.codex-plugin/plugin.json`
- `plugins/understand-book/.codex-plugin/plugin.json`
- `.agents/plugins/marketplace.json`
- `docs/架构.md`
- `docs/代码链路.md`
- `SESSION_CHECKPOINT.md`（仅在 C4 条件成立时整页覆写）
- 安装态 evidence 输出位置

**发布接管形状**:

```text
install new plugin cachebuster
  -> migrate only an exact known predecessor role, with backup
  -> start a new parent task
  -> run synthetic Session V3/exact-four doctor
  -> leave old plan/budget/policy/lease/dispatch/close/session/receipt bytes unchanged
  -> author one current standard_deep plan
  -> require exact plan confirmation
  -> create one V3 invocation
  -> canary one executor
  -> fill at most three live executor slots after durable reread
```

**执行步骤**:

1. 用正式 cachebuster 安装插件；已注册的精确已知 agent-only 前代只经显式、备份式全文比较迁移更新为 role-only Agent，任何未知正文仍不得覆盖。
2. 关闭旧 parent task，启动新 task，证明 plugin MCP 与 role 均重新加载。
3. 运行 synthetic、无语义 doctor；Bootstrap V3、Session V3、shared/connection direct checks、显式 semantic reuse identity 与 `forbidden_digest_field_count=0` 全绿才允许请求真实恢复授权。
4. 对本次新目标调用 code-owned `legacy-plan`；Pass2、预算、reuse/create/excluded work、估算、`plan_id` 与 `plan_digest` 只按 skill 的有界 projection 展示，等待用户精确确认，opaque `build_plan_path` 不进入聊天。
5. 确认后创建 `max_parallel=3` 的当前 invocation；不读取、改写、supersede 或关闭旧目标的 V1/V2 handoff/session/attempt/receipt。
6. 首次向 `build.step` 报一个可用 slot 作为 canary；一个 durable commit 后按实时容量补到最多三 child，并在每个 first-terminal 后立即重读 durable state。
7. 任何仍匹配 source/input/prompt/semantic-contract 的 accepted artifact 由现行引擎自然复用；派生 close/freshness/policy projection 从当前事实重算，不为旧 envelope 建迁移器。
8. 全程扫描 root trace；一旦 root Executor 调用或敏感正文命中，立即停止后续 wave。

**不做**:不原地迁移 V1/V2 plan、budget proof、policy、lease、dispatch、close result、handoff 或 opened session；不删除历史 handoff/session/receipt，不覆盖 accepted artifact，不把 generation.start 已发生的 attempt 重编号为未开始，也不把失败统一记 `writer_failed`。

**完成判据**:正式安装的 server/launcher/role 字段与 R7 已验证值直接相等；旧目标控制目录保持字节不变；新目标只有一个经精确确认的当前 plan/invocation；canary 和后续 wave 只通过 child 执行且 live child≤3；semantic attempt 只从被接受的 `generation.start` 增加；文档、代码链路、cachebuster 与 evidence 指向同一发布代际且不保存 snapshot hash。

## 5. 依赖与提交边界

```text
R0 decision/docs
  -> H0 HERO hash-utility red contract
  -> R1 shared-boundary red contract
  -> R2 Bootstrap V3 + split validators
  -> H1 explicit planning/control identities + one-shot forward migration
  -> H2 digest-free budget evidence + freshness separation
  -> H3 explicit policy generation + direct migration receipts
  -> H4 hash-free Transport/Session V3 + direct current V3 issuance
  -> R3 shared plugin MCP + launcher + role-only assets
  -> R4 wrapper/skills/root non-use contract
  -> R5 doctor/evidence semantics
  -> R6 deterministic source/compiled/thin-plugin gates
  -> R7 real Codex 0.149 installed-state synthetic smoke
  -> R8 release takeover + fresh V3 plan/run + release/docs closure
```

| Commit | 内容 | 必须为绿的判据 |
|---|---|---|
| 1 | R0 | 文档链接、术语、ADR revision、`git diff --check` |
| 2 | H0 | 保留 freshness/snapshot/replay 分支绿；control/budget/policy/transport 禁止字段按预期红 |
| 3 | R1 | 旧无关 suite 绿；共享边界新增断言只按预期红 |
| 4 | R2 | Bootstrap V3 显式字段、role/shared validators、connection behavior tests |
| 5 | H1 | context/intent/plan/blueprint 显式身份、synthetic 单次迁移、业务字段 parity |
| 6 | H2 | budget evidence 原字段重算；`proof_digest` 不再传播或决定 semantic freshness |
| 7 | H3 | policy generation/semantic contract 显式；receipt/resolution 无外层摘要 |
| 8 | H4 | Transport/Session V3 原值/ordinal/range/schema tests；无禁止摘要字段 |
| 9 | R3 | 双 `.mcp.json`、双 launcher、三 role-only Agent 资产 parity |
| 10 | R4 | canonical wrapper、executor fallback、root build、register skill parity |
| 11 | R5 | doctor/schema/evidence direct-mismatch fixtures，无 digest-tamper case |
| 12 | R6 | Core tests/typecheck、source release assertion、Sidecar/thin parity |
| 13 | R7 | 0.149 parent/child inventory、synthetic commit、thread-aware trace evidence |
| 14 | R8 | cachebuster、正式安装、synthetic doctor、精确确认后的新 V3 canary/wave、架构/代码链路 |

每片只依赖仓库文件和持久证据，不依赖当前聊天记忆。H0/R1 不顺带改生产；R2 不顺带搬配置；H1 不顺带改 budget/policy/transport；H2 不顺带改 policy/transport；H3 不顺带改 transport；H4 不顺带共享注册；R3 不顺带改 root prompt；R6 不用真实书验收；R7 不顺带迁移或恢复用户任务；R8 不把架构授权替代 code-issued BuildPlan 的精确确认，也不写旧目标控制状态。

## 6. 验证矩阵

| 维度 | 正向判据 | 负向判据 |
|---|---|---|
| HERO hash utility | 只有 source/input/prompt/artifact/payload/candidate/published-handoff 大正文身份与 opaque locator 派生值保留 | Active control/budget/policy/transport/evidence schema 的禁止 digest 字段数为 0 |
| Control identity | context/intent/plan/blueprint 使用 id + revision/version | 不用 digest 充当代际、确认令牌、目录键或兼容证明 |
| Budget evidence | proof 原字段在 claim/execution 重算；prompt/rendered input 大正文 hash 保留 | 无 `proof_digest`/plan-budget `preflight_evaluation_digest/receipt_digest`；estimator/reserve 不使旧 semantic artifact stale |
| Policy generation | `stage + policy_generation_id + semantic_contract` 直接比较 | 无 policy/policy-set/route/proof/receipt/resolution/evidence 外层 digest；一个 member 不连坐其他 work unit |
| Plugin ownership | `.mcp.json` 有 shared server，root/release parity | 用户 `config.toml` 无复制 transport |
| Server shape | compiled validator 验 `required=false`、`default_tools_approval_mode="approve"`、exact-four、timeout/env、Bootstrap V3 与 Session V3 | 不用 `mcp list/get` 伪证其未输出的隐藏字段；无额外工具、路径参数、caller-role 或 digest 字段 |
| Agent shape | 完整 canonical instructions；effective reductions 恰为 `shell_tool=false`、`apps=false`；三份资产 parity | 无 `[mcp_servers.*]`；不把 sandbox/approval/web-search/view-image/空 skills/非白名单 feature 写成 child 保证 |
| Agent registration | 同模板原始字节或规范化全文直接相等；已知前代正文显式备份迁移 | 不计算 template digest，不覆盖未知正文，不在 copy 后重哈希 |
| Parent inventory | `mcp list` 验 server 存在；installed `mcp get` allowlist 与 R6 server `tools/list` 合取为 exact-four | 不再要求 root-negative；不把 server list、raw inference surface 或 Agent 自述当完整 inventory |
| Child inventory | parent exact-four 再合取零 agent-local MCP、`fork_turns=none` 配置继承与四工具 backend 成功调用 | 不从 Agent TOML 新增 MCP；不以 Agent `ALL_TOOLS` 自述单独作证 |
| Connection ownership | child 继承 server 注册但各自拥有 thread-owned stdio process/connection | 不复用 parent/sibling MCP runtime、connection 或 session/ref 状态 |
| Trace attribution | `CODEX_ROLLOUT_TRACE_ROOT` bundle 经 `trace-reduce` 后完整关联 thread/role、`tool_call.thread_id`、dispatch invocation、`mcp_call_id` 与 runtime server/tool | 任一 join 缺失即 `root_executor_boundary_unverifiable`，不把缺证据计作零调用 |
| Root behavior | reduced normal-build trace 中 Executor dispatch-attempt 与 backend-call 数都为 0 | root 不 probe/open/input/start/submit，backend 前失败的 attempt 也不得漏计 |
| Other agents | 非 Executor child 的 Executor dispatch-attempt 与 backend-call 数都为 0 | 不向其他 child 转发 handoff；tool description 明禁调用 |
| Child behavior | first dispatch 与 first backend call 均为 open，随后按 Session V3 状态机 | 无 shell/file/path/candidate final |
| Transport directness | ordinal/range/UTF-8 长度、拼接 payload、serialized response、schema version 直接匹配 | 无 profile/payload/response/pack/ledger/output-contract digest |
| Capability truth | phase/ref/session/ordinal/grant/sink/private-root 直接检查全绿 | `caller_role_authenticated` 必须为 false；opaque ref 不作完整性证明 |
| Privacy | chunk/candidate 只在允许的 child trace shape | root/final/stderr/evidence 零敏感命中 |
| Integrity | Schema/LID/evidence/budget/quality/writer 门全绿 | 无跨 handoff、过期 generation 或任意写入 |
| Parallelism | live child ≤3，first-terminal 后 durable reread | 不一次创建 100 个顶层 task |
| Recovery | 旧 history/accepted artifact 只读保留，新确认 plan/invocation 直接使用 Session V3 | 不原地迁移、supersede、reset 或覆盖旧 control/session/attempt/receipt |
| Ordinary plugin use | Executor server 不可用不拖垮普通 root task | build path 必须有界失败，不由 root 代跑 |
| Evidence honesty | 写明 root/child 各 4、root calls 0、isolation false | 不出现“安全等价”“root capability isolated”或 skill/manifest/sidecar/root-final snapshot hash |

正式恢复条件是所有维度合取。Agent 自述、单次 `DONE`、静态工具名、裸 MCP 握手或 durable commit 中任一单项都不能替代 thread-aware 安装态证据。

## 7. 文件预算

预计新增:

```text
scripts/start-build-executor-mcp.cmd
plugins/understand-book/scripts/start-build-executor-mcp.cmd
docs/adr/0115-root-shared-executor-mcp-and-subagent-inheritance.md
docs/切片方案-root共享Executor-MCP注册与继承.md
安装态 synthetic evidence JSON（R7 时生成，路径由现有 performance/evidence 约定决定）
```

预计修改:

```text
CONTEXT.md
.mcp.json
plugins/understand-book/.mcp.json
.codex/agents/understand-book-executor.toml
assets/codex-agents/understand-book-executor.toml
plugins/understand-book/assets/codex-agents/understand-book-executor.toml
agents/automatic-build-dispatch-executor.md
skills/build/SKILL.md
plugins/understand-book/skills/build/SKILL.md
skills/executor/SKILL.md
plugins/understand-book/skills/executor/SKILL.md
skills/register-executor/SKILL.md
plugins/understand-book/skills/register-executor/SKILL.md
scripts/register-executor-agent.ps1
plugins/understand-book/scripts/register-executor-agent.ps1
packages/core/src/build-executor-connection-capability.ts
packages/core/src/build-executor-tool-adapter.ts
packages/core/src/build-planning-context.ts
packages/core/src/build-intent.ts
packages/core/src/build-intent-v2.ts
packages/core/src/build-intent-controller.ts
packages/core/src/artifact-blueprint.ts
packages/core/src/artifact-blueprint-registry.ts
packages/core/src/automatic-build-budget.ts
packages/core/src/automatic-build-policy-generation.ts
packages/core/src/semantic-artifact.ts
packages/core/src/stage-work-unit.ts
packages/core/src/automatic-build-task-store.ts
packages/core/src/automatic-build-lease.ts
packages/core/src/automatic-build-mailbox.ts
packages/core/src/automatic-build-metrics.ts
packages/core/src/automatic-build-quality.ts
packages/core/src/automatic-build-close.ts
packages/core/src/automatic-build-dispatch.ts
packages/core/src/automatic-build-dispatch-runtime.ts
packages/core/src/build-orchestrator.ts
packages/core/src/book-structure-generation.ts
packages/core/src/pass1-reduction.ts
packages/core/src/profile-sidecar-reduction.ts
packages/core/src/intent-artifact.ts
packages/core/src/intent-artifact-mailbox.ts
packages/core/src/executor-transport.ts
packages/core/src/model-input-budget.ts
packages/core/src/automatic-build-executor-session.ts
packages/core/src/build-executor-tool-contract.ts
crates/server/src/build_intent_api.rs
crates/server/src/intent_build_store.rs
skills/build/automatic-build.ts
skills/build/automatic-build-driver.ts
packages/core/test/build-resume.test.ts
packages/core/test/semantic-artifact.test.ts
packages/core/test/model-input-budget.test.ts
packages/core/test/automatic-build-budget.test.ts
packages/core/test/automatic-build-policy-generation.test.ts
packages/core/test/automatic-build-mailbox.test.ts
packages/core/test/automatic-build-close.test.ts
packages/core/test/automatic-build-quality-v2.test.ts
packages/core/test/intent-artifact-mailbox.test.ts
packages/core/test/build-intent-v2.test.ts
packages/core/test/executor-transport.test.ts
packages/core/test/automatic-build-executor-session.test.ts
packages/core/test/codex-executor-agent.test.ts
packages/core/test/build-executor-tool-adapter.test.ts
packages/core/test/build-executor-mcp.test.ts
packages/core/test/automatic-build-release.test.ts
packages/core/test/automatic-build-release-v3.test.ts
apps/desktop/scripts/assert-plugin-release.mjs
apps/desktop/scripts/smoke-t7-executor-release.ts
apps/desktop/scripts/smoke-t7-codex-cli-release.ts
apps/desktop/scripts/smoke-workbench-sidecar.mjs
.codex-plugin/plugin.json
plugins/understand-book/.codex-plugin/plugin.json
.agents/plugins/marketplace.json
docs/架构.md
docs/代码链路.md
SESSION_CHECKPOINT.md（仅 C4 触发时）
```

明确不改:

```text
executor.open / executor.input.next / executor.generation.start / executor.submit_candidate names
BuildPlan 的业务内容、预算、依赖与授权语义；work-unit / lease / attempt / owner-generation / submit-revision 的行为语义
candidate mailbox 的代码所有/create-only 语义；Schema / LID evidence / budget / quality / writer 行为门
semantic extractor output schemas 与既有公共/reader-private artifact payload contracts；只重构其 identity envelope
source/model-input/window-content/prompt/artifact/payload/candidate/published-handoff 内容 hash 的真实 reuse/stale/snapshot/replay 消费者
opaque ref 的有界 locator 与幂等键语义（不把它升级为完整性证明）
一个 handoff 一个 child、fork_turns=none、max_parallel=3、最多 100 work units
用户书源、既有 accepted artifacts、历史 attempt/receipt/evidence
```

若 R1-R3 证明 Codex 0.149 插件 `.mcp.json` 不能被 spawned child 继承，立即退回 ADR-0115，不得在后续切片静默引入全局 config 写入、headless Codex 或 root 语义执行。

## 8. Definition of Done

```text
done =
  official_contract_and_0149_observation_are_distinguished
  AND plugin_owns_one_root_shared_executor_mcp
  AND shared_server_is_optional_for_ordinary_root_sessions
  AND shared_server_exposes_exactly_four_tools
  AND bootstrap_version == automatic_build_executor_bootstrap.v3
  AND session_protocol == automatic_build_executor_session.v3
  AND hero_hash_utility_gate_passes
  AND forbidden_control_budget_policy_transport_or_evidence_digest_field_count == 0
  AND control_identities_use_explicit_revision_version_or_generation
  AND budget_proof_is_not_semantic_freshness_identity
  AND policy_generation_and_semantic_contract_are_explicit
  AND policy_member_changes_do_not_invalidate_unrelated_work_units
  AND useful_large_content_hash_branches_are_unchanged
  AND release_snapshot_hashes_are_absent
  AND opaque_ref_is_treated_only_as_a_locator
  AND root_executor_tool_count == 4
  AND child_executor_tool_count == 4
  AND custom_agent_contains_no_mcp_server
  AND installed_server_cli_and_static_checks_cover_their_supported_fields
  AND spawned_children_inherit_registration_but_own_distinct_stdio_connections
  AND root_executor_dispatch_attempt_count == 0
  AND root_executor_backend_call_count == 0
  AND non_executor_child_executor_dispatch_attempt_count == 0
  AND non_executor_child_executor_backend_call_count == 0
  AND child_first_executor_dispatch == executor.open
  AND child_first_executor_backend_call == executor.open
  AND capability_isolation == false
  AND caller_role_authenticated == false
  AND canonical_role_instructions_projected == true
  AND projected_role_reductions == [shell_tool=false, apps=false]
  AND unprojected_agent_fields_claimed == false
  AND stdio_phase_ref_ordinal_grant_sink_direct_checks_pass
  AND executor_transport_profile_payload_response_pack_ledger_and_output_contract_digests_are_absent
  AND candidate_never_crosses_root
  AND root_and_stderr_sensitive_hits == 0
  AND max_parallel_and_first_terminal_semantics_are_unchanged
  AND source_compiled_thin_plugin_parity_passes
  AND codex_0149_trace_thread_role_mcp_attribution_is_complete
  AND codex_0149_installed_state_synthetic_trace_passes
  AND known_predecessor_role_migration_is_explicit_backed_up_and_atomic
  AND known_predecessor_and_installed_assets_are_compared_directly
  AND legacy_control_state_is_read_only
  AND accepted_artifacts_reuse_only_by_semantic_identity
  AND derived_control_projections_are_recomputed_for_the_current_plan
  AND no_v1_or_v2_handoff_or_opened_session_is_migrated_or_superseded
  AND the_current_build_plan_is_explicitly_confirmed
  AND the_new_invocation_uses_session_v3
  AND no_current_source_claims_agent_only_or_root_negative_isolation
```

任一项为 false，不得以“工具已经能看见”、root 亲自试调、agent 自述、一次 durable commit、公共产物无敏感数据或用户已接受风险为理由绕过。风险回执允许采用该架构，不取消诚实证据、正常路径零 root 调用或停止条件。
