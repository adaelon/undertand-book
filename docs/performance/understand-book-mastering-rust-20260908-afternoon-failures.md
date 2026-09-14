# Mastering Rust 下午执行器连续失败排查

日期：2026-09-08，时间均为香港时间（UTC+8）。检查对象：任务“深读 Mastering Rust EPUB”，`01a07f21-570c-7d70-808d-1f0d16897ca3`。诊断证据截止该任务 17:10:42 中断。用户随后明确同意实施以下修复。

## 修复进度

意图：补齐现有 BookStructure 输出契约、通过对象传递 Executor 控制字段，更新本机安装并验证一个真实 BookStructure 提交。类型为纯技术修复；BookStructure、候选、执行器、证据 LID 均沿用现有领域含义。不改变产物 schema、证据校验或构建配方。生成提示变化须经过现有策略代次与恢复路径，保留已接受产物。

- [x] S1：生产提示的可执行合法示例覆盖 whole / fragment / reduce / stitch；6 组复现测试先红后绿。补充 v2 冻结策略共存测试，BookStructure 提示使用 v3 策略代次；相关 30 项测试通过。
- [x] S2：Executor 用 `store/load` 传递下一请求与终态字段；可执行协议示例覆盖 WAIT、多批输入、提交及错误回报。24 项 Agent 发布/注册测试通过，补充 WAIT 分支后 2 项可执行示例测试通过。
- [x] S3：重建日常 Build Engine、刷新插件版本及缓存、同步项目 Agent 注册。版本 `0.1.0+codex.20260908093652`；384 模块重编译，10 份插件文件 source/market/cache 逐字节一致，安装 exe 与编译产物逐字节一致，项目注册返回 `source_state=same`。插件校验、技能校验、source contract 和 core typecheck 通过。
- [x] S4：通过新宿主验证一个真实 BookStructure 单元。`unit:1` 第 2 次物理尝试成功，产物采用 `book-structure-unit.full.v3`，520 份既有成功回执逐字节不变；共 521 份成功回执。

原 invocation `abinv1_26fc89b98216385372e30c60e0e5016d9b98d84b82b20b7fe65de593e710cd57` 在新程序下的首次 step 用时 112.109 秒，返回一个 `SPAWN_EXECUTORS` 引用。受限新宿主只运行该引用，140.559 秒后退出码 0，子任务返回 `committed`。控制与验证脚本、私有轨迹位于 `tmp/book-structure-fix-20260908/`。旧 exe 保留为 `E:\allwork\Understand Book\understand-book-build.exe.before-structure-fix-20260908093652`。

## 真实验收与恢复入口

- 新宿主 root `01a08065-3079-7832-975c-305fede15a87`，专用 child `01a08065-6ebc-7c53-917f-1a7b1748595a`。四个 exec cell 均使用发布的 `executorCall`，后三步均通过 `load("understand_book_next_request")` 传递字段，实际源码中没有手写返回的 session/input/sink refs；四个 MCP 调用完成真实生成与提交。
- 成功时间：2026-09-08 17:43:46。回执：`E:\allwork\download\agent\lifebook\.understand-book\mastering-rust\.build\automatic-build\v2\tasks\book_structure\unit%3A1\attempts\0002\result.json`。
- 新产物：`E:\allwork\download\agent\lifebook\.understand-book\mastering-rust\.build\automatic-build\v3\artifacts\book_structure\book-structure-unit.full.v3\unit%3A1.json`。这是此前整批失败中的第一个单元，旧失败回执仍保留。
- 54 项相关测试通过（30 项结构/路由/编排，24 项 Agent 发布/注册），core typecheck、插件校验、技能校验、source contract、改动文件 whitespace 检查通过。WAIT 示例补充与隐私断言调整后，2 项可执行 helper 测试再次通过。
- 安装版本为 `0.1.0+codex.20260908093652`；日常缓存位于 `C:\Users\Lenovo\.codex\plugins\cache\understand-book-local\understand-book\0.1.0+codex.20260908093652`。安装程序仍为 `E:\allwork\Understand Book\understand-book-build.exe`。
- 原任务“深读 Mastering Rust EPUB”仍停在 17:10 的用户中断位置；本次没有给原任务发送消息。恢复时重新加载桌面宿主和新插件，沿用上面的 invocation 与原 confirmed plan；下一次 `build.step` 会读取已提交结果。无需重新创建书籍计划。验收宿主已退出，无后台构建继续运行。
- 本轮只验收一个真实单元，整本书剩余工作未全部完成；首次 step 包含新策略准备，不代表普通补位耗时。未重新打包 Windows Setup、提交 Git 或发布远程市场。

## 结论

16:47 起的整批失败来自 BookStructure 生成提示缺少输出契约。子任务已经成功调用四个 Executor MCP 工具并提交候选；引擎在 artifact writer 校验阶段以 `schema_invalid` 拒收。14 份失败回执均指向 `/unit_card`，预期为 `exact proof-bound BookStructure candidate fields`。

抽取 `book_exec_206` 与 `book_exec_219` 的实际传输记录，二者收到的 semantic prompt 均为 418 字节，只有顶层 `unit_card` / stitch 的说明，没有 unit card 字段定义、字段类型、角色枚举或 key-stop 枚举。semantic input 提供书籍输入数据；GENERATE 的 output contract 提供格式、大小、阶段与工作单元身份，两者均未补充候选对象 schema。

这两个子任务的 developer 技能目录均为 `0.1.0+codex.20260908031700`。上午的 `bootstrap_unavailable` 故障与本次批量拒收属于不同问题，不能沿用上午的旧缓存结论解释下午状态。

## 最近一批子任务

| 子任务 | 时间 / 结果 | 说明 |
| --- | --- | --- |
| `book_exec_193`–`204` | 16:28–16:41，12 个 `committed` | 紧邻这批失败之前，Executor 仍正常完成并提交。 |
| `book_exec_205` | 16:44，`retryable_failure` | `profile_sidecar` 的单独写入失败，见已知问题。 |
| `book_exec_206`–`219` | 16:49–17:08，14 个 `retryable_failure` | 全部是 BookStructure 候选 schema 不符。 |
| `book_exec_220` | 17:07，`interrupted` | 输入请求抄错 session ref，一个独立问题。 |
| `book_exec_221`、`222` | 17:10 启动 | 根任务中断前没有完成回执，不计为生成失败。 |

14 份 BookStructure 失败对应 `unit:1`、`2`、`3`、`5`、`19`、`20`、`21`、`22`、`23`、`24`、`26`、`27`、`28`、`29`，均为各自的第一次物理尝试。这是不同工作单元持续碰到相同契约缺口，不是同一单元重试 14 次。本次读取到的 BookStructure 阶段回执为 14 份失败、0 份成功。

## 提示与校验的具体差异

生产提示位于 [book-structure.ts](../../packages/core/src/book-structure.ts)，`BOOK_STRUCTURE_V2_EXTRACTOR_PROMPT`；通过 `BOOK_STRUCTURE_EXECUTION_PROMPTS_V2` 进入 production routing。实际下发提示与这里的简略内容相同。[agents/book-structure-v2-extractor.md](../../agents/book-structure-v2-extractor.md) 的普通输出要求也缺少这些定义。

严格校验位于 [book-structure-generation.ts](../../packages/core/src/book-structure-generation.ts)，`validateUnitOutput`。

| 项目 | 引擎要求 | 实际候选 |
| --- | --- | --- |
| unit card 字段 | 恰好包含 `unit_lid`、`role`、`summary`、`candidate_key_stops`、`depends_on`、`evidence_lids` | 14 份均使用 `key_stops`；部分还添加 `title`、`spine`、`unit_kind` 等字段。 |
| summary | `{text, evidence_lids}` | 14 份均为字符串。 |
| role | `setup / foundation / method / application / case / synthesis` | 多份使用未允许的 `front_matter`、`orientation`、`introduction`、`concept` 等值。 |
| key stop | `id`、`lid`、`type`、带证据的 `reason`，可选 `title`；type 使用固定枚举 | 提示只提到 closed enums，没有列出枚举或字段。 |

例如 `unit:1` 提交 `{unit_card: {unit_lid, role, summary, key_stops}}`，首先命中字段集合校验；即使只改 `key_stops` 的名字，仍会遇到缺失字段、summary 类型及 role 枚举问题。

原始证据在正确的外层工作区：

- `E:\allwork\download\agent\lifebook\.understand-book\mastering-rust\.build\automatic-build\v2\tasks\book_structure\unit%3A1\attempts\0001\result.json`
- 同目录 `candidate.json`、`failure.json`、`validation.json`；其中 `valid_json=true` 仅表示合法 JSON，不代表符合 BookStructure schema。
- 子任务 `01a08033-a412-7632-98d4-5c24c8a19915`（206）和 `01a08044-e0f4-78d2-933e-cee6351f8da1`（219）的持久会话记录，位于 `C:\Users\Lenovo\.codex\sessions\2026\09\08`。

## 修复落点与验收缺口

1. 在代码实际下发的 BookStructure 提示中补齐字段、嵌套类型、固定枚举、证据引用规则和合法示例；同步覆盖 whole、fragment、reduce、stitch 相关输出分支，避免推进到下一分支后再遇到同类缺口。
2. 以生产提示与实际 validator 的契约一致性验证这项改动。当前 routability 测试注入简短测试提示并手工构造合法候选，能验证路由和写入，不能证明真实 Executor 从下发信息中能获知完整 schema。
3. 编译并更新日常 Build Engine；先完成一个真实 BookStructure 单元的提交，再恢复该阶段余下工作，保留已接受产物。

此前 [V1 日常安装验证](understand-book-v1-daily-install.md) 完成了恢复 canary 和三个真实 discourse 单元的提交，没有覆盖真实 BookStructure 生成。这是原验收覆盖缺口。

## 已知问题

- `book_exec_205` 的 `discourse-174-2-995a144cc3bf` 第 3 次物理尝试（semantic attempt 2）记录为 `internal / writer_failed / artifact_writer`。现有失败回执未保留可直接定位到具体写入异常的原因；该单例与后续 14 份 `schema_invalid` 不合并解释。
- 历史 `book_exec_220`（`01a08045-0529-7372-98c9-934239a5c5ee`）收到的 `opaque_session_ref` 与下一次输入请求中的引用不同：原片段 `...835b964...` 被抄成 `...835bb964...`，长度由 64 位主体变成 65 位。工具返回 `protocol_incompatible / input_delivery`，尚未进入 generation。最终 lifecycle 文本还将诊断码误写为 `protocol_inible` 并附加了多余字符。本轮已通过 S2 的控制对象传递和终态序列化修复发布示例，S4 真实轨迹确认实际使用了该路径；协议没有增加手工引用的容错或放宽校验。
- 验收宿主报告现有 `C:\Users\Lenovo\.codex\hooks.json` 在第 1 行第 1 列无法解析。该配置不属于此修复；警告未阻止本次专用子任务成功提交。
