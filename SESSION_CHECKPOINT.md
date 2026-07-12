# SESSION_CHECKPOINT — 2026-07-12 20:12

## 新鲜度自检
- 论文地图功能基线 commit:`d46a94c feat: add localized agentic paper minimap`。
- 本文件会有后续独立 docs commit;读入时比较 `git log --oneline -3`,若代码晚于 `d46a94c` 则以 Git 为准。

## 当前在做什么
Agentic paper minimap 已完成并交付 Setup:只读 PDF/章节坐标、区域/重点位置/论证关系、skim/abstract/deep、viewport 双向同步、受控 Agent overlay、用户私有保存与 LLM 中文显示缓存均已接通。

## 下一步(可直接接手)
1. 安装 `dist/UnderstandBookSetup.exe`,打开一个已可信的英文 paper workspace。
2. 配置 Provider 后首次进入论文地图,确认章节与重点位置变为中文且 `BERT` 等专有名词保留英文。
3. 关闭并重新进入同一论文版本,确认命中 `paper-minimap-localizations.json` 且不再次调用 Provider。
4. 点击章节区域、重点位置和地图轨道,确认 PDF 跳转正确且不再出现 `INVALID_PAPER_MINIMAP_VIEWPORT` 或误开“引用来源”。
5. 将第一个真实使用失败点作为新需求重新走 §0 对齐;不要恢复旧 `paperStructureRows/PaperReadingGuide` 地图表面。

## 未提交 / 未完成
- 论文地图功能已提交为 `d46a94c`;本 checkpoint 以独立 docs commit 落盘。
- AM13 真实论文验收、Setup smoke 与真实 Provider smoke 按用户要求未由 Agent 执行,不得记为已通过。
- 工作树仍有用户资料、日志、浏览器 profile、测试产物及 `crates/runtime/src/{lib.rs,goldset.rs}` 格式化改动;不得清理、回退或混入论文地图提交。

## 冷启动读序
1. `docs/切片方案-paper-agentic-minimap.md` — 冻结范围、AM0-AM13 与 hard gates。
2. `docs/adr/0072-agentic-paper-minimap-readonly-projection-and-user-overlays.md` — 只读地图、overlay 与 Agent 权限边界。
3. `docs/adr/0073-paper-minimap-chinese-display-cache.md` — 首次 LLM 翻译、版本缓存与失败回退。
4. `CONTEXT.md` 的 Agentic paper minimap / Chinese display layer 术语 — 领域边界。
5. `packages/web/src/components/PaperMinimap.vue`、`packages/web/src/App.vue` — 中文渲染、交互与 viewport/goto 链路。
6. `crates/server/src/lib.rs` 的 `route_paper_minimap_localize` 与 paper minimap routes — HTTP、缓存和 reducer 边界。
7. `docs/代码链路.md` 末尾 paper minimap 条目 — 逐切片入口与验证证据。

## 本会话决策摘要
- ADR-0072:地图基座只读;Agent 只发 typed action;滚动不触发 LLM。
- ADR-0073:中文标签是可失效显示缓存,不替代英文正文、LID、citation 或证据关系。
- 导航修复:viewport 规范化到地图页域;请求 LID 的 resolved leaf 有 PDF 坐标时不打开来源 fallback。

## 最近验证
- Server full:95 passed;Web full:13 files / 66 tests;typecheck/build passed;Playwright desktop/mobile:2 passed。
- Setup:`dist/UnderstandBookSetup.exe`,33,889,606 bytes,SHA-256 `1748718451FE4DE002E82AD463BDAA1FC938165F53FD484BD2F012561305FCBC`。
