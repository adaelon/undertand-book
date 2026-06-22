# SESSION_CHECKPOINT — 2026-06-22(S0 判据① 闭环;待 commit + 起 S1)

## 新鲜度自检
- 非 git 仓库已转为 git 仓库(remote `https://github.com/adaelon/undertand-book.git`,默认分支 main)。
- 读入时对比 `git log -3`:文档基线已 push(commit 含 V3/CONTEXT/ADR/蓝图/切片方案);**S0 代码尚未 commit**(本会话刚写完)。

## 当前在做什么
切片0 **S0**(monorepo 骨架 + 插件外壳 + TS↔Rust 基座 schema 链路)—— 判据① 三道确定性闸全绿,已完成核心。

## S0 状态
- ✅ monorepo 三面:`Cargo.toml`(cargo workspace)+ `pnpm-workspace.yaml`(pnpm)+ 根 `package.json/tsconfig.json`。
- ✅ 插件外壳(ADR-0022):`.claude-plugin/plugin.json` + `skills/understand-book/SKILL.md`(`/understand-book` 入口占位)+ `agents/{pass1,pass2}.md` 占位。
- ✅ Rust 权威 schema `crates/base-schema`(LidNode/GraphNode/GraphEdge/ReadOnlyBase)→ ts-rs 生成 8 TS 到 `packages/core/src/generated/`。
- ✅ TS 侧 `packages/core`:zod 自检 + sample 构造 + vitest 产 fixture。
- ✅ **三道闸全绿**:`cargo test -p base-schema` / `pnpm -C packages/core test` / `pnpm -C packages/core typecheck`。
- ⏳ 判据②(`/understand-book` 被 Claude Code 识别)需 harness 内加载插件验证(未自验)。

## 下一步(可直接接手)
1. **commit S0**(用户标准:建完 commit、不 push,等发话再 push):`git add -A` → guard `.env` 未暂存 → commit。
2. 起 **S1**(导入+段级 LID 切分,TS,`[ADR-0008]`):在 `skills/understand-book/split-lid.mjs` 实现忠实块映射切段(epub h1/h2/p.zw/blockquote/pre),吃切片0 用书(《游戏编程模式》epub),产 `LidNode[]`,跑分区不变式自检(全覆盖+无重叠+同级递增+LID 唯一)。
3. S1 产物喂回 `crates/base-schema` 的 `LidNode` 类型(已就绪),跨语言闸继续兜底。

## 未提交 / 未完成
- S0 全部代码未 commit。
- `.env`(opencode/glm-5.1,= 阅读器自身 agent 后端,与我们读时后端无关)已 gitignore,不上传。
- 跨语言 fixture `crates/base-schema/fixtures/sample-base.json` 已 gitignore(vitest 重生成)。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0022。
- 实测数字、前端选型 PENDING(同前)。

## 切片0 已定输入
- 书:`C:\Users\Lenovo\Downloads\游戏编程模式 (…z-lib.sk).epub`(前言+6 部分+20 章;块标记 h1/h2/p.zw/blockquote/pre/img;中文,句切留切片1+)。
- 读时后端(S5/S6 NativeAdapter)= **Claude Opus 4.8** = `claude-opus-4-8`(Anthropic 原生 tools+JSON,key 留本地)。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 实现技术栈/打包形态。
2. `docs/切片方案-切片0样板间.md` — 实施入口(S0 已扩为骨架+插件外壳+schema;S1–S8)。
3. `docs/代码链路.md` — S0 改动账本(文件:符号)。
4. `需求文档-V3.md` / `CONTEXT.md` — 工程契约 / 术语表。
5. `docs/adr/0001`–`0022` — 22 条决策(0021 技术栈、0022 插件打包/一句话启动、0008 切分↔本书块映射)。
6. `memory/quality-over-speed-correct-context.md`(最高原则)/ `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- ADR-0022:预构建打包为本地 Claude Code 插件外壳(U-A 同构),`/understand-book` 一句话启动 = SKILL.md frontmatter name;读时启动亦走插件 skill 但产品与 harness 脱钩;「官方」非必需。
- 切片0 用书 = 《游戏编程模式》epub;读时后端 = Claude Opus 4.8。
- ts-rs `export_to` 相对 `src/` 目录解析(非 crate 根)—— 用三级 `../../../` 落到 `packages/core/src/generated/`(已实测,记 ADR-0021「何时回头」侧)。
