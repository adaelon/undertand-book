# ADR-0078 PDF selection translation as an ephemeral lock-free bilingual projection

Status: Accepted, 2026-07-16.

### §1 PDF selection translation boundary

**决策**:paper PDF 选区翻译经独立只读 Reader endpoint 在状态锁外调用 Provider,以临时 Markdown/KaTeX 浮层返回,不进入 chat、memory 或 cache。

**否决**:
- 复用 `/agent/chat`:污染对话、画像和回合历史。
- 前端直连 Provider:复制配置边界并暴露凭据处理。
- 持久化或词典拼接降级:制造第二正文或伪译文。

**命门**:英文原文和 LID ranges 仍是唯一证据;翻译只消费服务端复验选区,Provider 调用不得持有全局 `AppState` 锁。
**何时回头**:需要跨 profile、流式输出、持久缓存或教学型术语解释时。
**展开**:[PDF 选区翻译切片方案](../切片方案-pdf选区翻译.md)
