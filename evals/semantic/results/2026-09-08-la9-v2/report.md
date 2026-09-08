# 同环消融报告

模型：deepseek-v4-flash；状态：completed。三组共享生产 Agent 循环、基础提示、原文、判分及冻结预算；差异仅为读时定位能力。

| 组 | 完整成功 | 证据召回 | 引用支持 | P95 秒 | 平均 Token |
| --- | ---: | ---: | ---: | ---: | ---: |
| text | 10/24 | 88.46% | 38.46% | 115.79 | 85,729.96 |
| tree | 11/24 | 88.46% | 34.62% | 88.31 | 101,842.04 |
| graph | 9/24 | 92.31% | 30.77% | 91.9 | 95,171.38 |

## tree 对 text

新增成功：exact-01, contrast-03, refusal-01, refusal-04。失去成功：contrast-02, contrast-04, formula-04。

| 题目 | 前组成功 | 后组成功 | Token 增量 | 后组新增调用路径 |
| --- | --- | --- | ---: | --- |
| exact-01 | false | true | 70420 | book.structure |
| exact-02 | false | false | 59589 | book.structure |
| exact-03 | true | true | 23545 | book.structure |
| exact-04 | true | true | 79409 | book.structure |
| concept-01 | true | true | 4309 | book.structure |
| concept-02 | true | true | -23415 | book.structure |
| concept-03 | true | true | 12796 |  |
| concept-04 | true | true | 22577 | book.structure, book.context |
| cross-01 | false | false | 3910 | book.structure, book.context |
| cross-02 | false | false | -13279 | book.structure |
| cross-03 | false | false | 8063 | book.structure |
| cross-04 | false | false | 2024 | book.structure |
| contrast-01 | false | false | 13401 | book.structure |
| contrast-02 | true | false | 47111 | book.structure |
| contrast-03 | false | true | 43274 | book.structure |
| contrast-04 | true | false | 77963 | book.structure, book.context |
| formula-01 | false | false | 17921 | book.structure, book.context |
| formula-02 | false | false | 5299 | book.structure |
| formula-03 | false | false | 29099 | tool.search, book.structure |
| formula-04 | true | false | -23372 | book.structure |
| refusal-01 | false | true | -30037 | book.structure, source.present |
| refusal-02 | true | true | -2056 |  |
| refusal-03 | false | false | 7913 | book.structure, book.context |
| refusal-04 | false | true | -49774 |  |

## graph 对 tree

新增成功：contrast-02, formula-04。失去成功：concept-02, concept-03, concept-04, refusal-02。

| 题目 | 前组成功 | 后组成功 | Token 增量 | 后组新增调用路径 |
| --- | --- | --- | ---: | --- |
| exact-01 | true | true | -31549 | tool.search |
| exact-02 | false | false | -42678 |  |
| exact-03 | true | true | 18055 |  |
| exact-04 | true | true | -72571 |  |
| concept-01 | true | true | 33902 |  |
| concept-02 | true | false | 1190 |  |
| concept-03 | true | false | 51897 | book.context |
| concept-04 | true | false | -15800 | tool.search |
| cross-01 | false | false | -4622 |  |
| cross-02 | false | false | 12234 | tool.search |
| cross-03 | false | false | -2617 |  |
| cross-04 | false | false | -19580 | book.concept |
| contrast-01 | false | false | 158 |  |
| contrast-02 | false | true | -45142 | book.concept, source.present |
| contrast-03 | true | true | 22561 |  |
| contrast-04 | false | false | -268 | book.concept, source.present |
| formula-01 | false | false | -11735 | book.concept, source.present |
| formula-02 | false | false | 10034 | book.concept, source.present |
| formula-03 | false | false | -10623 |  |
| formula-04 | false | true | -18990 | book.concept |
| refusal-01 | true | true | -37434 |  |
| refusal-02 | true | false | 31265 | book.structure, source.present |
| refusal-03 | false | false | -1342 | book.concept |
| refusal-04 | true | true | -26441 |  |

## 已知限制

- Single book development set, one sample per arm/task; no statistical significance claim.
- Added tool paths and changed success are paired observations, not proof of a specific edge causing the outcome.
- Any missing Provider usage makes cumulative token compliance unknown. In-flight overshoots are retained.
- Prebuild history is reported separately; no book rebuild is performed to fill missing measurements.

正文范围统计为实际请求中 book.text 已接纳 canonical 区间的并集；与 Runtime 的预算计量相同，重复回读不重复计算唯一范围，但仍计模型 Token。完整范围被文本投影进一步缩短时，该统计保守计入整个已接纳范围。

匿名逐题证据、请求设置、预算超出和成本分账见 [summary.json](summary.json)。原始请求与答案仅在本地 run.json 保存。
