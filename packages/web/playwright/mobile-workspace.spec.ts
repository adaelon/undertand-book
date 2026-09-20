import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/mobile-workspace-visual.html");
  await expect(page.locator(".workspace-shell")).toBeVisible();
});

test("keeps one core tree through repeated region and orientation-sized projections", async ({ page }) => {
  const viewport = page.viewportSize()!;
  const shell = page.locator(".workspace-shell");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.locator(".reader-pane").evaluate((node) => { node.setAttribute("data-instance", "reader-stable"); });
  if (viewport.width < 1024) {
    const topbar = page.locator(".topbar");
    const mobileNavigation = page.locator(".workspace-mobile-nav");
    await expect(topbar).toBeHidden();
    await expect(mobileNavigation).toBeVisible();
    expect((await shell.boundingBox())?.y).toBe(0);
    const mobileNavigationBox = await mobileNavigation.boundingBox();
    expect(mobileNavigationBox).not.toBeNull();
    expect(mobileNavigationBox!.y + mobileNavigationBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.getByRole("button", { name: "菜单" }).click();
    await expect(topbar).toBeVisible();
    await topbar.getByRole("button", { name: "目录" }).click();
    await expect(topbar).toBeHidden();
    await expect(page.locator("#reader-outline")).toBeVisible();
    const outlineBackdrop = page.getByRole("button", { name: "关闭目录" });
    const outlineBackdropBox = await outlineBackdrop.boundingBox();
    expect(outlineBackdropBox).not.toBeNull();
    await page.mouse.click(
      outlineBackdropBox!.x + outlineBackdropBox!.width - 4,
      outlineBackdropBox!.y + Math.min(24, outlineBackdropBox!.height / 2),
    );
    await expect(page.locator("#reader-outline")).toBeHidden();
    await page.getByRole("button", { name: "菜单" }).click();
    await topbar.getByRole("button", { name: "新对话" }).click();
    await expect(topbar).toBeHidden();
    await expect(page.locator(".fixture-new-chat-count")).toHaveAttribute("data-count", "1");
    for (let index = 0; index < 10; index += 1) {
      await page.getByRole("button", { name: "问答" }).click();
      await page.getByRole("button", { name: "阅读" }).click();
    }
    await expect(page.locator('.reader-pane[data-instance="reader-stable"]')).toHaveCount(1);
    await page.getByRole("button", { name: "问答" }).click();
    await expect(page.locator(".agent-input textarea")).toHaveValue("未发送草稿");
    await page.getByRole("button", { name: "阅读" }).click();
  } else {
    await expect(shell).toHaveAttribute("data-mode", "wide");
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "菜单" })).toHaveCount(0);
  }

  if (viewport.width >= 732 && viewport.width < 1024) {
    await page.getByRole("button", { name: "对照" }).click();
    await expect(shell).toHaveAttribute("data-mode", "compare");
  }
});

test("freezes a document selection independently of mouseup and preserves source text", async ({ page }) => {
  await page.evaluate(() => {
    const text = document.querySelector<HTMLElement>('[data-lid="1.1"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.locator(".fixture-selection-action")).toContainText("移动阅读");
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.locator(".fixture-selection-action")).toContainText("移动阅读");

  const source = page.locator(".asset-source.asset-code");
  const original = await source.textContent();
  await page.getByRole("button", { name: "换行" }).click();
  await expect(source).toHaveClass(/soft-wrap/);
  expect(await source.textContent()).toBe(original);
  await page.getByRole("button", { name: "展开" }).click();
  await expect(page.locator(".asset-block")).toHaveClass(/asset-expanded/);
});

test("does not submit while an IME composition is active", async ({ page }) => {
  const input = page.locator(".agent-input textarea");
  if (page.viewportSize()!.width < 1024) await page.getByRole("button", { name: "问答" }).click();
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, isComposing: true, bubbles: true,
    }));
  });
  await expect(page.locator(".fixture-send-count")).toHaveAttribute("data-count", "0");
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, isComposing: false, bubbles: true,
    }));
  });
  await expect(page.locator(".fixture-send-count")).toHaveAttribute("data-count", "1");
});
