import { expect, test } from "@playwright/test";

test("desktop exact annotations stay on-page and open one bounded surface", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pdf-annotation-visual.html");

  await expect(page.locator(".pdf-region")).toHaveCount(0);
  await expect(page.locator(".pdf-user-highlight")).toHaveCount(2);
  await expect(page.locator(".pdf-note-marker")).toHaveCount(2);
  const markerLocators = await page.locator(".pdf-note-marker").all();
  const markers = (await Promise.all(markerLocators.map((marker) => marker.boundingBox())))
    .filter((box): box is NonNullable<typeof box> => box !== null);
  expect(markers).toHaveLength(2);
  const overlap = markers[0].x < markers[1].x + markers[1].width
    && markers[0].x + markers[0].width > markers[1].x
    && markers[0].y < markers[1].y + markers[1].height
    && markers[0].y + markers[0].height > markers[1].y;
  expect(overlap).toBe(false);

  const scroller = page.locator(".pdf-page-list");
  await scroller.evaluate((element) => { element.scrollTop = 96; });
  const before = await scroller.evaluate((element) => element.scrollTop);
  await page.getByRole("button", { name: "打开 2 条 PDF 笔记" }).click();
  await expect(page.locator(".pdf-annotation-surface")).toHaveCount(1);
  await expect(page.locator(".pdf-annotation-surface .note-card")).toHaveCount(2);
  const surface = await page.locator(".pdf-annotation-surface").boundingBox();
  expect(surface).not.toBeNull();
  expect(surface!.x).toBeGreaterThanOrEqual(0);
  expect(surface!.x + surface!.width).toBeLessThanOrEqual(1440);
  expect(surface!.y + surface!.height).toBeLessThanOrEqual(900);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
});

test("mobile annotation surface becomes a safe bounded bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pdf-annotation-visual.html");
  await page.getByRole("button", { name: "打开 2 条 PDF 笔记" }).click();

  const surface = page.locator(".pdf-annotation-surface");
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.width).toBe(390);
  expect(Math.round(box!.y + box!.height)).toBe(844);
  await expect(surface).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".pdf-annotation-surface .note-card")).toHaveCount(2);
  await expect(page.locator(".pdf-region")).toHaveCount(0);
});
