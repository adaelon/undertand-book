# ADR-0031 人的自由高亮:段内字符区间(UTF-16 偏移)/ memory Record 加可选 range / 兑现冻结 `reader.highlight(lid, range?)`

状态:已接受(2026-06-24,用户拍板「精确字符区间」;补切片1 S10d/S10f 把高亮做成整段的不足)

## 背景
切片0/切片1 的 `reader.highlight(lid)` 只能高亮**整个 LID 段**(content=该段全文,无段内位置)。用户要求**自由高亮**——选中段内任意文字、可删可改。V3 §4.2 **冻结契约本就把 `reader.highlight(lid, range?)` 的 `range?` 列入签名**,只是切片0 没实现;§4.3 的 record 模型却没有 range 字段。本 ADR 补这个缺口:定自由高亮的偏移口径与持久化模型。

## 决策
1. **区间口径 = 相对该 LID 自身文本的 UTF-16 code unit 偏移 `[start, end)`**。承 [[ADR-0024]] 全项目 UTF-16 口径——DOM 选区偏移 / JS `string.slice` / Rust `encode_utf16` 三者同为 UTF-16 code unit,前端捕获、后端切片、前端重绘**零换算一致**。**不**用相对全书 source 的绝对偏移(那是 `Span` 的口径,段内高亮用段内相对偏移更稳:段移动不失效)。
2. **持久化 = memory `Record` 加可选 `range: Option<TextRange{start,end}>`**(`#[serde(default, skip_serializing_if)]`,向后兼容:老记录无此字段=None)。`content` = 选区子串(供 recall 展示 / citation),`range` = 重绘位置。守「标注单源=记忆层」([[ADR-0015]]),不在前端另存。
3. **`reader.highlight(lid, range?)`** 接 range:`Some` → 按 UTF-16 切该段子串作 content + 存 range;越界 → `INVALID_RANGE` 不降级;`None` → 退回整段高亮(向后兼容,agent 高亮走此路)。**兑现 §4.2 冻结的 `range?` 参数,非破约**。
4. **content-address mem_id 纳入 range**:`mem_id = hash(book|type|anchor|content[|start:end])`——range 段**仅当 Some 时追加**(None 时哈希与旧版逐字节相同 ⇒ 老 note 的 mem_id 不变、upsert 幂等不破)。理由:同段同子串不同位置(如两个「the」)需是两条不同高亮,content 不足以区分,range 入址保唯一。
5. **「修改高亮」= 删旧 + 重选新**(复用内容寻址 upsert 语义,同 [[ADR-0030]] 笔记编辑):高亮无可编辑正文(content=选区原文),改 = 重新框选,前端 `memory.delete(old)` + `reader.highlight(new_range)`。
6. **agent 高亮维持整段**(range=None):agent 不做像素级选区,整段语义足够;自由段内高亮是人的交互能力。守人机对称命令面无特供([[ADR-0007]])——agent 只是不传 range。

## 命门
- **段内相对偏移 + UTF-16**:三处(DOM/JS/Rust)同口径,无转码裂缝;相对段而非全书,段在书内位移不致高亮错位。
- **range 入 mem_id 仅在 Some 时**:既保高亮唯一,又不动老 note 的内容寻址(向后兼容硬约束)。
- **range 是 runtime 记忆层扩展、非只读基座**:守 [[ADR-0006]] 物理隔离;§4.2 早留 `range?`,模型补字段是兑现非扩约。

## 否决
- 全书绝对 source 偏移作 range(段位移即失效;与 Span 口径混淆)。
- range 存前端交互层 / DOM(破标注单源=memory [[ADR-0015]])。
- 高亮可编辑 content(content=选区原文,改=重选,决策5)。
- agent 也产段内 range(切片1 不需要;留实测)。

## 何时回头
- 跨段高亮(选区跨多个 LID):切片1 限单 LID 内;跨段留后(拆成多条或引区间链)。
- 重叠高亮的渲染与点选歧义(前端 H2 先合并区间渲染、列表管理单条)。
- 高亮颜色 / 分类标签(切片1+)。

## 影响
- **改 memory**:`Record`/`SaveInput` 加 `range`;`content_mem_id` 纳入 range(仅 Some)。
- **改 reader**:`highlight` 签名加 `range: Option<(u32,u32)>` + UTF-16 切片 + 越界 `INVALID_RANGE`。
- **改 server**:`/reader/highlight` body 收 `range?:{start,end}`。
- **改 runtime**:`orchestrator` dispatch `reader.highlight` 传 `None`(agent 整段)。
- **前端**(H2):段内选区捕获→偏移、`<mark>` 精确重绘、删除/重选。
- **承**:[[ADR-0024]](UTF-16 口径)/ [[ADR-0015]](标注单源·effect·禁降级)/ [[ADR-0006]](记忆物理隔离)/ [[ADR-0007]](人机对称)/ [[ADR-0030]](标注编辑=删+建)/ V3 §4.2(冻结 `range?`)。
