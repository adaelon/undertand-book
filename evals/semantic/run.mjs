import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasks, memoryTasks, version } from './dataset.mjs';
import { aggregate, allSpans, bindReferences, config, loadCorpus, makeRetrievers, positionRestored, promptFor, referencePrompt, scoreTask, validateDataset, viewportContains } from './core.mjs';
import { startServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const answerProtocol = option('--answer-protocol', 'evidence-refs-v2');
if (!['quotes-v1', 'evidence-refs-v2'].includes(answerProtocol)) throw new Error('Unknown answer protocol');
const runConfig = { ...config, answerProtocol, maxOutputTokens: answerProtocol === 'quotes-v1' ? 1600 : 4096 };
const bookDir = path.resolve(option('--book', path.join(root, '.understand-book/quantification-essence')));
const corpus = loadCorpus(bookDir);
const inventory = validateDataset(tasks, memoryTasks, corpus);
if (args.includes('--validate')) { console.log(JSON.stringify({ version, ...inventory }, null, 2)); process.exit(0); }
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const provider = { key: process.env.OPENCODE_API_KEY, base: process.env.OPENCODE_BASE_URL, model: process.env.FLUID_LLM_MODEL };
if (!args.includes('--integration-only') && (!provider.key || !provider.base || !provider.model)) throw new Error('Configure OPENCODE_API_KEY, OPENCODE_BASE_URL and FLUID_LLM_MODEL');
const output = path.resolve(option('--out', path.join(root, 'evals/semantic/results', new Date().toISOString().replace(/[:.]/g, '-'))));
if (fs.existsSync(path.join(output, 'run.json'))) throw new Error('Output already contains a run; use a new --out directory');
fs.mkdirSync(output, { recursive: true });
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-book-semantic-'));
const selected = option('--only', '') ? tasks.filter(t => option('--only', '').split(',').includes(t.id)) : tasks;
if (!selected.length) throw new Error('No matching task IDs');
const results = [];
const report = { version, config: runConfig, started_at: new Date().toISOString(),
  git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  worktree: 'local workspace; relevant evaluator source is distributed with this report',
  corpus: { book_id: corpus.base.book_id, source_utf16: corpus.source.length, source_bytes: Buffer.byteLength(corpus.source),
    lids: corpus.base.lid_nodes.length, graph_nodes: corpus.base.graph_nodes.length, graph_edges: corpus.base.graph_edges.length },
  model: provider.model ?? null, provider_origin: provider.base ? new URL(provider.base).origin : null,
  scope: 'retrieval ablation, shared closed-fact answerer; not full Resident Agent',
  selected_ids: selected.map(t => t.id), results, restart: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(output, 'run.json'), JSON.stringify(report, null, 2) + '\n');
save();

async function answer(task, blocks) {
  const response = await fetch(provider.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(config.timeoutMs),
    headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages: answerProtocol === 'quotes-v1' ? promptFor(task, blocks) : referencePrompt(task, blocks), temperature: config.temperature,
      max_tokens: runConfig.maxOutputTokens, response_format: { type: 'json_object' } }),
  });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  const body = await response.json();
  const raw = body.choices?.[0]?.message?.content ?? '';
  let parsed = null, parseError;
  try { parsed = JSON.parse(raw); } catch { parseError = 'Provider returned invalid JSON'; }
  return { response: answerProtocol === 'quotes-v1' ? parsed : bindReferences(parsed, blocks), raw, total_tokens: body.usage?.total_tokens ?? null, usage: body.usage ?? null,
    finish_reason: body.choices?.[0]?.finish_reason, ...(parseError ? { error: parseError } : {}) };
}

async function navigate(task, row, server) {
  if (task.category !== 'source') return true;
  const observations = [];
  for (const field of Object.values(row.response?.fields ?? {})) {
    for (const cite of field.citations ?? []) {
      const b = row.blocks.find(b => b.id === cite.source_id);
      if (!b || !cite.quote) continue;
      const offset = b.text.indexOf(cite.quote);
      if (offset < 0) continue;
      const at = b.start + offset;
      const leaf = corpus.leaves.find(l => l.start <= at && l.end > at);
      if (!leaf) continue;
      const effect = await server.api('reader/goto', { lid: leaf.lid }, 'POST');
      const state = await server.api('reader/state', {}, 'POST');
      const text = await server.api('book/text', { lid: leaf.lid });
      const ok = viewportContains(state.viewport, leaf.lid) && text.text === leaf.text;
      observations.push({ lid: leaf.lid, ok, effect });
    }
  }
  row.navigation = observations;
  return observations.length > 0 && observations.every(o => o.ok);
}

async function restartChecks(server) {
  const probes = [];
  for (const t of memoryTasks) {
    const at = allSpans(corpus.source, t.anchor)[0].start;
    const leaf = corpus.leaves.find(l => l.start <= at && l.end > at);
    const start = at - leaf.start, end = Math.min(leaf.text.length, start + t.anchor.length);
    const args = t.kind === 'note' ? { lid: leaf.lid, text: t.content }
      : t.kind === 'highlight' ? { lid: leaf.lid, range: { start, end } } : { lid: leaf.lid };
    const route = t.kind === 'position' ? 'reader/goto' : `reader/${t.kind}`;
    try {
      await server.api(route, args, 'POST');
      probes.push({ ...t, lid: leaf.lid, range: { start, end }, expected: t.kind === 'highlight' ? leaf.text.slice(start, end) : t.content });
    } catch (e) { probes.push({ ...t, error: e.message }); }
  }
  // Position is the last goto; notes/highlights must not silently move it.
  const before = await server.api('reader/state', {}, 'POST');
  const previousPid = server.child.pid;
  await server.stop();
  const reopened = await startServer(bookDir, memoryDir, root);
  try {
    const after = await reopened.api('reader/state', {}, 'POST');
    for (const p of probes) {
      const start = performance.now(); let ok = false, observed, error = p.error;
      try {
        if (!error && p.kind === 'position') {
          observed = after.viewport;
          ok = positionRestored(before.viewport, after.viewport, p.lid);
        } else if (!error) {
          observed = await reopened.api('memory/recall', { book_id: corpus.base.book_id, lid: p.lid, type: p.kind }, 'POST');
          const records = Array.isArray(observed) ? observed : observed.records;
          ok = records?.some(r => r.content === p.expected && (p.kind !== 'highlight' || (r.range?.start === p.range.start && r.range?.end === p.range.end))) ?? false;
        }
      } catch (e) { error = e.message; }
      report.restart.push({ id: p.id, kind: p.kind, success: ok && previousPid !== reopened.child.pid,
        elapsed_ms: performance.now() - start, process_changed: previousPid !== reopened.child.pid,
        expected_lid: p.lid, before_anchor: before.viewport?.anchor_lid,
        ...(error ? { error } : {}), observed });
    }
  } finally { await reopened.stop(); }
}

let server;
try {
  server = await startServer(bookDir, memoryDir, root);
  const retrievers = makeRetrievers(corpus, server.api);
  if (!args.includes('--integration-only')) {
    for (let i = 0; i < selected.length; i++) {
      const task = selected[i];
      const systems = Object.keys(retrievers);
      if (i % 2) systems.reverse(); // Counterbalance service/cache drift; no favourable ordering.
      for (const system of systems) {
        const started = performance.now();
        const row = { id: task.id, category: task.category, system, blocks: [], total_tokens: null };
        try {
          Object.assign(row, await retrievers[system](task.question));
          row.retrieval_ms = performance.now() - started;
          Object.assign(row, await answer(task, row.blocks));
          row.navigation_ok = await navigate(task, row, server);
        } catch (e) { row.error = e.message; }
        row.elapsed_ms = performance.now() - started;
        row.score = scoreTask(task, row.response, row.blocks, corpus.source, row.navigation_ok !== false && !row.error);
        results.push(row); save();
        console.log(`${task.id} | ${system} | ${row.score.success ? 'PASS' : 'FAIL'} | ${(row.elapsed_ms / 1000).toFixed(2)}s | ${row.total_tokens ?? '?'} tokens${row.error ? ` | ${row.error}` : ''}`);
      }
    }
  }
  await restartChecks(server);
  report.summary = Object.fromEntries(Object.keys(retrievers).map(s => [s, aggregate(results.filter(r => r.system === s))]));
  report.status = 'completed'; report.finished_at = new Date().toISOString(); save();
  console.log(JSON.stringify({ summary: report.summary, restart: report.restart.map(({ id, success, error }) => ({ id, success, error })), output }, null, 2));
} catch (e) { report.status = 'failed'; report.error = e.message; save(); throw e; }
finally { if (server) await server.stop(); }
