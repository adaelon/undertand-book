# ADR-0037 住户教学整形 route 投影(book.guided_route_from)+ technical_learning policy 同构 synthesize

## 背景

ADR-0034 决策4/决策7:`route_from` = Core 结构排序,**教学 reorder/过滤 = technical_learning policy**,"人拿 policy 整形过的 route、外部 agent 拿裸 Core route"。P3-1 把人投影带读定为 **prompt 驱动 LLM 自调裸 `route_from`**。P3-3 要落地教学整形,而切片方案 P3 判据要求"**policy 教学排序确定性可单测**"。张力:确定性整形函数怎么接入 prompt 驱动的带读。承 ADR-0033 Core/Profile 分离、ADR-0035 `book_guide`(访客整形投影)。

## 决策

1. **新增 runtime LLM 可见工具 `book.guided_route_from(at, k?)`** = `route_from`(Core)+ technical_learning 教学整形;**裸 `book.route_from` 仍在**(访客/高级用)。住户带读 prompt 改优先调 guided 版。= ADR-0034 决策7"人拿整形过的 route"的兑现,与 ADR-0035 `book_guide`(访客版)对称。

2. **整形 = 确定性 runtime 函数(零 LLM,可单测),与 `book.synthesize`「Core+policy」同构**(ADR-0033 决策5):reorder 按教学优先序重排 5 类分组、过滤剔空组。**落 runtime,不进 read-tools Core**(守 Core/Profile 分离,route 内核不染 profile 偏见,ADR-0034 否决)。

3. **返回有序分组 `GuidedFrontier`**(`Vec<{category, steps}>`,保分组导航语义、体现教学序),**不平铺 ranked list**(守 ADR-0034 决策5 否决)。

4. **默认教学序中性占位**:无 reader_profile 时 `continue > back > concretize > forward > cross`(主线推进,不假设新手);**常量化,实测/profile 回填**。reader_profile 个性化(新手 back 置顶 / 已懂跳过,ADR-0034 决策4)留 **P4**。

## 命门

整形必**零 LLM、确定性**:守 ADR-0034"route 确定性 LID"红线在 policy 层的延续。profile 偏见只活在 runtime policy,**绝不渗进 read-tools `route_from` 内核**——否则破 Core/Profile 分离,且访客会拿到被污染的 route。

## 否决

- **Y3 带读改 Rust 编排**(route_from→整形→喂 prompt):推翻 P3-1 已冻结的 prompt 驱动方向,需改 FrozenIntent,代价大。
- **Y2 整形函数不接入**(仅 prompt 复述序):函数无生产调用点近 dead code,判据"作用在分组上"无真实落点。
- **整形进 read-tools `route_from`**(加 profile 参):ADR-0034 已否决 profile 焊进 route 内核。
- **平铺 ranked list**:丢导航语义(ADR-0034 决策5)。

## 何时回头

- 默认教学序 `continue>back>concretize>forward>cross` 是否合理(实测带读体验回填)。
- reader_profile 个性化整形(P4)的接入点。
- `guided_route_from` 是否也开放给高级外部访客(对称 ADR-0035 何时回头"裸 route 给高级访客")。

## 影响

- `crates/runtime` 新增 `book.guided_route_from` 命令(`tool_specs` + `dispatch` + REST GET,人机对称 ADR-0007/0028)+ 确定性整形函数 + `GuidedFrontier` 类型(ts-rs 导出前端)。
- P3-1 带读 SYSTEM_PROMPT 改优先 `book.guided_route_from`(裸 route_from 降为底层/访客)。
- 不改 ADR-0034/0035 正文;本 ADR 是 ADR-0034 决策4/7 在"住户教学整形落点"维度的兑现。
