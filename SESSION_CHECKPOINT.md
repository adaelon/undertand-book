# SESSION_CHECKPOINT — 2026-06-22(S0 完成并 push;待起 S1)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 读入时对比 `git log -3`:最新提交应为「S0 插件命名空间修正(skills/build)」;若不一致以 git log 为准。

## 当前在做什么
切片0 **S0 已完成并 push**(monorepo 骨架 + 插件外壳 + TS↔Rust 基座 schema 链路,三道确定性闸全绿)。下一步起 **S1**。

## S0 状态(已 push)
- ✅ monorepo 三面:`Cargo.toml`(cargo workspace)+ `pnpm-workspace.yaml` + 根 `package.json/tsconfig.json`。
- ✅ 插件外壳(ADR-0022):`.claude-plugin/plugin.json`(name `understand-book`)+ `skills/build/SKILL.md` + `agents/{pass1,pass2}.md`。
- ✅ Rust 权威 schema `crates/base-schema` → ts-rs 生成 8 TS 到 `packages/core/src/generated/`;TS 侧 `packages/core` zod 自检 + sample + vitest fixture。
- ✅ 三道闸:`cargo test -p base-schema` / `pnpm -C packages/core test` / `pnpm -C packages/core typecheck`。

## 插件加载 & 命令(实测口径)
- 加载:`claude --plugin-dir "E:\allwork\download\agent\understand-book"`(开发期,无需 marketplace);改后 `/reload-plugins` 热加载。
- 命令:插件 skill 强制命名空间 `/<插件名>:<skill文件夹名>` ⇒ 预构建入口 = **`/understand-book:build <epub|md>`**(裸 `/understand-book` 插件形态没有);读时入口将是 `/understand-book:read`(skills/read/,留 S7)。
- 判据②(命令被识别)需在 harness 内 `--plugin-dir` 实测确认(`/help` 看命令,`/agents` 看 pass1/pass2)。

## 下一步(可直接接手)
1. 起 **S1**(导入+段级 LID 切分,TS,`[ADR-0008]`):在 `skills/build/split-lid.mjs` 实现忠实块映射切段(epub h1/h2→章节、p.zw→段、blockquote/pre),吃《游戏编程模式》epub,产 `LidNode[]`(类型已在 `crates/base-schema` 就绪)。
2. 跑**分区不变式自检**(全覆盖+无重叠+同级数值递增+LID 唯一);非内容字节显式归类不静默丢。
3. 产物经跨语言闸兜底(serde 读 `LidNode[]` 零失配)。

## 未提交 / 未完成
- 无未提交(S0 + 命名空间修正本会话已 commit+push)。
- 判据②(插件命令识别)待用户 `--plugin-dir` 实测。
- `.env`(opencode/glm-5.1,= 阅读器自身 agent 后端,与读时后端无关)+ 握手 fixture 已 gitignore,不上传。
- 待人工 review:V3/架构蓝图/切片方案/ADR-0019~0022。实测数字、前端选型仍 PENDING。

## 切片0 已定输入
- 书:`C:\Users\Lenovo\Downloads\游戏编程模式 (…z-lib.sk).epub`(前言+6 部分+20 章;块标记 h1/h2/p.zw/blockquote/pre/img;中文,句切留切片1+)。
- 读时后端(S5/S6 NativeAdapter)= **Claude Opus 4.8** = `claude-opus-4-8`(Anthropic 原生 tools+JSON,key 留本地)。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 实现技术栈/打包形态。
2. `docs/切片方案-切片0样板间.md` — 实施入口(S0 已扩;S1–S8)。
3. `docs/代码链路.md` — S0 改动账本(文件:符号)。
4. `需求文档-V3.md` / `CONTEXT.md` — 工程契约 / 术语表。
5. `docs/adr/0001`–`0022`(0021 技术栈、0022 插件打包/命名空间、0008 切分↔本书块映射)。
6. `memory/quality-over-speed-correct-context.md` / `codex-memory-reference.md` / `understand-anything-reference.md`。

## 本会话决策摘要
- ADR-0022:预构建打包为本地 Claude Code 插件外壳(U-A 同构);**插件 skill 强制命名空间**,入口 = `/understand-book:build`(非裸名);`--plugin-dir` 加载;读时启动亦走插件 skill 但产品与 harness 脱钩。
- skill 文件夹 `understand-book` → 改名 `build`(避免 `/understand-book:understand-book` 双重)。
- 切片0 用书 = 《游戏编程模式》epub;读时后端 = Claude Opus 4.8。
- ts-rs `export_to` 相对 `src/` 目录解析,用三级 `../../../` 落到 `packages/core/src/generated/`。
