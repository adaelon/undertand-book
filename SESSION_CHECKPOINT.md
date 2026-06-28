# SESSION_CHECKPOINT — 2026-06-28 (P4 重定位:ADR-0038 落档,§0.5 完成,下一步 P4-1)

## 新鲜度自检
- 写入时最新代码 commit: 7b9eb5d docs: 刷新 checkpoint(P3-1/P3-3 已 push)
- **有未提交落档(ADR-0038 + CONTEXT + 切片方案 P4 重写),待 commit;无未提交代码**。读入时以 `git log -1` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(默认 :10809 不通)。

## 当前在做什么
P4 memory。**本会话发生方向重置(ADR-0038 修正 ADR-0018)**:用户反馈 Codex memory 不好用——后台自动抽推断**不透明 + 记猜测**,违最高原则。重定位为 **Claude Code 式透明 memory**:记确定事实 / 用户真说的话。**LLM 不砍,但限定在用户主动信号**(显式「记下 X」/ 跨轮反复提及),非后台全量扫描。§0.5 grill + 收尾落档**已完成**(ADR-0038 + CONTEXT + 切片方案 P4 + memory)。

## 下一步(可直接接手)
1. **commit 落档**:`git add docs/adr/0038-*.md CONTEXT.md "docs/切片方案-profile深路径.md" SESSION_CHECKPOINT.md`;消息 `docs(adr-0038): P4 memory 重定位为 Claude 式透明账本,修正 ADR-0018 Codex 自动 consolidation 根基`;push 走代理。
2. **P4-1 确定性已读账本**(首刀,纯确定性无 LLM):`crates/reader`(或 memory)记真读过的 LID(阅读位置历史)→ 已读集 + 进度(reading journey)。判据:读过 vs 没读过确定性可单测。**立刻解锁 P3-2 裸兜底真历史源**(`未读前置 = back ∩ (全集\已读集)`)。先走 A1 声明。注:reader 现仅有 viewport(当前位置),无 visited 累积历史——P4-1 要新增"读过的 LID 累积"(gotoLid/scroll 经过的 anchor 记入)。
3. 后续:P4-2 reader_profile 派生(解锁 P3-3)/ P4-3 用户主动 LLM 记忆 / P4-4 四层文件。

## 未提交 / 未完成
- **落档(本轮)**:`docs/adr/0038-*.md`(新,方向重置)、`CONTEXT.md`(记忆 consolidation 术语重写)、`docs/切片方案-profile深路径.md`(P4 重写 + A4 拆分)、本 checkpoint。
- memory(项目外 `~/.claude`):`memory-system-prefers-claude-style.md`(新 feedback)+ 索引。
- 无未提交代码(P3 那批 7b9eb5d 已 push)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞,承 P8):① ADR-0034「REST 自动 GET」措辞;② nearest_valid_lid 错误增强;③ route 权重/教学序实测回填。

## 冷启动读序
1. **`docs/adr/0038-memory重定位-...md`** — P4 现行根基(修正 ADR-0018),Claude 式透明 + LLM 限定用户主动信号。**先读这条**。
2. `docs/adr/0018-memory两阶段consolidation-...md` — 被修正的旧设计(Codex 同构);对照看哪些保留(引用锚定/认知诚实/四层/双维聚类)、哪些作废(Phase1/2 后台/锁/watermark)。
3. `docs/切片方案-profile深路径.md` P4(L558)+ P4 A4 拆分小节。
4. `CONTEXT.md`「记忆 consolidation」(已重写)+「记忆层」(ADR-0006 两层隔离)+「记忆引用锚定」。
5. `crates/memory/src/lib.rs`(Record/MemoryStore/save/recall/delete,consolidation 未做)+ `crates/reader/src/lib.rs`(viewport 当前位置,无 visited 历史)。
6. `~/.claude/.../memory/memory-system-prefers-claude-style.md` — 方向重置的用户反馈原文。

## 本会话决策摘要
- **P3 全 3 刀已 push**(7b9eb5d):P3-1 带读骨架 / P3-2 落档(裸兜底推迟 P4)/ P3-3 教学整形 + guided_route_from(ADR-0037)。
- **ADR-0038 P4 重定位**(本会话核心):Codex 后台自动抽推断 → Claude 式透明账本 + LLM 限定用户主动信号(显式/反复提及,读时同步)。砍 Phase1/2 流水线/锁/watermark/git diff。四层从确定性产物派生。**解锁** P3-2(已读集=真历史源,无近似)+ P3-3(已读降权,非 novice 推断)。
- **新 P4 拆分**:P4-1 已读账本(首刀,无 LLM,解锁 P3-2)/ P4-2 reader_profile 派生(解锁 P3-3)/ P4-3 用户主动 LLM 记忆 / P4-4 四层文件。
