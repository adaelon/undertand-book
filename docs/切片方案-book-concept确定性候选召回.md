# 切片方案 - `book.concept` 确定性候选召回

> 定位:把按展示名称精确寻址的 `book.concept` 升级为全书确定性候选发现工具，让外层 Agent 在无 MCP 内置 LLM 的情况下找到用户不会准确复述名称的图谱节点。
> 冻结决策:[ADR-0097](adr/0097-book-concept-deterministic-candidate-recall.md)。
> 状态:BC0 文档冻结已完成；BC1-BC5 待实施。

## 0. 对齐确认单

| 项 | 冻结结论 |
|---|---|
| FrozenIntent | 增强 `book.concept` 的确定性名称发现；不改 Pass1、merge、`GraphNode` schema 或 `book.query` 行为 |
| 成功标准 | `harness` 等自然表达能返回相关 concept/entity 候选，其中包括仅由 occurrence 正文命中的描述性节点 |
| 兼容 | 精确展示名称仍可查，但 wire contract 升级为 `book_concept.v2` 候选集 |
| 选择权 | 外层 Agent 根据完整问题选择一个或多个候选；工具内部不调用 LLM |
| 风险回执 | 用户已确认“静默误选比明确失败更危险”，因此弱匹配只召回、不代替 Agent 选择 |
| ChangeType | `[边界重构]` |
| 非目标 | 不修改 `book.query` Provider/PlanGate/候选选择，不新增 node-id 查询入口，不引入 embedding/向量索引 |

已确认术语仍只维护在 `CONTEXT.md`；默认 12、上限 50、截断字段等属于本方案的接口策略，不写入术语表。

## 1. 当前基线与失败链

| 层 | 当前状态 | 本次问题 |
|---|---|---|
| `base-schema::GraphNode` | `id/type/name/occurrences/source_lid` | `name` 同时被误当展示标签和公开查询键 |
| Pass1/merge | 按模型生成的规范化 `id` 合并节点 | 不保证用户会说出 `name`，也不保证 `node_id` 跨重建稳定 |
| `read-tools::Book::concept` | `node.name == input`，返回单个 `Concept` | 描述性长名称几乎不可自然访问 |
| `ReferentCatalog` | 已有标签、近似与 occurrence 正文召回 | 当前服务 `book.query`，且把 `candidate_id` 加入搜索标签；不能原样暴露为 v2 |
| `book-tool-contracts` | `ConceptInput { name }`，结果合同 `book_concept.v1` | 与候选集语义不兼容 |
| MCP | 暴露 `book_concept`，执行无需 Provider | 能运行，但只能精确复述节点名 |

真实失败链:

```text
用户问“模型强了以后 harness 会怎样”
  -> 图谱节点名是“模型与脚手架的消长关系”
  -> book.concept(name) 做全等比较
  -> CONCEPT_NOT_FOUND
  -> 外部 Agent 无法发现该节点及 occurrence LID
```

`node_id` 的现有消费者是 merge、GraphEdge、Pass2、`book.context` 和 `book.query` 内部绑定。它在 v2 结果中只用于区分同名候选，不成为公开输入。

## 2. 目标边界与不变量

```text
调用方给定 query
  -> 全书 concept/entity 节点
  -> 标签确定性匹配
  -> occurrence 正文确定性弱匹配
  -> 严格分层排序 + 有界截断
  -> 外层 Agent 选择候选
  -> book.text 读取完整原文
```

| 不变量 | 约束 |
|---|---|
| 确定性 | 相同 book revision、输入和 anchor 必须得到相同顺序与匹配原因 |
| 全书召回 | `anchor_lid` 不过滤候选，只在同等词法质量时参与排序 |
| 类型边界 | 候选只来自 `GraphNodeType::{Concept, Entity}`；不返回 claim 或独立 paper-term |
| 强弱边界 | 标签完整 > 标签词元 > 标签近似 > occurrence 正文；弱信号不能累计越级 |
| 身份边界 | `node_id` 只作为返回身份；不得加入 v2 的可搜索字段 |
| 证据边界 | preview 解释“为何召回”；最终语义回答必须继续读取 `book.text` |
| occurrence | 每个已返回候选携带完整、去重、文档序 `occurrences` |
| 错误边界 | 零候选返回 `CONCEPT_NOT_FOUND`；不自动降级到 `book.search_text` |
| 查询边界 | v2 只对传入字符串做确定性召回；原始问题还是提炼表达由调用方策略决定 |
| 隔离边界 | 不改变 `book.query` 的输入、输出、Provider、PlanGate、probe 或失败语义 |

## 3. `book_concept.v2` 合同草图

### 3.1 输入

```rust
struct ConceptInput {
    query: String,
    anchor_lid: Option<String>,
    limit: Option<usize>,
}
```

- `query` 必填，trim 后非空，最多 4096 Unicode scalar values。
- `limit` 默认 12，合法范围 `1..=50`；不提供分页 cursor。
- `anchor_lid` 可选；给定时必须是真实 LID，只作同层排序参考。
- 不接受 `node_id`、`name` 或模式开关；v2 不保留 `{name}` 兼容分支。

### 3.2 输出

```rust
struct ConceptCandidateSet {
    version: "book_concept.v2",
    query: String,
    matched_count: usize,
    returned_count: usize,
    truncated: bool,
    candidates: Vec<ConceptCandidate>,
}

struct ConceptCandidate {
    node_id: String,
    kind: "concept" | "entity",
    name: String,
    occurrences: Vec<String>,
    match_tier: ConceptMatchTier,
    matched_terms: Vec<String>,
    match_reasons: Vec<String>,
    previews: Vec<ConceptPreview>,
}

enum ConceptMatchTier {
    ExactLabel,
    LabelToken,
    ApproximateLabel,
    OccurrenceText,
}

struct ConceptPreview {
    lid: String,
    text: String,
}
```

- `matched_count` 是截断前、排除无匹配节点后的全集数量。
- `returned_count == candidates.len()`；`truncated == matched_count > returned_count`。
- 每个候选最多两条、每条约 180 Unicode 字符的命中居中 preview。
- label 命中没有正文命中位置时，preview 按可选 anchor 距离、再按文档序选择代表 occurrence。
- preview 与 `book.search_text` 的可证明 occurrence 不同，不进入“字面完备”语义。

### 3.3 排序

```text
rank(candidate) = (
  match_tier DESC,
  query_term_coverage DESC,
  distinct_matched_terms DESC,
  anchor_distance ASC,   // 未提供 anchor 时全部相同
  node_id ASC
)
```

规则:

1. `node_id` 不参与匹配，只作最后稳定 tie-break。
2. occurrence 中同一词重复出现不提升 `match_tier`，也不能越过任何标签命中。
3. `None` 匹配必须在计算 `matched_count` 前排除，不能靠 top-K 填充进结果。
4. 展示名称完全相同的不同节点都保留；精确名称不强制收敛成单节点。
5. 首版复用现有确定性 lexical normalization/term extraction；不新增 LLM、embedding、编辑距离或同义词库。

### 3.4 失败

| 条件 | 结果 |
|---|---|
| query 空或超长 | validation error，不执行召回 |
| `anchor_lid` 不存在 | `LID_NOT_FOUND` |
| `limit` 越界 | validation error |
| 匹配节点为 0 | `CONCEPT_NOT_FOUND` |
| 匹配节点为 1..N | 成功候选集，不返回 ambiguity error |

错误 recovery 可以提示调用方改写 query 或显式选择其他工具，但服务端不得自动改写、自动选候选或自动调用 `book.search_text/query`。

## 4. 所有权与数据流

```text
book-tool-contracts
  ConceptInput + JsonSchema + validator + result_contract="book_concept.v2"
             |
             v
read-tools::Book::concept_candidates
  graph concept/entity + source text + deterministic rank/previews
             |
       +-----+------------------+
       |                        |
Runtime book.concept      Server REST/MCP aliases
       |                        |
       +----------+-------------+
                  v
        outer Agent selects candidate(s)
                  v
              book.text
```

| 模块 | 做 | 不做 |
|---|---|---|
| `book-tool-contracts` | v2 typed input、schema、validation、contract version | 图搜索、source I/O、Agent 选择 |
| `read-tools` | 候选全集、匹配、排序、preview、计数、错误 | transport、Provider、Prompt |
| `runtime` | Resident 投影、执行、工具使用说明 | 第二套 matcher、内部 LLM 选择 |
| `server` | REST/MCP 解码与同核派发 | 手写漂移 schema、自动 fallback |
| `book.query` | 保持现状 | 不消费 v2 wire result，不改变 resolver 行为 |

若为复用逻辑而抽取 matcher，必须让 `ReferentCatalog` 与 v2 调用同一纯函数，但 v2 的候选全集仍只取 graph concept/entity；任何共享重构都先由 BC1 characterization 锁住 `book.query`。

## 5. 切片依赖

```text
BC0 docs [本次完成]
  -> BC1 v1/query characterization
      -> BC2 read-tools candidate kernel
          -> BC3 v2 canonical contract + three-surface cutover
              -> BC4 Agent usage policy + parity/error regression
                  -> BC5 real-book replay + release gate
```

每个切片独立提交、保持 workspace 可编译；功能切片不得夹带无关重构。每刀完成时追加 `docs/代码链路.md`；只有真实模块边界或主数据流变化时才更新 `docs/架构.md`。

## 6. BC0 - ADR 与切片冻结 [Docs]（完成 2026-07-31）

**Do**:新增 ADR-0097 与本切片方案，记录 v2 边界、合同草图、失败语义、`book.query` 隔离和验证顺序。

**Do not**:不修改 `CONTEXT.md`、Rust、Cargo、生成类型、工具 schema、Prompt 或测试。

**Done**:全部已确认 Grill 决策可追溯；未确认的“原始问题还是提炼 query”明确留给调用方策略；ADR 与方案互链。

**Verify**:`git diff --check -- docs/adr/0097-book-concept-deterministic-candidate-recall.md docs/切片方案-book-concept确定性候选召回.md`。

## 7. BC1 - v1 与 `book.query` characterization [Tests]

**Do**:冻结当前 `Book::concept` 精确成功/失败、`ConceptInput {name}` 三表面 schema、`ReferentCatalog` 排序，以及 `book.query` PlanGate/probe/selected binding 的代表 fixture。

**Do not**:不改任何执行、排序、contract version、工具说明或响应结构。

**Done**:测试能分别识别 v2 的预期破坏性变更与 `book.query` 非预期回归；至少覆盖同名节点、anchor tie-break、context-only 候选和 MCP required 字段。

**Verify**:`cargo test -p read-tools concept_found_and_missing`;`cargo test -p runtime referent`;`cargo test -p server mcp_tool_characterization`。

## 8. BC2 - 确定性候选内核 [ReadTools]

**Do**:在 `read-tools` 增加 v2 内部候选 API；实现 graph-only 全书召回、严格 tier、全量 occurrences、有界 preview、计数/截断和零候选错误；必要时以行为不变方式抽取共享 matcher。

**Do not**:不切换公共 `book.concept`、registry、Runtime/REST/MCP，不改 `book.query`，不加入向量、LLM、持久索引或 node-id 查询。

**Done**:单测覆盖 exact/token/approximate/context、弱信号不越级、重复正文不刷分、同名保留、anchor 只同层排序、ID 不可查询、0/1/12/13/50/51 规模、preview 上限和完整 occurrences。

**Verify**:`cargo test -p read-tools concept_candidates_v2`;`cargo test -p read-tools referent_catalog`。

## 9. BC3 - v2 合同与三表面原子切换 [Contracts/Runtime/Server]

**Do**:把 canonical `ConceptInput`、schema 和 validator 升级到 v2；Resident `book.concept`、MCP `book_concept`、REST concept route 同时派发到候选内核；更新 result contract version 和相关生成/fixture。

**Do not**:不保留双形返回，不新增第二个 concept 工具，不扩大 MCP capability，不修改其他 Book 工具或 `book.query`。

**Done**:三表面 required/default/range/additionalProperties parity；精确名称在三表面都返回首位候选；旧 `{name}` 明确按 v2 validation 拒绝；零候选均投影 `CONCEPT_NOT_FOUND`。

**Verify**:`cargo test -p book-tool-contracts concept`;`cargo test -p runtime concept_tool`;`cargo test -p server book_concept`。

## 10. BC4 - Agent 使用策略与隔离回归 [Runtime/Server]

**Do**:更新 canonical tool description 与 Resident/MCP 使用提示：concept 用于候选发现，Agent 选择后必须调用 `book.text`；加入无 Provider MCP smoke、结果预算和 `book.query` 全量回归。

**Do not**:不让 MCP Server 创建 ModelAdapter，不自动调用 `book.query/search_text`，不把 preview 提升为最终来源证据，不改 query 输入策略。

**Done**:外部 MCP 在 Provider 未配置时仍可调用 concept v2；scripted Agent 能从多候选中选一项并读取 occurrence 原文；`book.query` characterization 零 diff。

**Verify**:`cargo test -p runtime concept_routing`;`cargo test -p server mcp`;`cargo test -p runtime query`；MCP stdio smoke。

## 11. BC5 - 真书回放与发布门 [Cross-cutting]

**Do**:用当前 `quantification-essence` 构建产物冻结 `harness` gold case，验证候选包含“模型与脚手架的消长关系”、排序原因、完整 occurrence 和后续 `book.text`；执行三表面 parity 与 workspace 回归。

**Do not**:不把真书候选数量写进 Prompt 或跨版本常量，不以 LLM 自评代替结构断言，不因 gold 失败放宽 tier 或静默 fallback。

**Done**:同一 source revision 下 Core/Resident/MCP 候选顺序与计数一致；无 Provider 可完成 concept→text；所有 query characterization 仍绿；文档链路已更新。

**Verify**:专用 real-book smoke；`cargo test --workspace`;`pnpm test`;`pnpm build`;`git diff --check`。

## 12. 测试矩阵

| 维度 | 必测 |
|---|---|
| 候选数 | 0/1/N、默认 12、显式 1/50、越界 0/51、显式截断字段 |
| 类型 | concept/entity 返回；claim/paper-term 排除 |
| 排序 | exact > token > approximate > occurrence；弱命中数量不能越级 |
| 身份 | 同名不同 ID 均保留；ID 本身不能触发直达或词法命中 |
| anchor | 不传时稳定；传入时只改变同层同质候选顺序；远处强命中不被隐藏 |
| occurrence | 完整去重、文档序；正文命中指向真实 LID；重复词不刷 tier |
| preview | 最多 2 条、约 180 字符、命中居中；不进入完整证据语义 |
| Unicode | 中英混合、大小写、标点、连续 CJK、emoji 不崩溃且顺序稳定 |
| 错误 | 空/超长 query、非法 limit、坏 anchor、零候选、无自动 fallback |
| surface | Resident/MCP/REST schema、默认值、结果和错误 parity |
| 隔离 | `book.query` Provider/PlanGate/probe/binding/错误 fixture 零变化 |
| 真书 | `harness` 召回描述性关系节点，并能沿 occurrence 调 `book.text` |

## 13. 发布与回滚

1. `book_concept.v2` 是显式破坏性 wire 升级；客户端必须刷新 `tools/list`，不得把新响应标成 v1。
2. 精确展示名称只保证语义仍可查，不保证旧响应字段兼容。
3. 无持久 schema、Pass1、merge 或 graph migration；回滚只需恢复 v1 contract/dispatch，不重建书。
4. 任一三表面 parity、`CONCEPT_NOT_FOUND`、候选预算或 `book.query` characterization 失败都阻断发布。
5. 真实召回质量不足时先增加客观 gold cases；未经新 Grill/ADR 不引入 LLM、embedding、向量库或公开 node-id 地址。
