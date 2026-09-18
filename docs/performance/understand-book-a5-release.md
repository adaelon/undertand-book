# A5 旧局部成果复用与恢复验收

日期：2026-09-14。范围：[ADR-0129](../adr/0129-append-book-structure-and-reconcile-relations.md) 的 A5。

## 交付

沿用既有按工作类型冻结的策略代际与任务尝试存储。局部拼接 v4 合同保持，拼接后 select/delta 使用独立 v1 策略。当前生成读取器决定来源当前性，程序按来源映射公共 ID；旧 reduce 不进入贡献集合。

旧局部合同允许选择性骨架，追加发布要求完整 core。物化器现在以 `BookStructureContributionCoverageError` 汇集缺失或重复 core 的来源；生产路由返回包含具体 work unit 和 LID 的 `source_slice_coverage_invalid` 恢复状态。原成果、任务和收据保留。

## 程序验证

14 项定向用例通过：物化 4、磁盘复用/公共文件回滚 3、生产整链 1、Driver 计划接续 1、既有 policy-generation 3、task-store 2。Core TypeScript 和副本验收脚本严格 TypeScript 通过。

- 29 份 v4 局部成果在加入关系策略后可接入；重复磁盘读取重建同一物化结果与选择计划，所有原任务、成果、局部策略文件字节不变。
- 单份局部语义输入或合同变化时，该成果不再被当前读取器接受；未改变的 28 份仍 fresh。既有尝试存储按完整输入/策略身份隔离失败反馈，活动租约阻止半完成迁移。
- core 缺项红测先失败；修复后按稳定来源顺序报告全部缺失/重复项。生产测试注入局部缺项，得到具体来源恢复信封。
- 生产整链从局部任务之前创建 invocation，以同一引用完成关系任务、原子发布并返回 DONE；确认计划字节不变。另存的真实格式历史 reduce 产物始终保留原字节，未进入当前路由和最终贡献。
- 已改变的用户计划拒绝过期决策，新的 `confirm_current` 决策通过 Driver 持久授权后恢复派发，调用者无需手改 digest。发布失败、缺少发布收据、重复 close 和旧公共字节回归保持通过。
- 29 单元的有效公共结构在新文件已提升后注入发布失败，旧公共字节被恢复且通过 Reader 共用的 `BookStructureSidecarZ` 解析。

整链夹具为 29 单元、6 局部贡献、28 选择任务、2 关系任务，最终 82,501 字节，最后一次墙钟 67.602 秒。历史 reduce 夹具使用较短旧版本的条目，以符合原 reducer 输入预算；当前大成果未缩减。模型调用为 0。

## Mastering Rust 副本

[机器证据](understand-book-a5-reuse.json)记录 29 份来源逐项准入、生产恢复及旧 invocation 身份。验收脚本复制构建状态到独立目录，以存储覆盖方式保留原冻结 target identity；不修改任何 task、plan digest 或 lease 来伪装新身份。该覆盖仅用于验收，不提供工作区搬迁功能。

- 29 份旧局部成果通过身份与引用重读；28 份 core 完整。
- `stitch:fragment:0003` 覆盖单元 22–30，骨架只有 22、30，缺少 23、24、25、26、27、28、29。生产准备返回准确的来源及这七个 LID。
- 51 份已接受旧 reduce 保留为历史。7,534 个旧任务、语义成果、尝试/收据、策略及计划文件在副本准备前后相同，原目录对应文件也逐字节相同。
- 已登记的原 invocation 均绑定 `build_plan.v1`，计划 digest 保持原值，没有冻结内部 descriptor plan。最新原 invocation 为 `abinv1_b18731de81634f95f39611bdd8993da56a9faa91ec8c155ba6466a07ade79ec6`。
- 副本生产准备耗时 43.922 秒。原 invocation 未执行，原书语义生成未恢复。

## 已知问题与后续

- `stitch:fragment:0003` 不能作为完整局部贡献接纳。修复必须针对这个来源及单元 23–29，经正常新工作身份提交后重建；不能改写旧成功收据或用旧 reduce 补作额外贡献。原样 `retry_plan` 不会填补语义缺项。
- 原书尚未产生 `book_structure.json`，本轮无法以它验证“上一版公共结构仍可读”；该行为由有公共文件的小书集成验证。
- A6 尚未执行真实模型的相关条目选择、关系增量及语义质量验收；本次不报告新模型 token 成本或实书完成时间。现有全书 source-fingerprint 边界沿用；本轮局部变化用例验证的是局部语义输入与合同当前性。
- A5 源码与测试未提交。未更新 Build Engine 编译产物、日常程序、插件缓存、Windows Setup 或远程市场。下一次编译与发布使用 A1–A5 的完整工作树。

## 复跑入口

```text
node node_modules/vitest/vitest.mjs run --root packages/core test/book-structure-materialization.test.ts test/book-structure-reuse.test.ts
node node_modules/vitest/vitest.mjs run --root packages/core test/book-structure-append-production.test.ts
node node_modules/vitest/vitest.mjs run --root packages/core test/automatic-build-driver.test.ts -t "rejects a stale decision after BuildPlan drift"
node node_modules/vitest/vitest.mjs run --root packages/core test/automatic-build-policy-generation.test.ts test/automatic-build-task-store.test.ts -t "freezes canonical policy sets|stops prior-generation adoption|does not freeze a half migration|counts semantic failures only|does not carry a candidate field error"
node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-a5-book-structure-reuse.ts <source-file> <library-root> <new-output-directory>
```

本轮副本位于 `tmp/a5-real-20260914/workspace`；脚本只接受尚不存在的输出目录，复跑时另选目录。证据中 `storage_overlay` 是这次验收位置。
