# SESSION_CHECKPOINT — 2026-06-23(S6 已 push;下一步 S7)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`32244d2`(S6:外层 E 编排 loop + 最小 memory + ADR-0026)。本 checkpoint 是其后的刷新 commit;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0–S6 完成并 push**。S6=外层 E 编排 loop + 最小 memory(三子切片全绿):
- **S6a** memory 模块(`crates/runtime/src/memory.rs`):Record + save(内容寻址 upsert + citation 自动派生)+ recall(维度过滤)+ 用户级独立 JSON 落盘(物理隔离守 ADR-0006)。
- **S6b** 外层 loop(`orchestrator.rs`)+ `ModelAdapter::chat` + 双重停机(usage 口径)+ 工具错误回喂不降级 + FakeAdapter 双队列确定性测。
- **S6c** CLI `chat` 子命令 + 真实 glm-5.1 端到端人工验:10 轮多跳收敛、incomplete=false、memory note 锚回真 LID(结构红线兑现)。
下一步 **S7**(命令优先阅读器 + 闭环四动作)。

## 下一步(可直接接手)
1. 起 **S7**:headless `reader.*`(`gotoLid/scroll/highlight/note/openPanel/state` 返 effect),`note/highlight` **委托 memory.save**、渲染读 `memory.recall(anchor_lid)` 画标注(标注单一真相源=记忆层,防双所有者);最小 GUI 渲染层。读 `docs/切片方案-切片0样板间.md` S7 + `docs/adr/0007/0015`。
2. 选址:`reader.*` 进 `crates/runtime`(复用 `memory::MemoryStore`)或新 crate `reader`;effect 返回 `{ok, viewport/id/panel}`,`state()→{viewport,open_panels,selection}`。
3. 判据:agent 经命令面跑通「问→跳转→高亮→记笔记」一次闭环;标注单源=记忆层(无双所有者);effect 结构够 agent re-sync。

## 未提交 / 未完成
- 无(S6 代码 + ADR-0026 + 代码链路 3 条已 push 至 `32244d2`;本 checkpoint 为后续刷新 commit)。
- 真跑副产:`C:\Users\Lenovo\.understand-book\memory\memory.json`(1 条 note,用户级私有库,非 repo 内,gitignore 之外)。
- max_turns/token_budget 占位(12/120k),单次真跑 10/12 偏近上限,实测回填 ADR-0016 待 S8。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 技术栈。
2. `docs/切片方案-切片0样板间.md` — S7=reader+闭环四动作(下一刀)、S8。
3. `docs/代码链路.md` — S0–S6 改动账本(末三条 S6a/b/c)。
4. `docs/adr/` — `0026`(S6 外层 loop+memory 落地)、`0016`(双层 loop)、`0015`(reader/memory/错误命令面定型)、`0007`(阅读器命令优先·人机对称)、`0005`(E=书 agent)。
5. `crates/runtime/src/{lib.rs,orchestrator.rs,memory.rs}` — S5/S6 实现;`crates/read-tools/src/lib.rs`(4 叶子工具)。
6. `CONTEXT.md` / `需求文档-V3.md` §4.2(reader.*)+ §4.3(memory.*)。

## 本会话决策摘要
- **ADR-0026**(议题7 第三叉):外层 loop=原生 `tools/tool_calls`(NativeAdapter,砍 ReAct)+ `ModelAdapter` 同 trait 加 `chat`(complete 内层不动)+ 双重停机 `usage.total_tokens` 累加口径(无 usage 退 estimate 兜底)+ memory 用户级独立单 JSON 落盘(内容寻址 mem_id + note/highlight citation 自动派生)。已 S6c 真跑回填(glm-5.1 tools 稳、结构红线兑现)。
