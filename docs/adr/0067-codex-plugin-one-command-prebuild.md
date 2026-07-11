# ADR-0067 Codex plugin one-command prebuild
Status: Accepted, 2026-07-11.

**决策**:Codex plugin 以确定性 orchestrator 驱动全预构建。

**否决**:
- Codex app-server:把实验协议嵌入 Web 产品,边界和运维成本过高。
- 纯 SKILL.md 临场编排:阶段状态依赖 agent 记忆,无法稳定续跑。
- 通用/空输出降级:会把语义缺失伪装成构建完成。

**命门**:paper 只消费 Workbench 可信基座;非 paper 可从原始输入构建;专用 subagent 输出逐窗落盘并过 gate,失败自动修复最多两次,外部中断由同一命令幂等续跑。
**运行期依赖**:Windows 分发版由阅读器安装 Bun 编译的隐藏 sidecar `understand-book-build.exe`,用户不需要 Node、Bun 或 Cargo；插件开发/非 Windows 环境保留 Node/tsx 回退。PaperReadingGuide 完成判定由 TypeScript projection gate 执行，不调用 Cargo。Rust `read-tools` 保留为读时权威投影与 CI 一致性参照。
**何时回头**:Codex 不再提供 plugin skill 或 multi-agent 能力,或真书验证证明专用 subagent 编排不可维持。
