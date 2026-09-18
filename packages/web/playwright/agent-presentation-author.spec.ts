import { expect, test } from "@playwright/test";

// Uses the persisted real-model acceptance run served by presentation_author_mount_host.
test("Resident generated revision mounts, computes the known example and keeps its live instance", async ({ page }, info) => {
  await page.route("**/api/**", async route => {
    const response = await route.fetch({ url: route.request().url().replace(/^.*\/api/, "http://127.0.0.1:4175") });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/agent-presentation-visual.html");
  const frame = page.frameLocator(".agent-presentation iframe");
  await expect(frame.locator("#valFound")).toHaveText("66.7%");
  await frame.locator("#btnNoise").click();
  await expect(frame.locator("#valFound")).toHaveText("66.7%");
  await expect(frame.locator("#noiseCount")).toHaveText("2 条");
  await frame.locator("#btnComplete").click();
  await expect(frame.locator("#valFound")).toHaveText("100.0%");
  await expect(frame.locator("#barFound svg rect").last()).toHaveAttribute("width", "100.00");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(frame.locator("#valFound")).toHaveText("100.0%");
  await expect(page.locator(".agent-presentation iframe")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("resident-generated-expanded.png") });
  await frame.locator("#btnReset").click();
  await expect(frame.locator("#valFound")).toHaveText("66.7%");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await frame.locator("body").evaluate(body => body.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
