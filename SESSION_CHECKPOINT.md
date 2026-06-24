# SESSION_CHECKPOINT — 2026-06-25 00:12

## 新鲜度自检
- 写入时最新 commit:`ed72e45`(切片1 修缮 B,已 push)。本次文档落档 + checkpoint 将随下一 commit 推送;读入时若 git log 更新,以 git log 为准。
- 读入时请对比 `git log -3`,不一致以 git log 为准。
- ⚠️ 工具坑:Windows PowerShell `Set-Content -Encoding UTF8` 会加 BOM;写文档用 `.NET UTF8Encoding(false)`。`apply_patch` 当前会被 Windows sandbox helper 拒绝。
- ⚠️ `server.exe` 易被残留旧进程锁住致 `cargo run` 不重建 → 实测前先 `Stop-Process -Name server -Force`。

## 当前在做什么
切片1「前端阅读器」仍剩 S10e 打包收尾;本轮只做文档落档:补了 LID 隐形后的目录/搜索定位两刀(S10h/S10i)、asset 原文前端渲染保证(S10j)、asset 刀前置段/句粒度体检(SA0)与 ADR-0032。

## 下一步(可直接接手)
1. **S10e**:在 `crates/server/src/main.rs` worker 里加静态文件分支:非 `/book/`、`/reader/`、`/memory/`、`/agent/` 前缀的 GET → `dist/<path>` + MIME + `index.html` fallback;然后 `skills/read/SKILL.md` 一句话启动同端口 SPA+API。
2. **S10h/S10i**(前端 UX 修缮):隐藏默认 LID 输入;用目录/章节导航 + 自然定位搜索 + 标注/引用回跳作为用户入口,内部仍调 `reader.goto(lid)`。
3. **S10j**(asset 前端保证,依赖 asset 刀完成):读取 `ManifestNode.kind`,按 kind 渲染 `Code/Table/Image` 的 `book.text(asset_lid)` 原文。
4. **asset 刀 SA0–SA5**:先做 `GranularityProfile` 段/句粒度体检并让用户确认 `paragraph/hybrid/sentence`,再做 Code/Table/Image 一等叶子。

## 未提交 / 未完成
- 本 checkpoint 写入时有文档改动待提交:切片1前端方案、asset 方案、ADR-0032、SESSION_CHECKPOINT。
- 代码无改动;本轮未跑测试。
- S10c/f/g + 修缮 A/B 的 B2 真跑/浏览器人工验仍未闭。

## 冷启动读序
1. `docs/切片方案-切片1前端阅读器.md` — S10e 待做;§5 S10h/S10i;§6 S10j。
2. `docs/切片方案-asset一等对象.md` — SA0 粒度体检 + SA1–SA5 asset 一等对象。
3. `docs/adr/0032-段句粒度体检-先统计再选择paragraph-hybrid-sentence-避免默认全书句级.md` — 粒度决策。
4. `docs/adr/0029-asset一等对象-带类型lid叶子-image原文源标记序列化-manifest暴露kind-图谱层一视同仁.md` — asset 数据契约。
5. `docs/adr/0028-前端切片架构-vue-localhost-server-crate-tinyhttp同步-rest命令面1对1投影-不引epub框架-连续正文lid隐形-无页码寻址.md` — 前端架构/S10e 同源打包。
6. `crates/server/src/{lib.rs,main.rs}` + `packages/web/src/{App.vue,api.ts,style.css}` — 实现入口。

## 本会话决策摘要
- **S10h/S10i**:LID 是内部坐标,默认 UI 不暴露裸 LID;用户通过目录、搜索、标注/引用回跳定位,前端内部携带 lid 调命令面。
- **S10j**:asset 刀负责 `ManifestNode.kind` + `book.text(asset_lid)` 原文;切片1前端负责按 kind 渲染 code/table/image,不能当普通 paragraph 糊进正文。
- **ADR-0032 / SA0**:不默认全书句级;正式构建前先统计段/句分布和 LID 膨胀比,推荐 `paragraph/hybrid/sentence`,由用户确认粒度。
