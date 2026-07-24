# ADR-0091 Model-aware agent requests, demand-driven tools, and active-context budgets

Status: Accepted, 2026-07-23.
Revises: ADR-0026 decision 3 and ADR-0087 section 4.
Change type: 边界重构。

当前 Resident Agent 把一份巨型 `SYSTEM_PROMPT`、一个固定 27-tool surface、逐轮插入的画像快照和累计 `usage.total_tokens` 停机揉在同一循环中。简单的局部解释也可能进入开放检索,随后因重复计算历史输入而以“上下文不足”失败。本 ADR 冻结请求装配、工具暴露、结果投影与上下文预算的新边界;实施顺序见[切片方案](../切片方案-Agent提示词与工具上下文治理.md)。

### §1 模型运行时配置

**决策**:每个用户回合从模型运行时配置解析基础指令、上下文窗口、输出预留、工具能力和截断策略,并冻结到本回合的 Agent 请求计划。

**否决**:
- 所有模型共用一个不可分解的 `SYSTEM_PROMPT`:无法按模型能力控制工具与预算。
- 由 Provider adapter 临时拼提示词:会让 Native/ReAct 的语义分叉。

**命门**:解析优先级为显式配置覆盖、模型目录匹配、受版本控制的默认配置;模型切换只在新用户回合生效并产生显式上下文变更,不得在一次工具循环中漂移。
**何时回头**:Provider 提供可验证且稳定的权威模型目录时,可把本地目录降为缓存与未知模型回退。

### §2 结构化上下文片段

**决策**:基础指令、会话稳定信息、回合冻结画像和动态环境分别进入带 key/revision/scope 的上下文片段账本,请求投影对每个 key 只保留当前版本。

**否决**:
- 每轮重新拼接无身份的大段 system 文本:无法去重、审计或判断是否真的变化。
- 把画像快照写进持久会话:扩大敏感数据生命周期并污染历史。

**命门**:画像仍是只读数据而非指令,在一次用户回合内冻结且不持久化;无状态 Chat Completions 可重发同一活动投影,但不得伪称 wire-level 增量,只有声明支持 continuation 的 Provider 才发送 initial+delta。
**何时回头**:所有支持 Provider 都有受信任的服务端会话状态时,可去掉 stateless full projection 分支。

### §3 按需工具暴露

**决策**:工具注册表与模型可见面分离;每轮按模型能力、内容 profile、权限、证据状态和回合激活集生成 direct/deferred/hidden 工具暴露计划。

**否决**:
- 每次固定发送全部 27 个工具:简单问答承担无关 schema 和错误路由空间。
- 为不同 Provider 维护不同工具清单:契约与执行器会漂移。

**命门**:`tool.search` 只检索 deferred 工具元数据并为下一次采样激活命中项,不执行目标工具;direct+activated 同时受工具数和 schema 字节预算约束,hidden 工具永不由模型调用。
**何时回头**:真实请求证明完整工具面比延迟发现有更低总调用成本且不降低正确率时。

### §4 自动工具选择

**决策**:模型请求默认显式使用 `tool_choice=auto`;引用文本已足够回答时允许零工具,只有未满足的证据缺口或明确副作用命令才进入工具路径。

**否决**:
- 用 prompt 规定每类问题必须调用固定工具链:会把局部解释升级为开放检索。
- 用额外模型工具调用记录 QA 或使用统计:把运行时记账变成推理负担。

**命门**:Reader 写操作仍必须调用真实工具并经过既有 reducer/proposal;QA 观察、无进展检测和使用遥测由 Runtime 旁路拥有,不得要求模型追加 `memory.save` 或记账工具来完成回答。
**何时回头**:某个 Provider 的 auto 模式经固定夹具证明长期漏掉必要副作用时,只为该模型配置窄化策略,不恢复全局强制链。

### §5 结构化工具调用

**决策**:ToolSpec JSON Schema、结构化 ToolCall 和结构化 ToolResultEnvelope 是 Runtime 唯一契约;Native 直接投影,ReAct 仅作为兼容 adapter 解析到同一结构。

**否决**:
- 把工具说明和调用协议拼进用户问题:角色、参数和错误边界不可验证。
- 让 ReAct 拥有另一套工具名或参数规则:会形成双运行时。

**命门**:注册、暴露、参数校验、dispatch 和结果 envelope 必须来自同一注册表;adapter 只负责协议映射,不能增删工具、放宽 schema 或解释业务错误。
**何时回头**:弱 Provider 全部支持可靠原生 tool calling 时,删除 ReAct compatibility path。

### §6 有界工具结果

**决策**:模型只接收按工具策略生成的有界 result body、typed receipt、截断状态和 continuation;原始结果可留在受控持久/诊断面,不得无界进入活动上下文。

**否决**:
- 当前活动回合永远保留所有完整 Tool body:多步读取会线性挤占上下文。
- 静默字符串截断:模型会把不完整结果误当完整证据。

**命门**:新鲜结果在下一次采样前保留一次有界正文;随后可按活动预算降格为工具感知回执。证据工具截断必须给出 `truncated` 与可继续读取的 cursor/range,且不得扩大本轮证据账本。
**何时回头**:特定工具的压缩持续破坏回答正确性时,只提高该工具策略的预算或设计更窄的分页契约。

### §7 自动上下文压缩与活动预算

**决策**:活动上下文越过模型高水位时自动生成类型化压缩检查点,原子替换模型请求历史并在同一用户回合继续采样;累计 Provider token 仅作成本遥测。

**否决**:
- 按最旧优先删除或截断对话消息:会无提示地改变用户问题和约束。
- 累加每轮 `usage.total_tokens` 后与 120k 比较:重复输入成本不代表当前窗口装不下。

**命门**:回合前 compact 只压既有历史;回合中 compact 必须把当前用户原文、已验证选区和未完成 ToolCall 配对作为 raw 保留项,只摘要更早的 assistant/tool 历史。压缩提示词只要求任务交接状态,不得要求回答用户或输出思维过程;模型只能生成带 source item/ref 的语义草稿,`window_id`、history/context revision、Tool receipt 与 raw 保留项均由 Runtime 组装。动态画像等敏感片段由账本重新注入,不写进摘要。安装后的检查点作为 server-only synthetic context 投影,不得伪装成用户或 assistant 原话;当前 canonical context 与其后的 raw 原文优先。确定性预处理只可把已完成 Tool body 改为回执、去掉过期片段;单次压缩请求仍放不下时按完整回合分块分层压缩,不得无语义替代地丢消息。所有 local/remote 草稿必须通过同一 schema、引用、来源覆盖和 token 降幅闸后才原子安装并重算活动 token。失败保持原历史并返回 `COMPACTION_FAILED`;只有成功 compact 后仍物理放不下才返回 `ACTIVE_CONTEXT_EXHAUSTED`;轮数触顶单独返回 `TURN_LIMIT_EXCEEDED`。
**何时回头**:Provider 提供受信任的原生 remote compaction 时,可替换本地生成器,但必须继续满足同一检查点与原子安装契约。

### §8 修订与兼容边界

**决策**:ADR-0026 的原生 tool-calling 与诚实 incomplete 保留,其“累计 usage 触顶”被 §7 取代;ADR-0087 的历史回执保留,其“活动回合完整结果”被 §6 收窄为有界、可压缩结果。

**否决**:
- 一次性重写整个 agent loop:无法定位 prompt、tool surface、result 或 budget 的回归来源。
- 同时改写持久历史和公开轨迹:扩大迁移与隐私风险。

**命门**:持久消息、公开 history View、轨迹 UI、来源账本与回答交付闸默认不改;允许为重启续接持久化 server-only 压缩检查点及其来源 history revision,但不得改写原消息。所有新投影都必须可从原历史和已验证检查点重建,旧 warning 只用于读取旧记录。
**何时回头**:切片验证证明持久模型本身阻止上下文治理时,另立 ADR 讨论迁移,不得在本方案中顺带修改。
