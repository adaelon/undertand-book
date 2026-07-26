# ADR-0093 Intent-confirmed progressive prebuild and reader-private goal artifacts

Status: Accepted, 2026-07-25.
Extends: ADR-0047, ADR-0048, ADR-0063 and ADR-0075.
Revises: ADR-0067's default meaning of "full prebuild".
Change type: 边界重构。

全量 Pass1、profile sidecar、Pass2 与 BookStructure 只有在一本书被长期反复使用时才可能摊薄成本。现有 reader gate 已允许可信基础层完成后立即阅读,自然语言 sidecar 也已有 draft-confirm 两步契约;缺失的是从用户目标到整套构建范围、成本和私有产物的产品级计划。实施顺序见[切片方案](../切片方案-需求驱动渐进式预构建.md)。

## §1 先阅读再授权昂贵构建

**决策**:立即可读,昂贵构建须确认计划。

**否决**:
- 导入即自动运行当前全量 DAG:继续把数小时等待和 token 成本当入场费。
- 收集需求前阻塞 Reader:用户无法先检查原文并校准目标。
- 以 job 或 executor 成功替代 artifact gate:破坏既有信任边界。

**命门**:paper 仍先过 source reconciliation 与 Hybrid foundation;“立即可读”不等于跳过来源信任。
**何时回头**:若某种输入无法在不调用语义模型时形成可验证 LID 基座,单独评审该输入类型,不得放宽全局 reader gate。
**展开**:[预构建流程](../预购建流程.md#主状态机)

## §2 公共层与目标层隔离

**决策**:预构建分公共基础、公共语义和私有目标三层。

**否决**:
- 把用户目标注入公共 Pass1/Pass2/BookStructure:同书不同目标会互相污染并破坏复用。
- 为每个目标复制 source/LID/公共 graph:存储、迁移和证据真相分叉。
- 把目标产物暴露给 Visitor 或 Book MCP:泄漏用户目的与私人工作成果。

**命门**:目标产物只能引用真实 LID 和已门禁公共 artifact,不得反向写入书目录根 truth。
**何时回头**:团队明确需要共享、人工策展的 project artifact 时,另立 ADR 定义发布、审阅和撤回流程。
**展开**:[ADR-0048](0048-抽取规则包化-content-profile插槽化-technical-learning归档为默认规则包-paper作为新增规则包.md)

## §3 BuildIntent 两步确认

**决策**:需求先成 `BuildIntent` 草稿,确认后规划。

**否决**:
- 原始自由文本直接拼入 extractor prompt:无法审计范围、隐私、输出和 freshness。
- 从阅读行为或 ReaderProfile 自动推断构建目标:把弱证据误当用户授权。
- 强制用户填写长问卷:在价值出现前增加产品摩擦。

**命门**:首屏只要求“准备用这本书完成什么”,预设选项与自由文本等价进入 draft-confirm 流程。
**何时回头**:真实使用证明单问无法稳定得到目标范围时,只增加能改变计划的追问,不暴露内部 stage 术语。
**展开**:[既有 SidecarBuildIntent](../../packages/core/src/sidecar-plan.ts)

## §4 BuildPlan 与依赖闭包

**决策**:目标编译为最小依赖闭包并显式列出成本。

**否决**:
- 让模型任意选择 stage 顺序:可产生不满足 DAG 的伪计划。
- 只展示 token、不展示墙钟与未知项:无法回答用户的真实等待成本。
- 用户确认后静默扩大 scope 或预算:确认失去意义。

**命门**:`plan_digest` 绑定 source/profile/intent/recipe/artifacts/dependency closure/budget;漂移超过确认边界进入 `needs_user`。
**何时回头**:能力注册表无法表达稳定的新产物依赖时,升级 registry/schema,不得用 prompt 特判绕过。
**展开**:[ADR-0092](0092-phase-aware-automatic-build-leases-and-executor-dispatch-bundles.md)

## §5 产品模式与默认语义

**决策**:当前完整产物仅作 `standard_deep` 默认模板。

**否决**:
- 把 `standard_deep` 设为导入后的自动执行:成本问题没有变化。
- 把 `sparse` quality profile 当低价产品模式:覆盖率参数不是用户目标。
- 只提供自由文本定制:用户无法快速采用已验证的标准能力。

**命门**:“默认”只表示计划生成时首选模板;执行必须来自显式模式选择或显式兼容命令。
**何时回头**:分群数据证明长期深读用户绝大多数主动选择标准深读时,可调整推荐排序,仍不得取消确认。
**展开**:[产品担忧](../../产品担忧.md)

## §6 Freshness 与目标变更

**决策**:公共产物无目标,私有产物绑定目标与计划。

**否决**:
- 把 intent 加进所有公共 policy fingerprint:目标修改会触发全书重建。
- 目标变化后继续复用旧 overlay:结果与当前需求不一致。
- 覆盖式修改已确认计划:无法审计用户授权和实际成本。

**命门**:replan 生成新 revision 并 supersede 旧计划;source 变化使 intent/plan stale,公共 artifact 是否 stale 仍按自身 fingerprint 判断。
**何时回头**:若目标相关抽取被证明具有跨用户稳定价值,先提升为版本化 content-profile capability,不直接提升某个私人产物。
**展开**:[ADR-0085](0085-stage-specific-work-units-and-policy-bound-artifacts.md)

## §7 私有存储与消费面

**决策**:目标状态与产物进入独立读者私有存储。

**否决**:
- 写入 `.understand-book/<book_id>` 公共书目录:书被复制或注册时会携带私人目标。
- 混入 `memory.json` 的 ProfileFact:构建计划不是读者画像或记忆事实。
- 私有权限不可验证时回退公共目录:以可用性换隐私泄漏。

**命门**:私有 store 不可用时仍允许基础阅读和公共标准产物消费,但目标 draft/build 必须 fail-closed 并可诊断。
**何时回头**:引入账户、同步或团队 workspace 时,重新定义所有权、加密、同步冲突和删除传播。
**展开**:[ADR-0075](0075-runtime-owned-evidence-backed-profile-memory.md)

## §8 既有构建兼容

**决策**:既有公共产物复用,在途任务按原策略续建。

**否决**:
- 为迁移删除既有 Pass1/sidecar:浪费已通过门禁的昂贵产物。
- 把既有 SidecarBuildIntent 当顶层 BuildIntent:单一视图请求不能代表整套产品目标。
- 让旧一键命令静默选择 goal-directed:旧调用没有目标信息。

**命门**:显式调用旧“完整预构建”命令可记录为 `standard_deep` 的 `explicit_legacy_command` 确认来源;导入、打开或恢复旧书不能自动创建该确认。
**何时回头**:兼容窗口结束且使用数据证明旧命令已无调用时,删除映射前单独发布迁移说明。
**展开**:[ADR-0067](0067-codex-plugin-one-command-prebuild.md)
