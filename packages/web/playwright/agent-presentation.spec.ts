import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:4175/reset-scene");
  // Real Rust acceptance host owns persistence, semantics and source navigation.
  await page.route("**/api/**", async route => {
    const url = route.request().url().replace(/^.*\/api/, "http://127.0.0.1:4175");
    const response = await route.fetch({ url });
    await route.fulfill({ response });
  });
});

test("rich answer uses bound static/dynamic sources, one frame, responsive layout and theme", async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/agent-presentation-visual.html");
  const frame = page.frameLocator(".agent-presentation iframe");
  await expect(frame.locator("#result")).toBeVisible();
  await expect(frame.locator("#result")).toHaveText("2/3");
  await expect(frame.locator("body")).toHaveAttribute("data-isolated", "yes");
  expect(await page.locator("body").getAttribute("data-presentation-escaped")).toBeNull();
  const source = frame.locator("[data-source-ref]").first();
  await expect(source).not.toHaveText("页面自定标签");
  await source.click();
  await expect(page.getByRole("dialog", { name: "回答来源" })).toBeVisible();
  await page.getByRole("button", { name: "在正文中查看" }).click();
  await expect(page.getByTestId("reader-status")).toHaveText("已在正文中打开来源");
  await frame.locator("#irrelevant").click();
  await expect(frame.locator("#result")).toBeVisible();
  await expect(frame.locator("#result")).toHaveText("2/3");
  await frame.locator("#complete").click();
  await expect(frame.locator("#result")).toBeVisible();
  await expect(frame.locator("#result")).toHaveText("1");
  await frame.locator("#dynamic [data-source-ref]").click();
  await expect(page.getByRole("dialog", { name: "回答来源" })).toBeVisible();
  await page.getByRole("button", { name: "在正文中查看" }).click();
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("1");
  await expect(page.locator(".agent-presentation iframe")).toHaveCount(1);
  const expanded = await page.locator(".agent-presentation").boundingBox();
  expect(expanded?.x).toBe(20);
  expect(expanded?.width).toBe(1060);
  expect(expanded?.height).toBe(810);
  await frame.locator("#dynamic [data-source-ref]").click();
  await expect(page.getByRole("dialog", { name: "回答来源" })).toBeVisible();
  await page.getByRole("button", { name: "在正文中查看" }).click();
  await page.screenshot({ path: info.outputPath("expanded.png") });
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("1");
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await frame.locator("body").evaluate(node => node.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "展开", exact: true }).click();
  const narrow = await page.locator(".agent-presentation").boundingBox();
  expect(narrow?.width).toBe(374);
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(frame.locator("#result")).toHaveText("1");
  await page.evaluate(() => {
    for (const [name, value] of Object.entries({ "--canvas": "#202020", "--ink": "#f2ece3", "--surface": "#303030", "--line": "#555555", "--accent": "#f0a080" })) {
      document.documentElement.style.setProperty(name, value);
    }
  });
  await expect.poll(() => frame.locator("body").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(32, 32, 32)");
  await page.screenshot({ path: info.outputPath("narrow-theme.png") });
  await page.getByText("文字说明与来源", { exact: true }).click();
  await expect(page.locator(".readable-text")).toContainText("需要三处证据");
});

for (const [button, notice] of [["invalid", "文字或来源无法显示"], ["locator", "文字或来源无法显示"], ["crash", "运行出错"]]) {
  test(`dynamic ${button} is not published`, async ({ page }) => {
    await page.goto("/agent-presentation-visual.html");
    const frame = page.frameLocator(".agent-presentation iframe");
    await expect(frame.locator("#result")).toBeVisible();
    await frame.locator("summary").click();
    await frame.locator(`#${button}`).click();
    await expect(page.getByRole("alert")).toContainText(notice);
    await expect(page.locator(".agent-presentation iframe")).toHaveCount(0);
    await expect(page.locator(".agent-presentation")).not.toContainText("内部位置 1.1");
  });
}
