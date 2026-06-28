# SESSION_CHECKPOINT — 2026-06-28 (P3-1✅+P3-2落档+P3-3✅ 已 push,下一步 P3-2 prompt / P3-4 前端)

## 新鲜度自检
- 写入时最新代码 commit: 4e97ac7 feat(runtime,server): P3-1 带读骨架 + P3-3 教学整形 policy;P3-2 落档
- **已 push 到 origin/main(干净,无未提交代码)**。本 checkpoint 之后可能再带一条 `docs: 刷新 checkpoint` commit;读入时以 `git log -1` 为准。
- 注:推送走代理 `http://127.0.0.1:7897`(默认 :10809 不通,用 `-c http.proxy=http://127.0.0.1:7897 -c https.proxy=...` 覆盖推)。

## 当前在做什么
P3 人投影主动带读(消费 P8 route + ADR-0034/0036/0037)。**§0 架构方向**:复用 `run()`+SYSTEM_PROMPT 驱动,route_from 是确定性 Core,带读策略 LLM policy,Rust 仅确定性兜底。A4 拆 4 子刀:
- **P3-1 带读骨架**:✅ 已 push。
- **P3-2 反馈消歧**:范围已落档,**裸「没懂」兜底推迟 P4**;实做仅剩 NL→`{轴+类别}` + viewport re-sync(均 prompt)。**未开工**。
- **P3-3 教学整形 policy**:✅ 已 push(新工具 `book.guided_route_from` = route_from + 教学整形,ADR-0037)。
- **P3-4 Vue 带读 UI**:未开工。

## 下一步(可直接接手)
1. **P3-2 实做(纯 prompt 刀)**:`crates/runtime/src/orchestrator.rs:SYSTEM_PROMPT`(L263 带读段)强化——带读收到 NL 提问据语义定 `{导航轴→guided_route_from 类别 / 讲法轴→book.synthesize 调表达}`(ADR-0036 决策2);每回合 `reader.state()` anchor 偏离上次停靠点=用户自己导航走→静默跟脚(rebase route 起点,不打扰;决策5)。**B2**:prompt 行为无法 cargo test,管道已 P3-1 测覆盖,靠真 LLM 验。判据见 ADR-0036 决策2/5。
2. **或 P3-4 Vue 带读 UI**:前端带读交互(停靠点呈现 + 继续/换路/退回);消费 `packages/web/src/generated/GuidedGroup.ts`(已就位);REST `GET /book/guided_route_from?at=`。承切片1 前端范式(`packages/web` Vue/Vite)。
3. **(正交)PB4** profile sidecar build smoke,独立未做。

## 未提交 / 未完成
- 无未提交代码(4e97ac7 已 push)。本 checkpoint 刷新为独立 docs commit。
- 保持 untracked:`参考*.md`、`agent交互书.md`、`docs/预购建流程.md`、`.fluid/`。
- 待办(非阻塞,承 P8/ADR-0037):① ADR-0034「REST 自动 GET」措辞→「手工 wiring」;② nearest_valid_lid 错误增强(需扩共享 ToolError);③ route 权重/距离/前沿规模 + **默认教学序**实测回填(ADR-0037 何时回头)。

## 冷启动读序
1. `docs/adr/0034-route导航原语-...md` — route 机制 + 两投影。
2. `docs/adr/0037-住户教学整形route投影-...md` — guided_route_from + policy 同构 + 中性序(P3-3 依据)。
3. `docs/adr/0036-反馈信号模型-...md` — 反馈 5 决策 + 影响段排期(裸兜底推迟 P4,P3-2 依据)。
4. `docs/切片方案-profile深路径.md` P3(L533)+ P3 A4 拆分小节。
5. `docs/代码链路.md` 末两条(P3-1 / P3-3)+ P8-1/2/3。
6. (代码)`crates/runtime/src/lib.rs`:`technical_learning_reorder`/`guided_route_from`/`TEACHING_ORDER`;`orchestrator.rs`:`SYSTEM_PROMPT`(L263)、`run()`(L580)、`tests::{guided_read_one_stop_pipeline,dispatch_guided_route_from_*}`;`crates/server/src/lib.rs:route_book`(guided leaf)。

## 本会话决策摘要
- **§0 架构方向**:P3 带读 = run()+prompt 驱动 + Rust 仅兜底(守 ADR-0034 决策2)。
- **裸「没懂」兜底推迟 P4**:memory 近似/visited 占位均「已读」判定失真违质量优先;须 P4 真 reading journey 历史(落档切片方案 P3 + ADR-0036)。
- **P3-3 + ADR-0037**:住户教学整形 = 新工具 `book.guided_route_from`(= route_from + runtime policy 整形,synthesize Core+policy 同构,零 LLM 可单测);默认教学序 `continue>back>concretize>forward>cross` 中性占位,reader_profile 个性化留 P4。**B2**:整形确定性可测,带读挑停靠点智能靠真 LLM 验。
