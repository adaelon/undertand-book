import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProviderRecorder, measuredUsage, requestPurpose, usageByPurpose } from './provider-recorder.mjs';

test('cost purposes follow system signatures, preserve unknown and missing usage', () => {
  const request = content => ({ messages: [{ role: 'system', content }] });
  assert.equal(requestPurpose(request('source_answer_repair.v3\ncontract')), 'source_repair');
  assert.equal(requestPurpose(request('You are the resident reading agent for the current book.\nfinalization_sampling.v1')), 'finalization');
  assert.equal(requestPurpose({ messages: [{ role: 'user', content: 'source_answer_repair.v3' }] }), 'unclassified');
  assert.equal(requestPurpose(request('unknown')), 'unclassified');
  const costs = usageByPurpose([{ request: request('source_answer_repair.v3'), usage: { total_tokens: 10 } }, { request: request('unknown') }]);
  assert.equal(costs.source_repair.total_tokens, 10);
  assert.equal(costs.unclassified.missing_usage, 1);
  assert.equal(costs.unclassified.total_tokens, null);
  assert.equal(Object.values(costs).reduce((n, p) => n + p.requests, 0), 2);
});

test('experiment token cap records in-flight overshoot and never bills a rejected request', async () => {
  let calls = 0;
  const upstream = http.createServer((_req,res)=>{calls++;res.end('{"usage":{"total_tokens":13}}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const recorder=await startProviderRecorder(`http://127.0.0.1:${upstream.address().port}`,{tokenLimit:10});
  try {
    const send=()=>fetch(recorder.url+'/chat/completions',{method:'POST',body:'{}'});
    assert.equal((await send()).status,200);
    assert.equal((await send()).status,402);
    assert.equal(calls,1);
    assert.equal(recorder.records.length,1);
    assert.equal(measuredUsage(recorder.records).total_tokens,13);
    assert.equal(recorder.budgetRejections.length,1);
  } finally {await recorder.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});

test('recorder preserves tool requests and response bytes, counts all calls, never saves key or reasoning', async () => {
  const received = [];
  const returned = ' {"choices":[{"message":{"role":"assistant","content":"answer","reasoning_content":"PRIVATE_REASONING"}}],"usage":{"total_tokens":17}} ';
  const upstream = http.createServer(async (req, res) => {
    const parts = []; for await (const b of req) parts.push(b);
    received.push({ url: req.url, body: Buffer.concat(parts).toString(), auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json'); res.end(returned);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = await startProviderRecorder(`http://127.0.0.1:${upstream.address().port}/v1`);
  const body = ' {"model":"test","messages":[{"role":"user","content":"question"}],"tools":[{"type":"function","function":{"name":"book.text"}}]} ';
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(recorder.url + '/chat/completions', { method: 'POST', body,
        headers: { 'content-type': 'application/json', authorization: 'Bearer PRIVATE_KEY' } });
      assert.equal(await response.text(), returned);
    }
    assert(received.every(r => r.body === body && r.url === '/v1/chat/completions' && r.auth === 'Bearer PRIVATE_KEY'));
    assert.equal(recorder.records[0].request.tools[0].function.name, 'book.text');
    assert(!JSON.stringify(recorder.records).includes('PRIVATE_'));
    assert.deepEqual(measuredUsage(recorder.records), { requests: 2, total_tokens: 34, missing_usage: 0 });
    assert.equal(measuredUsage([...recorder.records, { error: 'failed' }]).total_tokens, null);
    assert.equal(measuredUsage([]).total_tokens, null);
  } finally {
    await recorder.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('recorder preserves non-JSON provider errors and reports missing usage', async () => {
  const upstream = http.createServer((_req, res) => { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('quota exceeded'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = await startProviderRecorder(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const response = await fetch(recorder.url + '/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 429);
    assert.equal(await response.text(), 'quota exceeded');
    assert.deepEqual(measuredUsage(recorder.records), { requests: 1, total_tokens: null, missing_usage: 1 });
  } finally {
    await recorder.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('recorder can drain an already issued request before closing', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const upstream = http.createServer((_req, res) => {
    entered(); setTimeout(() => res.end('{"usage":{"total_tokens":9}}'), 100);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const recorder = await startProviderRecorder(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const response = fetch(recorder.url + '/chat/completions', { method: 'POST', body: '{}' }).then(r => r.text());
    await ready;
    await recorder.stop(1000);
    await response;
    assert.equal(measuredUsage(recorder.records).total_tokens, 9);
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
