# ADR-0021 实现技术栈:预构建 TS / 读时后端 Rust / 前端待定;基座 schema Rust 权威·ts-rs 生成

状态:已接受(2026-06-22,工程层 grill 切片0 §0.5 技术栈共识)

## 背景
议题1–8 工程契约钻完、转切片0 开工前,§0.5 grill 技术栈(此前 20 条 ADR 与 V3 均未钉实现语言)。能翻代码库的先翻:**U-A** = TS monorepo(`packages/core` 构建逻辑 + tree-sitter/fuse.js/graphology/zod;`packages/dashboard` React19+Vite+Tailwind 读时消费端)+ `skills/*.py` 5 个预构建确定性脚本;**Codex** = 庞大 Rust workspace,读时后端零件齐全(`core` agent loop / `model-provider`+`ollama`+`lmstudio` provider 抽象 / `memories/{read,write}` 两阶段 consolidation+引用锚定 / `app-server` localhost 服务 / `agent-graph-store` 图存储 / `rollout` 会话态)。需求方提分语言方案。最高原则(正确性优先、上下文必须完全正确)贯穿。

## 决策
1. **分语言三段切分**:
   - **预构建期 = TypeScript / Node**:导入 / 段句切分 / 窗口 / Pass1·Pass2 / merge / 确定性闸 / 基座产出,**+ 增量构建 8a**([[ADR-0019]] Merkle diff / 变更分级 / Pass2 受影响追踪 / lid_migration_map 产出,亦属构建期)。
   - **读时后端 = Rust**:localhost 命令面服务 + 模块E agent 运行时(双层 loop / ModelAdapter)+ 记忆层(含 8b 迁移读时投影)+ 图谱读时遍历(`book.context` near/mid/far 投影)。
   - **前端 = 待定(PENDING)**:命令优先 = headless core 在 Rust([[ADR-0007]]),thin UI 留前端选型;切片0 先验命令面 headless 闭环,GUI 薄层待前端定,不阻塞后端。
2. **语言切分依据**:读时后端几乎**整套对齐移植 Codex Rust crate**(见背景映射,尤其 `ollama`/`lmstudio` = [[ADR-0016]] ReActAdapter 要兜的弱后端场景,Codex 已趟);预构建用 TS = U-A 同构 + epub/md 解析与 LLM subagent 编排生态成熟,书的切分是确定性字符串处理、不需 Python 独有能力。**基座是冻结只读产物 ⇒ TS→Rust 是单向产物交付**(类 U-A `*.py`→JSON→TS dashboard),接缝单向可控,不是频繁双向序列化。
3. **基座 schema 单一真相源 = Rust 权威 + ts-rs 生成 TS**(借 Codex `app-server-protocol` 已验证链路:`serde`+`ts-rs`+`schemars`,实有 `schema/typescript/*.ts` 生成产物):基座(LID 树 / 图谱 / Merkle 指纹 / 全局目录 / lid_migration_map)schema 用 **Rust struct 定义**(serde+ts-rs+schemars)→ 生成 TS 类型给预构建;预构建 TS 按生成类型构造 + **zod 产出前运行时自检**(呼应分区不变式闸「产出即校验」);schemars 出 JSON Schema 作语言中立文档。**谁定义 schema ≠ 谁先产数据**——定义权给对格式正确性最敏感的消费方(Rust serde 强校验,字段不匹配反序列化即报错,不让读到错位 LID 静默错),守最高原则。
4. **序列化格式 = JSON 默认**(可读 / 可分发 [[ADR-0001]] / serde·ts-rs 原生);基座全内存 MB 级([[ADR-0008]])够用。大书加载慢再评估 bincode/messagepack(留何时回头)。
5. **repo 组织 = 单 monorepo,cargo workspace(Rust)+ pnpm workspace(TS 预构建+前端)并置**,顶层 schema crate(Rust)经 ts-rs 生成 TS 桥接。一个仓库三段,schema 生成是构建步骤。
6. **关键库方向 + 一个分语言调整点**:
   - 预构建 TS:epub/md 解析(净新,U-A 无书导入)、zod(自检,U-A 已用)。
   - 读时 Rust:`serde`/`ts-rs`/`schemars`(schema)、图遍历(参 Codex `agent-graph-store` / petgraph)、localhost 服务(参 `app-server` / axum)、provider(参/复用 `model-provider`+`ollama`+`lmstudio`)。
   - **调整点**:[[ADR-0002]] 的 **Fuse.js 词法兜底是 TS 库,但词法索引查询在读时 = Rust 侧** ⇒ 需换 **Rust 等价物**(nucleo / fuzzy-matcher / tantivy),或词法索引预构建期(TS)产出、读时 Rust 查。切片0 实测时定具体库。
   - 测试:**vitest**(TS,U-A 同)+ **cargo test**(Rust,Codex 同)。

## 命门
- **基座 schema Rust 权威是分语言方案的安全闩**:最严格消费方(serde)定标准 + zod 双侧自检,跨语言接缝才不漂移;漂移=Rust 读错位 LID,直撞正确性红线。
- **单向产物交付削弱接缝风险**:基座冻结只读,不是双向频繁序列化;增量(8a TS 产)/ 迁移映射(8b Rust 投影消费)同样单向。
- **读时 Rust = 移植 Codex 而非重写**:`memories/{read,write}`、`model-provider`、`agent-graph-store` 直接对齐 [[ADR-0015]]/[[ADR-0016]]/[[ADR-0018]],省一遍语言重写。
- **前端 PENDING 不阻塞**:命令优先([[ADR-0007]])使 headless core(Rust)可独立验闭环,GUI 是其上渲染层,后定不返工。

## 否决
- **全 TS 统一**(原推荐):读时后端放弃 Codex 整套 Rust 参照,memory/provider/agent loop 全重写;Rust 的性能/内存/并发(Phase1 claim·lease、Phase2 锁,[[ADR-0018]])优势丢失。基座冻结产物使「消除接缝」收益本就有限。
- **全 Rust 统一**:预构建丢 TS 的 epub/md 解析与 harness subagent 编排生态;U-A 参照(TS)无法借。
- **读时后端也 TS**:同「全 TS」,且 localhost 常驻服务跑 agent loop+图遍历+consolidation 是 CPU 密集确定性计算,Rust 更稳。
- **zod 权威 → 生成 Rust**:zod→Rust codegen 工具链弱,Rust 失 serde derive 原生性,最严格校验方反而不定标准。
- **中立 schema(protobuf/JSON Schema)双向生成**:多工具链,无第三语言消费方,过度设计。
- **多 repo 分仓**:schema 生成跨仓同步更脆,三段本是一个产品。

## 何时回头
- **前端选型(PENDING)**:Rust 后端天然搭 Tauri(Rust+webview)或纯 web 前端(React 类 U-A dashboard)经 localhost 连 Rust;切片0 命令面闭环验完、需 GUI 时定。
- Rust 词法搜索库(nucleo/tantivy/fuzzy-matcher)切片0 实测选。
- 序列化 JSON→二进制:大书加载实测慢再评估。
- 切片0 首要验证项之一:**TS↔Rust 基座 schema 生成链路端到端跑通**(Rust 定义→生成 TS→预构建产基座→Rust serde 读入零失配),作为分语言方案的可行性闸。
- 若 ts-rs 某些类型(如 LID 物化路径的递归树)生成 TS 不理想 → 评估手写该类型 + 测试锁形状,不回退中立 schema。

## 影响
- **回填**:`docs/技术方案-架构蓝图.md` 加「实现技术栈」节(三段切分 + Codex/U-A 移植映射 + schema 桥接);`docs/切片方案-切片0样板间.md` 各 S 步骤标语言归属([TS]/[Rust]) + 新增「S0 schema 链路打通」前置步。
- **不回填 CONTEXT**:技术栈是实现细节,CONTEXT 是纯术语表(不含实现),守其纪律。
- **承** [[ADR-0001]](本地 plugin+localhost+可分发)/[[ADR-0003]](预构建绑 harness·读时脱钩·provider 抽象)/[[ADR-0016]](ModelAdapter↔Codex model-provider)/[[ADR-0015]][[ADR-0018]](memory↔Codex memories)/[[ADR-0019]](增量归预构建 TS)/[[ADR-0002]](Fuse.js→Rust 词法调整);参照 U-A(TS 构建+ts-rs 缺)与 Codex(Rust 读时全栈 + ts-rs 跨语言 schema)。
- **解锁切片0 开工**:语言地基定,可起 S0(schema 链路)+ S1(导入+段级 LID 切分,TS)。
