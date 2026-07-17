# ADR-0071 Auto-enter reader after trust

Status: Accepted, 2026-07-11.
Revised by: ADR-0082, which defines trusted Reader entry as accepted source plus hybrid-foundation integrity; mapping quality may be degraded.

**Decision**:确定性 artifact readiness 给出 `route=reader` 后立即进入 reader,任何 job 状态或历史界面偏好都不得阻塞。

**Rejected**:
- 等待用户点击“进入阅读”:可信构建完成后仍暴露编排细节,且旧 job 状态可能让按钮永久失效。
- 恢复 sessionStorage 中的 Workbench 偏好:会把过期界面选择置于当前 artifact truth 之上。
- 完全移除 Workbench:可信书仍需要用户主动进入诊断和查看构建记录。

**Constraint**:用户从 reader 主动打开的 Workbench 只作为当前诊断视图,不得改变 reader trust。
**Revisit when**:构建转为后台并行任务,需要在阅读中持续展示新 artifact revision。
