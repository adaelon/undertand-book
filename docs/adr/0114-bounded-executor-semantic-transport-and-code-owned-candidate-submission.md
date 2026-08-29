# ADR-0114 Bounded executor semantic transport and code-owned candidate submission

Status: Accepted design, 2026-08-25; T1-T7 implemented and verified, T8 pending; Codex subagent release gate passed with compiled Sidecar, thin-plugin installed parity, root-negative inventory, real CLI child trace and durable commit evidence.
Extends: ADR-0084, ADR-0092, ADR-0099, ADR-0100, ADR-0101 and ADR-0103.
Revises: ADR-0101 §3 中 `executor.open` 内嵌完整语义输入的实现，以及 ADR-0092 §2 中输入交付故障的计数边界。
Change type: [边界重构]。

Review gate: problem coverage `PASS`; implementation `PARTIAL (T1-T7)`; Codex subagent compliance `PASS`; guarded real-book recovery `BLOCKED (T8)`。T7 已用 compiled Sidecar、仓外 thin-plugin、安装态 root-negative、真实 `agent_type=understand_book_executor` child 四工具 trace 与 durable success event 复验证明 T6 源码边界；在用户再次授权 T8 前不得对真实书执行 `retry_current`。

BookStructure `unit:1.6` 的 317,247-byte 语义输入被完整放进 `executor.open` 的单次结果；Build Engine 的 1 MiB record 上限与 Codex 约 5k/10k-token 工具结果通道不是同一容量边界。三轮均在 candidate、Schema、evidence 和 writer 之前终止，却因未知 executor code 的兜底映射被统一记为 `internal/writer_failed`；第三轮还暴露了模型生成 PowerShell candidate source 的独立脆弱点。实施顺序见[切片方案](../切片方案-executor有界语义传输与候选提交闭环.md)。

## §1 语义输入交付

**决策**:Executor 只按 opaque ref 分块读取输入。

**否决**:
- 在 `executor.open` 内嵌完整输入:合法 record 仍会越过 harness 工具结果上限。
- 向 executor 暴露绝对路径:绕过 ref、identity、hash 与消费端重验。
- 仅提高单次输出额度:宿主额度变化后会再次静默截断。

**命门**:每个 chunk 同时受 token、byte 与 envelope 硬闸，绑定 session、segment、ordinal、range 与 hash；全部有序交付确认后只签发 generation grant，不得直接创建 semantic attempt。
**何时回头**:Harness 提供可验证的私有 prompt 注入与结构化模型输入通道时，可用等价原语替换分块读取。
**展开**:[T2 有界输入交付](../切片方案-executor有界语义传输与候选提交闭环.md#t2-有界输入交付协议)

## §2 传输预算与路由

**决策**:模型单元同时通过上下文与传输硬闸。

**否决**:
- 保留 `10_000_000` token 兜底:dispatch 上限无法证明单次交付可达。
- 只分块、不拆语义单元:工具轮次开销仍会挤爆模型上下文。
- 运行时截断后继续生成:无法证明正文覆盖和候选输入身份。

**命门**:有效预算取 stage、模型上下文、输入 chunk 总量和 candidate tool-input 上限的共同可行域；无版本化 transport proof 的 unit 不得创建 lease 或 semantic attempt。
**何时回头**:Harness 同时提供大对象私有输入和可证明的真实 tokenizer dry-run 时，可替换估算与 carrier，不能删除路由证明。
**展开**:[T1 预算证明与 T4 BookStructure 路由](../切片方案-executor有界语义传输与候选提交闭环.md#t1-传输画像与红测)

## §3 候选提交边界

**决策**:候选只经代码所有的结构化 sink 提交。

**否决**:
- 模型生成 PowerShell/临时文件:把语义、转义和文件构造合成一个不可诊断步骤。
- candidate 经 root 中转:破坏 ADR-0084/0101 的隐私与并发隔离。
- 放宽 candidate 到任意文本:JSON、大小与 session identity 无法在入口关闭。

**命门**:Sink 只接受绑定当前 session/ref/contract 的 JSON value，由 Build Engine 单次序列化并 create-only 写入私有 mailbox；candidate body 可作为专用 child 的可检查 tool request，但不得进入 root、工具结果、通用日志或任何 final。
**何时回头**:Harness 原生结构化输出可直接绑定私有 mailbox、schema 与幂等 receipt 时，可移除本地 sink adapter。
**展开**:[T3 结构化 candidate sink](../切片方案-executor有界语义传输与候选提交闭环.md#t3-结构化-candidate-sink)

## §4 失败与尝试计数

**决策**:失败按阶段分类，传输故障不耗尽语义尝试。

**否决**:
- 未知 executor code 映射 `writer_failed`:会伪造 writer 已启动的事实。
- 解析自由文本 message:措辞变化会改变恢复状态机。
- 输入交付失败递增 semantic attempt:基础设施故障会耗尽质量重试。

**命门**:完整输入确认只签发 generation grant；`generation.start` 原子创建一个 open attempt 并返回有界 `GENERATE`，其结果丢失只能重放同一 attempt，不能标记失败或递增；Executor、sink 与 writer 仍使用不同类型化入口。
**何时回头**:统一 tracing 能提供受 schema 约束、可持久化且与当前 task identity 绑定的阶段事实时，可由 tracing 投影同一诊断。
**展开**:[T1 失败表征与 T5 账本恢复](../切片方案-executor有界语义传输与候选提交闭环.md#t5-失败账本与恢复语义)

## §5 BookStructure 前向迁移

**决策**:BookStructure 以前向路由代际拆分。

**否决**:
- 重写旧失败 attempt:破坏 append-only 审计与原 scope 解释。
- 对原 `structure_unit` 原地加大阈值:相同 transport 缺口仍然存在。
- 无条件重跑全部已鲜活阶段:扩大恢复半径且浪费已通过产物。

**命门**:超限 unit 路由为 proof-bound fragment/reduce，最终仍产出既有 unit card/stitch 合同；新 router/policy scope 发布后由 `retry_current` 重规划，旧 scope 保持只读。
**何时回头**:质量基准证明分层 reduce 不能保持 BookStructure 质量时，升级该 stage 的专用模型或目标合同，不能退回不可传输单元。
**展开**:[T4 路由与 T7 前向恢复](../切片方案-executor有界语义传输与候选提交闭环.md#t4-bookstructure-有界路由)

## §6 发布门禁

**决策**:V2 只经真实尺寸与安装态门禁切换。

**否决**:
- 继续使用一句话 fixture:不能覆盖工具结果截断与多 chunk 状态。
- 只测源码 Node 路径:会遗漏薄插件、Sidecar 与 executor role 漂移。
- 用真实书首次重试充当测试:失败会再次消耗或污染持久状态。

**命门**:除 317,247-byte、截断、sink、失败与 scope 测试外，还须证明 root 工具集中不存在 Build Executor、合法 ref 不能绕过 child capability、权限模式/可检查 child trace 符合合同、多 ref 不重复不遗失，才允许真实书执行一次 `retry_current`。
**何时回头**:发布系统能对同一二进制和宿主 carrier 做受证明的端到端兼容检查时，可合并门禁，不能降低覆盖维度。
**展开**:[T6-T7 发布与恢复验收](../切片方案-executor有界语义传输与候选提交闭环.md#t6-协议切换与安装态门禁)

## §7 Subagent 能力隔离

**决策**:Build Executor 仅向专用 child 连接授权。

**否决**:
- 注册到根或项目级 MCP:root 持有 ref 后即可越过语义隔离边界。
- 仅凭 `opaque_handoff_ref` 授权:locator 会退化为 bearer credential。
- 只靠 prompt、sandbox 或工具命名隔离:父 turn live override 与配置继承可放宽 child。

**命门**:Build Executor 只登记在 executor custom-agent 的 `mcp_servers`；root 工具集与其读写工具交集为空；server 每次调用还必须验证不进入模型参数的 child-connection-bound capability，并把访问封闭在当前 session 私有根与 schema 内。
**何时回头**:Codex 提供可证明的 per-agent capability manifest 与不可继承的私有 I/O channel 时，可用原生边界替换 launcher capability，不能只删二次校验。
**展开**:[T6 agent-only capability 与 T7 负向安装态测试](../切片方案-executor有界语义传输与候选提交闭环.md#t6-协议切换与安装态门禁)

## §8 可检查 child thread 隐私

**决策**:语义正文只允许进入专用 child 交互。

**否决**:
- 宣称 child tool 交互对用户不可见:Codex 支持打开 agent thread 检查。
- 把 chunk 或 candidate 转发 root:重新污染主上下文并破坏职责隔离。
- 用通用 stdout、stderr、metrics 或 failure message 保存正文:扩大持久泄露面。

**命门**:允许 semantic chunk 出现在专用 child tool result、candidate 出现在其 tool request，且用户检查 child thread 时可能看到；禁止进入 root thread/final、child final、其他 subagent 与非协议日志。若要求 child trace 也不可见，本方案不满足，必须改用 Harness 原生私有通道。
**何时回头**:宿主提供可验证且不进入 agent thread 的私有输入与结构化输出通道时，迁移 carrier 并重新做安装态 trace 验收。
**展开**:[Subagent 能力、权限、可见性与编排合同](../切片方案-executor有界语义传输与候选提交闭环.md#38-codex-subagent-能力权限可见性与编排)
