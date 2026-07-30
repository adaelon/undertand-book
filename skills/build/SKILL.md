---
name: understand-book-build
description: Build or resume a book workspace, optionally from a confirmed natural-language reading goal shared with the Reader.
---

# $understand-book-build

> **Codex 入口**:`$understand-book-build <target>`。`target` 可以是 Markdown/EPUB、paper
> Workbench book id,或 `.understand-book/<book_id>` workspace。Claude Code 兼容入口仍是
> `/understand-book:build`(由插件名和 skill 文件夹名决定)。

## Codex 一命令自动编排(强制)

调用本 skill 后,主 agent 必须持续运行下面的确定性 loop,直到 action=`done`、出现
`needs_user`,或发生已耗尽自动修复的明确失败。不得只解释命令、只打印计划、只写 executor
contract,也不得在普通 stage 边界停下等待用户继续。

1. 定位本插件根目录(含 `.codex-plugin/plugin.json`)和确定性构建 sidecar:
   - 若 `UNDERSTAND_BOOK_BUILD_EXE` 指向存在的文件,使用它。
   - Windows 安装版读取 `HKCU\Software\UnderstandBook` 的 `InstallDir`,使用同目录下的
     `understand-book-build.exe`。
   - 意图控制器优先使用 `UNDERSTAND_BOOK_DESKTOP_EXE`,否则使用同一 `InstallDir` 下的
     `UnderstandBook.exe`;它拥有 reader-private store,build sidecar 不得复制该 store。
   - 仅插件开发/非 Windows 环境允许回退 Node:若缺少 `node_modules/tsx`,在插件根运行
     `pnpm install --frozen-lockfile`;依赖失败则报告阻塞,不得伪造构建。
   - 无自然语言目标时,本 skill 调用才是显式旧“完整预构建”命令。先运行
     `<understand-book-build.exe> legacy-plan <target> --root <root> [策略与预算参数]`,只消费
     `explicit_legacy_build_plan.v1`,要求 plan 为已确认 `standard_deep` 且
     `confirmation_source=explicit_legacy_command`,并保留 `build_plan_path`。打开、导入或恢复书籍
     不属于该调用,不得运行 `legacy-plan`;既有 SidecarPlan 也不得代替顶层 BuildPlan。
   - 安装或升级 sidecar 后运行
     `<understand-book-build.exe> protocol-doctor <target> --plugin-root <插件根目录> --build-plan <build_plan_path>`。只消费
     `automatic_build_protocol_doctor.v1`;它必须报告 `status=compatible`、
     `production_default=automatic_build_protocol.v2_dispatch` 与 `dry_run_mutates_state=false`。

### 自然语言目标的 v2 规划与两步确认

有自然语言目标时,target 文件不是 workspace。原始 Markdown/EPUB 或不可信 paper draft 返回
`needs_user(foundation_required)`,先由 Reader 导入/构建。对 Reader 书库内或由 Reader 显式登记的
绝对 workspace,不得从文件名、`.build/input/manifest.json`、PDF 或可选 paper sidecar 猜 profile/
foundation;只有 Desktop controller 可返回 `CODEX_BUILD_FOUNDATION_REQUIRED`。

所有 controller 调用都只在 argv 放 `--codex-build-intent`,并通过进程 stdin 写入恰好一个 JSON
envelope。不得把 raw goal 或 candidate 放进 argv、环境变量、shell 插值、临时/公共文件、stdout、
stderr 或用户可见计划;不得记录或复述完整 candidate。

1. 先发送 v2 capability/context 请求,此时不得发送 raw goal:

   ```json
   {"version":"codex_build_intent_command.v2","operation":"planning.context","target":{"workspace_dir":"<absolute>"},"input":{}}
   ```

   只消费 exactly-one `codex_build_intent_result.v2`。成功响应必须是
   `status=ok + response.version=build_planning_context.v1`;读取 target、scope catalog、Registry summaries、
   candidate contract 与 `context_digest`。若正常退出却没有该 v2 envelope、报告 unsupported version/
   capability,或返回旧协议正文,停止为 `needs_user(CODEX_BUILD_INTENT_V2_REQUIRED)` 并提示升级 Desktop/
   重装 plugin。Never fall back to `codex_build_intent_command.v1`；新 goal 入口不得调用 v1 raw-goal
   `draft`,也不得调用 Reader provider。

2. 当前 Codex 直接根据用户目标与该 context 构造一个 strict
   `build_intent_planner_candidate.v2`:

   ```text
   version / goal_kind
   source_scope={whole_book,lids,sections}
   artifacts=[registry selection | one_off ArtifactBlueprintV1]
   usage_horizon
   ```

   - `artifacts` 为 `0..candidate_contract.max_artifacts`,identity+version 唯一。Registry 选择只能逐字使用
     context 中列出的 `source/blueprint_id/blueprint_version`;列表截断时不得猜隐藏项。
   - scope 只能使用 context 给出的 LID/section 样本或 `whole_book=true`;不得发明未展示的细粒度锚。
   - 匹配时优先复用 Registry,不强套。不匹配时设计 `origin=one_off` 的
     `artifact_blueprint.v1`,shape 只能来自 `allowed_shapes`;schema 必须有界、closed 且逐记录 LID evidence,
     禁止 code、`$ref`、递归、regex、remote schema 与额外字段。
   - `search_fields` 中自由文本(`free-form string`,如 topic/title/question/claim)必须使用
     `analyzer=text`;`analyzer=keyword` 只用于 enum 等有界精确类别,不得用于自然语言主题短语。
   - candidate 不得包含 raw goal、解释、plan id/digest、public stages 或 Reader-private path;Codex 不得
     伪造 Reader plan identity。

3. 用同一受保护 stdin 通道发送:

   ```text
   version=codex_build_intent_command.v2
   operation=draft.candidate
   target.workspace_dir=<same absolute workspace>
   input={user_goal,planning_context_digest,candidate,budget?}
   ```

   只消费 exactly-one `codex_build_intent_result.v2`。若 `error_code=BUILD_PLANNING_CONTEXT_DRIFT`,立即
   丢弃旧 context/candidate,重新执行 `planning.context` 并重新规划;禁止重交旧 candidate。candidate/
   Blueprint 校验失败时按结构化 phase 修正或报告,不得删项伪装成功。缺 v2 能力仍返回
   `CODEX_BUILD_INTENT_V2_REQUIRED`,不做 v1 fallback。

4. 成功结果的 `response.version` 必须为 `codex_build_intent_response.v1`,其
   `response.projection.version` 必须为 `codex_build_intent_plan.v2`。向用户展示 projection 的 goal
   kind、scope、artifact summaries、public closure、reuse/create/excluded、token/墙钟估计、budget、
   `plan_id + plan_digest`,然后停止为 `needs_user(plan_confirmation_required)`;确认前禁止运行
   `legacy-plan/plan/next` 或私有成果任务。

用户确认后,仍使用 `codex_build_intent_command.v2` 对已展示 `plan_id` 执行 `operation=status`;若
Reader 已 replan、source/context 变化或 status/digest 不同,展示当前 Reader 投影并重新等待确认。
完全一致时发送 `operation=confirm + exact plan_id + plan_digest`,要求返回
`confirmation_source=codex_conversation`,保留 reader-private `build_plan_path`,然后才进入下方公共
automatic-build loop。Reader 已确认同一精确 plan 也可继续。用户拒绝时发送 v2
`operation=reject`;不得把展示计划之前的“构建它”当确认。
2. 每次进入一个可能需要模型抽取的 stage,先用与后续 `next` 完全相同的
   `--max-parallel`、`--quality-profile` 和预算参数执行只读 preflight。`--max-parallel`
   是已接受计划允许的 worker 上限(最多 3);`--available-agent-slots` 是此刻真正空闲的专用
   subagent/multi-agent 槽位,必须在每次 `plan/next` 前按 harness 事实重算:

   ```text
   <understand-book-build.exe> plan <target> --plugin-root <插件根目录> --build-plan <build_plan_path> --max-parallel <1..3> --available-agent-slots <0..3> [策略与预算参数]
   node node_modules/tsx/dist/cli.mjs skills/build/automatic-build.ts plan <target> --build-plan <build_plan_path> --max-parallel <1..3> --available-agent-slots <0..3> [策略与预算参数]
   ```

   只消费 stdout 的 `automatic_build_plan.v1` JSON。`preflight=null` 表示下一步不需要模型,
   直接执行 `next`;否则先检查 work-unit 数量、lifetime/remaining/scheduled 成本、估算 Token
   区间、墙钟 P50/P95、agent starts、confidence、质量策略、预算状态和 worker plan。
   `preflight.budget.status=exceeded` 时停止并报告 `needs_user(budget_exceeded)`,不得 claim。
   配置墙钟预算时还必须冻结 `preflight_evaluation_digest`;`low_confidence` 或 `exceeded`
   分别停止为 `needs_user(low_confidence_wall_budget)` 或 `needs_user(wall_budget_exceeded)`。
   预算内则把 plan 与 evaluation 两个 digest 原样传回:

   ```text
   <understand-book-build.exe> next <target> --plugin-root <插件根目录> --build-plan <build_plan_path> [相同策略/预算] --max-parallel <1..3> --available-agent-slots <当前值> --accepted-plan <plan_digest> [--accepted-evaluation <preflight_evaluation_digest>]
   node node_modules/tsx/dist/cli.mjs skills/build/automatic-build.ts next <target> --build-plan <build_plan_path> [相同策略/预算] --max-parallel <1..3> --available-agent-slots <当前值> --accepted-plan <plan_digest> [--accepted-evaluation <preflight_evaluation_digest>]
   ```

   `available_agent_slots` 不进入 plan identity,因此槽位缩减不会使已接受 digest 漂移;
   `worker_plan.max_workers=min(requested,available,3,max_parallel_cost 容量)`。0 槽位返回
   `needs_user(executor_unavailable)`;plan 不创建 task、attempt 或 lease 状态。使用性能历史时,
   `--executor-model`、`--executor-reasoning-effort`、`--executor-harness-release` 必须三者同时提供;
   历史只在 stage/kind/router 与这三项 provenance 全匹配时参与预测和 adaptive TTL。

   BP8 起 `automatic_build_protocol.v2_dispatch` 是新 claim 的生产默认:`next` 不预领 task,
   而是持久化已接受的完整 dispatch plan 并返回 `action.kind=dispatch`;后续补位必须继续传
   相同 accepted plan/evaluation。`--executor-dispatches` 只保留为兼容别名。若需要回滚到
   一任务一 executor,必须显式传 `--protocol automatic_build_protocol.v2`;该回滚读取同一 v2
   task/artifact 状态,不迁移、不重写已发布 artifact,也不得用于绕过 dispatch 故障诊断。

3. 只消费 stdout 的 `automatic_build_next.v1` JSON:
   - `action.kind=dispatch`:启动数必须等于 `action.dispatches.length` 的专用 subagent,不得按
     manifest 内 task 数启动。每个 subagent 只接收同一个 extractor prompt 与一个
     `automatic_build_dispatch_executor.v1` 信封,并独占其 `dispatch_run_id`。它循环执行
     `next_command`,每次最多收到一个 `action.kind=task` 信封;该 task 的 input/candidate/usage/
     submit/fail/heartbeat 契约与下面的单任务路径完全相同。task terminal 后必须丢弃 candidate
     body 再执行下一次 `dispatch.next`;semantic failure 已有 bounded task receipt 时继续下一 task。
     `waiting` 只按 `retry_after_ms` 等待;`finish` 原样执行 `finish_command`;`finished` 只向 root
     返回 `automatic_build_executor_dispatch_receipt.v1`。executor/命令/进程基础设施失败时立即
     执行 `interrupt_command`,不得继续 manifest 后缀。root 只核对
     `receipt_aggregation.expected_receipts/max_total_bytes`,不得接收 manifest 内逐任务 candidate。
     任一 dispatch receipt 返回后,root 按真实空闲槽位重新 plan/next;运行时从同一持久化 plan
     排除 active/finished dispatch 并立即补下一 manifest,不等待慢 worker。
   - `action.kind=extract`:只出现在显式旧 v2 回滚路径。若没有可用专用 subagent/multi-agent 槽位,立即停止并报告
     `needs_user(executor_unavailable)`,不得由 root 代跑模型。若有
     `extractor_prompt_command`,读取 prompt;否则读取 `extractor_prompt`。随后按可用槽位启动
     专用 subagent,每个只接收 prompt 与一个 `automatic_build_executor.v1` 信封。启动数必须等于
     `action.tasks.length`,不得超过 `worker_plan.max_workers`:

     ```text
     task_id / attempt_number(= semantic_attempt) / execution_identity / lease_ref
     input_command / candidate_path / candidate_command / usage_path / submit_command
     heartbeat_command / fail_command / inspect_command
     ```

     新 claim 先进入 10 分钟 `reserved` phase。`input_command` 的第一个副作用必须 create-only
     创建 `start.json`,从该时刻开始独立的 30 分钟 `running` deadline;重复 input start 读取同一记录。
     `heartbeat_command` 只允许延长 token、owner、target、stage、work unit 和 execution identity
     均匹配且未 terminal 的 running lease,不得延长 reserved 或过期 lease。

     subagent 必须自行执行 `input_command`,把该 stdout 作为唯一抽取输入;模型候选先写入同一
     task mailbox 下的私有 source 文件,再把 `candidate_command` 中的 `{candidate_source}` 替换为
     该路径并执行。helper 只接受 UTF-8 no-BOM 或单 BOM JSON,并把 `candidate_path` 规范化为
     UTF-8 no-BOM;禁止用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 直接写
     `candidate_path`。若 harness 提供原生或 executor-reported usage receipt,按
     `automatic_build_usage_receipt.v1` 写入 `usage_path`,否则不创建该文件。`source=unavailable`
     时禁止写任何精确 Token 字段,estimate 必须使用独立的带版本 method。可证明时同时记录
     `model`、`reasoning_effort` 与 `harness_release`;不可证明时保持缺失,由 summary 显式计入
     `unavailable` 和覆盖率,不得猜测。随后自行执行
     `submit_command`。成功时只向 root 返回
     submit stdout 的 `automatic_build_task_receipt.v1`;失败时自行执行 `fail_command` 并只返回
     failure receipt。root 只把本批最多 3 个 bounded receipt 组成临时 receipt 列表,核对
     `receipt_aggregation.expected_receipts/max_total_bytes` 后丢弃列表并回到步骤 2;不得把 receipt
     扩成 artifact 内容。root 禁止接收、复述、缓存、写入或转发 candidate JSON,也禁止调用
     `legacy-submit` 兼容入口。长任务由 subagent 执行 `heartbeat_command`。尝试次数与任务完成
     真相只从 lease/mailbox/receipt 得出,不得在对话内计算。
   - `action.kind=waiting`:按 `retry_after_ms` 有界等待后重新执行步骤 2;不得重发 active lease。
   - `action.kind=close_stage`:原样执行 `command`;禁止添加 `--allow-partial`。失败时保留磁盘
     中已完成窗口并报告结构化 stderr。semantic close 的 action 必须带已通过的
     `automatic_build_stage_quality_report.v1`;close 会在事务发布前重新计算并把报告写入
     `.build/automatic-build/v2/quality/<stage>.json`,不得绕过或手改报告。
   - `action.kind=needs_user`:停止自动 loop。预算类展示 `reason`、stage、plan digest 与
     violations;`preflight_required` 表示尚未确认当前计划;`evaluation_required` 或
     `evaluation_changed` 表示墙钟评估尚未接受或性能历史已经变化;`low_confidence_wall_budget`
     表示缺少匹配历史且墙钟门禁不能安全放行;`plan_changed` 表示 descriptor、质量、
     policy、预算或 worker 请求已变化,必须回到步骤 2 重新 plan。`legacy_migration_required`
     必须展示只读 audit 与 `legacy_resume/v2_rebuild` 两个命令,等待用户显式选择;root 不得代选。
     `legacy_resume_selected` 只能转回冻结的 production v1 contract,其结果始终标
     `legacy_policy_unknown`,不得继续 v2 loop。`quality_gate_failed` 必须分别展示 integrity 与
     selected quality floor violations,不得用全叶锚定率、LLM 自评或 `--allow-partial` 覆盖。重试耗尽时展示 task id、
     最后诊断与 `reset_commands`;只有用户确认重试后才能执行 reset。
   - `action.kind=done`:若为 `standard_deep`,报告 workspace 路径和已完成阶段并结束;若为已确认
     `goal_directed`,继续执行下方 reader-private 成果 loop。
4. 每个 dispatch receipt、每批 write 或 stage close 后立即回到步骤 2 重新生成当前 pending 集合的 preflight。磁盘 `.build/<stage>` 是唯一续建真相;
   不依赖对话记忆判断 done/pending。

### reader-private 目标成果 loop

公共 closure `done` 后,经 Desktop stdin controller 调用 `operation=artifact.prepare + confirmed
plan_id`,只消费 `intent_artifact_prepare_response.v1`。`handoff.tasks=[]` 表示全部声明成果已
accepted,此时才报告完成。否则按当前专用 subagent 槽位分波处理 opaque handoff;必须处理完本次
返回的整批 tasks 后再 prepare retry,避免失败成果饿死未处理兄弟成果。

root 每个 subagent 只给 `workspace_dir/task_path/Desktop controller path`,不得读取 task 或接收其
正文。专用 subagent 先调用 `artifact.inspect`,自行读取私有 `task.json`,仅依照其中 goal、scope、
output contract、validation rules、allowed evidence LIDs 与 canonical Book 工具/产物生成
`intent_artifact_candidate.v2`;完整复制 task identity 与 `blueprint_digest`,生成内容只放在
`payload={version:"artifact_instance.v2",blueprint_digest,records,relations?}`。每条 record/relation
分别使用 task Blueprint 的 record/relation schema,并携带至少一个 allowed evidence LID;以 UTF-8 no-BOM
写 sibling `candidate.json`。随后经 stdin 调用 `operation=artifact.submit`,只把 body-free
`intent_artifact_mailbox_receipt.v1` 返回 root。模型/进程/schema 失败时调用
`operation=artifact.fail + path-safe diagnostic_code`,只返回 retry receipt。

root 只校验 receipt 数、state、task/artifact identity 与 confirmed plan digest,丢弃 receipt 列表后
再次 prepare。中断后复用 pending attempt;accepted artifact 会被确定性排除;failed artifact 新开
有界 attempt;stale source/plan/task fail closed。candidate payload、raw goal、quote、LID 列表与
accepted body 都不得从专用 subagent 回到 root context。

硬边界:
- paper 必须先在 Build Workbench 完成 source reconciliation 与 hybrid foundation;本 skill
  只查找并验证其可信产物,不自行替代来源对齐。
- 非 paper Markdown/EPUB 从原始输入执行全管线。
- 专用 subagent/multi-agent 不可用时 fail-fast;不允许主 agent 用通用摘要、空节点、
  reject-all 或模板 sidecar 降级。
- 自动修复最多 2 次(总尝试 3 次);之后才向用户展示 task id、gate 诊断和重试/停止选择。
- v2 claim 前若发现 legacy/mixed artifact,必须先执行 `audit-legacy`;`v2_rebuild` 会把旧文件
  复制到不可变 legacy snapshot 后再执行,绝不删除或原地伪装 policy。公共 artifact 仅在完整
  v2 candidate set 通过 integrity+quality 后经事务发布;失败恢复旧公共集合。
- 正常条件下一次调用跑完;配额、进程或机器外部中断后,再次调用同一命令幂等续跑。

> **调用形态**:插件 skill 强制命名空间 = `/<插件名>:<skill文件夹名>`。本插件 name
> `understand-book`(`.claude-plugin/plugin.json`)+ skill 文件夹 `build` ⇒ 命令
> **`/understand-book:build`**。读时启动是另一个 skill `/understand-book:read`(留 S7)。

> **状态:S1–S3 确定性骨架 + PB5/PB6/PB3 跨会话续建脚手架已实现。** 段切分(S1)/
> 窗口(S2)/ Pass1 输入组装·merge+闸·目录投影(S3)落 `packages/core` 单测全绿;Pass1、
> profile-sidecar、Pass2 的 status/input/write/batch 流程均落 `.build/`。
> 余:**真书 + 真 LLM 语义质量试跑**(专门子代理逐窗抽取/分类 → 固化 `.understand-book/` → 自检闸实测)。

把一本书(`$ARGUMENTS` 指向的 epub/md)预构建成只读知识图谱基座,产物落
`.understand-book/`。预构建期绑当前 agent harness(本 skill 在 harness 内跑,
harness 供 LLM)`[ADR-0003]`;读时是独立产品,启动走 `/understand-book:read`(留 S7)。

## content_profile / extraction rule pack `[ADR-0033/0048]`

当前默认 `content_profile = technical_learning`。现有 `pass1-local-extractor`、
`profile-sidecar-extractor`、`pass2-longrange-linker`、`book-structure-extractor`
的抽取规则属于 `technical_learning` 规则包,不是 Core 全局真理。

后续新增 `paper` 等 profile 时,只能替换/扩展这些固定插槽的规则:
`pass1_rules`、`profile_sidecar_rules`、`pass2_edge_contracts`、
`book_structure_rules`、`mcp_projection_rules`、`answer_policy`。profile 不得改变
LID、source/book.text、citation anchor、确定性 gate、Core 命令面或 memory 隔离。

`paper` 规则包必须同时覆盖两层抽取 `[ADR-0049]`:
- **PaperArgumentLayer**:problem / research_question / method / evidence / claim / limitation,
  每个判断必须带真实 LID evidence。
- **PaperMetadataLayer**:title / authors / affiliations / venue / year / DOI/arXiv/URL /
  keywords / field labels / references / dataset-code-funding links。正文来源带 LID evidence,
  用户或外部 resolver 来源必须标 source。

PaperArgumentLayer 不物化独立 `paper_argument.json` `[ADR-0053]`;它落在
BookStructure(`spine/throughlines/key_stops`) + graph(entity/concept/claim/edges) +
discourse sidecar(段落功能/语篇关系)中,由 MCP/读时按需投影。

PaperMetadataLayer 物化为独立 profile sidecar `paper_metadata.json` `[ADR-0050]`。
它不塞进 `book_structure.json` 或 graph schema;BookStructure 仍只表达
`spine + throughlines + key_stops`,graph 仍只表达 entity/concept/claim/edges。
`paper_metadata.json` 的业务字段必须统一使用 `MetadataField<T>` 来源信封
`{value, source, evidence_lids?, confidence?}` `[ADR-0051]`;禁止裸字符串/裸数组字段。
MVP 字段集固定为 title、authors、affiliations、venue、year、identifiers(DOI/arXiv/URL)、
keywords、field_labels、references、datasets、code_links、funding `[ADR-0052]`。
不得在 MVP 中顺手做 citation style normalization、author disambiguation、
institution canonicalization、BibTeX/CSL 完整兼容或 reference graph normalization。

`paper` 规则包还应产出双语辅助 profile artifact `paper_lexicon.json` `[ADR-0054]`:
只抽论文关键术语、缩写、方法名、领域术语、数据集/指标/模型名、高价值学术短语等。
英文 `source/book.text` 仍是唯一正文真相;禁止全文预翻译成中文,禁止把中文解释当 citation evidence。
普通单词、短语和句子理解走读时按需解释 + 用户 memory,不写入公共基座。
`paper_lexicon.json` MVP 只收录理解本论文必需的公共词项 `[ADR-0055]`:
paper-defined terms、method names、acronyms、domain terms、dataset/metric/model names、
影响论证理解的 recurring academic phrases。普通英语生词默认不收录;只有当它在本论文中
成为术语、论证关键词或固定搭配影响论证理解时才可进入。
每个 lexicon 条目必须带 `occurrences_lids`;只有论文英文原文明确给出定义时才填
`defined_at_lid` `[ADR-0056]`。不得把首次出现位置、中文解释或模型常识伪装成定义位置。
`paper_lexicon.json` 的预构建目标是术语索引 `[ADR-0057]`:必须保存 term、term_type、
occurrences_lids、defined_at_lid?、aliases?、acronym_expansion?。短中文 gloss 可选;
深度中文解释、句法拆解和面向用户水平的讲解留给读时按上下文生成。

`paper` 规则包还应提供 `PaperReadingGuide` MCP/读时 projection `[ADR-0058]`:
- `PaperReadingMode`: skim / close / deep。
- `PaperReadingStage`: passive / active / critical / creative。
- 论文十问:问题/input-output、问题性质、hypothesis、相关研究/关键人物、核心贡献、
  实验设计、数据集、结果是否支撑假设、贡献总结、下一步工作。
- `PaperCodebook`:由 paper_lexicon + paper_metadata + BookStructure + discourse + graph 组合。
- `AbstractReadingAid`:摘要英文原文 + 关键术语 + 短中文释义 + 逐句理解检查 + 用户中文复述。
- 读时入口:REST `GET /book/paper_reading_guide?mode=&stage=`,runtime tool
  `book.paper_reading_guide`,MCP tool `book_paper_reading_guide`。
- 单篇论文 MCP 还暴露 `book_paper_metadata` / `book_paper_lexicon` 作为本篇 dossier
  与多论文客户端候选对齐键;不得在单篇服务内新增 cross-paper / corpus 关系工具。
这些都是 projection,不得新增 `paper_questions.json`、Codebook 持久产物或第二套 paper truth。

## 参数
- `$ARGUMENTS`:书路径(epub / markdown)。`--full` = 忽略已有基座强制全量重建。

## 构建期子代理授权与质量优先级

用户已授权预构建期**直接调用专门子代理**完成贵语义步骤:
`pass1-local-extractor`、`profile-sidecar-extractor`、`pass2-longrange-linker`、`book-structure-extractor`。这些子代理是
build-time harness 能力的一部分;TS 脚本只负责状态、输入、写盘、hash、gate 和 batch 收口。

质量优先级:
- **sidecar 语义质量优先于 token 节省**。`discourse_index.json` 与 `formula_semantics.json`
  直接影响读时解释、公式理解和后续 Pass2 packet 质量,不得用低信息量通用填充换取快速 done。
- 禁止把“schema 合法”当作“语义完成”。确定性 gate 只能验证 LID/enum/shape,不能替 LLM 判断
  `local_function`、`relations`、公式参数含义是否读对。
- 如果专门子代理不可用、窗口无法真实抽取、或 classifier 无法逐候选判断,**停止并报告阻塞**;
  不得改用 deterministic generic sidecar、空泛 formula 解释、或 Pass2 reject-all 作为常规完成路径。
- `--allow-partial` 只允许 smoke/救急且需用户显式要求;不得用它绕过语义抽取质量。

## 编排骨架(8 段管线)
0. **段/句粒度体检**(确定性,`skills/build/granularity-profile.ts` 经 tsx · SA0 ✓ `[ADR-0032]`):输出 `GranularityProfile`,用户确认 `paragraph/hybrid/sentence` 后才进入正式构建。
1. **导入 + LID 段级切分**(确定性,`skills/build/split-lid.ts` 经 tsx · S1 ✓ `[ADR-0008]`)
2. **窗口切分**(LID 子树 + 双约束预算,`packages/core/src/window.ts`;CLI `skills/build/window-cli.ts` · S2 ✓ `[ADR-0009]`)
3. **Pass1 局部抽取**:`packages/core/src/pass1-input.ts` 把每窗口组装成带 LID 标注的正文 → subagent `pass1-local-extractor`(5 并发,见 `agents/`)逐窗口出 `{nodes, edges(local)}` · S3 ✓骨架 `[ADR-0010]`
4. **merge + 确定性图谱闸**(`packages/core/src/merge.ts:mergeAndGate`;按类型合并 occurrences + 悬空丢不重建 + 最小连坐 + 可观测报告 · S3 ✓ `[ADR-0011]`)
5. **全局目录确定性投影**(`packages/core/src/catalog.ts:projectCatalog` · S3 ✓ `[ADR-0010]`)
6. **PB6 profile sidecar + Pass2 长程边**:subagent `profile-sidecar-extractor` 产 `discourse_index.json` / `formula_semantics.json`;subagent `pass2-longrange-linker` 逐候选分类 long_range 边。
7. **PB7 BookStructure 结构地图**:subagent `book-structure-extractor` 先逐结构单元产 unit cards,再 stitching 出 `spine + throughlines + key_stops`,经 gate 固化 `book_structure.json`。
8. **自检闸 + 固化只读基座**(分区不变式 + 锚定率 ≥90%,产 `.understand-book/` · 下一刀)

## 跨会话续建(冷启动契约)`[ADR-0042 · PB5]`

> **状态:PB5 已实现(ADR-0042)。** CLI `build-status` / `emit-input` / `pass1-write` / `pass1-batch`(续建改造)+ core `build-resume.ts`(`pass1ContentHash` / `computeBuildStatus` / `buildPass1Artifact`)+ `book-id.ts`(`deriveBookId`)落地且单测绿。
>
> build 由 Claude 在环驱动,真书数十窗 Pass1 抽取**一个会话跑不完**(token/上下文耗尽是常态,非异常)。任一**新会话零上下文**,纯靠 `.understand-book/<bookId>/.build/` 中间产物接手。下面是冷启动续建 loop,与 SESSION_CHECKPOINT(C4/C5 会话热启动)同招——只是冷启的是"构建状态"。

```
1. tsx skills/build/build-status.ts <book> [--book-id <id>]
   → done/pending 窗口 id(= 重算窗口逐窗 content-hash 校验 .build/pass1/<id>.json)
   # bookId = deriveBookId(<book>):文件名 slug;非 ASCII 主导报错,用 --book-id 显式指定
2. 对每个 pending 窗口 id:
   a. tsx skills/build/emit-input.ts <book> <id>            # 现算该窗 [LID] 前缀正文到 stdout(不落盘)
   b. 交 subagent pass1-local-extractor 抽 {nodes, edges(local)} → 存临时 out.json
   c. tsx skills/build/pass1-write.ts <book> <id> out.json   # 重算 hash + 原子写 .build/pass1/<id>.json
   # token 快耗尽就停:已写的全部幸存,下个会话从 build-status 接着来
3. 全 done → tsx skills/build/pass1-batch.ts <book>          # 消费 .build/pass1/* → merge/gate/固化 base + sidecar
   # 仍有 pending → 拒绝收口并报 pending ids(--allow-partial 显式兜底,只收 done 窗)
```

> **命门**:`pass1-write` 的 content_hash 由 TS 从窗口正文重算(`buildPass1Artifact`),agent 绝不手算 hash——书/切分变了则受影响窗口 hash 失配、`build-status` 判 pending 重抽,杜绝陈旧静默复用。

铁律:
- **逐窗原子写**:每抽完一窗立刻写其 `pass1/<id>.json`,绝不攒到末尾批量写(会话死=半成品全丢)。
- **冷启动只信磁盘**:新会话不依赖上个会话上下文里的任何东西;窗口确定性重算、`build-status` 给真相。
- **content_hash 锚新鲜度**:书/切分/profile 规则变了 → 受影响窗口 hash 失配 → `build-status` 判 pending 重抽,绝不静默复用陈旧抽取。
- `.build/` 是 build-only,`Book::load` 不读。

## paper Pass1 profile-aware 输入 `[PP4]`

`emit-input` / `pass1-write` / `pass1-batch` 在 `--content-profile paper` 时使用 profile-aware Pass1 input:

```text
PAPER_PASS1_RULES
content_profile: paper
paper_subtype: research_article | survey
argument_slots: ...
paper_edge_rules: ...

TEXT
[LID] source text...
```

`technical_learning` 路径保持旧输入逐字不变。Pass1 `content_hash` 绑定 profile-aware input,因此同一 source 的 technical artifact 不会被 paper 构建静默复用。

## 基座 schema(单一真相源)
基座类型由 Rust 权威定义(`crates/base-schema`,serde+ts-rs+schemars),ts-rs
生成 TS 给预构建用 `[ADR-0021]`。S0 先打通该生成链路(本仓库 `crates/base-schema`
→ `packages/core/src/generated/`)。
## profile-sidecar 独立抽取趟 `[PB6]`

> `discourse_index.json` 与 `formula_semantics.json` 不属于 Pass1 收口;不要把它们塞进 `pass1-batch`。PB6 先把正文段落组与 grounded formula 拆成独立 semantic units,再读写 `.build/profile-sidecar/`。paper discourse unit 会注入 `PAPER_DISCOURSE_RULES`;formula unit 只携公式与邻接解释。

```text
1. tsx skills/build/profile-sidecar-status.ts <book> [--book-id <id>]
   -> 查看 discourse eligible/group 与 formula eligible/skip/done/pending accounting
2. 对每个 pending `discourse-*` / `formula-*` work unit:
   a. tsx skills/build/profile-sidecar-input.ts <book> <work-unit-id>
      -> 输出 unit_kind + visible_lids + formula_lids + `[LID]` 正文
   b. 交给 subagent profile-sidecar-extractor
      -> discourse unit 只产 discourse_items;formula unit 只产 formula_semantics
   c. tsx skills/build/profile-sidecar-write.ts <book> <work-unit-id> out.json
      -> 互斥 gate 后原子写 `.build/profile-sidecar/<work-unit-id>.json`
3. 全部 eligible semantic units done -> tsx skills/build/profile-sidecar-batch.ts <book>
   -> 只写 `discourse_index.json` / `formula_semantics.json`
```

铁律:
- profile-sidecar batch 不改 `base.json` / `source.txt` / `profile_metadata.json` / `long_range_candidates.json`。
- `formula_lids` 由 `LidNode.kind === "formula"` + fragment/context router 确定性注入,LLM 不判断哪些 LID 是公式。
- 裸变量、页码/脚注、文本装饰、bibliography 公式与无解释公式必须 deterministic skip,不得生成空 artifact 或 discourse item。
- 每个 pending semantic unit 必须交 `profile-sidecar-extractor` 做真实语义抽取;不得用模板化 discourse item
  或“以相邻原文为准”这类通用 formula 解释填满 sidecar。
- 对公式语义,宁可让无证据公式保持 pending/omit 后暴露质量缺口,也不要编造参数、单位或组合含义。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。
- paper discourse 标签只表示段落功能,不是最终论证结论;低置信标签应 omit。

## paper_metadata 独立抽取趟 `[PP2]`

> `paper_metadata.json` 只在 `--content-profile paper` 下运行。它是 PaperMetadataLayer 的独立 profile sidecar,不写入 `book_structure.json` 或 graph。

```text
1. tsx skills/build/paper-metadata-status.ts <book> [--book-id <id>] --content-profile paper
   -> 查看 candidate router 的 eligible/skipped/done/pending(content_hash 校验)
2. 对每个 pending candidate id:
   a. tsx skills/build/paper-metadata-input.ts <book> <id> --content-profile paper
      -> 输出 signal_types + visible_lids + requested_fields + `[LID]` 正文
   b. 交给 subagent paper-metadata-extractor
      -> 只产 `{paper_metadata: {...}}`
   c. tsx skills/build/paper-metadata-write.ts <book> <id> out.json --content-profile paper
      -> 校验 MetadataField envelope / LID evidence 后原子写 `.build/paper-metadata/<id>.json`
3. 全部 eligible candidate done -> tsx skills/build/paper-metadata-batch.ts <book> --content-profile paper
   -> 合并模型字段与确定性 bibliography references,写 `paper_metadata.json`
```

铁律:
- 所有业务字段必须是 `{value, source, evidence_lids?, confidence?}`;裸字符串/裸数组直接 fail-fast。
- `front_matter` / `paper_text` 来源字段必须带真实 LID evidence。
- 无 metadata 信号窗口必须记录 deterministic skip,不得生成空模型 artifact;编号清晰且有年份/identifier 锚点的 bibliography reference 由 router 确定性合并,只有歧义项进入模型 candidate。
- 不做 author disambiguation、institution canonicalization、BibTeX/CSL 或 reference graph。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。

## paper_lexicon 独立抽取趟 `[PP3]`

> `paper_lexicon.json` 只在 `--content-profile paper` 下运行。它是论文术语索引,不是普通英语词典或中文讲义。

```text
1. tsx skills/build/paper-lexicon-status.ts <book> [--book-id <id>] --content-profile paper
   -> 查看 normalized clusters / budgeted batches / skipped windows / done / pending
2. 对每个 pending `lexicon-batch-<digest>`:
   a. tsx skills/build/paper-lexicon-input.ts <book> <work-unit-id> --content-profile paper
      -> 输出 candidate_clusters + visible_lids + requested_term_types + `[LID]` 代表上下文
   b. 交给 subagent paper-lexicon-extractor
      -> 只产 `{entries:[...]}`
   c. tsx skills/build/paper-lexicon-write.ts <book> <work-unit-id> out.json --content-profile paper
      -> 校验候选边界 / term_type / occurrence / definition 后原子写 `.build/paper-lexicon/<work-unit-id>.json`
3. 全部 candidate batch done -> tsx skills/build/paper-lexicon-batch.ts <book> --content-profile paper
   -> 合并去重,写 `paper_lexicon.json`
```

铁律:
- 每个条目必须有非空 `occurrences_lids`,且全是真实 LID。
- 同一 normalized term/acronym 的 occurrence 必须先聚成一个 cluster,再按 context cost 合批;不得恢复逐 Pass1 window 重复抽取。
- 无候选窗口只写 deterministic skip descriptor,不生成空 lexicon artifact;模型不得输出 candidate_clusters 外术语。
- `defined_at_lid` 只在论文明确给出定义时填写,且必须也出现在 `occurrences_lids` 中。
- 不收普通英语生词;不得预生成长中文解释或全文翻译。
- pending 默认拒绝收口;`--allow-partial` 只用于 smoke/救急。

## Pass2 长程边编排 `[PB3 + PB6]`

> Pass2 必须在 Pass1 `pass1-batch` 与 PB6 `profile-sidecar-batch` 都收口后运行。它从正式 `base.json`、`discourse_index.json`、`formula_semantics.json` 装配 work packet,不再从临时 candidate JSON 读取 discourse/formula。PP6 起 `--content-profile paper` 也可执行 Pass2,并使用扩展后的 paper edge contracts。

```text
1. tsx skills/build/pass2-status.ts <book> [--book-id <id>]
   -> 生成确定性 long_range 候选视图,按 source-window packet hash 检查 `.build/pass2/<id>.json`
   -> pending = 有候选且缺少/过期 LLM 分类的窗口; skipped = 无候选窗口
2. 对每个 pending window id:
   a. tsx skills/build/pass2-input.ts <book> <id> [--book-id <id>]
      -> 输出 Pass2WorkPacket(source text + source_nodes + PB6 discourse/formula 投影 + candidate_targets)
   b. 交给 subagent pass2-longrange-linker
      -> 只分类 candidate_targets 为 {accepted_edges,pending_edges,rejected_candidates}
   c. tsx skills/build/pass2-write.ts <book> <id> out.json [--book-id <id>]
      -> 用 packet hash 原子写 `.build/pass2/<id>.json`
3. 全 candidate windows done -> tsx skills/build/pass2-batch.ts <book> [--book-id <id>]
   -> 写 `long_range_candidates.json`;用 PB3 gate 替换 `base.json` 中的 long_range 边;写 `pass2_audit.json`
```

PP6 paper edge types:
`claim_supported_by_evidence`, `method_supports_result`,
`hypothesis_tested_by_experiment`, `related_work_contrasts`,
`related_work_builds_on`, `limitation_motivates_future_work`。

铁律:
- `pass2-longrange-linker` 只分类给定候选,不得新增候选、节点或 local 边。
- 每个 pending candidate window 必须交 `pass2-longrange-linker` 逐候选分类;不得用“全部 rejected”
  作为省 token 的默认策略。批量拒绝只允许在每条候选都真实读证据后自然发生。
- `pass2-batch` 默认拒绝 pending;`--allow-partial` 只用于 smoke/救急。
- `pass2-batch` 替换旧 long_range 边,保留 local 边;不要手工编辑 `base.json`。

## BookStructure 结构地图编排 `[PB7]`

> BookStructure 必须在 `profile-sidecar-batch` 与 `pass2-batch` 都收口后运行。它只从公共书基座与 profile artifacts 装配输入,不读取 reader_profile / memory / note / highlight / 当前用户问题。PP7 起 `--content-profile paper` 会在 unit/stitch packet 中携带 `PAPER_BOOK_STRUCTURE_RULES`,但输出仍是共享 `book_structure.json`。

```text
1. tsx skills/build/book-structure-status.ts <book> [--book-id <id>]
   -> 根据 `base.json` / `discourse_index.json` / `formula_semantics.json` / `pass2_audit.json`
      重算结构单元 unit jobs,按 content hash 检查 `.build/book-structure/units/<lid>.json`
2. 对每个 pending unit job:
   a. tsx skills/build/book-structure-input.ts <book> unit:<lid> [--book-id <id>]
      -> 输出 BookStructureUnitSource(public artifacts + LID excerpts)
   b. 交给 subagent book-structure-extractor
      -> 只产 `{unit_card}`
   c. tsx skills/build/book-structure-write.ts <book> unit:<lid> out.json [--book-id <id>]
      -> 用 unit input hash 原子写 `.build/book-structure/units/<lid>.json`
3. 全 unit done:
   a. tsx skills/build/book-structure-input.ts <book> stitch [--book-id <id>]
      -> 输出全书 unit_cards + long_range_edges stitching packet
   b. 交给 subagent book-structure-extractor
      -> 只产 `{spine, throughlines, key_stops}`
   c. tsx skills/build/book-structure-write.ts <book> stitch out.json [--book-id <id>]
      -> 原子写 `.build/book-structure/stitch.json`
4. stitch done -> tsx skills/build/book-structure-batch.ts <book> [--book-id <id>]
   -> gate LID/evidence/enum/reference shape,写 `book_structure.json`
```

铁律:
- BookStructure batch 不改 `base.json` / `source.txt` / `discourse_index.json` / `formula_semantics.json` / `pass2_audit.json`。
- unit card 与 stitch 都必须交 `book-structure-extractor` 做真实结构判断;不得用章节标题模板或自由导读文章代替。
- 每个 summary / reason / throughline 都必须有真 LID evidence;悬空 LID/reference 由 deterministic gate 丢弃。
- paper profile 不新增 `paper_structure.json`,不把 title/authors/venue/references 等 metadata 塞进 BookStructure;metadata 仍在 `paper_metadata.json`。
- pending 默认拒绝收口;读时 Rust loader / guided-reading projection 只能在 `book_structure.json` 能生成并过 gate 后再做。
