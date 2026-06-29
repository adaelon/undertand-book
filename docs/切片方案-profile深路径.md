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

## 1.5 technical_learning v0 artifact contracts

> 这些是 P1+ 的输入/输出契约草案。现在先作为 profile sidecar / optional artifact 形状冻结,不要求立即进入 `ReadOnlyBase` 必填字段。

### 1.5.1 ProfileArtifactHeader

所有 `technical_learning` profile artifact 必须带同一版本头,供增量构建和迁移使用。

```ts
interface ProfileArtifactHeader {
  book_id: string;
  book_version: string;
  profile_id: "technical_learning";
  profile_version: string;
  core_schema_version: string;
  generated_at: string;
}
```

迁移规则:

```text
Core LID map 能映射 -> 改写到新 LID / 新 book_version。
Core LID map 不能映射 -> 标 orphaned,不得静默删除。
artifact 自身可重建时优先重建,但旧 artifact 的 orphaned 状态仍要可审计。
```

### 1.5.2 TechnicalLearningDiscourseIndex v0

`discourse_index` 是 `technical_learning` 的 profile artifact,不是 Core graph_edges,也不是全局 schema。它先作为独立 LID 级索引存在;后续 `book.context near/far` 可把它投影为 `via.kind="discourse"`。

```ts
type DiscourseMode =
  | "informative"
  | "argumentative"
  | "procedural"
  | "descriptive"
  | "meta";

type LocalFunction =
  | "definition"
  | "description"
  | "classification"
  | "explanation"
  | "cause"
  | "effect"
  | "example"
  | "counterexample"
  | "comparison"
  | "contrast"
  | "procedure_step"
  | "application"
  | "warning"
  | "limitation"
  | "question"
  | "answer"
  | "summary"
  | "transition";

type RhetoricalMove =
  | "chapter_setup"
  | "problem_framing"
  | "prerequisite"
  | "main_point"
  | "concept_elaboration"
  | "worked_example"
  | "case_analysis"
  | "argument_support"
  | "objection"
  | "resolution"
  | "recap"
  | "bridge_to_next";

type DiscourseRelationType =
  | "elaborates"
  | "exemplifies"
  | "explains"
  | "causes"
  | "results_in"
  | "contrasts"
  | "concedes"
  | "supports"
  | "rebuts"
  | "summarizes"
  | "restates"
  | "prepares"
  | "continues"
  | "answers"
  | "depends_on";

type DiscourseRelationFamily =
  | "temporal"
  | "contingency"
  | "comparison"
  | "expansion";

interface TechnicalLearningDiscourseRelation {
  target_lid: string;
  type: DiscourseRelationType;
  family?: DiscourseRelationFamily;
  direction: "backward" | "forward" | "lateral";
  confidence: number;
  evidence_lids: string[];
}

interface TechnicalLearningDiscourseItem {
  lid: string;
  mode: DiscourseMode;
  local_function?: LocalFunction;
  rhetorical_move?: RhetoricalMove;
  local_summary?: string;
  relations: TechnicalLearningDiscourseRelation[];
}

interface TechnicalLearningDiscourseIndex {
  header: ProfileArtifactHeader;
  items: TechnicalLearningDiscourseItem[];
}
```

抽取与闸规则:

```text
不确定就不标;coverage 可以低,precision 优先。
确定性闸只校验 lid / target_lid / evidence_lids 存在、枚举合法、confidence 在 [0,1]。
确定性闸不判断标签语义是否正确;标签质量靠 gold fixture / 人工验。
relation 可局部也可长程,但必须带 evidence_lids;是否进入 near/far 由投影层根据距离和 scope 决定。
```

### 1.5.3 TechnicalLearningPass2Output v1

Pass2 是 `technical_learning.pass2_longrange_v1`,输出 profile-aware 候选;通过 Core gate 后可降成现有 `GraphEdge(scope="long_range")`。

```ts
interface TechnicalLearningPass2Input {
  header: ProfileArtifactHeader;
  catalog: CatalogEntry[];
  graph_nodes: GraphNode[];
  discourse_index?: TechnicalLearningDiscourseIndex;
  formula_semantics?: FormulaSemantics[];
  windows_or_chapters: Array<{
    lid: string;
    title?: string;
    summary?: string;
    key_lids: string[];
  }>;
}

type TechnicalLearningLongRangeEdgeType =
  | "builds_on"
  | "contradicts"
  | "exemplifies"
  | "prerequisite"
  | "refines"
  | "applies"
  | "analogous_to"
  | "contrasts";

interface TechnicalLearningLongRangeEdgeCandidate {
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  direction: "directed" | "undirected";
  scope: "long_range";
  weight: number;
  evidence_lids: string[];
  rationale: string;
}

interface TechnicalLearningPass2Output {
  header: ProfileArtifactHeader;
  edges: TechnicalLearningLongRangeEdgeCandidate[];
}
```

降级写入规则:

```text
GraphEdge 只接 source / target / type / direction / scope / weight。
profile_id / evidence_lids / rationale 保留在 Pass2 audit sidecar。
source/target 不存在或 evidence_lids 悬空 -> candidate 丢弃,不得 LLM 重建。
```

### 1.5.4 ReaderProfile v0

`reader_profile` 是 memory consolidation 的 Layer 3 读时投影,不是 `technical_learning` book artifact。它影响解释路径和检索计划,不写入 book base,不作为 citation。

```ts
type ReaderEvidenceKind =
  | "self_declared"
  | "quiz_result"
  | "question_pattern"
  | "note_highlight"
  | "reading_behavior";

interface ReaderProfileEvidence {
  kind: ReaderEvidenceKind;
  memory_id?: string;
  session_id?: string;
  lid?: string;
  source_book_version?: string;
  content?: string;
}

interface ReaderDomainBackground {
  domain: string;
  level: "novice" | "beginner" | "intermediate" | "advanced" | "expert";
  confidence: number;
  evidence: ReaderProfileEvidence[];
}

interface ReaderGoal {
  scope: "current_book" | "domain";
  goal: "understand" | "exam" | "work_application" | "research" | "skim";
  confidence: number;
  evidence: ReaderProfileEvidence[];
}

interface ReaderPreference {
  analogy?: boolean;
  math_detail?: "low" | "medium" | "high";
  examples?: "fewer" | "normal" | "more";
  answer_length?: "concise" | "normal" | "detailed";
}

interface ReaderStickingPoint {
  concept: string;
  description: string;
  confidence: number;
  evidence: ReaderProfileEvidence[];
}

interface ReaderKnownConcept {
  concept: string;
  level: "basic" | "working" | "strong";
  confidence: number;
  evidence: ReaderProfileEvidence[];
}

interface ReaderProfile {
  profile_id: "reader_profile_v0";
  updated_at: string;
  domain_background: ReaderDomainBackground[];
  goals: ReaderGoal[];
  preferences: ReaderPreference;
  sticking_points: ReaderStickingPoint[];
  known_concepts: ReaderKnownConcept[];
}
```

优先级与红线:

```text
用户显式声明 > 小测结果 > 行为推断。
所有推断字段必须带 confidence + evidence。
reader_profile 可被用户查看 / 修改 / 删除。
reader_profile 只影响 retrieval planning / answer style / exercise difficulty。
reader_profile 不得作为书中事实 citation。
```

### 1.5.5 SynthesizePolicy v0

`book.synthesize` 是 Core 命令;policy 决定如何组织输入 LID,但不得扩大证据范围。

```ts
interface SynthesizePolicy {
  book_profile: "technical_learning";
  reader_profile?: ReaderProfile;
  mode:
    | "compare"
    | "explain"
    | "summarize"
    | "derive"
    | "teach"
    | "answer_question";
  citation_policy: "citations_subset_of_input_lids";
  formula_policy?: "include_formula_semantics_when_formula_lid_present";
  discourse_policy?: "use_discourse_relations_as_structure_hints";
}
```

执行规则:

```text
按输入 LID 和章节顺序组织证据。
可用 discourse_index 判断定义/解释/例子/反驳/总结层次。
input 中包含 formula_lid 时,可附 FormulaSemantics。
reader_profile 只调解释深度、类比方式、术语密度、前置知识补全。
所有 citations 必须属于 input lids。
```

### 1.5.6 TechnicalLearningAgentPolicy v0

reader 命令属于 Core;`technical_learning` 只定义 agent 何时建议使用这些命令。

```ts
interface TechnicalLearningAgentPolicy {
  reader_actions: {
    suggest_goto_when: Array<
      | "answer_requires_prerequisite_lid"
      | "user_confused_about_current_lid"
      | "long_range_edge_has_high_weight"
      | "formula_semantics_needed"
    >;
    suggest_highlight_when: Array<
      | "local_function_definition"
      | "local_function_warning"
      | "formula_semantics_composition_present"
      | "main_point"
    >;
    suggest_note_when: Array<
      | "user_asked_summary"
      | "reader_profile_sticking_point_resolved"
      | "worked_example_completed"
    >;
  };
}
```

约束:

```text
不新增 profile 专属 reader 命令。
agent 动作仍是真执行 + 可撤销提议。
agent 标注默认 session 层,用户保留才升 long_term。
```
### 1.5.7 Contract consumption matrix

| 切片 | 主要消费契约 | 消费方式 | 产出 |
| --- | --- | --- | --- |
| PB0 profile artifact header/metadata | `ProfileArtifactHeader` | 生成统一 profile header 与 `profile_metadata.json`;后续 sidecar 复用同一 book/profile/core 版本 | 所有 profile sidecar 的版本锚点 |
| PB1 FormulaSemantics sidecar materialization | `FormulaSemantics`; `ProfileArtifactHeader` | 将 SA5 gate 产物固化为带 header 的 profile sidecar,并让读时 loader 兼容完整格式 | `formula_semantics.json` |
| PB2 `TechnicalLearningDiscourseIndex` artifact | `TechnicalLearningDiscourseIndex`; `ProfileArtifactHeader` | 抽取/闸/固化 discourse item 与 relation;只校验 LID/evidence/enum/confidence,不判断语义质量 | `discourse_index.json` |
| PB2b discourse extractor two-stage prompt | `TechnicalLearningDiscourseIndex`; LID-prefixed window | 先逐 LID 分类,再基于分类连局部 discourse relation;prompt 只产候选,gate 决定能否落 sidecar | `agents/discourse-index-extractor.md` + prompt fixtures |
| PB3 Pass2 build orchestration + audit sidecar | `TechnicalLearningPass2Input/Output`; `TechnicalLearningDiscourseIndex`; `FormulaSemantics` | 预构建期调用 pass2 subagent,过确定性 gate,写回 base long_range 边与 audit sidecar | `GraphEdge(scope="long_range")` + `pass2_audit.json` |
| PB4 profile artifact build smoke | PB0-PB3 outputs | 用最小 fixture 从构建输出目录加载 base/source/profile sidecars,验证 read-tools/runtime 能消费 | 预构建到读时的端到端 smoke |
| P1 `technical_learning.pass2_longrange_v1` | `ProfileArtifactHeader`; `TechnicalLearningPass2Input/Output`; 可选 `TechnicalLearningDiscourseIndex`; 可选 `FormulaSemantics` | 读时 context/query 消费 long_range 边;Pass2 gate 能降级候选 | `book.context far` / `book.query cross_chapter/global` 可见长程证据 |
| P2 `book.synthesize` 深路径 | `SynthesizePolicy`; `TechnicalLearningDiscourseIndex`; `FormulaSemantics`; 可选 `ReaderProfile` | 用 discourse 组织输入 LID 的定义/解释/例子/反驳/总结层次;公式 LID 附 FormulaSemantics;reader_profile 调整讲法 | citations ⊆ input lids 的综合回答 |
| P2a `book.context` discourse projection | `TechnicalLearningDiscourseIndex`; `ProfileArtifactHeader` | 把 `relations[]` 投影成 `ContextItem.via.kind="discourse"`;local relation 进 near,long_range relation 进 far;仍不带原文 | `book.context` 可见 discourse via 指针 |
| P3 reader.* 全集 + agent policy | `TechnicalLearningAgentPolicy`; 可选 `TechnicalLearningDiscourseIndex`; 可选 `ReaderProfile` | policy 决定何时建议 goto/highlight/note/回看 prerequisite/展示公式语义 | Core reader 命令调用策略,非新命令 |
| P4 memory consolidation | `ReaderProfile`; `ReaderProfileEvidence` | consolidation Layer 3 产 reader_profile;Layer 1/2/4 作为 evidence 来源 | memory 层 reader_profile 投影 |
| P5 ReActAdapter + provider registry | 不消费 profile artifact;只消费 Runtime 统一 tool/message 契约 | provider 归一到 AssistantTurn;profile 只提供 prompt/policy 给 orchestrator | 多 provider runtime 能力 |
| P6 增量构建 + 迁移 | `ProfileArtifactHeader`; `TechnicalLearningDiscourseIndex`; `TechnicalLearningPass2Output`; `ReaderProfileEvidence` | 按 Core LID map 迁移 profile artifacts 和 memory evidence;失败标 orphaned | 可迁移/可审计的 profile + memory 状态 |

P2a 是显式补刀:它不新增新基础命令,只让既有 `book.context` 消费 `TechnicalLearningDiscourseIndex`。P2 可以先直接读 sidecar 做 synthesize;P2a 则把同一份 discourse relation 变成通用 context 指针,供 agent 和 UI 复用。


### 1.5.8 Book MCP readonly boundary

`Book MCP` 是把一本已预构建书暴露给外部 agent 的只读工具面,不是 reader 会话远程控制面。它只投影 Core 只读命令:

```ts
interface BookMcpTools {
  book_manifest(): Manifest;
  book_text(args: { lid: string; end_lid?: string }): { lid: string; text: string };
  book_context(args: { lid: string; granularity?: "near" | "mid" | "far"; k?: number }): Context;
  book_concept(args: { name: string }): Concept;
  book_query(args: { q: string; anchor_lid: string }): QueryResponse;
  book_synthesize(args: { lids: string[]; task?: string }): SynthesizeResponse;
}
```

红线:

```text
MCP v1 不暴露 reader.*。
MCP v1 不暴露 memory.save / memory.delete。
MCP v1 不共享 /agent/chat messages 或 reader 当前视口。
book_query 必须显式传 anchor_lid;外部 agent 需先用 manifest/concept/context 定位。
```

### 1.5.9 navigation contracts(route + 人/访客两投影)

> route 是 ADR-0034/0035 的输入契约草案。本节**修订 §1.5.8 的"无状态"假设**:P7 由无状态只读改为连接式访客会话。实现前每刀仍按切片重新 A1 声明。

`route` = 图谱上的确定性多跳导航原语(零 LLM,保证 LID/边真实)。

```ts
type NavCategory = "back" | "forward" | "concretize" | "cross" | "continue";

interface RankedStep {
  lid: string;            // 真实 LID
  edge_type: string;      // 真实边类型(local / long_range / discourse / cooccurrence)
  why: string;            // 来自哪条边的导航理由
  evidence_lids: string[];
  score: number;          // 结构排序 = weight × 距离(Core)
}

// 前沿式内核(Core,架在 book.context 上,只做结构排序)。命令面 = book.route_from
// k? 沿用 book.context 截断惯例;永远返全 5 类,无 category 过滤参(OPEN② / ADR-0034 影响段)
function route_from(at: string, k?: number): Record<NavCategory, RankedStep[]>;

// 路径式 = 同批边上 BFS 的确定性组合(派生)。命令面 = book.route_to;target 先经 book.concept 解析
function route_to(from: string, target: string, k?: number): RankedStep[];
```

访客会话(P7 投影):

```ts
interface VisitorSession {
  session_id: string; book_id: string; declared_intent?: string;
  transcript: Exchange[];                              // query + 返回路线/答案 + "不对"反馈
  cursor?: { at_lid: string; last_frontier: RankedStep[] };  // 访客自己的位置,≠ 读者 viewport
  opened_at: string; last_active_at: string;           // 超时 GC 用
}
```

红线(承 ADR-0034/0035):

```text
route 内核零 LLM;NL 意图→入口节点 解析放在 route 之外(复用 book.concept / book.query)。
route_from = Core 结构排序;教学 reorder/过滤 = technical_learning policy + reader_profile。
人投影:agent 主动带读,默认逐停靠点确认(真 reader.goto 可撤销 + citation-gated 解释),自动巡航 opt-in。
访客投影:外部 agent = 临时住户 lite;暴露分两层(ADR-0035 决策7)——Tier 1 无状态只读(不建会话)/ Tier 2 book_guide 带会话(握手/挥手 + 临时游标);③ ephemeral 绝不碰 ② 读者私人记忆;裸 route 不给访客(v1,只给 curate 的 book_guide)。
世界模型可借(route / book_guide),读者私人层(reader_profile / memory / viewport)不可借。
反馈信号(ADR-0036):唯一主信号=开放 NL 提问;反馈意图二维(导航轴→route 5 类 / 讲法轴→policy),agent 据语义定 {轴+类别+target},裸信号走结构兜底;LLM 不产路/不产 LID,route 零 LLM。
```

### 1.6 预构建缺口盘点

ADR-0033 已把 `discourse_index`、`FormulaSemantics`、Pass2 audit、profile metadata 定义为 `technical_learning` profile artifacts,且要求 sidecar 带版本头、LID 证据和 orphaned 处理规则。当前已完成的是读时消费路径:P2/P2a 能读取可选 `formula_semantics.json` / `discourse_index.json` 并用于 `book.synthesize` / `book.context`。缺失的是预构建实际产出层:build pipeline 仍只稳定写 `base.json` 与 `source.txt`,没有统一 header、没有 discourse artifact gate/write、没有 FormulaSemantics sidecar write、没有 Pass2 audit sidecar write,也没有 profile sidecar 的 build smoke。

结论:这些缺口不能塞回 P2/P2a。它们属于预构建阶段,必须拆成 PB0-PB4 独立切片,完成后 P1/P2/P2a 才不再依赖手写 fixture 或外部 sidecar。
---

## 2. A4 子切片

### P0 · ADR-0033 + profile artifact 契约落档 `[docs]`
- **做**:落 ADR-0033 与本切片方案;定义 `ProfileArtifactHeader`、Core/Profile/Reader 边界、`technical_learning` 当前职责、GraphNode envelope 暂不迁移。
- **不做**:不改可执行代码;不改 V3 大文档;不新增 schema 字段。
- **判据**:`rg` 能找到 ADR-0033 的关键边界和 P1-P6 切片计划。
- **触达**:`[ADR-0033]`

### PB0 · profile artifact header / metadata 统一产出 `[TS]`
- **做**:在预构建侧新增 `ProfileArtifactHeader` 构造与 `profile_metadata.json` 写盘。统一 `book_id/book_version/profile_id/profile_version/core_schema_version/generated_at`,后续 `discourse_index`、`formula_semantics`、Pass2 audit 都复用同一 header 来源。
- **不做**:不引入通用 profile registry;不改 `ReadOnlyBase`;不改变 `book.text/context/query/synthesize` 命令签名。
- **判据**:给定一个构建输出目录,能稳定写出 `profile_metadata.json`;header 字段与 `base.json.book_id` 一致;缺字段时构建失败而不是写半成品。
- **触达**:`[ADR-0033 决策9]`

### PB1 · FormulaSemantics sidecar 固化 `[TS/Rust]`
- **做**:把 SA5 的 `gateFormulaSemanticsCandidate` 接入预构建写盘流程,输出带 profile header 的 `formula_semantics.json`;读时 `Book::load` 兼容完整 `{header, items}` 格式和旧 fixture 数组格式。
- **不做**:不把 FormulaSemantics 写入 `ReadOnlyBase` 必填字段;不让无证据解释进入只读语义剖面;不做公式语义质量判断。
- **判据**:fixture 中合法公式语义被写入 sidecar;悬空/越界/缺证据项不进入只读 sidecar;`book.synthesize` 对公式 LID 能消费真实 sidecar。
- **触达**:`[ADR-0029/0033]`

### PB2 · TechnicalLearningDiscourseIndex 抽取闸 + 写盘 `[TS/subagent]`
- **做**:新增 discourse 抽取候选契约、subagent prompt 或构建步骤;确定性 gate 校验 `lid/target_lid/evidence_lids` 存在、枚举合法、`confidence ∈ [0,1]`;输出带 header 的 `discourse_index.json`。
- **不做**:不把 discourse relation 写入 Core `graph_edges`;不新增 `book.discourse`;不让 gate 判断标签语义是否正确。
- **判据**:合法 fixture 写出 `TechnicalLearningDiscourseIndex`;悬空 target/evidence、非法 enum、越界 confidence 被丢弃并可观测;P2/P2a 不再需要手写 discourse fixture。
- **触达**:`[ADR-0033 决策3/4/9]`

### PB2b · discourse extractor 两阶段 prompt `[docs/subagent]`
- **做**:新增 `technical_learning.discourse_index_extractor` prompt,把 discourse 候选抽取拆成两轮:Step A 逐 LID 分类,只产 `mode/local_function/rhetorical_move/local_summary`;Step B 基于 Step A 分类结果连局部 `relations[]`,再交给 `buildTechnicalLearningDiscourseIndex` gate。
- **不做**:不扩 `discourse_index.json` 正式 schema;不加入 `secondary_functions/mentioned_nodes/claim_ids/warnings/signal` 等 prompt trace 字段;不抽 long_range relation;不产 graph node/claim/formula;不把 relation 直接写 Core `graph_edges`;不混入 PB3 Pass2 编排。
- **原则**:
  - LLM 只做可校验的语篇标注,不是深度阅读理解或问答。
  - prompt 必须显式给当前闭集 enum;输出枚举值不得自造。
  - 只为输入窗口中的真实 LID 产 item;`target_lid/evidence_lids` 只能回填输入窗口或明确 boundary LID。
  - `local_function` 表示"这段在做什么",不是主题词;topic 不得塞进 function。
  - 关系少而准;相邻 LID 不自动构成 `continues`。
  - 每条 relation 的 `evidence_lids` 至少包含 source LID 和 target LID;证据弱就不连。
  - `local_summary` 是局部功能摘要,不引入书外知识或扩写解释。
  - `confidence` 校准后使用;低于阈值的 relation 进 dropped/report,不进 sidecar。
- **建议 gate 收紧**:在现有 LID/enum/confidence/evidence 校验之外,增加 evidence 包含 source+target、relation 低置信丢弃、`local_summary` 长度限制;窗口边界限制可在 build 输入具备 `allowedTargetLids` 后再加。
- **判据**:仓库有两阶段 prompt 文件和最小 fixture;fixture 覆盖"定义+解释"、"例子"、"相邻但不连";`rg` 可找到"two-stage"/"少连边"/"evidence_lids 包含 source LID 和 target LID";正式 sidecar schema 保持不变。
- **触达**:`[ADR-0033 决策3/4/9]`

### PB3 · Pass2 预构建编排 + audit sidecar 写盘 `[TS/subagent]`
- **做**:按 `docs/PB3-pass2-prompt-grill.md` 的已确认设计,把 Pass2 从开放式抽边改成 deterministic `long_range_candidates.json` → LLM candidate classification → profile-aware gate → `base.json` long_range 写回 + `pass2_audit.json`;输入 PB1/PB2 sidecars、catalog/graph_nodes、source-window work packets。
- **不做**:不让 LLM 自由发现全书所有长程边;不让 Pass2 产新节点;不让 LLM 重建悬空 LID;不把 rationale/source_evidence_lids/target_evidence_lids 塞进 Core `GraphEdge`;不做 PB4 read-time smoke;不加 `related_to/same_problem/reuses_formula`。
- **实现前必读**:`docs/PB3-pass2-prompt-grill.md` 是 PB3 prompt、candidate builder、gate、audit 的冻结输入;若实现与该文件冲突,必须先回到 Grill/ADR 更新,不得在代码里悄悄改边界。
- **判据**:fixture 可生成 `long_range_candidates.json`;Pass2 prompt 对候选输出 accepted/pending/rejected;accepted 且过 gate 的候选生成 `GraphEdge(scope="long_range")`;`pass2_audit.json` 保留 split evidence、support_level、rejected summary;悬空端点/空证据/单侧证据/weak_inference/同窗口关系被确定性挡住;`book.context far` 能读到写回后的 long_range 边。
- **触达**:`[ADR-0010/0011/0033]`;`docs/PB3-pass2-prompt-grill.md`

### PB4 · profile sidecar build smoke `[TS/Rust]`
- **做**:增加预构建到读时的 smoke:构建输出目录同时含 `base.json/source.txt/profile_metadata.json/formula_semantics.json/discourse_index.json/pass2_audit.json`,Rust `Book::load` 与 runtime `book.synthesize/context` 能消费其中必要 sidecar。
- **不做**:不跑真实全书 LLM 质量评估;不验证 discourse/Formula 标签语义质量;不启动 P6 增量迁移。
- **判据**:`pnpm` 侧构建 fixture 通过 schema/gate;`cargo test` 侧加载同一 fixture 并验证 `book.synthesize` 可见 Formula/discourse hints、`book.context` 可见 discourse via、far 可见 long_range 边。
- **触达**:`[ADR-0033 命门 sidecar 是过渡层]`

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

### P2a · `book.context` discourse projection `[Rust]`
- **做**:让既有 `book.context` 消费 `TechnicalLearningDiscourseIndex`,把 `relations[]` 投影成 `ContextItem.via.kind="discourse"`。local relation 进入 near;长程 relation 进入 far;items 仍只返回 LID 指针,原文继续走 `book.text`。
- **不做**:不新增 `book.discourse` 命令;不把 discourse relation 塞进 Core graph_edges;不让 context item 携带原文。
- **判据**:给定 discourse_index fixture,`book.context` 能返回 discourse via;悬空 target/evidence 已在 artifact gate 阶段被拒;near/far 分层可解释。
- **触达**:`[ADR-0013/0014/0033]`
### P3 · reader.* 全集 + technical_learning agent policy + agent 主动带读 `[Rust/Vue]`
- **做**:补齐冻结命令面里尚未实现的 reader 命令;保持 Core 单一命令面。**人投影"主动带读"**(ADR-0034):agent 消费 `route_from` 的分组前沿,默认**逐停靠点确认**——挑下一停靠点 → 真 `reader.goto`(可撤销提议)→ citation-gated 解释 → 停下等人(继续/换路/退回/没懂),自动巡航 opt-in。technical_learning policy 在 route 的 5 类前沿上做**教学 reorder/过滤**(新手 back 置顶、reader_profile 已懂的跳过),并定 何时建议 goto/highlight/note、何时回看 prerequisite、何时展示 FormulaSemantics、何时生成练习。agent 动作仍为可撤销提议。**反馈信号(ADR-0036)**:停下等人收到的是**开放 NL 提问**(唯一主信号),agent 据语义定 `{轴, route 类别, target?}`——导航轴落 route 5 类、讲法轴落 policy 讲法层(`book.synthesize` 调表达);裸"没懂"走结构兜底(`route_from(at).back ∩ 未读前置`→ 空则讲法轴/有则可撤销提议/二次升级)。每回合开头读 `reader.state()` 做 viewport 静默 re-sync(`at=viewport.anchor_lid`,跟随用户已做的导航,不主动问;"问"仅在 opt-in 巡航被滚动打断时)。
- **不做**:不新增 profile 专属 reader 命令;不绕过 reader/memory 直接写;不把 agent 提议默认落 long_term;**不让 route 内核带 LLM 或 profile 偏见**(route_from 是 Core 结构,教学整形只在 policy 层);**不默认自动巡航**。
- **判据**:人和 agent 走同一命令;agent 主动带读逐停靠点可撤销;route_from 结构排序确定性可单测,policy 教学排序作用在分组上;policy 只影响何时/怎么用命令,不改变命令语义;**带读消费 NL 提问→`{轴+类别}`、裸信号结构兜底确定性可测、viewport 偏离触发静默 re-sync 而非自动改路(ADR-0036)**。
- **触达**:`[ADR-0007/0015/0030/0033/0034/0036]`
- **依赖**:route Core 原语(P8);route 命令面落点/命名**已定**(ADR-0034 影响段:`book.route_from(at,k?)` / `book.route_to(from,target,k?)`,详见 P8)。

#### P3 · A4 子刀拆分(实现期)

> P3 大切片 A4 拆 4 子刀,刀刀独立验。架构方向(§0 用户拍板):带读 = 复用 `runtime::run()` + SYSTEM_PROMPT 驱动,`route_from` 是确定性 Core,带读策略 = LLM policy(prompt),Rust 只加确定性兜底;守 ADR-0034 决策2 mechanism/policy 分离。

- **P3-1 带读骨架**(✅ 完成):SYSTEM_PROMPT 逐停靠点引导(reader.state→route_from 挑停靠点→gotoLid→synthesize 解释→停等人)+ 管道回归测试。详见 `docs/代码链路.md` P3-1 条。
- **P3-2 反馈消歧**:NL→`{轴+类别}` 识别(prompt 强化,ADR-0036 决策2)+ viewport 静默 re-sync(prompt,决策5);**裸「没懂」结构兜底推迟**(见下决策)。
- **P3-3 technical_learning policy**:`TechnicalLearningAgentPolicy` 教学 reorder/过滤 5 类前沿 + 何时建议 goto/highlight/note/回看/展示公式;含 NEW 术语,实现前走 §0.5。
- **P3-4 Vue 带读 UI**:前端带读交互(停靠点呈现 + 继续/换路/退回)。

**决策**:裸「没懂」结构兜底(`route_from(at).back ∩ 未读前置`)推迟 P4 之后,P3-2 不做。

**否决**:
- A `memory` 已交互 LID 近似:「已读」判定失真(交互过≠读过),违质量优先·上下文必须完全正确。
- B `visited` 留空占位:全部 back 恒算未读,兜底语义失真。

**命门**:「未读」判错 → agent 提议回看已读 / 漏真未读前置,污染 agent 上下文,踩最高原则;须用 P4 真 reading journey 历史,不用近似。
**何时回头**:P4 reader_profile / journey 历史落地后捡起裸兜底(ADR-0036 决策3)。

### P4 · memory:确定性账本 + 用户主动 LLM 记忆 + 四层派生(reader_profile)`[Rust]`
> **ADR-0038 重定位**(修正 ADR-0018 Codex 自动 consolidation 根基):Claude Code 式透明 memory——记**确定事实 / 用户真说的话**,砍后台自动抽推断。回收 P3-2 裸兜底 + P3-3 个性化的 P4 依赖。原"Layer 1-4(Session Digest/Reading Journey/Knowledge State/Durable Notes)"措辞作废,四层以 ADR-0038/CONTEXT 为准。

- **做**:① 确定性已读账本(真读 LID 历史 → 已读集 + reading journey)② reader_profile 确定性派生(已读集 + note/highlight/qa 的 LID)③ 用户主动 LLM 记忆(显式「记下 X」/ 跨轮反复提及,读时 `memory.save` + 认知诚实标注 + citation 闸)④ 四层透明文件产物(reader-profile/阅读手册/session 详档/raw)。reader_profile 是三类记忆的 ②(读者私人),供 **P3-2 裸兜底真历史源 + P3-3 已读降权整形**,绝不外借访客(ADR-0035)。
- **不做**:不写 book base;不把 reader_profile 作 citation;**不做 Codex 式后台自动抽推断**(interest/sticking_point/journey 凭空猜);不做 Phase1/2 后台流水线 / 锁 / watermark / git diff;**reader_profile 不推断认知水平**(novice/expert 是猜,改已读降权确定性规则);不把 ② 经 MCP/访客面泄漏(访客只拿 ③,见 P7)。
- **判据**:已读账本确定性可单测(读过 vs 没读过);reader_profile 从确定性产物派生、evidence 可追溯真 LID;用户主动 LLM 记忆带 citation 过确定性闸 + 认知诚实标注;四层文件可 grep/手编/删;删改画像不影响 book base。
- **触达**:`[ADR-0006/0015/0030/0038(修正0018)/0034-0037]`

#### P4 · A4 子刀拆分(实现期)
- **P4-1 确定性已读账本**:reader 记真读 LID(位置历史)→ 已读集 + 进度(reading journey)。纯确定性可单测、无 LLM。**解锁 P3-2 裸兜底真历史源**。
- **P4-2 reader_profile 确定性派生 + P3 接口**:已读集 + note/highlight/qa 的 LID 聚合 → reader_profile;喂 P3-3 已读降权整形 / P3-2 兜底。无 LLM。**解锁 P3-3 个性化**。
- **P4-3 用户主动 LLM 记忆**(一条线,不拆 `[ADR-0039 修正 ADR-0038]`)**✅ 实现(2026-06-29)**:**触发 = agent 读时 judgment ∨ 用户显式「记下 X」**(**砍确定性计数器** / 反复提及独立机制);**记什么 = 构建用户上下文(含对用户理解/推断)+ 三护栏**(透明落可见文件 / 用户可改可删 / 认知诚实标注+citation 锚真 LID);**直接 `long_term` + 可删兜底**(非提议态,事后纠正 > 事前批准);每条带 `generated_at` = 成长时间线。落地 = SYSTEM_PROMPT judgment 引导 + `memory.save` 扩 `citations` 参数 + dispatch citation 闸(⊆ 真 LID,无效丢弃不阻断)+ type `context`。**两 PENDING 落定**:type=`context`、citation 闸=无效丢弃·零有效仍存。详见 `docs/代码链路.md` P4-3 条。
- **P4-4 四层文件产物**:账本 / 记忆派生成透明 grep 文件(reader-profile.md / 阅读手册)+ 可选表达层摘要(不产事实)。

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

### P7 · Book MCP 访客向导面(连接式访客会话) `[Rust/MCP]`
> **本刀修订 ADR-0033 决策12 / §1.5.8 的"无状态"假设**,改为连接式(ADR-0035)。
- **做**:把已预构建 book 目录投影成 MCP server,暴露只读工具 `book_manifest/text/context/concept/query/synthesize` + **`book_guide(intent, anchor?)`**(返路线:意图→入口→route 路线含每步理由+证据 LID,是 book_query 的姊妹)。**连接式访客会话**(TCP 式握手/挥手):握手发 `session_id`、传输期支持"不对"refine、挥手即焚 + 超时 GC;会话含 `transcript` + 临时游标 `cursor{at_lid,last_frontier}`(访客自己的位置,≠ 读者 viewport)。复用 `read-tools::Book` + runtime citation gate + route(P8)。**暴露分两层(ADR-0035 决策7)**:Tier 1 无连接无状态只读(`book_manifest/text/context/concept/query/synthesize`,不建会话)/ Tier 2 带会话 `book_guide`(握手/挥手/GC 只压此层)。**crate 落点**:route_* 在 read-tools Core(P8,共享)、`book_guide` 在 runtime(lite LLM 命令、book_query 姊妹、不复用住户 `run()`)、VisitorSession 在 server `AppState`。**访客反馈(ADR-0036)**:与人同一消歧骨架,但换两插槽——历史来源用 ③(`cursor.last_frontier`+transcript,非 ② viewport/memory)、讲法整形为空(中立重述,讲法轴近塌缩)、终裁者=访客自身("不对"即指令,直接换前沿分支,无可撤销提议环节)。
- **不做**:不暴露 `reader.*`;不写 `memory.*`;不共享 localhost reader 当前视口 / `/agent/chat` messages / 读者 session;不新增 profile 专属 MCP 命令;**不把 ③ 访客会话写入 ② durable store**;**不暴露对话式住户 agent**(模糊住户/访客界、泄漏私人房间);**不给访客裸 `route_from/route_to`(v1,只给 curate 的 book_guide)**;**红线靠访客 MCP dispatch 物理无 reader/memory 分支,非运行时权限判**;**不为 Tier 1 只读建会话**;**不把 book_guide 逻辑塞进 server(LLM 命令在 runtime)**。
- **判据**:外部 agent 经 `book_guide` / route 拿到全真 LID 的路线并可跨调用 refine("不对"→换前沿分支);所有回答 citation 满足 Core 红线且可独立验证;挥手后 ③ 被 GC;并发访客各自会话隔离、读者私人层零泄漏;超时会话被 GC(承重墙);**Tier 1 只读调用不建会话(可测)**;**访客面 dispatch 物理不含 reader/memory 分支(构造 reader.goto 无路可达,可测)**。
- **触达**:`[ADR-0033 决策12(修订)/0034/0035/0036]`
- **依赖**:route Core 原语(P8);server AppState 从单会话扩为 住户1+访客N(会话表)。

### P8 · route Core 导航原语(前沿式 + 路径式 BFS) `[Rust]`
> P3 人投影带读 + P7 访客向导的**共享底座**;承 ADR-0034。
- **做**:实现 Core `Book::route_from(at, k?)`(前沿式,架在 `book.context` 上——吃 `context(at,"far")` 的边按 `edge_type→NavCategory` 重组,返回 5 类导航分组 `back/forward/concretize/cross/continue`,`edge_type→类别` 固定映射表,组内 weight×距离 结构排序,k 沿用 context 截断惯例)+ `Book::route_to(from, target, k?)`(同批边 BFS 派生)。**命令面落点(ADR-0034 影响段已定)**:`book.route_from`/`book.route_to` 两命令均经 `orchestrator::tool_specs()` + dispatch 暴露给外层 LLM(bounded,非 manifest token 炸弹),REST 自动 GET;参数最小、route_from 永远返全 5 类(不给 category 过滤参,挑类是上层);错误信封遵循 ADR-0015。零 LLM、纯确定性、可单测。
- **不做**:不在 route 内核放 LLM 或 profile 偏见(教学整形留 P3 policy 层);不让 route 吃 NL(意图→入口解析复用 book.concept/query);不给 route_from 加 category 过滤参(挑类是 agent/policy 关切,渗进 Core 即层违规);不新增 reader/memory 写;不碰访客会话(P7)。
- **判据**:给定基座 fixture,`route_from` 确定性产出全 5 类分组前沿、全是真 LID/真边、`edge_type→类别` 覆盖全边类型;`route_to` BFS 路径全真且与前沿同批边;`book.route_from/route_to` 在 tool_specs 暴露且 dispatch 可调,invalid at 返 not_found+nearest_valid_lid、叶子无边返空 5 类非 error;cargo test 确定性覆盖(像 isCrossWindow/gate 那样)。
- **触达**:`[ADR-0007/0013/0014/0028/0034]`
- **实测落点**:5 类是否够用(有无落不进的边)、weight×距离 权重、前沿规模上限。
---

## 3. 完成判据复述

```text
ADR-0033 落档
  ∧ PB0-PB4 预构建能真实产出 profile metadata / FormulaSemantics / discourse_index / Pass2 audit sidecars
  ∧ technical_learning profile 真实接入 Pass2/discourse/Formula/retrieval/answer policy
  ∧ book.synthesize 深路径遵守 citations ⊆ input lids
  ∧ reader.* 保持 Core 命令面,profile 只管 agent 使用策略
  ∧ memory consolidation 产 reader_profile 且不写 book base
  ∧ provider adapter 与 profile 正交
  ∧ 增量构建能迁移/标 orphaned profile artifacts 与 memory evidence
  ∧ route Core 导航原语支撑 agent 主动带读(人投影)与 book_guide 访客向导(外部 agent 投影),读者私人层零泄漏
```

## 4. 实测数字回填清单

| 数字 / 决策 | 回填 |
| --- | --- |
| Pass2 long_range 边保留率 / 丢弃原因 | ADR-0010 / ADR-0033 |
| scope 自适应外扩触发分布 | ADR-0016 |
| synthesize 分批阈值与归并质量 | ADR-0017 |
| reader_profile 对 novice/expert 回答差异的有效性 | ADR-0018 / ADR-0033 |
| ReActAdapter 工具解析失败率 | ADR-0016 |
| profile artifact 预构建 sidecar 完整率(header/Formula/discourse/audit) | ADR-0033 |
| profile artifact 迁移 orphaned 比例 | ADR-0019 / ADR-0020 |
