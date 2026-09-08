import http from 'node:http';

// Classify only signatures owned by the production request builders. User/tool
// text is deliberately excluded: a quoted policy is not the request's purpose.
export function requestPurpose(request) {
  const system = (request?.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  if (system.includes('source_answer_repair.v3')) return 'source_repair';
  if (system.includes('finalization_sampling.v1')) return 'finalization';
  if (system.includes('agent-compaction.generation.v1')) return 'compaction';
  if (system.startsWith('You extract durable reader-profile candidates from resident user turns.')) return 'background_profile_review';
  if (system.startsWith('You are the bounded PlanGate and referent resolver.')) return 'inner_query';
  if (system.startsWith('You are an in-book synthesizer.')) return 'inner_synthesis';
  if (system.includes('You are the resident reading agent for the current book.')) return 'business_loop';
  if (system.startsWith('你是封闭原文阅读助手。仅依据提供的原文证据自然地回答')) return 'business_loop';
  return 'unclassified';
}

export function usageByPurpose(records) {
  const purposes = ['business_loop', 'inner_query', 'inner_synthesis', 'source_repair', 'finalization', 'compaction', 'background_profile_review', 'grading', 'unclassified'];
  return Object.fromEntries(purposes.map(p => [p, measuredUsage(records.filter(r =>
    (r.purpose === 'grading' ? 'grading' : requestPurpose(r.request)) === p))]));
}

// Local test instrumentation only. Forward request/response bytes unchanged;
// retain no HTTP credentials and omit provider reasoning text from local records.
export async function startProviderRecorder(providerBase, { tokenLimit = null } = {}) {
  const records = [];
  const budgetRejections = [];
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    if (tokenLimit !== null && records.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0) >= tokenLimit) {
      budgetRejections.push({ at: new Date().toISOString(), reason: 'actual_provider_token_limit' });
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'EXPERIMENT_TOKEN_BUDGET' } }));
      return;
    }
    const record = { ordinal: records.length + 1, started_at: new Date().toISOString() };
    records.push(record);
    const started = performance.now();
    const controller = new AbortController();
    pending.add(controller);
    try {
      const buffers = [];
      for await (const b of req) buffers.push(b);
      const body = Buffer.concat(buffers);
      record.request = JSON.parse(body.toString('utf8'));
      record.purpose = requestPurpose(record.request);
      const upstream = await fetch(providerBase.replace(/\/$/, '') + req.url, {
        method: req.method, body, signal: controller.signal,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      record.status = upstream.status;
      record.usage = null;
      try {
        const response = JSON.parse(bytes.toString('utf8'));
        record.usage = response.usage ?? null;
        record.response = { id: response.id, model: response.model,
          choices: response.choices?.map(c => ({ finish_reason: c.finish_reason,
            message: { role: c.message?.role, content: c.message?.content, tool_calls: c.message?.tool_calls } })) };
      } catch { record.non_json_response = true; }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(bytes);
    } catch (e) {
      record.error = e.name === 'AbortError' ? 'recording session closed' : 'provider transport or JSON error';
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: record.error } }));
    } finally {
      record.elapsed_ms = performance.now() - started;
      pending.delete(controller);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, records, budgetRejections,
    async stop(waitMs = 0) {
      // The Reader may exit while its already-issued background review is in flight.
      // Let the upstream response finish so its real billable usage is not lost.
      const deadline = performance.now() + waitMs;
      while (pending.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function measuredUsage(records) {
  return { requests: records.length,
    total_tokens: records.length > 0 && records.every(r => Number.isFinite(r.usage?.total_tokens))
      ? records.reduce((n, r) => n + r.usage.total_tokens, 0) : null,
    missing_usage: records.filter(r => !Number.isFinite(r.usage?.total_tokens)).length };
}
