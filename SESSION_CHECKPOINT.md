# SESSION_CHECKPOINT — 2026-06-29 (PB5 跨会话续建已落档+commit;下一步 PB5-1 实现 或 真书试跑)

## 新鲜度自检
- 写入时最新 commit: `2f19d43` docs(adr-0042,build): PB5 预构建跨会话续建落档。
- 本 checkpoint 是其后唯一未跟踪改动;读入以 `git log -1` 为准。
- push 走代理:`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push`(代理需在跑)。

## 当前在做什么
**转向「先打磨核心、暂缓对外基建」**(见 memory [[prebuild-polish-before-external-infra]]):P5(多 provider)/ P7(MCP 访客)经讨论暂缓——系统从没在真书+真 LLM 端到端跑过(唯一产物是 13 行玩具)。本会话 §0.5 grill + 落档了 **PB5 预构建跨会话续建**(ADR-0042),**未写代码**。

## 下一步(可直接接手,挑一条)
1. **PB5-1 实现**(最小独立一刀):`skills/build/` 加 `deriveBookId(bookPath, override?)` 纯函数(文件名 slug ASCII-safe + `--book-id` 覆盖 + 非 ASCII fail-fast)+ 去 `pass1-batch.ts:48` 硬编码 `bookId="game-programming-patterns"` + vitest(slug/覆盖/报错)。
2. **PB5-2**:`skills/build/build-status.ts` 续建视图(重算窗口 + content-hash 校验 + 报 done/pending;夹具单测删窗 json / 改 source 失配)。
3. **PB5-3**:`emit-input.ts` + `pass1-batch.ts` 改造消费 `.build/pass1/*.json` + 逐窗原子写 + pending 拒绝收口 + SKILL.md 续建 loop(已写设计)。
4. **真书试跑**(零 LLM 先看):`npx tsx skills/build/window-cli.ts <真书.md|epub>` 看切分/窗口规模,再回来做 PB5。

## 未提交 / 未完成
- 无未提交代码(PB5 仅落档,已 commit 2f19d43)。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- PB5 全 4 子刀(含本 checkpoint 列的实现)待写代码;ADR-0042「何时回头」:内容寻址续建/跨版本增量/Pass2 续建/真书实测。

## 冷启动读序
1. `docs/adr/0042-预构建断点续跑-...md` — PB5 设计真相源(跨会话续建 8 决策)。**先读这条**。
2. `skills/build/SKILL.md` 末「跨会话续建(冷启动契约)」段 — agent 续建 loop + 铁律。
3. `docs/切片方案-profile深路径.md` PB5 段 + A4 三子刀 — 总骨架(PB0-3✅ / P1-4✅ / P8✅ / PB5、P5、P7 待做)。
4. `skills/build/pass1-batch.ts` — 现状(硬编码 bookId:48 / 末尾一次写,PB5 要改)+ `packages/core/src/{window,pass1-input,merge}.ts`。
5. `CONTEXT.md`「构建工作区」「跨会话续建」术语。
6. memory: [[prebuild-polish-before-external-infra]](优先级)/ [[grill-via-prose-not-multiplechoice]](协作)/ [[windows-cjk-path-tooling]]。

## 本会话决策摘要
- **ADR-0042**(commit 2f19d43):预构建跨会话续建 = 逐窗原子落盘(命根)+ 存在性+content-hash 校验(位置 id 键·无状态位)+ agent 冷启动契约(SKILL.md loop)+ bookId slug 派生(非 ASCII fail-fast)+ pending 拒绝收口。收回内容寻址。承 A4 防上下文断裂 / ADR-0012 不物化派生 / ADR-0038-39 砍过度工程。
- **优先级转向**:暂缓 P5/P7,先在真书上打磨预构建/工具/agent(memory 已存)。
