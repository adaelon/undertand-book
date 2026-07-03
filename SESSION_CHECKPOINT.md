# SESSION_CHECKPOINT - 2026-07-03 02:35

## Freshness check
- Commit at write time: `a6e82c1 fix(web): highlight cross-lid quote sources`
- On read, compare with `git log --oneline -3`; if different, trust git log.

## What's in progress
S13l/S13m agent 对话历史已实现但未提交: resident agent 按 `book_id` 保存可恢复历史会话;RightRail 用 History pill 打开 modal,展示每个历史会话的问题、提问 anchor LID,并提供 Goto/Open/Delete。

S13n 前端视觉切片已实现但未提交: 主页面风格以 `DESIGN-mintlify.md` 为准,保持三栏文档工具密度、black/mint/hairline 体系;细节借 `DESIGN-apple.md`,包括 off-white canvas、frosted topbar/rails/modal backdrop、44px 关键触控目标、蓝色 focus ring、按钮按压反馈。显式 `letter-spacing` 已收回到 0。

## Next steps (ready to hand off)
1. Review `git diff -- CONTEXT.md crates/runtime/src/lib.rs crates/runtime/src/orchestrator.rs crates/server/src packages/web/src docs SESSION_CHECKPOINT.md`.
2. Stage the modified tracked files for S13l/S13m/S13n only.
3. Commit with a message such as `feat(agent): persist chat history`.
4. Optional browser smoke: start server/web, send two chats, New, History modal -> Goto old anchor -> Open old chat -> Delete; also check topbar/rails/reader/history/note modal visual consistency.

## Uncommitted / unfinished
- Modified: `CONTEXT.md`, `crates/runtime/src/lib.rs`, `crates/runtime/src/orchestrator.rs`, `crates/server/src/{lib.rs,main.rs,mcp.rs,bin/book_mcp.rs}`, `packages/web/src/{api.ts,App.vue,components/RightRail.vue,style.css}`, `docs/adr/0030-...md`, `docs/代码链路.md`, `SESSION_CHECKPOINT.md`.
- Verification passed: `cargo test -p server`; `npm run --prefix packages/web typecheck`; `npm run build` in `packages/web`; `git diff --check` has only LF/CRLF warnings.
- Verification known red: `cargo test -p runtime` still has the two pre-existing viewport effect failures: `guided_read_one_stop_pipeline`, `agent_viewport_change_merges_into_single_goto_effect` (48 passed in prior run).
- Unrelated untracked files intentionally untouched: `.fluid/`, `DESIGN-apple.md`, `agent交互书.md`, `docs/预购建流程.md`, `grill.md`, `packages/web/vite-dev.log`, `server-stdout.log`, `server-stderr.log`, `todo.md`, `参考*.md`.

## Cold-start reading sequence
1. `CONTEXT.md` - `agent 对话历史` and `读时会话边界`.
2. `docs/adr/0030-e-agent阅读器形态-外层入口-reader双向共享-可撤销提议-session层提议-idle会话边界-精炼上下文.md` - S13l 落地回填.
3. `crates/server/src/lib.rs` - `AgentHistory`, summary turns, `/agent/history*`, `/agent/chat`, `/agent/new`, server tests.
4. `packages/web/src/api.ts` - Agent history summary types.
5. `packages/web/src/App.vue` and `packages/web/src/components/RightRail.vue` - history restore/select/delete, modal UI wiring, note/modal visual shell.
6. `packages/web/src/style.css` - S13n global Mintlify/Apple styling.
7. `docs/代码链路.md` - S13l/S13m/S13n entries.

## 本会话决策摘要
- S13l agent 对话历史: history 是 resident agent 的本地私有 UI 会话恢复层,保存 transcript + messages;不写 memory,不进 citation/reader_profile,不暴露给 visitor/MCP。
- S13m 历史入口: RightRail 不用原生 select,改为 History pill + modal;每轮历史问题必须显示 anchor LID 并提供 Goto。
- S13n 前端风格: Mintlify 是主页面骨架和信息密度;Apple 只用于细节质感和交互反馈。没有改 agent/history/note 的业务语义。
