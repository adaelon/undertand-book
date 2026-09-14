# V1 发布与多波性能验收

日期：2026-09-08。范围：[ADR-0121](../adr/0121-bounded-build-state-reads-and-executor-lifecycle.md) 与[方案 V1](../切片方案-预构建控制面有界读取与执行器补位.md#v1-发布与多波性能验收)。

后续状态：本页记录早先候选与隔离安装验收；2026-09-08 已补齐本机日常安装更新，见 [V1 日常安装更新](understand-book-v1-daily-install.md)。

## 执行状态

- [x] 读完 checkpoint 冷启动读序；HEAD 仍为 `9e36507`，保留所有承接改动。
- [x] 备份上一轮 compiled 程序到 `tmp/v1/previous-l1-l2-build.exe`，从当前源码重建。
- [x] source/thin-plugin/Agent/skill 合同检查与 compiled stdio smoke；证据 `understand-book-v1-compiled.json`。
- [x] Node/compiled parity 与隔离安装资产逐文件直接比较。
- [x] 扩展现有真实宿主 smoke 至三槽六单元，记录终态消费、补位和持久提交。
- [x] 独立 compiled 故障恢复 canary 与三次同规模暖跑对照。
- [x] 完成六连接的 server/outer 逐调用配对和首次 open 到提交测量。
- [x] 汇总真实结果、限制，更新方案、代码链路及 checkpoint。

## 执行边界

使用隔离安装和合成书 canary。真实书续跑必须先重读原计划、invocation 与 accepted 集合，再沿用已有授权。

## 发布候选与宿主

当前源码重建 384-module compiled Build Engine。source/thin-plugin/Agent/skill 合同通过；Node/compiled 的 outside-repo parity 通过；[compiled stdio 证据](understand-book-v1-compiled.json)保留协议负例、连接诊断、恢复与 oversize canary。

使用桌面自带 `codex-cli 0.153.4`，在仅复制现有认证的临时 Codex home 中，经现有 local marketplace 安装候选、注册专用 Agent。安装文件集合及每个文件字节均与候选直接比较一致；实际运行 installed launcher。日常个人安装未改动。

首轮真实 child 已提交但轨迹审计失败：当前宿主在 response-only envelope 增加 `code_mode_host_duration={secs,nanos}`。解析器原来拒绝该字段；最小复现先红，修复后只接受闭合数值字段，正文继续与已有归属的专用 child 工具响应直比。原样本重新解析通过，见[保留样本重解析](understand-book-v1-host-single-reanalyzed.json)；这不是新增模型采样。

## 真实六单元

第一轮[宿主发布证据](understand-book-v1-host-release.json)与[调度证据](understand-book-v1-host-scheduling.json)：

- 六个独立合成 work units、六个新 child、六个 MCP 连接，最大 live 为 3。
- 四种工具均由每个 child 实际调用；Root/其他 child 的 Executor 调用为 0。
- 第四个 child 在首个终态后、另外两个初始 child 结束前启动；第五和第六个 child 继续逐槽补位。零 followup 派新引用；累计终态全部消费后才返回最终动作。
- 每单元一次语义尝试、一次持久提交，总计 6/6。
- 总墙钟 211.812 秒，成功吞吐 1.700 units/min；三次观测空槽至 spawn 为 12.713、21.522、12.220 秒。

这些空窗从 Root 的已完成 list_agents 观察算起，不包括 child 完成到 Root 首次观察的时间；不是完整物理空闲时间。临时 helper 发布六个独立已准备引用，测试 Root 生命周期；生产 Driver 的恢复与持久状态另由下面的 compiled canary 验证。

补齐连接归属后的第二轮[发布证据](understand-book-v1-host-timed-release.json)和[完整计时](understand-book-v1-host-timed-scheduling.json)均通过。临时 stdio 转发器将首个 `executor.open` 的 opaque ref 写入私有连接元数据，和专用 child 的工具调用参数直接比较；公共证据仅保存 thread ID 与计时，不含 ref。六连接共 24 次调用，一一配对，无缺失或重复。

| 第二轮指标 | 实测 |
|---|---:|
| 六单元总墙钟 | 188.062 s |
| 成功吞吐 | 1.914 units/min |
| 三次观测补位空窗 | 13.841 / 9.763 / 10.792 s |
| 首次 open 到 commit（child 1–6） | 31.104 / 37.280 / 37.949 / 30.830 / 31.299 / 36.013 s |
| 24 次 MCP server 合计 | 9.840 s |
| 24 次 MCP outer 合计 | 10.388 s |
| 24 次 MCP residual 合计 | 0.548 s |
| semantic attempts / durable commits | 6 / 6 |

工具合计跨并发连接，不能与整轮墙钟相加。两轮使用同一当前程序，第二轮增加连接计时转发；二者不是旧程序/新程序 A/B。

## compiled 故障恢复

[恢复证据](understand-book-v1-recovery.json)通过 installed launcher 和 compiled Driver/MCP 执行：

`三槽 -> B/C 开始生成 -> A 零调用失败 -> A 同槽新 ref -> B/C 提交 -> terminal B 连接打开 A 被精确拒绝 -> Driver 换代 -> 第三次启动失败 -> NEEDS_USER -> retry_bootstrap -> A 提交`。

三次失败产生四个不同恢复引用，dispatch slot 保持；重复观察幂等。暂停时只有 B/C 的两个 semantic attempts；显式 retry 后 A 首次生成仍为 attempt 1，最终 3 attempts/3 commits；两个已有成功回执字节不变。该 canary 是真实 compiled 进程和磁盘、合成候选，未以模型 child 故障注入冒充宿主恢复验收。

## 原规模性能对照

沿用 B1：205 个 closed Pass1、315 个 sidecar（64 accepted）、三槽；初始样本单列，另做三次相同路径、完整字节与目录恢复的暖跑。各轮 1 attempt/1 commit，269 个已有 accepted artifacts 字节不变；2 项测试 clean exit。完整样本见 [V1 四轮数据](understand-book-v1-control-plane-samples.json)。下表为暖中位数，单位秒。

| 操作 | B1 | P1–P4 | V1 复验 |
|---|---:|---:|---:|
| snapshot | 12.203 | 1.492 | 1.501 |
| plan | 12.110 | 1.526 | 1.484 |
| build.step | 50.690 | 4.092 | 4.060 |
| 四次 MCP 合计 | 125.244 | 4.070 | 4.086 |

snapshot/plan 的 mkdir/write/EEXIST 均为 0；active step 完整 snapshot 为 1，Executor 四个操作均为 0。V1 数值与 P1–P4 同一量级，保留相对 B1 的收益。

## 验证入口

```text
node apps/desktop/scripts/build-sidecar.mjs
node apps/desktop/scripts/assert-plugin-release.mjs --source-contract-only
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-t7-executor-release.ts --evidence-out <compiled-evidence.json>
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-t7-codex-cli-release.ts --codex-home <fresh-auth-only-home> --codex-command <desktop-codex.exe> --expected-codex-version "codex-cli 0.153.4" --evidence-out <host.json> --m1-evidence-out <single.json> --scheduling-evidence-out <scheduling.json>
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-v1-executor-recovery.ts <compiled-exe> <evidence.json> <installed-plugin-root>
pnpm --filter @understand-book/core exec vitest run test/r7-rollout-trace.test.ts test/codex-executor-agent.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @understand-book/core typecheck
```

原规模复跑沿用 B1 的 `UNDERSTAND_BOOK_B1_REPORT` 指向新的输出文件名，运行 `test/automatic-build-control-plane-performance.test.ts`；不要覆盖 B1/P1–P4 证据。三个 smoke 脚本另通过严格 TypeScript 检查。

## 已知限制

- 没有同宿主、同模型、同起始状态的旧程序六单元 A/B，真实多波吞吐改善仍未验证，不能宣称整书提速。B1 对照仅证明有界控制面收益。
- 故障恢复的 Driver/连接行为已由 compiled canary 验证；真实模型 child 的零调用失败与 Root 失败队列尚无故障注入样本。
- 未发布或覆盖日常安装，未续跑 Mastering Rust，未修改其 plan、invocation 或 accepted 集合。下一次真实续跑必须从原持久状态开始。
- HEAD 仍为 `9e36507`；本次代码与证据未提交，工作树包含承接的 P1–P4/L1/L2 等改动。前程序备份及私有失败轨迹保留在临时位置；整份 Git diff 不等于 V1 的改动。
