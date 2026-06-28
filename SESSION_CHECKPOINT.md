# SESSION_CHECKPOINT - 2026-06-28 10:45

## Freshness check
- 最新 commit(写入时):0973b69 PB2b discourse extractor two-stage prompt + gate tightening
  - 上一条:cbc7e57 PB3 grill design freeze (docs only)
- PB3-1 已实现但**未 commit**(在工作区);PB3-2 待设计确认后开工。
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
PB3(Pass2 预构建编排 + audit sidecar)。已完成 PB3-1(候选契约 + edge type 扩 11 类 + cross-window helper)、PB3-2a(确定性候选生成 shared-node bridge,signal 4+1+2)。均**未 commit**。join 算法已与用户确认:shared-node 路线,不加语义桥(读时 scope 外扩兜底)。

## Next steps (ready to hand off)
1. PB3-2b:signal 3 formula 桥(FormulaSemantics 定义/使用跨窗口)→ 补进 `buildLongRangeCandidates` 或独立函数;走 formula_semantics.context_links,不与节点 occurrence 混。
2. PB3-3 PB3 gate(split evidence、support_level≠weak_inference、cross-window 硬校验)+ audit 类型(grill §7/§8/§9);现有 `pass2.ts:gateTechnicalLearningPass2LongRange` 是 P1 简版,需扩/新建。
3. PB3-4 work packet(grill §10)+ Pass2 prompt 更新(默认拒绝 + edge type contract,grill §5/§13)。
4. PB3-5 `pass1-batch` 编排:写回 base long_range 边 + `pass2_audit.json` + build-only `long_range_candidates.json`(grill §2/§3)。
5. 不混 reader.*/memory./PB4 smoke/P7 MCP。

## Uncommitted / unfinished
- `packages/core/src/pass2.ts`:edge type 扩 11 类 + 导出列表(PB3-1,未 commit)。
- `packages/core/src/pass2-build.ts`:候选契约 + cross-window helper(PB3-1)+ `buildLongRangeCandidates`(PB3-2a),未 commit。
- `packages/core/test/pass2-build.test.ts`:11 测(PB3-1 6 + PB3-2a 5,已绿,未 commit)。
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
