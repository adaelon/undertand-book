# SESSION_CHECKPOINT — 2026-07-14 14:56 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`08d4eab feat(memory): validate and commit incremental reviews`;M2.4=`1cd3197`,M2.3=`f1ad0a3`,M2.2=`a650fc8`,M2.1=`7e7b4ba`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -10`,若有更晚实现提交则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M2.1-M2.5 已完成并过闸;当前切换到 M2.6 scheduler/retry/boundary drain/startup resume/stale degradation。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` §2.6、§3.3、§6 M2.6、§8 与 ADR-0075 输出 A1:实现 60 秒 idle、8-turn 强制、边界有限 drain、retry backoff、startup resume、PendingMemoryContext;不做 M3 global consolidation。
2. 先把时序抽象成可注入 Clock/Scheduler 或纯 reducer,所有 idle/threshold/backoff/timeout 测试使用 fake clock,禁止真实 sleep。
3. start_server 在接收流量前用 durable AgentHistory cursors 调 `resume_review_jobs`;遗留 Running 唯一恢复为 Queued并补 watermark 缺口。
4. resident turn finalize 后更新调度状态;60 秒无新 user turn 或累计 8 个未 review ordinal 触发 run;new-chat/book-switch/context-compression 边界只在预算内 drain。
5. 边界预算耗尽或 review failure 时继续用户流程,用 last-good facts + bounded `PendingTurnRef` 生成 `ProfileStatus::Stale`;错误与 pending 可见,成功后恢复 Current。
6. 覆盖 MEM-E02/E03/E11 与总闸:fake-clock trigger/backoff/drain、重启 Running→Queued→Completed 无重复 fact、blocked executor 不阻塞 reader API。

## 未提交 / 未完成
- tracked 工作树在写入 checkpoint 前干净;本 checkpoint 是唯一预期待提交 tracked 修改。
- M2.6 尚未实现:当前只有手动 `RunningServer::run_one_review(now)`,没有 idle/8-turn 自动触发、backoff eligibility、边界 drain、startup resume 或 stale pending context。
- Global consolidation、MemoryPolicy、治理 UI 属 M3/M4,不得混入 M2.6。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §2.6、§3.3、§6 M2.6、§8 与 `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - timing、boundary、stale 契约。
2. `crates/server/src/host.rs:ReviewCoordinator/RunningServer/start_server` - serial gate、手动 run、启动装配与不持 AppState 锁模型调用边界。
3. `crates/server/src/lib.rs:route_agent_chat/route_agent_new/route_open_book/reconcile_agent_history_review_jobs` - resident finalize 与边界入口。
4. `crates/memory/src/review.rs` - Retryable.next_attempt_at、resume reducer、watermark 与 M2.5 原子 commit。
5. `crates/memory/src/projection.rs`、`crates/runtime/src/profile_context.rs`、`crates/runtime/src/profile_api.rs` - ProfileStatus::Stale、PendingTurnRef 与 snapshot/status API 接线。
6. `docs/架构.md` / `docs/代码链路.md` 末尾 M2.1-M2.5 - 当前数据流、测试与提交索引。

## 本会话决策摘要
- M2.5 production factory 已切到 ProviderReviewExecutor;ReviewInput 包含 current content profile,assistant answer 仅作 context。
- parser 只接受 exact user quote + 当前 job stable turn ID;含糊 Global 降 Book,UserStated/BookInference/GlobalInference 分别由共享 reducer 得 Confirmed/Provisional/Pending。
- Secret/Sensitive background candidate/observation 由共享 privacy classifier 拒绝且错误不回显值;memory commit 再校验 resident session/turn/book/exclusion。
- fact candidate/final fact/observation 均内容寻址;一次 MemoryDocument commit 写 facts+observations+Completed+watermark。Completed retry 为 no-op,落盘失败全量不变。
- intent observation 仅存 ReviewState;observation-only 不推进 projection revision,不进入 snapshot/动作/回答。
- 模型调用仍不持 AppState 锁;serial gate 保证单 executor;hot provider config 下一 job 生效。
- M2.5 tests:Memory 63/63、Runtime 91/91、Server 119/119;目标 crate strict clippy `--no-deps` 通过(runtime/server 既有 3/7 类豁免),目标 rustfmt/diff check 通过。
