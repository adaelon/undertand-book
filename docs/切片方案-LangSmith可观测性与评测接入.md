# LangSmith 可观测性与评测接入：实施切片

状态：**LS0–LS6、LS8–LS9 已完成本地实现与当前主机验收；LS7 独立扩展待实施，真实 LangSmith 租户上传待显式联调**，2026-09-20。对应 [ADR-0134](adr/0134-optional-langsmith-observability-and-evaluation.md)。

新增路径、配置键和类型为实施合同；阅读依据与验证记录集中在 [审阅记录](审阅记录-LangSmith接入-2026-09-20.md)。

## 0. 目标与交付顺序

首个交付目标：**真实 `/agent/chat` 或流式 Resident 回合在 LangSmith 中出现一棵可信执行树；关闭或断网时阅读完全照常。**

```text
LS0 Resident 合同/基线
 ├── LS1 事实分流 ── LS2 生命周期 ── LS3 Rust 导出 ── MVP 故障验收
 │                       └── LS4 用量/证据/交付诊断
 ├── LS5 构建回执导出
 └── LS6a 旧结果映射/合同 ── LS6b 未来运行计时 ── LS6c 云端导入

LS3 + LS4 ── LS7 访客/后台任务扩展（非首版必需）
LS3 ── LS8 持久队列/部署硬化
LS3 + LS4 + LS5 + LS6 + LS8 ── LS9 集成发布验收
```

依赖解释：LS5、LS6a 可与 Rust 线并行；LS6a 先用现有输出完成身份、状态和时间映射，再冻结评测合同。LS6b、LS6c 分别验收提交；已有完整时间的合成 fixture 可用于 LS6c 开发，正式结果导入在 LS6b 验收后开放。实际 trace 关联依赖 LS2，完整用量/证据指标依赖 LS4。LS4a、LS4b 分别验收提交；LS7 独立发布。

| 发布阶段 | 应包含 | 可以向用户宣称 | 不得提前宣称 |
|---|---|---|---|
| 开发者 MVP | LS0–LS3 及其故障测试 | Resident 真实执行树、状态、基本耗时、默认无正文 | 全应用成本、精确用量拆分、崩溃不丢、教学效果 |
| 诊断与实验 | LS4–LS6 | 用量来源、证据流转、构建任务事实、满足时间合同的评测可比较 | 已观察外部 Harness 全部 LLM 调用、缺逐题时间的历史评测已导入 |
| 发布硬化 | LS8–LS9 | 有界恢复、明确完整性、两类宿主经过验收 | exactly-once、永不丢失、云端成为事实源 |
| 扩展覆盖 | LS7 | 已列明的访客/后台任务 | 未接入调用也被全量覆盖 |

每个切片都要提交代码、测试、golden/协议样例和对应文档更新。不得只提交一个导出函数，留下生命周期、隐私或失败行为待猜测。

## LS0：冻结 Resident 观测合同与行为基线

状态：**已完成**。Rust/TypeScript 共享 `ub_observation.v1` fixture、允许列表、未知用量与 Provider 请求等价测试已通过。

### 目的

在没有网络和用户数据外发的条件下，确定什么是同一次执行、允许上传什么、未知值如何表达，以及如何证明接入没有改业务。

### 具体工作

阅读并固定以下当前实现：`RunEventSink/RunEvents/ObservedAdapter`、`execute_observed`、`RunCoordinator`、`RunStream`、ADR-0127/0132、构建 metrics 与 execution identity。核对实施时的 live diff，不覆盖已有未提交修改。

新增建议 `crates/runtime/src/observation.rs` 和 `packages/observability/` 的最小测试骨架。冻结 `ub_observation.v1` 的 Resident 子集：身份、时间、状态轴、用量来源、完整性标记及 metadata 允许列表。跨语言共享对应 JSON fixtures；构建映射在 LS5 完成，评测合同在 LS6a 完成旧格式映射后冻结。

记录本地可复现基线：实际代码 revision、相关已跟踪文件的未提交 diff、相关未跟踪源文件副本、模型/工具/prompt 配置与固定测试材料版本。仅 HEAD 不足以还原脏工作树；这些源文件资料和私有路径保留本地。

以合成数据验证官方 REST run 创建/更新字段、项目与 thread 区别、usage 映射以及 TS SDK 类型。选定并锁住 SDK/UUID/HTTP 依赖版本。当前 `server` 没有直接依赖 `ureq`，使用时需在 `crates/server/Cargo.toml` 显式增加，而不是误用 runtime 的传递依赖（该文件第 8–20 行）。

### Resident 信封与外传合同

| 字段组 | 关键字段 | 规则 |
|---|---|---|
| 身份 | schema_version、local_run_ref、step_id、parent_step_id、revision | UUID 和映射由宿主生成 |
| 范围 | surface | resident；后续分别扩展 prebuild / visitor / background / evaluation |
| 时间 | observed_at、elapsed_ms、duration_ms、timing_source | UTC 时间与单调耗时使用同一锚点，未知值为空 |
| 状态 | execution_state、delivery_state、persistence_state | 独立状态轴，按 LS2 产生 |
| 诊断 | 已注册工具名、purpose、error_code、计数、用量来源 | 白名单字段；未知工具名归为 unknown_tool |
| 材料 | book_ref、source_revision_ref、接纳证据范围、source_ref | 不附正文、标题或预览；坐标经授权且列表有上限 |
| 完整性 | sampled、dropped_count、coverage、reconstructed | 丢失或未观察到不等于没有发生 |

模式为 off / metadata / eval_content。off 不创建发送线程、客户端或观测落盘；metadata 只允许上表字段；eval_content 仅由显式评测导出命令用于授权材料，不能开启真实会话全文捕获。

过滤发生在内存队列、spool 或 SDK 之前。不得整包序列化 TraceStep、SourceBinding、QueryAudit、历史 messages、工具参数/结果、ProfileFact、Provider 错误体、presentation HTML 或选区原文。result_digest 也按内容字段处理。错误只传规范码；内容摘要默认不外传。

对云端使用随机不透明关联 ID，不传用户名、绝对路径、标题或原始 profile 标识。首版映射在进程内；后续持久映射不可用时放弃跨重启关联，不阻止业务。

### 验收

同一业务 fixture 在观测关闭/内存测试 sink 开启时，比较 Provider 请求内容和次数、工具顺序、答案/source refs、Reader/Memory 效果与持久终态；忽略时间和新观测随机 ID。差异必须解释，不能通过更新全部 golden 消除。

所有元数据 fixtures 均通过白名单；未知 Token 为空，estimated 与 provider_reported 不混用。真实租户合成 trace 冒烟在 LS3 完成。

### 回滚与边界

本切片不开启生产观测。不能把接入协议改动顺便混入 Agent prompt、工具选择或预算修复。

## LS1：复用事件源，安装安全分流

状态：**已完成**。共同 `execute_observed` 入口只分流 `RuntimeEvent`；SSE 独占 answer/source/effect 完整对象，Resident 运行回归通过。

### 修改位置

| 文件 | 修改 |
|---|---|
| `crates/runtime/src/run_events.rs` | 保持 existing event 语义；必要时加默认空实现诊断回调及可测时钟入口 |
| `crates/server/src/agent_run.rs:143–171` | 在共同 `execute_observed` 入口组合流式 sink 和观测 sink；无 stream 也能观测 |
| `crates/server/src/agent_stream.rs:245–297` | 保持活动、答案 patch、source bindings、effect 的既有行为 |
| 新增 `crates/server/src/observability/policy.rs` | 只从类型化字段构造允许外传的结构 |
| 新增 `crates/server/src/observability/mapping.rs` | 将 step、parent、purpose 和状态映射为中立观测对象 |

建议组合器不是盲目广播所有参数的通用事件总线：`emit` 可以复制活动事实；`answer_patch/source_bindings/effect_created` 必须分别投影，只让原 UI 接收完整原对象。

在事件源与根 run 之间建立明确时钟锚点。不能直接把 `RunEvents.elapsed_ms` 加到一个不同时间创建的根起点上而不补偿偏移；持续时间保持单调时钟口径。

保留 `orchestrator.rs:5336–5354` 的 `run_events().is_none()` 防重复包装。不得在 Provider、ObservedAdapter、HTTP handler 三处各建一份 LLM span。

父子关系来自 parent_step_id：外层模型和随后执行的工具可为同级，book.query 内模型属于该工具；用采样序号表达因果，不伪造时间包含关系。当前 RunEvents::scope 共享 parent/purpose，新增并发时须显式传递局部父上下文并覆盖兄弟节点串线。被拒绝工具保留 started_ms=None、executed=false，不伪造执行耗时。

### 验收用例

| 用例 | 必须观察到 |
|---|---|
| 外层模型 → book.query → 内层模型 | 一棵父子树，内层模型归属该工具 |
| 普通 `/agent/chat` 无订阅者 | 与流式路径同样产生业务活动观测 |
| 参数/权限/来源校验拒绝 | rejected，executed=false，没有虚构执行时长 |
| 工具正常返回空集 | no_result，不自动算 Provider 失败 |
| 订阅者断开并重连 | 不重跑模型，不重复 Reader 效果 |
| 答案 patch 含隐私 canary | UI 行为不变，观测对象不含正文 |

增加 existing `run_events`、`agent_stream`、`agent_run_tests` 的回归。先用内存 collector，不联网。通过逐字节请求比对验证没有增加 LangSmith prompt、header 或工具参数。

### 回滚

禁用或移除观测分支后，仍使用原 `RunStream`。新增 trait 方法有默认实现，不要求一次改完所有 adapter/test double。

## LS2：根回合身份与诚实终态

状态：**已完成**。UUIDv7 根/step 身份、进程内 book/thread 不透明映射和三轴终态已接入，业务判定与观测共用最终 repair 规则。

### 修改位置

`crates/server/src/agent_run.rs::execute_observed`、`ExecutionReport`、`UnsavedRun` 处理与 `RunCoordinator::execute`；新增 `observability/lifecycle.rs`。

运行开始时固定 book/session/turn、随机根 run UUID、step→UUID 映射、策略版本与时间锚点。UUID 不使用模型提供的 ToolCall ID 替代；原业务 turn_id 不改。

LangSmith 项目使用顶层 session_name 或项目 UUID；顶层 session_id 是项目 ID。本地聊天关联写入 extra.metadata.thread_id 并传播到所有子 run。

执行完成后，先读取同一业务判定产生的 execution/delivery 状态；历史保存尝试结束后补 persistence 状态，再关闭观测根。LangSmith 的网络确认不参与此流程。

| 情况 | execution_state | delivery_state | persistence_state |
|---|---|---|---|
| 正常回答并保存 | completed | delivered | saved |
| 循环触顶、最终修复成功 | completed，另记 incomplete=true | delivered | saved |
| 最终来源修复失败 | 按现有执行结果 | failed | 按保存结果 |
| Provider 失败 | failed | not_delivered | saved / failed |
| 用户取消 | cancelled | not_delivered / partial | saved / failed |
| 答案形成但历史保存失败 | completed | 按来源交付判定 | failed |
| 重启发现 pending | interrupted | unknown / not_delivered | 按恢复保存结果 |

delivered 表示满足业务来源交付判定，不表示浏览器已接收或显示。LangSmith error 仅写规范码，取消可映射为 AGENT_RUN_CANCELLED；exporter 的 queued / sent / retrying / dropped / disabled 不写入业务 error。recover_pending 保留业务恢复权。

`execute_observed` 在共享状态闭包内进行历史提交（`agent_run.rs:220–286`）；只在其中提取小型类型化结果，**出锁后**投影和入队。观测失败不能改变 `ExecutionReport.reply`。

若交付判断仍内联在原代码，应提取一个被业务和观测共同调用的纯函数或返回类型，不能在 exporter 复制一套“有 diagnostics 就失败”的规则。禁止把原始 `trigger_value` 带到观测结构。

### 状态测试矩阵

| 场景 | 必须保持的区别 |
|---|---|
| 最后一轮修复成功，同时 incomplete=true | delivered，而不是 delivery_failed |
| 最终 repair 仍有 issues | delivery_failed，保留诊断计数 |
| Provider 失败 | failed；历史按现有规则保留当前用户问题 |
| 用户取消 | cancelled；已经保存的笔记/导航不回滚 |
| 历史提交失败 | persistence_failed / UnsavedRun，不宣称持久完成 |
| 两次不同会话但相同 step_id | 不串 trace，也不串 thread |
| 一个回合被再次观察/订阅 | 复用 ID，不创建新业务根 |

MVP 身份映射可以只存在当前进程；明确这种级别不保证崩溃后的云端 trace 修补。持久观测身份与 spool 在 LS8 完成，不能以新增业务写入失败来换取观测“可靠”。

### 回滚

保留业务状态枚举和原序列化兼容；观测侧字段使用内部结构或可选字段，不成为旧会话读取的必填项。

## LS3：Rust LangSmith 导出——第一个能用的纵向切片

状态：**已完成本地开发者 MVP**。宿主级有界内存队列、基础 REST worker、父创建依赖、重试/丢弃、退出预算、状态面及 mock HTTP 故障测试已通过；真实租户合成 trace 未执行。

### 新增与接线

新增 `observability/mod.rs`、`queue.rs`、`langsmith.rs`、`config.rs` 与 mock HTTP 测试。`crates/server/src/host.rs` 管理一份观测运行时，不每个模型调用创建一个客户端。

参考实际宿主启动和停止位置：`host.rs:1157–1178`、`RunningServer::shutdown:1093–1104`。同时检查自然退出 `wait` 路径，不能只测显式 shutdown。

建议首版设置：

```text
UB_OBSERVABILITY_MODE=off | metadata
LANGSMITH_API_KEY=<只由宿主读取>
LANGSMITH_ENDPOINT=<区域或自管端点>
LANGSMITH_PROJECT=<独立的开发/运行项目>
LANGSMITH_WORKSPACE_ID=<多工作区 key 时按需>
```

这些 UB 键为新增设计，当前仓库不能直接使用。仅检测到 `LANGSMITH_API_KEY` 或全局 `LANGSMITH_TRACING=true` **不得自动开启** Understand Book 外发。低层手动 API 必须由本项目自己的开关保护。

建议开发默认硬上限：队列最多 1,024 条且合计最多 4 MiB；单条最多 64 KiB；单 trace 最多 512 个 span。超限截断数组/拒收并计数，不无限扩容。它们是拟定参数，LS9 以真实活动数量和内存测试调整，不是实测性能结果。

发送流程：父 run 创建获确认后才发送子 run；同一 run 的 start/finish/enrichment 按 revision 排序或合并，保留原始观察时间。合并保留创建所需字段及已有终态，迟到 enrichment 不能将已结束状态改回 running。元数据模式 inputs/outputs 不含消息正文。

### 丢弃与依赖规则

每个 run 的创建状态为 pending / confirmed / abandoned。pending 的 PATCH 和子创建在同一有界队列中等待，受共同容量与重试预算约束。

- 创建未入队、被淘汰或最终发送失败：标 abandoned，丢弃其未发送更新和全部后代；后续同一 run 的事件也丢弃，不用新 UUID 复活。
- 创建请求超时且接受状态未知：先在有界预算内查证或按已核实的同 ID 重试语义处理；尚未确认时不放行子节点。预算耗尽按 abandoned 处理，即使云端可能留下孤立的未完成父记录。
- 已 confirmed 的父允许部分子树丢失；优先保留根终态/摘要，将丢弃计数及 coverage=partial 合并到该根的待发送更新。根未创建或更新也无法发送时，仅保留本地丢弃计数，不声称云端完整。
- 根创建被丢弃时停止该 trace 的后续外发；业务仍正常运行。每个 trace 的创建状态随有界队列和活动回合清理，不积累永久 tombstone。

根决定头部采样，子节点继承；受控评测可全量记录。未采样不补造子节点，也不承诺捕获所有失败。

基础协议使用 `POST /runs`、`PATCH /runs/{id}`。重传复用 UUID；对服务端接受结果不确定和冲突做明确处理。不能假设任何 POST 都是 exactly-once。批量 `/runs/multipart` 暂留适配器升级点，首版先验证语义正确。

### 故障行为

| 故障 | 行为 |
|---|---|
| 开启但缺少 key / 配置无效 | 观测状态报配置问题；Reader 仍可启动和回答 |
| 401/403 | 暂停发送并给出规范诊断，避免无限刷请求 |
| 429 | 尊重有效 Retry-After，受总重试预算约束 |
| 5xx / 超时 / DNS 不通 | 有界退避，不重跑模型或工具 |
| 队列满 / payload 超限 | dropped_count/coverage 标记；业务线程不等待网络 |
| 关闭观测 | 停止新入队/新发送，丢弃未发送内容；不宣称撤回在途请求 |
| 宿主退出 | 仅在剩余 flush 预算内发送；不得无限 join exporter |

端点为宿主配置的 HTTPS 来源；禁止跨源重定向携带凭据。日志只记录规范错误，不保存认证 header 或响应全文。网络 request timeout 必须受 shutdown 的剩余预算约束；不能一边规定两秒退出，一边做没有总超时的阻塞 HTTP。所有重试与队列异常只返回给观测状态面。

### 验收

在本地 mock HTTP 服务验证请求字段、认证 header、项目/thread 层级、拒绝未知字段、父子顺序、重复更新、429/401/断网。增加父创建入队失败、淘汰、超时未确认以及已创建父下子树丢失用例：未确认父不发送子节点，abandoned 不再发送 PATCH，缺口出现在已创建根或本地计数。单独使用合成数据做真实租户验证。

canary 分别放入用户问题、工具参数、source preview、选区、Provider 错误、presentation HTML 与额外 metadata；扫描真实序列化 payload、队列样本和日志，确认不出现 canary 或密钥。

满足 LS0–LS3 和以上测试后可交付开发者 MVP。README 必须明确：纯内存观测可能丢失，详细成本尚未完整接通。

## LS4：真实用量、证据进展与交付诊断

状态：**LS4a、LS4b 已完成本地实现与验收；未使用真实阅读内容或真实租户。**

LS4a、LS4b 各自提交、验收与回滚，不将 Provider 用量和证据 ledger 修改绑成同一提交。

### LS4a：用量和首字时间

修改 `crates/runtime/src/provider_stream.rs`、`run_events.rs`、相关 ModelObserver 适配和测试。检查 `lib.rs` 中所有使用方，保留旧 `AssistantTurn.usage_total_tokens` 和旧预算行为。

新增可选详细用量回调或事件；即便沿用旧 `Usage(u32)`，新旧通知也必须汇入同一个 snapshot，不能相加。SSE 与非 SSE 均保留 Provider 原始可获得的 input/output/cache 等字段；不从字符数补全真实用量。

`ObservedAdapter` 失败时也允许保留已收到的部分用量，标 partial，而不是统一抹为零。遇到缺少缓存细分、仅 total、重复累计帧、usage-only frame、流截断、内部重试均有测试。

不把模型完整调用耗时等同于某一次 HTTP 传输尝试耗时；若需要传输重试明细，需在真实重试位置额外观察。尚未覆盖的 attempt 记 unknown，不从日志猜。

用量来源保留 provider_reported / executor_reported / estimated / unavailable 和 complete/partial；允许 total-only。AgentRequestAudit 输入估计和 billed_tokens_charged 兜底不作为原生用量；真实 LLM span 记一次，父汇总写 ub.summary.*，任务级回执写 ub.build_usage.*。平台价目估算与实际账单分开。

首字事件只记录时间：model_first_text_ms 为模型首文本增量；answer_first_patch_ms 为通过来源安全投影的首答案补丁，表示服务端可发布时间。非流式或无法观察时为空。对 LangSmith 的标准 usage/TTFT 展示做协议级集成验证。模型标识注明 configured 或 provider_reported 来源，不能把路由别名当作已核实的底层模型。

### LS4b：证据与交付

在 `orchestrator.rs:6301–6319` ledger 接纳后记录证据差量；工具 activity 在 `6238–6253` 已结束，需提前保留 step_id，使用 enrichment 更新，而非再造一次工具调用。

记录已读/候选/最终 source_ref 三组数据，计数按既有 LID/证据语义去重。metadata 模式只允许绑定的坐标和不透明材料版本，列表有上限；不附带 label_snapshot/preview_snapshot。

请求审计只导出大小、计数和估计来源（`agent_request_audit.rs:28–44`），默认不导出 FNV 内容摘要。交付诊断只导出规范错误码、initial/repair 的计数和最终分类。

### 验收

关键 fixture：工具拿到候选但没有 `book.text`；正文被预算拒绝；重叠范围多次读取；历史 source_ref 与新来源；初稿错但修复成功；最终修复失败；只有部分 Provider 用量。

回归 `crates/runtime/src/experiment.rs` 中统一正文预算与 rejected read 不算证据的合同（第 31–108 行）。不能为 tracing 让 text/tree/graph 实验组看到额外原文。

### 回滚

不再发送 enrichment 仍能保留 LS3 基础运行树。详细 usage 为可选扩展；未知值不会让旧 adapter 无法运行。

## LS5：TypeScript 预构建回执的只读 LangSmith 导出

状态：**已完成本地实现与验收；使用官方 SDK 适配，未连接真实租户。**

### 新增建议

`packages/observability/src/prebuild-projector.ts`、`prebuild-export.ts`、`langsmith-client.ts`、`export-ledger.ts` 及单元测试。使用官方 `langsmith` SDK 发送 trace；运行入口属于开发/诊断工具，不属于每个 extractor 的正常提交路径。

### 实际复用

| 事实来源 | 读取用途 |
|---|---|
| `automatic-build-metrics.ts:33–88` | usage 来源、任务状态、真实/未知用量 |
| `automatic-build-metrics.ts:657–719,757–815` | 从实际持久文件形成生命周期事件 |
| `automatic-build-task-store.ts:159–187` | 语义尝试、租约 epoch、提交 revision 和 scope |
| `automatic-build-observation.ts:42–119` | 可选剩余工作/槽位观察，不回写调度预测 |
| `skills/build/build-executor-mcp.ts:41–62,82–92` | 后续可选服务端计时观察口，不代表外部 LLM 内部活动 |

导出粒度首先选择已明确指定的 target/stage/attempt 范围，拒绝无界常驻全目录轮询。读取函数可能按 stage 扫描历史，所以不把它塞进心跳或每个 token 回调。

新导出状态单独保存：源记录 identity/revision → LangSmith run ID/最后发送 revision。它不改任务 lease、receipt、candidate、input_hash、policy_generation、retry boundary 或 release gate。

历史 trace 标记 `projection_source=durable_receipts`。容器 envelope 时间可以 derived，但要标注；没有真实子模型请求就不建 LLM span。`executor_reported` 不等于 native，legacy_inferred 不升级为 native。

保留 target/source version、stage、work_unit、attempt_scope、semantic_attempt、lease_epoch、submit_revision、physical_attempt 与 identity_source。语义重试、重新租约和提交修订分别映射；同一 observation 重传复用 ID，新的真实执行使用新 span。预构建与 Reader 回合通过材料版本关联，不挂在跨天根执行树下。

### 验收

准备一个含并行 work units、同 scope 重新租约、候选多次 submit、真正 semantic retry、policy generation 改变及部分未知用量的 fixture。核对这些维度没有混成一个 attempt。

重复导出相同 fixture 不新建业务运行、不重复增加用量；更新一个 submit revision 只改变对应观测。故障或 SDK 抛错不能改原任务存储；直接比较导出前后 fixture 的文件列表与文件内容，确认源目录不变。

测试旧版本缺 start/finish、只有结果、记录损坏、lease_expired；时长未知或不一致时标缺失，不以导出时刻充当原执行时刻。

### 分发边界

首版不改 `plugins/understand-book`、`skills/build/automatic-build-driver.ts` 或 extractor prompt。尤其不能把 trace context 混入 driver 的 opaque 协议字段（driver 第 84–122 行）。实时 timing hook 要另外测试 MCP stdout 仍只有合法协议数据。

## LS6：连接现有 Agent / quality 评测结果

状态：**LS6a、LS6b、LS6c 已完成本地合同、计时与合成 HTTP 验收；历史缺逐题绝对时间的报告保持本地且不能导入，真实租户未写入。**

### LS6a：旧结果映射与合同冻结

状态：**已完成；`ub_eval_export.v1`、实际历史报告适配与脱敏 fixture 已冻结。**

输入为已有 runner 源码、脱敏的真实输出样例及对应测试。新增建议 `packages/observability/src/eval-export-contract.ts`、`eval-adapt.ts` 和映射 fixtures；本切片只适配本地结果，不连接云端。

已核实的输入结构及映射约束如下；实施时以当前版本和实际样例固定逐字段映射，完成后才冻结 `ub_eval_export.v1`。

| 现有来源 | 已有事实 | 导出约束 |
|---|---|---|
| agent-run.mjs 的 report 与 qa/navigation/restart | 整场 started_at/finished_at；逐题 id、system、elapsed_ms；不同任务结果结构不同 | 按任务类型分别适配；题目与被测系统共同识别样本；逐题缺绝对时间如实保留 |
| agent-run.mjs 的 ablation | 同题 text/tree/graph，实验配置含 arms | 每个 system/variant 拆成独立实验，共享比较组和数据集版本 |
| provider-recorder.mjs | 模型请求 started_at、elapsed_ms 与 usage | 模型请求时间不代替产品样本起止时间；部分 usage 保持缺失 |
| quality-core.mjs 的 bundle.audit / judgeJobs | task_id、sample_id、system、execution；job_id 和 A/B→sample 映射 | 产品重复次数与 Judge 交换顺序分开；引用实际产品样本 |
| quality-core.mjs 的 qualityReport | quality_status、order_disagreement、comparison、systems、dimension_summary | 保留配对结果、完整分母及已有分类，禁止平均掉顺序分歧 |
| quality-run.mjs 的 report 与 evaluation-mode | report.status、calibration；Judge 独立时间和用量 | 校准状态与 Judge 版本分开保留；Judge 时间和成本不填到产品运行 |

现有 quality 四维为 accuracy / completeness / grounding / explanation；verdict 为 met / partial / failed / unknown / not_applicable，汇总另有 unscorable；产品未交付可为 product_failed。execution 沿用该评测已有 error / incomplete / delivered / empty 分类，不能在 importer 中改成新的业务口径。探索性与已校准状态原样保留。

建议中立输入结构如下。一个包表示一个 system/variant 的实验，同次比较的包共享 comparison_group_id；字段是新合同，不是旧输出原有字段：

```ts
type EvalTiming =
  | { source: "recorded"; started_at: string; finished_at: string; elapsed_ms?: number }
  | { source: "elapsed_only"; elapsed_ms: number }
  | { source: "unavailable" };

interface UbEvalExportV1 {
  schema_version: "ub_eval_export.v1";
  comparison_group_id: string;
  external_experiment_id: string;
  external_dataset_id: string;
  dataset_revision: string;
  source_revision_ref: string;
  system: string;
  execution_config_ref: string;
  timing: EvalTiming;
  evaluation_status?: string;
  calibration_ref?: string;
  summary: Record<string, number | string | null>;
  comparisons: Array<{
    case_id: string;
    repetition: number;
    sample_ids: string[];
    outcome: string;
  }>;
  rows: Array<{
    sample_id: string;
    case_id: string;
    repetition: number;
    execution_trace_id?: string;
    timing: EvalTiming;
    execution_status: string;
    quality_status?: string;
    order_disagreement?: boolean;
    permitted_inputs: Record<string, unknown>;
    permitted_expected_outputs?: Record<string, unknown>;
    permitted_actual_outputs?: Record<string, unknown>;
    scores: Array<{
      key: string;
      source: "deterministic" | "llm_judge" | "human";
      evaluator_version: string;
      judgment_id?: string;
      candidate_order?: string[];
      status: "measured" | "not_applicable" | "unavailable";
      score?: number;
      value?: string;
    }>;
  }>;
}
```

合同规则：

- repetition 仅表示产品的独立重复运行。sample_id 由本地原始运行、system、case_id、repetition 映射为稳定不透明 ID；quality 的匿名 sample_id 通过 audit 关联，不将随机 A/B 顺序视作产品身份。
- 原始逐次 Judge 判定用 judgment_id 和 candidate_order 区分。聚合判定沿用 qualityReport；配对结果保留 winner 对应样本 ID，或原有 tie / unresolved / not_paired 等值。缺 Judge 结果不是产品失败。
- evaluation_status 保留原 report.status，calibration_ref 关联允许外传的校准版本/状态记录，不含审核人身份或材料正文。无校准记录不能推断已校准。
- summary 按实际报告注册键名，保留总样本、交付、product_failed、unscorable 及配对子集分母；comparisons 属于整个比较组，在各系统实验中标明 group scope，不作为多个独立结果相加。
- scores.status 表示测量可用性；原始分类放 value，unknown / unscorable 不转换为数值零。同一 key 的逐次判断不得互相覆盖，适配到平台反馈时保留独立身份。
- Record 字段在 LS6a 中按来源定义专用允许列表和规模上限；summary、状态字符串及评测内容均不能作为任意 JSON 外传入口。

验收：用不同系统同题、消融 arms、交换顺序分歧、未校准、未交付和 Judge 缺失的 fixtures，逐字段比较适配前后身份、分类、分母与分数；不运行模型。缺时间的旧样例能生成 elapsed_only/unavailable 的本地包。实际输出样例的脱敏内容与授权在本地处理，不因成为 fixture 自动取得外传许可。

### LS6b：为未来产品样本记录时间

状态：**已完成；未来 chunk、Agent、navigation/restart 样本记录真实 UTC 边界，旧报告只读。**

修改 `evals/semantic/agent-run.mjs` 的 chunk、Agent、navigation/restart 等产品样本执行边界和相关测试，补真实 UTC started_at/finished_at，保留原单调时钟 elapsed_ms。起止覆盖原有产品耗时的同一边界；评分、宿主准备等原本不计入的工作不混入产品延迟。失败样本在 finally 中完成计时；尚未开始执行或硬中断未取得完整时间时仍标缺失。

整场实验时间覆盖各产品行，quality 复评关联产品原始时间，Judge 时间单独保留。旧 run.json 和报告只读；新增字段不修改提示词、预算、评分、结果顺序或旧分类。

验收：用确定性时钟和已有 runner 测试验证正常、产品失败、Judge 失败及缺时间分支；确认产品起止不包含 Judge 调用，UTC 区间与原耗时边界相符，旧结果仍可适配。无需以真实付费模型调用验证时间字段。

### LS6c：授权检查与云端导入

状态：**已完成本地合成验收；显式 consent、整组时间门、持久 row/experiment 映射和 uncertain 处理已实现，未使用真实凭据。**

新增建议 `eval-import.ts`、`eval-consent.ts`、`eval-feedback.ts` 和合成 HTTP fixtures。使用官方外部实验导入能力；SDK 无对应已核实调用时，在 Node importer 内封装 `/datasets/upload-experiment`。导入不执行被测模型，不再次调用 Judge。

**时间门**：该接口要求实验和每行的绝对起止时间。发送前检查整组待比较实验，所有产品样本都必须为 recorded，区间有效且位于实验区间内。任一缺失则整组返回 `unsupported_missing_timing` 和缺失样本 ID，零网络发送，不删掉失败或缺时行以换取导入成功。旧 elapsed_ms、首个模型请求时间、Judge 时间和导入时间均不能补造产品起止时间。

**身份与比较**：同一比较组的 system/variant 拆为独立实验。相同数据集版本的 case_id/repetition 映射为跨实验一致的外部 row UUID；产品 sample_id 则区分不同系统的真实输出。映射由导出侧持久保存；源材料变更进入新 dataset revision。dataset_id/name 按外部数据集接口语义使用，不传普通现有 LangSmith dataset UUID。

**结果映射**：实验元数据保存 comparison_group_id、system、配置、evaluation_status、校准引用及允许列表内的分母和配对摘要；行元数据保存 sample_id、产品状态、quality_status、order_disagreement 和执行 trace 关联。既有数值或分类反馈分别写 score/value；逐次 Judge 反馈采用稳定的区分键并保留其顺序映射，聚合指标使用独立键，不能覆盖或平均逐次冲突结果。

**重入与失败**：重复命令复用已保存的外部实验/row 映射；导入超时先查证或报告 uncertain，不盲目重试 POST。比较组多实验上传不是事务：网络失败导致部分已接受时，报告每个实验的接受状态和整组 incomplete，不发布为完整比较，也不重新上传已确认的实验。

已有 Resident trace 用 `ub.execution_trace_id` 关联；不假定自动 merge。实验行不重复上报 LLM Token，Judge 的实际用量属于 evaluation。参考答案仅给 evaluator；eval_content 只选入授权问答/证据，metadata 不能触发云端全文评估。

验收：

- 完整时间的合成比较组导入后，行数、系统、重复次数、分数、缺失项、校准状态、配对关系、分母和时间与本地包一致。
- 任一行缺时间时整组不发请求；不把 product_failed、unscorable 或 unknown 变成成功或零分。
- 相同题目不同系统在比较视图正确对齐，多次重复不合并；顺序分歧保留 unresolved/unscorable，未经校准的结果仍标探索性。
- 重复导入、超时、部分实验上传成功均不静默制造重复，不调用 Provider，不覆盖历史结果。未授权内容与无效时间区间被拒绝。

### 后续指标与执行扩展

LS6 只桥接现有指标。LS4 提供的工具计数、证据及来源交付诊断按独立版本加入；学习效果仅在有真实解释、迁移或复测数据时上报，否则 unavailable。不能从满意度或模拟学习者分数更新 mastery。

未来 SDK 驱动测试调用同一生产核心；单个 Reader 宿主 maxConcurrency 为 1，并行须隔离宿主/状态。不得自动对正在使用的个人 Reader 执行有写入效果的 benchmark。

## LS7：补足访客 MCP 与独立后台任务（独立扩展）

此切片在 Resident 版本稳定后进行。实施前跟完对应模型调用及错误路径，确定哪些经过 ObservedAdapter、哪些需要独立接线。

已定位的边界：`crates/server/src/mcp.rs` 的 VisitorSession 和 query/synthesize 依赖；`host.rs` 的 `route_selection_translation_request`、`route_paper_localization_request`、ReviewCoordinator 的 `run_one_at/run_one_backfill_at`；独立 `book_mcp` 二进制的实际启动链需补读。

每个独立任务建立自己的 root，surface 明确区分 visitor/background。只有运行时确实由当前 Resident 工具触发、且生命周期包含时才挂为子节点。不要把后台复核的个人资料全文传入观测。

外部 MCP 客户端没有合法父 trace 上下文时就创建独立服务端工具 trace。首版不接受模型参数指定的 parent ID/endpoint/key；跨进程传播以后通过可信传输元数据和单独协议合同实现。

验收包括：同名访客 session 不串 Resident thread、外部客户端断开不伪造取消、后台任务与前台同时发生不串父节点、真实模型调用只记一次。看板只在新增面验收通过后扩大“覆盖范围”声明。

## LS8：持久投影、配置撤销与两类宿主部署硬化

状态：**已完成本地实现与 Windows 宿主验收；Linux 实机启动受当前主机能力限制，保留为已知限制。**

### 持久观测队列

在 LS3 之上增加可选 spool。worker 将**已过滤的**身份/观测记录保存后才向云端发送，业务线程不等待 fsync。限制容量、保留时间和文件数；建议初始上限 64 MiB / 24 小时，实施时通过故障测试确认并允许配置。

文件原子替换，启动时解析记录并检查 schema 与目标 project/endpoint 的配置 epoch；损坏文件隔离，不能阻止 Reader 启动。不要使用书籍目录、构建 lease 目录或 Memory 真相源作为 spool。

重启时只依据已持久化观测与现有 `recover_pending`/最终历史状态进行观测修补；没有真实结束时间时标记 last_observed/unknown 及 interruption_detected_at。不得发起原工具、恢复原推理或把启动时刻当作精确失败时刻。

### 配置与撤销

关闭模式清空未发内容、停止新请求。改变目标项目/区域/工作区时不把旧队列自动发到新目标；需显式确认重投或丢弃。API key 永不在状态接口、日志、导出包或安装资源中出现。

确需 UI 时仅新增安全状态投影：enabled、mode、项目显示名、队列/丢弃计数、最后规范错误与覆盖范围。不向浏览器返回 client 配置原对象；不让前端调用 LangSmith 发送用户内容。

### 宿主测试

Windows Tauri：新增功能关闭时，不增加 Node/插件/网络启动前置条件；退出不无限等待。

Linux Reader：通过既有宿主入口运行；凭据为宿主环境/私有配置，不能由普通网页提交。翻页、选区、SSE 和停止不被 exporter HTTP 阻塞。

读取 apps/desktop 与 scripts/linux 的实际打包、启动接线并构建验证；对安装包、前端 bundle、插件资源进行 canary key 扫描。

## LS9：系统验收与逐步开放

状态：**已完成受影响路径、Windows Tauri、Web 构建与发布隐私验收；全仓 Core 回归存在与本切片无因果的既有工作树红项，见回归报告。**

### 必过验收矩阵

| 编号 | 场景 | 合格标准 |
|---|---|---|
| A1 | off + 配置中存在 key | 无 LangSmith 网络和观测落盘；已有 SSE 不变 |
| A2 | 同一 scripted Agent，开/关观测 | 请求内容/次数、工具、答案、来源、业务状态等价 |
| A3 | 成功、空结果、拒绝、失败、取消 | 分类正确，不把拒绝算成真实执行 |
| A4 | incomplete + repair 成功/失败 | 延续 ADR-0132，无终态回归 |
| A5 | 历史保存失败 | UnsavedRun 如实呈现，根状态不冒充 saved |
| A6 | 断网、429、401、慢响应、队列满、父创建丢失 | 阅读与停止仍可用；依赖丢弃正确，根或本地计数显示缺口 |
| A7 | SSE 重连/无订阅者 | 不重复执行；执行树身份稳定 |
| A8 | 进程被终止并重启 | 仅恢复观测/本地终态，不自动重放业务 |
| A9 | 隐私 canary、嵌套字段、错误文本、key | payload/spool/log/bundle 均无泄漏 |
| A10 | partial/total-only/重复 usage 帧 | 不补零、不相加累计值、不重复收费 |
| A11 | 构建 lease/semantic/submit 修订 | 身份准确，重复导出源目录不变 |
| A12 | 评测导入、缺时间、配对冲突、未校准、重复导入、超时 | 不调用模型；缺时间整组不发送；系统、分母、校准与判分状态无损；不静默造重复实验 |
| A13 | 切换项目、关闭、密钥失效 | 不向错误目的地重放旧队列 |
| A14 | Windows / Linux / installed plugin | 默认关闭可正常使用；声明与实际覆盖一致 |

### 执行命令

以下命令按受影响切片运行，LS9 完成系统回归。过滤测试需确认输出的测试数非零，不能把“没有匹配测试”当作通过。

```sh
cargo test -p runtime run_events
cargo test -p runtime provider_stream
cargo test -p runtime experiment
cargo test -p server agent_run
cargo test -p server agent_stream
cargo test -p runtime
cargo test -p server
pnpm --filter @understand-book/core test
pnpm --filter @understand-book/core typecheck
pnpm test
pnpm build
```

新增包的 `pnpm --filter @understand-book/observability test/typecheck` 需在 LS0 创建相应脚本后才能运行。LS6 各子切片按修改路径运行已有 `pnpm eval:semantic:test` 与 `pnpm eval:quality:test`。

真实 Agent/quality 评测可能调用付费模型，必须用隔离测试材料、明确授权和固定实验配置；不是纯单元测试之后的默认无条件步骤。真实 LangSmith 冒烟只传合成数据，记录 SDK/API 版本及服务端结果。

### 回归报告

报告至少包含源代码 manifest、测试结果、实际覆盖 surface、丢弃/重试统计、业务等价差异、隐私扫描和模型用量对账。性能报告将本地投影/入队开销与模型网络耗时分开，采用固定环境重复测量。

### 回滚

第一层：宿主设置 `UB_OBSERVABILITY_MODE=off`，停止外发并按策略清理未发送数据。

第二层：回滚 `server/observability` 接线与独立 TS 导出包；保留原 `RunStream`、业务状态、历史、LID、构建回执和本地评测。新增可选字段的旧数据仍应能读取。

第三层：云端已上传数据由单独受权限约束的管理操作清理；本地回滚不自动保证删除第三方副本。

## 已知限制

未配置 `UB_OBSERVABILITY_SPOOL_DIR` 时仍使用纯内存队列，进程崩溃可能丢失观测；父创建接受状态未知时，云端可能留下未完成记录。缺口只在有可发送根记录时同步到云端，否则以本地统计为准。持久 spool 提供有界尽力恢复，不承诺 exactly-once。

历史 Agent / quality 结果若缺逐题产品绝对时间，保留本地，不支持 LS6c 导入。LS6b 只改善未来运行记录，不能追补旧时间。Harness 内部调用与未接入的 Visitor/后台任务不计入全应用覆盖；云端数据保留与删除独立管理。

本轮 Windows 主机未安装 Bash、WSL 或 Linux Rust target，Linux Reader 的共享 Server 行为、环境文件和启动脚本合同已核对，但 systemd/真实 Linux 进程退出仍需在 Linux 宿主验收。真实 LangSmith 租户合成上传未执行。

## 交给实施 Agent 的总约束

先读取当前工作树，保留已有修改。按一个切片一个可验收提交推进，未过隐私/等价门不进入真实数据外发。不得改变 Agent prompt、十二轮预算、来源安全规则、Reader/Memory 所有权、构建恢复判断或原评测分数来“修好观测”。

遇到旧 schema 无法映射、不可见 Harness 内部用量或不完整记录，按对应切片报告缺失；评测缺时间按 LS6 的整组不发送规则处理。不补造字段、调用、分数与时长。LangSmith 配置错误不是业务错误；LangSmith 好看的 trace 不是系统正确性的证明。
