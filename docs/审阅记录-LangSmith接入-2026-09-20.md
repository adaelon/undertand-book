# LangSmith 接入审阅记录与证据边界

日期：2026-09-20。任务：为 Understand Book 制定基于当前代码的 LangSmith ADR 和实施切片。

第 1–5 节保留最初通过只读连接器形成的审阅记录；同日工作区复审与文档修订见第 6 节。旧记录中的访问限制不表示后续仍未读取相应源码。

## 1. 访问了什么，没有访问什么

本次实际使用用户连接的 `Understand_Book_代码只读` 工具，先调用 `project_overview`，再使用 `list_files`、字面量 `search_code`、`read_file` 和 `working_changes`。

工具提供的是获准 **live working tree**，包含允许访问的未提交修改与未跟踪文件。工具报告的 HEAD：

```text
c12cbb94fdddc289181f2f11b091fc1d0f58c53e
```

HEAD 不是本次返回内容的完整快照。多处 runtime/server 文件已修改，ADR-0132/0133 等文档在可见工作区中存在。已读取变更清单，但没有逐条读取全部 diff，也没有生成全仓库内容哈希快照。

### 目录范围

| 开放目录 | overview 报告文件数 | 本次目录盘点 |
|---|---:|---|
| packages | 644 | 分页列完，覆盖 core、web 与生成类型的文件名 |
| crates | 91 | 列完文件名 |
| apps | 41 | 列完文件名 |
| agents | 19 | 列完文件名 |
| skills | 63 | 列完文件名 |
| plugins | 8 | 列完文件名 |
| scripts | 12 | 列完文件名 |
| docs | 249 | 取得总范围；分页列完 ADR 子目录，未逐一列读其他全部文档 |
| 合计 | 1,127 | 不含额外获准根文件；目录清单不等于正文阅读 |

**本次没有逐行通读全部 1,127 个文件。**完成的是开放目录盘点与 LangSmith 接入相关执行链路的定向逐段阅读，阅读范围见下表。把它称为“全仓库逐行审计”是不准确的。

没有读取或绕过私密目录、密钥、用户书籍正文、运行数据和连接器未授权路径。`evals/` 不在开放根范围；根 `package.json` 虽证明评测命令存在，但不提供其脚本正文。

## 2. 实际正文阅读范围

行号为本次工具返回的仓库行号；合并后若代码变化，实施者应重新定位符号。

| 文件 | 已阅读范围 | 用途及限制 |
|---|---|---|
| `README.md` | 1–112，全文 | 技术分层、实际入口、已有评测与限制 |
| `CONTEXT.md` | 1–159；160 仅部分 | 术语与所有权背景；不是全文，也不以旧术语替代现行实现 |
| `docs/代码链路.md` | 1–170；171 仅部分 | 链路导航与历史背景；全文超过八千行，未全文读完 |
| `package.json` | 1–25，全文 | 工作区测试和 eval:agent/eval:quality 命令 |
| `packages/core/package.json` | 1–28，全文 | core 测试/typecheck 及依赖面 |
| `crates/runtime/Cargo.toml` | 1–20，全文 | 同步 ureq 技术栈与依赖方向 |
| `crates/server/Cargo.toml` | 1–25，全文 | server 目前未直接依赖 ureq，不可误用传递依赖 |
| `crates/runtime/src/run_events.rs` | 1–400 | 运行事实、sink、scope、ObservedAdapter；401–431 测试尾段未读 |
| `crates/runtime/src/provider_stream.rs` | 1–180 | 流式与非流式解析、只保留 total 用量；后续未全文读完 |
| `crates/runtime/src/agent_request_audit.rs` | 1–200 | 请求审计、大小/估计/用量来源、FNV 摘要；其余测试未读 |
| `crates/runtime/src/lib.rs` | 245–398 | ToolCall、AssistantTurn、ModelAdapter 及观察接口；不是五千多行全文 |
| `crates/runtime/src/orchestrator.rs` | 69–178；550–585；5310–5360；5970–6060；6220–6290；6290–6375 | 配置与结果、敏感 TraceStep、防重复包装、执行授权、活动终态、证据账本接纳 |
| `crates/runtime/src/experiment.rs` | 1–155，全文 | text/tree/graph 工具能力及统一正文预算、相应测试源码 |
| `crates/server/src/agent_run.rs` | 1–400；401–600；595–621，合并为全文 | 共同执行入口、持久化、UnsavedRun、协调器、取消、重启 pending 恢复 |
| `crates/server/src/agent_stream.rs` | 210–328 | SSE 快照、四类 sink 行为、断线不取消执行 |
| `crates/server/src/host.rs` | 1035–1208 | 宿主 Provider 配置、独立任务入口、wait/shutdown/start 边界；其他函数仅部分字面量搜索 |
| `crates/server/src/mcp.rs` | 1–140 | VisitorSession 与 read/query/synthesize 的边界；未读取完整 dispatch 与测试 |
| `packages/core/src/automatic-build-observation.ts` | 1–142，全文 | 剩余工作与 executor 槽位的确定性观察 |
| `packages/core/src/automatic-build-metrics.ts` | 1–180；640–815 | 回执、用量来源、生命周期及持久事实读取；其余函数未全文读完 |
| `packages/core/src/automatic-build-task-store.ts` | 1–150；159–213 | attempt scope、semantic/lease/submit 身份；其余存储逻辑未全文读完 |
| `skills/build/automatic-build-driver.ts` | 1–160 | 依赖、opaque 控制合同、禁止字段、阶段与用户决策原因 |
| `skills/build/build-executor-mcp.ts` | 1–180 | MCP 调用/阶段计时和 timing_sample_sink；未读取完整协议循环 |
| `docs/adr/0127-resident-agent-streaming-and-runtime-activity.md` | 1–80，全文 | 已接受的执行、SSE、持久化与停止合同 |
| `docs/adr/0132-agent-loop-budget-and-delivery-outcome-separation.md` | 1–29，全文 | incomplete 与最终修复失败不能混淆 |
| `docs/adr/0118-learning-memory-owned-replayable-tutor-session.md` | 1–14，全文 | 明确“Design decision; implementation pending”，不能当成已实现学习状态模块 |

补充搜索覆盖了 `orchestrator` 中的事件调用、ModelAdapter、宿主生命周期函数、metrics 导出函数和 execution identity。`crates/server/src/host_lifecycle.rs` 本次仅读取函数搜索结果，未全文阅读。

全范围字面量 `langsmith` 搜索没有命中，工具报告跳过 1 个文件。准确表述是：**获准、可搜索文本未发现该字面量**，不是对所有依赖、隐藏配置或运行环境的绝对不存在证明。

## 3. 关键判断与代码证据

### E1：优先接 RunEvents，不包装假想 TS Reader Agent

证据：`README.md:19–21,49`；`run_events.rs:1–46,225–315`。

推导：复用 Rust 的真实运行事实，在宿主层增加派生导出；TS 侧处理预构建与离线工具。该推导是设计选择，不是仓库已有 LangSmith 架构。

### E2：不能整包上传现有 trace / outcome

证据：`orchestrator.rs:140–147` 的 SourceBinding 含 preview；`552–565` 的 TraceStep 含 args；`91–115` 将内部诊断从普通 outcome 序列化中排除。

推导：外发必须做新的允许列表；不能一边沿用内部隐私边界，一边直接把 HTTP、SSE 或对象序列化给第三方。

### E3：当前调用失败、交付失败和保存失败是不同事实

证据：`agent_run.rs:244–268`；ADR-0132 第 14–21 行；`agent_run.rs:595–621`。

推导：至少保留 execution/delivery/persistence 三轴；telemetry delivery 属于 exporter 自身，不能污染业务终态。

### E4：现有 Token 数据不足以保证完整费用统计

证据：`provider_stream.rs:53–54,109–110`；`lib.rs:281–287`；`agent_request_audit.rs:159–184`；`automatic-build-metrics.ts:33–47`。

推导：详细用量需单独切片；估计、Provider 实测、executor_reported 和 unavailable 必须分开。外部 Harness 内部调用不可见时不造 LLM span。

### E5：工具返回结果不等于账本已经接纳证据

证据：`orchestrator.rs:6238–6253` 已结束 activity；`6290–6319` 后续还进行模型正文预算处理和证据账本观察。

推导：证据进展需要在 ledger 接纳之后补充；之前保存 step_id，随后 enrichment，不再重复执行或创建假的第二次工具调用。

### E6：预构建已有可读事实，但不是实时总线

证据：`automatic-build-metrics.ts:657–719,757–815`；`automatic-build-task-store.ts:159–187`。

推导：先只读导出 task/attempt/receipt；保留真实身份与时间来源，不把租约/提交修订合并成一次语义重试，也不把历史投影当成实时抓到的内部调用。

### E7：评测可接，但旧格式与学习效果不能猜

证据：`package.json:12–16`；`README.md:97–104`；ADR-0118 第 3 行。

推导：桥接已有评测，不重新跑题，不把漂亮回答当作用户理解；`evals/` 源码和真实输出的适配门必须保留。

## 4. 官方资料核查

核查日期为 2026-09-20，来源均为 LangChain/LangSmith 官方文档。

| 文档 | 核实的接口边界 |
|---|---|
| Trace with API | 可直接 REST tracing；基础 POST/PATCH 与 multipart；项目字段；调用方须考虑异步发送/性能 |
| Trace without environment variables | 可程序化配置；不能把环境变量开关当成所有手动 API 的自动安全边界 |
| OpenTelemetry integration | OTel 是可用替代方案，本方案暂缓是部署取舍而非不支持 |
| Configure threads | thread 元数据关联；子 run 也要传播 |
| Log LLM calls | LLM 类型、模型/Provider、usage 与首 token 事件映射 |
| Prevent logging of sensitive data | 输入输出和 metadata 的屏蔽是需要分别处理的维度 |
| Upload existing experiments | 外部已完成实验可导入；外部 dataset 标识有专门语义 |
| Evaluate agents | target / dataset / evaluators；JS 的并发设置要与宿主执行能力匹配 |

准确资料地址见 ADR 的 W1–W8。没有查询或填写任何真实 LangSmith 账号设置，没有验证订阅、区域可用性、价格、配额或真实账单，也没有声称这些已经完成。

## 5. 未完成验证与实施前置门

**旧评测适配**：未读 evals/semantic 的 runner、report、provider recorder 和实际结果文件。LS6 的中立格式可以先实施，精确旧格式 adapter 必须在补读后落地。

**其他宿主调用**：尚未逐段跟完 Visitor MCP、selection translation、画像 review/backfill、presentation author 的全部调用与错误路径。LS7 不得声称这些调用已被 Resident tracing 自动覆盖。

**部署**：apps/desktop 与 scripts/linux 已列文件，但全部安装/启动/打包源码未通读。LS8 必须补读并实际构建测试，不能只凭目录名声称安全。

**实时构建**：构建 metrics 和 MCP timing 合同已定位，但全 driver/session/lease/writer 链路未通读。选择首版只读导出正是为避免在未验证控制链中插入副作用。

**编译与运行**：连接器为只读代码工具。本次未在仓库执行 cargo、pnpm、Node 或模型调用；没有通过/失败测试数据和性能测量。文档中的命令、验收矩阵和配置参数均为待执行计划。

**本次实际产物**：生成了 ADR、切片方案和这份审阅记录，随后对交付目录、链接和打包文件做静态检查；没有修改用户仓库。

## 6. 同日工作区复审与文档修订

用户要求复审 ADR-0134 与切片方案，并确认按复审意见调整。通过本地工作区读取两份文档、run_events.rs、agent_run.rs、ADR-0132，以及 evals/semantic 的 agent-run.mjs、provider-recorder.mjs、quality-core.mjs、quality-run.mjs 和 QUALITY_EVAL.md 相关实现。重新核对官方 REST tracing 与外部实验导入文档。未读取完整历史运行产物，也未完成旧格式 adapter 的逐字段联调。

补充事实：agent-run 的整场报告有绝对时间，产品样本主要保存 elapsed_ms；模型请求和 Judge 的时间不能还原产品样本区间。qualityReport 保留双系统样本、交换顺序的逐次判断、order_disagreement、product_failed/unscorable、配对比较及完整分母；quality-run 另保留 report.status 与 calibration。

修订结果：ADR 收敛为长期决策；字段、接线和验收归入切片方案。LS0 仅冻结 Resident 合同；LS6a 完成旧格式映射，LS6b 为未来运行补时间，LS6c 执行授权与云端导入。缺产品逐题绝对时间时，整组返回 unsupported_missing_timing，保留本地结果且零发送。系统拆实验，产品重复与 Judge 顺序分开，校准状态和配对分母保留。

Rust 队列明确父创建确认后的发送依赖，以及 abandoned 后丢弃更新和后代的规则。基线采用相关 diff/必要文件副本；只读导出用 fixture 文件列表与内容直接比较；spool 保留原子写入、解析与目标检查。

本次修改仅限 ADR、切片方案和本审阅记录。仓库功能测试、真实模型运行、LangSmith 租户上传和两类宿主部署验收均未执行，仍由实施切片完成。

文档检查通过：三份文档的本地 Markdown 链接目标存在、代码围栏闭合；两份设计文档已移除旧的指纹/校验和要求及过期访问限制，新增时间门、评测身份与父子丢弃合同均存在。

## 7. LS0–LS3 实施与本地验收

在 `c12cbb9` 及同日既有脏工作树上增量实现，未 reset、checkout、stash 或覆盖其他切片。Runtime 增加 `ub_observation.v1` 中立合同和共享 fixture；Server 在共同 Resident 入口分流类型化活动，复用最终 repair 交付判定，并在历史保存尝试结束、释放 AppState 锁后记录三轴根终态。宿主拥有唯一有界内存队列和 LangSmith REST worker；默认 off，只有 `UB_OBSERVABILITY_MODE=metadata` 开启，配置错误和传输故障只进入安全状态面。

本地通过 Runtime 合同/事件测试、TypeScript fixture/typecheck、Server 观测 13 项、状态 endpoint 1 项和既有 Resident 生命周期 17 项。mock HTTP 覆盖 POST/PATCH 请求形状、认证/workspace header、401、429、断网；内存 transport 覆盖父创建确认、abandoned 后代、容量和 canary。当前没有使用真实 LangSmith 凭据或写入真实租户；内存队列的崩溃恢复、完整成本/证据、构建、评测与发布硬化仍按 LS4–LS9 保留。

## 8. LS4–LS6 实施与本地验收

LS4 在 Provider 真正返回 usage 的位置保留累计细分和 partial，记录模型首文本、首个安全答案补丁、ledger 接纳证据、最终来源、交付诊断与请求审计计数；完整正文对象仍只走业务链。Runtime 用量/事件/合同测试分别 4、6、7 项，Server 观测 15 项、Resident 生命周期 18 项通过。

LS5 新增只读预构建投影、官方 TypeScript SDK 适配和独立 export ledger。5 项 fixture 覆盖并行 work unit、同 scope 重新租约、semantic retry、多次 submit、未知用量、矛盾时间、幂等与 SDK 失败；实际持久回执目录在投影和导出前后逐文件一致。未接 driver、心跳、extractor 提交路径或真实 LangSmith 租户。

LS6 冻结 `ub_eval_export.v1`，直接适配仓库历史 Agent/quality 报告为 24/32 行的两个系统实验，保留 24 个配对关系、完整分母、product_failed/unscorable 和逐次 Judge 顺序；答案、参考证据、Judge 理由与私有路径不进入包。未来 runner 在原产品调用边界增加 UTC 起止，旧结果只读。受权 importer 在整组 recorded 时间门后才调用官方 `/api/v1/datasets/upload-experiment`，持久复用跨系统 row UUID，并区分 confirmed/rejected/uncertain。

TypeScript 观测包 18 项、既有语义评测 20 项、类型检查、agent-run 语法检查均通过。合成 HTTP 覆盖认证 header、官方路径、缺时/未授权零发送、重复导入、超时 uncertain 与部分成功；没有调用被测模型、Judge 或真实租户。历史 elapsed-only 结果按合同返回 `unsupported_missing_timing`，不能以请求、Judge 或导入时间补齐。

## 9. LS8–LS9 持久恢复与本地发布验收

LS8 增加可选有界 spool：worker 在发送前原子写入过滤后的 payload，启动时按 schema、目标 descriptor 与 config epoch 读取；损坏记录隔离，目标变化默认 isolate，只有显式 replay/drop 才跨目标处理旧记录。重启只补观测 `interrupted / last_observed / unknown`，不恢复业务执行；关闭模式清理本项目拥有的未发文件。恢复排序使用观测时间并把 root 终态置于同刻子记录之后，避免落盘毫秒碰撞导致先清理后丢失 child。

LS9 发现并修复一项因果回归：模型名投影曾在每次模型调用重新读取 runtime profile，现改为复用回合开始时冻结的 profile。Runtime 全量 353/353、Server lib 304/304、Windows Tauri 17/17、Web 287/287、observability 18/18、semantic 30/30、quality 10/10 通过；生产 Web build 和发布 canary 扫描通过。固定 150 ms 合成 transport 下 5 次本地投影/入队最大 1.571 ms。

Core 全量独立运行有 968/978 通过：9 项资源超时，1 项是既有 BookStructure relation skill inventory fixture 漂移；LS8–LS9 未修改 Core，Core typecheck 通过。当前主机没有 Bash、WSL 或 Linux Rust target，Linux 实机启动与真实 LangSmith 租户上传未执行。完整证据见 [LS9 回归报告](回归报告-LangSmith-LS9-2026-09-20.md)。
