# ADR-0099 Installed-plugin-safe executor handoff publication and diagnosable interruption

Status: Accepted, 2026-08-02.
Extends: ADR-0068 and ADR-0092.
Change type: 边界重构。

Windows 发布版的 Codex plugin 是不携带 `agents/` 的薄外壳，Build Engine Sidecar 已内嵌 extractor prompts。现有 handoff 实现却从 `--plugin-root/agents` 读 prompt；doctor 不准备 handoff、parity smoke 使用完整仓库根、release assertion 只单测 `sidecar prompt`，因而安装态失败仍被报告为 compatible。manifest 先于 handoff 写入还会暴露半发布 run，而 `executor_interrupted` receipt 无法区分中断阶段与有界原因。实施顺序见[切片方案](../切片方案-安装态executor-handoff可靠性闭环.md)。

## §1 Windows prompt 权威

**决策**:Windows executor prompt 只由 sidecar 提供。

**否决**:
- 把 `agents/` 复制进薄插件:形成 plugin/sidecar 双 prompt 权威与独立升级漂移。
- 把完整仓库当生产 `plugin-root`:依赖开发源码布局，绕过真实安装契约。
- 在 handoff 内再次直读文件:重复 `prompt` 命令已经封装的分发判断。

**命门**:packaged path 必须消费 sidecar 内嵌 prompt；Node 开发回退才可从源码根读取，二者输出字节一致且 semantic `prompt_sha256` 仍绑定原始 extractor bytes。
**何时回头**:Codex plugin 未来成为包含全部运行资产的唯一原子发布物时。
**展开**:[切片 S1](../切片方案-安装态executor-handoff可靠性闭环.md#s1-prompt-权威统一)

## §2 Dispatch run 发布边界

**决策**:handoff 先写，manifest 最后发布 run。

**否决**:
- manifest 先写再补 handoff:失败会留下外部可见但不可执行的 active run。
- 失败后删除 manifest 回滚:并发 reader/executor 可能已经观察该路径，删除破坏 append-only 审计。
- 只靠重跑覆盖:无法区分相同 replay 与冲突 bytes。

**命门**:`manifest.json` 是唯一发布标记；任何可见 manifest 必须已有摘要匹配的 create-only handoff，同 run replay 逐字节幂等，冲突 fail-closed。
**何时回头**:底层存储提供跨文件原子事务或内容寻址对象提交时。
**展开**:[切片 S2](../切片方案-安装态executor-handoff可靠性闭环.md#s2-run-原子发布)

## §3 Protocol doctor 兼容性

**决策**:Doctor 演练真实 prompt 与 handoff 准备路径。

**否决**:
- 固定返回 `compatible`:只能证明版本常量存在，不能证明安装态可执行。
- Doctor 创建真实 dispatch:只读诊断会污染租约与重试状态。
- 单独维护 doctor 检查器:检查路径与生产路径会再次漂移。

**命门**:Doctor 只在内存中解析全部 stage prompt、组合 handoff 并校验上限；任一生产依赖失败即返回结构化 incompatible，且 `dry_run_mutates_state=false`。
**何时回头**:发布系统能在安装前对同一二进制与插件快照执行受证明的等价检查时。
**展开**:[切片 S3](../切片方案-安装态executor-handoff可靠性闭环.md#s3-doctor-真实兼容性)

## §4 Executor 中断诊断

**决策**:中断 receipt 携带有界结构诊断。

**否决**:
- 只保存 `executor_interrupted`:无法区分领取前、任务中与任务间中断。
- 把原始 stderr/chat 写入 receipt:可能泄露路径、正文或 candidate，且破坏 16 KiB 上限。
- 所有中断递增 semantic attempt:把基础设施故障误记为语义失败。

**命门**:新 receipt 可选字段只含 allowlisted code、确定性派生 phase、reporter、ordinal/work-unit ref 与时间；旧 receipt 可读，新中断必须有字段，semantic attempt、lease epoch 与未领取 run 继续分账。
**何时回头**:Harness 提供可验证、可持久化的原生 agent 生命周期与取消原因时。
**展开**:[切片 S4](../切片方案-安装态executor-handoff可靠性闭环.md#s4-中断诊断与恢复口径)

## §5 安装态发布门禁

**决策**:发布验收必须使用真实薄插件根。

**否决**:
- 只在 repo root 跑 Node/Sidecar parity:会掩盖发布物缺失资产。
- 只验证 `sidecar prompt`:不能覆盖 accepted `next` 的 handoff 发布链。
- 用人工真书成功代替自动门禁:无法稳定复现安装形态回归。

**命门**:CI fixture 与正式 Setup 都必须证明薄插件无 `agents/` 时 doctor compatible、accepted next 生成完整 handoff、manifest 不可先于 handoff 可见；真实构建只作最终验收。
**何时回头**:插件与 sidecar 被同一内容寻址包原子安装、升级和回滚时。
**展开**:[切片 S5-S6](../切片方案-安装态executor-handoff可靠性闭环.md#s5-薄插件发布矩阵)
