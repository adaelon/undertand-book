# SESSION_CHECKPOINT - 2026-06-25 18:10

## Freshness check
- Commit at write time: 296b77a feat: gate formula semantics evidence
- On read, compare with `git log -3`; if different, trust git log.

## What's in progress
ADR-0033 Core/Profile/Reader 解耦与 `technical_learning` profile 深路径方案已落档待提交;下一刀建议从 `docs/切片方案-profile深路径.md` 的 P1 `technical_learning.pass2_longrange_v1` 开始 Grill/实现。

## Next steps (ready to hand off)
1. Commit and push `docs/adr/0033-*`, `docs/切片方案-profile深路径.md`, `docs/代码链路.md`, and this checkpoint.
2. For implementation, open `docs/切片方案-profile深路径.md` and start P1 scope declaration before editing code.
3. Cross-check P1 against `docs/adr/0010-*`, `docs/adr/0011-*`, `docs/adr/0013-*`, and `docs/adr/0016-*`.
4. Keep SA6 asset true-book validation separate unless the user explicitly merges the tracks.

## Uncommitted / unfinished
- 当前 Windows sandbox 的 apply_patch 写入会触发 codex-windows-sandbox-setup.exe 模块错误;本会话后续写文件改用 PowerShell 写入。
- ADR-0033 docs and code-trail entry are pending commit.
- `参考2.md` is user-provided source material and remains untracked unless the user asks to version it.
- SA6 remains unstarted.

## Cold-start reading sequence
1. `docs/adr/0033-core-schema-book-profile-reader-profile解耦-technical-learning作为当前profile.md` - Core/Profile/Reader boundaries.
2. `docs/切片方案-profile深路径.md` - P0-P6 execution plan; P1 is the next implementation candidate.
3. `docs/adr/0010-语义边两遍抽取-双agent-硬屏障-全量目录优先-确定性投影-锚定基数分裂.md` - Pass2 original contract.
4. `docs/adr/0011-确定性图谱闸-纯确定性收口-悬空丢不重建-最小连坐-按类型合并-边作召回路标.md` - Core gate rules.
5. `docs/adr/0017-query-synthesize签名分工-输入形态分工-synthesize确定性分批归并-复用query响应骨架.md` - synthesize deep path contract.
6. `docs/代码链路.md` - latest touched-symbol ledger.

## Decisions made this session
- Core owns LID/citation/book.* /reader.* /memory.* invariants; profile cannot alter them.
- Current Book Profile is `technical_learning`; GraphNode envelope migration is deferred.
- Pass2 is now designed as `technical_learning.pass2_longrange_v1` with audit sidecar.
- `book.synthesize` stays a Core command but consumes technical_learning policy and optional reader_profile style.
- reader_profile is Layer 3 of memory consolidation, not a book-base field or citation source.
