import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const executable = process.platform === "win32" ? "book_mcp.exe" : "book_mcp";
const binary = process.argv[2] ?? path.join(repoRoot, "target", "debug", executable);
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "book-concept-v2-mcp-"));
const firstText = "alpha primary evidence";
const secondText = "alpha detail evidence";
const source = `${firstText}\n${secondText}`;

await writeFile(path.join(fixtureDir, "source.txt"), source);
await writeFile(
  path.join(fixtureDir, "base.json"),
  JSON.stringify(
    {
      book_id: "concept-v2-no-provider",
      lid_nodes: [
        {
          lid: "1.1",
          path: [1, 1],
          kind: "paragraph",
          span: { start: 0, end: firstText.length },
          children: [],
        },
        {
          lid: "1.2",
          path: [1, 2],
          kind: "paragraph",
          span: { start: firstText.length + 1, end: source.length },
          children: [],
        },
      ],
      graph_nodes: [
        {
          id: "concept:alpha",
          type: "concept",
          name: "alpha",
          occurrences: ["1.1"],
        },
        {
          id: "concept:alpha-detail",
          type: "concept",
          name: "alpha detail",
          occurrences: ["1.2"],
        },
      ],
      graph_edges: [],
    },
    null,
    2,
  ),
);

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, [fixtureDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_API_KEY: "",
        OPENCODE_BASE_URL: "",
        FLUID_LLM_MODEL: "",
      },
    });
    let buffer = "";
    let stderr = "";
    let complete = false;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("book_concept v2 no-provider MCP smoke timed out"));
    }, 30_000);
    const send = (id, method, params = undefined) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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
        if (message.id === 1) {
          const concept = message.result?.tools?.find((tool) => tool.name === "book_concept");
          if (
            !concept?.description?.includes("book.text") ||
            JSON.stringify(concept.inputSchema?.required) !== JSON.stringify(["query"])
          ) {
            child.kill();
            reject(new Error(`unexpected book_concept tools/list contract: ${line}`));
            return;
          }
          send(2, "tools/call", {
            name: "book_concept",
            arguments: { query: "alpha" },
          });
        } else if (message.id === 2) {
          const candidates = message.result?.structuredContent;
          if (
            candidates?.version !== "book_concept.v2" ||
            candidates?.returned_count !== 2 ||
            candidates?.candidates?.[0]?.node_id !== "concept:alpha"
          ) {
            child.kill();
            reject(new Error(`unexpected concept candidates: ${line}`));
            return;
          }
          send(3, "tools/call", {
            name: "book_text",
            arguments: { lid: candidates.candidates[0].occurrences[0] },
          });
        } else if (message.id === 3) {
          const text = message.result?.structuredContent;
          if (text?.lid !== "1.1" || text?.text !== firstText) {
            child.kill();
            reject(new Error(`unexpected selected occurrence text: ${line}`));
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
      if (code !== 0 || !complete) {
        reject(new Error(JSON.stringify({ code, complete, stderr })));
        return;
      }
      resolve({
        tool: "book_concept",
        contract: "book_concept.v2",
        provider: "unconfigured",
        selected_lid: "1.1",
        followup: "book_text",
      });
    });

    send(1, "tools/list");
  });

  console.log(JSON.stringify(result));
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}
