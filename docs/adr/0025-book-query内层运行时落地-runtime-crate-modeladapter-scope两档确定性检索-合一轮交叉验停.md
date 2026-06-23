# ADR-0025 book.query 内层运行时落地(议题7 第二叉):runtime crate + ModelAdapter trait + scope 两档确定性检索 + 合一轮交叉验停

状态:已接受(2026-06-23,切片0 S5 开工前 §0.5 对齐)

## 背景
[[ADR-0016]] 定了自建最小运行时的双层 loop 形态与贯穿原则,并把"`book.query/synthesize` 精确签名"留作议题7 第二叉。S5 把内层 `book.query` mini-loop 落到切片0 最小版(Rust),本 ADR 记四处工程决策:选址、ModelAdapter 形态、scope 两档确定性定义、合一轮交叉验停落地。读时后端经 `.env` 配置驱动(用户实测端点 = OpenAI-兼容 `/v1`,模型 glm-5.1),不焊死某家([[ADR-0003]])。

## 决策
1. **选址 = 新 crate `crates/runtime`(模块 E)**:依赖 `read-tools`(复用 `Book::{context_near,text,concept}` 当确定性检索骨架)+ `base-schema`。**不塞进 `read-tools`** —— 后者自我定位是「纯函数库、无 LLM、provider 无关」,塞入调网络 / 读 `.env` / 引 reqwest 的 adapter 会污染其定位;[[ADR-0014]] 命令面分层(确定性叶子工具 vs LLM 运行时暴露)正好落到 crate 边界。
2. **ModelAdapter trait = `complete(CompletionRequest{system,user}) → ParsedResponse{sufficient, answer?, citations[], model_supplement[]}`**:loop 控制(检索 / 外扩 / 验停)**provider 无关恒定**,只经 `complete` 触模型([[ADR-0016]] 决策5)。**FakeAdapter**(脚本化 ParsedResponse,确定性测)先行;**NativeAdapter**(读 `.env` 的 OpenAI-兼容端点)留 S5b。
3. **scope 切片0 两档确定性定义**:`local` = `anchor ∪ context_near(anchor)`(树邻接 + scope=local 边);`chapter` = `local ∪「anchor 最近 NodeKind∈{Section,Chapter} 祖先子树内的 anchored 叶 LID」`。**用 `NodeKind` 定位章**(深度可变 LID 段数≠章层级,不取物化路径前 N 段)。顶档 = `chapter`(切片0 无 `cross_chapter/global`)。
4. **合一轮 + 确定性交叉验停**:`valid = citations ∩ 证据集 LID 全集`;`sufficient ∧ valid≠∅` → 留并返回;否则**外扩**(`local→chapter`);`chapter` 仍不足 → **触顶** `incomplete=true` + `CONTEXT_BUDGET_EXCEEDED`([[ADR-0015]] budget)。对外 `citations` **只含 valid**(悬空 LID 滤净 = 结构红线读时落地 [[ADR-0004]]);`model_supplement` 无 LID、物理隔离。

## 命门
- **chapter 用 `NodeKind` 定位** 优于物化路径前 N 段:LID 深度可变,段数不对应章层级。
- **"零有效 citation → 强制外扩"** 把充分性从纯 LLM 自评拉回部分确定性锚定(承 [[ADR-0016]] 早停防护)——有无真 LID 支撑确定性可验。
- **FakeAdapter 先行** = loop 的检索/外扩/验停逻辑确定性可单测(A2/B2);真实后端不可复现部分隔离到 S5b 人工验。

## 否决
- **query 塞 `read-tools`**:混淆确定性叶子工具 / LLM 运行时分层(违 [[ADR-0014]])。
- **chapter = 物化路径前两段**:深度可变 LID 下段数不对应章层级,误判章边界。
- **不写 FakeAdapter、loop 直连真实后端**:外扩/验停无法确定性单测(违 A2),真实 LLM 不可复现。
- **切片0 上 `cross_chapter/global` 档**:范围超切片0(留切片1+)。
- **内层每轮全答 + LLM 自评 confidence**:近 B2 红线(承 [[ADR-0016]] 否决项)。

## 何时回头
- 内层各 scope 档**检索体积上限**(实测回填 [[ADR-0016]])。
- **glm-5.1 结构化输出方式**(原生 `response_format:json_object` vs prompt 要 JSON + 解析)S5b 首次真跑实测定;失败不回退两套 loop,加强约束 prompt。
- `synthesize` 与自含外扩 `query` 的分工(议题7 续 / [[ADR-0017]])。
- chapter 档父容器过大/过小 → 引显式章预算或子树内半径细分。

**S5b 真跑回填(2026-06-23,glm-5.1 经 `.env` OpenAI-兼容端点,anchor `11.18.4`「命令模式」):**
- **结构化输出方式定**:`response_format=json_object` + system 拼 `OUTPUT_CONTRACT` JSON 契约 + `strip_fence` 容错,glm-5.1 稳定吐合法 JSON,**无需上 ReActAdapter**(决策2 验证)。
- **`sufficient` 语义需在契约里显式澄清**:初版契约「不足以作答时 sufficient=false」→ glm-5.1 把"完整定义要靠世界知识"误判为不充分,**答案错塞 `model_supplement`、`answer=null`、过度外扩到 chapter 并误标 `incomplete`**。澄清为「证据有任何片段支撑就写进 answer+sufficient=true;model_supplement 只放纯世界知识延伸」后:**answer 落位完整、`scope_used=local` 够即收口、`incomplete=false`**。⇒ 混合驱动的"够不够"判定对 prompt 措辞敏感,契约须明确 answer/model_supplement 分工。
- **结构红线 100% 兑现**:两跑 citations 均全真 LID、`text` 逐字原文;`model_supplement` 无 LID 物理隔离。确定性交叉验停后端无关恒守([[ADR-0004]])。
- scope 档检索体积上限仍占位(单查询未触发体积压力),待 S8 金标准集 + 更多查询观察。

## 影响
- **新增 `crates/runtime`**(模块 E);回填 V3 §5.2 / §4.1 `book.query` 内层机制。
- **承** [[ADR-0016]](双层 loop / 薄 adapter / scope 同轴 / 双重停机)/ [[ADR-0014]](命令面分层 / 叶子工具)/ [[ADR-0004]](结构红线)/ [[ADR-0003]](provider 抽象 / `.env`)/ [[ADR-0015]](错误信封 / 禁宽松降级)/ [[ADR-0024]](read-tools 确定性骨架)。
- **不回填 CONTEXT**:`证据集 / ParsedResponse / ModelAdapter 实现形态`是实现细节,守 [[ADR-0021]] CONTEXT 纯术语纪律(类比 [[ADR-0024]])。
