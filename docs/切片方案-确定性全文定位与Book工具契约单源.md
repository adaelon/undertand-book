# 切片方案 - 确定性全文定位与 Book 工具契约单源

> 定位:为 Agent 增加可证明完备的正文 occurrence 定位,并让 Resident、REST、MCP 从同一 Book 工具契约生成 schema 与参数校验。
> 冻结决策:[ADR-0088](adr/0088-deterministic-text-occurrence-search-and-canonical-book-tool-contracts.md)。
> 状态:FT0-FT8 已完成（2026-07-21）。`search_text.v1` 已覆盖三表面、location-first 路由、窄 occurrence 证据、历史压缩、真书回放、性能门禁与全发布门禁。

## 0. 对齐确认单

| 项 | 冻结结论 |
|---|---|
| 用户目标 | 定位首次、上一个、最近或全部正文出现时,不再让 LLM 猜地址 |
| 新命令 | 逻辑 ID 为 `book.search_text`;成功结果代表指定 scope 内完整 lexical occurrence 集 |
| “全部” | 先计算全集和总数,再分页;`page_size` 只限制单页载荷 |
| 匹配单位 | 每个匹配 range 是一个 occurrence;同一 LID 内重复文本不合并 |
| 真相源 | `source.txt` 正文 + `base.json` 的 LID/span 叶子分区 |
| 语义边界 | lexical exhaustive 可保证;semantic exhaustive 不可由全文字符串保证 |
| 共享层 | 新增无 I/O 的 `book-tool-contracts` crate,作为 Book 命令契约 registry |
| 表面关系 | Resident/MCP/REST 名称可不同,logical ID、typed input、schema 与 validator 必须相同 |
| MCP 边界 | 仍只投影允许的只读/访客能力;不因共享 registry 暴露 reader、memory 或住户私有工具 |
| 本次范围 | 只落 ADR、术语、架构说明和实施切片 |

本方案兑现 [前端阅读器切片 §7.4](切片方案-切片1前端阅读器.md) 的回头条件:真书实测已经证明“只搜当前工作集”不足,因此可以扩一个确定性全文叶子工具。

## 1. 当前基线与失败链

| 表面 | 当前 schema 所在 | 当前执行 | 判断 |
|---|---|---|---|
| Resident Agent | `crates/runtime/src/orchestrator.rs::tool_specs()` 手写 | Runtime dispatch 到 `Book`/query/synthesize | schema 与执行靠人工同步 |
| MCP | `crates/server/src/mcp.rs::tools_list_result()` 手写 | 多数复用同一 `Book`/Runtime kernel | 名称合理不同,但 required/enum/description 已漂移 |
| REST | `crates/server/src/lib.rs::route_book()` 手写 query/body 解析 | 直接调用 `Book`/Runtime | 参数默认值和 validation 是第三份契约 |
| Core 读工具 | `read-tools::Book` | 确定性 | 没有全文 occurrence primitive |

这次真实失败不是模型不知道统计学,而是没有“寻址”原语:

```text
用户问“第一处/第六、七节哪里出现”
  -> Agent 把位置问题交给 book.query
  -> referent resolver 返回 ambiguous
  -> Agent 又把 graph candidate id 当 concept name
  -> concept not found,随后按章节猜读
  -> 多次无进展调用耗尽 turn/context
```

同一问题用规范原文的确定性字符串扫描能直接确认当前真书共有 32 个 exact `\sqrt{2\ln N}` occurrence、首个在 `1.10.3.10`,再用 `book.text/context` 才进入解释。这个差异是命令能力缺口,不是换模型或扩大 context 能稳定修复的问题。

## 2. 目标架构与所有权

```text
                       book-tool-contracts (no I/O)
                  typed input + JsonSchema + validator
                    logical id + aliases + capabilities
                         /          |           \
            Resident ToolSpec    REST binder    MCP tools/list
                         \          |           /
                          canonical BookToolRequest
                                      |
                    +-----------------+----------------+
                    |                                  |
        read-tools::Book.search_text          runtime query/synthesize
          deterministic source scan               LLM mini-loops
```

| 模块 | 拥有 | 不拥有 |
|---|---|---|
| `book-tool-contracts` | 逻辑工具 ID、输入 DTO、JSON Schema、validator、别名、capability、契约版本 | Book、文件 I/O、LLM、session |
| `read-tools` | source revision、叶子文档序、匹配、range 映射、分页投影数据 | transport 名称、Agent prompt、MCP session |
| `runtime` | Resident 工具投影、调用编排、证据账本、工具使用策略 | 第二份 schema、全文索引真相 |
| `server` | REST/MCP transport 解码、capability filter、HTTP/MCP 错误投影 | 手写共同工具 schema、搜索算法 |

物理上新增独立 crate,而不把 registry 放进 `runtime`,是为了避免 `read-tools -> runtime` 反向依赖;也不放进 `base-schema`,因为命令契约版本与持久书基座版本不是同一生命周期。

## 3. `search_text.v1` 逻辑契约

### 3.1 输入

```ts
interface SearchTextInput {
  query: string;
  match_mode?: "exact" | "normalized"; // default: exact
  scope?: {
    within_lid?: string;
    relative_to?: {
      lid: string;
      direction: "before" | "after";
    };
  };
  order?: "document" | "reverse_document"; // default: document
  cursor?: string;
  page_size?: number; // default: 20, range: 1..50
}
```

- `query` 必填,长度为 1..4096 Unicode scalar values;exact 下空字符串非法,normalized 后为空也非法。
- `within_lid` 可指 container 或 leaf;搜索范围是该节点 source span。
- `relative_to.before` 只保留完整结束于 anchor span 之前的匹配;`after` 只保留完整开始于 anchor span 之后的匹配。
- `within_lid` 与 `relative_to` 同时存在时取交集;合法空交集返回 `exhaustive=true,total_occurrences=0`,只有未知 LID 或结构非法才报错。
- `reverse_document` 仍使用规范文档序,只反转返回方向;“上一个”可用 before + reverse + `page_size=1` 投影。
- cursor 不替代其他字段;后续页必须重复同一 query/mode/scope/order,服务端验证其绑定。
- REST 固定编码为 `query/match_mode/within_lid/relative_lid/direction/order/cursor/page_size` query parameters;binder 只有在 `relative_lid+direction` 成对出现时才组装 canonical `scope.relative_to`。

### 3.2 输出

```ts
interface SearchTextResult {
  version: "search_text.v1";
  source_revision: string;
  exhaustive: true;
  total_occurrences: number;
  total_lids: number;
  occurrences: TextOccurrence[];
  section_counts: Array<{
    section_lid: string;
    label: string;
    count: number;
  }>;
  next_cursor?: string;
}

interface TextOccurrence {
  ordinal: number; // 全集正向文档序中的 1-based 序号
  start_lid: string;
  end_lid: string;
  source_range_utf16: { start: number; end: number };
  ranges: Array<{
    lid: string;
    start_utf16: number;
    end_utf16: number;
  }>;
  heading_path: Array<{ lid: string; title: string }>;
  excerpt: string;
  match_type: "exact" | "normalized";
}
```

- `source_range_utf16` 是规范 `source.txt` 的全局半开区间;`ranges` 是按叶子拆开的局部半开区间。
- 单叶命中仍返回一个 range;跨叶命中返回全部连续 ranges,不得把中间叶丢掉。
- `total_lids` 是全集中被 occurrence ranges 触达的不同叶 LID 数,不是 occurrence 数。
- `section_counts` 基于全集,按 occurrence 起点所在 book root 的一级结构单元归属,不受当前页影响,避免把每个细粒度小节都复制进响应。
- `excerpt` 只做固定字符窗与边界裁剪,不通过 graph/context 拼接语义邻文。
- 成功响应永远是 `exhaustive=true`;扫描中止、cursor 不合法或版本不一致一律返回 typed error,不返回“部分成功”。

### 3.3 occurrence 与顺序

1. 从 `base.lid_nodes` 取 `children.is_empty()` 的叶子,按 `span.start, span.end, path` 建规范阅读序。
2. 校验叶 span 有效且无重叠;叶间/首尾未覆盖区只允许 Unicode 空白。真实 Markdown 基座会把段间 CRLF 留在叶 span 外,因此不能要求叶 span 字节级连续;任何非空白 gap 仍使搜索 fail-closed。
3. 在 scope 的规范 source span 上扫描,每个合法起始 offset 都计一次,包括重叠匹配。
4. 把每个全局 match span 与叶子 span 求非空交集,形成一次且仅一次的 `TextOccurrence`;global range 保留叶间分隔空白,ranges 只表达可归属叶 LID 的部分。
5. 正向按 `source_range.start, source_range.end` 排序;绝不按 LID 字符串排序。
6. first/all/previous/nearest 都从该集合投影:nearest 分别取前向首个与反向首个后比较 source distance。

父 container 与子 leaf span 重叠不产生重复 occurrence;container 只定义 scope 与 heading path,匹配身份落在叶子 ranges。

### 3.4 匹配模式

| mode | 规则 | 明确不做 |
|---|---|---|
| `exact` | 对规范 UTF-16 source 序列逐单元匹配 | 大小写折叠、空白折叠、符号改写 |
| `normalized` | 固定版本的 Unicode NFKC + Unicode case fold + CRLF/LF 统一 + 连续空白折叠 | 模糊编辑距离、分词召回、同义词、LaTeX AST/MathML 等价 |

normalized 扫描必须保留“规范化 offset -> 原 UTF-16 offset”映射;返回 ranges 永远指向原文,不能返回规范化字符串的伪位置。不同 normalized 规则必须新增 match-mode/version,不得静默改 `normalized` 语义。

### 3.5 revision、cursor 与错误

`source_revision` 由规范 source bytes 与有序叶 `{lid,path,span}` 一起做 SHA-256;正文相同但 LID 分区变化也必须换 revision。

cursor 至少绑定:

```text
search_text.v1
source_revision
sha256(canonical JSON { query, match_mode, normalized scope, order })
next page boundary
```

错误集首版冻结为:

| error_code | 条件 |
|---|---|
| `SEARCH_QUERY_EMPTY` | query 为空或 normalized 后为空 |
| `SEARCH_QUERY_TOO_LONG` | query 超过 4096 Unicode scalar values |
| `SEARCH_SCOPE_INVALID` | LID 不存在、source span 非法、relative 组合不完整 |
| `SEARCH_CURSOR_INVALID` | cursor 无法解码或字段缺失 |
| `SEARCH_CURSOR_MISMATCH` | cursor 与本次 query/mode/scope/order 不同 |
| `SEARCH_CURSOR_STALE` | source revision 已变化 |
| `SEARCH_SOURCE_INVALID` | 叶分区或 source span 不满足不变式 |

不提供“出错后自动改用 `book.query`”的 recovery;调用方可修改显式参数后重试。

## 4. Canonical Book Tool Contract Registry

### 4.1 Registry 形状

```rust
struct BookToolContract {
    id: BookToolId,
    version: ContractVersion,
    execution: Deterministic | Llm,
    input_schema: RootSchema,
    result_contract: ResultContractRef,
    aliases: SurfaceAliases,
    capabilities: CapabilitySet,
    when_to_use: &'static str,
    when_not_to_use: &'static str,
}
```

- 输入 DTO 使用 `Deserialize + JsonSchema` 派生 required/enum/default,validator 只接 typed DTO。
- schema 带稳定 `$id`/contract version;改字段语义必须 bump version。
- `TOOL_NAMES`、Resident `ToolSpec` 和 MCP `tools/list` 都从 registry filter/project,不再维护并行清单。
- REST transport 可以把 query string/body 映射成 canonical DTO,但映射后必须走同一 validator。
- 结果继续由 `read-tools`/`runtime` 的 typed DTO 拥有;registry 引用其 contract/version,parity fixture 校验序列化形状,不复制输出 schema。
- 完整 Resident system prompt 不塞进 registry;registry 只共享工具级 use/not-use 片段。住户编排策略与外部 MCP 客户端策略不同是允许的。

### 4.2 Surface 投影

| Logical ID | Resident | MCP | REST | Capability |
|---|---|---|---|---|
| `book.manifest` | `book.manifest` | `book_manifest` | `GET /book/manifest` | readonly |
| `book.text` | `book.text` | `book_text` | `GET /book/text` | readonly |
| `book.search_text` | `book.search_text` | `book_search_text` | `GET /book/search_text` | readonly |
| `book.context` | `book.context` | `book_context` | `GET /book/context` | readonly |
| `book.concept` | `book.concept` | `book_concept` | `GET /book/concept` | readonly |
| `book.structure` | `book.structure` | `book_structure` | `GET /book/structure` | readonly |
| `book.guide_path` | `book.guide_path` | `book_guide_path` | `GET /book/guide_path` | readonly |
| `book.paper_metadata` | `book.paper_metadata` | `book_paper_metadata` | `GET /book/paper_metadata` | paper readonly |
| `book.paper_lexicon` | `book.paper_lexicon` | `book_paper_lexicon` | `GET /book/paper_lexicon` | paper readonly |
| `book.paper_reading_guide` | `book.paper_reading_guide` | `book_paper_reading_guide` | `GET /book/paper_reading_guide` | paper readonly |
| `book.query` | `book.query` | `book_query` | `POST /book/query` | readonly LLM |
| `book.synthesize` | `book.synthesize` | `book_synthesize` | `POST /book/synthesize` | readonly LLM |

`book_guide` 作为 MCP visitor-session 专属逻辑工具也登记在 registry,但没有 Resident/REST alias。`source.present`、`reader.*`、`memory.*` 不是 MCP 共同 Book 工具,不进入上述 parity 集。

### 4.3 防漂移门禁

1. 同一 logical ID 的 Resident `parameters` 与 MCP `inputSchema` 在去除 transport name 后结构相等。
2. required、additionalProperties、enum、min/max、default 与 description contract 不允许 projection override。
3. 每个 surface alias 唯一且能反查 logical ID;registry 中暴露的 alias 必须有 dispatch 分支。
4. canonical validator 的 valid/invalid fixture 在 Resident、MCP、REST 三入口得到同一接受/拒绝结果和 error code。
5. MCP capability snapshot 继续证明不存在 `reader.*`、`memory.*`、住户 profile 和裸 private route。
6. CI 禁止共同工具在 `orchestrator.rs`/`mcp.rs` 新增手写 JSON Schema;有协议例外必须在 registry 标记 transport override 和 ADR 链接。

## 5. Agent 使用策略

### 5.1 基本链路

```text
LOCATE  book.search_text
   -> TRIAGE  first/all/by section/near anchor
      -> VERIFY  book.text (语义解释需要时)
         -> EXPAND  book.context/concept (关系或别名需要时)
            -> REASON  book.query/synthesize
               -> DELIVER  source.present
```

| 用户问题 | 首选 | 后续 |
|---|---|---|
| “这句话/公式第一次在哪里” | exact search, `page_size=1` | location-only 可直接呈现 verified range |
| “全文所有出现” | exact/normalized search,遍历 cursor 到空 | 按 section_counts 分组;不得只读第一页后称全部 |
| “当前位置前一次/后一次” | relative scope + 正/反 order + `page_size=1` | 必要时 `reader.goto` |
| “这里讲这句话是什么意思” | search 定位后 `book.text/context` | synthesize 已选 LID |
| “这个概念所有讨论” | concept occurrences + alias lexical searches 的 union | 去重、文档序阅读、LLM 判相关;明确不保证 semantic exhaustive |
| 明确 referent 的定义/关系 | `book.query` | 不先做无目标全文扫 |

### 5.2 防无进展规则

- location obligation 不得先送 `book.query`;先 search。
- `book.query` 返回 ambiguous/unresolved 后,只有用户目标包含字面定位时才转 search,不得把 `candidate_id` 当 `book.concept(name)`。
- 同一 search request 的 cursor 页必须单调推进;重复 cursor 视为 no-progress 并停止。
- “全部”只有在 `next_cursor` 为空且所有页成功后才能交付;中途失败明确报告未完成。
- 首个 location gold replay 的 scripted adapter 总工具调用上限为 4:search -> optional text/context -> optional source.present。

### 5.3 证据账本

- search occurrence 的 source/ranges 由 Core 验证,可作为“该字面文本在这里出现”的证据。
- excerpt 不扩大证据范围;若回答原因、推导、章节作用或上下文,必须显式 `book.text` 重读相应范围。
- `source.present` 只接受 occurrence ranges 的连续子集和原样 quote;普通用户仍只见 opaque source ref,不见 LID。
- MCP 不使用住户证据账本,照既有协议返回真 LID/range 供外部 agent 自行验证。

## 6. 切片依赖

```text
FT0 docs [本次完成]
  -> FT1 contract characterization
      -> FT2 registry + Resident projection
          -> FT3 MCP/REST projection + parity

FT0
  -> FT4 exact occurrence engine
      -> FT5 normalized/scope/cursor projection

FT3 + FT5
  -> FT6 search_text three-surface exposure
      -> FT7 Resident routing + evidence ledger
          -> FT8 real-book replay + release gates
```

FT1-FT3 是行为契约重构,FT4-FT7 是新功能;两条线在 FT6 前不混片,便于归因回归。

## 7. FT0 - 决策与切片冻结 [Docs] (完成 2026-07-21)

**Do**:新增 ADR-0088、术语、总体架构链路、本方案、真实失败 gold case 与 surface ownership。

**Do not**:不修改 Rust、Cargo、MCP manifest、Resident prompt、REST、生成类型或测试。

**Done**:lexical/semantic exhaustive、occurrence/range、cursor、registry/capability 边界均可追溯;链接和 `git diff --check` 通过。

## 8. FT1 - 共同工具契约 characterization [Tests]

**实施状态**:已完成。Resident 当前不暴露 `book.manifest`;MCP 独有 `book_manifest` 与 `book_guide`。已冻结 MCP 四类 missing-required 漂移和 `context.granularity` missing-enum 漂移,供 FT2/FT3 显式消除。

**Do**:为现有共同 Book 工具冻结 logical ID、valid/invalid request、required/enum/default/additionalProperties、surface alias 与结果形状 fixture;产出当前 drift matrix。

**Do not**:不修改任何表面 schema 或 dispatch,不顺手新增 search。

**Done**:至少覆盖 text/context/concept/query/synthesize 与 paper 枚举工具;测试能明确显示“协议命名差异”与“非法 schema 漂移”的区别。

**Verify**:`cargo test -p runtime book_tool_characterization`;`cargo test -p server mcp_tool_characterization`。

## 9. FT2 - Registry 与 Resident 投影 [Contracts/Runtime]

**实施状态**:已完成。`book-tool-contracts` 已拥有 logical ID、typed input、canonical schema/validator、surface alias/capability 和 result contract version;Resident `ToolSpec` 与共同 Book dispatch 已按 registry 投影,查询 DTO 从新 crate 重新导出保持公共名称兼容。

**Do**:新增 `book-tool-contracts` crate;迁移 typed input/schema/validator;由 registry 生成共同 Book 工具 Resident `ToolSpec` 与 name-to-id dispatch。

**Do not**:不改工具执行语义、结果 DTO、Resident tool-use prompt,不迁移 MCP/REST,不加入 search。

**Done**:Resident characterization 零非预期 diff;手写共同 Book input schema 从 `orchestrator.rs` 消失;logical ID/alias 冲突在构建测试中失败。

**Verify**:`cargo test -p book-tool-contracts`;`cargo test -p runtime book_tool_contract`。

## 10. FT3 - MCP/REST 投影与 parity [Server]

**实施状态**:已完成。MCP 12 项名称/schema/typed dispatch 由 capability-filtered registry 投影;REST query string 映射到 canonical DTO,历史 `text?end=` 映射为 `end_lid`;POST synthesize 使用同一 validator。Resident/MCP schema parity 与 REST/MCP valid/invalid fixture 已锁定。

**Do**:MCP `tools/list`、`TOOL_NAMES`/dispatch 与 REST binder 从 registry 投影;把 REST transport 参数映射到 canonical DTO;按 typed validator 收紧现有 MCP 缺失 required/enum。

**Do not**:不扩大 MCP capability,不向 MCP 暴露 reader/memory/private route,不改 search。

**Done**:所有共享 logical ID schema parity;三入口 fixture 接受/拒绝一致;MCP readonly/session snapshot 不变;旧 REST URL 与成功响应兼容。

**Verify**:`cargo test -p server book_tool_contract`;`cargo test -p server mcp`;`cargo test -p server route_book`。

## 11. FT4 - Exact occurrence engine [ReadTools]

**实施状态**:已完成。`Book::search_text_exact` 扫描完整 UTF-16 source,以有序叶 span 非空交集生成一次 occurrence;支持重叠、跨叶和空白 gap,并计算 source revision、total LIDs、section counts、heading path 与固定窗 excerpt。非空白 gap、叶重叠、越界或 surrogate 断点 fail closed。

**Do**:建立 source revision、规范叶序与一次匹配一次 occurrence 映射;实现 exact 全范围扫描、跨叶 ranges、重叠匹配、总数与 section aggregation 的内部 API。

**Do not**:不做 normalized、cursor、transport、Agent prompt、持久索引或 graph 搜索。

**Done**:同叶重复、父子重叠、`1.9/1.10` 顺序、跨叶、scope 边界、无结果、中文/emoji UTF-16、非法 partition 全有单元测试;成功只在全扫描完成后返回。

**Verify**:`cargo test -p read-tools search_text_exact`。

## 12. FT5 - Normalized、scope 与稳定分页 [ReadTools/Contracts]

**实施状态**:已完成。`SearchTextInput/SearchTextResult`、closed schema 与约束 validator 已冻结;ReadTools 以两遍扫描先聚合完整 totals/section counts、再只物化当前页,实现 within/relative 交集、正反展示顺序和 query/source-bound cursor,额外内存不随 occurrence 总数线性保存全部结果。normalized 使用带原文 provenance 的 NFKC + full non-Turkic case-fold + CRLF/Unicode whitespace 归一化;语义常量显式锁定 `unicode-normalization 0.1.25 / Unicode 17.0.0` 与 `unicode-casefold 0.2.0 / Unicode 9.0.0`,升级必须换版本常量。

**Do**:实现版本化 normalized offset map、within/relative/order、`page_size 1..50`、query-bound cursor、stale/mismatch errors 与 v1 request/result DTO。

**Do not**:不做 regex、fuzzy、同义词、公式 AST、向量索引或未知总数流式接口。

**Done**:所有页拼接严格等于未分页全集且无重无漏;正反 order ordinal 稳定;source/LID 分区变化使旧 cursor stale;normalized ranges 可逐字回读原文。

**Verify**:`cargo test -p read-tools search_text_pagination`;`cargo test -p book-tool-contracts search_text_contract`。

## 13. FT6 - 三表面暴露 [Runtime/Server]

**实施状态**:已完成。registry 新增 `BookToolId::SearchText` 与唯一 typed input/schema/validator;Resident `book.search_text`、MCP `book_search_text`、REST `GET /book/search_text` 均调用 `Book::search_text`。REST 只在 `relative_lid+direction` 成对时组装嵌套 scope;MCP 调用保持 Tier 1 零 visitor session。真书 stdio smoke 已验证 tools/list 与 tools/call。

**Do**:在 registry 增加 `book.search_text`;投影 Resident `book.search_text`、MCP `book_search_text`、REST `GET /book/search_text`;三者调用同一 `Book::search_text`。

**Do not**:不复制 schema/validator,不自动回退 query/concept,不改变其他工具 exposure。

**Done**:相同 canonical input 在三表面得到同一 totals/ordinals/ranges/error;MCP 调用保持 Tier 1 无 session;REST 嵌套 scope transport roundtrip 无损。

**Verify**:`cargo test -p runtime search_text_tool`;`cargo test -p server search_text`;MCP stdio smoke。

## 14. FT7 - Resident 定位路由与来源证据 [Runtime]

**实施状态**:已完成。Resident prompt 明确区分字面定位与语义问答,first/previous/next/all 使用 search,语义解释必须再读 text/context。当前回合账本以 `SourceText/LiteralOccurrence` 区分证据能力,search range 只支持出现位置;重复同 request/cursor 返回 `AGENT_NO_PROGRESS`。历史 provider projection 仅保留 search 定位参数与 opaque digest,不保留 occurrence/excerpt body。

**Do**:加入 location-first tool-use policy;把 verified occurrence ranges 以窄 claim 类型接入本轮 evidence ledger;允许 location-only `source.present`,语义回答强制 text/context。

**Do not**:不把全部 search excerpts 注入长期历史,不让 search ranges自动变成来源按钮,不声称 semantic exhaustive。

**Done**:位置问题不再先调 query;同一 ambiguous query 不循环;“全部”会消费到空 cursor;历史 typed receipt 只保留 request 定位摘要与 opaque digest,不保留所有 excerpt。

**Verify**:`cargo test -p runtime search_text_routing`;`cargo test -p runtime source_presentation`。

## 15. FT8 - 真书回放与发布门禁 [Cross-cutting]

**实施状态**:已完成。当前 `quantification-essence` source snapshot 的 exact `\sqrt{2\ln N}` 回放共 32 个 occurrence,首个为 `1.10.3.10`,`page_size=7` 的五页并集严格等于内部全集。Resident scripted 回放在四次工具调用内覆盖第一处、全部和“第六、七节如何关联”的 search -> text -> context 分层;MCP 五页结果逐页等于 Core。DeepSeek-v4-pro 真跑只调用一次 `book.search_text`,未进入 `book.query` ambiguous loop。5 MiB release fixture 七次扫描 p95 为 671.3731 ms,公开分页路径不保存完整 occurrence Vec。

**Do**:冻结 `quantification-essence` 失败回放,验证 exact `\sqrt{2\ln N}` 共 32 个、首个 occurrence 为 `1.10.3.10`、分页并集等于当前 source snapshot 全集;覆盖“第一处”“所有出现”“第六、七节如何关联”的分层流程。

**Do not**:不把真书绝对总数写进 prompt,不以 DeepSeek 自评替代结构断言,不因 E2E 偶发失败放宽 schema 或 exhaustive 语义。

**Done**:scripted adapter 在 4 次以内完成 location case;DeepSeek-v4-pro 实跑不再触发 ambiguous query loop;MCP 与 Resident 首个/全部结果相同;5 MiB fixture release build 全扫描 p95 小于 1 秒且峰值额外内存不随 total occurrence 线性保存全部结果。

**Verify**:专用 real-book smoke;`cargo test --workspace`;`pnpm test`;`pnpm build`。

## 16. 测试矩阵

| 维度 | 必测 |
|---|---|
| occurrence | 0/1/N 命中、同 LID 多次、重叠、跨叶、query 长于 scope |
| Unicode | 中文、组合字符、全角、emoji surrogate pair、CRLF/LF、normalized 回映射 |
| 结构 | container scope、leaf scope、父子 span、数值 LID 文档序、非法 partition |
| 相对定位 | before/after、正反 order、anchor 边界上不半吞匹配、nearest 双向比较 |
| 分页 | 1/20/50、空末页、全页 union、cursor mismatch/stale/tamper |
| 完备性 | totals/section counts 不受页大小影响;中途错误无 `exhaustive=true` |
| schema | required/enum/default/additionalProperties、alias、dispatch、contract version |
| surface | Resident/MCP/REST 同输入同结果;MCP Tier 1 不建 visitor session |
| evidence | location claim 可引用;语义 claim 未 text/context 时拒绝扩大证据 |
| Agent | first/all/previous/semantic-all 分流;ambiguous query 不循环 |

## 17. 发布与兼容

1. FT3 先发布 registry parity,FT6 才发布新工具;不能让 search 成为第三份临时 schema。
2. 现有工具名、REST URL 与结果保持;MCP required/enum 收紧是显式 contract correction,随 `book_tool_contract.v1` 记录。
3. 无新持久 artifact、数据库或迁移;MVP 每次从内存规范 source 扫描。
4. cursor 只保证同一 source revision 与 contract version 内稳定,不跨重建兼容。
5. 尚未部署 FT6 的 MCP server 不暴露 `book_search_text`,既有工具仍可用;任何版本的服务端都不得伪装 search 已执行。
6. schema parity、capability filter、真书全集和 no-progress gold 任一失败都阻断发布。

## 18. 本轮交付边界

FT0-FT8 已全部交付。`book.search_text`、`book_search_text` 与 `GET /book/search_text` 从同一 registry schema/validator 和同一 `Book::search_text` 内核投影;Resident 已采用 location-first 路由和窄 occurrence 证据。发布断言只绑定当前 source revision:32 个 occurrence 与首个 `1.10.3.10` 是真书回放 gold,不得写入 prompt 或冒充跨版本常量。
