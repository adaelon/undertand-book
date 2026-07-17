# SESSION_CHECKPOINT - 2026-07-17 16:23 +08:00

## 新鲜度自检
- 写入时最新 commit:`13f6d01 fix(pdf): stabilize native text-layer selection`;读入时先运行 `git log -3 --oneline` 与 `git status --short`,不一致时以 Git 和磁盘现状为准。
- 当前主切片:安装版 Workbench builtin stage runner 已修复并通过源码、编译 sidecar、正式 package 与 NSIS 构建;旧 Reader 已关闭,尚未安装新 bundle 做 installed Reader 验收。

## 当前在做什么
收口 `STAGE_RUNNER_NOT_INSTALLED` 修复:生产态不再依赖编译期 worktree 的 `node_modules/tsx` 与 TS 源文件,而是启动 `UnderstandBook.exe` 同目录的 `understand-book-build.exe workbench-stage`。

已完成:
1. Server 生产态优先解析 sibling Bun sidecar,可用 `UNDERSTAND_BOOK_BUILD_SIDECAR` 显式覆盖;源码态保留 Node/tsx fallback。
2. Bun sidecar 新增 `workbench-stage`,内嵌 Workbench runner、DOMMatrix 与 PDF worker;来源对齐可在无 Node/tsx 环境执行。
3. Core projection stages 在 sidecar 环境生成 `run-script` self-command,不再回跳 `node_modules/tsx`。
4. Desktop `beforeBuildCommand` 强制运行编译 sidecar 来源对齐 smoke,防止源码测试绿但安装产物坏。
5. `docs/架构.md` 与 `docs/代码链路.md` 已更新;ADR-0068 的单 exe 决策未改变。

## 验证结果
- 红测:Core 初始返回 `node.exe`;Server 无 packaged resolver;均已转绿。
- `pnpm -C packages/core test`:224/224。
- `pnpm -C packages/core typecheck`:通过。
- `cargo test -p server -p understand-book-desktop -- --test-threads=1`:Server 155/155,Desktop 16/16。
- 编译 sidecar smoke:`workbench sidecar smoke passed`;真实生成 source reconciliation report/job ready。
- `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book pnpm -C apps/desktop package:windows`:release guard、Web 1913 modules、sidecar smoke、Rust release、NSIS/export 全部通过。
- 正式安装包:`dist/UnderstandBookSetup.exe`,35,299,952 bytes,SHA-256 `2358BA25A95ACB36260C0F2915F6104A9375AD220A15D60B64D4D5881B845767`。
- `git diff --check`:通过;独立 rustfmt check 仍命中任务前 Server/host 既有格式债务,本次新增测试已按建议格式化。

## 下一步(可直接接手)
1. 运行 `dist\UnderstandBookSetup.exe` 更新已关闭的旧安装版。
2. 在 installed Reader 新建 fresh draft,导入最小一致 `paper.md + paper.pdf`,以 `adapter_mode=builtin` 启动 `source_reconciliation`。
3. 检查 `.build/source-reconciliation/report.json`、job `status=ready|needs_user` 与 stderr;不得再出现 `STAGE_RUNNER_NOT_INSTALLED`、DOMMatrix 或 pdf.worker failure。
4. 验收后按文件归属暂存本切片,不要混入任务前 Rust/用户材料。

## 未完成 / 工作区边界
- 本次提交范围:`apps/desktop/{package.json,scripts/smoke-workbench-sidecar.mjs,src-tauri/tauri.conf.json}`、`crates/server/src/lib.rs`、`packages/core/src/workbench-stage-runner.ts`、同名单测、`skills/build/sidecar-entry.ts`、根 `package.json/pnpm-lock.yaml`、`docs/{架构.md,代码链路.md}`、本 checkpoint。
- 任务前 Rust:`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`;保持未提交且未整理。
- 其余用户材料、日志、临时候选与 test-results 均未处理。

## 冷启动读序
1. `docs/架构.md:Deterministic stage runner/Windows desktop distribution` - 生产与开发命令边界。
2. `crates/server/src/lib.rs:resolve_builtin_stage_runner_command/spawn_builtin_stage_runner` - sibling sidecar 解析和 job spawn。
3. `skills/build/sidecar-entry.ts`、`apps/desktop/scripts/smoke-workbench-sidecar.mjs` - 单 exe 命令面与编译产物 smoke。
4. `packages/core/src/workbench-stage-runner.ts:workbenchStageCommand` 与同名单测 - projection self-command。
5. `docs/代码链路.md:WB1 Packaged Workbench stage runner` - 改动索引与验证账本。

## 本会话决策摘要
- 兑现 ADR-0068:安装版 Workbench 复用既有 Bun 单 sidecar;不向安装包加入 Node/tsx/TS 源码。
- 开发态 Node/tsx 仅作源码 checkout fallback;生产路径不得依赖 `CARGO_MANIFEST_DIR` 指向的 worktree 存活。
