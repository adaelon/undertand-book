# 切片方案 - Agent 对话用户可见来源

> 定位:保留 LID 作为 Agent 内部证据身份,将普通对话中的位置呈现替换为句后蓝色来源按钮和可核验文本弹窗。
> 冻结决策:[ADR-0086](adr/0086-runtime-owned-user-visible-source-references.md)。
> 状态:SR0-SR6 全部完成。普通对话已使用 typed parts、句后来源按钮和 opaque 文本弹窗;旧历史只读兼容与全量发布门禁已收口。

## 0. 冻结边界

1. LID 仍是内部唯一定位、引用校验、工具调用与诊断身份,不改 LID 模型。
2. 普通 Agent 对话前端不接收、解析或展示来源 LID;只接收 opaque `source_ref_id` 与用户标签。
3. 现有“轨迹”页是显式诊断面,本切片不改其工具参数、结果摘要或 LID 显示。
4. 来源引用是可选的;Runtime 不要求每个书内主张都有来源。
5. Agent 一旦想呈现内部位置,必须先把本轮已观察证据转成 `SourceRef`;原始 LID 不得进入普通回答。
6. `source.present` 只能消费本轮证据账本,不能为任意真实 LID 制造来源。
7. 本轮证据账本仅从用户验证选区、`book.query` citations、`book.synthesize` citations 与成功 `book.text` 读取中类型化提取。
8. `book.context`、route、reader state、viewport、recovery 和仅导航的 LID 不是直接证据。
9. 不修改现有 `book.*` 工具返回契约;证据观察发生在 orchestrator 执行结果写回 messages 之前。
10. 一个 `SourceRef` 绑定一段连续证据,可跨相邻 LID;不连续证据必须是多个 ref。
11. Agent 只放置受控 ref 标记;Runtime 校验并编译为类型化 `AgentAnswerPart`。
12. 未知 ref、ref 未被本轮观察、非连续范围或原始 LID 泄露都不得直接交付。
13. 非法回答只给一次受限修复;再失败则 fail-closed,保留用户问题并允许重新生成。
14. 来源标签从真实书树、节点类型与原文确定性派生;保留原始章节语言,只本地化节点类型。
15. 单来源按钮显示语义标签;同一句多来源合并为“N 个来源”按钮。
16. 按钮首次点击只打开来源弹窗,不改变主阅读区;弹窗的次级“在正文中查看”才导航。
17. 弹窗统一展示规范化原文文本,不在首版内嵌 PDF 页面裁剪。
18. 历史 ref 实时复验;失效时仅显示快照且关闭定位,不回退到最近 LID。
19. 旧历史不自动改写;只在渲染时转换明确标记且匹配真实 LID 的格式,歧义数字保持原文。
20. Agent 对话的问题引用头、操作提议与历史概览也使用用户标签;其他 Reader 面板不在本次范围。

## 1. 当前链路与根因

| 环节 | 当前实现 | 本方案判断 |
|---|---|---|
| Agent 工具执行 | `crates/runtime/src/orchestrator.rs::run_with_ephemeral_context` 执行后把原始 JSON 直接追加为 Tool message | 已有统一旁路观察点,不需改 book 契约 |
| 最终回答 | `OuterOutcome.answer: Option<String>` 原样接收 Agent 自由文本 | 无来源绑定和 LID 泄露闸 |
| Web 回答 | `RightRail.vue` 对 `turn.outcome.answer` 直接 `renderMarkdown` | 前端无法知道哪句绑定哪个 LID |
| 问题引用 | `RightRail.vue` 直接显示 `questionQuote.lid` | 即使回答干净,同一对话仍暴露 LID |
| 操作提议 | `App.vue::effLabel` 直接拼接 goto/highlight/note LID | 应投影语义标签,但不需证据账本 |
| 历史 | server 持久 `AgentChatTurn.outcome/question_quote/question_anchor_lid` | 新 ref 需内部绑定+对外 View 分离;legacy 字段要 default |
| 书树/原文 | `Book::manifest` 有树与 kind,`Book::text` 可取真原文 | 足以确定性生成标签和连续上下文 |

```text
现在:book/reader tool result(raw LID) -> Tool message -> free-text answer -> RightRail -> 用户看到 LID
目标:typed evidence -> ledger -> optional source.present -> Runtime compile -> typed parts -> blue button -> popup
```

## 2. 共享契约

### 2.1 内部绑定

```ts
interface EvidenceRange {
  start_lid: string;
  end_lid: string;
  ranges?: SelectedRange[];
}

interface StoredSourceBinding {
  source_ref_id: string;
  book_id: string;
  evidence_range: EvidenceRange;
  evidence_text_digest: string;
  label_snapshot: string;
  preview_snapshot: string;
}
```

- `start_lid..end_lid` 必须按当前书叶序连续;用户真实跨标题连续选区仍是合法证据。
- `ranges` 存在时必须全部落在该连续段内,用于弹窗精确高亮。
- `evidence_text_digest` 从已验证证据文本稳定派生,用于历史点击时检测失效。
- label/preview 快照只用于失效提示,不是第二原文真相源。

### 2.2 Agent 编译产物

```ts
type AgentAnswerPart =
  | { kind: "markdown"; text: string }
  | { kind: "sources"; source_ref_ids: string[] };

interface AgentAnswerView {
  parts: AgentAnswerPart[];
  sources: Array<{ source_ref_id: string; label: string }>;
}
```

- Agent 生成阶段可使用 `[[source:<ref>]]` 类受控标记,但它不得进入 Web 契约。
- Runtime 把标记编译为 `AgentAnswerPart`,并丢弃未被最终回答引用的临时 ref。
- 同一 ref 可在多个句子后复用;同一 sources part 含多 ref 时 Web 显示“N 个来源”。
- 普通 Web 契约不包含 stored binding、LID、ranges 或导航目标。

### 2.3 弹窗与导航 View

```ts
interface SourcePopupView {
  source_ref_id: string;
  label: string;
  highlighted_quote: string;
  context_before: string;
  context_after: string;
  stale: boolean;
  can_open_in_reader: boolean;
}
```

```text
POST /agent/source.resolve { turn_id, source_ref_id } -> SourcePopupView
POST /agent/source.open { turn_id, source_ref_id } -> Reader effect
```

- 端点通过 turn/ref 解析内部绑定,不接收客户端 LID。
- resolve 按当前原文重算 digest;失效只返快照与 `stale=true`,不产生导航命令。
- open 在服务端解析内部 LID 并返回 reader effect;前端不组装 `reader.goto(lid)`。

## 3. 本轮证据账本

```text
COLLECTING -> PRESENTING -> FINALIZING -> VALIDATING
VALIDATING -> DELIVERED | REPAIR_ONCE -> DELIVERED | FAILED_CLOSED
```

| 来源 | 写入证据账本 | 不写入 |
|---|---|---|
| 用户选区 | server 已验证 `ranges` 和 quote | 未解析 DOM 文本 |
| `book.query` | structural gate 通过的 `citations[]` | candidates、bindings、audit budget |
| `book.synthesize` | 最终过滤 `citations[]` | 无 citation 的输入 `source_lids` |
| `book.text` | 成功返回的请求范围+真原文 | not_found/recovery |
| context/route/state | 无 | anchor、items、path、viewport |
| `memory.*` | 首版无 | anchor/citations |

## 4. 标签与弹窗算法

```text
resolve_label(range):
  kind = localized_kind(start_lid)
  headings = nearest_nonempty_structural_ancestors(start_lid)
  title = shortest heading suffix that disambiguates current answer sources
  return title ? "{kind} · {original_title}" : "{generic_kind}"
```

- 章节标题从 `Book::text` 真实文本清理 Markdown 标记得到,不新增标题真相源。
- 英文标题保留英文;仅节点类型词本地化。
- 冲突时逐级加入父标题,不加原始 LID 消歧。

```text
context_window(range):
  center = exact evidence range
  boundary = smallest structural ancestor containing the whole range
  include complete containing paragraphs + adjacent leaves
  expand symmetrically inside boundary until target minimum
  stop at target maximum or boundary
```

- 中文目标 300-800 字,硬上限 1200 字;英文目标 120-300 词,硬上限 500 词。
- 不通过 semantic edge、concept 或 far context 拼接非连续段。
- Markdown/PDF 共用规范文本窗口;次级正文命令再按当前 Reader 表面定位。

## 5. 失败与兼容矩阵

| 条件 | 结果 |
|---|---|
| Agent 不想引用 | 不调 `source.present`,不补来源 |
| 未观察证据 | `SOURCE_NOT_OBSERVED`,不建 ref |
| 非连续范围 | `INVALID_SOURCE_RANGE`,不建 ref |
| 最终回答含未知 ref 或原始 LID | 一次修复;再失败不交付 |
| 历史 source digest 失效 | 显示快照,禁用导航 |
| 旧 question quote/effect 有结构 LID | 实时投影用户标签 |
| 旧 answer 有明确 LID 格式 | 保守渲染按钮,不改历史文件 |
| 旧 answer 有歧义裸数字 | 保持原文 |
| 轨迹页含 LID | 保持现状 |

## 6. 切片依赖

```text
SR0 docs
  -> SR1 deterministic source resolver
      -> SR2 turn evidence ledger + source.present
          -> SR3 final-answer compiler + delivery gate
              -> SR4 durable bindings + opaque server views
                  -> SR5 inline source UI + popup
                      -> SR6 compatibility + release gates
```

与当前 Note placement 工作的关系:

- SR0 只落文档,不吸收或清理现有 Rust dirty diff。
- SR1-SR4 开始前必须先完成 checkpoint 要求的 Rust dirty 归属审计。
- SR5 与 NP2 共享 `App.vue`、`RightRail.vue` 和 Agent 回答选区;两者不得在同一切片并行改动。
- 默认先完成 NP1/NP2 再进 SR5;SR1-SR4 可独立开展,但不得顺手修 Note placement。

## 7. SR0 - 决策与切片冻结 [Docs] (本次)

**Do**:定义术语,新增 ADR-0086,记录泄露链路、共享契约、SR1-SR6 与发布门禁,追加代码链路。

**Do not**:不修改 Rust/TypeScript/Vue、生成类型、测试、依赖、对话历史或轨迹页。

**Done**:Grill 决定都可追溯;新术语回链 ADR;链接、范围与 `git diff --check` 通过。

## 8. SR1 - 确定性来源解析器 [ReadTools] (完成 2026-07-20)

**Do**:建立内部 `EvidenceRange/ResolvedSource`,验证连续性与上下文扩展边界,派生原始标题、本地化类型、预览、digest 与连续上下文。

**Do not**:不建标题存储,不调 LLM,不改 `book.*` JSON,不组合 semantic context 或 PDF 裁剪。

**Done**:中英文章节、无标题、重名、跨 LID/跨标题连续选区和长度上限有确定性测试;非连续、range 越界和 digest 失配 fail-closed。

**Verify**:`cargo test -p read-tools source_presentation`。

## 9. SR2 - 本轮证据账本与 source.present [Runtime] (完成 2026-07-20)

**Do**:在 orchestrator 建回合级 ledger/ref registry;按工具类型旁路观察;注入已验证 question quote;新增只接受 ledger 子集的 `source.present`。

**Do not**:不递归扫所有 `lid`,不把 route/state/context 当证据,不强制调用,不改 book 工具输出。

**Done**:query/synthesize/text/selection 全绿;context/route/state/error 全不记账;未观察和非连续请求被稳定拒绝。

**Verify**:`cargo test -p runtime source_presentation`。

## 10. SR3 - 最终回答编译与交付闸 [Runtime] (完成 2026-07-20)

**Do**:解析受控 ref,输出 `AgentAnswerPart`,裁剪未用 ref,校验归属/语法/LID 泄露,实施一次修复和 typed fail-closed;Native/ReAct 共用闸。

**Do not**:不要求引用覆盖率,不用 LLM 判断来源合理性,不正则替换数字。

**Done**:无来源回答零 source 调用;unknown/unused/cross-turn ref、原始 LID 和坏标记均先 red,只有合法修复可交付。

**Verify**:`cargo test -p runtime source_presentation` 和 Native/ReAct 等价 fixture。

## 11. SR4 - 持久绑定与 opaque Server View [Server/API] (完成 2026-07-20)

**Do**:拆用户 outcome 与 server-only bindings;扩展 history 持久但建无 LID View DTO;新增 resolve/open;为 question quote、effect 和历史摘要生标签。

**Do not**:不对 Web 序列化 LID/ranges/bindings,不在 stale 时 nearest fallback,不把完整上下文写入 history。

**Done**:新旧 history roundtrip;对外 JSON 零 LID 字段;重启后 ref 可 resolve/open;wrong owner 与 stale 全 fail-closed。

**Verify**:`cargo test -p server agent_source` 和 API generated types diff。

## 12. SR5 - 句后按钮与来源弹窗 [Web] (完成 2026-07-20)

**Do**:`RightRail` 渲染 typed parts;单/多来源蓝色按钮;桌面锚定弹窗/移动底部弹层;高亮证据+连续上下文+次级导航;同步 quote/effect/history 标签;保持回答选区。

**Do not**:不改轨迹,不首击跳 Reader,不做末尾来源表或 PDF 裁剪,不显示 LID,不与 NP2 混片。

**Done**:无来源回答回归不变;单/多 ref 位置正确;desktop/mobile 无重叠溢出;普通 Agent DOM 无 LID;轨迹不变。

**Verify**:`pnpm -C packages/web test`;typecheck;build;专用 Playwright 视觉/交互测试。

## 13. SR6 - 历史兼容与发布门禁 [Cross-cutting] (完成 2026-07-20)

**Do**:用 Markdown-aware 解析保守转旧明确 LID 格式;覆盖重启/切书/删历史/stale/并发/迟到响应;更新架构和代码链路;跑全量回归与真书重放。

**Do not**:不批量改写历史,不把歧义数字当 LID,不以手工观察代替确定性断言。

**Done**:新普通对话 LID 泄露率 0;无引用回答零 source 开销;旧历史零写回/零误替换;来源可核验、可重放、stale 不猜测。

## 14. 发布硬门禁

1. `book.*` 公开工具返回契约不得因来源呈现而改动。
2. Evidence ledger 只接受白名单类型提取器,不得递归收集通用 `lid`。
3. `source.present` 不得呈现未观察或非连续证据。
4. Agent 不想引用时不得强制调用 `source.present`。
5. 普通交付不得含原始 LID、未知 ref 或未编译标记。
6. 非法回答只修复一次,不得正则清洗后伪报成功。
7. 对外 Agent/history/source View 不得序列化 LID/ranges/stored binding。
8. 单来源必须在相关句后;多来源必须合并按钮。
9. 首次点击来源不得改变主阅读区;只有次级命令可导航。
10. 弹窗上下文必须连续、受最小共同结构边界限制且有上限,不得混入远处语义召回。
11. stale/missing source 不得 nearest fallback 或静默换位置。
12. 旧历史不得自动写回;歧义数字不得转换。
13. 轨迹页保持现状;排除不得扩大为整个 Agent 面板的 LID 豁免。
14. Desktop/mobile 按钮、弹窗、文字与工具不得重叠、溢出或阻断回答选区。

## 15. 实施验证命令

```powershell
cargo test -p read-tools source_presentation
cargo test -p runtime source_presentation
cargo test -p server agent_source
pnpm -C packages/web test
pnpm -C packages/web typecheck
pnpm -C packages/web build
git diff --check
```

SR5/SR6 另运行专用 Playwright 用例,并检查 1440x900 与 390x844 截图。SR0 本次只运行文档范围、链接与 diff 检查,不伪报代码测试。
