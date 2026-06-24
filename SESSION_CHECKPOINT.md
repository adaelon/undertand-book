# SESSION_CHECKPOINT — 2026-06-24(切片1 前端 S10a 完成·server crate + book.* REST + API DTO ts-rs)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`8b7b5d2`(上一份 checkpoint)。**S10a 改动尚未 commit**(见「未提交」)。
- 读入时对比 `git log -3`,以 git log 为准。
- ⚠️ 工具坑(memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`;中文文件名勿用 Bash 读写。

## 当前在做什么
切片1「前端阅读器」刀,**S10a 已完成**(新 `crates/server`:tiny_http 同步把 `book.*` 四叶子投影成只读 GET REST + API DTO 经 ts-rs 导出 `packages/web/src/generated`)。下一子切片 S10b/c。

## 下一步(可直接接手)
1. **S10b**(`[Rust]`):`AppState` 扩 `Reader`+`MemoryStore`;POST `/reader/{goto,scroll,highlight,note,state}` + `/memory/{save,recall}`(JSON body),reader.* 返 effect、highlight/note 委托 memory.save。server Cargo 加 `reader`/`memory` 依赖。判据:`cargo test -p server` 绿 + 非法 LID 返 `LID_NOT_FOUND` 不降级。
2. **S10c**(`[Rust]`):POST `/book/query`(body `{q,anchor_lid}`)→ 同步直调 `runtime::query`(NativeAdapter::from_env)→ 返 `QueryResponse`。server Cargo 加 `runtime` 依赖。判据:真跑结构红线 100%(B2 人工)。
3. 或转 **S10d**(`[Vue/TS]`):建 `packages/web` Vue app,import 已生成的 `src/generated/*.ts`,连续正文渲染 + 四动作 + dev proxy。

## 未提交 / 未完成
- **S10a 全部改动未 commit**:`crates/server/{Cargo.toml,src/lib.rs,src/main.rs}`(新)+ `crates/read-tools/{Cargo.toml,src/lib.rs}`(加 ts-rs+derive TS)+ `crates/runtime/{Cargo.toml,src/lib.rs}`(同)+ `packages/web/src/generated/*.ts`(11 新文件)+ `docs/代码链路.md`、`docs/技术方案-架构蓝图.md`(已更)。**全绿**:`cargo test --workspace` 71 + clippy 净。建议先 commit 再开 S10b。
- S10a 未闭:手动 curl(B2,需预构建真书目录;路由逻辑已纯函数单测覆盖)。
- asset 一等对象刀(SA1–SA5)仍未开工(独立刀,ADR-0029)。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md`(S10a 已完成,S10b–S10g 待做)+ `docs/adr/0028`(前端架构)+ `docs/adr/0030`(agent 形态,S10f/g)。
2. `docs/代码链路.md` 末条(S10a 改动账本)+ `crates/server/src/lib.rs`(route 纯函数范式,S10b 在此扩)。
3. `crates/{read-tools,reader,memory}/src/lib.rs`(S10b 要接的 Book/Reader/MemoryStore 命令面)+ `crates/runtime/src/lib.rs`(QueryResponse,S10c)。
4. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ `CONTEXT.md`(命令面 REST 投影 / 连续正文 / 读位感)。
5. `docs/技术方案-架构蓝图.md` §6(crate DAG,已加 server)。
6. asset 刀单独接手时:`docs/adr/0029` + `docs/切片方案-asset一等对象.md` + `crates/base-schema/src/lib.rs`(NodeKind)。

## 本会话决策摘要
- **S10a 实测落点回填**(已落 ADR 关联):ts-rs API DTO 导出目标 = `packages/web/src/generated/`,跨指 base-schema 类型(`ManifestNode.span:Span`)由 ts-rs 自动算相对 import `../../../core/src/generated/Span`,跨 crate 可行(`[ADR-0028/0021]`)。
- HTTP status = §4.4 category 映射(REST 投影补充,body 仍透传信封);`ToolError` 暂不加 `recovery`(不擅扩冻结契约)。
