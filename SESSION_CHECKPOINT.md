# SESSION_CHECKPOINT — 2026-07-14 14:27 +08:00

## 新鲜度自检
- 写入时最新实现 commit:`1cd3197 feat(runtime): add isolated memory review executor`;M2.3=`f1ad0a3`,M2.2=`a650fc8`,M2.1=`7e7b4ba`。
- 本 checkpoint 将随后形成独立 docs commit;冷启动时对比 `git log --oneline -10`,若有更晚实现提交则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M2.1-M2.4 已完成并过闸;当前切换到 M2.5 incremental extractor + validator + atomic review commit。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` §2.2-§2.4、§4、§6 M2.5、§8 输出 A1 声明:实现结构化抽取/确定性校验/原子结果提交,不做 global consolidation 或自动调度。
2. 定义 ReviewExecutionOutput 的 typed candidate/intent schema 与 provider prompt/parser;candidate/observation ID 内容寻址,只接受 job ReviewInput 范围内 evidence。
3. 在 memory reducer 中新增一次 commit:validated facts + intent observations + job Completed + session watermark + revisions;任一校验/落盘失败时内存/磁盘/job/watermark/facts 全不变。
4. 将 ReviewCoordinator 成功占位替换为 validate+atomic commit;provider failure仍 Retryable;assistant/tool 自说、visitor、Secret/Sensitive inference、非法 scope/status 全部拒绝。
5. 覆盖发布矩阵:M2.5 至少 MEM-E02/E03/E05/E07/E12/E16/E17/E18/E21;运行 Memory/Runtime/Server 总测与 clippy。

## 未提交 / 未完成
- tracked 工作树在写入前干净;本 checkpoint 是唯一预期待提交 tracked 修改。
- M2.5-M2.6 尚未实现:ReviewExecutor 默认显式 unavailable;成功 raw output 仅 Retryable+REVIEW_RESULT_PENDING_VALIDATION,尚不生成事实/推进 watermark。
- Global consolidation、MemoryPolicy、治理 UI 属 M3/M4,不得混入 M2.5。
- 大量未跟踪资料、日志、截图、临时目录和 `docs/预构建画像-quantification-essence.md` 属用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §2.2-§2.4、§3.3、§4、§6 M2.5、§8 - candidate/evidence/trust/privacy/commit 契约。
2. `crates/runtime/src/memory_review.rs` 与 `memory_intent.rs` - M2.4 seam 及可复用 structured provider/payload parser 模式。
3. `crates/memory/src/{review,profile,privacy,operation,document}.rs` - 原子 reducer、fact 构建、隐私与 document revision 边界。
4. `crates/server/src/host.rs:ReviewCoordinator::run_one/copy_review_input` - raw success 占位和锁边界;M2.5 必须保留不持 AppState lock 调模型。
5. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - evidence/trust/local-first/sensitive/global pending 决策。
6. `docs/架构.md` / `docs/代码链路.md` 末尾 M2.1-M2.4 - 当前数据流、测试与提交索引。

## 本会话决策摘要
- M2.1-M2.3:typed ReviewState + stable resident turn + finalize 后入队;跨文件 gap 由 history-watermark 边界补唯一 job。
- M2.4:ReviewExecutor 使用 immutable ReviewInput;AppState 只在 claim/copy 与结果状态提交时短锁,模型调用期释放。
- ReviewCoordinator serial gate 保证全局一次一个 review;每次 run snapshot 最新 ProviderConfig,hot reload 后下一次使用新 config。
- M2.4 成功输出暂留 Retryable+REVIEW_RESULT_PENDING_VALIDATION;M2.5 必须用原子 facts/observations/watermark/Completed commit 替换。
- M2.4 测试:Runtime 85/85、Server 119/119;blocking local route 200,max_active=1,config model-a→model-b;clippy 既有 3/7 类豁免后通过。
