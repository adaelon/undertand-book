# SESSION_CHECKPOINT — 2026-06-29 (PB5 全 3 刀实现并 commit;下一步 真书真 LLM 端到端试跑)

## 新鲜度自检
- 写入时最新 commit: `fed9d48` feat(build): PB5-3c pass1-batch 改造消费 .build/pass1(本 checkpoint + SKILL/代码链路 doc 待与本盘一起 commit)。
- 读入以 `git log -3` 为准;若顶部已是 PB5-3d doc commit 即与本盘一致。
- push 走代理:`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push`(代理需在跑)。

## 当前在做什么
**先打磨核心、暂缓对外基建**(memory [[prebuild-polish-before-external-infra]]):P5/P7 暂缓。本会话把 **PB5 预构建跨会话续建**(ADR-0042)从纯落档**全部实现**:PB5-1 bookId 派生 / PB5-2 build-status 续建视图 / PB5-3a-d 续建 loop(emit-input+pass1-write 原子写+pass1-batch 消费+SKILL.md 契约)。全量 89 测试绿 + CLI 端到端烟测通过。

## 下一步(可直接接手,挑一条)
1. **真书真 LLM 端到端试跑**(PB5 的真正验证,memory 优先级):备一本真 md/epub → `tsx skills/build/build-status.ts <书>` 看窗口规模 → 逐窗 `emit-input` + subagent `pass1-local-extractor` 抽取 + `pass1-write` → `pass1-batch` 收口。看数十窗跨会话是否真跑通、锚定率、token 预算。
2. **零 LLM 先摸窗口规模**:`tsx skills/build/window-cli.ts <真书>` 看切分/窗口数,再决定试跑节奏。
3. **PB5 何时回头项**(ADR-0042):内容寻址续建 / Pass2·discourse 纳入同款续建 / id 漂移 orphan 实测。
4. 回主线 P 序列(P5 多 provider / P7 MCP 访客)——但 memory 说先打磨核心,真书没跑过前不建议。

## 未提交 / 未完成
- PB5-3d doc(SKILL.md + docs/代码链路.md + 本 checkpoint)**待 commit**(代码 PB5-1/2/3a/3b/3c 已分别 commit:c72e228/b065cdc/cf9624d/dbb4162/fed9d48)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 真书试跑用的真实 md/epub 尚未备(仅有 game-programming-patterns 的 4 窗 fixture 抽取样例,无源文)。

## 冷启动读序
1. `docs/adr/0042-预构建断点续跑-...md` — PB5 设计真相源(8 决策)。**先读**。
2. `skills/build/SKILL.md`「跨会话续建(冷启动契约)」段 — 已落地的续建 loop(build-status→emit-input→pass1-write→pass1-batch)+ 命门 + 铁律。
3. `skills/build/{build-status,emit-input,pass1-write,pass1-batch,load-book}.ts` — PB5 五脚手架现状。
4. `packages/core/src/{book-id,build-resume}.ts` + 同名 test — deriveBookId / pass1ContentHash / computeBuildStatus / buildPass1Artifact。
5. `docs/代码链路.md` 末 4 条(PB5-1/2/3a-c/3d)— 改动账本。
6. `docs/切片方案-profile深路径.md` PB5 段 — 骨架(PB0-3✅/P1-4✅/P8✅/PB5✅ / P5、P7 待做)。
7. memory: [[prebuild-polish-before-external-infra]](优先级)/ [[windows-cjk-path-tooling]](bookId fail-fast 由来)。

## 本会话决策摘要
- **PB5 实现完成**:ADR-0042 跨会话续建从落档到落地。逐窗原子落盘(命根)+ 存在性+content-hash 校验(位置 id 键·无状态位)+ agent 冷启动契约(SKILL.md loop)+ bookId slug 派生(非 ASCII fail-fast)+ pending 拒绝收口。命门=content_hash 由 TS 从窗口正文重算(`buildPass1Artifact`),agent 不手算。
- **PB5-1 落 `packages/core/` 非 `skills/build/`**(ADR 草图):纯函数属 core 且测试基建只覆盖 `packages/*`,放 skills 无 runner 覆盖违 A2。slugify 把 `.` 也当分隔符(防粘词)。
