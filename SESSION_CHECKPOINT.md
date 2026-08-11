# SESSION_CHECKPOINT — 2026-08-11 21:08 +08:00

## 新鲜度自检

- 写入时最新 commit: `830262c fix(build): close policy-scoped retry recovery`。
- 读入时请对比 `git log --oneline -3` 与 `git status --short`；若不一致，以 Git 与工作树为准。
- 当前分支 `main`；GR0-GR4 全部差异仍未提交，无 staged changes。

## 当前在做什么

“主动带读首轮路由闭环”GR0-GR4 已实现并通过真实书/真实 Provider 发布门；当前产物可审查、可选择性暂存，未执行 commit。

## 下一步（可直接接手）

1. 运行 `git diff -- CONTEXT.md crates/runtime/src/agent_prompt.rs crates/runtime/src/lib.rs crates/runtime/src/orchestrator.rs crates/runtime/src/tool_exposure.rs docs/代码链路.md docs/架构.md SESSION_CHECKPOINT.md`，并单独审阅 untracked `guided_read_replay.rs`、ADR-0104 与本切片方案。
2. 如需复跑真模门，设置 `UB_GUIDED_READ_REAL_BOOK_DIR=.understand-book/z-library-sk-1lib-sk-z-lib-sk`、`UB_GUIDED_READ_EXPECTED_STOP_LID=1.8.2`，执行 `cargo test -p runtime guided_read_real_provider_replay -- --ignored --nocapture`。
3. 获得提交授权后，只显式暂存下方 GR0-GR4 文件；不要使用 `git add .` 或混入受保护差异/其他 untracked 资产。
4. 若要处理 Runtime 唯一红测，另开切片调查 `search_text_real_book_first_all_and_layered_routing_replay` 的真实书首 LID 漂移，不得并入 GR4。

## 未提交 / 未完成

- GR0-GR4 文件：`CONTEXT.md`、`crates/runtime/src/{tool_exposure,agent_prompt,lib,orchestrator,guided_read_replay}.rs`、ADR-0104、本切片方案、`docs/代码链路.md`、`docs/架构.md`、本 checkpoint。
- GR4 回执/verifier 4/4、`agent_tool_policy` 11/11、`resident_navigation_policy` 1/1、`guided_read` 8/8；真模 ignored 门单独执行 1/1。
- 真模证据：Native `deepseek-v4-flash` / `resident-agent-default-v1`，唯一 `Goto(1.8.1→1.8.2)`；回执 `target/guided_read_route_replay.v1.json` 为 6363 bytes，SHA-256 `7c039ccd3856a7e0eb5b42ea8be29f2916c1397ac44fdd552d982d5d2d5568af`。
- Runtime 全量为 251/252（另 1 ignored）；唯一失败仍是既有真实书 search fixture 首 LID 漂移（实际 `1.9.3.10`、冻结期望 `1.10.3.10`）。
- 既有受保护 tracked 差异：`crates/base-schema/tests/roundtrip.rs`、`crates/memory/src/profile.rs`、`crates/memory/src/review.rs`、`crates/runtime/src/profile_api.rs`、`docs/切片方案-切片1前端阅读器.md`、`docs/预购建流程.md`。
- handoff、日志、executor-private、书籍、临时构建目录及其他 untracked 资产均不属 GR0-GR4；不得删除、重置、改写或批量暂存。

## 冷启动读序

1. `docs/切片方案-主动带读首轮路由闭环.md` 全文，重点 §9-§10 — GR4 契约、真模 red→green 与发布硬门。
2. `docs/adr/0104-intent-seeded-guided-reading-tool-exposure-and-resident-navigation-policy.md` 全文 — 首轮能力、Resident/MCP 与副作用边界。
3. `crates/runtime/src/guided_read_replay.rs` 全文 — closed 回执、Native/ReAct 投影证据与离线 verifier。
4. `crates/runtime/src/agent_prompt.rs::NAVIGATION`、`crates/runtime/src/orchestrator.rs::tests::guided_read_real_provider_replay` — navigation@v3 与真实发布门。
5. `docs/架构.md` 的 “Runtime Agent request governance [ADR-0091]”、`docs/代码链路.md` 最后的 GR0-GR4 记录；最后运行 `git status --short` 分离受保护差异。

## 本会话决策摘要

- `guided_read_route_replay.v1` 采用 64 KiB closed schema，只保存哈希、版本、工具/LID 摘要、路线成员、effect 与答案摘要（切片方案 §9）。
- 两次真模 red case 促成 `resident-agent.policy.navigation@v3`：结构步骤严格串行，且必须先读取与 Goto 相同的目标 LID；verifier 红线未放宽（切片方案 §9）。
- Native/ReAct 证据从同一首轮 `AgentRequestPlan` 派生；真实网络只跑配置的 Provider，另一协议保留无正文请求投影哈希。
