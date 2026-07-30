import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("the packaged Book MCP plugin smoke currently supports Windows only");
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const binary = path.join(
  desktopRoot,
  "src-tauri",
  "binaries",
  "book-mcp-x86_64-pc-windows-msvc.exe",
);
const plugin = JSON.parse(readFileSync(path.join(repoRoot, ".mcp.json"), "utf8"));
const server = plugin.mcpServers?.book;
if (!server || server.command !== "cmd.exe" || server.cwd !== ".") {
  throw new Error("root plugin does not declare the expected Book MCP launcher");
}

const root = mkdtempSync(path.join(tmpdir(), "understand-book-mcp-plugin-smoke-"));
const bookDir = path.join(root, "book");
const memoryDir = path.join(root, "memory");
const privateDir = path.join(root, "private");
mkdirSync(bookDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(privateDir, { recursive: true });
writeFileSync(path.join(bookDir, "source.txt"), "alpha beta alpha", "utf8");
writeFileSync(path.join(bookDir, "base.json"), JSON.stringify({
  book_id: "plugin-mcp-smoke",
  lid_nodes: [{
    lid: "1",
    path: [1],
    kind: "paragraph",
    span: { start: 0, end: 16 },
    children: [],
  }],
  graph_nodes: [],
  graph_edges: [],
}, null, 2));
writeFileSync(path.join(memoryDir, "session.json"), JSON.stringify({
  current_book_dir: bookDir,
  books: {},
}, null, 2));

try {
  const result = await new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      UNDERSTAND_BOOK_MCP_BIN: binary,
      UNDERSTAND_BOOK_MEMORY_DIR: memoryDir,
      UNDERSTAND_BOOK_PRIVATE_DIR: privateDir,
    };
    delete childEnv.UNDERSTAND_BOOK_DIR;
    const child = spawn(server.command, server.args, {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let stderr = "";
    let listed = false;
    let complete = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`packaged Book MCP plugin smoke timed out: ${stderr}`));
    }, 30_000);

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.error) {
          child.kill();
          reject(new Error(`Book MCP plugin error: ${line}`));
          return;
        }
        if (message.id === 1) {
          const names = message.result?.tools?.map((tool) => tool.name) ?? [];
          if (!names.includes("book_search_text")) {
            child.kill();
            reject(new Error(`book_search_text missing from tools/list: ${line}`));
            return;
          }
          for (const artifactTool of ["artifact_list", "artifact_search", "artifact_read"]) {
            if (!names.includes(artifactTool)) {
              child.kill();
              reject(new Error(`${artifactTool} missing from tools/list: ${line}`));
              return;
            }
          }
          listed = true;
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "artifact_list",
              arguments: {},
            },
          })}\n`);
        } else if (message.id === 2) {
          if (!message.result?.isError
            || message.result?.structuredContent?.error_code !== "ARTIFACT_OVERLAY_UNAVAILABLE") {
            child.kill();
            reject(new Error(`unexpected artifact_list unavailable result: ${line}`));
            return;
          }
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "book_search_text",
              arguments: { query: "alpha", page_size: 10 },
            },
          })}\n`);
        } else if (message.id === 3) {
          if (message.result?.isError) {
            child.kill();
            reject(new Error(`Book MCP plugin error: ${line}`));
            return;
          }
          const page = message.result?.structuredContent;
          if (page?.total_occurrences !== 2 || page?.occurrences?.length !== 2) {
            child.kill();
            reject(new Error(`unexpected book_search_text result: ${line}`));
            return;
          }
          complete = true;
          child.stdin.end();
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !listed || !complete) {
        reject(new Error(JSON.stringify({ code, listed, complete, stderr })));
        return;
      }
      resolve({
        tool: "book_search_text",
        total: 2,
        binding: "reader-session",
        artifactUnavailable: true,
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  });
  console.log(JSON.stringify(result));
} finally {
  rmSync(root, { recursive: true, force: true });
}
