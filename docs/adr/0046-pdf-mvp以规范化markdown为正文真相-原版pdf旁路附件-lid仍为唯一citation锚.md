# ADR-0046 PDF MVP 以规范化 Markdown 为正文真相 / 原版 PDF 旁路附件 / LID 仍为唯一 citation 锚

状态:已接受(2026-07-05,PDF/paper §0.5 产品形态修正)

## 背景
现有产品核心是 LID 驱动的连续语义阅读器,不是 PDF 页面阅读器。构建管线以 `source + SourceBlock[]` 作为 LID 切分输入;Markdown/EPUB 已能进入该地基。PDF/OCR 质量本身是大坑:双栏、脚注、公式、表格、参考文献顺序都会影响正文真相。若本项目在 MVP 内自建 PDF/OCR,会把大量版面解析不确定性灌进 LID/source/book.text,反而污染核心语义阅读能力。

## 决策
1. **MVP 正文真相 = 规范化 Markdown**:用户先用外部 OCR / PDF-to-Markdown 工具把 PDF 论文转换并清洗成 Markdown;本项目只以该 Markdown 生成 `source/source.txt`、`SourceBlock[]`、`LID/span/book.text`。
2. **原版 PDF = 旁路附件**:构建可接受一个 optional original PDF attachment,用于旁路预览、人工核对和未来回跳;它不参与 LID 切分。
3. **PDF source map 可选,不进 MVP 必需项**:若外部工具同时产出 `md_span -> page/bbox` 映射,阅读器可用它做 LID 到 PDF 页框的预览回跳;没有 source map 时只提供原 PDF 打开/人工核对。
4. **LID 仍是唯一证据锚**:图谱节点、断言、引用、FormulaSemantics、BookStructure evidence 只能引用真实 LID;PDF 页码/bbox/source map 只做 provenance。
5. **内建 PDF/OCR normalizer 延后**:后续可做 PDF adapter 或 OCR normalizer,但必须先产出同样的规范化 Markdown/source map,不得把 page/bbox 升格为 citation anchor。
6. **paper profile 不引入新锚定体系**:`paper` 只约束英语学术论文的构建/抽取规则,复用同一 LID/source/book.text 地基。

## 命门
- **正文真相只能有一套**:MVP 中是 cleaned Markdown,不是 PDF 页面坐标。
- **PDF 预览不是阅读地基**:旁路 PDF 只帮用户核对原版版面,主阅读体验仍是 understand-book 连续正文/LID 阅读器。
- **source map 只加体验,不加证据权力**:即使能跳 page/bbox,citation anchor 仍是 LID。

## 否决
- MVP 内自建 PDF/OCR normalizer:范围过大,且会把解析质量问题提前压到核心产品地基。
- 直接用 `page:bbox` 作为 citation:不可由现有图谱闸校验,也无法保证 `book.text` 可复现。
- 原版 PDF 页面阅读器作为主 UI:会引入新的前端、高亮、锚定和滚动体系,偏离当前产品形态。
- 没有 source map 却承诺 LID 精确跳回 PDF bbox:证据不足,只能旁路打开/人工核对。

## 何时回头
- 外部 OCR/PDF-to-Markdown 流程稳定后,评估内建 normalizer,但输出仍必须是 Markdown/source map。
- 用户强需求原版 PDF 高亮同步时,先支持 optional source map sidecar,再考虑 PDF.js 预览层。
- 论文抽取规则需要专门产物时,另立 ADR 定义 paper profile sidecar,仍复用 LID 证据。

## 影响
- `CONTEXT.md` 新增 `规范化 Markdown 正文`、`PDF 旁路附件`、`PDF source map`、`paper profile`。
- 后续实现优先扩展 build/read 参数:允许 Markdown canonical source 搭配 optional original PDF attachment。
- 暂不新增 PDF adapter 到 `load-book.ts`;内建 PDF/OCR normalizer 延后。
- 后续 Grill 继续定义 `paper` profile 的抽取内容、抽取规则和实现切片;本 ADR 不写代码。
