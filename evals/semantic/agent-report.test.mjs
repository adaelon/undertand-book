import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAgentReport, agentMarkdown } from './agent-report.mjs';
import { CHUNK, AGENT } from './agent-core.mjs';
test('public full-loop report strips source, requests and paths; recomputes metrics from every row', () => {
  const score = { facts: 1, supported_facts: 1, evidence_groups: 1, recalled_groups: 1, success: true, semantic_correct: true, details: [] };
  const row = { id: 'exact-01', category: 'exact', system: AGENT, score, answer: 'PRIVATE_TEXT', memory_dir: 'PRIVATE_PATH', error: 'PRIVATE_ERROR',
    sources: [{ valid: true, text: 'PRIVATE_SOURCE' }], blocks: [{ text: 'PRIVATE_SOURCE' }], requests: [{ request: { messages: [
      { role: 'tool', tool_call_id: 'private-call', content: JSON.stringify({ model_body: 'PRIVATE_SOURCE', receipt: { tool: 'book.text', error_code: 'LID_PROVENANCE_REQUIRED' } }) },
    ] } }],
    elapsed_ms: 1000, usage: { requests: 4, total_tokens: 100, missing_usage: 0 }, outcome: { trace: [{ tool: 'book.text', args: 'PRIVATE_ARGS' }] } };
  const run = { version: 'test', status: 'completed', qa: [row, { ...row, system: CHUNK, score: { ...score, success: false } }], navigation: [], restart: [],
    summary: { [AGENT]: { count: 999 } } };
  const publicRun = publicAgentReport(run);
  assert(!JSON.stringify(publicRun).includes('PRIVATE_'));
  assert.equal(publicRun.summary[AGENT].count, 1);
  assert.equal(publicRun.summary[CHUNK].success_rate, 0);
  assert.equal(publicRun.summary[AGENT].total_requests, 4);
  assert.equal(publicRun.tool_error_counts.LID_PROVENANCE_REQUIRED, 2);
  assert(agentMarkdown(publicRun).includes('100.0% (1/1)'));
  const failed = {...row,outcome:undefined,requests:[{ordinal:7,response:{choices:[{message:{tool_calls:[{function:{name:'book_search_text',arguments:'PRIVATE_ARGS'}}]}}]}}]};
  const failedReport=publicAgentReport({...run,qa:[failed]});
  assert.equal(failedReport.qa[0].tool_counts['book.search_text'],1);
  assert.equal(failedReport.qa[0].tool_sequence[0].request_ordinal,7);
  assert(!JSON.stringify(failedReport).includes('PRIVATE_'));
  assert.throws(() => publicAgentReport({ ...run, qa: [{ ...row, score: undefined }] }), /not been graded/);
});
