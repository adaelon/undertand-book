# Executor bootstrap 修复

## 范围与验收

用户于 2026-09-07 确认移除旧版插件、修复工具发现与零调用恢复，并添加测试。变更类型：控制面边界修复。沿用 opaque handoff、dispatch slot、semantic attempt 和 lease epoch 的既有定义。

- [x] 移除旧插件注册及内容；Windows 占用的空缓存目录待宿主释放。
- [x] 工具发现：执行角色中的确定性映射能找到四个实际规范化名称，缺失工具仍失败关闭。
- [x] 启动恢复：持久记录零调用失败，换新 ref、保持 slot 与语义身份；重复上报幂等；连续失败有界。
- [x] 回归、类型检查与运行链路文档。

## 决策

**决策**：启动失败独立推进控制面恢复代际。

**否决**：
- 删除 completed_refs：同一个已结束的启动尝试会无限重派。
- 消耗语义尝试或伪造 lease：启动前失败没有执行模型任务。
- 每次 step 随机换 ref：仍在运行的同一 dispatch 会被重复启动。

**命门**：Root 只上报所拥有 ref 的零调用 bootstrap 终态；代码验证所属 invocation、当前恢复身份和未 open 状态。失败事实存于 dispatch run；新恢复身份 V2 增加 bootstrap_epoch，已有 V1 ref 原样可读。达到三次失败后通过既有 NEEDS_USER 决策机制明确恢复。

**何时回头**：宿主能直接提供持久、带代际的 child terminal 事件时替换 Root 上报。

## 工具发现完成

规范角色、项目 Agent、发布模板与 executor skill 统一携带可执行的精确工具名映射。测试执行角色中的原样 JavaScript，逐一调用四个规范化名称，并验证其他 server 的同名操作不能被误选。首轮测试因映射缺失而失败，补齐后通过。

## 恢复验证

四条 Driver 回归覆盖三个真实 dispatch 的隔离恢复、跨 invocation 误报拒绝、已提交前缀复用和连续失败后的显式重试。既有 CLI 测试增加跨进程失败上报与重复 replay。`smoke-bootstrap-recovery.ts` 对重新编译的 Windows Sidecar 执行相同控制链，每次 step 都启动新进程；精确工具映射、新 ref/稳定 slot、三次失败边界、重复上报、语义身份不变和已 open 上报忽略均通过。

## 交付范围

本次恢复协议覆盖标准深读的 public dispatch。目标阅读的 reader-private artifact 使用独立的旧 handoff 协议，未在本次增加启动代际。

## 本机部署（2026-09-07）

- local 市场发布副本与安装缓存已同步，启用版本为 `understand-book@understand-book-local` / `0.1.0+codex.20260907110058`。旧 `understand-book@understand-book` 处于 not installed。
- 缓存中全部 10 个文件与仓库发布副本逐字节一致；项目执行器角色与安装模板按换行规范化后完全一致。
- `E:\allwork\Understand Book\understand-book-build.exe` 已替换为通过测试的候选，安装后逐字节比对一致。
- 安装态 `smoke-bootstrap-recovery.ts "E:\allwork\Understand Book\understand-book-build.exe"`：exit 0；覆盖精确工具发现、新 ref/稳定 slot、持久 replay、三次失败边界与语义身份不变。
- 旧程序保存在 `E:\allwork\Understand Book\understand-book-build.exe.backup-before-bootstrap-20260907-190058`。更新未终止既有 MCP 进程；现有进程仍可能载有旧程序，需在新任务中加载新版插件，重启 Codex 可释放旧连接。
- 本次部署没有恢复书籍构建或修改原书 artifacts；原 invocation 和待恢复 ref 保存在 `SESSION_CHECKPOINT.md`。

## 验证结果

- Driver 29、Agent 21、Session 37、Dispatch Runtime 17、Handoff 16、MCP 10、Tool Adapter 8，共 138 项相关断言通过。
- Session 全文件合跑触发既有 Vitest onTaskUpdate RPC 超时；按完整测试名称分为 15/13/9 三组后全部 exit 0，未改断言或超时阈值。Windows 注册测试串行运行通过。
- `pnpm --filter @understand-book/core typecheck` 与 `assert-plugin-release.mjs --source-contract-only`：exit 0。
- `build-sidecar.mjs`：384 modules 编译成功；`pnpm exec tsx apps/desktop/scripts/smoke-bootstrap-recovery.ts`：exit 0。
- `git diff --check`：无差异格式错误。原有未提交变更继续保留，本轮未创建 commit。
