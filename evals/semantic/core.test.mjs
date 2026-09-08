import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, bindReferences, bm25, chunks, config, evidenceUnits, percentile, positionRestored, promptFor, referencePrompt, scoreTask, validateDataset, viewportContains, withinBudget } from './core.mjs';
import { tasks, memoryTasks, taskView } from './dataset.mjs';

const source = '前文。事实甲支持答案。后文。';
const block = { id: 'x', start: 0, end: source.length, text: source };
const task = { id: 'sample', category: 'concept', slots: [{ key: 'x', description: '返回布尔值', accept: [true], evidence: [['事实甲支持答案']] }] };
const response = { refused: false, fields: { x: { value: true, citations: [{ source_id: 'x', quote: '事实甲支持答案' }] } } };
test('32 tasks cover exactly eight categories; public view cannot leak gold', () => {
  assert.equal(tasks.length + memoryTasks.length, 32);
  assert.equal(new Set([...tasks, ...memoryTasks].map(t => t.category)).size, 8);
  for (const t of tasks) {
    assert.deepEqual(Object.keys(taskView(t)), ['question', 'fields']);
    assert(!JSON.stringify(promptFor(t, [])).includes('"accept"'));
    assert(!JSON.stringify(taskView(t)).includes('"evidence"'));
  }
});
test('chunk overlap and character budget preserve real source offsets', () => {
  const docs = chunks('abcdefghijklmnop', 6, 2);
  assert.deepEqual(docs.map(d => d.start), [0, 4, 8, 12]);
  const out = withinBudget(docs, 9);
  assert.equal(out.reduce((n, b) => n + b.text.length, 0), 9);
  assert(out.every(b => b.text === 'abcdefghijklmnop'.slice(b.start, b.end)));
  assert.throws(() => chunks('a', 1, 1));
});
test('BM25 handles Chinese queries and ranks matching passages', () => {
  const rank = bm25([{ text: '苹果和香蕉', start: 0 }, { text: '金融数据样本外验证', start: 10 }]);
  assert.equal(rank('样本外验证')[0].start, 10);
});
test('correct grounded fact passes; valid LID alone is not support', () => {
  assert.equal(scoreTask(task, response, [block], source).success, true);
  const fake = structuredClone(response); fake.fields.x.citations[0].quote = '前文';
  assert.equal(scoreTask(task, fake, [block], source).supported_citations, 0);
  assert.equal(scoreTask(task, fake, [block], source).success, false);
});
test('wrong semantics, forged quote, outside-context citations and extra fields fail', () => {
  for (const mutate of [r => { r.fields.x.value = false; }, r => { r.fields.x.citations[0].quote = '不存在的原文'; },
    r => { r.fields.x.citations[0].source_id = 'unseen'; }, r => { r.fields.extra = { value: true }; }]) {
    const r = structuredClone(response); mutate(r);
    assert.equal(scoreTask(task, r, [block], source).success, false);
  }
});
test('all required evidence groups and navigation are necessary', () => {
  const multi = structuredClone(task); multi.slots[0].evidence.push(['后文']);
  assert.equal(scoreTask(multi, response, [block], source).success, false);
  assert.equal(scoreTask(task, response, [block], source, false).success, false);
  assert.equal(scoreTask(task, response, [{ ...block, text: '前文', end: 2 }], source).evidence_recall, 0);
});
test('refusal cannot get credit for hallucinated fields or unknown response', () => {
  const refusal = { category: 'refusal', slots: [] };
  assert.equal(scoreTask(refusal, { refused: true, fields: {} }, [], source).success, true);
  assert.equal(scoreTask(refusal, { ...response, refused: true }, [block], source).success, false);
  assert.equal(scoreTask(refusal, null, [], source).success, false);
  for (const fields of [undefined, null, [], 'unknown']) {
    assert.equal(scoreTask(refusal, { refused: true, fields }, [], source).success, false);
  }
});
test('failure stays in success/latency denominator; absent usage is not zero', () => {
  const rows = [{ score: { evidence_recall: 1, citation_count: 1, supported_citations: 1, success: true }, elapsed_ms: 1, total_tokens: 10 },
    { score: { evidence_recall: 0, citation_count: 0, supported_citations: 0, success: false }, elapsed_ms: 99, total_tokens: null, error: 'timeout' }];
  const a = aggregate(rows);
  assert.equal(a.task_success, 0.5); assert.equal(a.evidence_recall, 0.5); assert.equal(a.p95_ms, 99);
  assert.equal(a.tokens_per_task, null); assert.equal(a.errors, 1); assert.equal(percentile([], 0.95), null);
});
test('annotation drift and duplicate IDs fail before any model call', () => {
  assert.throws(() => validateDataset([{ ...task, slots: [{ evidence: [['missing']] }] }], [], { source }));
  assert.throws(() => validateDataset([task, task], [], { source }));
  assert.equal(config.evidenceChars, 6000);
});
test('source navigation and restart follow top/visible contract, not centre anchor', () => {
  const viewport = { top_lid: '1.1', anchor_lid: '1.10', visible_lids: ['1.1', '1.10'] };
  assert.equal(viewportContains(viewport, '1.1'), true);
  assert.equal(positionRestored(viewport, viewport, '1.1'), true);
  assert.equal(viewportContains(viewport, '1.2'), false);
  assert.equal(positionRestored(viewport, { ...viewport, top_lid: '1.2' }, '1.1'), false);
});
test('reference protocol binds only supplied evidence; preserves exact formula bytes', () => {
  const units = evidenceUnits([block]);
  const r = bindReferences({ refused: false, fields: { x: { value: true, citations: [units[0].id] } } }, [block]);
  assert.equal(scoreTask(task, r, [block], source).success, true);
  const forged = bindReferences({ refused: false, fields: { x: { value: true, citations: ['unknown'] } } }, [block]);
  assert.equal(scoreTask(task, forged, [block], source).success, false);
  const formula = { id: 'f', start: 0, text: '$\n\\sqrt{n}\n$\n\nnext' };
  assert.deepEqual(evidenceUnits([formula]).map(u => u.text), ['$\n\\sqrt{n}\n$', 'next']);
  assert(!JSON.stringify(referencePrompt(task, [])).includes('事实甲'));
});
