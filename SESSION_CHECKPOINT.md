# SESSION_CHECKPOINT — 2026-06-23(S4 完成:读时 Rust 叶子工具;待 commit)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`5c44a50`(show-base 基座查看器)。**本次工作 = S4(read-tools crate)+ ADR-0024 + 图谱/LID 导读文档,尚未 commit**;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0–S3.5 + S4 完成**。S4 读时 Rust 确定性叶子工具(headless 库+CLI)落地:`book.manifest/text/context(near)/concept` 消费小基座 + 旁路原文。下一步起 **S5**(book.query 内层 mini-loop + NativeAdapter)。

## 已完成(本会话新增 S4,三子刀)
- **S4a**:`pass1-batch.ts` 同固化 `source.txt`(原文旁路);修 `lib.rs` Span 注释口径(UTF-16 非字节)`[ADR-0024]`。
- **S4b**:新 crate `crates/read-tools`(库+CLI)。`book.manifest`(tree+stats_by_lid)/`book.text`(按 UTF-16 span 切真原文)。`text 11.18.4` 逐字 == TS 预览(跨语言一致)。
- **S4c**:`book.context(near)`(树邻接+local边,自指跳过,weight 降序,top-K)/`book.concept`(全量 occurrences+related_entities)。`ToolError` 信封禁降级。
- 全 workspace `cargo test` 全绿(17 = base-schema 11 + read-tools 6);vitest 34 + tsc 0。

## 下一步(可直接接手)
1. 起 **S5**:`book.query` 内层 mini-loop(确定性档位骨架捞 LID+真原文 → LLM 合一轮判停 → citations⊆证据集确定性验停)+ NativeAdapter。读 `docs/切片方案-切片0样板间.md` S5 + `docs/adr/0016`。
2. 选址:在 `crates/read-tools` 内加 query,或新建 crate;复用 `Book::{context_near,text,concept}` 当确定性检索骨架。
3. 先定 `ModelAdapter` trait:`complete(messages, tools?, schema?) → ParsedResponse`;NativeAdapter 对接推荐后端(Claude),provider key 留本地。

## 未提交 / 未完成
- 待 commit:`crates/read-tools/`、`docs/adr/0024-*`、`docs/导读-知识图谱与LID的关系.md`、改动(`pass1-batch.ts`/`base-schema/lib.rs`/`generated/Span.ts`/`Cargo.lock`)。
- `source.txt` 已 gitignore(`.understand-book/` 生成物,pass1-batch 重建)。
- near 默认 K=10 占位(待 S8 金标准集定);context mid/far + book.query + ReActAdapter 留 S5+/切片1+。
- 全书 64 窗 Pass1 锚定率定量仍留(需 harness)。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 技术栈。
2. `docs/切片方案-切片0样板间.md` — S5=book.query(下一刀)、S6/S7。
3. `docs/代码链路.md` — S0–S4 改动账本(末条 S4)。
4. `docs/导读-知识图谱与LID的关系.md` — 图谱/LID 关系导读(基座读法 + show-base 用法)。
5. `需求文档-V3.md` §4.1 / `CONTEXT.md`。
6. `docs/adr/0014`(book.* 叶子工具签名)、`0024`(S4 原文旁路+span口径+服务先库)、`0016`(S5 运行时)、`0011`(边作召回路标)。
7. `crates/read-tools/src/lib.rs` — S4 实现(`Book` + 4 工具);`memory/*`。

## 本会话决策摘要
- ADR-0024:book.text 原文 = 旁路 `source.txt`(不入 base schema);span = UTF-16 口径(修 lib.rs 注释矛盾);S4 服务先库+CLI、HTTP 推 S7。
- S4 验证:UTF-16 span 切原文跨 TS/Rust 逐字一致;context near 自指边跳过、按 weight 排序;concept 多锚 occurrences 完整。
