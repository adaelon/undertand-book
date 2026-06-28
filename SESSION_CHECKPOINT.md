# SESSION_CHECKPOINT - 2026-06-28 11:40

## Freshness check
- 最新 commit(写入时):a8fb858 PB3-5 Pass2 build orchestration + audit/candidate writeback(已 push origin/main)
- PB3 全切片已提交并推送。下一阶段切片是 PB4(未开工)。
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
PB3(Pass2 预构建编排 + audit sidecar)**已全部完成并 push**:PB3-1(契约+edge type 11 类)、PB3-2a/2b(候选生成 grill §11 四信号)、PB3-3(PB3 gate)、PB3-4(work packet+contracts+prompt)、PB3-5(pass1-batch 编排+写盘)。下一阶段切片是 PB4。

## Next steps (ready to hand off)
1. (可选)commit PB3-5(信息以 `PB3-5` 开头)。
2. **PB4 profile sidecar build smoke**(`docs/切片方案-profile深路径.md` PB4):构建输出目录同含 base.json/source.txt/profile_metadata/formula_semantics/discourse_index/pass2_audit;Rust `Book::load` + runtime `book.synthesize/context` 能消费;`book.context far` 能读到写回的 long_range 边;`cargo test` 侧加载同一 fixture 验证。这是预构建→读时端到端 smoke(PB3 判据里被 PB3「不做」推给 PB4 的那条 read-time 验证就在这)。
3. 评估 P1 旧 gate `pass2.ts:gateTechnicalLearningPass2LongRange` 是否退役(PB3 gate 已是更全的 `pass2-build.ts:gatePass2BuildOutput`)。
4. 不混 reader.*/memory./P7 MCP。

## Uncommitted / unfinished
- 无(PB3 全部已 commit + push;本 checkpoint 刷新随后单独提交)。
- 保持 untracked:`参考2.md`、`参考_discourse_prompt.md`、`参考pass2.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- `.understand-book/`:gitignore 生成物(PB3-5 smoke 覆写成 sample.md 小基座 + 全套 sidecar;需真书时用真 epub 重建)。

## Cold-start reading sequence
1. `docs/PB3-pass2-prompt-grill.md` - PB3 冻结设计(实现已对齐)。
2. `docs/切片方案-profile深路径.md` - PB0-PB4 + P1-P7 计划;PB4 是下一刀。
3. `docs/adr/0033-...technical-learning作为当前profile.md` - Core/Profile/Reader 边界。
4. `docs/代码链路.md` - 改动账本(含 PB2b、PB3-1..3-5)。
5. `packages/core/src/pass2-build.ts` - PB3 全部:候选生成 + gate + work packet + contracts。
6. `skills/build/pass1-batch.ts` - 预构建写盘全链(base/源/metadata/formula/discourse/candidates/pass2_audit)。
7. `packages/core/src/zod.ts` - 产出前自检 schema(含 PB3 audit)。
8. `crates/read-tools/src/lib.rs` - 读时 Book::load + context far(PB4 要让它消费新 sidecar)。

## 本会话决策摘要
- PB2b commit 0973b69;PB3-1..3-4 commit a1713e0/e294806/24f1d23。
- PB3-2 候选 join 算法 = shared-node 路线(grill §11 四信号),不加语义桥(读时 scope 外扩兜底)。
- PB3 长程边写盘:accepted 过 gate 才进 base.graph_edges;split evidence/support_level/rationale + pending/rejected/gate_dropped 仅进 pass2_audit.json。
- 阈值占位:`MIN_RELATION_CONFIDENCE=0.5`、`MAX_LOCAL_SUMMARY_LEN=200`(PB2b)、`MIN_LONG_RANGE_WEIGHT=0.5`(PB3),均待实测回填。
