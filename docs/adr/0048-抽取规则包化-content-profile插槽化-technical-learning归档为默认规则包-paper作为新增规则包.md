# ADR-0048 抽取规则包化 / content profile 插槽化 / technical_learning 归档为默认规则包 / paper 作为新增规则包

状态:已接受(2026-07-05,PDF/paper §0.5 抽取规则架构)

## 背景
ADR-0033 已把 Core Schema、Book Profile、Reader Profile 解耦,并把 `technical_learning` 定为当前唯一落地 Book Profile。但现有实现形态仍容易让抽取规则散落在 agent prompt、build 脚本和 BookStructure 规则里,被误认为项目全局真理。paper 支持暴露了这个风险:如果在各处写 `if paper`,后续文学、历史、法律等内容类型会继续堆分支。用户明确要求抽取规则能和项目结构即插即用,并把现在的抽取规则也变成 `technical_learning` 规则包。

## 决策
1. **Core build pipeline 固定**:导入 source、LID 切分、窗口切分、Pass1、profile-sidecar、Pass2、BookStructure、自检闸、固化基座的执行骨架不因 profile 分叉。
2. **content profile = extraction rule pack**:规则包挂在固定插槽上,决定每一步抽什么、怎么问、怎么分类、怎么投影。
3. **`technical_learning` 是默认规则包**:现有 Pass1 / profile-sidecar / Pass2 / BookStructure 抽取规则归档为 `technical_learning`,不再视为全局默认语义。
4. **`paper` 是新增规则包**:paper 只提供论文体裁的抽取规则和 MCP/读时投影视图,不新增独立 pipeline、图谱 schema 或 `book.paper.*` 命令。
5. **规则包不得改 Core 宪法**:LID、source/book.text、citation anchor、确定性图谱闸、分区不变式、Core 命令面和 memory 隔离不受规则包影响。
6. **BookStructure 是共享 sidecar**:`technical_learning` 与 `paper` 只改变 BookStructure 抽取提示和投影口径,不各自复制 `book_structure.json` 的结构体系。
7. **MCP projection 属于规则包输出视图**:单篇论文 MCP 可暴露 paper-specific overview/claims/evidence 视图,但这些视图从 BookStructure + graph + discourse/formula/pass2 artifacts 投影,不制造第二套持久真相。

## 规则包插槽
```text
content_profile/
  pass1_rules
  profile_sidecar_rules
  pass2_edge_contracts
  book_structure_rules
  mcp_projection_rules
  answer_policy
```

每个插槽都必须声明可用输入、输出形状、LID 证据要求和确定性 gate 责任边界。

## 命门
- **规则可插拔,地基不可插拔**:profile 是解释语法,不是新数据库。
- **现有规则先归档再扩展**:不把 `technical_learning` 留在全局隐式默认里,否则 paper 会变成第二套特殊分支。
- **投影视图不是新真相**:MCP/读时的 paper 视图可定制,但必须回到已有 sidecar 和 LID 证据。

## 否决
- 在 build pipeline 到处写 `if paper`:会把内容类型做成分支泥潭。
- 为 paper 新建独立 pipeline:重复 LID/window/gate/BookStructure,破坏 Core/Profile 分层。
- 为 paper MVP 新增图谱 schema 或 `book.paper.*`:范围扩大,且会提前冻结尚未实测的论文关系模型。
- 继续把当前抽取规则称作全局规则:会污染未来 profile。

## 何时回头
- 规则包数量超过两个且插槽接口稳定后,评估把 prompts / contracts / projections 移到显式 `profiles/<id>/` 目录。
- 某个 profile 反复需要 Core schema 新字段时,单独开 ADR 评估 schema 升级,不得从规则包里偷改 Core。
- MCP projection 需求稳定后,定义通用 profile projection manifest。

## 影响
- `CONTEXT.md` 新增 `content profile / extraction rule pack`、`technical_learning rule pack`,并修正 `paper profile`、`BookStructure` 定义。
- 后续实现应把当前 agents 的规则视为 `technical_learning` 默认规则包,再添加 `paper` 规则包。
- `skills/build/SKILL.md` 后续应接受/传递 content_profile,但默认仍为 `technical_learning`。
- 不改冻结命令面;本 ADR 只定规则包边界和后续实现约束。
