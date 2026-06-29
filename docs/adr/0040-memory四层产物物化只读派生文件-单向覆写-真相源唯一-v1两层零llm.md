# ADR-0040 memory 四层产物 = 物化只读派生 .md(单向覆写、真相源唯一 memory.json、v1 两层零 LLM)

状态:已接受(2026-06-29,P4-4 §0.5 grill)

## 背景

[[ADR-0038]] 把 memory 重定位为 Claude Code 式「透明可 **grep / 手编 / 删** 文件」,并保留 [[ADR-0018]] 的四层产物(reader-profile / 阅读手册 / session 详档 / raw)。但 ADR-0038 同时**砍掉了产 session 详档 / raw 的 Phase1/Phase2 后台流水线**,这两层失去生产者。且 [[ADR-0012]](语境胶囊降格)/[[ADR-0020]](记忆迁移读时投影)立的原则是**派生视图不物化、读时现场投影**——与 ADR-0038「透明文件」(暗示落盘 .md 才能 grep)直接顶牛。P4-4 实现前 grill,需求方就两个核心分支拍板:① 载体形态;② 物化文件的读写语义。

## 决策

1. **载体 = 物化 .md 文件**(否决「读时投影命令」):真把派生产物写盘成 `.md`(Claude Code 式真可 grep/手编/删),贴 ADR-0038 字面 + 用户参照的 Claude Code 体验。落盘位置 = `memory.json` 同目录(`MemoryStore` 路径的 parent)。

2. **读写语义 = 纯派生只读快照、单向覆写**(否决「托管区+手编区」/「双向同步」):`.md` 是 `memory.json` 的**确定性导出**,每次账本变更(`save`/`delete`)后**整页覆写**。`.md` 是透明**只读窗口**——用户可看/grep/复制,但**改东西走 `memory.delete` 或编 `memory.json`**,手编 `.md` 无意义(下次被覆)。**真相源唯一 = memory.json**,零不一致风险;与 [[ADR-0039]]「直接 long_term + 事后纠正走 delete」一贯。是 ADR-0038(物化)× ADR-0012/0020(不双向、真相源唯一)的折中:**物化但单向**。

3. **v1 范围 = reader-profile + 阅读手册两层、纯确定性零 LLM**:Phase1 被 [[ADR-0038]] 砍 ⇒ session 详档 / raw **失生产者**,v1 不做。两层皆从 ①②(已读账本/note/highlight/qa + `context` 记忆)**确定性聚合**(承 P4-2 `derive_reader_profile`):
   - **reader-profile.md**(单书常驻):已读集 + 关注点(note/highlight)+ 卡点(qa,暂空)+ agent 记的 `context`(按 `generated_at` 排成成长时间线、带 citation)。
   - **阅读手册.md**(双维):per-book(每本读到哪/关注/卡点)+ cross-book(读过哪些书 + 各自 context 条目清单;**概念对齐留 [[ADR-0006]]**,v1 不做)。
   LLM 表达层摘要(把聚合讲成人话)**v1 不做**(守 [[quality-over-speed-correct-context]] + B2 确定性可单测)。

## 命门

`.md` **只读、单向**(账本→文件)是这刀的根:一旦让 `.md` 反向写回 memory.json(双向同步)或留脱离真相源的手编区,就重新引入派生视图与真相源不一致——正是 ADR-0012/0020 否决物化的理由。物化的代价用「单向只读」赎回。

## 否决

- **读时投影命令(不落盘)**:用户明确要 Claude Code 式真文件(可 grep/手编/删),非命令返回的瞬时文本。
- **托管区 + 用户手编区(managed block)**:解析/合并复杂,且手编区 ∉ memory.json 真相源 → 破真相源唯一。
- **双向同步(.md 手编回写 json)**:确定性丧失 + 不一致风险,违 ADR-0012/0020 精神。
- **session 详档 / raw 两层**:Phase1 后台流水线已随 [[ADR-0038]] 砍除,无确定性生产者;强做需复活后台(已否)。
- **v1 含 LLM 表达层摘要**:留后续;v1 先纯确定性、可单测。

## 何时回头

- 需要把聚合「讲成人话」的 LLM 表达层摘要时(不产新事实,只表达层)。
- 需要 session 详档时(须先有非后台的确定性会话摘要源)。
- cross-book 概念对齐(同名概念跨书 LID 不同)误聚 → 扩 [[ADR-0006]] 概念映射,不退回 per-book 单维。
- reader-profile.md 体积膨胀超阅读/系统提示预算 → 加 usage/时间裁剪(**不复活计数器/后台流水线**)。

## 影响

- **承** [[ADR-0038]](四层产物 + 透明)/[[ADR-0039]](context 记忆 + 时间线)/[[ADR-0012]]/[[ADR-0020]](不物化原则,本刀以「单向只读」折中)/[[ADR-0018]](四层来源,session/raw 失源)/[[ADR-0006]](cross-book)。
- 修 **CONTEXT「记忆 consolidation」**四层产物条:物化只读派生 .md、单向覆写、v1 两层零 LLM。
- **落地**:`crates/memory/src/lib.rs` 加四层确定性渲染 + `save`/`delete` 后写盘;v1 reader-profile.md + 阅读手册.md。
