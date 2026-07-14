# SESSION_CHECKPOINT — 2026-07-14 14:03 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`a650fc8 feat(server): precommit durable resident turns`;M2.1 为 `7e7b4ba`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -6`,若有更晚实现提交则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M2.1-M2.2 已完成并过闸;当前切换到 M2.3 resident turn commit 后可靠创建/合并 ReviewJob。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` M2.3 输出 A1 声明:只在 durable turn finalization 后创建/合并 job,不执行 extraction,visitor/build-workbench job 恒零。
2. 从 `AgentHistory` 纯投影每个 resident session 的 `ReviewSessionCursor {session_id,book_id,latest_user_turn_ordinal}`,明确 PendingAssistant/Completed/Failed 是否都 eligible。
3. 在 AgentHistory completed/failed 原子保存成功后调用 `MemoryStore::reconcile_review_jobs`;history-save/job-save 任一侧崩溃时,启动/边界可由 cursor-watermark 差量补齐唯一 job。
4. 为 normal/provider-failed/new-chat/book-switch/visitor 场景加测试,断言 eligible ordinal 无间隙、重复调用幂等、不合格会话 job 数恒零。
5. M2.3 完成前不得 claim/执行 ReviewJob;executor 留给 M2.4。

## 未提交 / 未完成
- tracked 工作树在写入前干净;本 checkpoint 是唯一预期待提交 tracked 修改。
- M2.3-M2.6 尚未实现:Server 未消费 stable cursors 入队,无 executor/extractor/scheduler。
- Secret 显式记忆请求为 privacy 例外:确定性快筛在 precommit 前拒绝且取消 Sensitive pending,不进 history/磁盘。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §3.2、§6 M2.3 与 §8 MEM-E02/MEM-E03/MEM-E16 - 入队、崩溃恢复与隔离断言。
2. `crates/memory/src/review.rs` 的 `ReviewSessionCursor/reconcile_review_jobs/resume_review_jobs` - M2.1 producer API 与状态不变量。
3. `crates/server/src/lib.rs` 的 AgentChatTurn/AgentHistory、`finalize_agent_turn`、`route_agent_chat`、`route_agent_new`/book switch - M2.2 durable producer 与边界。
4. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - runtime ownership、resident eligibility 与 visitor 隔离。
5. `docs/架构.md` / `docs/代码链路.md` 末尾 M2.1-M2.2 - 当前数据流、测试与提交索引。

## 本会话决策摘要
- M2.1:typed ReviewState、内容寻址 job、Running→Queued 恢复、Completed+watermark 原子终态;纯 review mutation 只推进 document revision。
- M2.2:resident turn 以 session 内 1-based ordinal + stable turn ID 标识;PendingAssistant 先于 provider 原子保存,Completed/Failed 后置原子回填。
- agent-history.json 改为同目录 temp+backup+fsync 替换;candidate 写失败不替换内存且零 provider 调用。
- 旧 history 按 session 顺序确定性补 ID/ordinal/status,重复加载 evidence ID 稳定;visitor/MCP 未改。
- M2.2 测试:Server 117/117;strict clippy 仅豁免 7 类既有债后通过。
