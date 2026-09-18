# RP6 持续修改与恢复

状态：完成，2026-09-17。对应[切片方案 §6/§7](../切片方案-Agent富呈现与读时内容制作.md)。

## 已实现行为

- Resident 制作工具增加 `read`，按确切版本读取逻辑资产、语义说明、来源 ref、状态合同及初始值。代码每次最多返回 4,000 字符，使用 `file` / `offset` / `next_offset` 继续读取；工具历史仍保留紧凑回执。
- `write.based_on` 接入原不可变版本存储。修改保留内容身份并生成新修订；历史回答继续指向原版。制作失败或保存失败不替换已交付版本。保留旧版已绑定来源；新的书源主张仍需获取证据。
- 普通后续请求带最近八个已交付引用；明确现场追问保留原回执。修改基准与该追问指定版本不一致时拒绝写入。需要代码时再读，不把 HTML/JS 反复放进历史。
- 跨版本参数接纳在写候选时完成：旧/新 `state_contract` 对某个标量参数的定义完全相同，且保存的 `values.page` 值与新初始字段 JSON 类型一致，才沿用该值。定义含参数含义、单位和有效域。其余字段保持新初始值；对象、数组、控件、步骤和结果不跨版继承。
- 有明确追问回执时采用该快照，否则采用基准版本最后保存现场。候选保存有效初始值，实际预览执行同一组参数，后续现场变化不改变候选。
- `/agent/presentation.read` 默认返回指定版本最后保存现场；可通过 `saved_state` 指定确切回执，拒绝错配会话、回合和版本。磁盘读取错误不会静默当作没有保存过。
- 页面初始化后恢复原生控件，再调用同步 `registerStateRestorer(scene => …)` 恢复自定义参数与步骤并重算结果；`restoredState` 在初始化时也可读取。恢复期间不自动保存，不重放按钮点击、来源跳转或 Reader 操作。实际显示仍经过原公开语义检查。
- 回答显示版本号；当前现场输入可直接描述修改需求。无自定义恢复方法的旧版明确提示恢复能力缺失。

## 验证结果

| 验证 | 结果 | 检测的失败 |
| --- | --- | --- |
| Server 呈现筛选 | 16 通过；当时 5 个按需入口跳过 | 原候选/版本/现场/追问回归，旧版覆盖、错配快照、真实存储失败 |
| RP6 定向（包含实际 Edge 预览） | 3 通过 | 分段读旧代码、明确编辑基准、请求绑定参数被后续保存替换、不兼容参数误继承、新候选预览/交付失败、旧版被覆盖 |
| 分段读取补充断言 | 1 项定向重跑通过 | 4,800 字符资产跨分段遗漏或重复；补充后只重跑所属测试 |
| 真实浏览器 + Rust 接口 | 8 通过 | RP6 恢复 1、RP5 追问 2、RP3 来源/布局/错误 4、独立桥 1；恢复产生额外保存或模型调用、丢失步骤、重新追问取错现场 |
| Server Resident / 历史 / 来源 | 22 / 6 / 5 通过 | 最近引用投影及新读取路径破坏既有生命周期、取消、预提交、持久历史或来源 |
| Runtime 呈现相关 / 提示 | 24 / 5 通过 | 制作分支、工具发现、来源与图像投影、ts-rs 导出及制作提示模块 |
| Web 单测 / 类型检查 | 25 通过 / 通过 | 回答与运行状态、Markdown、内容装配、共享类型和组件事件 |

浏览器恢复用例实际保存 `count=1`、步骤 `explain`，重新构造 Reader 状态并加载磁盘历史，再刷新回答页面；显示恢复为 1/3、解释步骤。恢复期间保存次数仍为 2、模型请求数不变、未触发来源操作。继续提出“给这个版本增加一个例子”后，实际模型请求投影携带同一参数与步骤。截图：[重开后的现场](rp6-windows/reopened-scene.png)。

制作路径使用真实私有存储和 Edge：读取旧版 → 基于旧版写候选 → 实际预览显示保存参数 `Found 1` → 保存新修订 → 历史提交；随后仍可读到完全相同的旧版内容。参数不兼容和版本保存失败由独立存储用例覆盖。浏览器修改请求的模型入口采用记录请求的确定性适配器，本次没有新增真实 Provider 采样。

## 复跑

```text
cargo test -p server --lib presentation_ -- --test-threads=1
cargo test -p server --lib presentation_rp6 -- --include-ignored --test-threads=1
cargo test -p server --lib resident_ -- --test-threads=1
cargo test -p server --lib agent_history -- --test-threads=1
cargo test -p server --lib agent_source -- --test-threads=1
cargo test -p runtime --lib presentation -- --test-threads=1
cargo test -p runtime --lib agent_prompt -- --test-threads=1
pnpm --filter @understand-book/web typecheck
pnpm --filter @understand-book/web exec vitest run src/components/RightRail.test.ts src/agent-run-state.test.ts src/md.test.ts src/presentation-document.test.ts

# 单独启动验收宿主，再运行浏览器；最后访问 /stop。
cargo test -p server --lib presentation_browser_host -- --ignored --nocapture --test-threads=1
pnpm --filter @understand-book/web exec playwright test playwright/agent-presentation-recovery.spec.ts playwright/agent-presentation-follow-up.spec.ts playwright/agent-presentation.spec.ts playwright/presentation-bridge.spec.ts --workers=1
```

浏览器输出在 `D:/codex-build/understand-book-rp6/browser`。构建沿用 RP2 的 D 盘 target/temp、dev/test debug=0、incremental=0、`_LINK_=/DEBUG:NONE /PDB:NONE`。临时验收宿主已停止。

## 已知限制

- 本轮为 Windows 源码、Edge 预览和浏览器验收。未替换日常 Reader、制作安装包或重新部署 Linux；完整两平台真实模型体验属于 RP7。
- 旧页面若未注册自定义恢复方法，只能自动恢复原生控件，并显示明确提示。新制作合同要求自定义参数和步骤同时提供读取与恢复方法。
- 跨版本兼容声明由内容作者负责，首版只接纳同定义、同 JSON 类型的标量值；改变单位或有效域须改变定义，其余使用新版默认值。恢复重新计算结果，不重放外部副作用，不授予正式教学判断。
