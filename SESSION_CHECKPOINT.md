# SESSION_CHECKPOINT — 2026-07-14 16:19 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`8eaf17a feat(runtime): add neutral memory policy registry`;M2.6=`522e77f`。
- 本 checkpoint 将形成独立 docs commit;冷启动时对比 `git log --oneline -5`,若有更晚实现提交则以 Git 与工作树为准。

## 当前状态
可靠画像 memory 的 M3.1 已实现、全量验证、落档并独立提交。当前切换到 M3.2 technical_learning policy;不得提前做 paper 私有状态或 global consolidation。

## M3.1 完成证据
- `ProfileManifest.memory_policy` 现为共享 policy ID/version contract,technical_learning 与 paper manifest 均声明目标版本,TS 由 ts-rs 生成。
- `MemoryPolicyRegistry` 精确匹配 ID/version;缺插件或版本失配回退 `NeutralMemoryPolicy`,可重建 state 标为 orphaned。
- Neutral 只投影 read_lids 与 qa/note/highlight 原始 activity;不产 hint、不接受 Extension、不写 MemoryDocument。
- server `profile_snapshot_request` 把 policy candidates 接入既有 `profile_projection`;Core 仍拥有 confirmed facts、排序、预算与只读序列化。
- 测试:`cargo test -p read-tools` 122/122、runtime 96/96、server 127/127;Web typecheck 通过。
- strict clippy:read-tools/runtime/server 在仅豁免既有 5/3/7 类债后通过;`git diff --check` 通过。

## 下一步（可直接接手）
1. 读 `docs/切片方案-memory可靠画像升级.md` §5.3/M3.2,锁定 ConceptActivity/LearningHypothesis/goal/prerequisite/hint typed contract。
2. 读 `crates/runtime/src/lib.rs:technical_learning_reorder` 与 `crates/runtime/src/memory_policy.rs`,复用现有 route Core 外整形边界。
3. 在 `crates/runtime/src/memory_policy.rs` 实现并注册 technical_learning v1 policy,以 typed fact/raw activity 派生 state/candidates/hints。
4. 补 contract tests:read→Encountered;qa 只影响 review hint,不产 Confirmed confusion/mastery;当前指令优先。
5. 跑 runtime/server 全量测试、Web typecheck、strict clippy,更新架构/代码链路并独立提交 M3.2。

## 未提交 / 未完成
- tracked 文件:无。
- M3.2-M3.4:尚未实现。
- 大量未跟踪资料、日志、截图、临时目录及 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` M3.2 与 §5.3。
2. `docs/架构.md` 的 Runtime memory policy、Reader profile snapshot projection、Book reading state。
3. `crates/runtime/src/memory_policy.rs` 与 `crates/runtime/src/lib.rs:technical_learning_reorder`。
4. `crates/memory/src/{reading_state,profile,projection}.rs`。
5. `docs/代码链路.md` 末尾 M3.1 与提交 `8eaf17a`。

## 本会话决策摘要
- ADR-0075 既有边界继续生效:policy 派生状态非真相源;版本失配 Neutral fallback;global inference 必须先 Pending。
