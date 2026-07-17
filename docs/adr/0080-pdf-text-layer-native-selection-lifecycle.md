# ADR-0080 PDF text-layer native selection lifecycle

Status: Accepted, 2026-07-17.

### §1 PDF 文本层选区所有权

**决策**:使用 PDF.js TextLayerBuilder 管理原生选区。

**否决**:
- 截断 raw quote:无法恢复已错误的 DOM Range。
- 过滤异常 rect:文字内容仍会错误扩张。
- 复制私有监听器:随 PDF.js 升级容易漂移。

**命门**:builder 必须确定性 cancel,且作用域 CSS 必须让 `.endOfContent` 的有效 `z-index` 保持为 0。
**何时回头**:PDF.js 移除公开 TextLayerBuilder 或其选择契约不再兼容自定义页面容器时。
**展开**:[PDF 选区边界稳定性切片方案](../切片方案-pdf选区边界稳定性.md)
