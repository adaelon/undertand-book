# 候选校验纠错交付 — 2026-09-12

依据：[ADR-0125](adr/0125-candidate-validation-feedback-and-bounded-retry.md)。

## 工作步骤

- [x] 冻结决策：有字段诊断的 writer schema 错误可纠正；原策略、原输入、合法枚举保持；三次自动尝试耗尽后需要用户授权。
- [x] 复现测试：下一次生成未收到反馈；可纠正的 writer 字段错误仍投影为 publish_new_policy_scope。两个红测试已分别复现。
- [x] 实现：持久诊断反馈、分类与恢复、执行器说明和人工边界计数说明。
- [x] 验证：定向回归、类型检查、真实失败样本的隔离校验、编译入口。
- [x] 交付：重建 Build Engine、同步本地插件并重新安装，记录版本与验证结果。

## 当前证据

Mastering Rust 的 unit:16 三次在 `/unit_card/candidate_key_stops/4/type` 输出 `application`，合法 KeyStopType 不含该值。最后失败为 2026-09-12T11:38:15.874Z。提示词已明确合法枚举，失败通过普通 DONE 返回，下一次生成未携带字段反馈。

## 验证记录

- Core typecheck 通过。
- 本次纠错链路独立回归：4 个文件、6 项通过、107 项按名称过滤跳过，退出码 0（22.23 秒）；覆盖诊断分类、字段反馈与提交、旧请求恢复、重复确认、单次授权和范围隔离。日志：`tmp/candidate-retry-20260912/tests-focused.log`。
- 六个定向文件的首轮 143 项断言全部通过；运行器出现两次 onTaskUpdate 通信超时，该轮退出码 1。单 worker 重跑仍为 143 项断言通过、一次同类运行器错误，退出码 1；整批结果保留为受限验证，不记全绿。
- 原 unit:16 三份候选在隔离目录复现同一非法枚举；仅将该字段改为合法值后，三份均通过原 writer。验证的是字段纠正可行性，未替模型决定正式结果。
- 新编译程序及正式安装路径均走通：首次 writer 拒绝 → 下一次 GENERATE 携带字段反馈 → 冻结响应重放一致 → 修正候选 committed。
- 插件发布源契约、插件结构及两份 skill 验证通过；build skill 验证在 Windows 默认 GBK 下无法解码，使用 Python UTF-8 模式后通过。

## 安装结果

- 已逐文件比较发布源与安装缓存，10 个文件完全一致。
- 插件：`understand-book@understand-book-local`，版本 `0.1.0+codex.20260912122656`。
- 正式程序：`E:/allwork/Understand Book/understand-book-build.exe`。
- 安装版链路结果：`tmp/candidate-retry-20260912/compiled-Lkjaqv/verification.json`。
- 旧程序被已有 MCP 连接占用，原路径直接覆盖失败；保留旧进程并将旧文件改名为 `understand-book-build.running-before-20260912122656.exe`，新程序已放入正式路径。旧文件还另存了一份 `.before-candidate-retry-20260912122656` 备份。

## 已知边界

- 六文件整批回归存在 Vitest onTaskUpdate 上报超时；143 项断言通过但整批退出码 1。
- 现有 MCP 连接仍运行旧程序；应在重新建立连接后，用新任务加载更新后的 skill 和程序。
- 原书的失败记录、候选和 invocation 未改写，也未继续整本书的模型生成。
- 自动三次耗尽后，每次用户确认只追加一次纠错机会；再次失败需要新的确认。
- 工作树原有变更继续保留，本轮未提交。
