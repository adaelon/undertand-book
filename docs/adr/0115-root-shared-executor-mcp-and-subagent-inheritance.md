# ADR-0115 Root-shared Executor MCP and subagent inheritance

Status: Accepted design, 2026-08-29; recovery boundary revised to release takeover, 2026-08-31; R0-R7 implemented, minimal R8 pending.
Revises: ADR-0093/0094/0096 的小型控制对象摘要身份、ADR-0100 的 budget proof freshness 绑定、ADR-0101 的 root 能力边界、ADR-0102 §2 的 Executor transport 注册位置、ADR-0103 的 policy-set generation 身份，以及 ADR-0114 §6-§8 的 root-negative、agent-only capability、transport 摘要与隐私证明。
Extends: ADR-0089, ADR-0099, ADR-0102 and ADR-0114.
Change type: [边界重构].

OpenAI 官方 Subagents 文档把 custom-agent TOML 描述为 spawned session 的配置层，允许其中包含 `mcp_servers`，也说明 agent 文件省略的 `mcp_servers` 从 parent 继承。本机 Codex Desktop `0.149.0-alpha.4.3` 的已验证实现只把 Agent TOML 投影到不含 `mcp_servers` 的 `AgentRoleOverrides`，于是 child 能获得角色指令和能力缩减，却不能新增 root 没有的 Executor MCP；三条失败 child 均在第一次 `executor.open` 前终止。公开合同与版本实测必须分别记录。[官方 Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[0.149 诊断记录](../../mcp%20debug.md)

用户已明确接受：正式架构允许 root 发现并在能力上调用四个 Executor 工具，不设置兼容模式；代价是 `root_toolset ∩ executor_tools = ∅` 的硬隔离失效，root 不调用改由指令合同、正常路径 trace 与 Build Engine 数据门禁约束。用户同时要求采用 HERO 哈希用途门，删除不代表大型内容身份、只包装小控制对象或执行证据的摘要层，并接受语义 freshness 分界与 Executor transport/session 的前向合同变化。

## §1 共享注册拓扑

**决策**:Executor MCP 在 parent/root 插件层登记。

**否决**:
- 继续只写 custom-agent TOML:0.149 的角色投影会确定性丢弃新增 `mcp_servers`。
- 复制到用户全局 `config.toml`:重复插件 transport 权威并制造安装漂移。
- 新增 headless supervisor:扩大进程、调度和恢复模型，超出本次最小修复。

**命门**:根与发布插件的 `.mcp.json` 是 transport 单一权威；在固定两版宿主中，Agent TOML 的 child 合同只依赖 canonical instructions 与白名单缩减 `shell_tool=false`、`apps=false`，其余资产字段不作为 effective child 保证。
**何时回头**:Codex 提供并验证 child-only capability delegation 后，可把 transport 移回专用角色而不改届时现行的 Session V3 四工具状态机。
**展开**:[R3 共享注册与 launcher](../切片方案-root共享Executor-MCP注册与继承.md#r3-共享注册与插件-launcher)

## §2 Root 非调用合同

**决策**:共享能力只供专用 child 调用。

**否决**:
- 把工具存在等同于 root 可执行协议:会让语义正文进入长生命周期 root 上下文。
- 由 root 做能力探测或 handoff 诊断:`executor.open` 可能领取租约并阻塞真正 child。
- 宣称与旧硬隔离安全等价:宿主没有可用于 MCP 鉴权的可信 caller role。

**命门**:Root 与非 Executor subagent 均明禁四工具；其存在只服务专用 child 继承，发布证据必须写明 `capability_isolation=false`。
**何时回头**:宿主向 server 提供不可伪造的 agent-role/parent-thread 身份时，在 server 入口拒绝 root 后重新声明能力隔离。
**展开**:[R4 角色指令与 root 禁调用](../切片方案-root共享Executor-MCP注册与继承.md#r4-角色投影与-root-非调用合同)

## §3 Bootstrap 身份

**决策**:Bootstrap 直接验证版本字段。

**否决**:
- 沿用 `registration_scope=agent_only`:证据会与实际安装态相反。
- 对小型 identity 再算 digest:直接比较字段更便宜且错误可诊断。
- 继续声明 Executor V2 字节不变:删除 transport 摘要后合同已经变化。

**命门**:`bootstrap_version`、`registration_scope`、`session_protocol` 与 exact-four 直接校验；角色模板和共享 MCP transport 验证拆开。
**何时回头**:只有字段集合或状态机变化时再升级显式版本，不恢复 digest 包装。
**展开**:[R2 Bootstrap V3](../切片方案-root共享Executor-MCP注册与继承.md#r2-bootstrap-v3-与验证器拆分)

## §4 连接与数据门禁

**决策**:连接状态按原值与序号直接验证。

**否决**:
- 把进程私有 symbol 当 caller-role 证明:root 自己的 stdio connection 也能获得同类 symbol。
- 仅凭 opaque handoff ref 授权:locator 不能替代 session、generation、lease、schema 与 owner-generation 校验。
- 对已有 payload、response、chunk、profile 或 ledger 再算摘要:不能避免重读或昂贵工作。

**命门**:Session V3 保留 ref、phase、ordinal、byte range、grant、sink、schema 与 owner-generation；拼接原文直接比较，不保留 transport/profile/pack/ledger/output-contract digest。大 prompt/input、published handoff 与 candidate 的内容哈希只有在替代复制完整正文并决定复用、拒绝或幂等 replay 时保留。
**何时回头**:可信 caller identity 可用后，把 role authorization 作为独立门；不恢复摘要守卫。
**展开**:[H4 Session V3](../切片方案-root共享Executor-MCP注册与继承.md#h4-executor-transportsession-v3)、[R5 Doctor](../切片方案-root共享Executor-MCP注册与继承.md#r5-doctor-与证据语义迁移)

## §5 语义隐私边界

**决策**:正常语义流仍只经过专用 child。

**否决**:
- Candidate 经 root 中转:污染主上下文并破坏代码所有 mailbox。
- 限定仅公共预构建:改变已确认的统一 public/reader-private 构建合同。
- 把 root 可调用风险写成已消除:指令和 trace 不能提供调用前的硬拒绝。

**命门**:Root 正常路径只持有 opaque ref；chunk 只进专用 child tool result，candidate 只进其 tool request 与私有 mailbox。该保证是行为合同，不是 capability 隔离。
**何时回头**:出现 root Executor 调用、语义正文进入 root trace，或 reader-private 边界要求能力级证明时，立即停止真实构建并重审架构。
**展开**:[R7 安装态黑盒](../切片方案-root共享Executor-MCP注册与继承.md#r7-codex-0149-安装态黑盒)

## §6 发布证据

**决策**:门禁改验共享可见与零 root 调用。

**否决**:
- 保留 root-negative 断言:会阻止本决策实现且伪造旧边界仍成立。
- 只验 child 有四工具:无法发现 root 亲自消费 handoff 的越界。
- 只信 Agent 自述:不能证明调用线程、durable commit 或敏感正文去向。

**命门**:0.149 安装态必须用 `CODEX_ROLLOUT_TRACE_ROOT` bundle 经 `codex debug trace-reduce` 归属 thread/role；dispatch invocation 负责计入 backend 前失败的尝试，非空 `mcp_call_id` 与 runtime server/tool 负责确认 backend 调用。Root/非 Executor child 两种计数均为 0，专用 child 首 dispatch 与首 backend call 均为 `executor.open`；caller-role 鉴权仍不存在。
**何时回头**:若 bundle/reducer 或任一归属 join 缺失，证据必须记 `root_executor_boundary_unverifiable`，不得把“未观察到”写成零调用或隔离已验证。
**展开**:[R6-R7 验收矩阵](../切片方案-root共享Executor-MCP注册与继承.md#6-验证矩阵)

## §7 发布接管边界

**决策**:旧控制状态只读，新 V3 计划接管。

**否决**:
- 原地迁移 V1/V2 plan、budget、policy、lease、dispatch、close 与 session:为一次本机换代建立永久兼容面。
- 把已打开 V2 session 伪装成未开始:其 generation.start 与 attempt 历史已经存在。
- 清空或覆盖旧 attempt/receipt:破坏 append-only 历史且不能恢复已断开的模型输出。

**命门**:旧控制记录与已开始 attempt 只读保留；仍匹配 source/input/prompt/semantic-contract 的 accepted artifact 可复用，未完成工作由重新确认的当前 BuildPlan 与 Session V3 新 attempt 接管。旧目标未被本次实跑选中时保持零写入。
**何时回头**:出现外部用户或多机依赖、V2 中存在可恢复 candidate、业务选择无法重建，或项目承诺原地升级时再单独设计迁移。
**展开**:[R8 守卫恢复](../切片方案-root共享Executor-MCP注册与继承.md#r8-守卫恢复与发布收口)

## §8 已注册角色迁移

**决策**:仅显式迁移已知旧模板。

**否决**:
- 静默覆盖任意不同正文:会破坏用户自有 Agent 配置。
- 永久保留旧 agent-only 模板:角色指令会继续陈述错误安全边界。
- 要求用户先删除旧文件:不可恢复且无法证明删除对象身份。

**命门**:只在用户明确升级、现文件规范化全文与随包前代正文直接相等时，先按原始字节做同目录 create-only 备份再原子替换；未知正文仍失败关闭。
**何时回头**:Codex 插件原生拥有版本化 custom-agent 注册与回滚时，删除这份单代前代正文。
**展开**:[R4 注册迁移](../切片方案-root共享Executor-MCP注册与继承.md#r4-角色投影与-root-非调用合同)

## §9 HERO 哈希用途门

**决策**:小控制对象不用摘要作身份。

**否决**:
- Bootstrap、Agent、plan、policy、evidence 用 digest:直接字段、revision 或全文比较足够。
- Payload、response、chunk、pack、ledger 层层哈希:原值已被读取并直接验证。
- 删除语义 input/content/artifact hash:会失去昂贵模型产物的精确复用门。

**命门**:只保留决定“复用或重新生成”的大型语义输入/产物哈希、压缩大型 coverage/freshness/artifact-set/receipt body 且决定 close/recovery 的内容哈希，以及仅作持久 locator 的 opaque ref 派生值；后者不得冒充完整性证明。
**何时回头**:某个新哈希能替代实质更贵操作且比较结果改变下一动作时，单独记录消费者与分支后再引入。
**展开**:[HERO 审计与 H0-H4](../切片方案-root共享Executor-MCP注册与继承.md#02-hero-范围门与哈希审计)

## §10 显式控制身份

**决策**:控制代际使用 id、revision 与 version。

**否决**:
- `plan_digest` 充当并发令牌:Core 所有的单调 revision 更直接。
- `policy_digest` 充当目录代际:显式 generation id 能报告真实不兼容项。
- `context/intent/blueprint` 摘要套娃:各对象已有所有者与版本边界。

**命门**:确认绑定 `plan_id + plan_revision`；policy 使用 `stage + policy_generation_id`；context、intent 与 blueprint 分别使用自己的 id/revision/version。
**何时回头**:只有大型内容本身参与昂贵结果复用时保留一次内容哈希，不再对身份对象二次摘要。
**展开**:[H1 显式规划与控制身份](../切片方案-root共享Executor-MCP注册与继承.md#h1-显式规划与控制身份迁移)

## §11 语义复用与执行证据

**决策**:调度预算不进入语义 freshness。

**否决**:
- `proof_digest` 绑定 artifact、lease 与 mailbox:estimator/reserve 变化不是语义输入变化。
- policy-set/receipt/resolution 再算 digest:显式 generation 与原字段已能决定动作。
- 连同 input/prompt/artifact content hash 一起删除:会丢失昂贵生成和大正文幂等复用门。

**命门**:语义复用只绑定 source/input、一次 prompt 内容身份与显式 semantic contract；budget proof 在 claim/execution 时按原字段重算，receipt 直接比较有限字段。accepted payload、candidate 与 published handoff 的内容哈希只在不复制大正文且决定 snapshot、replay 或 stale 分支时保留。
**何时回头**:某个预算字段真实改变模型可见 prompt/input 时，让该变化进入 input/prompt hash 或 semantic contract version，而不是恢复 proof digest。
**展开**:[H2 执行证据](../切片方案-root共享Executor-MCP注册与继承.md#h2-budget-proof-去摘要与执行证据分离)、[H3 policy generation](../切片方案-root共享Executor-MCP注册与继承.md#h3-policy-generation-去套娃)

## §12 派生关闭结果重算

**决策**:旧 close 只读，当前投影确定性重算。

**否决**:
- 把 V1 原地归档并改写为 V2:为便宜派生值引入一次性迁移器和恢复分支。
- 永久保留 V1/V2 双写或兼容 reader:扩大前 1.0 本机控制面的维护面。
- 因 close envelope 换代重建 accepted artifact:把控制投影变化误当成语义变化。

**命门**:新计划只从当前 accepted artifact、publication、coverage、freshness 与显式 contracts 生成当前 close projection；旧目标目录不被本次接管时零写入。
**何时回头**:确定性重算会触发显著更贵的模型工作，且迁移结果能直接决定跳过该工作时再评估迁移。
**展开**:[R8 守卫恢复](../切片方案-root共享Executor-MCP注册与继承.md#r8-守卫恢复与发布收口)
