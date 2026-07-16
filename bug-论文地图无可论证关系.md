# Bug 修复方案 - 论文地图无可用论证关系与局部结构

> 状态:已修复。
> 日期:2026-07-16。
> 适用范围:Agentic paper minimap,不恢复已豁免的 AM13。
> 关联决策:[ADR-0072](docs/adr/0072-agentic-paper-minimap-readonly-projection-and-user-overlays.md)。

## 0. 冻结意图

- 修复 semantic graph 被 hybrid foundation 写回清空的问题。
- 修复 structured abstract/非标准 IMRaD region 无法分类以及同页 region 串地标的问题。
- 让 ModeLens 在 5/4/3 预算内优先保留真实、证据化关系。
- 区分 `unavailable`、`degraded` 和“当前 lens 无匹配关系”。
- 恢复 `.understand-book/1` 的语义图,但不改 paper truth、LID identity、PDF 坐标或用户 overlay。

非目标:

- 不生成新关系或用槽位顺序冒充 argument relation。
- 不重切 canonical source,不重编号 LID。
- 不新增 `paper_minimap.json` 或其他第二 truth。
- 不把旧 AM13 Setup smoke 自动恢复为验收项。

### §0.1 Foundation 与 semantic graph 所有权

**决策**:LID identity 不变时,hybrid foundation 写回必须保留正式 semantic graph。

**否决**:
- 整体采用 candidate `base.json`:会清空 Pass1/Pass2 graph。
- 只从历史 backup 恢复:backup 不是通用续建真相源。
- 缺端点时静默丢 graph:会把构建错误延迟成 Reader 空态。

**命门**:保留后的 graph 必须对 candidate LID 集与自身 edge endpoints 全量复验。
**何时回头**:LID identity 发生变化时拒绝写回,重新执行语义构建。

## 1. 已确认根因

### 1.1 Hybrid foundation 覆盖 semantic graph

当前 `.understand-book/1/base.json` 为 `graph_nodes=0 / graph_edges=0`;第一次写回前备份为 79/84。8 个 Pass1 artifact 仍有非空 nodes/edges,12 条 accepted Pass2 candidate 在旧 graph 上全部能解析端点。

故障链:

```text
buildHybridFoundation()
  -> candidate base.graph_nodes/graph_edges = []
  -> apply-hybrid-foundation-candidate 整体替换 base.json
  -> Pass2 endpoint 全部 missing
  -> PaperMinimapBase.relations = []
  -> arguments layer = unavailable
```

### 1.2 Region topology 对 structured abstract/扁平 IMRaD 不适配

真实论文的 `BACKGROUND/METHODS/RESULTS/CONCLUSIONS` 位于普通 paragraph LID,不是 structural section。当前选择器只取唯一 structural root 的 structural children,得到 14 个 region:12 `unknown`、1 `results`、1 `references`,没有 `abstract/introduction/method`。

### 1.3 Region membership 错用 PDF page span

`minimap_region_contains` 仅比较 `landmark.page_index` 与 region page span。同页 region 会共享地标;实测 Results region 的 slot 混入 `2.48/2.49` 地标。

### 1.4 ModeLens 先选节点再过滤边

恢复旧 graph 的隔离反事实得到 181 landmarks、18 base relations,但 skim/abstract/deep 的 `relation_ids` 仍全为 0。当前算法先选 5/4 个高优先级地标,再只保留两端恰好都在该集合中的边,真实稀疏图因此被过滤为空。

### 1.5 Web 混淆 degraded 与 unavailable

前端在关系为空时把任何非 `available` layer 都显示为“论证关系不可用”;同时忽略 lens warnings,使“未识别到摘要区域”“当前 mode 无匹配关系”和“关系基座缺失”显示成同一种空态。

## 2. 修复算法

### 2.1 Foundation 写回合并

```ts
function mergeHybridFoundationBase(
  official: ReadOnlyBase,
  candidate: ReadOnlyBase,
): ReadOnlyBase
```

```text
assert official.book_id == candidate.book_id
assert sameLidIdentity(official, candidate)
validate graph node anchors against candidate LIDs
validate every edge endpoint against official graph nodes

return {
  ...candidate,
  graph_nodes: official.graph_nodes,
  graph_edges: official.graph_edges,
}
```

写回报告增加 `semantic_graph_preserved` 与写回前后 graph digest。任一复验失败时,正式 artifact 保持原样。

### 2.2 Region 识别与归属

分类顺序:

```text
exact normalized heading
  -> deterministic structured-abstract paragraph run
  -> inherited explicit major section for flattened subsections
  -> unknown
```

- 连续命中 `BACKGROUND|OBJECTIVE|AIM|METHODS|RESULTS|CONCLUSIONS` 中至少两类、且包含 result/conclusion 的前置 paragraph run,生成一个逻辑 `abstract` region。
- 独立成行的显式 `methods/results/discussion/conclusion` major heading 建立顺序上下文;其后的扁平 sibling 可继承 major kind,遇到 end matter 或新的显式 major heading 截止。
- BookStructure spine role 继续只生成地标,不得改写 region kind。
- region 坐标仍来自真实 LID/PDF map;classification fallback 不改变坐标。
- landmark 归属改为数值 LID path 的闭区间比较,不再按 page span 判断。

### 2.3 Relation-aware lens

```text
eligible_edges = filter_by_mode_region_evidence(base.relations)
selected_edges = pack_edges(eligible_edges, node_budget, relation_budget=3)
visible_nodes = endpoints(selected_edges) + ranked_fill(remaining_budget)
```

- skim:全局节点预算 5。
- abstract:当前 abstract 局部节点预算 4。
- deep:当前 region 局部节点预算 4;关系至少一端位于当前 region。
- edge 排序固定为 relation type、证据 LID 顺序、source ID、target ID、relation ID。
- 任何 mode 无 eligible edge 时返回空 `relation_ids`,不得合成边。

### 2.4 Web 状态表

| Base/lens 状态 | 展示 |
|---|---|
| arguments `unavailable` | 论证关系不可用 + reason |
| arguments `degraded`,lens 有关系 | 渲染关系 + 部分降级提示 |
| arguments `available/degraded`,lens 无关系 | 当前模式暂无证据化关系 |
| abstract focus 缺失 | 未识别到摘要区域 |
| deep focus 为 unknown | 当前区域未分类,无法生成局部论证结构 |

## 3. 实现切片

### PMF1 - 修复方案落档

- **Status (2026-07-16)**:complete。

- **Do**:冻结根因、算法、测试矩阵与恢复门禁。
- **Do not**:修改可执行代码。
- **Done**:本文档可独立指导实现,术语与 ADR-0072 一致。

### PMF2 - Foundation graph preservation

- **Status (2026-07-16)**:complete。

- **Do**:提取可测试的 merge/validate helper,stage merged base,报告 graph digest。
- **Do not**:恢复具体书库或改 minimap projector。
- **Done**:same-LID candidate 保留 graph;LID/graph/edge 任一悬空均在写回前拒绝。

### PMF3 - Region projection and LID membership

- **Status (2026-07-16)**:complete。

- **Do**:structured abstract、major-heading inheritance、LID-span containment。
- **Do not**:改 relation selection 或 Web 文案。
- **Done**:真实压力 fixture 产出 abstract/introduction/method/results;同页 region 不串地标。

### PMF4 - Relation-aware ModeLens

- **Status (2026-07-16)**:complete。

- **Do**:先选证据边再填节点,保持 5/4/3 预算。
- **Do not**:生成 base 中不存在的边。
- **Done**:稀疏 graph fixture 三 mode 保留各自合法关系;无 eligible edge 诚实为空。

### PMF5 - Web truthful empty states

- **Status (2026-07-16)**:complete。

- **Do**:展示 unavailable/degraded/empty 与 lens warning 的不同状态。
- **Do not**:在前端推断 region 或关系。
- **Done**:component tests 与 desktop/mobile Playwright 文案、布局断言通过。

### PMF6 - Current artifact recovery and closure

- **Status (2026-07-16)**:complete。

- **Do**:由 `.build/pass1/.build/pass2` 确定性重闭合 semantic graph,临时目录验收后原子写回;同步代码链路、架构与 checkpoint。
- **Do not**:以 backup 整体覆盖现有 foundation,不提交私有/临时书库 artifact。
- **Done**:source/PDF/LID hash 不变;Pass2 accepted endpoint 全解析;真实 endpoint 三 mode 状态符合本方案;全量门禁通过。

## 4. 测试矩阵

| 层 | 必测场景 | 判据 |
|---|---|---|
| Core | same-LID foundation candidate + nonempty official graph | graph digest 不变 |
| Core | changed LID identity / dangling graph anchor / dangling edge | 写回前拒绝 |
| Read | structured abstract paragraphs | abstract region 存在且 span 正确 |
| Read | flattened methods/results + standalone major marker | kind 确定性继承 |
| Reader | two regions share one PDF page | local slot 仅消费 LID span 内地标 |
| Reader | sparse evidence graph | 5/4/3 内保留合法 relation |
| Reader | no eligible relation | 空数组且无伪造 ID |
| Web | unavailable/degraded/empty/warning | 四种文案不混淆 |
| Integration | `.understand-book/1` isolated endpoint | base relations 非零,mode 输出与 warning 真实 |

## 5. 恢复与回滚门禁

恢复前记录:

- canonical source、original PDF、source manifest、PDF map、LID identity hash。
- 当前与历史 graph counts/digest。
- Pass1/Pass2 artifact freshness。

恢复后必须满足:

- foundation hashes与 LID identity 不变。
- graph node anchor、edge endpoint、Pass2 accepted endpoint 零悬空。
- `PaperMinimapBase` 仅允许 semantic fingerprint、landmarks/relations/layer status 变化。
- 任一门禁失败即保留原文件并输出诊断,不允许 partial write。

## 6. 完成定义

- PMF1-PMF6 全部完成并逐刀验证。
- Rust、Core、Web unit/typecheck/build 全绿。
- desktop/mobile Playwright 证明关系、空态和长标题无重叠,PDF 几何不变。
- 真实本地 endpoint 证明受影响论文不再把所有 mode 误报为“论证关系不可用”。
- 代码链路与架构文档反映新 ownership 和数据流;SESSION_CHECKPOINT 可冷启动接手。

## 7. 实施结果

### 7.1 Artifact 恢复

- 隔离副本 Pass1:8/8 windows fresh,90 个输入节点合并为 79 个节点,72 条 local edge,零 node/edge drop。
- 隔离副本 Pass2:4 个有效分类窗口,12 条 accepted long-range edge,0 pending,11 条 accepted input 被确定性 gate 丢弃。
- 写回前验证 21 个 source/PDF/selection/reconciliation foundation 文件;LID foundation digest 为 `9cc0622763bb06e93cb745f32da1a4669c099a3c569e96fbed58d5b7573c27d7`。
- 仅原子替换 `base.json`、`long_range_candidates.json`、`pass2_audit.json`;正式 graph 由 0/0 恢复为 79 nodes / 84 edges(72 local + 12 long-range)。
- 回滚备份:`.understand-book/1/.build/paper-semantic-graph-recovery-backup-2026-07-16T11-13-08-425Z`。隔离 workspace、target、memory、日志与 8793 Server 均已清理。

### 7.2 真实 endpoint

| Mode | Focus / local structure | Relations | 解释 |
|---|---|---:|---|
| skim | global 5 | 3 | 关系图可用,不再被 top-5 节点预筛清空 |
| abstract | synthetic `2.27-2.32`;method/result 2 slots;2 correspondences | 0 | 当前摘要没有内部 evidence edge,合法 empty,不是 unavailable |
| deep | results `region:2.51`;evidence/result/claim 3 slots | 2 | local anchors 均在 `2.51` LID span,无同页串区 |

Base endpoint 为 15 regions、181 landmarks、18 relations;arguments 为 `degraded` 而非 `unavailable`,原因是仍有部分 relation source/candidate 不可用。Web 会渲染已有关系并显示部分降级提示。

### 7.3 预构建责任闭环

预构建对此故障负直接、主要责任,不是单纯的 Reader 展示问题:

- `hybrid foundation` 产出的 candidate graph 本来为空;旧的 candidate apply 路径整体替换正式 `base.json`,直接抹掉了已闭合的 Pass1/Pass2 graph。
- Workbench 的进程内 `runHybridFoundation()` 还存在一条绕过 candidate apply helper 的直接写回路径;同 LID 重跑同样可以再次清空 graph。
- 自动预构建旧的 Pass1 `closed` 判据只检查 `profile_metadata.json` header 与 `long_range_candidates.json` 是否存在,没有核对正式 graph,因此“artifact 完整、base graph 已空”的 workspace 会被误判为绿色并跳过恢复。
- Reader/Web 的旧空态合并放大了问题,但它是次级症状:上游 graph 已经被写坏,三个阅读 mode 共享同一空关系基座。

闭环后的确定性不变量:

- 外部 candidate apply 与 Workbench 进程内重跑都在 LID identity 相同时保留并复验正式 semantic graph;LID 改变时不沿用不兼容 graph。
- 自动预构建从所有 fresh Pass1 artifacts 重新执行 `mergeAndGate`,要求期望 nodes/local edges 与 `base.json` 精确一致后才承认 Pass1 closed;不一致会返回 `close_stage: pass1`,由 `--preserve-foundation` 路径确定性重闭合。
- 该保护不改抽取算法、不生成关系、不改 LID/PDF truth,只阻止写坏与假绿。

### 7.4 最终门禁

- Rust:`read-tools 126 + reader 54 + runtime 144 + server 153` 全绿。
- Core:218/218;typecheck 通过。
- Web:全量 Vitest 通过;typecheck + production build(1912 modules)通过。
- PaperMinimap component:11/11;Playwright desktop 1440x900 + mobile 390x844 = 2/2。
- `cargo fmt --check`、`git diff --check` 通过;仅保留仓库既有 ts-rs serde warning 与 Vite chunk-size warning。
