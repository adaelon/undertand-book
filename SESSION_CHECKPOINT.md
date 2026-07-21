# SESSION_CHECKPOINT - 2026-07-21 12:20 +08:00

## 新鲜度自检
- Setup 源码 commit: `09b7231 feat(book): add deterministic full-text search contracts`。
- 本 checkpoint 与发布记录在后续 release docs commit 中;读入时对比 `git log -3`,不一致则以 Git 为准。
- 当前 Setup: `dist/UnderstandBookSetup.exe`,35,667,957 bytes,SHA-256 `B5B075915D66E33CA74046BAC4BB4A719945F9C526FA7EA6C88844F9F965E7A3`。

## 当前在做什么
FT1-FT8 已完成、提交并从隔离 `09b7231` 快照重编 Windows Setup;没有开放实现切片。

## 下一步(可直接接手)
1. 发布前执行 `git log -3 --oneline` 和 `git status --short`,确认源码提交与用户遗留 dirty 边界。
2. 需要人工验收时启动 `dist/UnderstandBookSetup.exe`;本轮未安装或启动安装器。

## 未提交 / 未完成
- FT 与发布记录:无;Setup 为 `.gitignore` 忽略的本地发布产物。
- 工作树仍有用户既有 memory/profile/reader/server host、旧前端切片和资料文件,不得吸收或恢复。

## 冷启动读序
1. `docs/切片方案-确定性全文定位与Book工具契约单源.md` - FT0-FT8 契约、完成状态和发布门禁。
2. `docs/adr/0088-deterministic-text-occurrence-search-and-canonical-book-tool-contracts.md` - occurrence 与 schema 单源决策。
3. `docs/代码链路.md` 最后的 FT1-FT8/Setup 条目 - 实现、测试与产物索引。
4. `docs/架构.md` 的 Canonical Book tool contracts 段 - 当前模块与数据流。

## 本会话决策摘要
- ADR-0088:字面地址先走确定性 `book.search_text`;语义解释继续读取规范正文。
- 发布隔离:Setup 只从已提交 detached 快照构建,不吸收主工作区未提交改动。
