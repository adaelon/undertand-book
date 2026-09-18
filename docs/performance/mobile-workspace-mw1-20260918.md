# MW1 确定性工作区投影

状态：实现完成，定向验证通过。日期：2026-09-18。

## 实现

- `workspace-layout.ts` 集中 single/compare/wide、732px 对照下限、低高度、输入优先和导航形态参数。
- `resolveWorkspace` 只消费逻辑布局、视口、交互状态和本地偏好；不访问 DOM，不调用 Reader、layout、goto 或 Agent API。
- 正式 slot 注册表只映射当前真实挂载的 `technical/paper.structure_map` 与 `technical/paper.agent`。未注册 slot 返回不可用状态，不把 RightRail 本地标签伪造成后端 slot。
- 焦点请求以 `contextKey + logical revision + slot` 标识；输入法组合或冻结选区期间延迟，保护结束后只处理最新且未消费的请求。

## 验证

- `workspace-layout.test.ts` 10 项通过：732px/200px 边界、零尺寸、wide、显式 compare、输入优先、保护延迟、旧请求去重、未注册 slot、未知 preset 和 bigint revision。
- 与 MW2/MW3 合并后的 Web 全量结果：49 个测试文件、255 项通过；类型检查与生产构建通过。

## 边界

MW1 没有更改后端 `ReaderLayoutState`、proposal revision 或任何持久数据。布局变化零 API 副作用由纯函数边界保证；真实 Agent API 请求计数在后续真实入口验收中继续核对。
