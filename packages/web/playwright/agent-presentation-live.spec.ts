import { test, expect, chromium, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Opt-in acceptance: real Provider, product host, private disk, Reader and browser.
// The proxy records usage and injects one runtime error into a model-authored page.
// It never supplies content, tool calls, repair instructions or model answers.
test("RP7 live generation, sources, experiment, follow-up, revision and disk reopen", async () => {
  test.skip(!process.env.RP7_HOST_BINARY, "set RP7_HOST_BINARY and RP7_EVIDENCE_DIR; consumes real model usage");
  test.setTimeout(1_800_000);
  const root = resolve(process.env.RP7_EVIDENCE_DIR!);
  const repo = resolve("../..");
  await mkdir(root, { recursive: true });
  const save = (name: string, data: unknown) => writeFile(join(root, name), JSON.stringify(data, null, 2));
  const config: Record<string, string> = { ...process.env } as Record<string, string>;
  // Environment takes precedence; read the existing local provider configuration only.
  try { for (const line of (await readFile(join(repo, ".env"), "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !config[match[1]]) config[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  } } catch { /* Linux deployment can provide environment only. */ }
  expect(config.OPENCODE_API_KEY).toBeTruthy();
  expect(config.OPENCODE_BASE_URL).toBeTruthy();
  const desktop = process.env.RP7_DESKTOP === "1";
  const readerBrowser = desktop ? undefined : await chromium.launch({
    executablePath: process.env.UNDERSTAND_BOOK_PREVIEW_BROWSER,
    chromiumSandbox: true,
  });
  let page: Page = desktop ? undefined! : await readerBrowser!.newPage();
  let webview: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let host: ChildProcess | undefined;
  let hostOutput = "";
  let injected = false, sawFailure = false, imageCount = 0;
  const calls: any[] = [];
  const scenes: any[] = [];
  // Resume expensive completed model turns after a browser assertion or host fix.
  // All UI assertions still execute against persisted product data.
  if (process.env.RP7_RESUME === "1") {
    const previous = JSON.parse(await readFile(join(root, "run-state.json"), "utf8"));
    scenes.push(...previous.scenes);
    injected = previous.injected; sawFailure = previous.sawFailure; imageCount = previous.imageCount;
    calls.push(...(await readFile(join(root, "provider.jsonl"), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line)));
  }
  const proxy = createServer(async (req, res) => {
    const started = Date.now();
    try {
      let raw = ""; for await (const part of req) raw += part;
      const input = JSON.parse(raw);
      sawFailure ||= input.messages.some((m: any) => m.role === "tool" && typeof m.content === "string" && m.content.includes("RP7_INJECTED_RUNTIME_FAILURE"));
      for (const message of input.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "image_url") {
          const png = part.image_url.url.split(",")[1];
          await writeFile(join(root, `preview-${++imageCount}.png`), Buffer.from(png, "base64"));
        }
      }
      const upstream = await fetch(`${config.OPENCODE_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.OPENCODE_API_KEY}` },
        body: JSON.stringify(input), signal: AbortSignal.timeout(180_000),
      });
      const responseText = await upstream.text();
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      let result: any;
      if (contentType.includes("text/event-stream")) {
        // Observe the stream for evidence; forward its original bytes unchanged.
        const message: any = { content: "", tool_calls: [] };
        result = { choices: [{ message }] };
        for (const line of responseText.split(/\r?\n/)) {
          if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
          const event = JSON.parse(line.slice(5));
          if (event.usage) result.usage = event.usage;
          const delta = event.choices?.[0]?.delta;
          if (!delta) continue;
          message.content += delta.content ?? "";
          for (const part of delta.tool_calls ?? []) {
            const call = message.tool_calls[part.index] ??= { id: "", function: { name: "", arguments: "" } };
            call.id += part.id ?? "";
            call.function.name += part.function?.name ?? "";
            call.function.arguments += part.function?.arguments ?? "";
          }
        }
      } else result = JSON.parse(responseText);
      const message = result.choices?.[0]?.message;
      const record = { elapsed_ms: Date.now() - started, status: upstream.status, usage: result.usage, response: message,
        tool_choice: input.tool_choice, tools: input.tools?.map((t: any) => t.function.name), stream: input.stream,
        messages: input.messages.map((m: any) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((p: any) => p.type === "image_url" ? { type: "image_url", recorded: true } : p) : m.content })) };
      calls.push(record);
      await appendFile(join(root, "provider.jsonl"), JSON.stringify(record) + "\n");
      for (const call of message?.tool_calls ?? []) {
        let args: any;
        try { args = JSON.parse(call.function.arguments); } catch { continue; }
        if (!injected && args.operation === "preview" && typeof args.candidate_id === "string") {
          // Corrupt the saved candidate immediately before real execution. The model
          // first learns about the fault through the browser result, not its own call.
          const file = join(root, "memory/agent-history.presentations/candidates", `${args.candidate_id}.json`);
          const candidate = JSON.parse(await readFile(file, "utf8"));
          candidate.content.content_files[candidate.content.entrypoint] += "<script>throw new Error('RP7_INJECTED_RUNTIME_FAILURE')</script>";
          await writeFile(file, JSON.stringify(candidate));
          injected = true;
        }
      }
      res.writeHead(upstream.status, { "Content-Type": contentType });
      res.end(responseText);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const proxyPort = (proxy.address() as { port: number }).port;
  const book = join(root, "book");
  await mkdir(book, { recursive: true });
  for (const file of ["source.txt", "base.json", "profile_metadata.json"]) await copyFile(join(repo, ".understand-book/quickstart-demo", file), join(book, file));
  const appdata = join(root, "appdata");
  await mkdir(join(appdata, "UnderstandBook"), { recursive: true });
  await mkdir(join(root, "library"), { recursive: true });
  await writeFile(join(appdata, "UnderstandBook/settings.json"), JSON.stringify({ schema: "understand_book.desktop_settings.v1", library_root: join(root, "library") }));
  let url = "";
  const startHost = async () => {
    host = spawn(resolve(process.env.RP7_HOST_BINARY!), desktop ? [book] : ["--reader-only", book], {
      cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(desktop ? { LOCALAPPDATA: appdata, WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19227" } : {}),
        UNDERSTAND_BOOK_ADDR: "127.0.0.1:0", UNDERSTAND_BOOK_WEB_DIST: resolve("dist"),
        UNDERSTAND_BOOK_MEMORY_DIR: join(root, "memory"), UNDERSTAND_BOOK_PRIVATE_DIR: join(root, "private"),
        UNDERSTAND_BOOK_PROVIDER: "native", OPENCODE_API_KEY: "acceptance-local-proxy", OPENCODE_BASE_URL: `http://127.0.0.1:${proxyPort}`, FLUID_LLM_MODEL: config.FLUID_LLM_MODEL },
    });
    host.stdout!.on("data", data => { hostOutput += data; });
    host.stderr!.on("data", data => { hostOutput += data; });
    if (desktop) {
      await expect.poll(async () => { try { return (await fetch("http://127.0.0.1:19227/json/version")).ok; } catch { return false; } }, { timeout: 45_000 }).toBe(true);
      await expect.poll(async () => {
        try { webview = await chromium.connectOverCDP("http://127.0.0.1:19227", { timeout: 5000 }); return true; } catch { return false; }
      }, { timeout: 45_000 }).toBe(true);
      await expect.poll(() => webview!.contexts()[0].pages().length).toBeGreaterThan(0);
      page = webview.contexts()[0].pages()[0];
      await expect.poll(() => page.url(), { timeout: 20_000 }).toMatch(/^http:/);
      url = new URL(page.url()).origin;
    } else {
      await expect.poll(() => hostOutput.match(/listening at (http:\/\/[^\s]+)/)?.[1], { timeout: 30_000 }).toBeTruthy();
      url = hostOutput.match(/listening at (http:\/\/[^\s]+)/)![1];
      page.on("pageerror", error => { hostOutput += `\nReader error: ${error.message}`; });
      page.on("requestfailed", request => { hostOutput += `\nReader request failed: ${request.url()} ${request.failure()?.errorText}`; });
      await page.goto(url);
    }
    await expect(page.locator(".agent-input textarea")).toBeVisible({ timeout: 30_000 });
  };
  const stopHost = async () => {
    await webview?.close(); webview = undefined;
    if (host && host.exitCode === null) {
      const stopped = new Promise<void>(done => host!.once("exit", () => done()));
      host.kill(); await stopped;
      if (desktop) await expect.poll(async () => {
        try { await fetch("http://127.0.0.1:19227/json/version", { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; }
      }, { timeout: 20_000 }).toBe(true);
    }
    hostOutput = "";
  };
  const history = async () => (await page.request.get(`${url}/api/agent/history`)).json();
  const readVersion = async (index: number) => {
    const current = (await history()).current;
    const delivered = current.turns.flatMap((turn: any) => (turn.outcome?.answer_view?.parts ?? [])
      .filter((part: any) => part.kind === "presentation").map((part: any) => ({ turn, part })))[index];
    const reference = { presentation_id: delivered.part.presentation_id, revision: delivered.part.revision };
    const response = await page.request.post(`${url}/api/agent/presentation.read`, { data: { session_id: current.id, turn_id: delivered.turn.turn_id, reference } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const waitFinished = async () => {
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, { timeout: 600_000 });
    await expect(page.locator(".agent-input textarea")).toBeEnabled();
  };
  const ask = async (name: string, message: string, presentation?: ReturnType<Page["locator"]>, expectedPresentations = ({ rich: 1, experiment: 2, "follow-up": 2, revision: 3, argument: 4 } as Record<string, number>)[name]) => {
    if (scenes.some(scene => scene.name === name && scene.delivered === true)) return;
    // Older interrupted runs recorded completion before asserting delivery. Inspect
    // persisted answers before treating those expensive model turns as reusable.
    if (scenes.some(scene => scene.name === name) && name !== "follow-up") {
      const current = (await history()).current;
      const count = current.turns.flatMap((turn: any) => turn.outcome?.answer_view?.parts ?? []).filter((part: any) => part.kind === "presentation").length;
      if (count >= expectedPresentations!) return;
    }
    const start = Date.now(), firstCall = calls.length;
    if (name !== "follow-up") message += " 页面请保持精简，复用宿主共同样式，文字和背景颜色沿用宿主主题变量；必须通过制作工具交付，不要把HTML贴在最终回答里。";
    if (presentation) {
      await presentation.getByRole("textbox", { name: "针对当前现场追问" }).fill(message);
      await presentation.getByRole("button", { name: "发送追问", exact: true }).click();
    } else {
      await page.locator(".agent-input textarea").fill(message);
      await page.getByRole("button", { name: "发送", exact: true }).click();
    }
    await expect.poll(() => calls.length, { timeout: 240_000 }).toBeGreaterThan(firstCall);
    await waitFinished();
    const entry = { name, elapsed_ms: Date.now() - start, samples: calls.length - firstCall,
      total_tokens: calls.slice(firstCall).reduce((n, c) => n + (c.usage?.total_tokens ?? 0), 0) };
    scenes.push(entry); await save("scenes.json", scenes); await save(`${name}-history.json`, await history());
    await page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
    await expect(page.locator(".agent-presentation")).toHaveCount(expectedPresentations!);
    Object.assign(entry, { delivered: true });
    await save("scenes.json", scenes);
  };
  const source = async (presentation: ReturnType<Page["locator"]>) => {
    await presentation.frameLocator("iframe").locator("button[data-source-ref]:visible").first().click();
    await expect(page.getByRole("dialog", { name: "回答来源" })).toBeVisible();
    const opened = page.waitForResponse(r => r.url().endsWith("/agent/source.open"));
    await page.getByRole("button", { name: "在正文中查看", exact: true }).click();
    expect((await (await opened).json()).opened).toBe(true);
  };
  const checkLayout = async (presentation: ReturnType<Page["locator"]>, name: string) => {
    await presentation.getByRole("button", { name: "展开", exact: true }).click();
    const frame = presentation.frameLocator("iframe");
    await expect(frame.locator("body")).toBeVisible();
    await page.screenshot({ path: join(root, `${name}-expanded.png`) });
    await presentation.getByRole("button", { name: "收起", exact: true }).click();
    // Resize the actual content viewport, including the real WebView2 window's DOM.
    const original = await presentation.getAttribute("style");
    await presentation.evaluate(node => { (node as HTMLElement).style.width = "340px"; (node as HTMLElement).style.maxWidth = "100%"; });
    await page.screenshot({ path: join(root, `${name}-narrow.png`) });
    expect(await frame.locator("body").evaluate(node => node.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await presentation.evaluate((node, style) => style == null ? node.removeAttribute("style") : node.setAttribute("style", style), original);
    const rootStyle = await page.locator("html").getAttribute("style");
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ "--canvas": "#202020", "--ink": "#f2ece3", "--surface": "#303030", "--line": "#555555", "--accent": "#f0a080" })) document.documentElement.style.setProperty(key, value);
    });
    await expect.poll(() => frame.locator("html").evaluate(node => getComputedStyle(node).getPropertyValue("--canvas").trim())).toBe("#202020");
    await page.screenshot({ path: join(root, `${name}-theme.png`) });
    await page.locator("html").evaluate((node, style) => style == null ? node.removeAttribute("style") : node.setAttribute("style", style), rootStyle);
  };
  try {
    await startHost();
    await ask("rich", "请现场制作一个简洁中文富排版回答，只对比本书这两段原文的职责：‘构建时，系统整理原文位置，抽取概念、篇章关系与公式语义，并形成跨章节线索和全书结构。’和‘阅读时，系统根据问题寻找候选位置，按需读取原文，再给出带来源的回答。’请定位并读取这两段，绑定这两处来源即可。两张并排卡片各说明一个阶段，顶部突出一句要点，底部有一个可展开的补充说明。内容只围绕上述两段，自行设计完整页面，实际预览和操作，发现脚本错误就修正后交付。");
    const rich = page.locator(".agent-presentation").nth(0);
    await expect(rich.locator("iframe")).toBeVisible();
    await source(rich); await checkLayout(rich, "rich");
    expect(injected).toBe(true); expect(sawFailure).toBe(true); expect(imageCount).toBeGreaterThan(0);
    await ask("experiment", "请另做一个中文参数实验页面，依据本书证据召回公式及三处证据找到两处的例子，提供原文来源。起初所需三处、找到两处；按钮‘加入无关材料’增加无关材料但不改变召回率，按钮‘补齐证据’使其为1；用可访问名称‘找到的证据数’的滑块调整0到3。将当前分数单独显示在 id=recall 的元素中，格式2/3或1/3或3/3，配联动图形。页面参数命名count，明确假设无关材料不算所需证据，说明召回不等于忠实使用。初始值读取宿主 initialState；注册参数读取和恢复，恢复参数位于 scene.values.page。实际预览这些操作再交付。设计和代码由你完成。");
    const experiment = page.locator(".agent-presentation").nth(1);
    const frame = experiment.frameLocator("iframe");
    if (process.env.RP7_RESUME === "1") {
      await frame.getByRole("slider", { name: "找到的证据数", exact: true }).focus();
      await page.keyboard.press("Home"); await expect(frame.locator("#recall")).toBeVisible();
      await page.keyboard.press("ArrowRight"); await expect(frame.locator("#recall")).toBeVisible();
      await page.keyboard.press("ArrowRight");
    }
    await expect(frame.locator("#recall")).toHaveText("2/3");
    await frame.getByRole("button", { name: "加入无关材料", exact: true }).click();
    await expect(frame.locator("#recall")).toHaveText("2/3");
    await frame.getByRole("button", { name: "补齐证据", exact: true }).click();
    await expect(frame.locator("#recall")).toHaveText("3/3");
    await frame.getByRole("slider", { name: "找到的证据数", exact: true }).focus();
    await page.keyboard.press("Home"); await expect(frame.locator("#recall")).toBeVisible(); await page.keyboard.press("ArrowRight");
    await expect(frame.locator("#recall")).toHaveText("1/3");
    await expect(experiment.getByText("现场已保存", { exact: true })).toBeVisible();
    const originalVersion = await readVersion(1);
    const beforeFollowUpCount = await page.locator(".agent-presentation").count();
    await ask("follow-up", "解释现在的结果，指出找到几处、总需几处及为何不是答案正确率。只解释，不制作新页面。", experiment);
    const followUpHistory = JSON.parse(await readFile(join(root, "follow-up-history.json"), "utf8"));
    expect(JSON.stringify(followUpHistory.current.turns.at(-1).outcome.answer_view)).toMatch(/1\s*\/\s*3|三分之一|33[.．]3/);
    await expect(page.locator(".agent-presentation")).toHaveCount(beforeFollowUpCount);
    const followUp = calls.flatMap(c => c.messages.filter((m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("解释现在的结果") && m.content.includes("Presentation follow-up")));
    expect(followUp.length).toBeGreaterThan(0);
    expect(JSON.stringify(followUp)).toContain('\\"count\\":1');
    await ask("revision", "给当前这个版本增加一个标题为‘新增反例’的例子：三处都找到了但答案曲解了原文。保留已有实验、控件名字、recall元素和状态合同；沿用当前count参数。先通过tool.search发现制作工具，再读取确切旧版代码。保留原有来源：write的source_ref_ids逐字使用read返回的列表，HTML中的data-source-ref保持原值；不要重新调用source.present。新增反例明确标为自拟，不引入新书源主张，无需重新检索原文。修改为同一内容的新版本，实际预览并交付。", experiment);
    const revised = page.locator(".agent-presentation").nth(2);
    await expect(revised).toContainText("版本 2");
    await expect(revised.frameLocator("iframe").locator("#recall")).toHaveText("1/3");
    await expect(revised.frameLocator("iframe").getByRole("heading", { name: /^新增反例/ })).toBeVisible();
    await expect(frame.getByRole("heading", { name: /^新增反例/ })).toHaveCount(0);
    await expect(frame.locator("#recall")).toHaveText("1/3");
    const revisedVersion = await readVersion(2);
    expect(revisedVersion.reference.presentation_id).toBe(originalVersion.reference.presentation_id);
    expect((await readVersion(1)).content_files).toEqual(originalVersion.content_files);
    await source(revised);
    await ask("layout-revision", "仅修改布局，保留全部文字和已绑定来源，不新增书源主张，不需要重新检索原文。请将当前版本完善为340px宽内容区也能完整使用的页面。读取当前版本，检查并修正固定最小宽度、公式横线、网格子项和来源行；保持计算、控件名称、recall元素、状态合同和新增反例。使用可收缩宽度和文字换行，初始参数继续读取宿主initialState，恢复参数从scene.values.page读取。使用同一候选的width=340预览检查窄屏、默认宽度检查普通布局，成功后直接交付同一对象的新修订。", revised, 4);
    let fittedIndex = 3;
    let fitted = page.locator(".agent-presentation").nth(fittedIndex);
    await expect(fitted).toContainText("版本 3");
    await expect(fitted.frameLocator("iframe").locator("#recall")).toHaveText("1/3");
    expect((await readVersion(3)).reference.presentation_id).toBe(originalVersion.reference.presentation_id);
    await source(fitted); await checkLayout(fitted, "revision");
    let argumentIndex = 4;
    await ask("argument", "请另做一个中文论证与证据展开页面，只围绕这一个段落：‘知识图谱记录概念之间的联系。它负责帮助寻找值得阅读的内容；真正支撑回答的是取回的原文。关系边本身不是事实证据。’先发现制作工具，定位并读取该段，只绑定该段这一处来源，不扩展检索其他段落。呈现主张、这段依据、推理和明确标成自拟的反例，以及可点击的原文来源。提供名为‘展开依据’的按钮，点击后显示原文依据与来源。记录并恢复当前展开步骤；实际操作、检查截图后交付。", undefined, argumentIndex + 1);
    let argument = page.locator(".agent-presentation").nth(argumentIndex);
    await expect(argument.frameLocator("iframe").locator("body")).toBeVisible();
    const argumentToggle = argument.frameLocator("iframe").getByRole("button", { name: "展开依据", exact: true });
    if (await argumentToggle.count() && await argumentToggle.getAttribute("aria-expanded") !== "true") await argumentToggle.click();
    // A real generated page may render correctly while violating the save contract.
    // Correct it through the same user-facing authoring route; preserve the failed version.
    const needsStateRepair = scenes.some(scene => scene.name === "argument-state-revision") ||
      !(await argument.getByText(/^(现场已保存|已恢复上次保存的现场)$/).waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false));
    if (needsStateRepair) {
      await ask("argument-state-revision", "请修复刚交付的‘主张与依据：关系边本身不是事实证据’论证页面；该版本展开后没有成功保存现场，无法从页内发送追问。请只修复状态合同：registerStateReader返回的visible_step必须是字符串或null，不能是数字；expanded数值仍放values中。恢复时从scene.values.page.expanded读取。先发现制作工具，读取当前确切版本，保留已有内容、按钮名称、全部来源列表和data-source-ref，不重新检索或登记来源。以based_on创建同一对象的新版本，实际展开预览后交付。", undefined, 6);
      argumentIndex = 5;
      argument = page.locator(".agent-presentation").nth(argumentIndex);
      expect((await readVersion(argumentIndex)).reference.presentation_id).toBe((await readVersion(4)).reference.presentation_id);
      await expect(argument.frameLocator("iframe").locator("body")).toBeVisible();
      const toggle = argument.frameLocator("iframe").getByRole("button", { name: "展开依据", exact: true });
      if (await toggle.count() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    }
    await expect(argument.getByText(/^(现场已保存|已恢复上次保存的现场)$/)).toBeVisible();
    await source(argument); await checkLayout(argument, "argument");
    const expandedArgument = await argument.frameLocator("iframe").locator("body").innerText();
    // Exercise custom button state on the corrected current version before reopening.
    await fitted.frameLocator("iframe").getByRole("button", { name: "加入无关材料", exact: true }).click();
    await expect(fitted.getByText("现场已保存", { exact: true })).toBeVisible();
    let savedFitted = await readVersion(fittedIndex);
    if (scenes.some(scene => scene.name === "experiment-state-revision") ||
        savedFitted.restored_state?.values?.page?.irrelevant === undefined) {
      fittedIndex = argumentIndex + 1;
      await ask("experiment-state-revision", "该实验重开后无关材料计数丢失。请只补齐这项状态：将irrelevant与count都放进registerStateReader返回的values；从scene.values.page恢复两者并重新渲染；initial_state和state_contract增加irrelevant的既有整数范围定义，count合同原样保留。visible_step保持null。保留全部文字、来源、按钮、窄屏布局和新增反例；不重新检索或登记来源。读取本确切版本并以based_on交付同一对象的新版本，实际预览加入无关材料后再交付。", fitted, fittedIndex + 1);
      fitted = page.locator(".agent-presentation").nth(fittedIndex);
      await expect(fitted.frameLocator("iframe").locator("#recall")).toHaveText("1/3");
      await fitted.frameLocator("iframe").getByRole("button", { name: "加入无关材料", exact: true }).click();
      await expect(fitted.getByText("现场已保存", { exact: true })).toBeVisible();
      await source(fitted); await checkLayout(fitted, "revision");
      savedFitted = await readVersion(fittedIndex);
      expect(savedFitted.reference.presentation_id).toBe(originalVersion.reference.presentation_id);
      expect(savedFitted.restored_state.values.page.irrelevant).toBeGreaterThan(0);
    }
    const fittedText = await fitted.frameLocator("iframe").locator("body").innerText();
    const savedExperiment = await readVersion(1), savedArgument = await readVersion(argumentIndex);
    const before = calls.length;
    await writeFile(join(root, "host-before-reopen.log"), hostOutput);
    await stopHost(); await startHost();
    const restored = page.locator(".agent-presentation").nth(1);
    await expect(restored.frameLocator("iframe").locator("#recall")).toHaveText("1/3");
    await expect(page.locator(".agent-presentation").nth(fittedIndex).frameLocator("iframe").locator("body")).toHaveText(fittedText, { useInnerText: true });
    expect((await readVersion(fittedIndex)).restored_state).toEqual(savedFitted.restored_state);
    expect((await readVersion(fittedIndex)).restored_state_revision).toEqual(savedFitted.restored_state_revision);
    await expect(restored.getByText("已恢复上次保存的现场")).toBeVisible();
    await expect(page.locator(".agent-presentation").nth(2)).toContainText("版本 2");
    await expect(page.locator(".agent-presentation").nth(argumentIndex).frameLocator("iframe").locator("body")).toHaveText(expandedArgument, { useInnerText: true });
    await source(restored);
    expect((await readVersion(1)).restored_state_revision).toEqual(savedExperiment.restored_state_revision);
    expect((await readVersion(argumentIndex)).restored_state).toEqual(savedArgument.restored_state);
    expect(calls.length).toBe(before);
    await page.screenshot({ path: join(root, "reopened.png"), fullPage: true });
    await save("final-history.json", await history());
    await save("summary.json", { passed: true, platform: process.platform, desktop, model: config.FLUID_LLM_MODEL, scenes, injected, sawFailure, imageCount,
      total_tokens: calls.reduce((n, c) => n + (c.usage?.total_tokens ?? 0), 0),
      reopened: { model_samples_before: before, model_samples_after: calls.length, experiment: savedFitted.reference, argument: savedArgument.reference, state_unchanged: true, visible_content_unchanged: true } });
  } finally {
    await writeFile(join(root, "host.log"), hostOutput);
    await save("run-state.json", { scenes, injected, sawFailure, imageCount, samples: calls.length });
    await stopHost(); await readerBrowser?.close(); proxy.closeAllConnections(); await new Promise<void>(done => proxy.close(() => done()));
  }
});
