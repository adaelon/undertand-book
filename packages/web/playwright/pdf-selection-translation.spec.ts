import { expect, test } from "@playwright/test";

test("desktop translation stays anchored, flips in view, and does not resize the selection toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pdf-selection-translation-visual.html");

  const toolbar = page.getByRole("toolbar", { name: "PDF 选区操作" });
  const before = await toolbar.boundingBox();
  await page.getByRole("button", { name: "翻译" }).click();
  await expect(page.getByText("翻译中...")).toBeVisible();
  await expect(page.getByRole("button", { name: "高亮" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "关闭 PDF 选区操作" })).toBeEnabled();
  const loading = await toolbar.boundingBox();
  expect(loading).toEqual(before);

  const surface = page.getByRole("dialog", { name: "PDF 选区翻译" });
  await expect(surface.locator(".katex")).toBeVisible();
  await expect(page.getByRole("button", { name: "高亮" })).toBeEnabled();
  const surfaceBox = await surface.boundingBox();
  const selectionBox = await page.locator(".translation-selection").boundingBox();
  expect(surfaceBox).not.toBeNull();
  expect(selectionBox).not.toBeNull();
  expect(surfaceBox!.x).toBeGreaterThanOrEqual(0);
  expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(1440);
  expect(surfaceBox!.y).toBeGreaterThanOrEqual(0);
  expect(surfaceBox!.y + surfaceBox!.height).toBeLessThanOrEqual(900);
  expect(surfaceBox!.y).toBeLessThan(selectionBox!.y);
  await expect(page.locator(".translation-selection")).toBeVisible();
  await page.screenshot({ path: "test-results/pdf-selection-translation-desktop.png", fullPage: true });
});

test("mobile translation becomes a viewport-bound bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pdf-selection-translation-visual.html");
  await page.getByRole("button", { name: "翻译" }).click();

  const surface = page.getByRole("dialog", { name: "PDF 选区翻译" });
  await expect(surface.locator(".katex")).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.y + box!.height)).toBe(844);
  await expect(page.locator(".translation-selection")).toBeVisible();
  await page.screenshot({ path: "test-results/pdf-selection-translation-mobile.png", fullPage: true });
});
