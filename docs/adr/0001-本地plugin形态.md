# ADR-0001 项目形态采用本地 Claude-plugin,不做托管服务端

状态:已接受(2026-06-21,grill 共识)

## 背景
V2 原则三写"单一完整接口 + API Key 接入握手",措辞像一个 HTTP 服务。但项目实际形态被确认为:**类 Understand-Anything 的本地 plugin**(skills + agents + 本地脚本,经 Claude Code 在用户机器执行),没有、也不打算有托管服务端。

## 决策
- 形态 = 本地 plugin 工具,与 Understand-Anything 同构。
- 运行时的 LLM 推理 = Claude 本身(云端,经 Claude Code 调用),**不压用户硬件**。
- V2 §4 的 "API"(/manifest、/context、/query、/synthesize)**不是 HTTP 端点**,而是 **skill 接口 + 本地产物(`.understand-book/` 之类)的形状**。原则三的"单一接口"内核保留(人与外部 Agent 消费同一份产物 / 同一组 skill),但"网络服务"的读法作废。

## 命门
V2 §4 全部端点措辞需按"skill + 本地产物"重译;接入握手(API Key)语义随之失效或改写。

## 否决
- **托管 API 服务**:与既定 plugin 形态冲突;且要自建服务器、容量、计费,违背"一个 plugin 开箱即用"。
- **混合(服务端预构建 + 本地高级模式)**:复杂度翻倍,当前无此需求。

## 补充(2026-06-21,经阅读器形态澄清,详见 [[ADR-0003]])
- "不做托管服务端"指的是**远程托管**。plugin 启动的 **localhost 临时进程**(只在阅读时存活,U-A 启 Vite 同款)仍属本地形态,不违此 ADR。
- 因此 §4 端点重译量缩小:它们 = **localhost HTTP 路由**,契约大体可留,不是"全部作废"。
- 进一步区分两个时刻:**预构建期**绑 agent harness(Claude Code/Codex);**读时**阅读器与 harness 脱钩、LLM 后端用户自选。

## 何时回头
若未来要做"跨用户共享的书库 / 多人协作",才重新评估服务端。
