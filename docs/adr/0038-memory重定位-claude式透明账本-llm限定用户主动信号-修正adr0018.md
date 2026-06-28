# ADR-0038 memory 重定位:Claude Code 式透明确定性账本 + LLM 限定用户主动信号(修正 ADR-0018 Codex 自动 consolidation 根基)

状态:已接受(2026-06-28,P4 §0.5 grill 暴露 ADR-0018 根基问题)

## 背景

ADR-0018 把 memory consolidation 定为参照 Codex 两阶段后台自动流水线(Phase1 LLM 抽涌现推断 interest/sticking_point/journey + Phase2 consolidation sub-agent + claim/lease/锁/watermark/git diff)。P4 实现前 grill 时,需求方反馈:**Codex 那套不好用、且自己没真正理解它**。剖析:Codex memory 的核心动作是「后台对全量交互**自动抽推断**」——① 不透明(用户看不见记了什么、为什么),② 记的是**猜测**(兴趣/卡点)而非事实,与本项目最高原则 [[quality-over-speed-correct-context]]「只喂确定性事实」顶牛。用户要 Claude Code 式:显式、透明、可 grep/手编/删、记真东西。**但用户同时澄清:显式要记的、跨轮反复提到的,仍需 LLM**(理解组织 / 识别重复)——分歧不在"要不要 LLM",在"**后台自动全量推断 vs 用户主动信号触发**"。

## 决策

1. **memory 来源三分(重划 ADR-0018 决策1)**:
   - **① 确定性账本(无 LLM,直存)**:真读过的 LID 历史(阅读位置)+ note/highlight/qa(用户显式动作产物)。
   - **② 用户主动 LLM 记忆(LLM,用户信号触发、非后台全量扫描)**:
     - 用户显式「记下 X」→ LLM 理解组织成记忆条目;
     - 用户**跨轮反复提及** → LLM 识别(基于确定性"提了 N 次")。
     - 二者均 **认知诚实标注**「用户多次提到 X」(非「对 X 有兴趣」)+ **citation 锚真 LID**(确定性闸校验)。
   - **③ 会话临时(session,不持久)**:dialogue/position。

2. **读时主动,非后台流水线**:agent 在 E loop(`run()`)里**读时**判断该记什么(用户显式 / 反复提及)→ 调**已有 `memory.save`**,透明落可见文件、用户即时可见可改可删。**砍掉** Codex Phase1/Phase2 后台流水线 + idle 触发 + claim/lease/分布式锁 + watermark + git baseline diff(单用户单机过度工程,且后台=不透明)。

3. **四层产物 = 确定性派生 + 可选 LLM 表达层**:reader_profile / 阅读手册 / session 详档 / raw 从 ①② 确定性聚合派生(已读集 / 关注点 = note·highlight 的 LID / 疑惑点 = qa 的 LID);LLM 至多做**表达层摘要**(把聚合讲成人话),**不产新事实**;v1 可纯确定性聚合、零 LLM。

4. **守最高原则**:记的要么是确定事实(账本),要么是用户**真说的话**(LLM 组织,认知诚实 + citation);零凭空推断。透明(文件可见)+ 用户终裁(可改可删,承 [[ADR-0030]] 可撤销提议)。

## 命门

LLM 介入的**触发**必须是用户主动信号(显式记 / 反复提及),**不是对全量交互的后台推断扫描**——后者 = 黑盒 + 猜测,正是用户拒斥的。记「用户多次提到 X」(事实)非「用户对 X 有兴趣」(推断)。这条线一旦模糊,就退回 Codex 的不透明猜测。

## 否决

- **Codex 式后台自动抽涌现推断**(ADR-0018 Phase1 全量扫描):不透明 + 记猜测,违最高原则 + 用户实测别扭。
- **全砍 LLM**(纯确定性账本):丢"用户显式要记的自然语言 / 反复提及"两类真实需求(用户明确要保留)。
- **后台 Phase1/Phase2 流水线 + 锁/watermark/git diff**:单用户单机过度工程,后台 = 不透明。
- **reader_profile 推断认知水平**(novice/expert):是猜;P3-3 个性化改用确定性规则(已读降权)。

## 何时回头

- "反复提及"的识别阈值(提几次算)+ 是否需确定性计数辅助 LLM。
- LLM 表达层摘要要不要(v1 可纯确定性聚合,无 LLM)。
- reader_profile 确定性规则(已读降权等)对 P3-3 整形是否够(实测)。

## 影响

- **修正 ADR-0018**:Phase1 自动抽推断 / Phase2 后台 consolidation / claim/lease/锁/watermark/git diff **作废**;来源三分 ② 重划(后台抽涌现 → 用户主动信号 LLM 记忆,读时同步)。ADR-0018 **保留**:引用锚定、认知诚实标注、透明文件四层产物、双维聚类(per-book × cross-book)、遗忘按来源分裂(确定性产物只显式删 / 主动记忆可 usage 剪枝)。
- **解锁 P3-2 / P3-3**:已读集(确定性)= P3-2 裸「没懂」兜底「未读前置」**真历史源(无近似)**;reader_profile 确定性规则(已读降权)= P3-3 个性化整形(非 novice 推断)。回收了 [[ADR-0036]]「裸兜底推迟 P4」与 [[ADR-0037]]「reader_profile 留 P4」的依赖。
- 重写**切片方案 P4** 子刀;修 **CONTEXT**「记忆 consolidation(两阶段后台...)」「reader_profile」术语。
- 承 [[ADR-0006]](两层隔离)/[[ADR-0015]](记录模型 + citation)/[[ADR-0030]](读时会话边界 + 可撤销)/[[ADR-0034]]~[[ADR-0037]](route/带读/教学整形消费 reader_profile)。
