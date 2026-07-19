# ADR-0084 Codex harness inference and durable sidecar task mailbox

Status: Accepted, 2026-07-18.
Extends: ADR-0067.
Revises: ADR-0042 clauses 3-4 for guided automatic prebuild concurrency.

### §1 语义执行所有权

**决策**:模型留在 harness,任务状态归 sidecar。

**否决**:
- Sidecar 直连模型:引入 provider 凭据与第二套模型运行时。
- 完整 JSON 经 root 中转:把对话上下文变成文件传输总线。
- 仅靠会话续跑:无法提供租约、并发恢复与可审计指标。

**命门**:root 只接收 receipt;Token 无 receipt 时必须为 `unknown`。
**何时回头**:Codex 提供稳定的进程级任务 API,或产品决定由 sidecar 托管模型。
**展开**:[一键预构建执行面与成本治理](../修复方案-一键预构建执行面与成本治理.md)
