# ADR-0022 预构建打包为本地插件外壳:skill 一句话启动 + subagent 编排;读时启动亦走插件 skill

状态:已接受(2026-06-22,切片0 开工前 §0.5 打包形态共识)

## 背景
切片0 起 S0(搭骨架)前,需求方问:「我们还不是 Claude 官方 plugin,能否像 U-A 那样一句话就启动?」翻 U-A 真实插件目录(`E:\allwork\download\agent\Understand-Anything-main\understand-anything-plugin`)证实其机制:`.claude-plugin/plugin.json`(清单)+ `skills/understand/SKILL.md`(frontmatter `name: understand` → slash 命令 `/understand [path]`)+ `agents/*.md`(11 个 subagent)+ skill 内 `*.mjs`/`*.py`(确定性脚本)。[[ADR-0001]] 已定「本地 plugin 形态、与 U-A 同构、无托管服务端」,[[ADR-0003]] 已定「预构建绑 harness、读时与 harness 脱钩」,但**「构建管线如何被调起/编排、整体如何打包」**留白。本 ADR 钉死。

## 决策
1. **预构建 = 本地 Claude Code 插件外壳,U-A 同构**:
   - `.claude-plugin/plugin.json` = 插件清单(name `understand-book`)。
   - `skills/build/SKILL.md` = **预构建入口**。插件 skill **强制命名空间** `/<插件名>:<skill文件夹名>` ⇒ 命令 **`/understand-book:build [epub|md] [opts]`**(裸名 `/understand-book` 是 `.claude/` 标准配置才有,插件形态无);正文编排预构建管线(导入→LID 切分→窗口→Pass1/Pass2→merge+闸→产基座)。
   - `agents/{pass1-local-extractor,pass2-longrange-linker}.md` = LLM subagent(harness 供 LLM,[[ADR-0010]])。
   - skill 内确定性脚本(LID 切分/窗口/merge/闸/产基座,TS `*.mjs`)= S1–S3 落点。
2. **「官方」无关,无注册门槛**:本地插件目录 Claude Code 直接加载(本地路径,或 marketplace 指向本仓库),slash 命令即用。`plugin.json` 的 homepage/repo/license 纯元数据,非加载前提。
3. **读时启动亦走插件 skill**(类 U-A `/understand-dashboard` 拉 Vite):`skills/read/SKILL.md` ⇒ `/understand-book:read` 起 Rust localhost 服务 + 阅读器(留 S7)。**但 skill 仅作启动器**——服务拉起即独立存活,读时产品本体与 harness 脱钩([[ADR-0003]])。
4. **repo = 单 monorepo,三面并置**(承 [[ADR-0021]]):插件面(`.claude-plugin/` + `skills/` + `agents/`)+ pnpm workspace(`packages/`,TS 预构建)+ cargo workspace(`crates/`,Rust 读时),schema crate 经 ts-rs 桥接。

## 命门
- **一句话 = `/<插件名>:<skill文件夹名>`**(插件强制命名空间,由 `plugin.json` 的 name + skill 文件夹名共同决定),非额外注册;harness 读 SKILL.md 后编排 subagent + 跑确定性脚本。开发期 `claude --plugin-dir <repo>` 即加载,无需 marketplace。
- **预构建 LLM 来自 harness([[ADR-0003]])⇒ 必须是插件 skill(在 harness 内跑)**,不能是脱离 harness 的独立 CLI(那需自带 provider key,直破 [[ADR-0003]] 预构建绑 harness)。
- **读时 skill 仅启动器**:拉起 Rust 服务即退场,读时产品不依赖 harness 活着([[ADR-0003]] 脱钩);区别于预构建 skill(全程在 harness 内编排)。

## 否决
- **独立 CLI(`pnpm build-base <epub>`)**:脱离 harness 无 LLM 源,需自带 key,破 [[ADR-0003]];且丢「一句话 / subagent 编排」U-A 参照。
- **必须 npm 发布 / 官方 marketplace 才能用**:本地插件目录无需发布即可加载,过度门槛,违 [[ADR-0001]] 「开箱即用」。
- **读时也做成 harness 常驻插件**:破 [[ADR-0003]] 读时与 harness 脱钩,把消费门槛绑死在装了某 harness 的用户上。

## 何时回头
- 若未来要**免 harness 跑预构建**(无 Claude Code/Codex 的用户)→ 评估加一条自带 provider 的独立 CLI 旁路,但不替换插件主路径。
- 插件本地加载的具体安装方式(marketplace 配置 vs 本地路径 vs hook)→ 切片0 S0 实测定。

## 影响
- **回填切片方案 S0**:S0 从「纯 schema 链路」扩为「monorepo 骨架 + 插件外壳 + schema 链路」,新增插件外壳建立步 + `/understand-book:build` 入口占位(`skills/build/`)。
- **回填架构蓝图 §6**:加「打包形态 = 本地插件外壳」一句。
- **承** [[ADR-0001]](本地 plugin 形态、无托管)/[[ADR-0003]](预构建绑 harness、读时脱钩)/[[ADR-0010]](Pass1/Pass2 subagent)/[[ADR-0021]](单 monorepo、ts-rs 桥接);参照 U-A 插件目录结构(`.claude-plugin/plugin.json` + `skills/*/SKILL.md` + `agents/*.md` + skill 内确定性脚本)。
- **不回填 CONTEXT**:打包形态是实现细节,守 [[ADR-0021]] CONTEXT 纯术语表纪律。
