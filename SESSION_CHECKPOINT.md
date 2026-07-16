# SESSION_CHECKPOINT - 2026-07-16 22:54 +08:00

## 新鲜度自检
- 写入时最新 commit:`082f90e fix(build): verify paper semantic graph closure`;前两提交为 `77d7dad`、`5fa8647`。
- 读入时先运行 `git log -3 --oneline` 与 `git status --short`;本轮全部实现和文档仍未提交,以 Git 和磁盘现状为准。

## 当前状态
用户要求的“先落档 PDF 选区不稳定 bug 修复方案,再按切片修复”已完成 PF0-PF4。根因不是一个随机前端竞态,而是两条可独立复现的链:

1. PH5 把整页按“全左栏 -> 全右栏”排序,页 5 右栏续文前插入 167 条下方图表文字(至少 318 词),超过 240 词局部窗口;一次失配留下 stale `lineCursor`,随后连续 unmapped。
2. Web 在 `resolving` 阶段就挂载动作工具栏;真实 unresolved 响应因此表现为“选项闪一下再消失”,而 native Selection 按降级契约保留。

已实现通用修复:
- `pageLinesInReadingOrder` 先按归一化水平留白分 top-to-bottom bands,再在 band 内复用单栏/双栏/跨栏排序;无页码、论文或固定栏宽特判。
- 局部失配后仅允许当前/下一页、至少 6 token、连续且唯一的强锚恢复;重复/过远候选 fail-closed,恢复项置信度固定为 0.68 并显式写入 reason。
- 恢复预筛与正式匹配器统一处理 PDF 跨行断词(`en-` + `riched`),避免页 10 恢复锚点漏检。
- PDF 动作工具栏只在 error 或 partial/resolved draft 存在时挂载;resolving/unresolved 不挂载且不清除 native Selection。

## 正式 artifact 与真实验收
- 已将 `.tmp-hybrid-foundation-v2-ID9VcK` 原子应用到 `.understand-book/1`;canonical source、原 PDF、424 个 LID identity 与语义图摘要均未改变。
- 回滚点:`.understand-book/1/.build/hybrid-foundation-backup-2026-07-16T14-21-32-476Z`。
- `mapped_text_count`:修复前 `172/258 = 66.7%`,修复后 `206/258 = 79.8%`;标题 `29/29`;`page_regressions=[]`;保守恢复只触发 4 个段落。
- selectable-character coverage:页 5 `2.7% -> 41.7%`,页 6 `11.8% -> 76.5%`,页 7 `7.7% -> 39.7%`,页 10 `0% -> 21.1%`,页 11 `0% -> 86.2%`;其余页面无下降。
- PID `17132` 仍监听 `127.0.0.1:8794`,无需重启即读取新分片和最新 `packages/web/dist`。
- 真实 Chromium 物理拖选页 5 `Due to its tolerance`:800ms pending 时工具栏 0,resolved 后工具栏 1,Selection 全程保留;拖选 unmapped `Circulation`:pending/unresolved 工具栏始终 0,Selection 全程保留。
- Chromium 未复现“映射成功后原生选区绘制消失”;若 Tauri WebView 仍出现该独立现象,必须另立带 WebView/OS 证据的切片,不得回退本轮确定性修复。

## 验证基线
- Core:`pnpm test` 38 files / 223 tests passed;`pnpm typecheck` passed。
- Web:`pnpm test` 24 files / 124 tests passed;`pnpm build` passed;仅既有 KaTeX quirks、ECONNREFUSED fixture 与大 chunk 警告。
- Playwright:`pdf-selection-actions.spec.ts` 4/4 passed,含 1 秒 delayed unresolved 无工具栏闪现。
- Rust:`cargo test -p server pdf_selection_` 4/4 passed;仅既有 `ts-rs` serde attribute warning。
- 真书候选/正式应用:source/PDF hash、selection shard hash、页面边界、LID identity、hard gates 与 semantic graph digest 全部闭合。

## 未提交与边界
- 本任务 tracked 修改:`SESSION_CHECKPOINT.md`,`docs/architecture.md`,`docs/code-trail-S12-continuous-reader.md`,`packages/core/src/{hybrid-foundation,zod}.ts`,`packages/core/test/hybrid-foundation.test.ts`,`packages/web/src/App.vue`,`packages/web/playwright/pdf-selection-actions.spec.ts`。
- 本任务 untracked 文档:`docs/adr/0079-pdf-selection-banded-reading-order-and-conservative-resynchronization.md`,`docs/切片方案-pdf选区映射稳定性.md`。
- 本任务临时候选仍保留供审计:`.tmp-hybrid-foundation-v2-8GfDRX`(首轮通过),`.tmp-hybrid-foundation-v2-Wbypfx`(跨行断词预筛回退,禁止应用),`.tmp-hybrid-foundation-v2-ID9VcK`(最终已应用)。确认不再需要审计后方可删除。
- 任务前已有 tracked 修改:`crates/base-schema/tests/roundtrip.rs`,`crates/memory/src/{lib,profile,review}.rs`,`crates/reader/src/lib.rs`,`crates/runtime/src/{memory_review,profile_api}.rs`;本轮未修改、不得回退或混入本任务提交。
- 其余 untracked 用户材料、日志、`.fluid/`,`.tmp-pt5-preview-memory/` 与 `packages/web/test-results/` 均未处理。
- 本轮未提交、未重打 `dist/UnderstandBookSetup.exe`,也未做 Tauri/Windows installer smoke;用户未要求发布包。

## 下一步(可直接接手)
1. 若用户要求提交,只 stage 上述本任务代码/文档;明确排除任务前 Rust 修改、用户材料、三份 temp candidate 和 test-results。
2. 若用户仍在 Tauri 内看到“resolved 后蓝色原生选区消失”,先冻结 Windows/WebView2 版本、具体页/文本、Selection API 状态和逐帧截图;这属于本轮排除的绘制层问题。
3. 若要发布桌面版,先重跑必要验收,再单独执行 Windows package 与安装 smoke;不要把现有旧 Setup 当成本轮产物。
4. 若需释放磁盘,确认保留正式 `.build` 回滚点后,只删除三个明确列出的 `.tmp-hybrid-foundation-v2-*` 目录。

## 冷启动读序
1. `docs/adr/0079-pdf-selection-banded-reading-order-and-conservative-resynchronization.md` 与 `docs/切片方案-pdf选区映射稳定性.md` - 冻结边界、决策和 PF0-PF4 实际指标。
2. `docs/code-trail-S12-continuous-reader.md` 末尾 PF0-PF4 与 `docs/architecture.md:Major Data Flows/Decision Index` - 已实现链路和验证入口。
3. `packages/core/src/hybrid-foundation.ts:horizontalLineBands/bandLinesInReadingOrder/recoveryAnchorLineOccurrences/findLinesForBlock` 与相邻 tests - 构建时版面顺序和保守恢复。
4. `packages/web/src/App.vue:pdf-selection-toolbar`、`packages/web/src/pdf-selection-draft.ts`、`packages/web/playwright/pdf-selection-actions.spec.ts` - resolving/unresolved UI 状态契约。
5. `.understand-book/1/alignment_report.json`,`pdf_source_map.json`,`pdf_selection_map/` 与上述 `.build` backup - 正式运行 artifact 和回滚证据。

## 本会话决策摘要
- 这是通用几何/状态机修复,不是只对当前论文有效:分带阈值由页面高度与中位行高归一化,恢复约束由 token 唯一性与页距决定,UI 只依赖 draft ownership。
- canonical `source.txt`、LID/range 和英文原文继续是唯一正文/证据真相;图表内部文字允许 unmapped,但不得再使后续正文级联失配。
- 不采用全书模糊搜索、无限放大 lookahead、OCR/LLM 页框判断、特定页码条件或 unresolved loading 工具栏。[ADR-0079]
