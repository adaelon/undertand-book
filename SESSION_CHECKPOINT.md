# SESSION_CHECKPOINT - 2026-07-26 14:48 +08:00

## 新鲜度自检

- 当前基线标题:`feat(build): deliver intent-driven prebuild IP1-IP9`;读入时先运行 `git log --oneline -3` 获取文档 amend 后的最终 hash。
- Setup 的二进制代码快照为 `f2ae24d`;其后只追加 clean-build 代码链路并刷新本 checkpoint,不改变打包代码或版本源。
- desktop/package/bundle 四个版本源均为 `0.2.0`;插件 cachebuster、协议与 schema 版本未提升。

## 当前状态

IP1-IP9 已作为一个 commit 完成,IP10 不在本次范围。Windows Setup 已从 detached clean worktree 重编并复制到 `dist/UnderstandBookSetup.exe`。跨进程 automatic-build claim 的 attempt TOCTOU 已修复并纳入同一提交。

## 发布证据

- Setup:37,789,033 bytes;SHA-256 `EEAB0097B1EF699973990CD46D159F9F5EED0A295EF2CB64EFFD5D90B5680641`;file/product version `0.2.0`。
- NSIS bundle、detached export 与主工作区最终 Setup 三者大小和 SHA-256 完全一致;安装器未启动。
- Core 单 worker 全量 80 files/516 tests、Core typecheck、20 轮三进程 compiled-sidecar claim 压力、完整 Workbench smoke、IP9 Node/Bun metrics parity 与 package release gates 全部通过。

## 工作区边界

- 未提交 tracked:base-schema roundtrip、memory lib/profile/review、reader lib、runtime profile_api 与前端阅读器切片方案;均为用户既有改动,未回退也未提交。
- 未跟踪的用户书、方案/ADR、截图、日志和临时目录仍归用户所有,不得批量清理或纳入后续提交。
- `.tmp-ip9-setup-worktree` 是本次 detached 构建工作树;Tauri 生成文件需恢复后保持源快照干净。`dist/UnderstandBookSetup.exe` 为本地忽略发布产物。

## 冷启动读序

1. `docs/代码链路.md` 最后的 IP1-IP9 与 0.2.0 clean Setup 条目。
2. `docs/切片方案-需求驱动渐进式预构建.md` IP1-IP9 与 `docs/adr/0093-intent-confirmed-progressive-prebuild-and-reader-private-goal-artifacts.md` §1-§8。
3. `packages/core/src/automatic-build-lease.ts:claimAutomaticBuildTask` 与 `apps/desktop/scripts/smoke-workbench-sidecar.mjs` - Setup 构建期间发现并修复的 claim 竞态。
4. `apps/desktop/package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json`、根 `Cargo.lock` - `0.2.0` 版本一致性。

## 下一步

用户若继续产品切片,从 IP10 或新的明确范围开始;不要重做 IP1-IP9。若分发 Setup,使用 `dist/UnderstandBookSetup.exe` 并以本页哈希复核。
