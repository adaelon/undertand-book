# ADR-0045 BookStructure 读时消费与 MCP 投影

状态:已接受(2026-07-04,BookStructure backend-use grill)

## 决策

### §0045.1 读时工具面

**决策**:BookStructure 暴露 structure 与 guide_path。

**否决**:
- 只塞 prompt:不可测试且复用差。
- 并入 guided_route_from:宏观路线与局部前沿混淆。
- 做有状态带读会话:第一版状态复杂度过高。

**命门**:BookStructure 仍是公共只读 sidecar,不得吃 reader_profile/memory。
**何时回头**:需要章节/主题专属路线时再加 scope。

### §0045.2 带读路线

**决策**:guide_path 按 spine 分段展开 key_stops。

**否决**:
- 每 spine 一站:过粗,会漏关键定义/公式/转折。
- 全量 key_stops 平铺:失去全书结构节奏。
- 第一版加 thread scope:会牵涉 throughline 选择语义。

**命门**:第一版只有全书 scope;章节跳转由 LLM 基于路线选择。
**何时回头**:throughline 带读进入 UI/反馈路径时。

### §0045.3 目标跳转自检

**决策**:非机械跳转先读上下文自检。

**否决**:
- 纯确定性匹配:用户说法无穷,体验会硬。
- LLM 选后直接 goto:会把结构摘要误当证据。
- 新增确定性判定器:语义适配仍需 LLM。

**命门**:候选 LID 必须经 book.text/context 取真实上下文后才可 goto。
**何时回头**:若 prompt 约束不稳,再拆显式 check 工具。

## 影响

- `Book::load` 读取可选 `book_structure.json`;缺失可运行,存在但坏文件 fail-fast。
- 住户 agent 新增 `book.structure(at?)` 与 `book.guide_path(at?)` 工具;非机械跳转工具序列必须是 guide_path → text/context → gotoLid。
- MCP Tier 1 可暴露只读结构工具;Tier 2 `book_guide` 可复用 guide_path,但不得触达 reader/memory 或读者 viewport。
