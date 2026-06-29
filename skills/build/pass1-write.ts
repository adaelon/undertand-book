// PB5-3 跨会话续建 loop 第 2c 步 [ADR-0042]。subagent 抽完一窗 → **原子写**该窗产物。
//   tsx skills/build/pass1-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>]
// subagent-output.json = {nodes, edges}(Pass1Output)。content_hash 由 TS 从窗口重算(命门:
// 不信调用方手算),临时文件 + rename 原子落 `.understand-book/<bookId>/.build/pass1/<id>.json`。
// 逐窗原子写是跨会话续建命根:抽一窗落一窗,会话可停在任意窗、已抽全部幸存。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { buildPass1Artifact } from "../../packages/core/src/build-resume";
import { deriveBookId } from "../../packages/core/src/book-id";
import type { Pass1Output } from "../../packages/core/src/merge";
import { loadBookWindows, windowById } from "./load-book";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book || idStr === undefined || !outputPath) {
  console.error("usage: tsx pass1-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>]");
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId 必须是整数,得到 "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
const output = JSON.parse(readFileSync(outputPath, "utf8")) as Pass1Output;
const artifact = buildPass1Artifact(w, byLid, source, output);

const bookId = deriveBookId(book, override);
const dir = `.understand-book/${bookId}/.build/pass1`;
mkdirSync(dir, { recursive: true });
const finalPath = `${dir}/${id}.json`;
const tmpPath = `${finalPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(artifact), "utf8");
renameSync(tmpPath, finalPath); // 原子替换:中断不留半成品

console.log(
  `[pass1-write] window ${id} → ${finalPath}  nodes=${artifact.nodes.length} edges=${artifact.edges.length} hash=${artifact.content_hash.slice(0, 12)}`,
);
