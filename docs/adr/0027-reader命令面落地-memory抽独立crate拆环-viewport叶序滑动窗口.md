# ADR-0027 reader 命令面落地(S7):memory 抽独立 crate 拆环 + viewport 叶序滑动窗口 + manifest 移出外层工具集

状态:已接受(2026-06-23,切片0 S7 §0.5 对齐 + 真跑回填)

## 背景
[[ADR-0007]] 定阅读器命令优先、人机同命令面;[[ADR-0015]] 定 `reader.*` 返 effect、标注单一真相源=记忆层。S7 落 `reader.*` 闭环四动作(gotoLid/scroll/highlight/note + state),接进 [[ADR-0026]] 的外层 E 编排 loop,兑现切片0 总判据第 3 条「agent 经命令面跑通问→跳转→高亮→记笔记」。本 ADR 记四处工程决策:reader 选址(逼出 memory 拆 crate)、headless viewport 模型、reader 标注委托落地、真跑暴露的两处可用性修复。

## 决策
1. **reader 落独立 crate `crates/reader` + memory 从 runtime 抽独立 crate `crates/memory`**:
   - reader 须委托 `MemoryStore`(note/highlight 持久化 + 渲染读 recall),而 orchestrator(runtime)须调 reader 四工具才能真跑闭环 ⇒ 若 reader 依赖 runtime、runtime 依赖 reader = **Cargo 循环依赖**(crate 间强制 DAG)。
   - 打破环:把 `memory` 从 runtime 内 mod 抽成独立 crate,`reader` 与 `runtime` **共同依赖** `memory`。依赖图:`memory→read-tools`,`reader→{read-tools, memory}`,`runtime→{read-tools, memory, reader}`,无环。
   - 抽 memory 同时兑现 [[ADR-0006]]:记忆层本就是「用户私有·跨书·与只读基座物理隔离」的独立模块,独立 crate 比埋在 runtime 内更贴合其地位。
2. **headless viewport = 叶序滑动窗口**:`viewport={anchor_lid, visible_lids}`(V3 §4.2 只定形状)在无真实 GUI 下定义为——以 anchor 所在叶为中心,按全书叶 LID 物化路径序取前后 `radius` 个叶。`scroll(delta)` 沿叶序 clamp 移动锚点;`gotoLid` 叶→锚该叶、容器→锚到子树第一个叶。`radius` 切片0 占位(DEFAULT_RADIUS=3),实测回填。
3. **reader 标注委托 memory + 渲染读 recall(标注单源)**:`reader.note/highlight` 是薄入口,持久化委托 `MemoryStore::save`(返回的 mem_id 即 note_id/highlight_id);`render` 逐 visible_lid 读 `memory.recall(book_id, lid)` 画标注。标注归记忆层、不归 reader 会话实例(测试:换新 Reader 实例对同 store 渲染仍见标注)。承 [[ADR-0015]] 决策2、[[ADR-0006]]。
4. **真跑暴露的两处可用性修复**([[ADR-0026]] 何时回头延伸):
   - **book.manifest 移出外层工具集**:真跑实测 glm-5.1 调一次 `book.manifest`(返回全树 3399 LID)→ token 从 38k 飙到 205k 一次撑爆 budget。外层导航靠 `book.concept/context` 足够,manifest 不再暴露给外层 LLM;dispatch 保留防御分支(确定性测仍用它绕圈)。
   - **system prompt 强化 reader 指令**:glm 倾向用 `book.*` 反复读原文、把「高亮/记笔记」当成「读懂即可」而不调 reader 工具。prompt 明确「要求翻页/高亮/记笔记必须调对应 reader 工具,定位到 LID 即执行,不要反复读原文」。

## 命门
- **环是「reader 独立 crate」逼出的**:若 reader 只做 runtime 内 mod 则无环,但选独立 crate ⇒ 必须先抽 memory,否则 Cargo 拒编译。这是 crate(依赖单元,强制 DAG)与 mod(crate 内组织,无环限制)的本质区别。
- **抽 memory 是纯重构**(守 A3):零行为变更、6 个测试随文件搬走、全 workspace 仍绿,唯一变化是 `MemoryStore` 导入路径 `runtime::memory`→`memory`(编译器兜底漏改)。
- **标注单源在物理层兑现**:reader 不持有标注字段,渲染每次现读 recall ⇒ 不可能出现 reader 本地标注与记忆层不一致(防双所有者)。
- **manifest token 炸弹是真跑才暴露的**:确定性测无法发现(FakeAdapter 不计真实 token);印证 B2「真实数据跑一遍看真实产出」的必要。

## 否决
- **reader 不接 orchestrator、独立 demo 驱动闭环**:闭环不经真实 agent(=E loop),判据「agent 经命令面跑通」打折。
- **回退 reader 进 runtime 当 mod**(无环最短路):违用户已选「reader 独立 crate」;且 memory 留在 runtime 错失独立地位。
- **memory 类型抽 crate 但 MemoryStore 留 runtime**:reader 仍要 MemoryStore 具体类型,半抽不解环。
- **viewport=锚点子树**:gotoLid 到大章时 visible 集巨大、scroll 语义弱;叶序滑动窗口对 agent re-sync 更明确、scroll 自然。
- **viewport=仅锚点**:re-sync 信息过少,render 上下文不足。
- **manifest 留外层 + prompt 警告慎用**:依赖 LLM 自律,真跑已证不可靠(它主动调了);确定性移除更稳。

## 何时回头
- `DEFAULT_RADIUS`(叶序窗口半径)实测回填:多大窗口对 agent re-sync / render 最合适。
- **glm-5.1 reader.* 原生 tools 行为**:真跑观察模型是否稳定调 reader 工具完成闭环(prompt 强化后);若仍不稳,评估更强约束 / few-shot,不回退命令面设计。
- 外层 `max_turns`(12)/`token_budget`(120k)实测:真跑触顶频繁 → 回填 [[ADR-0016]];manifest 移出后 token 压力缓解,观察新基线。
- reader 全集(openPanel/closePanel 面板系统)、段内字符 range、真 GUI 渲染层:切片1+。
- `UB_TRACE` env-gated loop trace 设施:切片1+ 评估升级为结构化日志。

## 影响
- **新增 `crates/reader`(reader 命令优先 core)+ `crates/memory`(从 runtime 抽出)**;runtime 工具集扩入 reader.* 五工具、移出 book.manifest。回填 V3 §4.2(reader.* 落地)。
- **承** [[ADR-0007]](命令优先·人机对称)/ [[ADR-0015]](reader 返 effect / 标注单源 / 错误信封)/ [[ADR-0006]](记忆层独立·物理隔离)/ [[ADR-0026]](外层 loop / 工具集 / 双重停机)/ [[ADR-0008]](叶序=物化路径序)。
- **不回填 CONTEXT**:viewport / 叶序滑动窗口 / crate 拆分是既有术语「命令面」「reader.*」「记忆层」的实现细节,守 [[ADR-0021]] CONTEXT 纯术语纪律(承 [[ADR-0024]]/[[ADR-0025]]/[[ADR-0026]] 先例)。
- **切片0 总判据第 3 条兑现**(确定性闭环测);真跑收敛性 / 参数实测续 S8。
