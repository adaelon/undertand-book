# SESSION_CHECKPOINT - 2026-07-17 12:41 +08:00

## 新鲜度自检
- 写入时修复 commit:`02e123b fix(reader): constrain PDF translation to selected text`;读入时先运行 `git log -3 --oneline` 与 `git status --short`,不一致时以 Git 和磁盘现状为准。
- Windows Setup 已从 detached `02e123b` 快照重建;任务前 PE0-PE5、memory/profile Rust 与其他工作区修改未进入该快照。

## 当前状态
PDF 选区翻译的 context 扩译 bug 已完成 TS0-TS5:
- `source_markdown` 是 `translation_markdown` 的唯一内容边界。
- `reference_only.context_blocks` 只允许用于消歧,不得被翻译、引用、总结、前插或后附。
- terminology 只约束 source 用词,不得增加内容。
- 未改 Selection/ranges、resolved/partial 分流、endpoint、锁、Provider timeout、UI、cache、chat、memory 或 citation。
- 若相同真书选区再次出现 context-only 内容,按方案门禁删除 Provider context 输入,不继续堆 prompt。

## 验证证据
- TS1 red:`selection_translation_prompt_limits_output_to_source_markdown` 仅因旧 system 缺少唯一源文规则而失败。
- TS2 green:目标测试 1/1、`selection_translation_` 9/9、server 154/154;目标 diff 通过 `git diff --check`。
- TS3 real:`.understand-book/1` 同一 13 行 `partial` 选区在隔离新二进制上 5/5、活动 `8794` 上 1/1 通过;均保留 `15`/`80`,排除 `PRO00006097`/`STU00216333`。
- package:`pnpm -C apps/desktop package:windows` 退出 0;Web production build、sidecar、Rust release 与 NSIS 均完成。
- package 仅有既有 Vite 大 chunk 和 `ts-rs` serde attribute 警告;pnpm 离线 frozen install 未改锁文件。
- `cargo fmt -p server -- --check` 仍被本切片外既有 server 格式漂移阻断;本切片新增测试已按 rustfmt 建议调整。

## Windows Setup
- 路径:`dist/UnderstandBookSetup.exe`(gitignored)。
- 来源:detached `02e123b18516d99bfa9e350a58c4684d5537d519`。
- 大小:`34,662,819` bytes。
- SHA-256:`2F431F7225FE7DB4F938E4F4C6ACD45217163C116E4E502AC0D58A0E8205E006`。
- file/product version:`0.1.0`;Authenticode:`NotSigned`。
- NSIS source、detached export 与主工作区 Setup 哈希一致;安装器未启动。

## 工作区边界
- PDF 原生选区 PE0-PE5:`PdfReaderPane.vue`、同名单测、`pdf-selection-actions.spec.ts`、ADR-0080、边界方案、architecture/code trail;保持未提交状态。
- 任务前 Rust:`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/{lib,profile,review}.rs`、`crates/reader/src/lib.rs`、`crates/runtime/src/{memory_review,profile_api}.rs`;保持未提交状态。
- 其余用户材料、日志、`.fluid/`、hybrid candidates、preview memory 与 test-results 均未处理。
- detached worktree 的 Git 元数据已 prune;目录只残留约 13 MB pnpm 硬链接,因活动 Vite 的 esbuild/Rollup 文件占用无法删除。停止 4174 后可删除 `.tmp-translation-setup-worktree`。

## 运行服务
- Web:`http://127.0.0.1:4174/`,Vite PID `25156`,esbuild PID `18720`。
- Backend:`http://127.0.0.1:8794/`,PID `22388`,活动书 `.understand-book/1`;此前 `/desktop/status` 为 200。
- TS3 隔离端口 `8795` 已关闭;安装器未运行。

## 下一步
1. 可直接运行 `dist/UnderstandBookSetup.exe` 做人工安装 smoke;当前构建未签名,Windows 会按本机策略提示。
2. 可在 `http://127.0.0.1:4174/` 复选 Tissue Acquisition 样例,译文应从 `The heart was transected...` 开始。
3. 若翻译复发,按 `docs/切片方案-pdf选区翻译源文边界.md:何时回头` 建立红测并执行 context-removal 回退。
4. 后续停止 4174 后,删除残留 `.tmp-translation-setup-worktree` 目录。

## 冷启动读序
1. `docs/切片方案-pdf选区翻译源文边界.md` - 根因、prompt 契约、TS0-TS4 与回退门禁。
2. `crates/server/src/lib.rs:selection_translation_prompt/selection_translation_prompt_limits_output_to_source_markdown` - 生产实现与 red-green 锁。
3. `docs/code-trail-S12-continuous-reader.md:TS1-TS5` - 红测、实现、真书证据与安装包构建。
4. `docs/切片方案-pdf选区翻译.md:Provider 与输出` 与 ADR-0078 - 既有翻译边界。
5. ADR-0080 与 `docs/切片方案-pdf选区边界稳定性.md:PE5` - 当前原生 Selection 依赖。

## 本会话决策摘要
- Prompt 单一源文契约:`source_markdown` 是唯一输出范围,整 LID context 仅可消歧。
- Build isolation:脏工作树不得直接打包;Setup 必须来自已提交的 detached 快照。
- 回退门禁:真实请求再次出现 context-only 内容时删除 context 输入,不继续增加提示词。
