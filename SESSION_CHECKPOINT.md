# SESSION_CHECKPOINT - SR7-SR11 与 SR8.1 已完成

更新时间：2026-07-20 16:32 +08:00

## 冷启动顺序

1. 先读 `docs/切片方案-Agent对话用户可见来源.md` 的 §16-§21；SR7-SR11 已实现，不要重复施工。
2. 再读 `docs/adr/0087-provenance-aware-answer-delivery-and-compact-provider-history.md`；SR8.1 已把修复边界改为单次自由重写。
3. 沿 `docs/代码链路.md` 最后的 SR7-SR11、SR8.1 条目定位实现和测试；架构总览见 `docs/架构.md`。
4. 执行 `git log -3 --oneline`、`git status --short`；工作树有大量用户既有 dirty/untracked 文件，不得清理或恢复。

## 新鲜度

- 本 checkpoint 写入时基线为 `53dd983 docs(release): record agent source setup build`；SR7-SR11 与 SR8.1 将和本文件在同一提交中落库，读入时以 `git log -3 --oneline` 为准。
- 最新 Setup：`dist/UnderstandBookSetup.exe`，35,508,464 bytes，SHA-256 `9D7B1D89C1C0FDD82AE8721BDD0BE35CB5A3076CA8C0997141BB019561465141`。
- Setup 来自 detached `53dd983` + SR7-SR11 Runtime/Server + SR8.1 Runtime/Web 精确补丁；主工作区其他 dirty 文件未进入产物。
- 本轮 `.tmp-sr81-release-worktree`、补丁与 Git 注册已删除。旧 `.tmp-sr11-release-worktree` 仍可能因用户现有 Vite 进程占用硬链接而残留；不要为清理它停止用户进程。

## 已完成能力

- SR7：`AnswerProvenanceLedger` 分离 public/internal locator；公开同形章节号可交付，内部 locator 自然化和显式 `LID/节点` 泄漏拒绝；Native/ReAct 共用验证器。
- SR8/SR8.1：合法首答零修复；非法回答最多一次独立、无工具修复。修复请求不带完整历史或 Tool body，允许重写整答，最终仍必须通过同一 marker/source-ref/provenance/LID 编译闸。
- SR9：交付诊断只在服务端持久；公开 chat/history/TS/trace/Provider messages 均无诊断字段和值；最终失败只返回通用回答。
- SR10：completed Tool 历史在 Provider 读时替换为 typed receipt；当前活动回合保留完整 Tool result，持久 messages 零写回。
- SR11：真实 Transformer 跨回合回放覆盖同形碰撞、内部位置自然化、修复路径和本轮重读引用；真实 cardiac HTTP ref 跨重启稳定。
- Web：只有 `warning=CONTEXT_BUDGET_EXCEEDED` 才显示“上下文不足”；交付失败的 `incomplete=true, warning=null` 只显示通用失败回答。

## 决策边界

- 用户明确接受重试时不限制改写范围；模型可自由重写候选答案。这会允许主张变化，风险由“单次调用 + 禁止工具 + 同一确定性编译闸”约束，而非字符范围比较。
- 来源保持可选；Runtime 不自动调用 `source.present`，历史 ref 权限不跨回合继承。
- public provenance 只来自当前/历史公开文本、验证选区和白名单规范证据正文；未知 JSON 不递归扫描。
- diagnostics 不保存候选全文、repair prompt 或思维链，不进入公开契约或轨迹。
- receipt 只含 tool、顶层 locator args、状态/error、账本接受的 evidence、source refs、独立 opaque digest。
- 轨迹 UI、公开 history View、选区注入、`book.*` 契约和持久 session messages 未改变。

## 故障复盘

- 最新真实会话 `chat_1784534009277_8` 的导航和读取已成功；初答含内部 locator，旧局部修复因改动范围扩大被拒绝，最终返回 `incomplete=true, warning=null`。
- UI 曾把所有 warning 为空的 incomplete 都显示成“上下文不足”，造成频繁上下文耗尽的假象；它不是 Provider token 预算触顶。
- SR8.1 同时移除局部范围拒绝并修正 UI 归因；最终编译失败仍 fail-closed，不向用户暴露内部错误码。

## 验证记录

- `cargo test -p runtime answer_delivery` 4/4；Runtime 173/173；Server `agent_delivery` 2/2；`cargo test --workspace` 656/656。
- Web 26 files / 146 tests；typecheck 与 production build 通过。
- Runtime `cargo fmt -p runtime -- --check` 与目标 diff check 通过。
- 隔离发布通过 plugin release parity、Web build、compiled sidecar smoke、Rust release、Tauri 与 NSIS。
- 现有 `ts-rs` serde 警告和 Vite 大 chunk 警告不阻断。

## 文件边界

- 生产实现：`crates/runtime/src/orchestrator.rs`、`crates/server/src/lib.rs`、`packages/web/src/components/RightRail.vue`。
- 测试：Runtime 同文件测试、`packages/web/src/components/RightRail.test.ts`；Server 既有交付测试继续覆盖私有诊断。
- 文档：ADR 0087、来源切片方案、`docs/架构.md`、`docs/代码链路.md`、本 checkpoint。
- `crates/runtime/src/memory_review.rs`、`profile_api.rs`、reader/base-schema 及其他 dirty 修改不属于本轮，不得吸收或恢复。

## 下一步原子动作

1. 执行 `git show --stat --oneline HEAD`，确认最新提交包含 SR7-SR11/SR8.1；继续开发前先核对剩余 dirty 文件归属。
2. 未经用户明确要求，不安装或启动 Setup，也不 push。
