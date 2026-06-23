# SESSION_CHECKPOINT — 2026-06-23(S8 真跑结构红线 100%,未提交;下一步=人工试读+契约冻结=切片0 收尾)

## 新鲜度自检
- git 仓库,remote `https://github.com/adaelon/undertand-book.git`,默认分支 main。
- 写入时最新 commit:`1f868c9`(刷新 checkpoint:S7 已 push)。**S8 改动尚未 commit**(见「未提交」)。
- 读入时对比 `git log -3`,以 git log 为准。

## 当前在做什么
切片0 **S8 金标准集 + 验收闸**(切片0 收尾),针对**内层 `book.query`**做主度量。
**已完成**:harness 落地(47 测全绿 + clippy 净)+ **glm-5.1 真跑达标**:
- **结构红线 100.0%(12/12,0 悬空)** ⇒ 切片0 总判据①兑现、ADR-0004 结构红线真后端验证。
- 语义信号:mean_recall 1.00 / mean_precision 0.75 / incomplete 0 / errored 0;12 条全 local 档收口;answer 抽查贴原文。
**未做**:人工试读最终认可 + 命令面契约冻结(切片0 完成充要的最后两步)。

## 下一步(可直接接手)
1. **人工试读认可**(用户拍板语义质量):重看 goldset 报告 12 条 answer/citation(`cargo run -p runtime -- .understand-book/game-programming-patterns goldset crates/runtime/goldset/game-programming-patterns.json`)。
2. **冻结命令面契约为基线**(V3 §6,切片0 完成充要):在 `需求文档-V3.md` §6 标注「§4.1–4.4 命令面契约 + base-schema 自切片0 验证通过冻结为基线」,起一条收尾 ADR 或在 V3 §6 落冻结声明。
3. **commit + push**:S8 代码(goldset.rs/goldset/json/lib.rs/main.rs)+ 回填的 ADR-0004/0016 + 代码链路 + 契约冻结 + checkpoint。建议拆 2 commit:① S8 harness+真跑回填 ② 契约冻结(切片0 收尾)。
4. 切片0 收尾后 → 切片1+(句级 LID / Pass2 长程边 / synthesize 深路径 / reader 全集 / memory consolidation,见切片方案 §4)。

## 未提交 / 未完成
- **未 commit**(已测+真跑达标):`crates/runtime/src/goldset.rs`(新)、`crates/runtime/goldset/game-programming-patterns.json`(新)、`crates/runtime/src/{lib.rs,main.rs}`(改)、`docs/adr/{0004,0016}.md`(S8 回填)、`docs/代码链路.md`(S8 条)。
- 切片0 总判据未达项仅剩:人工试读认可 + 契约冻结(均在「下一步」)。结构红线/语义信号/闭环(S7)已达。

## 冷启动读序
1. `docs/技术方案-架构蓝图.md` — 架构全景 + §6 crate 依赖拓扑。
2. `docs/切片方案-切片0样板间.md` — §5 总判据(切片0 完成充要)+ §3 实测数字清单。
3. `docs/代码链路.md` — S0–S8 改动账本(末条 S8 真跑达标)。
4. `docs/adr/0004`(引用红线 + S8 真跑回填)、`0016`(双层 loop + S8 scope 回填)、`0027/0026`(reader/外层 loop)。
5. `crates/runtime/src/{goldset.rs, lib.rs}` — 金标准闸 / 内层 query。
6. `需求文档-V3.md` §6(切片0 总判据 + 契约冻结基线)+ §7.1(引用红线)。

## 本会话决策摘要
- **S8 选址**:金标准集针对内层 `book.query`(非外层 E loop)——结构红线度量干净/可复现/省 token;外层闭环已 S7 兑现。(落 `docs/代码链路.md` S8 条)
- **结构红线 vs 语义质量分工**(承 ADR-0004):自动验收只到结构红线(确定性、判据 100% 已达);语义 recall/precision 作人工评客观信号(建议 recall≥0.9 阈,precision 不设硬阈——额外真实引用不判负),最终人工试读认可由用户裁。(回填 ADR-0004「S8 真跑回填」)
- **runner 逐条容错**:provider 偶发空响应重试一次+errored 单列,不静默降级(ADR-0015 精神)。
