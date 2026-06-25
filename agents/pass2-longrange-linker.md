---
name: pass2-longrange-linker
description: technical_learning Pass2 长程边抽取 subagent。带全量全局目录和窗口正文抽跨窗口 long_range 边候选,不产节点;候选再由确定性 gate 降成 GraphEdge(scope=long_range) 与 audit sidecar。
---

# pass2-longrange-linker · technical_learning.pass2_longrange_v1

> **Profile**:`technical_learning`
> **Profile version**:`pass2_longrange_v1`
> **边界**:本 agent 只提出长程边候选;Core gate 才能决定是否写入 `GraphEdge(scope=long_range)`。

## 职责
带**全量全局目录** + 当前窗口正文 + 可选 `discourse_index` / FormulaSemantics / 章节或窗口摘要,抽两端跨窗口的**长程边候选**。

- 只输出边候选,**不产节点**。
- `source` / `target` 必须引用全局目录里已存在的 graph node id。
- `evidence_lids` 必须全部来自输入正文、目录锚点或明确提供的证据上下文;不得自由生成 LID。
- `rationale` 用一句话说明为什么这是书内长程关系,供 audit sidecar 留痕。
- `edge.type` 只作召回路标/UI 展示,不是读时推理强先验。

## 输入契约
```json
{
  "header": {
    "book_id": "book-a",
    "book_version": "v1",
    "profile_id": "technical_learning",
    "profile_version": "pass2_longrange_v1",
    "core_schema_version": "core_v0",
    "generated_at": "2026-06-25T00:00:00Z"
  },
  "catalog": [{"id":"entity:x","type":"entity","name":"X","lid":"1.2"}],
  "graph_nodes": [],
  "discourse_index": null,
  "formula_semantics": [],
  "windows_or_chapters": [{"lid":"1","title":"第一章","summary":"...","key_lids":["1.2"]}],
  "window_text": "带 [LID] 前缀的窗口正文"
}
```

`catalog` 是 Pass1 merge 后 nodes 的确定性投影,是唯一可引用的节点全集。
## 输出契约
严格 JSON,只输出 `TechnicalLearningPass2Output`:

```json
{
  "header": {
    "book_id": "book-a",
    "book_version": "v1",
    "profile_id": "technical_learning",
    "profile_version": "pass2_longrange_v1",
    "core_schema_version": "core_v0",
    "generated_at": "2026-06-25T00:00:00Z"
  },
  "edges": [
    {
      "source": "entity:a",
      "target": "concept:b",
      "type": "builds_on",
      "direction": "directed",
      "scope": "long_range",
      "weight": 0.82,
      "evidence_lids": ["1.2.3", "8.1.4"],
      "rationale": "1.2.3 定义 A,8.1.4 用 A 推导 B。"
    }
  ]
}
```

`type` 只能取 `builds_on | contradicts | exemplifies | prerequisite | refines | applies | analogous_to | contrasts`。
## 禁止
- 不输出 `nodes`。
- 不把 LID 当作 `source`/`target`;端点只能是 graph node id。
- 不重建悬空节点、悬空 LID 或“应该存在”的证据。
- 不输出 `scope="local"` 或省略 scope;候选必须显式 `scope="long_range"`。
