import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateNatural, toolMessages } from './agent-core.mjs';
import { recomputeScores, reportToolTrace } from './agent-report.mjs';
import { measuredUsage, usageByPurpose } from './provider-recorder.mjs';
import { loadCorpus } from './core.mjs';

function locatorPaths(row) {
  return reportToolTrace(row).filter(t => ['book.structure','book.context','book.concept'].includes(t.tool)).map(t => {
    let args = {}; try { args = JSON.parse(t.args); } catch { /* No inferred arguments. */ }
    return {tool:t.tool,loop:t.model_tool_loop,...(t.request_ordinal?{request_ordinal:t.request_ordinal}:{}),lid:args.lid ?? args.at,granularity:t.tool === 'book.context' ? args.granularity ?? 'near' : undefined};
  });
}

export function observedBodySpans(requests, corpus) {
  if (!corpus) return null;
  const nodes = new Map(corpus.base.lid_nodes.map(n => [n.lid,n]));
  const ranges = [];
  for (const m of toolMessages(requests)) {
    if (m.receipt?.tool !== 'book.text' || typeof m.model_body?.text !== 'string') continue;
    for (const e of m.receipt.accepted_evidence ?? []) {
      const a=nodes.get(e.start_lid), b=nodes.get(e.end_lid ?? e.start_lid);
      if (!a || !b) return null;
      ranges.push([a.span.start,b.span.end]);
    }
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for (const [a,b] of ranges) {
    const last=merged.at(-1);
    if(last && a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);
  }
  return merged.reduce((n,[a,b])=>n+b-a,0);
}

export function ablationReport(run, corpus = null) {
  const arms = ['text','tree','graph'];
  const ids = [...new Set(run.qa.map(r => r.id))];
  const summaries = Object.fromEntries(arms.map(a => [a, aggregateNatural(run.qa.filter(r => r.system === a))]));
  const rows = run.qa.map(r => ({ id:r.id, arm:r.system, score:r.score, elapsed_ms:r.elapsed_ms, usage:r.usage,
    error: r.error ? (r.error.match(/HTTP \d{3} ([A-Z][A-Z_]+)/)?.[1] ?? 'task_error') : null,
    grade_error:r.grade_error ? 'grading_error' : null, incomplete:r.outcome?.incomplete ?? false,
    valid_sources:r.sources.filter(s => s.valid).length,
    tool_sequence:reportToolTrace(r).map(t => t.tool),
    locator_paths:locatorPaths(r),
    observed_body_span_utf16:observedBodySpans(r.requests,corpus),
    cost_by_purpose:usageByPurpose(r.requests), budget_rejections:r.budget_rejections?.length ?? 0,
    token_limit_verified:Number.isFinite(r.usage.total_tokens) ? r.usage.total_tokens <= 120000 : null,
    token_overshoot:Number.isFinite(r.usage.total_tokens) ? Math.max(0,r.usage.total_tokens-120000) : null,
    request_settings:[...new Set(r.requests.map(c => JSON.stringify({model:c.request?.model,max_tokens:c.request?.max_tokens,temperature:c.request?.temperature})))].map(JSON.parse),
  }));
  const comparisons = [['text','tree'],['tree','graph']].map(([a,b]) => {
    const pairs = ids.map(id => {
      const left = rows.find(r => r.id === id && r.arm === a), right = rows.find(r => r.id === id && r.arm === b);
      return {id, left_success:left?.score.success ?? null, right_success:right?.score.success ?? null,
        token_delta:left?.usage.total_tokens != null && right?.usage.total_tokens != null ? right.usage.total_tokens-left.usage.total_tokens:null,
        added_paths: [...new Set(right?.tool_sequence.filter(t => !left?.tool_sequence.includes(t)) ?? [])],
        incremental_locator_calls:right?.locator_paths.filter(p => b === 'tree' || p.tool !== 'book.structure') ?? []};
    });
    return {from:a,to:b,pairs,gained:pairs.filter(p=>p.left_success===false && p.right_success===true).map(p=>p.id),
      lost:pairs.filter(p=>p.left_success===true && p.right_success===false).map(p=>p.id)};
  });
  return {version:'la9-paired-v1',status:run.status,model:run.model,git_head:run.git_head,
    started_at:run.started_at,finished_at:run.finished_at,scoring_version:run.scoring_version,corpus:run.corpus,
    config:run.config ? {temperature:run.config.temperature,task_timeout_ms:run.config.task_timeout_ms,repeats:run.config.repeats,grading:run.config.grading}:null,
    experiment:run.experiment ? {...run.experiment,source_program:undefined}:null,summary:summaries,rows,comparisons,
    grading_usage:measuredUsage(run.qa.flatMap(r=>r.grader?[r.grader]:r.grade_error?[{error:true}]:[])),
    limitations:['Single book development set, one sample per arm/task; no statistical significance claim.',
      'Added tool paths and changed success are paired observations, not proof of a specific edge causing the outcome.',
      'Any missing Provider usage makes cumulative token compliance unknown. In-flight overshoots are retained.',
      'Prebuild history is reported separately; no book rebuild is performed to fill missing measurements.']};
}

const displayNumber = n => n == null ? 'N/A' : n.toLocaleString('en-US',{maximumFractionDigits:2});
const displayPercent = n => n == null ? 'N/A' : (100*n).toFixed(2)+'%';

export function ablationMarkdown(report) {
  return `# 同环消融报告\n\n模型：${report.model}；状态：${report.status}。三组共享生产 Agent 循环、基础提示、原文、判分及冻结预算；差异仅为读时定位能力。\n\n| 组 | 完整成功 | 证据召回 | 引用支持 | P95 秒 | 平均 Token |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${Object.entries(report.summary).map(([a,s])=>`| ${a} | ${s.succeeded}/${s.count} | ${displayPercent(s.evidence_recall)} | ${displayPercent(s.citation_support)} | ${displayNumber(s.p95_seconds)} | ${displayNumber(s.mean_tokens)} |`).join('\n')}\n\n${report.comparisons.map(c=>`## ${c.to} 对 ${c.from}\n\n新增成功：${c.gained.join(', ')||'无'}。失去成功：${c.lost.join(', ')||'无'}。\n\n| 题目 | 前组成功 | 后组成功 | Token 增量 | 后组新增调用路径 |\n| --- | --- | --- | ---: | --- |\n${c.pairs.map(p=>`| ${p.id} | ${p.left_success} | ${p.right_success} | ${p.token_delta ?? 'N/A'} | ${p.added_paths.join(', ')} |`).join('\n')}`).join('\n\n')}\n\n## 已知限制\n\n${report.limitations.map(l=>'- '+l).join('\n')}\n\n正文范围统计为实际请求中 book.text 已接纳 canonical 区间的并集；与 Runtime 的预算计量相同，重复回读不重复计算唯一范围，但仍计模型 Token。完整范围被文本投影进一步缩短时，该统计保守计入整个已接纳范围。\n\n匿名逐题证据、请求设置、预算超出和成本分账见 [summary.json](summary.json)。原始请求与答案仅在本地 run.json 保存。\n`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir=path.resolve(process.argv[2]);
  const corpus=loadCorpus(path.resolve(process.argv[3]??'.understand-book/quantification-essence'));
  const report=ablationReport(recomputeScores(JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8')),corpus),corpus);
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'report.md'),ablationMarkdown(report));
  console.log(JSON.stringify(report.summary,null,2));
}
