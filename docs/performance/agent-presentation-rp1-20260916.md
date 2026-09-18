# RP1 预览执行验证

状态：RP1 完成，2026-09-16；Runtime 端口、Windows/Tauri 与 Linux 单用户宿主均已实际验证。

## 实现与执行合同

`runtime::presentation_preview::PresentationPreviewPort::preview(request, cancellation)` 执行一次有界排练。输入为候选身份、自包含 HTML/CSS/JavaScript 和顺序操作；输出包含浏览器版本、初始及每步页面文字/控件值/元素矩形、真实布局指标、PNG 截图和浏览器异常事件。操作支持选择器点击与焦点控件上的方向键、Home、End、Enter、Tab。页面脚本错误保留为候选的执行反馈；端口失败返回候选身份、阶段与具体错误。

`server::presentation_preview::BrowserPreview` 使用独立 Edge/Chromium 进程和临时 profile，经 CDP 执行。候选没有 Reader URL、Tauri IPC 或用户浏览器 profile，网络资源请求被阻断；内联样式、脚本、Canvas、SVG 与 data 资源可用。浏览器进程不依赖 Reader 客户端连接。

默认一次排练 30 秒、960×720 视口、最多 16 个操作、HTML 最大 2 MiB。每次观察等待两次真实渲染帧；截图由浏览器协议取得。返回值表示观察事实，不包含页面自报的成功判定。当前批次结束即停止进程，不保留交互会话；下一次修正可重跑候选。

取消接收既有 `RunContext` 的 `CancellationToken`，包括 host-stop。正常结束、错误、超时与取消均执行停止和 profile 清理；清理失败返回明确错误。Windows 结束该预览的进程树并等待根进程退出；Linux 使用独立进程组，并将 XDG 配置/缓存纳入同一临时目录。Linux 探针将 SIGINT/SIGTERM 转为取消令牌。RP4 再将端口接入 Resident 工具发现、预算与活动。

协议参考：[Page.captureScreenshot / 布局](https://chromedevtools.github.io/devtools-protocol/tot/Page/)、[实际输入事件](https://chromedevtools.github.io/devtools-protocol/tot/Input/)。

## 部署与复跑

- Rust Server 内包含执行适配器，新增 `tungstenite` 与 `tempfile` 构建依赖；运行不要求 Node、Playwright 或独立辅助程序。
- Windows 自动发现系统或用户安装的 Microsoft Edge。WebView2 Runtime 不等同于完整 Edge 浏览器；缺少浏览器时返回 `discovery` 错误。可用 `UNDERSTAND_BOOK_PREVIEW_BROWSER` 指定已安装 Chromium/Edge 的绝对路径。
- Linux 自动查找 `/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/bin/google-chrome`，也支持上述环境变量。目标 veLinux/CentOS Stream 9 已通过现有 EPEL 仓库 `dnf install chromium` 安装浏览器及运行库，以 Reader 专用非 root 用户执行并保留浏览器沙箱；不要求服务账户的主目录可写。
- Server 与桌面入口均提供 `--presentation-preview-probe`：stdin 读取 `PreviewRequest`，stdout 输出 report/error JSON，失败退出码为 1。无需打开书籍、访问 Provider 或修改私人数据。
- Windows 验证使用 `apps/desktop/src-tauri/examples/presentation-preview-host.rs` 包含真实桌面 `main.rs`；独立产物避免替换正在运行的日常 Reader。与桌面 bin 共用 Tauri 生成的 Windows manifest。

标准构建及验证：

```text
cargo test -p server --test presentation_preview -- --include-ignored --test-threads=1
cargo build -p understand-book-desktop --example presentation-preview-host
node scripts/validate-presentation-preview.mjs target/debug/examples/presentation-preview-host.exe tmp/rp1/windows-desktop

# Linux：在最终部署目录按现有源码部署流程安装依赖并构建，以服务账户运行
cargo build -p server --bin server
node scripts/validate-presentation-preview.mjs target/debug/server tmp/rp1/linux-host
python3 scripts/validate-presentation-preview-stop.py target/debug/server tmp/rp1/linux-host
```

验收脚本中的 Node 仅负责调用宿主、断言和保存证据，不参与产品预览执行。

## Windows 运行证据

- Windows、Edge `152.0.4191.66`，2026-09-16。最终 Tauri 实际入口六步排练耗时 4,499 ms；[观察报告](rp1-windows/report.json)，[初始截图](rp1-windows/step-0.png)，[补齐证据截图](rp1-windows/step-2.png)。原始请求、含截图的原始回执与全部 PNG 位于 `tmp/rp1/windows-desktop`。
- 初始 2/3，加入无关材料后仍为 2/3；补齐第三处为 1；真实滑块点击、End 与 ArrowLeft 后回到 2/3。报告中 Canvas 矩形为 360×120，960 像素视口；截图显示图形随数值改变。视觉检查修正了样例未随参数更新的说明文字，并重新通过宿主入口断言。
- 5 项 Rust 定向测试全部通过：图形与真实输入、脚本异常及无效操作的候选归属、Reader/网络隔离、调用前取消、死循环中的 host-stop 及执行超时。
- 验收脚本确认无新增残留 profile；测试后读取实际进程列表确认无本次预览 Edge 残留。
- 首次执行发现握手阶段读超时太短，以及 taskkill 返回时根进程尚在退出；分别为握手设置独立等待、等待所拥有进程实际退出后清理。Tauri example 首次缺少 bin 专用 manifest，补上同一资源链接后入口通过。
- 本机 Cargo 普通测试命令编译关联 bin 时出现 `LNK1140`；系统盘剩余约 170 MiB。初期单独关闭测试产物的调试数据库并运行已生成测试程序；最终在本次命令环境设 `_LINK_=/DEBUG:NONE /PDB:NONE`，正常 `cargo test -p server --test presentation_preview -- --include-ignored --test-threads=1` 完整通过，桌面 example 同样构建通过。临时目录为 `tmp/rp1-os-temp`。未更改项目构建 profile，未删除其他任务数据。环境变量优先级见 [MSVC 文档](https://learn.microsoft.com/en-us/cpp/build/reference/linking?view=msvc-170#link-environment-variables)。

## Linux 运行证据

- 原验收服务器 `115.190.121.150`，CentOS Stream 9 / veLinux 内核 `5.15.120-5.ve2.x86_64`，系统仓库 Chromium `138.0.7204.49-1.el9`。隔离源码与构建位于 `/opt/understand-book/acceptance/rp1-20260916/source`；未替换或重启日常 Reader 服务。
- 使用原源码部署工具链原生构建。依赖索引访问迟滞时将本机缓存中的 13 个缺失 crate 与对应索引同步到已有 Cargo 缓存，随后 `cargo test --offline --locked -p server --test presentation_preview --no-run -j 2` 通过。构建关闭 dev/test 调试信息，执行适配器保留在 Server 中。
- 以现有 `understand-book` 服务账户运行最终 **6 项测试全部通过**，耗时 7.13 秒；包括另外的浏览器启动 stderr 回执验证。[测试日志](rp1-linux/tests.txt)。
- 同一 HTML、同一六步操作经实际 Server 入口完成，耗时 **1,125 ms**。[观察报告](rp1-linux/report.json)、[初始截图](rp1-linux/step-0.png)、[补齐证据截图](rp1-linux/step-2.png)。实际截图显示中文、控件和 Canvas，数值、参数及图形一致。
- 对死循环页面的真实 Server 探针进程发送 SIGTERM，**2,129 ms** 返回候选 `rp1-host-stop` / `load` / `AGENT_RUN_CANCELLED`，退出码 1；实际进程列表无剩余预览浏览器，profile 已清理。[停止回执](rp1-linux/host-stop.json)。
- 首轮真实测试发现服务账户主目录不可写导致 Crashpad `--database is required` 并 SIGTRAP。为浏览器单独指定临时 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` 后通过；启动失败回执增加最多 4 KiB 实际 stderr。原失败日志与安装日志保留在远端验收目录。

## 已知限制

- Linux 验收范围为上述现有单用户服务账户与发行版，源码部署需要可用的系统 Chromium/Edge 浏览器。
- Windows：已验证真实 Tauri 源码入口与系统 Edge 发现；未制作或安装新的 NSIS 包，未替换日常 Reader。浏览器缺失时需要用户安装完整 Edge/Chromium。
- RP1 仅接收自包含单页；外部资源、多文件内容、来源绑定、版本持久化、回答挂载及 Agent 制作工具属于后续切片。
- 预览页面与未来 Reader 呈现区域的布局、样式和语义一致性仍需 RP3/RP7 验证；运行和算例通过不代表教学效果通过。

下一步：按 RP2 定义内容版本、Reader 私有存储及候选/交付引用；后续 RP4 使用本端口执行候选排练。
