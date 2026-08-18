# ADR-0107 Paper lexicon budget routing and cluster reduction

Status: Accepted, 2026-08-18.
Extends: ADR-0055, ADR-0056, ADR-0057 and ADR-0100.
Revises: `paper_lexicon_cluster.v2` may not fail a route merely because one candidate cluster exceeds the rendered-input budget.
Change type: 模型扩展。

## §1 Cluster routing ladder

**决策**:Lexicon 依次尝试整簇、整 LID 重组、单 LID 安全分片。

**否决**:
- 提高或绕过 6,000-token 硬闸:prompt、模型或 reserve 变化后会再次失效。
- 截取术语附近文本并声明为 `ModelInputSliceV1`:违反整 LID core 精确覆盖合同。
- 重切公开 LID:会改变 citation、标注和既有产物身份。

**命门**:definition LID 优先，occurrence LID 稳定采样；每个 packet 均以真实 lexicon renderer 证明预算。
**何时回头**:若另建 `lexicon_context_excerpt` 合同并独立定义覆盖、freshness 与证据语义。

## §2 Lexicon fragment/reduce

**决策**:多片簇以 lexicon fragment 观察和 artifact-bound reducer 收敛为零或一个 entry。

**否决**:
- 复用 `pass1_lid_stitch`:GraphNode/GraphEdge 的局部关系合并不适用于术语字段归约。
- 依赖公开 sidecar 的同名 entry 合并:字段冲突时“先到者胜”不是语义归约。
- 任一 fragment 成功即关闭簇:会静默丢弃未处理的 core 范围。

**命门**:fragment 必须绑定 source slice；reducer 必须绑定有序 child artifact hash，最终每簇严格输出 0 或 1 个 entry。
**何时回头**:若 lexicon schema 获得可证明无损的确定性字段代数。

## §3 Identity and recovery

**决策**:路由身份覆盖角色、source slice 或 child artifact hash，最小安全输入仍超限则结构化阻塞。

**否决**:
- 延续 v2 work-unit 身份:旧任务未表达 fragment/reduce 语义，不能冒充新鲜。
- 裸抛预算异常:planner 无法投影稳定恢复动作。
- reducer 读取未绑定的临时输出:重试与并发下无法证明输入一致。

**命门**:`model_input_unsplittable` 只暴露阶段、LID、预算数值与 allowlisted recovery，不暴露正文或 candidate。
**何时回头**:执行 harness 能原生证明请求 tokenization、依赖快照与 reducer 输入时，可替换证明实现但保留合同。
