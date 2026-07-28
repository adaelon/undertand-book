# ADR-0083 无引用来源 Note 显式正文放置

Status: Accepted, revised 2026-07-28.
Extends: ADR-0015, ADR-0020, ADR-0030, ADR-0043 and ADR-0074.
Change type: 模型扩展。

### §1 Note 类型判定权威

**决策**:结构字段唯一决定 Note 类型。

**否决**:
- 以正文是否用 `>` 开头判型:内容编辑会改变记录类别并允许绕过放置门禁。
- 只凭 `anchor_lid` 新建 Note:无法证明位置来自引用选区或显式正文放置。

**命门**:`selection_context` 与 `note_placement` 互斥;新 Note 二者皆无即拒绝,旧记录二者皆无只作未知 legacy 读取。
**何时回头**:出现第三种可独立验证的 Note 来源时扩展结构字段,不恢复内容启发式。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §2 正文放置身份

**决策**:正文放置绑定来源与真实目标。

**否决**:
- 只存 `book_id + lid`:当前 `book_id` 可由文件名或参数复用,同 ID 重建会静默错锚。
- 同时接收 placement、anchor 与 citations:会产生多个可冲突的位置真相源。

**命门**:`lid_block` 绑定 `source_fingerprint + lid`;`pdf_region` 另绑定 map version/config、page 与 region;服务端复验后派生 anchor、citations 和 `mem_id`。
**何时回头**:只有 book identity 被强制改为 canonical source 内容身份,才评估移除独立 `source_fingerprint`。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §3 PDF 目标精度

**决策**:PDF 只接受可证明的实际 region。

**否决**:
- 取 primary、整 LID bbox、最近 region 或裸 bbox:会把系统猜测伪装成用户选择。
- 跨 LID 重叠时按数组顺序选取:source map 未定义该顺序的语义权威。

**命门**:v1 仅准 `word_mapped`;v2 准 `char_exact | region_exact`;fallback、partial、unmapped 均拒绝。同 LID 重叠按最小 bbox、稳定 region ID 归一,跨 LID 重叠拒绝。
**何时回头**:source map 提供更稳定且可验证的内容寻址 region 身份时替换现有元组。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §4 创建与层级所有权

**决策**:用户与 Agent Note 分层创建。

**否决**:
- 继续内容寻址 upsert:Agent 重复保存可能覆盖长期 Note,撤销时再删除用户原记录。
- 让放置草稿携带任意 layer:创建入口的所有权会被前端数据绕过。

**命门**:用户 Note 固定 `long_term`;Agent `reader.note(lid,text)` 创建 `session` 提议。创建只返回 `CREATED | EXISTING`;保留按当前 `mem_id` 原子 promote,只改变 layer。
**何时回头**:出现用户对单回合 Agent 的显式直接长期保存授权时另定义可验证契约。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §5 Note 原子重锚

**决策**:重锚保留同一 Note 的审计语义。

**否决**:
- `delete + save`:失败会丢记录并切断审计连续性。
- 复用 `memory.replace`:内容编辑与位置变更需要不同校验和权限边界。
- 碰撞时自动合并:当前没有稳定 note ID 或历史证明应保留哪一条。

**命门**:placement、anchor、citations 与 `mem_id` 一起改变;content、layer、generated_at、usage、source session 全部保留。碰撞失败时两条原记录均不变。
**何时回头**:出现 Note 深链、版本历史或协作引用时引入稳定 `note_id + revision mem_id`。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §6 MemoryDocument v3 与 legacy

**决策**:MemoryDocument 升级为 v3。

**否决**:
- 把字段偷偷加入 v2:旧程序会忽略未知字段并在后续写盘时抹掉 placement。
- 根据旧 anchor 或 `>` 自动补 placement:旧锚可能正是历史默认逻辑写错的结果。

**命门**:v2 原子迁移到 v3并保留 document/projection revisions,旧 Record placement 为 null;裸数组迁入 v3;未知版本 fail-closed。legacy 可读、可编辑,仅显式“放置到正文”后升级。
**何时回头**:只有存在用户确认或可验证的历史放置证据时允许批量迁移。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §7 放置交互模型

**决策**:放置采用单草稿点选会话。

**否决**:
- 同时维护多个待放置 Note:产品只需要当前短生命周期动作,列表会引入额外管理语义。
- 首版实现拖拽或键盘目标导航:收益不足以覆盖第二套手势与焦点模型。

**命门**:全局最多一个 `NotePlacementDraft` 和一个控制器,草稿绑定书、surface 与来源指纹;Pointer Events 点选真实目标。无效点击继续放置;取消、新草稿、切书或关闭 Reader 丢弃草稿,明确写失败例外保留。
**何时回头**:真实可用性或无障碍需求证明点选不足时另开输入适配切片。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §8 提交与歧义恢复

**决策**:有效目标点击是不可撤销提交点。

**否决**:
- SAVING 期间继续允许取消:客户端无法保证已经发出的磁盘 mutation 被撤销。
- 为本切片引入持久幂等回执:会把局部 Note 功能扩大为通用操作日志系统。

**命门**:提交前最新明确操作可抢占;SAVING/RECONCILING 后锁定。明确错误回到草稿,断连或无响应先刷新原书权威状态;首次创建靠 `CREATED | EXISTING` 幂等,重锚不得盲重试旧 `mem_id`。
**何时回头**:离线队列或跨设备 mutation 成为产品需求时引入持久操作身份。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。

### §9 双格式能力与投影

**决策**:Markdown 与 PDF 独立启用和投影。

**否决**:
- 跨格式首次放置或重锚:当前产品没有该迁移场景。
- stale 时换到最近位置:会把失效状态隐藏成错误成功。

**命门**:当前 surface capability 未就绪即禁用入口且不建草稿。`lid_block` 只在 Markdown 内联,`pdf_region` 只在 PDF 内联;其他 surface 与 stale 来源/map 仅进 Notes 列表,用户可显式重新放置。
**何时回头**:产品引入显式格式切换或来源迁移时重新定义跨格式语义。
**展开**:[无引用 Note 显式正文放置切片方案](../切片方案-无引用Note显式正文放置.md)。
