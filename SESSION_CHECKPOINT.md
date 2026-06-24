# SESSION_CHECKPOINT — 2026-06-24(切片1 S10g 完成·agent 形态 UI 分屏+可撤销提议)

## 新鲜度自检
- 写入时最新 commit:`dc500a8`(S10f,已 push)。**S10g 将随本盘一起 commit+push**。
- 读入时对比 `git log -3`,以 git log 为准。
- ⚠️ 工具坑(memory `windows-cjk-path-tooling`):git 写操作走 Bash 须 `dangerouslyDisableSandbox`;中文文件名勿用 Bash 读写。

## 当前在做什么
切片1「前端阅读器」刀。**S10a/b/c/d/f/g 完成**:server REST + Vue SPA 连续正文+四动作 + book.query + 外层 E agent `/agent/chat` + **agent 形态 UI(分屏对话+可撤销提议+踪迹)**。**剩末刀 S10e(打包)**——做完切片1 收尾。

## 下一步(可直接接手)
1. **S10e**(`[跨段]` `[ADR-0028/0022]` 切片1 末刀):①`packages/web` `vite build`→`dist/`(已可跑);② `crates/server` tiny_http 同端口既服 `dist/` 静态文件(MIME 按扩展名 + index.html fallback)、又服现有 REST + `/agent/*`(单进程同源无 CORS)——在 `crates/server/src/main.rs` worker 里:非 `/book//reader//memory//agent/` 前缀的 GET 落静态文件分支(读 `dist/<path>`,默认 `index.html`);③ `skills/read/SKILL.md`(`/understand-book:read <book_dir>`)`cargo build` server + 起服务 + 开浏览器。判据:一句话启动 → 浏览器同端口 SPA + API 同源跑通,无 CORS。
2. **(并行/可选)B2 真跑验 S10f+S10g**(需真书 + `.env`):`cargo run -p server -- <真书目录>` + `pnpm -C packages/web dev` → 浏览器:agent 对话分屏 / agent goto 后阅读区同步且可「↩返回」/ 高亮提议可保留·撤销 / 踪迹可展开 / 凝练成笔记。
3. asset 一等对象刀(SA1–SA5)= 独立刀(ADR-0029),切片1 收尾后或并行接手。

## 未提交 / 未完成
- 本盘连同 S10g 一起 commit+push(若已 push 见 git log)。闸全绿:`cargo test --workspace` **89**(memory 7 + server 22,+2)+ clippy 净 + web typecheck(vue-tsc 0)+ build(14 模块→dist)。
- S10f/S10g 未闭(B2):真 LLM 端到端 + 浏览器人工验,留用户拍板。
- asset 刀(SA1–SA5)未开工。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md`(S10a–d/f/g 完成,**S10e 待做**)+ `docs/adr/0030`(agent 形态 + 末尾 S10f/g 落地回填)+ `docs/adr/0028`(前端架构,含 S10e 打包决策7)。
2. `docs/代码链路.md` 末两条(S10f/S10g 账本)。
3. `crates/server/src/{lib.rs,main.rs}`(route 含 book/reader/memory/agent + `/memory/delete`;main 4 worker——S10e 在此加静态文件分支)。
4. `packages/web/src/{App.vue,api.ts}`(阅读区 + agent 对话区 + 提议卡/踪迹;api 全端点客户端)+ `packages/web/src/generated/*.ts`(DTO)+ `packages/web/vite.config.ts`(dev proxy /api→8787)。
5. `crates/runtime/src/orchestrator.rs`(run 注入 reader/messages + effects/trace)+ `crates/{reader,memory}/src/lib.rs`(reader.* 加 layer 参数 / memory.delete)。
6. `需求文档-V3.md` §4(命令面契约·冻结 v1)+ `CONTEXT.md`(agent 可撤销提议 / 会话边界 / REST 投影)。
7. asset 刀单独接手:`docs/adr/0029` + `docs/切片方案-asset一等对象.md` + `crates/base-schema/src/lib.rs`(NodeKind)。

## 本会话决策摘要
- **memory.delete 补全**(完成 V3 §4.3 冻结契约):MemoryStore::delete + /memory/delete,找不到 MEMORY_NOT_FOUND 不降级。
- **S10g 提议交互**(回填 ADR-0030 决策5):逐条保留/撤销(非整回合事务);保留升级 = 同内容 long_term re-save 复用 content-addressed upsert;agent 主入口取代直问 book.query 框(决策1)。
