# LangSmith LS9 本地回归报告 — 2026-09-20

## 结论

LS0–LS6、LS8–LS9 的本地实现已接通；独立扩展 LS7 不在本次范围内。受影响 Rust、观测包、Web、评测、Windows Tauri、生产构建与发布面隐私扫描通过；默认关闭时不因普通 LangSmith 环境变量启动观测。未使用真实 LangSmith 凭据、真实阅读正文或付费模型。

仓库级 Core 行为回归不是全绿：一次独立全量运行有 968/978 项通过，9 项在 Windows 高并发文件/进程负载下超时，另 1 项是既有 BookStructure relation skill 清单增加后旧 fixture 仍少两个条目。LS8–LS9 未修改 `packages/core`，Core 类型检查通过；这些红项不冒充本切片通过项。

## 源代码 manifest

- Resident 合同与事实源：`crates/runtime/src/observation.rs`、`provider_stream.rs`、`run_events.rs`、`orchestrator.rs`。
- 宿主与生命周期：`crates/server/src/agent_run.rs`、`agent_run_tests.rs`、`agent_stream.rs`、`host.rs`。
- 导出器：`crates/server/src/observability/{config,langsmith,lifecycle,mapping,mod,policy,queue,spool}.rs`。
- 跨语言合同与导出：`fixtures/observability/`、`packages/observability/`、`evals/semantic/eval-timing.mjs`、`agent-run.mjs`。
- 配置与宿主发布面：`.env.example`、`README.md`、`scripts/linux/reader.env.example`、`smoke-reader.mjs`、`scripts/verify-observability-release.mjs`、`package.json`。
- 决策与实现说明：ADR-0134、LangSmith 切片方案、本报告、审阅记录、架构与代码链路。
- 基线：`c12cbb9 feat(reader): deliver mobile reading workspace` 上的既有脏工作树；未 reset、checkout 或 stash，未提交。

## 验收矩阵

| 场景 | 结果 | 确定性证据 |
|---|---|---|
| A1 off + key | 通过 | config 测试证明 `LANGSMITH_API_KEY` / `LANGSMITH_TRACING` 不自动开启；off 只清理本项目 spool 文件。 |
| A2 开关业务等价 | 通过 | Runtime 固定请求/回答等价测试；全量 Runtime 通过。 |
| A3 状态分类 | 通过 | mapping、lifecycle 与 Resident tests 覆盖成功、空结果、拒绝、失败、取消。 |
| A4 repair 终态 | 通过 | 最终 repair 判定复用业务规则；Server Resident 回归通过。 |
| A5 保存失败 | 通过 | `UnsavedRun` 与 persistence failed 路径由 Server 回归覆盖。 |
| A6 传输故障/容量/依赖 | 通过 | mock HTTP 覆盖 401、429、断网；queue/spool 覆盖限额、父未确认、慢响应与退出预算。 |
| A7 SSE 重连/无订阅者 | 通过 | Resident SSE/无 stream 共用 `execute_observed`，Server 回归通过。 |
| A8 终止重启 | 通过 | spool 重启只恢复观测，未闭合根补 interrupted，不运行工具或模型。 |
| A9 隐私 | 通过 | allow-list/canary 测试与发布扫描；Web、桌面资源、插件面各扫描 65 个文件，无合成密钥。 |
| A10 usage | 通过 | usage-only、total-only、累计帧、partial 和截断回归通过。 |
| A11 构建回执 | 通过 | observability 预构建 5 项覆盖只读、修订、幂等和源目录不变。 |
| A12 评测导入 | 通过 | observability 评测 11 项、semantic 30 项、quality 10 项；缺时与未授权均零发送。 |
| A13 目标切换/关闭/密钥失效 | 通过 | epoch 默认 isolate，显式 replay/drop；auth reject 停止发送，off 清理未发内容。 |
| A14 Windows/Linux/插件 | 部分 | Windows Tauri 17 项、生产 Web build、插件/资源扫描通过；当前主机无 Bash、WSL 或 Linux Rust target，未执行 Linux/systemd 实机启动。 |

## 测试结果

- `cargo test -p runtime --no-fail-fast`：353 passed、3 ignored；附加 build-intent 6/6。
- `cargo test -p server --no-fail-fast`：lib 304 passed、7 ignored；book-mcp 5/5、server main 1/1、presentation-preview 1 passed/8 ignored。
- `cargo test -p understand-book-desktop --no-fail-fast`：17/17。
- `pnpm --filter @understand-book/observability test`：18/18；typecheck 通过。
- `pnpm --filter @understand-book/web test`：55 files、287/287；`pnpm build` 通过。
- `pnpm --filter @understand-book/code-mcp test`：9/9。
- `pnpm eval:semantic:test`：30/30；`pnpm eval:quality:test`：10/10。
- `pnpm --filter @understand-book/core typecheck`：通过。
- Core 全量：117/126 files 通过，968/978 tests 通过；9 个资源超时，1 个旧 inventory fixture 失败。该命令没有继续 typecheck，随后已单独通过 typecheck。
- `node --check`：发布验证脚本与 Linux smoke 脚本通过。
- `pnpm verify:observability-release`：passed，Web/桌面资源/发布面各扫描 65 个文件。

## 故障、恢复与性能

持久队列先写过滤后 payload 再发送。active、stale 与 quarantine 记录共享文件数、字节数和保留期上限；容量按整 trace 淘汰更老 active 记录，不删除当前 trace 父链。目标变化默认隔离旧 epoch。恢复顺序使用观测时间而非毫秒级落盘时间，避免同毫秒记录把 root 终态排到 child 前面；专门回归锁定 root 终态最后发送。

固定合成环境把 transport 延迟设为 150 ms，连续 5 次本地根投影/入队为 1.571、0.212、0.172、0.219、0.167 ms，最大 1.571 ms。该结果只证明本机非阻塞边界，不代表真实 LangSmith 网络延迟或生产吞吐。

## 业务等价与用量对账

观测开关不改变 Provider 请求内容/次数、工具结果、答案、来源或业务持久状态。一次回归发现 LS4 为记录模型名而每次调用重新读取 runtime profile，已改为复用回合开始时冻结的 profile；既有冻结测试由红转绿并进入 Runtime 全量。

Provider usage 保留 input/output/cache/total 的累计快照与 `provider_reported` 来源，不和旧 `usage_total_tokens` 相加；缺项保持空，失败保留 partial。构建回执使用 `executor_reported`，请求估计只写审计计数，不充作原生模型费用。未连接真实账单，因此没有金额对账声明。

## Limitations

- 没有真实 LangSmith 租户合成上传、服务端 UI 核对、云端删除或账单核对。
- 当前 Windows 主机没有 Bash、WSL 或 Linux Rust target；Linux 仅核对共享 Server、EnvironmentFile 和脚本/命令行凭据边界。
- 未配置 spool 时仍是纯内存尽力发送；配置 spool 后也不承诺 exactly-once。
- Visitor MCP、独立后台任务和外部 Harness 内部模型调用不属于 Resident 覆盖。
- Core 全量现有红项需由对应 Automatic Build / BookStructure 切片单独处理，不纳入 LS8–LS9 修复范围。
