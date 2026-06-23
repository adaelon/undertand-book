# SESSION_CHECKPOINT — 2026-06-23(S7 已 push,下一步 S8)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`4b150e2`(S7:reader.* 闭环四动作 + memory 抽独立 crate + ADR-0027)。本 checkpoint 是其后的刷新 commit;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0–S7 完成并 push**。S7=命令优先阅读器 + 闭环四动作(三子切片全绿 + 真跑兑现闭环判据):
- **S7a** memory 从 runtime 抽独立 crate `crates/memory`(纯重构;拆 `runtime↔reader` 循环依赖 + 兑现记忆层独立地位)。
- **S7b** 新 crate `crates/reader`:gotoLid/scroll/highlight/note/state 返 effect、**叶序滑动窗口** viewport、note/highlight 委托 memory.save、render 读 memory.recall 画标注(**标注单源=记忆层**)。
- **S7c** reader 五工具接进外层 orchestrator + book.manifest 移出(token 炸弹)+ prompt 强化;FakeAdapter 脚本化闭环测 + 真实 glm-5.1 端到端验。
下一步 **S8**(金标准集 + 验收闸,切片0 收尾)。

## 下一步(可直接接手)
1. 起 **S8**:建小而稳人工金标准集(问→期望 citation LID)+ 结构红线闸(确定性校验 citations 全真 LID,无悬空)+ 语义质量人工评 + 人工试读。读 `docs/切片方案-切片0样板间.md` S8 + `docs/adr/0004`(引用红线分层)+ 体检 §11。
2. 选址:金标准集 + 闸放 `crates/runtime` 新 bin/test 或独立脚本;消费 `runtime::orchestrator::run`(外层)或 `runtime::query`(内层)对真基座 `.understand-book/game-programming-patterns` 跑。
3. 跑完回填实测数字 → 各 ADR「何时回头」:语义质量阈值/金标准集规模(0004)、max_turns/token_budget(0016)、DEFAULT_RADIUS 叶序窗口(0027);**命令面契约冻结为基线**(V3 §6,切片0 完成充要)。

## 未提交 / 未完成
- 无(S7 代码 5 crate + ADR-0027 + 代码链路 + 架构 + 本 checkpoint 已 push 至 `4b150e2` 及其后刷新 commit)。
- 真跑副产临时 memory 隔离在 scratchpad(非 repo);`UB_TRACE=1` 开外层 loop 诊断 trace。
- 占位待 S8 回填:DEFAULT_RADIUS=3 / max_turns=12 / token_budget=120k;不给明确 LID 时定位语义(book.query/concept 探索收敛)与 reader 闭环正交。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 crate 依赖拓扑。
2. `docs/切片方案-切片0样板间.md` — S8=金标准集+验收闸(下一刀,切片0 收尾)+ §5 总判据。
3. `docs/代码链路.md` — S0–S7 改动账本(末条 S7)。
4. `docs/adr/` — `0027`(reader 落地+memory 拆 crate+viewport)、`0026`(外层 loop)、`0016`(双层 loop)、`0015`(reader/memory/error 命令面)、`0004`(引用红线,S8 用)。
5. `crates/{reader/src/lib.rs, runtime/src/orchestrator.rs, memory/src/lib.rs, runtime/src/lib.rs}` — reader core / 外层 loop+reader 接入 / 记忆层 / 内层 query。
6. `需求文档-V3.md` §4.2(reader.*)+ §6(切片0 总判据 + 契约冻结基线)。

## 本会话决策摘要
- **ADR-0027**(S7 落地):reader 落独立 crate + memory 从 runtime 抽独立 crate(拆 `runtime↔reader` 循环依赖,crate 强制 DAG)+ viewport=叶序滑动窗口 + reader.note/highlight 委托 memory·render 读 recall(标注单源)+ 真跑回填(book.manifest 移出外层=token 炸弹防护 / prompt 强化引导调 reader)。已 glm-5.1 真跑兑现闭环判据(turn1 highlight+note → turn2 终答,锚回真 LID 11.18.2)。
