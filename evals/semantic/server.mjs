import { spawn } from 'node:child_process';
import path from 'node:path';

// Use a new process and isolated memory; never attach to the user's running Reader.
export async function startServer(bookDir, memoryDir, root = process.cwd(), extraEnv = {}) {
  const executable = process.env.SEMANTIC_EVAL_SERVER ?? path.join(root, 'target', 'debug', process.platform === 'win32' ? 'server.exe' : 'server');
  const child = spawn(executable, [bookDir], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv, UNDERSTAND_BOOK_ADDR: '127.0.0.1:0', UNDERSTAND_BOOK_MEMORY_DIR: memoryDir,
      UNDERSTAND_BOOK_REVIEW_DRAIN_TIMEOUT_MS: '50', UNDERSTAND_BOOK_WEB_DIST: path.join(root, 'packages/web/dist') } });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Reader startup timed out')); }, 30000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Reader exited during startup (${code})`)); });
    child.stderr.on('data', b => {
      log = (log + b.toString()).slice(-5000);
      const match = log.match(/listening at (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stdout.resume();
  });
  return { child, url,
    api: (route, args = {}, method = 'GET', timeoutMs) => apiRequest(url, route, args, method, timeoutMs),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned Reader process did not exit')), 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
      });
    },
  };
}
export async function apiRequest(base, route, args = {}, method = 'GET', timeoutMs = 30000) {
  const url = new URL(`/api/${route}`, base);
  if (method === 'GET') for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs),
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${value.error_code ?? ''}`);
  return value;
}
