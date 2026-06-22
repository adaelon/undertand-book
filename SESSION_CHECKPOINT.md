# SESSION_CHECKPOINT — 2026-06-22(切片0 两输入已定:书+后端;待 S0 开工)

## 新鲜度自检
- 非 git 仓库,以 mtime 为准。
- 本会话产物:确定切片0 用书(《游戏编程模式》epub)+ 读时后端(Claude Opus 4.8);实地核验 epub 结构(块标记/章节层级);未动代码、未建 repo。

## 当前在做什么
工程契约(ADR 0001–0021)+ 架构蓝图/切片方案两份交付文档全部就绪。切片0 **两个阻塞输入已敲定**,状态 = **待起 S0 编码开工**。

## 切片0 已定输入
- **书**:`C:\Users\Lenovo\Downloads\游戏编程模式 ([美] Robert Nystrom 尼斯卓姆) (z-library.sk, 1lib.sk, z-lib.sk).epub`
  - 结构(已核验):前言+6 部分+20 章;块标记 = h1(章)/h2(节)/p.zw(正文段)/blockquote.引用(内嵌 p)/pre(代码)/img;中文,句切留切片1+。忠实块映射可直接吃(印证 ADR-0008)。
- **读时后端(S5/S6 NativeAdapter)**:**Claude Opus 4.8** = `claude-opus-4-8`(native tools+JSON、1M 上下文、$5/$25 每 MTok)。直连 Anthropic API,key 留本地(ADR-0003)。注:预构建 Pass1/Pass2 用 harness LLM,非此后端。

## 下一步(可直接接手)
1. 起 **S0**(切片方案 §2 S0,前置闸,不依赖书/后端):搭 monorepo 骨架 = cargo workspace(Rust)+ pnpm workspace(TS)并置。
2. Rust 定义最小基座 schema(LID 节点 / 图谱节点·边),serde+ts-rs+schemars。
3. ts-rs 生成 TS 类型 → 预构建 TS 按类构造样例基座 → Rust serde 读入零失配。
4. 锁测试:`cargo test` 一例 + `vitest` 一例,字段失配能被 serde/zod 捕获(非静默)。
5. S0 判据过后 → 起 **S1**(导入+段级 LID 切分,TS,吃上面那本 epub)。

## 未提交 / 未完成
- 切片0 代码未起;repo 骨架未建。
- 待人工 review:V3(§3.4/§5.3)、架构蓝图、切片方案、ADR-0019~0021。
- 实测数字未测(散落 ADR-0008~0021「何时回头」+ 切片方案 §3)。
- 前端选型仍 PENDING(ADR-0021,切片0 命令面闭环验完再定)。
- V1/V2/体检报告保留为基准,勿动。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 实现技术栈。
2. `docs/切片方案-切片0样板间.md` — 实施入口(S0 schema 链路 + S1–S8 + 语言归属)。
3. `需求文档-V3.md` — 现行工程契约。
4. `CONTEXT.md` — 术语表。
5. `docs/adr/0001`–`0021` — 21 条决策(0021 技术栈;0008 切分对应本书块映射)。
6. `memory/quality-over-speed-correct-context.md`(最高原则)/ `codex-memory-reference.md`(Rust 读时移植源)/ `understand-anything-reference.md`(TS 预构建参照)。

## 本会话决策摘要
- 切片0 用书 = 《游戏编程模式》epub(中文,结构干净,适合验段级切分+块映射)。
- 切片0 读时后端 = Claude Opus 4.8(`claude-opus-4-8`,NativeAdapter);锚最高原则=前沿模型验「锚定推理」质量,弱后端留切片1+ ReActAdapter。
- 二者属 ADR-0021 列的切片0 输入,易换、未另立 ADR。
