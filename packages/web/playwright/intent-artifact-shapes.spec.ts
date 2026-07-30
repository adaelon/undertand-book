import { expect, test, type Page } from "@playwright/test";

async function assertFiveShapesAndNoViewportOverflow(page: Page, width: number) {
  for (const shape of ["collection", "table", "graph", "sequence", "document"]) {
    await expect(page.locator(`[data-artifact-shape="${shape}"]`)).toHaveCount(1);
  }
  await expect(page.getByText("Artifact Blueprint")).toBeVisible();
  await expect(page.getByText("五种通用形态共享同一个 accepted 数据合同")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelWidth: document.querySelector(".visual-panel")?.getBoundingClientRect().width ?? 0,
    panelScrollWidth: document.querySelector(".visual-panel")?.scrollWidth ?? 0,
  }));
  expect(geometry.viewport).toBe(width);
  expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  expect(geometry.panelScrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.panelWidth));
}

test("desktop shows all five Blueprint shapes and keeps long fields inside the Reader panel", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/intent-artifact-shapes-visual.html");
  await assertFiveShapesAndNoViewportOverflow(page, 1440);
  await page.getByRole("button", { name: "10.1" }).click();
  await expect(page.getByTestId("event-status")).toHaveText("已定位 10.1");
  await page.screenshot({ path: testInfo.outputPath("intent-artifact-shapes-desktop.png"), fullPage: true });
});

test("mobile stacks all five Blueprint shapes without horizontal page overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/intent-artifact-shapes-visual.html");
  await assertFiveShapesAndNoViewportOverflow(page, 390);
  await page.screenshot({ path: testInfo.outputPath("intent-artifact-shapes-mobile.png"), fullPage: true });
});
