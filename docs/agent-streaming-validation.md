# Resident Agent 流式回答验收

状态：2026-09-14，AS8–AS9 完成。Windows Chromium、真实 Tauri/WebView2、Linux Nginx、真实模型与运行生命周期均已验收。合同见 [ADR-0127](adr/0127-resident-agent-streaming-and-runtime-activity.md) 和 [切片方案](切片方案-Resident-Agent流式回答与运行活动.md)。

## 源码与环境

基线为 `96215a67b24407c9ebe648718505cead683d5e44` 上的 AS0–AS8 未提交工作树。本轮未提交、未安装插件、未修改正式 Linux 服务。Linux 独立源码及 release 构建位于 `/opt/understand-book/acceptance/as9-20260914/source`，原始日志和真实模型数据在其上级目录。Reader/Runtime/Server 生产实现与 Web 构建均来自当前工作树。受控场景使用隔离临时书、Memory/History 和真实 HTTP Provider；桌面场景使用实际 `UnderstandBook.exe` 和 WebView2，通过 CDP 观察页面。

真实模型为 native / DeepSeek / `deepseek-v4-flash`。三个题目依次通过 `/agent/runs` 和旧 `/agent/chat`，每次新建会话，沿用同一模型配置及默认工具预算；原文为验收脚本生成的中文阅读材料。每个宿主每题每入口各一个样本。机器可读结果含实际答案、来源、effects、模型/工具活动及 usage，见 [验收数据](agent-streaming-validation.json)。

## 确定性链路

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| Reader / Runtime / Server lib | 54 / 328 / 259 项通过；Runtime 3 项原有忽略 | `tmp/as9-rust-tests.log` |
| Web 全量 | 41 文件、227 项通过 | `tmp/as9-web-all.log` |
| Web 类型检查和生产构建 | 通过 | `tmp/as9-web-final-build.log` |
| Windows Chromium，Native/ReAct | 2 场景通过 | `tmp/as8-browser-final.log` |
| Tauri/WebView2，Native/ReAct | 2 场景通过 | `tmp/as9-webview-final3.log` |
| Linux 原生 release 构建 | 通过，5 分 25 秒 | `tmp/as9-linux/build.log` |
| Linux Nginx，Native/ReAct | 2 场景通过；Native 扩大远程测试总时限后重跑通过 | `tmp/as9-linux/browser.log`、`browser-native-final.log` |
| 旧完整入口评测器 | 9 项通过；两端真实 `/agent/chat` 样本完成 | `tmp/as9-linux/evaluator-tests.log` |
| Linux 运行生命周期 | 15 项通过，含取消、保存失败、切书和宿主停止 | `tmp/as9-linux/lifecycle.log` |
| 真实模型，流式/完整入口 | Windows 6 + Linux 6 样本 completed，历史一致，来源可解析 | `tmp/as9-real-model-final.log`、`tmp/as9-linux/real-model.log`、验收数据 |

浏览器在受控 Provider 尚未结束时断言真实正文、工具父子活动已经显示；验证追加、刷新恢复零新增请求、不完整参数零执行、取消后停止等待、修复替换、持久历史重读、生成期间来源打开及终局接续、笔记在终局前可见。Chromium 额外扣住实际 metrics Node 子进程，证明 Reader/停止可响应；桌面使用预构建 sidecar，该 Node 扣门断言仅由 Chromium 覆盖。

真实存储测试验证活动绑定先登记、仅已发布引用可解析、修复撤回失效、不同书拒绝、终局持久接续；取消保留完成笔记，手动导航推进 revision。既有 Server 受控测试覆盖长模型等待、断线快照、取消、保存失败、进程停止及 pending 恢复。终态独立运行摘要保留真实 effects。

## Windows 真实延迟分解

下表单位为秒；Reader 请求单位为毫秒。首正文为客户端收到公开正文事件的时间，页面实际提前显示由上面的 Chromium/WebView2 受控场景验证。

| 题目 | 接收运行 | 首活动 | 首正文 | Provider 最后结束 | 流式终局 | 旧完整入口终局 | Reader 请求 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 检索与来源问答 | 0.018 | 0.034 | 10.250 | 10.701 | 10.748 | 9.550 | 7.1 |
| 已验证选区回答 | 0.017 | 0.033 | 2.984 | 3.166 | 3.198 | 3.557 | 7.0 |
| 显式保存笔记 | 0.016 | 0.030 | 2.638 | 2.698 | 2.727 | 10.932 | 7.0 |

| 题目 | 流式/完整请求数 | 流式/完整实际 tokens | 缺失 usage |
| --- | --- | --- | --- |
| 检索与来源问答 | 6 / 7 | 31933 / 39252 | 0 / 0 |
| 已验证选区回答 | 2 / 2 | 7669 / 7446 | 0 / 0 |
| 显式保存笔记 | 2 / 3 | 8267 / 18355 | 0 / 0 |

三个流式样本的首正文均早于最后一次 Provider 结束；来源/选区分别交付 1 个可解析来源，动作样本保存 Note。每次请求的首网络分片、耗时以及 Runtime 用途/父子关系见 JSON。旧完整入口保留完整返回语义。

## Linux Nginx 真实延迟分解

Linux 宿主为原部署机 `115.190.121.150`，veLinux/CentOS Stream 9，Nginx 1.20.1。独立 Nginx 实例读取正式配置的代理段，保留 HTTP/1.1、Authorization 清除、600 秒超时及 `proxy_buffering off`，只调整 upstream、日志和监听地址；验收仅监听 `127.0.0.1:19080`，关闭该隔离监听的 Basic Auth。正式 8080 配置和服务未更改，结束时 MainPID 仍为 3444218、状态 active、匿名访问仍为 401。

受控浏览器运行在 Windows Chromium，通过 SSH 到 Linux Nginx，再到 Linux release server；模型夹具、Reader 和持久存储都在 Linux。Native/ReAct 同一场景覆盖正文先于 Provider 完成、模型/工具活动、Reader 并行操作、SSE 刷新恢复零重跑、来源打开、即时笔记、取消、修复和历史重读。Linux 生命周期测试另覆盖保存失败、停止、切换和中断恢复。验收临时进程与 SSH 转发已关闭。

真实模型六样本也经过该 Linux Nginx 路径；单位为秒，Reader 请求单位为毫秒。

| 题目 | 首活动 | 首正文 | Provider 最后结束 | 流式终局 | 旧完整入口终局 | Reader 请求 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 检索与来源问答 | 0.017 | 7.874 | 8.396 | 8.410 | 7.714 | 10.9 |
| 已验证选区回答 | 0.009 | 1.777 | 1.922 | 1.930 | 4.095 | 2.3 |
| 显式保存笔记 | 0.011 | 1.445 | 1.458 | 1.465 | 5.240 | 2.7 |

| 题目 | 流式/完整请求数 | 流式/完整实际 tokens | 缺失 usage |
| --- | --- | --- | --- |
| 检索与来源问答 | 7 / 6 | 38161 / 31048 | 0 / 0 |
| 已验证选区回答 | 2 / 2 | 7513 / 8131 | 0 / 0 |
| 显式保存笔记 | 2 / 4 | 8650 / 21122 | 0 / 0 |

流式来源问答交付 2 个可解析来源，选区交付 1 个，两个动作入口都产生 Note。Linux 脚本在每次动作样本结束后删除该次验收 Note，避免后一个入口命中重复 Note。JSON 的 `linux.observations` 保留每次请求、真实活动和结果。

## 运行记录与已知限制

- Linux 验收使用独立 loopback Nginx 实例复用正式代理配置，未切换正式 8080 upstream。最初 SSH 访问失败，用户恢复访问后已完成上述实机验收；凭据未写入项目或报告。
- 相同题目的模型工具选择并不相同；每入口只有单样本，数据不能证明稳定的总耗时收益。两个入口共享本次隔离 Memory，动作题第二次命中已有 Note，因此没有新建 effect；新建 Note 的事实由流式样本、真实存储测试及受控浏览器覆盖。
- Linux Native 首次在最后一次历史刷新触及整场景 60 秒上限，远程场景总上限改为 180 秒、单项断言不变后通过；ReAct 首次已通过。一次重跑筛选表达式未匹配测试，修正后只重跑 Native，日志均保留。
- 浏览器夹具首次把 schema 字段名误作 source ref，随后修正真实 ID 提取。桌面夹具改从 CDP 页面读取地址、创建隔离书库，并区分 sidecar 与 Node metrics 路径。C 盘空间不足时将本轮浏览器临时目录迁至 `tmp/as9-temp`，后续使用 E 盘。上述失败记录保留于 `tmp/as8-browser.log`、`tmp/as9-webview*.log`。
- 真实模型脚本修正空载荷读取及收到持久终态后结束订阅；最终六样本完成。同步网络读取取消、进程内草稿恢复边界沿用 ADR-0127。

## 接续入口

`scripts/validate-agent-streaming.mjs` 读取已有本地 Provider 配置，在隔离存储中记录真实模型样本，输出不包含密钥。`packages/web/playwright/agent-run-live.spec.ts` 默认验证真实 server + Chromium；设置 `AS9_WEBVIEW=1` 验证已构建的 Tauri/WebView2。Windows 测试临时目录应指向有足够空间的 `tmp/as9-temp`。

Linux runner 使用 `AS9_RELEASE=1`、`AS9_NGINX_TEMPLATE=/etc/nginx/conf.d/understand-book-reader.conf` 和 `AS9_PROVIDER_ENV=/opt/understand-book/reader.env`；浏览器跨主机观察使用 `AS9_BROWSER_WS`。验收已完成；后续正式部署、提交或插件安装属于另行执行的发布操作。
