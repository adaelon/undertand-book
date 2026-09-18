# RP7 完整体验验收

状态：Windows/Tauri 与 Linux 完整体验验收通过，RP7 完成，2026-09-17。对应[切片方案 §6 RP7](../切片方案-Agent富呈现与读时内容制作.md)。

## 最终结果

| 平台 | 完整体验 | 最终实验 / 论证版本 | 重开前后采样 |
| --- | --- | --- | --- |
| Windows/Tauri + WebView2 | 通过 | v3 / v1 | 140 → 140 |
| Linux Server + 系统 Chromium，原服务账户 | 通过 | v4 / v2 | 138 → 138 |

两平台均经真实模型生成三类内容、注入故障后的实际修正、来源返回正文、实验数值操作、保存现场追问、同对象持续修改、窄宽与主题检查、停止宿主后重新打开。最新实验完整可见文本、论证展开文本与保存状态一致，恢复没有新增模型采样或状态修订。旧版保留。生成内容的失败和后续纠正见「已知问题与验收口径」。RP8 正式教学集成仍独立。

## 验收入口

`packages/web/playwright/agent-presentation-live.spec.ts` 从实际 Reader 发起请求，使用已配置的真实 Provider。Windows 连接真实 Tauri/WebView2，Linux 启动实际 Server 的 `--reader-only` 入口。每次运行使用独立的书籍副本、Memory、AgentHistory、呈现版本及浏览器数据目录。

三个现场生成请求分别是构建时/阅读时富排版对照、证据召回参数实验、关系边与事实证据的论证展开；材料来自 `examples/quickstart/book.md`。模型自行读取原文、绑定来源、编写完整内容、选择实际预览操作和交付。

验收代理把真实 Provider 的请求/结果和用量落盘，在模型首次请求预览后、实际执行前向已保存候选末尾注入 `RP7_INJECTED_RUNTIME_FAILURE`。脚本不提供页面模板、修复代码、工具调用或替代回答；模型必须从实际浏览器反馈中修正。代理保留产品发送的 Provider 请求和 SSE 原始响应内容，为记录完整工具参数和注入候选而缓冲响应；Reader 仍走独立 Resident 运行和 SSE 活动入口，增量文本时序沿用既有运行回归验证。

## 完成判据

1. 三类内容均由真实模型生成，实际来源弹窗可打开原文，展开、窄宽和主题验证通过。
2. 实验从 2/3 开始，加入无关材料仍为 2/3，补齐为 3/3；滑块调整到 1/3。
3. 明确追问通过生产 App 入口发送保存现场，真实 Provider 收到 `count=1`；随后修改创建同一对象的版本 2，沿用参数，旧版代码不变。
4. 终止并重新启动宿主后，从磁盘恢复最新修正版的完整可见现场与论证展开状态，旧版仍可访问并保持 1/3；来源仍可打开，恢复不触发模型或额外状态保存。
5. 输出逐回合等待、采样数、Provider 实报 token 用量、历史、真实预览截图及页面截图。

## 复跑

先构建当前源码的 Web 和宿主；Windows 可使用包含实际桌面 `main.rs` 的独立 example，避免替换日常 Reader。

```text
pnpm --filter @understand-book/web build
cargo build -j 1 -p understand-book-desktop --example presentation-preview-host
# Linux 使用 cargo build -j 2 -p server --bin server

RP7_HOST_BINARY=<absolute path to desktop example or Linux server>
RP7_DESKTOP=1  # 仅 Windows/Tauri
RP7_EVIDENCE_DIR=<new isolated absolute directory>
pnpm --filter @understand-book/web exec playwright test -c playwright.presentation-live.config.ts
```

使用本地 `.env` 或已有环境中的 `OPENCODE_API_KEY`、`OPENCODE_BASE_URL`、`FLUID_LLM_MODEL`；凭据不写入证据。未设置 `RP7_HOST_BINARY` 时常规测试跳过此付费用例。

## 早期回归记录

- Web 生产构建与类型检查通过；既有来源弹窗回归 2 项通过。
- Windows 首次并行编译报 OS error 1455（页面文件不足），改为 `-j 1` 后真实桌面 example 构建通过。
- Server 呈现 16、来源 5、Resident 生命周期 22 项回归通过。
- Linux 登录已于续接任务恢复；原服务账户以系统 `/usr/bin/chromium-browser` 执行，新源码原生构建及七项预览测试通过；完整模型体验进展见下文。

## 未通过的采样

第一次 Windows 实际入口运行（`D:/codex-build/understand-book-rp7/windows-live`）耗时 151,503 ms，13 次 Provider 采样、332,513 tokens。宽泛对照请求引发多轮全书片段读取及页面重写，达到现有工具循环上限后没有交付呈现引用，浏览器断言失败。最后 Provider 将 DSML 调用文字放入普通回复；此轮不能计为生成或纠错验收通过。

第一次故障注入直接改写模型 `write` 参数，异常代码出现在后续模型历史中，模型在预览前就删掉了它；因此改为对已保存候选在预览前注入，只有真实工具回执中的故障才计为模型观察到错误。第二次独立采样把富排版请求限定为两段指定原文的职责对照，保留相同产品场景和验收要求。

第二次 Windows 运行（`windows-live-2`）耗时 127,293 ms，7 次采样、100,656 tokens。公开语义检查把“已展开 1 张卡片”的普通计数与检索结果的根位置 `1` 混淆，拒绝候选；模型随后漏传 `operation` 并尝试在终答贴 HTML，最终没有交付。没有进入预览，故障注入和纠错均不算通过。

第三次 Windows 运行（`windows-live-3`）耗时 69,582 ms，8 次采样、85,418 tokens。真实脚本故障与截图已返回模型，但首次失败观察未计入进展，模型再次预览同一失败候选后触发连续无进展停止。工具被禁用后，Provider 输出 DSML 文字，最终退回普通文字描述，未交付呈现。前三次验收代理请求非流式回执；后续保留产品原始 SSE 请求/响应，避免改变 Provider 调用合同。

## 实际修复

`AnswerProvenanceLedger::violations` 对纯整数根位置要求存在定位语境，避免普通计数、分数和计算结果因同值被拒绝；显式 LID/node、方括号位置、章节/位置表达及点分层级位置继续按原规则检查。新增复现测试先在“已展开 1 张卡片”上失败，修复后出处相关 11 项测试通过。

`run_context` 的呈现进展记录增加每个候选首次失败观察；相同候选/状态的重复观察不增加进展。读取已有版本时，进展同时区分文件与偏移，避免超过两段的代码读取被当作停滞。两条主循环复现测试先失败，修复后制作相关 5 项、通用无进展门禁 1 项通过。来源相关 26 项及修复整数误判后的 Server 呈现 16/来源 5 项通过。

## 续接实测与修复（2026-09-17 晚）

Windows 第四份隔离记录继续使用 `windows-live-4`：富排版已真实修正脚本错误并交付，实验、现场追问与 revision 2 均通过。参数实验前两次失败分别是工具循环耗尽和本机内存不足导致 Edge 启动超时/断连。已交付实验验证 2/3 → 无关材料仍 2/3 → 补齐 3/3 → 滑块 1/3；真实追问收到 1/3，修改保持同一对象、兼容参数与旧版。revision 2 的固定宽度公式在 340px 内容区溢出，转为实际用户修改请求修正；该阶段尚未计为全套通过。

Linux 登录恢复，独立目录 `/opt/understand-book/acceptance/rp7-20260917` 构建通过。实际 Server/Chromium 服务账户生成富排版、实验和追问成功；revision 2 验收发现父组件更新使原版重新装载，下一次修改的实际现场已退回 2/3。

新增修复：
- 按键操作支持显式 selector，先聚焦目标再发送真实按键，省略目标仍使用当前焦点。此前 schema 接受 selector，执行器却忽略；实际模型因此误修页面。新增真实浏览器用例先失败，修复后 Windows 六项预览测试通过。
- AgentPresentation 按会话、回合、对象和版本的标量值监听；父组件传入等价引用时保留 iframe。新增组件测试先复现重复读取，修复后通过。
- 同版恢复改在 DOMContentLoaded 所有回调执行之后启动；原 queueMicrotask 会先于页面初始化回调，原生控件恢复值被随后初始化覆盖。新增真实浏览器测试先显示 2/3 而失败，修复后恢复 1/3 且没有额外保存；桥两项测试通过。

独立 `playwright.presentation-live.config.ts` 不再启动开发服务器；Windows 直接连接 WebView2，Linux 才启动 Reader 浏览器。续跑按持久回答确认交付，不能仅凭回合结束跳过失败场景；每次尝试的等待和 Provider 用量均保留。

定向回归收口：Windows 预览 6 项、Linux 预览 7 项，组件/装配单测 3 项、真实浏览器呈现回归 9 项、Web 构建/类型检查、验收脚本类型检查全部通过。Linux 第一轮的错误恢复现场作为失败证据保留；修复后使用新的 `linux-live-2` 隔离记录，避免把已产生的错误编辑基准混作成功证据。

最后新增能力与回归：`preview.width` 接受 240–1920 CSS px、默认 960，可在同一候选上真实检查窄屏；指定宽度后的 Windows 预览 7 项、Linux 服务账户预览 8 项通过。Linux 连续方向键曾在语义校验临时隐藏后失焦，新增真实桥用例先在焦点断言失败；校验完成后恢复原控件焦点，桥 3 项通过。检查期间用户已移出 iframe 时不抢回焦点。

历史候选与续读修复：持久历史不再保留仅本次运行有效的 candidate_id；新运行开始时也清理已有历史中的候选句柄，保留已交付 reference/based_on。新增历史测试先红后绿，Runtime 呈现 28 项、prompt 5 项与 Server 呈现 16 项通过。旧版代码读取首段返回 total_characters / chunk_characters，便于一次批量续读剩余分段，避免每段消耗一个采样回合；仍保持 4,000 字符分段和既有循环上限。Server 精确旧版读取/参数继承回归通过。

Windows 后续真实模型已交付窄屏修改版本 3，原参数仍为 1/3，340px 布局通过，继续进行论证展开和重开。Linux 修改阶段曾因混用新登记来源与旧版按钮而被预览拒绝，失败记录保留；纠正请求明确保留 read 返回的来源列表及页面引用。

## 已知问题与验收口径

- 真实模型可能漏遵守页面合同。Windows 实验旧版 1/2 的恢复器误读 scene.values，原生滑块能恢复 1/3，但自定义无关材料计数丢失；实际修改已在版本 3 改为 scene.values.page。重开对最新版本比较完整可见文本和持久现场，对旧版检查保留、1/3 和来源，旧代码不回写。Linux 首版论证把 visible_step 写成数字，页面能预览但不能保存现场，随后通过主输入框修改为论证版本 2，保存与恢复通过。Linux 实验版本 3 未登记 irrelevant 参数，重开会丢失无关材料计数；通过该页修改为实验版本 4，完整可见状态恢复通过。制作指令明确 visible_step 必须是字符串或 null。
- 浏览器预览检查执行、来源、语义和布局，当前预览环境的保存回调是占位函数；预览成功不能替代 Reader 中实际保存和重开验收。此次已覆盖这种差异。
- deepseek-v4-flash 在多轮检索、重复登记来源和修改时可能耗尽循环，tools-disabled 阶段有时输出 DSML 普通文字。失败均保留，不按交付计算；本次将任务收窄到具体段落和明确的局部修改后通过各生成阶段。
- 窄宽检查为呈现内容区 340 CSS px；主题检查为共同变量同步和内容可读性，不代表整个 Reader 的完整深色主题验收。
- 未更新安装包、未替换日常 Reader 或 Linux 日常服务；本次结果对应隔离真实宿主。Provider token 包含多轮重复上下文，不能据此直接推算费用。

## 日常 Reader 失败恢复回归

完整验收完成后，Windows 日常 Reader 在同一对话中连续重试“配对比较与模型排名”页面。前两次运行都由 `tool.search` 明确激活 `presentation.author`，完成原文读取及来源登记，但最终 Provider 连接在约 60 秒后以 Windows `10060` 失败。第三次精简请求没有调用任何工具，只执行一次普通模型采样和一次来源文字修复；模型读取了前两个失败回合遗留的内部工具记录，把旧的能力激活和来源登记误称为“本轮”动作，并以制作工具不可用为由结束。该回合没有呈现引用，却因 Provider 正常返回普通文字而显示“已完成”。

根因是失败回合的 assistant/tool 后缀进入了下一轮模型上下文，而延迟能力激活、来源绑定和制作候选均为单次运行状态。修复后，Provider 或协议失败仍把用户问题留在对话里，便于用户只说“重试”，但去掉该失败运行的 assistant/tool 后缀；详细工具活动和错误继续保存在 `run_summary`。主动取消继续保存未执行工具的合成取消回执，以保证持久历史中的工具调用协议闭合。能力发现策略同时明确：历史回执不激活当前运行，缺少能力时应重新发现，且无需再次征求用户授权。

界面的正常终态文案同步从“已完成”改为“运行已结束”。该状态只表示本轮 Provider 与持久化生命周期正常结束；实际交付仍以回答内容和呈现引用为准。

新增 Server 复现覆盖“发现制作能力 → Provider 返回空响应失败 → 下一轮只说重试”：下一轮请求同时包含原问题和“重试”，不包含旧 `tool_search_result.v2` 或旧调用 ID。历史中的成功发现回执另压缩为 `tool_search_history.v1`，只保留任务和匹配工具，并明确标记激活已随先前运行过期。Runtime 工具暴露 27 项、工具策略 11 项、Server Resident 23 项通过；Web 生产构建通过，Windows debug 于 22:26 完成 Web 与桌面最终重建并启动。修复前已污染的对话不会在启动时改写，复验仍以新建对话最干净；继续旧对话时会在下一次运行前清理旧能力激活回执。

同一精简请求在新对话的第一次真实复验成功写入候选，并连续完成主操作与窄屏等三次真实预览；写入位于第 9 回合，三次预览占用第 10–12 回合。原循环在第 12 回合后直接进入禁用工具的收尾采样，模型没有机会调用 `deliver`，却在普通文字中声称“已交付”，回答只有 Markdown 且带 `TURN_LIMIT_EXCEEDED`。这不是页面已保存后挂载丢失；追踪确认四次制作调用实际为一次 `write` 和三次 `preview`，没有 `deliver`。

Runtime 现为这种状态保留一次受限交付采样：条件只在达到工具回合上限且存在刚成功预览的候选时成立；该采样只暴露 `presentation.author`，schema 只允许 `deliver`，候选 ID 固定为该预览候选。任何其他工具、重写、再预览或普通文字结束均按协议失败；成功交付后再进入原有禁用工具收尾。新增回归以 `max_turns=3` 覆盖发现、写入、末回合预览、受限交付和页面引用挂载。呈现相关 25 项、原有收尾协议 4 项通过。

22:35 最终 debug 重建后又发起新会话真实复验。两次运行都重新执行能力发现和原文绑定，但 Provider 均在进入页面写入前的大响应采样以 `10060` 失败。第二次用户消息只有“重试”；持久历史最终为 System + 原问题 + 重试，没有任何失败回合 assistant/tool 轨迹，证明恢复清理已在真实宿主生效。由于外部 Provider 仍连接失败，受限交付尚未取得新的真实页面结果，不计作实机交付通过。

## 最终回归汇总

### 2026-09-18 Edge 兼容层重启导致预览进程失管

用户新运行 `turn_35d1cd5aa7116989` 的模型生成持续 106.35 秒后成功写入候选，确认此前 Resident 300 秒期限已生效。随后两次预览均报 `preview browser exited before ready`，清理再报 Windows 32。进程检查发现 Edge 兼容层重启：原始 PID 已退出，两个实际浏览器主进程（38240、43164）携带 `--edge-skip-compat-layer-relaunch` 及本工具专属临时目录继续存活。原 `taskkill /PID <初始 PID> /T` 无法处理已经失去父进程的浏览器，目录因而被占用。

Windows 启动命令现在主动传入 `--edge-skip-compat-layer-relaunch`，让实际浏览器保持为工具直接持有的子进程；关闭与清理继续使用既有生命周期。两组遗留进程已按精确预览目录及主进程身份核对后关闭。新增连续三次预览回归，每次点击后验证 DOM，且 preview 成功返回意味着进程与目录均已清理。实际 Edge 7 项通过，包含真实交互、窄屏、脚本错误、无外部访问、取消和超时。记录 `tmp/rp7-preview-relaunch-tests.log`。

Windows debug 于 07:44:57 重建并启动。旧候选通过桌面 probe 的 340px 点击与展开检查，返回三个观察、零错误，截图为 `tmp/rp7-pairwise-narrow.png`。该 probe 仅验证页面及浏览器，不替代 Reader 的正式交付。候选磁盘文件虽仍存在，制作端口要求 `created_by_turn_id` 等于当前运行，所以上一回答承诺下一轮直接重用候选不成立。

原会话完整复验 `turn_35d1ca5aa7116470` 已成功启动浏览器并进入 `interact:2`，不再有 Windows 32 或启动退出错误；模型指定的操作目标失败，随后 write 漏传 title，触发 `AGENT_NO_PROGRESS`，最后还返回 DSML 工具文本。此轮未交付。新会话 `chat_1789689020571_42` 用保留原要求的精简任务复验 `turn_b48c1305fc81f324`（三模型矩阵、汇总排名、计算依据、原文来源与窄屏；无需额外拟合第二套算法）成功：第 3 回合 write、第 4/5 回合主操作及窄屏 preview、第 6 回合 deliver、第 7 回合完成。状态 completed/saved、incomplete=false、无 warning，回答实际附带 `presentation-1789689081072713700-2` revision 1。

正式页面标题“配对比较与模型排名 · 交互演示”，绑定两处来源。通过 `/agent/presentation.read` 成功读取；关闭并重开桌面后再次读取相同版本，HTML 直接比较一致，当前会话仍选中成功会话，残留预览进程为零。证据 `tmp/rp7-preview-scoped-snapshot.json`、`tmp/rp7-preview-delivered-view.json`。最终 debug 构建时间 07:44:57，重开后的 PID 32904。本轮未替换 Linux 日常服务或更新安装包。

### 2026-09-18 日常对话 60 秒总时限修复

用户再次复现的 `turn_6adff85b10200719` 在原文阅读、能力发现、来源消歧成功后，第五次模型采样于 60,018 ms 失败。错误没有 HTTP 请求失败前缀，来自响应体读取阶段。继续核对调用链发现：日常桌面与 Linux 共用的 Resident 入口使用 `SERVICE_PROVIDER_TIMEOUT=60s`，通过 `ureq::Request::timeout` 限制完整请求（包括流式响应体），并非连续无数据时限。此前将此类错误归因为外部网络不稳定、建议等待恢复，证据不足；该结论在本节更正。

新增真实 HTTP 回归让 Provider 每秒发送 SSE 心跳，第 65 秒返回完整回答。旧实现仍在约 60 秒处失败，错误与用户完全一致（Windows `10060`），排除了该复现场景中的外部网络故障。Resident 现使用独立的 `RESIDENT_PROVIDER_TIMEOUT=300s`；后台服务和翻译的 60 秒上限不变。仍保留有限的整请求时限；完全无数据时，取消或关闭等待在途请求的最坏时间也随之延长到该上限。

Resident 相关 24 项通过，包括 65 秒持续响应、取消、重试、保存和关闭。红/绿记录为 `tmp/rp7-provider-deadline-red.log` 与 `tmp/rp7-provider-deadline-green.log`。Windows debug 于 9/18 06:33:45 重建完成，构建记录 `tmp/rp7-provider-desktop-build.log`。旧程序正常关闭后，自动启动新程序被审批策略拒绝（仅返回 blocked by policy）。已请用户手动打开；原问题真实模型复验尚未完成，不把本地长响应回归当作新页面交付。

| 验证 | 结果 |
| --- | --- |
| 原生浏览器预览（指定目标按键、窄宽） | Windows 7 项；Linux 服务账户 8 项通过 |
| Runtime 呈现 / 制作指令 | 呈现 28 项；最后指令修改后 5 项通过 |
| Server 呈现与精确旧版读取 | 呈现 16 项通过；新增分段长度断言通过 |
| 历史读写 / Resident 生命周期 | 最终源码 6 / 22 项通过 |
| Web 组件 / 真实浏览器 | 组件与装配 3 项；呈现浏览器 9 项；随后焦点、恢复与快照桥 3 项通过 |
| 构建和类型检查 | Web 生产构建、Web 类型检查、最终验收脚本类型检查通过 |

Windows 最终实际宿主完整用例通过（最终脚本续跑 15.2 秒，无新增模型采样）。证据：[summary](rp7-windows/summary.json)、[逐次用量](rp7-windows/scenes.json)、[窄屏修正版](rp7-windows/revision-narrow.png)、[主题同步](rp7-windows/revision-theme.png)、[论证展开](rp7-windows/argument-narrow.png)、[重新打开](rp7-windows/reopened.png)。

Windows 有效生成回合：富排版 53.3 秒、实验 126.6 秒、现场解释 18.1 秒、版本 2 修改 101.9 秒、版本 3 修改 93.8 秒、论证 62.6 秒。最终隔离目录累计 140 次采样、5,541,937 tokens；连同前三份失败目录合计 168 次、6,060,524 tokens。包含画像提取及失败回合的实际 Provider 记账，不是单次用户任务的典型成本。旧记录 rich 没有 delivered 字段，由最终持久引用和全部 UI 断言确认成功。

Linux 最终实际宿主完整用例通过（最终脚本续跑 10.1 秒，无新增模型采样）。证据：[summary](rp7-linux/summary.json)、[逐次用量](rp7-linux/scenes.json)、[窄屏修正版](rp7-linux/revision-narrow.png)、[主题同步](rp7-linux/revision-theme.png)、[论证展开](rp7-linux/argument-narrow.png)、[重新打开](rp7-linux/reopened.png)。

Linux 有效生成回合：富排版 60.2 秒、实验 71.9 秒、现场解释 9.3 秒、版本 2 修改 40.3 秒、版本 3 修改 64.1 秒、论证 57.2 秒；论证保存合同纠正 47.6 秒，实验自定义计数纠正 49.6 秒。最终目录累计 138 次采样、4,924,222 tokens；第一份保留的失败验收另有 33 次、789,208 tokens。两平台全部目录共 339 次 Provider 采样、11,773,954 tokens，包含失败尝试、画像提取和重复上下文；无账单金额数据。

完整私有日志留在 Windows `D:/codex-build/understand-book-rp7/windows-live*` 与 Linux `/opt/understand-book/acceptance/rp7-20260917/linux-live*`。仓库归档摘要与选定截图，不复制 Provider 凭据。最终脚本支持复用成功生成阶段，所有实际 UI 与磁盘恢复断言仍执行；修正后的页面保持原 presentation_id、增加 revision。
