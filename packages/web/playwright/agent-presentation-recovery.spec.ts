import { expect, test } from "@playwright/test";

test("reopen restores saved controls and custom step without replaying actions, then edits the exact scene", async ({ page }, info) => {
  await page.request.post("http://127.0.0.1:4175/reset-scene");
  let saves = 0, sourceActions = 0;
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.endsWith("/presentation.state.save")) saves++;
    if (url.includes("/agent/source")) sourceActions++;
    const response = await route.fetch({ url: url.replace(/^.*\/api/, "http://127.0.0.1:4175") });
    await route.fulfill({ response });
  });
  await page.goto("/agent-presentation-visual.html");
  const frame = page.frameLocator(".agent-presentation iframe");
  await expect(frame.locator("#result")).toBeVisible();
  await frame.locator("#evidence-count").evaluate((node: HTMLInputElement) => {
    node.value = "1";
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByText("现场已保存", { exact: true })).toBeVisible();
  await frame.locator("#next-step").click();
  await expect.poll(() => saves).toBe(2);
  // Read from disk after the last save completed, then reconstruct the Reader state.
  await expect.poll(async () => {
    const fixture = await page.request.get("http://127.0.0.1:4175/fixture").then(r => r.json());
    return page.request.post("http://127.0.0.1:4175/agent/presentation.read", { data: fixture }).then(r => r.json()).then(v => v.restored_state?.visible_step);
  }).toBe("explain");
  const before = await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json());
  await page.request.post("http://127.0.0.1:4175/reopen");
  await page.reload();
  await expect(frame.locator("#result")).toBeVisible();
  await expect(frame.locator("#result")).toHaveText("1/3");
  await expect(frame.locator("#evidence-count")).toHaveValue("1");
  await expect(frame.locator("#step")).toHaveAttribute("data-presentation-step", "explain");
  await expect(page.getByText("已恢复上次保存的现场")).toBeVisible();
  expect(saves).toBe(2);
  expect(sourceActions).toBe(0);
  expect(await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json())).toHaveLength(before.length);
  await page.getByRole("textbox", { name: "针对当前现场追问" }).fill("给这个版本增加一个例子");
  await page.getByRole("button", { name: "发送追问", exact: true }).click();
  await expect(page.getByTestId("follow-up-status")).toHaveText("追问已完成");
  const requests = await page.request.get("http://127.0.0.1:4175/requests").then(r => r.json());
  const user = requests.at(-1).filter((m: any) => m.role === "User").at(-1).content;
  expect(user).toContain('"count":1');
  expect(user).toContain('"visible_step":"explain"');
  expect(user).toContain("给这个版本增加一个例子");
  await page.screenshot({ path: info.outputPath("reopened-scene.png") });
});
