# 需求驱动产物 Blueprint 与 Agent 访问切片方案

状态:方案冻结;AA0-AA11 已完成。

冻结决策:[ADR-0094](adr/0094-codex-designed-artifact-blueprints-and-versioned-registry.md)、[ADR-0095](adr/0095-active-artifact-read-surface-and-book-mcp-boundary.md)。承接边界:[ADR-0093](adr/0093-intent-confirmed-progressive-prebuild-and-reader-private-goal-artifacts.md)、[ADR-0091](adr/0091-model-aware-agent-request-tool-exposure-and-active-context-budget.md)、[ADR-0089](adr/0089-plugin-provided-current-book-mcp-and-setup-sidecar.md)、[ADR-0004](adr/0004-引用红线分层.md)。

## 0. 对齐确认单

**FrozenIntent**:Codex 根据已确认目标选择、复用或设计 0..N 个数据型 `ArtifactBlueprint`,用户在 BuildPlan 中一次确认名称、用途、形态、关键字段与成本,Runtime 以受限 schema、LID evidence、规模和 digest 确定性验收。Resident Agent 在回合开始只获得 current active + accepted Routing Cards,相关时自动使用通用 list/search/read;所有绑定该书的本地 Book MCP 静态暴露同一只读合同。产物只缩小检索空间与组织推理,书中事实仍须回到 canonical Book evidence。首版不开放自定义代码/渲染器、向量搜索、Intent/Plan/candidate/历史 overlay,也不处理 Handoff 中独立的 mixed assistant content + tool call 缺陷。

**TermMap**:

| 术语 | 状态 | 冻结定义 |
|---|---|---|
| BuildIntent / BuildPlan | BOUNDARY_CHANGE | 目标不再强制映射四类;Plan 冻结完整 Blueprint 与 digest |
| ArtifactBlueprint | NEW | 数据形态、受限 schema、证据、搜索、摘要、路由与规模的元合同 |
| ArtifactBlueprint Registry | NEW | 系统预设 + 用户私有候选,优先复用但不强套 |
| ArtifactRoutingCard | NEW | 只用于工具路由的语义卡,不是证据 |
| ArtifactAccessSnapshot | NEW | Resident 回合冻结、MCP 调用时解析的 active + accepted 只读视图 |
| 目标产物层 | BOUNDARY_CHANGE | 物理私有;Resident 与 Book MCP 可读 current active + accepted |
| 工具暴露计划 | EXISTING | Resident direct/deferred/hidden 继续由 ADR-0091 管理 |
| Book MCP Sidecar | BOUNDARY_CHANGE | 增加静态 artifact list/search/read,其余私人状态仍不可见 |

**RiskReceipt**:用户在 Codex task `019fac59-f620-7233-8332-03df320ca875` 于 2026-07-29 逐项接受以下风险:动态 schema 可能形成类型动物园;Routing Card 会泄露有限目标语义;所有本地 Book MCP 可据产物推断当前目标。控制措施为受限 DSL、两层 Registry、plan/blueprint digest、active + accepted 门禁、无 raw goal/Plan 暴露和同书同用户绑定。

**ChangeType**:`[边界重构]`。

领域对齐完成;TermMap 零未解析符号。

## 1. 合同草图

```ts
type ArtifactShape =
  | collection
  | table
  | graph
  | sequence
  | document;

interface ArtifactBlueprintV1 {
  version: artifact_blueprint.v1;
  blueprint_id: string;
  blueprint_version: string;
  origin: system | user_private | one_off;
  title: string;
  purpose: string;
  shape: ArtifactShape;
  record_schema: RestrictedSchemaV1;
  relation_schema?: RestrictedSchemaV1;
  routing: {
    use_when: string[];
    avoid_when: string[];
    covered_topics: string[];
    scope_label: string;
  };
  search_fields: Array<{
    path: string;              // JSON Pointer
    weight: number;           // 1..10
    analyzer: text | keyword;
  }>;
  summary_fields: string[];
  evidence_policy: {
    required_per_record: true;
    anchor: lid;
  };
  limits: {
    max_records: number;
    max_relations: number;
    max_text_chars: number;
  };
}

interface ArtifactInstanceV2 {
  version: artifact_instance.v2;
  blueprint_digest: string;
  records: Array<{
    record_id: string;
    data: Record<string, unknown>;
    evidence_lids: string[];
  }>;
  relations?: Array<{
    relation_id: string;
    source: string;
    target: string;
    data: Record<string, unknown>;
    evidence_lids: string[];
  }>;
}

interface BuildPlanPrivateArtifactV2 {
  artifact_id: string;
  source_scope: BuildSourceScope;
  blueprint: ArtifactBlueprintV1; // 确认时冻结完整 snapshot
  blueprint_digest: string;
  required_public_capabilities: string[];
}

interface AcceptedIntentArtifactV2 {
  version: intent_artifact_accepted.v2;
  task_id: string;
  book_id: string;
  source_fingerprint: string;
  intent_id: string;
  intent_digest: string;
  plan_id: string;
  plan_digest: string;
  artifact_id: string;
  blueprint_digest: string;
  payload: ArtifactInstanceV2;
  payload_digest: string;
  accepted_at: string;
}
```

`RestrictedSchemaV1` 只允许有界 object/array、string/number/boolean/null、required、enum 和长度/数值上限;禁止 `$ref`、递归、任意正则执行、远程 schema、函数和渲染代码。BuildPlan 的每个 private artifact 保存完整 Blueprint snapshot、`blueprint_digest`、scope 与 public dependency closure;因此 Registry 后续变化不能改变已确认计划。

新建 `origin=one_off` 规划候选时,自由文本 string 的 `search_fields` 必须使用 `text`;
`keyword` 只允许表达 enum 等有界精确类别。该规划门不追溯收紧既有 Plan/accepted Blueprint
快照,旧 digest 继续只读兼容;重新规划时才按新规则拒绝误配。

该边界必须通过新版本落地:`BuildIntentV2` 不再保存固定 `desired_artifacts` 枚举,`BuildPlanV2.private_artifacts[]` 改存 `BuildPlanPrivateArtifactV2`。不得原地改变 V1 canonical JSON 或 digest 语义;既有 V1 Intent/Plan 继续按四个内置 Blueprint 适配读取和执行,新 draft 只写 V2。

```ts
interface ArtifactRoutingCardV1 {
  artifact_ref: string;        // opaque
  overlay_revision: string;
  title: string;
  purpose: string;
  use_when: string[];
  avoid_when: string[];
  covered_topics: string[];
  scope_label: string;
  searchable_fields: string[];
  record_count: number;        // 从 accepted instance 确定性派生
}
```

## 2. 工具合同

```ts
artifact.list({
  limit?: number;
  cursor?: string;
}) -> {
  overlay_revision: string;
  artifacts: ArtifactRoutingCardV1[];
  next_cursor?: string;
}

artifact.search({
  query: string;
  artifact_refs?: string[];
  anchor_lids?: string[];
  limit?: number;              // 默认/最大 3
  cursor?: string;
}) -> {
  overlay_revision: string;
  hits: Array<{
    artifact_ref: string;
    record_ref: string;        // opaque + stable for unchanged payload
    data: object;              // 完整记录或 summary_fields
    evidence_lids: string[];
    matched_fields: string[];
    matched_terms: string[];
    score: number;
    truncated: boolean;
  }>;
  next_cursor?: string;
}

artifact.read({
  artifact_ref: string;
  record_refs?: string[];      // 与 cursor 二选一
  cursor?: string;
  field_paths?: string[];
  include_relations?: boolean;
  limit?: number;              // 最大 3
}) -> {
  overlay_revision: string;
  records: object[];
  relations?: object[];
  next_cursor?: string;
}
```

Resident aliases 为 `artifact.list`、`artifact.search`、`artifact.read`;MCP aliases 为 `artifact_list`、`artifact_search`、`artifact_read`。三者共用同一 schema、validator、snapshot reader、排序、分页、结果预算和错误码。

搜索只索引 Routing Card 与 Blueprint `search_fields`;不索引 raw goal、Intent、Plan、task path、digest、内部 ID 和 `evidence_lids` 字符串。排序管线固定为:

```text
Unicode/大小写/空白规范化
  -> 完整短语
  -> 规范化子串
  -> 中文二/三元片段 + 英文词项
  -> 字段权重 + 查询词覆盖率 + 可选 anchor 范围奖励
  -> 正常零命中时才做有限拼写容错
```

默认 search 返回排名最高的 1..3 条完整记录;模型可见总正文不超过约 12 KiB。单条超限时只返回 `summary_fields` 并置 `truncated=true`;不自动附带书源原文。

## 3. 产品与安全不变量

| 不变量 | 确定性验收 |
|---|---|
| Blueprint 受控 | 未知 DSL 节点、递归、代码、远程 ref、超限 schema 全部拒绝 |
| 一次确认 | `plan_digest` 包含 canonical `blueprint_digest`;确认后任一字节漂移进入 `needs_user` |
| 生成者不当裁判 | Codex 只产 Blueprint/instance candidate;Runtime gate 决定 accepted |
| 逐记录证据 | 每个 record/relation 至少一个 current、scope 内真实 LID |
| 只读 current overlay | replan/source stale/delete 后旧 snapshot 不可新建;Resident 已开始回合不跨 revision |
| 私有正文不外溢 | list/search/read 不返回 raw goal、Intent、Plan、candidate、failure、path 或历史 overlay |
| 产物不是书源 | artifact ToolResult 不进入 turn evidence ledger;只有后续 Book evidence 可 source.present |
| Resident 有界 | 无 overlay 时工具 Hidden;有 overlay 时最多一次初始 search,零命中不循环改写碰运气 |
| MCP 静态能力 | tools/list 始终有三工具;无 overlay 返回明确 unavailable,不是空成功 |
| 兼容旧产物 | accepted v1 不原地改写;固定四类通过内置 Blueprint adapter 读取 |

## 4. 切片

### AA0 - 术语与决策落档

状态:完成,2026-07-29。

**输入/输出**:输入为已确认会话与当前 ADR/代码事实;输出为更新后的术语表、ADR-0094/0095 和本方案。
**做**:更新 `CONTEXT.md`,新增 ADR-0094/0095 与本切片方案。
**不做**:不修改合同、运行代码、测试或现有 Note-placement 未提交工作。
**完成判据**:链接存在、术语零冲突、`git diff --check` 通过。

### AA1 - Blueprint DSL 与系统预设 Registry

状态:完成,2026-07-29。

依赖:AA0。

**输入/输出**:输入为冻结的 Blueprint 边界与现有四类 schema;输出为可独立验证的 DSL、digest 和系统 preset Registry。
**做**:新增 `ArtifactBlueprintV1`、受限 schema validator、canonical digest 和系统 Registry;把四类现有产物表达为 v1 系统 Blueprint。
**不做**:不改 Planner、BuildPlan、accepted 文件或 Reader;不持久化用户候选。
**触达**:`packages/core/src/artifact-blueprint.ts`、`packages/core/test/artifact-blueprint.test.ts`、内置 preset fixtures。
**Red**:递归/ref/code/超限 schema 可通过;相同语义因 key 顺序得到不同 digest;四类 preset 无法表达当前 payload。
**Green**:DSL fail closed;canonical digest 稳定;四类 preset 的旧 payload golden 均可映射。
**验证**:`pnpm -C packages/core test -- artifact-blueprint`;`pnpm -C packages/core typecheck`。

### AA2 - 用户私有 Blueprint Registry

状态:完成,2026-07-29。

依赖:AA1。

**输入/输出**:输入为 AA1 的已验证 Blueprint;输出为不含书内容的用户私有 candidate Registry 与生命周期命令。
**做**:实现用户级、schema-only、版本化 candidate store,支持 list/get/upsert/retire 与使用计数;系统 preset 优先,无匹配允许 one-off。
**不做**:不保存书中内容、raw goal、artifact instance;不自动晋升系统模板;不做跨账户同步。
**触达**:`packages/core/src/artifact-blueprint-registry.ts`、`skills/build/intent-blueprint.ts`、`skills/build/sidecar-entry.ts`、Core/packaged-sidecar contract tests。
**Red**:候选夹带书文/goal;同 identity 同版本不同 digest 被覆盖;symlink/越界路径写入。
**Green**:create-only version、冲突 fail closed、retire 不破坏已确认 Plan、Registry 为空仍可 one-off。
**验证**:Core registry tests;packaged Node/Bun parity;private path/symlink/redaction scan。

**结果**:`artifact-blueprint-registry.ts` 以不可变 candidate + 独立 retirement/usage 事件落盘,`intent.blueprint` 通过 stdin-only canonical JSON 暴露 list/get/upsert/retire/record_use/resolve;系统 preset 先于私有与 one-off 解析。AA1+AA2 定向 8/8、Core typecheck、编译 sidecar Node/Bun parity 与 redaction smoke 通过;Core 全量 525/526,唯一 100-task 压力用例固定 5 秒 timeout,该文件单独复跑 4/4 全绿。

### AA3 - Planner、BuildPlan 与一次确认

状态:完成,2026-07-29。

依赖:AA1、AA2。

**输入/输出**:输入为已确认 BuildIntent 与两层 Registry 摘要;输出为包含完整 Blueprint snapshot/digest 的可确认 BuildPlan。
**做**:让 Codex Planner 返回 0..N 个 Blueprint 选择/草案;确定性 compiler 验证后生成 `BuildIntentV2/BuildPlanV2`,把完整 snapshot + digest 写入 Plan;Reader/Codex 摘要展示名称、用途、形态、关键字段、复用来源与成本;V1 Plan 通过四个内置 preset 适配。
**不做**:不执行产物、不增加第二次确认、不把 raw schema 塞给普通用户、不改变 public stage closure 规则、不重算 V1 digest。
**触达**:`crates/runtime/src/build_intent.rs`、`crates/server/src/build_intent_api.rs`、`packages/core/src/build-intent.ts`、`packages/core/src/build-capability.ts`、`packages/core/src/build-intent-controller.ts`、`skills/build/intent-plan.ts`、`packages/web/src/components/BuildIntentPane.vue` 及对应测试。
**Red**:未知 Blueprint/漂移 digest 可确认;goal_directed 强制非空四类;Plan 确认后 Registry 更新改变执行合同;同一 V1 文件在新代码下 digest 改变。
**Green**:0..N 合法;新 draft 只写 V2;Plan 持有不可变 snapshot;旧确认在 Blueprint 漂移时失效;V1 digest/golden 不变且可按内置 preset 继续读取和执行;一次确认同时绑定预算与 Blueprint。
**验证**:`cargo test -p runtime build_intent`;Core build-intent tests;Server contract tests;Web plan summary tests。

**结果**:`BuildIntentV2/BuildPlanV2` 已独立版本化,goal-directed Planner 可从系统/用户私有 Registry 摘要选择 0..N 个 Blueprint 或返回 one-off 草案;Server 起草时解析并冻结完整 snapshot,确认前按当前 Registry 重验,漂移稳定返回 `needs_user`;Reader/Codex 仅投影名称、用途、形态、关键字段、来源和成本上限。V1 golden 原字节/原 digest 回归保持不变。Core 定向 49/49、Runtime 5/5、Server AA3 定向 5/5、Web 8/8 及两端 typecheck 全绿。

### AA4 - 通用 ArtifactInstance v2、gate 与 v1 适配

状态:完成,2026-07-29。

依赖:AA1、AA3。

**输入/输出**:输入为 confirmed Plan、Blueprint 和模型 candidate;输出为通过 gate 的 accepted v2 或私有 failure,另提供 v1 只读投影。
**做**:以 Blueprint 驱动 task/candidate/accepted v2;逐 record/relation 校验 schema、ID、端点、证据、scope、规模和所有 digest;为 accepted v1 建只读适配器。
**不做**:不原地迁移历史文件、不开放工具、不改 Reader 展示;不保留新旧双生成器。
**触达**:`packages/core/src/intent-artifact.ts`、`packages/core/src/intent-artifact-mailbox.ts`、`skills/build/intent-artifact.ts`、`crates/server/src/intent_build_store.rs`、v1/v2 fixtures。
**Red**:伪 LID、跨 scope、悬空 relation、旧 Blueprint candidate、超限 payload 可 accepted;v1 digest 被重写。
**Green**:新生成只写 v2;v1 通过 preset adapter 等价读取;任一 gate 失败只留下私有 failure。
**验证**:Core intent-artifact/mailbox tests;Server active-overlay tests;真实四类 v1 fixture parity。

**结果**:`intent_artifact_task_envelope.v2` 对 V2 Plan 直接冻结 Blueprint snapshot/digest,对 V1 Plan 只使用四个固定系统 preset 适配;所有新 candidate/accepted 统一写 `ArtifactInstanceV2`。Core gate 会从 current Intent/Plan 重新编译 task,再校验 candidate identity、受限 record/relation schema、唯一 ID、relation 端点、current + scope 内逐条 LID evidence、record/relation/text 上限及 intent/plan/blueprint/payload digest。旧 accepted v1 先验证原 payload digest,再只读投影为稳定 v2 instance,不改写历史文件;V2 Plan 不接受 v1 body。Rust active-overlay 每次从磁盘重读并复算 intent、plan、Blueprint 与 payload canonical digest,`serde_json/arbitrary_precision` 保持与 Core 数字 canonical bytes 一致。Core AA4 3 文件 16/16、Server 全量 215/215（另 `book_mcp` 5/5）通过。

### AA5 - Runtime 回合资源端口重构

状态:完成,2026-07-29。

依赖:AA0。

**输入/输出**:输入为现有 Resident run API 与 characterization fixtures;输出为行为不变、可注入只读回合资源的 Runtime 端口。
**做**:把 Resident 每回合的外部只读能力收进 `ResidentTurnResources`/trait port,为后续 `ArtifactToolSession` 留入口;保持现有 28 工具行为不变。
**不做**:不注册 artifact 工具、不改 direct 排序、不读 private store、不改 Provider 线协议。
**触达**:`crates/runtime/src/orchestrator.rs`、调用方与 characterization tests。
**Red**:现有 Agent fixture 的请求、工具列表、effects、来源或历史投影变化。
**Green**:默认空资源时 byte/semantic parity;所有现有 Runtime/Server agent tests 仍绿。
**验证**:`cargo test -p runtime` 与 Server agent 定向回归。此片是纯重构,必须独立提交。

**结果**:`ResidentTurnResources` 通过 `ResidentTurnResourcePort` 冻结 context fragments、初始 evidence 与 profile memory updates,Runtime 核心 loop 只依赖只读端口,旧 context-fragment wrappers 仍委托同一路径;Server 主调用方已改为一次构造回合资源后注入。默认空资源 parity characterization 锁定公开 outcome、source bindings、delivery diagnostics、request audit、消息与工具 schema 不变;未注册 artifact 工具、未读取 private store、未修改 direct 排序或 Provider 线协议。Runtime 除改前已存在的可变真书 fixture LID 漂移外 228/228,Integration 5/5;Server 全量 215/215,格式与 diff 检查通过。

### AA6 - ArtifactAccessSnapshot 与 list/read 引擎

状态:完成,2026-07-29。

依赖:AA4、AA5。

**输入/输出**:输入为 current private overlay 的 v1/v2 accepted 投影;输出为 revision-frozen snapshot 及共享 list/read 执行器。
**做**:新增共享 Rust artifact-tools crate/模块,定义 canonical aliases、schemas、错误码、snapshot、opaque refs、分页和 list/read;Server 从 private store 构造只读 snapshot。
**不做**:不实现搜索、不暴露 Resident/MCP、不读取 raw goal/Plan;不让 Runtime 依赖 Server crate。
**触达**:`crates/artifact-tools/`、workspace Cargo、`crates/server/src/intent_build_store.rs`、cross-language fixtures。
**Red**:snapshot 混入 pending/history;replan 后一次 session 跨 revision;cursor 可跨 book/artifact 复用;结果无上限。
**Green**:snapshot 绑定 book/source/overlay/payload;refs/cursor opaque 且 scope-bound;list/read 预算和 v1/v2 parity 通过。
**验证**:`cargo test -p artifact-tools`;Server snapshot tests;TS/Rust golden contract parity。

**结果**:新增独立 `artifact-tools` crate,冻结 list/read aliases、closed schemas、稳定错误码、20/50 + 64 KiB list 预算、最多 3 条 + 12 KiB read 预算、JSON Pointer 字段选择与最多 32 条关系投影。`ArtifactAccessSnapshot` 以 book/source/plan/accepted payload 集计算 revision,artifact ref 绑定 revision,record ref 对不变 payload 稳定,cursor 绑定 revision + operation + artifact + offset。Server 只在 current active overlay 至少有一个 verified accepted v1/v2 时构造 snapshot;pending、历史、raw goal/Plan、candidate/failure/path 均不进入共享引擎。Rust 5/5、TS/Rust identity golden 1/1、Core Blueprint/contract 9/9 + typecheck、Server 217/217 + book_mcp 5/5 通过。

### AA7 - 确定性 artifact.search

状态:完成,2026-07-29。

依赖:AA6。

**输入/输出**:输入为 snapshot 的 Routing Cards 与规范 record/relation;输出为稳定排序、可解释、可分页且受预算约束的搜索结果。
**做**:实现字段白名单、规范化、短语/子串、中英 token/n-gram、字段权重、覆盖率、anchor 奖励、有限 typo fallback、稳定排序与匹配解释。
**不做**:不引入 embeddings、LLM、后台索引服务;不索引 evidence LID 字符串或内部字段。
**触达**:`crates/artifact-tools/src/search.rs` 与中英/分页/预算 fixtures。
**Red**:同分结果漂移;内部 ID/goal 命中;中文无空格查询零召回;零命中反复模糊扩张;12 KiB 超界。
**Green**:固定输入得到固定排序/原因;top 1..3 完整记录;超限按 summary 截断并可 read 续取。
**验证**:`cargo test -p artifact-tools search`;golden score/ordering;property tests 覆盖预算与 cursor。

**结果**:`artifact-tools` 新增 closed search schema 与 snapshot-local 执行器,以版本化 NFKC/full-casefold/空白规范化完成 exact phrase、边界短语、规范化子串、英文词项和中文二/三元片段召回;字段权重、覆盖率和 LID 层级 overlap anchor 奖励形成稳定整数分数,同分以 snapshot artifact/record 顺序收口。正常管线全局零命中时才对最多 4 个 ASCII 长词执行 1-edit fallback;关系字段命中投影到两端 record 并携带匹配关系 evidence。cursor 绑定 revision + 规范 query + artifact filter + anchors;返回最多 3 条/12 KiB,完整 record 超预算降为 `summary_fields + truncated=true`,summary 仍超限则 fail closed。Routing Card 与声明的 record/relation `search_fields` 是唯一索引输入,artifact/record/relation ID、digest、goal/Plan 与 evidence LID 字符串不可命中。Rust 15/15、Clippy、Core 9/9 + typecheck、Server 217/217 + book_mcp 5/5 通过。

### AA8 - Book MCP 静态暴露

状态:完成,2026-07-29。

依赖:AA6、AA7。

**输入/输出**:输入为 Book MCP 的 current-book binding 与共享 artifact read port;输出为静态 MCP schema 和逐调用重验的只读结果。
**做**:在 MCP tools/list 静态加入 `artifact_list`、`artifact_search`、`artifact_read`;Book MCP 启动时只建立同 OS 用户、当前书的 artifact read port,每次调用重验 current snapshot。
**不做**:不启用 BuildIntent HTTP/写接口、不注入 Routing Card、不开放 memory/profile/history/Provider 或 private path。
**触达**:`crates/server/src/mcp.rs`、`crates/server/src/bin/book_mcp.rs`、MCP contract tests、plugin smoke。
**Red**:无 overlay 时工具消失或空成功;换书/换源后读旧记录;响应出现 intent/plan/path/raw goal;MCP 可写。
**Green**:三工具始终列出;无数据返回 `ARTIFACT_OVERLAY_UNAVAILABLE`;current accepted 可分页读且仅只读。
**验证**:`cargo test -p server mcp`;book_mcp JSON-RPC smoke;`node apps/desktop/scripts/smoke-book-mcp-plugin.mjs`。

**结果**:Book MCP 通过独立 `ArtifactSnapshotReadPort` 静态公开三项 closed-schema 工具,而 `intent_store_root` 仍保持 `None`;生产端口只冻结启动时书目录/book id/private root,每次调用重新加载当前 source、校验 book id,再由 `IntentArtifactStore::read_active_artifact_access_snapshot` 重读 active + accepted。输入在读取 private store 前 fail closed,无端口或无 overlay 明确返回 `ARTIFACT_OVERLAY_UNAVAILABLE`,snapshot 漂移后旧 ref 被共享执行器拒绝;未增加写工具、BuildIntent、memory/profile/history/Provider 或 private path 暴露。MCP 定向 15/15、Server 220/220、book_mcp 5/5、release plugin JSON-RPC smoke、fmt、脚本语法与 diff-check 通过。

### AA9 - Resident Routing Card、暴露状态与调用预算

状态:完成,2026-07-29。

依赖:AA5、AA6、AA7。

**输入/输出**:输入为用户消息、回合冻结 snapshot 与现有 ToolExposurePlan;输出为有界 Routing Card fragment、阶段化工具面和共享 ToolResult。
**做**:Server 在回合开始冻结 snapshot;以 private turn-frozen fragment 注入 Routing Cards;Runtime 注册三工具并实现 NO_OVERLAY/ROUTABLE/SEARCH_HIT 暴露(list Deferred)、Direct 名额替换、显式禁用/source-only 指令与回合调用账本。
**不做**:不注入 accepted 正文、不让 artifact result 进入 evidence ledger、不改 mixed assistant/tool-call 交付协议。
**触达**:`crates/runtime/src/context_fragment.rs`、`tool_registry.rs`、`tool_exposure.rs`、`orchestrator.rs`、`crates/server/src/lib.rs` 与 tests。
**Red**:无 overlay 仍可调用;search 先走 tool.search;Direct 超过 8;零命中可循环重试;产物 LID 直接 source.present。
**Green**:search 替换 book.synthesize Direct;read 仅命中/续页后激活;一次初始 search、最多 3 记录;后续 Book evidence 才进入来源账本。
**验证**:Runtime registry/exposure/orchestrator tests;Server /agent/chat fixtures;请求审计确认 fragment 私有且不持久。

**结果**:Server 在 durable precommit 后、Resident loop 前从 reader-private store 重新校验 current source 与 active + accepted overlay,并将 `ArtifactAccessSnapshot` 冻结进 `ResidentTurnResources`;无 store、无 accepted、stale/replan 冲突均降为 `NO_OVERLAY`。Runtime 注册共享 closed-schema `artifact.list/search/read`,以 sensitive + turn-frozen `artifact_routing_cards.v1` 只注入有界 Routing Cards,显式“禁用产物/source-only”时不注入。暴露状态固定为 `NO_OVERLAY` 三工具 Hidden、`ROUTABLE` 下 list Deferred/search Direct/read Hidden 且替换 `book.synthesize` 的第八个 Direct 名额、`SEARCH_HIT`/read continuation 下 read Direct;初始 search 在执行前即消耗唯一名额,零命中或读完后不可重试。artifact 结果只进入当轮有界 ToolResult,持久历史改写为 receipt,trace 仅保留私有摘要,不进入 Book evidence ledger 或 `source.present`。Artifact Tools 15/15、Runtime 排除既有可变真书 LID 漂移单例后 232/232 + Integration 5/5、Server 220/220 + `book_mcp` 5/5 通过;严格 Clippy 仅命中既有基线类别,保留基线允许项后 Runtime/Artifact Tools 与 Server 全目标 `-D warnings` 通过。

### AA10 - Reader 通用五形态展示

状态:完成,2026-07-30。

依赖:AA4。

**输入/输出**:输入为 accepted v1/v2 加 Blueprint 展示元数据;输出为五种通用 Reader 投影与旧四类视觉兼容。
**做**:Reader 依据 Blueprint shape/summary/display metadata 展示 collection/table/graph/sequence/document,旧四类保持视觉与 evidence goto parity。
**不做**:不执行 Blueprint 自定义渲染代码、不在前端重新校验 accepted、不改变 Agent/MCP 合同。
**触达**:`crates/server/src/intent_build_store.rs`、`packages/web/src/api.ts`、`IntentArtifactPanel.vue`、视觉夹具与 tests。
**Red**:新 shape 空白;长字段横向溢出;旧四类退化;前端显示 raw goal/digest/path。
**Green**:五形态有通用降级;旧 fixture 截图/交互不退化;所有 evidence 点击仍走 Reader goto。
**验证**:Web unit/typecheck/build;Playwright desktop/mobile 五形态截图与 overflow 检查。

**结果**:Server 对 current active 的 pending/accepted v1/v2 统一附加仅含 title、purpose、shape、summary fields 的展示投影;V1 取固定系统 preset,V2 取 digest 已验证的 Plan snapshot,不发送完整 schema、私有路径或 goal。Web 同时接受旧四类 payload 与 `ArtifactInstanceV2`,collection/table/graph/sequence/document 均有通用、缺字段和未知 shape 降级;旧 timeline/concept map/comparison table/argument map 无论来自 v1 还是 v2 preset 均保留原视觉和 cite→goto 事件。长字段在 390px 下换行,表格仅在自身容器滚动。Web 37 files / 208 tests、typecheck/production build、Server 220/220 + `book_mcp` 5/5、desktop/mobile Playwright 2/2、fmt 与 diff-check 通过。

### AA11 - 迁移、真书闭环与发布门

状态:完成,2026-07-30。

依赖:AA1-AA10。

**输入/输出**:输入为 packaged Desktop/plugin/sidecar 与两本真实书;输出为可复放 audit、运行统计、架构/代码链路更新和发布判定。
**做**:用 technical_learning 与 paper 真书各验证一次 one-off Blueprint、preset 复用、v1 适配、Resident 自动搜索、MCP 静态读取、replan/source stale/delete、无 overlay 和用户禁用;记录成本/命中/调用轮次。
**不做**:不以 tiny fixture、空产物、LLM 自评或关闭隐私 gate 过门;不删除回滚适配器。
**触达**:新增 `apps/desktop/scripts/smoke-artifact-access.mjs`、packaged Desktop/plugin/sidecar、运行统计、`docs/架构.md` 与 `docs/代码链路.md`。
**Red**:任一消费者读到非 active/pending/历史产物;书中事实未重取证据;v1 不可读;词法零命中无诊断。
**Green**:两本真书三消费面结果一致;所有异常返回稳定错误;Agent 无关问题零 artifact 调用;相关问题少于等于一次初始 search。
**验证**:workspace Core/Runtime/Server/Web 全量测试、packaged parity、两本真书 audit、`cargo fmt --all -- --check`、`git diff --check`。

**结果**:`smoke-artifact-access.mjs` 在隔离 private/library 根复制 technical_learning `quantification-essence`(2757 LIDs)与 paper `understanding-transformer-from-the-perspective-of-reviewed-v2`(1981 LIDs)的真实基础层,通过 Core gate 构造 one-off、system preset、accepted v1 adapter、accepted v2 与 pending 控制样本,再从当前 Desktop stdin controller、packaged sidecar/plugin Book MCP 和 Resident Server 复放。两书 Reader/Resident/MCP 均只见 current active 的 2 个 accepted,legacy v1 各读 1 条,pending/history 不可读;replan 旧 ref=`ARTIFACT_REF_INVALID`,source stale=`INTENT_BUILD_CONFLICT`,delete/no-overlay=`ARTIFACT_OVERLAY_UNAVAILABLE`。相关 Resident 问题各 5 回合/25 tokens,恰好 1 search + 1 read + 1 `book.text` + 1 `source.present`;无关与用户禁用问题均 0 artifact 调用,private goal/body 泄漏为 0。最终复跑 wall clock 为 technical_learning 280 ms、paper 3618 ms;每书 delete 前 MCP 11 次调用。packaged parity 全绿,发布配置以仓库与 README 冻结的公开 source `adaelon/undertand-book` 通过;Core 串行全量 535/538,余下均为固定 wall-clock 冷启动阈值且无断言差异,其中 dispatch/profile 单测冷跑已绿,handoff 仅 Node/tsx 冷启动约 5.34 s 超过既有 5 s,未修改测试或门槛。Artifact Tools 15/15、Runtime 232/232 + integration 5/5(仅过滤已知真书 LID 基线)、Server 220/220 + Book MCP 5/5、Web 37 files / 208 tests + typecheck/build 均通过。

## 5. 执行顺序与提交边界

```text
AA0 -> AA1 -> AA2 -> AA3 -> AA4 -> AA10
  \-> AA5 -----------\
AA4 + AA5 -----------> AA6 -> AA7 -> AA8
                                  \-> AA9
AA8 + AA9 + AA10 ----------------> AA11
```

每片独立提交,不与现有 Note-placement 工作混合。AA5 是纯重构;AA1-AA4 是构建合同;AA6-AA9 是读取面;AA10 是 UI;AA11 只做集成与文档收口。任何切片若需要扩大 FrozenIntent、开放新私人正文、引入向量/模型搜索或执行代码,必须停止并回到新的 ADR,不得在实现中顺手吸收。

## 6. 回滚

- 关闭 Resident artifact exposure 不影响 Reader 成果页、Book tools 或 private artifact 文件。
- 关闭 MCP artifact dispatch 只让三工具返回 unavailable,不动态删除 tools/list。
- Planner 可临时回退为只选择四个系统 Blueprint,但新合同与 digest 不回退为固定 enum。
- v2 写入关闭后保留 v1/v2 只读适配;不删除已 accepted 文件。
- Registry 故障时允许 one-off Blueprint 随 Plan 冻结,不得绕过 Runtime gate 或写公共目录。
