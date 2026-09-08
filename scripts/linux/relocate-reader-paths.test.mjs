import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relocateDocuments, relocateFiles } from './relocate-reader-paths.mjs';

const mapping = { 'E:\\books\\中文 空格': '/books/中文 空格', 'C:\\papers\\B': '/books/B' };
const session = { current_book_dir: 'E:\\books\\中文 空格', books: {
  '\\\\?\\E:\\books\\中文 空格': { top_lid: '1.2' }, 'C:\\papers\\B': { top_lid: '2.3' },
} };
test('two books, Windows canonical paths and legacy progress survive relocation', () => {
  const result = relocateDocuments({ session, registry: { workspaces: Object.keys(mapping) } }, mapping);
  assert.equal(result.session.current_book_dir, '/books/中文 空格');
  assert.deepEqual(result.session.books, { '/books/中文 空格': { top_lid: '1.2' }, '/books/B': { top_lid: '2.3' } });
  assert.deepEqual(result.registry.workspaces, Object.values(mapping));
  assert.deepEqual(relocateDocuments(result, mapping), result);
  assert.deepEqual(relocateDocuments({ session: { book_dir: 'C:\\papers\\B', top_lid: '2.3' } }, mapping).session,
    { book_dir: '/books/B', top_lid: '2.3' });
});
test('mapping and existing destination collisions fail without overwriting progress', () => {
  assert.throws(() => relocateDocuments({ session }, { ...mapping, 'D:\\other': '/books/B' }), /conflict/);
  assert.throws(() => relocateDocuments({ session: { ...session, books: { ...session.books, '/books/B': { top_lid: '9' } } } }, mapping), /conflict/);
  assert.throws(() => relocateDocuments({ session }, {}), /Missing directory mapping/);
});
test('only selected known files change, dry run and repeated apply preserve bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-lx5-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify(session));
  fs.writeFileSync(path.join(root, 'library-registry.json'), JSON.stringify({ workspaces: Object.keys(mapping) }));
  const privateData = '{"note":{"lid":"1.2","content":"C:\\\\papers\\\\B"},"profile":{"goal":"学习"},"history":["对话"]}';
  fs.writeFileSync(path.join(root, 'memory.json'), privateData);
  const options = { memoryDir: root, libraryRoot: root, mapping };
  const before = fs.readFileSync(path.join(root, 'session.json'));
  assert.equal(relocateFiles(options).changed.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(root, 'session.json')), before);
  assert.equal(relocateFiles({ ...options, apply: true }).changed.length, 2);
  assert.equal(relocateFiles({ ...options, apply: true }).changed.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'), privateData);
});
