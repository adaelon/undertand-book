# SESSION_CHECKPOINT — 2026-09-14 05:17（Asia/Hong_Kong）

## 新鲜度自检
- 写入时最新 commit：`96215a67b24407c9ebe648718505cead683d5e44 feat(reader): deliver LA reliability and Linux reader deployment`。
- 接手时对比 `git log -3` 与工作树；AS0–AS9 实现/验收尚未提交，不能只凭 HEAD 判断进度。

## 当前在做什么
Resident Agent 流式回答与运行活动 **AS0–AS9 全部完成**。AS8 活动来源及即时动作已实现；Windows Chromium、真实 Tauri/WebView2、Linux release/Nginx、真实模型与生命周期验收已完成。

## 下一步（可直接接手）
1. 阅读 `docs/agent-streaming-validation.md/json`，了解最终验收与单样本测量边界。
2. 若用户要求提交或发布，先按 `docs/代码链路.md` 的 AS1–AS9 条目筛选本功能改动；工作树还有预构建、插件和画像等其他修改，不要批量提交。
3. 若用户要求部署，使用已验证源码构建正式发布版本；本轮 Linux 独立验收目录为 `/opt/understand-book/acceptance/as9-20260914`，正式服务尚未切换。

## 未提交 / 未完成
- 本 goal 无未完成实现或验收；所有改动待 commit，本轮未安装插件或更新正式服务。
- Runtime：`provider_stream.rs/answer_stream.rs/run_context.rs/run_events.rs` 及 lib/orchestrator；Server：`agent_run.rs/agent_stream.rs/agent_run_tests.rs` 与宿主/来源入口。
- Reader revision、Web reducer/订阅/App/RightRail、生成类型、单元及浏览器测试待提交。
- ADR-0127、切片方案、架构、代码链路、验收 Markdown/JSON 与本 checkpoint 已同步。
- AS9 runner：`scripts/validate-agent-streaming.mjs`；Playwright 配置支持 `AS9_WEBVIEW`、`AS9_RELEASE`、`AS9_BROWSER_WS` 和 `AS9_NGINX_TEMPLATE`。
- 原有其他工作树修改仍保留；不要回退。凭据未写入项目文件或报告。

## 验证状态
- Windows Reader **54**、Runtime **328**（3 原有忽略）、Server **259** 全量通过：`tmp/as9-rust-tests.log`。
- Web **41 文件/227 项**通过：`tmp/as9-web-all.log`；类型检查/构建：`tmp/as9-web-final-build.log`。
- Windows Chromium **Native/ReAct 2 场景**：`tmp/as8-browser-final.log`；真实 Tauri/WebView2 **2 场景**：`tmp/as9-webview-final3.log`。
- Linux release 构建通过；Nginx **Native/ReAct 2 场景**通过：`tmp/as9-linux/browser.log`（ReAct）、`browser-native-final.log`（Native）；生命周期 **15 项**通过：`lifecycle.log`。
- 旧完整入口评测器 **9 项**通过：`tmp/as9-linux/evaluator-tests.log`；Windows/Linux 三题×两入口共 **12 个真实模型样本 completed**，数据在 `docs/agent-streaming-validation.json`。
- 两端流式样本首正文均早于 Provider 最后结束；Reader 请求 Windows 约 7ms、Linux 2.3–10.9ms。单样本及模型请求数差异不用于声称稳定总耗时收益。
- Linux 临时 Nginx/测试宿主、浏览器控制和 SSH 转发均已退出。正式服务仍 active、MainPID 3444218，匿名 8080 返回 401，未切换部署。
- Linux Native 首次触及整场景 60s 上限，远程总上限改为 180s 后通过，单项断言不变；原始失败保留。详细口径见验收文档。
- C 盘曾满；本轮临时目录转移至 `tmp/as9-temp`。后续 Windows 验收应使用有空间的 E 盘 TEMP/TMP。

## 冷启动读序
1. `docs/adr/0127-resident-agent-streaming-and-runtime-activity.md` — 已接受架构及完成边界。
2. `docs/切片方案-Resident-Agent流式回答与运行活动.md` — §2–§6、AS8–AS9 及末尾实施记录。
3. `docs/agent-streaming-validation.md/json` — Windows/Linux 最终证据、测量和环境限制。
4. `crates/server/src/agent_stream.rs/agent_run.rs`；`lib.rs:agent_source_binding/reader_state_response`；Runtime `answer_stream.rs/run_events.rs` — 来源、revision 和 effects。
5. Web `App.vue:syncResidentChanges/onReaderViewportInteraction`、`agent-run-state.ts/useAgentRun.ts`、RightRail 来源；`playwright/agent-run-live.spec.ts`、`scripts/validate-agent-streaming.mjs` — 展示与验收入口。
6. `docs/架构.md` Resident 两节、`docs/代码链路.md` AS8–AS9；`docs/Linux阅读器部署.md` — 当前结构及发布入口。

## 本会话决策摘要
- 延续 ADR-0127：活动引用受已验证绑定与当前发布草稿约束，终局由持久绑定接续；修复撤回旧引用。
- Reader 写入推进 revision，事件只同步观察；effect 使用运行/步骤身份，终局保留原撤销合同并取消强制定位。
- Linux 复用正式 Nginx 代理段，在独立 loopback 实例验证；实际部署保持原版本。详见验收记录。
