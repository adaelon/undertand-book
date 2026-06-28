# SESSION_CHECKPOINT — 2026-06-28 (P8 route Core 三子刀全完成,进 P3/P7)

## 新鲜度自检
- 写入时最新 commit: aa90f6d feat(read-tools): P8-1/P8-2 route Core 导航原语
- 本 checkpoint 与 **P8-3 命令面暴露**(runtime+server+ledger)正一并 commit。读入时对比 `git log -1`,以 git 为准。

## 当前在做什么
设计线 route 两投影带读已 grill 收敛 + **P8 route Core 落地完成**(P8-1 route_from 前沿 / P8-2 route_to BFS / P8-3 命令面)。route 原语(确定性、零 LLM、人机对称)就位,下一步是它的两个消费者 P3/P7。

## 下一步(可直接接手)
1. **P3 人带读 loop**(消费 route + ADR-0036 反馈):`crates/runtime` 在 `run()` 之上做带读——agent 用 `book.route_from` 挑下一停靠点 → 真 `reader.gotoLid`(可撤销 Goto)→ citation-gated 解释 → 停等人;NL 提问→`{轴+类别}`、裸"没懂"走 `route_from(at).back ∩ 未读前置` 结构兜底;technical_learning policy 在 5 类前沿上做教学 reorder/过滤。判据见切片方案 P3。
2. **或 P7 访客 book_guide**(Tier2 连接式会话):`crates/server` AppState 加 VisitorSession 表;`crates/runtime` 加 `book_guide` lite 命令(book_query 姊妹,内部调 route_*,不复用 run());红线靠访客 dispatch 物理无 reader/memory 分支。判据见切片方案 P7 + ADR-0035 决策7。
3. **(正交)PB4** profile sidecar build smoke,独立未做。

## 未提交 / 未完成
- 本批正在 commit(aa90f6d 之后):`crates/runtime/src/orchestrator.rs`(route 两命令 tool_specs+dispatch)、`crates/server/src/lib.rs`(route 两命令 REST GET + 测)、`docs/代码链路.md`(P8-3 条目 + P8 收口)、本 checkpoint。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞):ADR-0034 影响段「REST 自动 GET」措辞修为「手工 wiring」;nearest_valid_lid 错误增强(扩共享 ToolError);route 权重/距离实测回填。

## 冷启动读序
1. `docs/adr/0034-route导航原语-...md` — route 机制 + 两投影 + 命令面落点。
2. `docs/adr/0035-book-mcp访客会话-...md` — 住户/访客 + 三类记忆 + Tier1/Tier2(决策7,P7 用)。
3. `docs/adr/0036-反馈信号模型-...md` — 反馈信号 5 决策(P3 用)。
4. `docs/切片方案-profile深路径.md` §1.5.9 + P3/P7/P8 — 契约 + 切片落点。
5. `docs/代码链路.md` 末三条(P8-1/P8-2/P8-3)— route 已落地的真实接口。
6. (代码接手)`crates/read-tools/src/lib.rs:Book::route_from/route_to`(前沿+BFS,L585 起)+ `crates/runtime/src/orchestrator.rs:run()`(L580,带读架其上)。

## 本会话决策摘要
- **P8 route Core 完成**(已落 docs/代码链路 + cargo test 全绿):`Book::route_from(at,k?)` 返 5 类前沿(edge_type→NavCategory 固定映射,组内 weight/(1+树距) 排序)、`Book::route_to(from,target,k?)` 同批边 BFS;三处命令面暴露(tool_specs/dispatch/REST GET)。
- **两处实现自拍**(待 P3 实测校):未知 local 边→cross 兜底;Tree 仅 next_sibling 进前沿。
