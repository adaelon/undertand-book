# Reader Markdown 正文性能治理切片方案

状态:PHR3 已完成（2026-08-12）；下一刀为 PHR4。
基线 revision:`e64d5f0`。
冻结决策:[ADR-0105](adr/0105-bounded-reader-buffer-stable-rendering-and-batched-source-loading.md)。
既有边界:[ADR-0043](adr/0043-reader连续滚动视口-后端区间窗口-前端虚拟流-note-overlay.md)、[ADR-0024](adr/0024-book-text原文旁路source文件-span口径utf16-s4服务先库后http.md)。

## 0. 对齐确认单

**FrozenIntent**:新增一份 reader 性能 ADR 和一份分阶段切片方案，覆盖有界虚拟缓冲、滚动定位、Markdown/KaTeX 重渲染、目录首屏阻塞、正文与公式批量加载；本轮不改生产代码。成功标准是每个问题都有决策边界、独立验收、指标和回滚。

**TermMap**:

| 术语 | 状态 | 本方案口径 |
| --- | --- | --- |
| 区间视口 | EXISTING | ADR-0043 的后端 `top..bottom` 阅读窗口 |
| 虚拟阅读流 | EXISTING | 边缘补入且反向回收的连续 Markdown 展示策略 |
| Markdown reader | EXISTING | `ReaderPane.vue` 中非 PDF 的正文阅读表面 |
| LID / UTF-16 span | EXISTING | 唯一引用锚与 `book.text` 的切分坐标 |

**RiskReceipt**:用户已知悉变高 Note/图片/KaTeX 回收可能造成跳位和选区丢失、范围批取可能破坏 UTF-16/LID 边界，并明确要求继续。

**ChangeType**:[纯技术]；让实现重新服从 ADR-0043，不改领域语义。

## 1. 现状、证据等级与范围

当前 revision 的静态执行路径如下；在 PHR1 完成前全部保持 High-value hypothesis，不写成 measured finding。

| 优先级 | 路径 | 机制 | 当前放大条件 |
| --- | --- | --- | --- |
| P0 | `ReaderPane.onScroll -> currentLidAtProbe`；`App.onScrollEdge -> mergeSegments` | append-only 保留全部 segment；每帧全 DOM 查询和布局读取 | 长书持续下滑，代表书 2,623 leaves |
| P1 | `current-lid -> App currentReadingLid -> ReaderPane update -> renderSeg` | 模板调用 Markdown/KaTeX；annotation 与 focus 按 segment 重复扫描 | 已挂载 segment 多、公式或标注多 |
| P1 | `init -> loadOutlineTitles -> api.text × outline` | 目录标题全部完成前不加载首批正文，容器正文还相互重叠 | 启动、切书、目录层次多 |
| P2 | `onScrollEdge -> hydrateSegments -> api.text × width -> formulaSemantics × F` | 单项请求、JSON 解析和共享 AppState lock 边界次数多 | 冷滚动、公式密集窗口 |

代表性 `quantification-essence/base.json` 在当前工作区机械统计为 2,757 nodes、2,623 leaf LIDs、893 formula leaves。当前没有同 revision 的 reader Performance trace、Long Task、heap、渲染计数或网络瀑布。

本方案只覆盖 Markdown reader。PDF.js 页面虚拟化、预构建性能、Agent 回答、memory 存储模型、LID/schema 真相和 Reader 命令所有权不在范围内。Note 保持 ADR-0043 后来接受的段内卡片模型，不恢复 S12d overlay；虚拟 item 的高度必须包含 Note。

## 2. 冻结运行模型

```ts
type ReaderBufferState = {
  sourceFingerprint: string;
  startLeafIndex: number;       // inclusive
  endLeafIndex: number;         // exclusive
  mountedLids: string[];        // contiguous leaf-order slice
  topSpacerPx: number;
  bottomSpacerPx: number;
  viewportWidth: number;        // backend viewport.width
  epoch: number;                // goto/book/source change invalidates stale work
};

type BufferBudget = {
  settledMountedLids: 3 * viewportWidth;   // default 60
  transitionMountedLids: 4 * viewportWidth; // one in-flight batch only
  contentCacheEntries: 5 * viewportWidth;  // default 100
  htmlCacheEntries: 5 * viewportWidth;
};

type BufferTransition = {
  insertRange: [number, number];
  evictRange: [number, number] | null;
  preserveAnchorLid: string;
  direction: "up" | "down";
  epoch: number;
};
```

稳定 render item 由相邻 LID 的现有 flow 规则确定，key 为有序 LID 集；分批边界不得改变分组结果。高度账本以 render-item key 记录最后一次同宽度/同内容 revision 的实测 block height，包含 Note、图片和 KaTeX；宽度、字体尺度、source fingerprint 或 renderer version 改变时使旧高度失效。

```text
scroll frame
  -> rAF coalescer
  -> visible LID registry resolves 28% probe
  -> emit current-lid only on change
  -> edge IntersectionObserver schedules at most one transition
  -> reader.scroll(+/-width) obtains authoritative interval
  -> hydrate missing contiguous range
  -> commit insert + opposite eviction
  -> next frame correct scrollTop from preserved anchor
  -> ResizeObserver refreshes item heights and spacer ledger
```

非折叠原生选区或 Note 指针手势开始后，回收进入 `trim_pending`；最多允许一个 incoming window。手势结束先转换成现有 LID/UTF-16 selection/placement 状态，再执行回收。若仍未结算，不再发第二个 edge load。Note 展开态等必须跨回收保持的 UI 状态提升到以 `mem_id` 为 key 的非 DOM 状态。

## 3. 批取与失效契约

```ts
type TextRangeReply = { lid: string; text: string };

function splitUtf16Range(
  reply: TextRangeReply,
  requestedLeaves: ManifestNode[],
): Map<string, string>;

// GET /book/formula_semantics_range?start=<lid>&end=<lid>
type FormulaSemanticsRangeReply = {
  start_lid: string;
  end_lid: string;
  items: FormulaSemantics[]; // only found items
};
```

`splitUtf16Range` 只接受按 leaf order 连续、span 单调且落在 `[first.span.start,last.span.end)` 的节点。对每个 LID 使用 `reply.text.slice(node.span.start - first.span.start, node.span.end - first.span.start)`；JavaScript slice 与 Manifest 都以 UTF-16 code unit 计。响应总长度、逐段长度、首尾 identity 或顺序任一不符即失败关闭。

一个全冷连续窗口的允许请求形状为:

```text
1 × POST /reader/scroll
1 × GET  /book/text?lid=<first>&end=<last>
0..1 × GET /book/formula_semantics_range?start=<first>&end=<last>
0 × per-LID title request
0 × per-LID text/formula request
```

缓存 key 至少含 `source_fingerprint + lid`；基础 HTML 再含 `renderer_version + text`。Highlight、Note、selected、anchor 和 source focus 不进入基础 HTML key。换书、换源、renderer version 变化清空相关缓存；annotation revision 只重建按 LID 索引和受影响 overlay。正/负公式缓存都受 `5 * width` LRU 上限约束。

## 4. 测量与发布硬门

PHR1 先建立基线，后续每刀复用同一 harness。输入采用确定性 2,623 叶 mock API fixture；公式分布覆盖 893 个 formula leaves，并以真实 `quantification-essence` 在 WebView2 复放。每个场景预热 2 次、正式 5 次，分别穿过第 20、500、1000、2623 叶并滚到目标附近 80% 位置。

| 指标 | 采集方式 | 最终硬门 |
| --- | --- | --- |
| `mounted_lids` / `[data-lid]` | app counter + DOM query | 稳定态 `<=3w`；事务态 `<=4w` |
| content/HTML cache entries | cache diagnostics | 各 `<=5w` |
| probe 次数与候选数 | `performance.measure` + counter | 每 animation frame `<=1`；候选不超过挂载集 |
| Markdown/KaTeX 调用 | renderer counter | 纯 current-LID 变化为 0；补页不超过新增/失效 LID 数 |
| 请求数与字节 | Playwright request ledger | 满足 §3 冷窗口请求形状 |
| 帧与 Long Task | rAF delta + PerformanceObserver | 参考机滚动 p95 frame interval `<=32ms`；归因于 reader scroll 的 `>50ms` Long Task 为 0 |
| probe self time | User Timing | 参考机 p95 `<=2ms`，且 500/1000/2623 深度不呈单调增长 |
| 滚动锚误差 | 固定/变高 item Playwright | 事务结算后 preserved anchor top 误差 `<=2px` |
| heap | Chromium precise memory（可用时） | 报告峰值与 settled 值；以结构上限为硬门，不用单次 GC 数字判绿 |
| 首批正文关键路径 | performance marks + request ledger | `reader:first-segment` 前无 outline `book.text`；目录规模不改变请求数 |

正确性门优先于性能门:逐 LID 文本必须与旧单项 API byte-for-byte 等价；LID 顺序、current LID、goto top、双向滚动、Highlight ranges、Note 展开/编辑/删除/来源跳转、原生选区、图片和公式渲染全部保持。任何正确性失败直接红，不用更快的数字抵消。

## 5. 切片依赖

```text
PHR0 docs
  -> PHR1 baseline
       -> PHR2 scroll hot path
            -> PHR3 bounded-buffer reducer
                 -> PHR4 DOM eviction + anchor/height lifecycle
                      -> PHR5 stable rendering/indexes
       -> PHR6 range text + formula API
            -> PHR7 batched hydration + bounded caches
       -> PHR8 non-blocking outline projection

PHR4 + PHR5 + PHR7 + PHR8 -> PHR9 end-to-end release gate
```

PHR2、PHR6、PHR8 在 PHR1 后可独立推进，但不得跳过各自前置；PHR9 前不删除回滚开关。每刀只修改列出的责任，不夹带相邻重构。

## 6. PHR0 - 决策与切片冻结 [Docs]（已完成）

**输入**:Performance Hints 静态审查、ADR-0043、当前 `e64d5f0` 执行路径、用户风险回执。

**做**:新增 ADR-0105 与本切片方案，冻结证据等级、缓冲/缓存上限、UTF-16 批取、测量门、依赖和回滚边界。

**不做**:不改生产代码、测试、现有 ADR/CONTEXT、代码链路或 checkpoint；不声称性能已改善。

**产出**:
- `docs/adr/0105-bounded-reader-buffer-stable-rendering-and-batched-source-loading.md`
- `docs/切片方案-reader有界虚拟流与批量正文加载.md`

**确定性验收**:ADR 编号唯一；双向链接存在；两文件可 UTF-8 读取；`git diff --check` 通过；diff 除两份新增文档外不包含本刀产生的文件。

**回滚**:删除两份新增文档即可，不影响运行时。

## 7. PHR1 - 长书滚动基线与计数器 [Test/Diagnostics]

状态:已完成；只建立基线与诊断，不宣称性能收益。

**输入**:PHR0；revision `e64d5f0`；§4 指标表。

**做**:新增 2,623 叶确定性 reader API fixture、滚动驱动器、rAF/Long Task/DOM/request/renderer/probe 计数和有界 JSON 报告；在真实书/WebView2 保存同 schema 回执。诊断只在 test/perf mode 开启。

**不做**:不优化滚动、渲染或请求；不根据首次结果调整测试输入；不把 mock 结果宣传为桌面端收益。

**产出**:可重复的 `reader-performance.spec.ts` 与 baseline report，报告含 revision、runtime、机器、warm-up、repetitions 和每次原始样本。

**确定性验收**:
- `pnpm -C packages/web test`
- `pnpm -C packages/web test:e2e -- reader-performance.spec.ts`
- 同一 fixture 两次运行产生相同结构计数；时间指标保留原始分布而非伪造固定值。
- 报告能区分 scroll、probe、render、edge-load 和 first-segment；缺字段即失败。

**完成证据**:
- `packages/web/src/reader-performance.ts` 提供 query-gated、有界样本诊断；`App.vue`、`ReaderPane.vue` 与 `main.ts` 只在 dev 或 `VITE_READER_PERF=1` 编译诊断入口，production bundle 检查确认无诊断标记。
- `packages/web/playwright/reader-performance.spec.ts` 固定 2,623 leaves / 893 formula leaves / 134 outline nodes，保存的两份 Chromium 2+5 报告结构签名完全一致。
- `packages/web/scripts/record-reader-performance-webview2.mjs` 先核对 active manifest 的 2,757 / 2,623 / 893 / 134 形状与完整 outline LID 集，再采集真实书；首屏 ledger 必须为 134 个 outline title + 1 个 chapter title，否则拒绝写报告。
- canonical WebView2 报告为 `docs/performance/reader-performance-webview2-quantification-essence.json`：2 次预热、5 次正式、`structure_consistent=true`，每轮终点均为 2,623 mounted LIDs / 893 formula LIDs，诊断字段零缺失。

**基线读数**（WebView2 151，5 次正式；仅描述旧路径）:

| 检查点 | mounted/probe candidates | frame interval p95 | probe self p95 |
| --- | --- | --- | --- |
| 20 | 20 | 6.2 ms | 0.2-0.3 ms |
| 500 | 580 | 24.2-48.6 ms | 10.7-13.3 ms |
| 1000 | 1040 | 2078.8-2569.7 ms | 17.0-22.5 ms |
| 2623 | 2623 | 5006.2-5460.7 ms | 36.5-42.8 ms |

首屏每轮为 135 次 outline text + 20 次 leaf text；末端仍挂载全部 2,623 LID，证明 append-only DOM、全挂载 probe 和逐 LID 请求是后续切片需要压平的已测基线。frame interval 包含 fixture 驱动的补页/渲染阶段，不单独解释为用户稳态滚动延迟。

**验证回执**:
- `pnpm -C packages/web test`：39 files / 217 tests 通过。
- `pnpm -C packages/web test:e2e -- reader-performance.spec.ts`：1/1 通过，完整 2+5 轮。
- `pnpm -C packages/web test:perf-bundle`：typecheck、production build 与诊断 bundle 隔离门通过。
- `pnpm -C packages/web test:perf-webview2`：真实书 2+5 轮通过并重生成 canonical report。

**回滚**:删除 perf-only fixture/计数器；生产 bundle tree-shake 后不得含诊断入口。

## 8. PHR2 - 可见注册表、按帧探针与边缘哨兵 [Web]

状态:已完成；只收敛滚动热路径与边缘请求身份，不引入 DOM 回收。

**输入**:PHR1 baseline；现有 28% current-LID probe 语义。

**做**:为挂载 LID 建立元素注册表与可见集合；用一个 rAF coalescer 结算 current LID 和 buffer need；用 IntersectionObserver 观察上下 edge sentinel；移除 wheel/keydown 在硬边缘等待 I/O 的 `preventDefault` 分支，并以 epoch + direction 去重边缘请求。

**不做**:不回收 segment、不改 hydration API、不缓存 HTML、不改 current-LID 探针位置。

**产出**:ReaderPane 滚动热路径只依赖可见/挂载注册项，原生滚动不被网络等待拦截。

**确定性验收**:
- ReaderPane 单测证明 1000 个已挂载测试节点下每帧只结算一次，scroll path 不调用 `querySelectorAll`。
- probe 穿过段边界、Note 间隙、公式和图片时仍返回确定 LID；只在变化时 emit。
- 上下 sentinel 各最多一个 in-flight；stale epoch 回执不提交。
- `pnpm -C packages/web test && pnpm -C packages/web typecheck && pnpm -C packages/web build`。

**完成证据**:
- `ReaderPane.vue` 以模板 ref callback 维护 `Map<LID, HTMLElement>`，IntersectionObserver 维护可见 LID 与上下 sentinel；scroll、observer、props 更新统一进入一个 rAF coalescer，28% probe 只读取有序可见候选，LID 未变化不 emit。
- wheel 使用 passive 原生滚动；Arrow/Page 键只在仍可滚动时接管平滑滚动，硬边缘不再 `preventDefault` 等待 I/O。无 IntersectionObserver 时保留注册表之外的几何 edge fallback，但 scroll probe 仍不查询 DOM。
- `ReaderEdgeLoadGate` 以 `epoch + direction + requestId` 允许上下方向各一个 in-flight；`loadWindow(...,"replace")`、goto/reader 同步和切书使旧 epoch 失效，stale 成功或失败均不能提交或污染新上下文。
- `ReaderPane.test.ts` 用 1,000 个挂载节点证明同帧 8 次 scroll 只结算一次、scroll path 不调用 `querySelectorAll`、current LID 只在变化时 emit，并覆盖段边界、Note 间隙、公式、图片、sentinel 帧内去重和硬边缘原生输入；`reader-edge-load.test.ts` 覆盖上下单 in-flight 与 stale commit fail-closed。
- `pnpm -C packages/web test`：40 files / 225 tests；`typecheck`、`build`、`test:perf-bundle` 均通过。
- `docs/performance/reader-performance-chromium-phr2.json`：同一 2+5 harness 的 5 次正式轮结构一致；20/500/1000/2623 深度均为 `probe.max_candidates=8`、`probe.max_calls_per_frame=1`、`scroll.max_checks_per_frame=1`、edge failed=0，挂载/公式/请求结构与 PHR1 Chromium baseline 相同。probe p95 为 3.8-5.3 ms，已消除随深度增长但尚未达到 §4 最终 `<=2ms` 门；该布局成本需与 PHR4 有界 DOM 后复验，不在 PHR2 宣称最终发布收益。

**回滚**:恢复旧 probe/scheduler；与 segment 数据结构无耦合。

## 9. PHR3 - 有界缓冲纯 reducer [Web/Core-free]

状态:已完成；reducer 已接入 segment identity 影子状态，但实际 `segments` 与 DOM 回收仍留给 PHR4。

**输入**:PHR2 注册表事件；leafOrder、viewport.width、当前 buffer interval 和交互 pin 状态。

**做**:新增纯 `planBufferTransition/commitBufferTransition`，只计算连续 insert/keep/evict ranges、anchor 和 epoch；冻结稳定态 `3w`、事务态 `4w`、单 in-flight、两端 clamp、goto/book/source reset 与 `trim_pending` 状态机。

**不做**:不触碰 DOM、不测高度、不发 HTTP、不改变 App 当前 `segments`。

**产出**:可由 property test 穷举的小状态机，后续 PHR4 只消费 transition，不在组件里重写策略。

**确定性验收**:
- 对 0/1/20/2623 叶、两端、反向、重复回执、stale epoch、连续 200 次下滑再上滑做表驱动测试。
- 每次 committed buffer 严格连续、无重复、顺序等于 leafOrder；稳定态不超过 `3w`。
- 手势 pin 时最多接受一个 incoming window；手势结束必清偿至 `3w`。
- 随机序列 fixed seed property test 不变量全绿。

**完成证据**:
- `packages/web/src/reader-buffer.ts` 提供纯 `replaceReaderBuffer/planBufferTransition/commitBufferTransition/abortBufferTransition/setReaderBufferPin`；状态显式区分 `settled/loading/trim_pending`，以 `sourceFingerprint + epoch + transitionId` 拒绝 stale/重复回执。
- plan 只生成连续半开 `insert/keep/evict/transient/settled` ranges；稳定态上限 `3w`、单 incoming 事务/trim debt 上限 `4w`，书首书尾 clamp，selection 与 Note pin 全部释放后才结算 trim。
- `App.vue:loadWindow/onScrollEdge/resetBookSessionUi` 维护 reducer 的 segment identity 影子状态；replace/goto/source reset 重建 epoch，edge token 当前时才提交 reducer。现有 `segments` 仍按 PHR2 append/prepend，不消费 `evictRange`，因此本刀不触碰 DOM、高度或滚动锚。
- `reader-buffer.test.ts` 覆盖 0/1/20/2623 叶、精确上下 ranges、两端 clamp、全局单 transition、abort/retry、duplicate/stale、goto/换书/换源 reset、selection/Note 双 pin、连续 200 次下滑再上滑与 1,000 步 fixed-seed 混合序列；静态接入门拒绝 PHR3 提前执行 segment eviction。

**验证回执**:
- `pnpm -C packages/web test`:41 files / 241 tests；`pnpm -C packages/web typecheck`、`pnpm -C packages/web build`、`pnpm -C packages/web test:perf-bundle` 全部通过。
- PHR3 不改变实际挂载结构或请求形状，不宣称性能收益；长书报告保持 PHR2 基线，PHR4 接通有界 DOM 后按 §4 复验。

**回滚**:删除 reducer、测试与 App identity shadow hooks；现有 append-only 运行时行为不受影响。

## 10. PHR4 - DOM 回收、变高账本与滚动锚 [Web]

状态:已完成；`bounded_buffer_v1` 已消费 reducer receipt 并实际限制 Markdown DOM，旧 append-only 路径只保留为发布期回滚。

**输入**:PHR3 transition；PHR2 元素注册表；现有 segment/Note/image/formula DOM。

**做**:把 App/ReaderPane 接到 reducer；按稳定 render-item 测量高度，维护 top/bottom spacer；insert 与反向 eviction 同事务提交，下一帧按 preserved anchor 修正 `scrollTop`；ResizeObserver 吸收 Note 展开、图片解码和 KaTeX 布局变化；边缘跨窗调用现有 `reader.scroll` 保持 ADR-0043 后端状态。

**不做**:不改变 Note memory、Highlight/LID 语义，不批取正文，不缓存 Markdown HTML，不虚拟化 PDF。

**产出**:`bounded_buffer_v1` 开关下的真正有界 Markdown 虚拟流；旧 append-only 仅作发布期回滚。

**确定性验收**:
- 固定高度、混合变高 Note、延迟图片、公式四种 Playwright fixture 双向穿过 2,623 叶，稳定挂载 `<=60`、事务 `<=80`。
- preserved anchor 结算误差 `<=2px`；current LID 单调前进/后退，goto 后目标仍到 pane top。
- Note open state、编辑/删除、来源跳转、Highlight ranges、selection/placement 手势在回收前先固化且回收后可恢复。
- Reader/server 既有 scroll/goto 测试、Web unit/typecheck/build、reader performance spec 全绿。

**完成证据**:
- `reader-height-ledger` 以 source/layout/renderer identity 保存稳定 render-item 实测块高，未知叶使用有界估值；ReaderPane 用 ResizeObserver 更新账本并投影 top/bottom spacer，Note 展开态以 `mem_id` 脱离可回收 DOM。
- `App.vue:onScrollEdge` 先经串行 Reader command queue 提交权威 `reader.scroll`，再在 current edge token 上合并 hydration、提交 reducer receipt 并把 `segments` 投影到 mounted LID slice；replace/goto/source epoch 使旧成功和失败回执失效。
- selection/Note pin 将 eviction 延后为 `trim_pending`，最后一个 pin 释放后投影 settled range 并恢复 preserved anchor；每次 wheel/键盘交互最多解锁一个同方向 edge transition。
- `reader-bounded-buffer.spec.ts` 在固定、Note、延迟图片、公式四种真实 DOM fixture 中各双向穿过 2,623 叶，并覆盖 goto、Highlight、原生选区、Note 展开/编辑/删除/来源跳转与 pin 清偿。

**验证回执**:
- 四 fixture 4/4：固定/Note/图片最大锚误差 `0.03125px`，公式 `0.484375px`；settled limit `60`、transient limit `80`，观察到的最大挂载分别为 `80/60/60/60`。
- `pnpm -C packages/web test`：44 files / 261 tests；`typecheck`、`build`、`test:perf-bundle` 全部通过，production bundle 无 reader performance 诊断入口。
- `reader-performance.spec.ts` 完整 2 次预热 + 5 次正式回放 1/1 通过；driver 通过真实 wheel/scroll 交互穿过同一边缘门，报告写入 `docs/performance/reader-performance-chromium-phr4.json`。

**回滚**:关闭 `bounded_buffer_v1` 回到旧 append-only；不回滚 PHR2 热路径改进。

## 11. PHR5 - 稳定 segment 渲染与 annotation 索引 [Web]

**输入**:PHR4 有界 render items；PHR1 renderer counter。

**做**:把 render item/segment 隔离为稳定组件；缓存不含 overlay 的基础 Markdown/KaTeX HTML；一次构建 `annotationsByLid/highlightsByLid/highlightCardsByLid/notesByLid` 与 source-focus ranges；只让输入 revision 变化的 LID 失效。HTML LRU 上限 `5w`。

**不做**:不缓存最终 `<mark>`/Note DOM，不预渲染全书，不改变 Markdown、KaTeX 或 Highlight 输出。

**产出**:current LID/anchor class 改变不重新解析正文，补页只渲染新增或真正失效的 segment。

**确定性验收**:
- 跨一个 current LID 时 `renderInlineMarkdown`/KaTeX 调用为 0；新增冷窗口时调用数不超过新增/失效 LID 数。
- 修改一个 Highlight/Note 只使对应 LID overlay 与必要 group representative 失效。
- 1000 条 annotation 下 lookup 计数与挂载 LID 数线性、无 `N × A` filter 路径。
- 换书/换源/renderer version 清空缓存；LRU 始终 `<=5w`；HTML snapshot 与旧渲染一致。

**完成证据**:
- `StableReaderSegment` 只观察 source/renderer/segment/render revision；anchor、selection 与 Note-only 更新保持父层响应式，但不重新解析正文。
- `ReaderAnnotationIndex` 单遍生成 annotation/highlight/card/Note/group 投影和 ranged-Highlight HTML revision；App 复用索引查询，并只为实际 source-focus LID 生成 revision。
- `ReaderSegmentHtmlCache` 接入无 overlay 的基础正文路径，按 book/source/renderer scope 清空、按 LID/text/kind 局部失效，并动态限制为 `5 * viewport.width`；最终 `<mark>` 与 Note DOM 不入缓存。

**验证回执**:
- characterization 先稳定复现 3 段 × 3 次 UI/Note 更新共 9 次额外 `renderSeg`；接入后为 0，显式修改一个 LID revision 只重渲染该段。
- `pnpm -C packages/web test`：46 files / 274 tests；`build` 与 `git diff --check` 通过。annotation 1000 条线性计数、四类 LRU scope/limit/invalidation、Highlight overlay 与 code asset HTML snapshot 均有确定性测试。
- 2,623 叶固定 fixture 1/1：range Highlight、selection/Note pin、双向回收均通过，anchor max `0.03125px`，settled/transient=`60/80`，最大挂载 80。
- `reader-performance.spec.ts` 完整 2 次预热 + 5 次正式回放 1/1（9.4 分钟）；`test:perf-bundle` 确认 production bundle 不含 reader performance 诊断入口。

**回滚**:按组件/索引/缓存三个小提交逆序回滚；PHR4 有界缓冲继续成立。

## 12. PHR6 - UTF-16 正文范围拆分与公式区间 API [Rust/TS]

**输入**:现有 `book.text(lid,end)`、Manifest spans、FormulaSemantics sidecar。

**做**:在 TS 增加纯 `splitUtf16Range`；Rust 增加 `book.formula_semantics_range(start_lid,end_lid)` 只读投影和 REST 类型；强化范围顺序、leaf、span 与响应 identity 校验；保留 singular API 向后兼容。

**不做**:不接入 App hydration，不修改 `source.txt`/base schema/LID span，不把 formula sidecar 全量送到首屏。

**产出**:一个连续 leaf range 可用一次正文响应无损拆回，并用一次公式响应覆盖窗口内全部命中/未命中。

**确定性验收**:
- Rust/TS gold cases 覆盖 ASCII、CJK、CRLF、emoji surrogate pair、空白 gap、公式、首尾叶和非法逆序。
- 对每个 fixture，range 拆分结果逐 LID 严格等于 singular `book.text(lid)`；digest、长度与顺序全等。
- 公式 range 返回项按 leaf order、无重复、全在请求区间；调用方可由差集确定 negative cache。
- `cargo test -p read-tools && cargo test -p server`；生成 TS 类型后 `pnpm -C packages/web typecheck`。

**完成证据**:
- `splitUtf16Range` 只消费一次正文 reply 与连续 Manifest leaf range；校验首端/可选尾端 identity、leaf 唯一性、UTF-16 span/边界、顺序、响应总长和仅空白 gap，任一漂移即失败关闭。
- `Book::text(start, Some(end))` 复用同一连续 leaf validator；`Book::formula_semantics_range` 以相同区间投影 sidecar hits，按 canonical leaf order 返回并校验 Formula leaf、`formula_lid`、`composition.source_lid` 与重复 identity。
- REST 新增 `GET /book/formula_semantics_range?start=&end=` 与 ts-rs `FormulaSemanticsRangeReply`；Web 只新增 typed API client，App hydration 与 singular 公式端点均未改变。

**验证回执**:
- TS gold/非法输入与 API binding：2 files / 14 tests；ASCII、CJK、CRLF、emoji、空白 gap、formula、首尾叶、identity/顺序/span/长度/surrogate 均覆盖。
- `cargo test -p read-tools`：166/166；`cargo test -p server`：229/229，另 `book_mcp` 5/5。range item 与 singular JSON 深等，missing formula 可由请求集差集确定。
- `pnpm -C packages/web test`：48 files / 288 tests；`typecheck` 与 production `build` 通过。未接入 App hydration，未修改 `source.txt`、base schema 或 LID span。

**回滚**:移除新增公式 range leaf 与 TS helper；singular API 未改。

## 13. PHR7 - 批量 hydration、去重与有界内容缓存 [Web]

**输入**:PHR6 API；PHR4 buffer transitions；Manifest leaf spans/kinds。

**做**:hydrate 只请求缺失 LID，把连续 miss 合成 range；一次拆分正文并合并公式 range；按 epoch/AbortController 丢弃 goto/换书后的 stale 回执；正文、公式正负和 in-flight cache 去重，settled LRU 各不超过 `5w`。

**不做**:不改变 buffer 策略、目录标题或 renderer；不增加 Promise 并发冒充批量化。

**产出**:`batched_hydration_v1` 开关下的范围 hydration；旧逐 LID 路径只作显式回滚。

**确定性验收**:
- 全冷 20 叶连续窗口严格为 1 text range + 0..1 formula range；无 per-LID 请求。
- 部分 cache 命中时只为连续缺口发请求；相同 in-flight range 只发一次。
- 404 formula negative cache 在同 source 内不重试；换源后重新求值。
- stale、abort、乱序响应不污染新 epoch；逐 segment 内容/formula 与旧路径深相等。
- Web unit/e2e/typecheck/build 与 PHR1 请求 ledger 全绿。

**完成证据**:
- `ReaderHydrator` 以 `book_id:source_fingerprint` 绑定 Manifest leaf order；正文 miss 按 canonical adjacency 分组并调用 `splitUtf16Range`，公式只为缺失 Formula LID 合并 hit-only range，由差集写入同源负缓存。
- 正文与公式正/负 settled LRU 独立限制为 `5w`；text/formula in-flight map 按 LID 共享 promise，重叠调用不重复请求已在途身份。
- goto/sync replacement、换书、建书与 unmount 先 abort 活动 transport 并推进 hydration epoch；即使 transport 忽略 abort，晚到 success/failure 也不能写 cache 或 UI。
- `batched_hydration_v1` 默认启用，query/env 显式置 `0|false` 回到原 singular hydrate；range 校验或请求失败不会静默猜测或自动降级。

**验证回执**:
- PHR7 unit/API：`reader-hydration` 10 tests + range transport 2 tests；全量 Web 为 49 files / 299 tests。
- PHR1 ledger：首段前严格 1 text range + 1 formula range、0 singular；2,623 叶全程无逐 LID text/formula 正常请求。
- Web E2E 30/30：长书 fixed/Note/image/formula、PDF/Markdown Note、选区、Agent source、artifact/minimap/annotation/translation 均通过；长书 DOM settled/transient 上界仍为 `3w/4w`。
- `pnpm -C packages/web build` 与 `test:perf-bundle` 通过；生产 bundle 不含 reader performance diagnostics，仅保留既有 chunk-size warning。

**回滚**:关闭 `batched_hydration_v1` 回到 singular hydrate；PHR6 API 可暂留且无调用者。

## 14. PHR8 - Manifest 标题投影与非阻塞首屏 [Rust/Web]

**输入**:ManifestNode spans、canonical source、当前 `loadOutlineTitles/loadChapter/init`。

**做**:给 ManifestNode 增加确定性 `display_title` 并生成 TS 类型；Rust 在节点 span 内提取首个非空行、剥 heading marker、UTF-16 安全截断 80 units、空值用 LID；目录和 chapter title 共用字段；删除启动/章节标题的 per-node `api.text` 请求，让 `loadWindow` 不再等待标题网络扇出。

**不做**:不改变 LID tree、正文、BookStructure title 或用 LLM 翻译；不把旧 N 请求挪到后台。

**产出**:目录规模不再改变 first-segment 关键路径和标题请求数。

**确定性验收**:
- Rust title parser 覆盖 Markdown heading、普通首行、空白、CJK、emoji 截断、空 span fallback。
- Manifest REST/MCP/生成 TS contract parity 通过；目录最终文本与当前代表 fixture 期望一致。
- Playwright 将 outline 扩为 40/134/292 项时，首段前 title `book.text` 请求始终为 0，正文与目录可见。
- `cargo test -p read-tools -p server`；Web unit/typecheck/build；first-segment trace 门全绿。

**完成证据**:
- `ManifestNode.display_title` 由 Rust 在节点 UTF-16 span 内提取首个非空行，按 ATX heading 规则剥 marker，在合法 scalar 边界截断到 80 UTF-16 units；空白、空/非法 span 回退 LID。
- REST 与 Book MCP 复用同一 `Book::manifest` 投影并做 JSON 语义 parity；ts-rs 生成的 `ManifestNode.ts` 将 `display_title` 固化为必填字段。
- App 一次把 Manifest 投影成 `titleByLid + outline`，目录和 chapter read position 共用字段；已删除 `loadOutlineTitles` 与 `loadChapter` 的标题 `api.text` 路径，未迁移成后台 N 请求。
- 40/134/292 项 Playwright fixture 均显示代表目录标题、breadcrumb 与首个正文 LID；首段前及目录结算后 `outline-text=0`，正文仍为 1 text range + 1 formula range、0 singular。

**验证回执**:
- Rust：read-tools 169/169；server 229/229 + book_mcp 5/5。
- Web：50 files / 301 tests；`typecheck`、production `build`、`test:perf-bundle` 通过，仅既有 chunk-size warning。
- E2E：33/33；含 40/134/292 标题规模门、1 次 measured first-segment trace 及 fixed/Note/image/formula 长书回归。

**回滚**:恢复旧可选标题加载但必须保持非阻塞；Manifest 新字段可向后兼容保留。

## 15. PHR9 - 真书回放、发布闸与旧路径删除 [Release]

**输入**:PHR4/5/7/8 全部绿；PHR1 baseline 与 §4 硬门；真实 `quantification-essence`。

**做**:在 Chromium 与 Desktop WebView2 各跑预热 2 + 正式 5 次全程回放；保存 trace、request ledger 和结构计数；执行 Note/Highlight/selection/goto 双向 correctness matrix；先独立开 `bounded_buffer_v1`，再开 `batched_hydration_v1`。全部门通过后删除 append-only、逐 LID 正常路径和临时诊断 UI/开关。

**不做**:不因单次最好成绩放行，不把 Chromium 结果替代 WebView2，不在本刀继续调 CSS/功能。

**产出**:带 revision/runtime/机器信息的最终报告，以及单一生产路径。

**确定性验收**:
- §4 所有结构、帧、Long Task、probe、锚、请求和首屏硬门同时通过；5 次原始样本可复核。
- 2,623 叶下滑到末尾再回到起点，current LID、server viewport、目录进度和 DOM 顺序一致。
- 全量相关 Rust/Web/Playwright 回归、typecheck 和 production build 通过。
- 若任一 correctness gate 红，关闭对应开关并记录失败，不删除旧路径；若只有 wall-time 抖动，增加重复测量而不改判据。

**回滚**:发布前按两个独立开关回滚；旧路径删除后的回滚使用对应独立 commit revert，不牵连已证实的另一条优化。
