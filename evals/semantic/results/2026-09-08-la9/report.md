# 同环消融报告

模型：deepseek-v4-flash；状态：invalid_configuration。三组共享生产 Agent 循环、基础提示、原文、判分及冻结预算；差异仅为读时定位能力。

| 组 | 完整成功 | 引用支持 | P95 秒 | 平均 Token |
| --- | ---: | ---: | ---: | ---: |
| text | 1/1 | 1 | 18.634347 | 20302 |
| tree | 1/1 | 1 | 35.116710700000006 | 104837 |
| graph | 0/0 | N/A | N/A | N/A |

## tree 对 text

新增成功：无。失去成功：无。

| 题目 | 前组成功 | 后组成功 | Token 增量 | 后组新增调用路径 |
| --- | --- | --- | ---: | --- |
| exact-01 | true | true | 84535 | book.structure |

## graph 对 tree

新增成功：无。失去成功：无。

| 题目 | 前组成功 | 后组成功 | Token 增量 | 后组新增调用路径 |
| --- | --- | --- | ---: | --- |
| exact-01 | true | null | N/A |  |

## 已知限制

- Single book development set, one sample per arm/task; no statistical significance claim.
- Added tool paths and changed success are paired observations, not proof of a specific edge causing the outcome.
- Any missing Provider usage makes cumulative token compliance unknown. In-flight overshoots are retained.
- Prebuild history is reported separately; no book rebuild is performed to fill missing measurements.

匿名逐题证据、请求设置、预算超出和成本分账见 [summary.json](summary.json)。原始请求与答案仅在本地 run.json 保存。
