# 语义评测实测报告

运行：2026-09-08T02:23:01.874Z。数据集：`quantification-essence-v1`；检索器：`retrieval-ablation-v1`；模型：`deepseek-v4-flash`。

语料：`quantification-essence`，2757 个 LID、1640 个图节点、1745 条边。使用本地已有预构建，不计入读时耗时。

28 道阅读任务，每系统 1 次/题，共 56 次模型请求尝试；额外 4 道共享 Reader 重启检查。检索对照共用模型、提示、6000 UTF-16 字符原文上限及 1600 output-token 上限。系统调用顺序逐题交替。回答协议：quotes-v1。

| 系统 | 证据召回 | 引用支持率（锚点代理） | 任务成功率（严格判据） | P95 延迟 | 单任务 Token（均值） |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chunk RAG (BM25) | 91.7% | 46.9% | 60.7% (17/28) | 13.18 s | 4,443 |
| LID + Graph | 87.5% | 70.4% | 75.0% (21/28) | 11.58 s | 4,404 |

任务成功要求每个事实都有必要的支持证据，但不要求额外引用也全部命中参考锚；因此成功率可高于引用支持率。后一指标会把正确但未收录的替代表述计为不命中，不是幻觉率。

## 分项结果

| 类别 | Chunk RAG 成功 | LID + Graph 成功 |
| --- | ---: | ---: |
| 精确原文定位 | 4/4 | 4/4 |
| 概念解释 | 3/4 | 3/4 |
| 跨章节关系 | 0/4 | 0/4 |
| 反例/对比 | 3/4 | 4/4 |
| 公式解释 | 0/4 | 2/4 |
| 来源跳转 | 4/4 | 4/4 |
| 证据不足拒绝 | 3/4 | 4/4 |

## 重启恢复（共享 Reader，不计入检索胜负）

| 任务 | 操作 | 结果 |
| --- | --- | --- |
| restart-01 | note | 通过 |
| restart-02 | highlight | 通过 |
| restart-03 | position | 通过 |
| restart-04 | note | 通过 |

真实服务进程退出后，以同一隔离记忆目录启动另一个进程；检查两条笔记、段内高亮及阅读位置。没有预写历史回答，没有模拟进程重启，也未检验模型是否自主回忆或记忆整合质量。

## 失败清单

| 题号 | 系统 | 可复核原因 |
| --- | --- | --- |
| concept-04 | LID + Graph | 回答器拒绝（检查检索证据是否足够） |
| concept-04 | Chunk RAG (BM25) | 回答器拒绝（检查检索证据是否足够） |
| cross-01 | Chunk RAG (BM25) | 回答器拒绝（检查检索证据是否足够） |
| cross-01 | LID + Graph | Provider returned invalid JSON |
| cross-02 | LID + Graph | Provider returned invalid JSON |
| cross-02 | Chunk RAG (BM25) | objective: 引文未覆盖参考支持锚 |
| cross-03 | Chunk RAG (BM25) | noise_extreme: 引文未覆盖参考支持锚；bias: 引文未覆盖参考支持锚 |
| cross-03 | LID + Graph | Provider returned invalid JSON |
| cross-04 | LID + Graph | constrain_transformer: 引文未覆盖参考支持锚 |
| cross-04 | Chunk RAG (BM25) | high_capacity_stacking: 引文未覆盖参考支持锚；constrain_transformer: 引文未覆盖参考支持锚 |
| contrast-01 | Chunk RAG (BM25) | Provider returned invalid JSON |
| formula-01 | Chunk RAG (BM25) | Provider returned invalid JSON |
| formula-01 | LID + Graph | Provider returned invalid JSON |
| formula-02 | Chunk RAG (BM25) | direction: 引文未覆盖参考支持锚 |
| formula-03 | Chunk RAG (BM25) | Provider returned invalid JSON |
| formula-04 | LID + Graph | weight: 引文未覆盖参考支持锚 |
| formula-04 | Chunk RAG (BM25) | Provider returned invalid JSON |
| refusal-03 | Chunk RAG (BM25) | Provider returned invalid JSON |

## 指标与限制

- 证据召回：本次可回答任务的必需证据组宏平均（完整题集为 24 道）；组内可接受替代锚取 OR，组间取 AND；按实际提供给模型的原文区间计。拒绝题不进入此分母。
- 引用支持率：支持参考事实、逐字存在于已提供证据、且覆盖对应参考锚的引文数 / 所有生成引文数。它是封闭事实槽的严格自动判据，不是任意自然语言的语义蕴含判定；可能漏判正确但未覆盖选定锚的引文。
- 任务成功：所有规定事实槽正确且有支持引文；拒绝题必须明确拒绝且不编造字段；来源题另需真实 Reader 跳转及原文回读成功。
- P95：nearest-rank，含检索、本地工具、模型请求和来源题跳转；不含服务启动、预构建和索引创建。单次小样本、共享网络/服务端缓存，不能视为稳定服务 SLA。
- Token：Provider 返回的 total_tokens，包含其计入的输入、输出和推理 Token；缺失就报告 N/A，不用字符数估算。
- 基线是 BM25 文本分块检索，没有向量检索、reranker 或查询改写。LID 组使用原文 BM25 种子加生产 book.context(far) 和 book.text；并非完整多轮 Resident Agent，也未消融 LID 分段与图关系的各自贡献。
- 单书、自编的 32 题，没有盲测集或重复采样；答案限定为事实槽，不测开放式讲解的教学质量。原书含公式/数值排版噪声，评测保留输入原貌。
- 阅读测试描述书中观点，不核验金融论断，也不构成投资建议。

## 复现与证据

[评测方法](../../README.md)；[冻结题目与金标准](../../dataset.mjs)；[逐题公开结果](summary.json)。本地 run.json 保留实际引文、模型输出与检索轨迹，但被 Git 忽略，避免公开用户原书片段。公开结果保留事实值、证据坐标和判分细目，不含密钥、机器路径或全文。
