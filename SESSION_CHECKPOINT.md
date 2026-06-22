# SESSION_CHECKPOINT — 2026-06-22(S2 窗口切分完成;下一步 S3)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`feae5ad`。**S2 全部改动(代码+测试+CLI+实测文档+ADR 回填+本 checkpoint)随本次 commit 落地**;读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0:**S0+S1+S2 均完成**。下一步起 **S3(Pass1 抽取 + merge + 确定性闸 + 全局目录)**。

## 已完成
- **S0/S1**:monorepo+插件外壳+TS↔Rust schema 链路;段级 LID 切分(Model A)+分区不变式闸+md/epub 适配器。真书覆盖率 100%。
- **S2**:`packages/core/src/window.ts` `[ADR-0009]` —— LID 章/节子树为窗口单元 + 双约束预算(输入硬闸 token + 输出软闸叶子数)+ 超限子树内逐叶贪心细分(吸附 LID 边界不腰斩)+ 过小贪心合并 + 不跨卷(顶层封口)+ 单叶超限标 `overBudget` 诚实不腰斩;token=确定性近似估算(CJK 1/其余 0.25,零依赖)。
  - 闸:vitest 17 例全绿(新增 window 8)+ tsc 0。
  - **真书实测**:3047 叶/≈174k tok,默认 12000/80→64 窗口、partition.ok、零单叶超限、每窗 ≤ 硬闸。
  - **利用率完整记录**:`docs/实测-S2窗口利用率.md`(预算扫描 + 三层约束根因:软闸→硬闸稀释→结构地板 34 窗口;利用率低是子树对齐预期成本、非 bug)。

## 下一步(可直接接手)
1. 起 **S3** `[ADR-0010/0011]`(TS 确定性部分 + LLM subagent):
   - `packages/core/src/pass1-input.ts`:把 `Window` 还原成「每段前缀 LID 标注」的抽取输入正文(消费 `window.leafLids` + span 取原文),喂 `agents/pass1-local-extractor.md`。
   - `packages/core/src/merge.ts`:merge 按类型合并(实体/概念 occurrences 并集、断言单锚 `source_lid`)+ 确定性图谱闸(悬空丢不重建、最小连坐),复用 `base-schema` 的 `GraphNode/GraphEdge`。
   - `packages/core/src/catalog.ts`:merge 后 nodes 确定性投影出全局目录(零幽灵条目)。
   - 填 `agents/pass1-local-extractor.md` 实编排;vitest 用 mock 窗口抽取结果验 merge/闸/投影(LLM 联调留实机)。
2. S3 实测落点 → 回填 ADR-0010/0011(图谱锚定率/悬空丢弃率/并发数);**联动定 ADR-0009 窗口预算终值**(主锚=Pass1 抽取质量非利用率;实测建议:软闸 ~160+硬闸 ~8000 可省调用 30–40%,但以锚定率为准)。

## 未提交 / 未完成
- 无未提交(S2 随本 commit 落地)。
- 判据②(`/understand-book:build` 插件命令识别)待用户 `--plugin-dir` 实测。
- 字节精确 span(中文 UTF-16↔字节)留 S4;`.understand-book/` 写盘留 S3/S7。
- 窗口软闸/硬闸最终数字 = 占位(12000/80),待 S3 接 Pass1 质量实测后定。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0022。前端选型 PENDING。

## 工具链 & 实测要点
- node v24.9 / pnpm 10.34 / rustc·cargo 1.96;`.npmrc` 用 `node-linker=hoisted`(Windows 无符号链接权限)。
- CLI 传 **Windows 盘符路径**(`C:/Users/...`),勿用 `/c/...`。
- 真书:`C:\Users\Lenovo\Downloads\游戏编程模式 ([美] Robert Nystrom 尼斯卓姆) (z-library.sk, 1lib.sk, z-lib.sk).epub`。
- 命令:`pnpm -C packages/core test`(17)/ `... typecheck` / `cargo test -p base-schema` / `pnpm exec tsx skills/build/split-lid.ts <书>`(S1)/ `pnpm exec tsx skills/build/window-cli.ts <书> [硬闸] [软闸]`(S2)。
- md-adapter **空行分段**(单 `\n` 不分段)—— 写合成测试用 `\n\n`。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md`(架构全景 + §6 技术栈/打包)。
2. `docs/切片方案-切片0样板间.md`(S0–S2 已实现;S3=Pass1 抽取+merge+闸+目录)。
3. `docs/代码链路.md`(S0+S1+S2 改动账本,文件:符号 + 真书实测数)。
4. `需求文档-V3.md` / `CONTEXT.md`。
5. `docs/adr/0008`(切分)、`0009`(窗口=S2,含实测回填)、`0010`(两遍抽取=S3)、`0011`(确定性闸=S3)、`0021`(技术栈)、`0022`(插件)。
6. `docs/实测-S2窗口利用率.md`(S2 预算扫描根因,接 S3 调参前必读)。
7. `memory/quality-over-speed-correct-context.md` / `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- S2 token 口径 = **确定性近似估算**(中文 1/其余 0.25,零依赖、保守),否决真 tokenizer(Claude 新模型 tokenizer 未公开匹配+加依赖)。
- S2 不跨卷 = **顶层容器逐个封口、之间绝不合并**;过小合并 = 同父内贪心累加自然实现。
- 单叶超硬闸 = 自成一窗 + `overBudget`,**诚实不腰斩**(守 ADR-0008 + 最高原则)。
- **利用率低是子树对齐的预期成本、非 bug**;窗口预算终值主锚 = S3 Pass1 抽取质量非利用率(详见实测文档)。
