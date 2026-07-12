import { expect, test } from "@playwright/test";

test("desktop expansion preserves the PDF surface", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paper-minimap-visual.html");
  const pdf = page.getByTestId("pdf-surface");
  const before = await pdf.boundingBox();
  await page.locator(".paper-map-toggle").click();
  const after = await pdf.boundingBox();
  expect(before).not.toBeNull();
  expect(after).toEqual(before);
  const map = await page.locator(".paper-map-shell").boundingBox();
  expect(map).not.toBeNull();
  expect(map!.x + map!.width).toBeLessThanOrEqual(after!.x);
  await page.getByRole("button", { name: "深读" }).click();
  await expect(page.locator(".paper-map-shell")).toContainText("材料与方法");
  await expect(page.locator(".paper-map-shell")).toContainText("BERT");
  await expect(page.locator(".paper-map-shell")).not.toContainText("Materials and Methods");
  expect(await pdf.boundingBox()).toEqual(before);
  await expect(page.locator("[data-testid='local-chain'] > button")).toHaveCount(4);
  expect(await page.locator(".paper-map-relations > div").count()).toBeLessThanOrEqual(3);
  expect(await page.locator("[data-testid='global-chain'] .paper-map-chain-row").count()).toBeLessThanOrEqual(5);
  await page.screenshot({ path: "../../docs/screenshots/paper-minimap-chinese-desktop.png", fullPage: true });
});

test("mobile expansion stays inside the viewport as an overlay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/paper-minimap-visual.html");
  await page.locator(".paper-map-toggle").click();
  const map = await page.locator(".paper-map-shell").boundingBox();
  expect(map).not.toBeNull();
  expect(map!.x).toBeGreaterThanOrEqual(0);
  expect(map!.x + map!.width).toBeLessThanOrEqual(390);
  expect(map!.y + map!.height).toBeLessThanOrEqual(844);
  await expect(page.locator(".paper-map-region-list button")).toHaveCount(6);
  await page.screenshot({ path: "../../docs/screenshots/paper-minimap-chinese-mobile.png", fullPage: true });
});
