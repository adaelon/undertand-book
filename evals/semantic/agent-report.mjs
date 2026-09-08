import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK, AGENT, aggregateNatural, scoreNatural, scoringVersion, toolMessages, navigationOK } from './agent-core.mjs';
import { qaTasks, sourceTasks } from './agent-dataset.mjs';
import { loadCorpus } from './core.mjs';
import { measuredUsage, usageByPurpose } from './provider-recorder.mjs';

// HTTP-level turn failure has no OuterOutcome, but actual Provider tool attempts
// remain recorded. Keep them visible, including blocked finalization attempts.
export function reportToolTrace(row) {
  if (row.outcome?.trace) return row.outcome.trace;
  return (row.requests ?? []).flatMap(r => (r.response?.choices ?? []).flatMap(c =>
    (c.message?.tool_calls ?? []).map(t => ({request_ordinal:r.ordinal,tool:t.function?.name?.replace('_','.'),args:t.function?.arguments})).filter(t => t.tool)));
}

function toolCounts(outcomes) {
  const counts = {};
  for (const o of outcomes) for (const t of o?.trace ?? []) counts[t.tool] = (counts[t.tool] ?? 0) + 1;
  return counts;
}
function toolErrors(rows) {
  const counts = {};
  for (const row of rows) for (const m of toolMessages(row.requests ?? [])) {
    const code = m.receipt?.error_code;
    if (code) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}
export function recomputeScores(run, corpus) {
  // Keep raw run.json immutable, including its original provisional scores.
  return { ...run, scoring_version: scoringVersion, ...Object.fromEntries(['qa', 'navigation'].map(key => [key, run[key].map(row => {
    const task = [...qaTasks, ...sourceTasks].find(t => t.id === row.id);
    if (!task) throw new Error(`Unknown task ${row.id}`);
    const checked = task.category === 'source' ? { ...row, navigation_ok: navigationOK(task, row, corpus) } : row;
    return { ...checked, score: scoreNatural(task, checked, row.grade, corpus.source) };
  })])) };
}
export function publicAgentReport(run) {
  const rows = [...run.qa, ...run.navigation];
  if (rows.some(r => !r.score)) throw new Error('Some completed answers have not been graded');
  const summarize = row => ({ id: row.id, category: row.category, system: row.system, score: row.score,
    elapsed_ms: row.elapsed_ms, usage: row.usage, cost_by_purpose: usageByPurpose(row.requests ?? []), incomplete: row.outcome?.incomplete ?? false,
    tool_counts: toolCounts([{trace:reportToolTrace(row)}]), tool_sequence: reportToolTrace(row).map(t => ({ loop: t.model_tool_loop, request_ordinal:t.request_ordinal, tool: t.tool })),
    valid_sources: row.sources.filter(s => s.valid).length,
    navigation_ok: row.navigation_ok, error: row.error ? (row.error.match(/HTTP \d{3} ([A-Z][A-Z_]+)/)?.[1] ?? 'task_error') : undefined, grade_error: row.grade_error ? 'grading_error' : undefined });
  return { version: run.version, started_at: run.started_at, finished_at: run.finished_at, status: run.status,
    model: run.model, git_head: run.git_head, scope: run.scope, config: run.config, corpus: run.corpus, scoring_version: run.scoring_version,
    selected_ids: run.selected_ids,
    summary: Object.fromEntries([CHUNK, AGENT].map(s => [s, aggregateNatural(run.qa.filter(r => r.system === s))])),
    qa: run.qa.map(summarize), navigation: run.navigation.map(summarize),
    restart: run.restart.map(r => ({ id: r.id, kind: r.kind, success: r.success, setup_ok: r.setup_ok,
      persistence_ok: r.setup_ok ? r.persistence_ok : null, process_changed: r.before_pid !== r.after_pid, new_chat_empty: r.new_chat_empty,
      memory_observed_by_agent: r.memory_observed_by_agent, elapsed_ms: r.elapsed_ms, usage: r.usage, cost_by_purpose: usageByPurpose(r.requests ?? []), error: r.error ? 'task_error' : undefined,
      tool_counts: toolCounts([r.setup?.outcome, r.resume?.outcome]) })),
    tool_counts: toolCounts([...rows.map(r => ({trace:reportToolTrace(r)})), ...run.restart.flatMap(r => [r.setup?.outcome, r.resume?.outcome])]),
    tool_error_counts: toolErrors([...rows, ...run.restart]),
    cost_by_purpose: usageByPurpose([...rows, ...run.restart].flatMap(r => r.requests ?? [])),
    cost_by_system: Object.fromEntries([CHUNK, AGENT].map(s => [s, usageByPurpose([...rows, ...run.restart].filter(r => r.system === s).flatMap(r => r.requests ?? []))])),
    failed_task_usage: measuredUsage([...rows, ...run.restart].filter(r => !(r.score?.success ?? r.success)).flatMap(r => r.requests ?? [])),
    grading_usage: measuredUsage(rows.flatMap(r => r.grader ? [r.grader] : r.grade_error ? [{ error: r.grade_error }] : [])),
    background_usage: measuredUsage([...rows, ...run.restart].flatMap(r => (r.requests ?? []).filter(c => c.purpose === 'background_profile_review'))),
  };
}
const pct = n => n == null ? 'N/A' : `${(n * 100).toFixed(1)}%`;
const num = n => n == null ? 'N/A' : Math.round(n).toLocaleString('en-US');
export function agentMarkdown(report) {
  const table = Object.entries(report.summary).map(([s, m]) => `| ${s} | ${pct(m.evidence_recall)} | ${pct(m.citation_support)} | ${pct(m.success_rate)} (${m.succeeded}/${m.count}) | ${m.p95_seconds?.toFixed(2) ?? 'N/A'} s | ${num(m.mean_tokens)} |`).join('\n');
  const details = report.qa.map(r => `| ${r.id} | ${r.system.startsWith('Chunk') ? 'Chunk' : 'Agent'} | ${r.score.semantic_correct ? '✓' : '✗'} | ${r.score.success ? '✓' : '✗'} | ${r.valid_sources} | ${r.usage.requests} | ${num(r.usage.total_tokens)} |`).join('\n');
  const navigation = report.navigation.map(r => `| ${r.id} | ${r.navigation_ok ? '✓' : '✗'} | ${r.score.success ? '✓' : '✗'} | ${num(r.usage.total_tokens)} |`).join('\n');
  const restart = report.restart.map(r => `| ${r.id} | ${r.setup_ok ? '✓' : '✗'} | ${r.persistence_ok == null ? '未进入' : r.persistence_ok ? '✓' : '✗'} | ${r.success ? '✓' : '✗'} | ${num(r.usage.total_tokens)} |`).join('\n');
  const purposeNames = {business_loop:'业务循环（含 Chunk 单轮）',inner_query:'内层查询',inner_synthesis:'内层综合',source_repair:'来源修复',finalization:'无工具终答',compaction:'压缩',background_profile_review:'后台画像',unclassified:'未分类'};
  const costRows = [...Object.entries(report.cost_by_purpose).filter(([p]) => p !== 'grading').map(([p,u]) => [purposeNames[p] ?? p,u]), ['独立判分',report.grading_usage], ['失败任务合计（已含于上述被测用量）',report.failed_task_usage]].map(([p,u]) => `| ${p} | ${u.requests} | ${num(u.total_tokens)} | ${u.missing_usage} |`).join('\n');
  return `# 完整 Agent 评测报告\n\n判分：${report.scoring_version ?? 'raw'}；按可见词句统一核对，忽略 Markdown 加粗分隔符，原始运行记录不改写。\n\n协议：${report.version}；模型：\`${report.model}\`；开始：${report.started_at}；状态：${report.status}。\n\n## 共同问答\n\n| 系统 | 证据召回 | 引用支持率¹ | 任务成功率¹ | P95 延迟 | 单任务 Token |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${table}\n\n¹ 引用支持率为必要事实中“结论正确且有有效引用支持”的比例；无引用计不支持。任务成功要求全部必要事实及引用通过，拒绝题要求明确不臆造。证据召回为参考锚组的覆盖率，不覆盖全部等价原文。自由答案采用独立模型标注，再核对金标准值、逐字答句、有效原文引用和动作状态；不是人工盲审。\n\n本表是单次产品级对照。Chunk 为单轮 BM25 RAG，Agent 使用生产默认策略自主循环、动态发现工具。Agent 不受 Chunk 的 6000 字符证据预算限制，双方提示和工具能力不同，因此不能把结果差异归因于图谱。\n\nAgent 问答内容正确率：${pct(report.summary[AGENT].semantic_accuracy)}；Chunk：${pct(report.summary[CHUNK].semantic_accuracy)}。内容正确不代表引用或任务完成。\n\nToken 来自全部实际 Provider 请求，包含工具循环、内层查询、压缩和答案修复；不使用 Runtime 估算。问答 Agent 共 ${report.summary[AGENT].total_requests} 次请求，Chunk 共 ${report.summary[CHUNK].total_requests} 次。缺失 usage 则均值为 N/A。判分另计：${report.grading_usage.requests} 次请求、${num(report.grading_usage.total_tokens)} Token，不计入被测系统成本。P95 排除服务启动、预构建和事后判分，包含失败任务。\n\n全流程（不含判分）实际发起 ${[...report.qa, ...report.navigation, ...report.restart].reduce((n, r) => n + r.usage.requests, 0)} 次模型请求。后台画像 review 包含在用量中，单列 ${report.background_usage.requests} 次、${report.background_usage.missing_usage} 次缺失 usage；缺失项没有用估计值补齐。\n\n## 实际请求成本分账\n\n| 用途 | 请求数 | 实际 Token | 缺失 usage |\n| --- | ---: | ---: | ---: |\n${costRows}\n\n无请求的用途显示 N/A；存在缺失 usage 的合计同样显示 N/A，二者由请求数和缺失列区分。按已知生产系统提示签名归类；无法识别的请求保留未分类。分系统、逐题用量见 summary.json。独立判分不计入任务延迟或被测系统成本。\n\n## 来源跳转（Agent 专属）\n\n| 任务 | Agent 实际跳转 | 回答、引用及动作均通过 | Token |\n| --- | ---: | ---: | ---: |\n${navigation}\n\n跳转成功须 Agent 自己调用阅读工具，且最终视口覆盖参考位置。评测器只读取状态和解析已交付引用，不替 Agent 跳转。\n\n## 真实重启（Agent 专属）\n\n| 任务 | Agent 写入/定位 | 进程重启后持久化 | 新会话 Agent 恢复成功 | 两阶段 Token |\n| --- | ---: | ---: | ---: | ---: |\n${restart}\n\n每题使用独立目录。先由 Agent 保存笔记、高亮或位置，再退出服务并启动新进程、清空活动聊天。新会话不包含准备阶段对话；须实际观察持久化信息并复述指定内容。失败准备不从分母剔除。\n\n## 逐题核对\n\n| 任务 | 系统 | 内容正确 | 完整成功 | 有效来源数 | 模型请求数 | Token |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${details}\n\n## 实际工具尝试（含被拒绝调用）\n\n${Object.entries(report.tool_counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => '- ' + k + ': ' + v).join('\n')}\n\n## 限制与复现\n\n单书开发集、每系统每题一次；语义标注器和被测系统使用同一配置模型，仍可能存在标注偏差。必需事实覆盖不等于整篇答案无幻觉，引用支持也不衡量引用位置排版。重启包含服务进程和新聊天，不模拟系统断电或长期人格记忆。\n\n配置和匿名逐题结果见 [summary.json](summary.json)，协议与命令见 [完整 Agent 方法](../../AGENT_EVAL.md)。带原文、模型输入和机器路径的 run.json 仅保留本地，Git 忽略；公开报告不包含这些内容。\n`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2]);
  const book = path.resolve(process.argv[3] ?? '.understand-book/quantification-essence');
  const report = publicAgentReport(recomputeScores(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')), loadCorpus(book)));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'report.md'), agentMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}
