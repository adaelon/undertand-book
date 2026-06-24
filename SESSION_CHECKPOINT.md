# SESSION_CHECKPOINT — 2026-06-24(切片1 前端阅读器 §0.5 已落档·未开工;下次从 S10a 起)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时已 push 的最新 commit:`4dfea08`(切片0 契约冻结)。**本 checkpoint 随「切片1 §0.5 落档」commit 一同提交**(ADR-0028 + CONTEXT + 切片方案-切片1 + 本文件)。
- 读入时对比 `git log -3`:顶部应是 §0.5 落档 commit;以 git log 为准。

## 当前在做什么
切片0 **完成 + 契约冻结基线 v1**(V3 §6.1)。已规划**切片1 第一刀 = 前端阅读器 + localhost 服务连通**,§0.5 领域对齐(Grill)**已走完并落档**(ADR-0028 + 切片方案-切片1)。**用户指定:本刀不在上个对话做,下次开工从 S10a 起。**

## 下一步(可直接接手)
1. **开工 S10a**(切片1 第一刀第一步,`docs/切片方案-切片1前端阅读器.md §2`):新建 `crates/server`(tiny_http 同步、`Mutex<AppState{book}>`)+ `book.*` 四叶子工具映射 GET(/book/manifest、/book/text、/book/context、/book/concept)+ 错误透传 §4.4 信封 + 给 `QueryResponse/Citation/ToolError` 等补 `#[derive(TS)]` 导出到 `packages/web`。判据:`cargo test -p server` 全绿 + curl 各 GET 正确 + ts-rs 生成 TS。
2. 续 S10b(reader/memory POST)→ S10c(query POST,B2 真跑)→ S10d(Vue app + 连续正文 + 四动作 + dev proxy,B2 浏览器验)→ S10e(打包 tiny_http 服 dist + 启动 skill)。
3. **(可选,任意时点)切片0 完整收尾人工动作**:人工试读认可 + S9 判据③ 真跑回归 —— `cargo run -p runtime -- .understand-book/game-programming-patterns goldset crates/runtime/goldset/game-programming-patterns.json`(走 `.env`,看结构红线仍 100%)。不阻塞切片1。

## 未提交 / 未完成
- 无未提交(§0.5 落档 4 文件随本 commit 落盘)。
- 切片1 前端阅读器:**已落档未开工**(S10a–S10e 待做)。
- 切片0 完整「完成」剩人工动作:人工试读认可 + S9 判据③(不阻塞)。

## 冷启动读序
1. `docs/adr/0028` — **前端切片架构**(本刀总决策:Vue+localhost / server crate tiny_http 同步 / REST 1:1 / 不引 EPUB 框架·连续正文 LID 隐形 / 无页码 / ts-rs 类型契约 / dev·打包)。
2. `docs/切片方案-切片1前端阅读器.md` — A1 声明 + A4 子切片 S10a–S10e(**下次开工正文**)。
3. `需求文档-V3.md` §4(命令面契约,**已冻结基线 v1**,前端要投影的本体)+ §6.1(冻结声明)。
4. `CONTEXT.md` 末三条(命令面 REST 投影 / 连续正文渲染·LID 隐形 / 读位感)。
5. `crates/reader/src/lib.rs`(headless Reader:viewport 叶序窗口 / 四动作)+ `crates/read-tools/src/lib.rs`(Book 叶子工具)+ `crates/runtime/src/lib.rs`(`query` + `NativeAdapter`)+ `crates/memory/src/lib.rs`(MemoryStore)——server 要包装暴露的命令面本体。
6. `docs/技术方案-架构蓝图.md` §6(crate DAG)+ `docs/adr/{0027 DAG,0024 同步,0021 技术栈,0022 插件外壳}`。

## 本会话决策摘要
- **切片0 契约冻结**:§4.1–4.4 + base-schema = 基线 v1(V3 §6.1);切片1+ 只增不改,破坏性变更须新 ADR+升版本。
- **S9 完成**(commit `dd49b6a`):ModelAdapter `extract_json_object` 鲁棒 JSON 抽取 + 抽不到诚实报错;workspace 50 测全绿。
- **切片1 前端 §0.5(ADR-0028)**:7 条决策(见 `docs/切片方案-切片1前端阅读器.md §0`)。否决 Tauri/纯静态页/手写types/axum-tokio/塞runtime-CLI/引EPUB框架/通用command派发/一等页码。**已落档未开工。**
