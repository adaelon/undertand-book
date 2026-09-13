import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./playwright", testMatch: "agent-run-live.spec.ts", timeout: process.env.AS9_BROWSER_WS ? 180_000 : 60_000, workers: 1, use: { ...(process.env.AS9_BROWSER_WS ? { connectOptions: { wsEndpoint: process.env.AS9_BROWSER_WS } } : {}), viewport: { width: 1440, height: 900 }, screenshot: "only-on-failure" } });
