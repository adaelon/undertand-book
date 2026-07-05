# 切片方案 · Profile Plugin Framework + Reader UI Control Plane

> **定位**:在 `paper` 预构建规则包之后,补齐消费层框架:预构建、后端运行时、前端阅读器都按 `content_profile` 插拔;agent 通过后端校验后的 JSON action 操作阅读器布局。
> **冻结决策**:ADR-0060、ADR-0061。
> **状态**:§0.5 Grill 已收口,未开工。当前只落档方案;后续每个 PF 刀单独 A1 声明、单独验证。

---

## 0. §0.5 锁定决策摘要

1. **三模块都 profile-aware**:预构建、后端 runtime/agent、前端消费层都按 profile 插拔,但共享同一契约版本。
2. **共享契约由后端 Rust 拥有**:`ProfileManifest`、projection、UI slot、layout action/state 等类型由 Rust 定义,通过 ts-rs 导出给前端。
3. **manifest 是静态能力表**:profile manifest 描述 projection、UI slots、layout presets、允许动作和 agent tools;动态状态只在 `ReaderLayoutState`。
4. **agent 不操作 DOM**:agent 输出 typed JSON tool call `reader.layout.apply({ actions })`;后端解析、鉴权、校验、reduce;前端只渲染 accepted state。
5. **后端是布局真相源**:`ReaderLayoutState` 属 workspace/session,覆盖 open slots、focus、pinned evidence、panel sizes、slot order、active preset,不覆盖选区、popover、输入草稿。
6. **低风险直执,高风险提议**:`open_slot/focus_slot/set_active_tab/pin_evidence/unpin_evidence/set_panel_size` 可直执;`close_slot/reorder_slot/set_layout_preset/reset_layout` 先生成 inline proposal,用户 Apply 后后端按 `proposal_id` 复验。
7. **undo 走 AgentEffect**:扩展 `AgentEffect::Layout/LayoutProposal`;undo 只在当前 rev 等于 effect after rev 时恢复 before snapshot。
8. **paper 消费层先做工作台**:普通大纲升级为论文结构地图;贡献摘要、structure spine、十问进度、Codebook 摘要、AbstractReadingAid 等是 agent 的上下文和槽位,主入口仍是 agent。
9. **UI 风格控制延后**:整体 theme/style 调整以后以 `ReaderThemeAction` 或 profile theme spec 处理,本阶段不做。

---

## 1. A1 阶段总声明

- **做**:建立 Profile Plugin Framework 的最小闭环:Rust 契约 + 后端 profile registry + `reader.state`/manifest summary + layout reducer/tool/effect + 前端 manifest/layout sync + paper workbench slots。最终 agent 能通过受控 JSON action 改变阅读器布局,前端根据 profile manifest 渲染 paper 专属消费入口。
- **不做**:
  - 不让 agent 直接发 DOM/CSS selector/任意脚本。
  - 不把 layout 临时状态写成跨设备同步或长期用户偏好。
  - 不在本阶段实现 UI theme/style 调整。
  - 不重做 `paper` 预构建规则包;只消费现有 PaperReadingGuide、metadata、lexicon、BookStructure 等 projection。
  - 不新增大量 profile 专属 Core 命令;共享命令保持 Core,profile 只提供 policy/manifest/projection。
- **完成判据**:`technical_learning` 行为保持不变;`paper` profile 能返回 manifest 和 layout summary;agent 可调用 `reader.layout.apply` 执行低风险布局动作、产生高风险 proposal;前端可按 manifest 渲染 paper 结构地图和辅助槽位;所有论文事实展示仍可回到 LID evidence。

---

## 2. 共享契约草案

### 2.1 ProfileManifest

```ts
interface ProfileManifest {
  profile_id: "technical_learning" | "paper";
  profile_version: string;
  projections: ProjectionSpec[];
  ui_slots: UiSlotSpec[];
  layout_presets: LayoutPresetSpec[];
  allowed_layout_actions: ReaderLayoutActionKind[];
  agent_tools: AgentToolSpec[];
  guided_reading_policy: GuidedReadingPolicySpec;
  defaults: ProfileDefaults;
}
```

manifest 不承载动态布局,也不承载完整构建规则。完整 manifest 经 `profile.manifest` / `/profile/manifest` 取;`reader.state` 只返回 profile summary、version 和 agent-facing 操作摘要。

### 2.2 ProjectionSpec

```ts
type ProjectionSpec = {
  id: string;             // e.g. "paper.reading_guide"
  kind: string;           // e.g. "reading_guide"
  endpoint: string;       // e.g. "/book/paper_reading_guide"
  runtime_tool?: string;  // e.g. "book.paper_reading_guide"
  mcp_tool?: string;      // e.g. "book_paper_reading_guide"
  ts_type: string;        // e.g. "PaperReadingGuide"
  required: boolean;
};
```

### 2.3 UiSlotSpec

```ts
type UiSlotSpec = {
  id: string;
  title: string;
  kind: "map" | "agent" | "evidence" | "codebook" | "aid" | "questions";
  primary_projection?: string;
  secondary_projections: string[];
  allowed_actions: ReaderLayoutActionKind[];
  default_region: "left" | "center" | "right" | "bottom" | "overlay";
};
```

### 2.4 LayoutPresetSpec

```ts
type LayoutPresetSpec = {
  id: string;
  title: string;
  description: string;
  slots: LayoutPresetSlot[];
  focused_slot?: string;
};

type LayoutPresetSlot = {
  slot_id: string;
  region: "left" | "center" | "right" | "bottom" | "overlay";
  order: number;
  size?: { kind: "px" | "fr" | "percent"; value: number };
};
```

---

## 3. Reader UI Control Plane 契约

### 3.1 Layout state

```ts
type ReaderLayoutState = {
  rev: number;
  active_preset?: string;
  open_slots: string[];
  focused_slot?: string;
  pinned_evidence: Array<{ slot_id: string; lid: string; reason?: string }>;
  panel_sizes: Record<string, { kind: "px" | "fr" | "percent"; value: number }>;
  slot_order: Record<string, string[]>;
};
```

### 3.2 Action set

```ts
type ReaderLayoutActionKind =
  | "open_slot"
  | "close_slot"
  | "focus_slot"
  | "set_active_tab"
  | "pin_evidence"
  | "unpin_evidence"
  | "set_panel_size"
  | "reorder_slot"
  | "set_layout_preset"
  | "reset_layout";
```

后端按 profile manifest 校验 action 是否允许、slot/projection 是否存在、尺寸是否越界、proposal 是否 stale。前端不得自行接受未校验 action。

---

## 4. A4 子切片顺序

### PF0 · 文档和契约对齐

- **做**:落本切片方案,并确认 ADR-0060/0061、CONTEXT 术语、paper 规则包方案之间的引用关系。
- **不做**:不改代码、不生成类型。
- **判据**:后续实现能只依赖本方案 + ADR-0060/0061 开刀。
- **触达**:`docs/adr/0060-*`, `docs/adr/0061-*`, `CONTEXT.md`, 本文档。

### PF1 · Rust contract + ts-rs 导出

- **做**:新增/扩展 `ProfileManifest`、`ProjectionSpec`、`UiSlotSpec`、`LayoutPresetSpec`、`GuidedReadingPolicySpec`、`ReaderLayoutState`、`ReaderLayoutAction`、layout effect/proposal 类型,并导出 TS。
- **不做**:不实现 profile registry、不接前端渲染。
- **判据**:Rust 单测/类型检查通过;生成的 TS 类型能被前端编译消费。
- **触达**:`crates/read-tools`, `crates/runtime`, `packages/web/src/generated`。

### PF2 · 后端 profile registry + manifest 面

- **做**:实现 profile registry,提供 `technical_learning` 与 `paper` manifest;暴露 `profile.manifest` / REST endpoint;`reader.state` 返回 profile summary/version/allowed action summary。
- **不做**:不改变现有 build pipeline;不让前端硬编码 paper slots。
- **判据**:默认书仍是 `technical_learning`;paper fixture 能取到 paper manifest;manifest version 变化能被前端识别。
- **触达**:`crates/server`, `crates/runtime`, `crates/read-tools`。

### PF3 · profile-aware `book.guided_route_from`

- **做**:保持同一工具名,让 route/guided route 在 runtime 内读取 profile policy;`technical_learning` 行为保持不变,`paper` 可按论文结构策略排序。
- **不做**:不新增 `paper.guided_route_from`;不把 profile policy 写进 route Core。
- **判据**:现有 guided route 测试仍绿;paper policy fixture 下返回顺序可解释。
- **触达**:`crates/runtime/src/orchestrator.rs`, route/read-tools 相关测试。

### PF4 · ReaderLayoutState reducer + proposal lifecycle

- **做**:在后端 session 保存 layout state/rev,实现 `reader.layout.apply(actions)` reducer;低风险 action 直执,高风险 action 生成 proposal;proposal 记录 `base_layout_rev`,stale 不自动 rebase。
- **不做**:不持久化临时 focus/pin/open slot;不做多设备同步。
- **判据**:action validation、rev bump、proposal stale、Apply 复验、undo before snapshot 都有确定性测试。
- **触达**:`crates/runtime`, `crates/server`, agent effect 相关类型。

### PF5 · agent tool/effect 集成

- **做**:把 `reader.layout.apply` 放进 tool specs 和 dispatch;扩展 `AgentEffect::Layout/LayoutProposal`;SYSTEM_PROMPT 明确 JSON action 约束和高风险提议策略。
- **不做**:不让 LLM 生成任意 UI schema;不让 tool bypass reducer。
- **判据**:脚本化 agent 回合可触发 open/focus/pin 直执和 preset proposal;effect trace 可显示 before/after/actions。
- **触达**:`crates/runtime/src/orchestrator.rs`, `crates/server/src/mcp.rs`, prompt/test。

### PF6 · 前端 manifest/layout sync + 通用 slot shell

- **做**:前端从 `reader.state` 读取 profile summary/version,按需拉完整 manifest;以 `ReaderLayoutState` 为真相渲染 slot shell、preset、focus、panel size 和 proposal Apply/Dismiss。
- **不做**:不在前端复制 profile policy;不让前端自行构造未授权 action。
- **判据**:刷新后 layout 与后端一致;manifest version 变化触发重拉;proposal Apply 调后端并处理 stale。
- **触达**:`packages/web` reader 页面、generated types。

### PF7 · paper workbench slots

- **做**:基于 paper manifest 落地论文工作台:论文结构地图、agent 主入口、evidence panel、Codebook 摘要、AbstractReadingAid、十问进度、贡献摘要/structure spine。普通大纲在 `paper.structure_map` slot 中升级为论文结构地图。
- **不做**:不新增预构建 artifact;不把中文辅助内容当论文事实;不做跨论文比较 UI。
- **判据**:paper fixture 可渲染结构地图和辅助槽位;点击/agent pin 的论文事实都有 LID evidence;slot 缺 projection 时显示可降级状态而非崩溃。
- **触达**:`packages/web`, `crates/read-tools` paper projection, `docs/切片方案-paper规则包.md` PP8/PP9。

### PF8 · 端到端验收和回归

- **做**:跑通 backend + frontend + fixture smoke:paper manifest -> layout state -> agent action -> frontend render -> proposal apply/stale。补齐 cargo/npm 测试和必要的手工验收脚本。
- **不做**:不以 LLM 自评作为唯一验收;不要求真实长论文全量跑通。
- **判据**:`cargo test`、前端类型/构建检查、最小 paper fixture smoke 通过;记录无法自动化的 UI 验收项。
- **触达**:测试、fixtures、必要 smoke 文档。

---

## 5. 推荐实施顺序

```text
PF0
  -> PF1
  -> PF2
  -> PF4
  -> PF5
  -> PF6
  -> PF7
  -> PF8

PF3 可在 PF2 后并行开,但不得阻塞 layout 控制闭环。
```

先打通后端契约和布局 reducer,再接前端 shell,最后填 paper 专属槽位。这样可以先证明“后端承载 profile + layout control”的核心假设,再逐步增加消费层复杂度。

---

## 6. 总验收

```text
technical_learning 现有 reader/route 行为不回退
  ∧ paper profile 可返回 manifest/projection/slot/preset/action summary
  ∧ reader.state 是前端和 agent 的布局真相源
  ∧ agent 只能通过 reader.layout.apply typed JSON action 改布局
  ∧ 后端能区分低风险直执和高风险 proposal
  ∧ undo/rev/stale proposal 语义可测
  ∧ 前端按 manifest 渲染 paper workbench,不硬编码 profile policy
  ∧ 论文事实展示和 agent pin 均可回到真实 LID evidence
  ∧ UI theme/style 控制未混入本阶段
```

## 7. 后续回填清单

| 项目 | 回填位置 |
| --- | --- |
| manifest 字段是否需要拆 public/private | ADR-0061 |
| layout action 低/高风险集合实测是否调整 | ADR-0060 |
| paper slot 信息密度和默认 preset | 本文 PF7 / 前端实测 |
| proposal stale 频率和是否需要手动 rebase | ADR-0060 |
| 前端 slot renderer 是否足够支撑第二个非 paper profile | ADR-0061 |
| UI theme/style 控制的独立切片 | 新 ADR / 新切片方案 |
