# 切片方案 - Agentic paper minimap

> 定位:为可信 PDF-first paper reader 增加类似游戏小地图的辅助型全局导航,由确定性地图基座、用户私有 overlay 和受控 agent action 组成。
> 冻结决策:[ADR-0072](adr/0072-agentic-paper-minimap-readonly-projection-and-user-overlays.md)。
> 状态:领域 Grill、AM0-AM12 已完成;AM13 按用户要求不执行,Windows Setup 已于 2026-07-12 交付用户自测。

## 0. 冻结决策

1. 小地图是辅助导航,不是摘要、论文十问、Codebook、元数据面板或第二主阅读面。
2. 基础坐标固定为 PDF 页/章节阅读顺序;模式、Agent 和用户 overlay 都不得重排坐标。
3. 默认 collapsed,只显示区域、viewport 和地标点;只有用户能展开 expanded 视图,Agent 无权主动展开。
4. `skim / abstract / deep` 是 `PaperMinimapMode`,与 `ReaderLayoutPreset` 解耦。
5. 滚动与跳转只走确定性位置同步;只有用户自然语言目标或反馈触发 resident reader agent。
6. Agent 选择合法投影和焦点,系统根据预构建证据绘制节点与关系;Agent 不提交任意关系图。
7. `viewport_position / selected_lid / map_focus` 独立;Agent 改 focus 默认不导航正文。
8. 基础地图是只读 projection,不新增 `paper_minimap.json` 或其他 paper truth。
9. `SessionOverlay` 可撤销且默认不跨会话;`SavedUserOverlay` 仅在用户确认后写入独立用户私有结构化存储。
10. 基础地标不可编辑;个人修改通过带 provenance 的 user landmark/override 表达。
11. reducer 是最终权威;schema、权限、revision、ID、证据、区域语法和信息预算任一失败即拒绝。
12. 基础拓扑缺失或 stale 时整图 unavailable;BookStructure/discourse/graph 等语义层独立 degraded。

## 1. 所有权与运行流

```text
trusted paper artifacts
  -> book.paper_minimap
  -> PaperMinimapBase(read-only)

ReaderPaperMinimapState
  = position
  + presentation
  + PaperMinimapMode
  + SessionOverlay
  + SavedUserOverlay

human gesture
  -> reader.paper_minimap.apply
  -> deterministic effect

natural-language goal/feedback
  -> resident reader agent
  -> PaperMinimapAgentContext
  -> optional book.text/context evidence read
  -> reader.paper_minimap.apply
  -> effect | proposal | noop | error
```

所有权:

- `crates/read-tools`:加载地图所需公共 sidecar,拥有确定性 `PaperMinimapBase` projection 与区域/地标/关系规范化。
- `crates/reader`:拥有 `ReaderPaperMinimapState`、typed action、reducer、effect/proposal 和 undo 语义。
- `crates/server`:暴露 HTTP 命令面,解析用户级 overlay 路径并负责原子持久化生命周期。
- `crates/runtime`:把同一命令投影给 resident agent,不另起 minimap agent loop。
- `packages/web`:渲染状态和发送 action,不推断 paper truth、不在本地绕过 reducer。

## 2. 只读地图契约

```ts
type PaperRegionKind =
  | "abstract"
  | "introduction"
  | "related_work"
  | "method"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "unknown";

type PaperLandmarkKind =
  | "research_question"
  | "hypothesis"
  | "related_work"
  | "method"
  | "experiment"
  | "evidence"
  | "result"
  | "claim"
  | "contribution"
  | "limitation"
  | "future_work"
  | "other";

type PaperMinimapRelation =
  | "frames"
  | "addresses"
  | "tests"
  | "produces"
  | "supports"
  | "challenges"
  | "limits"
  | "motivates"
  | "builds_on"
  | "contrasts";

type PaperArgumentSlot =
  | "background"
  | "research_gap"
  | "research_question"
  | "hypothesis"
  | "input"
  | "object"
  | "method_step"
  | "method"
  | "output"
  | "assumption"
  | "experiment"
  | "evidence"
  | "result"
  | "claim"
  | "contribution"
  | "interpretation"
  | "limitation"
  | "future_work";
```

```ts
interface PaperRegion {
  region_id: string;
  title: string;
  kind: PaperRegionKind;
  lid_span: { start_lid: string; end_lid: string };
  page_span: { start_page: number; end_page: number };
  classification_source: "heading" | "discourse" | "unknown";
  confidence: number;
}

interface PaperLandmark {
  landmark_id: string;
  kind: PaperLandmarkKind;
  anchor_lid: string;
  page_index: number;
  label: string;
  source_label?: string;
  evidence_lids: string[];
  provenance: Array<"book_structure" | "discourse" | "graph" | "pass2">;
}

interface PaperArgumentRelation {
  relation_id: string;
  type: PaperMinimapRelation;
  source_landmark_id: string;
  target_landmark_id: string;
  evidence_lids: string[];
}

interface PaperMinimapBase {
  version: "paper_minimap.v1";
  book_id: string;
  book_version: string;
  fingerprint: string;
  status: "available" | "degraded" | "unavailable";
  regions: PaperRegion[];
  landmarks: PaperLandmark[];
  relations: PaperArgumentRelation[];
  layer_status: Record<string, { status: "available" | "degraded" | "unavailable"; reason?: string }>;
  warnings: string[];
}
```

区域分类优先级:

```text
normalized original heading alias
  -> aggregate discourse labels with sufficient evidence
  -> original title + kind=unknown
```

BookStructure 的 `setup/foundation/method/application/case/synthesis` 只参与地标候选,不得强行改写 paper region kind。地标按 `{kind,anchor_lid}` 去重;关系必须能归一化到闭集、解析两端真实地标并持有有效 `evidence_lids`。

AM3 确定性映射表:

| 来源 | 输入 | 地标/关系 |
|---|---|---|
| discourse `local_function` | `research_question/hypothesis/related_work/method_description/experiment_setup/evidence_report/result_interpretation/limitation/future_work` | 同名 `PaperLandmarkKind`；`result_interpretation -> result` |
| discourse `rhetorical_move` fallback | `related_work_positioning/method_setup/experiment_report/result_claim/limitation_acknowledgement/future_work_projection` | `related_work/method/experiment/claim/limitation/future_work` |
| graph | claim node | `claim`;entity/concept 只在证据化关系需要解析端点时成为 `other` |
| BookStructure key stop | `claim/example/warning/summary` | `claim/evidence/limitation/contribution`;其他闭集类型为 `other` |
| BookStructure spine role | `method/synthesis` | `method/contribution`;其他 role 为 `other`,不得解释成 paper region |
| paper graph/Pass2 edge | `claim_supported_by_evidence/method_supports_result/hypothesis_tested_by_experiment/related_work_contrasts/related_work_builds_on/limitation_motivates_future_work` | `supports/produces/tests/contrasts/builds_on/motivates`,其中 supports/tests 按语义反转端点 |
| generic evidence edge | `supports/rebuts/contradicts/builds_on/contrasts/prerequisite` | `supports/challenges/challenges/builds_on/contrasts/frames` |
| discourse relation | `supports/rebuts/contrasts/answers/depends_on/prepares/results_in/causes` | `supports/challenges/contrasts/addresses/builds_on/frames/produces/motivates` |

任何输入关系若 evidence 为空/悬空、graph 端点不存在、Pass2 header 与 book 不匹配、或归一化后地标端点无法解析,都不得进入 `relations`;它只产生 warning 并把 arguments layer 标成 degraded/unavailable。Pass2 仅消费 `accepted`,不得消费 `pending/rejected/gate_dropped`。

## 3. 模式与区域语法

基础区域、viewport 和地标坐标在所有模式中保持不变。

```text
skim
  research_question
    -> method
    -> evidence/result
    -> contribution/claim
    -> limitation

abstract
  abstract 内 problem -> method -> result -> contribution
  最多三条跨区域投影指向正文 method/results/discussion/conclusion 证据

deep
  保留全局 throughline
  当前区域展开最多 4 节点 / 3 关系
  邻区最多一个前置关系和一个后续影响
```

区域语法:

```text
abstract:     research_question -> method -> result -> contribution
introduction: background/research_gap -> research_question/hypothesis
method:       input/object -> method_step -> output -> assumption
results:      experiment -> evidence/result -> claim
discussion:   claim/result -> interpretation -> limitation -> future_work
conclusion:   research_question -> contribution/claim -> limitation
unknown:      no generated argument relation
```

`PaperArgumentSlot` 是局部投影槽位,不自动升级为全局地标;projector 只用已有证据化候选填槽。缺节点即留空;不得为了闭合链路生成地标或关系。graph weight、LLM confidence 和 map classification confidence 都不得显示成“证据强度”。

AM4 的 `5/4/3` 信息预算固定为:skim 全局速览最多 5 个地标;abstract/deep 当前区域语法最多 4 个地标;任何 lens 最多 3 条关系。ModeLens 结果只保存 base IDs:

```ts
interface PaperMinimapLensProjection {
  mode: PaperMinimapMode;
  focus_region_id?: string;
  global_landmark_ids: string[];
  local_landmark_ids: string[];
  relation_ids: string[];
  slot_bindings: Array<{ slot: PaperArgumentSlot; landmark_id: string }>;
  abstract_correspondences: Array<{
    slot: PaperArgumentSlot;
    abstract_landmark_id: string;
    body_landmark_id: string;
  }>;
  warnings: string[];
}
```

排序固定为语法槽位优先、PDF page、anchor LID、ID;关系仅能引用已存在地标。`unknown/references` 不生成局部槽位或关系;无匹配候选时返回空数组,不得补节点。abstract mode 优先选择 abstract region;没有 abstract 时保留全局速览并给 warning。deep mode 使用显式 focus region;缺 focus 时同样不推断当前区域。

abstract correspondence 不是 argument relation:projector 仅把 abstract 四槽中已有地标与 abstract 区域外同 `PaperLandmarkKind` 的最早正文地标配对,最多 3 条,只返回 base IDs;缺同类正文地标即不显示,不得生成“对应”事实。

## 4. Reader state、overlay 与 action

```ts
interface PaperViewportPosition {
  start_page: number;
  end_page: number;
  center_page: number;
  progress_ratio: number;
  anchor_lid: string | null;
  region_id: string | null;
}

interface MinimapOverlay {
  emphasized_landmark_ids: string[];
  hidden_landmark_ids: string[];
  pinned_landmark_ids: string[];
  focused_region_id: string | null;
  focused_landmark_id: string | null;
  visible_layers: string[];
  local_projection: { region_id: string; grammar: PaperRegionKind; focus_slots: PaperArgumentSlot[] } | null;
}

interface ReaderPaperMinimapState {
  rev: number;
  base_map_rev: string;
  presentation: "collapsed" | "expanded";
  mode: "skim" | "abstract" | "deep";
  viewport_position: PaperViewportPosition;
  selected_lid: string | null;
  map_focus: { region_id?: string; landmark_id?: string } | null;
  session_overlay: MinimapOverlay;
  saved_user_overlay: SavedUserOverlay;
}
```

Agent/GUI 共用 action 闭集:

```ts
type PaperMinimapAction =
  | { kind: "set_presentation"; presentation: "collapsed" | "expanded" }
  | { kind: "update_viewport"; position: PaperViewportPosition }
  | { kind: "set_selected_lid"; selected_lid: string | null }
  | { kind: "focus_region"; region_id: string }
  | { kind: "focus_landmark"; landmark_id: string }
  | { kind: "emphasize_landmarks"; landmark_ids: string[]; reason: string }
  | { kind: "select_local_projection"; region_id: string; grammar: PaperRegionKind; focus_slots: PaperArgumentSlot[] }
  | { kind: "set_layer_visibility"; layer: string; visible: boolean }
  | { kind: "pin_landmark" | "unpin_landmark"; landmark_id: string }
  | { kind: "set_mode_lens"; mode: "skim" | "abstract" | "deep" }
  | { kind: "clear_session_overlay" };
```

直接执行:

- 用户发出的 `set_presentation`;该 action 不进入 Agent allowed actions。
- PDF 滚动/选区发出的 `update_viewport/set_selected_lid`;两者是确定性 UI 同步 action,Agent 无权调用。
- 用户手势对应的 session action。
- Agent 在当前 mode 内的 focus、emphasis、local projection、session layer 与 session pin。

必须 proposal:

- Agent 推断出的 `set_mode_lens`。
- 长期隐藏、改名、自定义地标、保存偏好或任何 SavedUserOverlay 变更。
- 用户未显式要求的正文导航。

每个 effect 记录 `effect_id/base_map_rev/before_state_rev/after_state_rev/trigger_turn_id/actions/reason/evidence_lids/created_at` 和可执行 undo。基础地图或 reader state revision 不匹配时拒绝重放。

## 5. Agent context 与反馈策略

Agent 输入使用轻量全局快照,不得默认塞入全文:

```ts
interface PaperMinimapAgentContext {
  map_rev: string;
  topology: PaperRegion[];
  position: PaperViewportPosition;
  mode: ReaderPaperMinimapState["mode"];
  landmarks: Array<PaperLandmark & { state: "normal" | "emphasized" | "hidden" | "pinned" }>;
  user_signal: { current_goal: string | null; latest_feedback: string | null };
  allowed_actions: PaperMinimapAction["kind"][];
}
```

若动作涉及地标或关系语义,Agent 必须按需调用 `book.text/context` 取真实证据。反馈映射:

```text
orientation -> focus current region
interest    -> resolve evidence-backed landmarks -> emphasize
confusion   -> select current-region local projection
density     -> change session layer visibility
correction  -> user override proposal
persistence -> saved preference proposal
```

反馈无法唯一定位目标时保持地图不变并只追问一个问题。一条反馈最多触发一个主要地图意图。直接地图手势不触发 Agent;用户手动状态优先于 saved preference、Agent suggestion 和 mode default。

## 6. 私有持久化与 provenance

用户级单一真相源:

```text
<user-data>/paper-minimap-overlays.json
```

```ts
interface UserLandmark {
  landmark_id: string;
  label: string;
  anchor_lid: string;
  kind: "important" | "question" | "confusing" | "follow_up";
  note?: string;
  created_from_effect?: string;
  provenance: "user_saved";
}

interface UserLandmarkOverride {
  target_landmark_id: string;
  operation: "hide" | "deemphasize" | "rename";
  label?: string;
  user_reason?: string;
  provenance: "user_override";
}

interface SavedUserOverlay {
  book_id: string;
  book_version: string;
  overlay_rev: number;
  emphasized_kinds: PaperLandmarkKind[];
  hidden_landmark_ids: string[];
  pinned_landmark_ids: string[];
  custom_landmarks: UserLandmark[];
  landmark_overrides: UserLandmarkOverride[];
  saved_mode_preferences: Array<{ mode: "skim" | "abstract" | "deep"; visible_layers: string[] }>;
}

type SavedUserOverlayAction =
  | { kind: "save_user_landmark"; anchor_lid: string; label: string; user_kind: UserLandmark["kind"]; note?: string }
  | { kind: "remove_user_landmark"; landmark_id: string }
  | { kind: "set_landmark_override"; target_landmark_id: string; operation: UserLandmarkOverride["operation"]; label?: string; user_reason?: string }
  | { kind: "remove_landmark_override"; target_landmark_id: string }
  | { kind: "save_mode_preference"; mode: "skim" | "abstract" | "deep"; visible_layers: string[] }
  | { kind: "clear_saved_overlay" };
```

AM6 版本迁移只允许确定性重锚:同 `book_id+book_version` 精确恢复;仅有旧 version 时,custom landmark 的 `anchor_lid` 必须在新 base 仍存在,base landmark pin/hide/override 必须能按稳定 landmark ID 精确命中;kind preference 与 mode preference 可原样保留。不得猜最近 LID、标题相似或语义近邻。无法解析的条目写入 store envelope 的 stale records(含 book/version、item kind/id、reason),并从活动 overlay 移除。

`SavedUserOverlayAction` 只能由用户直接发出,或在用户确认 revision-bound proposal 后执行。provenance 闭集=`derived | agent_session | user_saved | user_override`。基础地标不可编辑;rename/hide/deemphasize 都是用户覆盖。该文件原子覆写,不得写入 paper workspace 或 `memory.json`;book version 变化时逐 LID 重锚,失败项标 stale 且不自动应用。

## 7. 命令面与验证门禁

```text
GET  /book/paper_minimap
POST /reader/paper_minimap.state
POST /reader/paper_minimap.apply
```

验证顺序:

```text
schema
  -> actor permission
  -> base_map_rev/state_rev
  -> target IDs/LIDs
  -> mode + region grammar
  -> evidence
  -> information budget
  -> effect | proposal | noop
```

错误闭集第一版:

- `TARGET_NOT_FOUND`
- `STALE_MINIMAP_STATE`
- `EVIDENCE_REQUIRED`
- `INVALID_ARGUMENT_PROJECTION`
- `MINIMAP_BUDGET_EXCEEDED`

fingerprint 覆盖 `book_version/source_manifest/pdf_source_map/book_structure/discourse/graph-pass2/profile/projector` 版本或 hash。fingerprint 变化时重建 base、清 SessionOverlay、重锚 SavedUserOverlay;不得调用 LLM。

## 8. 前端交互与信息预算

桌面:

- collapsed 地图常驻左栏顶部。
- 用户展开后地图接管整个左栏;PDF 中心栏宽度和滚动位置不变。
- 收起后恢复普通目录,SessionOverlay 保留。

移动端:

- collapsed 保留入口、viewport 与变化提示。
- expanded 使用可关闭覆盖层,不重新排版 PDF 页面。

视觉语义:

- `y = pageIndex / pageCount`;章节区域保持真实页跨度。
- viewport 是半透明窗口,selected LID 与 map focus 使用不同标记。
- collapsed 持续显示全文进度;references 等长区域保留真实比例但降低视觉权重。
- 极短章节至少保留可点击命中区,视觉命中扩张不得改变真实页坐标。
- collapsed 不显示标题、关系、pin 说明或 Agent 理由。
- expanded 渐进显示短中文类型标签、局部关系与最近 effect 原因/撤销。
- 不在地图上显示 LID、内部 role、confidence 或段落摘要。

硬预算:

- 全局带文字重点地标最多 5 个;其余只显示点位。
- 当前局部最多 4 节点、3 关系,只展开一条主链。
- 用户固定项最多 3 个直接展开,超出聚合。
- reducer 拒绝或降权超预算 action;地图不得因动态内容改变尺寸。

滚动同步:

```text
PDF scroll
  -> requestAnimationFrame local viewport update
  -> no network / no Agent / no graph projection
  -> 200-300ms idle
  -> nearest mapped LID semantic sync
```

## 9. 实现切片

### AM0 - 决策与术语落盘

- **Status (2026-07-12)**:complete。

- **Do**:落 ADR-0072、CONTEXT 术语和本计划。
- **Do not**:改可执行代码或现有 reader 行为。
- **Done**:术语零未解析;ADR/计划互链;文档 diff 检查通过。

### AM1 - Rust/TypeScript DTO 与 schema gate

- **Status (2026-07-12)**:complete。Rust 权威 DTO、ts-rs bindings 与 serde closed-contract tests 已落地。

- **Do**:在 `crates/read-tools` 定义 base/region/landmark/relation DTO,在 `crates/reader` 定义 state/action/effect/proposal DTO,通过 ts-rs 导出前端类型并补 schema round-trip tests。
- **Do not**:实现 projection、reducer、HTTP 或 UI。
- **Done**:所有闭集可序列化且生成类型稳定;非法 enum/缺字段 fixture 被拒绝。

### AM2 - 基础拓扑 projector

- **Status (2026-07-12)**:complete。`Book::paper_minimap()` 已由 LID structural subtree、`source_manifest.v2` 与 `pdf_source_map.v1` 确定性生成 regions/page spans/fingerprint;坏产物只让地图 unavailable,不阻断 `Book::load`。
- **Do**:让 read-tools 读取 public PDF map 所需字段,由 LID section subtree + PDF regions 生成稳定 regions/page spans/fingerprint;实现 heading-first kind 与 unknown fallback。
- **Do not**:接 BookStructure/discourse/graph,不生成地标关系。
- **Done**:标准标题、别名、非标准 unknown、跨页区域和 stale PDF hash fixtures 全绿。

### AM3 - 语义地标与关系 projector

- **Status (2026-07-12)**:complete。BookStructure/discourse/graph/Pass2 accepted 已按冻结表生成去重地标、provenance 与 evidence-gated 关系;各语义层可独立 degraded/unavailable。
- **Do**:组合 BookStructure/discourse/graph/Pass2,实现地标去重、provenance、关系归一化和独立 layer status。
- **Do not**:实现 mode、Agent 或 UI;不得生成缺证据关系。
- **Done**:地标闭集、关系闭集、dangling evidence、部分 sidecar degraded tests 全绿。

### AM4 - ModeLens 与局部投影

- **Status (2026-07-12)**:complete。reader 纯函数仅从 immutable base IDs 生成 skim/abstract/deep lens,执行全局 5 点、局部 4 点、关系 3 条预算及固定 region grammar。
- **Do**:实现 skim/abstract/deep 以及各 region grammar,应用 5/4/3 信息预算并产出 deterministic projection。
- **Do not**:接 reader session 或 LLM。
- **Done**:同一 fixture 三模式输出不同且坐标完全一致;unknown 不产关系。

### AM5 - Reader minimap state/reducer

- **Status (2026-07-12)**:complete。Reader 初始化 minimap state,单一 apply 入口原子校验 actor/revision/ID/grammar/layer/预算;支持 effect/proposal/noop、stale proposal 与 before/after undo。
- **Do**:在 `crates/reader` 加 position triad、presentation、mode、SessionOverlay、typed action、revision gate、effect/proposal/noop/error 与 undo tests。
- **Do not**:持久化 SavedUserOverlay 或接 HTTP。
- **Done**:direct/proposal 分流、stale、budget、invalid target/evidence、undo 全绿。

### AM6 - SavedUserOverlay store

- **Status (2026-07-12)**:complete。server 用户数据目录新增版本化单文件 store,支持原子写、精确恢复、旧版本确定性重锚、stale records 与 corruption error boundary;冷启动/book.open 注入 Reader。
- **Do**:实现用户级 `paper-minimap-overlays.json` 原子读写、book/version 分组、provenance、LID 重锚和 stale 记录。
- **Do not**:复用 memory.json、session layout 或写 paper workspace。
- **Done**:重启恢复、版本变化重锚、失败 stale、损坏文件错误边界 tests 全绿。

### AM7 - HTTP 与 runtime command surface

- **Status (2026-07-12)**:complete。三个 HTTP endpoint 已接 base/state/lens/reducer/proposal/persistence;resident runtime 复用同一 typed command 并把 minimap effect/proposal 纳入 `OuterOutcome.effects`。
- **Do**:新增三个 HTTP endpoint、resident agent tool schema/dispatch,把 minimap effect/proposal 接入现有 `AgentOutcome.effects`。
- **Do not**:新增独立 minimap agent 或后台触发器。
- **Done**:HTTP/business error envelope、runtime fake-provider tool call、proposal revision tests 全绿。

### AM8 - 被动 collapsed/expanded 前端

- **Status (2026-07-12)**:complete。`PaperMinimap` 已接真实 base/state API;collapsed 只绘 region 坐标带、viewport 与 landmark dots,仅用户命令可展开真实 region/LID 列表。桌面固定左栏、移动端视口内 overlay 均经 Chromium 几何断言和截图验证。
- **Do**:新增 `PaperMinimap` 组件,先渲染 base regions、viewport、landmark dots 与用户展开状态;桌面接管左栏,移动端覆盖层。
- **Do not**:实现模式关系、Agent effect 或 PDF scroll sync。
- **Done**:desktop/mobile component tests 与 Playwright 截图证明 PDF 尺寸/滚动不变且无重叠。

### AM9 - PDF viewport 双向同步

- **Status (2026-07-12)**:complete。`PdfReaderPane` 以 rAF 合并 scroll,按可见页中心与 PDF region 视觉坐标确定 nearest LID;App 本地即时移动 marker,180ms idle 后合并 viewport/selection reducer command。地图轨道支持 click/drag release/keyboard 确定性导航,Agent 调 position action 被 403 拒绝。
- **Do**:让 `PdfReaderPane` 发本地 viewport change,小地图 rAF 同步;idle 后确定性映射 nearest LID;地图点击/拖动可导航 PDF。
- **Do not**:滚动触发 Agent、网络高频请求或 base 重算。
- **Done**:scroll/click/drag/跨章节中心判定/selected 与 focus 分离 tests 全绿。

### AM10 - ModeLens 与 expanded 交互

- **Status (2026-07-12)**:complete。expanded 已消费 authoritative lens,分别渲染 skim 全局路线、abstract 四槽与最多 3 条正文同类对应、deep 当前区域链及最多 3 条证据关系;mode/layer/pin 均走 reducer。Reader 只按 effect ID 保留服务端快照并提供单步 undo,客户端快照不受信任;unknown/degraded 显式空态。
- **Do**:渲染 skim 主路线、abstract-to-body 对应、deep local chain,实现 layer、pin、effect reason 和单步 undo。
- **Do not**:把 PaperReadingGuide 十问、Codebook、metadata 或摘要正文塞进地图。
- **Done**:三模式 DOM/视觉差异、信息预算、degraded 层和 unknown tests 全绿。

### AM11 - Agent feedback integration

- **Status (2026-07-12)**:complete。每个 paper 自然语言 turn 注入紧凑 `PaperMinimapAgentContext`,deterministic classifier 覆盖 orientation/interest/confusion/density/correction/persistence;prompt 只映射合法 session action 或 mode/saved proposal。右栏已支持 direct effect 撤销与 proposal 应用/忽略,忽略会从 Reader 删除 proposal。fixed provider 覆盖 4 effect/2 proposal/noop/clarify;滚动路径不进入 runtime。
- **Do**:注入轻量 AgentContext,实现 orientation/interest/confusion/density/correction/persistence policy,只在自然语言 turn 调工具。
- **Do not**:滚动触发 LLM、Agent 直接切 mode、Agent 直接持久化 overlay。
- **Done**:固定 provider fixtures 验证 effect/proposal/noop/clarify;真实 provider 只做 smoke。

### AM12 - 旧 paper map 迁移

- **Status (2026-07-12)**:complete。App/LeftRail 已删除 `paperStructureRows/paperMinimapPresets/PaperReadingGuide/BookStructure` 旧地图请求、props、computed、events 与孤立 CSS;左栏只保留一个 `PaperMinimap`。迁移守卫和 Reader 集成测试证明 `paper_deep_read` 只改 slots,minimap `abstract` 只改 lens。
- **Do**:删除 `paperStructureRows` 直接暴露 BookStructure 的旧 UI 路径;让 minimap mode 与 `ReaderLayoutPreset` 分离,保留 layout preset 的面板职责。
- **Do not**:顺手重构无关 LeftRail/ReaderPane。
- **Done**:旧 preset 仍控制 slots,小地图 mode 只控制地图;无重复“论文地图”表面。

### AM13 - 真实论文验收与收口

- **Status (2026-07-12)**:waived。用户明确要求不运行 AM13,改为生成新的 Windows Setup 后自行测试;因此不宣称真实论文验收或 Setup smoke 已通过。
- **Do**:用标准 IMRaD、非标准/综述、语义 sidecar 不完整三类可信 paper 跑端到端验收,补 docs/代码链路与架构文档。
- **Do not**:用 LLM 自评代替断言,不在验收刀新增功能。
- **Done**:全量 web/Rust tests、typecheck、build、desktop package、Playwright desktop/mobile 与真实 Setup smoke 全绿。

## 10. Hard gates

- Base topology 必须来自 trusted source manifest、有效 LID tree 与 fresh PDF map。
- region/landmark/relation 所有 LID 必须真实存在;page spans 必须在 PDF 页界内。
- `PaperMinimapBase.fingerprint` 与 action 的 `base_map_rev` 必须一致。
- relation 两端、类型、方向和 evidence 必须通过闭集及区域语法。
- Agent action 必须通过同一 reducer;前端不得本地容错绘制非法动作。
- SavedUserOverlay 只能位于用户私有目录,不得进入 book workspace、memory 或公共 sidecar。
- collapsed/expanded、模式切换和 Agent effect 不得改变 PDF 中心栏尺寸或滚动锚。

## 11. 非目标

- 新的 `paper_minimap.json`、argument sidecar 或公共用户地图数据库。
- 全文知识图谱、跨论文地图、论文摘要面板或十问面板。
- Agent 后台常驻、滚动触发 LLM、Agent 自由绘图或直接改 paper truth。
- OCR、PDF annotation write-back、page/bbox citation anchor。
- 多设备同步、多人协作 overlay 或通用 ReaderThemeAction。
