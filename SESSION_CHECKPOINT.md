# SESSION_CHECKPOINT - 2026-07-09 13:20

## 新鲜度自检
- 写入时基准 commit: `3d42b39 feat: add confirmable sidecar planning`.
- 读入时先跑 `git log --oneline -3` 和 `git status --short`;若更新,以 git 为准。

## 当前状态
- PH6-PH9 已完成并提交: Workbench core shell、PDF runtime endpoints、最小 PDF surface、trusted-source paper projections、confirmable sidecar plan。
- 两块前端仍未实现,已落档为后续切片:
  - PH10: Build Workbench 前端预构建页。
  - PH11: PDF.js 正文阅读面。

## 下一步可直接接手
1. 打开 `docs/切片方案-paper-pdf-first-hybrid.md` 的 PH10/PH11,先确认本轮做哪一块。
2. PH10: 扫 `packages/core/src/build-workbench.ts`、`packages/web/src/App.vue`、`packages/web/src/api.ts`、`packages/web/src/components/*`,做 Workbench route/API/UI 最小闭环。
3. PH11: 扫 `packages/web/src/components/PdfReaderPane.vue`、`packages/web/src/api.ts` 和 PH7 endpoints,把最小 PDF surface 升级为 controlled PDF.js canvas/text-layer/lazy page surface。
4. 每个小切片实现后运行相关 typecheck/test/build,单独 commit。

## 未提交/未完成
- PH10/PH11 当前仅落档方案,尚未实现。
- 工作区有既有脏改和未跟踪文件;不要误 stage unrelated files。
- 已知既有脏改包括 `packages/core/src/md-adapter.ts`、core tests、`packages/web/src/App.vue`、`LeftRail.vue`、`ReaderPane.vue`、`md.ts`、`style.css` 等。

## 冷启动读序
1. `docs/切片方案-paper-pdf-first-hybrid.md` - 读 PH10/PH11,再看 G49/G50/G11/G36/G17b/G35。
2. `docs/代码链路.md` - 读 2026-07-09 PH6-PH9 以及 PH10/PH11 docs entry。
3. `packages/core/src/build-workbench.ts` - PH10 的 readiness/job/decision/permission 状态模型。
4. `packages/web/src/App.vue` - PH10/PH11 的 frontend entry 和 reader surface 切换点。
5. `packages/web/src/components/PdfReaderPane.vue` - PH11 的最小实现现状。

## 本会话决策摘要
- “前端预构建页面”不是 PH6 已完成内容,应作为 PH10 单独实现。
- “前端 PDF 正文”不是 PH7 最小 native/minimal surface 已完成内容,应作为 PH11 单独实现。
