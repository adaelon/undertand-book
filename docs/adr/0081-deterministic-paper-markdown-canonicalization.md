# ADR-0081 Deterministic paper Markdown canonicalization

Status: Accepted, 2026-07-17.

### §1 论文 Markdown 表示噪声

**决策**:来源对齐前确定性规范化纯展示噪声。

**否决**:
- 开启 raw HTML 渲染:扩大 XSS 面且保留脏正文。
- 只改 LLM prompt:格式等价项不会进入 LLM。
- 全量剥离 HTML:会破坏图片、表格和未知结构。

**命门**:规范化正文必须同时承担对齐 span、人工决策和最终 source.txt。
**何时回头**:图表结构成为可引用语义证据时。
**展开**:[ADR-0063](0063-paper-pdf-first-reconciled-source-build-workbench.md)
