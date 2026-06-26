# ADR-0033 Core Schema / Book Profile / Reader Profile 解耦:technical_learning 作为当前书籍 profile

状态:已接受(2026-06-25,源自 `参考2.md` Grill:工具书 profile 与深路径能力合流)

## 背景
`参考2.md` 提出三条会改变后续架构的线:一是语篇功能不应压成单个 `discourse_role`;二是读者上下文会影响解释路径但不能改变书内事实;三是不同书类需要 profile,但 LID/citation/book.* 这类地基不能随书类分叉。

项目当前已经有稳定 Core: LID/span/LID tree、只读基座、`book.text/context/query`、memory 隔离、确定性图谱闸与读时 citation gate。若现在把所有 schema 直接改成泛化 profile envelope,会同时冲击 Pass1/Pass2、read-tools、runtime、前端和既有测试;但如果继续把工具书规则写成全局真理,后续接文学/历史/数学会返工。因此从本 ADR 起,系统按 Core + Book Profile + Reader Profile 三层设计,当前唯一落地 Book Profile 是 `technical_learning`。

## 决策
1. **Core Schema 固定为系统宪法**:Core 负责 LID、span、LID tree、citation gate、ReadOnlyBase 外壳、`book.text/context/query/synthesize`、`reader.*`、`memory.*`、错误信封和确定性闸。任何 profile 不得改变 LID 规则、citation 规则、`book.text` 语义或 memory 隔离规则。
2. **当前内置 Book Profile = `technical_learning`**:覆盖工具书、教材、技术书、数学、金融、科学、管理等说明型学习材料。`math` 是 `technical_learning` 的 domain extension,不是独立 profile;文学/历史等以后另开 profile。
3. **暂不迁移 `GraphNode` envelope**:现有 `entity/concept/claim` 和 `GraphEdge` 核心保持。`technical_learning` 新增能力先走 optional artifact / sidecar: `discourse_index`、`FormulaSemantics`、Pass2 audit、profile metadata。GraphNode typed envelope 以后单独开切片。
4. **`technical_learning` 负责书内深路径策略**:Pass1/Pass2 抽取策略、当前图谱 vocabulary、`discourse_index`、`FormulaSemantics`、long_range edge policy、retrieval policy hints、answer policy hints 归 profile 管;Core gate 仍决定 LID/节点/边端/evidence_lids 是否真实。
5. **Pass2 定名为 `technical_learning.pass2_longrange_v1`**:不再视作无 profile 的通用 linker。profile 决定抽取关系类型和输入材料;通过 Core gate 后可降成现有 `GraphEdge` 写入 base,`profile_id/evidence_lids/rationale` 先进入审计 sidecar。
6. **`book.synthesize` 是 Core 命令,执行受 profile policy 约束**:命令仍是 `book.synthesize(lids, task?)`;`technical_learning` 提供 synthesis policy(disourse 组织、FormulaSemantics、教学型 answer contract),`reader_profile` 提供表达策略。硬红线:`citations ⊆ input lids`,reader_profile 不作为 citation,超预算走确定性分批归并。
7. **Reader Profile 是 memory 层读时投影**:Book Profile 负责"书怎么结构化";Reader Profile 负责"对谁怎么讲"。`reader_profile` 不写入 ReadOnlyBase,不参与 citation,只影响检索计划、解释深度、类比方式、术语密度、前置知识补全和练习难度。
8. **memory consolidation 四层产物分离**:Layer 1 Session Digest、Layer 2 Reading Journey、Layer 3 Knowledge State / Reader Profile、Layer 4 Durable Notes / Highlights。只有 Layer 3 是 `reader_profile`;其他层只是 memory 产物或 evidence 来源。
9. **profile artifacts 从第一天带版本头**:`book_id/book_version/profile_id/profile_version/core_schema_version/generated_at` 是所有 `technical_learning` artifact 的固定头。增量构建时按 Core LID map 迁移;迁不了标 `orphaned`,不得静默删除。
10. **`reader.*` 属于 Core,profile 只定义使用策略**:`technical_learning` 可规定何时建议 goto/highlight/note/回看 prerequisite/展示公式语义/生成练习,但不定义新 reader 命令或特供通道。agent 动作仍遵守 ADR-0030:真执行、可撤销提议、默认 session 层、用户保留才升 long_term。
11. **ModelAdapter / ReActAdapter / provider 与 profile 正交**:Adapter 只把不同 provider 归一到 Message/ToolSpec/ToolCall/AssistantTurn。profile 影响 prompt fragments、extraction policy、answer policy、tool-use policy;工具执行和 citation gate 仍由 Runtime/Core 控制。

## 命门
- **LID 与 citation 是宪法**:profile 是解释语法,不是新地基。
- **当前就在解耦,但不大爆炸重写**:`technical_learning` 不是全局真理,只是第一个内置 profile。
- **读者上下文决定讲法,不决定事实**:同一本书同一组 LID 可以有不同解释路径,但 citation 只能来自 textual context。
- **sidecar 是过渡层,不是垃圾桶**:所有 profile artifact 必须有版本头、LID 证据和 orphaned 处理规则。

## 否决
- 一套 `entity/concept/claim/discourse_role` 打天下:会把工具书规则误升为全局 schema。
- 每类书完全独立 schema:会破坏统一检索、引用、命令面和评估。
- 现在立刻迁移 GraphNode envelope:切片过大,会阻塞 SA6 和深路径补齐。
- 把 reader_profile 写入 book base:污染只读基座,同一本书无法共享。
- 让 provider 自己声称工具调用成功:工具执行必须由 Runtime/Core 完成并校验。

## 何时回头
- `technical_learning` 的 sidecar 数量变多且迁移稳定后,启动 GraphNode typed envelope 迁移切片。
- 文学/历史 profile 开始设计时,抽取 policy 与 discourse vocabulary 另开 ADR,不得扩污染 `technical_learning`。
- Pass2 / synthesize / consolidation 实测显示 profile policy 需要进入 ReadOnlyBase 必填字段时,单独评估 schema 升级与迁移成本。

## 影响
- **新增阶段方案**:`docs/切片方案-profile深路径.md` 作为 ADR-0033 的执行计划。
- **2026-06-26 执行补记**:预构建层需补 PB0-PB4 独立切片,分别落地 profile metadata/header、FormulaSemantics sidecar、TechnicalLearningDiscourseIndex sidecar、Pass2 audit sidecar、profile sidecar build smoke;这些切片不改变 Core/Profile/Reader 边界,只是把本 ADR 已接受的 sidecar 规则从读时 fixture 补齐为正式构建产物。
- **承**:[[ADR-0010]](Pass2 长程边)/ [[ADR-0017]](`book.synthesize`)/ [[ADR-0018]](memory consolidation)/ [[ADR-0019]](增量构建)/ [[ADR-0020]](记忆迁移)/ [[ADR-0029]](FormulaSemantics)/ [[ADR-0030]](agent 阅读器形态)。
- **不改冻结命令面**:本 ADR 定边界和后续切片,不新增运行时代码接口。
