# 2026-07-24 Quantification Essence full 预构建性能与成本复盘

> 用途:为后续维护者优化一键预构建的墙钟时间、模型成本、租约恢复与遥测提供可复核的真实样本。
>
> 样本书:`quantification-essence`
>
> 统计日期:2026-07-24,Asia/Hong_Kong。
>
> 本文只记录构建事实、诊断推断和待验证方案,不是质量降级授权,也不是迁移或清理指令。

## 1. 结论摘要

本次约 5 小时的高成本不是单一模型问题。直接原因是语义任务延迟超过初始 5 分钟 lease,触发重复领取和代理重启;随后又进入拥有 401 个 eligible 微型单元的 `profile_sidecar`,每个单元都需要新的专用 subagent,冷启动成本已经高于首批单元的语义执行成本。

主要结论:

- Pass1 共 46 个 work unit,从首批 lease 发出到最后一个 commit 用时 4 小时 47 分 17 秒。
- Pass1 单 attempt 的 `executor_ms` P50 为 4.50 分钟,P95 为 8.94 分钟,最大 16.20 分钟;固定 5 分钟 lease 与实际分布明显不兼容。
- 18 个 5 分钟 lease 仅 3 个提交,提交率 16.7%;改为 30 分钟后,49 个 lease 中 43 个提交,提交率 87.8%。
- 46 个 Pass1 work unit 实际创建 67 个 lease/attempt 目录,21 个没有 receipt,10 个任务被重复领取,最大 attempt 编号达到 5。
- Pass1 记录到的 executor 总时长为 257.06 slot-minutes,lease wait 总时长为 110.73 slot-minutes。按 3 worker 理论摊平约 122.60 分钟,实际为 287.30 分钟,仍有约 164.70 分钟落在未计量过期任务、批次切换、重规划和未充分利用的并发槽位中。
- Pass1 integrity 与 `full` quality gate 均通过。性能事故不是质量门反复失败造成的。
- `profile_sidecar` 共 1,057 个语义微单元,401 个 eligible,656 个 deterministic skip。当前只提交 3 个,仍有 398 个 pending。
- `profile_sidecar` 首批 3 个任务平均 executor 1.67 分钟,平均 lease wait 2.40 分钟。代理启动等待已超过语义执行本身。
- 当前 usage 全部为 `source=unavailable`,receipt 没有模型 ID,工作区内也没有同口径的 Luna 高历史 v2 metrics。因此不能从现有账本定量证明 Luna 高快多少。
- “Luna 高更快”是合理假设,但更重要的机制是阈值放大:模型只需稍慢到越过 5 分钟 lease,系统就会从线性变慢变成重复执行。
- 当前没有后台 `understand-book-build` 进程。磁盘状态可续建,不是丢失或重置。

## 2. 样本身份与边界

| 项目 | 值 |
| --- | --- |
| 原始输入 | `E:\allwork\download\agent\clamp\(2026-06-24)你认为量化的本质是什么？_栀染.md` |
| 构建输入副本 | `target/prebuild-input/quantification-essence.md` |
| book_id | `quantification-essence` |
| workspace | `.understand-book/quantification-essence` |
| source bytes | 335,861 |
| source SHA-256 | `77628C8460E25635AD36A2D90673DB67944180A126AD6D18FD7B7CCC9DDB7D34` |
| content profile | `technical_learning` |
| quality profile | `full` |
| protocol | `automatic_build_protocol.v2` |
| 最大专用 worker | 3 |
| plugin skill release | `0.1.0+codex.20260721044654` |
| Pass1 plan digest | `1c95d7444915f140a20c1e240a015a7d9e43212924c9429ff6da1285d8c3a350` |
| profile_sidecar plan digest | `b1fada8447f7d32ae246c7e2913cf8d28adc803321f3ce5deec6bd92da241304` |

本次执行遵守以下边界:

- 原始输入只读,构建使用逐字节一致的 ASCII 文件名副本。
- 语义提取由专用 subagent 执行,root 不承担 extractor 角色。
- 未使用 `--allow-partial`,未绕过 integrity gate 或 quality gate。
- `.build/automatic-build/v2` 是续建真相,本文不从会话回忆重建任务状态。
- 未清理或覆盖其他书籍。
- 本文不评价内容质量优劣,只分析执行成本与协议行为。

## 3. 证据来源与统计口径

主要证据均来自本书持久化状态:

```text
.understand-book/quantification-essence/
  .build/automatic-build/v2/
    preflight/
    policies/
    tasks/<stage>/<work_unit_id>/attempts/<attempt>/
      lease.json
      metrics.json
      failure.json
      receipt.json
    metrics/pass1.json
    quality/pass1.json
    publication/pass1/<transaction>/receipt.json
```

口径说明:

- `lease count` 来自所有 `lease.json`,包括最终没有 metrics/receipt 的过期或中断 lease。
- `metrics attempt count` 来自 `metrics.json`,只覆盖实际落盘 metrics 的 attempt。
- `committed` 来自 `receipt.json`,不以 candidate 文件存在代替。
- `lease_wait_ms` 是 lease 发出至 executor 开始处理 input 的时间,当前可近似反映 subagent 冷启动与调度等待。
- `executor_ms` 包含 executor 从读取 input 到 submit 路径结束的时间,不等于 provider 官方推理时间。
- `writer_ms` 是确定性 writer 时间。
- 所有 UTC 时间在时间线中转换为 Asia/Hong_Kong,即 UTC+8。
- Token 估算来自 preflight descriptor,不是账单 Token。

## 4. 执行时间线

| 时间,UTC+8 | 事件 |
| --- | --- |
| 15:42:41 | Pass1 plan 接受并发出首批 5 分钟 lease |
| 15:57:52 | 首个 Pass1 receipt committed |
| 17:32:53 | 发出首批 30 分钟 lease,避免长任务持续过期 |
| 20:29:58 | 最后一个 Pass1 work unit committed |
| 20:33:17 | `profile_sidecar` full policy 冻结并接受 plan |
| 20:37:02-20:37:36 | 首批 3 个 sidecar unit committed |
| 诊断时 | stage 停在 `profile_sidecar`,398 pending,无活动 build 进程 |

Pass1 墙钟:

```text
first lease issued : 2026-07-24 15:42:41.110 +08:00
last Pass1 commit  : 2026-07-24 20:29:58.870 +08:00
wall clock         : 04:47:17.760
```

该墙钟包含模型执行、专用 agent 启动、lease 过期等待、重新 plan/next、失败恢复和批次收口,不等于纯模型时间。

## 5. Pass1 规模、质量与产物

### 5.1 工作量

| 指标 | 数值 |
| --- | ---: |
| Work units | 46 |
| Committed units | 46 |
| Skipped units | 0 |
| 落盘 metrics attempts | 48 |
| Metrics 中 committed | 46 |
| Metrics 中 non-committed | 2 |
| 输入 bytes 合计 | 381,137 |
| 输出 bytes 合计 | 736,638 |
| Writer 总时长 | 56.10 秒 |
| Writer P95 | 1.82 秒 |

Writer 总时长不到 1 分钟,因此正常 writer 不是 4 小时 47 分墙钟的主要瓶颈。异常 candidate 解析失败另见第 8 节。

### 5.2 延迟

| 指标 | P50 | P95 | 最大值/合计 |
| --- | ---: | ---: | ---: |
| executor | 4.50 分钟 | 8.94 分钟 | 最大 16.20 分钟,合计 257.06 分钟 |
| lease wait | 2.08 分钟 | 3.22 分钟 | 合计 110.73 分钟 |
| writer | 1.15 秒 | 1.82 秒 | 合计 56.10 秒 |

`executor P95 + lease wait P95` 已超过 12 分钟。固定 5 分钟 TTL 在该环境下无法覆盖正常任务生命周期。

### 5.3 Quality gate

Pass1 质量报告:

| 项目 | 结果 |
| --- | --- |
| Integrity | passed |
| Quality | passed |
| Gate | passed |
| Eligible coverage | 1.0 |
| Empty unit rate | 0 |
| Low-information rate | 0 |
| Grounded units | 46 |
| Emitted items | 2,328 |
| Missing/stale/legacy artifacts | 0/0/0 |
| Policy generations | 1 |

正式 Pass1 publication 已提交以下关键产物:

| 产物 | 结果 |
| --- | ---: |
| `base.json` | 1,527,879 bytes |
| LID nodes | 2,757 |
| Graph nodes | 2,002 |
| Graph edges | 1,769 |
| `long_range_candidates.json` | 8,748,970 bytes |
| Long-range candidates | 16,947 |
| `source.txt` | 335,861 bytes,hash 与输入一致 |

关闭时另报告 2,623 个 leaf LID,其中 1,774 个被锚定,锚定率 67.63%。这证明 Pass1 输出规模不小,但质量门一次通过,没有因质量失败导致整个 stage 重跑。

## 6. Lease 失配与重复领取

### 6.1 总体数据

| 指标 | 数值 |
| --- | ---: |
| Work units | 46 |
| Lease/attempt directories | 67 |
| 带 receipt 的 lease | 46 |
| 无 receipt 的 lease | 21 |
| 被重复领取的任务 | 10 |
| Claim batches | 23 |
| 3 worker 理想最少批次 | 16 |
| 额外批次 | 7 |
| 最大 attempt 编号 | 5 |

67 个 lease 对应 46 个最终提交,即 31.3% 的 lease 没有形成 receipt。未提交 lease 不一定都完成了完整模型推理,但它们至少占用了调度周期,部分还在过期后继续执行并产生重复工作。

### 6.2 TTL 对比

| TTL | Lease 总数 | Committed | 未提交 | 提交率 |
| --- | ---: | ---: | ---: | ---: |
| 5 分钟 | 18 | 3 | 15 | 16.7% |
| 30 分钟 | 49 | 43 | 6 | 87.8% |

仅按 lease 占用下界计算,15 个失败的 5 分钟 lease 至少浪费 75 slot-minutes,三路并发下相当于至少 25 分钟墙钟。实际浪费可能更高,因为外部 subagent 不会在 lease 过期瞬间自动停止。

### 6.3 多 attempt 任务

| Task | Lease 数 | 最大 attempt |
| --- | ---: | ---: |
| 4 | 5 | 5 |
| 27 | 4 | 4 |
| 37 | 4 | 4 |
| 11 | 3 | 3 |
| 26 | 3 | 3 |
| 30 | 3 | 3 |
| 35 | 3 | 3 |
| 7 | 2 | 2 |
| 12 | 2 | 2 |
| 43 | 2 | 2 |

当前 `$understand-book-build` skill 声明“Automatic repair permits at most three total attempts per task”,但 task 4 达到 attempt 5,task 27/37 达到 attempt 4。可能解释有两种:

1. lease expiry 被当作新的 lease epoch,但不计入 semantic repair attempt;
2. retry exhaustion 只统计有 failure metrics 的 attempt,忽略无 metrics 的 expired lease。

无论哪一种,当前磁盘命名和 skill 中“total attempts”的语义不一致。未来必须拆分 `lease_epoch` 与 `semantic_attempt`,或让总 attempt 门禁覆盖 expiry;不能继续让运维人员看到 attempt 5 却由 summary 报告 retry 2。

## 7. 并发利用率

已记录 slot time:

```text
executor slot-minutes   = 257.06
lease-wait slot-minutes = 110.73
writer slot-minutes     =   0.94
recorded total          = 368.73
```

忽略负载不均衡时,3 worker 理论墙钟:

```text
368.73 / 3 = 122.91 minutes
```

实际 Pass1 墙钟为 287.30 分钟,记录到的有效 slot time 只覆盖理论总容量的:

```text
368.73 / (287.30 * 3) = 42.8%
```

剩余约 57.2% 容量并不等于机器空闲,其中包括:

- 没有 `metrics.json` 的 21 个过期或中断 lease;
- `plan -> next -> spawn -> wait -> receipt -> plan` 的批次切换;
- agent slot 启动不同步,部分 worker 已运行而其他 worker 仍在冷启动;
- heartbeat 不及时导致的 lease 恢复等待;
- 失败后同 attempt 修复与重新 submit;
- root 等待 subagent 收口和工具调用返回。

23 个 claim batch 比理论最少 16 个多 43.8%。即使单次 plan/next 只消耗数秒到十余秒,额外 agent 冷启动仍会显著放大总墙钟。

## 8. 失败与遥测盲区

扫描 `failure.json` 得到 10 次明确失败:

| diagnostic | 次数 | 说明 |
| --- | ---: | --- |
| `writer_failed` | 8 | JSON 开头包含 UTF-8 BOM,解析器报 `Unrecognized token` |
| `input_failed` | 1 | input command 失败 |
| `submit_failed` | 1 | submit 命令返回非零 |

8 次 writer failure 都在同 attempt 内恢复并最终提交。最终 receipt 相对 failure 时点累计增加约 8.84 executor-minutes,因此 BOM 不是本次 5 小时的首要原因,但属于完全可消除的返工。

更重要的是遥测不一致:

- `failure.json` 实际有 10 个;
- `metrics/pass1.json` 的 `diagnostic_counts` 只报告 `input_failed=1`、`submit_failed=1`;
- 同 attempt 先 failure、后 committed 时,最终 `metrics.json` 覆盖了中间状态,stage summary 看不到 8 次 writer failure;
- 磁盘有 67 个 lease attempt 目录,stage summary 只报告 `attempt_count=48`、`retry_count=2`。

因此现有 stage metrics 能准确描述最终落盘 attempt,但不能完整描述所有 lease epoch 与同 attempt 内的失败事件。未来不能只依赖 `metrics/pass1.json` 做成本归因。

## 9. Profile Sidecar 的剩余成本

### 9.1 Preflight

| 指标 | 数值 |
| --- | ---: |
| Total semantic units | 1,057 |
| Eligible | 401 |
| Deterministic skip | 656 |
| Committed | 3 |
| Pending | 398 |
| Score total | 271,234 |
| Score P50/P95/max | 353 / 2,064 / 2,844 |
| Estimated input tokens | 152,194 |
| Estimated input P50/P95/max | 202 / 1,224 / 2,004 |
| Estimated total tokens | 163,202-467,714 |
| Budget status | `within_budget` |
| Max workers | 3 |

`profile_sidecar_semantic_units.v2` 已实现 stage-specific routing,656 个单元被确定性跳过,这比“每个 LID 都调用模型”明显更好。但 eligible 单元的 P50 输入只有 202 tokens,仍然过细。每个 202-token 量级单元启动一个完整专用 agent,调度开销会主导总成本。

### 9.2 首批实测

| 指标 | 3 个任务合计 | 每任务平均 |
| --- | ---: | ---: |
| executor | 5.02 分钟 | 1.67 分钟 |
| lease wait | 7.20 分钟 | 2.40 分钟 |
| writer | 4.34 秒 | 1.45 秒 |
| input | 812 bytes | 271 bytes |
| output | 953 bytes | 318 bytes |

首批中 `lease wait / (lease wait + executor)` 为 58.9%。也就是超过一半的已记录 slot time 用在 executor 真正处理 input 之前。

### 9.3 外推,低置信

仅用首批 3 个任务外推剩余 398 个,样本很小,只能作为成本风险信号:

```text
纯 executor 下界:
398 * 1.67 / 3 workers = 221.6 minutes,约 3.7 小时

包含当前平均 lease wait:
398 * (1.67 + 2.40) / 3 workers = 539.9 minutes,约 9.0 小时
```

该外推不包含后续 Pass2、BookStructure、close/gate,也没有考虑 P95 大单元。它不是交付承诺,但足以说明“继续按当前粒度运行”存在明显成本风险。

## 10. Luna 高假设

用户提供的历史信息是以前使用 Luna 高时体感更快。当前证据无法做严格 A/B:

- 48 个 Pass1 metrics 的 usage 全部为 `source=unavailable`;
- receipt 和 policy fingerprint 没有记录实际 model ID 或 reasoning effort;
- 当前 workspace 只有本次 automatic-build v2 metrics,没有 Luna 高的同源、同 prompt、同 profile 历史样本;
- `executor_ms` 同时包含 harness、模型、candidate 写入和 submit,不是纯 provider latency。

仍可提出一个高可信机制假设:

```text
模型或 harness 稍慢
  -> P50/P95 生命周期越过 5 分钟 TTL
  -> lease 过期并重新领取
  -> 旧 subagent 可能继续运行
  -> 重复执行 + 新 agent 冷启动
  -> 墙钟和成本非线性上升
```

因此,Luna 高可能既有直接速度优势,也可能因为保持在 TTL 阈值以内而避免了重复执行。第二部分会放大第一部分,不能用“当前模型慢了多少百分比”线性解释总耗时。

### 10.1 建议的模型 A/B

未来不要再用整本书做第一次比较。建立隔离 benchmark namespace,不得提交到正式 stage:

1. 固定 source fingerprint、prompt hash、schema、quality profile 与 executor envelope。
2. 从 Pass1 选择 9 个 descriptor,覆盖 input/score 的 P25、P50、P95。
3. 从 profile_sidecar 选择 30 个 micro-unit,覆盖短 discourse、长 discourse、formula context。
4. Luna 高和候选模型各预热一次,然后每个样本运行 3 次。
5. 分开记录 agent cold start、input read、model/executor、candidate write、submit、writer。
6. 比较 P50/P95、首次 writer 通过率、output bytes、quality gate、Token 与单位成本。
7. 模型 ID、reasoning effort、harness release 必须写入 usage/provenance。

在该 A/B 完成前,不应把 Luna 高写死为默认模型,也不应把本次事故全部归因于模型。

## 11. 根因分层

### P0-A:固定 lease TTL 与真实延迟分布失配

证据:5 分钟 lease 提交率 16.7%,30 分钟 lease 提交率 87.8%。

根因不是“偶发超时”,而是 TTL 小于正常 P50 生命周期。lease 应根据 stage 历史分布、当前模型与 heartbeat 自动续期,不能依赖 root 在事故中手工改成 30 分钟。

### P0-B:Sidecar work unit 过细

证据:eligible 401,P50 输入 202 tokens,首批平均 executor 1.67 分钟而 cold start 2.40 分钟。

ADR-0085 要求 stage-specific work unit,但“stage-specific”不自动等于“成本合适”。应保留 micro-unit 级 accounting,同时将多个相邻/同类 micro-unit 打包进一个 lease,减少专用 agent 数。

### P0-C:Preflight 预算缺少可执行的墙钟门禁

本次 sidecar 398 pending、估算最多 467,714 tokens,仍返回 `within_budget`。当前默认预算主要限制 task、score、estimated tokens 与 parallel cost,没有利用历史 `lease_wait + executor` 预测墙钟,因此无法在第一批前暴露“可能再运行数小时”。

### P0-D:Attempt 与 retry 语义不一致

磁盘最大 attempt 5,skill 声明最多 3 次,total summary 却只报 retry 2。lease expiry、semantic failure 和同 attempt 内 repair 需要分层计数,并由一个明确门禁决定何时 `needs_user(retry_exhausted)`。

### P1-A:Candidate 编码不稳定

8 次 UTF-8 BOM 导致 writer parse failure。Candidate writer 应使用无 BOM UTF-8;确定性 JSON loader 也可以在不改变 payload 的前提下容忍单个标准 BOM。

### P1-B:失败事件聚合不完整

最终 metrics 覆盖了同 attempt 中间 failure,stage summary 漏掉 8 次 writer failure 和 19 个无 metrics lease。需要 append-only attempt events 或由 lease/failure/receipt 三类文件联合重算。

### P1-C:缺少模型与原生 usage provenance

设计文档允许 provenance 记录 model,但本次 48 个 Pass1 attempt 全部 usage unavailable。没有 model ID、reasoning effort 和 exact usage,无法回答模型比较与账单成本。

### P1-D:批次级冷启动

Pass1 23 个 claim batch,sidecar 按 3 tasks/batch 继续执行将需要约 133 批。每批重新 plan/next 并启动专用 agent,对 202-token P50 单元不经济。

## 12. 已有方案为何没有完全解决本次问题

[一键预构建执行面与成本治理修复方案](./修复方案-一键预构建执行面与成本治理.md) 已解决多项旧问题:

- Candidate 不再经 root 对话中转,改为 executor-owned mailbox。
- Task lease、heartbeat、attempt 和 receipt 已持久化,中断后可从磁盘续建。
- `profile_sidecar_semantic_units.v2` 能跳过 656 个无价值单元。
- Policy fingerprint、integrity gate 与 quality gate 工作正常。
- Pass1 公共产物只在全量门禁通过后发布。

本次暴露的是下一层问题:

- AP0-AP16 的发布结论主要证明协议正确性、可恢复性与 fake executor parity,不能代替真实 harness/model 的延迟基准。
- Lease 协议存在,但默认 TTL 没有按真实 P95 校准。
- Stage-specific router 存在,但 sidecar micro-unit 粒度仍小于 agent 冷启动成本。
- Metrics 存在,但 summary 没有覆盖全部 lease epoch 和中间 failure。
- Token preflight 存在,但缺少 wall-clock/cold-start 预算。

这不是推翻 ADR-0084/0085,而是用真模型数据补齐它们的性能闭环。

## 13. 当前构建的安全处理

当前磁盘状态:

```text
pass1           : closed,integrity passed,quality passed
profile_sidecar : full policy frozen,3 committed,398 pending
active process  : none
budget          : within_budget,但不代表墙钟可接受
```

处理原则:

- 不删除或重建 Pass1。已发布 artifact 与质量报告有效。
- 切换 harness 模型本身不在当前 policy fingerprint 中;按照现有设计,model 只应进入 provenance,不应无意义地使 artifact stale。因此可在同一 sidecar policy 下换回 Luna 高续建。
- 继续前保持 30 分钟 TTL,并确保 heartbeat 在长任务期间实际更新 lease。
- 若先实现 sidecar bundling,`router_version` 或 stage policy 必须升级。当前 3 个 sidecar artifact 应按显式 policy migration 处理,不得与新 router 混合后宣称 complete。
- 任何优化都不得使用 `--allow-partial`、generic summary、空节点或 reject-all 代替真实 semantic output。

## 14. 优化方案

### 14.1 P0:自适应 lease 与可靠 heartbeat

建议按 stage 与模型历史值计算初始 TTL:

```text
service_p95 = p95(lease_wait_ms + executor_ms + writer_ms)
initial_ttl = clamp(min_ttl,ceil(1.5 * service_p95),max_ttl)
```

在没有历史数据时使用保守 bootstrap,例如 15-30 分钟,并把低置信度写入 preflight。Heartbeat 必须由 executor watchdog 独立于模型输出触发,不能依赖模型“记得执行”。

验收:

- 同一固定 benchmark 的 lease expiry rate 小于 2%。
- 16 分钟 executor 任务只产生一个 lease epoch并正常提交。
- Heartbeat 中断后能在 TTL 到期恢复,不会无限占用。
- Source/policy 改变时 heartbeat 不得延长 stale lease。

### 14.2 P0:Sidecar micro-unit bundling

保持 micro-unit 级证据与完成记账,将多个相邻或同类 micro-unit 装进一个 executor lease:

```ts
interface ProfileSidecarBundleV1 {
  bundle_id: string;
  micro_units: ProfileSidecarMicroUnit[];
  estimated_input_tokens: number;
  expected_output_items: number;
  score: number;
}
```

Bundler 约束:

- 同一 bundle 共享 profile、prompt、schema 与 source fingerprint。
- 按章节邻接和 discourse/formula kind 分组,避免无关上下文混合。
- 每个 micro-unit 仍有独立 evidence LID、result 和 skip/failure accounting。
- Writer 可整 bundle 校验后原子拆写,或写 bundle artifact 后由 close 投影;不得丢失 unit 级可恢复性。
- Bundle 超过 output/schema 限制时确定性二分,不能要求模型临时变 sparse。

首个目标不是拍死 bundle 大小,而是让 P50 executor 时间显著高于 agent cold start。可从每 bundle 8-16 个短单元、2,000-6,000 estimated input tokens 开始真书校准。

验收:

- 本样本 401 个 eligible micro-unit 全部 accounted。
- Lease/task 数相对 401 至少下降 70%。
- Cold-start slot time 占比低于 25%。
- Discourse/formula quality floor 不低于未 bundling 基线。
- 单个 bundle 失败只重做该 bundle,不重跑整个 stage。

### 14.3 P0:墙钟与冷启动预算

Preflight 应同时输出 Token 和墙钟区间:

```text
task_service_ms = historical_p50/p95(lease_wait + executor + writer)
predicted_wall_ms = deterministic list scheduling(work_units,max_workers)
confidence = sample_count + model_match + policy_match
```

预算至少支持:

```ts
interface AutomaticBuildWallBudgetV1 {
  max_wall_clock_minutes?: number;
  max_agent_starts?: number;
  max_duplicate_lease_ratio?: number;
  on_exceed: "needs_user" | "stop";
}
```

无历史数据时必须显示低置信区间并在高 agent-start 任务上进入 `needs_user`,不能仅因 estimated tokens 小于 10M 就直接运行。

### 14.4 P0:区分 lease epoch 与 semantic attempt

建议状态标识拆为:

```text
work_unit_id
  semantic_attempt:因 schema/evidence/provider 失败而重新生成语义
    lease_epoch:因进程/heartbeat/owner 中断而重新领取
      submit_revision:同 lease 内修复编码或重传
```

门禁:

- `max_semantic_attempts=3` 与 skill 保持一致。
- Lease epoch 可有独立上限,超过后 `needs_user(executor_instability)`。
- 同 lease 的 BOM 重写只增加 submit revision,不伪装为新 semantic attempt。
- Stage summary 必须同时报告三种计数。

### 14.5 P1:统一无 BOM JSON 写入

- 插件提供受控 candidate writer/helper,默认 UTF-8 no BOM。
- Windows PowerShell 5.1 禁止直接以默认 `Set-Content -Encoding UTF8` 写 candidate。
- Sidecar JSON reader 可剥离文件起始的单个 `U+FEFF`,随后仍执行原 schema/hash/evidence gate。
- 增加 UTF-8 no BOM、UTF-8 BOM、UTF-16 和前导垃圾的 fixture;只允许前两者按明确策略处理。

### 14.6 P1:完整事件遥测

Stage summary 必须由以下并集重算:

```text
lease.json + heartbeat.json + failure.json + receipt.json + metrics.json
```

新增指标:

- lease issued/expired/committed 数;
- duplicate lease ratio;
- semantic attempt、lease epoch、submit revision;
- cold-start ratio;
- 同 attempt failure/recovery 分布;
- worker utilization;
- model/reasoning effort/harness release;
- exact usage coverage 与 estimate 分栏。

要求 `failure.json=10` 时 summary 不能只报告 2 次失败。

### 14.7 P2:减少批次冷启动

优先采用 router bundling,因为它不改变“一个 lease 对应一个专用 subagent”的安全边界。若 Codex 后续提供稳定的进程级任务 API,再评估同一专用 worker 顺序处理多个同 policy bundle,mailbox 与 writer gate 保持不变。

## 15. 回归基准与验收矩阵

使用相同 source fingerprint 和 `full` profile 建立许可 benchmark。正式发布前至少覆盖 Luna 高与当前候选模型。

| 维度 | 当前基线 | 目标 |
| --- | ---: | ---: |
| Pass1 lease expiry/uncommitted ratio | 31.3% overall;5 分钟组 83.3% | <2% |
| Duplicate lease ratio | 21/67 = 31.3% | <5% |
| Pass1 claim batches | 23 | 接近理论排程,额外批次 <10% |
| Pass1 recorded utilization | 42.8% | >75% |
| Sidecar cold-start ratio | 58.9%,n=3 | <25% |
| Sidecar agent starts | 预计约 401 | 至少减少 70% |
| Max semantic attempts | 磁盘 attempt 5,语义不清 | <=3 且口径一致 |
| BOM writer failures | 8 | 0 |
| Failure summary coverage | 2/10 | 100% |
| Model provenance | 0% | 100% |
| Exact usage | unavailable | 可用则精确记录,不可用则明确 unavailable |
| Wall-clock preflight | 无可执行预测 | 校准后误差 <=30% |
| Pass1 quality gate | passed | 继续 passed,不得降 floor |

性能验收不能用 fake executor 单独通过。至少需要一次真实 harness/model 回放,并报告:

- source/policy/model identity;
- work-unit 与 bundle 分布;
- P50/P95 cold start、executor、writer;
- lease expiry 和 duplicate ratio;
- exact usage coverage;
- quality report digest;
- predicted 与 actual wall clock 偏差。

## 16. 复核命令

以下命令只读,用于未来接手者复算本文关键数字。

### 16.1 当前 plan

```powershell
& 'E:\allwork\Understand Book\understand-book-build.exe' plan `
  'E:\allwork\download\agent\understand-book\target\prebuild-input\quantification-essence.md' `
  --plugin-root 'E:\allwork\download\agent\understand-book\plugins\understand-book' `
  --max-parallel 3 `
  --available-agent-slots 3 `
  --quality-profile full
```

预期 durable state:

```text
stage=profile_sidecar
total=1057
eligible=401
skipped=656
committed=3
pending=398
budget=within_budget
```

### 16.2 Lease 数与 TTL

```powershell
$root = '.understand-book\quantification-essence\.build\automatic-build\v2\tasks\pass1'
Get-ChildItem -LiteralPath $root -Recurse -Filter lease.json -File |
  ForEach-Object {
    $lease = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    [pscustomobject]@{
      task = $lease.work_unit_id
      attempt = $lease.attempt
      ttl_minutes = (([datetime]$lease.expires_at) - ([datetime]$lease.issued_at)).TotalMinutes
      committed = Test-Path -LiteralPath (Join-Path $_.DirectoryName 'receipt.json')
    }
  } |
  Group-Object ttl_minutes
```

### 16.3 Metrics 与 failure 对照

```powershell
$root = '.understand-book\quantification-essence\.build\automatic-build\v2\tasks\pass1'
@{
  leases   = @(Get-ChildItem -LiteralPath $root -Recurse -Filter lease.json -File).Count
  metrics  = @(Get-ChildItem -LiteralPath $root -Recurse -Filter metrics.json -File).Count
  failures = @(Get-ChildItem -LiteralPath $root -Recurse -Filter failure.json -File).Count
  receipts = @(Get-ChildItem -LiteralPath $root -Recurse -Filter receipt.json -File).Count
}
```

本次预期:

```text
leases=67
metrics=48
failures=10
receipts=46
```

## 17. 数据限制

- 无原生 Token receipt,不能给出精确账单成本。
- 无模型 ID,不能把 `executor_ms` 精确归因到 Luna 高或其他模型。
- 没有同源同策略的历史 v2 样本,跨书墙钟不可直接比较。
- Sidecar 外推只基于首批 3 个任务,置信度低。
- 21 个无 receipt lease 中部分没有 metrics,无法还原其真实模型执行时长。
- `executor_ms` 包含模型以外的 executor 文件和 submit 路径。
- 本次 wall clock 是端到端用户成本,适合容量规划,不适合作为纯 provider benchmark。

## 18. 决策记录

### §18.1 优化优先级

**决策**:先修 lease 与 sidecar 粒度,再评模型默认值。

**否决**:
- 只切回 Luna 高:无法消除冷启动和遥测盲区。
- 直接降低 quality profile:改变用户已冻结的 `full` 语义目标。
- 放宽 integrity/quality gate:用不完整产物换墙钟。

**命门**:任何优化都必须保留专用 extractor、policy identity 与确定性 gate。
**何时回头**:模型 A/B 证明模型差异占总墙钟绝大多数且调度指标已达标。

### §18.2 当前书续建

**决策**:保留 Pass1,从磁盘 sidecar 状态续建。

**否决**:
- 删除目标目录重跑:浪费已通过质量门的 Pass1。
- 混合新旧 router artifact:破坏 policy freshness。
- 用空结果快速 close:违反 full profile。

**命门**:若 router 变化,只对受影响 stage 走显式 policy migration。
**何时回头**:现有 sidecar policy 出现 integrity/quality failure 或用户明确选择重建。

## 19. 参考

- [2026-07-18 Understanding Transformer 预构建运行统计](./运行统计-2026-07-18-understanding-transformer预构建.md)
- [一键预构建执行面与成本治理修复方案](./修复方案-一键预构建执行面与成本治理.md)
- [一键预构建执行面与成本治理切片方案](./切片方案-一键预构建执行面与成本治理.md)
- [ADR-0084 Codex harness inference and durable sidecar task mailbox](./adr/0084-codex-harness-inference-and-durable-sidecar-task-mailbox.md)
- [ADR-0085 Stage-specific work units and policy-bound artifacts](./adr/0085-stage-specific-work-units-and-policy-bound-artifacts.md)
- [`CONTEXT.md` 中的构建工作区、跨会话续建、一键预构建与 Build Engine Sidecar 定义](../CONTEXT.md)
