# RP4 Resident 现场制作

状态：RP4 完成，2026-09-17。对应[切片方案 §6](../切片方案-Agent富呈现与读时内容制作.md)。

## 已实现行为

- `presentation_authoring` 进入现有能力目录；`presentation.author` 默认延迟暴露，经 `tool.search` 激活后才进入下一次采样。普通短回答不增加制作工具的完整 schema。
- `write` 接收标题、自包含 HTML、可回读说明、来源 ref、假设和初始状态，保存当前书籍/会话/pending 回合的不可变候选。模型只给出当前运行通过 `source.present` 获得的 ref，Runtime 传入真实绑定，页面不自行构造来源身份。
- `preview` 在 Reader 状态锁外调用 RP1 `BrowserPreview`，沿用当前运行的取消令牌；每次最多四个实际点击/按键，返回初始及每步 DOM、布局、PNG 和错误。预览采用 RP3 共同样式、初始状态、宿主来源标签与同样的资源限制；实际语义和来源 ref 使用既有回答编译器验证。
- 浏览器错误、未知来源、公开语义违规或不支持的资产使候选不能交付。修改使用新候选，重新排练。已失败的预览不会保留旧的成功资格。
- PNG 以临时视觉消息送入下一次 native/react 采样，按每张 4,096 token 预留上下文估计，provider 实际 usage 继续计入运行用量。截图不进入持久历史。Runtime 要求截图经过后续采样，拒绝同一批次刚预览就交付；是否理解并正确使用观察仍由模型执行。
- `deliver` 只保存本运行成功排练过的候选，并返回固定版本引用；终答编译成功后由 Runtime 追加 `AgentAnswerPart::Presentation`。历史仍由原有原子提交决定；候选、版本保存与回答已提交保持不同事实。取消不会发布未提交引用。
- 工具沿用既有循环上限、结果大小预算、事实活动及取消；候选/观察/保存的实际进度加入进展判定。历史中的制作调用保留操作身份，生成代码从参数中移除，工具结果保留紧凑回执。

## 内容编写合同

制作工具接收完整单页 HTML，使用内联普通 CSS/JS、SVG 或 data 图像；最大 HTML 为 1 MiB。共同类为 `.comparison`、`.card`、`.callout`，主题变量为 `--canvas / --ink / --surface / --line / --accent`，初始值从 `window.presentation.initialState` 读取。来源控件使用 `button[data-source-ref]`，语义说明可以使用既有来源标记。预览每次从初始状态重跑，四步以上的不同路径分次排练。

`readable_content` 应包含文字、图形说明及动态计算含义；模型需要比较实际截图、DOM 与这些说明。有已知答案的算例另外用确定性断言验证。当前参数保存与追问属于 RP5，已有内容的持续修改及现场恢复属于 RP6。

## 真实模型与挂载验收

使用当前配置的 **deepseek-v4-flash**，完整 Resident 核心、真实私有文件系统和 Edge 浏览器执行。输入是新提出的中文交互页面请求：比较找到证据和忠实使用证据，给定三处证据、起初两处、加入无关材料不变、补齐后为一。没有向模型提供页面模板。

验收适配器只在模型第一次生成有效 HTML 后追加 `RP4_INJECTED_RUNTIME_FAILURE` 脚本异常；内容、操作选择、故障修正与交付均由真实模型完成。实际调用为：

```text
tool.search
  → write → preview（真实脚本异常）
  → write（模型重写）→ preview（操作两个按钮，errors=[]）
  → deliver → 终答 → 历史提交 → presentation.read
```

7 次模型采样、2 次候选写入；运行 **119,365 ms**，累计 provider 报告 **185,457 tokens**，终态完整。此数值是多次采样累计用量，不是单次上下文大小；费用未换算。[结构化摘要](rp4-windows/summary.json)。

真实回答区使用该已提交版本，实际 Rust 读取/语义路由和 RP3 iframe 挂载，无模拟接口：初始 66.7%，加入无关材料后仍 66.7% 且计数变为 2 条，补齐后 100%，SVG 进度宽度 100；展开不重建 iframe、不丢失当前值，重置恢复 66.7%，390px 视口无横向溢出。已查看[初始预览](rp4-windows/initial.png)、[补齐后预览](rp4-windows/completed.png)及[回答区挂载截图](rp4-windows/mounted.png)。

模型另外明确声明样例中“找到的证据全部被忠实使用”的演示假设，因此两张卡片数值相同；此例不构成对一般忠实性指标或教学效果的验收。

## 定向验证结果

| 验证 | 结果 | 检测的具体失败 |
| --- | --- | --- |
| Server RP4 定向（含真实浏览器） | 3 项通过 | 未预览交付、伪造来源、脚本故障修正、动态语义拒绝、取消死循环、已保存但未提交不能挂载 |
| Runtime RP4 | 3 项通过 | 延迟发现、同批交付被拒绝、截图仅进入后续一次采样、固定引用追加、native/react 图片投影及历史不含 PNG |
| 真实模型闭环 | 1 项通过 | 模型不能根据真实错误修正、未交付引用、修正未持久或历史混入 HTML/PNG |
| 真实生成版本 Playwright | 1 项通过 | 挂载失败、计算错误、图形不同步、展开丢状态、重置失效、窄屏溢出 |
| Server 呈现筛选 | 11 项通过，5 个按需验收入口跳过 | RP2/RP3 存储、归属、来源及历史提交回归；RP4 三项定向测试按上行单独执行 |
| Server 来源 / Resident / 历史 | 5 / 22 / 6 项通过 | 来源跳转、锁边界、取消、已有副作用与终态持久回归 |
| Runtime 来源及图片筛选 / 工具注册 / 工具暴露 / 增量回答 / 提示模块 | 19 / 8 / 26 / 4 / 5 项通过 | 出处边界、注册完整性、能力发现、原回答及提示注入回归 |

## 复跑与证据位置

```text
cargo test -p server --lib presentation_author -- --include-ignored --skip presentation_author_real_model --skip presentation_author_mount_host --test-threads=1
cargo test -p runtime --lib presentation_author -- --test-threads=1
cargo test -p runtime --lib presentation_images -- --test-threads=1

# 为真实模型另设新的隔离目录，避免混用验收历史
RP4_EVIDENCE_DIR=<isolated-directory>
cargo test -p server --lib presentation_author_real_model_repairs_and_delivers -- --ignored --nocapture --test-threads=1

# 浏览器脚本使用本次已生成内容的按钮/数值身份；重采样的新页面需按其实际身份更新断言。
# 本次保存目录：D:/codex-build/understand-book-rp4/live-2
cargo test -p server --lib presentation_author_mount_host -- --ignored --nocapture --test-threads=1
pnpm --filter @understand-book/web exec playwright test playwright/agent-presentation-author.spec.ts --workers=1
```

浏览器宿主有五分钟上限，可通过 `http://127.0.0.1:4175/stop` 结束，本次已停止。完整隔离历史、候选、版本、工具调用及 PNG 在 `D:/codex-build/understand-book-rp4/live-2`；挂载测试结果在旁边 `browser/`。Windows 编译使用 RP2 D 盘缓存与临时目录，dev/test debug=0、incremental=0、`_LINK_=/DEBUG:NONE /PDB:NONE`，未修改项目构建 profile。

首次新 Server 测试程序曾在启动前被 Windows 拒绝访问，旧程序可启动，未从日志确认原因；移出内嵌页面夹具、移除不必要的验收解码依赖并重新构建后可执行，随后浏览器和模型验证通过。首次真实模型验收的故障注入器假定 write 必有 HTML 而报错；改为仅向有效 HTML 注入后，第二次独立运行通过。没有更改系统安全设置。

## 已知限制

- RP4 本次为 Windows/Edge 的源码验收；未重新部署 Linux、制作安装包或替换日常 Reader。RP1 两平台预览证据保持；完整跨平台体验在 RP7。
- 视觉制作需要当前 Provider 接受图片输入。native/react 均已实现图片消息投影，本次真实 Provider 已接受；不支持图片的 Provider 会返回实际调用错误，不会被算作成功视觉验收。
- 制作入口限定自包含单页；RP3 读取端原有多文件支持保留。外部资源、模块导入图、CSS 资源链与二进制本地资产仍未接入。
- 运行现场尚未持久化，也没有当前状态追问或已有对象修改入口；按 RP5/RP6 继续。截图观察与算例通过不等于所有内容推导正确或具备正式教学判断能力。
