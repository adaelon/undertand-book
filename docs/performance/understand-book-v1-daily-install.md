# V1 日常安装更新

日期：2026-09-08。承接 [Mastering Rust 排查](understand-book-mastering-rust-20260908-diagnosis.md)；用户确认继续更新日常安装。

## 安装结果

- 插件版本从 `0.1.0+codex.20260907110058` 更新为 `0.1.0+codex.20260908031700`。
- 从当前源码重新编译 384 个模块，替换 `E:\allwork\Understand Book\understand-book-build.exe`。
- 更新已有本地市场的发布副本，通过桌面自带 CLI 0.153.4 重新安装 `understand-book@understand-book-local`。
- 新缓存为 `C:\Users\Lenovo\.codex\plugins\cache\understand-book-local\understand-book\0.1.0+codex.20260908031700`。
- 仓库发布副本、本地市场副本与日常缓存的 10 个文件集合及字节全部一致；安装后的 Build Engine 与重建产物逐字节一致。
- 项目 Agent 注册检查返回 `source_state=same`；`.codex/agents/understand-book-executor.toml` 与新缓存模板按换行规范化后相同。
- CLI 插件列表确认新版本 installed/enabled；`mcp get understand_book_build_executor` 的实际 cwd 指向新缓存，并列出四个协议工具。

## 验证结果

插件结构校验、source contract、重新编译均通过。新安装路径及新缓存 launcher 的[恢复 canary](understand-book-v1-daily-install-recovery.json)通过：三次语义尝试、三次持久提交，零调用失败和连接终态拒绝按原规则恢复，已有两份成功回执不变。

另启动一个没有 `UNDERSTAND_BOOK_BUILD_EXE` 环境变量覆盖的 MCP 连接，从日常缓存 launcher 经注册表定位 Build Engine，四工具发现与正常退出通过。

原书 `Mastering Rust.epub` 使用原 confirmed plan 的只读 plan 调用耗时 4.345 秒；随后沿用原 invocation 的一次真实 `build.step` 耗时 32.620 秒，返回 `SPAWN_EXECUTORS` 及三个引用。[恢复入口证据](understand-book-v1-daily-install-resume.json)确认原计划、invocation 和 327 份已有成功回执字节不变。此次调用尚未执行语义生成。

本书旧程序 20 次 step 的中位数为 83.16 秒。32.62 秒是安装后一个新样本，当前状态也已有推进；它说明实际调度等待缩短，但不是同一起始状态的严格 A/B。真实书的剩余调度成本仍需独立定位。

## 新宿主验证

更新前已存在的当前任务未刷新 Executor 工具环境，三个验证 child 均零调用返回 `bootstrap_unavailable`。三个观察已按原 invocation 分别回报 Driver，由 Driver 依据已有 open/恢复状态决定是否处理。

桌面 CLI 临时会话的一轮三槽验证已完成，宿主退出码为 0，墙钟 133.820 秒。三个独立 child 均返回 `committed`；磁盘成功回执从 327 增至 330，原有 327 份逐字节不变。新增成功单元为 `discourse-104-1-009887433e90`、`discourse-117-2-0ccc9d7f8cd2`、`discourse-119-2-c2a8cdede7d4`。

其中 `discourse-104-1-009887433e90` 就是原任务第 17 个 child 输入引用抄错后停住的单元；其同一手交引用在新的连接中恢复并完成首次语义尝试。此次恢复沿用已打开的持久会话，未新增通用恢复协议。三个成功结果均落在原书外层工作区。

三次零调用观察的 Driver 回报分别耗时 37.63、35.64、37.18 秒。因此新程序在这本书上仍有约 30–40 秒的调度成本；本轮完成日常安装及真实恢复验证，不代表剩余性能问题全部解决。

## 备份与后续入口

- 安装目录保留旧程序：`E:\allwork\Understand Book\understand-book-build.exe.before-v1-20260908031700`。
- 另存旧程序、旧市场副本、旧 manifest 与项目 Agent 到 `tmp/v1/daily-install-20260908/`。
- 私有验证目录保留原 invocation 的当前 Driver 回复和临时宿主轨迹；公共记录不复制 opaque refs、语义正文或候选。
- 重开任务时从新缓存读取 build skill，沿用 Mastering Rust 的原计划及 invocation。现有旧任务不会因为文件更新而自动重载工具。

## 范围

本次更新本机 Build Engine 与日常插件安装，未重新打包 Windows Setup、推送 Git 或发布远程市场。原 V1 记录中的“日常安装未更新”描述的是早先候选验收的历史状态，由本记录补齐部署结果。全局 checkpoint 仍属于并行的 Linux 工作，本次部署入口登记在代码链路。
