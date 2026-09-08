# LA1–LA6 实施与验收

日期：2026-09-08。LA1–LA6 实现和确定性回归完成；真实模型定向复验如实记录成功、未完成和失败。完整 32 题统一回归属于 LA7。

依据：[ADR-0123](adr/0123-lid-foundation-and-reliable-agent-completion.md)、[切片方案](切片方案-LID底座与Agent可靠交付.md)、[原始评测工作记录](agent-loop-eval-worklog.md)。基于 `9e36507` 的未提交工作树，保留前序 V1、Linux 与插件修改；本次本地实现没有部署到 Linux。

## 实现结果

| 切片 | 交付行为 | 主要代码 |
| --- | --- | --- |
| LA1 显式导航 | 普通明确跳转可发现并执行 `reader.goto`；动作授权同时用于 discovery 与 dispatch；否定、引述与解释性提问不获得相应写权限，宿主权限仍有效 | [tool_exposure.rs](../crates/runtime/src/tool_exposure.rs)、[orchestrator.rs](../crates/runtime/src/orchestrator.rs) |
| LA2 笔记/高亮 | 笔记、高亮分别授权；指定原句时使用唯一精确匹配的 UTF-16 范围；Agent 导航后保存会话位置，已有 MemoryStore 承担记录持久化 | [orchestrator.rs](../crates/runtime/src/orchestrator.rs)、[server/lib.rs](../crates/server/src/lib.rs) |
| LA3 来源交付 | 已绑定 ref 的无歧义后缀可规范化为标准来源标记；未知 ref、代码与引述不被自动选择来源；修复提示明确标准语法并保留已选来源 | [orchestrator.rs](../crates/runtime/src/orchestrator.rs)、[agent_prompt.rs](../crates/runtime/src/agent_prompt.rs) |
| LA4 合法恢复 | 定位/来源错误后允许一次合法恢复批次；concept 返回的实际 occurrence 纳入 locator；原文读取仍是 evidence 的入口，同批次尚未完成的定位不提前授权读取 | [orchestrator.rs](../crates/runtime/src/orchestrator.rs) |
| LA5 停滞收敛 | 无新状态且恢复机会耗尽后进入现有无工具终答；成功新增来源绑定计入交付进展；无进展告警为 `AGENT_NO_PROGRESS`，不再追加普通工具轮 | [orchestrator.rs](../crates/runtime/src/orchestrator.rs)、[server/lib.rs](../crates/server/src/lib.rs) |
| LA6 最终协议 | 验证 Native/ReAct 最终请求明确禁用工具；违规输出零 dispatch，并持久化最终失败状态；合法证据不足回答仍可正常交付 | [runtime/lib.rs](../crates/runtime/src/lib.rs)、[server/lib.rs](../crates/server/src/lib.rs) |

LA6 的适配器生产序列化原本正确，本次补齐确定性覆盖与 Server 失败状态验证。来源交付与工具发现提示版本均为 v5；新聊天读取笔记/高亮的发现约定明确为 `memory_read`、`operation: explain` 和只读访问。

保留既有带读对布局/地图工具的 discovery 与 reducer 约定。没有将普通导航授权扩大为全部 ReaderWrite，也没有将 locator 或语义预览提升为正文证据。

## 确定性验证

| 验证 | 具体防止的失败 | 结果 | 本地日志 |
| --- | --- | --- | --- |
| Runtime 完整库测试 | 动作串权、误写、来源规范化误绑定、合法恢复被提前拦截、停滞后继续工具采样、最终协议违规产生副作用及已有 Runtime 回归 | 312 passed，3 项既有真模测试 ignored；含最终冒号格式修复 | [la-final-runtime5.log](../tmp/la-final-runtime5.log) |
| Server 完整库测试 | Agent 导航后未保存位置、终答失败未落盘或被投影为成功及已有 Server 回归 | 241 passed | [la-final-server3.log](../tmp/la-final-server3.log) |
| 评测器测试 | 评分、来源/动作判断与账目生成行为被意外改变 | 24 passed | [la-final-eval.log](../tmp/la-final-eval.log) |
| 独立 Server 构建 | 新实现无法生成可执行服务 | passed；后续冒号修复独立构建也通过 | [la-final-build.log](../tmp/la-final-build.log)、[la-final-colon-build.log](../tmp/la-final-colon-build.log) |

新增用例覆盖：笔记与高亮重开存储、指定短句精确选区、代理导航后的会话落盘、否定和元问题不执行动作、未知来源与代码块不被规范化、两次盲读后的合法恢复、concept locator、连续有效来源绑定属于进展、无工具最终请求和失败状态重开。红测及中间失败日志保留在 `tmp/la*`；完整测试最终全绿后未重复无关测试。

## 独立切片真实模型运行

真实 Provider 为 `deepseek-v4-flash`，温度 0，每题一次，300 秒超时。使用原有题目、原有评分器和真实 `/agent/chat`；每题独立 memory/private 目录。原始 32 题基线保留不改。

下表各行来自不同实施阶段，不能相加或拼接为同一版本成绩。结果目录下的 `run.json` 含原始请求与回答，留在本地；公开汇总不包含这些私有原文。

| 运行目录 | 场景 | 结果与后续处理 |
| --- | --- | --- |
| [2026-09-08-la1](../evals/semantic/results/2026-09-08-la1/summary.json) | `source-01..04` | 4/4 实际导航通过 |
| [2026-09-08-la2](../evals/semantic/results/2026-09-08-la2/summary.json) | `restart-01..04` | 1/4 完整通过；02 准备失败（选区过宽），03 准备通过但位置持久化失败，04 持久化通过但新聊天恢复失败。对应补精确原句选区、Agent 会话保存和记忆发现提示 |
| [2026-09-08-la3](../evals/semantic/results/2026-09-08-la3/summary.json) | exact-04、concept-03、cross-02/04、formula-01/03 | 2/6 通过；cross-02 超时，其余失败涉及来源未交付或内容/证据不足；补明确来源语法、绑定后缀规范化和真实来源绑定进展 |
| [2026-09-08-la4](../evals/semantic/results/2026-09-08-la4/summary.json) | concept-02、cross-01/02 | 1/3 通过；concept-02 incomplete，cross-01 内容正确但缺少有效交付来源；随后修复恢复与停止交互 |
| [2026-09-08-la5](../evals/semantic/results/2026-09-08-la5/summary.json) | concept-02 | 1/1 通过；仍消耗 7 次请求、85,504 tokens，成本问题留给 LA7 统一分账 |
| [2026-09-08-la6](../evals/semantic/results/2026-09-08-la6/summary.json) | refusal-01..04、restart-02/03 | 拒绝题 3/4 正常完成，01 incomplete；restart-02 准备通过但恢复发生最终协议错误，03 准备/持久化通过但恢复答案未通过。错误没有改判为成功 |

## 最终固定版本定向复验

程序：`tmp/la-final/server.exe`。目录：`evals/semantic/results/2026-09-08-la1-la6-final`。12 个场景：8 道共同问答及 Chunk 对照、4 道重启任务。运行期间未修改该程序。该批 formula-01 暴露的冒号格式缺口在随后独立快照修复，成绩分开记录。

运行状态 `completed`；[公开逐题报告](../evals/semantic/results/2026-09-08-la1-la6-final/report.md)、[匿名汇总](../evals/semantic/results/2026-09-08-la1-la6-final/summary.json)。

| 场景 | Agent 结果 | 失败说明 |
| --- | --- | --- |
| exact-04、concept-02、concept-03、cross-02、formula-03 | 5 道通过 | — |
| cross-01 | 失败 | 最终采样返回工具调用，HTTP 500 `FINALIZATION_TOOL_PROTOCOL_VIOLATION` |
| cross-04 | 失败 | 内容正确；两次 `source.present` 返回 `SOURCE_NOT_OBSERVED`，最终没有有效来源 |
| formula-01 | 失败 | 内容正确；公式引用位于冒号前而漏编译，另一个来源不足以支持题目；后续格式修复单列 |
| restart-01 | 通过 | 笔记准备、重启持久化、新聊天恢复均通过 |
| restart-02 | 通过 | 精确高亮准备、重启持久化、新聊天恢复均通过 |
| restart-03 | 失败 | 准备与位置持久化通过；新聊天 discovery 曾用不匹配的 operation，随后已成功激活 Reader 状态工具，但模型自行交付进度句而未调用；`incomplete=false`，任务判分仍为失败 |
| restart-04 | 通过 | 第二条独立笔记准备、持久化、恢复均通过 |

问答 Agent **5/8**、内容正确 7/8，Chunk **5/8**、内容正确 6/8。Agent 57 次请求、平均 88,705.25 tokens、P95 179.25 秒；Chunk 8 次请求、平均 4,518.625 tokens、P95 14.30 秒。Chunk 的 formula-03 返回格式解析失败，保留在分母中。

重启任务准备 **4/4**、持久化 **4/4**、新聊天完整恢复 **3/4**。restart-02 有一次 Provider usage 缺失，token 总量保持 `null`；不补估计值。上述 12 场景不是全量 32 题结论，也未与不同快照的导航/拒绝题拼接。

### 冒号来源格式跟进

formula-01 的真实答案把已绑定来源写在冒号之前：`依据书中的近似式 [source_ref_id]：`。原规范化漏掉中英文冒号，导致该引用未进入正式来源。用这段形状新增回归输入，先复现绑定数 0，再把冒号加入既有后缀分隔符，转绿且完整 Runtime 312 项通过。

修复程序：`tmp/la-final-colon/server.exe`；单题目录：`evals/semantic/results/2026-09-08-la3-colon`。此改动仅扩展两个标点，不替模型选择证据，未知 ref、代码和引述的原约束保持。

修复后的真实单题运行 `completed`；Agent 0/1，40.07 秒、9 次请求、96,775 tokens，因 `FINALIZATION_TOOL_PROTOCOL_VIOLATION` 失败；Chunk 1/1。[匿名汇总](../evals/semantic/results/2026-09-08-la3-colon/summary.json)。格式缺口已由确定性红绿测试修复，但该次真模没有交付答案，不能宣称此题已端到端通过，也不拿旧快照的通过覆盖当前失败。

## 已知问题与后续

- 模型仍可能在无工具最终请求下输出工具调用，返回 `FINALIZATION_TOOL_PROTOCOL_VIOLATION`；运行时不执行这些调用，Server 记录失败。确定性协议约束通过不代表 Provider 每次遵守协议。
- 模型仍可能在工具已经可用时自行交付“下一步将读取”的进度句；restart-03 的 `incomplete=false` 不能代表任务成功，评测按未恢复处理。后续质量回归应保留这类失败。
- 普通动作分类沿用项目的明确短语机制；没有拓展成自由语义意图分类器。精确高亮仅接受原文中唯一命中的指定原句；多处同文不猜选区。
- 来源规范化只处理已绑定且格式明确的后缀，不能替模型决定应引用哪份证据；内容正确但没有有效来源仍然失败。
- 真实模型一次抽查不能证明整体质量或成本收益。LA7 应从固定源码重新跑完整 32 题、分列准备/持久化/恢复、检查既有成功样本退化并统计所有请求；LA8–LA10 尚未实施。
- 本地工作树包含并行 Linux/V1 改动。Linux LX7 已验收的部署快照以其独立报告为准；本报告不代表 LA 变更已发布、安装或部署。

实现链路见[代码链路 LA1–LA6 记录](代码链路.md)，架构见[架构](架构.md)，下一次接手入口见 [SESSION_CHECKPOINT](../SESSION_CHECKPOINT.md)。
