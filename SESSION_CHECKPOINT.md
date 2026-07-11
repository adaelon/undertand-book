# SESSION_CHECKPOINT - 2026-07-11 23:20

## 新鲜度自检
- 写入时功能基线 commit:`5529581 fix: enter reader when paper build becomes trusted`。
- checkpoint 自身会有后续 docs commit;读入时比较 `git log -3`,不一致时以 Git 为准。
- worktree 有大量既有用户资料、日志和临时产物;不得清理、提交或回退。

## 当前在做什么
可信 paper 自动进入 reader 已完成;下一会话工作上下文切到 paper 阅读区本身:PDF 正文、论文小地图与结构/阅读指南投影。

## 下一步（可直接接手）
1. 关闭旧 Reader,运行 `dist/UnderstandBookSetup.exe`,打开一个已可信 paper workspace。
2. 实测 `PdfReaderPane` 的 PDF 页面、LID overlay/跳转/选区与 Markdown source fallback,记录第一个确定性失败点。
3. 实测 `LeftRail` 论文小地图的 preset、structure rows、pinned evidence 与当前位置联动。
4. 改码前先跑 `pnpm -C packages/web test -- components/PdfReaderPane.test.ts`,再按用户反馈完成新的 §0 对齐。

## 未提交 / 未完成
- 本轮功能与 checkpoint 已提交;tracked worktree 干净。
- paper 阅读区尚无新的已冻结需求;下一会话先以真实可信 paper 做验收和需求对齐。
- 最新 Setup:`dist/UnderstandBookSetup.exe`,33,603,539 bytes,SHA-256 `FFF4D8E9076BD7C4AA5830B98EE6FA23596C7DE50DE97D9F9C8B2C52B8A0C1D2`。

## 冷启动读序
1. `docs/adr/0063-paper-pdf-first-reconciled-source-build-workbench.md` - source trust、PDF-first reader 与 Workbench 边界。
2. `docs/切片方案-paper-pdf-first-hybrid.md` 的 PH11、Reader runtime flow 和 Hard Gates - PDF.js 正文阅读契约。
3. `docs/架构.md` 的组件图与 `App init -> PdfReaderPane` 数据流。
4. `CONTEXT.md` 的 BookStructure、结构投影、PDF visual source map、PDF-first reader surface、Reader surface selection。
5. `packages/web/src/App.vue` 的 `pdfReaderAvailable/loadPdfRuntimeArtifacts/loadPaperProjectionData/paperStructureRows/doGoto` 与 reader template。
6. `packages/web/src/components/PdfReaderPane.vue`、`PdfReaderPane.test.ts` - PDF.js canvas/text/overlay/selection 主阅读面。
7. `packages/web/src/components/LeftRail.vue` - paper minimap、preset、结构停靠点与 pinned evidence。
8. `packages/web/src/api.ts` 的 `SourceManifestV2/PdfSourceMap/PaperReadingGuide` 类型和对应 API。

## 本会话决策摘要
- ADR-0071:artifact readiness 给出 `route=reader` 后立即进入阅读;job 状态和历史界面偏好不得阻塞,用户仍可主动打开诊断 Workbench。

## 验证证据
- `pnpm -C packages/web test`:10 files / 54 tests passed。
- `pnpm -C packages/web typecheck`:passed。
- `pnpm -C packages/web build`:passed。
- `pnpm -C apps/desktop package:windows`:release NSIS passed,Setup hash 见上。
