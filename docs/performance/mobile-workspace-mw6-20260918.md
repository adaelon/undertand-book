# MW6 多环境预览与真实触控排练记录

日期：2026-09-18
基线：`8dea7b0`；实现位于 Runtime 合同、Server CDP 宿主与 author 候选回执。
结论：Windows Edge/Chromium 定向验证通过；没有把内容容器预览当作 iPhone 或 Linux 真机证明。

## 合同与实现

- 旧 `width` 请求继续可用，默认 960×720 mouse，范围仍为 240–1920；新增 `viewport {width,height,input}`，高度范围 160–2160。两者同时出现立即拒绝。
- 新 author 合同固定要求同一 candidate 的三份干净回执：`narrow-content` 320×420 touch、`short-content` 640×240 touch、`desktop-content` 960×720 mouse。前两份只记录环境，第三份完成后才设置 `previewed_candidate`；失败只撤销该候选的对应环境回执。
- 旧调用只生成 `legacy` 回执，保持原有一次成功预览即可交付的兼容行为。回执集合返回前排序，结果稳定。
- CDP 始终用请求宽高建立普通内容容器布局，并按 input 单独启用触摸能力；touch click 使用 `Input.dispatchTouchEvent`，mouse click 使用鼠标事件。这样没有 `<meta viewport>` 的候选也保持精确 CSS 内容宽度。
- 每步观察返回分类问题：`candidate_execution`、`geometry_overflow`、`control_unactionable`、`touch_target_small`、`result_mismatch`，并带环境名。320×240 组合边界作为额外真实浏览器场景。

## 验证

- Runtime：旧/新请求解析、冲突与越界拒绝 2 项；author schema 保留 width 并公开 viewport bounds/input 1 项。
- Server 纯合同：三环境缺一不可及 legacy 兼容 2 项；相关集成测试均完成编译。
- 真实浏览器 preview 套件最终 8/8 通过，覆盖真实 touch/mouse、320×240、窄宽、错误归因、按键、图形、取消/期限、网络隔离及进程/profile 回收。
- 真实 author：三份环境回执后交付 1 项通过；旧 browser correction/private delivery 1 项通过。
- 初次真实触控测试发现 CDP `mobile=true` 令无 viewport meta 的候选获得约 980px 布局宽度、漏报 320px 溢出；修复为“普通内容容器 + 独立 touch emulation”后全套通过。

## 已知限制

- 当前实测平台为 Windows 的已安装 Edge/Chromium；Linux 服务账户和正式反代入口留给 MW8。
- 环境回执证明候选在固定容器及输入模式下执行过关键路径，不证明所有设备、浏览器 UI、安全区或虚拟键盘组合。
- 仓库全量 `cargo fmt --all -- --check` 被既存脏工作区的大量格式差异阻断；本次 Rust 编译、定向单元与真实浏览器测试均通过，未为格式检查重写无关文件。
