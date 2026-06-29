# SESSION_CHECKPOINT — 2026-06-29 (P4-3 + P4-4 已实现+测试绿+落档,P4 全完成,待 commit)

## 新鲜度自检
- 写入时最新 commit: `2817342` docs(adr-0039): P4-3 设计落档。
- **有未提交代码(P4-3 + P4-4 实现)+ 文档(代码链路/ADR-0039 回填/ADR-0040 新/切片方案/CONTEXT/本 checkpoint),待 commit**。读入以 `git log -1` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(代理服务需在跑)。

## 当前在做什么
**P4 memory 大切片 P4-1~P4-4 全部完成**。本会话实现两刀:
- **P4-3**(runtime):用户主动 `context` 记忆 + citation 确定性闸 + SYSTEM_PROMPT judgment 引导。
- **P4-4**(memory):四层产物物化为只读派生 .md(reader-profile.md + reading-handbook.md),save/delete 后单向覆写。
全部测试绿(memory 12 / runtime 41 / workspace 全绿)+ 落档完。**待 commit**。

## 下一步(可直接接手)
1. **commit**:建议拆两条或合一条。文件:
   - `git add crates/runtime/src/orchestrator.rs crates/memory/src/lib.rs docs/代码链路.md docs/adr/0039-*.md docs/adr/0040-*.md docs/切片方案-profile深路径.md CONTEXT.md SESSION_CHECKPOINT.md`
   - 消息建议 `feat(memory,runtime): P4-3 context 主动记忆+citation闸 / P4-4 四层产物物化只读派生md(ADR-0040)`;push 走代理。
2. **接下来挑一条**(P4 已全完,解锁项):
   - **P3-2 裸「没懂」结构兜底**:`route_from(at).back ∩ (全集 \ read_lids)`,真历史源已就位(P4-1 `read_lids`)。
   - **qa 类型落地**:E loop 问答 save `type=qa` → 填 reader_profile/profile.md 卡点维度(现恒空)。
   - **P5 ReActAdapter + provider registry**(切片方案 L572)。
   - **LLM 表达层摘要**(P4-4 何时回头):把 .md 聚合讲成人话(不产事实)。

## 未提交 / 未完成
- **P4-3 代码**:`crates/runtime/src/orchestrator.rs`(memory.save 加 context+citations / dispatch citation 闸 / SYSTEM_PROMPT judgment / +1 测试)。
- **P4-4 代码**:`crates/memory/src/lib.rs`(render_reader_profile_md / render_handbook_md / write_profile_files / all_book_ids / context_timeline;save+delete 末尾 best-effort 写盘;+1 测试)。
- **文档**:代码链路 P4-3+P4-4 条、ADR-0039 回填、ADR-0040 新、切片方案 P4-3✅、CONTEXT consolidation(context type + 四层产物物化)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞):qa 未落地 ⇒ 卡点维度恒空;synthesize `reader_profile=not_attached` prompt 未接;承 P8 三项;context recall 裁剪留实测(不复活计数器)。

## 冷启动读序
1. `docs/adr/0040-memory四层产物物化...md` — P4-4 现行设计(物化只读派生 .md·单向覆写)。**先读这条**。
2. `docs/adr/0039-memory主动记忆-...md` + `docs/adr/0038-memory重定位-...md` — context 记忆 + memory 重定位(上层)。
3. `docs/代码链路.md` 末尾 P4-3 + P4-4 两条 — 改动账本 + 测试 + B2 边界。
4. `crates/memory/src/lib.rs` — Record/save/delete(末尾写盘)/derive_reader_profile/render_*_md/write_profile_files。
5. `crates/runtime/src/orchestrator.rs` — memory.save tool_spec(203)/dispatch citation 闸(468起)/SYSTEM_PROMPT(280起)。
6. `docs/切片方案-profile深路径.md` P4(L558)+ A4 子刀(P4-1✅/P4-2✅/P4-3✅/P4-4✅)。

## 本会话决策摘要
- **P4-3 两 PENDING 落定(ADR-0039 回填)**:type=`context`;citation 闸=无效丢弃·不阻断·零有效仍存。
- **P4-4 §0.5 两分支(ADR-0040)**:① 载体=物化 .md 文件(否决读时投影命令);② 读写语义=纯派生只读快照·save/delete 后单向覆写(否决托管区/双向同步)。v1 两层零 LLM,session 详档/raw 失源不做。
