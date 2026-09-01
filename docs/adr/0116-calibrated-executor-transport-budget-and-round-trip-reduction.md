# ADR-0116 Calibrated Executor transport budget and round-trip reduction

Status: Accepted design, 2026-09-01; D0/M1/M1b/M2/A2/R1/R2/W1/S1 implemented, A1 rejected by its bootstrap stop condition, S2 tail-balance trial rejected as unverifiable with scheduler unchanged.
Revises: ADR-0114 §1-§2 对 `2,048 estimated tokens / 8,192 bytes` 的宿主硬闸表述。
Extends: ADR-0115 的 Session V3、共享 Executor MCP、直接字段校验与前向接管边界。
Change type: [边界重构].

32 个成功候选的实测中，工具调用与模型可见协议步进约占成功 Executor 活跃时间的 70%，而启动与收尾只占 1.9%。当前 `2,048/8,192` 来自本地 `CODEX_EXECUTOR_TRANSPORT_PROFILE_V2`；仓库只证明 8 KiB 结果可达、317,247-byte 单次结果不可达，没有证明 2,048 tokens 是 Codex/MCP 的最大值。公开 [OpenAI MCP 指南](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)未声明该上限；[Programmatic Tool Calling 指南](https://developers.openai.com/api/docs/guides/latest-model#programmatic-tool-calling)建议把无需逐步模型判断的有界工具密集流程交给程序执行，并以代表性任务比较质量、延迟、tokens 与成本。实施顺序见[切片方案](../切片方案-executor传输标定与协议往返压缩.md)。

## §1 传输预算语义

**决策**:2,048 只作待标定基线。

**否决**:
- 把 2,048 写成官方宿主上限:没有公开合同或失败边界证据。
- 删除所有单次结果上限:会恢复不可预判截断与上下文失控。
- 用单一常量同时代表 carrier、上下文和 batch:三者失败条件不同。

**命门**:分别记录宿主可达的 serialized-result byte 档位、模型可见 token 预算和单次协议 batch 上限；标定前生产值不变。
**何时回头**:OpenAI 公布明确合同，或受支持宿主的阶梯探针给出新的通过/失败边界。
**展开**:[M2 宿主容量标定](../切片方案-executor传输标定与协议往返压缩.md#m2-宿主容量标定)

## §2 优化顺序

**决策**:先量内外时延，再改协议。

**否决**:
- 先做长期 worker:启动与收尾不是当前主要成本。
- 先提高并发:只会并发复制同一串行协议成本。
- 先拆 submit:尚不知 writer、next render 与 transport 各占多少。

**命门**:同一批固定 work units 必须同时产出 server elapsed、outer elapsed、响应字节和 action kind；后续先处理总耗时较大的已观测部分。
**何时回头**:内外样本无法按 child/operation/ordinal 一一对应时，先修观测，不进入行为实验。
**展开**:[M1 内外层计时](../切片方案-executor传输标定与协议往返压缩.md#m1-mcp-内外层计时)

## §3 输入领取合并

**决策**:批量领取不改变语义边界。

**否决**:
- 逐 chunk 强制模型重新判断:中间没有新的语义分支。
- 未标定就返回任意大输入:会把原截断事故换一个接口重现。
- 新增第五个 Executor 工具:现有 exact-four 表面可用同一 `input.next` 前向演进。

**命门**:先以程序化循环 A/B 隔离模型步进成本；需要减少 MCP 次数时，`input.next` 只返回有界连续 batch，最终 ordinal 的确认可由 `generation.start` 接收，attempt 仍只在 start 被接受时创建。
**何时回头**:任一 replay、丢失响应或错序测试会重复/遗漏字节，或候选质量门相对基线退化。
**展开**:[A1-A2 输入领取实验](../切片方案-executor传输标定与协议往返压缩.md#a1-程序化领取-ab)

**实施回执**:A1 在 `shell_tool=false` 专用角色中未获得 `functions.exec`，于 0 次 Executor MCP、0 attempt、0 commit 时失败关闭；生产指令不变。M2 的 64 KiB passing tier 与 M1 的 `input.next` per-call 成本仍满足 A2 进入条件。

**A2 回执**:exact-four 不变；`input.next.v4` 返回不超过 64 KiB 的连续 batch，非 final batch 由下一次领取确认，final ordinal 由 `generation.start.v3` 原子确认并创建或重放同一 attempt。5-chunk 真实 Codex 0.149 A/B 的三次 A2 中位数为 4 MCP、server 4,708.937 ms、outer 4,819 ms，相对 9 MCP、4,861.718 ms、5,086 ms baseline 分别下降 3.14% 与 5.25%，且三次均为 1 attempt/1 commit；保留 A2。四档真实计时与端到端 token/墙钟未采集，见性能证据 Limitations。

## §4 冻结输入复用

**决策**:冻结输入只渲染一次。

**否决**:
- `generation.start` 再启 renderer:模型已收到的冻结字节不会因此更真实。
- 删除 current task/owner/policy 校验:会允许过期 delivery 启动 attempt。
- 只信路径或 agent 自报:不能绑定模型实际收到的字节。

**命门**:open 时生成并持久化 frozen input；start 时重验当前控制身份和既有 input binding，按冻结记录登记 observation，不再执行 stage input 子进程。
**何时回头**:存在受支持的状态变化只能由二次 renderer 发现、而现有 current-state/binding 校验无法表达。
**展开**:[R1-R2 冻结输入复用](../切片方案-executor传输标定与协议往返压缩.md#r1-public-frozen-input-复用)

**R1 回执**:public `generation.start` 复用 create-only generation input，按当前 task binding 校验并记录 delivered bytes observation，不再启动 stage renderer；private 路径保持原状。Codex 0.149 固定 5-chunk fixture 的 start server 从 A2 三次中位数 `1,463.093 ms` 降至 `326.953 ms`，input-render-or-reuse 从 `1,162.372 ms` 降至 `15.069 ms`，1 attempt/1 commit 不变，保留 R1；单次真实样本限制见性能证据。

**R2 回执**:private `generation.start` 复用 create-only generation input material，并以当前 task/Blueprint/output contract 直接比对冻结 task bytes；start 的 segment packing `4 → 2`。三次 direct Core synthetic 对照的 input-render-or-reuse 中位数从 `8.504 ms` 降至 `5.058 ms`，两阶段总中位数从 `119.609 ms` 降至 `118.514 ms`；private sink、replay 与 artifact commit 不变，保留 R2。该计时不代表 Codex outer/model 墙钟，见性能证据 Limitations。

## §5 Submit 与下一单准备

**决策**:提交重活先分段计时。

**否决**:
- 直接把 next open 拆成额外调用:可能降低单次响应却增加总往返。
- 把 writer 改成后台成功:会破坏 durable commit 与 DONE 权威。
- 无证据地预渲染整阶段:扩大无用工作和阶段尾部成本。

**命门**:`submit_candidate` 至少区分 candidate gate、writer/commit、next-work prepare 三段；只有主导段被实测确认后才拆对应切片。
**何时回头**:M1 已能从现有事件精确还原三段且无需新增代码观测。
**展开**:[M1b 服务端阶段归因](../切片方案-executor传输标定与协议往返压缩.md#m1b-服务端阶段归因)

**W1 回执**:同版本 Codex 0.151 fixed fixture 中，proof-bound Pass1 writer 改为当前 deterministic build 进程内同步提交；其他 stage writer、submit 接口与 DONE durable 门不变。`writer/commit` 从 `1,195.960 ms` 降至 `71.313 ms`（`-94.04%`），`submit_candidate` server 从 `1,612.416 ms` 降至 `510.616 ms`（`-68.33%`），两边均为 4 MCP、1 attempt、1 commit，保留 W1。单样本与宿主版本限制见性能证据。

## §6 调度与长期 worker

**决策**:调度复用最后优化。

**否决**:
- 把一个 child 改成无限接单:扩大语义上下文与隐私生命周期。
- 以 executor session 数估算语义吞吐:一个 session 可完成多个 work units。
- 在没有 kind 余量时承诺整本 ETA:阶段单位成本与 barrier tail 不同。

**命门**:先公开 remaining work units by kind、slot occupancy 与 barrier tail；只针对最大已观测空闲来源改调度，长期 worker 不是默认目标。
**何时回头**:P1/P2 后启动与 refill 成为最大的可避免墙钟成本。
**展开**:[S1-S2 调度利用率](../切片方案-executor传输标定与协议往返压缩.md#s1-剩余工作与槽位事实)

**S1 回执**:`automatic-build-observation.ts` 从 snapshot descriptor 与 active lease/start durable records 按 `stage + kind` 投影 pending/reserved/running/terminal；`automatic-build.ts remaining-work` 公开同一无正文结果。R7 reducer 为每次 `list_agents` 生命周期事实保留 `observed_at_ms + live_slots`，区间投影再计算 `observed_ms` 与四类 idle reason。32-unit fixture 精确得到四态各 8，trace fixture 的 10 ms refill-gap 与 35 ms tail 区间可由 wall-time 复算；49 条相关回归、Core typecheck、384-module Build Engine 与 Node/compiled/thin-plugin parity 全绿。

**S2 证据**:同宿主 Codex 0.151 四任务/三槽 trace 中，`root_refill_gap=18,076 ms`，idle-slot 上界 `54,228 ms`；`tail_imbalance=38,203 ms`，idle-slot 下界 `76,406 ms`，因此只进入 tail 分支。9-unit `[4,4,1] → [3,3,3]` A/B 的 baseline 完成 9/9 且 tail 为 `48,640 ms`；balanced 两次均完成 durable 9/9，却分别在 15/25 分钟内未形成完整 root terminal lifecycle，无法比较 tail。实验 planner 已撤回，生产调度不变；证据见 `understand-book-s1-real-scheduling-observation.json` 与 `understand-book-s2-tail-balance-trial.json`。
