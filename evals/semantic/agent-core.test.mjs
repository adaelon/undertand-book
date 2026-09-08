import test from 'node:test';
import assert from 'node:assert/strict';
import { observedEvidence, scoreNatural, chunkSources, citationText, aggregateNatural, navigationOK, matchingSavedRecords } from './agent-core.mjs';
import { qaTasks, sourceTasks, restartTasks } from './agent-dataset.mjs';

const source = 'The answer is absolute return.';
const corpus = { source, base: { lid_nodes: [{ lid: '1', span: { start: 0, end: source.length } }] }, leaves: [{ lid: '1', start: 0, end: source.length }] };
const task = { category: 'exact', slots: [{ key: 'x', accept: ['absolute_return'], evidence: [['absolute return']] }] };
const row = { answer: 'Aim for absolute return.[[source:c1]]', sources: [{ id: 'c1', text: source, valid: true }],
  blocks: [{ start: 0, end: source.length, text: source }], elapsed_ms: 1000, usage: { requests: 2, total_tokens: 12, missing_usage: 0 } };
const grade = { fields: { x: { value: 'absolute_return', answer_quote: 'absolute return', support_ids: ['c1'] } } };

test('full-loop protocol has 24 common tasks and eight distinct Agent action tasks', () => {
  assert.equal(qaTasks.length, 24);
  assert.equal(sourceTasks.length, 4);
  assert.equal(restartTasks.length, 4);
  assert.equal(new Set([...qaTasks, ...sourceTasks, ...restartTasks].map(t => t.id)).size, 32);
  for (const t of restartTasks) assert.equal(t.resume.includes(t.content ?? t.anchor), false);
});

test('memory verification follows production nested anchor and distinguishes annotation type', () => {
  const task = { kind: 'note', content: 'original note' };
  const record = { type: 'note', content: 'original note', anchor: { lid: '1' } };
  assert.equal(matchingSavedRecords(task, [record], ['1']).length, 1);
  assert.equal(matchingSavedRecords(task, [{ ...record, anchor: { lid: '2' } }], ['1']).length, 0);
  assert.equal(matchingSavedRecords(task, [{ ...record, type: 'context' }], ['1']).length, 0);
});

test('natural grading rejects forged answer quotes, wrong values and unbound citations', () => {
  assert(scoreNatural(task, row, grade, source).success);
  for (const change of [{ answer_quote: 'invented' }, { value: 'derivative_pricing' }, { support_ids: ['missing'] }, { support_ids: [] }]) {
    assert.equal(scoreNatural(task, row, { fields: { x: { ...grade.fields.x, ...change } } }, source).success, false);
  }
  assert.equal(scoreNatural(task, { ...row, outcome: { incomplete: true } }, grade, source).success, false);
});

test('verbatim answer verification ignores visible Markdown bold delimiters, not changed wording', () => {
  const formatted = { ...row, answer: 'Aim for **absolute** return.[[source:c1]]' };
  assert(scoreNatural(task, formatted, grade, source).success);
  assert.equal(scoreNatural(task, formatted, { fields: { x: { ...grade.fields.x, answer_quote: 'relative return' } } }, source).success, false);
});
test('missing references do not acquire support from bare source IDs or private tool results', () => {
  assert.deepEqual(chunkSources('[source_ref_fake]', row.blocks), []);
  assert.equal(chunkSources('[[source:missing]]', row.blocks)[0].valid, false);
  assert.equal(citationText({ answer_view: { parts: [{ kind: 'markdown', text: 'Claim.' }, { kind: 'sources', source_ref_ids: ['abc'] }] } }), 'Claim.[[source:abc]]');
});
test('recall uses actual model-visible accepted source text, not LID metadata or locator previews', () => {
  const message = { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ model_body: { text: source.slice(0, 10) }, receipt: { accepted_evidence: [{ start_lid: '1', end_lid: '1' }] } }) };
  const requests = [{ request: { messages: [message] } }, { request: { messages: [message] } }];
  assert.equal(observedEvidence(requests, corpus).length, 1);
  assert.equal(observedEvidence(requests, corpus)[0].end, 10);
  assert.equal(observedEvidence([{ request: { messages: [{ ...message, content: JSON.stringify({ model_body: { text: source }, receipt: {} }) }] } }], corpus).length, 0);
});
test('a refusal requires an actual refusal statement and no fabricated answer', () => {
  const t = { category: 'refusal', slots: [] }, r = { ...row, answer: '本书没有给出这一信息。' };
  const g = { abstained: true, fabricated_answer: false, refusal_quote: r.answer };
  assert(scoreNatural(t, r, g, source).success);
  assert.equal(scoreNatural(t, r, { ...g, fabricated_answer: true }, source).success, false);
  assert.equal(scoreNatural(t, r, { ...g, refusal_quote: '' }, source).success, false);
});
test('aggregate keeps failures and missing usage in denominators; navigation needs an Agent action', () => {
  const r = { ...row, score: scoreNatural(task, row, grade, source) };
  const fail = { ...r, usage: { requests: 1, total_tokens: null, missing_usage: 1 }, score: { ...r.score, success: false } };
  assert.equal(aggregateNatural([r, fail]).success_rate, 0.5);
  assert.equal(aggregateNatural([r, fail]).mean_tokens, null);
  const nav = { state: { viewport: { visible_lids: ['1'] } }, outcome: { trace: [] } };
  assert.equal(navigationOK(task, nav, corpus), false);
  nav.outcome.trace.push({ tool: 'reader.gotoLid' });
  assert.equal(navigationOK(task, nav, corpus), false, 'attempted calls do not prove execution');
  const receipt = { tool: 'reader.gotoLid', status: 'error' };
  nav.requests = [{ request: { messages: [{ role: 'tool', tool_call_id: 'nav', content: JSON.stringify({ receipt }) }] } }];
  assert.equal(navigationOK(task, nav, corpus), false);
  receipt.status = 'ok';
  nav.requests[0].request.messages[0].content = JSON.stringify({ receipt });
  assert(navigationOK(task, nav, corpus));
});
