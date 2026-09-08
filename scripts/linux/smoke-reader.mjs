// Real deployed reader acceptance. Never starts a dev server or mocks API responses.
// Run from the repository: node scripts/linux/smoke-reader.mjs technical|qa|guided|pdf|images|artifacts|restore
// Required: READER_URL, READER_TECHNICAL_DIR, READER_PAPER_DIR; optional READER_EVIDENCE_DIR.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const base = process.env.READER_URL;
const technical = process.env.READER_TECHNICAL_DIR;
const paper = process.env.READER_PAPER_DIR;
const output = process.env.READER_EVIDENCE_DIR ?? 'tmp/linux-reader-smoke';
const mode = process.argv[2];
assert(base && technical && paper, 'Set READER_URL, READER_TECHNICAL_DIR and READER_PAPER_DIR');
assert(['technical', 'qa', 'guided', 'images', 'artifacts', 'pdf', 'restore'].includes(mode), 'Choose technical, qa, guided, images, artifacts, pdf or restore');
await fs.mkdir(output, { recursive: true });
const checks = [];
const evidence = { mode, base, started_at: new Date().toISOString(), checks };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(120000);
const errors = [];
const buildRequests = [];
const pendingRequests = new Set();
const failedRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('requestfinished', r => pendingRequests.delete(r.url()));
page.on('requestfailed', r => {
  pendingRequests.delete(r.url());
  failedRequests.push({ url: r.url(), error: r.failure()?.errorText });
});
page.on('request', r => {
  pendingRequests.add(r.url());
  if (r.method() === 'POST' && /\/build_workbench\//.test(r.url())) buildRequests.push(r.url());
});
async function save(name, value) {
  await fs.writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}
function checked(name) { checks.push(name); console.log('PASS', name); }
async function api(route, body) {
  const url = new URL(base + '/api' + route);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', Connection: 'close',
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) },
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', data => { raw += data; });
      response.on('end', () => {
        try {
          assert(response.statusCode < 300, `${route}: ${response.statusCode} ${raw}`);
          resolve(JSON.parse(raw));
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.setTimeout(240000, () => request.destroy(new Error(`${route}: timeout`)));
    request.on('error', reject);
    request.end(payload);
  });
}
async function openBook(dir) {
  await api('/book/open', { dir });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.agent-input textarea').waitFor({ state: 'visible' });
}
async function chat(message, name) {
  await page.locator('.agent-input textarea').fill(message);
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/agent/chat'), { timeout: 240000 });
  await page.locator('.agent-input > button').click();
  const response = await responsePromise;
  const outcome = await response.json();
  await save(name, outcome);
  assert(response.ok(), `${name}: ${JSON.stringify(outcome)}`);
  assert(outcome.answer?.length > 10 && !outcome.incomplete, `${name}: incomplete answer`);
  await page.locator('.agent-input > button').getByText('发送', { exact: true }).waitFor();
  return outcome;
}
async function selectPdfText(requireResolution = true) {
  const text = page.locator('.pdf-text-layer span').filter({ hasText: /\w.{45}/ }).first();
  await text.scrollIntoViewIfNeeded();
  const response = requireResolution ? page.waitForResponse(r => r.url().endsWith('/reader/pdf_selection.resolve')) : null;
  await text.evaluate(element => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    element.closest('.pdf-page-list').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('.pdf-selection-toolbar').getByTitle('笔记', { exact: true }).waitFor({ state: 'visible' });
  if (!response) return;
  const resolved = await (await response).json();
  assert(resolved.ranges?.length > 0, 'Real PDF selection must resolve to source');
  return resolved;
}
try {
  const host = await api('/desktop/status');
  assert.equal(host.desktop_host, false);
  assert.equal(host.reader_only, true);
  checked('Linux pure-reader host');
  if (mode === 'technical' || mode === 'qa' || mode === 'guided') {
    await openBook(technical);
    await page.locator('.reader-pane').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: '打开桌面设置' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开构建方案' }).count(), 0);
    checked('technical book rendered with server menus');
    const firstTitle = await page.locator('.outline-title').first().innerText();
    await page.locator('#outline-search').fill(firstTitle);
    await page.locator('.outline-item').first().click();
    await page.locator('#outline-search').fill('');
    checked('outline search and navigation');
    if (mode !== 'guided') {
    const answer = await chat(process.env.READER_QUESTION ?? '这份材料的核心观点是什么？请读取原文，用简短中文回答并给出可以点击的原文来源。', 'qa-answer');
    assert(answer.answer_view.sources.length > 0, 'Q&A must contain real sources');
    await page.locator('.agent-source-button').last().click();
    await page.locator('.source-highlight').waitFor({ state: 'visible' });
    evidence.source_quote = await page.locator('.source-highlight').innerText();
    assert(evidence.source_quote.length > 0);
    const opened = page.waitForResponse(r => r.url().endsWith('/agent/source.open'));
    await page.getByRole('button', { name: '在正文中查看' }).click();
    // The visible paragraph is the acceptance criterion; source API naming can evolve.
    assert((await opened).ok());
    await page.waitForFunction(quote => document.querySelector('.reader-pane')?.textContent.includes(quote), evidence.source_quote);
    checked('real Provider Q&A and source opens actual text');
    }
    if (mode !== 'qa') {
    const guided = await chat('带我读这篇材料，从当前位置选择下一站，实际导航过去，简短解释这一站后停下。', 'guided-answer');
    const goto = guided.effects.find(effect => effect.kind === 'Goto');
    assert(goto && goto.before_anchor !== goto.after_anchor, 'Guided reading must move viewport');
    const state = await api('/reader/state', {});
    assert.equal(state.viewport.anchor_lid, goto.after_anchor);
    await page.getByRole('button', { name: '返回原位置', exact: true }).last().waitFor({ state: 'visible' });
    evidence.guided_anchor = goto.after_anchor;
    checked('real Provider guided-reading navigation effect rendered');
    }
    evidence.history = await api('/agent/history');
    evidence.profile = await api('/profile/memory');
    evidence.usage = await api('/build_intent/usage');
    assert(evidence.usage.event_count > 0);
    checked('real Node usage, profile and chat projections');
  }
  if (mode === 'pdf') {
    await page.goto(base);
    await page.locator('.agent-input textarea').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '打开书', exact: true }).click();
    await page.locator('.book-picker-card').filter({ hasText: paper }).dblclick();
    await page.locator('.pdf-text-layer span').first().waitFor({ state: 'visible' });
    checked('book library switches to real paper PDF');
    assert(await page.locator('.pdf-page-canvas').first().evaluate(c => c.width > 0 && c.height > 0));
    evidence.selection = await selectPdfText();
    const translated = page.waitForResponse(r => r.url().endsWith('/reader/selection.translate'), { timeout: 180000 });
    await page.locator('.pdf-selection-toolbar').getByTitle('翻译', { exact: true }).click();
    const translationResponse = await translated;
    evidence.translation = await translationResponse.json();
    assert(translationResponse.ok());
    assert(/[\u4e00-\u9fff]/.test(evidence.translation.translation_markdown));
    await page.getByRole('dialog', { name: 'PDF 选区翻译' }).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(output, 'pdf-translation.png') });
    checked('real PDF selection translation via configured Provider');
    await page.getByRole('button', { name: '关闭翻译', exact: true }).click();
    const highlighted = page.waitForResponse(r => r.url().endsWith('/reader/highlight'));
    await page.locator('.pdf-selection-toolbar').getByTitle('高亮', { exact: true }).click();
    evidence.highlight = await (await highlighted).json();
    await page.locator('.pdf-user-highlight').first().waitFor({ state: 'visible' });
    checked('PDF highlight displayed');
    await selectPdfText(false);
    await page.locator('.pdf-selection-toolbar').getByTitle('笔记', { exact: true }).click();
    evidence.note_text = `LX7 Linux PDF note ${new Date().toISOString()}`;
    await page.locator('.note-dialog textarea').fill(evidence.note_text);
    const noted = page.waitForResponse(r => r.url().endsWith('/memory/save'));
    await page.locator('.note-dialog .primary').click();
    evidence.note = await (await noted).json();
    await page.locator('.pdf-note-marker').first().waitFor({ state: 'visible' });
    await page.locator('.pdf-note-marker').first().click();
    await page.getByRole('dialog', { name: 'PDF 用户标注' }).waitFor({ state: 'visible' });
    await page.getByRole('dialog', { name: 'PDF 用户标注' }).getByText(evidence.note_text, { exact: true }).waitFor({ state: 'visible' });
    evidence.state = await api('/reader/state', {});
    evidence.memory = await api('/memory/recall', { lid: evidence.selection.ranges[0].lid });
    evidence.profile = await api('/profile/memory');
    evidence.history = await api('/agent/history');
    checked('PDF Note displayed and persistent projections readable');
  }
  if (mode === 'images') {
    assert(process.env.READER_IMAGE_DIR, 'Set READER_IMAGE_DIR to a complete book with bundled images');
    await openBook(process.env.READER_IMAGE_DIR);
    const assets = await api('/book/asset_manifest');
    const asset = assets.images.find(image => image.status === 'available');
    assert(asset?.url_path, 'Material must contain a bundled image');
    await api('/reader/goto', { lid: asset.lid });
    await page.reload();
    const img = page.locator('.reader-pane img').filter({ visible: true }).first();
    await img.waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('.reader-pane img')].some(img => img.complete && img.naturalWidth > 0));
    evidence.image_lid = asset.lid;
    evidence.image_path = asset.url_path;
    checked('bundled book image displayed through Linux same-origin asset API');
  }
  if (mode === 'artifacts') {
    assert(process.env.READER_ARTIFACT_DIR, 'Set READER_ARTIFACT_DIR to the migrated accepted-artifact fixture');
    await openBook(process.env.READER_ARTIFACT_DIR);
    evidence.artifacts = await api('/build_intent/artifacts');
    const previous = JSON.parse(await fs.readFile(path.join(output, 'accepted-windows.json'), 'utf8'));
    assert.deepEqual(evidence.artifacts, previous);
    await page.locator('.context-tabs').getByRole('button', { name: /^成果/ }).click();
    await page.getByText('PRIVATE_SERVER_ARTIFACT_SENTINEL', { exact: false }).first().waitFor({ state: 'visible' });
    checked('migrated accepted projection equals Windows and renders in pure reader');
  }
  if (mode === 'restore') {
    const previous = JSON.parse(await fs.readFile(path.join(output, 'pdf.json'), 'utf8'));
    assert.equal((await api('/desktop/status')).book_dir, paper);
    evidence.state = await api('/reader/state', {});
    assert.equal(evidence.state.viewport.anchor_lid, previous.state.viewport.anchor_lid);
    evidence.memory = await api('/memory/recall', { lid: previous.selection.ranges[0].lid });
    assert(JSON.stringify(evidence.memory).includes(previous.note_text));
    assert(JSON.stringify(evidence.memory).includes(previous.highlight.highlight_id));
    evidence.profile = await api('/profile/memory');
    evidence.history = await api('/agent/history');
    assert.equal(evidence.history.active_session_id, previous.history.active_session_id);
    assert.deepEqual(evidence.history.current.turns, previous.history.current.turns);
    for (const fact of previous.profile.facts) {
      assert(evidence.profile.facts.some(saved => saved.fact_id === fact.fact_id), 'Profile fact must survive restart');
    }
    await page.goto(base);
    await page.locator('.pdf-user-highlight').first().waitFor({ state: 'visible' });
    await page.locator('.pdf-note-marker').first().click();
    await page.getByRole('dialog', { name: 'PDF 用户标注' }).getByText(previous.note_text, { exact: true }).waitFor({ state: 'visible' });
    checked('systemd restart restores book, viewport, PDF highlight and Note');
    await openBook(technical);
    evidence.technical_history = await api('/agent/history');
    assert(evidence.technical_history.current.turns.some(t => t.status === 'completed' && t.outcome?.effects.some(e => e.kind === 'Goto')));
    checked('technical guided-reading conversation survives restart and book switch');
  }
  assert.deepEqual(buildRequests, []);
  assert.deepEqual(errors, []);
  checked('no prebuild request or page exception');
  await page.screenshot({ path: path.join(output, mode + '.png'), fullPage: true });
  evidence.status = 'passed';
} catch (error) {
  evidence.pending_requests = [...pendingRequests];
  evidence.failed_requests = failedRequests;
  evidence.status = 'failed';
  evidence.error = String(error.stack ?? error);
  await fs.writeFile(path.join(output, mode + '-body.txt'), await page.locator('body').innerText().catch(() => ''));
  await page.screenshot({ path: path.join(output, mode + '-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
  console.error(evidence.error);
} finally {
  evidence.finished_at = new Date().toISOString();
  await save(mode, evidence);
  await browser.close();
}
