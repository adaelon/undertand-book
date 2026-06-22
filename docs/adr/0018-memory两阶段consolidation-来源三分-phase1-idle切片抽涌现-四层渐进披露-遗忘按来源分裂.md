# ADR-0018 memory 两阶段 consolidation(议题7 第三/四叉):来源三分 + Phase1 idle 切片抽涌现信号 + 四层渐进披露 + 遗忘按来源分裂

状态:已接受(2026-06-22,工程层 grill 议题7 第三/四叉共识)

## 背景
议题7 第三/四叉。[[ADR-0015]] 定了 memory 命令面(记录信封 + LID 引用锚定 + save/recall/delete),把 Codex 式两阶段后台 consolidation + 分层渐进披露产物留本叉。参照 Codex `codex-rs/memories`(README 流水线 + `stage_one_system.md`/`consolidation.md` 两 prompt + phase1/phase2 编排)。**关键同构/差异**:Codex Phase1 是唯一记忆生产者(无命令面 save)、抽取单元 = rollout(明确起止)、遗忘由"输入被删"驱动;我们多了命令面实时 save、抽取单元 = 跨多次打开的连续阅读流、输入(阅读历史)不可删。本叉据此把 Codex 机制改造落地。最高原则(正确性优先、只喂确定性事实+真原文)贯穿。

## 决策
1. **记忆按来源三分,Phase1 只抽涌现信号**(改 Codex"Phase1 唯一生产者"):
   - **显式 save(确定性用户产物)**:`note/highlight/qa` —— reader.note/highlight 委托 memory.save、E 存问答([[ADR-0015]]),即长期记忆、确定性事实,**LLM 不重抽**(防污染)。
   - **Phase1 抽取(跨轮涌现推断)**:`interest/sticking_point/journey` —— 从整个阅读会话交互流浮现、无显式动作,**带证据→推断的认知诚实标注**("反复追问 X→推断对 X 有兴趣",非"对 X 有兴趣"为事实)+ 最小信号闸(无 durable 模式则 no-op,承 Codex)。
   - **会话临时(session layer)**:`dialogue/position` —— 当前对话+阅读位置,Phase1 只消费不产出。
2. **Phase1 抽取单元 = idle 切片段 + 多触发取先到**(改 Codex"per-rollout"):抽取单元 = 自上次 Phase1 以来的未抽交互流;触发器多触发取先到——idle 超时(主,避免抽活跃中,承 Codex"扫 idle 够久")/ 关书·切书·退出(即时,明确边界)/ 交互量·时长超上限(保护,超长强制切);后台扫 idle 够久片段抽取,绑 `source_session_id`。N 分钟/上限阈值留切片0实测。
3. **四层渐进披露产物**(映射 Codex 五层、去 skills 抽取层):
   - **reader-profile**(常驻系统提示,类 `memory_summary.md`):读者画像 + 跨书偏好 + 兴趣/旅程概览。
   - **阅读手册**(可 grep,类 `MEMORY.md`):**双维聚类** —— per-book(这本书读到哪/卡点/问答/笔记)+ cross-book(兴趣/概念对齐,承 [[ADR-0006]] LID 永久有效+概念映射)。
   - **session 详档**(类 `rollout_summaries/`):每阅读会话片段摘要。
   - **raw 原料**(临时,类 `raw_memories.md`):Phase1 条目合并,Phase2 输入。
   - **skills 不作 consolidation 产物**(我们 skills = [[ADR-0005]] §5.4 预设工具集,与 Codex 抽取式 skill 语义不同)。
   - Phase1 产 raw 条目 + session 详档;Phase2 产手册 + 常驻 profile。
4. **遗忘按来源分裂**(改 Codex"输入被删驱动",我们输入不可删):
   - **确定性用户产物(note/highlight/qa)**:永不 usage 遗忘,只用户显式 `memory.delete` 删([[ADR-0015]])——用户笔记是事实,不因未 recall 而删(守正确性+用户预期)。
   - **Phase1 涌现推断(interest/sticking_point/journey)**:usage 剪枝(count/last_used 低 + 超 max_unused_days)+ 时效遗忘(久未被新证据强化)+ 矛盾遗忘(新证据推翻:卡点已解/兴趣转移)——推断会过时,认知诚实。
   - 机制:Phase2 git baseline diff 驱动 consolidation(承 Codex),但"删什么"由来源分裂策略 + usage 数据驱动。
5. **采纳 Codex 同构运行时**(无方向分叉,直接借):Phase1 并发 claim/lease/retry-backoff;Phase2 单全局锁 + INIT/INCREMENTAL 双模式 + watermark bookkeeping;脱敏步骤(用户笔记可能含隐私);证据优先禁编造。

## 命门
- **来源三分是全叉骨架**:确定性产物直存不抽(正确性)、推断才 LLM 抽(且认知诚实标注)、遗忘也按此分裂(用户笔记永不被 usage 静默删)。三处一致,根在用户最高原则。
- **抽取单元改造的必然**:阅读是跨多次打开的连续流,无 Codex rollout 的干净起止;idle 切分 + 多触发是适配。
- **遗忘改造的必然**:我们输入(阅读历史)不可删,Codex"输入被删驱动遗忘"失效;改 usage+时效+矛盾遗忘,但仅对推断,不碰确定性产物。
- **双维聚类**(per-book + cross-book)是我们区别于 Codex 单 cwd-task 聚类的关键,承 [[ADR-0006]] 跨书能力。

## 否决
- **Phase1 统一抽取一切**(含重抽已 save):与 [[ADR-0015]] 冲突(笔记本是长期产物),LLM 重抽确定性产物失真。
- **不要 Phase1、只靠显式 save**:丢 interest/sticking_point/journey 涌现信号,E 主动阅读策略无输入,退化被动笔记本。
- **纯显式边界触发抽取**:用户长期不关则旅程更新永久滞后。
- **纯周期抽取**:可能切在交互中途,涌现模式被腰斩。
- **完整五层含 skills 抽取**:与 [[ADR-0005]] 预设工具集语义重叠/混淆。
- **扁平两层**:丢渐进披露(常驻塞太多/检索无中间路标),违 Codex 借鉴核心。
- **统一 usage 遗忘**:误删用户笔记/高亮(确定性产物因未 recall 静默消失),违正确性+用户预期。
- **只增不减**:手册/profile 无限膨胀,跨书越读越失焦,违 consolidation 要义。

## 何时回头
- 切片0 实测填:Phase1 idle 超时 N 分钟、交互量/时长上限、并发数;Phase2 max_unused_days 窗、top-N selection、时效遗忘阈;矛盾遗忘的"新证据推翻"判据。
- 若实测 cross-book 概念对齐(同名不同书 LID 不同)误聚 → 扩 [[ADR-0006]] 概念映射规则/实体消歧,不退回 per-book 单维。
- type 枚举随读时交互分阶段开放([[ADR-0005]] §5.4)。
- 若 reader-profile 常驻体积膨胀超系统提示预算 → 加 profile 内部 usage 加权裁剪,不复活扁平层。

## 影响
- **回填 V3 §5.3**(memory consolidation:两阶段 + 来源三分 + 抽取单元 + 四层产物 + 遗忘分裂)。
- **新增 CONTEXT 术语**:记忆来源三分 / 两阶段 consolidation(Phase1/Phase2)/ 分层渐进披露产物 / 遗忘按来源分裂。
- **承** [[ADR-0015]](记录模型+命令面+引用锚定)/[[ADR-0006]](记忆层两层隔离+跨书)/[[ADR-0005]](E 运行时+skills)/[[ADR-0004]](引用红线→记忆);参照 Codex `codex-rs/memories`。
- **议题7 全闭环**(第一叉 loop 形态 [[ADR-0016]] + 第二叉 query/synthesize [[ADR-0017]] + 第三/四叉 memory [[ADR-0018]])。下一步:议题8(增量/版本)。
