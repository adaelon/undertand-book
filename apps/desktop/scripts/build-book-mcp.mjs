import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("the packaged Book MCP sidecar currently supports Windows only");
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const targetRoot = process.env.CARGO_TARGET_DIR
  ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");
const source = path.join(targetRoot, "release", "book_mcp.exe");
const outputDir = path.join(desktopRoot, "src-tauri", "binaries");
const output = path.join(outputDir, "book-mcp-x86_64-pc-windows-msvc.exe");

const result = spawnSync(
  process.env.CARGO ?? "cargo",
  ["build", "--locked", "--release", "-p", "server", "--bin", "book_mcp"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(outputDir, { recursive: true });
copyFileSync(source, output);
console.log(output);
