// Real Provider acceptance using isolated Reader storage; never records credentials.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const output = resolve(process.argv[2] ?? 'tmp/as9-real-model.json');
const env = { ...process.env };
for (const line of (await readFile(process.env.AS9_PROVIDER_ENV ?? '.env', 'utf8')).split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  const key = line.slice(0, i).trim();
  env[key] ??= line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
}
const base = env.OPENCODE_BASE_URL.replace(/\/$/, '');
const records = [];
const proxy = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const started = performance.now();
  const record = { started, first_chunk_ms: null, total_ms: null, status: null };
  records.push(record);
  try {
    const upstream = await fetch(base + request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENCODE_API_KEY}` }, body: Buffer.concat(chunks) });
    record.status = upstream.status;
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of upstream.body) {
      record.first_chunk_ms ??= performance.now() - started;
      response.write(chunk);
    }
    record.total_ms = performance.now() - started;
    response.end();
  } catch (error) { record.error = String(error); response.destroy(); }
});
await new Promise(done => proxy.listen(0, '127.0.0.1', done));
const data = await mkdtemp(join(tmpdir(), 'ub-as9-real-'));
const book = join(data, 'book'); await mkdir(book);
const paragraphs = [
  '流式阅读实验\n',
  '流式回答让读者在模型尚未完成时看到已验证的内容。完整回答仍需要经过来源检查。\n',
  '来源引用必须来自本轮实际读取的原文。读者可以打开来源查看上下文，并继续阅读。\n',
  '阅读动作包括导航、笔记和高亮。取消回答不会撤销已经保存的笔记，重复观察也不会重复执行动作。\n',
  ...Array.from({ length: 15 }, (_, i) => `阅读记录 ${i + 1}：验证模型等待时阅读器仍然响应。\n`),
];
let offset = 0;
const nodes = paragraphs.map((text, i) => { const start = offset; offset += text.length; return { lid: `1.${i + 1}`, path: [1, i + 1], kind: 'paragraph', span: { start, end: offset }, children: [] }; });
await writeFile(join(book, 'source.txt'), paragraphs.join(''));
await writeFile(join(book, 'base.json'), JSON.stringify({ book_id: 'as9-real', lid_nodes: [{ lid: '1', path: [1], kind: 'chapter', span: { start: 0, end: offset }, children: nodes.map(n => n.lid) }, ...nodes], graph_nodes: [], graph_edges: [] }));
const host = spawn(resolve('target/' + (process.env.AS9_RELEASE ? 'release' : 'debug') + '/server' + (process.platform === 'win32' ? '.exe' : '')), ['--reader-only', book], { cwd: data, windowsHide: true, env: { ...env, UNDERSTAND_BOOK_ADDR: '127.0.0.1:0', UNDERSTAND_BOOK_WEB_DIST: resolve('packages/web/dist'), UNDERSTAND_BOOK_MEMORY_DIR: join(data, 'memory'), UNDERSTAND_BOOK_PRIVATE_DIR: join(data, 'private'), OPENCODE_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, UNDERSTAND_BOOK_PROVIDER: 'native' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
let nginx;
const results = { model: env.FLUID_LLM_MODEL, provider: base, data, scenarios: [] };
try {
  let url = await new Promise((done, reject) => {
    host.stderr.on('data', chunk => { log += chunk; const match = log.match(/listening at (http:\/\/\S+)/); if (match) done(match[1]); });
    host.once('exit', code => reject(new Error(`Host exited ${code}`)));
  });
  if (process.env.AS9_NGINX_TEMPLATE) {
    let config = await readFile(process.env.AS9_NGINX_TEMPLATE, 'utf8');
    config = config.replace('listen 8080;', 'listen 127.0.0.1:19080;').replace(/auth_basic "[^"]*";/, 'auth_basic off;')
      .replace('http://127.0.0.1:8787', url).replace(/access_log [^;]+;/, `access_log ${join(data, 'nginx-access.log')};`)
      .replace(/error_log [^;]+;/, `error_log ${join(data, 'nginx-error.log')};`);
    const path = join(data, 'nginx.conf');
    await writeFile(path, `pid ${join(data, 'nginx.pid')};\nevents {}\nhttp { ${config} }`);
    nginx = spawn('/usr/sbin/nginx', ['-p', data, '-c', path, '-g', 'daemon off;'], { stdio: 'ignore' });
    url = 'http://127.0.0.1:19080';
    for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  }
  const api = async (path, body) => {
    const response = await fetch(`${url}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  const quote = paragraphs[2].trim();
  const scenarios = [
    { name: 'source', message: '读取 1.2 和 1.3，解释为什么流式回答仍需要来源检查。请引用你读取的原文，回答两句话。' },
    { name: 'selection', message: '解释选区的核心意思，回答两句话并引用选区原文。', question_anchor_lid: '1.3', question_quote: { lid: '1.3', quote, status: 'resolved', raw_quote: quote, resolved_quote: quote, ranges: [{ lid: '1.3', range: { start: 0, end: quote.length } }] } },
    { name: 'action', message: '请在 1.4 保存一条笔记：取消回答会保留已经保存的阅读动作。保存后简短告知。' },
  ];
  for (const scenario of scenarios) {
    for (const mode of ['stream', 'complete']) {
      await api('/agent/new', {});
      const start = performance.now();
      const firstRequest = records.length;
      const sample = { name: scenario.name, mode, accepted_ms: null, first_activity_ms: null, first_answer_ms: null, total_ms: null, reader_ms: null, requests: [], outcome: null };
      results.scenarios.push(sample);
      const { name, ...input } = scenario;
      try {
        if (mode === 'stream') {
          const run = await api('/agent/runs', input);
          sample.accepted_ms = performance.now() - start;
          const readerStart = performance.now(); await api('/reader/state', {}); sample.reader_ms = performance.now() - readerStart;
          const response = await fetch(`${url}/api/agent/runs/${run.turn_id}/events`);
          let buffer = ''; const decoder = new TextDecoder();
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const payload = frame.split('\n').find(line => line.startsWith('data: '));
              if (!payload) continue;
              const event = JSON.parse(payload.slice(6));
              if (/^(model|tool)\./.test(event.type) || event.payload?.activities?.length) sample.first_activity_ms ??= performance.now() - start;
              if ((event.type === 'answer.patch' && event.payload.view) || event.payload?.draft?.view) sample.first_answer_ms ??= performance.now() - start;
              if (event.type === 'run.completed' || event.type === 'run.failed') sample.outcome = event.payload.final_view;
            }
            if (sample.outcome) break;
          }
          const saved = await api(`/agent/runs/${run.turn_id}`);
          assert.deepEqual(saved.final_view, sample.outcome);
          for (const source of sample.outcome?.outcome?.answer_view?.sources ?? []) {
            const resolved = await api('/agent/source.resolve', { turn_id: run.turn_id, source_ref_id: source.source_ref_id });
            assert.equal(resolved.stale, false);
          }
        } else sample.outcome = await api('/agent/chat', input);
        sample.total_ms = performance.now() - start;
      } catch (error) { sample.error = String(error); }
      sample.requests = records.slice(firstRequest).map(({ started, ...rest }) => ({ request_at_ms: started - start, ...rest }));
      const outcome = mode === 'stream' ? sample.outcome?.outcome : sample.outcome;
      for (const effect of outcome?.effects ?? []) if (effect.kind === 'Note') await api('/memory/delete', { mem_id: effect.mem_id });
      await writeFile(output, JSON.stringify(results, null, 2));
      console.log(`${scenario.name} ${mode}: ${Math.round(sample.total_ms ?? 0)}ms, ${sample.requests.length} requests${sample.error ? ' failed' : ''}`);
    }
  }
} finally {
  await writeFile(output, JSON.stringify(results, null, 2));
  nginx?.kill(); host.kill(); proxy.closeAllConnections(); proxy.close();
}
