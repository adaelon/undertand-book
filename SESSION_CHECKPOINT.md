# SESSION_CHECKPOINT - Agent 对话用户可见来源

更新时间：2026-07-20 11:35 +08:00

## 新鲜度自检

- 功能实现与 Windows Setup 的冻结输入：`a0d7a48 feat(agent): present user-visible source references`，分支 `main`。本 checkpoint 与发布记录在打包完成后单独提交；冷启动以 `git log -3 --oneline` 确认最新文档提交。
- 冷启动先执行 `git log -3 --oneline` 与 `git status --short`；工作树包含用户原有大量 dirty/untracked 文件，不得清理或恢复。
- 本 checkpoint 覆盖旧的 Note placement 热启动内容。Agent 来源 SR0-SR7 已全部实现、验证并打包，不要从 SR1 重做。

## 当前结果

目标“实现全部 SR”已完成并生成本地 Windows Setup：普通 Agent 对话不再把内部 LID 作为位置名称展示，而是在相关句后显示蓝色来源按钮。

- SR1：`Book::resolve_source` 验证真实连续 EvidenceRange，生成语义标签、exact quote、连续上下文、preview 与 digest。
- SR2：Runtime 本轮 ledger 只观察 verified selection、gated query/synthesize citations 和成功 `book.text`；`source.present` 可选且不能越权。
- SR3：Native/ReAct 共用 final compiler；受控 marker 编译为 typed parts，原始 LID/unknown ref 一次修复后 fail-closed。
- SR4：Server 持久 internal binding，对外只给 opaque ref；resolve/open 复验 owner/digest，stale 禁止导航。
- SR5：`RightRail` 渲染句后单/多来源按钮；桌面锚定弹窗、移动底部 sheet；首次点击不跳 Reader，次级按钮才打开正文。
- SR6：旧 `[LID: real.node]` 仅在只读 View 中保守转换；代码、链接、转义、裸数字不动；重启稳定，切书/删历史 fail-closed。
- SR7：从 detached `a0d7a48` 运行正式 Web/sidecar/Rust/NSIS 发布链；最终 Setup 位于 `dist/UnderstandBookSetup.exe`，不受主工作区其他 dirty 改动影响。

冻结决策仍以 `docs/adr/0086-runtime-owned-user-visible-source-references.md` 为准。实现切片与门禁见 `docs/切片方案-Agent对话用户可见来源.md`。

## 关键代码入口

1. `crates/read-tools/src/lib.rs`：`EvidenceRange`、`ResolvedSource`、`Book::resolve_source`、`disambiguate_source_labels`。
2. `crates/runtime/src/orchestrator.rs`：`TurnEvidenceLedger`、typed tool observers、`source.present`、`compile_agent_answer`、`deliver_agent_answer`。
3. `crates/server/src/lib.rs`：internal/public Agent history split、`turn_view`、`legacy_answer_projection`、`agent_source_binding`、source resolve/open routes。
4. `packages/web/src/components/RightRail.vue`：typed answer parts、source popup controller、semantic question/effect/history labels。
5. `packages/web/src/App.vue`：history View mapping、当前回合 question selection 保留、source open 后 Reader 同步。
6. `packages/web/src/api.ts` 与 `packages/web/src/generated/AgentAnswer*.ts`：opaque Web 契约。
7. `packages/web/playwright/agent-source.spec.ts` 与 `crates/server/scripts/smoke-agent-source-real-book.mjs`：浏览器和真书发布门禁。

## 验证快照

- `cargo test -q --workspace`：640/640。
- `cargo test -q -p read-tools`：136/136。
- `cargo test -q -p runtime`：160/160。
- `cargo test -q -p server`：162/162。
- `pnpm -C packages/web test -- --reporter=dot`：145/145。
- `pnpm -C packages/web typecheck`：通过。
- `pnpm -C packages/web build`：通过；仅有既存 chunk size warning。
- `pnpm -C packages/web test:e2e`：15/15，含 1440x900 与 390x844 来源截图。
- `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book pnpm -C apps/desktop package:windows`：从 detached `a0d7a48` 通过 plugin release parity、Web production build、compiled sidecar smoke、Rust release 与 NSIS。
- NSIS 原始产物、detached export 和主工作区 `dist/UnderstandBookSetup.exe` 三份一致：35,462,929 bytes，SHA-256 `210D2CCE3C3BA2130DA433A7C4D85990A422F71B5164299E33D3B02147E7FCEF`；file/product version `0.1.0`，未签名，未启动安装器。
- 真书重放：cardiac-splicing LID `2.26.2` -> `legacy_source_eb0bb55a08248e06`，标签“正文 · Abstract”，上下文 175 词；重启 ref/evidence 稳定，history/base/source 未改。
- 静态审计：普通 Agent 模板无 `questionQuote.lid`/`askDraft.lid`/history raw anchor 插值；AgentAnswer 三个生成类型无 LID/range/anchor；`git diff --check` 通过。
- `cargo fmt --check` 未作为绿门禁：`crates/server/src/lib.rs` 存在本切片外的既有 rustfmt 差异；本轮只手工格式化新增区域，未扫动用户改动。

## 本轮文件边界

来源功能主要触达：

- `CONTEXT.md`
- `docs/adr/0086-runtime-owned-user-visible-source-references.md`
- `docs/切片方案-Agent对话用户可见来源.md`
- `docs/architecture.md`
- `docs/代码链路.md`
- `docs/screenshots/agent-source-desktop.png`
- `docs/screenshots/agent-source-mobile.png`
- `crates/read-tools/src/lib.rs`
- `crates/runtime/src/orchestrator.rs`
- `crates/server/src/lib.rs`
- `crates/server/src/host.rs`
- `crates/server/scripts/smoke-agent-source-real-book.mjs`
- `packages/web/src/api.ts`
- `packages/web/src/App.vue`
- `packages/web/src/components/RightRail.vue`
- `packages/web/src/components/RightRail.test.ts`
- `packages/web/src/agent-note-selection.test.ts`
- `packages/web/src/generated/AgentAnswerPart.ts`
- `packages/web/src/generated/AgentAnswerSource.ts`
- `packages/web/src/generated/AgentAnswerView.ts`
- `packages/web/src/generated/OuterOutcome.ts`
- `packages/web/agent-source-visual.html`
- `packages/web/src/agent-source-visual.ts`
- `packages/web/src/agent-source-visual.css`
- `packages/web/playwright/agent-source.spec.ts`
- `dist/UnderstandBookSetup.exe`（本地忽略产物，不进入 Git 提交）

其他已修改/未跟踪文件多数属于用户先前工作、自动构建或测试日志；尤其 memory/profile/reader/base-schema、NP0 文档、大量 `.tmp-*` 与资料文件，不得归入来源功能或恢复。

## 下一步

本目标没有剩余实现或打包项。下一会话只需：

1. 用 `git log -3 --oneline` 确认功能提交与发布记录提交；除非源码再次变化，不要重复构建 Setup。
2. `main` 尚未 push；只有用户明确要求时才推送。`dist/UnderstandBookSetup.exe` 受 `.gitignore` 管理，不会随 push 发布。
3. 若继续 Note placement，重新读取 ADR-0083 与对应切片；不要把它和已完成的来源 SR 混成一个提交。
