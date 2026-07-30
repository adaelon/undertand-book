# Codex 主导构建规划与 Reader 确定性权威切片方案

状态:方案冻结;CB0-CB6 已完成,CB7 待实施。

冻结决策:[ADR-0096](adr/0096-codex-authored-build-planning-reader-deterministic-authority.md)。承接边界:[ADR-0093](adr/0093-intent-confirmed-progressive-prebuild-and-reader-private-goal-artifacts.md)、[ADR-0094](adr/0094-codex-designed-artifact-blueprints-and-versioned-registry.md)、[ADR-0095](adr/0095-active-artifact-read-surface-and-book-mcp-boundary.md)。

## 0. 对齐确认单

**FrozenIntent**:Codex goal-directed 入口不再把 raw goal 交给 Reader-side provider 二次规划。Reader 先投影当前书的有界 `BuildPlanningContext`;当前 Codex 直接选择/复用/设计 0..N 个 `ArtifactBlueprint`,形成严格 `BuildPlanningCandidate` 并通过 stdin 提交。Reader/Core 重读当前状态、确定性解析 Blueprint、编译最小依赖闭包、持久化唯一 reader-private draft 并投影给用户确认。Reader UI 可继续用本地 provider 产生同形候选,但两入口必须共用同一 validator/compiler/store。首版不把 store、确认权、artifact gate、发布权或 Reader UI 独立能力迁给 Codex,不改既有 BuildPlan/overlay canonical identity。

**TermMap**:

| 术语 | 状态 | 冻结定义 |
|---|---|---|
| BuildPlanningContext | NEW | Reader 对当前 book/source/profile/scope/Blueprint 合同的有界只读快照,带 canonical digest |
| BuildPlanningCandidate | NEW | Codex 或 Reader fallback planner 产出的严格未授权语义候选,不是 BuildPlan |
| Codex 构建意图入口 | BOUNDARY_CHANGE | 从 raw-goal-only 改为 context → candidate → deterministic draft |
| BuildIntent / BuildPlan | BOUNDARY_CHANGE | 仍由 Reader/Core 编译和持久化;不再要求 Codex 入口调用 Reader provider |
| ArtifactBlueprint | EXISTING | 仍由 Codex 选择或设计,受限 DSL 与 digest 不变 |
| Reader-private store | EXISTING | 唯一 intent/plan/overlay 状态权威 |
| Reader UI Planner | BOUNDARY_CHANGE | 仅是可选 candidate producer,不拥有独立编译或验收语义 |
| Core gate | EXISTING | 校验 schema、scope、依赖、预算、evidence 与 digest 的唯一裁判 |

**RiskReceipt**:用户在 Codex task `019fb118-2a26-7022-873c-662bf5642a4b` 于 2026-07-30 接受 candidate 注入扩大本地控制器输入面的风险;控制措施为有界上下文、context digest、strict candidate schema、Reader 当前态重读、Core 确定性编译、一次计划确认、stdin-only 私有传输和无静默 provider fallback。

**ChangeType**:`[边界重构]`。

领域对齐完成;TermMap 零未解析符号。

## 1. 目标边界与不变量

| 不变量 | 确定性验收 |
|---|---|
| Codex 是语义规划者 | Codex candidate 路径的 model adapter 调用次数必须为 0 |
| Reader 是状态权威 | 只有 Reader-private store 可创建 intent/plan revision 与 active overlay |
| Core 是唯一裁判 | candidate 必须经同一 Blueprint resolve、scope、capability、budget、digest validator |
| inspect 只读 | `BuildPlanningContext` 不能创建 intent、plan、task、attempt、lease 或 usage event |
| context 防漂移 | source/profile/Registry/合同上限改变后旧 `context_digest` 必须 fail closed |
| candidate 未授权 | candidate 不能直接 claim task 或激活 overlay;仍需用户确认 `plan_id + plan_digest` |
| 私有数据不外溢 | context/result 不含 raw goal、API key、filesystem path、历史 plan 正文或 artifact body |
| 无静默二次规划 | 新 Codex plugin 缺 candidate 能力时返回 upgrade-required,不得改走 raw-goal Planner |
| Reader UI 不回归 | Reader UI provider 仍可产同形 candidate,随后与 Codex 走同一编译链 |
| 既有计划不迁移 | v1/v2 plan、accepted overlay、digest 与确认来源保持原字节语义 |

## 2. 合同草图

```ts
interface BuildPlanningContextV1 {
  version: "build_planning_context.v1";
  target: {
    book_id: string;
    source_fingerprint: string;
    content_profile: "technical_learning" | "paper";
  };
  scope_catalog: {
    available_lids: string[];       // 有界确定性样本
    available_lid_count: number;
    available_sections: string[];
    available_section_count: number;
    truncated: boolean;
    whole_book_allowed: true;
  };
  blueprint_registry: ArtifactBlueprintPlannerSummaryV1[];
  blueprint_registry_count: number;
  blueprint_registry_truncated: boolean;
  candidate_contract: {
    version: "build_intent_planner_candidate.v2";
    max_artifacts: 16;
    allowed_shapes: ["collection", "table", "graph", "sequence", "document"];
    one_off_blueprint_version: "artifact_blueprint.v1";
  };
  context_digest: string;
}

interface CodexBuildIntentDraftInputV2 {
  user_goal: string;                 // stdin-only;只进 reader-private intent
  planning_context_digest: string;
  candidate: BuildIntentPlannerCandidateV2;
  budget?: BuildBudgetPolicy;
}

type CodexBuildIntentCommandV2 =
  | {
      version: "codex_build_intent_command.v2";
      operation: "planning.context";
      target: { workspace_dir: string };
      input: Record<string, never>;
    }
  | {
      version: "codex_build_intent_command.v2";
      operation: "draft.candidate";
      target: { workspace_dir: string };
      input: CodexBuildIntentDraftInputV2;
    }
  | CodexStatusConfirmRejectArtifactCommandV2;

type CodexBuildIntentResultV2 =
  | {
      version: "codex_build_intent_result.v2";
      status: "ok";
      response: BuildPlanningContextV1 | CodexBuildIntentResponseV1 | IntentArtifactResponseV1;
    }
  | {
      version: "codex_build_intent_result.v2";
      status: "error";
      error: {
        error_code: string;
        category: string;
        phase: "request" | "context" | "candidate" | "blueprint" | "compile" | "store" | "artifact";
        retryable: boolean;
        message: string;             // 有界且已脱敏
      };
    };
```

`context_digest` 的 canonical identity 至少绑定 `book_id/source_fingerprint/content_profile`、完整 Registry identity+digest 集、scope catalog 的完整计数与采样策略、candidate contract 版本和所有上限。它不是 BuildPlan identity;提交成功后仍由既有 `intent_digest/plan_digest/blueprint_digest` 绑定持久事实。

`BuildPlanningCandidate` 继续复用已发布的 `build_intent_planner_candidate.v2`;新协议只改变 candidate 的生产者与提交边界,不修改候选 schema。Codex 可选择 system/user_private Blueprint,或携带完整 one-off `ArtifactBlueprintV1`;Reader 必须重新 resolve 并验证,不能相信 candidate 自带的 source/digest 声明。

## 3. 状态机与数据流

```text
Codex receives explicit user goal
  -> planning.context (read-only)
  -> Codex designs BuildPlanningCandidate
  -> draft.candidate(context_digest + goal + candidate)
      -> Reader reloads current book/source/profile/Registry
      -> recompute context_digest
      -> strict candidate validation
      -> resolve every Blueprint through intent.blueprint
      -> Core compile BuildIntent/BuildPlan + dependency closure + budget
      -> persist one reader-private draft
  -> Codex shows redacted plan projection
  -> user confirms exact plan_id + plan_digest
  -> existing automatic-build + private artifact loop
  -> Reader/Core accept and publish current overlay
```

```text
Reader UI goal
  -> Reader provider produces BuildPlanningCandidate
  -> same strict validation/resolve/compile/persist function
  -> same plan projection and confirmation gate
```

禁止的旁路:

```text
Codex candidate -> direct plan file write
Codex candidate -> direct task claim
Codex candidate -> accepted artifact
v2 unavailable -> silently call v1 raw-goal draft
Reader UI candidate -> separate digest/compiler implementation
```

## 4. 实施切片

### CB0 - 术语、ADR 与实施边界

状态:完成,2026-07-30。

**输入/输出**:输入为用户确认、ADR-0093/0094/0095 与当前实现事实;输出为 CONTEXT、ADR-0096 和本方案。
**做**:冻结 Codex/Reader/Core 职责、合同草图、切片依赖、发布与回滚门。
**不做**:不改 controller、Core、plugin skill、Reader UI、私有 store 或已确认计划。
**完成判据**:术语零冲突、文档互链、`git diff --check` 与 Markdown 链接检查通过。

### CB1 - Core planning context 与 v2 命令合同

状态:完成,2026-07-30。

依赖:CB0。

**输入/输出**:输入为当前 candidate、Registry summary 与 desktop v1 envelope;输出为纯函数 `BuildPlanningContextV1`、canonical digest、v2 command/result schema 和 golden fixtures。
**做**:新增 context identity/validator/projector;冻结 v2 success/error envelope;复用 `BuildIntentPlannerCandidateV2` 与既有 Blueprint DSL。
**不做**:不调用 provider、不读写 store、不编译 BuildPlan、不改变 v1 canonical JSON。
**触达**:`packages/core/src/build-intent-controller.ts` 或独立 `build-planning-context.ts`、Core tests/fixtures、Rust mirror contract types。
**Red**:Registry 顺序改变导致 digest 改变;unknown field/超限摘要通过;v2 error 可携带 raw goal;v1 fixture 被改写。
**Green**:canonical digest 与 key 顺序无关;边界 fail closed;结果 envelope body 有界;v1 golden 字节不变。
**验证**:`pnpm --dir packages/core exec vitest run test/build-intent-controller.test.ts test/artifact-blueprint-registry.test.ts`;Core typecheck;Rust/TS golden parity。

**结果**:Core 新增 strict `BuildPlanningContextV1` projector/validator、canonical digest、确定性 128 项 scope/Registry 采样与 v2 command/result envelope;Runtime mirror 使用同一排序、采样和 SHA-256 canonical body。跨语言 golden 固定 target/scope/Registry/contract/digest,Registry 输入顺序与 key 顺序不改变结果;unknown field、超限目录、digest 漂移和未脱敏错误均 fail closed。Core 13/13 + typecheck、Runtime build-intent 6/6 通过,既有 v1 controller fixture 未改写。

### CB2 - Reader 只读 planning.context

状态:完成,2026-07-30。

依赖:CB1。

**输入/输出**:输入为可信 workspace 与当前 Reader state;输出为无副作用的 `BuildPlanningContextV1`。
**做**:从 current book/source/profile、LID/section catalog 与 Registry summaries 构造 context;每次调用重读当前状态;支持有界确定性采样。
**不做**:不接收 user goal、不调用 model adapter、不创建 intent/plan/usage/task、不返回路径或私有正文。
**触达**:`crates/server/src/build_intent_api.rs`、`intent_build_store.rs` 只读检查、server tests。
**Red**:inspect 增加 `store_revision`;source/Registry 变化后 digest 不变;大书返回无界 LID;Visitor/MCP 可调用。
**Green**:重复 inspect 字节稳定且零写;当前态改变使 digest 改变;目录/结果有界;仅 trusted desktop controller 可用。
**验证**:`cargo test -p server planning_context`;大书 1,981+ LID 采样 fixture;store 前后文件树与 revision 相等。

**结果**:可信 Desktop controller 新增 `planning.context`,从每次重读的 current source、Book profile、完整 LID/章节目录与当前 Registry summaries 构造 Runtime mirror context;HTTP Reader、Visitor 与 Book MCP 未增加路由。该操作显式跳过 active-source lifecycle 同步,不接收 goal,不访问 adapter,不创建或修订 intent/plan/usage/task。Server 定向测试证明重复输出稳定、private tree/revision 零变化、source 漂移改变 digest、1,982 LID 均匀采样为 128 项、unknown input fail closed。

### CB3 - candidate draft 单编译链

状态:完成,2026-07-30。

依赖:CB1、CB2。

**输入/输出**:输入为 `context_digest + user_goal + BuildPlanningCandidate`;输出为既有 `BuildIntentV2/BuildPlanV2` draft 与 Codex plan projection。
**做**:抽出 shared `validate_resolve_compile_persist`;Codex candidate 路径先重算 context,再验证 candidate/Blueprint/scope,最后编译并持久化;Reader provider 路径产出 candidate 后调用同一函数。
**不做**:不让 Codex 写 plan_id/digest;不信任 one-off snapshot;不改变 confirm/reject/artifact loop;不保存 candidate 正文为新 artifact。
**触达**:`crates/runtime/src/build_intent.rs`、`crates/server/src/build_intent_api.rs`、Core intent.plan/intent.blueprint、server/runtime tests。
**Red**:Codex candidate 路径调用 provider;旧 context 可提交;六个 candidate 只编译一个;两入口同 candidate 得到不同 identity。
**Green**:provider 调用次数 0;drift 返回 needs_user;artifact 数量/identity 一一保持;固定 now/id 下两入口 plan identity 相同。
**验证**:`cargo test -p runtime --test build_intent`;`cargo test -p server codex_build_intent`;六产物 one-off/system 混合 golden;adapter panic-if-called fixture。

**结果**:Server 抽出唯一 `compile_candidate_draft`:每条路径都先冻结 current context,严格校验 candidate/scope,逐项重解 Blueprint,调用同一 Core draft compiler,最终重算 context 后才持久化。Reader provider 只负责产 candidate;Codex `draft.candidate` 绑定 context digest 且不访问 adapter,返回既有 body-free plan projection。定向测试证明旧 digest 在 revision 0 时即拒绝、system 2 + one-off 4 恰好编译六项、Unconfigured adapter 可成功、同 goal/candidate/target/budget/now 的 Reader/Codex plan 与 intent identity 完全一致;既有 v1 raw-goal Codex 路径仍通过兼容回归。

### CB4 - Desktop v2 结果闭环与故障可观测性

状态:完成,2026-07-30。

依赖:CB2、CB3。

**输入/输出**:输入为 v2 stdin envelope;输出为 exactly-one `codex_build_intent_result.v2` 与可信进程 exit status。
**做**:Desktop 同时解析 v1/v2;v2 正常失败也输出脱敏 result;标注 failure phase/retryable;harness 在无协议 body 时报告数值 exit code 与 signal/termination 类别。
**不做**:不记录 raw goal/candidate/API key;不把 stderr 文本当成功响应;不吞掉 Core/Provider error code。
**触达**:`apps/desktop/src-tauri/src/main.rs`、controller integration tests、desktop smoke scripts、plugin status/capability projection。
**Red**:invalid candidate 产生空输出;异步 wait 丢 exit code;error message 回显 goal;v1 调用回归。
**Green**:所有受控失败均有一个 result;异常终止有 harness 诊断;敏感串扫描为零;v1/v2 parity 通过。
**验证**:Desktop 真进程 success/validation/provider-unavailable/sidecar-failure/forced-abort smoke;Windows PowerShell 与直接 process spawn 双路径。

**结果**:Desktop CLI 同时保留 v1 compatibility 并把每个 v2 受控成功/失败收口为 exactly-one
`codex_build_intent_result.v2`;结构化错误固定 phase/retryable 且按 goal/candidate/path 敏感值脱敏。
真实进程 smoke 覆盖 v1 status、v2 context、invalid candidate、缺失 sidecar、PowerShell 管道与直接
spawn;stdout 均为单一协议正文,stderr 无协议正文,敏感 sentinel 为零。harness 对无协议 body 的异常
终止保留数值 exit code、signal/error code 并把强制超时明确分类为 `timed_out`。

### CB5 - Codex skill 接管语义规划

状态:完成,2026-07-30。

依赖:CB4。

**输入/输出**:输入为自然语言目标与 `BuildPlanningContext`;输出为 Codex 直接构造并提交的严格 candidate,以及供用户确认的 Reader plan projection。
**做**:更新 `$understand-book-build`:先 capability/context,再由当前 Codex 选择/设计 Blueprint,提交 `draft.candidate`;保留 status/confirm/build/artifact loop;明确新 plugin 不回退 v1 raw-goal draft。
**不做**:不让 Reader provider 重规划 Codex goal;不由 Codex伪造 plan/digest;不在 stdout/argv/temp public file 放 goal/candidate;不提前执行未确认计划。
**触达**:`skills/build/SKILL.md`、plugin packaged skill、release cachebuster/installation flow、skill contract tests。
**Red**:Reader adapter 被调用;context drift 后自动重试旧 candidate;缺 v2 时静默 v1;candidate/goal 泄入日志。
**Green**:Codex-only planner 路径零 Reader LLM;drift 回到 context/replan;缺能力明确 upgrade-required;用户只确认 Reader 投影 digest。
**验证**:plugin install/status;packaged skill static audit;fake controller protocol transcript;真实工作区六产物 plan smoke,确认前零 build task。

**结果**:源码与发布包 `$understand-book-build` 的新 goal 入口均改为 v2
`planning.context -> current Codex candidate -> draft.candidate`;context probe 不携 goal,候选只使用有界
scope/Registry/contract,`BUILD_PLANNING_CONTEXT_DRIFT` 会丢弃旧 context/candidate 后重规划。正常退出但
缺 v2 envelope 的旧 Desktop 明确投影 `CODEX_BUILD_INTENT_V2_REQUIRED`,禁止 v1 raw-goal fallback;
status/confirm/reject、automatic-build 与 private artifact loop 语义不变。静态 skill 审计与 fake
transcript 2/2、两份 skill validator、plugin validator、packaged/installed hash parity 全绿;真实
`quantification-essence` Desktop 进程以 2 个 system + 4 个 one-off Blueprint 得到六项
`codex_build_intent_plan.v2` 摘要,确认前 public automatic-build tree 字节不变且无 task/attempt/lease。
发布 cachebuster 为 `0.1.0+codex.20260730052015`,personal marketplace 安装副本与发布 skill SHA-256
一致;当前任务占用的旧 Git marketplace cache 保留到应用重启,未被强杀或手改配置。

### CB6 - Reader UI fallback 与单编译器 parity

状态:完成,2026-07-30。

依赖:CB3。

**输入/输出**:输入为 Reader UI raw goal;输出为 provider candidate 经 shared compiler 生成的同版 draft。
**做**:保留 UI 独立规划;把 provider 限定为 candidate producer;统一 candidate/schema/Blueprint/digest 错误投影;UI 标识规划来源但不改变 plan identity。
**不做**:不让 Web 直接提交任意 candidate;不暴露 Codex-only stdin capability 到 Visitor/MCP;不维护第二套 compiler。
**触达**:`crates/server/src/build_intent_api.rs`、`packages/web/src/components/BuildIntentPane.vue`、API/types/tests。
**Red**:UI 与 Codex 同 candidate 得到不同 plan;UI provider 失败默认成 concept map;Web 可绕过 candidate validator。
**Green**:同 candidate/target/budget 编译 identity 一致;provider 失败显式;Web 仍只使用 resident Reader 权限。
**验证**:Server shared-compiler tests;BuildIntentPane unit;desktop Reader draft/confirm/reject smoke。

**结果**:Reader REST `draft/edit` 仅接受 `mode|plan_id + user_goal + budget`,unknown `candidate` 在 provider 调用与 store 写入前 fail closed;两条 goal-directed 路径均先让 provider 产生严格 v2 candidate,再进入 `compile_candidate_draft` 的 current context、scope、Blueprint、Core compiler 与 persist 顺序。Reader HTTP 与 Codex v2 在固定 goal/candidate/target/budget/now 下得到相同 intent/plan identity,而 `planning_source` 只存在于响应元数据,不进入 selection 或 plan digest。UI 显示 Reader/provider、deterministic 或 stored-plan 来源;provider 失败保持显式错误且不产生默认 concept map。Server build-intent 11/11、Web 37 files/210 tests、typecheck/production build、Rust fmt 与 diff check 全绿;Reader 路由集成覆盖 draft/edit/confirm/reject,HTTP candidate 注入保持 store revision 0。

### CB7 - 迁移、六产物真书闭环与发布门

状态:待实施。

依赖:CB4、CB5、CB6。

**输入/输出**:输入为新旧 plugin、既有 v1/v2 plans 与真实 `ai-agent-engineering` workspace;输出为可发布的兼容矩阵、六产物闭环、故障矩阵与回滚证据。
**做**:证明现有 plan/overlay 零迁移;用 system concept/comparison + 四个 one-off Blueprint 生成恰好六项 plan;确认后跑公共 closure 与私有 artifact loop;验证 Reader/Resident/MCP 消费;记录 token/墙钟/失败恢复。
**不做**:不覆盖用户现有 active overlay 作为测试前置;不把一次 provider 成功当发布证据;不删除 v1 controller/plan adapter。
**触达**:desktop/plugin smoke、release assertions、真实书测试脚本、迁移/回滚文档。
**Red**:六项 proposal 在 plan projection 中缺项/合并;旧 plugin 或旧 plan 不可读;candidate 失败被误报为缺 Blueprint;rollback 需改写 plan。
**Green**:六项 identity 一一可审阅;旧状态字节不变;每类失败有稳定恢复码;关闭 v2 capability 即可回滚入口且 Reader UI/旧计划继续工作。
**验证**:Core/Runtime/Server/Desktop/plugin 全量;packaged Node/Bun parity;真实 workspace dry-run + 用户隔离副本 confirmed run;release artifact hash/skill/version audit。

## 5. 执行顺序与提交边界

```text
CB0
  -> CB1
      -> CB2
          -> CB3
              -> CB4
              -> CB6
                  -> CB7
              -> CB5
                  -> CB7
```

每个 CB 独立 commit-ready;不得把合同、Server 路径、Desktop 观测、skill 切换和真书发布混成一刀。每刀完成时同步 `docs/代码链路.md`;只有真实组件/数据流改变后才更新 `docs/架构.md`。CB5 发布前必须已有 CB4 的结构化错误闭环,否则 Codex 入口仍可能把空响应误诊为能力缺失。

## 6. 发布与回滚

- 发布顺序:`Core contract → Reader context/candidate compiler → Desktop v2/observability → Reader UI parity → plugin skill → real-book gate`。
- capability 默认关闭直到 CB1-CB6 全绿;CB7 通过后新 plugin 才要求 v2。
- 新 plugin 遇到旧 Desktop 返回明确 `CODEX_BUILD_INTENT_V2_REQUIRED`;不自动调用 v1 raw-goal draft。
- Reader UI、v1 command、既有 BuildPlan、accepted overlay 与 artifact access 始终保持兼容。
- 回滚只关闭 v2 capability/恢复旧 plugin 版本;不得删除、重写或 relabel 已确认计划与 accepted artifact。
- candidate/context 不成为长期 public artifact;失败后仅保留有界脱敏诊断,私有 hard delete 仍按既有 intent ownership 传播。
