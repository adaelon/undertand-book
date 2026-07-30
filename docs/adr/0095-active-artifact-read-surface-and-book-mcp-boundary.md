# ADR-0095 Active artifact read surface and Book MCP boundary

Status: Accepted, 2026-07-29.
Revises: ADR-0093 §§2、7、9 and ADR-0035/ADR-0089's Book MCP read surface.
Extends: ADR-0091's context fragments, demand-driven tools and bounded results.
Change type: 边界重构。

Reader 已能投影 active overlay,但 `/agent/chat` 与 Book MCP 都不能读取目标产物。用户已在 Codex task `019fac59-f620-7233-8332-03df320ca875` 接受所有本地 Book MCP 可据此推断当前目标的风险,并冻结 Routing Card、确定性搜索和有界读取方案。实施顺序见[切片方案](../切片方案-需求驱动产物Blueprint与Agent访问.md)。

### §1 Active + accepted 读取边界

**决策**:Resident 与绑定该书的 Book MCP 只读 current active + accepted snapshot。

**否决**:
- 继续只供 Reader 面板读取:Agent 无法利用已付费生成的结构化成果。
- 暴露 Intent、Plan、candidate 或历史 overlay:泄漏原始目标、执行细节与过期结论。
- 把产物复制到公共书目录:私人目标随书复制并分叉真相源。

**命门**:访问方必须绑定当前 OS 用户、当前书与 current source;无 active accepted overlay 时显式返回 `ARTIFACT_OVERLAY_UNAVAILABLE`。
**何时回头**:出现远程账户、团队空间或共享产物时,重新定义 ACL、发布、撤回与删除传播。

### §2 产物与书源证据分层

**决策**:产物负责导航推理,书源负责证明书中事实。

**否决**:
- 把产物记录直接当 source.present 证据:派生结论会伪装成作者原文。
- 完全忽略产物证据桥:Agent 仍需从全书重新检索。
- 自动把产物正文塞进来源弹窗:混淆产物陈述与规范原文。

**命门**:回答“产物是什么”可直接复述产物;回答书中事实必须沿 `evidence_lids` 重新取得 canonical Book evidence。
**何时回头**:未来引入人工审阅并可独立发布的知识产品时,另定义它自己的来源类型,不得借用 Book source。

### §3 Routing Card 与自动时机

**决策**:回合开始只注入有界 Routing Cards,相关时自动搜索。

**否决**:
- 注入产物目录:只能说明“有什么”,无法判断“何时有用”。
- 常驻注入 accepted 正文:无关问题承担隐私与上下文成本。
- 要求用户每次点名产物:Agent 无法主动利用已确认成果。

**命门**:Routing Card 不是证据;用户说“不用产物”时本回合禁用,要求原文时优先走 Book tools。
**何时回头**:真实路由评测显示卡片仍造成持续误调用时,调整字段或改成确定性候选过滤,不注入正文。

### §4 通用只读工具面

**决策**:Resident 与 MCP 共用 artifact list/search/read 合同和执行器。

**否决**:
- 每种 Blueprint 新增专用工具:工具面随类型增长并迫使客户端升级。
- 一次返回整个 accepted 文件:大产物会挤占活动上下文。
- Resident/MCP 各写一套查询:排序、分页与隐私门禁会漂移。

**命门**:只保留传输别名差异(`artifact.search` / `artifact_search`);list 仅用于显式枚举,search 返回有界记录,read 用于指定记录、续页、截断字段与关系展开。
**何时回头**:某个稳定形态无法通过通用 record/relation 合同表达高价值操作时,以独立 capability 评审。

### §5 确定性搜索与有界读取

**决策**:搜索采用可解释词法排序,不引入模型或向量召回。

**否决**:
- 只做字符串包含:中英文变体与多字段权重无法表达。
- 首版引入 embeddings:增加索引、模型、迁移和不可解释排序成本。
- 搜索所有 JSON 字段:内部 ID、digest、目标文本和 LID 字符串会污染召回。

**命门**:仅索引 Routing Card 与 Blueprint 声明字段;短语、规范化子串、中英分词/n-gram、字段权重和有限拼写容错均返回匹配原因。默认最多 3 条、总正文约 12 KiB;超限按 summary fields 截断。
**何时回头**:真实零命中/误命中集证明词法召回不足且有稳定客观评测时,才增加可关闭的语义召回层。

### §6 Resident 阶段暴露

**决策**:有 snapshot 时 `artifact.search` 直接替换 `book.synthesize` 的 Direct 名额。

**否决**:
- 先经 `tool.search` 发现 artifact.search:每个相关问题多一次无价值采样。
- 永远 Direct:无 overlay 的会话承担空能力和 schema 成本。
- 增加第九个 Direct 工具:突破 ADR-0091 的活动工具预算。

**命门**:`NO_OVERLAY` 时 list/search/read Hidden;`ROUTABLE` 时 list Deferred、search Direct、read Hidden;search 命中或 continuation 后 read 在下一采样 Direct,book.synthesize 降为 Deferred。
**何时回头**:固定评测证明该替换降低回答质量或增加总调用轮次时,重排 Direct 优先级,不复制工具合同。

### §7 Book MCP 静态暴露

**决策**:Book MCP 的 tools/list 始终列出三项 artifact 工具。

**否决**:
- 按 overlay 动态删减 tools/list:客户端无法区分能力不存在与当前无数据。
- 新建另一套私有 MCP:增加安装、发现和书绑定分叉。
- 给 MCP 自动注入 Routing Card:协议没有回合上下文,且会无调用泄漏内容。

**命门**:每次调用重新校验 book/source/active/accepted;只返回产物读取结果,永不返回 Intent、Plan、raw goal、mailbox 或历史 overlay。
**何时回头**:多用户远程 MCP 无法证明当前用户身份时,默认关闭 artifact 调用并另立认证 ADR。

### §8 List/read 分页与关系预算

**决策**:list 按 20/50 与 64 KiB 分页;read 最多 3 条、12 KiB,关系限 32 条并显式截断。

**否决**:
- 静默截断任意 JSON/字符串:会把结构完整性问题伪装成成功。
- 一条超限即扩大回合预算:让 Blueprint 上限绕过 Agent 上下文预算。
- 首版增加独立关系游标:在尚无真实关系分页评测前扩大合同。

**命门**:field paths 以 JSON Pointer 键返回;cursor 绑定 snapshot revision、operation 与 artifact,record ref 只随 book/source/artifact/payload 改变。
**何时回头**:真实产物证明 32 条关系不足或 Pointer-key 投影妨碍稳定消费时。
