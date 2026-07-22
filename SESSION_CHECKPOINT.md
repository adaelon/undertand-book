# SESSION_CHECKPOINT - 2026-07-22 17:52 +08:00

## 新鲜度自检
- 写入时最新 commit:`ed864cb feat(pdf): add full-book adaptation audit`；PR9 已验证完成，下一原子动作是提交 PR9 后进入 PR10。
- 读入时先比较 `git log -3 --oneline`;若不一致,以 git 为准并重新核对本页未提交状态。

## 当前在做什么
PDF 选区全书适配 PR9 已实现并验证：Markdown adapter 已切换到 positioned CommonMark/GFM/math AST，真实书的无正文结构差异和 10 个 source-review proposal 已冻结；正式 source/base/maps 未修改。当前进入 PR10 来源实质差异复核与 LID 迁移。

## 下一步(可直接接手)
1. 提交 PR9 精确暂存集；提交后把本页 freshness 更新为 PR9 commit hash。
2. 读取 PR10 方案、ADR-0019/0020、`source-reconciliation.ts` 及现有 review/migration tests，先声明 source decision/migration 的最小边界。
3. 以 `external-formula-dense-transformer-structure-audit.json` 的 10 个 proposal 和总账 A011 28 项建立 red review manifest；未经显式证据的项必须阻断候选发布。
4. 构建新 book_id 的隔离 source/base 候选与 `lid_migration_map`；旧 source/base/记忆保持只读，禁止最近邻迁移。
5. 跑 PR10 定向测试、Core typecheck/全量、真实 source review closure 与 PR8 migration audit；若仍有未复核项，工具能力可提交但 PR20 发布门保持红。

## 未提交 / 未完成
- `SESSION_CHECKPOINT.md`:本次整页刷新，将随 PR9 提交；提交后需再次刷新 hash。
- PR9 实现/测试/文档已完成但尚未提交；PR10-PR21 仍未实施。
- 工作树另有用户既存 memory/profile/reader/server、前端阅读器切片、Note/画像文档和临时日志;不吸收、不恢复,每个 PR 提交前精确选文件。

## 冷启动读序
1. `docs/切片方案-PDF选区全书适配闭环.md` 第 3-4 节 PR10 - source review、候选基座与退出判据。
2. `docs/adr/0019-*.md` 与 `docs/adr/0020-*.md` - 基座替换和 LID migration 的冻结约束。
3. `packages/core/src/source-reconciliation.ts` 与对应 tests - 现有来源复核/决策边界。
4. `packages/core/test/fixtures/hybrid-foundation-goldset/v1/external-formula-dense-transformer-structure-audit.json` - PR9 冻结的真实结构差异和 review proposals。
5. `packages/core/src/hybrid-foundation-goldset.ts` - PR8 migration map 审计入口。

## 本会话决策摘要
- PR9 引入 positioned mdast parser 和 source-review proposal，不修 source、不改 alignment unit/LCS/formula 白名单；真实结构快照为 2,075 -> 1,983 leaves、10 proposals、463 LID drift，SHA-256 `120762b3...ccb566`。
- Core typecheck、定向 19/19、单 worker 全量 360/360 和正式 PR8 audit 均通过；默认多 worker 全量在本机只因三个既有 CLI 测试超时，三文件独跑与单 worker 全量均全绿。
- PR10 只能消费已冻结 proposal/证据形成 reviewed decision 与确定性迁移，不得从 PDF 近似文本或模型输出自动补 source。
