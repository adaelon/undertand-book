# MW3 原生选区、来源往返与正文连续性

状态：实现完成，定向验证通过；允许本地受控技术材料试用，不代表 PDF/RP 或整体移动端完成。日期：2026-09-18。

## 实现链路

- `useReaderSelection.ts` 监听 document `selectionchange`，以 pointerup/keyup 补调度；只接收当前 Reader 根内、非编辑控件、非空选区，克隆 Range、文本和矩形并用签名合并重复事件。
- ReaderPane 把冻结快照交给 App 既有 `selectionRanges` 与 `rangeToMarkdown`，沿用 LID/UTF-16/KaTeX 语义；Ask、Note、高亮在点击时消费当前书/会话身份绑定的快照，不重新读取可能已折叠的 DOM Selection。
- RightRail 在唯一一次 `agentSourceOpen` 前同步发出来源身份，App 先捕获 Markdown LID/相对 top；权威打开成功后返回点才入有界栈。显式“返回回答”恢复原阅读锚点、切回 Agent 并按稳定 turn id 定位原消息。切书/切会话使旧返回点及在途恢复失效；真实用户滚动会取消旧恢复。
- Agent 输入在 composition/229 期间不响应 Ctrl+Enter；移动 Enter 保持换行，发送按钮和桌面 Ctrl+Enter 保留。
- 代码/表格保持局部横滚，并提供软换行与同实例展开；切换显示不改原始文本。

## 验证

- 定向 Vitest：工作区、视口、选区、装饰节点过滤、连续性、ReaderPane、RightRail 共 45 项通过。
- 全量 Web：49 个测试文件、255 项通过；类型检查、Vite 生产构建通过。构建仅保留既有大 chunk 警告，没有新增构建失败。
- 浏览器矩阵 12/12 通过：文档级选择不依赖 mouseup；DOM Selection 清空后冻结文本仍可用；宽代码换行/展开不改源文本；IME composition 期间 0 次提交，结束后的显式桌面快捷键 1 次提交。
- 来源组件测试确认预览只调用 resolve；显式打开恰好一次 open，并在 open 前发出同一 turn/source 身份。返回点 LIFO、有界、上下文失效和用户取消由纯状态测试覆盖。

## 已知限制

- 本轮未连接真实 Agent/Linux 实例，未把来源往返浏览器夹具误写为线上闭环；权威 API 与 App 集成由既有来源测试和新增组件/状态测试覆盖。
- Markdown 返回保存 LID 与相对 top；PDF 精确返回需 MW4 的页面几何与语义锚点，当前 PDF 来源只保留回答返回，不宣称原 PDF 读位已完成。
- 自动构造的浏览器 Selection 不能替代 iPhone 长按、拖动手柄、中文系统键盘与真实旋转；这些仍是 MW8 的人工实测门槛。
