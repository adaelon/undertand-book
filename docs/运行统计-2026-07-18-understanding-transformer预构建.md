# 2026-07-18 Understanding Transformer 预构建运行统计

> 用途：为未来 Agent、构建器维护者和预构建流程优化提供可复核的运行样本。
>
> 工作区：`.understand-book/understanding-transformer-from-the-perspective-of`
>
> 统计截止：2026-07-18 21:41:15（task 28 writer 产物时间）；本文生成时 builder 下一批为 task 29-33。

## 结论摘要

- 当前 builder 明确枚举了 4 个阶段、每阶段 48 个窗口，共 192 个任务。
- 已通过确定性 writer 的窗口产物 173 个，完成率 90.10%；剩余 profile-sidecar 任务 19 个（29-47）。
- 已完成 Pass1、paper-metadata、paper-lexicon；profile-sidecar 完成 29/48，尚未关闭。
- 至少产生 177 次 LLM 语义提取输出：173 个成功产物 + 3 次 schema 修正重试 + task 10 的一次压缩重提取。单纯重传不计入。
- 176 个临时 JSON 共 759,586 bytes；173 个 writer 产物共 956,487 bytes。
- Codex 当前任务与 builder 均未持久化精确 Token 遥测。根据可审计字节量估算，本次截至统计点约处理 0.8M-1.3M token-equivalent；这不是账单 Token，也不应当作精确消费值。
- 从首个 Pass1 产物到 task 28 产物的墙钟跨度为 11 小时 40 分钟；仅可见的 task 10-28 `apply_patch` 等待累计已不少于 57 分 35 秒。
- 主要瓶颈不是论文理解难度，而是 4 次全量窗口遍历、逐 LID sidecar 契约、大 JSON 经子代理消息与主代理补丁重复传输、文件写入异常慢，以及有效并发只有 1 个提取 worker。

## 输入规模

| 指标 | 数值 | 来源 |
| --- | ---: | --- |
| `source.txt` | 161,427 bytes / 810 行 | 文件统计 |
| PDF 页映射 | 46 页（0-45） | `pdf_selection_map/pages` |
| LID 节点 | 2,118 | `base.json.lid_nodes` |
| 图节点 | 877 | `base.json.graph_nodes` |
| 图边 | 1,003 | `base.json.graph_edges` |
| long-range candidates | 2,637 | `long_range_candidates.json` |
| Pass1 关闭时锚定率 | 44.14% | builder close 输出 |

OCR 把正文、公式、表格单元格、分隔符、脚注和参考文献拆成大量独立 LID。源文件只有 810 行，但最终有 2,118 个 LID 节点，因此“论文篇幅不大”没有转化为“小任务”。

## 任务统计

| 阶段 | 计划 | writer 产物 | 状态 | 产物 bytes | 产物时间范围 |
| --- | ---: | ---: | --- | ---: | --- |
| `pass1` | 48 | 48 | closed | 349,923 | 10:01:00-14:12:45 |
| `paper_metadata` | 48 | 48 | closed | 22,099 | 14:16:21-15:11:57 |
| `paper_lexicon` | 48 | 48 | closed | 159,203 | 15:18:37-17:52:53 |
| `profile_sidecar` | 48 | 29 | open，pending 19 | 425,262 | 18:21:26-21:41:15 |
| **合计** | **192** | **173** | **90.10%** | **956,487** | 10:01:00-21:41:15 |

注意：192 是当前 builder snapshot 已枚举的四阶段任务数。profile-sidecar 关闭后是否出现 Pass2 或 projection 新阶段，应以新的 `next` 返回为准，不能把 192 当作最终全流程上限。

## 已生成内容

| 产物 | 数量 |
| --- | ---: |
| graph nodes | 877 |
| graph edges | 1,003 |
| long-range candidates | 2,637 |
| metadata authors | 4 |
| metadata affiliations | 1 |
| metadata references | 49 |
| metadata datasets | 1 |
| lexicon entries | 466 |
| profile-sidecar discourse items（tasks 0-28） | 1,450 |
| profile-sidecar formula semantics（tasks 0-28） | 202 |

## 提取调用与重试

可由文件和已知失败复核的最小调用量：

```text
成功 writer 产物                         173
paper_metadata task 22 schema 修正         +1
paper_metadata task 23 schema 修正         +1
paper_lexicon task 15 evidence 修正         +1
profile_sidecar task 10 压缩重提取          +1
------------------------------------------------
最少 LLM 语义提取输出                     177
```

另有 task 9 完整 JSON 重传、task 10 写入失败后的再次返回等通信动作；这些没有形成新的语义提取版本，因此未计入 177。

### 明确失败

1. `paper_metadata` task 22：`references.value` 使用字符串数组，writer 要求结构化引用；修正后成功。
2. `paper_metadata` task 23：同类引用 schema 问题；修正后成功。
3. `paper_lexicon` task 15：`Optimal Memory.defined_at_lid` 未出现在 occurrences 中；修正后成功。
4. `profile_sidecar` task 9：曾生成 malformed 临时文件，验证前发现并删除；重新传输完整 80 discourse / 15 formula JSON 后成功。
5. `profile_sidecar` task 10：首版为 30 discourse / 12 formula；代理 `apply_patch` 长时间无文件，改由主代理请求压缩版本，最终写入 30 discourse / 6 formula。流程成功，但公式语义完整度下降。

## Token 统计口径

### 为什么没有精确值

- 当前桌面任务没有暴露历史 input/output/cached Token 汇总接口。
- `get_goal` 返回 `goal: null`，没有 token usage report。
- builder 的 job、stage artifact 和 attempt 记录没有保存模型、input tokens、cached tokens、output tokens。
- 因此不能从文件系统还原官方计费 Token；任何单一精确数字都是伪精确。

### 可审计数据

| 数据 | 数值 |
| --- | ---: |
| 临时提取 JSON | 176 files / 759,586 bytes |
| writer 阶段 JSON | 173 files / 956,487 bytes |
| 可信源正文 | 161,427 bytes |
| 四阶段理论正文遍历 | 约 645,708 source bytes，未含窗口 header、规则和重叠 |

临时 JSON 按混合中英文 JSON 常见编码密度粗略折算，单是模型生成的结构化结果约为 190k-300k output tokens。大量 JSON 又经历了：

```text
subagent JSON response
  -> root context
  -> root apply_patch 参数（同一 JSON 再出现一次）
  -> temp file
  -> deterministic writer
```

因此，结构化结果的消息与补丁传输本身约造成 380k-600k token-processing 量级；再加四阶段输入窗口、重复 extractor contract、工具输出、重试和长上下文，合理的总处理区间为 **0.8M-1.3M token-equivalent**。

这个区间只用于流程容量规划：

- 不等于 API/Codex 账单 Token；缓存命中会改变实际计费。
- 不含系统内部不可见的压缩、推理或平台开销。
- 未来必须以原生遥测替代该估算。

## 时间统计

| 区段 | 墙钟跨度 |
| --- | ---: |
| workspace foundation 最早文件至 task 28 | 00:38:03-21:41:15（21:03:12，含长间隔） |
| Pass1 首产物至 task 28 | 10:01:00-21:41:15（11:40:15） |
| Pass1 | 4:11:45 |
| metadata | 0:55:36 |
| lexicon | 2:34:16 |
| sidecar tasks 0-28 | 3:19:49 |
| 可见 task 10-28 `apply_patch` 等待下界 | 0:57:35 |

`apply_patch` 延迟高度不稳定：同类 JSON 有时 7 秒完成，有时 8-12 分钟。task 18 约 12 分 27 秒、task 24 的单行 202-byte JSON 仍约 9 分 16 秒，说明耗时与文件大小不成比例，更像工具/沙箱调度异常，而不是 JSON 解析成本。

## 事故与流程缺陷

### P0：没有 Token 与延迟遥测

无法回答精确消费、缓存命中、哪个 stage 最贵、生成和等待各占多少。只能在事后用 bytes 和时间戳估算。

### P0：大 JSON 经过对话往返

extractor 输出先进入子代理消息，再完整进入主代理补丁。JSON 越大，主上下文越快膨胀，compaction 后还可能要求重传。模型被当成了文件传输总线。

### P0：`record-attempt` 共享账本不可并行

并行记录会竞争同一个 ledger，存在覆盖/丢记录风险。本次改为严格串行。此前一次错误地对 `next` 传入 `source.txt` 而非 workspace dir，创建了 `.understand-book/source` 假工作区并造成 ledger 解析冲突；审计后删除，并串行重放正确工作区的记录。

### P1：有效并发退化为 1

技能要求每个 task 隔离 extractor，但 agent thread limit 和已占用 slot 阻止创建足够 worker。最终反复复用一个 agent，任务串行执行，也弱化了“隔离上下文”的原始设计。

### P1：写入路径异常慢且不可靠

子代理 `apply_patch` 曾长时间无产物；主代理写入也多次等待数分钟。等待不创造语义价值，却占据整个串行关键路径。

### P1：所有 stage 都全量遍历

metadata 的多数窗口只生成空结果；参考文献窗口仍为每个 LID 调用 LLM 生成 meta discourse。结构上可确定的空窗口、参考文献和分隔符没有在 LLM 前被裁剪。

### P1：任务粒度由 OCR 而非语义成本主导

80-LID 窗口可能是正文推导，也可能是表格碎片或 bibliography。task 数相同，但输出规模、公式密度和耗时差异很大，导致批次预算不可预测。

### P2：压缩输出改变质量

为控制传输和写入失败，后半段要求“sparse relations / only strongly grounded formulas / omit optional fields aggressively”。这符合 schema，但与首版丰富输出相比可能降低 local summary、relation 和 formula coverage；task 10 已出现可量化下降（12 -> 6 formulas）。

### P2：中途 checkpoint 不够及时

虽然构建产物可恢复，但任务状态主要靠会话摘要衔接。用户中断时 task 28 writer 已成功、下一步为 29-33；若没有再次调用 builder `next`，接手 Agent 容易重复工作。

## 优化清单

### P0：先补原生遥测

每个 task 原子追加 `.build/automatic-build/task-metrics.jsonl`：

```json
{"stage":"profile_sidecar","task_id":"28","attempt":1,"model":"...","input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"queue_ms":0,"model_ms":0,"writer_ms":0,"input_bytes":0,"output_bytes":0,"status":"success","error_code":null}
```

stage close 时生成聚合：总 Token、P50/P95 延迟、重试数、空输出率、每 1k LID 成本。没有这份数据，不应再向用户承诺精确 Token 或时间。

### P0：改为 artifact handoff

目标数据流：

```text
subagent/executor -> task-owned temp file -> schema writer -> artifact
root             -> 只接收 path/hash/counts/diagnostic
```

禁止在正常路径中把完整 JSON 返回 root 后再放入 `apply_patch`。可新增 builder 命令接收受控 stdin，或让 executor 写入预分配且仅属于该 task 的路径；writer 仍负责最终门禁。

### P0：attempt 存储改为每任务文件或原子 JSONL

- 每个 task 写独立 attempt 文件，stage close 再确定性汇总；或使用文件锁 + append-only JSONL。
- `record-attempt` 必须幂等，键为 `(book_id, stage, task_id, attempt)`。
- `next` 参数应拒绝 file path，只接受含 workspace manifest 的目录，消除 `source.txt` 误用。

### P1：预路由与跳过

在调用 LLM 前确定性分类窗口：

- metadata：无候选 title/author/reference/dataset 信号则直接写空产物。
- bibliography：确定性写 `mode=meta`，不逐 LID 调 LLM。
- 表格分隔符、脚注号、裸变量：不进入 formula semantics 候选。
- 仅对含解释性邻接文本的公式调用 formula extractor。

本样本中 task 22-23 的 117 个 bibliography LID 可完全确定性处理；metadata 大量 22-byte 临时结果说明跳过空间很大。

### P1：按成本而非固定 5-task 批处理

先计算：

```text
cost = visible_lids + 3 * formula_lids + 2 * table_fragment_count
```

同一批的总 cost 受限；80-LID/39-formula 窗口不应与其他大窗口并发占用上下文。小窗口可合批，但 writer/attempt 仍按 task 隔离。

### P1：安全并发

- extractor worker pool 设为 2-3，根据可用 agent slot 动态调整。
- prompt contract 每 stage 只加载一次，任务只发送 input shard。
- writer 可并行写 task-owned artifact；ledger commit 单线程或按任务分片。
- 不复用带历史输出的 agent 作为“隔离”worker；使用无历史 worker 或 builder executor process。

### P1：运行前预算门禁

在第一批前输出预估并要求策略选择：

```text
window_count / lid_count / formula_count
estimated_input_tokens / estimated_output_tokens
estimated_wall_time at concurrency N
quality_profile = full | balanced | sparse
```

超过用户设定阈值时暂停，而不是运行数小时后才发现成本异常。quality profile 必须在阶段开始前冻结，不能像 task 10 那样因写入失败临时降低覆盖。

### P2：每批 checkpoint

每 5 个任务完成后写：last successful task、artifact hash、pending tasks、retry diagnostics、累计 metrics。恢复只信 builder `next` 和磁盘 artifact，不信会话记忆。

### P2：临时文件生命周期

当前根目录保留 176 个临时 JSON。writer 成功并记录 hash 后，应把临时输出移入 `.build/raw-extractor-output/<stage>/` 或按 retention policy 清理；根目录不应承担任务队列职责。

## 未来 Agent 接手指令

1. 不要重跑 0-28；先执行 builder `next`，当前返回 profile-sidecar tasks 29-33，pending 总数 19。
2. `next` 必须传 workspace 目录，不得传 `source.txt`。
3. writer 可按 task 并行，但 `record-attempt` 必须串行，直到存储实现修复。
4. 不要让子代理直接 `apply_patch` 大 JSON；若没有 artifact handoff 能力，先向用户暴露成本风险。
5. 不要宣称精确 Token；除非新遥测文件已实际记录 usage。
6. profile-sidecar 关闭后继续调用 `next`，不能假定四阶段就是最终完成状态。

## 复核命令

```powershell
# 当前 builder 状态
& 'E:\allwork\Understand Book\understand-book-build.exe' next `
  'E:\allwork\download\agent\understand-book\.understand-book\understanding-transformer-from-the-perspective-of' `
  --plugin-root 'C:\Users\Lenovo\.codex\plugins\cache\understand-book\understand-book\0.1.0' `
  --root 'E:\allwork\download\agent\understand-book'

# 各阶段 writer 产物数量与字节数
Get-ChildItem -File `
  '.understand-book\understanding-transformer-from-the-perspective-of\.build\<stage>\*.json' |
  Measure-Object Length -Sum
```

## 数据可信度

- **精确**：任务/产物数量、bytes、文件时间、节点/边/LID、sidecar item 数、当前 pending 数。
- **高可信人工审计**：明确 schema 失败、错误工作区、ledger 串行化、task 9/10 写入事故、可见 `apply_patch` 等待下界。
- **估算**：Token 区间、实际模型调用总数中的纯重传次数、缓存命中与平台内部推理开销。

## 后续决策与方案

- [ADR-0084：Codex harness 推理与持久化 sidecar 任务 mailbox](./adr/0084-codex-harness-inference-and-durable-sidecar-task-mailbox.md)
- [ADR-0085：阶段专属工作单元与策略绑定工件](./adr/0085-stage-specific-work-units-and-policy-bound-artifacts.md)
- [详细优化方案：一键预构建执行面与成本治理](./修复方案-一键预构建执行面与成本治理.md)
- [实施切片方案：一键预构建执行面与成本治理](./切片方案-一键预构建执行面与成本治理.md)
