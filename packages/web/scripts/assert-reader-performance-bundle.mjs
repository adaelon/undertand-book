import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const diagnosticMarkers = [
  "__UNDERSTAND_BOOK_READER_PERF__",
  "reader-performance-snapshot.v1",
  "reader:first-segment",
];

function javascriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

const leaked = [];
for (const path of javascriptFiles(dist)) {
  const source = readFileSync(path, "utf8");
  for (const marker of diagnosticMarkers) {
    if (source.includes(marker)) leaked.push({ path, marker });
  }
}

if (leaked.length) {
  throw new Error(`reader performance diagnostics leaked into the production bundle:\n${JSON.stringify(leaked, null, 2)}`);
}

process.stdout.write("reader performance diagnostics absent from production bundle\n");
