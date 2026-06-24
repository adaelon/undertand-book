# SESSION_CHECKPOINT — 2026-06-24(asset 一等对象 §0.5 已落档·未开工;两条切片1+ 刀待挑)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`3406758`(切片1 前端 §0.5 落档)。**本 checkpoint 随「asset §0.5 + ②③ 优化项落档」commit 一同提交**。
- 读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0 **完成 + 契约冻结基线 v1**(V3 §6.1)。现有**两条并列的切片1+ 刀,均 §0.5 已落档、未开工**:
1. **前端阅读器**(Vue+localhost,ADR-0028)— 从 S10a 起。
2. **asset 一等对象**(代码块/表/图,ADR-0029)— 从 SA1 起。**本会话新增**,源自 `参考.md` 文档世界状态对照。
两刀互不混入。**优先级未定,下次开工前先与用户确认挑哪条;默认主线 = 前端 S10a。**

## 下一步(可直接接手,二选一)
- **前端 S10a**:新建 `crates/server`(tiny_http 同步、`Mutex<AppState{book}>`)+ `book.*` 四叶子 → GET + 错误透传 §4.4 信封 + 给 `QueryResponse/Citation/ToolError` 补 `#[derive(TS)]` 导出 `packages/web`。判据:`cargo test -p server` 绿 + curl 各 GET 正确 + ts-rs 生成。
- **asset SA1**:`base-schema::NodeKind` 增 `Code/Table/Image` + `read-tools::ManifestNode` 加 `kind`(投影 `LidNode.kind`)+ ts-rs 重生成。判据:`cargo test` 绿 + manifest 节点带 kind + `generated/NodeKind.ts` 含三新值。

## 未提交 / 未完成
- 无未提交(本会话 6 文件随本 commit 落盘)。
- 两条切片1+ 刀:**均已落档未开工**(前端 S10a–S10e / asset SA1–SA5)。
- 切片0 完整「完成」剩人工动作:人工试读认可 + S9 判据③ 真跑回归(不阻塞)。

## 冷启动读序
1. `docs/adr/0028`(前端切片架构)+ `docs/切片方案-切片1前端阅读器.md`(S10a–S10e)。
2. `docs/adr/0029`(asset 一等对象)+ `docs/切片方案-asset一等对象.md`(SA1–SA5)+ `参考.md`(文档世界状态,asset 刀源头)。
3. `docs/参考对照-文档世界状态-优化登记.md`(②冲突暴露 / ③证据路径可视化 已采纳 + ①对照结论)。
4. `需求文档-V3.md` §4(命令面契约·冻结基线 v1)+ §6.1(冻结声明);`CONTEXT.md`(末段:asset 叶子 / REST 投影 / 连续正文 / 读位感)。
5. `crates/{read-tools,reader,runtime,memory}/src/lib.rs`(命令面本体)+ `crates/base-schema/src/lib.rs`(schema 真相源,asset 刀要改 NodeKind)。
6. `docs/技术方案-架构蓝图.md` §6(crate DAG)+ `docs/adr/{0027,0024,0021,0022,0008,0019}`。

## 本会话决策摘要
- **asset 一等对象 §0.5(ADR-0029)**:5 决策 — 带类型 LID 叶子(NodeKind 增 Code/Table/Image)/ 原文=源标记确定性序列化 / ManifestNode 暴露 kind 零新命令 / 类型闭集{Code,Table,Image} / 图谱层一视同仁。否决旁挂属性·独立 asset_id·LLM描述进source·book.assets命令·formula长尾。grill 中暴露三 ingestion bug(epub img 消失/table 丢/pre 被 norm 拍平)。
- **优化项②冲突暴露 / ③证据路径可视化**:已采纳落档(登记 §A/§B),切片1+ / 切片1 前端消费。
