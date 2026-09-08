# 完整 Agent 评测报告

判分：natural-facts-v2-bold-normalization；按可见词句统一核对，忽略 Markdown 加粗分隔符，原始运行记录不改写。

协议：quantification-essence-agent-v1；模型：`deepseek-v4-flash`；开始：2026-09-08T06:30:27.599Z；状态：completed。

## 共同问答

| 系统 | 证据召回 | 引用支持率¹ | 任务成功率¹ | P95 延迟 | 单任务 Token |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chunk RAG (BM25, single-shot) | 84.6% | 76.9% | 83.3% (20/24) | 7.57 s | N/A |
| Resident Agent (LID + Graph, full loop) | 100.0% | 65.4% | 62.5% (15/24) | 114.85 s | 97,359 |

¹ 引用支持率为必要事实中“结论正确且有有效引用支持”的比例；无引用计不支持。任务成功要求全部必要事实及引用通过，拒绝题要求明确不臆造。证据召回为参考锚组的覆盖率，不覆盖全部等价原文。自由答案采用独立模型标注，再核对金标准值、逐字答句、有效原文引用和动作状态；不是人工盲审。

本表是单次产品级对照。Chunk 为单轮 BM25 RAG，Agent 使用生产默认策略自主循环、动态发现工具。Agent 不受 Chunk 的 6000 字符证据预算限制，双方提示和工具能力不同，因此不能把结果差异归因于图谱。

Agent 问答内容正确率：66.7%；Chunk：83.3%。内容正确不代表引用或任务完成。

Token 来自全部实际 Provider 请求，包含工具循环、内层查询、压缩和答案修复；不使用 Runtime 估算。问答 Agent 共 200 次请求，Chunk 共 24 次。缺失 usage 则均值为 N/A。判分另计：50 次请求、102,195 Token，不计入被测系统成本。P95 排除服务启动、预构建和事后判分，包含失败任务。

全流程（不含判分）实际发起 297 次模型请求。后台画像 review 包含在用量中，单列 6 次、1 次缺失 usage；缺失项没有用估计值补齐。

## 实际请求成本分账

| 用途 | 请求数 | 实际 Token | 缺失 usage |
| --- | ---: | ---: | ---: |
| 业务循环（含 Chunk 单轮） | 256 | 2,739,145 | 0 |
| 内层查询 | 0 | N/A | 0 |
| 内层综合 | 0 | N/A | 0 |
| 来源修复 | 30 | 75,151 | 0 |
| 无工具终答 | 4 | 41,249 | 0 |
| 压缩 | 0 | N/A | 0 |
| 后台画像 | 6 | N/A | 1 |
| 未分类 | 1 | N/A | 1 |
| 独立判分 | 50 | 102,195 | 0 |
| 失败任务合计（已含于上述被测用量） | 107 | N/A | 1 |

无请求的用途显示 N/A；存在缺失 usage 的合计同样显示 N/A，二者由请求数和缺失列区分。按已知生产系统提示签名归类；无法识别的请求保留未分类。分系统、逐题用量见 summary.json。独立判分不计入任务延迟或被测系统成本。

## 来源跳转（Agent 专属）

| 任务 | Agent 实际跳转 | 回答、引用及动作均通过 | Token |
| --- | ---: | ---: | ---: |
| source-01 | ✓ | ✓ | 33,804 |
| source-02 | ✓ | ✗ | 46,145 |
| source-03 | ✓ | ✗ | 33,763 |
| source-04 | ✓ | ✗ | 66,162 |

跳转成功须 Agent 自己调用阅读工具，且最终视口覆盖参考位置。评测器只读取状态和解析已交付引用，不替 Agent 跳转。

## 真实重启（Agent 专属）

| 任务 | Agent 写入/定位 | 进程重启后持久化 | 新会话 Agent 恢复成功 | 两阶段 Token |
| --- | ---: | ---: | ---: | ---: |
| restart-01 | ✓ | ✓ | ✓ | 43,520 |
| restart-02 | ✓ | ✓ | ✓ | 41,531 |
| restart-03 | ✓ | ✓ | ✓ | 143,285 |
| restart-04 | ✓ | ✓ | ✓ | N/A |

每题使用独立目录。先由 Agent 保存笔记、高亮或位置，再退出服务并启动新进程、清空活动聊天。新会话不包含准备阶段对话；须实际观察持久化信息并复述指定内容。失败准备不从分母剔除。

## 逐题核对

| 任务 | 系统 | 内容正确 | 完整成功 | 有效来源数 | 模型请求数 | Token |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| exact-01 | Chunk | ✓ | ✓ | 1 | 1 | 3,701 |
| exact-01 | Agent | ✓ | ✓ | 1 | 6 | 33,621 |
| exact-02 | Agent | ✓ | ✓ | 1 | 6 | 31,054 |
| exact-02 | Chunk | ✗ | ✗ | 2 | 1 | 4,131 |
| exact-03 | Chunk | ✓ | ✓ | 2 | 1 | 3,944 |
| exact-03 | Agent | ✓ | ✓ | 1 | 6 | 38,082 |
| exact-04 | Agent | ✓ | ✓ | 1 | 5 | 39,034 |
| exact-04 | Chunk | ✓ | ✓ | 2 | 1 | 3,984 |
| concept-01 | Chunk | ✓ | ✓ | 1 | 1 | 4,007 |
| concept-01 | Agent | ✓ | ✓ | 2 | 7 | 54,688 |
| concept-02 | Agent | ✗ | ✗ | 0 | 11 | 131,920 |
| concept-02 | Chunk | ✓ | ✓ | 2 | 1 | 3,876 |
| concept-03 | Chunk | ✓ | ✓ | 2 | 1 | 4,392 |
| concept-03 | Agent | ✗ | ✗ | 0 | 7 | 51,320 |
| concept-04 | Agent | ✓ | ✓ | 2 | 8 | 54,716 |
| concept-04 | Chunk | ✗ | ✗ | 0 | 1 | 3,802 |
| cross-01 | Chunk | ✗ | ✗ | 2 | 1 | 4,230 |
| cross-01 | Agent | ✗ | ✗ | 0 | 11 | 175,056 |
| cross-02 | Agent | ✗ | ✗ | 7 | 11 | 204,445 |
| cross-02 | Chunk | ✓ | ✓ | 4 | 1 | 4,220 |
| cross-03 | Chunk | ✓ | ✓ | 4 | 1 | 4,287 |
| cross-03 | Agent | ✓ | ✓ | 7 | 9 | 175,806 |
| cross-04 | Agent | ✓ | ✓ | 3 | 10 | 179,249 |
| cross-04 | Chunk | ✓ | ✓ | 4 | 1 | 4,570 |
| contrast-01 | Chunk | ✓ | ✓ | 2 | 1 | 3,830 |
| contrast-01 | Agent | ✓ | ✓ | 2 | 5 | 41,714 |
| contrast-02 | Agent | ✓ | ✓ | 2 | 11 | 130,671 |
| contrast-02 | Chunk | ✓ | ✓ | 1 | 1 | 4,071 |
| contrast-03 | Chunk | ✗ | ✗ | 0 | 1 | N/A |
| contrast-03 | Agent | ✗ | ✗ | 3 | 7 | 80,899 |
| contrast-04 | Agent | ✓ | ✗ | 0 | 5 | 52,279 |
| contrast-04 | Chunk | ✓ | ✓ | 1 | 1 | 4,981 |
| formula-01 | Chunk | ✓ | ✓ | 2 | 1 | 4,762 |
| formula-01 | Agent | ✓ | ✓ | 3 | 10 | 139,904 |
| formula-02 | Agent | ✓ | ✓ | 6 | 11 | 173,830 |
| formula-02 | Chunk | ✓ | ✓ | 3 | 1 | 4,719 |
| formula-03 | Chunk | ✓ | ✓ | 1 | 1 | 4,165 |
| formula-03 | Agent | ✓ | ✓ | 1 | 9 | 76,444 |
| formula-04 | Agent | ✗ | ✗ | 0 | 7 | 63,142 |
| formula-04 | Chunk | ✓ | ✓ | 2 | 1 | 4,408 |
| refusal-01 | Chunk | ✓ | ✓ | 0 | 1 | 3,945 |
| refusal-01 | Agent | ✗ | ✗ | 0 | 13 | 194,067 |
| refusal-02 | Agent | ✓ | ✓ | 0 | 6 | 46,170 |
| refusal-02 | Chunk | ✓ | ✓ | 0 | 1 | 3,986 |
| refusal-03 | Chunk | ✓ | ✓ | 1 | 1 | 3,782 |
| refusal-03 | Agent | ✗ | ✗ | 0 | 13 | 125,505 |
| refusal-04 | Agent | ✓ | ✓ | 0 | 6 | 43,006 |
| refusal-04 | Chunk | ✓ | ✓ | 0 | 1 | 3,732 |

## 实际工具尝试（含被拒绝调用）

- book.text: 133
- book.search_text: 123
- source.present: 97
- book.context: 25
- book.concept: 15
- tool.search: 7
- reader.gotoLid: 5
- book.structure: 4
- memory.recall: 4
- book.query: 2
- reader.state: 2
- reader.note: 2
- reader.highlight: 1

## 限制与复现

单书开发集、每系统每题一次；语义标注器和被测系统使用同一配置模型，仍可能存在标注偏差。必需事实覆盖不等于整篇答案无幻觉，引用支持也不衡量引用位置排版。重启包含服务进程和新聊天，不模拟系统断电或长期人格记忆。

配置和匿名逐题结果见 [summary.json](summary.json)，协议与命令见 [完整 Agent 方法](../../AGENT_EVAL.md)。带原文、模型输入和机器路径的 run.json 仅保留本地，Git 忽略；公开报告不包含这些内容。
