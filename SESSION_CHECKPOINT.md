# SESSION_CHECKPOINT — 2026-06-24(切片1 前端 S10a+S10b 完成·server REST book.*/reader.*/memory.*)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`c40c375`(S10a)。**本 checkpoint 随其后的 S10b commit 一起提交**(S10b 代码 + 代码链路 + 本盘)。
- 读入时对比 `git log -3`,以 git log 为准(应见 S10b commit 在顶)。
- ⚠️ 工具坑(memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`;中文文件名勿用 Bash 读写。

## 当前在做什么
切片1「前端阅读器」刀。**S10a + S10b 已完成**:`crates/server` 把命令面投影成 REST——`book.*`→GET(S10a)、`reader.*`/`memory.*`→POST(S10b,返 effect / 标注委托 memory)。下一子切片 S10c 或 S10d。

## 下一步(可直接接手)
1. **S10c**(`[Rust]`):POST `/book/query`(body `{q, anchor_lid}`)→ 同步直调 `runtime::query`(`NativeAdapter::from_env`)→ 返 `QueryResponse`。server Cargo 加 `runtime` 依赖;route 加该 POST 分支(注意:`/book/query` 是 book.* 但可变?→ 它是 LLM 命令、POST,放 route_mut 或单列;query 需 adapter,AppState 可缓存 `NativeAdapter` 或每次 from_env)。判据:真跑返 QueryResponse、结构红线 100%(B2 人工,走 `.env`/glm-5.1,不入自动测)。
2. 或 **S10d**(`[Vue/TS]`):建 `packages/web` Vue3+Vite app,import `src/generated/*.ts`,连续正文渲染 + 四动作(scroll/goto/highlight/note)+ memory overlay(recall)+ 读位感条 + 问答框 + Vite dev proxy `/api`→tiny_http。判据:浏览器加载书显连续正文、四动作经 HTTP 真驱动(B2 浏览器人工验)。

## 未提交 / 未完成
- 无未提交(S10a `c40c375` 已 push;S10b 随本 checkpoint commit 落盘)。**全绿**:`cargo test --workspace` 73 + clippy 净。
- S10a/b 未闭:手动 curl/POST(B2,需预构建真书目录;路由逻辑已纯函数单测覆盖)。
- asset 一等对象刀(SA1–SA5)仍未开工(独立刀,ADR-0029)。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md`(S10a/b 完成,S10c–S10g 待做)+ `docs/adr/0028`(前端架构)+ `docs/adr/0030`(agent 形态,S10f/g)。
2. `docs/代码链路.md` 末两条(S10a/S10b 改动账本)+ `crates/server/src/lib.rs`(route/route_book/route_mut 纯函数范式 + Req 结构)。
3. `crates/runtime/src/lib.rs`(`query` + `QueryResponse`,S10c 要接)+ `crates/{reader,memory}/src/lib.rs`(已接的命令面)。
4. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ `CONTEXT.md`(REST 投影 / 连续正文 / 读位感)。
5. `packages/web/src/generated/*.ts`(S10d 前端 import 的 API 类型)。
6. asset 刀单独接手时:`docs/adr/0029` + `docs/切片方案-asset一等对象.md` + `crates/base-schema/src/lib.rs`(NodeKind)。

## 本会话决策摘要
- **S10a 实测落点**:ts-rs API DTO 导出目标 = `packages/web/src/generated/`,跨指 base 类型由 ts-rs 自动算相对 import,可行(`[ADR-0028/0021]`)。HTTP status = §4.4 category 映射;`ToolError` 暂不加 `recovery`。
- **S10b**:`route` 引入 `Req{method,url,body,now}`;命名空间前缀定方法(book→GET、reader/memory→POST);标注回显走客户端 `memory.recall`(无 render 端点);`now` 由 main 注入(epoch 毫秒)守 A2 可测。
