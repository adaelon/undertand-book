import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { startProviderRecorder, measuredUsage } from './provider-recorder.mjs';
import { tasks } from './dataset.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.loadEnvFile(path.join(root, '.env'));
const dir = path.join(root, 'evals/semantic/results/agent-loop-probe');
if (fs.existsSync(path.join(dir, 'run.json'))) throw new Error('Probe already exists');
fs.mkdirSync(dir, { recursive: true });
const memory = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-book-agent-probe-'));
const recorder = await startProviderRecorder(process.env.OPENCODE_BASE_URL);
let server;
try {
  server = await startServer(path.join(root, '.understand-book/quantification-essence'), memory, root,
    { OPENCODE_BASE_URL: recorder.url });
  const question = tasks.find(t => t.id === 'concept-04').question + ' 请仅依据本书回答，并给出支持结论的原文来源。';
  const started = performance.now();
  const outcome = await server.api('agent/chat', { message: question }, 'POST', 300000);
  const elapsed_ms = performance.now() - started;
  const history = await server.api('agent/history');
  const state = await server.api('reader/state', {}, 'POST');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ question, outcome, history, state, elapsed_ms,
    usage: measuredUsage(recorder.records), requests: recorder.records, memory }, null, 2));
  console.log(JSON.stringify({ answer: outcome.answer, turns: outcome.turns, incomplete: outcome.incomplete,
    tools: outcome.trace?.map(t => t.tool), usage: measuredUsage(recorder.records), elapsed_ms, memory }, null, 2));
} finally { if (server) await server.stop(); await recorder.stop(); }
