import { expect, test, type Locator } from "@playwright/test";

async function expectTextBlocksNotClipped(locator: Locator) {
  const failures = await locator.evaluateAll((elements) => elements.flatMap((element) => {
    const node = element as HTMLElement;
    const style = window.getComputedStyle(node);
    const clipped = node.scrollHeight > node.clientHeight + 1
      || node.scrollWidth > node.clientWidth + 1
      || style.textOverflow === "ellipsis"
      || !["none", "0"].includes(style.webkitLineClamp);
    return clipped ? [node.textContent?.trim() ?? node.className] : [];
  }));
  expect(failures).toEqual([]);
}

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
  await expect(page.locator("[data-testid='skim-route']")).toBeVisible();
  await expect(page.locator("[data-testid='global-chain'] .paper-map-chain-row")).toHaveCount(5);

  await page.getByRole("button", { name: "摘要", exact: true }).click();
  await expect(page.locator("[data-testid='abstract-structure']")).toBeVisible();
  await expect(page.locator("[data-testid='skim-route']")).toHaveCount(0);
  await expect(page.locator("[data-testid='local-chain'] > button")).toHaveCount(4);
  await expect(page.locator("[data-testid='abstract-correspondences'] > button")).toHaveCount(3);
  await expect(page.locator(".paper-map-region-list button.lens-focus")).toHaveCount(4);
  await expect(page.locator(".paper-map-shell")).toContainText("摘要中的 BERT 方法概述");

  await page.getByRole("button", { name: "深读", exact: true }).click();
  await expect(page.locator("[data-testid='deep-region']")).toBeVisible();
  await expect(page.locator("[data-testid='abstract-structure']")).toHaveCount(0);
  await expect(page.locator(".paper-map-region-list button.lens-focus")).toHaveCount(1);
  await expect(page.locator(".paper-map-shell")).toContainText("材料与方法");
  await expect(page.locator(".paper-map-shell")).toContainText("BERT");
  await expect(page.locator(".paper-map-shell")).toContainText("LongMethodName-ExtremelySpecificVariant");
  await expect(page.locator(".paper-map-shell")).toContainText("覆盖主要对照组与消融条件的实验设计");
  await expect(page.locator(".paper-map-shell")).not.toContainText("摘要中的研究问题与适用边界");
  await expect(page.locator(".paper-map-shell")).not.toContainText("Materials and Methods");
  expect(await pdf.boundingBox()).toEqual(before);
  await expect(page.locator("[data-testid='local-chain'] > button")).toHaveCount(4);
  expect(await page.locator(".paper-map-relations > div").count()).toBeLessThanOrEqual(3);
  expect(await page.locator("[data-testid='global-chain'] .paper-map-chain-row").count()).toBeLessThanOrEqual(5);
  await expectTextBlocksNotClipped(page.locator([
    ".paper-map-region-copy strong",
    ".paper-map-landmark-link span",
    ".paper-map-local-chain strong",
    ".paper-map-correspondences span",
    ".paper-map-relations > div > span",
  ].join(",")));
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
  await page.getByRole("button", { name: "深读", exact: true }).click();
  await expect(page.locator("[data-testid='deep-region']")).toBeVisible();
  await expect(page.locator(".paper-map-shell")).toContainText("LongMethodName-ExtremelySpecificVariant");
  await expectTextBlocksNotClipped(page.locator([
    ".paper-map-region-copy strong",
    ".paper-map-local-chain strong",
    ".paper-map-relations > div > span",
  ].join(",")));
  await expect(page.locator(".paper-map-shell")).toHaveCSS("overflow-y", "auto");
  await page.screenshot({ path: "../../docs/screenshots/paper-minimap-chinese-mobile.png", fullPage: true });
});
