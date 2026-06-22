# SESSION_CHECKPOINT — 2026-06-22(S0+S1 已 push;待起 S2)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 读入时对比 `git log -3`:S1 已 push 至 `e028944`(本 checkpoint 的更新会是其后一条)。

## 当前在做什么
切片0:**S0 + S1 均已完成并 push**。下一步起 **S2(窗口切分)**。

## 已完成(已 push)
- **S0**:monorepo 骨架 + 插件外壳(`.claude-plugin` + `skills/build/SKILL.md` = `/understand-book:build` + `agents/{pass1,pass2}`)+ Rust 权威 schema `crates/base-schema` → ts-rs 生成 TS → TS 侧 zod/sample/vitest。三道闸全绿。
- **S1**:段级 LID 切分(Model A:章/节=纯容器 span=子并集,标题=容器首叶段)+ 分区不变式闸 + md/epub 适配器(fflate + node-html-parser)+ `skills/build/split-lid.ts` CLI(tsx)。
  - 闸:vitest 9 例(覆盖率 100%)+ tsc 0 + cargo 绿。
  - **真书实测**:《游戏编程模式》epub → 3047 块/3399 节点(3047 叶+352 容器)/25 万字,分区不变式 ok、覆盖率 **100.0000%** ⇒ S1 判据达成。

## 下一步(可直接接手)
1. 起 **S2 窗口切分**(TS,`[ADR-0009]`):
   - 在 `packages/core/src/window.ts` 实现:LID 子树(章/节)为窗口单元;输入硬闸预算(正文 token ≤ 上下文窗口×安全系数 − 指令/目录/输出预留)→ 超限子树内 token 驱动细分(切点吸附 LID 边界,不腰斩);过小则合并相邻同级;不跨卷。
   - 消费 S1 的 `LidNode[]`(段级);用 LID 物化路径排序数组做子树范围切片。
   - 写 vitest:窗口覆盖全书无遗漏 + 每窗口 token ≤ 硬闸;再用真书跑一遍看窗口数/分布。
2. S2 实测落点 → 回填 ADR-0009:输入安全系数 / 输出软上限 / 并发数 / 融合·细分阈值。

## 未提交 / 未完成
- 无未提交(S0+S1+本 checkpoint 已 push)。
- 判据②(`/understand-book:build` 插件命令识别)待用户 `--plugin-dir` 实测。
- 字节精确 span(中文 UTF-16↔字节)留 S4(`book.text`)精化;`.understand-book/` 写盘留 S3/S7。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0022。前端选型 PENDING。
- `.env`(阅读器自身 agent 后端,与读时后端无关)+ 跨语言 fixture 已 gitignore。

## 工具链 & 实测要点
- node v24.9 / pnpm 10.34 / rustc·cargo 1.96;pnpm 用 `node-linker=hoisted`(`.npmrc`,Windows 无符号链接权限)。
- CLI 传 **Windows 盘符路径**(`C:/Users/...`),勿用 `/c/...`(Node 当成 `E:\c\...`)。
- ts-rs `export_to` 相对 `src/` 目录,三级 `../../../` 落 `packages/core/src/generated/`。
- 命令:`pnpm -C packages/core test`(vitest 9)/ `... typecheck`(tsc)/ `cargo test -p base-schema` / `pnpm exec tsx skills/build/split-lid.ts <epub|md>`。

## 切片0 已定输入
- 书:`C:/Users/Lenovo/Downloads/游戏编程模式 (…z-lib.sk).epub`(前言+6 部分+20 章;h1/h2/p.zw/blockquote/pre)。
- 读时后端 = **Claude Opus 4.8** = `claude-opus-4-8`(Anthropic 原生 tools+JSON)。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md`(架构全景 + §6 技术栈/打包)。
2. `docs/切片方案-切片0样板间.md`(S0/S1 已实现;S2–S8 待;S2=窗口切分)。
3. `docs/代码链路.md`(S0+S1 改动账本,文件:符号 + 真书实测数)。
4. `需求文档-V3.md` / `CONTEXT.md`。
5. `docs/adr/0001`–`0022`(0008 切分、**0009 窗口=S2**、0010 两遍抽取、0021 技术栈、0022 插件)。
6. `memory/quality-over-speed-correct-context.md` / `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- ADR-0022 插件打包 + 命名空间(`skills/build`,`/understand-book:build`)。
- S1 标题→LID = **Model A**(章/节=纯容器,标题=容器首叶段),不动 S0 schema。
- epub 适配器 = fflate + node-html-parser;source = 块文本顺序拼接,span 索引进 source。
- 切片0 用书 / 读时后端 Opus 4.8(同前)。
