import { defineConfig } from "@playwright/test";

// The acceptance starts the actual product host with its production Web assets.
export default defineConfig({
  testDir: "./playwright",
  testMatch: "agent-presentation-live.spec.ts",
  workers: 1,
});
