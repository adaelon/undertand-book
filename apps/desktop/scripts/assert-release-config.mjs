import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.env.UNDERSTAND_BOOK_MARKETPLACE_SOURCE?.trim();
if (!source) {
  throw new Error("UNDERSTAND_BOOK_MARKETPLACE_SOURCE is required (for example owner/repo)");
}
const publicGit = /^[\w.-]+\/[\w.-]+(?:@[^\s]+)?$/.test(source)
  || /^https:\/\//.test(source)
  || /^git@[^:]+:/.test(source);
if (!publicGit) {
  throw new Error("UNDERSTAND_BOOK_MARKETPLACE_SOURCE must be a public Git marketplace source, not a local path");
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
for (const externalBinary of ["binaries/understand-book-build", "binaries/book-mcp"]) {
  assert(
    config.bundle?.externalBin?.includes(externalBinary),
    `Windows Setup must package the external binary: ${externalBinary}`,
  );
}
assert(
  config.bundle?.resources?.includes("resources/web-dist/**/*"),
  "Windows Setup must package the prepared web resources",
);

const beforeBuildCommand = config.build?.beforeBuildCommand ?? "";
const requiredBuildSteps = [
  "pnpm -C ../../packages/web build",
  "node scripts/build-sidecar.mjs",
  "node scripts/smoke-workbench-sidecar.mjs",
  "node scripts/build-book-mcp.mjs",
  "node scripts/smoke-book-mcp-plugin.mjs",
  "node scripts/prepare-resources.mjs",
];
let previousIndex = -1;
for (const step of requiredBuildSteps) {
  const index = beforeBuildCommand.indexOf(step);
  assert(index >= 0, `Windows Setup beforeBuildCommand is missing: ${step}`);
  assert(index > previousIndex, `Windows Setup beforeBuildCommand is out of order at: ${step}`);
  previousIndex = index;
}
