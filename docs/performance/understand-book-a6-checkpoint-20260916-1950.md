# SESSION_CHECKPOINT — 2026-09-16 19:50（Asia/Hong_Kong）

## 新鲜度自检
- 最新 commit：8dea7b01290bba136f7332b01b20972d8a9d661f feat(build): deliver prebuild recovery, bounded reads and structure evidence。
- 读入时对比 git log -3 与工作树；R1–R4、A1–A5 和 A6 前置修复均未提交，其他任务修改保留。

## 当前在做什么
A6 实书验收已启动：0003 的九个 core 修复已全部由真实模型提交并被 Driver 接纳；正在执行 210 个真实关系选择任务，关系增量、发布与 Reader 尚未完成。

## 下一步（可直接接手）
1. 读 A6 在途记录并用 collaboration.list_agents 核实当前专用 child；禁止重复启动同一 slot。所有后续 subagent 必须显式使用 model=gpt-5.6-sol。
2. 消费 child 终态后立即以同一 invocation 调用安装态 build.step，按 build skill 补位；只有 Driver 返回才能证明持久接纳。
3. 完成九个 core 修复后继续真实模型 selection/delta，直到 DONE 或真实 NEEDS_USER；保留其精确 reason、request_id、choices。
4. 发布后执行 Reader 实际消费、语义案例与来源/历史比对，运行 collect-a6-cost.mjs 汇总成本；小书真实模型案例仍待执行。
5. 所有执行器停止后，将隔离副本移回预留归档位置，原目录整体恢复；逐项暂存明确交付文件并刷新本页。

## 隔离与在途身份
- 当前规范路径（隔离副本）：E:/allwork/download/agent/lifebook/.understand-book/mastering-rust。
- 原目录保留：E:/allwork/download/agent/lifebook/.understand-book/mastering-rust.a6-original-20260916-1718。
- 隔离容器：E:/allwork/download/agent/understand-book-a6-20260916-1718；预留归档位置为其 workspace 子目录。
- 当前 invocation：abinv1_dd201775a5ff6eac88f7bbd64e5479a738237410f8aa70ca99ecaee26f87a9f7；复用既有确认计划，max_parallel=3；原 invocation 未执行。
- 九个 core repair child 均 committed，Driver 已确认 local=37/37。关系选择计划为 210 项；写入时 selection=13/210，/root/a6_select_014、015、016 正以 gpt-5.6-sol 运行。
- Driver 必须按实时容量调用；并发上限 3。返回的已有 slot/ref 要去重，只为新 ref 启动新 child。
- 19:47 历史对照：7,534 个文件与原目录逐字节相同。初始副本共 20,407 文件、90,027,804 字节。
- tmp/a5-real-20260914/workspace 是旧验收存储 overlay，绝不可当可迁移续跑工作区。

## 未提交 / 未完成
- A6 core 修复：build-orchestrator.ts 对不完整来源签发按 core 的 :core-repair:<ordinal>；book-structure.ts/generation.ts 加覆盖约束；整链测试新增修复和旧成果保留验证。
- 上一轮交接确认整链回归、Core 类型检查、392 模块编译通过。本轮安装成功，编译/安装字节一致；实际语义结果尚待 Driver 确认。
- 日常程序 E:/allwork/Understand Book/understand-book-build.exe 已更新；旧文件保留为 .before-a6-20260916 及 .running-before-a6-20260916；旧进程继续运行旧映像。
- 插件仍为 0.1.0+codex.20260916085911，协议资产未变；新 dedicated child 使用新连接。
- apps/desktop/scripts/collect-a6-cost.mjs、A6 记录和代码链路本轮更新；真实账单不可用时不得以估算冒充。
- A6 小书真实语义案例、实书关系/发布/Reader、最终成本、目录恢复、暂存尚未完成。
- 无 Windows Setup、远程发布或提交操作。

## 冷启动读序
1. docs/performance/understand-book-a6-20260916.md 与上述 control.json — 当前安装、隔离、在途执行身份。
2. 已安装插件 skills/build/SKILL.md 与 skills/executor/SKILL.md — Root 四动作循环、专用 child 和诊断边界。
3. docs/adr/0129-append-book-structure-and-reconcile-relations.md；docs/切片方案-BookStructure追加组装与关系增量.md 的 A6、§6–§7。
4. build-orchestrator.ts:routeBookStructureProductionStage 的 core repair/selection/delta；book-structure-generation.ts:validateCandidate；book-structure-append-production.test.ts。
5. docs/performance/understand-book-ra-install-20260916.md、understand-book-a5-release.md；docs/adr/0128-root-guided-executor-call-correction.md。

## 本会话决策摘要
- 原冻结 target identity 通过目录整体换位保持；验收副本占规范路径，原工作区保留；不改冻结收据、不使用旧 overlay。
- 单份修复输入超预算时按来源内 core 拆成九个正常工作身份；其他 28 份成果复用。见 A6 在途记录。
