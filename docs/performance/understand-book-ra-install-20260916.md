# R1–R4 与 A1–A5 本机合并安装

日期：2026-09-16。用户授权将 R1–R4 与 A1–A5 一起编译、更新本机程序与插件，随后在新任务开展 A6。

## 安装结果

- Build Engine：`E:/allwork/Understand Book/understand-book-build.exe`；本次完整工作树编译 392 模块，包含调用纠错与诊断，以及局部追加、关系选择/增量、发布和缺项恢复。
- 插件：`0.1.0+codex.20260916085911`，通过已配置的 `understand-book-local` 本地市场执行 CLI 重装。
- 缓存：`C:/Users/Lenovo/.codex/plugins/cache/understand-book-local/understand-book/0.1.0+codex.20260916085911`。
- 项目执行器注册返回 `source_state=same`，规范角色字节一致；新任务读取更新后的插件。
- 旧程序备份：`E:/allwork/Understand Book/understand-book-build.exe.before-ra-20260916085911`；旧市场插件另存 `tmp/ra-install-20260916/previous-market-plugin`。

## 验证

[安装证据](understand-book-ra-install-20260916.json)、[编译执行器证据](understand-book-ra-compiled-20260916.json)。

- 392 模块编译成功；源码/编译程序 outside-repo parity、提示词、protocol doctor、派发租约/收据与旧协议恢复检查通过。
- R/A 定向回归 25 项通过：调用诊断 5、MCP 合同 13、物化 4、旧成果复用及公共回滚 3。
- T7 使用仓库外 E 盘插件副本执行，包含诊断入口、未知版本、短引用错误分类、同连接纠正、分批交付、提交、恢复和超预算边界；状态 passed。该副本与最终安装插件来自同一版本，最终另行逐文件核验安装缓存。
- 插件结构校验与发布 gate 通过。源码、市场副本、缓存的 10 个文件集合及字节一致；本机程序与编译产物逐字节一致。
- 最终安装缓存的 launcher 在不设置 `UNDERSTAND_BOOK_BUILD_EXE` 时通过注册表找到本机程序，四工具发现成功。

本轮日志及核验入口位于 `tmp/ra-install-20260916/`。T7 首次传入仓库内插件目录被测试的隔离条件拒绝，随后使用仓库外副本通过；未修改测试条件。

## 临时空间处理

C 盘初始可用空间为 0，构建与验收临时目录改放 E 盘。确认无相关进程且文件不再更新后，将以下旧测试目录完整移至 `E:/allwork/download/agent/understand-book-ra-install-20260916/old-temp/` 保留：

- `understand-book-t7-executor-release-AybByL`、`understand-book-t7-executor-release-VhJZl8`。
- `understand-book-w1-current-codex-01a05c42`、`understand-book-w1-codex-01a05c42`。

释放空间后完成日常插件缓存写入。未移动真实书籍目录或日常 Driver registry。

## 后续验收

A6 留给新任务。本轮没有启动真实书语义生成，也没有修改 Mastering Rust 成果；其 `stitch:fragment:0003` 缺少 core 单元 23–29，仍需在隔离副本通过正常工作身份定点修复，再验收关系召回、最终发布、Reader 与实际模型成本。

现有运行中的任务与进程不会重载已加载的角色或程序映像。新任务使用本次安装；未打包 Windows Setup、发布远程市场或提交工作树。
