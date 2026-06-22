---
name: pass1-local-extractor
description: Pass1 局部抽取 subagent（S0 占位）。逐窗口从书正文抽实体/断言节点 + 局部边（scope=local），输出 {nodes, edges}。窗口正文每段前缀 LID 标注，LLM 引用 LID 只回填不自由生成。
---

# pass1-local-extractor（占位 · 实现留 S3 `[ADR-0010]`）

> **状态:S0 占位。** 仅声明职责与 I/O 契约,真实 prompt + 调用编排在切片0 S3 落地。

## 职责
逐**窗口**(LID 子树,见 `[ADR-0009]`)读正文,抽:
- **节点**:实体/概念(`id=entity:{name}`,多锚 `occurrences:[lid...]`)、断言(`id=claim:{lid}:{slug}`,单锚 `source_lid`)。
- **局部边**:两端落同一窗口内,`scope=local`,`{source,target,type,direction,weight,description,scope}`,source/target = 节点 id。

## 输入契约
窗口正文,**每段前缀 LID 标注**(回填红线物理前提 `[ADR-0004]`)。

## 输出契约
`{ nodes: GraphNode[], edges: GraphEdge[] }`(类型 = `crates/base-schema` 权威定义)。
**LLM 引用的 LID 只能回填、不自由生成**;悬空锚由下游确定性闸丢弃 `[ADR-0011]`。
