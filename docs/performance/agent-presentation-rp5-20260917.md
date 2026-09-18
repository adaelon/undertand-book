# RP5 当前状态追问

状态：完成，2026-09-17。最终修订号存储、Server 回归和 7 项真实浏览器验收均通过。对应[切片方案 §6/§7](../切片方案-Agent富呈现与读时内容制作.md)。

## 已实现行为

- 原生控件 `change`、按钮与步骤操作完成后保存现场；拖动 `input` 与动画帧不保存、不调用模型。原 RP3 的确定性公开语义检查保持。
- 浏览器在当前语义观察获得宿主通过回执后，一次同步采集原生控件值/勾选状态、自定义参数、步骤和当前可见 DOM 结果。隐藏步骤不混入结果；图形通过可见说明或可访问标签参与观察。
- 页面可注册 `window.presentation.registerStateReader(() => ({values, visible_step}))` 提供自定义参数，异步计算完成可调用 `window.presentation.commitState()`。制作提示与预览环境提供同一接口；预览环境仅执行页面，不写读者现场。
- `POST /agent/presentation.state.save` 核对当前书、会话、来源回合及已提交版本，复用公开文字/来源编译，实际写入后返回 `PresentationFollowUp`。私有文件位于 `agent-history.presentations/states/<presentation_id>/<revision>/<state_revision>.json`；现场修订在同一内容版本内递增，历史快照不覆盖。
- 回答内增加“解释现在的结果”和自定义追问输入。发送前重新采集一份现场并串行保存，成功后经 `RightRail → App → agentRunCreate` 进入原 Resident 生命周期。保存失败显示具体原因、保留问题，允许重试。
- `prepare_agent_chat` 在预提交前读取确切回执；版本、来源回合、现场修订及活动会话错配均拒绝。回执随用户回合原子预提交；标题、语义说明、假设和该现场进入 `agent_message`，经原 `run_precommitted_agent_chat` 传给模型。完整 HTML/JS 不进入追问上下文。
- 后续页面变化不会替换已选定的快照；回看旧版按旧版追问。参数和显示结果为页面观察，沿用现有来源证据、取消和历史语义。

## 验证结果

| 验证 | 结果 | 检测的失败 |
| --- | --- | --- |
| 最终 Server 呈现筛选 | 14 通过、5 个按需入口跳过 | 修订号现场存储、模型确切输入、旧版与旧现场、持久历史、错配回执、真实写入失败及既有呈现回归 |
| Server Resident / 历史 / 来源 | 22 / 6 / 5 通过 | 新回执与回合预提交不破坏原 Resident 生命周期、取消、历史及来源路由 |
| RP5 真实浏览器 + Rust 接口 | 2 通过 | input 不保存/不采样，change 和步骤保存；语义核对通过后才采集可见结果；延迟显式保存期间改参数仍使用原快照；保存失败不发起模型请求、问题保留且可重试 |
| RP3 浏览器回归 | 4 通过 | 静态/动态来源、展开同实例、主题和窄屏、无效 ref、内部位置与脚本错误 |
| 最终浏览器桥独立测试 | 1 通过 | 最终代码的可见结果过滤、自定义参数/步骤、原生 checkbox、图形可访问说明 |
| Web 相关单测 | 25 通过 | RightRail 15、运行状态 5、Markdown 3、内容装配 2 |
| Web 类型检查 | 通过 | 共享现场/回执与组件事件、App 请求字段一致 |
| Runtime 呈现类型生成 / 提示模块 | 4 / 5 通过 | ts-rs 投影、制作提示模块接入 |
| 最终 Server 构建与运行 | 通过 | Rust 类型、调用、链接成立，且上述用例实际启动执行 |

首次 Server 测试通过后，将现场文件从随机身份文件名调整为修订号文件名，以扫描文件名递增修订，避免每次保存重读所有历史快照；保存回执和归属合同保持。该最终存储布局已由 Server 呈现、Resident、历史及来源回归验证。

最终浏览器验收首轮发现一个真实竞态：步骤切换后，公开语义核对会暂时隐藏页面，现场采集可能正好读到空可见结果，导致保存被拒绝。`presentation-bridge` 改为等待当前观察修订收到 `accepted` 后再采集并保存；修复后 RP5 2 项、RP3 4 项及独立桥 1 项共 7 项浏览器测试全部通过。

模型边界使用记录实际 `AgentRequestPlan` 的确定性适配器；没有模拟私有文件系统或正常来源/现场 API。浏览器失败提示场景由验收宿主注入一个保存错误，真实文件写入失败另由 Server 测试覆盖。本轮未新增真实 Provider 采样；RP4 现场生成与纠错证据仍见 [RP4 记录](agent-presentation-rp4-20260917.md)。

浏览器实际证据：[现场追问入口](rp5-windows/follow-up.png)。截图中页面已继续变为 3/3，但测试断言模型收到点击追问时的 1/3、步骤 explain 及对应回执。最终 7 项输出在 `D:/codex-build/understand-book-rp5/acceptance-passed`。

## 复跑

```text
cargo test -p server --lib presentation_ -- --test-threads=1
cargo test -p server --lib resident_ -- --test-threads=1
cargo test -p server --lib agent_history -- --test-threads=1
cargo test -p server --lib agent_source -- --test-threads=1
cargo test -p runtime --lib presentation::export_bindings -- --test-threads=1
cargo test -p runtime --lib agent_prompt -- --test-threads=1
pnpm --filter @understand-book/web typecheck
pnpm --filter @understand-book/web exec vitest run src/components/RightRail.test.ts src/agent-run-state.test.ts src/md.test.ts src/presentation-document.test.ts

# 单独启动真实 Rust 验收宿主，然后运行浏览器测试；结束后访问 /stop，避免 Windows 占用测试程序。
cargo test -p server --lib presentation_browser_host -- --ignored --nocapture --test-threads=1
pnpm --filter @understand-book/web exec playwright test playwright/agent-presentation-follow-up.spec.ts playwright/agent-presentation.spec.ts playwright/presentation-bridge.spec.ts --workers=1
```

沿用 D 盘 RP2 构建缓存及临时目录，dev/test debug=0、incremental=0、`_LINK_=/DEBUG:NONE /PDB:NONE`，未修改仓库构建配置。

## 已知问题与后续

- Server 测试程序曾在启动前返回 OS error 5。只读诊断发现 360 隔离目录中的同大小、同时间文件，但未读到原路径/检测名，因此不将它记为已确诊误报。用户关闭 360 后，同一最终测试程序正常启动，上述 Server 回归全部通过；本轮未恢复隔离文件、加白或修改安全配置。证据见 [启动诊断](rp5-windows/startup-diagnosis.json)。
- 本轮为 Windows 源码与浏览器验证；没有替换日常 Reader、制作安装包或重新部署 Linux。RP7 负责完整两平台体验。
- 持久现场恢复到页面、持续修改已有内容及跨版本参数接纳属于 RP6；本轮仅保存和按确切现场追问。
- 自定义内部参数需由页面注册读取器；未注册的既有页面仍提供原生控件和当前可见文字。图形含义需页面提供可见/可访问说明，不做像素识别或自动判题。
