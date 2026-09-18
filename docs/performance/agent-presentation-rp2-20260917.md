# RP2 内容版本与持久化

状态：RP2 完成，2026-09-17。验收对应[切片方案 §6/§7](../切片方案-Agent富呈现与读时内容制作.md)。

## 已实现行为

- `runtime::presentation` 定义内容、归属、不可变候选、固定版本及公开引用。内容保存逻辑文件、入口、语义文字、既有来源绑定、假设、状态合同和初始值。
- Server 在私有历史文件旁保存 `agent-history.presentations/candidates/<candidate_id>.json` 与 `versions/<presentation_id>/<revision>.json`。写入临时文件并同步后，以不覆盖方式发布；失败返回实际错误。
- 创建、保存要求当前书籍和所属会话中的 pending 制作回合；候选不能交给另一回合保存。历史会话可以在非活动状态读取，跨书、跨会话引用均被拒绝。
- 每次修改生成独立候选，显式保留 `based_on`。保存新版本递增编号，旧内容不变；基于旧版继续编辑也分配新的编号。重复保存同一候选返回原引用。
- `AgentAnswerPart::Presentation` 仅包含内容身份与版本号。`finalize_agent_turn` 核对版本实际存在及其书籍/会话归属后，再走原有历史原子提交。候选保存、版本保存和历史提交是不同阶段；保存失败不会被当作成功交付。
- 重新建立 Reader 状态并加载磁盘历史后，可按原引用读取完整版本及来源、初始值。HTML/JS 不进入历史消息。前端来源按钮分支显式匹配 `sources`，为新增引用联合类型保持正确收窄。

## 验证结果

Windows 本机执行；文件与历史均使用真实文件系统，未模拟存储端口。

| 验证 | 结果 | 检测的具体失败 |
| --- | --- | --- |
| `tests::presentation_store_tests` | 6 项通过 | 旧版被覆盖、重开引用错版、旧版编辑丢失基准、重复保存增生版本 |
| 同组错误与归属场景 | 包含于上述 6 项 | 未保存候选被提交，候选/版本/历史失败更新内存或公开引用，跨书/会话/回合混用，取消替换旧版，私有路径不可用却宣告保存 |
| Server `agent_history` | 6 项通过 | 历史读写原子性、重开与旧历史投影退化 |
| Server `agent_source` | 5 项通过 | 原有来源绑定、公开投影及归属读取退化 |
| Server `resident_` | 22 项通过 | 运行取消、终态保存失败、切书/切会话边界、状态锁及恢复退化 |
| Runtime `answer_stream` | 4 项通过 | 回答片段、来源规则与增量投影退化 |
| Runtime `export_bindings_` | 54 项通过 | Rust 与共享 TypeScript 联合类型不一致；包含新增 `PresentationRef` |
| Web `typecheck` | 通过 | 新回答联合类型引起访问错误字段 |
| `RightRail.test.ts` + `agent-run-state.test.ts` | 20 项通过 | 原 Markdown、来源按钮和运行投影行为退化 |

失败时应修正对应存储提交顺序、归属检查或联合类型分支，再重跑受影响项。本次上述验证全部通过。

标准复跑命令：

```text
cargo test -p server --lib tests::presentation_store_tests -- --test-threads=1
cargo test -p server --lib agent_history -- --test-threads=1
cargo test -p server --lib agent_source -- --test-threads=1
cargo test -p server --lib resident_ -- --test-threads=1
cargo test -p runtime --lib answer_stream -- --test-threads=1
cargo test -p runtime --lib export_bindings_ -- --test-threads=1
pnpm --filter @understand-book/web typecheck
pnpm --filter @understand-book/web exec vitest run src/components/RightRail.test.ts src/agent-run-state.test.ts
```

本次 Server 最初使用 `cargo test -p server --lib presentation_ -- --test-threads=1`，实际命中 RP2 六项及现有两项同名相关测试，8/8 通过；随后直接执行同一次构建的 `target/debug/deps/server-4d9f77fee3a9dd6b.exe` 跑三个回归筛选。Runtime 新构建使用 `D:/codex-build/understand-book-rp2/target`，临时目录使用其旁的 `temp`；设置 `CARGO_PROFILE_TEST_DEBUG=0`、`CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_INCREMENTAL=0`，仅作用于本次命令。没有修改仓库构建 profile。

## 已知限制

- RP2 提供内部 Reader/Server 接口与可持久引用；富内容 HTTP 读取、实际挂载、共同样式和来源编译在 RP3，预览及制作工具调度在 RP4。当前产品入口尚不生成这类回答。
- 当前保存状态合同与初始值；用户运行中的现场保存、追问回执和跨版本参数接纳按 RP5/RP6 接入。
- 候选与已保存但尚未提交的版本保留于私有目录，不自动替代已交付内容。本切片没有增加候选清理策略。
- RP2 本次验证为 Windows 文件系统及宿主回归；未重新部署 Linux 或制作桌面安装包。RP1 两平台浏览器证据仍见原记录。
- 本机 C/E 盘空间紧张；Server 编译沿用 RP1 的 `_LINK_=/DEBUG:NONE /PDB:NONE`，后续新增构建转至 D 盘。缓存清理被自动审批策略拒绝，既有缓存保留。
