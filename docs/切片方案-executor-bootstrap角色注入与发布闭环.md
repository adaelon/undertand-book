# Executor Bootstrap 角色注入与发布闭环切片方案

状态:实施中；EB0-EB3 已完成，EB4-EB7 待实施。

冻结决策:[ADR-0102](adr/0102-dedicated-executor-bootstrap-role-isolation-and-distribution.md)。修订边界:[ADR-0101](adr/0101-deterministic-prebuild-protocol-ownership-and-codex-semantic-boundary.md)。关联实现:[build skill](../skills/build/SKILL.md)、[automatic build driver](../skills/build/automatic-build-driver.ts)、[executor wrapper](../agents/automatic-build-dispatch-executor.md)、[release assertion](../apps/desktop/scripts/assert-plugin-release.mjs)。

## 0. 对齐确认单

**FrozenIntent**:修复 `SPAWN_EXECUTORS` 只传 opaque ref、却没有把完整 executor 角色指令注入 spawned subagent 的 bootstrap 缺口。`understand_book_executor` custom agent 是主执行角色，root 必须显式选择该 `agent_type`；插件发布版本化 agent 模板和显式注册适配层，并保留 executor-only skill 作为未注册环境的有界回退。不修改 Build Engine 状态机、handoff/session schema、semantic prompt、candidate/mailbox/receipt、BuildPlan 或质量语义。成功标准是在不含本仓库源码的普通书籍工作区中，主路径不激活任何 executor/build skill，回退路径只激活 executor skill；两者都不搜索协议，首个 Build Engine 边界均是合法 `executor.open`，最终仍只返回有界 lifecycle state。

**TermMap**:

| 术语 | 状态 | 本方案口径 |
|---|---|---|
| Opaque handoff ref | EXISTING | root 原样转交、仅由代码解析的有界 locator |
| Executor open | EXISTING | 代码完成 handoff、identity、lease 与当前状态重验的原子消费边界 |
| Executor bootstrap contract | NEW | subagent 消费 ref 前必须已获得的版本化角色指令 |
| Root build skill | EXISTING | 负责目标理解、用户确认和四动作外层循环，不承担语义 candidate 执行 |
| Codex custom agent | EXISTING | 个人或项目级 TOML 角色配置；`developer_instructions` 在 spawn 会话构建时注入 |
| Executor agent template | NEW | 插件携带、但不假定会被宿主自动注册的版本化 custom-agent TOML |
| Executor role registration | NEW | 把模板显式安装到个人或项目 agent 配置的幂等、冲突失败关闭边界 |
| Executor-only skill | NEW | 只承载 bootstrap contract 的插件回退 skill，不包含 root 编排职责 |

**RiskReceipt**:用户已提供真实 trace，确认当前 worker 会隐式激活 build skill、读取完整 SKILL、运行 `--help`、搜索协议，并且仅因 cwd 是源码仓库才找到 wrapper；用户进一步要求 custom agent 作为主路径。官方文档与本机加载均证明 custom agent 可实现，但当前插件合同未承诺自动注册 agent。本方案因此承担显式注册、冲突和升级责任，不得把个人机器上偶然存在的 agent 当成插件原生能力。

**ChangeType**:`[边界重构]`。

领域对齐完成；TermMap 零未解析符号。

## 1. 根因与证据

### 1.1 缺口位于 spawn 与角色指令之间

当前链路是:

```text
build.step
  -> SPAWN_EXECUTORS [{ opaque_handoff_ref }]
  -> root build skill 启动内置 worker
       payload = ref + “follow executor.open / executor.session protocol”
  -> worker 没有 executor developer instructions
       -> 隐式匹配 understand-book-build
       -> 读取完整 root SKILL.md
       -> --help / rg / 读取源码 wrapper
       -> 才能构造 executor.open stdin
```

对应证据:

- [automatic-build-driver.ts](../skills/build/automatic-build-driver.ts) 的 root action 只含 `opaque_handoff_ref`；这是 ADR-0101 的正确隐私边界，不是缺陷。
- [SKILL.md](../skills/build/SKILL.md) 的 `SPAWN_EXECUTORS` 分支只给固定一句话，随后却声称 subagent 会遵循“dedicated executor instructions”；两者之间没有可执行的角色选择或注入机制。
- [automatic-build-dispatch-executor.md](../agents/automatic-build-dispatch-executor.md) 完整定义了 stdin JSON、`GENERATE/WAIT/DONE`、candidate 私有性和失败边界，但它只是源码/sidecar 资产。
- [assert-plugin-release.mjs](../apps/desktop/scripts/assert-plugin-release.mjs) 明确要求 installed plugin 不含 `agents/`；发布插件当前只有 build skill 与 Book MCP launcher。
- 仓库不存在 `understand_book_executor` custom agent、`.codex/agents/*.toml` 或任何把 wrapper 绑定到 spawn role 的配置。

### 1.2 为什么真实运行仍能完成

本次 worker 的 cwd 是本仓库，因此它可用 `rg` 找到 `agents/automatic-build-dispatch-executor.md`，再手工拼出 `automatic_build_executor_open_request.v1`。普通用户从任意书籍目录启动时没有这份源码资产；同一推理链只能依赖模型猜测或停止。

连续多次“创建 candidate -> `executor.session`”不是根因。一个 session 会顺序处理 dispatch 中多个 work unit，代码返回下一个 `GENERATE` 属于正常状态机；最终 `DONE/committed` 只证明这次探索后执行成功，不证明 bootstrap 可发布。

### 1.3 现有门禁为何漏检

当前测试分别证明:

```text
wrapper bytes 正确
AND sidecar 能组合 wrapper + semantic prompt
AND handoff 内含完整 prompt
AND plugin 保持无 agents/ 的薄形态
AND build skill 文本出现 executor.open/session marker
```

缺失的合取项是:

```text
spawned_subagent.selected_role_instructions == canonical_executor_bootstrap
```

所以静态资产、Sidecar 和 Engine 都可全绿，而真实 spawned worker 仍没有 role instructions。

### 1.4 Custom agent 能力与插件注册是两个命题

截至 2026-08-10 的证据链:

```text
official Subagents docs
  -> ~/.codex/agents/*.toml OR <project>/.codex/agents/*.toml
  -> required: name + description + developer_instructions
  -> selected custom agent becomes spawned-session config layer

local Codex CLI 0.146.0
  -> ~/.codex/agents/{blackbox_reviewer,whitebox_reviewer}.toml
  -> both names/descriptions exposed as selectable agent_type values in this session

official plugin package docs
  -> skills + MCP config + optional assets/hooks
  -> no documented rule that plugin installation registers bundled TOML as a custom agent
```

因此:

```text
custom_agent_role_is_implementable = true
plugin_native_agent_registration_is_documented = false
```

本方案不再用第二个 false 否定第一个 true。插件可把 TOML 作为版本化 asset 携带，但只有显式注册后才能把它当成可选 `agent_type`；在此之前仅能使用受限 skill 回退。

## 2. 冻结边界

必须保持:

1. `build.step` 的 `SPAWN_EXECUTORS` 继续只返回 `opaque_handoff_ref`，不回传 prompt、路径、hash、命令或 semantic input。
2. Root 继续负责目标语义、用户选择、实时 slot 与 harness spawn/wait；Build Engine 不启动模型。
3. Executor 只处理 `GENERATE/WAIT/DONE`，candidate 只存在 subagent 私有 source、session 与 mailbox。
4. `automatic_build_executor_session.v1`、BuildPlan、work unit、lease、attempt、receipt、quality 和 retry 语义不变。
5. `agents/*-extractor.md` 与 semantic `prompt_sha256` 不变。
6. 已注册 custom agent 时，root 必须选择 `agent_type=understand_book_executor`，不得降级为 skill 路由。
7. 未注册 custom agent 时只允许 executor-only skill 回退；两种 provider 都不可用时失败关闭，root 不得临时扮演 executor。

明确不做:

- 不把完整 wrapper 塞回每次 spawn payload。
- 不恢复 root 对 path/hash/schema/receipt 的人工检查。
- 不把 `agents/` 目录整体加入薄插件。
- 不把插件 asset 的存在当成 agent 已注册。
- 不由 Setup 静默创建或覆盖 `~/.codex/agents/understand-book-executor.toml`或项目同名文件；只允许用户显式请求后进行幂等注册。
- 不通过 `AGENTS.md` 污染书籍工作区内所有 agent。
- 不以修改 Engine 或 candidate 协议掩盖角色指令分发缺口。
- custom-agent 主路径不承诺平台的非角色 UI 提示，但必须不激活任何 build/executor skill；回退路径只允许一次 executor skill 使用提示。

## 3. 目标合同

### 3.1 Bootstrap provider

```ts
type ExecutorBootstrapProvider =
  | {
      kind: "custom_agent";
      agent_name: "understand_book_executor";
      developer_instructions_sha256: string;
      registration_scope: "personal" | "project";
    }
  | {
      kind: "plugin_skill_fallback";
      skill_name: "understand-book-executor";
      contract_sha256: string;
    };
```

当前 release 同时携带 custom-agent 模板与 skill 回退，选择顺序固定为:

```text
if spawn tool advertises agent_type=understand_book_executor:
    provider.kind = custom_agent
elif installed plugin advertises $understand-book-executor:
    provider.kind = plugin_skill_fallback
else:
    bootstrap_unavailable (fail closed)
```

两种 provider 都必须满足:

```text
provider.contract_digest == sha256(canonical normalized executor wrapper body)
AND first_engine_boundary == executor.open(exact_opaque_ref)
AND root_build_skill_was_not_activated
AND source_repo_was_not_searched
```

正向 custom-agent 黑盒必须从发布模板显式注册，不得使用个人机器上预先手工存在的同名 agent 让 smoke 偶然通过。

### 3.2 Custom agent 与显式注册合同

Custom agent 的最小形状:

```toml
name = "understand_book_executor"
description = "Execute exactly one Understand Book opaque handoff through the packaged executor session protocol."
developer_instructions = """
<canonical Automatic Build Executor Session Protocol body>
"""
```

约束:

1. `name`、`description`、`developer_instructions` 必须存在，`name` 是 `agent_type` 的唯一权威。
2. 默认不固定 model/reasoning，使其按 Codex 的 custom-agent 规则继承 root/全局设置；后续如需独立定级必须另立决策。
3. `developer_instructions` 自包含完整 session bootstrap，明确禁止激活 `$understand-book-build`、`$understand-book-executor` 或任何源码发现流程。
4. 仓库 `.codex/agents/understand-book-executor.toml` 用于项目开发/黑盒；插件在 `assets/codex-agents/` 发布同字节模板，但 asset 本身不等于已注册。

显式注册操作:

```text
register_executor_agent(template, scope, expected_sha256):
    target = personal(~/.codex/agents/) OR project(<workspace>/.codex/agents/)
    if target missing: atomically create from exact template
    elif sha256(target) == expected_sha256: return already_current
    else: return conflict_without_overwrite
    return restart_required
```

只有用户显式请求“注册/安装 executor agent”时才可写目标；升级、冲突与卸载责任必须由注册适配层承担。注册后必须从新 Codex task 验证 `agent_type` 已可见，不在当前 task 内假定热加载。

### 3.3 Root spawn 合同

Custom-agent 主路径:

```text
spawn_agent(
  agent_type = understand_book_executor,
  message = "Process exactly this code-issued opaque handoff ref and return only bounded lifecycle state:\n<opaque_handoff_ref>"
)
```

Skill 回退路径:

```text
Use $understand-book-executor for exactly this opaque handoff ref:
<opaque_handoff_ref>
Return only the bounded lifecycle state defined by that skill.
Do not use $understand-book-build inside this subagent.
```

约束:

- `opaque_handoff_ref` 仍是唯一动态数据。
- Root 不复制 wrapper、semantic prompt、target、workspace、command list 或 receipt。
- `agent_type` 可用时必须选主路径，不得因 skill 已安装而降级。
- Custom agent 未注册时可使用 skill 回退；skill 也缺失时，subagent/root 只返回有界 `interrupted/bootstrap_unavailable` 观察，随后由 root 重新 `build.step`，不得自行搜索协议。

### 3.4 Executor-only skill 回退合同

`understand-book-executor` 必须:

1. 只匹配“处理一个 code-issued opaque handoff ref”的任务。
2. 立即按环境变量/注册表规则解析 `understand-book-build.exe`。
3. 第一个引擎请求就是精确 `automatic_build_executor_open_request.v1` stdin。
4. 只消费 `automatic_build_executor_session.v1` 的 `GENERATE/WAIT/DONE`。
5. 将 candidate 写入 executor-private UTF-8 JSON source，再以精确 session request 提交或失败。
6. 删除私有 candidate source，并只返回有界 lifecycle state。
7. 禁止激活 root build skill、运行 `--help`、搜索仓库、读取 `agents/` 或使用源码命令回退。
8. 禁止在 final、stdout 诊断或 root chat 中暴露 semantic/candidate body、路径、命令和 raw stderr。

Skill frontmatter、执行纪律和 canonical wrapper 的职责分离:

```text
frontmatter          -> 何时选择 executor skill
bootstrap wrapper    -> 精确 session protocol 与隐私边界
semantic_prompt      -> 每个 GENERATE 的领域抽取规则，由 Engine 私下返回
```

### 3.5 单一权威与发布投影

```text
agents/automatic-build-dispatch-executor.md
  -> normalized canonical bootstrap body
       -> .codex/agents/understand-book-executor.toml developer_instructions
       -> assets/codex-agents/understand-book-executor.toml
       -> plugins/understand-book/assets/codex-agents/understand-book-executor.toml
       -> skills/executor/SKILL.md fallback body
       -> plugins/understand-book/skills/executor/SKILL.md fallback body
```

发布门必须比较完整规范化正文或 SHA-256；只检查 marker 不足以证明分支、失败和隐私约束一致。项目 agent/发布模板、root/release executor skill 各自字节一致，root/release build skill 继续字节一致。

### 3.6 目标 trace

```text
root receives opaque_handoff_ref
  -> spawn explicitly selects agent_type=understand_book_executor
  -> developer_instructions already contain executor bootstrap contract
  -> resolve packaged Build Engine
  -> executor.open(exact ref)
       -> GENERATE: private candidate -> executor.session -> continue
       -> WAIT: exact retry_after_ms -> reopen same ref
       -> DONE: bounded terminal state
  -> root calls build.step and trusts durable state
```

主路径禁止任何 executor/build skill 激活或 `SKILL.md` 读取。回退路径的差异只能是:

```text
spawn default dedicated subagent
  -> explicitly activate $understand-book-executor once
  -> same canonical bootstrap and executor.open loop
```

两条 trace 都禁止 `I’m using the Understand Book build skill...`、build `SKILL.md`、`--help`、协议 `rg` 或源码 wrapper 访问。

## 4. 切片顺序

### EB0 决策、术语与根因冻结

状态:完成，2026-08-10；custom-agent-first 修订于同日重新冻结。

**做**:新增 ADR-0102、本切片方案和 `Executor bootstrap contract` / `Executor role registration` 术语；把 ADR-0101 的 S6 发布假设显式交给本方案；用官方文档与本机 agent-type 加载证据区分“角色可实现”和“插件原生注册”。

**不做**:不修改 skill、agent、driver、Engine、测试或发布缓存。

**触达**:

- `docs/adr/0102-dedicated-executor-bootstrap-role-isolation-and-distribution.md`
- `docs/切片方案-executor-bootstrap角色注入与发布闭环.md`
- `CONTEXT.md`
- `docs/adr/0101-deterministic-prebuild-protocol-ownership-and-codex-semantic-boundary.md`
- `docs/切片方案-预构建确定性确认收口.md`

**完成判据**:根因链、provider 优先级、显式注册边界、skill 回退、切片输入/输出与确定性验收均落盘；文档检查通过。

### EB1 Bootstrap 发布红测

状态:完成，2026-08-10；新增合同按预期只红 custom agent、注册适配层、skill 回退与 root selector。

**做**:先建立会在当前快照失败的发布合同，证明 wrapper 存在，但 custom agent、注册适配层、skill 回退与 root selector 都缺失。

**触达**:

- 新增 `packages/core/test/codex-executor-agent.test.ts`
- `packages/core/test/automatic-build-handoff.test.ts`
- `packages/core/test/automatic-build-executor-prompt.test.ts`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**红测**:

1. 项目 `.codex/agents/understand-book-executor.toml` 必须存在且含官方必填字段，当前红。
2. 根/发布 `assets/codex-agents/understand-book-executor.toml` 必须字节一致并与项目 agent 同角色同正文，当前红。
3. Custom agent `developer_instructions` 必须与 canonical wrapper 的规范化全文摘要一致，当前无 provider 而红。
4. 显式注册 skill/script 必须存在，并覆盖 absent / already-current / conflict-no-overwrite，当前红。
5. 回退 `skills/executor/SKILL.md` 及发布投影必须存在并匹配 canonical digest，当前红。
6. Root build skill 必须在 `agent_type=understand_book_executor` 可用时优先选它，仅在不可用时选 `$understand-book-executor`，当前欠规格固定句而红。
7. Release snapshot 仍不得把源码 `agents/` 或 `.codex/agents/` 当作插件自动注册目录；只允许 `assets/codex-agents/` 模板。
8. 既有 driver/session/handoff/semantic prompt hash 测试保持绿色。

**不做**:不新增生产 agent/skill/script，不改 spawn 文本，不更新 cachebuster。

**完成判据**:新增断言只因 bootstrap/注册/selector 缺失而红；旧 Engine/session 行为无新增失败。

### EB2 Custom agent 与发布模板

状态:完成，2026-08-10；项目 agent、根 asset 与发布 asset 已按 canonical wrapper 全文投影，三份 TOML 精确字节一致。

**做**:以 canonical wrapper 为正文权威，新增可直接加载的项目 custom agent 和插件 asset 模板。

**触达**:

- 新增 `.codex/agents/understand-book-executor.toml`
- 新增 `assets/codex-agents/understand-book-executor.toml`
- 新增 `plugins/understand-book/assets/codex-agents/understand-book-executor.toml`
- EB1 contract tests

**实现约束**:

- `name` 固定为 `understand_book_executor`，description 只匹配单个 code-issued opaque ref。
- `developer_instructions` 包含完整 bootstrap，禁止 build/executor skill 与源码发现。
- 不固定 model/reasoning，不添加规范外的个人配置。
- 项目 agent 与两份 asset 模板字节一致；asset 不声称自动注册。

**不做**:不写用户个人/书籍工作区配置，不新增回退 skill，不改 root spawn。

**完成判据**:TOML 形状、全文 digest、三投影 parity 与职责隔离断言转绿；新 Codex task 在本项目显示 `understand_book_executor` 为可选 `agent_type`。

### EB3 显式注册适配层

状态:完成，2026-08-10；显式注册脚本与 skill 已完成根/发布精确投影，Windows absent/same/conflict 三态合同绿色。

**做**:提供只在用户明确请求时运行的 personal/project agent 注册路径。

**触达**:

- 新增 `scripts/register-executor-agent.ps1`
- 新增 `plugins/understand-book/scripts/register-executor-agent.ps1`
- 新增 `skills/register-executor/SKILL.md`
- 新增 `plugins/understand-book/skills/register-executor/SKILL.md`
- EB1 registration tests

**实现约束**:

- 必须显式给出 `personal` 或 `project` scope；project scope 必须有精确 workspace root。
- 目标不存在时原子创建；同 digest 时幂等返回；不同 digest 时失败关闭并不覆盖。
- 源文件必须是当前已安装插件的发布 asset，不从 repo cwd 搜索。
- 成功后只报告 digest、scope、目标与“新 task 生效”，不在当前 task 伪装角色已热加载。
- 注册 skill 的 description 只匹配显式安装/注册/升级请求，普通 build 不得触发。

**不做**:不添加 install hook，不静默修改用户配置，不卸载/改写不同 digest 文件。

**完成判据**:临时目标上 absent / same / conflict 三路径确定性测试全绿；root/release script 和 skill 字节一致。

### EB4 Executor-only skill 回退

**做**:新增只承载 bootstrap contract 的回退 skill，保证未注册 custom agent 的当前 task 仍无需 `--help`/搜索源码。

**触达**:

- 新增 `skills/executor/SKILL.md`
- 新增 `plugins/understand-book/skills/executor/SKILL.md`
- `apps/desktop/scripts/assert-plugin-release.mjs`
- EB1 contract tests

**实现约束**:

- Frontmatter name 固定为 `understand-book-executor`，description 只匹配单 ref 执行任务。
- 正文与 canonical wrapper 的规范化全文摘要一致。
- 不声明 BuildIntent、BuildPlan、`build.step` 或用户交互职责。
- 不添加 repo/source fallback；Build Engine 缺失直接有界中断。

**不做**:不改 custom agent/注册适配层，不改 driver/session，不改 semantic prompts。

**完成判据**:回退 provider 存在、digest、职责隔离和薄插件形态断言转绿。

### EB5 Root 显式 provider 选择

**做**:把 `SPAWN_EXECUTORS` 固定指令改为 custom-agent-first 选择，仅在该 `agent_type` 未广告时调用 executor skill。

**触达**:

- `skills/build/SKILL.md`
- `plugins/understand-book/skills/build/SKILL.md`
- `packages/core/test/automatic-build-handoff.test.ts`
- `apps/desktop/scripts/assert-plugin-release.mjs`

**实现约束**:

- 每个 ref 仍启动一个 dedicated subagent，仍受 driver 返回数量和实时 slot 限制。
- 主路径显式设置 `agent_type=understand_book_executor`，payload 只含 ref 与有界返回要求。
- 回退 payload 只增加静态 skill selector/role prohibition，不增加任何私有动态字段。
- Build skill 不复制 executor stdin schema；schema 只在 canonical wrapper 的 agent/skill 投影。
- 两种 provider 都不存在时失败关闭；root 不回退为“follow protocol”泛化句或亲自执行。
- Subagent final 仍只是 harness lifecycle observation；root 结束后总是重新 `build.step`。

**不做**:不修改 `AutomaticBuildStepActionV1`，不改变 opaque ref 或 receipt。

**完成判据**:root/release build skill 字节一致；旧欠规格固定句不再存在；provider 优先级断言转绿；driver action shape 仍只有 ref。

### EB6 安装态双路径黑盒验收

**做**:在不含本仓库源码的临时书籍目录，用真实 installed thin plugin 和 packaged Build Engine 分别跑 custom-agent 主路径与 skill 回退。

**自动前置**:

```powershell
pnpm -C packages/core test -- automatic-build-driver.test.ts automatic-build-executor-session.test.ts automatic-build-handoff.test.ts automatic-build-executor-prompt.test.ts codex-executor-agent.test.ts
pnpm -C packages/core typecheck
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
node apps/desktop/scripts/assert-plugin-release.mjs
```

**黑盒场景**:

1. 从 installed asset 把 agent 显式注册到临时书籍项目，启动新 Codex task，证明角色被广告且 root 选择 `agent_type=understand_book_executor`。
2. 主路径先跑单 ref，再跑两 ref wave，记录每个 agent 在首个 `executor.open` 前的工具 trace。
3. 在另一个没有 `.codex/agents` 的临时书籍项目启动新 task，证明只激活 `$understand-book-executor` 回退。
4. 对已存在的不同 digest 同名 agent 运行注册，证明冲突失败关闭且原文件字节不变。
5. 中断一个 executor，root 重新 step 后仍从磁盘恢复，不以 agent final 判完成。

**共同正向断言**:

- 每个 executor 的首个 Build Engine 子命令是 `executor.open`。
- stdin 是精确 `automatic_build_executor_open_request.v1` 且 ref 完全相同。
- `GENERATE -> executor.session` 可连续处理多个 work unit，最后由代码给 `DONE`。
- Root action/final 与日志不含 candidate、semantic input、prompt 或私有路径。

**分路径断言**:

- Custom-agent 路径可观测到显式 `agent_type`，不激活/读取任何 build 或 executor skill。
- Skill 回退只激活/读取 executor skill，不激活 root build skill。
- 两者都不运行 Build Engine `--help`，不 `rg`/搜索 `automatic_build_executor`、`opaque_handoff_ref` 或 wrapper，不访问 repo `agents/`、`packages/core/src` 或当前源码根。

**完成判据**:自动门、主路径单/双 executor、skill 回退、注册冲突、中断恢复和 trace 负向扫描全部通过；最终状态同时由 `DONE` 与 canonical artifact/receipt 证明。

### EB7 发布与文档收口

**做**:更新 plugin cachebuster/marketplace/安装态快照，记录双路径真实 trace，并同步架构与代码链路。

**触达**:

- `.codex-plugin/plugin.json`
- `plugins/understand-book/.codex-plugin/plugin.json`
- `.agents/plugins/marketplace.json`（若 cachebuster 由此维护）
- `docs/架构.md`
- `docs/代码链路.md`
- `docs/切片方案-预构建确定性确认收口.md`
- `SESSION_CHECKPOINT.md`（仅在触发 C4 时整页覆写）

**不做**:不覆盖用户不同 digest 的 custom agent 配置，不删除历史 handoff/session/receipt，不改 accepted artifact。

**完成判据**:新 task 加载的是新 cachebuster；发布快照含 agent 模板、注册 skill/script、build skill 与 executor 回退 skill，仍无可被误解为原生注册的顶层 `agents/`/`.codex/agents/`；EB6 证据可从干净安装复现；架构与代码链路指向真实实现。

## 5. 依赖与提交边界

```text
EB0 decision/docs
  -> EB1 red publication contract
  -> EB2 custom agent + release template
  -> EB3 explicit registration adapter
  -> EB4 executor-only skill fallback
  -> EB5 custom-agent-first root selection
  -> EB6 installed dual-path black-box
  -> EB7 release/docs closure
```

| Commit | 内容 | 必须为绿的判据 |
|---|---|---|
| 1 | EB0 | 文档链接、术语、`git diff --check` |
| 2 | EB1 | 旧 suite 绿；新增测试按预期只红 agent/注册/fallback/selector |
| 3 | EB2 | TOML 必填字段、canonical digest、项目/发布投影 parity |
| 4 | EB3 | absent/same/conflict 注册测试、root/release adapter parity |
| 5 | EB4 | executor skill 全文/摘要/职责隔离、plugin shape |
| 6 | EB5 | provider 优先级、root/release skill parity、driver shape |
| 7 | EB6 | 自动门 + clean-workspace custom-agent/skill live trace |
| 8 | EB7 | cachebuster、安装态复验、架构/代码链路 |

每片只依赖文件状态和持久化证据，不依赖当前对话记忆。EB2 不顺手注册用户 agent；EB3 不顺手改 root spawn；EB4 不顺手把 skill 升为主路径；EB6 不用 repo cwd 代替安装态。

## 6. 验证矩阵

| 维度 | 确定性判据 |
|---|---|
| Root action | `SPAWN_EXECUTORS` 每项仍只有 `opaque_handoff_ref` |
| Agent schema | Custom agent 含 `name/description/developer_instructions`，`name=understand_book_executor` |
| Registration | absent 原子创建、same 幂等、conflict 不覆盖；新 task 后角色可见 |
| Role selection | `agent_type` 已广告时必选 custom agent；未广告时才选 executor skill |
| Bootstrap authority | Custom agent、asset 模板与 fallback skill 均与 canonical wrapper 全文/摘要一致 |
| Role isolation | Custom agent/fallback skill 均不含 planning/confirmation/driver/source-discovery 职责 |
| Plugin shape | agent template + register/build/executor skills 存在；不伪装插件会从 `agents/`/`.codex/agents/` 原生注册 |
| Engine/session | `executor.open/session` schema、actions、retry 与 receipt 既有测试全绿 |
| Privacy | Root 与 final 无 semantic/candidate/private path/raw stderr |
| Clean workspace | 无源码目录时，custom-agent 主路径与 skill 回退的首个引擎边界均为 `executor.open` |
| Skill isolation | 主路径无任何 skill 激活；回退只激活 executor skill；两者均不激活 build skill |
| Parallelism | 每个 spawned worker 独立获得相同 bootstrap，不共享对话推断 |
| Recovery | 中断后 `build.step` 只信 durable state，不重复等价语义尝试 |
| Semantic identity | Extractor bytes 与 `prompt_sha256` 不变 |

正式发布前所有条件合取；单一静态 marker、agent 自述或最终 `committed` 不能替代 clean-workspace trace。

## 7. 文件预算

预计新增:

```text
.codex/agents/understand-book-executor.toml
assets/codex-agents/understand-book-executor.toml
plugins/understand-book/assets/codex-agents/understand-book-executor.toml
scripts/register-executor-agent.ps1
plugins/understand-book/scripts/register-executor-agent.ps1
skills/register-executor/SKILL.md
plugins/understand-book/skills/register-executor/SKILL.md
skills/executor/SKILL.md
plugins/understand-book/skills/executor/SKILL.md
packages/core/test/codex-executor-agent.test.ts
```

预计修改:

```text
skills/build/SKILL.md
plugins/understand-book/skills/build/SKILL.md
packages/core/test/automatic-build-handoff.test.ts
packages/core/test/automatic-build-executor-prompt.test.ts
apps/desktop/scripts/assert-plugin-release.mjs
apps/desktop/scripts/smoke-automatic-build-parity.mjs  # 仅当可复用现有安装态 harness
.codex-plugin/plugin.json
plugins/understand-book/.codex-plugin/plugin.json
.agents/plugins/marketplace.json
docs/架构.md
docs/代码链路.md
```

明确不改:

```text
skills/build/automatic-build-driver.ts
packages/core/src/automatic-build-executor-session.ts
packages/core/src/automatic-build-dispatch-runtime.ts
agents/*-extractor.md
automatic_build_executor_session.v1 schema
BuildPlan / work-unit / lease / attempt / mailbox / receipt / quality semantics
用户书库与 accepted artifacts
```

若 EB1 证明必须修改上述“不改”文件才能注入角色，先回到 ADR-0102 复审边界，不得在 EB2-EB5 内静默扩范围。

## 8. Definition of Done

```text
done =
  bootstrap_contract_is_published
  AND custom_agent_is_project_loadable
  AND release_template_is_explicitly_registerable
  AND registration_is_idempotent_and_conflict_safe
  AND root_prefers_agent_type_understand_book_executor
  AND skill_fallback_is_used_only_when_agent_is_absent
  AND root_build_skill_is_not_activated_in_executor
  AND canonical_wrapper_has_one_authority
  AND plugin_remains_thin
  AND clean_workspace_requires_no_repo_discovery
  AND first_engine_boundary_is_executor_open
  AND every_parallel_worker_gets_the_same_contract
  AND engine_session_semantics_are_unchanged
  AND semantic_prompt_identity_is_unchanged
  AND candidate_never_crosses_root
  AND installed_black_box_and_deterministic_gates_pass
```

任一项为 false，不得用源码 cwd、预先手工存在的个人 agent、静默配置覆盖、隐式 build skill、`--help`/`rg` 自举或 agent 最终自述绕过。
