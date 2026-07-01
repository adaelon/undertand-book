# ADR-0043 reader 连续滚动视口:后端区间窗口 + 前端虚拟流 + note overlay

状态:已接受(2026-07-01,`grill.md` 连续阅读体验 grill)

## 背景

当前 reader 视口承 [[ADR-0027]] 定义为 `anchor ± radius` 的叶序滑动窗口:`DEFAULT_RADIUS=3`,窗口最多 7 叶,且 `anchor_lid` 是窗口中心。前端 TopBar 的上/下按钮发 `scroll(-3)` / `scroll(+3)`。因此一次滚动后旧窗口与新窗口通常只重叠 1 叶,正文视觉上接近整屏替换,用户已读位置被甩到窗口边缘,不符合连续阅读习惯。

## 决策

1. **阅读模型改为连续滚动 / 虚拟列表**:正文是一条按叶序排列的连续长流。滚轮、触控和键盘滚动驱动阅读,新叶从流的边缘补入,旧叶从另一端回收;不再把 `anchor_lid` 当作视觉中心。

2. **后端 viewport 改为可配宽度区间窗口**:`Viewport` 从中心化窗口扩为区间语义,至少表达 `anchor_lid`, `top_lid`, `bottom_lid`, `visible_lids`, `width`。`visible_lids = leaf_lids[top..top+width]`,`width` 默认 20 叶。`scroll(delta)` 表示窗口 top 的平移量,clamp 到叶序两端。

3. **anchor 仍由后端管理**:`scroll(delta)` 后,后端把 `anchor_lid` 更新为新窗口中段叶。前端不回传真实停留 LID,保持"后端有状态、前端薄渲染层、agent 注入 reader 时状态一致"的既有边界。接受裸 `agent.chat` 使用中段 anchor 的轻微偏差;精确询问当前段时继续走 Ask AI 选区 LID。

4. **goto 定位到 top**:`goto(lid)` 叶目标落为 `top_lid = lid`;容器目标先解析到子树首叶,再作为 top。显式定位的语义是"从这里开始读",而不是把目标挤到窗口中心。

5. **已读账本按区间记账,进度按 top 计算**:`scroll` 把新可见区间内所有叶标记为已读,与连续滚动的"窗口划过即经过"语义一致。进度百分比从 `anchor_idx / leaf_total` 改为 `top_idx / leaf_total`,反映当前阅读区间起点。

6. **前端使用原生滚动驱动的虚拟流**:前端持有大于可见区的叶缓冲,通过浏览器原生滚动条/滚轮滚动。滚到缓冲边缘时调用 `reader.scroll(+/-N)` 拉取下一段并追加/回收,避免整窗替换和 CSS 假滑动。

7. **highlight 仍嵌入正文,note 卡回到正文 seg 循环**(S13a 回退):段内 highlight 继续在 `renderSeg` 里渲染 `<mark>`;note 卡在每段后按 LID 渲染,与 highlight 卡同类位置。S12d 曾把 note 拆到独立 overlay 层以隔离虚拟列表回收,但其造成的阅读割裂感高于回收闪烁的收益,故 S13a 回退为段内渲染;note 内容仍来自 memory,按可见 LID 集过滤。

8. **移除 TopBar 翻页按钮**:连续流不再提供显式上/下翻页按钮。桌面无滚轮场景以键盘方向键/PageUp/PageDown 作为兜底,不占用 TopBar 空间。

## 命门

- `scroll(delta)` 的 delta 是区间 top 平移量,不是"锚点移动量"。实现若仍用 anchor 中心化计算,会复发整屏替换。
- `goto(lid)` 必须让目标叶成为 top,否则目录和 note source 的"从这里读"语义会被上下文挤偏。
- 进度必须使用 `top_idx`,已读必须覆盖新可见区间;否则连续流下账本和用户体感会脱节。
- note 内容仍来自 memory(单一真相源),seg 循环只负责按 LID 过滤和定位展示。

## 否决

- **保留窗口模型只改步长**:仍保留中心化 anchor,只是把大跳变成小跳,无法获得真实连续流。
- **整窗替换 + CSS 过渡**:快滚和长书下仍会闪烁,只是用动画掩盖 DOM 重建。
- **前端回传 anchor**:扩出前端到后端的写回路径,破坏现有命令优先边界。
- **后端固定 7 叶 + 前端并发预取**:请求倍增,快滚时容易堆积,且仍受旧 viewport 宽度约束。
- **note 卡回到嵌入正文 seg 循环**(原 S12d 拆出 overlay 的理由):隔离虚拟列表回收的收益不足以抵消阅读割裂;S13a 接受段高估算含 note 的轻微偏差。
- **保留翻页按钮改为一屏或一叶**:连续流主入口已是滚动;按钮会保留旧翻页心智。
- **agent chat 附带前端 top_lid 改契约**:扩 HTTP/orchestrator 契约换取的精度有限;Ask AI 选区已覆盖精确锚定场景。

## 何时回头

- 真书快滚时若 `width=20` 仍出现接缝,再调 viewport 默认宽度和边缘预取阈值。
- 如果裸 `agent.chat` 在无选区场景频繁误判用户位置,再评估临时 `top_lid` 字段或 anchor 偏上计算。
- note overlay 若定位成本过高,先降级为仅在右 rail Notes tab 稳定展示,正文 overlay 留后续刀。

## 影响

- 修订 [[ADR-0027]] 的 viewport 语义:从中心化叶序滑动窗口升级为可配宽度区间窗口。
- `crates/reader` 需要重写 `Viewport`, `Reader` 状态,`viewport/goto_lid/scroll/state/render` 测试。
- `crates/server` 和 `packages/web/src/api.ts` 需要同步新的 `Viewport` DTO。
- `packages/web` 需要引入 reader 虚拟滚动缓冲、移除 TopBar 翻页按钮、调整进度计算、拆出 note overlay。
