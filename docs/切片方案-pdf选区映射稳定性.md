# 切片方案 - PDF 选区映射稳定性

> 状态:2026-07-16 PF0-PF4 已完成,正式 artifact 与真实浏览器验收已闭合。
> 决策:[ADR-0079](adr/0079-pdf-selection-banded-reading-order-and-conservative-resynchronization.md)。
> 既有边界:[ADR-0063](adr/0063-paper-pdf-first-reconciled-source-build-workbench.md) 与 [ADR-0074](adr/0074-pdf-selection-actions-and-exact-user-annotation-projection.md)。

## 0. 冻结边界

1. 只修带文字层 PDF 的 `SourceBlock -> PDF line -> selection char span` 构建链和 unresolved 工具条闪现。
2. canonical `source.txt`、LID/range 与英文原文仍是唯一正文和证据真相。
3. 不加入 OCR、LLM 页框判断、PDF annotation write-back 或针对特定页码/论文的条件。
4. 不把尚未在 Chromium 复现的 Tauri 原生选区绘制问题混入本次修复。
5. 图表内部文字允许保持 unmapped;正文不得因图表噪声发生连续失配。

## 1. 根因证据

```text
page 5 ordered line 19: left-column body match ends
  -> 167 chart/figure lines, at least 318 ASCII words
  -> ordered line 187: right-column body continues

ALIGNMENT_LOOKAHEAD_WORDS = 240
  -> right-column anchor rejected
  -> lineCursor remains stale
  -> later paragraphs cascade to unmapped until an exact heading resynchronizes
```

修复前真书 `alignment_report.json` 只有 `172/258 = 66.7%` alignable text mapped;selection char coverage 在页 5-7 为 `2.7%/11.8%/7.7%`,页 10-11 为 `0%`,页 12 又恢复为 `94.5%`。前端在 mouseup 后立即进入 `resolving`,所以后端返回 `unresolved` 时会出现工具条闪现而原生选区保留。

## 2. PF0 - 决策与切片落档

- **Do**:冻结根因、通用修复边界、否决方案和验收矩阵。
- **Do not**:不修改运行时代码或 artifact。
- **Done**:ADR-0079 与本方案互链,每个后续切片有独立红测和退出判据。

## 3. PF1 - 水平带内栏序

- **Do**:先按显著水平留白把页面划为 top-to-bottom bands,再在每个 band 内复用单栏/双栏/跨栏排序;阈值按页面与中位行高归一化。
- **Do not**:不增加失配恢复,不改变前视窗口,不接 UI。
- **Done**:新增图表密集双栏 fixture 先红后绿;右栏续文排在图表文字前,其 LID 与 selection chars 均可映射;现有 hybrid foundation tests 全绿。

## 4. PF2 - 唯一强锚重同步

- **Do**:局部 240 词窗口失配后,仅在当前页与下一页搜索至少 6 token、连续、唯一、单调的 anchor;恢复结果显式进入 alignment reason。
- **Do not**:不做全书模糊搜索,不放宽短片段规则,不让多候选自动胜出。
- **Done**:新增噪声超过 240 词但唯一续文可恢复的红测;跨行断词 anchor 与正式匹配器使用同一归一化;重复 anchor 仍 unmapped;失配不再级联到后续强段落。

## 5. PF3 - unresolved 无闪现

- **Do**:工具条只渲染 error 或已生成 partial/resolved draft 的状态;resolving/unresolved 保留原生选区和复制能力。
- **Do not**:不清除 DOM Selection,不改变 Highlight/Note/Ask AI/Translate 的动作门禁。
- **Done**:controller/component/Playwright 证明 unresolved 从未出现动作工具条,resolved 工具条稳定出现,原生选区保持非折叠。

## 6. PF4 - 真书重建与验收

- **Do**:先在临时目录重建 `.understand-book/1`,核对 LID identity、hard gates、页级覆盖和代表性 selection resolve;证据达标后才替换正式 foundation artifact。
- **Do not**:不覆盖 canonical source/PDF,不混入 paper graph、memory 或 profile 的既有修改。
- **Done**:候选与正式产物均通过 source/PDF hash、424 个 LID identity、selection shard hash、页面边界与语义图摘要门禁;`206/258 = 79.8%` alignable text mapped,29/29 标题映射,无 page regression。可选字符覆盖页 5 `2.7% -> 41.7%`,页 6 `11.8% -> 76.5%`,页 7 `7.7% -> 39.7%`,页 10 `0% -> 21.1%`,页 11 `0% -> 86.2%`,其余页面无下降。正式替换保留 `.build/hybrid-foundation-backup-2026-07-16T14-21-32-476Z` 回滚点。
- **Done**:真实 Chromium 物理拖选页 5 正文时,pending 工具条为 0,resolved 后为 1,原生 Selection 全程保留;拖选 unmapped 的 `Circulation` 时,pending/unresolved 工具条始终为 0,原生 Selection 全程保留。

## 7. 确定性验收矩阵

| 层 | 必测契约 |
|---|---|
| Layout | 单栏、双栏、跨栏 opening、栏下图表、跨栏图注、页眉页脚 |
| Recovery | 唯一强锚恢复、重复锚拒绝、页距限制、单调不回退 |
| Selection map | 正文 char 获得正确 LID/span,图表噪声不冒充正文 |
| Web | resolving 不显示动作工具条,unresolved 保留原生复制,resolved/partial 动作不回归 |
| Real book | 页 5、10、11 代表性正文与覆盖率报告,正式 artifact hash/freshness 闭合 |

禁止把“全局 mapped ratio 仍过 60%”当作完成;必须同时检查连续 unmapped run、页级正文覆盖和真实选区响应。
