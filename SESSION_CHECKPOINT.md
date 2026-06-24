# SESSION_CHECKPOINT — 2026-06-24(E agent 阅读器形态 §0.5 落档·ADR-0030;两条切片1+ 刀待挑)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`c68f183`(ADR-0030 E agent 阅读器形态落档)。**本 checkpoint 随其后一个小 commit 提交**。
- 读入时对比 `git log -3`,以 git log 为准。
- ⚠️ 工具坑(见 memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`(否则沙箱隔离、commit 不落盘);中文文件名勿用 Bash。

## 当前在做什么
切片0 **完成 + 契约冻结基线 v1**(V3 §6.1)。两条并列的切片1+ 刀,均 §0.5 已落档、未开工:
1. **前端阅读器**(Vue+localhost,ADR-0028 **+ ADR-0030 agent 形态**)— S10a–S10g。
2. **asset 一等对象**(代码块/表/图,ADR-0029)— SA1–SA5。
两刀互不混入。**优先级未定,下次开工前先与用户确认挑哪条;默认主线 = 前端 S10a。**

## 下一步(可直接接手,二选一)
- **前端 S10a**:新建 `crates/server`(tiny_http、`Mutex<AppState{book}>`)+ `book.*` 四叶子→GET + 错误透传 §4.4 信封 + 给 `QueryResponse/Citation/ToolError` 补 `#[derive(TS)]` 导出 `packages/web`。判据:`cargo test -p server` 绿 + curl 各 GET 正确 + ts-rs 生成。(agent 形态在 S10f/S10g,靠后)
- **asset SA1**:`base-schema::NodeKind` 增 `Code/Table/Image` + `read-tools::ManifestNode` 加 `kind` + ts-rs 重生成。判据:`cargo test` 绿 + manifest 节点带 kind + `generated/NodeKind.ts` 含三新值。

## 未提交 / 未完成
- 无未提交(随本 checkpoint commit 落盘)。
- 两条切片1+ 刀:均已落档未开工(前端 S10a–S10g / asset SA1–SA5)。
- 切片0 完整「完成」剩人工动作:人工试读认可 + S9 判据③ 真跑回归(不阻塞)。

## 冷启动读序
1. `docs/adr/0028`(前端切片架构)+ `docs/adr/0030`(**E agent 阅读器形态**)+ `docs/切片方案-切片1前端阅读器.md`(S10a–S10g)。
2. `docs/adr/0029`(asset 一等对象)+ `docs/切片方案-asset一等对象.md`(SA1–SA5)+ `参考.md`(文档世界状态,asset/agent 刀源头)。
3. `docs/参考对照-文档世界状态-优化登记.md`(②冲突暴露 / ③证据路径可视化·已采纳 + ①对照结论)。
4. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ §5(模块 E·双层 loop)+ §6.1;`CONTEXT.md`(末段:asset 叶子 / agent 可撤销提议 / 读时会话边界 / REST 投影 / 连续正文 / 读位感)。
5. `crates/runtime/src/{lib.rs,orchestrator.rs}`(外层 E loop·ADR-0030 要注入 reader+加 effects/trace)+ `crates/{read-tools,reader,memory}/src/lib.rs` + `crates/base-schema/src/lib.rs`(asset 刀改 NodeKind)。
6. `docs/技术方案-架构蓝图.md` §6(crate DAG)+ `docs/adr/{0027,0024,0021,0022,0008,0019,0018,0015,0007,0026}`。

## 本会话决策摘要
- **E agent 阅读器形态 §0.5(ADR-0030)**:6 决策 — 前端对话主入口=外层 E agent(`/agent/chat`)/ reader 双向共享(orchestrator 注入 reader)/ agent 动作=可撤销提议(前端层,OuterOutcome 加 effects+trace,提议单元=对话回合)/ agent 标注落 session 层·确认升 long_term / 五动作(goto 返回·标注询问保留·回答分屏+凝练笔记·踪迹可见)/ **会话边界=用户手动「新对话」**(简化,不自动 idle)。否决主入口接内层 book.query·agent 自建临时 reader·后端 staging·memory 加 provenance·idle 自动判边界·consolidation 塞前端刀。
- **asset 一等对象 §0.5(ADR-0029)**、**②冲突暴露 / ③证据路径可视化**:见 commit `2d9ce96`(已落档)。
