# ADR-0102 Dedicated executor bootstrap role isolation and distribution

Status: Accepted, 2026-08-10.
Amends: ADR-0101 §2-§3 and the S5-S6 release assumption.
Extends: ADR-0067, ADR-0099 and ADR-0101.
Change type: 边界重构。

`build.step` 现在只向 root 返回 `opaque_handoff_ref`，root build skill 再用一句固定说明启动内置 worker。完整 `automatic_build_executor_session.v1` 协议虽然存在于 `agents/automatic-build-dispatch-executor.md`，却没有作为被选中 subagent 的角色指令发布或注入。内置 worker 因而隐式激活完整 build skill，再从 `--help`、源码搜索和当前工作目录反推协议；这次成功依赖工作目录恰好是源码仓库，不构成安装态合同。实施顺序见[切片方案](../切片方案-executor-bootstrap角色注入与发布闭环.md)。

截至 2026-08-10，OpenAI 官方文档已支持个人 `~/.codex/agents/` 与项目 `.codex/agents/` custom agent，且 `developer_instructions` 是必填字段；本机 Codex CLI 0.146.0 也已把个人 TOML 角色暴露为可选 `agent_type`。因此 executor custom agent 的可实现性已成立。另一边，官方插件包文档只列出 skills、MCP 配置、assets 与 hooks，没有声明安装时会把插件内 TOML 注册为 custom agent。“角色能实现”与“插件会自动注册角色”必须分开。[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Package your plugin](https://developers.openai.com/plugins/build/plugins)

## §1 Executor bootstrap 是角色合同

**决策**:Executor 必须在 spawn 时获得完整版本化角色指令。

**否决**:
- 内置 worker + `executor.open/session` 名称:缺少 stdin schema、action 分支和隐私边界。
- 隐式激活 root build skill:把规划、用户确认和 executor 两个角色重新混合。
- 从当前仓库搜索 wrapper:普通书籍工作区没有源码资产。

**命门**:subagent 在读取语义输入前就必须知道精确 open/session 循环；root 仍只传 opaque ref。
**何时回头**:Build Engine 获得 harness 原生模型调用权时重新划分角色，但不得让 candidate 经 root 中转。
**展开**:[EB1-EB6](../切片方案-executor-bootstrap角色注入与发布闭环.md#4-切片顺序)

## §2 Custom agent 是主角色，注册是独立边界

**决策**:Custom agent 主执行；显式注册，skill 仅回退。

**否决**:
- Executor-only skill 作主路径:仍依赖任务时 skill 路由，不是 spawn 时角色注入。
- 假定插件自动加载 agent 模板:当前公开插件合同没有该注册语义。
- Setup 静默覆盖个人或项目 agent 配置:会破坏用户文件所有权。
- 把 `agents/` 整目录塞回薄插件:混入语义 extractor 资产并推翻 ADR-0099 的发布边界。

**命门**:root 在角色已注册时必须显式选 `agent_type=understand_book_executor`；注册操作必须显式、幂等、冲突失败关闭。
**何时回头**:官方插件 manifest 原生支持 custom agent 注册时，删除显式注册适配层；不改变 custom agent 主角色。
**展开**:[EB2-EB5](../切片方案-executor-bootstrap角色注入与发布闭环.md#4-切片顺序)

## §3 Bootstrap 指令单一权威

**决策**:`automatic-build-dispatch-executor.md` 是 bootstrap 正文唯一权威。

**否决**:
- 在 root build skill 复制完整协议:每次 spawn 扩大 root 上下文并形成第二权威。
- 把协议正文放进 `SPAWN_EXECUTORS` action:破坏只返回 opaque ref 的收口边界。
- 只比较少量 marker:两份文本可同时含 marker 却在 action 或隐私规则上漂移。

**命门**:发布门必须比较规范化完整正文或其 SHA-256，并验证 TOML 必填字段；semantic extractor `prompt_sha256` 继续不变。
**何时回头**:Harness 提供内容寻址的角色指令资产并能原子绑定 spawn 时。
**展开**:[EB1-EB2](../切片方案-executor-bootstrap角色注入与发布闭环.md#4-切片顺序)

## §4 安装态行为门禁

**决策**:安装态分别验收 custom-agent 主路径与 skill 回退。

**否决**:
- 只测 wrapper/sidecar prompt 字节:不能证明 spawned agent 实际得到该文本。
- 只在 repo root 真跑:会让 `rg agents/` 偶然自愈。
- 只看最终 `DONE`:无法发现每个 subagent 都重复 skill、help 与协议搜索。

**命门**:custom-agent trace 必须可观测到显式 `agent_type` 且无任何 build/executor skill 激活；回退 trace 只允许 executor skill；两者都禁止 `--help`、协议搜索、repo 资产读取和 candidate 进入 root。
**何时回头**:Codex 提供可确定性检查的 spawn-role/instruction introspection API 时，可用等价自动门替代模型黑盒。
**展开**:[EB6](../切片方案-executor-bootstrap角色注入与发布闭环.md#eb6-安装态双路径黑盒验收)
