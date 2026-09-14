# P1–P4 控制面有界读取验收

日期：2026-09-08。范围：[ADR-0121 §1–§3](../adr/0121-bounded-build-state-reads-and-executor-lifecycle.md) 与[切片方案 P1–P4](../切片方案-预构建控制面有界读取与执行器补位.md)。

## 实现

- P1：每次阶段 routing 只准备一次 policy set；独立 migration/adoption API 仍可自行准备。策略与回执先读取直接比较，缺失才 create-only，首次创建碰撞继续读回核对。
- P2：snapshot/plan 只检查当前策略、回执与 artifact；空/未准备阶段以内部 `preparation_required` 表达准备缺口，不将缺失产物当永久失败。Driver/Next 通过原计划授权门后调用 `prepareAutomaticBuildSnapshot(stage)`，执行既有迁移与接管，再刷新 pending 和预算；冲突返回原 recovery envelope。已接受当前代次产物和已有回执不再触发前代目录遍历或重复 materialize。
- P3：同一 step 的无写入 plan/next 共享 snapshot；准备、失败观察、close 或其他状态 transition 后刷新。Driver 每次执行完整安装合同检查；显式 protocol doctor 保留历史 attempt/legacy 状态审计。claim、dispatch 恢复和 terminal 检查继续读取当前事实。
- P4：Pass1/sidecar 从当前冻结 task 读取 descriptor，对照当前代码 policy、持久 policy、manifest binding 和完整输出合同；归约任务重验 accepted children。BookStructure 单元只路由当前 parent 的真实投影，stitch 保留全局依赖；其他阶段按所需 source/catalog 做 scoped stage 读取。Executor 四个操作不进入全书 snapshot，不做阶段准备。派工推进若紧接 retryable failure，额外定向读取前一个失败任务，保留重试耗尽与策略检查。

代码与入口索引见[代码链路](../代码链路.md)的 2026-09-08 P1–P4 条目，数据流见[架构](../架构.md)“构建控制面的准备与读取”。未新增持久格式、语义 identity 或跨请求缓存。

## 同规模测量

沿用 B1 的 205 个已关闭 Pass1、315 个 sidecar（64 已提交）和三槽 dispatch。每轮恢复相同绝对路径下的完整目录和文件字节；初始样本单列，另做三次暖样本。P2 后夹具在合成 writer 前显式调用阶段准备，其工作规模、候选、Date、已接受集合与四次 MCP 操作不变。

下表均为三次暖样本中位数，单位为秒。完整原始样本分别见 [B1](understand-book-b1-control-plane-samples.json)、[P1](understand-book-p1-control-plane-samples.json)、[P1–P4](understand-book-p1-p4-control-plane-samples.json)。

| 操作 | B1 | P1 | P1–P4 | 相对 B1 减少 | 完整 snapshot 次数（B1 → 当前） |
|---|---:|---:|---:|---:|---:|
| snapshot | 12.203 | 1.825 | 1.492 | 87.77% | 1 → 1 |
| plan | 12.110 | 1.889 | 1.526 | 87.40% | 1 → 1 |
| build.step | 50.690 | 9.046 | 4.092 | 91.93% | 3 → 1 |
| executor.open | 26.206 | 5.527 | 1.838 | 92.99% | 2 → 0 |
| executor.input.next | 24.205 | 3.735 | 0.093 | 99.62% | 2 → 0 |
| executor.generation.start | 36.450 | 5.724 | 0.203 | 99.44% | 3 → 0 |
| executor.submit_candidate | 38.205 | 7.652 | 1.942 | 94.92% | 3 → 0 |

四次 MCP 的三轮合计为 4.069590、4.075294、4.066941 秒，中位数 **4.069590 秒**；B1 为 **125.244229 秒**。每轮仍是 **1 semantic attempt / 1 durable commit**，原有 **269 个 accepted artifacts 字节不变**。没有模型调用或重试增加。

| 当前操作 | read | exists | readdir | mkdir | write | EEXIST |
|---|---:|---:|---:|---:|---:|---:|
| snapshot | 1100 | 2394 | 0 | 0 | 0 | 0 |
| plan | 1102 | 2401 | 1 | 0 | 0 | 0 |
| build.step | 3237 | 5631 | 7 | 57 | 23 | 16 |
| executor.open | 23 | 40 | 0 | 14 | 3 | 0 |
| executor.input.next | 18 | 23 | 0 | 14 | 1 | 0 |
| executor.generation.start | 42 | 89 | 4 | 56 | 13 | 1 |
| executor.submit_candidate | 76 | 132 | 13 | 32 | 9 | 1 |

以上计数四轮一致。Driver 和 Executor 保留实际 dispatch、delivery、claim 与 commit 写入；零写入目标针对 snapshot/plan 及 Executor 内的阶段准备。snapshot 原有 5,770 次 EEXIST 和逐文件 930 次重复写入已消除。

## 正确性与复跑

- 策略/回执重放红测：mkdir/write 合计 6 → 0；首次创建、相同内容、冲突内容和另一调用在首次创建窗口完成后的 EEXIST 复核有覆盖。
- 空阶段及已准备阶段的连续 snapshot/plan 为零 mkdir/write；旧 whole-window 精确接管改为显式准备，再检查原 accepted bytes、迁移回执和 freshness。
- active-dispatch 重放为一次 snapshot；注入 plan 后 child commit，Driver 不再领取该 ref。原有租约过期、bootstrap 恢复、close 后下一阶段及预算/授权门回归保持。
- 四个 Executor 操作前的 policy 漂移均拒绝；open 后 reducer 的 accepted child 消失时 input 拒绝。BookStructure scoped unit 与完整 routing 的 descriptor 一致，后到的 Pass2 证据使旧 descriptor 失效。历史 V3 continuation、当前 V4 单元终态及 frozen-input 复用分别验证；同批“成功—失败—成功”终结后重试失败项、前项重试耗尽检查保持。
- 分组回归状态和逐项名单见 [P1–P4 regression JSON](understand-book-p1-p4-regression.json)。**11 个文件、180/180 项分组 clean exit**；另有 2/2 项同规模性能测试、core typecheck 和源码差异空白检查通过。发布 smoke 合同断言对齐现有 Root/child 分列证据，两边四工具检查保持。

```powershell
$env:UNDERSTAND_BOOK_B1_REPORT = Join-Path (Get-Location) 'docs/performance/understand-book-p1-p4-control-plane-samples.json'
pnpm --filter @understand-book/core exec vitest run test/automatic-build-control-plane-performance.test.ts --maxWorkers=1 --minWorkers=1
Remove-Item Env:UNDERSTAND_BOOK_B1_REPORT
pnpm --filter @understand-book/core typecheck
```

回归涉及 policy-generation、routing-v3、orchestrator、Driver、Executor session、dispatch runtime、adapter/MCP、release doctor 和 model-input-routability。Driver/session 每组至多四项，精确测试名来自 `vitest list --json`；必须退出码 0、JSON success=true 且所有预期断言 passed，不能把被跳过项算作通过。

## 已知限制

- 基准测量真实磁盘与进程内 MCP handler；没有测 Codex 宿主传输、模型推理、多波 child 占用率或整书墙钟。不能据此宣称 Mastering Rust 整书提速；这些留在 V1。
- 初始样本发生在 fixture setup 后，不是进程或文件缓存冷启动。同步文件计数不包括 stage renderer/writer 子进程的 I/O，墙钟包含这些子进程。
- BookStructure stitch 的全局投影、paper metadata/lexicon source 路由及 Pass2 catalog 属于真实依赖读取；没有将这些成本伪装为常数。205/315 基准测量的当前单元是 sidecar fast path。
- 一次合并 Executor 回归的 78 个断言通过，但 Vitest onTaskUpdate RPC timeout 导致退出码 1；以随后互斥小组 clean exit 的最终证据为准。
- 本次修改未 commit；承接 checkpoint 原有 L1/L2、B1、RG/R8、Rust 等在途改动。未重建 compiled executable、安装或发布插件，现有 compiled 文件仍是上一轮 L1/L2 构建；真实书进度未查询或修改。
