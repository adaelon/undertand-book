# 切片方案 - 无引用来源 Note 显式正文放置

> 定位:取消无 quote source 的 Agent Note 默认锚定,改为用户通过单一放置会话把 Note 放置草稿或已有无引用 Note 显式绑定到真实正文目标后再创建/重锚。
> 冻结决策:[ADR-0083](adr/0083-unquoted-note-explicit-body-placement.md)。
> 状态:NP0R、§0.5、NP1a-NP1c、NP2a-NP2c、NP3a-NP3c 与 NP4 均已完成;Markdown/PDF capability 均已启用。
> 格式边界:Markdown 与 PDF 各自完整支持该能力;共享模型、状态与 mutation 语义,不定义跨格式放置、迁移、重锚或会话延续。

## 0. 冻结边界

1. Note 类型只由结构字段决定:`selection_context` 表示引用型,`note_placement` 表示正文放置型,二者互斥。
2. 正文是否以 `>` 开头不再承担类型或权限语义,只可作为展示/legacy 提示。
3. 新 Note 若既无 `selection_context` 又无 `note_placement`,服务端必须拒绝;旧记录同形状时只作未知 legacy 兼容读取。
4. Agent 回答无引用摘录不得从 `questionAnchorLid`、`selectedLid`、`viewport.top_lid` 或最近可见 LID 取存储锚。
5. Agent 回答无引用摘录先成为前端唯一的 `NotePlacementDraft`;有效目标提交前 memory mutation 为零。
6. 用户创建的 Note 固定为 `long_term`;Agent `reader.note(lid,text)` 创建 `session` 提议,用户保留后按 `mem_id` 原子提升。
7. `reader.note(lid,text)` 与正文块直接 Note 已有明确 LID,由服务端合成 `lid_block` placement,不进入草稿流程。
8. `memory.save(type="note")` 不接受仅含 `anchor_lid` 的新 Note;其他 memory 类型不受影响。
9. Markdown 只接受 Pointer Events 实际点中的真实 `[data-lid]` 正文块,NoteCard 与工具控件不属于目标。
10. PDF 只接受实际点中的可信 source-map region,并保存来源、LID、map version/config、页和 region 身份;不保存裸 bbox。
11. v1 PDF 仅准 `word_mapped`;v2 准 `char_exact | region_exact`;fallback、partial、unmapped 均拒绝。
12. 已有正文放置型 Note 可同格式重锚;legacy Note 可显式“放置到正文”;带 `selection_context` 的 Note 仍走显式重新选择。
13. 重锚必须原子更新 placement、anchor、citations 与 `mem_id`,不得 `delete + save` 或复用 `memory.replace`。
14. `memory.replace` 只编辑内容并继承 placement;内容改成或移出 blockquote 均不得改变类型。
15. 全局最多一个草稿与一个放置控制器;首版只支持鼠标、触屏、手写笔的点选,不实现拖拽和键盘目标导航。
16. 取消、新草稿、切换书/表面或关闭 Reader 会在提交前丢弃草稿;无效点击继续放置;明确写入失败保留草稿重试。
17. 点击有效目标即进入不可撤销提交;SAVING/RECONCILING 阶段禁止取消、替换或重复提交。
18. Markdown 与 PDF capability 独立启用;未就绪的当前表面禁用入口且不创建草稿,不得回退默认锚。
19. placement 必须绑定当前 canonical `source.txt` 的 `source_fingerprint`;失配时只进 Notes 列表,不得在旧 LID/region 投影。
20. 老记录不自动补 placement;旧锚、blockquote 或附近正文都不是可验证迁移证据。

## 1. 当前代码链路与根因

| 环节 | 当前实现 | 本方案边界 |
|---|---|---|
| 问答上下文 | `App.vue:submitAgentMessage` 用 draft/selected/top LID 生成 `questionAnchorLid` | 可继续服务问答,不得成为无引用 Note 存储位置 |
| Agent 摘录保存 | `App.vue:saveAgentSelection` 在无 selection context 时回退 `questionAnchorLid` | 改为创建 `NotePlacementDraft`,目标确认前零 mutation |
| Memory 写入 | `/memory/save` 接收 `anchor_lid`;`save` 是内容寻址 upsert | Note 改为结构字段判型和 create-only 语义 |
| Agent Note 保留 | Web 用旧 effect 的 LID/text 再次 save 到 `long_term` | 改为按当前 `mem_id` 原子 promote |
| Memory 文档 | `MemoryDocument` v2;Record 无 placement | 升 v3并显式迁移,防旧程序抹掉新字段 |
| Book 身份 | `book_id` 可由文件名或 `--book-id` 派生 | placement 额外绑定 `source_fingerprint` |
| Markdown 目标 | `ReaderPane.vue` 渲染真实 `[data-lid]` 块 | 点选实际正文块,排除 NoteCard/工具控件 |
| PDF 目标 | `PdfReaderPane.vue` 已有坐标与 region 命中能力 | 返回实际 `{entry,region}`,不取默认 region |
| PDF 回显 | 现有 marker 依赖 selection ranges | 为 `pdf_region` 增对象级 marker;stale 时只进列表 |

现有错误链路:

```text
Agent answer selection(no quote)
  -> saveAgentSelection
  -> selectionContext = null
  -> turn.questionAnchorLid
  -> /memory/save(anchor_lid = question-time selected/top LID)
  -> 错误位置被持久化
```

目标链路:

```text
Agent answer selection(no quote)
  -> NotePlacementDraft(frontend only,one active)
  -> explicit point selection
  -> Markdown exact LID | PDF exact region
  -> Server validates source + target
  -> create Note(long_term)
```

## 2. 共享类型与判定

```ts
type NoteBodyPlacement =
  | {
      kind: "lid_block";
      source_fingerprint: string;
      lid: string;
    }
  | {
      kind: "pdf_region";
      source_fingerprint: string;
      lid: string;
      source_map_version: "pdf_source_map.v1" | "pdf_source_map.v2";
      source_map_config_hash: string;
      page_index: number;
      region_id: string;
    };

interface MemoryRecord {
  note_placement?: NoteBodyPlacement | null;
}

interface NotePlacementDraft {
  draft_id: string;
  book_id: string;
  surface_kind: "markdown" | "pdf";
  source_fingerprint: string;
  content: string;
  origin: {
    kind: "agent_answer";
    chat_session_id: string;
  };
}

type PlacementSubject =
  | { kind: "draft"; draft_id: string }
  | { kind: "record"; mem_id: string };
```

判定矩阵:

| `selection_context` | `note_placement` | 读取 | 新建 |
|---|---|---|---|
| 有 | 无 | `SELECTION_BACKED` | 允许 |
| 无 | 有 | `BODY_PLACED` | 允许 |
| 无 | 无 | `LEGACY_UNKNOWN` | 拒绝 `NOTE_PLACEMENT_REQUIRED` |
| 有 | 有 | 非法 | 拒绝 `INVALID_NOTE_PLACEMENT` |

- blockquote 不参与矩阵。
- 前端只镜像 affordance;后端是唯一写入/重锚判定权威。
- 客户端为正文放置型 Note 只提交 placement;不得同时提交 anchor/citations。
- Server 复验当前书后派生规范 anchor、citations 与 `mem_id`。

## 3. 来源、目标与投影不变量

### 3.1 来源身份

- `source_fingerprint = sha256(canonical source.txt bytes)`,由 Server 计算并复验。
- 放置会话捕获当前 fingerprint;提交时与服务端当前值不一致即 `STALE_NOTE_SOURCE`,mutation 为零。
- placement 序列化进入 `mem_id`;同内容同 LID但不同来源版本不得得到同一记录身份。
- 内容编辑保留原 fingerprint;失配记录仍可编辑内容,但保持 stale,直到用户显式重新放置。
- `reader.note(lid,text)` 由服务端填入当前 fingerprint。

### 3.2 Markdown 目标

- 只接受当前 DOM 实际点中的真实 `[data-lid]` 段、标题、公式或资源块。
- NoteCard、工具按钮、容器 LID、空白与最近块推断均不可接收。
- `lid_block` 仅在 Markdown 内联投影;其他表面只进 Notes 列表。

### 3.3 PDF 目标

- placement 身份为 `source_fingerprint + lid + map version/config + page_index + region_id`。
- v1 `word_mapped` 视为可放置;`line_fallback | block_fallback | unmapped/excluded` 拒绝。
- v2 `char_exact` 可作 LID/字符证据放置;`region_exact` 只声明对象位置,不产生字符引用;`partial | unmapped` 拒绝。
- 指针下无候选视为无效;同 LID 多候选取最小 bbox,同面积按稳定 region ID;跨 LID 多候选返回 `AMBIGUOUS_TARGET`。
- PDF marker 只从已复验 region 取 bbox;来源、map、region、LID 任一失效即 marker 为零。

## 4. MemoryDocument v3

```text
bare Vec<Record>
  -> v3(document_revision=1, projection_revision=1)

schema v2
  -> 保留 records/profile/review/exclusions/governance
  -> 所有旧 Record.note_placement = null
  -> 保留 document_revision/projection_revision
  -> 原子覆写为 v3

schema v3
  -> 正常读取

其他版本
  -> fail-closed
```

- schema 迁移不是领域 mutation,不得增加已有 revisions。
- placement 缺省时沿用旧 `mem_id` 规范输入;placement 存在时追加其规范序列化。
- 文档级 validator 允许 legacy records,避免一条旧 Note 阻塞所有其他 mutation。
- 新建 Note 的 placement 必填规则位于命令边界;读取或编辑 legacy 不触发自动迁移。
- v2 程序遇到 v3 必须因 schema mismatch 拒绝,不得忽略字段后写回。

## 5. Memory 命令契约

```text
memory.save(type="note", selection_context | note_placement)
  -> CREATED(record) | EXISTING(record)

memory.reanchor(mem_id, note_placement)
  -> UPDATED(new_record) | NOTE_REANCHOR_CONFLICT | STALE

memory.promote(mem_id, from="session", to="long_term")
  -> UPDATED(same_mem_id) | STALE

memory.replace(mem_id, content, selection_context?)
  -> 内容编辑或带引用 Note 的显式重新选择
```

### 5.1 创建

- `CREATED` 才写盘并生成可撤销 Agent effect。
- `EXISTING` 是零 mutation:不改变 layer、usage、时间或来源,也不生成撤销 effect。
- 用户放置命中既有 `session` Note 时显式 promote;命中既有 `long_term` 时视为幂等成功。
- `memory.save` 不再承担 layer promotion。

### 5.2 重锚

- 以旧 `mem_id` 作为预期版本;成功返回新 Record/新 `mem_id`,旧 ID 失效。
- 只允许正文放置型 Note 或 legacy 的显式类型转换;引用型 Note 走重新选择。
- content、layer、generated_at、usage 与 source session 完整保留。
- 新 `mem_id` 已存在时返回 `NOTE_REANCHOR_CONFLICT`;不合并、不删除、不覆盖。
- source stale 的旧记录可从 Notes 列表显式选择当前目标完成重锚。

### 5.3 提升与内容编辑

- promote 只按当前 `mem_id` 定位并只改变 layer;旧版本 ID 不得复活。
- Note 与 Highlight 可共用 promote 命令,但本切片不改变 Highlight 创建语义。
- replace 缺省继承 placement;普通内容变化不得改变 Note 类型或刷新位置审计。

推荐稳定错误码:

- `NOTE_PLACEMENT_REQUIRED`
- `INVALID_NOTE_PLACEMENT`
- `STALE_NOTE_SOURCE`
- `STALE_PDF_NOTE_PLACEMENT`
- `NOTE_REANCHOR_NOT_ALLOWED`
- `NOTE_REANCHOR_CONFLICT`
- `AMBIGUOUS_NOTE_TARGET`

## 6. 入口与 layer 所有权

| 入口 | placement | 初始 layer | 草稿 |
|---|---|---|---|
| 用户选正文后点击 Note | `selection_context` 或显式当前目标 | `long_term` | 无 |
| 用户截取 Agent 回答且有 quote source | `selection_context` | `long_term` | 无 |
| 用户截取 Agent 回答且无 quote source | 用户点选后的 `lid_block | pdf_region` | `long_term` | `NotePlacementDraft` |
| Agent `reader.note(lid,text)` | Server 合成 `lid_block` | `session` | 无 |

- Note 放置草稿不含 layer。
- `reader.note` 的 LID 是显式 canonical LID;在 PDF 阅读表面只进 Notes 列表,不得猜 PDF marker。
- Agent Note 由用户“保留”后 promote;撤销只针对真正 `CREATED` 的当前版本。

## 7. 放置状态机

```text
IDLE
  -> 创建无引用 Agent 摘录
PLACING_DRAFT(subject, surface, source_fingerprint)
  -> 点中有效目标
SAVING(frozen subject + target + original book_id)
  -> success                       -> IDLE
  -> explicit error                -> PLACING_DRAFT
  -> timeout/disconnect/abort       -> RECONCILING
RECONCILING
  -> refresh original book truth   -> IDLE | PLACING_DRAFT | PLACING_RECORD

IDLE
  -> 用户选择“移动”或 legacy“放置到正文”
PLACING_RECORD(subject, surface, source_fingerprint)
  -> 点中有效目标                  -> SAVING
  -> explicit error/reconcile old  -> PLACING_RECORD,原记录不变
```

交互规则:

- 创建草稿后立即进入同 surface 放置;Markdown 草稿不能放到 PDF,反之亦然。
- Pointer Events 的 click/tap 是唯一提交输入;pointermove 只预览候选。
- 空白、无效或跨 LID 歧义目标保持 PLACING 并显示短暂反馈。
- 提交前取消、新草稿、新重锚、切书、切 surface 或关闭 Reader:丢弃草稿/取消旧重锚,最新明确操作优先。
- 有效目标点击是提交点;SAVING/RECONCILING 禁止取消、抢占或重复提交,但不冻结 Reader 滚动。
- 请求始终绑定原 `book_id`;迟到响应不得刷新当前新书。
- 首次创建歧义失败保留草稿并靠 `CREATED | EXISTING` 幂等确认;重锚先刷新权威记录,不得盲重试旧 ID。
- 本切片不新增持久 idempotency receipt、稳定 note ID、离线队列或草稿跨重启存储。

## 8. Capability 与投影矩阵

| placement | Markdown 内联 | PDF 内联 | Notes 列表 |
|---|---|---|---|
| `lid_block` | 对应 LID 后 NoteCard | 不猜 marker | 显示 |
| `pdf_region` | 不猜 NoteCard | 精确 region marker | 显示 |
| `selection_context` | 既有选区投影 | 既有精确选区投影 | 显示 |
| legacy/stale | 不猜位置 | 不猜位置 | 显示“无法定位/放置到正文” |

```text
Markdown capability ready after NP2c -> 启用 Markdown 无引用摘录入口
PDF capability ready after NP3c      -> 启用 PDF 无引用摘录入口
current surface not ready            -> 禁用入口,不创建草稿
```

- automatic PDF regions 仅在 active placement session 中瞬时显示候选,结束后销毁。
- source/map stale 不删除或改写 Note;用户可从 Notes 列表显式重新放置。
- NP2 与 NP3 可独立验收;NP4 不补实现。

## 9. 实施依赖与实际切片

```text
NP0R 文档对齐
  -> NP1a Schema + canonical identity
  -> NP1b Atomic mutations
  -> NP1c Server/API validators
       -> NP2a Shared placement controller
       -> NP2b Markdown first placement
       -> NP2c Markdown reanchor + races
       -> NP3a PDF target resolver
       -> NP3b PDF projection
       -> NP3c PDF create/reanchor + races
  -> NP4 Release Gate
```

NP1-NP3 是里程碑名;只有 a/b/c 子切片才是实际实施单位。每个子切片独立保持测试绿,格式专属竞态在 NP2c/NP3c 完成,NP4 只验收。

## 10. NP0R - 文档对齐 [Docs]

### Do

- 更新 `CONTEXT.md` 的无引用 Note、NotePlacementDraft、放置会话、正文放置与 PDF placement 定义。
- 修订 ADR-0083,记录结构判型、来源身份、v3、mutation、交互与格式边界。
- 重写本方案,删除旧输入、稳定待处理状态与默认锚语义并固定 NP1a-NP4。

### Do not

- 不改 Rust、TypeScript、Vue、schema、测试或生成物。
- 不实现 NP1,不更新架构文档,不刷新 `SESSION_CHECKPOINT.md`。

### Done

- 三份文档对同一术语只有一个含义,旧术语、旧状态名、blockquote 判权与取消后保留旧规则均归零。
- 所有冻结决策均有 ADR 或方案承载,TermMap 零未解析符号。
- 目标文件链接存在,旧规则扫描和 `git diff --check` 通过。

## 11. NP1 - Shared Foundation [Memory/Server/API]

### NP1a - Schema 与规范身份

**Do**:新增 `NoteBodyPlacement`;MemoryDocument v2/bare array 原子迁移到 v3;placement 纳入 `mem_id`;legacy 可读且不阻塞其他 mutation。

**Do not**:不新增 commands、routes、UI;不猜旧 placement;不改变无 placement 记录的既有 ID。

**Done**:v2/profile/governance fixture 无损迁移;v3/legacy roundtrip;未知版本拒绝;placement canonical hash 稳定;`cargo test -p memory` 通过。

### NP1b - 原子 mutation

**Do**:实现 Note `CREATED | EXISTING`、原子 reanchor、按版本 promote、replace 继承、碰撞与审计语义。

**Do not**:不实现 Server target validation 或 Web;不改变 Highlight 创建语义;不新增稳定 note ID。

**Done**:重复创建零 mutation;promote 不改 ID;重锚成功/冲突/落盘失败原子;旧版本不可复活;`cargo test -p memory` 通过。

### NP1c - Server/API validator

**Do**:投影 save/reanchor/promote routes;验证 source fingerprint、Markdown LID、PDF map/region/precision;`reader.note` 合成当前 `lid_block`;同步 Web API 类型。

**Do not**:不复制 validator 到 NP3;不接受正文放置型 Note 的 anchor/citations 双输入;不实现 UI或 marker。

**Done**:双格式合法/非法 fixture 覆盖;source/map stale、歧义目标和 anchor-only 新 Note 均 fail-closed;server/API 测试通过。

## 12. NP2 - Markdown 纵切 [Web/Markdown]

### NP2a - 单一放置控制器

**Do**:实现唯一 `NotePlacementDraft`、PLACING/SAVING/RECONCILING 状态、surface/source 绑定、capability gate 与 Pointer Events 输入。

**Do not**:不提交 memory mutation,不实现真实 Markdown/PDF target,不做拖拽或键盘焦点模型。

**Done**:创建/取消/替换/切书/切 surface/写失败状态测试通过;有效目标前 API mutation 为零。

### NP2b - Markdown 首次放置

**Do**:实现真实 `[data-lid]` resolver、候选反馈、用户 long-term create、CREATED/EXISTING/promote 结果处理与 NoteCard 回显。

**Do not**:不取 nearest/selected/top LID;不把 NoteCard/工具控件当目标;不启用 PDF。

**Done**:有效 LID 只提交一次;空白与回收块零 mutation;相同 session Note 被 promote;桌面与 390px 触控组件测试通过。

### NP2c - Markdown 重锚与竞态

**Do**:实现已有 Note“移动”、legacy“放置到正文”、source stale 恢复、提交锁、迟到响应与权威刷新。

**Do not**:不允许 selection-backed Note 走 reanchor;不跨格式;不在 NP4 留 Markdown 竞态实现。

**Done**:成功只剩新 ID;碰撞/错误/断连保留权威记录;切书迟到响应不污染新书;Markdown capability 可启用。

## 13. NP3 - PDF 纵切 [Web/PDF]

### NP3a - PDF target resolver

**Do**:返回实际 `{entry,region}`;执行精度矩阵、同 LID 归一、跨 LID拒绝与瞬时候选反馈。

**Do not**:不取 primary/nearest/whole-LID bbox;不复制 Server validator;不持久化 bbox。

**Done**:zoom、scroll、旋转页下候选一致;v1/v2/重叠/无效 fixture 覆盖;候选消失生命周期测试通过。

### NP3b - PDF placement 投影

**Do**:从已验证 region 生成对象级 Note marker;复用 Note 内容/编辑/删除界面;stale 时 side-list-only。

**Do not**:不改变 selection Note terminal marker、Highlight、Ask AI 或 PDF 页面布局。

**Done**:marker 精确绑定 region;source/map/region/LID 任一 stale 时 marker=0;既有 PDF annotation 回归绿。

### NP3c - PDF 创建、重锚与竞态

**Do**:接通用户 long-term create、existing reanchor、legacy 转换、提交锁、歧义刷新与 PDF capability。

**Do not**:不跨格式;不新增持久回执;不把竞态实现拖到 NP4。

**Done**:首次放置与重锚真实写盘/重载一致;所有 fail-closed 路径原记录不变;桌面 1440x900 与 mobile 390x844 E2E 通过。

## 14. NP4 - Release Gate [Cross-cutting,Done 2026-07-28]

### Do

- 跑 Rust/Web/E2E 全量回归与双格式真实数据 smoke。
- 检查 source/map stale、legacy、重复 create、碰撞、迟到响应、切书和 Reader remount。
- 同时启用已通过 NP2c/NP3c 的独立 capability。
- 更新 `docs/架构.md` 的实际数据流并追加 `docs/代码链路.md`。

### Do not

- 不承载任何新实现或格式专属竞态修复。
- 不批量修正历史默认错锚,不实现跨格式流程或持久草稿。
- 不以截图或 LLM 自评替代确定性断言。

### Done

- 新无引用 Note 100% 带合法 placement 与 source fingerprint,无默认 anchor 写入点。
- quote/selection Note、正文直接 Note、Agent Note、Highlight、Ask AI 全量回归不变。
- Markdown/PDF desktop/mobile 无目标反馈、marker、正文和工具栏重叠。
- 架构、代码链路、ADR、术语表与真实代码一致。

## 15. 发布硬门禁

1. 无 quote Agent 摘录分支不得读取 question/selected/top LID 作为存储锚。
2. 有效目标点击前 memory mutation 必须为零。
3. 新 Note 必须恰有 `selection_context | note_placement` 之一。
4. body placement 只接收 placement;anchor/citations 由 Server 派生。
5. placement 必须绑定并复验 current source fingerprint。
6. Markdown 只认实际正文 `[data-lid]`,无 nearest/top/selected fallback。
7. PDF 保存实际 region 与 map identity,无 primary/whole-LID/nearest fallback。
8. PDF fallback/partial/unmapped 与跨 LID 歧义必须 mutation=0。
9. automatic regions 只在 active session 中瞬时出现。
10. 重锚/碰撞/写盘失败必须保留原 record,禁止 `delete + save`。
11. `memory.replace` 内容编辑必须保留 placement 与审计字段。
12. 引用型 Note 不得出现正文 reanchor affordance,后端也必须拒绝。
13. legacy 可读可编辑且不自动迁移;显式放置才升级。
14. `CREATED` 才产生 Agent undo effect;`EXISTING` 不得覆盖或生成撤销。
15. SAVING/RECONCILING 不可取消或抢占;歧义结果以原书磁盘权威为准。
16. MD/PDF capability 独立,未完成表面不得创建无法放置的草稿。

## 16. 确定性验证命令

NP0R:

```powershell
$targets = @("CONTEXT.md", "docs/adr/0083-unquoted-note-explicit-body-placement.md", "docs/切片方案-无引用Note显式正文放置.md")
$forbidden = @(("Pending" + "Note"), ("markdown" + "_lid"), ("PLACING_" + "PENDING"), ("PENDING" + "("))
foreach ($term in $forbidden) { if (rg -n -F $term $targets) { throw "stale Note placement term: $term" } }
git diff --check
```

代码子切片按触达面执行:

```powershell
cargo test -p memory
cargo test -p server
pnpm -C packages/web test
pnpm -C packages/web typecheck
pnpm -C packages/web build
pnpm -C packages/web test:e2e -- note-body-placement.spec.ts
git diff --check
```

NP0R 未改可执行代码,不得伪报代码测试通过;NP1a 起每刀必须执行对应确定性测试。
