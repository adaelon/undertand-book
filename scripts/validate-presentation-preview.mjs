// Installed-host probe. Usage: node scripts/validate-presentation-preview.mjs <host executable> <evidence directory>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const [executable, evidence] = process.argv.slice(2);
if (!executable || !evidence) throw new Error('Pass the built Server or installed UnderstandBook executable and evidence directory');
mkdirSync(evidence, { recursive: true });
const profiles = () => readdirSync(tmpdir()).filter(name => name.startsWith('understand-book-preview-'));
const before = new Set(profiles());
const html = readFileSync(new URL('../crates/server/tests/fixtures/presentation-recall.html', import.meta.url), 'utf8');
const request = { candidate_id: 'rp1-recall-probe', html, actions: [
  { kind: 'click', selector: '#irrelevant' }, { kind: 'click', selector: '#complete' },
  { kind: 'click', selector: '#count' }, { kind: 'key', key: 'End' }, { kind: 'key', key: 'ArrowLeft' },
] };
writeFileSync(path.join(evidence, 'request.json'), JSON.stringify(request));
const start = Date.now();
const run = spawnSync(executable, ['--presentation-preview-probe'], { input: JSON.stringify(request), encoding: 'utf8', timeout: 45000, maxBuffer: 24 * 1024 * 1024, windowsHide: true });
writeFileSync(path.join(evidence, 'stderr.log'), run.stderr ?? '');
assert.ifError(run.error);
writeFileSync(path.join(evidence, 'raw-result.json'), run.stdout);
assert.equal(run.status, 0, run.stdout + run.stderr);
const report = JSON.parse(run.stdout);
assert.equal(report.candidate_id, request.candidate_id);
assert.deepEqual(report.errors, []);
assert.equal(report.observations.length, 6);
for (const [step, expected] of [[0, '2/3 = 0.667'], [1, '2/3 = 0.667'], [2, '3/3 = 1.000'], [5, '2/3 = 0.667']]) {
  assert.ok(report.observations[step].dom.text.includes(expected), `step ${step}: ${expected}`);
}
assert.ok(report.observations[2].dom.text.includes('当前已找到 3 处'));
for (const observation of report.observations) {
  const bytes = Buffer.from(observation.screenshot_png_base64, 'base64');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  writeFileSync(path.join(evidence, `step-${observation.step}.png`), bytes);
  delete observation.screenshot_png_base64;
  observation.screenshot = `step-${observation.step}.png`;
}
assert.deepEqual(profiles().filter(name => !before.has(name)), [], 'preview profiles leaked');
const result = { status: 'passed', platform: process.platform, executable: path.resolve(executable), elapsed_ms: Date.now() - start, temporary_profiles_cleaned: true, ...report };
writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, platform: result.platform, browser: report.browser, elapsed_ms: result.elapsed_ms, observations: report.observations.length, evidence }, null, 2));
