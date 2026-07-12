# SESSION_CHECKPOINT — 2026-07-12 23:44

## 新鲜度自检
- 论文地图代码基线 commit:`93e9774 fix: improve paper PDF mapping and navigation`。
- 前一提交:`a6e8814 fix: differentiate paper minimap reading modes`。
- 本文件以独立 docs commit 落盘;读入时比较 `git log --oneline -3`,若代码晚于 `93e9774` 则以 Git 为准。

## 当前在做什么
PDF LID 对齐器、大纲导航和正式论文 artifacts 已修复;新 Setup 已完成 release/NSIS 编译,等待安装启动验收。

## 下一步(可直接接手)
1. 安装 `dist/UnderstandBookSetup.exe`,启动新 Reader 并打开 workspace `.understand-book/1`。
2. 确认 source map `config_hash=f55c0a80...`,实测大纲 mapped/unmapped 点击均留在 PDF 面。
3. 确认来源正文只可通过显式按钮或引用操作打开。
4. 实测 `2.47.23.1`、`2.47.24.1` 滚动到 PDF 文件第 3 页对应标题。

## 未提交 / 未完成
- 论文地图、PDF 映射、导航和代码链路已提交;Setup 已重建但未安装,桌面 Reader 未运行,未做在线 API/安装验收。
- 正式 artifacts 已由 `.tmp-hybrid-foundation-v2-tZ5sAV` 写回;旧版备份在 `.understand-book/1/.build/hybrid-foundation-backup-2026-07-12T15-02-12-080Z`。
- `crates/runtime/src/{lib.rs,goldset.rs}` 和其他用户资料/日志/测试产物为既有改动,不得清理或回退。

## 冷启动读序
1. `docs/切片方案-paper-agentic-minimap.md` — 论文地图冻结范围、AM0-AM13 和 hard gates。
2. `docs/adr/0072-agentic-paper-minimap-readonly-projection-and-user-overlays.md` — 只读地图、overlay 与 Agent 权限边界。
3. `docs/adr/0073-paper-minimap-chinese-display-cache.md` — 中文显示缓存和正文/LID 边界。
4. `docs/代码链路.md` 末尾论文地图模式、PDF LID 对齐和 release package 条目 — 本轮入口与验证证据。
5. `crates/reader/src/lib.rs:project_paper_minimap_lens` 与 `packages/web/src/components/PaperMinimap.vue` — skim/摘要/深读投影和完整文字布局。
6. `packages/core/src/hybrid-foundation.ts` 与 `packages/core/test/hybrid-foundation.test.ts` — 空间阅读顺序、窗口匹配和 hard gates。
7. `packages/core/scripts/{rebuild-hybrid-foundation-temp,apply-hybrid-foundation-candidate}.ts` — 临时重建、schema/hash 复验和事务写回。
8. `packages/web/src/App.vue:doGoto` 与 `paper-minimap-navigation.ts` — 无映射时保留 PDF,禁止自动来源 fallback。

## 本会话决策摘要
- 论文地图基座只读;skim/摘要/深读使用不同 lens,文字完整换行显示。
- PDF 内容流不等于阅读顺序;对齐按页内跨栏/左栏/右栏空间顺序,异常几何不得进入候选。
- 短文本碎片只允许整行精确匹配;正文/标题覆盖率必须分别达到 60%/80%。
- 大纲 goto 永不自动打开来源正文;无 PDF region 时保留当前 PDF 页面并提示。
- 临时重建与正式写回分离;本次正式替换已获用户确认并保留回滚备份。

## 最近验证
- 正式复读:algorithm v2,正文 166/258(64.34%),标题/outline 29/29,全部 gates true;正式 artifact hash 与候选一致,目标两 LID 均为 `pageIndex=2`。
- Core full:36 files / 206 tests;Web full:13 files / 68 tests;Core/Web typecheck 与 Web production build 通过。
- Setup:33,881,407 bytes,SHA-256 `92EAC8CE8F0E0415D99089F19EDA42A6B518ED4A723DB62AC3AB64CB5C3004BF`;export/bundle hash 一致。
