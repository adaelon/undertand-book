# SESSION_CHECKPOINT — 2026-07-14 14:13 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`f1ad0a3 feat(server): enqueue durable resident review jobs`;M2.2 为 `a650fc8`,M2.1 为 `7e7b4ba`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -8`,若有更晚实现提交则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M2.1-M2.3 已完成并过闸;当前切换到 M2.4 独立 ReviewExecutor/provider seam。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` §3.3、§6 M2.4 输出 A1 声明:只建 executor/input/output/provider 配置 seam 与单 job 运行骨架,不实现 M2.5 语义 extractor。
2. 检查 `crates/server/src/host.rs` 的 `Arc<Mutex<AppState>>` 生命周期、Provider hot reload 和本地 reader request 路径;检查 runtime adapter 构造/structured completion API。
3. 在短锁内 claim job + 从 AgentHistory 复制 immutable ReviewInput,解锁后调用可阻塞 fake executor,再短锁提交 retry/error 占位状态;模型调用期间不得持 AppState lock。
4. 新增阻塞 fake executor 并发测试:review 阻塞时 `/reader/state` 等本地请求仍能取锁;provider hot reload 后新 job 使用新配置;同一时刻只执行一个 job。
5. M2.4 不生成 CandidateFact/IntentObservation,不推进 watermark/Completed;这些留 M2.5。

## 未提交 / 未完成
- tracked 工作树在写入前干净;本 checkpoint 是唯一预期待提交 tracked 修改。
- M2.4-M2.6 尚未实现:无 executor seam/extractor/scheduler;现有 ReviewJob 只会 Queued。
- Secret 显式记忆请求为 privacy 例外:确定性快筛在 precommit 前拒绝且不进 history/磁盘。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §3.3、§6 M2.4 与 §8 MEM-E03/MEM-E11 - lock、executor、失败与可恢复断言。
2. `crates/server/src/host.rs` - AppState Mutex、request worker、Provider hot reload 与生命周期边界。
3. `crates/runtime/src/lib.rs` 的 ModelAdapter/ProviderConfig/ProviderRegistry/complete_structured - provider seam。
4. `crates/server/src/lib.rs` 的 AgentHistory/ReviewJob enrollment 与 reader state route - immutable input producer和非阻塞消费者。
5. `crates/memory/src/review.rs` 的 claim/retry/complete API - M2.4 只使用 claim/retry,不 complete。
6. `docs/架构.md` / `docs/代码链路.md` 末尾 M2.1-M2.3 - 当前数据流、测试与提交索引。

## 本会话决策摘要
- M2.1:typed ReviewState、内容寻址 job、Running→Queued 恢复、Completed+watermark 原子终态。
- M2.2:stable resident turn 在 provider 前 PendingAssistant 原子保存,后置 Completed/Failed;legacy 确定性迁移。
- M2.3:Completed/Failed finalize 后立即 reconcile;PendingAssistant 在崩溃后的边界 scan 中 eligible。
- cross-file 顺序固定 history commit→ReviewState commit;后者失败保留 durable turn,new-chat/book-open/workbench-switch 边界补唯一 job。
- M2.3 测试:Server 118/118;strict clippy 仅豁免 7 类既有债后通过;visitor/MCP memory revision 仍不变。
