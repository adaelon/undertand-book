# SESSION_CHECKPOINT — 2026-09-08 16:40

## 新鲜度自检

- 合并提交基线：`9e36507 feat(build): complete executor transport compression`；本文件随 LA/LX 合并交付，最新提交以 `git log -1` 为准。
- 读入时比对最新git记录；本次仅合并 LA/LX 及其评测与部署文档；前序 V1、插件及其他未提交工作继续保留。

## 本轮完成

用户目标“阅读checkpoint，实现LA7–LA10，完成后刷新checkpoint”已完成实现、实测及落档。完整产品质量目标未全通过，失败与返回切片明确保留。

- LA7固定32题：Agent15/24、Chunk20/24；实际跳转4/4、回答引用动作完整1/4；重启准备/持久化/恢复均4/4。
- Agent平均97,359.25 tokens、P95 114.85秒；Chunk一次usage缺失，平均N/A。旧Agent13/24、Chunk22/24基线不改写。
- LA7请求用途分账完整：业务循环、内层查询/综合、来源修复、终答、压缩、后台、判分和未分类；失败和缺失usage保留。
- LA8同环Text/Tree/Graph显式实验完成：内存Book视图、同注册表直接/discovery限制、环境/sidecar隔离、真实模型输入标记测试。
- LA9固定72样本全部完成：Text10/24、Tree11/24、Graph9/24；平均tokens分别85,729.96、101,842.04、95,171.38。
- Tree对Text增4失3，平均成本+18.79%；Graph对Tree增2失4。保留LID，不扩大默认图谱使用，不从单次开发集作正向推广。
- LA9实际599请求/6,785,841 tokens，usage完整；27样本在途超额，最大19,351，10次后续上游请求被预算拒绝；正文并集最大11,465/12,000 UTF-16。
- LA10真实前端七阶段通过：选区解释、弹窗不导航、显式open、保存笔记、进程重启、新聊天恢复、两章来源点击。
- 修复Markdown askSelection丢失精确provenance；source.open改视口后漏存session；已读范围引文错误单列SOURCE_QUOTE_MISMATCH，允许更正/省略quote，不放宽证据闸。
- 最终Runtime318 passed/3既有ignored、Server241 passed、评测器28 passed；真实UI及来源持久化红绿证据保留。

## 结果与固定程序

- LA7：`tmp/la-final-colon/server.exe`；`evals/semantic/results/2026-09-08-la7`。
- LA8接入：`2026-09-08-la8-probe`三题通过；初版LA9因无显式输出上限停为invalid_configuration，2条样本不拼接。
- LA9：`tmp/la9/server.exe`；`evals/semantic/results/2026-09-08-la9-v2`。此程序早于LA10位置修复及LA7后续来源提示修复，批次内未替换。
- LA9冻结：deepseek-v4-flash/温度0/12轮/300秒/输出8000/实际累计120000/终答预留20000/唯一正文12000；按题循环轮换三组。
- LA7后续：`tmp/la7-followup/server.exe`；`2026-09-08-la7-followup`。contrast-04/source-02/source-03通过；formula-04仍终答协议失败，独立结果不替换全量。
- LA10：`tmp/la10-final/server.exe`及正式Web dist；`tmp/la10-v4/run.json` passed，末步等待修正后接续同一持久回答，原失败run-initial.json保留；匿名结果`2026-09-08-la10/summary.json`。
- 历史构建：书目录7,861文件/34,814,058字节/530条metrics；实际tokens和墙钟未知，不重建、不计算数值回收点。见LA9 prebuild.json。
- 公开summary/report不含原文请求；run.json与tmp行为证据仅本地。最终测试和交付核对日志在`tmp/la7-la10-final-*`、`tmp/la7-la10-delivery-check.log`。

## 后续入口与已知问题

1. 先读`docs/LA7-LA10实施与验收.md`，再按问题回到LA3–LA6；LA7–LA10不再是待实施切片。
2. 来源选择/范围与终答可靠性仍未达全量质量目标；formula-04后续复验仍违规终答。不要靠提高预算、拼接成功样本或接纳违规工具掩盖失败。
3. 标注器有改写引号/标点与布尔反填，严格分数保留；LA9部分Tree表面增益受标注影响。单书单次、同模型家族标注和开发机并行负载限制结论。
4. 后续若要在README主张某项能力有普遍收益，先用新冻结题集复核；当前README保持谨慎结论。
5. 代码与文档未提交；Linux仍为前序部署版本，本轮LA修改未部署。不要重做已完成LX0–LX7。
6. 前序V1候选已实现未提交；旧/新宿主A/B、真实模型child故障注入和正式发布待后续，见`docs/performance/understand-book-v1-release.md`。
7. Mastering Rust未续跑：`E:\allwork\download\agent\lifebook\.understand-book\mastering-rust`；保留原plan/invocation/accepted、Pass2 disabled和三槽约束。

## 并行 Linux 完成状态（保留前序成果）

- LX0–LX7完成：真实Provider、阅读问答/来源/带读、PDF高亮/Note/翻译、v3成果、systemd重启与Windows入口联验通过；12阶段证据见LX7验收。
- veLinux2.2/CentOS Stream9 x86_64；Node24.20.0、pnpm10.34.2、Rust1.98.1。
- `understand-book.service`专用账户监听127.0.0.1:8787；native/DeepSeek/deepseek-v4-flash，凭据只在远端环境文件。
- 公网 `http://115.190.121.150:8080/`：机内401、原站点200、PID保持；外部TCP超时，等待云安全组TCP8080及用户网络验收。旧公共域名因备案拦截撤下。
- 源码 `/opt/understand-book/source`；书库 `/opt/understand-book/books`；私有数据 `/opt/understand-book/data/lx6/{memory,private}`；环境 `/opt/understand-book/reader.env`。
- 实测停止0.086秒，重启恢复位置/画像/PDF批注/聊天；测试进程和隧道已关闭，Linux常驻保留。该部署不含后来本地LA修改。

## 冷启动读序

1. 本checkpoint → `docs/LA7-LA10实施与验收.md` → 各批summary/report；不重跑已完成整批。
2. ADR0123、LA切片方案、LA1–LA6验收；代码链路/架构的LA7–LA10与来源反馈节。
3. 按问题触达experiment.rs、orchestrator.rs、read-tools Book视图、报告与continuous-reading脚本。
4. Linux仅按问题读LX7验收/JSON、部署说明和ADR0122，保留公网待验收状态。

## LA/LX 合并交付

- 用户要求一个 commit 并推送，再同步 Linux；暂存版本独立验证：Runtime 318/3 ignored、Server 241、CLI/MCP 6、评测器 28、迁入 3、Web 219 与正式 Web 构建通过；提交不包含预构建 V1 与插件更新。
- Linux 更新采用独立固定目录构建，保留原 source 与私有数据；构建通过后仅重启阅读器，原 80 端口程序保持。
