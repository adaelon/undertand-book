# ADR-0015 reader/memory/错误契约命令面定型:reader 返 effect / 标注单源 memory / Codex 式记忆引用锚定 / 错误分类+recovery

状态:已接受(2026-06-22,工程层 grill 议题6 第二~四叉共识)

## 背景
工程层 grill 议题6 续(承 [[ADR-0014]] 命令面分层,补 `reader.*` / `memory.*` / 错误契约)。V3 §4.2 reader.* 留白、§4.3 memory.* 仅列 recall/save、§4.4 错误信封扁平。需求方立的**最高原则**(memory `quality-over-speed-correct-context`:回答质量第一、agent 上下文必须完全正确)贯穿本轮;并**指定 memory 层参考 Codex**(`E:\allwork\download\agent\codex\codex-rs\memories`)。

读 Codex memory 的关键发现(与本项目同构):① 引用锚定——记忆被用时吐 `MemoryCitationEntry{path, line_start-line_end, note}` + 源 rollout_ids,**每条记忆可回溯源位置**(≈ 我们的 **LID**);② 分层渐进披露(`memory_summary.md` 常驻 / `MEMORY.md` 手册 / `rollout_summaries/*` 详档 / `raw_memories.md` 原料);③ 两阶段后台 LLM 流水线(Phase1 逐会话抽取带最小信号闸、Phase2 consolidation 合并+遗忘+usage 剪枝);④ 证据优先、禁编造、认知诚实。Codex 的 session↔我们阅读会话、cwd↔book_id、跨 repo↔跨书([[ADR-0006]])。

## 决策
1. **reader.* 变更命令返回 effect(变更后相关状态),非裸 ack**:`gotoLid/scroll→{ok,viewport}`、`highlight/note→{ok,id}`、`openPanel→{ok,panel}`。人机对称(人看到结果 / agent 收到结果)+ 兑现切片0"问→跳转→高亮→记笔记"闭环判据 + 守 agent 上下文正确。
2. **reader.* 标注单一真相源 = 记忆层**:`reader.note/highlight` 是薄 UI 入口,持久化**委托 `memory.save`**(返回的 `note_id/highlight_id` 即记忆层 id),reader 渲染时读 `memory.recall(anchor_lid)` 画标注。防双所有者不一致(笔记/高亮属记忆层,[[ADR-0006]])。reader 写记忆层不违 [[ADR-0007]] 硬边界(硬边界只禁写 book 只读基座)。
3. **新增 `reader.state()` 只读会话态** → `{viewport, open_panels, selection}`。补"mutation 只返自己 effect"的盲区,agent 中途接入或人类手动操作后一次拉齐 re-sync。
4. **memory 参考 Codex 定型,命令面与 consolidation 流水线分离**(后者入议题7,与 query/synthesize 移议题7 [[ADR-0014]] 平行):
   - **记录 = 结构信封 + 散文 content + LID 引用锚定**:`{mem_id, type, layer, book_id, anchor:{lid?}|{concept?}, content, citations:[{lid,book_id,note}], usage:{count,last_used}, generated_at, source_session_id}`。Codex `path:lines` → 我们 LID;**引用红线([[ADR-0004]])延伸到记忆层**——recall 带可验证 LID citation、可跳原文。跨书偏好类记录可无 anchor(≈ Codex User Profile)。
   - **type 闭集核心 + 可扩展就绪**(承 [[ADR-0005]] §5.4),源自 [[ADR-0006]] 两层内容:长期 `note/highlight/qa/interest/sticking_point/journey`;会话 `dialogue/position`。**layer ∈ {session, long_term} 为显式字段**,不靠 type 推。
   - `memory.save(record) → {ok, mem_id}`(mem_id 已存=upsert);`memory.recall(query{book_id?, lid?, concept?, type?, layer?, text?}) → [record...]`(带 citations;不限 book_id 即跨书,按 concept 对齐 [[ADR-0006]]);`memory.delete(mem_id) → {ok}`(用户显式删,区别于议题7 后台 usage 遗忘)。
5. **错误契约 = 分类信封 + 类型化 recovery**:`{error_code, category, message, recovery?}`。`category ∈ {validation, not_found, provider, budget, internal}`,让 agent 分流(provider/budget=瞬时,可重试/换后端 [[ADR-0003]];not_found/validation=永久,改输入)。`recovery` 按错误类型化(`{nearest_valid_lid}` / `{suggestions:[...]}` / `{retriable, after_ms}`),**系统永不自动套用**(守禁宽松降级,体检 §14),仅供 agent 自纠。`error_code` 闭集枚举:
   - validation: `INVALID_GRANULARITY / INVALID_K / INVALID_RANGE / INVALID_SCOPE / INVALID_PANEL_TYPE / INVALID_MEMORY_TYPE`
   - not_found: `LID_NOT_FOUND / LID_OUT_OF_RANGE / CONCEPT_NOT_FOUND / MEMORY_NOT_FOUND / ANNOTATION_NOT_FOUND`
   - provider: `PROVIDER_ERROR / BACKEND_UNAVAILABLE / RATE_LIMITED`
   - budget: `CONTEXT_BUDGET_EXCEEDED`
   - internal: `INTERNAL_ERROR`

## 命门
- 用户原则贯穿:reader 返 effect + `state()` = agent 的 UI 上下文恒正确;标注单源 = 防不一致;**memory 引用锚定 = recall 可验证**(引用红线延伸,记忆不再是不可溯的散文)。
- **Codex 两阶段 consolidation = 运行时机器**,与 query/synthesize 同属 agent loop → 议题7,不在议题6 抠签名(否则同 [[ADR-0014]] 之患:无运行时模型硬抠=返工)。
- `recovery` 永不自动套用,是"禁宽松降级"的物理实现:系统给 agent hint、不替它决定,呼应 [[ADR-0011]]/§4.4。
- reader.note/highlight 委托 memory.save 不违硬边界:[[ADR-0007]] 硬边界只禁 reader/memory 写 **book 只读基座**,reader 写**记忆层**(可变、用户私有)合法。

## 否决
- **reader 裸 `{ok}` / void**:agent 无法确认效果、无法闭环,违正确性原则。
- **reader 独立持有标注 / 临时高亮 vs 持久高亮割裂**:双所有者一致性风险,撞 [[ADR-0006]];两套高亮语义割裂,"记笔记"闭环归属不清。
- **memory 自由文本日志(无结构无锚)**:recall 出噪声、跨书无结构支点、喂 agent 上下文不精确,撞用户原则;且丢掉 Codex 引用锚定这一最大可借项。
- **memory 把 consolidation 拉进议题6**:运行时机器,无运行时模型硬抠=返工(同 query/synthesize)。
- **错误扁平 enum(原 §4.4)**:provider/budget 瞬时错与 not_found 永久错混淆,agent 难分"重试 vs 改参";recovery 仅 nearest_valid_lid 一种,concept suggestions / provider retriable 无处放。
- **错误宽松降级(返最近邻内容)**:静默给错数据毒化引用准确率(体检 §14)。

## 何时回头
- **议题7** 定 Codex 式两阶段 consolidation(Phase1 抽取阅读会话 + 最小信号闸 / Phase2 合并+遗忘+usage 剪枝)+ 分层渐进披露产物(reader-profile 常驻 / 阅读手册 / session 详档);本 ADR 只定命令面与记录模型。
- type 枚举随读时交互分阶段开放([[ADR-0005]] §5.4)。
- 跨书概念对齐([[ADR-0006]] 命门:LID 永久有效 + 概念映射)实测后若需实体消歧 → 扩 recall 对齐规则。
- 切片0 实测填:`recovery.after_ms` 默认、provider 重试退避策略。

## 影响
- **回填 V3**:§4.2(reader.* 命令集 + 返 effect + state())、§4.3(memory.* 记录模型 + save/recall/delete + Codex 渊源 + 引用锚定)、§4.4(分类错误信封 + 全集枚举)。
- **新增 CONTEXT 术语**:记忆引用锚定(memory citation,LID 锚)、effect 返回、错误分类+recovery。
- **入议题7**:memory 两阶段 consolidation + 分层产物;`book.query/synthesize` 已在 [[ADR-0014]] 移入。
- **议题6 闭环**。承 [[ADR-0014]](命令面分层)/[[ADR-0006]](记忆层两层隔离)/[[ADR-0007]](命令优先·人机对称)/[[ADR-0004]](引用红线→延伸记忆层);参考 Codex `codex-rs/memories`(两阶段流水线 + 引用锚定 + 分层渐进披露)。
