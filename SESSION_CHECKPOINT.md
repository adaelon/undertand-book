# SESSION_CHECKPOINT — 2026-06-28 (P4-1 已读账本完成·未 commit,下一步 P4-2 / 捡 P3-2 裸兜底)

## 新鲜度自检
- 写入时最新 commit: `ad99e66` docs(adr-0038): P4 memory 重定位为 Claude 式透明账本。
- **有未提交代码(P4-1 全刀),待 commit;无其他在途**。读入时以 `git log -1` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(默认 :10809 不通)。

## 当前在做什么
P4 memory(ADR-0038 重定位:Claude 式透明账本)。**P4-1 确定性已读账本已完成**:reader `goto/scroll` 落点 anchor 真叶 → 委托 `memory.mark_read`(复用 Record `type="read"`,内容寻址去重)落持久账本;`read_lids(book_id)` 返已读集/reading journey。4 crate 全绿。**已解锁 P3-2 裸兜底真历史源**(read_lids = `未读前置 = back ∩ (全集\已读集)`)。

## 下一步(可直接接手)
1. **commit P4-1**:`git add crates/memory/src/lib.rs crates/reader/src/lib.rs crates/server/src/lib.rs crates/runtime/src/orchestrator.rs "docs/代码链路.md" SESSION_CHECKPOINT.md`;消息 `feat(memory,reader): P4-1 确定性已读账本(mark_read/read_lids + goto/scroll 记账)解锁 P3-2 真历史源`;push 走代理。
2. **P4-2 reader_profile 确定性派生**(承 P4 顺序,解锁 P3-3):新方法聚合「已读集(read_lids) + note/highlight/qa 的 LID」→ reader_profile;喂 P3-3 已读降权整形 / P3-2 兜底。无 LLM、确定性可单测。先走 A1 声明。
3. **或先捡 P3-2 裸兜底**(回收点,ADR-0036 决策3):`route_from(at).back ∩ (全集\read_lids)` 落 runtime/read-tools;P3-2 反馈消歧的结构兜底。

## 未提交 / 未完成
- **P4-1 代码(本轮,未 commit)**:`crates/memory/src/lib.rs`(+mark_read/read_lids +2测试)、`crates/reader/src/lib.rs`(goto/scroll 签名+记账,scroll 升 Result,+1测试,5 现有测试随签名改)、`crates/server/src/lib.rs`(goto/scroll 分支接线)、`crates/runtime/src/orchestrator.rs`(同)、`docs/代码链路.md`(P4-1 条)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞,承 P8):① ADR-0034「REST 自动 GET」措辞;② nearest_valid_lid 错误增强;③ route 权重/教学序实测回填;④ ADR-0038「反复提及」阈值 / LLM 表达层摘要是否要(v1 可省)。

## 冷启动读序
按顺序读这些还原全局上下文:
1. `docs/adr/0038-memory重定位-...md` — P4 现行根基(修正 ADR-0018),Claude 式透明 + LLM 限定用户主动信号。
2. `docs/切片方案-profile深路径.md` P4(L558)+ P4 A4 拆分(P4-1✅/P4-2/P4-3/P4-4)+ P3-2 裸兜底决策(L549)。
3. `crates/memory/src/lib.rs` — mark_read/read_lids(已读账本)+ save/recall/delete;`crates/reader/src/lib.rs` — goto/scroll 记账接线。
4. `docs/代码链路.md` P4-1 条 — 改动账本。
5. `CONTEXT.md`「记忆 consolidation」(ADR-0038 重写)+「记忆层」+「记忆引用锚定」。

## 本会话决策摘要
- **P4-1 数据模型(§0 拍板)**:已读账本复用 Record `type="read"`(非独立 ReadingJourney 结构),内容寻址天然去重、复用现有 save/recall/persist/隔离设施 = 最小切。
- **记账触发点(纯技术定)**:reader `goto/scroll` 落点 **anchor 真叶** 记账(goto 容器→子树首叶,非容器 lid;不记 visible 全部、不近似);`scroll` 升 `Result`(记账=持久写,守禁宽松降级不静默)。
- **区分 read vs position**:`type="read"`=① 持久「读过的 LID 历史」;`type="position"`=③ 会话临时当前位置。二者不复用。
