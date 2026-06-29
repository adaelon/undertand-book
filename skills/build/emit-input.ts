// PB5-3 跨会话续建 loop 第 2a 步 [ADR-0042]。现算单窗 Pass1 抽取输入正文(每段 [LID] 前缀)
// 打印到 stdout 喂 subagent pass1-local-extractor —— **不落盘**(输入是确定性派生,[ADR-0012])。
//   tsx skills/build/emit-input.ts <book.md|epub> <windowId> [--book-id <id>]
import { buildPass1Input } from "../../packages/core/src/pass1-input";
import { loadBookWindows, windowById } from "./load-book";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr] = positional;
if (!book || idStr === undefined) {
  console.error("usage: tsx emit-input.ts <book.md|epub> <windowId> [--book-id <id>]");
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId 必须是整数,得到 "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
const w = windowById(windows, id);
// 纯正文到 stdout(无前后缀),便于直接管道喂 subagent;诊断信息走 stderr。
process.stderr.write(`[emit-input] window ${id}: ${w.leafLids.length} 叶子\n`);
process.stdout.write(buildPass1Input(w, byLid, source).text);
