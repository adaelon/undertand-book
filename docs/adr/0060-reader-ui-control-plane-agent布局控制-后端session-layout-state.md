# ADR-0060 Reader UI Control Plane / agent 布局控制 / 后端 session layout state

状态:已接受(2026-07-05,Profile Plugin Framework §0.5 reader layout control grill)

## 背景
Profile Plugin Framework 要让预构建、后端读时/agent、前端消费都按 `content_profile` 插拔。用户进一步要求 resident agent 能按用户任务直接调整整个阅读器页面布局,例如打开 paper structure map、聚焦 Codebook、pin 某个 evidence LID 或提议切换到 paper deep-read 工作台。现有命令面已确立 `reader.*` 是可变 UI 控制层,现有 `AgentEffect` 已支持可撤销的 `Goto/Highlight/Note`;但尚未定义 agent 如何安全操作布局。

## 决策
1. **新增 Reader UI Control Plane**:阅读器布局、槽位、面板焦点、pin evidence 和 workspace preset 属于 `reader.*` 可变 UI 会话态,不属于 book/paper truth。
2. **后端拥有 session layout state**:前端同步渲染后端 `ReaderLayoutState`;agent 不直接操作 DOM,只能发 typed `ReaderLayoutAction`。
3. **布局命令使用批量事务**:`reader.layout.apply(actions[])` 作为第一版命令面,后端校验 profile manifest、action 合法性和风险等级后更新 layout state。
4. **风险分级执行**:低风险 action 直接执行;高风险 action 以内联 agent proposal 呈现,用户点 Apply 后再调用后端执行。
5. **proposal 绑定 layout revision**:layout state 每次变更递增 `rev`;proposal 记录 `base_layout_rev`,Apply 时不匹配则返回 stale,不得自动 rebase。
6. **workspace 级状态边界**:`ReaderLayoutState` 管 `active_preset/open_slots/focused_slot/pinned_evidence/panel_sizes/slot_order`;不管 selection、popover、modal、输入草稿等前端瞬态。
7. **持久化只保留确认 preset**:用户确认过的 layout preset 可按 book/profile 恢复;agent 临时打开槽位、焦点、pin evidence 不跨会话持久化。
8. **profile manifest 限制布局能力**:每个 profile 声明 `ui_slots`、`layout_presets`、`allowed_layout_actions`;后端拒绝非法 slot/action/preset 组合,前端 registry 只负责渲染。
9. **UI 风格控制后置**:字体、密度、配色、主题等 `ReaderThemeAction` 不进入第一版 Reader UI Control Plane。
10. **第一版 action 闭集**:`open_slot/close_slot/focus_slot/set_active_tab/pin_evidence/unpin_evidence/set_panel_size/reorder_slot/set_layout_preset/reset_layout`。
11. **第一版风险表**:低风险直接执行=`open_slot/focus_slot/set_active_tab/pin_evidence/unpin_evidence/set_panel_size`;高风险 proposal=`close_slot/reorder_slot/set_layout_preset/reset_layout`。

## 命门
- **agent 操作布局,但不拥有页面**:所有变更必须通过 typed action + 后端 reducer。
- **layout 是 UI 会话态**:不得写入 BookStructure、paper sidecar、memory 或公共 truth。
- **用户终裁**:高风险 layout preset / workspace 替换必须经用户确认,旧 proposal 不得套到新 layout revision。

## 否决
- agent 直接操作 DOM:不可校验、不可回放、不可撤销。
- 前端本地应用高风险 proposal:绕过后端 session layout state。
- 全部布局操作都弹确认:会让 agent 操作阅读器失去流畅性。
- 完整 UI 状态后端化:selection、popover、modal 等瞬态会制造脆弱同步。

## 何时回头
- 多设备或多窗口同步同一阅读会话时,重新评估 layout state 的持久化和冲突处理。
- agent 频繁误切布局时,把更多 action 从 direct 降级为 proposal。
- 用户稳定要求 agent 调整视觉风格时,另立 `ReaderThemeAction` / theme policy ADR。

## 影响
- `CONTEXT.md` 新增 Reader UI Control Plane。
- 后续实现需扩展 `AgentEffect` 或新增 layout effect,并新增 `reader.layout.apply` 命令。
- Profile manifest 第一版需声明 slots、presets 和 allowed layout actions。
- 前端需新增 profile registry 渲染 slots,并把 layout state 视为后端 session state 的投影。
