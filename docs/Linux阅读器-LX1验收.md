# Linux 阅读器 LX1 实机验收

状态：**LX1 通过，2026-09-08**。Linux 原生构建、两份材料的 11 项 HTTP 检查，以及 Windows 经 SSH 隧道访问均通过。当前源码无需修改即可完成这些基础运行场景。

范围与判据见 [切片方案 LX1](切片方案-Linux阅读器本体适配.md)；部署决策见 [ADR-0122](adr/0122-linux-reader-host-and-source-deployment.md)。

逐项机器结果见 [LX1 验收 JSON](Linux阅读器-LX1验收.json)。

## 目标环境

通过 Windows OpenSSH 登录用户提供的目标机采集，远端主机名与原系统输出一致。

| 项目 | 实测结果 |
|---|---|
| 系统 | veLinux 2.2 CentOS Compat / CentOS Stream 9，x86_64 |
| 内核 | `5.15.120-5.ve2.x86_64` |
| glibc | `2.34` |
| GCC / libstdc++ | `11.5.0` |
| OpenSSL 开发包 | `openssl-devel-3.2.2-6.el9.x86_64` 已安装 |
| make / pkg-config | `4.3` / `1.7.3` |
| Python / Git | `3.9.21` / `2.47.1` |
| systemd | `252 (252-51.el9)`；状态 `running` |
| CPU / 内存 | 4 个逻辑 CPU；内存约 3.63 GiB，采集时可用约 1.59 GiB，无 swap |
| 根分区可用空间 | 采集时约 23.54 GiB |
| Node / pnpm | 初始未安装；已在项目独立目录安装 `v24.20.0` / `10.34.2` |
| Rust / Cargo | `rustc 1.98.1 (48a229cea 2026-09-01)` / `cargo 1.98.1 (797e8a9bc 2026-08-05)` |

## 部署与源码

- 部署根：`/opt/understand-book`；源码：`/opt/understand-book/source`；工具链：`/opt/understand-book/tools`。
- 原生 C 工具链及 OpenSSL 开发包已具备，本次直接复用；新增 Node、pnpm、Rust 工具链使用项目专属目录。
- 源码快照基于 `9e36507 feat(build): complete executor transport compression` 的当前工作树，包含相关未提交修改和新文件，共 803 个源码/配置文件、13,595,123 字节。
- 传输包为 `acceptance/lx1/payload.tar.gz`，大小 9,456,183 字节；解包后保留 `acceptance/lx1/source-snapshot.json`，记录源码文件集合、时间与 HEAD。
- 材料使用 `quickstart-demo` 与 `understanding-transformer-from-the-perspective-of-associative-memory` 的完整副本，存入独立 `books` 目录；后者包含原始 PDF 和隐藏 `.build` 元数据。
- 私有验收目录：`/opt/understand-book/data/lx1`。验收不接入 Windows 日常 Reader 的私有目录。

## 执行结果

| 阶段 | 实际命令 / 证据 | 结果 |
|---|---|---|
| Node、pnpm 安装 | `acceptance/lx1/prepare-tools.sh` 与 `tools.log` | Node `v24.20.0`、pnpm `10.34.2` 可执行 |
| Rust 工具链安装 | `acceptance/lx1/resume-rust.sh` 与 `rust-install.log` | 通过，退出码 0；固定 `1.98.1-x86_64-unknown-linux-gnu` |
| 依赖安装 | `pnpm install --frozen-lockfile` | 通过 |
| 前端正式构建 | `pnpm -C packages/web build` | 通过；包含 `vue-tsc --noEmit` 和 Vite build，输出 `packages/web/dist` |
| Rust 服务构建 | `cargo build --offline --locked --release -p server --bin server -j 1` | 通过，退出码 0；release 构建耗时 5 分 14 秒 |
| 页面、正文与资源 HTTP | `acceptance/lx1/smoke-baseline.py` | 两份材料共 11 项通过，退出码 0 |
| Windows 经 SSH 隧道访问 | 本地 `127.0.0.1:18787` 转发至远端 `127.0.0.1:8787` | 页面、宿主状态、书籍 manifest 三个真实请求均通过 |

远端执行脚本、日志和阶段退出码保留在 `/opt/understand-book/acceptance/lx1`，原始证据已取回 Windows。Linux 二进制为 `source/target/release/server`，大小 18,295,128 字节。

首次 Rust 组件直下载持续偏慢，改由 Windows 从同一官方发布地址下载 `rustc` 与 `rust-std`，传入 rustup 下载缓存后完成安装。初次下载进程由本次操作终止，`tools.exit=143` 记录该中断；最终安装结果以 `rust-install.exit=0` 和实际版本输出为准。

Cargo 在线索引拉取同样偏慢，复用 Windows 中与当前 `Cargo.lock` 对应的全部 453 份 crate 源码归档及索引缓存，随后在 Linux 执行离线构建。在线拉取进程被终止后，最终原生构建证据为 `server-offline.log` 与 `server-offline.exit=0`。

## HTTP 与跨机结果

| 材料 / 入口 | 实际断言 | 结果 |
|---|---|---|
| `quickstart-demo` | HTML 与正式 dist 一致；JS/CSS 与构建文件一致；manifest 的 23 个 LID 与基座一致；`1.2` 正文与源文件对应 UTF-16 范围一致 | 5/5 通过 |
| `understanding-transformer-from-the-perspective-of-associative-memory` | HTML、JS/CSS 一致；manifest 的 2,017 个 LID 与基座一致；`1.1` 正文与源文件范围一致；原始 PDF 的 2,646,721 字节逐字节一致 | 6/6 通过 |
| Windows 隧道入口 | HTTP 200；宿主响应中的书目录位于 `/opt/understand-book/books`；manifest 返回上述论文的 2,017 个 LID | 通过 |

验收结束后，两个基线测试进程、跨机访问用的临时服务和 SSH 隧道均已停止。源码、工具链、材料副本和验收证据保留，供 LX2 继续使用。

## 已知限制

- LX1 证明原生构建、进程启动及基础页面/材料接口；宿主身份、纯阅读入口、统计辅助调用、路径迁入、真实 Provider 和 systemd 生命周期分别由后续切片验收。
- Linux 实机的 `/desktop/status` 仍返回 `desktop_host: true`，与现有代码一致，交由 LX2 修正。`--reader-only` 尚未实现。
- 本轮使用真实 HTTP 和文件比对；浏览器 JavaScript 交互、真实模型及重启持久化尚待后续验收。临时进程清理不作为 LX6 有序停止通过的证据。
- Vite 保留现有大 chunk 提示，Rust 构建保留 ts-rs 的 serde 属性解析警告。本轮没有修改共享运行时代码，未额外执行 Windows 运行时回归。
