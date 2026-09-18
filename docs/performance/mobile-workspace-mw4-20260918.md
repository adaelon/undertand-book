# MW4 PDF 容器重绘、位置和资源一致性记录

日期：2026-09-18
基线：`8dea7b0`；在已有大量未提交改动的工作树上实施，未重置或覆盖其他切片。
结论：实现完成并通过本地定向与 Web 全量回归；真实 iPhone、旋转页/双栏材料的人工几何测量及 30 页长滚动内存观测未在本切片宣称通过。

## 实现

- `PdfReaderPane` 改为观察实际页面列表容器。宽度或 DPR 改变时先捕获页内锚点，再推进 render generation、取消旧任务并重建；仅高度改变只重新安排可见页。零宽或零高释放驻留并等待恢复。
- 每次 canvas、文字层和异步追加都校验 source、page、CSS 尺寸、raster scale 与 generation 的统一 identity；旧任务即使晚返回也不能提交。几何待定期间文字层和标注层不接受指针交互。
- `planPdfRenderResidency` 按当前页距离选择驻留页，最多 5 张；总 backing pixels 上限为 12,000,000，超限先减少远页，再降低 raster scale，CSS 几何不变。
- 阅读返回点增加 source-bound PDF 锚点：页号、页内比例、探针比例和横向比例均绑定当前 `sourceKey`。App 的来源打开/返回栈可恢复 PDF 页内位置，不把屏幕比例当作证据坐标。
- 既有 PDF selection resolver、标注坐标与证据映射算法未替换；本切片只收口渲染生命周期和读位。

## 验证

- 红测试先复现缺少渲染预算模块、未观察容器、零尺寸仍可能渲染、宽度变化后旧结果可能提交以及 PDF 返回点未绑定来源。
- 定向 Vitest：`pdf-rendering`、`useReadingContinuity`、`PdfReaderPane` 与 note placement 共 20 项通过。
- Web 全量：51 个文件、262 项通过；类型检查随生产构建通过，Vite production build 成功。
- 浏览器矩阵：Chromium/WebKit 的 390×844、844×390 与桌面共 12 项通过，确认既有工作区连续性未回退。

## 已知限制

- 单元测试锁定同代提交、零尺寸和预算上限，但尚未用真实旋转页/双栏 PDF 对 canvas、文字层和标注中心做 ≤2 CSS px 的人工量测，因此不把总验收门 G6 标绿。
- 尚未在真实 iPhone Safari 或 Linux 正式入口测量 DPR 变化、GPU/浏览器总内存；12,000,000 仅是 canvas backing pixel 预算，不是进程内存结论。
- 显式 Markdown/PDF 阅读表面切换仍属于 MW9。
