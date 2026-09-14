# BookStructure 证据资料包交付记录 — 2026-09-12

决策：[ADR-0124](../adr/0124-book-structure-evidence-packets-and-cross-unit-relations.md)。用户确认“允许跨章理解，明确证据用途”，要求落 ADR、修改代码并重建插件。

## 完成

- [x] 章节图谱只收集两端均有本章锚点的关系，裁剪共享节点的外章 occurrences。
- [x] 辅助分片附带端点映射和相关原文；共享 occurrence 优先，否则每端携带一个真实摘录，避免单条关系展开整章。
- [x] renderer、描述符与 writer 从同一份实际交付内容派生 reference_scope；单元身份、正文引用、依赖目标分开。
- [x] 章节任务产出本章内容；跨章依赖由同时具备两端资料的 stitch 判断。缺少关系依据在路由阶段阻断。
- [x] 跨界 stitch 分片携带另一端卡片与 Pass2 证据摘录；writer-owned reference_scope/context_units 保留各级减并需要的证据归属与另一端内容，不是模型输出字段。
- [x] 本章摘要限制本章证据；主题线证据覆盖声明的各单元/段落；依赖只能指向有可用内容的其他单元。
- [x] 六类 BookStructure 生成策略升至 v4；更新五份语义提示，保留现有 Executor 外层协议。
- [x] 重建 Build Engine，复制到注册表指向的安装目录，更新本地市场并重新安装插件。

## 验证

- 新增 10 项证据机制测试。初始用例复现 5 项行为失败；修复后覆盖本章归属、引用用途、关系分片完整性、跨章通过/拒绝、缺失材料的路由阻断，以及落盘读取后继续减并；补充空证据摘要的红绿测试，防止用空数组绕过引用要求。
- 77 项相关测试分批通过：证据 10、结构路由 8、结构 helper/gate 8、orchestrator 16、模型输入渲染 4、生产提示契约 6、可选 Pass2 1、Executor 发布契约 24。发布契约因两个 manifest 更新时刻不同曾失败，同步后该项单独重跑通过。
- Core TypeScript 类型检查通过；插件结构验证、发布源契约、限定改动文件的 diff whitespace 检查通过。
- 真实 Mastering Rust 基座包含 4,192 个 LID、2,999 个图谱节点、2,797 条关系。178 个结构单元全部可路由，生成 292 个工作单元，阻断数 0。这是确定性资料组装/预算检查，不是模型生成完成数。
- 原失败分片包含 89 条关系；修复后第 4 单元完整输入包含 11 个图谱节点、5 条本地关系，可以走 whole 路径。原来失败的混合分片不再产生。
- 在隔离目录冻结真实第 4 单元，通过编译 EXE 和已安装 EXE 的 `book-structure-input --shadow-generation` 接口读取，均得到新 reference_scope 和本地 5 条关系；两者的打包提示均包含新引用契约。
- 源插件、本地市场、已安装缓存的 10 个文件逐字节一致；编译 EXE 与安装 EXE 逐字节一致。没有新增校验和文件。

## 安装定位

- 插件：`understand-book@understand-book-local`
- 版本：`0.1.0+codex.20260912013803`
- 缓存：`C:/Users/Lenovo/.codex/plugins/cache/understand-book-local/understand-book/0.1.0+codex.20260912013803`
- 日常 Build Engine：`E:/allwork/Understand Book/understand-book-build.exe`，105,705,472 字节。
- 旧引擎保留为：`E:/allwork/Understand Book/understand-book-build.exe.before-evidence-20260912013803`。
- 原书工作区：`E:/allwork/download/agent/lifebook/.understand-book/mastering-rust`，本轮验证未修改。

复现脚本及机器结果在 `tmp/book-structure-evidence-20260912/`：`verify-real.ts`、`prepare-compiled.ts`、`verify-compiled.cjs`、`real-routing.json`、`all-unit-routing.json`、`compiled-build.json`、`compiled-installed.json`、`installation.json`。

## 已知问题与验证边界

没有启动原书的完整模型生成，也没有把已完成的上游产物或旧失败收据改写成成功。v4 策略会使受影响的旧 BookStructure 结果重新生成，不能承诺先前 83 份结构提交都继续复用。

附加验证把原书的规范化 `source.txt` 复制为 Markdown，再走不带 `--shadow-generation` 的旧全文输入命令时，Markdown 解析器报 `Markdown parser node lacks a valid source position: text`（`nodeSpan → collectDisplaySegments → parseMarkdownSourceBlocks → loadBookWindows`）。该路径未修复；本轮源码没有修改 Markdown 解析器。冻结资料输入接口在编译与安装版本上均通过，不代表已验证原书从头重建。

本轮没有修复先前间歇性的 Executor bootstrap_unavailable。插件和 EXE 已落盘，但现有 Codex 进程不会自动丢弃全部已加载状态；重启 Codex 后在新任务中使用新插件。仅在原任务反复回复“重试”不能修复旧策略的失败状态。
