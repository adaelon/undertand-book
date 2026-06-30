---
name: build
description: Turn a book (epub/md) into a read-only knowledge-graph base for anchored-reasoning reading. Deterministic LID segmentation + LLM semantic-edge extraction, gated.
argument-hint: ["<path-to-epub-or-md> [--full]"]
---

# /understand-book:build

> **调用形态**:插件 skill 强制命名空间 = `/<插件名>:<skill文件夹名>`。本插件 name
> `understand-book`(`.claude-plugin/plugin.json`)+ skill 文件夹 `build` ⇒ 命令
> **`/understand-book:build`**。读时启动是另一个 skill `/understand-book:read`(留 S7)。

> **状态:S1–S3 确定性骨架 + PB5 跨会话续建已实现。** 段切分(S1)/ 窗口(S2)/ Pass1 输入组装·
> merge+闸·目录投影(S3)落 `packages/core` 单测全绿;Pass1 subagent prompt 已填实;PB5 续建脚手架
> (build-status / emit-input / pass1-write / pass1-batch 消费 `.build/`,见下「跨会话续建」)落地。
> 余:**真书 + 真 LLM 端到端试跑**(数十窗跨会话抽取 → 固化 `.understand-book/` → 自检闸实测)。

把一本书(`$ARGUMENTS` 指向的 epub/md)预构建成只读知识图谱基座,产物落
`.understand-book/`。预构建期绑当前 agent harness(本 skill 在 harness 内跑,
harness 供 LLM)`[ADR-0003]`;读时是独立产品,启动走 `/understand-book:read`(留 S7)。

## 参数
- `$ARGUMENTS`:书路径(epub / markdown)。`--full` = 忽略已有基座强制全量重建。

## 编排骨架(8 段管线)
0. **段/句粒度体检**(确定性,`skills/build/granularity-profile.ts` 经 tsx · SA0 ✓ `[ADR-0032]`):输出 `GranularityProfile`,用户确认 `paragraph/hybrid/sentence` 后才进入正式构建。
1. **导入 + LID 段级切分**(确定性,`skills/build/split-lid.ts` 经 tsx · S1 ✓ `[ADR-0008]`)
2. **窗口切分**(LID 子树 + 双约束预算,`packages/core/src/window.ts`;CLI `skills/build/window-cli.ts` · S2 ✓ `[ADR-0009]`)
3. **Pass1 局部抽取**:`packages/core/src/pass1-input.ts` 把每窗口组装成带 LID 标注的正文 → subagent `pass1-local-extractor`(5 并发,见 `agents/`)逐窗口出 `{nodes, edges(local)}` · S3 ✓骨架 `[ADR-0010]`
4. **merge + 确定性图谱闸**(`packages/core/src/merge.ts:mergeAndGate`;按类型合并 occurrences + 悬空丢不重建 + 最小连坐 + 可观测报告 · S3 ✓ `[ADR-0011]`)
5. **全局目录确定性投影**(`packages/core/src/catalog.ts:projectCatalog` · S3 ✓ `[ADR-0010]`)
6. ~~Pass2 长程边~~(subagent `pass2-longrange-linker`)— **切片0 砍,留切片1+**
7. **自检闸 + 固化只读基座**(分区不变式 + 锚定率 ≥90%,产 `.understand-book/` · 下一刀)

## 跨会话续建(冷启动契约)`[ADR-0042 · PB5]`

> **状态:PB5 已实现(ADR-0042)。** CLI `build-status` / `emit-input` / `pass1-write` / `pass1-batch`(续建改造)+ core `build-resume.ts`(`pass1ContentHash` / `computeBuildStatus` / `buildPass1Artifact`)+ `book-id.ts`(`deriveBookId`)落地且单测绿。
>
> build 由 Claude 在环驱动,真书数十窗 Pass1 抽取**一个会话跑不完**(token/上下文耗尽是常态,非异常)。任一**新会话零上下文**,纯靠 `.understand-book/<bookId>/.build/` 中间产物接手。下面是冷启动续建 loop,与 SESSION_CHECKPOINT(C4/C5 会话热启动)同招——只是冷启的是"构建状态"。

```
1. tsx skills/build/build-status.ts <book> [--book-id <id>]
   → done/pending 窗口 id(= 重算窗口逐窗 content-hash 校验 .build/pass1/<id>.json)
   # bookId = deriveBookId(<book>):文件名 slug;非 ASCII 主导报错,用 --book-id 显式指定
2. 对每个 pending 窗口 id:
   a. tsx skills/build/emit-input.ts <book> <id>            # 现算该窗 [LID] 前缀正文到 stdout(不落盘)
   b. 交 subagent pass1-local-extractor 抽 {nodes, edges(local)} → 存临时 out.json
   c. tsx skills/build/pass1-write.ts <book> <id> out.json   # 重算 hash + 原子写 .build/pass1/<id>.json
   # token 快耗尽就停:已写的全部幸存,下个会话从 build-status 接着来
3. 全 done → tsx skills/build/pass1-batch.ts <book>          # 消费 .build/pass1/* → merge/gate/固化 base + sidecar
   # 仍有 pending → 拒绝收口并报 pending ids(--allow-partial 显式兜底,只收 done 窗)
```

> **命门**:`pass1-write` 的 content_hash 由 TS 从窗口正文重算(`buildPass1Artifact`),agent 绝不手算 hash——书/切分变了则受影响窗口 hash 失配、`build-status` 判 pending 重抽,杜绝陈旧静默复用。

铁律:
- **逐窗原子写**:每抽完一窗立刻写其 `pass1/<id>.json`,绝不攒到末尾批量写(会话死=半成品全丢)。
- **冷启动只信磁盘**:新会话不依赖上个会话上下文里的任何东西;窗口确定性重算、`build-status` 给真相。
- **content_hash 锚新鲜度**:书/切分变了 → 受影响窗口 hash 失配 → `build-status` 判 pending 重抽,绝不静默复用陈旧抽取。
- `.build/` 是 build-only,`Book::load` 不读。

## 基座 schema(单一真相源)
基座类型由 Rust 权威定义(`crates/base-schema`,serde+ts-rs+schemars),ts-rs
生成 TS 给预构建用 `[ADR-0021]`。S0 先打通该生成链路(本仓库 `crates/base-schema`
→ `packages/core/src/generated/`)。
## profile-sidecar 独立抽取趟 `[PB6]`

> `discourse_index.json` 与 `formula_semantics.json` 不属于 Pass1 收口;不要把它们塞进 `pass1-batch`。PB6 是第二条独立 profile artifact 抽取趟:复用同一 window/input/hash,但读写 `.build/profile-sidecar/`。

```text
1. tsx skills/build/profile-sidecar-status.ts <book> [--book-id <id>]
   -> 查看 `.build/profile-sidecar/<id>.json` 的 done/pending(content_hash 校验)
2. 对每个 pending window id:
   a. tsx skills/build/profile-sidecar-input.ts <book> <id>
      -> 输出 visible_lids + formula_lids + `[LID]` 正文
   b. 交给 subagent profile-sidecar-extractor
      -> 只产 {discourse_items, formula_semantics}
   c. tsx skills/build/profile-sidecar-write.ts <book> <id> out.json
      -> 原子写 `.build/profile-sidecar/<id>.json`
3. 全 done -> tsx skills/build/profile-sidecar-batch.ts <book>
   -> 只写 `discourse_index.json` / `formula_semantics.json`
```

铁律:
- profile-sidecar batch 不改 `base.json` / `source.txt` / `profile_metadata.json` / `long_range_candidates.json`。
- `formula_lids` 由 `LidNode.kind === "formula"` 确定性注入,LLM 不判断哪些 LID 是公式。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。

## Pass2 长程边编排 `[PB3 + PB6]`

> Pass2 必须在 Pass1 `pass1-batch` 与 PB6 `profile-sidecar-batch` 都收口后运行。它从正式 `base.json`、`discourse_index.json`、`formula_semantics.json` 装配 work packet,不再从临时 candidate JSON 读取 discourse/formula。

```text
1. tsx skills/build/pass2-status.ts <book> [--book-id <id>]
   -> 生成确定性 long_range 候选视图,按 source-window packet hash 检查 `.build/pass2/<id>.json`
   -> pending = 有候选且缺少/过期 LLM 分类的窗口; skipped = 无候选窗口
2. 对每个 pending window id:
   a. tsx skills/build/pass2-input.ts <book> <id> [--book-id <id>]
      -> 输出 Pass2WorkPacket(source text + source_nodes + PB6 discourse/formula 投影 + candidate_targets)
   b. 交给 subagent pass2-longrange-linker
      -> 只分类 candidate_targets 为 {accepted_edges,pending_edges,rejected_candidates}
   c. tsx skills/build/pass2-write.ts <book> <id> out.json [--book-id <id>]
      -> 用 packet hash 原子写 `.build/pass2/<id>.json`
3. 全 candidate windows done -> tsx skills/build/pass2-batch.ts <book> [--book-id <id>]
   -> 写 `long_range_candidates.json`;用 PB3 gate 替换 `base.json` 中的 long_range 边;写 `pass2_audit.json`
```

铁律:
- `pass2-longrange-linker` 只分类给定候选,不得新增候选、节点或 local 边。
- `pass2-batch` 默认拒绝 pending;`--allow-partial` 只用于 smoke/救急。
- `pass2-batch` 替换旧 long_range 边,保留 local 边;不要手工编辑 `base.json`。
