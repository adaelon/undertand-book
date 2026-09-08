# Linux 阅读器源码部署

面向一个读者的自有服务器。Linux 消费完整、已就绪的书籍工作目录，保留正文/PDF、读时 Agent、笔记、高亮、画像和聊天历史。预构建在现有 Windows/Codex 环境完成。

验收环境为 veLinux 2.2 CentOS Compat / CentOS Stream 9、x86_64、glibc 2.34、systemd 252。实际工具链：Node 24.20.0、pnpm 10.34.2、Rust/Cargo 1.98.1。结果与已知问题见 [LX7 验收](Linux阅读器-LX7验收.md)，前序证据见 [LX1](Linux阅读器-LX1验收.md)、[LX2–LX6](Linux阅读器-LX2-LX6进展.md)。

## 目录与依赖

```text
/opt/understand-book/
  source/                 源码、node_modules、packages/web/dist、target/release/server
  tools/                  项目独立工具链
  books/                  完整书籍工作目录
  data/memory/            memory.json、session.json、agent-history.json 等
  data/private/           使用统计、既有目标成果
  reader.env              服务环境及 Provider 配置
  acceptance/             实机验收日志与源码快照
```

目标机器已具备 GCC、链接器及 OpenSSL 开发包，本次复用。缺少原生依赖的新 EL9 机器可先安装 `gcc gcc-c++ make pkgconf-pkg-config openssl-devel`；安装命令本身未在本次机器重复执行。工具准备脚本和官方发行包安装记录位于目标机器 `acceptance/lx1/prepare-tools.sh`、`resume-rust.sh`。

在当前已准备的机器上，使用以下实际运行过的环境与构建入口：

```bash
source /opt/understand-book/acceptance/lx1/env.sh
cd /opt/understand-book/source
node --version
pnpm --version
rustc --version
cargo --version
pnpm install --frozen-lockfile
pnpm -C packages/web build
cargo build --locked --release -p server --bin server -j 1
```

本机 Cargo 网络索引较慢，验收使用了与锁文件匹配的 crate 缓存，并以 `cargo build --offline --locked --release -p server --bin server -j 1` 完成原生构建。离线命令要求缓存齐全；缓存准备的实际经过见 LX1。源码必须在最终运行目录编译，运行时继续保留源码与 Node/tsx 依赖。

## 按 Git 提交更新

LA/LX 合并版本采用独立发布目录：Git 仓库保留在 `/opt/understand-book/repository`，每个待部署提交检出到 `/opt/understand-book/releases/<完整提交号>`。在该最终路径安装依赖、编译 Web 与 release server，再更新阅读器的 systemd 覆盖配置。运行时继续保留这个路径中的源码与 Node/tsx。

原 `/opt/understand-book/source`、其二进制和 lx6 私有数据保留。更新仅切换 `understand-book.service` 的工作目录、启动脚本和 Web dist；书库、模型配置、memory/private 目录及 Nginx 入口沿用。构建失败不切换；切换后检查原站点 200、阅读器认证 API、当前书及持久状态。已运行版本可在 release 目录执行 `git rev-parse HEAD` 查看。

## 材料与私有数据

将完整书籍目录放入 `books/<book-id>`，包含隐藏 `.build`、正文、`base.json`、来源 manifest、图片、PDF、映射分片及该 profile 所需的就绪报告。带读还需要已有的全书结构与路线产物。`quickstart-demo` 可演示问答、来源和笔记；完整带读验收使用 `quantification-essence`。

材料更新采用停服、同步、启动的顺序。材料由服务账户读取，书库根和书库索引需要可写；`data/memory` 与 `data/private` 归该账户所有。不要把 Windows 日常私有数据与远端实例同时指向同一存储。迁移已存在的阅读状态时，按 [数据迁入说明](Linux阅读器数据迁入.md) 复制私有目录并运行路径重定位工具；不要批量替换正文或成果文件中的字符串。

验收常驻实例使用独立的 `/opt/understand-book/data/lx6/{memory,private}`，并保留新增测试笔记和会话。目录名中的 lx6 不限制功能；后续正常部署可选择自己的持久目录。

## Provider 与服务

以 [reader.env.example](../scripts/linux/reader.env.example) 为模板填写 `/opt/understand-book/reader.env`。所有目录使用绝对路径，模型配置填写实际值：

```ini
UNDERSTAND_BOOK_DIR=/opt/understand-book/books/quantification-essence
UNDERSTAND_BOOK_LIBRARY_ROOT=/opt/understand-book/books
UNDERSTAND_BOOK_MEMORY_DIR=/opt/understand-book/data/memory
UNDERSTAND_BOOK_PRIVATE_DIR=/opt/understand-book/data/private
UNDERSTAND_BOOK_ADDR=127.0.0.1:8787
UNDERSTAND_BOOK_WEB_DIST=/opt/understand-book/source/packages/web/dist
UNDERSTAND_BOOK_NODE=/opt/understand-book/tools/node-v24.20.0-linux-x64/bin/node
UNDERSTAND_BOOK_PROVIDER=native
OPENCODE_BASE_URL=https://api.deepseek.com
FLUID_LLM_MODEL=deepseek-v4-flash
OPENCODE_API_KEY=<填写实际密钥>
```

LX7 沿用工作机已经配置的 DeepSeek Provider，密钥仅写入远端服务环境文件，未写入验收报告。systemd 的环境文件不是 shell 脚本；含空格等字符的值使用双引号。

专用账户与 service unit 已在目标机器安装。首次安装时创建 `understand-book` 系统账户，并赋予上述读取、持久目录写入权限；然后执行：

```bash
chmod 600 /opt/understand-book/reader.env
install -m 644 /opt/understand-book/source/scripts/linux/understand-book.service /etc/systemd/system/understand-book.service
systemctl daemon-reload
systemctl enable --now understand-book
systemctl status understand-book --no-pager
```

启动脚本 [start-reader.sh](../scripts/linux/start-reader.sh) 用 `exec` 启动 `server --reader-only`。服务运行用户为 `understand-book`，不会依赖 root 登录 shell 的 PATH。修改环境文件后重启：

```bash
systemctl restart understand-book
journalctl -u understand-book -n 100 --no-pager
journalctl -u understand-book -f
```

停服用 `systemctl stop understand-book`。SIGTERM/SIGINT 通知主进程停止接单、结束在途工作并冲刷待持久阅读记录。已有 Provider 请求有时间上限，停服可能需要等待其完成；unit 使用 `KillMode=mixed` 和 180 秒停止期限。

## 浏览器访问

在 Windows 保持 SSH 隧道连接；`reader-linux` 是自行配置的 SSH Host 别名：

```powershell
ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 reader-linux
```

打开 `http://127.0.0.1:18787`，浏览器页面及 `/api` 均由 Linux 服务提供。页面可以切书、搜索目录、定位正文和使用阅读助手。纯阅读入口隐藏桌面设置和预构建操作；Provider 通过服务环境管理。

首次打开论文时先显示正文/PDF 和已有地图；地图中文标签在后台翻译，同一张地图的在途请求会复用。翻译失败时保留现有标签，不影响正文。PDF 选中文本后可直接翻译、添加高亮或笔记。

## 公网访问（2026-09-08 增补）

- 原程序：`http://115.190.121.150/`，原站点配置保持。
- 阅读器配置地址：`http://115.190.121.150:8080/`，用户名 `reader`，密码已单独交付且保持不变。
- 当前状态：用户完成端口设置后，公网匿名请求返回 401，登录后的 `/api/desktop/status` 返回 200；IP:8080 已连通，登录信息保持。

Nginx 独立监听 8080，转发整站页面和 `/api` 到 `127.0.0.1:8787`。原 IP 的 80 端口、原程序及阅读器进程保持运行。此前独立域名曾在验收网络可访问，但用户反馈实际网络存在备案拦截，该域名入口已撤下，不作为交付地址。

配置模板见 [nginx-reader.conf.example](../scripts/linux/nginx-reader.conf.example)。实际配置为 `/etc/nginx/conf.d/understand-book-reader.conf`，认证文件为 `/etc/nginx/understand-book-reader.htpasswd`（root:nginx，0640）。长 Agent 请求使用 600 秒代理读取期限。修改后运行 `nginx -t && systemctl reload nginx`，无需停止原程序。

云控制台需核对绑定实例的安全组，添加或确认：入方向、允许、TCP、目标端口 8080、源地址按读者访问范围设置。任意网络访问可用 `0.0.0.0/0`；已有固定出口可限定为对应公网 IP。见 [火山引擎安全组说明](https://www.volcengine.com/docs/6396/68802?lang=zh)。端口连通性与云平台网站接入要求分别核对，不承诺更换端口会免除平台要求。

机内匿名请求返回 401；原站点返回 200；Nginx 主 PID 823574、Reader PID 3425481 保持不变；此前外部连接超时证据见 `tmp/linux-public/ip-entry.json`；端口设置完成后的公网 401/200 已重新实测。此前 `browser.json` 与远端 `public-entry-final.json` 仅证明旧域名在当时测试网络的结果，已被本次用户反馈及入口变更取代。

入口日志为 `/var/log/nginx/understand-book-reader.{access,error}.log`。当前入口使用 HTTP，登录保护不提供传输加密；既有 SSH 隧道仍可使用。

## 实机复验

[smoke-reader.mjs](../scripts/linux/smoke-reader.mjs) 使用 Playwright 访问已运行的正式服务，不启动开发服务器，也不模拟后端。需要本地项目已安装 Playwright 与 Chromium。使用隔离的验收私有目录运行，因为用例会创建真实对话、笔记、高亮并消费 Provider 额度。

```powershell
$env:READER_URL='http://127.0.0.1:18787'
$env:READER_TECHNICAL_DIR='/opt/understand-book/books/quantification-essence'
$env:READER_PAPER_DIR='/opt/understand-book/books/understanding-transformer-from-the-perspective-of-associative-memory'
$env:READER_EVIDENCE_DIR='tmp/linux-reader-smoke'
node scripts/linux/smoke-reader.mjs guided
node scripts/linux/smoke-reader.mjs pdf
```

`technical` 会执行问答、来源与带读的完整技术材料场景；`qa` 和 `guided` 分别单独执行问答与带读。可用 `READER_QUESTION` 设置与所选材料对应的问题，例如“本文怎样区分买方量化和卖方量化？请读取原文，用两句话回答，并给出可点击来源。”`images` 需要 `READER_IMAGE_DIR` 指向包含已打包图片的完整书；`artifacts` 需要 `READER_ARTIFACT_DIR` 及证据目录内的 Windows 基准 `accepted-windows.json`。

PDF 阶段通过后，停止服务并观察 memory/session 磁盘记录，再启动服务，执行 `node scripts/linux/smoke-reader.mjs restore`。该阶段验证原书、位置、高亮、Note、画像和技术材料带读历史。脚本的 PDF 保存阶段使用真实浏览器选区和 UI 保存入口。

## 已知限制

- 单实例对应一个读者，共享当前书和会话；公网入口的一个登录账户仍对应同一读者，不提供多用户隔离。
- 显式带读使用项目冻结的表达，例如“带我读”“带着我读”“guide me through”。“带我阅读”未命中现有短语表；这次实测已记录，LX7 沿用既有分类契约。
- 源材料中标为 `external` 的图片仍依赖外部地址；迁入不会自动下载它们。需要离线图片时，在预构建端准备 `available` 的打包资源。本次图片验收使用 `ai-agent-engineering` 的已有本地 SVG。
- 本次环境之外的发行版、架构和独立安装包未验收。移动源码路径后需重新编译。
