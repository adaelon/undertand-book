# ADR-0100 Budget-routable model work units and truthful build recovery

Status: Accepted, 2026-08-02.
Extends: ADR-0085, ADR-0092, ADR-0093 and ADR-0099.
Revises: ADR-0009 的“单叶超限仍可成为窗口”只能用于结构诊断，不得进入模型执行。
Change type: 边界重构。

真实 EPUB 在 Pass1 已关闭后进入 profile sidecar 规划时，单个 LID `1.7.2` 的正文估算为 6,992 token，超过 `profile_sidecar` 5,000-token 路由硬闸；当前代码从 `plan` 抛出裸堆栈，无法形成 `needs_user`、迁移或恢复动作。实施顺序见[切片方案](../切片方案-预算可路由模型工作单元与构建恢复闭环.md)。

## §1 LID 与模型输入边界

**决策**:LID 保持证据真相，超限正文仅切模型输入片。

**否决**:
- 重切 EPUB/LID:会改变引用、标注与既有产物的定位身份。
- 截断超限 LID:正文覆盖不完整且质量闸无法证明无损。
- 由 executor 临时切分:切点、freshness 与重试半径不可复现。

**命门**:模型输入片只携带父 LID 与受校验源码区间；core 区间精确覆盖原 LID，overlap 只扩可见上下文，不产生新 citation anchor。
**何时回头**:若产品正式迁移到句级 LID 并提供引用、标注和派生产物的全量重锚协议。

## §2 预算可路由性

**决策**:所有模型工作单元须在调度前通过版本化输入硬闸。

**否决**:
- 只限制 dispatch 总 token:一个包可拆开，但包内单任务仍可能物理放不下。
- 抛异常后让调用者猜恢复:计划面无法区分升级、重建与源结构阻塞。
- 提高阈值绕过:模型、prompt 或输出预留变化后会再次失效。

**命门**:router 以版本化 estimator、render contract、prompt/output reserve 和 per-kind 上限生成证明；planner/doctor 复验，未证明的 unit 不得创建 lease、dispatch 或 attempt。
**何时回头**:Harness 提供可验证的真实请求 tokenization 与硬拒绝前 dry-run 时，可替换估算器但保留同一证明合同。

## §3 Pass1 策略迁移

**决策**:Pass1 路由升级采用可审计的选择性复用与重建。

**否决**:
- 把 `pass1_window.v1` 直接标成新鲜:旧 envelope 未绑定新路由与预算证明。
- 全书无条件重跑:相同输入、prompt、schema 与质量策略的旧结果被无谓丢弃。
- 覆盖旧 policy lock 和 task:恢复与审计无法解释策略切换。

**命门**:仅“单新 unit 与旧 unit 的渲染输入逐字相同、prompt/schema/quality 相同且已过新硬闸”可由 migration receipt 采用；其余 unit 重建，旧锁与产物 append-only 保留。
**何时回头**:若选择性采用的实现或验证成本高于重建成本，则保留迁移收据并降级为全量派生产物重建。

## §4 close 成功语义

**决策**:`close` 成功仅表示发布后阶段快照已关闭且新鲜。

**否决**:
- 子脚本退出 0 即成功:只能证明进程结束，不能证明公开产物已发布且可读。
- 只做发布前质量检查:事务后缺文件、hash 漂移仍会被漏报。
- 把阶段关闭当整本 BuildPlan 完成:会跳过后续 sidecar、Pass2 或 BookStructure。

**命门**:成功必须同时具备通过的质量报告、publication receipt、发布后重算的 `stage.closed=true` 与 freshness digest；调用方仍须重新 `plan/next`，只有 `action.kind=done` 才结束。
**何时回头**:底层存储提供单事务 stage commit 与可验证完成标记时，可用该标记替代多文件后置重算。

## §5 结构化恢复

**决策**:可预期构建阻塞必须返回有界结构化恢复信封。

**否决**:
- 向用户暴露 Node 堆栈:没有稳定错误码、阶段或安全恢复动作。
- 只写自由文本 stderr:plugin、sidecar 与测试无法确定性分支。
- 自动修改 EPUB 或降低质量:恢复动作越过已确认 BuildPlan 边界。

**命门**:信封只含 version、phase、code、stage、policy/router digest、受限 work-unit/LID 引用、预算数值、retryability 与 allowlisted recovery；不得含正文、candidate、私有目标或任意路径。
**何时回头**:跨进程 tracing 成为统一错误权威时，信封仍保留稳定的用户恢复码与脱敏边界。

## §6 质量与发布门禁

**决策**:模型切片增加范围覆盖闸，不降低既有语义质量闸。

**否决**:
- 任一同 LID 分片成功即视为整 LID 完成:会静默丢失正文区间。
- 用 overlap 重复量冒充覆盖率:重叠不能补缺失 core span。
- 迁移时 `--allow-partial`:会把策略升级变成质量降级通道。

**命门**:close 前须证明 core span 无缺口无重叠、每片 input hash/policy 新鲜、全 eligible unit terminal；既有 integrity 与 selected quality floor 只可保持或收紧。
**何时回头**:真书 goldset 证明某类内容必须用不同语义路由时，升级独立 kind/router 与质量基准，不放宽全局门禁。
