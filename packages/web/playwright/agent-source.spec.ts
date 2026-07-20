import { expect, test, type Page } from "@playwright/test";

const contextBefore = "在心肌组织中，选择性剪接受到多层调控。研究团队在严格控制批次效应后比较了多个样本，并以相同分析流程验证候选事件。";
const evidence = "剪接调控显著改变了疾病相关转录本的构成。";
const contextAfter = "这些变化随后在独立队列中得到复核，同时结合功能实验评估其与疾病通路的关系。连续上下文保留了实验条件、比较对象和结论边界。";

async function installSourceRoutes(page: Page) {
  const calls: string[] = [];
  await page.route("**/api/agent/source.resolve", async (route) => {
    calls.push("resolve");
    const body = route.request().postDataJSON() as { source_ref_id: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source_ref_id: body.source_ref_id,
        label: body.source_ref_id === "source_ref_methods"
          ? "正文 · Materials and Methods"
          : "正文 · Results",
        highlighted_quote: evidence,
        context_before: contextBefore,
        context_after: contextAfter,
        stale: false,
        can_open_in_reader: true,
      }),
    });
  });
  await page.route("**/api/agent/source.open", async (route) => {
    calls.push("open");
    const body = route.request().postDataJSON() as { source_ref_id: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source_ref_id: body.source_ref_id, opened: true }),
    });
  });
  return calls;
}

async function expectInsideViewport(page: Page, selector: string, width: number, height: number) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

test("desktop source stays inline and opens an anchored popup before reader navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = await installSourceRoutes(page);
  await page.goto("/agent-source-visual.html");

  const sourceButtons = page.locator(".agent-source-button");
  await expect(sourceButtons).toHaveCount(2);
  await expect(sourceButtons.nth(0)).toContainText("正文 · Materials and Methods");
  await expect(sourceButtons.nth(1)).toContainText("2 个来源");
  const paragraphBox = await page.locator(".answer-markdown.before-source p").first().boundingBox();
  const buttonBox = await sourceButtons.first().boundingBox();
  expect(paragraphBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.y).toBeLessThan(paragraphBox!.y + paragraphBox!.height);

  await sourceButtons.first().click();
  const popup = page.getByRole("dialog", { name: "回答来源" });
  await expect(popup).toBeVisible();
  await expect(popup.locator("mark")).toHaveText(evidence);
  await expect(page.getByTestId("reader-status")).toHaveText("保持当前阅读位置");
  expect(calls).toEqual(["resolve"]);
  await expectInsideViewport(page, ".agent-source-popup", 1440, 900);

  const overflow = await popup.evaluate((node) => ({
    horizontal: node.scrollWidth > node.clientWidth + 1,
    actions: Array.from(node.querySelectorAll("button")).some((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left < 0 || rect.right > window.innerWidth;
    }),
  }));
  expect(overflow).toEqual({ horizontal: false, actions: false });
  await page.screenshot({ path: "../../docs/screenshots/agent-source-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "在正文中查看" }).click();
  await expect(page.getByTestId("reader-status")).toHaveText("已在正文中打开来源");
  expect(calls).toEqual(["resolve", "open"]);
});

test("mobile source popup is a viewport-bound bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await installSourceRoutes(page);
  await page.goto("/agent-source-visual.html");
  await page.locator(".agent-source-button").first().click();

  const popup = page.getByRole("dialog", { name: "回答来源" });
  await expect(popup.locator("mark")).toHaveText(evidence);
  const box = await popup.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.y + box!.height)).toBe(844);
  await expectInsideViewport(page, ".agent-source-popup", 390, 844);
  expect(calls).toEqual(["resolve"]);

  const textOverflow = await popup.locator(".source-popup-head strong, .source-context, .source-open-reader").evaluateAll(
    (nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth + 1),
  );
  expect(textOverflow).toBe(false);
  await page.screenshot({ path: "../../docs/screenshots/agent-source-mobile.png", fullPage: true });
});
