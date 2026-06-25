# 切片方案 · Profile 深路径(Core/Profile/Reader 解耦后的书中心能力补齐)

> **定位**:切片1+ 阶段方案,承 ADR-0033。目标不是先做通用 profile registry,而是在保持 Core 稳定的前提下,把当前 `technical_learning` profile 接入长程边、综合、记忆 consolidation、provider、增量构建和 reader 策略。
> **状态**:Grill 已对齐,未开工。当前不改代码;后续每个 P 刀单独 A1 声明、单独验证。

---

## 0. §0.5 锁定决策摘要

1. **Core 固定**:LID/span/citation gate/ReadOnlyBase 外壳/`book.text/context/query/synthesize`/`reader.*`/`memory.*` 属于 Core。
2. **当前 profile**:`technical_learning` 是当前唯一落地 Book Profile,覆盖工具书、教材、技术书、数学、金融等说明型学习材料。
3. **不过早重写 GraphNode**:保留现有 `entity/concept/claim`;profile 新产物先走 optional artifact / sidecar。
4. **Pass2 profile-aware**:Pass2 定名 `technical_learning.pass2_longrange_v1`,输出可降成 `GraphEdge`,审计信息进 sidecar。
5. **synthesize 是 Core + policy**:`book.synthesize` 命令不分叉,执行时消费 `technical_learning` synthesis policy 和可选 reader_profile。
6. **reader_profile 属 memory 投影**:只影响解释路径与检索计划,不写 book base,不作为 citation。
7. **profile artifacts 带版本头**:所有 `technical_learning` artifact 预留迁移头,迁不了标 `orphaned`。
8. **reader.* / adapter 属 Core/runtime**:profile 只管 agent 使用策略和 prompt/policy,不新增特供命令。

---

## 1. A1 阶段总声明

- **做**:在书为中心的主线下补齐深路径能力:Pass2 长程边与全量 scope 自适应、`book.synthesize` 深路径、reader 命令全集与 `technical_learning` agent policy、memory 两阶段 consolidation 与 reader_profile、ReActAdapter/多 provider、增量构建与 profile artifact / memory 迁移。所有新增能力都按 Core/Profile/Reader 三层边界落地。
- **不做**:
  - 不把 `technical_learning` 当成所有书的全局 schema。
  - 不在本阶段第一刀重写 `GraphNode` typed envelope。
  - 不让 reader_profile 进入 ReadOnlyBase 或 citation。
  - 不让 provider 绕过 Runtime/Core 执行工具。
  - 不新增 profile 专属 reader 命令。
- **完成判据**:每个 P 刀都能独立验证;最终系统能以 `technical_learning` profile 产出长程边/语篇/公式等书内深路径,以 Core 命令完成跨 LID 综合和 reader 操作,以 memory consolidation 产 reader_profile,并在增量构建时保留 profile artifact 与 memory 的可迁移/可 orphaned 语义。

---

## 2. A4 子切片

### P0 · ADR-0033 + profile artifact 契约落档 `[docs]`
- **做**:落 ADR-0033 与本切片方案;定义 `ProfileArtifactHeader`、Core/Profile/Reader 边界、`technical_learning` 当前职责、GraphNode envelope 暂不迁移。
- **不做**:不改可执行代码;不改 V3 大文档;不新增 schema 字段。
- **判据**:`rg` 能找到 ADR-0033 的关键边界和 P1-P6 切片计划。
- **触达**:`[ADR-0033]`

### P1 · `technical_learning.pass2_longrange_v1` + 全量 scope 自适应 `[TS/Rust]`
- **做**:把 Pass2 设计为 profile-aware long-range linker。输入包含 catalog、现有 graph_nodes、可选 discourse_index、FormulaSemantics、章节/窗口摘要;输出 long_range 边候选和审计 sidecar。Core gate 校验边端/evidence_lids,通过后降成现有 `GraphEdge(scope=long_range)`。补齐 `book.context far` / `book.query cross_chapter/global` 的实测自适应。
- **不做**:不迁移 GraphNode envelope;不让 Pass2 产新节点;不让 LLM 重建悬空 LID。
- **判据**:长程边端点全真;悬空候选被确定性丢弃;`book.context far` 或 `book.query` 能捞到跨章证据;审计 sidecar 带 profile/version/evidence/rationale。
- **触达**:`[ADR-0010/0011/0013/0016/0033]`
- **实测落点**:long_range 边数量、保留率、跨章召回命中、scope 外扩触发条件。

### P2 · `book.synthesize` 深路径 + technical_learning synthesis policy `[Rust]`
- **做**:实现/补齐 `book.synthesize(lids, task?)`:输入离散 LID 集,不外扩;超预算按 LID 顺序确定性分批归并;响应复用 query 骨架。technical_learning policy 用 discourse_index 组织定义/解释/例子/反驳/总结,遇 formula_lid 时加入 FormulaSemantics;reader_profile 只调表达策略。
- **不做**:不允许 citations 超出输入 lids;不把 reader_profile 当事实;不新增 `technical_learning.synthesize` 命令。
- **判据**:citations 全部属于输入 LID;超预算路径覆盖;包含公式的输入会把 FormulaSemantics 放入 prompt;无 reader_profile 与有 reader_profile 的事实引用一致。
- **触达**:`[ADR-0017/0029/0033]`
- **实测落点**:批大小、归并质量、公式上下文对回答帮助、novice/expert 表达差异。

### P3 · reader.* 全集 + technical_learning agent policy `[Rust/Vue]`
- **做**:补齐冻结命令面里尚未实现的 reader 命令;保持 Core 单一命令面。新增 technical_learning agent policy:何时建议 goto/highlight/note、何时回看 prerequisite、何时展示 FormulaSemantics、何时生成练习。agent 动作仍为可撤销提议。
- **不做**:不新增 profile 专属 reader 命令;不绕过 reader/memory 直接写;不把 agent 提议默认落 long_term。
- **判据**:人和 agent 走同一命令;agent side effects 可撤销;policy 只影响何时调用命令,不改变命令语义。
- **触达**:`[ADR-0007/0015/0030/0033]`

### P4 · memory 两阶段 consolidation + 四层产物 + reader_profile `[Rust]`
- **做**:实现 consolidation:Layer 1 Session Digest、Layer 2 Reading Journey、Layer 3 Knowledge State / Reader Profile、Layer 4 Durable Notes / Highlights。reader_profile 每个推断带 confidence + evidence;用户显式声明优先于小测和行为推断。
- **不做**:不写 book base;不把 reader_profile 作为 citation;不把四层都塞进 reader_profile。
- **判据**:consolidation 能从 session/memory 产四层;reader_profile evidence 可追溯;删除/修改用户画像不会影响 book base;回答时同证据可不同讲法。
- **触达**:`[ADR-0006/0018/0033]`

### P5 · ReActAdapter + provider registry `[Rust]`
- **做**:在现有 ModelAdapter 之上加 provider registry;支持原生 tool calling provider 和 ReActAdapter fallback。所有 provider 输出归一为 `AssistantTurn`;工具执行仍由 Runtime 完成。
- **不做**:不让 provider 自称工具结果;不让 Adapter 理解 technical_learning 或 reader_profile;不绕过错误信封。
- **判据**:同一 orchestrator tool set 可在 native tools 与 ReAct fallback 下运行;工具结果来自 Runtime;provider 错误分类稳定。
- **触达**:`[ADR-0016/0026/0033]`

### P6 · 增量构建 + profile artifact / memory 迁移 `[TS/Rust]`
- **做**:实现 Core LID v1→v2 map;profile artifacts(`discourse_index`、FormulaSemantics、Pass2 sidecar、profile metadata)按 map 迁移或标 orphaned;memory 不批量改写,读时投影;reader_profile evidence 保留 source_book_version。
- **不做**:不猜最近邻;不静默删除 orphaned 记忆或 profile artifact;不把迁移失败伪装成已迁移。
- **判据**:v1/v2 fixture 下 base 可重建;profile artifact 可迁移/标 orphaned;memory recall@v2 可显示 old evidence 的投影或 orphaned 状态。
- **触达**:`[ADR-0019/0020/0033]`

---

## 3. 完成判据复述

```text
ADR-0033 落档
  ∧ technical_learning profile 真实接入 Pass2/discourse/Formula/retrieval/answer policy
  ∧ book.synthesize 深路径遵守 citations ⊆ input lids
  ∧ reader.* 保持 Core 命令面,profile 只管 agent 使用策略
  ∧ memory consolidation 产 reader_profile 且不写 book base
  ∧ provider adapter 与 profile 正交
  ∧ 增量构建能迁移/标 orphaned profile artifacts 与 memory evidence
```

## 4. 实测数字回填清单

| 数字 / 决策 | 回填 |
| --- | --- |
| Pass2 long_range 边保留率 / 丢弃原因 | ADR-0010 / ADR-0033 |
| scope 自适应外扩触发分布 | ADR-0016 |
| synthesize 分批阈值与归并质量 | ADR-0017 |
| reader_profile 对 novice/expert 回答差异的有效性 | ADR-0018 / ADR-0033 |
| ReActAdapter 工具解析失败率 | ADR-0016 |
| profile artifact 迁移 orphaned 比例 | ADR-0019 / ADR-0020 |
