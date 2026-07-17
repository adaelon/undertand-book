# SESSION_CHECKPOINT - 2026-07-17 18:51 +08:00

## 新鲜度自检
- 写入时最新 commit：`1238678 docs(core): record canonicalization validation`。
- 冷启动先运行 `git log -3 --oneline` 与 `git status --short`；若不一致，以 Git 和磁盘现状为准。
- 当前目标“确定性清理论文图注重复 div 并交付安装包”已完成。

## 问题与结果
- 根因：source reconciliation 比较时剥离 raw HTML，却把 raw `paper.md` 原样写回；LLM 只分析 unresolved，无法覆盖格式等价项。
- `canonicalizePaperMarkdown` 只解包完整行、单根、安全居中 div 链中的纯文本；图片、表格、混合子标签、未知 HTML 原样保留。
- canonical Markdown 现在统一承担 reconciliation block/span、LLM evidence、review draft 和人工决定基准；trusted source 再执行既有 safe repair。
- 原始 `paper.md` 保持 draft/provenance，不被覆盖；新 report 记录 `canonicalization.presentation_html_unwrap`。
- Workbench config 已从 `source_reconciliation_v4` 升至 v5；旧 report/decision surface 会 stale，重跑后恢复。

## 真实论文验收
- 固定输入：`.understand-book/understanding-transformer-from-the-perspective-of/{paper.md,paper.pdf}`，仅复制到临时 workspace。
- 27 个真实重复文本 div 全部清零；早先“29”误含两张带多个居中单元格的 HTML table，table 按设计未改。
- 19 个图片 wrapper 逐行保持不变；27 个 repair 的内容比较签名逐项一致。
- 新 `review-draft.md`、121 个 unresolved/LLM evidence 均无重复 div；Figure 3 变为纯 Markdown 图注。
- report 记录 `presentation_html_unwrap=27`；unresolved 从上个修复基线 122 降至 121。

## 已完成切片
1. `59231aa`：定义 Paper Markdown canonicalization 与 ADR-0081。
2. `a57e95e`：实现结构化、安全边界明确的纯函数及红绿测试。
3. `ac98fb6`：统一 canonical span/review/source 数据流与人工决定基准。
4. `5f6dea4`：配置 fingerprint 升 v5，旧 v4 report 必须 stale。
5. `004cc4c`：新报告增加向后兼容的 canonicalization 审计计数。
6. `4ea1df6`：编译 sidecar smoke 锁定最终 `source.txt` 不含 div。
7. `1238678`：记录真实论文、全量回归与 Setup 验收。

## 验证结果
- Core：39 files / 241 tests；typecheck 通过。
- Server：156 tests；v4 stale 定向测试 1/1。
- 编译 sidecar：132 modules；旧 binary 红灯、新 binary canonicalization smoke 通过。
- 正式 Web/Rust/NSIS package：通过；Web 1913 modules。
- Setup：`dist/UnderstandBookSetup.exe`，35,309,683 bytes，SHA-256 `98BBB254177874D96104C509771B1B813FB58EC72A7ED29CE390151FDBDC0293`；与原始 NSIS bundle 字节一致。
- `git diff --check`：通过。全文件 rustfmt check 仍命中任务前 `host.rs/server lib.rs` 格式债务，本次新增测试行已按 rustfmt 建议对齐。

## 下一步（可直接接手）
1. 运行 `dist\UnderstandBookSetup.exe` 更新安装版并重启 Reader。
2. 打开 Transformer 论文 Workbench；旧 v4 report 显示 stale 属预期。
3. 创建/启动 `source_reconciliation` job，让 manifest config 刷新到 v5 并生成新 report/review draft。
4. 检查 report 的 `canonicalization.presentation_html_unwrap=27`，并确认 Figure 3 evidence 不再显示 `<div>`。
5. 继续按现有页面复核组处理剩余 121 项；不要复用旧 block decision 位置假设。

## 工作区边界
- 任务前 Rust 修改仍未提交：`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`。
- 其他用户材料、日志、临时目录和 `test-results` 均未处理；本任务临时真实论文 smoke 脚本已删除。
- 新 Setup 按当前工作区编译，因此包含上述未提交 Rust 修改；本任务没有改写或暂存它们。

## 冷启动读序
1. `docs/adr/0081-deterministic-paper-markdown-canonicalization.md` 与 `CONTEXT.md:Paper Markdown canonicalization`。
2. `packages/core/src/paper-markdown-canonicalization.ts` 及同名单测。
3. `packages/core/src/source-reconciliation.ts:reconcilePaperSource`、`workbench-stage-runner.ts:runSourceReconciliation`。
4. `crates/server/src/lib.rs:workbench_config_hash` 与 v4 stale 测试。
5. `apps/desktop/scripts/smoke-workbench-sidecar.mjs`、`docs/代码链路.md`、`docs/架构.md`。

## 本会话决策摘要
- ADR-0081：纯展示噪声在来源对齐前确定性规范化；不启用 raw HTML、不依赖 LLM、不全量剥离 HTML。
