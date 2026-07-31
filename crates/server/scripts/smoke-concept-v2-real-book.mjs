import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const executable = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const residentBinary = process.argv[2] ?? path.join(repoRoot, "target", "debug", executable("server"));
const mcpBinary = process.argv[3] ?? path.join(repoRoot, "target", "debug", executable("book_mcp"));
const bookDir = process.argv[4] ?? path.join(repoRoot, ".understand-book", "ai-agent-engineering");
const broadQuery = "harness";
const refinedQuery = "模型 脚手架";
const targetId = "concept:model_harness_tradeoff";
const targetName = "模型与脚手架的消长关系";
const targetLid = "1.6.8.13.12";
const targetText = "模型与脚手架（harness）之间是此消彼长的关系";

for (const required of [residentBinary, mcpBinary, path.join(bookDir, "base.json"), path.join(bookDir, "source.txt")]) {
  assert(existsSync(required), `real-book concept replay input is missing: ${required}`);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sourceBefore = {
  base: sha256(path.join(bookDir, "base.json")),
  text: sha256(path.join(bookDir, "source.txt")),
};
const privateDir = await mkdtemp(path.join(os.tmpdir(), "book-concept-v2-real-"));

function completion(message) {
  return {
    id: "book-concept-v2-real-smoke",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
    usage: { total_tokens: 5 },
  };
}

function toolCompletion(id, name, args) {
  return completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
}

function toolMessagesAfterLastUser(messages) {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  return messages.slice(lastUser + 1).filter((message) => message.role === "tool");
}

function providerToolName(body, alias) {
  const tool = body.tools?.find((candidate) => candidate.function?.name === alias);
  assert(tool, `Resident provider request did not expose ${alias}`);
  return tool.function.name;
}

function parseEnvelope(message, expectedTool) {
  const envelope = JSON.parse(message.content ?? "null");
  assert.equal(envelope.version, "tool_result_envelope.v1", `${expectedTool} envelope version drifted`);
  assert.equal(envelope.status, "ok", `${expectedTool} did not succeed`);
  assert.equal(envelope.truncated, false, `${expectedTool} exceeded its Resident model-body budget`);
  assert.notEqual(envelope.model_body, null, `${expectedTool} model body was not available to the Agent`);
  return envelope.model_body;
}

async function startMockProvider() {
  const requests = [];
  let residentCandidates;
  let residentText;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      requests.push(body);
      const tools = toolMessagesAfterLastUser(body.messages ?? []);
      let result;
      if (tools.length === 0) {
        result = toolCompletion(
          "real-concept-candidates",
          providerToolName(body, "book_concept"),
          { query: refinedQuery },
        );
      } else if (tools.length === 1) {
        residentCandidates = parseEnvelope(tools[0], "book.concept");
        const target = residentCandidates.candidates.find((candidate) => candidate.node_id === targetId);
        assert(target, "Resident refined query did not expose the gold candidate");
        assert.equal(target.occurrences[0], targetLid);
        result = toolCompletion(
          "real-concept-text",
          providerToolName(body, "book_text"),
          { lid: target.occurrences[0] },
        );
      } else if (tools.length === 2) {
        residentText = parseEnvelope(tools[1], "book.text");
        assert.equal(residentText.lid, targetLid);
        assert(residentText.text.includes(targetText), "Resident did not read the gold occurrence text");
        result = completion({
          role: "assistant",
          content: "模型越强，外围 Harness 的约束、验证和纠正仍需协同演进。",
          tool_calls: [],
        });
      } else {
        result = completion({ role: "assistant", content: "真书回放已完成。", tool_calls: [] });
      }
      const encoded = JSON.stringify(result);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encoded),
      });
      response.end(encoded);
    } catch (error) {
      const encoded = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      response.writeHead(500, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encoded),
      });
      response.end(encoded);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    residentCandidates: () => residentCandidates,
    residentText: () => residentText,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function fetchJson(url, init = undefined) {
  const response = await fetch(url, init);
  const text = await response.text();
  assert(response.ok, `${url} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function waitForServer(url, child, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Resident Server exited early: ${stderr()}`);
    try {
      await fetchJson(`${url}/api/book/manifest`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Resident Server startup timed out: ${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function mcpCall(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(mcpBinary, [bookDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_API_KEY: "",
        OPENCODE_BASE_URL: "",
        FLUID_LLM_MODEL: "",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP ${name} timed out`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, `MCP ${name} exited ${code}: ${stderr}`);
        const response = JSON.parse(stdout.trim());
        assert(!response.error, `MCP ${name} JSON-RPC error: ${stdout}`);
        assert.equal(response.result?.isError, false, `MCP ${name} tool error: ${stdout}`);
        resolve(response.result.structuredContent);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`);
  });
}

const mock = await startMockProvider();
const residentPort = await freePort();
let residentStderr = "";
const resident = spawn(residentBinary, [bookDir], {
  cwd: repoRoot,
  env: {
    ...process.env,
    UNDERSTAND_BOOK_ADDR: `127.0.0.1:${residentPort}`,
    UNDERSTAND_BOOK_MEMORY_DIR: privateDir,
    UNDERSTAND_BOOK_REVIEW_DRAIN_TIMEOUT_MS: "50",
    UNDERSTAND_BOOK_PROVIDER: "native",
    OPENCODE_API_KEY: "concept-v2-local-mock",
    OPENCODE_BASE_URL: mock.url,
    FLUID_LLM_MODEL: "concept-v2-scripted",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
resident.stderr.on("data", (chunk) => {
  residentStderr += chunk.toString();
});
const residentUrl = `http://127.0.0.1:${residentPort}`;

try {
  await waitForServer(residentUrl, resident, () => residentStderr);
  const restRefined = await fetchJson(
    `${residentUrl}/api/book/concept?query=${encodeURIComponent(refinedQuery)}`,
  );
  const mcpRefined = await mcpCall("book_concept", { query: refinedQuery });

  await fetchJson(`${residentUrl}/api/agent/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const residentOutcome = await fetchJson(`${residentUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "模型强了以后，harness 会怎样？" }),
  });
  assert.equal(residentOutcome.incomplete, false);
  assert.deepEqual(
    residentOutcome.trace.map((step) => step.tool),
    ["book.concept", "book.text"],
  );
  const residentRefined = mock.residentCandidates();
  assert(residentRefined, "Resident did not publish a concept candidate result to the Agent");
  assert.deepEqual(residentRefined, restRefined, "Resident and REST concept candidates drifted");
  assert.deepEqual(residentRefined, mcpRefined, "Resident and MCP concept candidates drifted");
  assert.equal(residentRefined.candidates[0].node_id, targetId);
  assert.equal(residentRefined.returned_count, residentRefined.candidates.length);

  const broad = await mcpCall("book_concept", { query: broadQuery, limit: 50 });
  assert.equal(broad.version, "book_concept.v2");
  assert.equal(broad.matched_count, 82);
  assert.equal(broad.returned_count, 50);
  assert.equal(broad.truncated, true);
  const targetIndex = broad.candidates.findIndex((candidate) => candidate.node_id === targetId);
  assert.equal(targetIndex, 48, "broad harness ranking changed for the frozen source revision");
  const target = broad.candidates[targetIndex];
  assert.equal(target.name, targetName);
  assert.equal(target.match_tier, "occurrence_text");
  assert.deepEqual(target.match_reasons, ["occurrence_text"]);
  assert.deepEqual(target.occurrences, [targetLid]);
  assert(target.previews.some((preview) => preview.text.includes(targetText)));

  const fullText = await mcpCall("book_text", { lid: target.occurrences[0] });
  assert.equal(fullText.lid, targetLid);
  assert(fullText.text.includes(targetText), "MCP book_text did not return the gold occurrence");
  assert(mock.residentText()?.text.includes(targetText));

  assert.equal(sha256(path.join(bookDir, "base.json")), sourceBefore.base, "real replay changed base.json");
  assert.equal(sha256(path.join(bookDir, "source.txt")), sourceBefore.text, "real replay changed source.txt");
  console.log(JSON.stringify({
    book_id: "ai-agent-engineering",
    source_revision: sourceBefore,
    parity_query: refinedQuery,
    parity_candidates: residentRefined.returned_count,
    broad_query: broadQuery,
    broad_matched: broad.matched_count,
    broad_returned: broad.returned_count,
    gold_candidate_index: targetIndex,
    gold_candidate: target.node_id,
    gold_lid: targetLid,
    resident_trace: residentOutcome.trace.map((step) => step.tool),
    provider_calls: mock.requests.length,
    book_unchanged: true,
  }));
} finally {
  await stopChild(resident);
  await mock.close();
  await rm(privateDir, { recursive: true, force: true });
}
