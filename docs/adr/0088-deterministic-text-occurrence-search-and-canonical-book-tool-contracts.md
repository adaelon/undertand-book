# ADR-0088 Deterministic text occurrence search and canonical Book tool contracts

Status: Accepted, 2026-07-21.
Extends: ADR-0014, ADR-0024, ADR-0028, ADR-0033, ADR-0035, ADR-0077 and ADR-0086.
Change type: 边界重构。

### §1 全文定位边界

**决策**:新增确定性叶子工具 `book.search_text`,直接在规范 `source.txt` 与 `base.json` LID/span 上枚举指定范围内的正文匹配。

**否决**:
- 用 `book.query`/`book.concept` 猜字符串地址:它们负责语义指代与图谱 occurrence,不保证字面完备。
- 只返回首次命中:首次、上一个、最近和全部都应是完整 occurrence 集上的调用方投影。
- 以 graph、向量库或 LLM 输出作为全文命中真相:都会把召回近似伪装成确定性定位。

**命门**:`exhaustive=true` 只承诺给定 query、match mode 与 scope 的**字面匹配完备性**,不承诺找齐“所有语义上相关的讨论”。
**何时回头**:真书性能数据证明加载时扫描无法满足交互延迟时,再评估从同一 source revision 派生的可重建索引。
**展开**:[确定性全文定位与 Book 工具契约单源切片方案](../切片方案-确定性全文定位与Book工具契约单源.md)。

### §2 occurrence、顺序与分页

**决策**:一次正文匹配就是一个 `TextOccurrence`;同一 LID 内重复匹配分别返回,跨叶命中保留全局 UTF-16 range 及全部叶 span 非空交集,父子节点不得重复计数。规范 Markdown 基座允许叶间存在只含 Unicode 空白的分隔 gap;非空白 gap 或任意叶重叠均使搜索 fail-closed。

**否决**:
- 只按命中 LID 去重:会吞掉同段重复出现。
- 按 LID 字符串排序:`1.10` 与 `1.9` 会违背阅读顺序。
- 用 `limit` 截断后声称“全部”:页面大小不能改变全集或总数。

**命门**:先按叶子 span 建立规范文档序并验证 span/UTF-16 边界/空白 gap;第一遍完整扫描聚合 `total_occurrences`、`total_lids` 与 section counts,第二遍只物化 cursor 指定页,不得按 occurrence 总数保留全部结果。匹配始终扫描完整 source,叶 ranges 不伪造 gap 归属。响应页由绑定 query+scope+order+source revision 的稳定 cursor 投影。源版本变化使 cursor 明确失效,任何扫描失败都返回错误而非不完整成功。
**何时回头**:只有调用方明确需要流式未知总数时,才另设计不带 `exhaustive=true` 的不同命令,不得稀释本工具语义。
**展开**:[确定性全文定位与 Book 工具契约单源切片方案](../切片方案-确定性全文定位与Book工具契约单源.md)。

### §3 匹配与证据边界

**决策**:首版只提供 `exact` 与版本化 `normalized` 两种确定性匹配;不提供 regex、模糊最近邻或公式语义等价搜索。

**否决**:
- 静默把 exact 降级为 fuzzy:用户无法判断“出现过”还是“模型觉得相近”。
- 把搜索 excerpt 当成完整语义上下文:命中只能证明该文本在该位置出现。
- 声称 lexical 与 semantic exhaustive 等价:别名、改写和隐含讨论不可能只靠全文字符串证明完备。

**命门**:`search_text` 的验证 ranges 可进入本轮证据账本,但只支撑“该文本在这里出现”;解释其作用必须继续调用 `book.text/context`,语义召回可与 `book.concept` 合并后逐项阅读,仍不得宣称语义完备。
**何时回头**:出现稳定 goldset 证明需要 LaTeX/MathML 规范化或语言形态学时,以新 match mode 和显式版本扩展。
**展开**:[确定性全文定位与 Book 工具契约单源切片方案](../切片方案-确定性全文定位与Book工具契约单源.md)。

### §4 Book 工具契约单一真相源

**决策**:建立版本化 `BookToolContractRegistry`,统一拥有逻辑工具 ID、typed input、JSON Schema、required/enum/default/validation、共享说明片段、结果契约引用、执行类别、surface aliases 与 capability tags。

**否决**:
- Resident `tool_specs()` 与 MCP `tools/list` 继续手写两份 schema:新增字段后必然再次漂移。
- 强制三表面使用同一工具名:命名是 transport 投影,不是逻辑契约。
- 为追求表面一致而向 MCP 暴露 reader/memory/private route:能力隔离是安全边界,不是 schema 漂移。

**命门**:`book.search_text`、`book_search_text` 与 `/book/search_text` 映射同一逻辑 ID;Resident、MCP、REST 只能从 registry 投影或解码。MCP capability filter 仍遵守只读访客边界;完整 Agent prompt 与 MCP 外部编排策略允许不同,但不得各写一份输入 schema。
**何时回头**:只有协议本身无法表达规范 schema 的字段时,才允许有记录的 transport override,并由 parity test 明示差异。
**展开**:[确定性全文定位与 Book 工具契约单源切片方案](../切片方案-确定性全文定位与Book工具契约单源.md)。

### §5 所有权与迁移顺序

**决策**:`book-tool-contracts` 无 I/O 层拥有跨表面命令契约;`read-tools::Book` 拥有确定性搜索;Runtime 与 Server 只负责执行编排和 Resident/REST/MCP 投影。

**否决**:
- 把搜索实现放进 MCP/server:Resident 和 REST 会再次复制行为。
- 把工具契约塞进持久 `base-schema`:命令版本与书基座 schema 生命周期不同。
- 同一切片同时迁移全部 schema 并加入新搜索行为:无法区分重构回归和功能错误。

**命门**:先 characterization 现有共同工具,再行为不变地引入 registry 和逐表面迁移,最后通过同一 registry 暴露 `search_text`;既有 MCP 缺失 required/enum 的弱 schema 按 canonical typed validator 收紧并单独验收。
**何时回头**:只有出现第二类非 Book 共享命令契约且重复机制已被证明时,才把该 crate 泛化为全命令面 registry。
**展开**:[确定性全文定位与 Book 工具契约单源切片方案](../切片方案-确定性全文定位与Book工具契约单源.md)。
