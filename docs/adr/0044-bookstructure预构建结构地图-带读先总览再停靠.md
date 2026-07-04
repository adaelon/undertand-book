# ADR-0044 BookStructure 预构建结构地图:带读先总览再停靠

状态:已接受(2026-07-04,BookStructure §0.5 grill)

## 背景

现有带读已经有 `book.guided_route_from` + `reader.gotoLid` + `book.synthesize` 的逐停靠点管道,但用户反馈:带读不能只是一个 LID 接一个 LID 地读。读者需要 AI 先帮他们理解**这本书的总体框架、总体结构、当前位置在全书中的意义**,再进入关键内容带读。若把这件事只写进读时 prompt,LLM 会每次临时概括,成本高且容易生成无锚大纲;若把它写死成固定路线,又会破坏反馈驱动带读。

## 决策

1. **新增 BookStructure profile sidecar**:BookStructure 是 technical_learning 的预构建结构地图,不是 reader_profile、memory 或读时临时摘要。它描述书的公共结构理解,每条判断必须锚定 LID / evidence_lids。

2. **结构三层**:BookStructure 由 `spine + throughlines + key_stops` 组成。`spine` 表达书如何展开;`throughlines` 表达跨章节主题线;`key_stops` 表达带读必须停下来讲的定义、核心公式、反直觉论断、转折、例子或总结段。

3. **摘要是派生展示,结构地图是真产物**:导读摘要可由 BookStructure 在读时生成,但 sidecar 不保存一篇自由散文总述。真产物必须可被程序投影、过滤、引用和测试。

4. **构建输入只来自公共书基座与 profile artifacts**:输入可用 LID tree / source_text / title_path / graph_nodes / graph_edges / discourse_index / formula_semantics / pass2_audit / profile_metadata;不得输入 reader_profile、memory、note、highlight、用户当前问题。

5. **两阶段构建**:先按章/节等结构单元做压缩 unit card 与候选 key_stops,再用全书 unit cards + long_range/pass2 evidence stitching 出 spine、throughlines、cross-unit dependencies。不得重新把完整 source.txt 喂给 LLM 做全书总结。

6. **读时投影在带读停靠前发生**:用户请求带读时,住户 agent 先用 BookStructure 说明当前书/章地图与当前位置,再按用户目标选择 key_stops 或进入 `book.guided_route_from` 的逐停靠点循环。

## 命门

BookStructure 必须守引用红线:每个 unit role、summary、thread、key_stop reason 都要有真实 LID 证据。LLM 只产候选结构判断;能否入 sidecar 由确定性 gate 检查 LID/evidence/enum/shape。读者私人层只在读时投影阶段参与路线取舍,不得污染公共 BookStructure。

## 否决

- **只改 SYSTEM_PROMPT 临时总结**:不可复现、成本重复、容易无锚。
- **把 BookStructure 写成一篇导读文章**:无法结构化消费,也不能稳定接入 route/key_stops。
- **把 reader_profile/memory 输入预构建**:公共书基座会泄漏读者私人层,违三类记忆边界。
- **逐叶子重跑全书结构抽取**:成本接近重建一遍书,且与已有 discourse/graph/formula/pass2 artifacts 重复。

## 何时回头

- 真书实测后回填 unit 粒度(章/节/混合)、每 unit 最大 key_stops、最大 throughlines、source excerpt 字符预算。
- 若文学/历史 profile 启动,另开 profile 结构 vocabulary,不得把 technical_learning 的 spine role 硬扩成全局真理。
- 读时消费命令面已由 [ADR-0045](0045-bookstructure读时消费与mcp投影.md) 收口;若用户经常要求章节/主题专属带读,再评估 `guide_path` 的 chapter/thread scope。

## 影响

- CONTEXT 新增 BookStructure / spine / throughline / key stop / structure unit card 术语。
- 切片方案新增 PB7 BookStructure 预构建 sidecar,并让 P3 带读从“逐停靠点”升级为“先结构地图,再停靠点”。
- 后续实现需新增 build 工具、subagent/prompt、sidecar schema/gate/write/batch/status,以及读时 loader/orchestrator prompt 接入。
