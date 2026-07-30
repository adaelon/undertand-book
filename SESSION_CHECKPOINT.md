# SESSION_CHECKPOINT - 2026-07-30 08:35 +08:00

## 新鲜度自检

- 写入时最新提交:`e81e334 feat(notes): add explicit body placement`。
- 读入时运行 `git log --oneline -3`;若不同,以 Git 与工作区 diff 为准。

## 当前在做什么

AA0-AA11 已实现并完成发布面收口,代码与文档仍未提交;Blueprint Registry、V2 Plan/Instance gate、Reader 五形态、Resident/MCP current snapshot 读取和两本真书 release audit 已形成完整闭环。

## 下一步(可直接接手)

1. 运行 `Get-Content -Raw apps/desktop/scripts/smoke-artifact-access.mjs`,复核新增且尚未跟踪的 AA11 audit 脚本。
2. 运行 `git diff -- docs/切片方案-需求驱动产物Blueprint与Agent访问.md docs/架构.md docs/代码链路.md SESSION_CHECKPOINT.md`,复核 AA11 文档收口 diff。
3. 依据 `docs/代码链路.md` 的 AA1-AA11 触达清单生成显式 staging 文件列表,排除 NP0R-NP4、书籍、截图、日志、`.tmp-*` 与其他用户文件。
4. 若准备发布,以 `UNDERSTAND_BOOK_DESKTOP_EXE=<current UnderstandBook.exe>` 运行 `node apps/desktop/scripts/smoke-artifact-access.mjs`,并以 `UNDERSTAND_BOOK_MARKETPLACE_SOURCE=adaelon/undertand-book` 运行 `node apps/desktop/scripts/assert-release-config.mjs`。
5. 若准备提交,按 AA1-AA11 切片边界分别提交;不要把既有 Note-placement 工作混入。

## 未提交 / 未完成

- AA1-AA11:Core/Runtime/Server/Web/plugin/docs 与新增 `crates/artifact-tools/`、`apps/desktop/scripts/smoke-artifact-access.mjs` 全部实现、验证并完成文档收口,待显式 staging/commit。
- AA11 真书 audit:technical_learning `quantification-essence` 2757 LIDs、paper `understanding-transformer-from-the-perspective-of-reviewed-v2` 1981 LIDs;两书均 `release_gate=pass`,相关 Resident 各 5 回合/25 tokens/1 search/1 read/1 `book.text`/1 `source.present`,无关与禁用均 0 artifact 调用,最终 wall clock 280/3618 ms,MCP delete 前各 11 calls。
- AA11 异常矩阵:replan old ref=`ARTIFACT_REF_INVALID`;source stale=`INTENT_BUILD_CONFLICT`;delete/no-overlay=`ARTIFACT_OVERLAY_UNAVAILABLE`;Reader/Resident/MCP 均只读 current active + accepted,private goal/body 泄漏 0。
- 验证:Artifact Tools 15/15;Runtime 232/232 + integration 5/5(仅过滤已知真书 LID 基线);Server 220/220 + Book MCP 5/5;Web 37 files / 208 tests + typecheck/build;packaged parity、release-config、`cargo fmt --all -- --check`、`git diff --check` 全绿。
- Core 串行全量 535/538;剩余 3 条只有固定 wall-clock timeout 且无断言差异。dispatch/profile 冷跑已绿;handoff 仅 Node/tsx 冷启动约 5.34 s 超过既有 5 s。按 A2 未修改无关测试或门槛。
- 既有 NP0R-NP4 goal-owned 代码/文档仍未提交;边界见 `docs/切片方案-无引用Note显式正文放置.md` 与 `docs/代码链路.md` 的 NP1a-NP4。
- 其他书籍、截图、日志、临时目录及用户工作不属于 AA0-AA11,不得清理、覆盖或纳入提交。

## 冷启动读序

1. `docs/切片方案-需求驱动产物Blueprint与Agent访问.md` - FrozenIntent、AA0-AA11 状态、真书统计与发布判定。
2. `docs/adr/0094-codex-designed-artifact-blueprints-and-versioned-registry.md`、`docs/adr/0095-active-artifact-read-surface-and-book-mcp-boundary.md` 与 `CONTEXT.md` 的 Blueprint/目标产物术语。
3. `apps/desktop/scripts/smoke-artifact-access.mjs` - 两本真书、三消费面、异常矩阵与 audit JSON 的可复放权威。
4. `crates/artifact-tools/`、`crates/server/src/intent_build_store.rs::read_active_overlay_state`、Runtime `ArtifactToolSession` 与 MCP dispatch - current snapshot 执行链。
5. `docs/架构.md` 的 AA6-AA11 章节与 `docs/代码链路.md` 最后的 AA11 - 架构、隐私边界、运行统计和验证证据。
