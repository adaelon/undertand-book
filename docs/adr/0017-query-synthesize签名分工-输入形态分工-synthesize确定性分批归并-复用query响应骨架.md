# ADR-0017 book.query/synthesize 精确签名与分工(议题7 第二叉):输入形态分工 + synthesize 确定性分批归并 + 复用 query 响应骨架

状态:已接受(2026-06-22,工程层 grill 议题7 第二叉共识)

## 背景
议题7 第二叉。[[ADR-0014]] 把 LLM 命令签名移入议题7;[[ADR-0016]] 第一叉定了 `book.query` 内层自含外扩 loop(已隐含 query 签名骨架),并埋伏笔:synthesize 与自含外扩的 query 若无法清晰分工则并入 query。本叉正面回答:synthesize 去留 + 两命令精确签名/响应。最高原则(正确性优先、只喂确定性事实+真原文)贯穿。

## 决策
1. **保留 synthesize,按输入形态分工**(证据范围谁定):
   - `book.query(query, anchor_lid?, scope="auto")`:NL 问题 + 单 anchor,**系统隐式检索 + 外扩**找证据(内层自含外扩 loop,[[ADR-0016]])。
   - `book.synthesize(lids:[LID...], task?)`:**调用方给定离散多 LID 集**,系统只在该范围内综合,**无 scope 外扩**。
   - 分工线 = 输入语义截然不同:query 单 anchor + 连续半径**表达不了"就这几个不相邻 LID"**,synthesize 填此缺口(用户阅读器圈选多段 / E 编排已圈定范围)。**不靠任务类型**(多跳问答 vs 综合)划线——边界模糊、两者输入同构无法路由,回 [[ADR-0014]] 之患。
2. **synthesize 内部 = 确定性分批归并**:`texts = [book.text(l) for l in lids]`(确定性取真原文);放得下 → 单轮 LLM 综合(快路径);超预算 → **确定性按 LID 顺序/子树切批**,每批局部综合 → LLM 归并(map-reduce),归并层可按需回取关键 LID 原文。**横向不出 lids 范围(无外扩)+ 纵向全证据确定性进过上下文(不静默丢)**,复用 [[ADR-0009]] 窗口预算纪律。**不靠 LLM 自主挑读**(退回 query 式隐式检索、漏读违正确性、抹掉分工线)。
3. **synthesize 响应复用 query 骨架 + 微调**:`{answer, citations:[{lid,text,role}], model_supplement, evidence_chain, related_concepts, suggested_probing, source_lids, batched}`。差异:`scope_used` → `source_lids`(echo 输入范围)+ `batched` 标记;`citations[].role` 扩枚举(support/contrast/theme…)承载多 LID 证据绑定/对照——**"证据矩阵"靠 role 表达,不另立结构**。命令面一致(消费方一套解析,[[ADR-0007]])。
4. **结构红线范围更紧**:synthesize 的 `citations` 必 `⊆ 输入 lids`(每批确定性校验),比 query 的 ⊆ 检索集更窄;`model_supplement` 仍保留(综合时模型世界知识补充,无 LID,显式隔离,承 V3 §2/§3 原文-补充隔离)。

## 命门
- 输入形态(隐式检索 vs 显式 LID 集)是最可证伪的分工线,且填补 query 真实表达缺口;两命令不重叠、不冗余。
- synthesize **"无 scope 外扩" 守分工**(调用方圈定范围),**"确定性分批归并" 守正确性**(大证据集不静默丢);两者不矛盾——前者管横向(不出范围),后者管纵向(范围内全消化)。
- `citations[].role` 复用即覆盖"证据矩阵"需求,避免第二套响应结构(否则消费方两套解析,且 LID 间 relation 易让 LLM 自由判)。

## 否决
- **砍 synthesize 全归 query**:query 单 anchor+连续半径表达不了离散多 LID 集,用户圈选多段综合无入口。
- **按任务类型分工**(问答 vs 综合):边界模糊,两者输入同构(NL+anchor)无法路由,回 [[ADR-0014]] 之患。
- **synthesize 单轮硬约束**(超预算直接 `CONTEXT_BUDGET_EXCEEDED`):圈一章即失败,产品能力受限。
- **synthesize LLM 自主挑读**:退回隐式检索,漏读违正确性,抹掉分工线。
- **专门证据矩阵响应**:消费方两套解析,relation 易 LLM 自由判。
- **极简 `{synthesis,citations}`**:丢 role/model_supplement/evidence_chain,综合的证据绑定/原文隔离/推理链无处放。

## 何时回头
- 切片0 实测填:synthesize 分批的批预算(复用 [[ADR-0009]] 窗口预算实测)、归并层回取 LID 上限、`role` 枚举的实际取值集。
- 若实测发现 map-reduce 归并层丢跨批对照(类 Pass2 长程问题)→ 加大归并层回取原文配额,不回退单轮硬约束。
- `task` 参数结构化程度(自由文本 vs 受控综合意图枚举)随读时交互分阶段定([[ADR-0005]] §5.4)。

## 影响
- **回填 V3 §4.1**:`book.query` 签名已在 [[ADR-0016]] 注;新增 `book.synthesize(lids, task?)` 完整签名 + 响应结构 + 分批归并;LLM 命令小节去"留议题7"。
- **新增 CONTEXT 术语**:`book.query` / `book.synthesize` 分工(输入形态)+ synthesize 确定性分批归并。
- **承** [[ADR-0016]](query 内层 loop)/[[ADR-0014]](LLM 命令暴露)/[[ADR-0009]](窗口预算)/[[ADR-0004]](结构红线)/[[ADR-0007]](一套面)。
- **议题7 续**:第三/四叉(memory 两阶段 consolidation + 分层渐进披露产物)。**议题7 LLM 命令部分(query/synthesize)闭环。**
