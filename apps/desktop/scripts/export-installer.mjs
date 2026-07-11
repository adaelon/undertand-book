import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";
const config = JSON.parse(readFileSync(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const source = path.join(
  repoRoot,
  "target",
  profile,
  "bundle",
  "nsis",
  `Understand Book_${config.version}_x64-setup.exe`,
);
const outputDir = path.join(repoRoot, "dist");
const output = path.join(outputDir, debug ? "UnderstandBookSetup-debug.exe" : "UnderstandBookSetup.exe");
mkdirSync(outputDir, { recursive: true });
copyFileSync(source, output);
console.log(output);
