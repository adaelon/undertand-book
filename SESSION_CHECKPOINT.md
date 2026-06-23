# SESSION_CHECKPOINT — 2026-06-23(S5 已 push;下一步 S6)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`19ffd30`(S5:book.query 内层 + ModelAdapter/NativeAdapter + ADR-0025)。本 checkpoint 是其后的刷新 commit;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0–S5 完成并 push**。`book.query` 内层 mini-loop(确定性档位检索 + 合一轮 + 确定性交叉验停)+ `ModelAdapter` trait + `NativeAdapter`(读 `.env` OpenAI-兼容)落地,真实 glm-5.1 端到端验通(结构红线 100%)。下一步 **S6**(外层 E 编排 loop + 最小 memory)。

## 下一步(可直接接手)
1. 起 **S6**:外层 E 编排 loop(messages 会话态,LLM 自主调 `book.*`/`reader.*`/`memory.*`)+ 双重停机(`max_turns`+token 触顶标 incomplete)+ `memory.save/recall`(note/highlight/position,带 LID citation)。读 `docs/切片方案-切片0样板间.md` S6 + `docs/adr/0005/0016/0015`。
2. 选址:S6 外层 loop 进 `crates/runtime`,复用 `runtime::query` 当内层工具之一、复用同一 `ModelAdapter` trait + `NativeAdapter`。
3. 先定外层 tool 集映射(book.manifest/text/context/concept/query + memory.save/recall)→ messages 循环 → 双重停机闸。

## 未提交 / 未完成
- 无(S5 代码+ADR+代码链路已 push 至 `19ffd30`;本 checkpoint 为后续刷新 commit)。
- `.env` 含真实 key(gitignore);`.understand-book/` 生成物(gitignore)。
- scope 档检索体积上限 / chapter 真基座行为待 S8 金标准集 + 更多查询观察;多 provider/ReActAdapter 留切片1+。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 技术栈。
2. `docs/切片方案-切片0样板间.md` — S6=外层 E loop+memory(下一刀)、S7/S8。
3. `docs/代码链路.md` — S0–S5 改动账本(末两条 S5a/S5b)。
4. `docs/adr/` — `0016`(双层 loop 运行时)、`0025`(S5 query 内层落地 + S5b 真跑回填)、`0005`(E=书 agent)、`0015`(命令面/错误/memory 记录模型)、`0014`(命令面分层)。
5. `crates/runtime/src/lib.rs` — S5 实现(Scope / ModelAdapter / retrieve / query / NativeAdapter);`crates/read-tools/src/lib.rs`(4 叶子工具)。
6. `CONTEXT.md` / `需求文档-V3.md` §4.1–4.4。

## 本会话决策摘要
- **ADR-0025**:book.query 内层落地——选址新 crate `runtime`(模块 E)、`ModelAdapter` trait(`complete→ParsedResponse`)、scope 两档确定性(local/chapter,`NodeKind` 定位章)、合一轮 + 确定性交叉验停(`citations⊆证据集`)、触顶 incomplete。
- **S5b 真跑实测**(glm-5.1):`OUTPUT_CONTRACT` 的 `sufficient` 语义须显式澄清,否则 answer 错塞 model_supplement + 误判 incomplete + 过度外扩;调优后 answer 落位、local 收口、结构红线 100%。已回填 ADR-0025/0016。
