# ADR-0061 Profile Plugin Framework / 预构建后端前端三模块按 content_profile 插拔

状态:已接受(2026-07-05,Profile Plugin Framework §0.5 grill)

## 背景
ADR-0048 已把预构建抽取规则包化,让 `technical_learning` 与 `paper` 通过 `content_profile` 接入固定 build pipeline 插槽。paper 消费层讨论进一步暴露:如果只有预构建按 profile 插拔,后端读时/agent policy 和前端消费 UI 仍会继续堆散乱 `if paper` 分支。用户要求形成一套框架,让预构建、后端读时/agent、前端消费三大模块都能根据 profile 即插即用。

## 决策
1. **建立 Profile Plugin Framework**:同一个 `content_profile` 同时驱动 build rules、runtime policy/projections 和 frontend consumption。
2. **前后端各自 registry**:后端 registry 管 build rules、runtime policy、projection contracts、evidence gate 和 profile manifest;前端 registry 管 profile 组件槽位、布局渲染和交互 affordance。
3. **共享 contract 由后端 Rust 拥有**:第一版 `ProfileManifest` / UI slot / layout/action/tool/policy contract 由 Rust 定义,用 `ts-rs` 导出给前端。
4. **第一版 manifest 覆盖消费期关键契约**:包含 `profile_id/profile_version/projections/ui_slots/layout_presets/allowed_layout_actions/agent_tools/guided_reading_policy`;完整 build 规则不塞进读时 manifest。
5. **`book.guided_route_from` profile-aware**:保留同一工具名,根据当前 book 的 `content_profile` 选择 guided reading policy;不为每个 profile 新增 route 工具。
6. **frontend registry 负责渲染,不拥有 truth**:前端根据 manifest slot id 选择组件和布局;不得拥有 book/paper truth、plan truth、citation policy 或 evidence gate。
7. **paper 是首个验证 profile**:paper 第一版 slots 为 `paper.structure_map`、`paper.agent`、`paper.evidence`、`paper.codebook`、`paper.abstract_aid`、`paper.ten_questions`;presets 为 `paper_skim`、`paper_abstract`、`paper_deep_read`。
8. **technical_learning 也归入框架**:当前默认 profile 需要从隐式默认收敛为 registry 中的显式默认实现。
9. **manifest 是静态能力契约**:`ProfileManifest` 不保存当前布局状态;动态会话态属于 `ReaderLayoutState`。
10. **projection spec 显式双锚**:`ProjectionSpec` 同时包含语义 `id/kind` 与现有 endpoint/tool/type 信息,便于第一版前后端调试和迁移。
11. **slot 可声明多 projection 依赖**:`UiSlotSpec` 有 primary/secondary projections,避免前端组件私自隐式拉取能力。
12. **preset 声明 workspace placement**:`LayoutPresetSpec` 描述 slot 所在 region/order/size/focus,但不下发 CSS/grid 细节。
13. **profile manifest 独立命名空间**:完整 manifest 走 `profile.manifest` / `/profile/manifest`;`reader.state` 只返回 profile summary 与 manifest version。
14. **agent 只拿操作摘要**:`reader.state` 给 agent 暴露 slots/presets/allowed layout actions 摘要,不塞完整 schema。

## 命门
- **Core/Profile 分离不变**:LID、source/book.text、citation anchor、确定性 gate 和 Core 命令面不因 profile 改变。
- **同机制换策略**:带读 loop、route 内核、reader command surface 保持共享;profile 只换 policy、projection 和 UI affordance。
- **contract 不等于动态 UI 引擎**:后端发布能力与槽位,前端负责高质量组件实现。

## 否决
- 只扩 build profile:读时/前端继续散落 `if paper`。
- 后端下发完整动态布局由前端通用渲染:前端质量差且难维护。
- 每个 profile 新增一套 route/tool 命令:命令面膨胀,agent prompt 复杂化。
- 第一版 manifest 吞下完整 build 规则:过大,会把构建期与读时契约绑死。

## 何时回头
- 第二个非 paper profile 接入时,检查 manifest 字段是否足够泛化。
- 前端 profile registry 出现大量重复组件时,再抽共享 slot component 基类。
- build profile 与 runtime manifest 出现版本漂移时,补 profile compatibility/migration gate。

## 影响
- `CONTEXT.md` 的 Profile Plugin Framework 术语指向本 ADR。
- 后续实现需新增后端 profile registry 与 Rust `ProfileManifest` ts-rs 导出。
- `book.guided_route_from` 后续改为按 `content_profile` 选择 policy。
- 前端后续新增 FrontendProfileRegistry,按 slot/preset 渲染 profile workbench。
- ADR-0060 的 Reader UI Control Plane 是本框架在 reader layout 控制面的配套决策。
