# SESSION_CHECKPOINT — 2026-06-24(切片1 S10d 完成·Vue/Vite 前端 app 最小连通画面)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`cd03ec6`(S10c,已 push)。**本 checkpoint 随其后的 S10d commit 一起提交**(`packages/web/*` + `pnpm-lock.yaml` + 代码链路 + 本盘)。
- 读入时对比 `git log -3`,以 git log 为准。
- ⚠️ 工具坑(memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`;中文文件名勿用 Bash 读写。

## 当前在做什么
切片1「前端阅读器」刀。**S10a/b/c/d 已完成**:server 投影 REST(book.*/reader.*/memory.*/book.query)+ `packages/web` Vue/Vite SPA(连续正文 + 四动作 + 标注 overlay + 读位感 + 问答框)。**最小连通画面(S10a+b+d)成形**。剩 S10f(外层 agent)/ S10g(agent UI 分屏)/ S10e(打包)。

## 下一步(可直接接手)
1. **先 commit S10d**:`git add -A && git commit`(未提交,见「未完成」)。
2. **B2 浏览器人工验 S10d**(需真书):`cargo run -p server -- <真书目录>` 起后端,另开 `pnpm -C packages/web dev` → 浏览器开 Vite 地址,验:连续正文显示 / 上下翻 + 跳转 LID / 高亮+笔记回显 / 读位感 / 问答(需 `.env`)。
3. **S10f**(`[Rust]`):改 `runtime::orchestrator::run` 签名——删内部 `Reader::new`、改 `reader:&mut Reader` 注入(与 `store` 对称);`OuterOutcome` 加 `effects:Vec<AgentEffect>`(goto 前后 anchor、highlight/note id+lid)+ `trace:Vec<TraceStep>`(tool_calls 摘要);server 加 `POST /agent/chat`(持 `Mutex<AppState>` 注入同一 book/store/reader/adapter)+ `POST /agent/new`(清 messages,`AppState` 持 `messages`)。判据:`cargo test -p server`/`-p runtime`(FakeAdapter 注入 reader 多跳 + effects/trace 装配)绿 + 真跑人工验。`[ADR-0030]`

## 未提交 / 未完成
- 无未提交(S10d 随本 checkpoint commit 落盘)。S10d 闸全绿:`pnpm install` ✓ + `typecheck`(vue-tsc 0)✓ + `build`(vite,12 模块→dist)✓;`cargo test --workspace` 78 不变。
- S10d 未闭(B2):浏览器加载真书 / 四动作真驱动 / 标注回显 / 读位感 / 问答 citations 可跳——需真书人工验。
- asset 一等对象刀(SA1–SA5)仍未开工(独立刀,ADR-0029)。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md`(S10a–d 完成,S10e/f/g 待做)+ `docs/adr/0028`(前端架构)+ `docs/adr/0030`(agent 形态,S10f/g)。
2. `docs/代码链路.md` 末四条(S10a/b/c/d 改动账本)+ `crates/server/src/lib.rs`(route/route_book/route_mut/route_query + AppState 含 adapter)。
3. `packages/web/src/{api.ts,App.vue}`(前端命令面客户端 + 阅读器组件,S10f/g 在此扩 agent 对话区)+ `packages/web/src/generated/*.ts`(API DTO)。
4. `crates/runtime/src/lib.rs`(`query`/`QueryResponse`/`ModelAdapter`)+ `crates/runtime/src/orchestrator.rs`(S10f 要改签名 + OuterOutcome)+ `crates/{reader,memory}/src/lib.rs`。
5. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ `CONTEXT.md`(REST 投影 / 连续正文 / 读位感 / agent 可撤销提议)。
6. asset 刀单独接手时:`docs/adr/0029` + `docs/切片方案-asset一等对象.md` + `crates/base-schema/src/lib.rs`(NodeKind)。

## 本会话决策摘要
- **S10d 实现落点**(回填 ADR-0028):连续正文取数 = 逐 visible_lid 取真原文(整窗 range 批取属优化,留实测);标注 overlay 锚定 = 段落 `data-lid` + 客户端按 lid 过滤 `recall`;读位感 = 进度%(anchor 叶序下标/叶总数)+ 章节(LID 首段原文首行);dev 同源经 Vite proxy `/api`→tiny_http(无 CORS)。
- **S10c**(已 commit cd03ec6):`/book/query` 单列 POST 分支;adapter 注入 AppState;`.env` 缺用 UnconfiguredAdapter 兜底;StubAdapter 确定性测。
