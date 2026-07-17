# 切片方案 - PDF 选区边界稳定性

> 状态:2026-07-17 PE0-PE5 已完成。
> 决策:[ADR-0080](adr/0080-pdf-text-layer-native-selection-lifecycle.md)。
> 既有边界:[ADR-0074](adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md) 与 [ADR-0079](adr/0079-pdf-selection-banded-reading-order-and-conservative-resynchronization.md)。

## 0. 冻结边界

1. 只修原生 PDF 拖选终点落在视觉行尾或段尾空白时,DOM Selection 向前或向后扩张的问题。
2. 保持 canonical `source.txt`、LID/range、`pdf_selection_map` 与后端 `pdf_selection.resolve` 契约不变。
3. 不用 quote 截断、rect 面积阈值或特定页/文本条件掩盖错误 DOM Range。
4. 保持行内、跨行、跨段原生复制,以及 resolved/partial/unresolved 工具条门禁。
5. 不混入当前工作树的 memory/profile Rust 修改,不自动安装生成的 Windows 包。

## 1. 已证实根因

当前 `PdfReaderPane` 直接实例化低层 `pdfjsLib.TextLayer`,只复制了基础 span/br 样式,没有使用 PDF.js `TextLayerBuilder` 的 `endOfContent` 与全局 selection lifecycle。

```text
指针越过绝对定位文本 span 的右边界
  -> 命中 text-layer 空白
  -> caret 回退到具有错误静态几何的可选择 br / parent child offset
  -> DOM Range 跨过不相关的 PDF text items
  -> capturePdfSelection 原样发送扩张后的 raw_quote + rects
```

正式页 5 的确定性复现:
- `Due to its tolerance`:停在末字符为 20 字;越过行尾 2px 变为前 6 行、307 字。
- `2A and 2B).`:停在末字符为 11 字;越过段尾 2px 变为 118 字。
- 行尾目标为 text-layer child 54,错误 caret 落到 parent offset 36;child 36 是覆盖该 y 坐标的幽灵 `br`。
- 请求体 `raw_quote` 与错误的 `window.getSelection().toString()` 完全一致,后端不是首个错误层。
- 运行时注入 `TextLayerBuilder` 等价 selection scaffold 后,两个样本分别恢复为 20 字和 11 字。

## 2. 修复契约

```text
RENDER_PAGE
  -> new TextLayerBuilder({ pdfPage, onAppend, abortSignal })
  -> builder.render({ viewport })
  -> builder.div owns native selection lifecycle

ZOOM | BOOK_SWITCH | RERENDER | UNMOUNT
  -> builder.cancel()
  -> unregister global selection ownership
  -> remove rendered text-layer DOM

MOUSEUP
  -> capturePdfSelection reads the builder-stabilized Selection
  -> existing resolve/draft/toolbar path remains unchanged
```

CSS 只在 `.pdf-text-layer .textLayer` 下补齐当前 PDF.js 版本的文字、`br::selection`、`.endOfContent` 和 `.selecting` 契约;不引入整份 viewer 全局样式。

## 3. PE0 - 决策与方案落档

- **Do**:冻结根因、边界、官方 selection lifecycle 决策、切片和验收矩阵。
- **Do not**:不修改运行时代码或测试。
- **Done**:ADR-0080 与本方案互链;后续每片均有独立退出判据。

## 4. PE1 - 真实鼠标边界红测

- **Do**:扩展 Playwright PDF fixture,用真实鼠标分别越过普通行尾和段尾 2px;断言原生 Selection 与 resolve 请求 `raw_quote` 只含用户目标文字。
- **Do not**:不使用 `document.createRange()` 伪造通过,不修改生产代码。
- **Done**:修复前测试稳定失败,并能分别观测错误扩张文本;既有 resolved/partial/unresolved 用例保持原状。

## 5. PE2 - TextLayerBuilder 最小接入

- **Do**:用公开 `TextLayerBuilder` 替换低层 `TextLayer`;让每页 builder 在缩放、重渲染和卸载时确定性 cancel;补齐作用域内 CSS 契约与单元生命周期覆盖。
- **Do not**:不修改 `capturePdfSelection`、后端 resolve、selection map 或工具条状态机。
- **Done**:PE1 两个物理拖选用例转绿;单测证明 builder append/cancel 生命周期;无残留全局选区 owner。

## 6. PE3 - Web 回归与构建

- **Do**:运行 PdfReaderPane 单测、selection Playwright、Web 全量测试、typecheck/build;检查生产 bundle 未引入整份 viewer CSS 的全局冲突。
- **Do not**:不以 AI 目测代替 runner 结果。
- **Done**:所有命令退出 0;resolved/partial/unresolved、翻译、标注、缩放与原生复制路径无回归。

## 7. PE4 - 真书验收与收口

- **Do**:在正式书页 5 对两个已冻结样本做物理 Chromium 拖选,核对 Selection、请求 quote 和工具条稳定性;更新代码链路、架构索引与 SESSION_CHECKPOINT;通过后再构建隔离的 Windows artifact。
- **Do not**:不覆盖 canonical book artifact,不混入既有 Rust 修改,不自动运行安装器。
- **Done**:行尾 20/20、段尾 11/11,无额外 rect/quote;Windows package 命令退出 0并记录大小/hash,或明确记录未构建原因。
- **Evidence**:正式书 pageIndex 5 的 `Due to its tolerance` 为 20/20、`2A and 2B).` 为 11/11,两者均只产生 1 个 rect 且 resolve HTTP 为 200;隔离 worktree 的 Setup/NSIS 均为 34,754,425 bytes,SHA-256 `ECE6D45232EC4B69C89320D80F3F574BC4B143A0BAC13C94B9D60CE3D1D0D061`。

## 8. 确定性验收矩阵

| 层 | 必测契约 |
|---|---|
| DOM | 最后字符与右侧 2px 空白产生同一目标 Selection |
| Pointer | 普通行尾、段尾均使用真实 mouse down/move/up |
| Capture | `raw_quote` 与目标文字相等,rect 只覆盖目标行 |
| Lifecycle | zoom/book switch/unmount 均 cancel builder |
| Existing actions | resolved/partial/unresolved 与原生复制不回归 |
| Real book | 页 5 两个冻结样本在真实 TextLayer 上通过 |
| Distribution | Web build 通过;隔离 Windows artifact 不混入既有 Rust 修改 |
| Mid-line start | 鼠标按在行中间字符时,anchor 保持该字符 offset,不被 `.endOfContent` 截获 |

## 9. PE5 - 行中间起选 specificity 回归

- **Do**:用真实鼠标从单行 offset 15 拖到 27,断言原生 Selection 与请求均为 `fixture text`;在正式书上从 offset 7 拖到 20,断言 `its tolerance`。
- **Do not**:不回退 TextLayerBuilder,不改变尾部边界、capture、resolve 或 selection map。
- **Root cause**:作用域选择器 `.textLayer > :not(.markedContent)` 同时命中 `.endOfContent`,而较短的 `.endOfContent` 规则 specificity 更低,使尾节点按下后以 `z-index: 1` 覆盖整页文字并吞掉 mousemove。
- **Done**:base selector 改为 `.textLayer .endOfContent`,有效 `z-index` 恢复为 0;合成 PDF 中间起选、行尾、段尾与正式书中间起选全部通过;最终 Windows artifact 独立重建。
