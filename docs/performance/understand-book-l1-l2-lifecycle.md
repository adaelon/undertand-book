# L1/L2 执行器生命周期与连接恢复

日期：2026-09-08。范围：[ADR-0121 §4–§5](../adr/0121-bounded-build-state-reads-and-executor-lifecycle.md) 与[切片方案 L1/L2](../切片方案-预构建控制面有界读取与执行器补位.md)。

状态：实现与本地验收完成；下一入口 P1。主回归 121 项分组测试、handoff 16 项、core typecheck、最新源码 compiled stdio smoke 均正常退出。

## 实现

- Root 每个新 ref 创建新 child/连接；按 slot 占位、按 ref 去重。消费已送达终态后立即重算容量，Driver 调用中到达的终态在返回后先入账；重复旧终态不能释放替补 child 的槽。
- child 启动错峰时，已派出但未 open 的引用也可能占据 Root 槽位。普通 dispatch 选择之后，Driver 补充返回同一 run 已准备且未结束 dispatch 的当前引用；Root 从这些引用中选实际空槽，避免单个重放引用挡住其他空槽的替补。
- 失败观察按 ref 排队，每个 step 携带一个。NEEDS_USER 可能在 Driver 处理观察之前返回，因此已发送和未发送项都保留，恢复后幂等重报；其他 child 成功不会清空队列。
- 连接拒绝精确返回 `session/connection_terminal/open` 或 `session/handoff_ref_mismatch/open`。MCP、adapter 与协议自检使用相同分类，版本/请求合同错误继续使用 `protocol_incompatible`。
- `automatic_build_step_request.v1` 新增可选闭合字段 `executor_open_failure={opaque_handoff_ref, diagnostic_code, phase:"open"}`，与 `bootstrap_failure` 互斥。Driver 只接受上述两个诊断。
- Driver 沿用 invocation 发行记录、durable open、当前代际和任务终态检查，复用既有 bootstrap failure 记录。替补保持同 slot，控制恢复不增加 semantic attempt/lease epoch；三次失败暂停、`retry_bootstrap` 一次授权保持原义。
- Root skill、Executor wrapper、fallback skill、项目 agent、规范 agent asset 和 thin-plugin 投影同步更新。未修改 extractor prompt 或 durable record/ref 派生格式。

## 验证证据

| 范围 | 通过数 | 退出状态 |
|---|---:|---|
| Driver（包含 L1/L2） | 41 | 最终源码分组全部 0 |
| Executor session | 37 | 分组全部 0 |
| Agent/skill/发布投影 | 23 | 0 |
| MCP | 12 | 0 |
| adapter/connection | 8 | 0 |
| handoff 补充回归 | 16 | 0 |
| core typecheck | — | 0 |
| compiled stdio smoke | 16 次调用配对 | 0 |

主回归共 121 项，分 21 个互斥组；加 handoff 后共 137 项。每个测试名恰好覆盖一次，没有通过忽略未处理错误取得成功。

`packages/core/test/automatic-build-driver.test.ts` 的 L1 磁盘 fixture 完成六个独立 Pass1 units：六个新 MCP session、六次 semantic attempt 1、六个 durable commits，最终 live 集合为空。前三次完成分别在另两个 session 已接受 generation.start、尚未提交时补位；重复 launch 不增加连接。

另一个 L1 红例覆盖尚未 open 的兄弟 child：A 完成后派出替补 A，B/替补 A 仍等待首次调用，此时 C 完成；Driver 必须返回同 slot 的替补 C。原实现只返回被 B 占用的引用，空槽候选为零；补充当前 prepared refs 后该用例通过。

L2 的真实持久链路为 `A 四次 MCP -> commit -> 同连接打开 B 被拒绝 -> Driver 接收精确诊断 -> 同 slot 新 ref -> 新连接四次 MCP -> B commit`。恢复前后直接比较任务文件字节；A 的结果保持，B 首次生成仍为 attempt 1。重复观察、旧 ref、已 open、已提交、跨 invocation、非白名单诊断、错误 phase、额外字段、双字段同时发送均有定向覆盖。原 bootstrap 通道与两类新观察共同覆盖三次暂停和显式重试。

`codex-executor-agent.test.ts` 校验 Root 的补位/排队合同及所有发布投影；`build-executor-mcp.test.ts`、`build-executor-tool-adapter.test.ts` 校验连接拒绝与其他分类边界。

重新构建的 executable 通过既有 compiled stdio smoke，证据见 [L1/L2 compiled JSON](understand-book-l1-l2-compiled.json)：16 次调用计时配对；两类连接拒绝精确，另一个任务 attempt 数为 0，主任务一次生成/提交。既有 RG8 恢复与 oversize canary 保持通过；`installed_launcher_executed=false`。

复跑入口：

```text
pnpm --filter @understand-book/core exec vitest run test/automatic-build-driver.test.ts test/automatic-build-executor-session.test.ts test/build-executor-mcp.test.ts test/build-executor-tool-adapter.test.ts test/codex-executor-agent.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @understand-book/core typecheck
pnpm --filter @understand-book/core exec vitest run test/automatic-build-handoff.test.ts --maxWorkers=1 --minWorkers=1
node apps/desktop/scripts/build-sidecar.mjs
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-t7-executor-release.ts --evidence-out docs/performance/understand-book-l1-l2-compiled.json
```

遇到既有 RPC 回传超时时，先用 `vitest list <同一组文件> --json` 取得完整测试名；Driver/session 每组最多五项，L1 两个场景单独成组，其余文件各自一组，使用 `-t` 精确匹配互斥测试名。每组要求退出码 0、JSON reporter 的 success=true、通过数等于分组大小；最后核对所有测试名恰好覆盖一次。逐组名单与结果写入 [regression JSON](understand-book-l1-l2-regression.json)。启动错峰修复后替换 Driver 各组为最终源码复验结果。

## 已知限制

- 三槽/六单元是真实磁盘、真实 MCP handler 与合成候选的确定性测试；child 身份由独立连接表示。未在真实 Codex 宿主启动六个 child，未证明宿主会按文字合同消费终态或保留失败队列。真实宿主多波、安装态与性能 A/B 留在 V1。
- 未安装或发布插件，未续跑 Mastering Rust；本次不声明整书提速。compiled 文件为本地开发构建产物。
- 首轮 15 个定向断言与一次合并运行的 120 个断言通过，但 Vitest `onTaskUpdate` 回传超时使进程退出码为 1；六单元测试在 child 启动/提交边界让步，并按互斥小组重跑取得正常退出，不忽略 RPC 错误、不放宽业务断言。启动错峰问题另以新增红例和 Driver 修复闭环。
- 工作树承接 B1、RG/R8、bootstrap、Rust 与其他未提交内容，HEAD 仍为 `9e36507`；Git 的整份 diff 不等于本次改动范围。
