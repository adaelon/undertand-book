# MW9 显式 Markdown/PDF 阅读表面选择记录

日期：2026-09-18
基线：`8dea7b0`；在 MW4 的 source-bound PDF 锚点和既有 Markdown LID 上实现。
结论：实现完成并通过本地定向、全量 Web 与移动浏览器回归；真实双栏 PDF 和 iPhone 表面往返仍属于 MW8 外部验收。

## 实现

- `activeReaderSurface` 与 `pdfReaderAvailable` 分离。PDF 能力只决定是否显示选择器；当前选择显式决定挂载 `PdfReaderPane` 或 `ReaderPane`。
- Markdown/PDF 偏好按 `book_id + source_fingerprint` 写入本机 `localStorage`。没有偏好时兼容旧行为：可用 PDF 默认打开 PDF；能力暂时不可用时降级 Markdown，但不覆写用户原偏好。
- `ReaderWorkspace` 提供可键盘操作的 Markdown/PDF 按钮；旋转与几何变化不会自动切换表面，也不写后端布局状态。
- 切换前冻结当前 LID 或 source-bound PDF 页内锚点，清理旧表面的临时 PDF 翻译/选择。PDF 无可靠 LID 映射时保留原页面或此前 Markdown 读位并提示限制，不猜测精确位置。
- 笔记放置表面、来源返回点、PDF 定位警告与模板挂载统一读取 `activeReaderSurface`；原规范 Markdown、PDF、source map 和选区 resolver 身份不变。

## 验证

- `reader-surface.test.ts` 2 项覆盖默认选择、能力降级、按书/来源隔离和非法存储值。
- `ReaderWorkspace.test.ts` 6 项包含显式表面选择事件和能力不可用时隐藏选择器。
- 表面相关定向测试 36/36；MW7+MW9 合并定向 37/37；Web 全量 53 文件/271 项、生产 build、移动矩阵 12/12 通过。

## 已知限制

- 无映射 PDF 位置只给出明确降级，不提供文本相似度猜测。
- localStorage 仅保存当前设备的呈现偏好，不持久化草稿、选区或学习记忆，也不在设备间同步。
- 尚未用真实 iPhone Safari 完成 Markdown/PDF 往返、双栏 PDF 原生手柄和后台恢复人工验收。
