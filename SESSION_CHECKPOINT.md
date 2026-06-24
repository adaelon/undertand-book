# SESSION_CHECKPOINT — 2026-06-24(切片1 S10c 完成·book.query POST 端点接 runtime::query)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`9f2667d`(S10b)。**S10c 已完成但未 commit**(代码 + 代码链路 + 本盘待一并提交)。
- 读入时对比 `git log -3`,以 git log 为准。
- ⚠️ 工具坑(memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`;中文文件名勿用 Bash 读写。

## 当前在做什么
切片1「前端阅读器」刀。**S10a/b/c 已完成**:`crates/server` 把命令面投影成 REST——`book.*`→GET(S10a)、`reader.*`/`memory.*`→POST(S10b)、`book.query`→POST 接内层 `runtime::query`(S10c,adapter 注入 AppState)。下一子切片 **S10d(前端)** 或 **S10f(外层 agent)**。

## 下一步(可直接接手)
1. **先 commit S10c**:`git add -A && git commit`(未提交,见下「未完成」)。
2. **S10d**(`[Vue/TS]`,最小连通画面所缺最后一块,推荐):建 `packages/web` Vue3+Vite app(pnpm workspace),import `src/generated/*.ts`;组件 = 连续正文列(`GET /book/text` 渲染 `visible_lids` 无分隔)+ 四动作(scroll→`/reader/scroll`、goto→`/reader/goto`、选区→`/reader/highlight`、笔记→`/reader/note`)+ memory overlay(`/memory/recall`)+ 读位感条(章节+进度%)+ 问答框(`POST /book/query`)+ Vite dev proxy `/api`→tiny_http。判据:浏览器加载书显连续正文、四动作经 HTTP 真驱动(B2 浏览器人工验)。
3. 或 **S10f**(`[Rust]`):改 `runtime::orchestrator::run` 签名(删内部 `Reader::new`、改 `reader:&mut Reader` 注入)+ `OuterOutcome` 加 `effects[]`/`trace[]`;server 加 `POST /agent/chat`(持 `Mutex<AppState>` 注入同一 book/store/reader)+ `POST /agent/new`(清 messages)。判据:`cargo test -p server`/`-p runtime`(FakeAdapter 注入 reader 多跳 + effects/trace 装配)绿 + 真跑人工验。

## 未提交 / 未完成
- **S10c 未 commit**:`crates/server/{Cargo.toml,src/lib.rs,src/main.rs}` + `docs/代码链路.md` + 本盘 已改未提交。**全绿**:`cargo test --workspace` 78 + `clippy -p server` 净。
- S10c 未闭(B2,需真书 + `.env`):真跑 `POST /book/query` 返结构红线 100% QueryResponse(走 glm-5.1)由用户拍板。
- asset 一等对象刀(SA1–SA5)仍未开工(独立刀,ADR-0029)。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md`(S10a/b/c 完成,S10d–g 待做)+ `docs/adr/0028`(前端架构)+ `docs/adr/0030`(agent 形态,S10f/g)。
2. `docs/代码链路.md` 末三条(S10a/b/c 改动账本)+ `crates/server/src/lib.rs`(route/route_book/route_mut/route_query 纯函数范式 + AppState 含 adapter + Req)。
3. `crates/runtime/src/lib.rs`(`query` + `QueryResponse` + `ModelAdapter`/`NativeAdapter`,S10c 已接;S10f 接 orchestrator)+ `crates/{reader,memory}/src/lib.rs`(已接的命令面)。
4. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ `CONTEXT.md`(REST 投影 / 连续正文 / 读位感 / agent 可撤销提议)。
5. `packages/web/src/generated/*.ts`(S10d 前端 import 的 API 类型,含 QueryResponse/Citation)。
6. asset 刀单独接手时:`docs/adr/0029` + `docs/切片方案-asset一等对象.md` + `crates/base-schema/src/lib.rs`(NodeKind)。

## 本会话决策摘要
- **S10c 实现落点**:`/book/query` 是 `book.*` 但 LLM 命令 → `route` 里**单列 POST 分支**(GET-only route_book 之前);adapter 注入 `AppState{...,adapter:Box<dyn ModelAdapter+Send>}`;anchor 缺省 = reader 当前视口 anchor;`scope` 入参暂不接(内层无 scope 旋钮)。
- **graceful 兜底**:`.env` 缺失用 `UnconfiguredAdapter`(query 返 PROVIDER_ERROR→502),book/reader/memory 浏览不被阻塞。
- **超 checkpoint 一条**:StubAdapter 实现 ModelAdapter 把 query 路由层做成**确定性可测**(守 A2,非仅 B2)。
