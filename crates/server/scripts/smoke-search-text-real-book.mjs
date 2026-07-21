import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const executable = process.platform === "win32" ? "book_mcp.exe" : "book_mcp";
const binary = process.argv[2] ?? path.join(repoRoot, "target", "debug", executable);
const bookDir =
  process.argv[3] ?? path.join(repoRoot, ".understand-book", "quantification-essence");
const query = String.raw`\sqrt{2\ln N}`;

const result = await new Promise((resolve, reject) => {
  const child = spawn(binary, [bookDir], { stdio: ["pipe", "pipe", "pipe"] });
  const ordinals = [];
  let buffer = "";
  let stderr = "";
  let cursor;
  let firstLid;
  let pages = 0;
  let requestId = 1;
  let complete = false;

  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("book_search_text MCP smoke timed out"));
  }, 30_000);

  const requestPage = () => {
    const args = { query, page_size: 7 };
    if (cursor) args.cursor = cursor;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId++,
        method: "tools/call",
        params: { name: "book_search_text", arguments: args },
      })}\n`,
    );
  };

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      if (message.error || message.result?.isError) {
        child.kill();
        reject(new Error(`MCP error: ${line}`));
        return;
      }
      const page = message.result?.structuredContent;
      if (page?.total_occurrences !== 32) {
        child.kill();
        reject(new Error(`unexpected total_occurrences: ${page?.total_occurrences}`));
        return;
      }
      pages += 1;
      firstLid ??= page.occurrences[0]?.start_lid;
      ordinals.push(...page.occurrences.map((occurrence) => occurrence.ordinal));
      cursor = page.next_cursor;
      if (cursor) requestPage();
      else {
        complete = true;
        child.stdin.end();
      }
    }
  });
  child.on("error", reject);
  child.on("close", (code) => {
    clearTimeout(timer);
    const expectedOrdinals = Array.from({ length: 32 }, (_, index) => index + 1);
    if (
      code !== 0 ||
      !complete ||
      pages !== 5 ||
      firstLid !== "1.10.3.10" ||
      JSON.stringify(ordinals) !== JSON.stringify(expectedOrdinals)
    ) {
      reject(
        new Error(
          JSON.stringify({ code, complete, pages, first_lid: firstLid, ordinals, stderr }),
        ),
      );
      return;
    }
    resolve({ tool: "book_search_text", pages, total: ordinals.length, first_lid: firstLid });
  });

  requestPage();
});

console.log(JSON.stringify(result));
