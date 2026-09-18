# A6 验收在途记录

日期：2026-09-16。状态：定点修复已编译并安装，正在通过隔离 invocation 执行真实模型验收。

## 隔离副本与恢复位置

- 原始工作区保留于 `E:/allwork/download/agent/lifebook/.understand-book/mastering-rust.a6-original-20260916-1718`。
- 全新副本临时占用规范路径 `E:/allwork/download/agent/lifebook/.understand-book/mastering-rust`，以保留冻结 target identity。原书目录已整体移开，验收结束必须恢复。
- 副本归档位置预留为 `E:/allwork/download/agent/understand-book-a6-20260916-1718/workspace`；当前该位置已移到规范路径。
- 复制基线：20,407 文件、90,027,804 字节；robocopy 差异为 0。未使用 A5 overlay。
- 新 invocation：`abinv1_dd201775a5ff6eac88f7bbd64e5479a738237410f8aa70ca99ecaee26f87a9f7`，复用既有已确认计划，max_parallel=3。控制面在途记录位于隔离容器的 `control.json`，成本汇总位于 `cost.json`。
- 原 invocation 未执行。当前新 invocation 首次安装态 step 返回 `NEEDS_USER/foundation_required`，request `abreq1_9cda46912278ac0b3749c808e7414ae8582d808bc6f0abe057731c76643ec830`，choices=[]。

## 修复切片

不完整 fragment 保留原成果，通过同一 fragment 类型的独立 `:core-repair` work unit 重新生成该来源。输入明确要求每个 core 单元恰好一条 spine，writer 与持久重读检查同一约束。其余来源沿用已有身份；旧提示词字节不变。

生产整链红测已复现 `blocked`。修复按原来源的每个 core 单元签发独立 `:core-repair:<ordinal>` 工作，避免原输入接近预算上限时加入覆盖约束超预算；0003 对应九个修复任务。旧不完整来源退出当前工作集合，磁盘历史保留。

上一轮整链回归、Core 类型检查及 392 模块编译已通过（用户提供的交接记录）；编译产物时间为 17:35:26，晚于最后源码修改 17:34:39。本轮已将该产物安装到日常 Build Engine，并逐字节验证一致。原程序正在被既有连接使用，直接覆盖被 Windows 拒绝；整体改名保留后安装成功，既有进程不被终止。

- 旧程序保留：`E:/allwork/Understand Book/understand-book-build.exe.before-a6-20260916` 和 `understand-book-build.exe.running-before-a6-20260916`。
- 插件版本保持 `0.1.0+codex.20260916085911`，本次修复未改执行器协议或插件资产。

19:44 安装态 Driver 返回 `SPAWN_EXECUTORS`，局部贡献 `28/37`，首次启动三个专用执行器。该响应证明已越过原 foundation 边界，修复尚须等实际候选接纳。19:47 对照原保留目录，7,534 个历史文件逐字节一致，差异 0。

成本收集入口为 `apps/desktop/scripts/collect-a6-cost.mjs <workspace> <report.json>`，仅读取代码所有的 metrics，不输出语义正文。实际账单未由 Executor 协议提供时保留 unavailable/null。

## 待完成

1. 定点修复回归、编译、安装。
2. 实书修复与真实关系选择、增量生成、发布。
3. 小书语义案例、Reader 消费、成本记录。
4. 恢复原工作区，归档副本并刷新 checkpoint。
