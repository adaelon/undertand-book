# SESSION_CHECKPOINT — 2026-07-14 13:41 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`7e7b4ba feat(memory): add durable review state reducer`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -5`,若有更晚实现提交则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M2.1 durable ReviewState/watermark reducer 已完成并过闸;当前切换到 M2.2 resident AgentHistory stable turn 与 provider 前原子 precommit。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` M2.2 输出 A1 声明:只改 resident AgentHistory turn envelope/migration/precommit,不创建 ReviewJob、不改 visitor history。
2. 在 `crates/server/src/lib.rs` 为 resident user turn 增稳定 `turn_id`、单调 `user_turn_ordinal` 与 PendingAssistant/Completed/Failed outcome;旧 history 加载时确定性补齐且重复加载稳定。
3. 将 `route_agent_chat` 改为 provider 前原子保存用户原话 PendingAssistant,provider 返回后原子回填 Completed/Failed;失败响应不得删除已提交 user turn。
4. 新增 fake provider/重启测试,证明 provider 失败后同一 turn/evidence ID 可恢复,并运行 `cargo test -p server` 与相关 strict clippy。
5. M2.2 完成前不得创建/执行 ReviewJob;入队留给 M2.3。

## 未提交 / 未完成
- tracked 工作树在写入前干净;本 checkpoint 是唯一预期待提交 tracked 修改。
- M2.2-M2.6 尚未实现:AgentHistory 无 stable turn/precommit,server 未入队,无 executor/extractor/scheduler。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。
- Runtime/Server 回归测试保留既有 ts-rs serde 属性提示;非 M2.1 回归。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §3.2、§6 M2.2 与 §8 MEM-E02/MEM-E03 - precommit、恢复和发布断言。
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - runtime 所有权、证据与 durable scheduling 决策。
3. `crates/server/src/lib.rs` 的 `AgentChatTurn`、`AgentHistory`、`load/save_agent_history`、`route_agent_chat` - M2.2 当前边界。
4. `crates/memory/src/review.rs` - 已完成 M2.1 cursor/job/watermark API;M2.2 不调用 reconciliation。
5. `docs/架构.md` / `docs/代码链路.md` 末尾 M2.1 - 当前 durable reducer、测试与提交索引。

## 本会话决策摘要
- M2.1:`MemoryDocument.review_state` 由预留 JSON map 收敛为 typed ReviewState,旧 `{}` 兼容,非法持久状态在 open 时拒绝。
- ReviewJob ID 由 session/book/range 内容寻址;active ranges 从 watermark 连续,未 claim queued tail 可合并,重复 reconcile 不提交。
- 启动恢复只将 Running→Queued;Completed 终态与 watermark 在同一 document commit 中推进,不可回退。
- 纯 job/error/watermark mutation 只推进 document revision;M2.5 facts 原子提交时才同时推进 projection revision。
- M2.1 测试:Memory 59/59、定向 9/9、Runtime 85/85、Server 114/114、memory strict clippy 全绿。
