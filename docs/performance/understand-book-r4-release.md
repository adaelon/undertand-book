# R4 调用纠错编译、安装与宿主验收

日期：2026-09-14。范围：[ADR-0128](../adr/0128-root-guided-executor-call-correction.md) 的 R4。

## 编译入口

387-module Build Engine 已从 R1–R3 源码构建。真实宿主首次调用 `build.diagnose-child` 时发现打包入口未执行 `prepare`，导入依赖会误启动 `executor-prompt-cli`，以 `unsupported extractor prompt: build.diagnose-child` 退出。修复是在导入前设置 `build-child-diagnostic.ts` 入口，并保留原始诊断参数。

新增 compiled 入口回归验证：无 child 记录时退出 0、stderr 为空，stdout 为 `evidence_missing`。实时样本另将 compiled 诊断与源码读取结果直接比较。既有 T7 验收更新额外字段错误的旧分类，新增 75→73 字符拒绝、同连接成功打开和未知 open 版本维护边界。

## 宿主场景

`smoke-r4-call-correction.ts` 通过 CLI 安装源码插件并逐文件比较安装资产，在仓库外创建隔离小书、Codex home 和 Driver registry。仅复制现有认证，使用新编译程序和 installed launcher。合成 fixture 确认计划；执行中的语义输入和候选只属于 dedicated child。

三槽故障注入：live child 收到缺少末尾两字符的 ref；terminal child 收到另一条缺字符 ref；第三槽执行正确引用。隔离角色仅追加故障注入等待规则，使 live child 在原连接上等待 Root 的真实反馈，其他执行合同来自安装后的规范角色。Root 使用实际诊断结果纠正 live child，经生产 Driver 为 terminal child 换代并启动新 child。

真实宿主 `codex-cli 0.153.4` 验收通过，墙钟 302.797 秒。[宿主证据](understand-book-r4-host.json)记录了以下结果：

- live：Root 诊断出末尾缺少 `ef`，向原 child 发消息；同一 child 的两次 open 分别使用 73 字符错误引用和原始 75 字符引用，随后提交一次。
- terminal：Root 诊断出末尾缺少 `70`，保留 `session/invalid_arguments/open`；Driver 签发 bootstrap epoch 1 的替代引用，slot、semantic attempt 1 与 lease epoch 1 保持。重复观察没有再换代，新 child 提交一次。
- 换代时共 1 次语义尝试、0 次提交，正常 sibling 仍在执行；它随后成功提交。
- 共 4 个 child、3 次语义尝试、3 次 submit 调用、3 次持久提交；Root Executor 调用 0 次，terminal followup 0 次，用户操作 0 次。
- 最后再读生产 Driver 返回 `SPAWN_EXECUTORS`：本次三个验收单元完成，小书后续工作仍存在，没有把局部验收写成全书 DONE。

## 日常安装

[安装证据](understand-book-r4-install.json)：插件更新为 `0.1.0+codex.20260914042345`，通过已有 `understand-book-local` 市场重新安装。

- Build Engine：`E:/allwork/Understand Book/understand-book-build.exe`，与本轮构建逐字节一致。
- 缓存：`C:/Users/Lenovo/.codex/plugins/cache/understand-book-local/understand-book/0.1.0+codex.20260914042345`；源码、市场副本和新缓存的 10 个文件集合及字节一致。
- 项目角色注册返回 `source_state=same`，与新缓存规范模板一致；测试专用等待规则只位于隔离 home。
- 日常 launcher 在未设置 `UNDERSTAND_BOOK_BUILD_EXE` 的环境中通过注册表定位程序，四工具发现通过。
- 旧程序保留为安装目录下 `understand-book-build.exe.before-r4-20260914042345`；另存程序和旧插件到 `tmp/r4-install-20260914/`。原已启动进程继续使用旧映像，新连接读取新安装。

## 验证结果

[安装态 compiled T7](understand-book-r4-compiled.json)通过：未知 open 版本与旧 bootstrap 保持 `protocol_incompatible`，额外字段与短 ref 返回 `invalid_arguments`，短 ref 拒绝后同连接可正常打开；现有跨引用、终态、delivery、恢复与 oversize canary 保持通过。新诊断入口的缺证据返回和真实调用读取均经编译程序执行。

诊断读取与 MCP 定向测试 18/18，R4/T7 脚本严格 TypeScript 检查、Node/compiled outside-repo parity、插件结构与发布 gate 全部通过。首次错误分类红测和宿主入口失败均保留在 `tmp/r4-*` 及隔离目录，未通过修改语义断言掩盖失败。

## 可复跑入口

```text
node apps/desktop/scripts/build-sidecar.mjs
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-r4-call-correction.ts run <desktop-codex.exe> <host-evidence.json>
node node_modules/tsx/dist/cli.mjs apps/desktop/scripts/smoke-t7-executor-release.ts --sidecar <build.exe> --installed-plugin-root <installed-plugin> --evidence-out <compiled-evidence.json>
node apps/desktop/scripts/smoke-automatic-build-parity.mjs
node apps/desktop/scripts/assert-plugin-release.mjs --automatic-build-parity-prechecked --t7-executor-release-prechecked
```

两个 `prechecked` 参数只在对应当前程序验收已通过时使用。私有临时状态入口为 `tmp/r4-current-run.json`；报告只输出调用控制事实、恢复身份、提交计数和安装信息。

## 已知限制

- live 分支通过测试专用等待窗口确定性注入；证明实际 Root 反馈和原 child 恢复，不测量生产任务自然出现错误时收到反馈的概率。
- 宿主把持久化的协作消息正文加密。本次核验发消息目标、Root 的字段差异说明、child 后续精确 open 和持久结果，不宣称读取到了加密反馈正文。
- 初次系统临时目录安装被宿主拒绝，后续使用仓库外的独立目录。
- R4 不实施 ADR-0129 的追加组装；原 Mastering Rust invocation 保留，真实书续跑依赖追加方案的独立验收。
- 更新了本机 Build Engine 和插件，未重新打包 Windows Setup 或发布远程市场。已存在任务不会自动重载角色与 MCP 连接。
