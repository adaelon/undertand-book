import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(desktopRoot, "..", "..", "packages", "web", "dist");
const target = path.join(desktopRoot, "src-tauri", "resources", "web-dist");

if (!existsSync(path.join(source, "index.html"))) {
  throw new Error(`web production build is missing: ${source}`);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
