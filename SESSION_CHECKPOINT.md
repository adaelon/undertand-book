# SESSION_CHECKPOINT — 2026-06-22(S3 确定性骨架完成;待 commit)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`bec73fc`(S2 窗口切分)。**S3 全部改动随本次 commit 落地**;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0+S1+S2 已 push;S3(语义边两遍抽取的确定性骨架)已完成、待 commit**。下一步二选一:S3 收尾(全书真实 Pass1 抽取实测)或起 S4(Rust 读时服务)。

## 已完成
- **S0/S1/S2**(已 push):骨架+插件+schema 链路;段级 LID 切分;窗口切分(双约束预算)。
- **S3 确定性骨架**(待 commit,`[ADR-0010/0011/0023]`):
  - `base-schema`:`GraphEdge` 补 `Direction`(directed/undirected,去重键),**不补 description**(ADR-0023 收窄 ADR-0010);direction 贯通 Rust→TS→zod→sample→fixture。
  - `pass1-input.ts`:Window→每段前缀 `[LID]` 标注的抽取输入(回填红线物理前提)。
  - `merge.ts:mergeAndGate`:按类型合并 occurrences + 确定性闸(悬空丢不重建+最小连坐)+ 边去重(undirected 规范化)+ 可观测报告(锚定率)。
  - `catalog.ts:projectCatalog`:全局目录确定性投影(零幽灵)。
  - `agents/pass1-local-extractor.md`:真实 prompt 填实;`SKILL.md` 编排第 2–5 段指向真实模块。
  - 闸:vitest 34 例全绿(新增 pass1-input 4+merge 9+catalog 4)+ tsc 0 + cargo 11(ts_fixture 零失配)。
  - **小样真实抽取 smoke**:窗口 #12(18 段)抽 13 节点/8 边 → 回填红线窗口外 LID=0、闸后全留、目录零幽灵 ⇒ 链路打通。

## 下一步(可直接接手,二选一)
**A. S3 收尾 — 全书真实 Pass1 抽取实测**(`[ADR-0010/0011]`,需 harness 供 LLM):
1. `skills/build/pass1-smoke.ts emit` 已可逐窗口产抽取输入;扩成批量编排 64 窗口(5 并发 subagent `pass1-local-extractor`)→ 收集 `Pass1Output[]`。
2. `mergeAndGate(outputs, lidNodes)` → 图谱锚定率(目标 ≥90% V3 §7.2)+ 悬空丢弃率实测 → 回填 ADR-0010/0011「何时回头」。
3. 固化 `.understand-book/`(产物写盘,LidNode 表+图谱+目录)。
**B. 起 S4 — Rust 读时查询服务 + 确定性叶子工具**(`[ADR-0014]`,语言切到 Rust):
- `book.manifest/context(near)/text/concept`,读 `.understand-book/` 基座;字节精确 span(中文 UTF-16↔字节)在此精化。

## 未提交 / 未完成
- **S3 全部改动未 commit**(代码+测试+prompt+SKILL+ADR-0023+文档,自测全绿)。
- 全书 Pass1 锚定率实测 + `.understand-book/` 写盘留下一刀(上 A)。Pass2 长程边切片0 砍、留切片1+。
- 窗口软闸/硬闸最终数字 = 占位(12000/80),待 Pass1 质量实测后定(见 `docs/实测-S2窗口利用率.md`)。
- 判据②(`/understand-book:build` 插件命令识别)待用户 `--plugin-dir` 实测。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0023。前端 PENDING。

## 工具链 & 实测要点
- node v24.9 / pnpm 10.34 / rustc·cargo 1.96;`.npmrc` `node-linker=hoisted`(Windows 无符号链接)。
- CLI 传 Windows 盘符路径(`C:/...`),勿 `/c/...`。真书:`C:\Users\Lenovo\Downloads\游戏编程模式 ([美] Robert Nystrom 尼斯卓姆) (z-library.sk, 1lib.sk, z-lib.sk).epub`。
- 命令:`pnpm -C packages/core test`(34)/ `... typecheck` / `cargo test -p base-schema` / split-lid(S1)/ window-cli(S2)/ pass1-smoke(S3)。
- schema 改字段流程:改 `base-schema/lib.rs` → `cargo test`(触发 ts-rs 重生成,旧 fixture 会先红)→ `pnpm -C packages/core test`(产新 fixture)→ `cargo test` 全绿。
- md-adapter **空行分段**;合成测试用 `\n\n`。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md`(架构全景 + §6)。
2. `docs/切片方案-切片0样板间.md`(S0–S3 已实现;S4=读时叶子工具 Rust)。
3. `docs/代码链路.md`(S0–S3 改动账本)。
4. `需求文档-V3.md` / `CONTEXT.md`。
5. `docs/adr/0008`(切分)、`0009`(窗口,含实测)、`0010`(两遍抽取)、`0011`(确定性闸)、`0023`(GraphEdge 字段定型)、`0014`(叶子工具=S4)、`0021`(技术栈)。
6. `docs/实测-S2窗口利用率.md`(窗口预算根因)。
7. `memory/quality-over-speed-correct-context.md` / `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- ADR-0023:GraphEdge 切片0 字段补 `direction`(去重键)、**排除 description**(读时/merge 均不用,收窄 ADR-0010)。
- S3 终点 = 确定性骨架 + 小样真实抽取;全书锚定率实测另起一刀(省成本、先焊确定性)。
- merge 闸 = 纯确定性收口、无 LLM reviewer;悬空丢不重建 + 最小连坐 + 按类型合并 occurrences(守 ADR-0011)。
