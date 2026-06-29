// PB5-2 跨会话续建视图 CLI [ADR-0042]。新 Claude 会话冷启动第一步:零上下文、纯靠磁盘
// `.understand-book/<bookId>/.build/pass1/<id>.json` 判哪些窗口还要(重)抽。
//   tsx skills/build/build-status.ts <book.md|epub> [--book-id <id>]
// 逻辑确定性(无 LLM):重算窗口 → 逐窗 content-hash 校验磁盘产物 → 报 done/pending。
import { readFileSync, existsSync } from "node:fs";
import { segment, type SourceBlock } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import { splitWindows } from "../../packages/core/src/window";
import { computeBuildStatus, type Pass1ArtifactMeta } from "../../packages/core/src/build-resume";
import { deriveBookId } from "../../packages/core/src/book-id";

const argv = process.argv.slice(2);
const book = argv.find((a) => !a.startsWith("--"));
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
if (!book) {
  console.error("usage: tsx build-status.ts <book.md|epub> [--book-id <id>]");
  process.exit(2);
}

let source: string;
let blocks: SourceBlock[];
if (/\.epub$/i.test(book)) ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(book))));
else { source = readFileSync(book, "utf8"); blocks = markdownToBlocks(source); }

const lidNodes = segment(blocks);
const byLid = new Map(lidNodes.map((n) => [n.lid, n]));
const windows = splitWindows(lidNodes, source);

const bookId = deriveBookId(book, override);
const pass1Dir = `.understand-book/${bookId}/.build/pass1`;

// 磁盘侧:逐窗读已落产物(只取 content_hash);缺文件 = 不入 map = pending。
const existing = new Map<number, Pass1ArtifactMeta>();
for (const w of windows) {
  const f = `${pass1Dir}/${w.id}.json`;
  if (!existsSync(f)) continue;
  const meta = JSON.parse(readFileSync(f, "utf8")) as Pass1ArtifactMeta;
  if (typeof meta?.content_hash === "string") existing.set(w.id, { content_hash: meta.content_hash });
}

const { done, pending } = computeBuildStatus(windows, byLid, source, existing);

console.log(`[build-status] ${book}  bookId=${bookId}`);
console.log(`  窗口=${windows.length}  done=${done.length}  pending=${pending.length}`);
console.log(`  pass1 产物目录: ${pass1Dir}`);
if (pending.length) console.log(`  pending ids: ${pending.join(",")}`);
else console.log(`  全部窗口已抽且 content_hash 一致 → 可收口(tsx skills/build/pass1-batch.ts ${book})`);
