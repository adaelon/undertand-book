# SESSION_CHECKPOINT - 2026-07-17 12:22 +08:00

## 新鲜度自检
- 写入时最新 commit:`ea34a82 fix(pdf): stabilize selection mapping and actions`;读入时先对比 `git log -3 --oneline` 与 `git status --short`,不一致时以 Git 为准。
- 本轮 PDF 翻译源文边界修改尚未提交;任务前已有 PE0-PE5 与 memory/profile Rust 修改,三组不得混合覆盖。

## 当前在做什么
paper `PDF selection translation` 的 context 扩译 bug 已按 TS0-TS4 修复:保留整 LID context,但 prompt 将 `source_markdown` 冻结为唯一输出范围。

冻结边界:
- `context_blocks` 继续用于消歧,现位于 user JSON 的 `reference_only.context_blocks`。
- system 明令不得翻译、引用、总结、前插或后附 context;terminology 只约束 source 用词。
- 未改 PDF Selection/ranges、resolved/partial 分流、endpoint、锁、Provider timeout、UI、cache、chat、memory 或 citation。
- 若相同症状再次出现,按新方案的回退门禁停止向 Provider 发送整 LID context,不再继续堆 prompt。

## 验证证据
- TS1 red:`selection_translation_prompt_limits_output_to_source_markdown` 仅因旧 system 缺少唯一源文规则而失败。
- TS2 green:目标测试 1/1、`selection_translation_` 9/9、server 154/154;目标 diff 通过 `git diff --check`。
- TS3 real:`.understand-book/1` 同一 13 行 `partial` 选区在隔离新二进制上 5/5、重启后活动 `8794` 上 1/1 通过;均保留 `15`/`80`,排除 `PRO00006097`/`STU00216333`。
- `cargo fmt -p server -- --check` 仍被本切片外既有 server 格式漂移阻断;本切片新增测试已按 rustfmt 建议调整。

## 下一步(可直接接手)
1. 审阅 `git diff -- crates/server/src/lib.rs docs/切片方案-pdf选区翻译.md docs/切片方案-pdf选区翻译源文边界.md docs/code-trail-S12-continuous-reader.md SESSION_CHECKPOINT.md`。
2. 如需提交,仅暂存上一步列出的翻译文件,不要带入 PE0-PE5 或 memory/profile Rust 文件。
3. 可在 `http://127.0.0.1:4174/` 复选 Tissue Acquisition 样例,确认界面译文从 `The heart was transected...` 开始。
4. 若复发,按 `docs/切片方案-pdf选区翻译源文边界.md:何时回头` 建立新红测并执行 context-removal 回退。

## 未提交 / 未完成
- 本目标:`crates/server/src/lib.rs`;`docs/切片方案-pdf选区翻译.md`;新文件 `docs/切片方案-pdf选区翻译源文边界.md`;`docs/code-trail-S12-continuous-reader.md`;本 checkpoint。
- PDF 原生选区 PE0-PE5:`PdfReaderPane.vue`、同名单测、`pdf-selection-actions.spec.ts`、ADR-0080、边界方案、architecture/code trail;保持原样。
- 任务前 Rust:`crates/base-schema/tests/roundtrip.rs`;`crates/memory/src/{lib,profile,review}.rs`;`crates/reader/src/lib.rs`;`crates/runtime/src/{memory_review,profile_api}.rs`;保持原样。
- 本轮隔离 `.tmp-ts3-target`/`.tmp-ts3-memory` 已删除;Windows installer 未重建。

## 运行服务
- Web:`http://127.0.0.1:4174/`,Vite PID `25156`。
- Backend:`http://127.0.0.1:8794/`,新编译 PID `22388`,活动书 `.understand-book/1`;`/desktop/status` 为 200。
- TS3 隔离端口 `8795` 已关闭。

## 冷启动读序
1. `docs/切片方案-pdf选区翻译源文边界.md` - 根因、prompt 契约、TS0-TS4 与回退门禁。
2. `crates/server/src/lib.rs:selection_translation_prompt/selection_translation_prompt_limits_output_to_source_markdown` - 生产实现与 red-green 锁。
3. `docs/切片方案-pdf选区翻译.md:Provider 与输出` 与 ADR-0078 - 既有翻译边界。
4. `docs/code-trail-S12-continuous-reader.md:TS1-TS3` - 红测、实现和真书证据。
5. `docs/architecture.md:PDF selection translation` - 未变化的锁外数据流。
6. ADR-0080 与 `docs/切片方案-pdf选区边界稳定性.md:PE5` - 当前原生 Selection 依赖。

## 本会话决策摘要
- §1 Prompt 单一源文契约:`source_markdown` 是唯一输出范围,整 LID context 仅可消歧(已落档到翻译源文边界方案 §2)。
- 回退门禁:真书再次出现 context-only 内容时删除 Provider context 输入,不继续增加提示词。
