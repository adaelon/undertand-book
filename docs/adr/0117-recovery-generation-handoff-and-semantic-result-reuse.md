# ADR-0117 Recovery-generation handoff and semantic-result reuse

Status: Accepted design, 2026-09-02; RG1–RG8 runtime implemented. Public-dispatch zero-call bootstrap recovery added 2026-09-07.
Extends: ADR-0092, ADR-0099, ADR-0101, ADR-0103, ADR-0115 and ADR-0116.
Extended by: [ADR-0121](0121-bounded-build-state-reads-and-executor-lifecycle.md)；明确新引用使用新 child，规划连接状态错误的有界恢复与控制面读路径优化；这些后续运行切片尚未实施。
Revises: ADR-0114 §4 中“丢失 generation.start 结果总是重放同一 attempt”的边界；只允许仍属当前恢复代际的 active lease 重放。
Change type: [边界重构].

真实 Pass1 恢复记录证明，过期 lease 的 replacement child 会经相同 handoff、delivery、generation start、task session 与 candidate sink 重放 epoch 1，直到 submit 才发现 lease expired；MCP 总兜底又把该错误与候选超限、sink/session 故障统一伪装成 `bootstrap/protocol_incompatible`。同一 ref 既被 Driver 要求复用，又被 root 的 `completed_refs` 禁止再次启动，形成“重复启动则死循环、严格去重则永久停住”的合同冲突。实施顺序见[切片方案](../切片方案-executor恢复代际与语义结果复用闭环.md)。

## §1 结果身份与恢复身份

**决策**:恢复代际只改变控制面身份。

**否决**:
- 把 lease epoch 写入 artifact freshness:会重跑仍 fresh 的昂贵模型结果。
- 把 recovery ref 当 task binding:会让调度恢复污染语义作用域。
- 复用过期 session/sink:会把无效执行权伪装成有效生成状态。

**命门**:`target/source + work-unit input + prompt + semantic contract` 继续决定结果复用；`dispatch/run + current work unit + semantic attempt + lease epoch` 只决定一次可启动 handoff。
**何时回头**:恢复字段真实改变模型可见 prompt/input 或输出 Schema 时，让该变化进入既有语义身份，不扩大控制身份。

## §2 Handoff 前向版本

**决策**:新增恢复代际 handoff 版本。

**否决**:
- 原地修改 V3 ref 算法:升级后旧 create-only record 将无法按原身份读取。
- 用时间或随机 nonce 签发:同一有效恢复代际会产生重复 Executor。
- 改 dispatch id 取得新 ref:会丢失同一 run 的 progress 与完成前缀。

**命门**:旧 V3 record 保持可读；新 public record 显式携带 recovery identity，相同五元组生成同一 ref，任一字段变化才生成新 ref。
**何时回头**:宿主提供原生、持久且代际化的单次任务句柄时，可用其替代本地 opaque locator。

## §3 Driver 与 Root 去重合同

**决策**:Driver 按恢复代际索引，Root 按调度槽占位。

**否决**:
- 继续只按 dispatch/run replay:会在 epoch 变化后返回旧 ref。
- Root 只按 ref 占 live:child 跨单元时会重复启动同一 dispatch。
- 为每次 `build.step` 重新签发:会并发复制仍 active 的同一 lease。

**命门**:`completed_refs` 保证同一恢复 ref 最多启动一次；稳定 dispatch slot 保证跨 ref 仍最多一个 live child；manifest/run 保持不变。
**何时回头**:Root 能把可信 child terminal generation 回传 Driver 并由 Driver 原子接管去重时，可合并 projection，不能删除代际区分。

## §4 Generation replay

**决策**:重放前先判当前任务与租约。

**否决**:
- `existingStart` 无条件提前返回:会把 expired lease 继续暴露为 `GENERATE`。
- 只移动提前返回位置:末尾 create-only start 仍会返回旧 response。
- 覆盖旧 start/session/sink:破坏幂等历史且无法解释旧 child。

**命门**:current active lease 才 byte-identical replay；terminal task 投影下一单元或 DONE；expired/stale call 返回类型化错误，由 Driver 为当前 attempt/epoch 发行新 handoff、delivery、grant、session、sink 与 start。
**何时回头**:若 generation grant 原生绑定可续租 session 且能证明旧 sink 在新 token 下不可提交，可缩短记录链但保持三分支。

## §5 错误与持久失败

**决策**:工具错误按实际阶段分类。

**否决**:
- 所有异常映射 `bootstrap/protocol_incompatible`:会抹掉 lease、transport、sink 与 writer 的真实恢复动作。
- 返回原始异常、路径或 candidate:越过有界诊断与语义隐私边界。
- 候选超限只抛异常:任务不产生 durable terminal，Driver 会无限重派。

**命门**:`protocol_incompatible` 只表示版本/协议不兼容；lease/session/sink/transport/writer 使用 allowlisted code 与 phase。已解析到当前 task 的候选超限写 `writer_started=false` 的 retryable failure，下一次重新生成。
**何时回头**:统一 tracing 能原子写入同一 task terminal truth 时，可由 tracing 投影错误，仍不得回退总兜底。

## §6 候选传输合同

**决策**:生成侧显式获得 token 与 byte 上限。

**否决**:
- 只暴露 `max_bytes`:合法 byte 候选仍可撞到隐藏 token gate。
- 直接提高 2,048:当前值是待标定本地基线，不是已证明宿主上限。
- 把 transport 上限写入 semantic contract:基础设施预算变化会错误失效 accepted artifact。

**命门**:output contract 显式区分 candidate value 与 serialized request 的 token/byte 预算；入口仍校验完整请求，超限形成类型化持久结果，但不改变 Pass1 policy generation 或 artifact identity。
**何时回头**:宿主提供可验证 tokenizer 与结构化输出硬约束时，可替换 estimator，不能重新隐藏 admission limit。

## §7 升级与既有 Pass1

**决策**:升级只重跑没有成功结果的单元。

**否决**:
- 清理整个 task/artifact store:会丢失已提交 Pass1 与 append-only 证据。
- 为控制协议升级提升 Pass1 policy generation:会把恢复修复伪装成语义迁移。
- 把 `start.json` 或 active lease 当完成结果:两者都没有 accepted artifact 权威。

**命门**:同 workspace 下仍匹配语义复用身份的 generation artifact、receipt 与 progress 原样保留；只有无成功 artifact/receipt 的当前单元由新恢复代际接管。
**何时回头**:source/input/prompt/schema/semantic contract 真实变化时按现有 policy migration 重建受影响单元，不由本 ADR 放宽 freshness。

## §8 Bootstrap 与静默终止

**决策**:零调用 bootstrap 与会话恢复分账。

**否决**:
- 用 startup timeout 解释所有 interrupt:现有记录只证明四次零调用与时间边界吻合。
- 因一次并发启动成功否认瞬时失败:成功只排除稳定安装损坏。
- child 无 final 就重启同 ref:再次违反恢复代际去重。

**命门**:零 backend call 记 bootstrap unavailable/timeout evidence；已进入 session 的 child terminal 只信 durable state，未完成 lease 到期后由新恢复代际接管。提高 timeout 必须有独立启动证据。
**何时回头**:宿主持久记录 MCP startup 结果与 child terminal reason 后，用原生事实替代时长推断。

## §9 零调用启动代际

**决策**:失败上报只推进 bootstrap epoch。

**否决**:
- 重试同 ref：与 Root completed_refs 去重冲突。
- 伪造 semantic attempt 或 lease：启动失败没有执行语义工作。
- 凭 child final 覆写已 open 状态：生命周期观察不能替代持久事实。

**命门**:Root 向 build.step 回报所属 invocation 的 public ref；未 open 且仍 current 时写入幂等启动失败记录。恢复身份 V2 增加 bootstrap_epoch；既有 V1 与 V4 ref 的字节/派生规则保持不变。失败三次后由 NEEDS_USER/retry_bootstrap 限定后续重试。
**展开**:[实现与测试](../修复-executor-bootstrap-20260907.md)。
