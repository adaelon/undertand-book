# SESSION_CHECKPOINT — 2026-08-25 14:50 +08:00

## 新鲜度自检

- 写入时父提交：`d1b1a72 docs: refresh reader rollback checkpoint`；分支 `main`。本 checkpoint 与 CR0–CR10 实现同属其后的单一 CR 提交，读入时以实际 `git log` 为准。
- 读入时先对比 `git log --oneline -3` 与 `git status --short`；若变化，以 Git 和工作树为准。
- CR0–CR10 均已完成并纳入与本 checkpoint 相同的提交；不存在未提交的 CR 实现。

## 当前在做什么

“开放自然语言能力发现与 Runtime 证据拓扑”CR0–CR10 已完成并合并为一个提交：能力路由、Runtime 证据拓扑、隐私有界 semantic release receipt/bundle、双语九场景真实模型发布门、v4 evidence/source policy 和完整邻接复验均已通过；当前没有 CR 实现缺口。

## 下一步（可直接接手）

1. 运行 `git log --oneline -3`，确认当前 HEAD 包含 CR0–CR10 单一提交；再用 `git status --short` 区分用户原有脏文件与该已提交边界。
2. 若远端或 CI 报告 CR 回归，先按 `docs/代码链路.md` 的 CR1–CR10 入口定位，不把剩余 Reader、Memory/Profile、Desktop 或构建产物混入修复。
3. 只有 prompt/tool schema/model/profile/冻结书或 receipt verifier 发生变化时，才重跑 `cargo test -p runtime semantic_release_real_provider_replay --lib -- --ignored --nocapture` 并更新脱敏 hash。

## 未提交 / 未完成

- CR0–CR10：无未提交或未完成项。
- Reader、Memory/Profile、Desktop、预构建文档等既有修改仍未提交；书稿、构建产物、日志、handoff、测试临时目录和其他 untracked 文件均未清理或覆盖。
- `docs/代码链路.md` 中 2026-08-25 Debug Desktop 条目及对应 Desktop smoke 修改不属于 CR，仍留在工作树。

## 验证状态

- 真实模型门：`deepseek-v4-flash` Native 9/9 + bundle offline verifier 全绿；五条 overview 与 negated-summary 均结构首开、blind-read=0、Reader effect=0，selection 零工具，literal 首调用 `book.search_text`，guided 唯一 Goto。
- 脱敏 bundle：106,881 bytes；SHA-256 `5a91b989849b8ef0b8667694c63690d97cb7e092b32f028e2cf88d2a07020e89`；禁用 payload marker 0 命中。
- 单一 CR staged snapshot：Runtime 298/298 + integration 6/6（3 个真模用例 ignored，1 个本地真书用例在原工作区单独 1/1）；Artifact Tools 17/17；Book Contracts 10/10；Server CR 定向 4/4 + Book MCP 5/5；原工作区 Server 231/231；Web 38 files / 215 tests + typecheck；CR Rust 文件 rustfmt 与 `git diff --cached --check` 全绿。
- scoped Runtime Clippy：`--all-targets --no-deps -D warnings`，仅 allow 既有 `too_many_arguments/result_large_err/large_enum_variant/collapsible_match/cloned_ref_to_slice_refs/useless_vec`，全绿。
- 不带 `--no-deps` 的 `-D warnings` 会命中 `book-tool-contracts` 五个既有 `derivable_impls`；这是无关基线债务，未在 CR10 中修改。

## 冷启动读序

1. `docs/切片方案-开放自然语言能力发现与Runtime证据拓扑.md` 的 §0、§14–§17 — 冻结边界与 CR9/CR10 完成回执。
2. `docs/adr/0113-open-natural-language-capability-routing-and-runtime-evidence-topology.md` 的 §1、§6–§8 — 开放语义、收敛、Prompt policy 与既有边界。
3. `CONTEXT.md` 尾部六个 ADR-0113 术语 — Runtime 权威术语表。
4. `crates/runtime/src/semantic_release.rs:SemanticReleaseReceipt/SemanticReleaseBundle/build_*/verify_*` — CR10 closed receipt 与离线 release verdict。
5. `crates/runtime/src/orchestrator.rs:CR10_DOCUMENT_OVERVIEW_CASES/run_cr10_semantic_release_case/semantic_release_real_provider_replay` 与 `agent_prompt.rs` 的 evidence/source v4 policy — 真模夹具和产品策略边界。
6. `docs/代码链路.md` 尾部 CR10a–CR10d 与 `docs/架构.md` 的 Runtime Agent request governance — 改动账本与权威数据流。

## 本会话决策摘要

- CR10：开放语义改写只存在 eval 夹具，不进入产品 classifier/同义词表；发布结论同时依赖真实模型结构化回执和确定性不变量测试（ADR-0113 §1/§8、切片方案 §15）。
- CR10：当前真模 receipt 未因仅文档收口而重跑；任何影响 prompt/schema/model/profile/冻结书/verifier 的变更都必须使现有回执失效并重跑（切片方案 §15）。
