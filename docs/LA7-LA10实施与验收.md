# LA7–LA10 实施与验收

依据 ADR-0123 与 LID 底座切片方案。保留 `9e36507` 上既有未提交工作树，旧基线不改写。

## 执行状态

- [x] LA7：请求用途分账、固定程序完整 32 题、逐题退化分析；质量目标未全通过，见下文。
- [x] LA8：显式 Text/Tree/Graph 实验入口、隐藏语义通道隔离、实际模型输入测试及三组接入。
- [x] LA9：冻结同环同预算 72 样本、配对收益与预构建成本报告；不扩大默认图谱使用。
- [x] LA10：真实前端连续阅读、来源弹窗、动作、重启和新聊天回放。

## 验证目标

LA7 分账必须保留未知用途与缺失 usage；全量运行检查前序成功退化和动作闭环。LA8 用只存在于语义资产中的标记检测泄漏，直接调用与发现入口都受限。LA9 验证累计实际用量及唯一原文区间预算，不修改判分。LA10 用实际点击与持久数据比对定位来源、动作、存储、新聊天和 UI 失败。

## LA8 实现与验证

Server 的显式实验环境 `UNDERSTAND_BOOK_EVAL_ACCESS=text|tree|graph` 仅构造内存 Book 视图。Text/Tree 清空该视图的语义图；三组共同移除模型结构、公式语义、discourse、paper 等 sidecar，关闭 profile、memory、artifact 和高层 query/synthesize 通道。生产默认不选择实验配置。注册表先执行原有完整校验，再收窄直接与 discovery 的共同集合。

Tree 使用 canonical LID 树；Graph 额外开放概念候选和 graph context。三组定位结果不暴露原文预览，正文经同一 book.text 回读与 evidence gate；12,000 UTF-16 正文预算按全局区间并集合并。实验系统提示相同，差异由可用工具表达。

实际输入隔离、词法定位回读、重叠/重复正文区间和超限拒绝测试通过。完整 Runtime 315 passed / 3 既有 ignored，Server 241 passed；随后增加的输出上限适配器测试通过。评测器 27 passed。日志位于 `tmp/la8-*`、`tmp/la9-tests.log`。

三组首题接入 exact-01 全部通过：Text 48,815 tokens / 23.63 秒，Tree 61,582 / 31.62 秒，Graph 47,115 / 36.46 秒。见[独立接入结果](../evals/semantic/results/2026-09-08-la8-probe/summary.json)。该批没有显式输出上限，只用于 LA8 接入；不能计入 LA9。

LA9 首批启动后发现 Adapter 未显式发送单次输出上限，停止并保留 `2026-09-08-la9` 两条已完成样本，状态 `invalid_configuration`。新目录 `2026-09-08-la9-v2` 冻结 8,000 输出 tokens、12 轮、300 秒、120,000 实际累计 tokens、20,000 终答预留和 12,000 UTF-16 唯一正文预算；三组按题号循环轮换，不拼接首批成绩。

## LA10 发现与修复

首次真实 UI 回放选区解释未完成，证据见 `tmp/la10/run.json`。Markdown “问 AI”丢失已有 ranges/status/raw_quote/resolved_quote，仅传旧式 lid/quote；Server 无法将其纳入已验证选区，模型重新检索后来源交付失败。`App.vue:askSelection` 复用已用于 Markdown 笔记的 `markdownSelectionContext`。正式 Web 构建通过，第二次回放选区解释、来源弹窗保持位置、显式打开原文通过。

第二次 `tmp/la10-v2` 在保存 Note 后误等 `/memory/save`；段落笔记实际走 `/reader/note`。修正验收等待条件，保留失败记录，再运行完整连续场景。

第三次 `tmp/la10-v3` 确认实际存储问题：显式来源打开已改变视口，重启却从 1.2.2 回到 1.1。`route_agent_source_open` 调用 Reader 成功后漏存 session；加入同一路径的 `save_session`。Server 既有来源集成测试扩展为“resolve 不保存/不移动，open 后 session 含实际位置”，先红后绿，证据 `tmp/la10-source-red.log` / `tmp/la10-source-green.log`。

正式前端 `continuous-reading.mjs` 的 `tmp/la10-v4` 七阶段全部通过：选区解释、来源弹窗核对且无跳转、显式打开原文、保存笔记、换进程后同位置与同笔记、空新聊天主动读取 memory.recall/reader.state、两章来源点击。末步脚本在 DOM 渲染前计数误报无按钮，`continuous-reading-sources.mjs` 修正等待后接续同一持久回答，先核对回答完全一致，再实际打开“因子是什么？”和“防过拟合”两个来源；未重新生成答案。初始失败记录在 `run-initial.json`，完整行为及请求在 `run.json`，截图仅佐证。

匿名阶段结果：[LA10 summary](../evals/semantic/results/2026-09-08-la10/summary.json)。程序 `tmp/la10-final/server.exe`、正式 Web dist；测试记忆独立，未部署到 Linux。

## LA7 固定程序全量结果

固定 `tmp/la-final-colon/server.exe` 完成 32 道任务、48 个共同问答系统样本。原始记录和程序始终不替换。[完整报告](../evals/semantic/results/2026-09-08-la7/report.md)及[逐题分账](../evals/semantic/results/2026-09-08-la7/summary.json)按同一 `natural-facts-v2-bold-normalization` 判分。

| 项目 | 本轮观测 |
| --- | --- |
| 共同问答完整成功 | Agent 15/24；Chunk 20/24 |
| Agent 内容正确率（含标注失败） | 16/24；不能当作完整成功 |
| Agent 证据参考锚组召回 | 100%，仍有来源交付失败 |
| Agent 问答实际成本 | 200 请求，平均 97,359.25 tokens，P95 114.85 秒 |
| Chunk 问答实际成本 | 24 请求，其中 1 次 usage 缺失，平均 N/A；P95 7.57 秒 |
| 实际跳转 / 回答引用动作完整通过 | 4/4 / 1/4 |
| 重启准备 / 持久化 / 新聊天恢复 | 4/4 / 4/4 / 4/4；restart-04 后台请求缺失 usage，总成本 N/A |

旧基线 Agent 13/24、Chunk 22/24 保持不变；本轮不是超过 Chunk 的证据。固定题集的一次运行不衡量统计显著性。

### 退化与失败分层

旧 13 道成功中的退化有三道。`contrast-03` 答案和三个来源均包含正确结论，但标注器把答句分号改成句号，逐字校验拒绝；保持失败，不放宽标点规则。`contrast-04` 内容正确，`source.present` 的 quote 改写数学符号且用过大范围，未绑定来源。`formula-04` 同样已有正文、引文不匹配，随后停滞终答为 incomplete。后两题回到 LA3/LA4 的来源反馈和合法恢复路径。

`source-02` 已跳转但模型没有调用 source.present；一次来源修复不能从空绑定中造引用。`source-03` 仅交付“复权因子要用”的短语，不能支持整个结论。`source-04` 的回答明确“不可微”且两处来源支持，但标注字段 differentiable 被填成 true；严格成绩仍失败，归类为标注错误。`cross-02` 回答有七个真实来源，但标注 JSON 截断；Chunk 也有 JSON/传输失败，全部保留。其余未完成及 refusal-03 最终协议错误见逐题结果，不改判正常拒绝。

### 成本归因及具体入口

业务循环占主要已知成本；内层 query/synthesize 与 compaction 本轮均零请求。来源修复 30 请求 / 75,151 tokens，无工具终答 4 请求 / 41,249 tokens。六次后台画像含一次 usage 缺失，未知合计不补零。判分单列，失败成本包含在总成本中。

`cross-02` 的第 8–11 请求合计 104,426 tokens，主要在大范围回读后修正多次来源绑定并重传既有上下文；改动入口是 `TurnEvidenceLedger::present` 的范围/quote 反馈及来源使用合同。`refusal-01` 使用 12 次普通采样加一次无工具终答，共 194,067 tokens，多轮围绕同一缺失随机种子搜索；回到 LA5 的实际无进展判断，不能仅靠换搜索词就证明检索增量。两者均不以预先增加缓存或压缩框架解决。

已绑定格式规范化样本零来源修复、停滞终答后零普通采样由既有确定性请求计数测试保证；30 次真实修复不被错误解释为规范化失效。完整产品质量目标未全通过，失败分层作为返回 LA3–LA6 的输入。

### LA7 独立反馈修复复验

`TurnEvidenceLedger::present` 在观察覆盖成立后单独返回 SOURCE_QUOTE_MISMATCH，明确可更正原文或省略 quote，避免提示重新检索；覆盖不成立仍拒绝。来源使用合同同步说明完整已读范围与关键词片段的区别。红测复现后来源相关 17 项通过。

固定后续程序 `tmp/la7-followup/server.exe` 的独立四场景：contrast-04、source-02、source-03 完整通过；formula-04 仍因 FINALIZATION_TOOL_PROTOCOL_VIOLATION 失败，返回 LA6。见[独立复验](../evals/semantic/results/2026-09-08-la7-followup/report.md)。该结果不替换 LA7 全量或 LA9 已冻结样本，也不把随机模型的一次改善当作稳定保证。

最终 Runtime 318 passed / 3 既有 ignored、Server 241 passed，评测器 28 passed；覆盖配对路径匿名化、失败请求轨迹保留及实际正文区间并集。日志 `tmp/la7-la10-final-rust-tests.log`、`tmp/la7-la10-final-eval-tests.log`。

## LA9 完整结果与裁决

固定程序 `tmp/la9/server.exe` 已完成每组24题、共72个样本，程序早于 LA10 持久化及 LA7 后续来源反馈修复；这两项后续源码变化没有进入本批。模型、预算、循环轮换及失败保留按启动清单执行。[配对报告](../evals/semantic/results/2026-09-08-la9-v2/report.md)与[匿名逐题记录](../evals/semantic/results/2026-09-08-la9-v2/summary.json)使用同一判分版本。

| 组 | 完整成功 | 证据召回 | 引用支持 | P95 | 平均实际 Token |
| --- | ---: | ---: | ---: | ---: | ---: |
| Text | 10/24 | 88.46% | 38.46% | 115.79秒 | 85,729.96 |
| Tree | 11/24 | 88.46% | 34.62% | 88.31秒 | 101,842.04 |
| Graph | 9/24 | 92.31% | 30.77% | 91.90秒 | 95,171.38 |

被测599次请求、6,785,841 tokens；独立判分52次、72,743 tokens。全部实际请求 usage 完整。27个样本有允许的在途超额，最大19,351 tokens；预算代理阻止10次后续上游请求，这些拒绝未计为已付费请求。实际送入模型的已接纳正文区间并集最大11,465 UTF-16字符，没有正文预算超出。三组实际采样均明确带 max_tokens=8000、温度0、同一模型；工具schema使用同一模型profile的262,144字节上限。HTTP层失败没有 OuterOutcome 时，报告从真实 Provider 响应保留工具尝试，request_ordinal 与正常 trace 的轮次分开。

### Tree 对 Text

新增成功 `exact-01, contrast-03, refusal-01, refusal-04`，失去成功 `contrast-02, contrast-04, formula-04`；净增1题，平均成本增加16,112.08 tokens（18.79%）。前两道成功使用了 canonical book.structure，其中 contrast-03 在已定位的1.10.18展开章节结构；refusal-01也调用结构，refusal-04没有调用新增结构/邻接入口，后者不能归因于 Tree 能力。

`exact-01` 的 Text 答案与来源正确，但标注器改写引号，逐字闸未通过；`contrast-03` 的 Text 标注也没有逐字摘取实际答句。因此不能把全部四道表面增益当成结构检索的真实增益。Tree 在另外三题的来源交付、未完成和协议失败同样保留。证据召回没有增加，不据此将普通精确定位改为强制结构遍历。

### Graph 对 Tree

新增成功 `contrast-02, formula-04`，失去成功 `concept-02, concept-03, concept-04, refusal-02`；净少2题。平均成本降低6,670.67 tokens（6.55%），但完整成功也减少，不能解释成等效果的成本优化；相对 Text 则平均多9,441.42 tokens且少1道成功。

两道新增成功都在第一轮使用 book.concept：contrast-02 随后回读防过拟合的1.9.5段落并交付两处来源，比 Tree 少45,142 tokens；formula-04随后回读1.10.17/1.10.18并交付 MWU 来源，比 Tree 少18,990 tokens。这支持“概念定位在这两次运行中提供了有用路径”的局部观察，不能归因于某条具体图边。两题 Text 也通过；其中 contrast-02 的 Text 还比 Graph 少1,969 tokens。四道跨章节题三组全部未完整成功，本批没有证明跨章节图谱收益。

**默认策略裁决**：保留 LID 与原文证据闸；明确措辞继续优先词法定位，已知章节需要展开时按需使用确定性树，概念候选作为需要时的定位能力。此次不扩大图谱默认使用，不提高工具轮数或预算，也不撤销正式学习的整书预构建门槛。没有将局部观察升级为 README 正向能力主张，因此不启动为了支撑该主张的新冻结题集。

### 预构建成本与回收点

[既有构建记录](../evals/semantic/results/2026-09-08-la9-v2/prebuild.json)共530次尝试。整个书目录7,861个文件、34,814,058字节，包含原文、语义资产和构建历史，不能当作图谱独有的增量体积。

| 阶段 | 尝试 / committed | executor累计毫秒 | lease等待累计毫秒 | writer累计毫秒 |
| --- | ---: | ---: | ---: | ---: |
| book_structure | 25 / 25 | 2,561,519 | 306,316 | 22,342 |
| pass1 | 46 / 46 | 6,004,439 | 552,843 | 33,144 |
| pass2 | 37 / 36 | 1,744,224 | 4,906,768 | 33,387 |
| profile_sidecar | 422 / 401 | 27,043,871 | 6,194,527 | 424,564 |

所有历史实际 Provider Token 均不可用；并行尝试计时相互重叠，整体墙钟耗时未知。未重建原书或估算填充。额外构建成本未知，且本批没有同成功水平的读时节省，不能给出数值成本回收点。

## 已知限制与后续入口

本轮实现与实测交付完成，完整产品的质量目标未全通过。后续仍以 LA3–LA6 的来源选择/范围反馈、合法恢复与终答协议为入口；不要靠扩大预算掩盖失败。单书开发集、每组一次、同模型家族标注、标注引文改写及开发机并行负载都限制结论；本轮没有统计显著性、跨书推广或部署验收主张。LA7、LA9和独立修复复验的快照与结果保持分离。

交付核对通过：72样本/三组各24/轮换顺序一致；599次实际请求的模型、温度、8,000输出上限及各组工具schema均符合冻结配置；正文并集没有超限。四份公开summary未混入原文请求字段，82个本地文档链接可达；全局checkpoint为59行。证据：`tmp/la7-la10-delivery-check.log`。
