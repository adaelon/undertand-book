import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:4175/reset-scene");
  await page.route("**/api/**", async route => {
    const response = await route.fetch({ url: route.request().url().replace(/^.*\/api/, "http://127.0.0.1:4175") });
    await route.fulfill({ response });
  });
});

test("drag stays local, steps save, follow-up sends one exact saved scene", async ({ page }, info) => {
  const saves: any[] = [];
  page.on("response", async response => {
    if (response.url().endsWith("/presentation.state.save") && response.ok()) saves.push(await response.json());
  });
  await page.goto("/agent-presentation-visual.html");
  const frame = page.frameLocator(".agent-presentation iframe");
  await expect(frame.locator("#result")).toBeVisible();
  const before = await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json());
  await frame.locator("#evidence-count").evaluate((node: HTMLInputElement) => {
    for (const value of ["0", "1", "2", "3", "1"]) { node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  await expect(frame.locator("#result")).toHaveText("1/3");
  await expect(frame.locator("#result")).toBeVisible();
  expect(saves).toHaveLength(0);
  expect(await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json())).toHaveLength(before.length);
  await frame.locator("#evidence-count").dispatchEvent("change");
  await expect(page.getByText("现场已保存", { exact: true })).toBeVisible();
  await frame.locator("#next-step").click();
  await expect.poll(() => saves.length).toBe(2);
  // Delay the explicit save, then change the running page: the question must keep its captured scene.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted!: () => void;
  const entered = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route("**/api/agent/presentation.state.save", async route => {
    intercepted(); await gate;
    const response = await route.fetch({ url: "http://127.0.0.1:4175/agent/presentation.state.save" });
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: "解释现在的结果", exact: true }).click();
  await entered;
  await frame.locator("#evidence-count").evaluate((node: HTMLInputElement) => {
    node.value = "3"; node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  release();
  await expect(page.getByTestId("follow-up-status")).toHaveText("追问已完成");
  const requests = await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json());
  expect(requests).toHaveLength(before.length + 1);
  const user = requests.at(-1).filter((message: any) => message.role === "User").at(-1).content;
  expect(user).toContain('"count":1');
  expect(user).toContain('"visible_step":"explain"');
  expect(user).toContain("1/3");
  expect(user).not.toContain("Hidden previous result");
  expect(user).toContain(saves.at(-1).saved_state_ref);
  expect(user).not.toContain("<script>");
  await page.screenshot({ path: info.outputPath("follow-up.png") });
});

test("save failure shows the actual error and does not send a model request; retry succeeds", async ({ page }) => {
  await page.goto("/agent-presentation-visual.html");
  await expect(page.frameLocator("iframe").locator("#result")).toBeVisible();
  const before = await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json());
  await page.request.post("http://127.0.0.1:4175/fail-next-state");
  await page.getByRole("textbox", { name: "针对当前现场追问" }).fill("为什么是这个结果？");
  await page.getByRole("button", { name: "发送追问", exact: true }).click();
  await expect(page.getByText(/追问未发送：.*现场写入失败/)).toBeVisible();
  expect(await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json())).toHaveLength(before.length);
  await expect(page.getByRole("textbox", { name: "针对当前现场追问" })).toHaveValue("为什么是这个结果？");
  await page.getByRole("button", { name: "发送追问", exact: true }).click();
  await expect(page.getByTestId("follow-up-status")).toHaveText("追问已完成");
});
