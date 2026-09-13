import { test, expect, chromium } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Real tiny_http host, real history/Reader storage, controlled HTTP model responses.
for (const mode of ["native", "react"]) test(`${mode}: running activities survive reload and share the trace timeline; stop and saved completion settle`, async ({ page: defaultPage }) => {
  let page = defaultPage;
  let webview: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const root = await mkdtemp(join(tmpdir(), "ub-as5-browser-"));
  const book = join(root, "book");
  await mkdir(book);
  const paragraphs = Array.from({ length: 24 }, (_, i) => `这是第 ${i + 1} 段原文，用于验证阅读与运行活动。\n`);
  let offset = 0;
  const leaves = paragraphs.map((text, i) => { const start = offset; offset += text.length; return { lid: `1.${i + 1}`, path: [1, i + 1], kind: "paragraph", span: { start, end: offset }, children: [] }; });
  await writeFile(join(book, "source.txt"), paragraphs.join(""));
  await writeFile(join(book, "base.json"), JSON.stringify({ book_id: "as5-browser", lid_nodes: [{ lid: "1", path: [1], kind: "chapter", span: { start: 0, end: offset }, children: leaves.map(n => n.lid) }, ...leaves], graph_nodes: [], graph_edges: [] }));
  type Step = { body: Record<string, unknown>; response: ServerResponse };
  const pending: Step[] = [];
  const receivers: Array<(step: Step) => void> = [];
  const outstanding = new Set<ServerResponse>();
  let requestCount = 0;
  let holdMetrics = false;
  const metricsResponses = new Set<ServerResponse>();
  const provider = createServer(async (request, response) => {
    if (request.url === "/metrics-gate") {
      if (holdMetrics) metricsResponses.add(response);
      else response.end();
      return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const step = { body: JSON.parse(raw), response };
    requestCount++;
    outstanding.add(response);
    const receiver = receivers.shift(); if (receiver) receiver(step); else pending.push(step);
  });
  await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
  const providerPort = (provider.address() as { port: number }).port;
  // Pause the actual metrics subprocess before its normal script executes.
  const preload = join(root, "metrics-gate.mjs");
  await writeFile(preload, `if (process.argv.some(arg => arg.endsWith('intent-metrics.ts'))) await fetch('http://127.0.0.1:${providerPort}/metrics-gate');`);
  const next = () => pending.length ? Promise.resolve(pending.shift()!) : new Promise<Step>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Expected model request after ${requestCount} received`)), 12_000);
    receivers.push(step => { clearTimeout(timeout); done(step); });
  });
  const answer = (step: Step, content: string) => { outstanding.delete(step.response); step.response.setHeader("Content-Type", "application/json"); step.response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { total_tokens: 5 } })); };
  const tool = (step: Step, name: string, args: unknown) => { if (mode === "react") { answer(step, JSON.stringify({ tool_calls: [{ id: `call-${requestCount}`, name, arguments: args }] })); return; } outstanding.delete(step.response); step.response.setHeader("Content-Type", "application/json"); step.response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call-${requestCount}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { total_tokens: 5 } })); };
  let host: ChildProcess | undefined;
  let nginx: ChildProcess | undefined;
  let hostOutput = "";
  try {
    // Isolate the host from a prebuilt sibling sidecar, exercising the real development Core script.
    const hostBinary = join(root, "server" + (process.platform === "win32" ? ".exe" : ""));
    await copyFile(resolve("../../target/" + (process.env.AS9_RELEASE ? "release" : "debug") + "/server" + (process.platform === "win32" ? ".exe" : "")), hostBinary);
    const desktop = process.env.AS9_WEBVIEW === "1";
    const appdata = join(root, "appdata");
    await mkdir(join(appdata, "UnderstandBook"), { recursive: true });
    await mkdir(join(root, "library"), { recursive: true });
    await writeFile(join(appdata, "UnderstandBook", "settings.json"), JSON.stringify({ schema: "understand_book.desktop_settings.v1", library_root: join(root, "library") }));
    host = spawn(desktop ? resolve("../../target/debug/UnderstandBook.exe") : hostBinary, desktop ? [book] : ["--reader-only", book], {
      cwd: root, windowsHide: true,
      env: { ...process.env, ...(desktop ? { LOCALAPPDATA: appdata, WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19224" } : {}), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, UNDERSTAND_BOOK_ADDR: "127.0.0.1:0", UNDERSTAND_BOOK_WEB_DIST: resolve("dist"), UNDERSTAND_BOOK_MEMORY_DIR: join(root, "memory"), UNDERSTAND_BOOK_PRIVATE_DIR: join(root, "private"), UNDERSTAND_BOOK_PROVIDER: mode, OPENCODE_API_KEY: "test-key", OPENCODE_BASE_URL: `http://127.0.0.1:${providerPort}`, FLUID_LLM_MODEL: "test-model" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let url: string;
    if (desktop) {
      await expect.poll(async () => { try { return (await fetch("http://127.0.0.1:19224/json/version")).ok; } catch { return false; } }, { timeout: 30000 }).toBe(true);
      webview = await chromium.connectOverCDP("http://127.0.0.1:19224");
      await expect.poll(() => webview!.contexts()[0].pages().length).toBeGreaterThan(0);
      page = webview.contexts()[0].pages()[0];
      await expect.poll(() => page.url(), { timeout: 20000 }).toMatch(/^http:/);
      url = new URL(page.url()).origin;
    } else {
      url = await new Promise<string>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Host startup: ${hostOutput}`)), 12000);
        host!.stderr!.on("data", chunk => { hostOutput += chunk; const match = hostOutput.match(/listening at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); done(match[1]); } });
        host!.once("exit", code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}: ${hostOutput}`)); });
      });
    }
    if (process.env.AS9_NGINX_TEMPLATE) {
      let proxy = await readFile(process.env.AS9_NGINX_TEMPLATE, "utf8");
      proxy = proxy.replace("listen 8080;", "listen 127.0.0.1:19080;")
        .replace(/auth_basic \"[^\"]*\";/, "auth_basic off;")
        .replace("http://127.0.0.1:8787", url)
        .replace(/access_log [^;]+;/, `access_log ${join(root, "nginx-access.log")};`)
        .replace(/error_log [^;]+;/, `error_log ${join(root, "nginx-error.log")};`);
      const config = join(root, "nginx.conf");
      await writeFile(config, `pid ${join(root, "nginx.pid")};\nevents {}\nhttp { ${proxy} }`);
      nginx = spawn("/usr/sbin/nginx", ["-p", root, "-c", config, "-g", "daemon off;"], { stdio: ["ignore", "pipe", "pipe"] });
      nginx.stderr!.on("data", chunk => { hostOutput += chunk; });
      url = "http://127.0.0.1:19080";
      await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }).toBe(200);
    }
    await page.goto(url);
    await expect(page.locator(".agent-input textarea")).toBeVisible();
    await page.locator(".agent-input textarea").fill("解释 1.1 这段原文");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const first = await next();
    first.response.setHeader("Content-Type", "text/event-stream");
    const firstFrame = (delta: unknown, finish_reason: string | null = null) => first.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    firstFrame({ content: mode === "react" ? '{"final":"正在查阅原文。",' : '正在查阅原文。' });
    await expect(page.locator(".answer-draft")).toContainText("正在查阅原文。");
    if (mode === "native") firstFrame({ tool_calls: [{ index: 0, id: "first-call", function: { name: "book.text", arguments: '{"lid":' } }] });
    else firstFrame({ content: '"tool_calls":[{"id":"first-call","name":"book.text","arguments":{"lid":' });
    expect(requestCount).toBe(1);
    await expect(page.locator('.transcript .agent-activity').filter({ hasText: '读取原文' })).toHaveCount(0);
    if (mode === "native") { firstFrame({ tool_calls: [{ index: 0, function: { arguments: '"1.1"}' } }] }); firstFrame({}, "tool_calls"); }
    else { firstFrame({ content: '"1.1"}}]}' }); firstFrame({}, "stop"); }
    outstanding.delete(first.response); first.response.end('data: [DONE]\n\n');
    tool(await next(), "book.synthesize", { lids: ["1.1"], task: "解释" });
    const synthesis = await next();
    await expect(page.locator('.transcript .agent-activity[data-status="running"]')).toHaveCount(2);
    await expect(page.locator('.transcript .agent-activity.nested')).toContainText("综合原文");
    const countBeforeReload = requestCount;
    holdMetrics = true;
    await page.reload();
    await expect(page.locator('.transcript .agent-activity[data-status="running"]')).toHaveCount(2);
    if (!desktop) await expect.poll(() => metricsResponses.size, { timeout: 15_000 }).toBeGreaterThan(0);
    const readerResponse = await page.request.post(`${url}/api/reader/state`, { data: {}, timeout: 4000 });
    expect(readerResponse.status()).toBe(200);
    expect(requestCount).toBe(countBeforeReload);
    await page.getByRole("button", { name: "轨迹", exact: true }).click();
    await expect(page.locator('.tab-panel:visible .agent-activity[data-status="running"]')).toHaveCount(2);
    await page.getByRole("button", { name: "问答", exact: true }).click();
    const cancellationResponse = page.waitForResponse(response => response.url().endsWith("/cancel"), { timeout: 8000 });
    await page.getByRole("button", { name: "停止", exact: true }).click();
    const cancellation = await cancellationResponse;
    expect(cancellation.status()).toBe(200);
    expect((await cancellation.json()).execution_state).toBe("cancelling");
    await expect(page.locator(".transcript .run-status")).toContainText("正在停止");
    holdMetrics = false;
    for (const response of metricsResponses) response.end();
    metricsResponses.clear();
    answer(synthesis, JSON.stringify({ sufficient: true, answer: "综合结果", citations: [] }));
    await expect(page.locator(".transcript .run-status")).toContainText("已停止");
    await expect(page.locator('.transcript .agent-activity[data-status="running"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".transcript .run-status")).toContainText("已停止");
    await page.locator(".agent-input textarea").fill("继续解释");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const continued = await next();
    await page.getByRole("button", { name: "轨迹", exact: true }).click();
    await expect(page.locator('.tab-panel:visible .agent-activity[data-status="running"]')).toHaveCount(1);
    await expect(page.locator('.tab-panel:visible .trace-card')).toHaveCount(0);
    await page.getByRole("button", { name: "问答", exact: true }).click();
    expect(continued.body.stream).toBe(true);
    continued.response.setHeader("Content-Type", "text/event-stream");
    const delta = (content: string) => continued.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    delta(mode === "react" ? '{"final":"这是已保存的' : '这是已保存的');
    delta('最终解释。');
    await expect(page.locator(".answer-draft .answer-markdown")).toContainText("这是已保存的最终解释。");
    delta("补充说明。");
    await expect(page.locator(".answer-draft")).toContainText("这是已保存的最终解释。补充说明。");
    const requestsBeforeDraftReload = requestCount;
    await page.reload();
    await expect(page.locator(".answer-draft .answer-markdown")).toContainText("这是已保存的最终解释。");
    expect(requestCount).toBe(requestsBeforeDraftReload);
    if (mode === "react") delta('"}');
    outstanding.delete(continued.response);
    continued.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
    await expect(page.locator(".answer-markdown")).toContainText("这是已保存的最终解释。");
    await page.reload();
    await expect(page.locator(".answer-markdown")).toContainText("这是已保存的最终解释。");
    await expect(page.locator('.transcript .agent-activity[data-status="running"]')).toHaveCount(0);
    await page.locator(".agent-input textarea").fill("读取 1.1 并引用原文，同时保存一条笔记");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    tool(await next(), "book.text", { lid: "1.1" });
    tool(await next(), "source.present", { start_lid: "1.1" });
    tool(await next(), "reader.note", { lid: "1.1", text: "AS8 即时笔记" });
    const sourced = await next();
    await expect(page.locator(".live-effects")).toContainText("笔记");
    const allContent = JSON.stringify(sourced.body);
    const ref = allContent.match(/source_ref_[0-9a-f]{16}/)?.[0];
    expect(ref, allContent).toBeTruthy();
    sourced.response.setHeader("Content-Type", "text/event-stream");
    const sourceDelta = (content: string) => sourced.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    sourceDelta((mode === "react" ? '{"final":"' : '') + `原文说明阅读活动。[[source:${ref}]]\n` .replace(/\n/g, mode === "react" ? '\\n' : '\n'));
    await expect(page.locator(".answer-draft .agent-source-button")).toHaveCount(1);
    await page.locator(".answer-draft .agent-source-button").click();
    await expect(page.getByRole("dialog", { name: "回答来源" }).locator("mark")).toContainText("原文");
    await page.getByRole("button", { name: "在正文中查看" }).click();
    await expect(page.getByRole("dialog", { name: "回答来源" })).toHaveCount(0);
    const sourceRequests = requestCount;
    await page.reload();
    await expect(page.locator(".answer-draft .agent-source-button")).toHaveCount(1);
    expect(requestCount).toBe(sourceRequests);
    if (mode === "react") sourceDelta('"}');
    outstanding.delete(sourced.response);
    sourced.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    await expect(page.locator(".answer-draft")).toHaveCount(0);
    await page.locator(".agent-source-button").last().click();
    await expect(page.getByRole("dialog", { name: "回答来源" }).locator("mark")).toContainText("原文");
    await page.getByRole("button", { name: "在正文中查看" }).click();
    await page.locator(".agent-input textarea").fill("换一种解释");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const invalid = await next();
    invalid.response.setHeader("Content-Type", "text/event-stream");
    const invalidFrame = (content: string) => invalid.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    invalidFrame(mode === "react" ? '{"final":"暂时可见的旧草稿。' : '暂时可见的旧草稿。');
    await expect(page.locator(".answer-draft").last()).toContainText("暂时可见的旧草稿。");
    invalidFrame('内部位置是 LID 1.1。' + (mode === "react" ? '"}' : ''));
    outstanding.delete(invalid.response);
    invalid.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    const repair = await next();
    repair.response.setHeader("Content-Type", "text/event-stream");
    repair.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: mode === "react" ? '{"final":"这是修复后的解释。' : '这是修复后的解释。' }, finish_reason: null }] })}\n\n`);
    await expect(page.locator(".answer-draft").last()).toContainText("这是修复后的解释。");
    await expect(page.locator(".answer-draft").last()).not.toContainText("旧草稿");
    await expect(page.locator(".transcript")).not.toContainText("LID 1.1");
    if (mode === "react") repair.response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '"}' }, finish_reason: null }] })}\n\n`);
    outstanding.delete(repair.response);
    repair.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    await expect(page.locator(".answer-draft")).toHaveCount(0);
    await expect(page.locator(".answer-markdown").last()).toContainText("这是修复后的解释。");
    await page.reload();
    await expect(page.locator(".answer-markdown").last()).toContainText("这是修复后的解释。");
    await page.locator(".agent-input textarea").fill("再解释一次");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    answer(await next(), "");
    await expect(page.locator(".transcript .run-status").last()).toContainText("运行失败");
    await expect(page.locator('.transcript .agent-activity[data-status="running"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.transcript')).toContainText(mode === "native" ? "PROVIDER_EMPTY_RESPONSE" : "PROVIDER_ERROR");
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  } finally {
    await test.info().attach("host.log", { body: hostOutput, contentType: "text/plain" });
    for (const response of metricsResponses) response.end();
    for (const response of outstanding) response.destroy();
    await webview?.close();
    nginx?.kill();
    host?.kill();
    provider.closeAllConnections();
    await new Promise<void>(done => provider.close(() => done()));
  }
});
