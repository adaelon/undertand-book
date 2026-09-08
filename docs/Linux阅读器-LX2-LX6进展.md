# Linux 阅读器 LX2–LX6 实施与验收

状态：**LX2–LX6 完成，2026-09-08**。机器结果见 [验收 JSON](Linux阅读器-LX2-LX6验收.json)，操作入口见 [数据迁入与服务配置](Linux阅读器数据迁入.md)。基于 `9e36507` 当前工作树，包含前序未提交修改；本次未创建 commit。

| 切片 | 实现与结果 |
|---|---|
| LX2 | 三种宿主/模式分别投影；保留位置参数与环境书目录；固定书库；纯阅读预构建请求在副作用前拒绝；Tauri 两个配置分支保持桌面身份 |
| LX3 | 复用原就绪规则；纯阅读跳过自动恢复、自动 rerun 和记录清理；缺失材料显示等待与具体原因，不展示旧阅读区 |
| LX4 | Node --import tsx 源码调用与桌面打包调用通过；真实 reader_ready 记录及报告可读；accepted 成果在纯阅读及私有根迁入后保持相同投影 |
| LX5 | 显式目录映射脚本支持当前/旧版 session 与外部书籍索引；两书不同阅读位置、中文空格目录、笔记、画像读取和历史经迁入与重启恢复 |
| LX6 | Linux SIGINT/SIGTERM 接入主线程停止；模型当前请求有界，停止后不发起下一次；待持久已读冲刷；systemd 专用账户停止/重启通过 |

## 验证证据

- Windows：server 库 **238 项**、CLI **1 项**通过；Tauri 编译检查通过；前端宿主菜单/分流/书库 **7 项**、路径脚本 **3 项**通过；正式前端构建及类型检查通过。
- Linux：最终原生 release 与正式前端构建通过；库首次 **239 项通过、1 项缺夹具失败**。补齐原有 `quantification-essence` 完整测试材料后，该失败用例通过，搜索代码未改；Linux CLI **1 项**、路径脚本 **3 项**通过。
- 两份真实材料 **43 项 HTTP/迁入/生命周期断言**通过。内容直比证明刷新和缺失材料查询不改写构建文件；专门观测到发 SIGTERM 前已读仍待持久，退出后账本已写入，重启可读回。
- 受控 Provider 在真实 HTTP 请求已进入后延迟响应，SIGTERM 期间该响应完成、历史落盘、进程正常退出；另测 SIGINT 正常退出。
- Windows Chromium 经 SSH 隧道访问 Linux 正式 dist：宿主菜单、书库、缺失材料刷新通过，无自动预构建请求和 JavaScript 错误。验收脚本关闭临时 HTTP 连接后执行浏览器步骤；临时隧道已关闭。
- systemd 使用 `understand-book` 专用账户；停止约 **0.10 秒**，旧进程退出，重启恢复阅读位置，统计接口在服务账户下可用。

## 当前部署

- 服务：`understand-book.service`，已启用并运行；监听 `127.0.0.1:8787`。
- 源码：`/opt/understand-book/source`；书库：`/opt/understand-book/books`。
- 本次独立私有数据：`/opt/understand-book/data/lx6/{memory,private}`；配置：`/opt/understand-book/reader.env`。
- 远端证据：`/opt/understand-book/acceptance/lx2-lx6`；本地原始证据：`tmp/lx2-lx6/evidence`。源码传输包与文件列表保留在该验收目录，未记录模型密钥或 SSH 密码。

## 已知限制

- LX7 尚未完成：当前常驻配置未填入真实 Provider；本轮延迟 Provider 只验证停止行为。真实问答/带读、PDF 翻译、完整阅读交互和 Windows 桌面最终联验留在 LX7。
- 当前部署面向单读者、veLinux/CentOS 9 x86_64，源码与 Node/tsx 依赖保留在编译目录。
- Vite 大 chunk 提示与 ts-rs 的既有 serde 属性警告保留。
