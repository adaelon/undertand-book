import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("semantic observation preserves the focused control for repeated keyboard input", async ({ page }) => {
  const bridge = readFileSync(new URL("../src/presentation-bridge.js", import.meta.url), "utf8");
  await page.goto("about:blank");
  await page.evaluate(() => window.addEventListener("message", event => {
    if (event.data.kind === "observe") requestAnimationFrame(() => requestAnimationFrame(() =>
      (event.source as Window).postMessage({ channel: "agent-presentation", kind: "accepted", revision: event.data.revision }, "*")));
  }));
  await page.evaluate(bridge => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = `<style>html[data-presentation-pending] body{visibility:hidden}</style>
      <script>(${bridge})({sources:[],initialState:{}})</script>
      <input id="count" type="range" min="0" max="3" value="2"><output id="result">2/3</output>
      <script>document.querySelector('#count').oninput=e=>document.querySelector('#result').textContent=e.target.value+'/3';</script>`;
    document.body.appendChild(frame);
  }, bridge);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#result")).toBeVisible();
  await frame.locator("#count").press("Home");
  await expect(frame.locator("#result")).toHaveText("0/3");
  await expect(frame.locator("#result")).toBeVisible();
  await expect(frame.locator("#count")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#result")).toHaveText("1/3");
});

test("restore runs after page DOMContentLoaded initialization without saving again", async ({ page }) => {
  const bridge = readFileSync(new URL("../src/presentation-bridge.js", import.meta.url), "utf8");
  await page.goto("about:blank");
  await page.evaluate(() => {
    (window as any).events = [];
    window.addEventListener("message", event => {
      (window as any).events.push(event.data);
      if (event.data.kind === "observe") (event.source as Window).postMessage({ channel: "agent-presentation", kind: "accepted", revision: event.data.revision }, "*");
    });
  });
  await page.evaluate(bridge => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = `<script>(${bridge})({sources:[],initialState:{count:2},restoredState:{values:{controls:[{key:'count',type:'range',value:'1'}],page:{count:1}},visible_step:'explain'}})</script>
      <input id="count" type="range" min="0" max="3" value="2"><output id="result"></output>
      <script>document.addEventListener('DOMContentLoaded',()=>{
        const input=document.querySelector('#count'),result=document.querySelector('#result');
        input.value='2'; const render=()=>result.textContent=input.value+'/3';
        input.addEventListener('input',render); render();
        window.presentation.registerStateReader(()=>({values:{count:Number(input.value)}}));
        window.presentation.registerStateRestorer(scene=>{input.value=String(scene.values.page.count);render();});
      });</script>`;
    document.body.appendChild(frame);
  }, bridge);
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("1/3");
  await page.locator("iframe").evaluate((node: HTMLIFrameElement) => node.contentWindow!.postMessage({ channel: "agent-presentation", kind: "snapshot", request_id: 2 }, "*"));
  await expect.poll(() => page.evaluate(() => (window as any).events.filter((e: any) => e.kind === "state").length)).toBe(1);
  const events = await page.evaluate(() => (window as any).events);
  expect(events.some((e: any) => e.kind === "restore-partial")).toBe(false);
  expect(events.filter((e: any) => e.kind === "state")[0]).toMatchObject({ request_id: 2, state: { values: { page: { count: 1 } } } });
});

test("snapshot reads visible results, custom step and live controls in one browser task", async ({ page }) => {
  const bridge = readFileSync(new URL("../src/presentation-bridge.js", import.meta.url), "utf8");
  await page.goto("about:blank");
  await page.evaluate(() => {
    (window as any).scenes = [];
    window.addEventListener("message", event => {
      if (event.data.kind === "observe") (event.source as Window).postMessage({ channel: "agent-presentation", kind: "accepted", revision: event.data.revision }, "*");
      if (event.data.kind === "state") (window as any).scenes.push(event.data);
    });
  });
  await page.evaluate(bridge => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = `<script>(${bridge})({sources:[],initialState:{}})</script>
      <p hidden>Old result: 99/100</p><p style="display:none">Old step</p>
      <input id="count" type="range" min="0" max="3" value="2"><input id="selected" type="checkbox" checked>
      <output id="result">2/3</output><svg aria-label="Two thirds filled"></svg>
      <script>window.presentation.registerStateReader(()=>({values:{count:Number(document.querySelector('#count').value)},visible_step:'compare'}));</script>`;
    document.body.appendChild(frame);
  }, bridge);
  await expect(page.frameLocator("iframe").locator("#result")).toBeVisible();
  await page.locator("iframe").evaluate((node: HTMLIFrameElement) => node.contentWindow!.postMessage({ channel: "agent-presentation", kind: "snapshot", request_id: 1 }, "*"));
  await expect.poll(() => page.evaluate(() => (window as any).scenes.length)).toBe(1);
  const scene = await page.evaluate(() => (window as any).scenes[0]);
  expect(scene.request_id).toBe(1);
  expect(scene.state.values.page).toEqual({ count: 2 });
  expect(scene.state.values.controls[1].checked).toBe(true);
  expect(scene.state.visible_step).toBe("compare");
  expect(scene.state.observed_result).toContain("2/3");
  expect(scene.state.observed_result).toContain("Two thirds filled");
  expect(scene.state.observed_result).not.toContain("Old");
});

test("editing focus reports only a boolean bound to the host content generation", async ({ page }) => {
  const bridge = readFileSync(new URL("../src/presentation-bridge.js", import.meta.url), "utf8");
  await page.goto("about:blank");
  await page.setContent('<button id="outside">Outside</button>');
  await page.evaluate(() => {
    (window as any).focusEvents = [];
    window.addEventListener("message", event => {
      if (event.data.kind === "observe") {
        (event.source as Window).postMessage({ channel: "agent-presentation", kind: "theme", generation: 7, values: {} }, "*");
        (event.source as Window).postMessage({ channel: "agent-presentation", kind: "accepted", revision: event.data.revision }, "*");
      }
      if (event.data.kind === "editing-focus") (window as any).focusEvents.push(event.data);
    });
  });
  await page.evaluate(bridge => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = `<style>html[data-presentation-pending] body{visibility:hidden}</style>
      <script>(${bridge})({sources:[],initialState:{}})</script><input id="editor" value="draft"><p>Visible result</p>`;
    document.body.appendChild(frame);
  }, bridge);

  const editor = page.frameLocator("iframe").locator("#editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await expect.poll(() => page.evaluate(() => (window as any).focusEvents.at(-1))).toMatchObject({
    kind: "editing-focus",
    generation: 7,
    editing: true,
  });
  await page.locator("#outside").click();
  await expect.poll(() => page.evaluate(() => (window as any).focusEvents.at(-1))).toMatchObject({
    kind: "editing-focus",
    generation: 7,
    editing: false,
  });
  expect(await page.evaluate(() => Object.keys((window as any).focusEvents[0]).sort())).toEqual([
    "channel", "editing", "generation", "kind",
  ]);
});
