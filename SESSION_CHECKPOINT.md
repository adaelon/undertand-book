# SESSION_CHECKPOINT — 2026-06-29 (P4-5 qa 落地完成,未提交;下一步 commit 或选向 P5/P3-4)

## 新鲜度自检
- 写入时最新 commit: `41fc38c` feat(runtime,server): P3-2 裸没懂结构兜底 book.unvisited_back。
- **有未提交改动**(P4-5 qa 落地 qa-1+qa-2,全绿未 commit)。读入以 `git log -1` + `git status` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(代理服务需在跑)。

## 当前在做什么
**P4-5 qa 落地已完成**(qa-1 生产 + qa-2 消费,§0.5 grill 全程)。qa = LID 价值/提问热度信号(读者私人 ②),回收 P4-2 `puzzle_lids` 恒空缺口。三消费方全锚 `anchor.lid`:确定性 back 升权 / LID-local recall / 透明渲染。**改动全绿未提交**。

## 下一步(可直接接手,挑一条)
1. **commit P4-5 qa 落地**:`git add` ADR-0041 + CONTEXT + 切片方案 + 代码链路 + crates(memory/runtime)+ 本 checkpoint;消息 `feat(memory,runtime): P4-5 qa 落地 = LID 价值热度信号(qa-1 生产 + qa-2 back 卡点升权/recall/渲染)`,然后 push(代理)。
2. **P5 ReActAdapter + provider registry**(切片方案 L597):provider registry + ReActAdapter fallback,归一 AssistantTurn;含 NEW,实现前走 §0.5。
3. **P3-4 Vue 带读 UI**(切片方案 L572):前端停靠点呈现 + 继续/换路/退回(`packages/web`)。
4. **LLM 表达层摘要**(P4-4 何时回头):四层 .md 聚合讲成人话(不产事实,可选层)。

## 未提交 / 未完成
- **P4-5 qa 落地全部改动未提交**(测试全绿):`crates/memory/src/lib.rs`(puzzle_heat/qa_heat/qa_questions/render)、`crates/runtime/src/lib.rs`(reorder 加 puzzle_heat/back 升权)、`crates/runtime/src/orchestrator.rs`(qa enum/save+recall prompt)、`docs/adr/0041`、`CONTEXT.md`、`docs/切片方案-profile深路径.md`(P4-5)、`docs/代码链路.md`(qa-1/qa-2)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞,ADR-0041 何时回头):count 噪声(3vs2)实测;re-ask usage.count 是否加权 heat;concretize/cross 升权(back 不够时);跨读者书内在价值(多读者场景);reader-profile.md 体积裁剪(承 ADR-0040,不复活计数器)。承前:二次「没懂」插反问、viewport re-sync 判定、synthesize reader_profile prompt、承 P8 三项。

## 冷启动读序
1. `docs/切片方案-profile深路径.md` — 总骨架 + A4 子刀状态(P3-1~4✅ / P4-1~5✅ / P5~P8 待做)。**先读这条**。
2. `docs/代码链路.md` 末尾两条(P4-5 qa-1 / qa-2)— 本会话改动账本 + 测试 + B2 边界。
3. `docs/adr/0041-qa落地-...md` — qa = LID 价值热度信号 7 决策 + 三消费方 + 升权压已读(命门:count 读时排序非写闸,区别 ADR-0039)。
4. `crates/runtime/src/lib.rs` — `technical_learning_reorder`(back 组 qa 升权)/ `guided_route_from` / `unvisited_back`。
5. `crates/memory/src/lib.rs` — `ReaderProfile.puzzle_heat` / `qa_heat` / `qa_questions` / `derive_reader_profile` / `render_*_md`。
6. `crates/runtime/src/orchestrator.rs` — SYSTEM_PROMPT(带读+裸没懂+主动记忆+qa 记录/recall)/ tool_specs(memory.save type qa)/ dispatch。
7. `CONTEXT.md` — 术语表(记忆 consolidation / qa 提问热度 / 四层产物 / 导航讲法轴)。

## 本会话决策摘要
- **ADR-0041**(待 commit):qa 落地 = LID 价值/提问热度信号(读者私人 ②)。触发=agent 用 book.query 答完存 qa(锚 query anchor+问题原文);三消费方全锚 anchor.lid(lid→count back 升权 / lid→问题文本 LID-local recall + 透明渲染);升权压已读(卡点=读过+问过冒顶);back-only;count 分层(非 blend);派生 puzzle_lids→puzzle_heat。修正 P4-2 puzzle 恒空。
