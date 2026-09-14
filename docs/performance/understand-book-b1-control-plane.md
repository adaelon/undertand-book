# B1 代表性控制面基线

范围：ADR-0121 的 B1。固定工作区和观测边界，供 L1/L2、P1–P4 的后续验收使用。

状态：2026-09-07 验收完成。代表性测试 2/2、计时测试 22/22、core 类型检查及 compiled release smoke 均通过；入口推进 L1。

## 工作负载与测量边界

- 205 个独立顶层章节产生 205 个 Pass1 units；每个单元经现有 production writer 写入候选，再经真实 close 入口关闭 Pass1。
- 其中 110 章含独立公式，形成 205 个 discourse 与 110 个 formula sidecar units；64 个 discourse 已提交，251 个 sidecar 待处理。
- 既有 planner/dispatch store 建立三槽活动调度。每轮重放三个既有 handoff，再在一个真实进程内 MCP 连接中执行 `open → input.next → generation.start → submit_candidate`，提交一个独立单元。
- 测量 snapshot、plan、build.step 和四种 Executor operation；每种操作分别记录文件读取、存在查询、目录枚举、mkdir/write 尝试、成功写入、成功 exclusive create、EEXIST、其他写入错误、snapshot 次数与墙钟。
- 起始磁盘镜像含完整文件字节和目录集合。四轮均恢复到同一绝对路径并逐文件比较；Date 固定以保持租约身份，performance.now 使用真实时钟。每轮提交后检查原有 269 个 accepted artifacts 字节不变。
- 初始样本单列，后续三次为暖样本；各轮的确定性计数必须一致。操作计数封装调用真实磁盘实现，未替代业务返回值。
- snapshot 次数统计两种公开入口 `buildAutomaticBuildSnapshot` / `routeAutomaticBuildSnapshot`；两者分别直接进入内部全书构建函数。其他审计路径产生的 I/O 独立计入其所在 operation，不据 I/O 倍数推算 snapshot 次数。

## 证据与复跑

- [实际源代码快照](understand-book-b1-source.zip)：保存基线使用的 core、测试、构建 skills、Executor agent、观测脚本、依赖锁与配置。基于 HEAD `9e36507` 的脏工作树；此快照包含此前在途改动，不是 B1 的改动归属清单。
- [compiled smoke 计时](understand-book-b1-compiled-timing.json)：现有 compiled executable 的独立辅助验证；同一连接 15 次调用成功配对，其中包含错误请求与重放。
- [代表性四轮采样](understand-book-b1-control-plane-samples.json)保存各次值与暖样本中位数。

在仓库根目录执行：

```powershell
$env:UNDERSTAND_BOOK_B1_REPORT = Join-Path (Get-Location) 'docs/performance/understand-book-b1-control-plane-samples.json'
pnpm --filter @understand-book/core exec vitest run test/automatic-build-control-plane-performance.test.ts --maxWorkers=1 --minWorkers=1
Remove-Item Env:UNDERSTAND_BOOK_B1_REPORT
```

要重建此脏工作树基线，在单独的 `9e36507` checkout 中展开源代码快照，按附带锁文件准备依赖，再执行以上命令。后续优化的候选样本应使用另一个输出文件名，保留本次基线。

## 量化结果

宿主：Windows x64、Node v24.9.0；夹具位于 C 盘临时目录，使用确定性合成候选。耗时单位为秒；最后两列是单次 operation 的计数，四轮完全一致。

| operation | 初始 | 暖 1 | 暖 2 | 暖 3 | 暖中位数 | snapshot 次数 | EEXIST |
|---|---:|---:|---:|---:|---:|---:|---:|
| snapshot | 12.145 | 12.099 | 12.553 | 12.203 | 12.203 | 1 | 5770 |
| plan | 12.134 | 12.170 | 12.110 | 12.100 | 12.110 | 1 | 5770 |
| build.step | 50.845 | 50.826 | 49.806 | 50.690 | 50.690 | 3 | 23144 |
| executor.open | 26.129 | 26.206 | 25.903 | 26.350 | 26.206 | 2 | 11540 |
| executor.input.next | 24.549 | 24.184 | 24.205 | 24.239 | 24.205 | 2 | 11540 |
| executor.generation.start | 36.430 | 37.172 | 36.275 | 36.450 | 36.450 | 3 | 17311 |
| executor.submit_candidate | 38.594 | 38.155 | 38.765 | 38.205 | 38.205 | 3 | 17311 |

单次 snapshot 的文件操作为 read 6,043、exists 7,337、readdir 520、mkdir/write 各 5,770；写入全部 EEXIST，同一文件最多被尝试写入 930 次。重复创建与全书 snapshot 放大均已重现。

每轮四次 MCP outer 合计分别为 125.703、125.717、125.149、125.244 秒；三个暖样本的合计中位数为 **125.244 秒**。各次 server/outer/residual、response bytes 和原有 server phases 全部保存在 JSON 中；每轮 1 semantic attempt、1 durable commit，原有 269 个 accepted artifacts 字节不变。

未启用计数的 snapshot 为 11.965 秒；启用计数后的暖中位数为 12.203 秒。显式 bookkeeping 占单次 operation 的最高比例为 0.2243%。该诊断未显示计数封装主导耗时。

## 验收记录

- 计数器合同覆盖首次 exclusive create、覆盖写入和已有文件拒绝。
- 计时测试覆盖连接内序号、跨连接隔离、响应乱序、缺失 server/outer、错误连接、错误 operation、错误 ordinal、重复 outer 和缺失 server phases。
- compiled smoke 在真实 stdio 边界记录 outer，连接关闭后与该连接的 server JSONL 严格归并；错误和重放调用也占用真实序号。
- 初次规模验证的业务断言通过，但出现 Vitest `onTaskUpdate` 回传超时；夹具阶段边界增加异步让步后，后续运行 clean exit。单次被测同步 operation 内不插入让步。
- 夹具曾以零 available slots 请求 Driver，实际进入 `executor_unavailable`。最终测量使用三槽活动调度重放，并断言返回原有三个 handoff；运行时调度代码未变。
- 一次完整采样的四轮业务断言均通过，但 919.57 秒的测试运行超过原 900 秒限时。仅将该长基准测试的上限改为 1,200 秒，并完整复跑；未放宽业务或计数断言。
- 最终代表性测试：2/2 通过，退出码 0；测试耗时 928.54 秒，包含 setup/reset/产物字节核对与 cleanup。表中耗时仅覆盖各自 operation。
- `test/r7-rollout-trace.test.ts`：22/22 通过，退出码 0；`pnpm --filter @understand-book/core typecheck` 通过。
- `smoke-t7-executor-release.ts --evidence-out ...`：退出码 0；主连接 15 次调用逐次配对，恢复及 oversize 辅助 canary 保持通过。未传入安装态入口。
- 源码快照包含 393 个文件，7 个复跑关键文件与当前源码直接比较一致。

## 已知限制

- 初始样本已执行 fixture setup；不是进程冷启动或文件页缓存冷启动。
- 合成输入较短，重现的是单元规模造成的状态工作，不代表 Mastering Rust 的正文长度与推理成本。
- 代表性样本的 outer 是进程内 MCP handler 边界；compiled smoke 的 outer 是本地 stdio 边界。两者都不能冒充真实 Codex 宿主的逐调用 transport residual。
- 三槽是真实持久调度状态；每轮只执行一个连接，未测真实 child 占用率或多波补位。这些属于 L1/V1。
- I/O 计数覆盖本进程被观测的同步文件入口；子进程 I/O 不计入。Pass1 close 的子进程在采样前运行。
- 计数器 bookkeeping 计时仅覆盖显式记账部分。另列未启用计数的 snapshot 作为包装开销诊断；它不是优化前后 A/B。
- 尚未运行安装态、真实宿主或真实书续跑；此基线不证明端到端提速。
