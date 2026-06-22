# ADR-0023 GraphEdge 切片0 字段定型:补 direction(去重键)/ 排除 description(收窄 ADR-0010)

状态:已接受(2026-06-22,切片0 S3 开工前 schema 对齐)

## 背景
S3(语义边两遍抽取的确定性收口)开工前盘点冻结基座 schema(`crates/base-schema`,S0 最小子集),发现 `GraphEdge` 当前只有 `{source, target, type, scope, weight}`,与 [[ADR-0010]]/[[ADR-0011]] 对边模型的两处约定有缺口:
- **缺 `direction`**:[[ADR-0011]] 决策4 的边去重键明定为 `(source, target, type, direction)` —— direction 是 merge 去重**必需**字段,缺它则 undirected 边(如 contradicts)的 (A,B)/(B,A) 无法规范化去重。
- **`description` 的 ADR 张力**:[[ADR-0010]] 决策6 把 `description` 列进边字段列表,但 [[ADR-0011]] 决策6 明定「边只作召回路标、edge.type/描述不进 LLM 推理」⇒ description 在读时是 dead field,merge 去重键也不含它。schema 是冻结只读基线(V3 §6 切片0 后冻结),需裁决其去留。

## 决策
1. **补 `direction`**:新增 `Direction` 枚举 `{directed, undirected}`,进 `GraphEdge`。directed = source→target 有序(builds_on/cites/exemplifies);undirected = 两端对称(contradicts),merge 去重时规范化端点顺序后比对。是去重键 `(source,target,type,direction)` 成员。
2. **排除 `description`**:**不**纳入冻结基座 schema。理由:读时不用([[ADR-0011]] 边只作召回路标)、构建期 merge/闸不用(去重键不含它)、与最高原则「只喂确定性事实+真原文,LLM 关系判断退居召回路标」一致 —— 把可能判错的 LLM 描述文本冻进基座只会诱使下游误用。**此为对 [[ADR-0010]] 决策6 字段列表的有意收窄**。
3. **切片0 GraphEdge 字段 = `{source, target, type, direction, scope, weight}`**;Rust 权威 → ts-rs 生成 TS → zod/sample 镜像同步,三道闸(cargo/vitest/tsc)守字段失配非静默。

## 命门
- direction 进去重键是 [[ADR-0011]] 决策4 的硬要求,非可选;merge(S3c)对 undirected 边须规范化端点顺序再比。
- description 排除是「冻结基线最小化」与「禁喂可能判错的 LLM 产物」的双重守护;若未来读时确需边描述,应在读时确定性投影或独立非冻结侧产出,**不回灌冻结基座**。
- schema 是单一真相源 + 单向交付([[ADR-0021]]):改字段必走 Rust 权威→重生成链路,不在 TS 侧手补。

## 否决
- **保留 description 入冻结 schema**(忠于 ADR-0010 字面):读时/merge 均不用,纯 dead weight,且诱导下游把 LLM 文本当权威,违最高原则。
- **连 direction 也不补**(去重键退化 (source,target,type)):undirected 边去重错误(A,B 与 B,A 视为两条),直接违 [[ADR-0011]] 决策4。
- **direction 用 bool(is_directed)**:枚举更显式、可读、未来可扩(如 bidirectional),bool 语义贫乏。

## 何时回头
- 若读时实测确需边的人类可读描述(UI 展示/调试)→ 评估读时投影或非冻结侧产物,不改本决策(冻结基座仍不含 description)。
- 若 Pass 抽取出 direction 之外的方向语义(如非对称强度)→ 扩 Direction 枚举,不退回 bool。

## 影响
- **改 schema**:`base-schema/lib.rs` 加 `Direction` + `GraphEdge.direction`;重生成 `generated/{Direction,GraphEdge}.ts`;`zod.ts`(DirectionZ + GraphEdgeZ)、`sample.ts`、`sample_base()`、roundtrip fixture 同步。三道闸全绿。
- **承** [[ADR-0010]](边字段列表,本 ADR 收窄其 description)/[[ADR-0011]](去重键含 direction、边作召回路标)/[[ADR-0021]](Rust 权威 schema 单向交付)。
- **不回填 CONTEXT**:字段定型是实现细节,守 [[ADR-0021]] CONTEXT 纯术语表纪律。
- S3c merge 去重直接消费本 direction 字段。