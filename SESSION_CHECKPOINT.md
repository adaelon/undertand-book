# SESSION_CHECKPOINT — 2026-06-29 (P3-2 裸兜底已实现+测试绿+落档,待 commit)

## 新鲜度自检
- 写入时最新 commit: `7bf7aae` feat(memory,runtime): P4-3 context 主动记忆+citation闸 / P4-4 四层产物物化。
- **有未提交代码(P3-2 实现)+ 文档(代码链路/切片方案/CONTEXT/本 checkpoint),待 commit;无未提交 ADR(P3-2 复用 ADR-0036,无新 ADR)**。读入以 `git log -1` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(代理服务需在跑)。

## 当前在做什么
**P3-2 裸「没懂」结构兜底 已实现**(ADR-0036 决策3,P4 真历史源就位后捡起)。新确定性命令 `book.unvisited_back(at)` = `route_from(at).back ∩ (全集 \ read_lids)` + SYSTEM_PROMPT 编排引导。`cargo test --workspace` 全绿(runtime 43 / server 27 / memory 12 / read-tools 35 / base-schema 13)+ 落档完。**待 commit**。

## 下一步(可直接接手)
1. **commit**:`git add -u; git add docs/...`(全已跟踪改动:crates/runtime/src/{lib.rs,orchestrator.rs}、crates/server/src/lib.rs、docs/代码链路.md、docs/切片方案-profile深路径.md、CONTEXT.md、SESSION_CHECKPOINT.md;无新文件)。消息建议 `feat(runtime,server): P3-2 裸没懂结构兜底 book.unvisited_back(确定性 back∩未读, ADR-0036)`;push 走代理。
2. **接下来挑一条**(P4 全完、P3-2 已闭;解锁项):
   - **qa 类型落地**:E loop 问答 save `type=qa` → 填 reader_profile/profile.md 卡点维度(现恒空)。
   - **P5 ReActAdapter + provider registry**(切片方案 L572)。
   - **P3-4 Vue 带读 UI**(前端停靠点呈现 + 继续/换路/退回)。
   - **LLM 表达层摘要**(P4-4 何时回头):把 .md 聚合讲成人话(不产事实)。

## 未提交 / 未完成
- **P3-2 代码**:`crates/runtime/src/lib.rs`(unvisited_back 函数 + 单测 + fixture)、`crates/runtime/src/orchestrator.rs`(tool_spec + dispatch 分支 + SYSTEM_PROMPT 裸没懂引导 + dispatch 测试)、`crates/server/src/lib.rs`(GET 投影 + import + 测试断言)。
- **文档**:代码链路 P3-2 条、切片方案 P3-2 标✅、CONTEXT 导航轴术语补命令名。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞):qa 未落地⇒卡点维度恒空;二次「没懂」升级前要不要插反问(ADR-0036 何时回头);viewport re-sync 偏离判定留实测;synthesize `reader_profile=not_attached` prompt 未接;承 P8 三项。

## 冷启动读序
1. `docs/adr/0036-反馈信号模型-...md` — P3-2 裸兜底机制根(决策3 + 命门)。**先读这条**。
2. `docs/代码链路.md` 末尾 P3-2 条 — 改动账本 + 测试 + B2 边界。
3. `crates/runtime/src/lib.rs:unvisited_back`(guided_route_from 姊妹)+ `技术整形 technical_learning_reorder`。
4. `crates/runtime/src/orchestrator.rs` — book.unvisited_back tool_spec/dispatch/SYSTEM_PROMPT 裸没懂引导。
5. `docs/切片方案-profile深路径.md` P3 拆分(P3-1✅/P3-2✅/P3-3✅/P3-4 待做)+ P4(P4-1~4✅)。
6. `crates/memory/src/lib.rs` — read_lids/derive_reader_profile(P3-2 消费的真历史源)/render_*_md(P4-4)。

## 本会话决策摘要
- **P4-3**(commit 7bf7aae):context 主动记忆 + citation 闸(type=context / 无效丢弃零有效仍存)。
- **P4-4**(commit 7bf7aae):四层产物物化只读派生 .md + 单向覆写(ADR-0040)。
- **P3-2 §0.5(本轮,无新 ADR,承 ADR-0036)**:裸「没懂」兜底载体 = 新独立确定性命令 `book.unvisited_back`(否决扩 guided 标 read 让 agent 心算交集,违命门)。
