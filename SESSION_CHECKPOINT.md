# SESSION_CHECKPOINT - 2026-07-17 17:52 +08:00

## 新鲜度自检
- 写入时最新 commit：`16a889d docs(build): close source review overload validation`。
- 冷启动先运行 `git log -3 --oneline` 与 `git status --short`；若不一致，以 Git 和磁盘现状为准。
- 当前目标“落档来源对齐复核过载方案并按切片修复”已完成。

## 问题与结果
- 固定输入：`.understand-book/understanding-transformer-from-the-perspective-of/{paper.md,paper.pdf}`。
- 原始报告：667 个单元，unresolved 390（58.5%），其中 `needs_review=157`、`md_unmatched=233`。
- 修复后隔离重跑：370 个单元，unresolved 122，`verified=120`、`format_equivalent=128`、`needs_review=102`、`md_unmatched=20`、`pdf_unmatched=0`。
- 产品 `groupSourceReviewBlocks` 将 122 个原子差异投影为 40 个 PDF 页面复核组；原报告和原子审计记录不合并。

## 已完成切片
1. `8882437`：展示公式携带相邻正文上下文；LaTeX 表示归一化不丢公式 token。
2. `1002dff`：唯一 exact/compact/token-equivalent 前向锚点可重同步单调游标，后向候选仍阻断。
3. `84f6ef2`：来源复核过载门禁阻止批量 LLM，保留逐项证据。
4. `d1bb413`：fuzzy 候选只生成复核证据，不再推进游标。
5. `4254cdf`：平衡解包公式 wrapper/fraction、保留运算符并规范 PDF 公式编号。
6. `c41fce4`：按 PDF 页稳定分组；显式页面操作逐条写 `accept_markdown`，部分成功持久化，重试跳过已完成项。
7. `16a889d`：记录最终真实统计与全量回归。

## 信任边界
- fuzzy、LLM 和页面分组均不会产生 trusted source；只有确定性前向等价可自动通过。
- 页面组只是 UI/操作投影；每项仍走现有 `/build_workbench/source_review.resolve` 和 decision 审计。
- 页面操作不会自动执行；必须由用户明确点击“本页 N 项均保留 Markdown”。
- `sourceReconciliationTrusted` 与 ADR-0065 `manual_override` 契约未改变。
- 当前仍是 Markdown→PDF 单向覆盖；反向 `pdf_unmatched` 检测是后续独立信任增强。

## 验证结果
- `pnpm -C packages/core test`：38 files / 234 tests。
- `pnpm -C packages/web test`：24 files / 135 tests。
- Core/Web typecheck：通过。
- `pnpm -C packages/web build`：通过，1913 modules。
- 重编桌面 sidecar 后 `pnpm -C apps/desktop test:workbench-sidecar`：通过。
- 隔离真实论文 benchmark：`md_unmatched=20`、`review_page_groups=40`、空 PDF evidence 为 0。
- 数值/运算符差异回归仍为 unresolved；页面写入失败回归证明成功项不回滚。
- in-app Browser 当时无可用会话，未完成截图级视觉验收；组件渲染/交互测试和 production build 已通过。

## 文档与代码入口
1. `docs/修复方案-来源对齐复核过载.md`：根因、拒绝方案、信任不变量、切片和真实验收。
2. `packages/core/src/source-reconciliation.ts`：公式规范形、单元形成、可信锚点与 fuzzy cursor 权限。
3. `packages/web/src/source-review-batch.ts`：过载判定、页面分组、可重试页面决策执行器。
4. `packages/web/src/components/SourceReviewWorkspace.vue`：过载状态和显式页面操作。
5. `packages/web/src/App.vue:resolveSourceReviewGroup`：逐条持久化、快照更新与最终自动重跑。
6. `docs/代码链路.md`、`docs/架构.md`：改动账本和完整数据流。

## 工作区边界
- 任务前 Rust 修改仍未提交：`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`。
- 其他用户材料、日志、临时目录和 `test-results` 均未处理；本任务临时 benchmark 脚本已删除。
- 若继续实际复核：先用修复后的安装版重跑来源对齐，再按 40 个页面组检查并显式确认；不要对 122 项启动批量 LLM。
