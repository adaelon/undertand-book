# ADR-0028 前端切片架构:Vue+localhost / 新 server crate(tiny_http 同步)/ REST 命令面 1:1 投影 / 不引 EPUB 框架·连续正文 LID 隐形 / 无一等页码 / ts-rs 类型契约

状态:已接受(2026-06-24,§0.5 领域对齐 Grill 共识;解 [[ADR-0021]] 前端 PENDING)

## 背景
切片0(S0–S9)完成、命令面契约冻结基线 v1(V3 §6.1)。下一刀 = **阅读器前端页面 + 与后端连上**(用户拍板)。[[ADR-0021]] 把前端标为 **PENDING**(「Tauri 或 React+localhost,切片0 命令面闭环验完再定」);[[ADR-0024]] 把读时服务的 HTTP 暴露也留到了后面;架构蓝图画了「本地查询服务 localhost」但代码不存在。本 ADR 在契约冻结后定前端切片的整体架构(BOUNDARY_CHANGE:resolve 前端栈)。最高原则(memory `quality-over-speed-correct-context`)贯穿:阅读体验不改变用户基本判断,前端是命令面的纯投影、不另立真相。

## 决策
1. **前端栈 = Vue/Vite SPA + localhost 服务**(解 [[ADR-0021]] PENDING)。Vue app 落 `packages/web`(pnpm workspace,与 `packages/core` 并置)。否决 Tauri(agent 不走 IPC,偏离人机同命令面)、纯静态页(用户要完整 SPA);React↔Vue 是同类「localhost+SPA」内换框架,不改架构方向。
2. **新建 `crates/server`,tiny_http 同步、线程每连接**;应用状态 = 单 `Book` + 单 `MemoryStore` + 单 `Reader` 会话,`Mutex` 包(切片0 单用户单书)。坐 DAG 顶端,依赖 `read-tools`/`memory`/`reader`/`runtime`/`base-schema`([[ADR-0027]] DAG 纪律)。**同步**:`runtime::query` 的 LLM 调用是同步阻塞(ureq,[[ADR-0024]] 不上 tokio);localhost 单用户并发近零,tiny_http 同步直调 query,**不搭 async 桥**。
3. **HTTP = 命令面 1:1 REST 投影**:`book.*` 只读 → `GET`、`reader.*`/`memory.*` 可变 → `POST`,**端点名 = 命令名**;错误**原样透传** §4.4 分类信封(`error_code/category/recovery`)。HTTP 是冻结命令面(V3 §4)的网络投影,前端/agent/人看同一张面([[ADR-0007]] 人机同命令面无特供)。
4. **不引 EPUB 阅读器框架**(epub.js/foliate-js/Readium);**薄 Vue 层把视口 `visible_lids` 渲染成连续流动正文**——不画每段框/分隔/LID 标号,读者看到的就是普通阅读页;**LID 是隐形接缝,只在被用到时(citation/跳转/高亮锚)才显形**。理由三冲突:① 内容模型(框架吃 epub blob 自解析,我们的内容是命令面投影的 LID 片段)② 寻址(框架用 CFI/spine,我们用 LID,无映射)③ 标注归属(框架自带标注库,我们硬性「标注单源=memory 层」[[ADR-0015]])。
5. **无一等"页码"寻址语义**。页在 reflowable/连续滚动模型里**物理不存在**,按「每 N 段=一页」造号会随窗口/字号漂移、**不可复现**(违锚定红线 + 禁宽松降级 [[ADR-0015]])。人类位置参照 = **视口当前 / 章节名(容器 LID)/ 概念内容搜索**(`book.concept`/`book.query`)。**读模式 orchestrator 每轮把当前 viewport(`reader.state`)喂 agent**,"这段/这里/刚读到的"确定性解析到 LID。UI 用**章节定位 + 进度%**(`anchor_idx`/叶总数,确定性)给读位感,替代页码——只做导航/显示,不做引用锚。印刷版 page-list(`pagebreak`)仅当源 EPUB 携带时,切片1+ 作 LID **展示标签**,citation 恒为 LID;源无则诚实告知无固定页码,不编假页。
6. **类型契约 = ts-rs 从 Rust 权威导出 API DTO** 到 `packages/web` 生成目录([[ADR-0021]] 单一真相源)。REST 请求/响应体(`QueryResponse`/`ViewportEffect`/`ReaderState`/`Record`/`ToolError` 信封…)= 冻结契约(§6.1)的线上形状;给散在各 crate 的这些类型补 `#[derive(TS)]` 导出 → **冻结契约的 TS 面自动从 Rust 生成、前后端不漂**。否决前端手写 `types.ts`(两份真相,在已冻结契约上更不该手抄)。
7. **dev = Vite dev server + proxy 到 tiny_http;打包/启动 = tiny_http 同端口服 `dist/` 静态 + API**(单进程单端口同源,**全程无 CORS**;承 [[ADR-0022]] `skills/read` 一句话拉起 localhost 服务)。

## 命门
- **前端是命令面的纯投影,不是第二套真相**:REST 端点=命令名、类型 ts-rs 生成、标注归 memory——三处都堵住"前端自立真相"。冻结契约(§6.1)由此延伸到网络面与 TS 面。
- **LID 隐形 = 阅读体验不变**:LID 之于阅读体验 ≈ HTML 之于网页,是结构底座不是阅读单位;视口本就是连续多片段窗口([[ADR-0027]] `viewport` 叶序滑动窗口),渲染成连续正文即普通阅读页。
- **同步贯穿**:server 同步直调同步 `runtime::query`,不引 tokio、不搭 async 桥——单用户 localhost 前提下最简且正确。
- **无页码守确定性**:不编不可复现的页坐标;位置参照退到 LID 可锚的视口/章节/概念三者。

## 否决
- **Tauri**:Rust 直连 webview 无 HTTP,但 agent 不走 Tauri IPC → 偏离人机同命令面([[ADR-0007]])与「服务与 harness 脱钩」;且引 Tauri 工具链。
- **纯静态页 / 手写 types.ts**:省事但用户要完整 SPA;手写类型在冻结契约上自找漂移。
- **axum + tokio**:生态标准(Codex `app-server` 参照),但为单用户 localhost 引 async 运行时 + 与同步 LLM 调用搭桥,违 [[ADR-0024]] 最小主义。多用户/并发时再升(见何时回头)。
- **塞进 `runtime` CLI(`serve` 子命令)**:省一 crate,但把 http 传输依赖混进逻辑层、污染 DAG([[ADR-0027]])。
- **引 EPUB 阅读器框架**:其价值(EPUB 解析/分页/TOC/CFI)正是我们刻意替换掉的部分,套上等于把 LID 地基架空、违标注单源,是负资产。
- **通用 `POST /command {name,args}` 派发 / GraphQL**:丢 REST 具名性(命令面=具名工具集)/ 切片0 过重。
- **一等页码 / 每 N 段造页号**:不可复现、违锚定红线与禁宽松降级。

## 何时回头
- **多用户 / 多书并发** → 评估 axum/tokio + 多会话状态(本 ADR 单会话 `Mutex` 是切片0 单用户前提)。
- **人读视口半径**:`DEFAULT_RADIUS=3`(视口 7 段)是给 agent 上下文调的、偏小;人读窗口大小 / 真·无限滚动渐进加载实测定(回填 [[ADR-0027]])。
- **印刷版 page-list 支持**:切片1+,仅当源 EPUB 携带 `pagebreak` 时作 LID 展示标签。
- **ts-rs 导出清单**:具体导出哪些类型随实现定;若 `derive(TS)` 铺太广,考虑集中一层 API DTO crate。
- **标注选区 UX**:是否引轻量文本高亮工具(`web-highlighter`/`mark.js`)做 DOM 选区→高亮交互,持久化仍走 `memory.save`——实测定。

## 影响
- **解 [[ADR-0021]] 前端 PENDING** → Vue + localhost。
- **回填 V3**:§4.2(`reader.*` 视口连续正文渲染语义 + 无页码位置参照)、§6(前端形态从 PENDING → 本 ADR);新增 localhost HTTP 服务形态条目。
- **新增产物**:`crates/server`(tiny_http)+ `packages/web`(Vue3+Vite)。
- **新增 CONTEXT 术语**:命令面 REST 投影(端点名=命令名)、连续正文渲染(LID 隐形接缝)、读位感(章节定位+进度%,非页码)、server 单会话状态(单 Book+Reader+MemoryStore Mutex)。
- **承**:[[ADR-0007]](命令优先·人机对称)/ [[ADR-0021]](技术栈·schema 单一真相源)/ [[ADR-0022]](插件外壳·一句话启动)/ [[ADR-0024]](同步·不上 tokio)/ [[ADR-0027]](crate DAG·viewport 叶序窗口)/ [[ADR-0015]](标注单源 memory·禁宽松降级·错误信封)/ [[ADR-0008]](LID 寻址)/ [[ADR-0004]](引用红线)/ V3 §6.1(契约冻结基线)。
