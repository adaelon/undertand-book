# 旧批次补位与异常诊断交付 — 2026-09-13

依据：[ADR-0126](adr/0126-dispatch-refill-uses-current-pending-work.md)。

- [x] 根因与决策落档。
- [x] 旧计划补位和终态收束实现、定向回归。
- [x] 有界本地诊断和结构化失败边界。
- [x] 编译、安装插件与正式 Build Engine、记录验证结果。

原书不续跑，已有收据与构建状态不改写。工作树原有变更保留。


## 实现

- 旧计划未发布的批次包含非当前待办时跳过该批次；当前计划保留未完成成员，后续重新组织，不修改历史批次和任务收据。
- 已发布派发在准备执行入口时发现终态，按已有收据正常结束。若在后续入口检查期间变为终态，以类型化信号返回短暂 WAIT，下一次调度协调状态。
- 未处理异常返回 `NEEDS_USER/build_engine_failed`，无恢复选项。请求编号对应 driver registry 的 `diagnostics/<request_id>.json`；异常名称最多 128 字符、消息 2048 字符、堆栈 8192 字符。原始诊断不进入主任务。保存失败以独立错误码明确报告。
- 构建技能同步说明维护边界，并要求普通状态检查不能描述成阶段收口。

## 验证

- 两个红测试先复现整批过时和部分过时的重复选择；修改后通过，并继续验证剩余成员不会丢失。
- 最终 runtime 19 项、driver failure 3 项通过；concurrency 6 项通过。共 28 个不同用例，分批退出码均为 0。日志：`tmp/close-diagnosis-20260912/regression.log`、`regression-final.log`。
- Core typecheck 通过。新增晚发布测试最初漏填测试夹具要求的 run_ttl_ms，补齐后测试及类型检查通过。
- 编译程序端到端场景：保存旧计划 → 通过真实 executor 交付及 writer 提交任务 → build.step 补位跳过成功任务 → 原收据字节不变。并验证非法请求获得结构化失败及有界本地诊断。
- 正式安装程序重复上述场景通过，结果：`tmp/close-diagnosis-20260912/compiled-hWdPwt/verification.json`。
- 插件源契约、插件结构和 build skill 校验通过；发布源与缓存 10 个文件逐个比较一致。

## 安装

- 插件：`understand-book@understand-book-local`，版本 `0.1.0+codex.20260912174142`（UTC 版本时间）。
- 正式 Build Engine：`E:/allwork/Understand Book/understand-book-build.exe`。
- 旧程序保留为 `E:/allwork/Understand Book/understand-book-build.before-dispatch-refill-20260912174142.exe`，不终止占用它的已有连接。

## 已知边界

- 原 Mastering Rust 构建未续跑；本次验证使用隔离的小书工作区，未进行整本真实模型构建验收。
- 新任务及新连接加载更新后的插件与程序；已经运行的连接继续使用原进程。
- 本轮代码和文档未提交；工作树既有变更保留。
