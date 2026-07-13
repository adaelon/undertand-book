# 切片方案 - PDF 选区动作与用户标注投影

> 定位:让 PDF 原生拖选与 Markdown 正文共用 Highlight、Note、Ask AI 语义,同时保持原版 PDF 纯净阅读。
> 冻结决策:[ADR-0074](adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md)。
> 状态:PS0-PS6 完成;PS7 待实现。

## 0. 冻结边界

1. PDF mouseup 不自动 `select`、`goto`、打开来源正文、发送问题、写 memory 或清除选区。
2. 选区解析后显示浮动工具条:`高亮 / 笔记 / 问 AI`;动作必须由用户显式点击。
3. 自动 source-map regions 永不显示;只有用户主动创建的 Highlight 与 Note marker 可进入 PDF user annotation projection。
4. `resolved` 开放三动作;`partial` 只开放 Note/Ask AI 并显示部分定位;`unresolved` 只保留原生复制。
5. raw PDF text 只保存用户看到的内容;citations、持久锚与投影只认 resolved quote/ranges。
6. Highlight 必须精确到字符 range;不得退化为整段 bbox。
7. Note 语义锚是首 resolved LID,显示锚是末 resolved range;无法证明选区末端可精确恢复时不显示 inline marker。
8. Note 内容编辑不移动锚;重新定位必须显式重新选择。
9. Ask AI 增强现有跨 LID `AskDraft`,不新增 PDF-only 对话路径。

## 1. 共享契约

```ts
type SelectionResolution = "resolved" | "partial";

interface SelectedRange {
  lid: string;
  range: { start: number; end: number };
}

interface SelectionContext {
  status: SelectionResolution;
  raw_quote: string;
  resolved_quote: string;
  ranges: SelectedRange[];
}

interface PdfSelectionDraft extends SelectionContext {
  request_id: string;
  screen_rect: { left: number; top: number; right: number; bottom: number };
}

interface AskDraft {
  lid: string;
  quote: string;
  ranges?: SelectedRange[];
  status?: SelectionResolution;
  raw_quote?: string;
  resolved_quote?: string;
}

interface MemoryRecord {
  selection_context?: SelectionContext;
}
```

兼容规则:

- 旧 Highlight/Note/AskDraft 无新增字段时保持原行为。
- `AskDraft.lid/quote` 保留,分别等于首 LID 与现有引用卡展示文本。
- 普通非选区 Note 不带 `selection_context`。
- Note citations 由 `selection_context.ranges[].lid` 按阅读顺序去重派生。
- Note `mem_id` 在存在 selection context 时纳入其规范序列化结果。

## 2. 选区状态机

```text
IDLE
  -> mouseup(non-collapsed)
RESOLVING(request_id)
  -> resolved
READY_RESOLVED
  -> partial
READY_PARTIAL
  -> unresolved / Esc / blank click / new selection / book switch
IDLE

READY_RESOLVED -> Highlight -> SAVING -> success -> IDLE
READY_RESOLVED -> Note      -> NOTE_EDITING -> save/cancel -> IDLE
READY_RESOLVED -> Ask AI    -> ASK_DRAFT -> IDLE
READY_PARTIAL  -> Note | Ask AI
```

硬约束:

- 新 mouseup 废弃旧 `request_id`;迟到响应不得覆盖新 draft。
- `RESOLVING` 显示加载态,动作不可点击。
- mutation 失败保留 draft 与原生选区,允许重试。
- Highlight 成功、Note 保存成功或 AskDraft 建立后才清除原生选区。
- `Esc`、空白点击、切书与 Reader unmount 销毁 draft。

## 3. 动作门禁

| resolve status | Highlight | Note | Ask AI |
|---|---|---|---|
| `resolved` | 保存全部精确 ranges | 保存 selection context,可显示 inline marker | 携带完整 ranges + 双 quote |
| `partial` | 禁用 | 保存并标记部分定位;不能证明末端精确时只进 Notes list | 可用;模型收到 partial 声明 |
| `unresolved` | 禁用 | 禁用 | 禁用;只保留原生复制 |

## 4. Highlight

```text
memory highlights
  -> batch exact pdf_ranges.project
  -> merge adjacent glyph rects by visual line
  -> render borderless low-opacity marker strokes
```

- 默认持续可见,与 Markdown `<mark>` 语义一致。
- 只覆盖实际字符,不显示 LID、置信度、边框或 source-map 状态。
- 跨 LID/跨页继续按多条 Highlight record + `source_session_id` 分组。
- 重叠笔迹可视觉合并,memory records 不合并。
- 点击笔迹打开引用摘录与“重新选择/删除”;编辑范围必须显式重选。
- 精确投影失败时只在 Highlights list 标记无法定位。

## 5. Note

创建:

```text
selection draft -> 点击“笔记” -> existing note editor(raw quote 预填)
  -> save -> one MemoryRecord + selection_context
  -> refresh annotations -> exact terminal marker
```

回显:

- marker 位于末 range 最后一个 glyph 之后,不得改变 PDF 页面尺寸或文本布局。
- 同 terminal range 的多条 Note 合并为带数量的 marker。
- 近邻 marker 只做可逆视觉错位;数据 range 不变。
- 页面边界不足时 marker 向左/上翻转,不得溢出视口。
- desktop 点击 marker 打开锚定 popover;mobile 打开 bottom sheet。
- 两种容器都渲染与 Markdown 相同的 `NoteCard`,复用内容、编辑和删除事件。
- 同时只打开一个 Note surface;`Esc`、关闭按钮或 PDF 空白点击收起,滚动位置不变。

编辑:

```ts
memory.replace({
  mem_id,
  content,
  selection_context?: SelectionContext // 缺省继承旧值
}) -> MemoryRecord
```

- 默认只改 content,保留 anchor/selection context/citations/layer。
- 写失败时旧记录原样保留。
- “重新选择”是唯一允许替换 selection context 的入口。
- 删除成功后关闭 Note surface、移除 marker、刷新 Notes list。

## 6. Ask AI

```text
selection draft -> 点击“问 AI”
  -> reuse AskDraft
  -> RightRail agent tab + quote card + focused textarea
  -> user types question -> explicit send
```

- 不自动发送,不写 memory,不创建 Highlight/Note,不改变 PDF 滚动位置。
- `resolved` 发送全部 ranges 与 resolved quote。
- `partial` 同时发送 raw/resolved quote 和 ranges,并明确声明未完整锚定。
- 未映射 raw quote 不得成为 citation truth。
- 发送、清除引用、新会话、切换会话后销毁 draft。

## 7. 实现切片

### 7.0 执行规则与依赖

依赖链:

```text
PS0
  -> PS1 Selection/Memory schema
      -> PS2 memory.replace
      -> PS3 exact range projection
          -> PS5 selection draft/toolbox
              -> PS6 Highlight/Note projection
                  -> PS7 AskDraft provenance + E2E

PS1 -> PS4 shared NoteCard -> PS6
PS3 -----------------------> PS6
PS5 -----------------------> PS7
```

共同执行约束:

1. 每个 PS 是独立 commit-ready 切片;不得把后续切片的 UI、投影或重构混入当前切片。
2. 新增路径先写最小失败测试,再实现到绿;改已有路径必须跑相关回归。
3. wire/schema 新字段一律可选并带 serde/TS 兼容读取;旧 memory、旧 agent history、旧 Highlight/Note 不迁移也能读取。
4. 每刀完成时更新 `docs/代码链路.md`;只有模块边界或主要数据流改变时才更新架构文档。
5. 测试必须由 Rust test runner、Vitest、TypeScript compiler、production build 或 Playwright 给出确定性结果,不得以人工阅读代替。
6. 任一 hard gate 失败即停在当前切片;不得靠 bbox fallback、吞错、清空旧数据或放宽断言进入下一刀。

每刀交接最少包含:

- 变更文件与关键符号。
- 新旧 wire 示例各一条。
- 精确测试命令与通过数量。
- 尚未覆盖的真实环境风险。
- 下一刀只依赖文件状态即可执行的入口。

### PS0 - 领域与决策落盘

- **Do**:更新 CONTEXT、ADR-0074 与本计划。
- **Do not**:改可执行代码。
- **Done**:术语零未解析;ADR/计划互链;Markdown diff 检查通过。

状态:完成;领域 Grill、冻结决策、执行计划与验证入口均已落盘。

交付物:

- `CONTEXT.md`:规范 Memory/PDF/Ask AI 选区术语。
- `docs/adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md`:冻结不可跨越的产品与架构边界。
- 本文:固定 PS1-PS7 依赖、契约和验收证据。
- `docs/代码链路.md`:记录 PS0 入口与验证。

退出检查:

```powershell
git diff --check -- CONTEXT.md docs/adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md docs/切片方案-pdf-selection-actions.md docs/代码链路.md
```

### PS1 - Selection/Memory schema

- **Do**:增加共享 `SelectionContext/SelectedRange`,memory 可选 selection context,兼容 serde/TS 类型与 mem_id/citation 规则。
- **Do not**:改前端交互或 PDF 投影。
- **Done**:旧 memory fixture round-trip 不变;新 Note 多 LID ranges、双 quote、citations、mem_id tests 全绿。

状态:完成;Rust/HTTP/TS schema 已同构,旧 hash 与缺省字段兼容测试已锁定。

前置条件:

- PS0 文档已审阅并提交。
- `SelectionContext` 只允许 `resolved/partial`;`unresolved` 不得持久化。
- range 偏移继续使用相对 LID 文本的 UTF-16 `[start,end)`;不得引入第二套偏移口径。

主要落点:

- `crates/memory/src/lib.rs:TextRange/Record/SaveInput/content_mem_id/MemoryStore::save`。
- `crates/reader/src/lib.rs`、`crates/runtime/src/orchestrator.rs`、`crates/server/src/lib.rs` 中全部 `SaveInput` 构造点。
- `crates/server/src/lib.rs:/memory/save` 的 JSON 解析与错误分类。
- `packages/web/src/api.ts:TextRange/MemoryRecord/api.save`。

Rust/TS 契约:

```rust
enum SelectionResolution {
    Resolved,
    Partial,
}

struct SelectedRange {
    lid: String,
    range: TextRange,
}

struct SelectionContext {
    status: SelectionResolution,
    raw_quote: String,
    resolved_quote: String,
    ranges: Vec<SelectedRange>,
}

struct Record {
    // existing fields unchanged
    selection_context: Option<SelectionContext>,
}

struct SaveInput {
    // existing fields unchanged
    selection_context: Option<SelectionContext>,
}
```

保存不变量:

| 条件 | 结果 |
|---|---|
| `selection_context` 缺省 | JSON 省略字段;旧 `mem_id` 输入逐字节不变;旧 citation 派生不变 |
| context 存在但 `type != note` | validation error,不得静默忽略 |
| `ranges=[]`、`start >= end` 或空 LID | validation error |
| `anchor.lid != ranges[0].lid` | validation error,防止语义锚与选区来源分叉 |
| context 合法且 citations 缺省 | 按 `ranges` 阅读顺序对 LID 首次出现去重派生 |
| citations 显式给出 | 保留显式值;仍校验 selection context 自身合法性 |

`mem_id` 兼容规则:

```text
selection_context == None
  -> 沿用 book|type|anchor|content[|range]

selection_context == Some(ctx)
  -> old_key + "|selection:" + canonical_json(ctx)
```

- `canonical_json` 只序列化定长 struct 字段顺序:`status,raw_quote,resolved_quote,ranges`。
- `ranges` 保留传入阅读顺序,每项固定为 `lid,range.start,range.end`;不得排序或使用无序 map。
- 同一 context 重复保存必须得到同一 ID;range 顺序、双 quote 或 status 任一变化必须改变 ID。

实施顺序:

1. 在 memory crate 增加类型、serde 属性和 context validator。
2. 先为每个现有 `SaveInput` 构造点显式补 `selection_context: None`,确保编译影响面受控。
3. 增加旧 JSON fixture 读取、回写及旧 Note hash 固定值测试。
4. 增加多 LID Note 的 validation、citation 去重和 canonical mem_id 测试。
5. 扩展 `/memory/save` body 与 `api.save`,再增加同构 TS 类型。
6. 跑 memory/reader/runtime/server tests 与 Web typecheck;本刀不改 App/Reader UI。

最小测试矩阵:

| Case | 断言 |
|---|---|
| 旧 fixture 无 context | deserialize/serialize 后字段语义与旧 `mem_id` 不变 |
| resolved 单 LID | context 完整落盘,citation 一条 |
| resolved 多 range 同 LID | citation 去重但 ranges 不合并 |
| resolved 多 LID 重复出现 | citation 按首次出现顺序去重 |
| partial | raw/resolved quote 与 ranges 均保留 |
| 空 ranges/逆序 range/anchor 不符 | 分类明确的 validation error,不写文件 |
| context 任一规范字段变化 | `mem_id` 改变 |

退出证据:

```powershell
cargo test -p memory
cargo test -p reader -p runtime -p server
pnpm -C packages/web typecheck
```

### PS2 - 原子 memory.replace

- **Do**:实现原子 replace command/HTTP client,默认继承 selection context,显式 reselection 才替换。
- **Do not**:改 Note UI。
- **Done**:成功替换、写失败保留旧记录、缺 mem_id、显式 reanchor tests 全绿。

状态:完成;候选快照落盘成功后才交换内存状态,HTTP/TS command 已接通。

前置条件:PS1 schema 与旧数据兼容测试已绿。

主要落点:

- `crates/memory/src/lib.rs:MemoryStore` 新增 `replace` 与候选快照持久化路径。
- `crates/server/src/lib.rs` 新增 `/memory/replace` route,不复用 delete+save。
- `packages/web/src/api.ts` 新增 `api.replace` 类型,本刀不接 Note editor。

命令契约:

```rust
struct ReplaceInput {
    mem_id: String,
    content: String,
    // None = 继承旧 context;Some = 显式重新选择后替换
    selection_context: Option<SelectionContext>,
}

fn replace(&mut self, input: ReplaceInput, now: &str) -> Result<Record, ToolError>;
```

状态转换:

```text
lookup old mem_id
  -> clone current records into candidate
  -> inherit or validate new selection context
  -> derive anchor/citations from effective context
  -> recompute content-addressed mem_id
  -> persist candidate snapshot
  -> only after persistence succeeds swap in-memory state
```

原子性不变量:

- 找不到旧 ID 返回 `MEMORY_NOT_FOUND`,不创建新记录。
- content 为空返回 validation error,旧记录不变。
- 缺省 context 时保留旧 anchor/context/citations/layer/type/book/source session。
- 显式 context 时 anchor 改为首 LID,citations 重新按 ranges 去重派生;其他信封字段继承。
- 新 ID 若与另一条既有记录冲突,返回 `MEMORY_REPLACE_CONFLICT`;不得合并 usage 或删除任一记录。
- 序列化、目录或写入失败时,内存与磁盘上的旧记录都仍可 recall。
- 成功后旧 ID 不可 recall,新 ID 恰有一条;整个过程不暴露中间“已删未存”状态。

失败注入测试:

| 故障点 | 断言 |
|---|---|
| missing mem_id | 404/`MEMORY_NOT_FOUND`;记录总数不变 |
| invalid new context | validation;旧记录逐字段不变 |
| persistence failure | old mem_id 仍能从当前 store 与重开 store 读取 |
| target ID collision | conflict;两条原记录都保留 |
| successful content edit | 仅 content/ID/timestamps 变化,锚与引用不变 |
| explicit reselection | context/anchor/citations/ID 一起更新 |

退出证据:

```powershell
cargo test -p memory
cargo test -p server memory_replace
pnpm -C packages/web typecheck
```

### PS3 - 精确 range 反向投影

- **Do**:让 `pdf_ranges.project` 真正消费 range,从 char-level selection shards 返回精确 glyph/line rects 与 terminal coverage。
- **Do not**:恢复自动 source-map overlays。
- **Done**:单行/跨行/跨页/旋转/partial/unmapped/末字符 tests 全绿;整段 bbox fallback 被拒绝。

状态:完成;range 必填,字符级 rect/连续 coverage/terminal rect 已由 selection shards 确定性返回。

前置条件:PS1 已冻结 `SelectedRange` 的 UTF-16 口径;PS2 可并行但不阻塞本刀。

主要落点:

- `crates/server/src/lib.rs:selection_manifest_value/selection_page_shard_path/selection_hits_for_page/route_pdf_ranges_project`。
- `crates/server/src/lib.rs:PdfRangeProjection/PdfRangesProjectResponse`。
- `packages/web/src/api.ts:PdfRangesProjectResponse/api.pdfRangesProject`。
- 现有 `pdf_selection_map/pages/*.json` char entries 是唯一几何来源;`pdf_source_map.json` 只保留导航用途。

响应契约:

```ts
interface ExactPdfRect {
  pageIndex: number;
  bbox: [number, number, number, number];
  source_span: { start: number; end: number };
}

interface PdfRangeProjection {
  lid: string;
  range: TextRange;
  status: "exact" | "partial" | "unmapped";
  rects: ExactPdfRect[];
  covered_range?: TextRange;
  terminal_rect?: ExactPdfRect;
}
```

投影算法:

```text
for each requested range in caller order:
    validate LID and UTF-16 [start,end)
    translate to absolute source span using lid_span
    scan selection-map page shards for chars intersecting that exact source span
    retain chars whose lid and source_span belong to the requested range
    sort by pageIndex,char_index
    prove coverage from requested start through requested end
    exact   = every requested UTF-16 unit has mapped char geometry
    partial = some geometry exists but coverage has a gap
    unmapped = no usable geometry
    terminal_rect = rect covering the exact final selected unit, exact only
```

几何边界:

- 返回 selection shard 的 PDF user-space bbox,不转换为 CSS pixels。
- `rects` 保留字符级证据;相邻字符按视觉行合并属于 PS6 renderer,不得在服务端丢失 terminal glyph。
- range 缺省、越界、`start >= end` 均为 validation error;不得降级成整个 LID。
- `pdf_source_map` 的 `primary_region/regions` 不得进入新 exact 响应。
- 旋转页沿用 artifact coordinate metadata;测试必须证明 90/180/270 度页面不会交换错误轴。

测试 fixture:

- 单 LID 单行连续字符,覆盖首尾精确 bbox。
- 单 LID 跨行、跨页字符,保持 page/char 顺序。
- 两个 LID 分别投影,响应顺序等于请求顺序。
- selection shard 中间缺字 -> `partial`,无 `terminal_rect`。
- 末字符缺映射 -> `partial`,禁止 Note marker。
- 全部缺映射 -> `unmapped`,rects 为空。
- 只有 `pdf_source_map` 整段 region -> 仍为 `unmapped`,证明 fallback 被拒绝。

退出证据:

```powershell
cargo test -p server pdf_range
pnpm -C packages/web typecheck
```

### PS4 - 共享 NoteCard

- **Do**:从 ReaderPane 提取行为不变的 NoteCard,Markdown 继续原位渲染。
- **Do not**:新增 PDF marker 或改变 Note 样式/操作。
- **Done**:重构前后 Markdown Note DOM、编辑、删除测试不变。

状态:完成;ReaderPane flow/single 两条路径复用同一 NoteCard,characterization tests 锁定原行为。

前置条件:PS1 的 `MemoryRecord.selection_context?` 已进入 TS 类型;NoteCard 本身不得依赖 PDF。

主要落点:

- 新建 `packages/web/src/components/NoteCard.vue`。
- `packages/web/src/components/ReaderPane.vue:leadingQuote/notePreview/noteSourceLabel/isLongNote` 与两处重复 `<details class="note-card">`。
- `packages/web/src/style.css:.note-card/.note-summary/.note-actions` 继续作为共享样式源,本刀不重做视觉。

组件契约:

```ts
props: {
  note: MemoryRecord;
  renderMarkdown: (source: string) => string;
}

emits: {
  focusSource: { lid: string; quote: string | null };
  edit: MemoryRecord;
  delete: MemoryRecord;
}
```

实施顺序:

1. 先写 ReaderPane characterization test,锁定短/长 Note 的 DOM、默认展开、预览、来源按钮及事件 payload。
2. 把纯展示 helper 与 `<details>` 模板移入 NoteCard。
3. ReaderPane 的 flow/single 两条路径都改为调用同一组件,不改变 notes-by-LID 分组。
4. 比较重构前后的 class、aria/title、Markdown HTML 与 edit/delete/focus-source 事件。

禁止变化:

- 不改变 Note 排序、折叠阈值、引用摘录解析或 Markdown 渲染器。
- 不增加 PDF popover/bottom sheet props。
- 不改 App 的 delete+save 编辑逻辑;该行为由 PS2/PS6 后续接线。

退出证据:

```powershell
pnpm -C packages/web test -- ReaderPane NoteCard
pnpm -C packages/web typecheck
pnpm -C packages/web build
```

### PS5 - PDF selection draft 与工具条

- **Do**:实现 request-safe 状态机、浮动工具条、动作门禁、取消与失败恢复;移除自动 goto/focus-source。
- **Do not**:实现持久 PDF annotation projection。
- **Done**:resolved/partial/unresolved、迟到响应、Esc/空白/切书、失败重试 tests 全绿。

状态:完成;PdfReaderPane 只捕获原生选区,App-owned 状态机与显式三动作已接通,自动 mouseup 导航已移除。

前置条件:PS1 wire 类型可供 App 使用;PS3 exact projection 可独立完成,但本刀只消费 selection resolve。

所有权边界:

```text
PdfReaderPane
  owns: DOM Selection -> raw_quote/rects/screen_rect capture
  emits: captured request payload

App
  owns: request_id,RESOLVING/READY/SAVING state,SelectionDraft,actions
  calls: pdfSelectionResolve,memory.save/reader.highlight
  renders: fixed-position selection toolbar
```

捕获契约:

```ts
interface PdfSelectionCapture {
  request_id: string;
  raw_quote: string;
  rects: Array<{ pageIndex: number; bbox: PdfBbox }>;
  screen_rect: { left: number; top: number; right: number; bottom: number };
}
```

解析转换:

```text
capture.raw_quote + resolve response
  -> unresolved: no draft/no toolbar;native selection remains
  -> partial/resolved: PdfSelectionDraft {
       status,raw_quote,
       resolved_quote = response.quote_markdown,
       ranges = response.ranges.map(lid,range),
       request_id,screen_rect
     }
```

请求安全规则:

- 每次 non-collapsed mouseup 先生成新 request ID 并使旧 ID 失效。
- resolve 成功/失败都先比较当前 ID;迟到响应只能被丢弃,不能更新 banner、draft 或 toolbar。
- `RESOLVING` 只显示稳定尺寸加载态,三动作不可点击。
- resolve 网络失败保留原生选区并提供可重试状态;不得清空或自动导航。
- `Esc`、PDF 空白点击、新选区、切书、Reader unmount 清理 draft/toolbar;只有动作成功才清除 native selection。

动作接线范围:

- Highlight:仅 `resolved`;按每个 range 保存既有 Highlight records,跨 range 继续用同一 `source_session_id`。
- Note:`resolved/partial`;打开既有 editor,预填 raw quote,并携带完整 `SelectionContext` 等待保存。
- Ask AI:`resolved/partial`;建立增强 AskDraft,切到 agent tab 并聚焦输入框,不发送。
- 本刀只证明新记录/草稿建立;不渲染持久 Highlight strokes 或 Note markers。

组件/状态测试:

| Case | 断言 |
|---|---|
| resolved | 三按钮可用,无 goto/select/focus-source emit |
| partial | Highlight disabled,Note/Ask enabled,显示部分定位状态 |
| unresolved | 无工具条,原生复制仍可用 |
| response A 晚于 response B | draft 始终属于 B |
| mutation failure | draft、toolbar、selection 均保留,按钮可重试 |
| action success | draft 与 native selection 清除一次 |
| Esc/blank/book switch/unmount | draft 确定性销毁 |

退出证据:

```powershell
pnpm -C packages/web test -- PdfReaderPane pdf-selection
pnpm -C packages/web typecheck
pnpm -C packages/web build
```

### PS6 - PDF Highlight/Note projection

- **Do**:批量投影 memory annotations,渲染精确 Highlight strokes、Note marker 聚合、popover/bottom sheet 与 shared NoteCard。
- **Do not**:显示自动 map regions 或近似 bbox。
- **Done**:桌面/移动 geometry、collision、边界翻转、无法定位、edit/delete/reselect tests 全绿。

状态:完成;memory records 单批 exact-only 投影、Highlight strokes、聚合 Note marker、共享 NoteCard surface 与显式重选已接通。

前置条件:PS1 schema、PS2 replace、PS3 exact projection、PS4 NoteCard 与 PS5 draft 全部已绿。

数据流:

```text
memory.recall(note/highlight)
  -> build projection requests from exact record.range or selection_context.ranges
  -> one batched pdf_ranges.project request
  -> accept status == exact only
  -> Highlight:merge adjacent glyph rects by visual line -> strokes
  -> Note:take final range.terminal_rect -> aggregate marker
  -> partial/unmapped -> side-list location state only
```

主要落点:

- `packages/web/src/App.vue:refreshAnnotations/openEditNote/saveNote/deleteNote`。
- `packages/web/src/components/PdfReaderPane.vue` 新增只消费 user annotation projection 的 overlay layer。
- `packages/web/src/components/NoteCard.vue` 在 PDF surface 中复用。
- `packages/web/src/api.ts:MemoryRecord/PdfRangesProjectResponse/api.replace`。
- `packages/web/src/style.css` 的 Highlight strokes、marker、popover 与 bottom-sheet responsive rules。

投影模型:

```ts
interface ProjectedHighlight {
  mem_id: string;
  source_session_id?: string;
  rects: CssRect[];
}

interface ProjectedNoteMarker {
  terminal_key: string; // page + exact terminal range
  anchor_rect: CssRect;
  notes: MemoryRecord[];
}
```

Highlight 规则:

- 只渲染 `status=exact` 的 rects;无边框、低透明度、不拦截 text-layer 选择。
- 同一 record 的相邻 glyph 可按 page/visual line/小间隙合并;不得把空白、其他列或其他行涂满。
- 重叠 record 只做视觉叠加/合并,不得改写 memory 或 mem_id。
- 点击命中只打开该 user annotation 的摘录/删除/重新选择操作,不能暴露 source-map confidence。

Note marker 规则:

- 只使用 selection context 最后一条 range 的 `terminal_rect`;普通 Note 或 partial/unmapped Note 不生成 marker。
- 同 terminal key 聚合并显示数量;单个 marker 可打开该位置的 Note 列表。
- 邻近 marker 的错位只存在于布局结果,原始 anchor rect 不变且重算可逆。
- desktop surface 是锚定 popover;mobile surface 是 bottom sheet;两者只渲染共享 NoteCard。
- 同时只允许一个 surface;关闭、Esc、PDF 空白点击不改变 PDF scroll anchor。

编辑/删除/重选:

- edit 调 `memory.replace`;失败时 surface 保持打开且旧卡片/marker 不变。
- delete 成功后关闭无剩余内容的 surface并刷新;失败时原卡片保留。
- reselect 明确进入 PS5 draft,保存成功后以新 context 替换;取消则旧 marker 不动。
- 刷新投影以返回的 authoritative memory record 为准,不得前端猜新 mem_id。

测试矩阵:

- CSS/PDF 坐标转换:缩放、scroll、90/180/270 度、跨页。
- glyph line merge:同一行合并、跨行分开、双栏不串联。
- marker:同锚聚合、近邻碰撞、右/下边界翻转、移动端安全区。
- exact/partial/unmapped:仅 exact 进入 overlay DOM。
- edit/delete/reselect:成功与失败都验证 memory、DOM、surface 和 scroll anchor。
- hard guard:`pdf_source_map` 自动 region DOM 数始终为零。

退出证据:

```powershell
pnpm -C packages/web test
pnpm -C packages/web typecheck
pnpm -C packages/web build
pnpm -C packages/web test:e2e
```

### PS7 - AskDraft provenance 与端到端验收

- **Do**:增强现有 AskDraft,把 ranges/status/raw/resolved quote 传入 agent metadata;用真实 PDF fixture 验收三动作。
- **Do not**:新增 PDF-only agent 入口或自动发送。
- **Done**:跨 LID resolved/partial prompt contract、citation gate、全量 Web/Rust tests、typecheck/build、Playwright desktop/mobile 全绿。

前置条件:PS5 能建立 resolved/partial AskDraft;PS6 完成完整 PDF annotation UI。

主要落点:

- `packages/web/src/App.vue:AskDraft/askSelection/sendAgent/chat history hydration`。
- `packages/web/src/components/RightRail.vue:AskDraft/quote card`。
- `packages/web/src/api.ts:AskQuote/AgentChatMeta/AgentChatTurn`。
- `crates/server/src/lib.rs:AskQuote/parse_question_quote/route_agent_chat/AgentHistory`。
- 必要时在 `crates/runtime/src/orchestrator.rs` 增加结构化 selection provenance 到 prompt 的确定性格式化函数。

兼容契约:

```ts
interface AskQuote {
  lid: string;                 // first resolved LID,old field retained
  quote: string;               // current quote-card display text
  ranges?: SelectedRange[];
  status?: "resolved" | "partial";
  raw_quote?: string;
  resolved_quote?: string;
}
```

- 旧 history 只有 `lid/quote` 时照常读取与显示。
- Markdown 选区逐步改用同一扩展结构,但不得要求旧调用方一次迁移。
- RightRail quote card 继续显示用户看到的 quote;partial 状态必须可见,但 raw quote 不生成可跳 citation。

发送契约:

```text
display_user = 用户实际问题
question_quote = structured AskQuote
runtime prompt provenance:
  resolved:
    cite only ranges[].lid + resolved_quote
  partial:
    label raw_quote as unverified user-visible context
    cite only ranges[].lid + resolved_quote
  legacy:
    preserve current lid/quote behavior
```

安全边界:

- 点击 Ask AI 只建立草稿、打开 agent tab、聚焦输入;发送仍需用户提交非空问题。
- server 必须验证 ranges 非空/有序/合法且首 LID 等于 `lid`;不能只信客户端拼出的 message 文本。
- raw quote 可进入提示词的“未验证上下文”区,不可进入 citation allowlist、memory citation 或 PDF geometry。
- 发送后、清除引用、新会话、切换/删除会话均销毁当前 draft;历史 turn 保存结构化副本。
- agent 回复 citation 仍受既有确定性 evidence/LID 校验,selection provenance 不放宽引用红线。

端到端 fixture:

1. resolved 跨 LID 选区:三动作可用;Highlight 精确覆盖;Note 保存全部 ranges 并在末字符显示 marker;Ask AI metadata 含完整 resolved provenance。
2. partial 跨页选区:Highlight 禁用;Note 只进列表或在末端不可证明时无 marker;Ask AI 明确 partial 且 raw 不成为 citation。
3. unresolved 选区:只可 native copy;零 toolbar mutation、零 memory、零 agent turn。
4. stale request + action failure:新 draft 不被旧响应覆盖;失败后可重试且无重复记录。
5. legacy Markdown/old memory/history:原 Highlight、Note、Ask quote 行为与渲染不变。

全量退出证据:

```powershell
cargo test -p memory -p reader -p runtime -p server
pnpm -C packages/web test
pnpm -C packages/web typecheck
pnpm -C packages/web build
pnpm -C packages/web test:e2e
```

人工验收只补足浏览器手感,不替代上述测试:

- desktop 1440x900 与 mobile 390x844 无工具条/marker/Note surface 重叠。
- PDF 页面 shell、canvas、text layer 的尺寸与 scroll anchor 在 overlay 前后不变。
- 原生复制、Esc、空白点击、切书和新会话行为符合状态机。

## 8. Hard gates

| Gate | 首次锁定切片 | 必须保留的证据 |
|---|---|---|
| 自动 `pdf_source_map` regions 的可见 DOM 始终为零 | PS5/PS6 | PdfReaderPane DOM test + Playwright locator count 0 |
| 用户 annotation 只有 exact projection 才可覆盖 PDF;partial/unmapped 只进列表 | PS3/PS6 | Rust coverage test + Web overlay filtering test |
| raw quote 永不成为 citation 或持久几何依据 | PS1/PS7 | memory citation test + server/runtime prompt contract test |
| 迟到 selection response 永不覆盖新 `request_id` | PS5 | deferred-promise race test |
| Note edit failure 不得删除或损坏旧 record | PS2/PS6 | persistence failure injection + UI failure test |
| PDF overlay 不改变 canvas/text-layer/page shell 尺寸与滚动锚 | PS6/PS7 | before/after browser geometry assertions |
| Markdown 与 PDF 使用同一 NoteCard 和同一 AskDraft 语义 | PS4/PS7 | shared component identity/DOM test + history compatibility test |
| 缺省 selection context 时旧 JSON 与旧 `mem_id` 不变 | PS1 | frozen legacy fixture/hash assertion |
| 整段 bbox fallback 永不冒充 exact range | PS3 | source-map-only fixture returns unmapped |
| Note marker 只锚 exact final character | PS3/PS6 | missing-terminal-char test + marker absence assertion |

跨切片回归门禁:

- PS1 之后每刀都重跑 legacy memory fixture。
- PS3 之后每刀都保留 source-map-only fallback 拒绝测试。
- PS4 之后每刀都保留 Markdown NoteCard characterization test。
- PS5 之后每刀都保留 stale request 与 unresolved native-copy 测试。
- PS6/PS7 的 Playwright 必须同时覆盖 desktop/mobile,并断言 PDF 几何稳定与自动 overlay DOM 为零。
