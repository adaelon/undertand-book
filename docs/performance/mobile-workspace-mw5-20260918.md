# MW5 RP 宿主、低高度展开与现场保持记录

日期：2026-09-18
基线：`8dea7b0`；保留既有 RP1–RP7 与工作树中的未提交成果。
结论：实现完成并通过组件、真实浏览器及真实 Rust 验收宿主的定向回归；未宣称真实 iPhone 或 Linux 正式入口通过。

## 实现

- `AgentPresentation` 在内嵌、单区、对照和展开之间保留同一个 iframe；纯布局切换不改 `srcdoc`。组件以父容器 `ResizeObserver` 计算可用高度，长内容在稳定 frame 内滚动。
- 展开层使用安全区和低高度布局：标题/追问区固定收敛，内容区独立滚动，关闭、展开和追问按钮保持至少 44px；关闭后焦点返回原展开按钮。
- 桥接协议增加最小 `editing-focus` 消息，只含 channel、kind、content generation 和 boolean。宿主继续校验 `source === frame.contentWindow`，并要求当前代际、可见且 frame 实际聚焦；失焦、隐藏、load、版本切换和卸载都会清除。
- `useViewportEnvironment` 将当前 iframe 编辑焦点并入设备侧输入保护，但不读取 sandbox DOM、不增加 `allow-same-origin`，也不把焦点信号当作授权或持久状态。
- “解释当前结果”继续沿用先保存现场、成功取得回执后再发送的 RP5 路径；失败保留当前内容和问题输入。

## 验证

- 组件测试连续展开/收起 10 次：iframe 节点身份不变、load count 保持 1；同引用对象不重新读取。
- 纯宿主协议测试覆盖过期 generation、隐藏/未聚焦拒绝、当前聚焦接受与 clear；真实 Chromium bridge 4 项通过，确认消息只有四个必要字段。
- 真实 Rust 验收宿主 + Playwright 6 项通过：同 frame、桌面展开边界、390px 窄布局、主题、动态语义拒绝、现场保存失败不发送模型请求且重试成功。
- Web 全量 51 文件/262 项、生产构建以及移动浏览器矩阵 12 项通过。

## 已知限制

- RP 专项验收运行于本机 Chromium/Edge；移动矩阵验证工作区外壳，但未把真实 RP 场景跑在 iPhone Safari 或 Linux 反代入口。
- 本切片不负责运行恢复、认证/跨设备状态边界与发布回滚；这些属于 MW7–MW8。
