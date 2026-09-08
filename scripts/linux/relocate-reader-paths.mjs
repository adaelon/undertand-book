#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function key(value) {
  const unprefixed = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return path.win32.isAbsolute(unprefixed) && !unprefixed.startsWith('/')
    ? path.win32.normalize(unprefixed).replace(/[\\/]+$/, '').toLowerCase()
    : path.posix.normalize(unprefixed).replace(/\/$/, '') || '/';
}

export function relocateDocuments({ session, registry }, mapping) {
  const dirs = new Map();
  const targets = new Set();
  for (const [oldDir, newDir] of Object.entries(mapping)) {
    if (typeof newDir !== 'string' || !path.posix.isAbsolute(newDir)) {
      throw new Error(`Linux target must be absolute: ${oldDir}`);
    }
    const target = path.posix.normalize(newDir);
    if (dirs.has(key(oldDir)) || targets.has(key(target))) throw new Error(`Directory mapping conflict: ${oldDir}`);
    dirs.set(key(oldDir), target);
    targets.add(key(target));
  }
  function relocate(value) {
    if (typeof value !== 'string') throw new Error('Expected a directory string');
    const mapped = dirs.get(key(value));
    if (mapped) return mapped;
    if (path.win32.isAbsolute(value) && !value.startsWith('/')) throw new Error(`Missing directory mapping: ${value}`);
    return value;
  }
  const result = structuredClone({ session, registry });
  if (result.session) {
    if ('current_book_dir' in result.session) {
      result.session.current_book_dir = relocate(result.session.current_book_dir);
      const books = {};
      const seen = new Set();
      for (const [dir, progress] of Object.entries(result.session.books ?? {})) {
        const target = relocate(dir);
        if (seen.has(key(target))) throw new Error(`Session progress conflict: ${target}`);
        seen.add(key(target));
        books[target] = progress;
      }
      result.session.books = books;
    } else if ('book_dir' in result.session) {
      // Preserve the legacy schema; the Reader already knows how to load it.
      result.session.book_dir = relocate(result.session.book_dir);
    } else throw new Error('Unrecognized session format');
  }
  if (result.registry) {
    const workspaces = (result.registry.workspaces ?? []).map(relocate);
    if (new Set(workspaces.map(key)).size !== workspaces.length) throw new Error('Library workspace mapping conflict');
    result.registry.workspaces = workspaces;
  }
  return result;
}

export function relocateFiles({ memoryDir, libraryRoot, mapping, apply = false }) {
  const paths = { session: path.join(memoryDir, 'session.json'), registry: path.join(libraryRoot, 'library-registry.json') };
  const original = Object.fromEntries(Object.entries(paths).map(([name, filename]) =>
    [name, fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : undefined]));
  // Compute both documents and detect all conflicts before changing either file.
  const result = relocateDocuments(original, mapping);
  const changed = Object.keys(paths).filter(name => JSON.stringify(original[name]) !== JSON.stringify(result[name]));
  if (apply) for (const name of changed) fs.writeFileSync(paths[name], `${JSON.stringify(result[name], null, 2)}\n`);
  return { applied: apply, changed: changed.map(name => paths[name]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') options.apply = true;
      else if (['--memory-dir', '--library-root', '--map'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    if (!options['memory-dir'] || !options['library-root'] || !options.map) {
      throw new Error('Usage: node relocate-reader-paths.mjs --memory-dir <copy> --library-root <copy> --map <mapping.json> [--apply]');
    }
    console.log(JSON.stringify(relocateFiles({ memoryDir: options['memory-dir'], libraryRoot: options['library-root'],
      mapping: JSON.parse(fs.readFileSync(options.map, 'utf8')), apply: options.apply }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
