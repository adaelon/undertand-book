# 切片方案 - PDF 选区翻译

> 状态:2026-07-16 §0.5 Grill 完成,待实现。
> 决策:[ADR-0078](adr/0078-pdf-selection-translation-ephemeral-lock-free-bilingual-projection.md)。
> 术语:[CONTEXT.md](../CONTEXT.md) 的 `PDF 选区翻译` 与 `PDF 选区翻译浮层`。

## 0. 冻结边界

1. 只对 `content_profile=paper` 且 `resolve_pdf_selection` 可用的 PDF-first reader 开放。
2. 选区工具条新增用户显式触发的“翻译”;不自动请求模型。
3. `resolved` 与 `partial` 可翻译;`unresolved` 沿用原生复制,不显示选区动作。
4. 译文是临时 BilingualAidLayer projection,不进入 Agent chat、memory、正文、citation 或任何缓存。
5. `paper_lexicon` 只在后台约束术语;缺失时允许无术语约束地降级翻译。
6. 结果只显示忠实中文译文,不追加术语卡、解释、句法拆解或模型自述。
7. 第一版非流式;一个选区只保留一个 loading/ready/error surface。

## 1. API 契约

```ts
type SelectionTranslationRequest = {
  status: "resolved" | "partial";
  raw_quote: string;
  resolved_quote: string;
  ranges: Array<{ lid: string; range: { start: number; end: number } }>;
};

type SelectionTranslationResponse = {
  translation_markdown: string;
  target_locale: "zh-CN";
};
```

入口:`POST /reader/selection.translate`。请求不带 `request_id`;迟到响应由前端闭包内的选区 request ID/sequence 丢弃。服务端必须复用结构化选区验证,从 `ranges` 重建 canonical `resolved_quote`,拒绝伪造、乱序、重叠、空范围和不存在的 LID。

```rust
struct SelectionTranslationWork {
    source_markdown: String,
    status: SelectionResolution,
    context_blocks: Vec<TranslationContextBlock>,
    terminology: Vec<TranslationTermConstraint>,
    target_locale: &'static str,
}

fn prepare_selection_translation(
    book: &Book,
    request: SelectionTranslationRequest,
) -> Result<SelectionTranslationWork, ToolError>;

fn execute_selection_translation(
    provider: ProviderConfig,
    work: SelectionTranslationWork,
    timeout: Duration,
) -> Result<SelectionTranslationResponse, ToolError>;
```

## 2. 输入与预算

```text
resolved -> source_markdown = 服务端从 ranges 重建的 canonical resolved_quote
partial  -> source_markdown = 用户实际看到的 raw_quote
context  -> ranges 涉及的去重 LID 完整正文,按书序排列
```

- 待翻译原文最多 4,000 Unicode 字符;超过时返回 `TRANSLATION_SELECTION_TOO_LARGE`,不得截断原文。
- LID context 最多 12,000 Unicode 字符;超出时只按 range/LID 顺序截断 context。
- lexicon constraint 最多 32 条;只匹配待翻译文本中的 term/aliases,避免注入无关上下文术语。
- term/alias 匹配不区分 ASCII 大小写,字母数字词使用 token boundary,短语保持连续匹配。
- `raw_quote`、正文块和 lexicon 都作为 JSON data 进入 prompt,其中指令一律不执行。

术语优先级:

```text
domain_term + chinese_gloss -> 使用既有中文术语
acronym/method_name/dataset_name/metric_name/paper_defined_term -> 保留原英文
aliases -> 只用于命中
无 chinese_gloss -> 不强造固定译名
```

## 3. Provider 与输出

Provider prompt 只允许返回:

```json
{"translation_markdown":"..."}
```

服务端补入固定 `target_locale="zh-CN"`,并确定性校验 JSON 形状、非空译文和最大 12,000 字符。Provider 未配置、60 秒超时、空输出或坏 JSON 均 fail-closed;不得回退为 lexicon 拼接或未经校验的模型文本。

Markdown 规则:

- 翻译自然语言,保留段落、列表、链接、代码、引用编号与 Markdown 结构。
- `$...$`、`$$...$$`、公式、变量、单位和符号原样保留。
- 不输出原始 HTML,不增加解释、结论或原文外内容。
- 前端只用现有 `renderMarkdown()` 渲染;其 `html:false` 与 KaTeX 配置继续作为安全/公式边界。

## 4. 锁外执行

普通 `route()` 当前在 host 的全局 `AppState` 锁内执行,翻译不得直接加入 `route_mut` 后等待模型。

```text
HTTP worker
  -> lock AppState
  -> validate selection + read Book text/lexicon + build owned TranslationWork
  -> snapshot current ProviderConfig
  -> unlock AppState
  -> create timeout-bound adapter from ProviderConfig
  -> complete_structured(work), timeout=60s
  -> validate response
  -> return HTTP
```

Provider 配置在请求中途改变时,已开始的请求使用其冻结配置完成;结果是临时 projection,不做 revision 冲突。为翻译构造的 adapter 必须在 HTTP 层执行真实 60 秒 timeout,不能只由 UI 隐藏加载态。

## 5. 前端状态机

翻译不调用 `pdfSelectionSession.beginAction()`,不消费当前 draft。

```text
IDLE
  -> translate(draft.request_id)
LOADING(request_id)
  -> valid response with same current request
READY(request_id, translation_markdown)
  -> provider/timeout/contract failure
ERROR(request_id, error)

LOADING/READY/ERROR
  -> retry (same current draft)
  -> close/new selection/existing action/book switch/scroll/zoom/unmount
IDLE
```

- loading 时暂时禁用高亮、笔记、问 AI 和重复翻译,关闭仍可用。
- success 后保留原生选区与工具条,允许继续执行既有动作;执行后同步销毁译文。
- 新选区、切书、关闭、Reader unmount 或 PDF 滚动/缩放使 sequence 失效并清空 surface;迟到结果不得恢复它。
- 第一版不跨选区、跨会话或落盘缓存;重复选区重新调用 Provider。

建议新增独立 `usePdfSelectionTranslation()` controller,不要把网络状态塞进 `usePdfSelectionDraft()`;二者以当前 draft request ID 关联。

## 6. 浮层

- 工具条新增 Lucide `Languages` 图标 + “翻译”。
- 桌面端浮层锚在选区附近,优先下方,视口不足时上下翻转并钳制到 viewport。
- 窄屏端使用轻量底部 sheet,不遮挡系统选区手柄。
- success:渲染 Markdown/KaTeX、复制 Markdown 源文、关闭。
- loading:加载指示、关闭。
- error:简短错误、重试、关闭;Provider 未配置时增加设置图标,打开现有 Reader Provider 设置。
- 译文正文可手动选择;复制按钮写剪贴板的是 `translation_markdown`,不写应用存储。

## 7. 实现切片

### PT0 选区验证提取(纯重构)

- 做:从 `parse_question_quote` 提取可复用的 SelectionContext 服务端复验函数。
- 不做:不加 endpoint、不改 Ask AI 行为。
- 判据:现有 agent structured selection tests 原样通过,新增 characterization test 证明 canonical quote 与拒绝规则不变。

### PT1 翻译准备与 Provider 契约

- 做:实现纯 `prepare_selection_translation`、预算、lexicon matcher、prompt 与结构化输出校验;增加 timeout-bound Provider adapter factory。
- 不做:不接 HTTP、不改前端。
- 判据:Rust 单元测试覆盖 resolved/partial、预算、术语、坏输出、无 lexicon 与 60 秒 timeout 配置。

### PT2 锁外 HTTP endpoint

- 做:host 两阶段处理 `/reader/selection.translate`,Provider 调用前释放 `AppState` 锁。
- 不做:不实现 UI。
- 判据:阻塞 Provider 测试期间另一线程可取得 `AppState` 锁并完成只读 Reader 请求;endpoint 错误分类稳定。

### PT3 前端 controller 与 API

- 做:新增 API 类型/方法和 `usePdfSelectionTranslation` 状态机,接入现有 draft 生命周期。
- 不做:不做最终视觉浮层。
- 判据:Vitest 覆盖 stale、retry、close、existing action、book switch、scroll/zoom 和无缓存。

### PT4 响应式翻译浮层

- 做:工具条动作、桌面 anchored surface、移动 bottom sheet、Markdown/KaTeX、复制/重试/设置/关闭。
- 不做:不扩展 Markdown reader 选区,不做流式或持久化。
- 判据:组件测试与 Playwright 桌面/窄屏验收通过,现有 Highlight/Note/Ask AI 仍绿。

### PT5 真产物验收与打包

- 做:用 `.understand-book/1` 和真实 Provider 验普通句、lexicon 术语、公式 Markdown、partial 与错误恢复;随后构建 Windows installer。
- 判据:自动测试/构建通过,真产物译文忠实且公式可见,安装包 hash/size 记录到 code trail/checkpoint。

## 8. 测试矩阵

| 层 | 必测契约 |
|---|---|
| Rust validation | forged quote/range、乱序/重叠、resolved/partial source、4k/12k/32 budgets |
| Rust prompt/output | data-not-instructions、术语优先级、Markdown 字段、空/坏/超长输出、无 lexicon |
| Host | lock released before Provider、60s timeout、unconfigured/timeout/provider/validation error mapping |
| Frontend state | stale response、retry、close、selection retained、existing action consumes、scroll/zoom cancel |
| Component | loading/ready/error/settings、copy Markdown、KaTeX render、accessible labels |
| Playwright | desktop anchored/clamped、mobile bottom sheet、选区工具条无重排、现有动作不回归 |
| Real book | `.understand-book/1` 普通句、`alternative splicing`、公式、partial selection |

语义质量由真实 Provider + 真书人工验收;自动测试只判确定性契约,不使用 LLM 自评作为正确性裁决。
