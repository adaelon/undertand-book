# SESSION_CHECKPOINT — 2026-07-14 00:34

## 新鲜度自检
- 写入时最新实现 commit: `e1e6260 refactor(memory): model per-book reading engagement`。
- 本 checkpoint 可随后形成独立 docs commit;读入时请对比 `git log --oneline -6`,若实现提交晚于 `e1e6260` 则以 Git 与工作树为准。

## 当前在做什么
可靠画像 memory 的 M0 数据地基已完整实现并通过总闸;当前无在途 M0 代码,下一高层阶段是 M1 显式记忆闭环,首刀 M1.1 ReaderProfileSnapshot 纯投影尚未开始。

## 下一步(可直接接手)
1. 按 `docs/切片方案-memory可靠画像升级.md` M1.1 输出 A1 声明:只做 seeded facts 到有界 snapshot 的纯投影,不接对话或模型。
2. 读取 `crates/memory/src/{document,profile,reading_state}.rs` 与方案 §2.6/§6 M1.1,确定 snapshot 分区、排序和 token budget 输入输出。
3. 新增 `crates/memory/src/projection.rs` 与最小 deterministic tests,覆盖 status/authority/applicability/recency 和各区预算。
4. 以 `projection_revision` 做 cache invalidation;不得提前进入 M1.2 每回合注入。

## 未提交 / 未完成
- M0:无未提交或未测试项;四刀 commits 为 `6aa103e`、`762f51e`、`d57c870`、`e1e6260`。
- `crates/runtime/src/goldset.rs`、`crates/runtime/src/lib.rs`:用户既有格式化修改;M0.4 提交已选择性排除,不得回退或混入后续提交。
- M1-M4 尚未实现;runtime-owned capture/snapshot injection/review worker/policy/UI 均不属于已完成能力。
- `docs/预构建画像-quantification-essence.md` 及大量未跟踪资料、日志、截图、临时目录为用户/环境既有内容,未清理或暂存。

## 冷启动读序
1. `docs/切片方案-memory可靠画像升级.md` §2.6、§6 M1、§8 - snapshot 契约、后续切片与发布矩阵。
2. `docs/adr/0075-runtime-owned-evidence-backed-profile-memory.md` - 冻结所有权、信任、隐私与不做范围。
3. `crates/memory/src/document.rs` - v2 envelope、revision 与 atomic storage。
4. `crates/memory/src/profile.rs` - typed fact reducer、evidence exclusion 与 resolver。
5. `crates/memory/src/reading_state.rs` - BookReadingState、EngagementSignals 与 legacy projection。
6. `docs/架构.md` / `docs/代码链路.md` 末尾 M0.1-M0.4 - 当前结构、数据流、验证与提交索引。

## 本会话决策摘要
- ADR-0075 前置文档已提交为 `ebf2899`;M0 严格按四个独立子切片提交。
- legacy 裸数组首次打开原子迁移到 `MemoryDocument` v2;所有 mutation 先落盘再切内存。
- ProfileFact 状态由 source × scope 信任矩阵决定;forget 物理删值并只留 content-free evidence hash。
- 旧 code-level ReaderProfile 已由 BookReadingState 取代;旧四字段 JSON/Markdown 仅由显式兼容投影保留。
- 最终总闸:`cargo test -p memory -p runtime -p server` 通过(35/63/105)。
