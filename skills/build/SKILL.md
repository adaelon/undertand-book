---
name: build
description: Turn a book (epub/md) into a read-only knowledge-graph base for anchored-reasoning reading. Deterministic LID segmentation + LLM semantic-edge extraction, gated.
argument-hint: ["<path-to-epub-or-md> [--full]"]
---

# /understand-book:build

> **调用形态**:插件 skill 强制命名空间 = `/<插件名>:<skill文件夹名>`。本插件 name
> `understand-book`(`.claude-plugin/plugin.json`)+ skill 文件夹 `build` ⇒ 命令
> **`/understand-book:build`**。读时启动是另一个 skill `/understand-book:read`(留 S7)。

> **状态:S0 占位骨架。** 这一刀(切片0 S0)只立入口 + 编排骨架,确定性脚本与
> subagent 实现留 S1–S3(见 `docs/切片方案-切片0样板间.md`)。编排正文当前为 stub,不执行真实管线。

把一本书(`$ARGUMENTS` 指向的 epub/md)预构建成只读知识图谱基座,产物落
`.understand-book/`。预构建期绑当前 agent harness(本 skill 在 harness 内跑,
harness 供 LLM)`[ADR-0003]`;读时是独立产品,启动走 `/understand-book:read`(留 S7)。

## 参数
- `$ARGUMENTS`:书路径(epub / markdown)。`--full` = 忽略已有基座强制全量重建。

## 编排骨架(7 段管线 · S1–S3 逐段填实)
1. **导入 + LID 段级切分**(确定性,`skills/build/split-lid.mjs` · S1 `[ADR-0008]`)
2. **窗口切分**(LID 子树 + 双约束预算,`compute-windows.mjs` · S2 `[ADR-0009]`)
3. **Pass1 局部抽取**(subagent `pass1-local-extractor`,5 并发 · S3 `[ADR-0010]`)
4. **merge + 确定性图谱闸**(`merge-graph.mjs` · S3 `[ADR-0011]`)
5. **全局目录确定性投影**(`project-catalog.mjs` · S3 `[ADR-0010]`)
6. ~~Pass2 长程边~~(subagent `pass2-longrange-linker`)— **切片0 砍,留切片1+**
7. **自检闸 + 固化只读基座**(分区不变式 + 锚定率 ≥90%,产 `.understand-book/`)

## 基座 schema(单一真相源)
基座类型由 Rust 权威定义(`crates/base-schema`,serde+ts-rs+schemars),ts-rs
生成 TS 给预构建用 `[ADR-0021]`。S0 先打通该生成链路(本仓库 `crates/base-schema`
→ `packages/core/src/generated/`)。
