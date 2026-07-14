# SESSION_CHECKPOINT — 2026-07-14 12:30 +08:00

## 新鲜度自检
- 写入时最新 commit: `e947416 style(runtime): apply pending formatting`;M1 最后功能 commit 为 `a3a7093 feat(runtime): expose profile usage and state`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时先对比 `git log --oneline -8`,若实现提交晚于 `e947416` 则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M1 显式记忆闭环已完整实现并通过总闸。当前无在途 M1 代码;下一高层阶段是 M2 增量后台整理,首刀应为 M2.1 `ReviewState + watermark reducer` 的纯状态层。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` M2.1 输出 A1 声明:只做 ReviewJob/status/watermark/error/idempotency 与启动恢复 reducer,不启动线程、不调用模型、不改 AgentHistory。
2. 读取方案 §3.2-§3.4、§6 M2.1 与 ADR-0075,冻结 job identity、状态机、watermark 单调性和 crash reconciliation 输入输出。
3. 新增 `crates/memory/src/review.rs` 及 deterministic tests,覆盖 Running→Queued 启动恢复、重复 job 幂等、completed 不回退、watermark 不倒退、非法状态拒绝与原子提交失败不改内存/磁盘。
4. M2.1 完成前不得进入 M2.2 AgentHistory stable turn/precommit,更不得启动后台 worker 或触碰 M3 policy/consolidation。

## 未提交 / 未完成
- tracked 工作树在 checkpoint 写入前干净;本文件是唯一预期的待提交 tracked 修改。
- M2-M4 尚未实现:无 ReviewJob/review worker、global consolidation、MemoryPolicy/profile-specific state、治理 UI 或历史回填。
- Sensitive pending 仅存在于 `AgentHistory.pending_memory_ops` 的 `serde(skip)` 进程态;进程重启丢弃是 M1 冻结行为,不是 durable ReviewJob。
- server 全文件 `rustfmt --check` 仍命中既有 PDF-selection 格式债;本次新增 Rust 文件/区块已格式化,strict clippy 全绿。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §3.2-§3.4、§6 M2、§8 - durable review 状态机、边界触发和后续总闸。
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - runtime 所有权、证据、隐私、watermark 与边界等待决策。
3. `crates/memory/src/document.rs` - MemoryDocument v2 槽位、revision、validation 与原子 commit seam。
4. `crates/memory/src/{profile,operation,privacy,projection}.rs` - M1 ledger/MemoryOp/隐私/snapshot 已完成契约,不得在 M2.1 重写。
5. `crates/server/src/lib.rs` 的 `AgentHistory`、`route_agent_chat`、`route_agent_new` - M2.2 以后 turn precommit/reconciliation 的消费者边界。
6. `docs/架构.md` / `docs/代码链路.md` 末尾 M1.1-M1.4 - 当前数据流、隔离边界、测试与提交索引。

## 本会话决策摘要
- M1.1:五区 snapshot 由 Core 纯投影;实际序列化 ID/status/text 采用 CJK=1、其他字符=0.25 的确定性预算,以 `projection_revision + request` 缓存。
- M1.2:resident 每用户回合冻结一份 snapshot 并临时注入整个 tool loop;messages/AgentHistory 不持久 snapshot;visitor/MCP 永不读取私人画像。
- M1.3:显式 remember/correct/forget 经确定性快筛与一次 structured extractor;普通表达零额外模型调用;默认 Book,Global 必须显式跨书标记。
- MemoryOp 在一次 MemoryDocument commit 中原子写 evidence+fact/supersession 或 hard forget;显式 evidence 受保护且普通 recall 不可见。
- 隐私分类由 memory/runtime 共享:validator 同查 evidence 与 payload,Normal 只能升级;Secret 本地零 provider 拒绝,Sensitive 必须精确下一消息确认,否则取消。
- Server 在 MemoryOp 后、snapshot 前提交 Normal,因此同一回答可见新事实;operation result 也是 ephemeral data,并以 typed `memory_updates` 返回。
- M1.4:每个 OuterOutcome 返回确定性 injected trace;`profile.mark_used` 只接受 injected 子集且不改 memory;resident `GET /profile/memory` 暴露 typed snapshot/status/facts/evidence,pending 值不序列化。
- M1 commits:`02c19e1`、`5023a41`、`aca4bcf`、`8dab08a`、`478ab83`、`a3a7093`;用户原有两处 rustfmt 修改已按明确授权提交为 `e947416`。
- 最终总闸:`cargo test -p memory -p runtime -p server` 全绿(50/85/114);独立两会话 gate 1/1;Web 91/91、typecheck、production build 通过。仅保留既有 ts-rs serde 属性提示与 Vite 大 chunk 警告。
