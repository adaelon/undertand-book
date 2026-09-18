import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Read only code-owned metrics. Semantic inputs, candidate bodies and model
// reasoning are intentionally outside this acceptance report.
const [workspace, output] = process.argv.slice(2);
if (!workspace || !output) throw Error('usage: node collect-a6-cost.mjs <workspace> <report.json>');
const root = path.join(workspace, '.build/automatic-build/v2/tasks/book_structure');
const rows = [];
for (const task of readdirSync(root, { withFileTypes: true })) {
  if (!task.isDirectory()) continue;
  const id = decodeURIComponent(task.name);
  const category = id.includes(':core-repair:') ? 'core_repair'
    : id.startsWith('stitch:select:') ? 'selection'
    : id.startsWith('stitch:relation:') ? 'relation' : undefined;
  if (!category) continue;
  const attempts = path.join(root, task.name, 'attempts');
  if (!existsSync(attempts)) continue;
  for (const attempt of readdirSync(attempts, { withFileTypes: true })) {
    if (!attempt.isDirectory()) continue;
    const file = path.join(attempts, attempt.name, 'metrics.json');
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    rows.push({ category, work_unit_id: id, attempt: m.attempt, status: m.status,
      input_bytes: m.input_bytes, output_bytes: m.output_bytes,
      executor_ms: m.executor_ms ?? null, writer_ms: m.writer_ms,
      diagnostic_code: m.diagnostic_code ?? null,
      usage: m.usage, estimate: m.estimate ?? null });
  }
}
const totals = Object.fromEntries(['core_repair', 'selection', 'relation'].map(category => {
  const selected = rows.filter(row => row.category === category);
  return [category, { terminal_attempts: selected.length,
    committed: selected.filter(row => row.status === 'committed').length,
    retries_or_failures: selected.filter(row => row.status !== 'committed').length,
    input_bytes: selected.reduce((n, row) => n + row.input_bytes, 0),
    output_bytes: selected.reduce((n, row) => n + row.output_bytes, 0),
    usage_available_attempts: selected.filter(row => ['native', 'executor_reported'].includes(row.usage?.source)).length,
    estimated_input_tokens: selected.every(row => row.estimate)
      ? selected.reduce((n, row) => n + row.estimate.input_tokens, 0) : null,
    estimated_output_tokens: selected.every(row => row.estimate)
      ? selected.reduce((n, row) => n + row.estimate.output_tokens, 0) : null }];
}));
const report = { measured_at: new Date().toISOString(), totals, rows,
  billing_cost: null, billing_note: 'No provider billing receipt is supplied by the executor protocol. Estimates are not billed token usage.' };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ totals, billing_cost: report.billing_cost }));
