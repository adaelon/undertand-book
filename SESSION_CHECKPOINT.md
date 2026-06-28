# SESSION_CHECKPOINT — 2026-06-28 (反馈信号 grill 收敛 + ADR-0036 落档)

## 新鲜度自检
- 写入时最新 commit: f56b541 C4 checkpoint: PB3 complete, next is PB4
- 本会话**未 commit**:改动全在工作区(下方「未提交」)。读入时对比 `git log -1`,不一致以 git 为准。

## 当前在做什么
设计线:把 route 两投影带读补全。本会话 grill 关闭 **OPEN①「反馈信号」** 并落档 **ADR-0036**(显式 NL 主信号 / 导航·讲法二维 / 结构兜底消歧 / 人访客两投影 / viewport 模式分裂)。设计仅落档,**零代码**。

## 下一步(可直接接手)
1. **(设计)续 grill OPEN②**:route 命令面落点 + 命名(`book.route`? 还是 runtime 内部不暴露?)。照 §0.5 一次一问 + 带推荐答案。
2. **(设计)续 grill OPEN③**:route_to / book_guide / 访客会话 归 P7/P8 的精确边界(谁在 Core、谁在 server、谁在 policy)。
3. **(代码,设计稳后可起)**从 **P8 route Core** 起:在 `crates/read-tools/src/lib.rs:Book::context`(L472)之上加 `route_from(at)`,返 5 类导航分组 `back/forward/concretize/cross/continue`,`edge_type→类别` 固定映射表,组内 weight×距离 排序,cargo test 确定性覆盖。再 P3 人带读 / P7 访客向导。
4. **(正交代码)PB4** profile sidecar build smoke 仍是独立未做 CODE 刀,与本设计线正交。

## 未提交 / 未完成
- 新增:`docs/adr/0034-*.md`、`docs/adr/0035-*.md`、`docs/adr/0036-*.md`(本会话新增 0036)。
- 已改:`CONTEXT.md`(+反馈信号/导航轴·讲法轴)、`docs/切片方案-profile深路径.md`(§1.5.9+P3+P7)、`docs/代码链路.md`(+ADR-0036 条目)、本 checkpoint。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 全部待 commit。**零代码改动**(未跑 cargo/pnpm)。

## 冷启动读序
按序读可还原本设计线全局:
1. `docs/adr/0034-route导航原语-...md` — route 机制 + 两投影(6 决策)。
2. `docs/adr/0035-book-mcp访客会话-...md` — 住户/访客 + 三类记忆 + 连接式会话。
3. `docs/adr/0036-反馈信号模型-...md` — 反馈信号 5 决策(本会话新增)。
4. `docs/切片方案-profile深路径.md` §1.5.9 + P3/P4/P7/P8 — 契约 + 切片落点。
5. `docs/代码链路.md` 末两条(ADR-0034/0035、ADR-0036 落档)— 含余下 OPEN②③。
6. (代码接手才需)`crates/read-tools/src/lib.rs:Book::context`(L472)— route_from 架在它上。

## 本会话决策摘要(ADR-0036 五条)
- D1 显式 NL 提问=唯一主信号(viewport 弱旁路 / memory 慢先验 / quiz 留后)。
- D2 反馈意图二维:导航轴→route 5 类 / 讲法轴→policy;开放 NL 不立闭集词表,agent 据语义定 `{轴+类别+target}`。
- D3 裸"没懂"消歧=`route_from.back ∩ 未读前置` 结构收窄 + 可撤销提议 + 二次信号升级,不靠 LLM 神判。
- D4 人/访客同骨架两插槽(历史来源 ②/③、讲法整形 reader_profile/无)+ 终裁者不同。
- D5 viewport 偏离随模式分裂:默认 turn-based=静默 re-sync(rebase `at`,不问)/ 巡航 opt-in=中断信号(停+问)。
