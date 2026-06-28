# SESSION_CHECKPOINT - 2026-06-28 10:45

## Freshness check
- 最新 commit(写入时):0973b69 PB2b discourse extractor two-stage prompt + gate tightening
  - 上一条:cbc7e57 PB3 grill design freeze (docs only)
- PB3-1 已实现但**未 commit**(在工作区);PB3-2 待设计确认后开工。
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
PB3(Pass2 预构建编排 + audit sidecar)。已完成 PB3-1/2a/2b/3/4(契约+候选生成 grill §11 四信号+PB3 gate+work packet/edge contracts/prompt 重写)。已 commit 到 e294806(含 PB3-1/2a/2b/3);**PB3-4 未 commit**。仅剩 PB3-5 编排接线。

## Next steps (ready to hand off)
1. (可选)commit PB3-4(信息以 `PB3-4` 开头)。
2. PB3-5 `pass1-batch.ts` 编排(最后一刀):
   a. 装配 `Pass2WorkPacket`(注入源窗口正文/title_path,用 `EDGE_TYPE_CONTRACTS`);
   b. `buildLongRangeCandidates(...)` → 写 build-only `long_range_candidates.json`(不被 Book::load 读);
   c. 读 Pass2 subagent 输出(像 pass1 那样用 fixture/手抽)→ `gatePass2BuildOutput` → 把 accepted 的 `GraphEdge(scope=long_range)` 合并进 `base.json.graph_edges` + 写 `pass2_audit.json`;
   d. zod 自检新 sidecar(`Pass2BuildAuditSidecarZ`、`LongRangeCandidateIndexZ` 视需要补 zod.ts);
   e. CLI smoke + C2/C4。
3. 不混 reader.*/memory./PB4 smoke/P7 MCP。

## Uncommitted / unfinished
- `packages/core/src/pass2-build.ts`:`EDGE_TYPE_CONTRACTS` + `Pass2WorkPacket`/`CandidateNodeSnapshot`(PB3-4),未 commit。
- `agents/pass2-longrange-linker.md`:重写为 PB3 candidate-driven prompt(PB3-4),未 commit。
- `packages/core/test/pass2-build.test.ts`:17 测(+PB3-4 2,已绿,未 commit)。
- `docs/代码链路.md`、`SESSION_CHECKPOINT.md`:已更新(未 commit)。
- 保持 untracked:`参考2.md`、`参考_discourse_prompt.md`、`参考pass2.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- `.understand-book/`:gitignore 生成物(PB2b smoke 覆写成 sample.md 小基座,需真书时重建)。

## Cold-start reading sequence
1. `docs/PB3-pass2-prompt-grill.md` - PB3 冻结设计(candidate/gate/packet/audit,实现前必读)。
2. `docs/切片方案-profile深路径.md` - PB0-PB4 + P1-P7 计划。
3. `docs/adr/0033-...technical-learning作为当前profile.md` - Core/Profile/Reader 边界。
4. `docs/代码链路.md` - 改动账本(含 PB2b、PB3-1)。
5. `packages/core/src/pass2.ts` - P1 gate + 11 类 edge type。
6. `packages/core/src/pass2-build.ts` - PB3 build-only 候选契约 + cross-window helper。
7. `packages/core/src/discourse-index.ts` - discourse gate(PB2b 收紧,candidate builder 信号源)。
8. `packages/core/src/window.ts` - Window.leafLids(lidToWindowIndex 来源)。

## 本会话决策摘要
- PB2b 已 commit(0973b69);范围含 gate 收紧(B2 兜底硬线)。
- PB3 拆 5 子刀(PB3-1..PB3-5);PB3-1 完成。
- PB3-2 join 算法待确认(见 Next steps 1),不在代码里擅自发明候选配对逻辑。
