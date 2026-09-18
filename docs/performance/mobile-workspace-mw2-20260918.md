# MW2 阅读工作区外壳、导航与可用视口

状态：实现完成，定向验证通过。日期：2026-09-18。

## 实现

- `ReaderWorkspace.vue` 以一个稳定默认 slot 承载既有 LeftRail、Reader/PDF 与 RightRail；single/compare/wide 只改变可见投影，不用条件渲染复制或重建核心组件。
- 移动端改为单区域优先、目录抽屉和底部主导航；低高度横屏使用单条紧凑操作栏，有足够空间且用户显式请求时进入 400 + 12 + 320px 对照。
- `useViewportEnvironment.ts` 合并容器尺寸、VisualViewport、输入聚焦和 composition 状态，监听器与 ResizeObserver 均在卸载时清理。入口使用 `100dvh`、`viewport-fit=cover` 和四边安全区退化。
- `VITE_MOBILE_WORKSPACE=0` 是本地/构建级回退开关；它恢复宽屏呈现投影，不创建第二套业务实例，也不写后端布局。

## 浏览器证据

`playwright.mobile.config.ts` 的确定性夹具覆盖 390×844 Chromium、390×844 WebKit、844×390 Chromium、1440×900 Chromium：

- 一次运行 12/12 通过；连续 10 次阅读/问答切换后 Reader 节点仍是同一实例。
- 四个项目均断言文档根横向溢出不超过 1 CSS px。
- 844×390 首轮发现顶部紧凑栏被隐藏后“对照”入口不可达；入口移入唯一的底部操作栏后复测通过。
- 目录、阅读、问答、笔记、更多和发送入口由同一外壳提供；桌面仍为 wide 且不显示手机导航。

## 未完成的验收

自动化 viewport 与 WebKit 引擎不等于真实 iPhone Safari。安全区实体、浏览器工具栏伸缩、真实软键盘、双指缩放、系统后台/锁屏及 Linux 反代入口仍未验证，因此状态止于“定向验证通过”。
