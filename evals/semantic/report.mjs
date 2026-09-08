import fs from 'node:fs';
import path from 'node:path';
import { aggregate } from './core.mjs';

const input = process.argv[2];
if (!input) throw new Error('Usage: node evals/semantic/report.mjs <results-directory>');
const dir = path.resolve(input);
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
if (run.status !== 'completed') throw new Error('Cannot publish an incomplete run');
const systems = ['Chunk RAG (BM25)', 'LID + Graph'];
const pct = n => n === null ? 'N/A' : `${(n * 100).toFixed(1)}%`;
const num = n => n === null ? 'N/A' : Math.round(n).toLocaleString('en-US');
const seconds = n => n === null ? 'N/A' : `${(n / 1000).toFixed(2)} s`;
const metrics = s => `| ${s} | ${pct(run.summary[s].evidence_recall)} | ${pct(run.summary[s].citation_support)} | ${pct(run.summary[s].task_success)} (${run.summary[s].successes}/${run.summary[s].n}) | ${seconds(run.summary[s].p95_ms)} | ${num(run.summary[s].tokens_per_task)} |`;
const publicRows = run.results.map(r => ({ id: r.id, system: r.system, category: r.category,
  elapsed_ms: r.elapsed_ms, retrieval_ms: r.retrieval_ms, total_tokens: r.total_tokens,
  finish_reason: r.finish_reason, error: r.error ?? null, refused: r.response?.refused ?? null,
  fields: Object.fromEntries(Object.entries(r.response?.fields ?? {}).map(([k, v]) => [k, {
    value: v.value, citations: (v.citations ?? []).map(c => ({ source_id: c.source_id, quote_chars: c.quote?.length ?? 0 })),
  }])), retrieved: r.blocks.map(({ id, lid, start, end }) => ({ id, lid, start, end })),
  navigation: r.navigation?.map(({ lid, ok }) => ({ lid, ok })), score: r.score,
}));
const summary = { ...run, results: publicRows, restart: run.restart.map(({ id, kind, success, process_changed, elapsed_ms, error }) => ({ id, kind, success, process_changed, elapsed_ms, error })) };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const categories = [...new Set(run.results.map(t => t.category))];
const names = { exact: '精确原文定位', concept: '概念解释', cross: '跨章节关系', contrast: '反例/对比', formula: '公式解释', source: '来源跳转', refusal: '证据不足拒绝' };
let md = `# 语义评测实测报告\n\n运行：${run.started_at}。数据集：\`${run.version}\`；检索器：\`${run.config.version}\`；模型：\`${run.model}\`。\n\n`;
md += `语料：\`${run.corpus.book_id}\`，${run.corpus.lids} 个 LID、${run.corpus.graph_nodes} 个图节点、${run.corpus.graph_edges} 条边。使用本地已有预构建，不计入读时耗时。\n\n`;
md += `${new Set(run.results.map(r => r.id)).size} 道阅读任务，每系统 1 次/题，共 ${run.results.length} 次模型请求尝试；额外 ${run.restart.length} 道共享 Reader 重启检查。检索对照共用模型、提示、${run.config.evidenceChars} UTF-16 字符原文上限及 ${run.config.maxOutputTokens} output-token 上限。系统调用顺序逐题交替。回答协议：${run.config.answerProtocol ?? 'quotes-v1'}。\n\n`;
md += '| 系统 | 证据召回 | 引用支持率（锚点代理） | 任务成功率（严格判据） | P95 延迟 | 单任务 Token（均值） |\n| --- | ---: | ---: | ---: | ---: | ---: |\n' + systems.map(metrics).join('\n') + '\n\n';
md += '任务成功要求每个事实都有必要的支持证据，但不要求额外引用也全部命中参考锚；因此成功率可高于引用支持率。后一指标会把正确但未收录的替代表述计为不命中，不是幻觉率。\n\n';
md += '## 分项结果\n\n| 类别 | Chunk RAG 成功 | LID + Graph 成功 |\n| --- | ---: | ---: |\n';
for (const c of categories) md += `| ${names[c]} | ${systems.map(s => { const a = aggregate(run.results.filter(r => r.system === s && r.category === c)); return `${a.successes}/${a.n}`; }).join(' | ')} |\n`;
md += '\n## 重启恢复（共享 Reader，不计入检索胜负）\n\n| 任务 | 操作 | 结果 |\n| --- | --- | --- |\n';
for (const r of run.restart) md += `| ${r.id} | ${r.kind} | ${r.success ? '通过' : '失败'} |\n`;
md += '\n真实服务进程退出后，以同一隔离记忆目录启动另一个进程；检查两条笔记、段内高亮及阅读位置。没有预写历史回答，没有模拟进程重启，也未检验模型是否自主回忆或记忆整合质量。\n\n';
md += '## 失败清单\n\n| 题号 | 系统 | 可复核原因 |\n| --- | --- | --- |\n';
for (const r of run.results.filter(r => !r.score.success)) {
  const reason = r.error ?? (r.response?.refused ? '回答器拒绝（检查检索证据是否足够）' : r.score.details.filter(d => !d.correct || !d.evidence_ok).map(d => `${d.key}: ${!d.correct ? '事实值不匹配' : '引文未覆盖参考支持锚'}`).join('；') || '缺少字段或来源跳转未通过');
  md += `| ${r.id} | ${r.system} | ${reason.replaceAll('|', '/')} |\n`;
}
md += '\n## 指标与限制\n\n- 证据召回：本次可回答任务的必需证据组宏平均（完整题集为 24 道）；组内可接受替代锚取 OR，组间取 AND；按实际提供给模型的原文区间计。拒绝题不进入此分母。\n- 引用支持率：支持参考事实、逐字存在于已提供证据、且覆盖对应参考锚的引文数 / 所有生成引文数。它是封闭事实槽的严格自动判据，不是任意自然语言的语义蕴含判定；可能漏判正确但未覆盖选定锚的引文。\n- 任务成功：所有规定事实槽正确且有支持引文；拒绝题必须明确拒绝且不编造字段；来源题另需真实 Reader 跳转及原文回读成功。\n- P95：nearest-rank，含检索、本地工具、模型请求和来源题跳转；不含服务启动、预构建和索引创建。单次小样本、共享网络/服务端缓存，不能视为稳定服务 SLA。\n- Token：Provider 返回的 total_tokens，包含其计入的输入、输出和推理 Token；缺失就报告 N/A，不用字符数估算。\n- 基线是 BM25 文本分块检索，没有向量检索、reranker 或查询改写。LID 组使用原文 BM25 种子加生产 book.context(far) 和 book.text；并非完整多轮 Resident Agent，也未消融 LID 分段与图关系的各自贡献。\n- 单书、自编的 32 题，没有盲测集或重复采样；答案限定为事实槽，不测开放式讲解的教学质量。原书含公式/数值排版噪声，评测保留输入原貌。\n- 阅读测试描述书中观点，不核验金融论断，也不构成投资建议。\n\n';
md += '## 复现与证据\n\n[评测方法](../../README.md)；[冻结题目与金标准](../../dataset.mjs)；[逐题公开结果](summary.json)。本地 run.json 保留实际引文、模型输出与检索轨迹，但被 Git 忽略，避免公开用户原书片段。公开结果保留事实值、证据坐标和判分细目，不含密钥、机器路径或全文。\n';
fs.writeFileSync(path.join(dir, 'report.md'), md);
console.log(md.slice(0, md.indexOf('## 分项结果')));
