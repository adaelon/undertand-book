import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const outputDir = path.join(desktopRoot, "src-tauri", "binaries");
const output = path.join(outputDir, "understand-book-build-x86_64-pc-windows-msvc.exe");
mkdirSync(outputDir, { recursive: true });

function bunExecutable() {
  if (process.env.BUN_BINARY) return process.env.BUN_BINARY;
  if (process.platform !== "win32") return "bun";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const executable = path.join(directory, "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(executable)) return executable;
  }
  throw new Error("bun.exe was not found; install Bun or set BUN_BINARY");
}

const result = spawnSync(
  bunExecutable(),
  [
    "build",
    path.join(repoRoot, "skills", "build", "sidecar-entry.ts"),
    "--compile",
    "--target=bun-windows-x64",
    "--loader=.md:text",
    "--loader=.toml:text",
    `--outfile=${output}`,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
