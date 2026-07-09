# SESSION_CHECKPOINT - 2026-07-09 17:22

## 新鲜度自检
- 写入时基准 commit: `d794b0a docs: plan frontend workbench and pdf reader follow-ups`.
- 读入时先跑 `git log --oneline -3` 和 `git status --short`;若更新,以 git 为准。

## 当前状态
- PH6-PH9 已提交: Workbench core shell、PDF runtime endpoints、trusted-source paper projections、confirmable sidecar plan。
- 工作区已有未提交实现: PH10 snapshot Workbench shell、PH11 PDF.js body reader、中文化文案、tech 书绕过 paper gate 的 server 修复。
- 重要纠偏: PH10 只是静态 snapshot shell,不是完整 Build Workbench。
- 已落档完整 Build Workbench 路线: `docs/切片方案-paper-pdf-first-hybrid.md` 的 `3.1 Complete Build Workbench Completion Plan`,覆盖 PH12-PH18。

## 下一步可直接接手
1. 读 `docs/切片方案-paper-pdf-first-hybrid.md` 的 `3.1 Complete Build Workbench Completion Plan`,从 PH12 开始。
2. PH12: 设计并实现 Workbench 上传/选择 `paper.md + paper.pdf`、draft workspace、input manifest、fingerprint 和 snapshot 更新。
3. PH13: 接 server-side build controller API,持久化 job create/reuse/start/resume/decision/permission lifecycle。
4. PH14-PH15: 接 Codex executor adapter skeleton 和交互式 Workbench 控制 UI。
5. PH16-PH18: source reconciliation review、stage runner 到 reader handoff、恢复与观测。

## 未提交/未完成
- 完整 Build Workbench 尚未实现;当前只是方案落档和 checkpoint 重定向。
- 本轮文档改动: `CONTEXT.md`, `docs/切片方案-paper-pdf-first-hybrid.md`, `docs/代码链路.md`, `SESSION_CHECKPOINT.md`。
- 工作区还有既有脏改和未跟踪文件;不要误 stage unrelated files。
- 已知既有脏改包括 server PH10/PH11 相关改动、web 组件、core md adapter/tests、`pnpm-lock.yaml` 等。

## 冷启动读序
1. `docs/切片方案-paper-pdf-first-hybrid.md` - 先读 `3.1 Complete Build Workbench Completion Plan` 和 PH12-PH18,再回看 PH10/PH11 现状。
2. `CONTEXT.md` - 读 `Build Workbench`、`Build controller`、`BuildDecisionRequest`。
3. `docs/代码链路.md` - 读 2026-07-09 的完整构建工作台重定向、Workbench gate 修复、PH10/PH11 entry。
4. `packages/core/src/build-workbench.ts` - 现有 job/readiness/decision/permission 状态模型,可复用到 server controller。
5. `crates/server/src/lib.rs` - 当前 `/book/build_workbench` snapshot 和 tech fast-path;PH12/PH13 要在这里扩展动作端点。
6. `packages/web/src/components/BuildWorkbenchPane.vue` / `packages/web/src/api.ts` - 当前静态壳和前端 API 类型,PH15 要改成交互控制台。

## 本会话决策摘要
- Build Workbench 的目标定义改为 build-mode 控制台:上传/选择输入、创建/续跑 job、server-side Codex executor、用户决策、权限审批、stage runner、reader handoff。
- PH10 不再被视为完整 Workbench,只保留为 snapshot shell。
- 完整 Workbench 后续按 PH12-PH18 实现,优先 PH12。
