---
name: pass2-longrange-linker
description: Pass2 长程边抽取 subagent（切片0 砍，占位留切片1+ `[ADR-0010]`）。带全量全局目录逐窗口抽跨窗口长程边（scope=long_range），不产节点。
---

# pass2-longrange-linker（占位 · 切片0 不启用,留切片1+ `[ADR-0010]`）

> **状态:占位。** 切片0 只做 Pass1 局部边(见 `docs/切片方案-切片0样板间.md` §0 不做清单)。
> Pass2 在 Pass1 全部完成 + 沉淀完整全局目录后,经**硬串行屏障**才开。

## 职责(切片1+)
带**全量全局目录** + 窗口正文,抽两端跨窗口的**长程边**(`scope=long_range`),**不产节点**;
两端必须都是已存在节点 id。各遍内 5 并发。

## 输出契约
`{ edges: GraphEdge[] }`(仅 `scope=long_range`)。悬空 / 非已存在节点端由确定性闸丢 `[ADR-0011]`。
