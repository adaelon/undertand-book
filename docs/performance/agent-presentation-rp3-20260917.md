# RP3 富回答与来源

状态：RP3 完成，2026-09-17。对应[切片方案 §6/§7](../切片方案-Agent富呈现与读时内容制作.md)。

## 已实现行为

- `POST /agent/presentation.read` 接收 `session_id / turn_id / reference`，复用私有版本读取，并要求该回合的已提交回答实际引用此版本。候选、仅保存未提交的版本、其他回合或会话的引用不能挂载。返回由 ts-rs 生成的 `PresentationView`；来源只返回 ref 与宿主标签。
- `RightRail` 的终答分支挂载 `AgentPresentation`。内嵌与展开使用同一 iframe、同一版本和同一运行现场；展开时解除 RightRail 背景滤镜对固定定位的限制。收起不会重载脚本或重置参数。
- 内容在 `sandbox="allow-scripts"` 的不透明来源 iframe 内运行。公共样式提供排版、比较卡片、控件、图形宽度与主题变量；网络、表单提交及主页面能力受宿主边界约束。页面错误转为明确失败提示。
- `compile_presentation_text` 复用既有完整回答编译器及公开出处规则，结合已有消息与来源证据。历史提交前验证标题、说明和假设，并拒绝同一回答中含义冲突的来源 ref。
- 页面启动及 DOM/控件值变化时，宿主桥收集实际语义文字与来源 ref，经 `/agent/presentation.observe` 编译后开放显示。未知 ref、原始来源标记或内部位置公开违规会停止挂载；过期观察回执不开放较新的内容。
- 静态及动态来源控件均用宿主绑定派生标签，经原有 `/agent/source.resolve`、`/agent/source.open` 弹窗及正文导航。绑定只从该回答所引用的持久版本读取；原有来源陈旧判断仍有效。
- “文字说明与来源”提供可选择复制的语义内容、假设及来源入口；完整 HTML/JS 仍在私有版本中，不进入历史消息正文。

## 内容编写合同

入口 HTML 可以内联 CSS/JavaScript，也支持版本内相对路径的普通 `<script src>`、`<link rel="stylesheet">` 和 SVG 图像；装配时转成自包含页面。data 图像可直接使用。初始值通过 `window.presentation.initialState` 读取。

引用写成 `<button data-source-ref="已绑定的 ref">占位文字</button>`；宿主替换标签并处理点击。动态添加相同控件走相同路径。页面普通文字不使用 `[[source:...]]`；`readable_content` 继续允许既有标记，由服务端编译成语义视图。标题与假设为普通文字。

比较布局可使用 `.comparison`、`.card`、`.callout`；内容可自由补充样式和计算。共享变量为 `--canvas / --ink / --surface / --line / --accent`，宿主主题变化传入同一页面。图形应提供关联的 DOM 说明或可访问标签及 `readable_content`，制作阶段仍须实际预览图形。

## 验证结果

| 验证 | 结果 | 发现的具体失败及修正位置 |
| --- | --- | --- |
| Server `presentation_` | 10 项通过，1 个浏览器宿主测试按需启动 | 包含 RP2 六项、RP3 两项及既有两项；检测未交付读取、版本归属、公开内部位置、未知 ref、来源冲突及历史提交原子性 |
| Server 来源、历史、Resident | 5 / 6 / 22 项通过 | 检测既有来源读取、持久终态、取消、状态借用及切会话回归 |
| Runtime 类型生成、增量回答 | 55 / 4 项通过 | 共享投影一致；现有 Markdown/来源增量规则保持 |
| Web 类型检查 | 通过 | 新视图与回答联合分支字段正确 |
| Web 相关单测 | 25 项通过 | RightRail 15、运行状态 5、Markdown 3、内容装配 2 |
| RP3 Playwright | 4 项通过 | 实际 Rust 存储、编译及 Reader 来源接口；静态/动态来源、2/3→无关材料不变→1、同实例展开、390px 无溢出、完整深色变量、隔离、无效 ref、动态内部位置及脚本失败 |
| 既有来源与运行 Playwright | 2 / 2 项通过 | 桌面/窄屏来源弹窗；native/react 两种运行模式的重连、停止和持久终态 |

RP3 浏览器夹具使用 `presentation_browser_host`：真实临时私有目录创建候选、持久版本并提交回答，再以真实路由服务浏览器。没有模拟来源或语义验证响应。宿主最多运行五分钟，也可通过 `/stop` 提前结束；本次已停止。既有运行浏览器测试按其原脚本使用 `target/debug/server.exe`；当前改动的 Rust 路径由上述新编译的 Server 单测覆盖。

实际检查过的截图：[展开](rp3-windows/expanded.png)、[窄屏与深色变量](rp3-windows/narrow-theme.png)。截图首次发现展开受背景滤镜限制，修正后加入 1100×850 视口下 1060×810 展开尺寸断言并重新通过四项浏览器测试。

复跑命令：

```text
cargo test -p server --lib presentation_ -- --test-threads=1
cargo test -p server --lib agent_source -- --test-threads=1
cargo test -p server --lib agent_history -- --test-threads=1
cargo test -p server --lib resident_ -- --test-threads=1
cargo test -p runtime --lib export_bindings_ -- --test-threads=1
cargo test -p runtime --lib answer_stream -- --test-threads=1
pnpm --filter @understand-book/web typecheck
pnpm --filter @understand-book/web exec vitest run src/components/RightRail.test.ts src/agent-run-state.test.ts src/md.test.ts src/presentation-document.test.ts

# 在另一终端启动有界浏览器夹具宿主，然后执行 RP3 浏览器测试
cargo test -p server --lib presentation_browser_host -- --ignored --nocapture
pnpm --filter @understand-book/web exec playwright test playwright/agent-presentation.spec.ts --workers=1
pnpm --filter @understand-book/web exec playwright test playwright/agent-source.spec.ts playwright/agent-run-live.spec.ts --workers=1
```

Windows 构建沿用 D 盘 RP2 缓存与临时目录，关闭本次 dev/test 调试信息和增量编译，未改仓库 profile。两次新测试程序曾在启动时报拒绝访问并消失；重新构建、从文件读取浏览器夹具后全部运行通过，未关闭系统安全软件，未确认消失原因。既有 react 浏览器测试首次复制宿主至 C 盘因空间不足失败，改用 D 盘 TEMP/TMP 后通过。浏览器完整结果位于 `D:/codex-build/understand-book-rp3/`。

## 已知限制

- 本次为 Windows Chromium 验收，未制作桌面安装包、替换日常 Reader 或重新部署 Linux。RP1 两平台预览证据保持原记录。
- RP4 尚未接入 Resident 制作与预览工具；本次内容来自确定性验收夹具。当前参数只在挂载页面中存在；状态持久化、追问与恢复由 RP5/RP6 接入。
- 内容装配支持上述自包含资产方式。外部依赖、JavaScript 模块导入图、CSS 外部资源链与二进制本地资产不在当前装配合同内。
- 动态公开检查观察 DOM 文字、标签及控件值，不对 Canvas/图像像素做文字识别。绘制内容与语义说明一致性由制作预览及实际图形观察验证；此处不授予页面来源身份、教学判题或学习状态写入能力。
- 动态语义检查是本机确定性请求，不调用模型；当前未对高频语义变化做节流。动画若只改变图形或样式而语义未变，不发送新的语义检查请求。
