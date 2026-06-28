# SESSION_CHECKPOINT — 2026-06-28 (P4-2 reader_profile+已读降权完成·未 commit,下一步 commit→P4-3/P4-4 或捡 P3-2)

## 新鲜度自检
- 写入时最新 commit: `878913a` feat(memory,reader): P4-1 确定性已读账本。
- **有未提交代码(P4-2 全刀),待 commit;无其他在途**。读入时以 `git log -1` 为准。
- 注:推送走代理 `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... push`(默认 :10809 不通)。

## 当前在做什么
P4 memory(ADR-0038 重定位:Claude 式透明账本)。**P4-2 reader_profile 确定性派生 + 已读降权已完成**:memory `derive_reader_profile(book_id)`→`ReaderProfile{read_lids,focus_lids(note/highlight),puzzle_lids(qa 暂空)}`;runtime `guided_route_from` 吃 profile 做**组内稳定已读降权**(未读升首·已读沉底·不剔除);dispatch+server GET 接线。全 workspace 全绿。**P3-3 已读个性化现已通**。

## 下一步(可直接接手)
1. **commit P4-2**:`git add crates/memory/src/lib.rs crates/runtime/src/lib.rs crates/runtime/src/orchestrator.rs crates/server/src/lib.rs "docs/代码链路.md" SESSION_CHECKPOINT.md`;消息 `feat(memory,runtime): P4-2 reader_profile 确定性派生 + guided 已读降权(解锁 P3-3)`;push 走代理。
2. **P4-3 用户主动 LLM 记忆**(ADR-0038 决策2):agent 在 E loop 读时判断该记什么(用户显式「记下 X」/ 跨轮反复提及)→ `memory.save` + 认知诚实标注「用户多次提到 X」+ citation 锚真 LID 过确定性闸。**LLM 限定用户主动信号、非后台扫描**。先走 §0/§0.5(含 NEW 行为,可能要 ADR)。
3. **或 P4-4 四层透明文件产物**(reader-profile.md/阅读手册,确定性派生 + 可选 LLM 表达层摘要、不产事实)。
4. **或捡回收点**:P3-2 裸兜底(`back ∩ (全集\read_lids)`,read_lids 已是真历史源)。

## 未提交 / 未完成
- **P4-2 代码(本轮,未 commit)**:`crates/memory/src/lib.rs`(+ReaderProfile/derive_reader_profile/anchor_lids_of_type +1测试)、`crates/runtime/src/lib.rs`(reorder 加 read_set 降权 + guided 加 profile 参数 + import +1测试,2 现有测试随签名改)、`crates/runtime/src/orchestrator.rs`(dispatch 派生 profile)、`crates/server/src/lib.rs`(route_book 加 store 参数 + guided 派生)、`docs/代码链路.md`(P4-2 条)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞):① **qa 类型未落地**(E loop 问答 save type=qa)⇒ reader_profile 疑惑点维度暂空;② synthesize `reader_profile=not_attached` prompt 表达层未接;③ 承 P8:ADR-0034 REST 措辞 / nearest_valid_lid 增强 / route 权重实测;④ ADR-0038「反复提及」阈值(P4-3 用)。

## 冷启动读序
按顺序读这些还原全局上下文:
1. `docs/adr/0038-memory重定位-...md` — P4 现行根基(修正 ADR-0018),Claude 式透明 + LLM 限定用户主动信号。
2. `docs/切片方案-profile深路径.md` P4(L558)+ A4 拆分(P4-1✅/P4-2✅/P4-3/P4-4)。
3. `docs/代码链路.md` P4-1·P4-2 条 — 改动账本。
4. `crates/memory/src/lib.rs` — mark_read/read_lids/derive_reader_profile(ReaderProfile);`crates/runtime/src/lib.rs` — technical_learning_reorder(已读降权)/guided_route_from。
5. `CONTEXT.md`「记忆 consolidation」(ADR-0038)+「记忆层」。

## 本会话决策摘要
- **P4-1 已读账本**:复用 Record `type="read"` 内容寻址去重(§0 拍板);reader goto/scroll 落点真叶记账,scroll 升 Result。已 commit `878913a`+push。
- **P4-2 已读降权语义(§0 拍板)**:**组内稳定降权排后**(未读升首·已读沉底·保原 weight 次序·**不剔除**,保留回看入口);否决「直接剔除已读」(丢回看 + back 类可能被剔空)。
- **P4-2 接口**:`guided_route_from` 吃 `&ReaderProfile`(消费 P4-2a 派生),v1 仅用 read_lids 降权,focus/puzzle 留后续;reader_profile 派生落 memory(贴数据源)、runtime 消费。
