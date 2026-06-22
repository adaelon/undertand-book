# SESSION_CHECKPOINT — 2026-06-23(S3 + S3.5 完成 + 基座查看器;待 commit)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`8f4b9ef`(S3.5 小规模实测)。**本次 commit 落地 `show-base.ts` 基座查看器 + 本 checkpoint**;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0–S3 + S3.5 完成**,已用 `show-base.ts` 核验生成的 LID 树 + 知识图谱(4 窗口手抽基座)合理。下一步二选一:全书 64 窗 Pass1 实测(需 harness),或起 S4(Rust 读时服务)。

## 已完成
- **S0/S1/S2**(已 push):骨架+插件+schema;段级 LID 切分;窗口切分。
- **S3 确定性骨架**(已 push `f3e0802`):GraphEdge 补 direction(ADR-0023)、pass1-input、merge+闸、catalog、pass1 prompt、SKILL 编排。vitest 34+tsc+cargo 全绿。
- **S3.5 小规模 Pass1 实测**(已 push `8f4b9ef`):`pass1-batch.ts` + `fixtures/pass1-sample-4windows.json`(#9/#12/#14/#17 手抽)→ merge → 固化 `.understand-book/<id>/base.json`(zod 校验)。验证跨窗口 occurrences 合并(flyweight 跨 #12/#14)、闸零悬空、目录零幽灵。锚定率 55%(根因=非内容叶+召回,见 `docs/实测-S3小规模锚定率.md`,回填 ADR-0011)。
- **基座查看器**(本次 commit):`skills/build/show-base.ts`(tree / graph / concept 三模式),已核验 LID 树 Model A 结构 + 图谱(11 实体/12 概念/17 断言/26 边)锚定真实、跨章合并正确。

## 下一步(可直接接手,二选一)
**A. 全书 64 窗 Pass1 实测**(`[ADR-0010/0011]`,需 harness 供 LLM):
1. harness 内编排 `pass1-local-extractor`(5 并发)跑全 64 窗 → `Pass1Output[]`;`pass1-batch.ts` 已可消费多窗口结果 → merge+固化基座。
2. **锚定率按"可锚内容叶"分母重算**(先给叶子加内容/非内容标记,见 ADR-0011 何时回头)→ 定量 ≥90%?回填 ADR-0010/0011。
**B. 起 S4 — Rust 读时查询服务 + 叶子工具**(`[ADR-0014]`):
- `book.manifest/context(near)/text/concept` 读 `.understand-book/<id>/base.json`(S3.5 已产小基座可直接喂);字节精确 span(中文 UTF-16↔字节)在此精化。
- 建议先 B:对话内可推进、不烧 LLM 成本,小基座已就绪;A 的全量抽取更适合用户在 harness 内跑 `/understand-book:build`。

## 未提交 / 未完成
- 本次 commit 后无未提交。
- `.understand-book/` 基座 gitignore(生成物,由 fixture+pass1-batch 重建)。
- 全书 Pass1 锚定率定量 + 锚定率分母排除非内容叶(需扩 NodeKind)留下一刀。Pass2 切片0 砍。
- 窗口软闸/硬闸最终数字=占位(见 `docs/实测-S2窗口利用率.md`)。判据②插件命令识别待 `--plugin-dir` 实测。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0023。前端 PENDING。

## 工具链 & 实测要点
- node v24.9 / pnpm 10.34 / cargo 1.96;`.npmrc` `node-linker=hoisted`;CLI 传 Windows 盘符路径。
- 真书:`C:\Users\Lenovo\Downloads\游戏编程模式 ([美] Robert Nystrom 尼斯卓姆) (z-library.sk, 1lib.sk, z-lib.sk).epub`;小基座:`.understand-book/game-programming-patterns/base.json`。
- 命令:`pnpm -C packages/core test`(34)/ `... typecheck` / `cargo test -p base-schema`;split-lid(S1)/ window-cli(S2)/ pass1-smoke(S3 emit/verify)/ pass1-batch(S3.5)/ **show-base(查看基座:`<书> <base.json> tree <prefix>|graph|concept <name>`)**。
- **PowerShell 坑**:给脚本传逗号列表(窗口索引)必须加引号 `"9,12,14,17"`,否则逗号被当数组操作符 → NaN。
- schema 改字段:改 lib.rs → cargo test(重生成 TS,旧 fixture 先红)→ pnpm test(产新 fixture)→ cargo test 全绿。
- md-adapter 空行分段;合成测试用 `\n\n`。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md`(架构全景 + §6)。
2. `docs/切片方案-切片0样板间.md`(S0–S3 已实现;S4=读时叶子工具 Rust)。
3. `docs/代码链路.md`(S0–S3.5 改动账本)。
4. `需求文档-V3.md` / `CONTEXT.md`。
5. `docs/adr/0008/0009/0010/0011/0023`(0011 含 S3.5 锚定率回填)、`0014`(叶子工具=S4)、`0021`(技术栈)。
6. `docs/实测-S2窗口利用率.md` / `docs/实测-S3小规模锚定率.md`(两份实测根因)。
7. `memory/quality-over-speed-correct-context.md` / `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- ADR-0023:GraphEdge 补 direction(去重键)、排除 description(收窄 ADR-0010)。
- S3 merge 闸纯确定性收口:悬空丢不重建+最小连坐+按类型合并 occurrences。
- S3.5 实测:链路(合并/闸/基座)正确;**锚定率分母须排除非内容叶**(代码/链接/注),否则代码密集书天然达不到 90%——回填 ADR-0011,待全书实测落实。
