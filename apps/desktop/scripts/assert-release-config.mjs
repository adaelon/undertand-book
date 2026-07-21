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
assert(
  config.bundle?.externalBin?.includes("binaries/book-mcp"),
  "Windows Setup must package the Book MCP sidecar",
);
assert(
  config.build?.beforeBuildCommand?.includes("build-book-mcp.mjs")
    && config.build.beforeBuildCommand.includes("smoke-book-mcp-plugin.mjs"),
  "Windows Setup must build and smoke the plugin-provided Book MCP before bundling",
);
