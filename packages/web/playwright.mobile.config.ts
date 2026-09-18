import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  testMatch: "mobile-workspace.spec.ts",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4176" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176/mobile-workspace-visual.html",
    reuseExistingServer: true,
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "mobile-webkit", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "landscape-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 844, height: 390 }, hasTouch: true } },
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
});
