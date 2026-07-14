# SESSION_CHECKPOINT — 2026-07-14 15:26 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`522e77f feat(server): schedule durable memory reviews`;M2.5=`08d4eab`,M2.4=`1cd3197`,M2.3=`f1ad0a3`,M2.2=`a650fc8`,M2.1=`7e7b4ba`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -12`,若有更晚实现提交则以 Git 与工作树为准。

## 当前状态
可靠画像 memory 的 M2.1-M2.6 已全部实现、独立提交并通过 M2 总闸。当前没有未完成的 M2 工作;下一阶段如继续应从 M3.1 Neutral MemoryPolicy 开始,不得回扫历史 transcript 或提前做 M3.4 global consolidation。

## M2 完成清单
1. M2.1 `7e7b4ba`:typed durable ReviewState/ReviewJob、内容寻址 job、连续 watermark reducer、Running startup recovery、原子状态机。
2. M2.2 `a650fc8`:AgentHistory stable turn ID/ordinal/status、provider 前 PendingAssistant 原子 precommit、成功/失败回填、legacy 稳定迁移。
3. M2.3 `f1ad0a3`:resident Completed/Failed turn 入队、history-watermark 跨文件 gap 在边界幂等修复;visitor/MCP 不 eligible。
4. M2.4 `1cd3197`:独立 ReviewExecutor/factory、短锁 copy/result、模型调用不持 AppState、全局串行与 provider hot reload。
5. M2.5 `08d4eab`:structured extractor/parser、exact resident user evidence、local-first/trust/privacy validator、内容寻址 candidate/fact/observation、facts+observations+Completed+watermark 单 commit。
6. M2.6 `522e77f`:60s idle、8-turn force、1s 指数 retry backoff(60s cap)、startup resume、有限 boundary drain、stale + bounded PendingTurnRef、可见 review error。

## M2 总闸证据
- `cargo test -p memory`:63/63。
- `cargo test -p runtime`:92/92。
- `cargo test -p server`:126/126;host M2 定向 12/12。
- 崩溃恢复:MemoryStore reopen 后 Running→Queued→Completed,attempts 保留,watermark 补齐,fact 不重复。
- fake-clock 时序:59,999ms 不跑、60,000ms 运行;第 8 个未审核 user ordinal 立即运行;retry 精确受 1s/2s next_attempt_at 门控。
- fake boundary waiter:不真实 sleep 即覆盖 timeout;`GET /profile/memory` 返回 200 + stale + pending + REVIEW_DRAIN_TIMEOUT,后台完成后恢复 Current。
- 非阻塞:blocked review executor 期间本地 `/reader/state` route 仍 200;第二 executor 不并发,max_active=1。
- strict clippy:memory/runtime/server `--all-targets --no-deps -D warnings` 通过(runtime/server 只保留既有 3/7 类豁免)。
- `pnpm -C packages/web typecheck`、目标 Rust rustfmt check、`git diff --check` 通过。

## 关键数据流
- Production `start_server`:load history/store → `resume_review_jobs` + reconcile gap → 有 pending 则 startup trigger → 单 scheduler worker。
- Resident chat:history precommit → provider → finalize → reconcile job → HTTP worker 解锁后 note activity → 8-turn/idle tick。
- Review run:短锁 claim/copy → 解锁 provider extractor/validator → 短锁单 commit;provider/unconfigured/parser/input failure 转 Retryable + durable error/backoff。
- Boundary:new/select/book open/create/workbench import 先短锁 reconcile gap,再 detached drain;默认等 10s,可用 `UNDERSTAND_BOOK_REVIEW_DRAIN_TIMEOUT_MS` 配置。
- Stale:当前书有 unresolved job 且 durable last_error 时,ledger 提供 last-good facts,watermark 后 normal resident turns 变 PendingTurnRef;Secret/Sensitive pending text 被排除,Snapshot budget 限量。
- `RunningServer::drain_review_boundary` 是现有 context-compression 接入 hook;当前代码库没有独立 compression route。

## 冷启动读序(如进入 M3)
1. `docs/切片方案-memory可靠画像升级.md` M3.1 与 §5 MemoryPolicy,先做 Neutral fallback,不做 technical/paper/global promotion。
2. `docs/架构.md` 的 Profile fact ledger、Incremental profile extraction、Review scheduling and stale degradation。
3. `crates/memory/src/{profile,projection,review}.rs` 与 `crates/runtime/src/{profile_context,profile_api}.rs`。
4. `docs/代码链路.md` 末尾 M2.1-M2.6 以及以上提交历史。

## 工作树说明
- M2 tracked 变更均已提交;本 checkpoint 是唯一预期待提交 tracked 修改。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。
