# Linux 阅读器本体适配切片方案

状态：LX0–LX7 完成；真实 Provider、完整阅读交互、重启及 Windows 联验通过。2026-09-08。

决策依据：[ADR-0122](adr/0122-linux-reader-host-and-source-deployment.md)。[LX1 实机验收](Linux阅读器-LX1验收.md) 已取得原生构建与基础运行证据；完整 Linux 可用性以 LX7 的实机证据为准。

## 0. 目标与对齐

**FrozenIntent**：让阅读器本体在用户自有 Linux 服务器常驻运行，浏览器消费已构建书籍，保留读时 Agent、正文/PDF、导航、笔记、画像和聊天历史；验收包括跨平台材料迁入、真实模型调用、有序停止与重启恢复。预构建继续在现有环境完成。

**TermMap**：

| 术语 | 状态 | 本方案含义 |
|---|---|---|
| 阅读器 / 阅读器本体 | BOUNDARY_CHANGE | 独立阅读产品增加自有服务器部署位置 |
| 预构建期 / 读时 | EXISTING | 服务器消费预构建产物，读时与 agent harness 脱钩 |
| 书 Agent / LLM 后端 | EXISTING | 现有运行时调用用户配置的 Provider |
| 记忆层 / 阅读状态 | EXISTING | 当前读者的私有数据，沿用既有持久化语义 |
| 只读基座 / 来源与 LID | EXISTING | 消费已有材料、身份和证据，不因部署位置改变 |

**RiskReceipt**：服务器消费既有预构建产物的范围已确认。桌面接口、就绪读取、辅助程序和绝对路径是当前部署耦合；未完成 Linux 实机验证的状态保留在验收账本中。

**ChangeType**：`[纯技术]`，扩展运行宿主与部署方式。领域对齐完成。

## 1. 首轮目标环境

以下事实来自目标服务器提供的系统输出：

| 项目 | 已知值 |
|---|---|
| 发行版标识 | `veLinux release 2.2 (lyra) CentOS Compat` |
| 用户态系统标识 | `CentOS Stream 9`，`ID=centos`，`PLATFORM_ID=platform:el9` |
| CPU 架构 | `x86_64` |
| 内核 | `5.15.120-5.ve2.x86_64` |
| glibc / GCC | `2.34` / `11.5.0`，LX1 实测 |
| Node / pnpm | 项目独立目录安装 `v24.20.0` / `10.34.2`，LX1 通过 |
| Rust / Cargo | `1.98.1` / `1.98.1`，`x86_64-unknown-linux-gnu`，LX1 通过 |
| systemd | `252 (252-51.el9)`，服务管理器状态 `running` |

原生依赖安装按该服务器的 EL9/RPM 软件源处理。火山引擎对 veLinux 2.0 CentOS 兼容系列的说明是用户态软件包兼容 CentOS Stream 9；本机具体版本以上表输出和实测为准。[官方说明](https://www.volcengine.com/docs/6396/74967?lang=zh)

首轮 Node 使用 24.x；现有锁文件中 `pdfjs-dist@6.1.200` 的声明为 `>=22.13.0 || >=24`。Node 24 的 Linux x64 官方二进制要求内核至少 4.18、glibc 至少 2.28，并有对应的 libstdc++ 要求；本机 `v24.20.0` 已在 LX1 实际运行并完成前端构建。[项目锁文件](../pnpm-lock.yaml)、[Node 24 平台说明](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)

Rust 采用支持现有 `Cargo.lock` 的 stable 工具链，编译目标为 `x86_64-unknown-linux-gnu`，在验收记录中固定实际版本。该目标属于 Rust 官方 Tier 1 with Host Tools。[Rust 平台支持](https://doc.rust-lang.org/rustc/platform-support.html)

## 2. 现状与必须处理的耦合

| 现状 | 具体影响 | 负责切片 |
|---|---|---|
| [main.rs](../crates/server/src/main.rs) 已独立启动 `server`；[host.rs](../crates/server/src/host.rs) 同端口提供 SPA 与 REST | 可以复用现有阅读服务，不需要桌面进程 | LX1 |
| Windows [start.bat](../start.bat) 也启动同一个独立 `server` | 不能按二进制名称统一关闭预构建；Linux 纯阅读模式需要显式选择，原入口默认行为保持 | LX2、LX3 |
| `ServerHostConfig::from_env` 未设置稳定书库根；`/desktop/status` 无条件返回 `desktop_host: true` | 服务器身份错误，网页会展示依赖 Tauri 的设置入口；书库行为仍可能由当前书目录推导 | LX2 |
| [App.vue](../packages/web/src/App.vue) 的 `init -> loadBuildWorkbenchSnapshot -> maybeAutoRerunSourceReview`；服务端 `route_build_workbench_state` 调用构建恢复逻辑 | 进入阅读器仍经过构建控制流程，需要把服务器的就绪读取保持为读操作 | LX3 |
| paper 就绪判定读取 `.build/source-reconciliation/report.json`、来源 manifest 和映射元数据 | 仅复制正文和 `base.json` 可能被判未就绪；迁入单位必须是完整书籍工作目录 | LX3、LX5 |
| `recordIntentUsage(reader_ready)` 经 [build_intent_api.rs](../crates/server/src/build_intent_api.rs) 调用 `intent.metrics`，前端忽略该请求失败 | 页面可读不代表统计正常；需要保留并实际验证 Node/tsx 辅助路径 | LX4 |
| `workspace_root()` 使用编译期 `CARGO_MANIFEST_DIR`；辅助程序从源码树定位 | 单独搬动二进制可能丢失辅助入口；首版在最终源码目录编译并运行 | LX1、LX4 |
| `SessionState.current_book_dir`、`books` 的键和 `library-registry.json` 保存目录路径 | Windows 路径无法直接用于 Linux，原阅读位置和外部书籍索引需要重定位 | LX5 |
| `main` 只进入 `RunningServer::wait()`；已有 `shutdown()` 未接入 Linux 终止信号 | `systemctl stop` 不能据此保证执行待持久已读账本冲刷 | LX6 |

## 3. 运行与数据契约

```text
现有环境产出完整、已就绪的书籍工作目录
  -> 同步到 Linux 书库
  -> Rust 服务按既有规则加载材料
  -> 浏览器访问同源 SPA + REST
  -> 读时 Agent 调用 Provider
  -> 阅读状态、笔记、画像、聊天历史进入私有持久目录
```

**宿主身份与运行模式**：真实启动入口设置 `desktop_host`；LX2 已实现显式参数 `--reader-only` 及对应 `reader_only` 状态字段，供前端阅读入口与后端预构建请求共同判断。桌面能力与是否执行预构建分别表达，不从操作系统或浏览器 User-Agent 猜测。

| 启动入口 | `desktop_host` | `reader_only` | 保留的行为 |
|---|---|---|---|
| Tauri 的两个启动分支 | `true` | `false` | 桌面设置、阅读与现有预构建流程 |
| 既有 `server <book_dir>` / Windows `start.bat` | `false` | `false` | 现有浏览器阅读与预构建工作台，配置仍由既有环境提供 |
| Linux 新入口 `server --reader-only <book_dir>` | `false` | `true` | 消费已就绪材料，读时 Agent 与私有数据照常读写 |

`reader_only` 只选择本次已明确的纯阅读部署方式，默认 `false`。依赖 Tauri 的操作由 `desktop_host` 控制；预构建操作由 `reader_only` 控制，不能用 `desktop_host=false` 代替禁止预构建。

**Windows 兼容约束**：保留 Windows 桌面与 `start.bat` 的既有调用方式、默认目录、Provider、阅读、预构建及持久化行为。Linux 使用独立部署目录和数据副本。任何触达共享 Rust、Vue 或读时辅助程序的切片，都在该切片验收中验证受影响的 Windows 入口；触达辅助程序时覆盖实际改动涉及的源码 Node 与桌面打包调用分支。Windows 回归失败则在当前切片修复后继续。

**服务配置**：CLI 参数与进程环境是服务器配置入口。systemd 的 `EnvironmentFile` 在进程启动前提供变量；当前 Provider 内部加载 `.env` 的行为不能证明书库和私有目录也已读取该文件。

| 配置 | 状态 | 服务器约定 |
|---|---|---|
| `server <book_dir>` / `UNDERSTAND_BOOK_DIR` | 已有 | 首次至少指定一份已就绪材料，沿用已有会话恢复规则 |
| `--reader-only` / 状态字段 `reader_only` | LX2 已实现 | Linux 启动入口显式传入；未传时保持既有模式，仍支持参数或环境指定书籍 |
| `UNDERSTAND_BOOK_ADDR` | 已有 | 默认 `127.0.0.1:8787` |
| `UNDERSTAND_BOOK_WEB_DIST` | 已有 | 前端构建目录的绝对路径 |
| `UNDERSTAND_BOOK_LIBRARY_ROOT` | LX2 已实现 | 固定书库根，不随切书改变 |
| `UNDERSTAND_BOOK_MEMORY_DIR` | 已有 | memory、session 和 agent-history 所在目录 |
| `UNDERSTAND_BOOK_PRIVATE_DIR` | 已有 | 私有目标成果与使用统计目录 |
| `UNDERSTAND_BOOK_NODE` | 已有 | 服务账户可执行的 Node 绝对路径 |
| `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `FLUID_LLM_MODEL` | 已有 | 三项模型配置齐全后启用现有读时 Provider |
| `UNDERSTAND_BOOK_PROVIDER` | 已有 | 沿用现有 `native` / `react` 选择 |

**材料交接**：同步完整目录，包括隐藏 `.build`、PDF、图片、manifest、映射分片和附属产物；已有 `book_id`、LID、来源与配置标识原样保留。Linux 读取就绪事实，不重新生成这些产物。材料更新采用停止服务后同步、再启动的首版操作流程。

**私有数据**：配置、书籍材料与读者私有数据分开存放。保留笔记、画像与对话时，分别迁入记忆目录和已有私有成果目录；用户自有服务器只由一个 Reader 实例写这份私有数据。

**源码部署**：在最终目录安装 Linux 平台的依赖并执行下面的构建入口；部署说明记录实际 Node、pnpm、Rust 版本。源码与其 `node_modules` 是首版运行交付物的一部分。

```bash
pnpm install --frozen-lockfile
pnpm -C packages/web build
cargo build --locked --release -p server --bin server
```

前端由正式 `dist` 提供。用户浏览器通过 SSH 隧道访问服务的 loopback 端口；服务配置文件中的模型密钥不进入网页响应和部署记录。

### 3.1 从 Windows 执行实机验收

Windows 工作机负责编辑代码、执行 Windows 回归，并通过 SSH 驱动目标 Linux 服务器。Linux 编译、运行、文件持久化和服务管理发生在真实 veLinux 服务器上；浏览器与浏览器自动化可以继续运行在 Windows。

| 执行位置 | 实际工作 | 验收证据 |
|---|---|---|
| Windows 工作机 | 源码编辑与定向回归；同步源码和材料副本；通过 SSH 执行远端命令 | Windows 测试结果、对应源码版本/快照、远端命令输出与退出码 |
| veLinux 服务器 | 原生依赖安装与编译；Rust/Node/Provider 运行；私有数据写入；systemd 停止重启 | Linux 构建结果、服务日志、真实 API 响应、停止后磁盘记录及重启读回结果 |
| Windows 浏览器 / Playwright | 经 SSH 隧道访问 Linux 正式 `dist` 和同源 API，执行阅读交互 | 页面行为、来源定位、网络响应与重启后的恢复结果 |

LX1 已从 Windows OpenSSH 连接用户提供的服务器，并通过本地 `18787` 隧道入口取得 Linux 页面与 API 的真实响应。验收临时进程与隧道已关闭；后续切片复用服务器上的独立目录，按需重新启动验收服务与隧道。

当前工作树包含未提交修改和新文件，同步时必须纳入本次要验收的源码；仅在远端拉取现有 HEAD 不足以取得这些改动。保留该次源码快照作为证据。Linux 在独立目录重新安装依赖并编译，使用完整书籍副本及独立私有目录。

下面的 `reader-linux` 是待替换的 SSH Host 别名示例。远端环境命令从 Windows PowerShell 发出：

```powershell
ssh reader-linux 'getconf GNU_LIBC_VERSION'
```

Linux 服务监听 `127.0.0.1:8787` 后，在 Windows 保持以下隧道进程运行，浏览器访问 `http://127.0.0.1:18787`。本地端口与现有 Windows 阅读器的默认端口分开。

```powershell
ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 reader-linux
```

现有 `packages/web/playwright.config.ts` 启动本地开发服务器，PDF/Note 等部分用例用 `page.route` 返回测试数据；这些用例作为界面回归保留。LX7 的实机浏览器入口指定隧道地址为 `baseURL`，消费 Linux 的正式页面和真实 API，不启动本地开发服务、不用模拟响应替代待验收后端。受控 Provider 延迟仅用于 LX6 的停止行为测试，LX7 的 Agent 验收使用真实 Provider。

WSL 或容器可用于提前发现部分 Linux 编译问题；首轮系统库、源码路径、服务账户、Node 子进程和 systemd 生命周期的验收以目标 veLinux 的结果为准。Linux 环境不需要搬到 Windows，也不需要在服务器上安装桌面浏览器。

## 4. 切片顺序

| 切片 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| LX0 目标与决策 | ADR、术语、当前方案 | 已确认部署范围与真实系统信息 | 完成 |
| LX1 目标环境与原生构建 | 实际工具链版本、Linux server + web dist、启动证据 | LX0 | 完成，见实机验收记录 |
| LX2 宿主身份与服务配置 | 准确宿主投影、固定书库、适合服务器的页面入口 | LX1 | 完成，见 LX2–LX6 验收 |
| LX3 已就绪书籍的阅读入口 | 无构建副作用的就绪读取与切书 | LX2 | 完成，见 LX2–LX6 验收 |
| LX4 读时辅助程序 | 阅读统计与已有目标成果读取闭环 | LX3 | 完成，见 LX2–LX6 验收 |
| LX5 数据迁入与路径重定位 | 迁入说明、已知字段路径映射、持久数据回归 | LX4 | 完成，见 LX2–LX6 验收 |
| LX6 常驻与有序停止 | Linux 启动脚本、systemd unit、信号退出闭环 | LX5 | 完成，见 LX2–LX6 验收 |
| LX7 真实服务器验收 | 实际浏览器/Provider/重启证据及部署说明 | LX6 | 完成，见 LX7 验收 |

每个切片完成后更新本表、触达记录和验收结果；共享代码的 Windows 定向回归随所属切片完成，LX7 汇总两端结果。失败留在对应切片修复。下列新文件名均为拟新增交付物。

## LX1 目标环境与原生构建

**结果**：已完成。原生 release 构建、两份材料的 11 项 HTTP 检查和 Windows 隧道访问通过；本切片未修改运行时代码，详见 [LX1 实机验收](Linux阅读器-LX1验收.md)。

**目标与触达**：在目标 veLinux 服务器完成运行环境核对和独立服务构建。使用根目录锁文件、`packages/web`、`crates/server` 及其依赖；仅修复实际构建暴露的 Linux 编译或原生依赖问题。

**输入 / 产出**：当前源码、完整已构建材料的副本 -> 工具链版本记录、Linux `server`、web `dist`、同端口静态页面与书籍 API 的响应；证据写入 `docs/Linux阅读器-LX1验收.md`。

先采集 `getconf GNU_LIBC_VERSION`、Node/pnpm/Rust/Cargo/系统 C 编译器版本及 systemd 可用性。缺项才补对应工具；从配置的软件源确认包名与可用版本，源码编译所需 C 工具链与运行 Node 官方二进制所需库分别处理。Node 启动失败时依据加载器错误处理用户态库，不从发行版名称推算版本。

在 Linux 的独立部署目录执行第 3 节构建入口，用隔离的私有目录启动已构建书籍副本。LX1 使用当前 `server <book_dir>` 启动语法；`--reader-only` 尚待 LX2 实施。取 `/`、`/api/book/manifest`、一个真实 LID 正文以及该书已声明的 PDF/图片资源。

**验收与失败动作**：二进制能启动且上述响应与材料一致。若失败，定位到编译、依赖加载、文件定位或 HTTP 响应这一层；此切片的成功只证明 Linux 基础进程可运行，页面交互由后续切片验收。

## LX2 宿主身份与服务配置

**结果**：已完成，见 [LX2–LX6 验收](Linux阅读器-LX2-LX6进展.md) 与 [机器结果](Linux阅读器-LX2-LX6验收.json)。

**目标与触达**：在 `crates/server/src/host.rs::ServerHostConfig`、`crates/server/src/main.rs`、`crates/server/src/lib.rs` 的宿主/书库投影以及 `packages/web/src/App.vue` 处理实际宿主差异。同步更新 `apps/desktop/src-tauri/src/main.rs` 的两个启动分支，保持 Windows 宿主身份准确。

**输入 / 产出**：服务环境、启动书籍与显式 `--reader-only` 参数 -> 固定书库根、符合第 3 节入口表的宿主/模式状态、正常的浏览器阅读/切书入口。未传该参数保持既有行为；现有位置参数及 `UNDERSTAND_BOOK_DIR` 两种启动方式都继续有效。

纯阅读模式展示正文、书库及读时能力，模型和目录由服务配置管理；直接启动预构建的请求在任何启动副作用前返回明确的不支持错误。桌面设置、插件安装等 native 操作仅在 Tauri 宿主展示。Windows `start.bat` 与既有独立 server 的预构建工作台保持可用。

**验收与失败动作**：覆盖第 3 节三类真实启动入口，Tauri 的两个配置分支都要覆盖；断言宿主/模式响应、首次书籍选择和切书后书库根。普通浏览器菜单不能触发 Tauri `invoke` 或 native dialog；纯阅读模式不支持的请求不启动构建进程。Windows 桌面设置与 `start.bat` 工作台仍可用。若入口被误判或原 CLI 语法失效，修正入口赋值或参数解析后再进入 LX3。

## LX3 已就绪书籍的阅读入口

**结果**：已完成，见 [LX2–LX6 验收](Linux阅读器-LX2-LX6进展.md) 与 [机器结果](Linux阅读器-LX2-LX6验收.json)。

**目标与触达**：沿 `App.vue::init/loadBuildWorkbenchSnapshot/maybeAutoRerunSourceReview`、`surface-selection.ts` 和 `server::route_build_workbench_state/route_build_workbench`，让纯阅读模式消费已有就绪状态。

```text
reader_only=true + 已就绪材料 -> 原有就绪判定 -> 阅读器
reader_only=true + 缺少必需材料 -> 明确列出缺失材料 -> 等待同步
reader_only=false（桌面 / 既有 server）-> 沿用既有工作台、恢复与用户操作
```

就绪规则复用现有 Rust 判定，只拆出读操作所需部分；纯阅读模式的查询不调用构建恢复写入或自动 rerun。基础材料不完整时不伪造就绪。读取 `.build` 的必要元数据继续有效，读取这些文件不等于执行预构建。

**验收与失败动作**：用一份现有 technical-learning 材料和一份 paper/PDF 材料，覆盖加载、刷新和切书。通过隔离副本的文件内容直比确认纯阅读模式的就绪读取没有改写构建状态；移除该 profile 必需的一项元数据，页面应说明材料缺失且不发起构建请求。Windows 桌面与 `start.bat` 同时验证既有工作台、恢复与阅读入口。若某个只读判定依赖副作用，拆开这一具体依赖，不另建第二份就绪规则。

## LX4 读时辅助程序

**结果**：已完成，见 [LX2–LX6 验收](Linux阅读器-LX2-LX6进展.md) 与 [机器结果](Linux阅读器-LX2-LX6验收.json)。

**目标与触达**：验证 `crates/server/src/build_intent_api.rs::resolve_named_core_command/append_usage_event/artifacts`、`skills/build/intent-metrics.ts` 与前端 `recordIntentUsage/refreshIntentArtifacts` 在 Linux 源码部署下可用。

**输入 / 产出**：Node/tsx 路径、隔离私有目录、已就绪材料 -> `reader_ready` 事件持久记录、可读取的使用报告、已有 accepted 目标成果投影。

保留现有 TS 实现及所需源码依赖；普通阅读可以调用 `intent.metrics` 等确定性辅助程序，不调用 Executor、模型预构建任务或 Windows launcher。源码固定在编译与运行目录，systemd 中提供 Node 绝对路径，不依赖交互式 shell 初始化。

**验收与失败动作**：真实 Node 子进程执行一次事件写入和报告读取，断言持久记录内容；无目标成果时返回现有空投影，有成果时读取迁入副本。前端当前会吞掉统计失败，验收必须检查接口与磁盘结果。若路径或导入不兼容，只修复相应辅助调用；不以删除统计调用获得表面成功。

## LX5 数据迁入与路径重定位

**结果**：已完成，见 [LX2–LX6 验收](Linux阅读器-LX2-LX6进展.md) 与 [机器结果](Linux阅读器-LX2-LX6验收.json)。

**目标与触达**：围绕 `SessionState`、`session_dir_key/select_start_book`、`LibraryRegistry` 与现有记忆加载入口，提供一次性数据迁入操作说明和 `scripts/linux/relocate-reader-paths.mjs`，只操作显式选择的副本与已知路径字段。

```text
输入：完整书籍目录 + 私有数据副本 + 显式目录对应关系
      Windows 旧绝对目录 -> Linux 新绝对目录
输出：可在 Linux 恢复的当前书、每书 top_lid、外部书籍索引
      原有 book_id、LID、笔记内容、画像和聊天记录保持原义
```

重定位 `session.json.current_book_dir`、`session.json.books` 的目录键和 `library-registry.json.workspaces`；基于已知字段操作，不扫描全部 JSON 做字符串替换。不同旧目录映射到同一新目录时报告冲突，不覆盖一份进度。旧版本会话使用已有读取兼容路径，不新建迁移框架。

私有目标成果若需延续，应迁入 `UNDERSTAND_BOOK_PRIVATE_DIR` 对应目录；其消费路径发现确实需要重定位的字段时再明确补入映射。原始备份保持可回退，运行中的两个 Reader 不同时写同一份副本。

**验收与失败动作**：两本书保留不同 `top_lid`，其中一份目录包含中文和空格；迁入后验证笔记锚点、画像和聊天历史，停止并重启后恢复相同阅读位置。重复应用相同目录映射不追加或覆盖无关记录。若路径修正后仍加载失败，保留原数据定位具体字段，不能通过清空 session 或 memory 消除错误。

## LX6 常驻与有序停止

**结果**：已完成，见 [LX2–LX6 验收](Linux阅读器-LX2-LX6进展.md) 与 [机器结果](Linux阅读器-LX2-LX6验收.json)。

**目标与触达**：在 `crates/server/src/main.rs` 和 `host.rs::RunningServer` 接通 SIGINT/SIGTERM 的主线程停止通知，复用现有停止与已读账本冲刷；拟新增 `scripts/linux/start-reader.sh` 和 `scripts/linux/understand-book.service`。

```text
SIGINT / SIGTERM
  -> 主线程请求停止
  -> 服务不再接收新的工作
  -> 在途有界操作完成或保留既有可恢复中断状态
  -> 待持久已读账本冲刷
  -> 进程退出
```

Linux 信号接线使用相应平台代码，保留 Windows 的启动、关闭与持久化路径。信号处理只传递停止通知，阻塞等待和持久化由正常控制流执行。核对已有 Provider 请求超时与 worker 等待路径，让 unit 的 `TimeoutStopSec` 覆盖实际退出上界；不把 systemd 强制结束当成有序停止。

unit 明确工作目录、服务用户、环境文件与绝对启动路径，重启时使用同一份私有目录。Linux 启动脚本显式传入 LX2 的 `--reader-only`，使用 `exec` 交给 server，不残留阻断信号传递的中间 shell；服务账户对既有私有存储有实际读写权限。

**验收与失败动作**：启动、停止、重启各走真实进程；在已读事件尚待冲刷时发送 SIGTERM，重启后读回记录。再用可控延迟的 Provider 响应验证在途退出，并确认正常停止没有遗留 Node 辅助进程。若超时或记录丢失，定位等待/冲刷/子进程路径；不能单靠延长 systemd 强杀等待掩盖无上界等待。

## LX7 真实服务器验收与交付

**结果**：已完成，见 [LX7 验收](Linux阅读器-LX7验收.md)、[机器结果](Linux阅读器-LX7验收.json) 与 [部署说明](Linux阅读器部署.md)。

**目标与触达**：在第 1 节指定的真实 veLinux 服务器运行 LX6 的服务，按 §3.1 从 Windows 浏览器或 Playwright 经隧道访问。沿用 `packages/web/playwright` 中 PDF、Note、来源引用和 minimap 的交互场景，增加访问真实服务的入口；原有 fixture/mock 用例继续承担界面回归。补充 `scripts/linux/smoke-reader.mjs` 与 `docs/Linux阅读器部署.md`。

**验收场景**：

1. 同步一份完整 technical-learning 材料和一份 paper/PDF 材料，页面正常加载、切书、搜索、导航并打开图片/PDF。
2. 使用实际配置的 Provider 完成一次问答和一次带读，返回来源能定位真实正文，导航 effect 在页面体现；模型结论不以自评分验收。
3. PDF 选区翻译可用；保存高亮和 Note，观察私有持久记录，重启后恢复内容与位置。画像投影与聊天历史可以读回。
4. 实际读取 LX4 的统计记录；迁入既有目标成果时，确认对应投影可读。整个场景没有启动预构建任务。
5. 使用真实 systemd unit 完成有序停止与启动，确认服务用户、Node、源码目录、书库与私有数据配置一致。
6. 汇总各切片的 Windows 定向回归，使用 Windows 桌面与 `start.bat` 做最终受影响路径联验，确认阅读、预构建、配置入口及重启持久化保持有效。

**交付**：部署说明给出本机验证过的依赖准备命令、构建入口、环境文件示例、书籍/私有数据同步、SSH 隧道、systemd 管理和日志位置。验收记录写明源码版本、实际系统/工具链、用例结果与未解决问题，模型密钥和完整用户材料不写入记录。

**完成判据**：以上场景均有目标机器上的实际结果，待修问题归零；只有编译通过、仅有 Windows 回归或缺少真实 Provider 的结果时，保持“Linux 验收未完成”。

## 5. 检查与失败处理

| 检查 | 要发现的具体失败 | 失败后改变什么 |
|---|---|---|
| 原生构建与进程启动 | 工具版本、原生库、Linux 编译错误 | 修复环境或对应代码后再进入宿主适配 |
| 宿主/阅读入口回归 | 桌面误识别、构建副作用、缺失材料被误判可读 | 修正入口身份或复用的就绪分支 |
| 所属切片的 Windows 定向回归 | 原启动参数失效、`start.bat` 预构建被禁用、桌面设置或共享阅读/持久化路径退化 | 在当前切片修正共享改动与入口条件，通过后再推进下一片 |
| 真实辅助程序与文件读回 | 统计静默失败、源码路径失效、目标成果读不到 | 修正调用或迁入路径，不删功能 |
| 路径映射和重启 | 进度丢失、书籍错配、笔记/画像/历史未持久 | 修正已知字段映射或存储生命周期 |
| systemd 停止与在途操作 | 信号未到服务、待持久记录丢失、进程未退出 | 修正信号、等待和冲刷路径 |
| 真实浏览器与 Provider | 静态/API 可用但交互、引用或模型调用失败 | 在发生失败的界面或运行链路修复 |

按切片运行相关测试与实际入口；没有新改动或失败线索时不重复整仓审计。文件比较直接比较内容，沿用已有标识，不为本方案生成额外校验和清单。

## 6. 已知限制

- 单个服务实例对应一个读者，共享当前书、阅读状态和 Agent 会话；默认通过 SSH 隧道访问 loopback。公开网络访问入口需另行明确，当前没有应用层登录体系。
- 首轮覆盖所提供的 veLinux/CentOS 9 x86_64 服务器；其他发行版与架构尚无验收承诺。LX0–LX7 的原生构建、宿主与完整阅读场景已通过。
- 当前 Linux 方案消费已就绪材料；预构建执行和插件发行继续使用现有环境。首版保留完整目录中的就绪元数据。
- 首版运行依赖固定源码目录与 Node/tsx；移动部署目录后重新构建。同步数据采用停服操作，不提供双机同时写入或自动合并。
- [ADR-0120](adr/0120-whole-source-prebuild-gate-for-formal-learning.md) 的正式学习门槛继续有效，本方案不将尚在设计中的教学能力计入已实现功能。
- LX2–LX6 已完成，见 [实施与验收](Linux阅读器-LX2-LX6进展.md)。宿主、只读就绪、统计、迁入与有序停止/重启通过；真实 Provider、完整阅读交互和 Windows 最终联验已在 [LX7](Linux阅读器-LX7验收.md) 通过。
