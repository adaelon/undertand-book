# ADR-0134：可选 LangSmith 观测与评测投影

状态：**已接受；LS0–LS6、LS8–LS9 已完成本地实现与可执行范围验收，LS7 独立扩展未实施，真实租户上传和 Linux 实机启动未执行**。日期：2026-09-20。

实施合同与验收见 [切片方案](../切片方案-LangSmith可观测性与评测接入.md)；代码依据与核查范围见 [审阅记录](../审阅记录-LangSmith接入-2026-09-20.md)。延续 ADR-0127 的运行生命周期、ADR-0132 的循环预算与交付终态分离，以及既有 TypeScript 预构建 / Rust 读时分层。

## §1 观测后端与执行权威

**决策**：LangSmith 仅接收可删除的派生观测。
**否决**：

- 迁移 Agent 至 LangChain/LangGraph：获取观测不需要改变执行语义。
- 从模型叙述还原轨迹：叙述不能证明模型或工具真实执行。
- 云端评分驱动业务状态：会形成第二套执行与结果权威。

**命门**：Agent、Reader、Memory、来源交付、构建控制与本地评测保留所有权；关闭观测或云端不可用不改变原业务行为。
**何时回头**：已有成熟统一 OTel 平台或明确多后端需求时，重审导出适配器。
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS0–LS3。

## §2 依赖方向与传输

**决策**：Rust 宿主导出 REST，TS 工具使用官方 SDK。
**否决**：

- Rust runtime 依赖厂商客户端：网络和凭据应由宿主拥有。
- Node sidecar / OTel Collector：当前没有需要新增部署组件的复用需求。
- core 构建函数直接依赖 SDK：离线导出应只读消费现有事实。

**命门**：Rust 在共同执行入口组合 sink，保留 SSE 行为；业务线程仅受限投影、非阻塞入队，宿主 worker 发送。TS 导出包依赖 core 只读接口。REST 首版采用 `POST /runs` 与 `PATCH /runs/{id}`。[W1–W3]
**何时回头**：实测吞吐受限时更换为 multipart；独立 runtime CLI 需要复用网络实现时再抽 crate。

## §3 身份、层级与时间

**决策**：按真实执行建立稳定身份与父子关系。
**否决**：

- 将本地聊天 session 填入 LangSmith 项目 ID：两者含义不同。
- 将预构建和跨天 Reader 回合挂在同一执行树：生命周期不包含。
- 重传重建 ID 或时间：会重复计数并扭曲时长。

**命门**：每回合固定根与 step 的随机 UUID、时钟锚点和目标项目；聊天关联使用 `extra.metadata.thread_id` 并传播到子 run。持续时间用单调时钟，外部时间为 UTC；未知时间不补造。[W1,W4]
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS0 的信封、LS1 的层级与 LS2 的身份合同。

## §4 业务终态与发送状态

**决策**：执行、交付、持久化独立记录。
**否决**：

- 模型返回即整轮成功：后续来源交付或历史保存仍可能失败。
- 用 incomplete 与诊断是否存在判交付：会误判最终修复成功的答案。
- 导出失败触发业务重试：可能重复工具与 Reader/Memory 效果。

**命门**：交付沿用最终 repair 的业务判定；根在执行及保存尝试结束后关闭，不等待云端确认。发送状态归 exporter；重启修补观测不重放业务。
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS2。

## §5 外传边界

**决策**：默认关闭，入队前按允许列表投影。
**否决**：

- 整包序列化 trace、历史或工具结果：内部对象含正文、参数和个人资料。
- 仅依赖 SDK 屏蔽 inputs/outputs：不能覆盖其他 metadata 与错误字段。
- 将内容摘要作为匿名标识：摘要不能替代数据外传授权。

**命门**：metadata 只传受控身份、状态、时间、计数、用量及授权来源坐标；eval_content 限授权评测材料。凭据仅由宿主或显式 Node 导出进程读取；关闭后停止新发送并清理未发送内容。[W6]
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS0、LS3 与 LS8。

## §6 用量、证据与构建事实

**决策**：保留事实来源、覆盖范围与未知值。
**否决**：

- 将估计、任务汇总充作原生模型用量：会误算成本或重复计费。
- 将候选或原始结果充作已读证据：模型可见投影和 ledger 接纳另有判定。
- 由 Harness 任务回执制造 LLM span：任务级事实不包含内部请求事实。

**命门**：原生用量在真实 LLM 调用记一次；证据在 ledger 接纳后补充，候选、已读、终答引用分列。构建首版只读导出持久回执，保留各类 attempt 身份和时间来源。[W5]
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS4a、LS4b 与 LS5。

## §7 评测桥接与历史兼容范围

**决策**：保留评测语义，仅导入满足时间合同的结果。
**否决**：

- importer 重跑 Agent 或 Judge：桥接不拥有执行权，也不改旧分数。
- 以导入或 Judge 时间补齐产品运行时间：会伪造延迟。
- 只上传分数：会丢失系统身份、判分状态、顺序分歧和校准依据。

**命门**：不同被测系统拆实验；保留完整样本分母、配对关系及既有四维质量判定。先完成 LS6a 旧格式映射，再冻结评测合同。缺逐题绝对时间的历史结果整组返回 `unsupported_missing_timing`，保留本地结果且不静默删行；LS6b 为未来运行补时间，LS6c 才接云端。[W7]
**何时回头**：若必须将缺时间的历史结果送入云端，单独选择能够诚实表达时间缺失的协议。
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS6。

## §8 有界丢弃与恢复

**决策**：尽力送达，丢弃保持父子依赖完整。
**否决**：

- 队列满时阻塞业务或无限扩容：观测会反过来影响阅读。
- 父创建已丢弃仍发送子节点或 PATCH：会制造缺父节点和不完整更新。
- 无界重试与业务重放：观测恢复不能拥有业务恢复权。

**命门**：先确认父创建再发送子节点；创建终止后丢弃其未发送更新和后代，缺口记本地并尽力补入已创建根。头部采样由根决定；可选 spool 只保存过滤后的有界记录，恢复按观测时间保持父链并让根终态最后发送。
**展开**：[切片方案](../切片方案-LangSmith可观测性与评测接入.md) LS3 的丢弃规则与故障验收。

## 已知限制

Resident 已覆盖执行树、三轴状态、Provider 报告用量、首字、证据接纳、交付诊断与可选持久 spool；未配置 spool 时崩溃仍可能丢失。预构建只读导出和评测导入使用独立持久映射，但不覆盖 Harness 内部未落账的模型调用。头部采样不能保证捕获所有失败，发送不保证 exactly-once；Visitor 与独立后台任务仍属于 LS7。

当前历史 Agent 评测的逐题数据主要记录 `elapsed_ms`，因此会被整组时间门拒绝，不能补造后导入；更新后的 runner 只影响未来运行。quality 复评保留独立 Judge 时间与校准状态；这些不能替代产品运行时间或直接证明学习效果。TutorSession / LearningMemory 的实现不属于本决策。

关闭或本地删除不等于撤回已上传数据；云端保留与删除单独管理。Windows Tauri、本地 Server、Web 生产构建和发布面隐私扫描已验证；当前 Windows 主机没有 Bash、WSL 或 Linux Rust target，因此 Linux 仅验证共享 Server 与部署脚本静态合同，实机启动仍待对应宿主执行。

## 官方资料

- [W1：Trace with API](https://docs.langchain.com/langsmith/trace-with-api)
- [W2：Trace without environment variables](https://docs.langchain.com/langsmith/trace-without-env-vars)
- [W3：Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [W4：Configure threads](https://docs.langchain.com/langsmith/threads)
- [W5：Log LLM calls](https://docs.langchain.com/langsmith/log-llm-trace)
- [W6：Prevent logging of sensitive data](https://docs.langchain.com/langsmith/mask-inputs-outputs)
- [W7：Upload existing experiments](https://docs.langchain.com/langsmith/upload-existing-experiments)
- [W8：Evaluate agents](https://docs.langchain.com/langsmith/evaluate-llm-application)
