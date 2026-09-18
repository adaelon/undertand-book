# BookStructure 追加组装与关系增量切片方案

日期：2026-09-14。决策：[ADR-0129](adr/0129-append-book-structure-and-reconcile-relations.md)。
状态：D0、A1–A5 已完成；A1–A4 的编译验收、A5 的程序整链与真实成果副本验收通过。A6 真实模型验收待实施，先处理 §7 的具体旧来源缺项。独立于 [调用纠错方案](切片方案-主任务诊断子代理调用与纠错恢复.md)；两者都通过后再验收真实书续跑。

## 0 对齐与目标

**FrozenIntent**：程序累计有效局部结果，模型只补充相关主题与依赖的变化；最终三个清单直接来自累计状态，取消递归整表汇总。
**授权依据**：用户认可 append 方向及“程序追加、模型处理局部变化”的分工，于 2026-09-14 要求落 ADR 和切片方案。本轮交付文档，不切换正在使用的构建策略。

**实施授权**：2026-09-14 用户要求“设定goal：阅读checkpoint，实现A1-A4，完成后刷新checkpoint”。沿用已接受的术语与架构风险；A5 旧 invocation 接续和 A6 实书验收保持后续切片。

**A5 实施授权**：2026-09-14 用户要求“设定goal：阅读checkpoint，实现A5，完成后刷新checkpoint”。沿用本方案的局部贡献、关系增量和既有恢复身份；A6 真实模型调用及日常安装保持后续切片。
**ChangeType**：[边界重构]。改造全书拼接之后的生产与发布路径，保持公共 BookStructure 输出契约和 ADR-0124 引用规则。
**风险承接**：直接拼数组会丢跨片段语义；累计全表重新输入模型又会恢复原瓶颈；并发追加若没有贡献身份会重复或覆盖结果。分别由有限关系任务、局部输入和确定性物化解决。

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| BookStructure、spine、throughline、key_stop | EXISTING | 沿用 CONTEXT 和 ADR-0044/0124 |
| 局部结构贡献 | NEW | 一份已接受局部拼接成果对三清单的有来源贡献 |
| 结构关系增量 | NEW | 对已交付条目的主题新建/扩展/合并及依赖补充 |
| append | 实现级 | 按来源身份应用贡献；不是在 JSON 文件末尾写文本或累计全表重生成 |
| 物化 | 实现级 | 从已接受贡献与变化生成可发布的完整三清单 |

术语已对齐，定义见 [CONTEXT](../CONTEXT.md)。领域对齐完成。

## 1 事实与替换点

历史任务：[构建 Mastering Rust 深读](codex://threads/01a09996-7874-7582-b6ce-a7cd03d2cf9a)。2026-09-13 停止时：局部拼接 29/29；第一级汇总 27/27（25 个单输入、2 个双输入）；第二级汇总 24/25（计划 23 个单输入、2 个双输入）。52 个汇总任务仅计划把 29 份变为 25 份。

当前链路：`routeBookStructureStitchWorkUnitsV2 -> 29 个 stitch_candidate -> routeBookStructureStitchReductionLevelV2 -> 重复产生同形三清单 -> final stitch_artifact -> book_structure.json`。

问题机制：三清单按覆盖范围累积细节，最多 8 个子结果与现有输入预算不能保证真实合并；放不下多份时单份再生成。整层只减少一个结果也算可继续，没有保证减少下一层模型输入。

目标链路：

```text
既有章节卡片与局部拼接任务
  -> 已接受局部结构贡献
  -> 程序累计 spine / key_stops / 局部 throughlines
  -> 固定相关条目工作集 -> Executor 生成结构关系增量
  -> 程序应用已接受增量、排序和引用检查
  -> 原子发布 book_structure.json
```

当前符号入口：`packages/core/src/book-structure.ts` 的 stitch 路由；`build-orchestrator.ts` 的全书 reduction 循环；`book-structure-generation.ts` 的 candidate 校验；`model-input-renderer.ts` 的全量 children 渲染；`skills/build/book-structure-batch.ts` 的 sidecar 组装。

## 2 贡献与更新契约

```text
materialize(accepted_fragments, accepted_relation_deltas) -> BookStructureCandidate
RelationDelta = {
  new_throughlines,
  extend_throughlines,
  merge_throughlines,
  add_dependencies
}
```

三份完整数组只在局部拼接和程序物化处出现。关系任务输出引用已交付对象的变化，不输出全书 spine 或 key_stops；不得默认删除骨架、重点位置或替换无关摘要。

- **贡献身份**：使用已有 work unit、输入/策略与提交身份定位有效贡献；同一贡献只能应用一次，失效或新版本替换的是对应来源贡献，不是向旧内容继续堆叠。
- **spine**：按原书单元 ID 与顺序物化。局部任务的 core range 决定正文条目归属，context card 仅用于理解关系。其他片段对同一单元的上下文副本不另加骨架。
- **key_stops 与局部主题 ID**：子任务自选 ID 不默认全书唯一。程序按“来源工作单元＋局部 ID”登记并分配确定的公共 ID，同时重写所有引用；分配不依赖完成先后，遵守现有字段长度。不同 ID 指向相同段落不自动判定为同一重点。
- **重复与冲突**：同一来源重放是无操作；不同来源不同条目保留；归属冲突不能默默最后写入者覆盖。机械相同项可统一身份，语义是否相同交由相关任务判断。
- **主题变化**：扩展记录新增单元、重点引用与证据；合并明确 source IDs、目标 ID 和整合概括。程序保存成员映射，不覆盖局部贡献；重放/重建保留来源。
- **依赖变化**：指向已交付的结构单元，携带两端已交付依据。不得把共享名字或图谱边直接写成已证实依赖。
- **并发**：child 只提交独立 delta 产物；由现有 Driver/发布路径串行物化。重叠主题的已接受合并按成员集合归并；重叠成员需要改概括的任务按依赖顺序执行，不允许并发覆盖同一概括。
- **持久化**：复用 task/artifact/receipt 存储与最终原子发布，不另建通用事件库或全局写入服务。中断在提交后、物化前时，可从收据重建同一结果。

A1/A2 的具体接口为 `materializeBookStructureContributions`、`BookStructureRelationDeltaZ`、`validateBookStructureRelationDelta` 和 `applyBookStructureRelationDeltas`，分别位于 Core 的 materialization/relations 模块。

## 3 相关条目组织与结束条件

局部贡献完成后，以这组固定成果建立本次关系工作集。程序组织已有主题名、带出处的短概括、涉及单元和重点引用为有界索引；模型先从索引提出相关组，程序再给关系任务交付被选中的完整相关条目与证据。索引过大时按现有预算分批，跨批候选通过对其他批索引的检索获得；不能只比较相邻片段。

一次索引覆盖任务只针对固定贡献集合执行一次，相关组按成员身份去重。关系任务只处理实际选中的条目；选组依据是待判断的主题联系而不是预先认定语义相同。同名、共享 LID、现有概念/证据关系可作召回入口，但不能成为唯一入口或直接决定合并。

索引选择和语义整合均计入工作量；检索结果必须在预算内交付，过大组按成员覆盖拆分，禁止单输入的整表“压缩汇总”。需要跨组统一概括时，只传主题相关条目，不传全部骨架和重点清单。

工作集固定后，delta 不自行触发另一轮全书扫描。已计划依赖任务完成后即进入发布。没有可证明的联系时提交空 delta，原局部主题保留；资料不足报告具体成员，不能虚构关系来清空待办。

关闭条件：局部必需工作完成、预期单元覆盖完整、相关索引已覆盖、关系工作集全终态成功、所有最终引用合法、原子发布成功。模型调用数或文件数不能证明完成。展示“局部贡献 x/y；相关条目选择 x/y；关系任务 x/y；发布状态”，不把片段百分比当整阶段百分比。

## 4 切片顺序

- [x] D0：ADR、术语、事实基线与本方案。
- [x] A1：局部贡献的确定性追加与物化。
- [x] A2：结构关系增量 Schema 与应用。
- [x] A3：有界相关条目选择和关系任务路由。
- [x] A4：接入 Driver、终态与最终发布。
- [x] A5：旧局部成果复用及可恢复切换（不完整来源见 §7）。
- [ ] A6：隔离与真实书副本验收。

依赖：`A1 -> A2 -> A3 -> A4 -> A5 -> A6`。每刀独立验收，A1–A5 的中间状态不单独发布为可续跑的新构建算法。

## A1 局部贡献组装

**输入/产出**：已接受 stitch fragment 与 core range -> 一份确定的累计 candidate。
**触达**：`packages/core/src/book-structure.ts`、`book-structure-generation.ts`；按需要新增专用于贡献物化的模块及测试，不将其扩展为通用框架。
**实现**：冻结贡献身份、core 归属、公共 ID 分配与引用重写；局部字段沿用现有引用验证。模型不参与追加。
**红测/验收**：乱序与重复提交得到同一结果；两个 child 都用 `stop-1` 时不串引用；context 单元不重复成为 core；两个不同重点同段落时不丢条目；来源版本替换后旧贡献撤出物化。
**完成判据**：固定 29 份局部贡献零额外模型调用即可产生局部集合的完整三清单，覆盖和引用均正确；尚不宣称跨片段语义已完成。

## A2 关系增量

**输入/产出**：被选中的已验证条目、两端证据与 delta -> 新的主题成员/概括及依赖关系。
**触达**：`book-structure-generation.ts`、`book-structure-evidence.ts`、`model-input-renderer.ts` 及新的关系 delta 类型/应用函数；现有候选纠错反馈随之覆盖字段位置。
**实现**：只允许 §2 四类变化；引用必须属于实际交付对象。合并身份与序列由程序处理，模型负责语义判断和有依据的概括。
**红测/验收**：主题扩展与合并保持所有成员；空 delta 不损失原贡献；重复 delta 无重复；未知成员/未交付证据拒绝；重叠合并结果无顺序漂移；补依赖不改动无关骨架和重点。
**完成判据**：旧局部成果保持原字节，最终变化来自独立已接受 delta；writer 可定位错误而非让模型重写全表。

## A3 相关任务路由

**输入/产出**：固定局部贡献 -> 有覆盖记录的索引选择与有限关系工作集。
**触达**：`book-structure.ts`、`build-orchestrator.ts`、`stage-work-unit.ts`、`automatic-build-dispatch.ts`、`model-input-renderer.ts`；新增对应 agent 提示词并接入 `skills/build/sidecar-entry.ts`。
**实现**：按 §3 组织索引、检索、去重选组和必要的依赖顺序；沿用预算与 Executor 语义执行。只传任务相关字段，delta 不再次扩大全书工作集。
**红测/验收**：非相邻、不同名称但语义相关的示例可被选组；同名但无关系的示例不被程序强制合并；超预算输入不会变成单输入整表重写；重复选组只派一次；无关系的集合在有限空 delta 后结束。
**完成判据**：记录索引与任务覆盖、实际输入字节/token 和模型调用数；每次语义任务有明确新增关系目标或明确无关系结论，不再出现 `29 -> 27 -> 25` 的同形归约。

## A4 调度与发布

**输入/产出**：局部贡献和关系工作集状态 -> 进度、pending 或最终 sidecar。
**触达**：`build-orchestrator.ts`、`automatic-build-close.ts`、`book-structure-generation.ts`、`skills/build/book-structure-batch.ts` 及 Driver 状态投影。
**实现**：移除新算法中的递归 stitch-reduce 派发；程序物化最终三清单后沿用原子发布。大产物写入不经过模型输入通道。更新 public contributor/quality routing，避免仍要求一个 LLM final root 的旧关闭条件。
**红测/验收**：模型任务全成功但发布失败时不能 DONE；关系任务缺一项仍 pending；重复 close 不重复应用 delta；最终文件满足现有 Reader 消费与证据引用约束；最终体积超过单次模型输入预算也能发布。
**完成判据**：从局部贡献到 DONE 全链经过新权威路径，进度区分局部/关系/发布；Reader 结构投影回归通过。

## A5 复用和切换

**输入/产出**：当前输入/策略下的旧局部成果及既有计划 -> 新组装路径的可恢复状态。
**触达**：`automatic-build-policy-generation.ts`、`automatic-build-task-store.ts`、`book-structure-generation.ts`、`build-orchestrator.ts` 及既有恢复/发布测试。
**实现**：复用现有生成策略和依赖失效机制，只更新改变的拼接后策略；局部语义输入/输出合同未变时允许接纳原 29 份成果。旧各级 reduce 保留历史，不同时当作追加来源。采用字段映射可确定完成的 ID 归属转换，不让模型重做映射。
**红测/验收**：旧局部 29 份可接入；source/局部语义契约变化只失效实际受影响贡献和关系任务；旧成功收据不改写；恢复不重复关系 delta。旧 invocation 若绑定原内部计划，走既有合法计划接续流程，不手改 plan digest 或活动租约。
**完成判据**：可从中断状态重建同一物化结果；发布前最后一份有效公共文件仍可读。不能接纳的具体来源及原因进入已知问题，不能笼统重建全书。

## A6 端到端验收

**夹具**：小书覆盖共享重点 ID、非相邻主题、同名不同义、两端证据、重复/乱序/中断；Mastering Rust 工作区副本提供真实 29 份已接受局部成果。只读原目录，续跑使用隔离副本。
**确定性检查**：比较输入贡献与最终条目的来源映射、单元覆盖、重点引用、主题成员、依赖目标；验证 repeated apply/restart 结果相同，旧成果不被修改。对实质语义关系用少量人工可核对案例验收，不以模型自评分替代。
**成本报告**：单列复用的既有工作、相关条目选择、关系生成、重试、模型输入/输出、控制调用和墙钟。历史 27+25 次是已观测基线，不为测量重新跑旧全书汇总。新工作必须有完成终点和可解释的每次调用用途。
**交付**：相关 Core 定向测试、类型检查、编译/插件资产和 Reader 消费回归；补架构/代码链路/安装记录。实际书语义质量、复用集合和调用数均报告，不以减少文件数代替收益。

## 5 已知边界

- 索引与相关条目选择不能先验保证找出全书所有隐含主题；A3/A6 必须包含非相邻、不同措辞的实质联系，并报告未覆盖场景。
- 一份旧局部成果若已遗漏重要内容，append 不会自动补出缺失信息；按具体来源修复，不能用机械覆盖检查冒充语义完整性。
- `max_children=8` 的理论下界不是新方案成本承诺；模型成本包含索引选择与关系整合，不承诺一次调用结束。
- 初次交付保持单元提取与单元内 reduction；本方案替换的是全书局部拼接之后的递归整表汇总。

## 6 A1–A4 实施与验证

- A1：以当前来源工作单元/已接受 artifact 身份取有效贡献；按来源及局部 ID 排序分配短公共 ID，重写重点引用，按 core 范围精确覆盖原书单元。来源冲突拒绝，替换后旧版本退出。
- A2：独立严格 Schema 限定主题新建/扩展/合并和依赖补充，验证实际交付成员与证据；错误沿既有 writer 诊断返回字段位置。固定任务序重建，保留主题成员映射。
- A3：固定索引按预算分块并覆盖跨块组合；模型选择相关组，按成员拆成去重条目对。关系任务串行读取最新概括，独立成果不重新派生索引。超出预算的完整条目明确停止。
- A4：生产 fragmented stitch 后直接物化并路由 selection/delta；局部及关系结果进入质量贡献，索引进入依赖覆盖。最终输出由程序写入，关闭同时要求精确单元覆盖、合法引用、匹配公共字节与既有原子发布收据。Root 只接收进度计数。
- 程序验证：57 项相关用例分别通过，含两项既有 orchestrator BookStructure 场景；Core TypeScript 通过。长集成使用真实 Executor 两种新任务、现有发布器和 Driver，最后返回 DONE。
- 392-module Build Engine 编译通过，outside-repo Node/compiled parity、17 个提示词入口和 protocol doctor 通过。没有更新本机安装或原书工作区。
- 夹具：29 单元、6 局部贡献、28 选择任务、2 关系任务，最终 82,501 字节；最后一个关系任务提交空 delta，质量与发布仍正确完成。64 条索引覆盖全部 2016 个条目对。
- 成本、原始失败及边界详见 [A1–A4 验收](performance/understand-book-a1-a4-release.md)。

## 7 A5 实施与验证

- 局部拼接保持 `book-structure-stitch-fragment.full.v4`；已有 policy-generation/task-store 的成员冻结与尝试隔离足以承接，仅增加拼接后的 select/delta 策略，不新增迁移存储。
- 29 份有效局部成果的磁盘夹具通过当前读取器接入；公共 ID 映射与关系选择计划重建一致，任务、成果及局部策略字节不变。局部输入或语义合同变化时，对应读取被拒绝，其余 28 份仍 fresh。
- `BookStructureContributionCoverageError` 汇集不完整来源及 core LID；生产路由转为 `source_slice_coverage_invalid` 恢复信封，替代普通异常。旧语义成果与成功收据不改写。
- 生产整链使用同一 invocation，从局部阶段到关系提交和 DONE；旧 reduce 文件保留原字节且不计入累计贡献。旧计划确有变动时，沿用 Driver 的 `confirm_current` 持久授权，测试覆盖拒绝过期决策与合法接续。
- Mastering Rust 的 29 份成果身份均 fresh；28 份 core 完整，`stitch:fragment:0003` 的范围 22–30 仅有 22、30，缺少 23–29，因此该来源未接纳。51 份旧 reduce 仅保留历史。7,534 个历史文件在隔离副本准备前后及原目录逐字节相同。
- 原 invocation 绑定 `build_plan.v1`，未冻结内部 descriptor plan；不需要改写 plan digest。原目录尚无 `book_structure.json`；已有公共文件的保留与发布失败行为由小书集成覆盖。
- 14 项定向测试、Core TypeScript 与副本脚本严格 TypeScript 通过；候选均来自固定夹具或既有成果，模型调用 0。完整证据、复跑入口与已知问题见 [A5 验收](performance/understand-book-a5-release.md)。
