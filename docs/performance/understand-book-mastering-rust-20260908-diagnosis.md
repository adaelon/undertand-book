# Mastering Rust 实际运行慢：2026-09-08 排查

对象：[构建 Mastering Rust 深读](codex://threads/01a07e93-ff0b-71d3-9318-7f2c140aec8f)。
调度样本截止 2026-09-08 10:59:52（Asia/Hong_Kong）；该任务在取证时仍在运行。

结论：本次运行没有使用 V1 候选 Build Engine，Root 读取的插件缓存也未包含最新补位合同；此外，已出现一个输入引用抄写错误后无法推进的槽位。慢来自实际安装未更新、补位空窗和失败恢复三个问题。

后续状态：已完成 [V1 日常安装更新与三槽真实恢复](understand-book-v1-daily-install.md)。下文保留原排查时点的证据。

## 1. 实际安装未承接 V1

Root 的调用记录明确使用 `E:\allwork\Understand Book\understand-book-build.exe`。注册表 `HKCU\Software\UnderstandBook\InstallDir` 指向该目录；取证时存活的 Executor MCP 进程也从该路径启动。

| 文件 | 字节数 | 文件修改时间（香港时间） |
|---|---:|---|
| 日常安装的 Build Engine | 105651712 | 2026-09-07 18:23:54 |
| 仓库 V1 候选 compiled Build Engine | 105669632 | 2026-09-08 07:16:16 |
| V1 保留的上一轮 L1/L2 compiled 备份 | 105655808 | 2026-09-08 05:53:32 |

直接比较文件字节：日常安装既不等于 V1 候选，也不等于上一轮 L1/L2 备份。候选位于 `apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe`。

Root 实际读取的缓存为 `C:\Users\Lenovo\.codex\plugins\cache\understand-book-local\understand-book\0.1.0+codex.20260907110058`。与仓库 `plugins/understand-book` 逐文件比较：

- `skills/build/SKILL.md`、`skills/executor/SKILL.md`、`assets/codex-agents/understand-book-executor.toml` 均不同。
- `.mcp.json` 相同；其 launcher 按环境变量或注册表寻找独立安装的 Build Engine。
- 旧 build skill 缺少“消费已到达的全部终态，且 step 返回后再次消费调用期间到达的终态，再按最新容量补位”的完整规则，也缺少 L2 的连接打开失败上报规则。

[V1 验收记录](understand-book-v1-release.md)写明只做隔离安装，日常个人安装未改动。因此，V1 候选验收成功没有使本次任务的实际安装自动更新；同版本的旧缓存仍被使用。不能把本次运行作为 V1 新程序的性能回归样本。

## 2. 工具成本和补位空窗

20 次完成的 `build.step`，单次 79.36–89.45 秒，中位数 83.16 秒，调用时长之和约 1679.12 秒（27.99 分钟）。最初两次调用有时间重叠，因此这个和不是整轮额外损失的墙钟时间。

首个 child 的四次工具往返如下。计时从实际 `functions.exec` 发起该操作到最终结果交回 child，包括 yield 后取回结果的间隔。

| 操作 | 往返秒数 |
|---|---:|
| executor.open | 35.183 |
| executor.input.next | 29.768 |
| executor.generation.start | 42.389 |
| executor.submit_candidate | 42.362 |
| 合计 | 149.702 |

首个 child 从首次 open 到提交结果共 204.556 秒。首批另两个 child 的四次往返合计分别为 152.568 和 155.975 秒。这说明生成之外的工具等待占了很大一部分。

可直接观察到的补位错误：

1. 首批三个 child 分别在 09:22:15、09:22:51、09:23:04 完成。
2. Root 在第一个完成后以 `available_agent_slots=1` 请求下一步；该请求 09:23:58 才结束。调用期间另两个 child 已经完成。
3. Root 09:24:17 只启动一个新 child，随后一直等到它 09:27:57 完成；在这 3 分 40 秒内另外两槽空闲。
4. 后面还有 09:46:36–09:56:11 约 9 分 35 秒的单 child 阶段。

Root 把这一现象解释为“驱动只签发一个，所以依赖只允许一个”。记录显示它向 Driver 报的是过期的单槽容量；`max_parallel=3` 本身不能补偿这个错误。当前源码的 L1 规则针对的正是这类情况。

最初第一条长调用还丢失了进程句柄：Root 只输出 `exit_code/output`，没有保留仍在运行时返回的 `session_id`，随后重新启动了一次相同 step。两次最终返回同一组三个引用；这是一次额外重复调用。

## 3. 输入引用抄错后，一个槽持续无法推进

`book_exec_17`（`01a07ec2-a357-7073-a3a2-5b3657714775`）在 10:05:37 收到正常 `DELIVER_INPUT`，其 `next_request.version` 为 `automatic_build_executor_input_next_request.v4`。

该 child 的下一次代码调用先发生语法错误；随后在 10:05:59 调用 `executor.input.next` 时，两个引用均不等于工具原样返回值：`opaque_session_ref` 长度从 75 变成 76，`generation_input_ref` 从 73 变成 69。请求版本未变化。工具立即返回 `interrupted/bootstrap/protocol_incompatible/input_delivery`，child 于 10:06:06 退出。

从第 10 次到第 20 次调度，Driver 连续 11 次返回这个 child 原先拥有的同一个 handoff。Root 将它放入 `completed_refs` 后不断跳过，没有启动替代 child，也没有进入明确的人工恢复边界。结果是这一路工作持续悬空，其余槽位仍能推进。

这不是“零调用且从未 open”的 `bootstrap_unavailable`，也不是 L2 的 `connection_terminal/open` 或 `handoff_ref_mismatch/open`。V1 已实现的这两种恢复规则不能直接套用。当前 build skill 本身仍把历史 `protocol_incompatible` 定义为安装/人工恢复边界。V1 的故障 canary 没有覆盖本次“已成功 open，input.next 抄错引用后退出”的实际故障。

## 后续处理范围

先让日常 Build Engine、插件缓存和实际加载的 Agent 合同承接同一候选版本，并让后续运行建立新的 MCP 连接；同时保留本书原计划、invocation 和 accepted 结果。现有失败槽需要按其已打开但未生成的实际状态确定恢复入口，不能仅更新文件后认为它会自行解开。

后续验收应在该书既有状态上记录少量真实 step/child 往返及三槽补位，并覆盖本次输入阶段失败。V1 合成样本的约 4 秒 step 和四次 MCP 合计约 4 秒是参考数据，不是本书更新后耗时的承诺。

## 取证边界

- 本次只读任务记录、安装文件、进程路径和源码；未调用真实书的 build.step 或 Executor 工具，未修改安装、书内状态或正在运行的任务。
- 未改全局 checkpoint；它已由另一项 Linux 工作刷新。
- 原始轨迹位于 `C:\Users\Lenovo\.codex\sessions\2026\09\08`，Root 文件名为 `rollout-2026-09-08T09-13-43-01a07e93-ff0b-71d3-9318-7f2c140aec8f.jsonl`。本记录不复制语义正文、候选或完整 opaque refs。
- 子工具往返没有服务端内部计时，不能进一步精确拆成文件读取、进程或宿主等待；安装差异、长调用、补位空窗和引用错误均有独立直接证据。

## 工作区嵌套补查（2026-09-08）

实际工作区是 `E:\allwork\download\agent\lifebook\.understand-book\mastering-rust`。其内层 `.understand-book/mastering-rust` 创建于 2026-09-07 20:15；内层只有 `.build` 下的计划、Pass1 policy 和 migration 状态，未找到成功结果回执。

2026-09-08 09:14 的原任务和 11:29 的新任务“深读 Mastering Rust EPUB”（`01a07f0f-0732-79f0-bb06-2a17e9c6d9ca`）都曾把完整工作区误传给 `legacy-plan --root`。该参数是书库根目录，程序会继续拼接 `.understand-book/<book-id>`，因此产生双层目录。两次均随后改用 `--root E:\allwork\download\agent\lifebook`；新任务的错误计划尚未确认或执行。

截至补查，外层 `.build` 今天有 551 个新建/修改文件、33 份成功结果回执、1 份失败结果回执；33 个已接受侧车产物在 `.build/automatic-build/v3/artifacts/profile_sidecar/profile-sidecar-discourse.full.v2`。内层今天只增加两份 legacy plan。最新三份成功结果来自本次安装验证，原有 327 份成功回执字节不变。顶层 `base.json` 的日期不能代表增量侧车构建进展。未删除或移动内层目录。
