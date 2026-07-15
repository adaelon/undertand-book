# ADR-0077 Referent-first query and structural evidence gates

Status: Accepted, 2026-07-15.

### §1 Referent-first query boundary

**决策**:query 先冻结指代再读取来源证据。

**否决**:
- anchor-scope 逐级外扩:附近上下文会覆盖远处正确概念。
- 向量检索或穷举别名:不符合本地阅读器边界且不能保证语义正确。
- 开放关系规则表:定义、因果、类比和推导无法穷举。

**命门**:程序只校验 plan、binding、义务覆盖与 citations;开放语义由 LLM 判断并写入旁路审计。
**何时回头**:固定 book/paper 回放证明本地词法候选无法达到可接受召回时。
**展开**:[M6 实施方案](../切片方案-memory可靠画像升级.md)
