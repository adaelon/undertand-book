import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregate } from './core.mjs';

const reporter = fileURLToPath(new URL('./report.mjs', import.meta.url));
test('public report removes corpus excerpts and reports actual sample counts and absent metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-book-report-test-'));
  const row = { id: 'exact-01', system: 'Chunk RAG (BM25)', category: 'exact',
    elapsed_ms: 1000, retrieval_ms: 2, total_tokens: 17,
    raw: 'PRIVATE_RAW_ANSWER', trace: [{ text: 'PRIVATE_GRAPH_TEXT' }],
    blocks: [{ id: 'c', start: 0, end: 10, text: 'PRIVATE_SOURCE' }],
    response: { refused: false, fields: { answer: { value: true, citations: [{ source_id: 'c', quote: 'PRIVATE_QUOTE' }] } } },
    score: { evidence_recall: 1, citation_count: 1, supported_citations: 1, success: true, details: [] } };
  const run = { version: 'test', config: { version: 'test', evidenceChars: 6000, maxOutputTokens: 4096 },
    started_at: '2026-09-08T00:00:00Z', corpus: { book_id: 'test', lids: 1, graph_nodes: 0, graph_edges: 0 },
    results: [row], restart: [{ id: 'restart-01', kind: 'note', success: true, process_changed: true, observed: 'PRIVATE_MEMORY' }],
    summary: { 'Chunk RAG (BM25)': aggregate([row]), 'LID + Graph': aggregate([]) }, status: 'completed' };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  execFileSync(process.execPath, [reporter, dir], { windowsHide: true });
  const json = fs.readFileSync(path.join(dir, 'summary.json'), 'utf8');
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert(!json.includes('PRIVATE_'));
  assert.equal(JSON.parse(json).results[0].fields.answer.value, true);
  assert(md.includes('1 道阅读任务'));
  assert(md.includes('额外 1 道共享 Reader 重启检查'));
  assert(md.includes('| LID + Graph | N/A | N/A | N/A (0/0) | N/A | N/A |'));
  // These files are generated fixtures in a newly created test directory, never a user workspace.
  for (const name of ['run.json', 'summary.json', 'report.md']) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
});
