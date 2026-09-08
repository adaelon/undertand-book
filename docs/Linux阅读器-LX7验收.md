# Linux 阅读器 LX7 验收

状态：完成，2026-09-08。沿用 ADR-0122，LX0–LX7 已完成。机器可读结果见 [验收 JSON](Linux阅读器-LX7验收.json)，运行方式见 [源码部署说明](Linux阅读器部署.md)。

## 环境与源码范围

- 目标为 `115.190.121.150`，veLinux 2.2 CentOS Compat / CentOS Stream 9 x86_64，glibc 2.34、systemd 252；Node 24.20.0、pnpm 10.34.2、Rust/Cargo 1.98.1。
- `understand-book.service` 已启用，专用账户 `understand-book`，监听 `127.0.0.1:8787`。源码和正式 dist 位于 `/opt/understand-book/source`；书库为 `/opt/understand-book/books`，独立私有数据为 `/opt/understand-book/data/lx6/{memory,private}`。
- 真实 Provider 为 native / DeepSeek / `deepseek-v4-flash`。模型密钥仅在服务环境文件中，报告不包含凭据。
- 基于 commit `9e365075c99c9627959f2d9a03f987912c8c7a95` 的未提交工作树；测试期间工作区另有 LA 系列并行修改。验收对应部署快照和本次实际 Windows 构建，不把后续本地修改计作已验收。
- 冻结的实机源码及正式 dist：`/opt/understand-book/acceptance/lx7/source-final.tar.gz`，871 文件的路径清单为同目录 `source-files.json`；本地 `tmp/lx7` 保留相同副本。

## 真实场景结果

| 场景 | 实际结果 | 原始证据（本地 tmp/lx7） |
|---|---|---|
| 技术材料与论文 | 完整 quantification-essence 和 paper/PDF 加载、目录搜索、切书与导航通过 | qa.json、guided.json、pdf.json |
| 问答与来源 | 真实模型回答买方/卖方量化问题；点击来源打开对应原文 | qa.json、qa-answer.json、qa.png |
| 带读 | 真实导航 effect 改变阅读位置到 `1.3.7`，页面显示返回位置入口 | guided.json、guided-answer.json、guided.png |
| PDF 翻译 | 真实选区解析到 `1.1` 的 2–51 字符范围，Provider 返回中文，页面显示翻译 | pdf.json、pdf-translation.png |
| PDF 高亮与 Note | 真实 UI 保存并重新打开笔记，磁盘和新进程读回一致 | pdf.json、pdf.png、lifecycle.json、restore.json |
| 打包图片 | ai-agent-engineering 的现有 available SVG 在 Linux 页面实际加载 | images.json、images.png |
| 统计与成果 | Node 辅助程序的 usage 返回非零事件；accepted 投影与 Windows 副本逐字段一致，v3 表格行可见 | qa.json、artifacts.json、artifacts.png |
| 画像、历史、位置 | 显式保存测试画像偏好；新进程恢复相同论文位置、画像事实、PDF 批注与带读历史 | lifecycle.json、restore.json |
| systemd | 旧 PID 3423159 在 0.086 秒内退出；停服检查磁盘后，新 PID 3425481 恢复 | lifecycle.json |
| Windows Tauri | 真实 WebView 的阅读、原生 Provider 设置、创建论文与构建方案入口通过；关闭旧进程后，无参数新进程恢复书和 Note | desktop-initial.json、desktop-restore.json |
| 原始 start.bat | 实际两次启动，旧服务被替换；阅读、构建方案入口、Note 恢复与 v3 成果显示通过 | startbat-initial.json、startbat-restore.json、windows-artifact.json |

全部 12 个阶段结果为 passed。技术材料、图片、成果和恢复阶段的浏览器监听未见预构建请求或页面异常；Linux 仅消费既有材料与迁入成果。成果验收使用从既有 Rust 测试私有目录复制的 accepted 副本及其配套 source/base，不代表在 Linux 执行了预构建。

PDF 翻译、高亮和保存均通过真实 UI 完成。修正验收脚本的 Note 接口与异步等待条件后，最后一次确认接续已保存记录，重新打开 PDF 验证内容；`pdf.json` 明记 `completed_from_saved_record`。失败过程保留，不把脚本选择器错误包装为产品修复。

## 修复的四个实际问题

1. **桌面自动端口被 WebView 拒绝。** 实际端口 1719 出现 `ERR_UNSAFE_PORT`。`host::bind_host_http` 在 49152–65535 中直接绑定可用 socket，再交给 HTTP 服务。回归先红后绿，真实桌面重启通过。
2. **带读导航目标不能继续读取。** `book.guided_route_from` 返回的合法目标未进入 locator 账本，下一次 `book.text` 被 `LID_PROVENANCE_REQUIRED` 拦截。登记 guide-path 与各导航结果的声明字段，正文证据仍由实际读取产生。定向红绿测试与完整材料真实带读通过。
3. **地图标签翻译阻塞 Reader。** 冷启动论文的中文标签翻译持有 Reader 状态锁。现在先快照所需数据，释放锁再调用 Provider；缓存短锁读合并写。前端后台更新并复用同地图在途请求。锁回归先红后绿，真实 PDF 加载与翻译通过。
4. **v3 成果有表头但无数据。** 迁入投影为 `artifact_instance.v3`，前端只识别 v2。补全 v3 类型和判别后，复用 records/relations 显示路径。五种通用形态和四种预设的 v3 测试先红后绿，两端正式页面显示数据行。

## 回归与构建

- Windows：Runtime 301 passed / 3 项既有手动测试忽略，server 239 passed；相关 Web 5 文件 19 项，加成果组件 7 项，共 26 项；正式 Web 构建与实际 Tauri debug 构建通过。
- Linux：新增导航账本、Reader 锁释放测试各 1 项通过；最终 Web 39 文件 219 项通过；release server 与正式 Web dist 构建通过。
- Linux 首次锁测试因缺少实际论文夹具失败，补齐原材料副本后通过。LX1、LX2–LX6 的原生构建、只读就绪与停止结果继续保留，未重复无关整仓测试。
- 原始日志、截图、失败记录和验收脚本位于本地 `tmp/lx7` 与远端 `/opt/understand-book/acceptance/lx7`。源码路径清单用于说明测试范围，不新增校验和机制。

## 已知限制

- 单实例单读者，通过 SSH 隧道访问；其他发行版、架构和独立安装包未验收。移动源码目录后需重新构建。
- `turn_intent_classifier.v1` 的显式带读表达按现有冻结契约，例如“带我读”。“带我阅读”未命中，首次结果单独保留。
- 原材料中的 external 图片仍依赖外部网络；已打包 SVG 单独通过。quickstart-demo 缺少全书结构，完整带读使用 quantification-essence。
- 补测时一次客户端工作区加载超过等待期限；同一服务保持健康，另开页面及后续完整场景通过。保留 `qa-page-load-failure.json`，脚本记录失败时未完成的网络请求，未据此添加产品超时或自动重试。
- 常驻服务保留本次隔离测试笔记、画像和会话；本地并行 LA 改动不在此次冻结部署验收范围内。


## LA/LX 合并提交验证

用户要求将 LA1–LA10 与 LX0–LX7 合并为一个提交并推送，再同步 Linux。合并验证仅导出 Git 暂存内容，排除 V1、插件更新和其他未提交实现，复用既有依赖与原书夹具。

- 独立导出版本：Runtime 318 passed / 3 既有 ignored、Server 241、MCP/CLI 6、评测器 28、迁入脚本 3；正式 Web 构建通过。
- Web 36 文件 201 项先通过；另外 3 文件受临时目录外的 PDF worker 依赖访问限制，临时测试配置允许既有依赖目录后 18 项通过，合计 39 文件 219 项。产品配置未改动。
- 验证日志保留在 `tmp/lax-commit`；此前各阶段真模成绩保持原快照口径，不合并为新模型成绩。
- 公网 IP:8080 经用户完成端口设置后，匿名返回 401、登录 API 返回 200；现有 IP:80 程序保持。
