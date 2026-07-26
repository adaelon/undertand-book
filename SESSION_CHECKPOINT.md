# SESSION_CHECKPOINT - 2026-07-26 16:47 +08:00

## 新鲜度自检

- IP11 功能 commit:`a8fcb35 feat(build): share Reader build intent with Codex IP11`,已推送 `origin/main`。
- 本页与 Setup 代码链路作为独立发布证据 commit;读入时运行 `git log --oneline -3`,以 Git 最新 hash 为准。
- desktop/package/bundle 四个版本源均为 `0.2.0`;发布插件为 `0.1.0+codex.20260726080400`。

## 当前在做什么

IP1-IP9、IP11 已完成并发布源码,IP10 仍待实施。IP11 让 Codex 经 Desktop stdin controller 与 Reader 共用唯一 private BuildIntent/BuildPlan,精确确认 `plan_id + plan_digest` 后复用 BP8 公共构建与 IP7 私有成果 mailbox;无 goal 的 legacy build 不变。

`dist/UnderstandBookSetup.exe` 已从 detached clean `a8fcb35` 重编并覆盖旧 IP1-IP9 本地产物。当前机器已安装的旧插件不会因打包自动热更新;运行新 Setup 或后续按正确 marketplace 源重装后,需新开 Codex thread 加载 IP11 skill。

## 发布证据

- Setup:37,810,189 bytes;SHA-256 `240077F6D2DF62BEFEA718C6A2D7AAE851A046E305979E465052CDEE15908DBA`;file/product version `0.2.0`;`NotSigned`。
- NSIS bundle、detached export、主工作区最终 Setup 三者大小和 SHA-256 完全一致;安装器未启动。
- `pnpm -C apps/desktop package:windows` 0 退出;plugin/release gates、Web production build、compiled workbench smoke、Book MCP smoke、Rust release 与 NSIS 均通过。
- IP11 实现验证:Core/Web 全量、Server 207+5、Desktop 17、Codex Desktop stdin 真进程 smoke 与 legacy automatic-build parity 均通过。

## 下一步(可直接接手)

1. 分发或手测时运行 `dist/UnderstandBookSetup.exe`,并以本页 SHA-256 复核。
2. 验证 Codex IP11 时安装新 Setup,新开 thread 后用 `$understand-book-build <trusted-workspace> <goal>` 检查 draft -> exact confirm -> build -> private artifact loop。
3. 产品切片继续时从 `docs/切片方案-需求驱动渐进式预构建.md` 的 IP10 开始,不要重做 IP1-IP9/IP11。

## 未提交 / 未完成

- IP11/Setup:无未提交实现;`dist/UnderstandBookSetup.exe` 是 Git 忽略的本地发布产物。
- 用户既有 tracked:base-schema roundtrip、memory lib/profile/review、reader lib、runtime profile_api 与前端阅读器切片方案;不得回退或纳入后续切片提交。
- 用户未跟踪书籍、方案/ADR、截图、日志和临时目录仍归用户所有;不得批量清理。

## 冷启动读序

1. `docs/切片方案-需求驱动渐进式预构建.md` IP11 与 ADR-0093 §9 - 冻结边界。
2. `docs/代码链路.md` 最后的 IP11.1-IP11.5 与 IP11 clean Setup - 实现/发布证据。
3. `docs/架构.md` Codex/Reader shared build intent 图 - 主数据流。
4. `apps/desktop/src-tauri/src/main.rs`、`crates/server/src/build_intent_api.rs`、`skills/build/SKILL.md` - controller 与 skill 入口。

## 本会话决策摘要

- IP11 shared authority:Codex/Reader 共用 Reader-private plan store,raw goal 不进入 argv/stdout/stderr/Visitor/MCP;见 ADR-0093 §9。
- 发布边界:功能固定为 `a8fcb35`,Setup 只从该 clean snapshot 构建,用户 dirty files 不进入提交或打包输入。
