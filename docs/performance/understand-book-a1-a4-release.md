# A1–A4 BookStructure 追加组装验收

日期：2026-09-14。范围：[ADR-0129](../adr/0129-append-book-structure-and-reconcile-relations.md) 的 A1–A4。实现与阶段状态见 [切片方案](../切片方案-BookStructure追加组装与关系增量.md)。

## 交付

局部贡献按当前来源集合物化，core 范围决定骨架归属，程序重写局部重点与主题 ID。关系选择和四类关系增量使用独立冻结任务及已接受产物；模型只接收相关条目，程序重建完整三清单。生产 fragmented stitch 不再进入递归 stitch-reduce，单元内 reduction 和小书 whole stitch 保留。

阶段关闭检查精确单元覆盖和公共引用，要求目标文件与当前物化字节一致且具有既有原子发布收据。质量报告包含局部及关系贡献，索引任务进入依赖闭包；合法空 delta 可正常结束。Root 仅取得三组进度计数和发布状态。

## 程序验证

57 项相关用例分别通过：局部物化 3、关系增量 3、关系路由 3、既有结构/证据/路由/提示词 32、质量 4、派发 5、输入渲染 4、生产追加整链 1、既有 orchestrator BookStructure 场景 2。Core TypeScript 检查通过。

- 29 份局部贡献的纯程序测试：乱序与重放得到相同结果；共享局部 ID 不串引用；同段不同重点保留；context 不重占 core；当前来源替换会撤出旧版本。
- 关系测试：空/重复 delta、不改原输入、主题扩展、重叠合并与成员保留、两端证据和未知引用拒绝；后续重叠任务收到合并后的当前条目。
- 索引测试：64 条索引覆盖全部 2016 个条目对，含跨批、非相邻、不同措辞；重复选择去重。超过原子输入预算时明确停止，不调用模型压缩整表。
- 生产整链：从真实磁盘的前置阶段成果进入 29 个单元任务、6 份局部贡献、28 个索引选择任务和 2 个关系任务，生成 82,501 字节公共文件。最后一个关系任务为空 delta。
- selection 与 delta 各一项经实际调度、opaque handoff、Executor 打开、分批读取、generation.start 和 submit_candidate；其他候选经真实 generation writer 保存。最后由实际 Driver 返回 DONE，公开响应没有 evidence_lids 等语义载荷。
- 关系未完时保持 pending；发布目录不可写时不能关闭；复制正确公共文件但没有发布收据时不能关闭；重复 close 文件字节不变；旧公共内容会重新打开发布状态。

## 固定夹具的任务输入

下表是本轮实际冻结并渲染的语义输入正文，token 为现有估算器数值，不是模型账单；不含提示词及控制协议开销。程序测试实际模型调用数为 0。

| 任务 | 数量 | 输入字节总量 | 估算 token 总量 |
|---|---:|---:|---:|
| 单元卡片 | 29 | 25,878 | 6,489 |
| 局部拼接 | 6 | 88,952 | 27,198 |
| 相关条目选择 | 28 | 345,366 | 106,452 |
| 关系增量 | 2 | 12,264 | 3,751 |

最后一次生产集成测试墙钟 67.628 秒，包含前置阶段夹具、实际 Executor 两种新任务、故障注入、重复发布和 Driver 关闭。该时间不是书籍构建耗时。

## 编译验证

392-module Build Engine 编译通过，产物位于 `apps/desktop/src-tauri/binaries/understand-book-build-x86_64-pc-windows-msvc.exe`。outside-repo Node/compiled parity 通过，覆盖 17 个提示词入口、thin-plugin protocol doctor、派发租约/收据与既有 rollback smoke。

编译验收曾发现新提示词缺少 task 模式执行说明，已补齐；dispatch 模式仍剥离该说明并使用固定语义提示词。Executor 的单章范围判断已改为 parent_unit_lid，关系任务保持 stitch 依赖范围。长同步集成曾超过 Vitest onTaskUpdate 通信时限，测试改为阶段之间释放事件循环后以退出码 0 完成，断言未放宽。

## 已知限制

- 本轮是程序与格式验收，候选由确定性夹具提供，没有调用真实模型；不能据此断言实际书的主题召回质量、token 用量或速度改善。真实模型调用与真实书成本属于 A6。
- 索引采用完整的跨块组合，选择任务数随块数呈二次增长；关系组拆为去重条目对并串行执行。单个完整相关条目或最小条目对超预算时返回具体条目错误，当前不会截断证据或改回全表压缩。
- 原局部成果已缺少 core 骨架时，物化会报具体缺项；本轮没有改写局部语义合同来伪装完整性。
- A5 的旧 invocation 接续、原 Mastering Rust 29 份局部成果复用和 A6 的隔离实书验收未执行。原书目录保持不变。
- 没有提交现有工作树，没有更新日常安装、插件缓存、Windows Setup 或远程市场。既有 R1–R4 和其他任务修改保留。

## 复跑入口

```text
node node_modules/vitest/vitest.mjs run --root packages/core test/book-structure-materialization.test.ts test/book-structure-relations.test.ts test/book-structure-relation-routing.test.ts test/book-structure-append-production.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node apps/desktop/scripts/build-sidecar.mjs
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
```
