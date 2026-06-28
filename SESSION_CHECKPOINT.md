# SESSION_CHECKPOINT — 2026-06-28 (route 两投影带读 grill 收敛:OPEN①②③ 全关闭)

## 新鲜度自检
- 写入时最新 commit: 5e752f5 docs: ADR-0034/0035/0036 route 导航原语 + 访客会话 + 反馈信号模型落档
- 本 checkpoint 与下方改动**正一并 commit**(OPEN②③ 收口 + 切片方案一致性修正)。读入时对比 `git log -1`,以 git 为准。

## 当前在做什么
设计线 **route 两投影带读** 已 grill 收敛:三个 OPEN 全部关闭,落档完成,**下一步进代码**。本会话纯设计落档,**零可执行代码改动**。

## 下一步(可直接接手)
1. **起代码 P8 route Core**(设计已稳):
   - `crates/read-tools/src/lib.rs` 加 `Book::route_from(at, k?)`——架在 `Book::context`(L472)上,吃 `context(at,"far")` 的边,按 `edge_type→NavCategory` 固定映射表重组成 5 类分组(back/forward/concretize/cross/continue),组内 weight×距离 排序,返全 5 类(无 category 过滤参)。
   - 加 `Book::route_to(from, target, k?)`——同批边 BFS 派生。
   - `crates/runtime/src/orchestrator.rs`:`tool_specs()`(L99)+ dispatch(L251)暴露 `book.route_from` / `book.route_to` 两命令。
   - cargo test 确定性覆盖(仿 isCrossWindow/gate);invalid at→not_found+nearest_valid_lid、叶子无边→空 5 类非 error。
2. **再 P3**(人带读 loop 消费 route + ADR-0036 反馈)/ **P7**(访客向导面 Tier1/Tier2 + book_guide)。
3. **(正交)PB4** profile sidecar build smoke,独立未做 CODE 刀。

## 未提交 / 未完成
- 本批正在 commit(5e752f5 之后):`docs/adr/0034`(影响段关 OPEN②)、`docs/adr/0035`(决策7 暴露双层+crate边界)、`docs/切片方案-profile深路径.md`(P3/P7/P8 + §1.5.9,含一致性修正)、`docs/代码链路.md`(OPEN②③ 条目)、本 checkpoint。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。

## 冷启动读序
1. `docs/adr/0034-route导航原语-...md` — route 机制 + 两投影 + 命令面落点(影响段)。
2. `docs/adr/0035-book-mcp访客会话-...md` — 住户/访客 + 三类记忆 + Tier1/Tier2 暴露(决策7)。
3. `docs/adr/0036-反馈信号模型-...md` — 反馈信号 5 决策。
4. `docs/切片方案-profile深路径.md` §1.5.9 + P3/P4/P7/P8 — 契约 + 切片落点。
5. `docs/代码链路.md` 末四条(0034/0035、0036、OPEN②、OPEN③)。
6. (代码接手)`crates/read-tools/src/lib.rs:Book::context`(L472)+ `crates/runtime/src/orchestrator.rs:tool_specs`(L99)/dispatch(L251)。

## 本会话决策摘要(全部已落档)
- **ADR-0036** 反馈信号 5 决策(显式NL主信号 / 二维导航·讲法 / 裸"没懂"结构兜底 / 人访客两插槽 / viewport 模式分裂)。
- **OPEN②**(→ADR-0034 影响段 + P8):route 归 book.* 一等叶子命令,`book.route_from(at,k?)` 返全 5 类 + `book.route_to(from,target,k?)`,两命令暴露 tool_specs。
- **OPEN③**(→ADR-0035 决策7 + P7):Q1 crate 边界(route_*=read-tools 共享 / book_guide=runtime lite / VisitorSession=server / 不复用 run());Q2 暴露双层(Tier1 无状态只读 / Tier2 book_guide 带会话)+ 红线物理无路由 + 裸 route 不给访客 v1。
