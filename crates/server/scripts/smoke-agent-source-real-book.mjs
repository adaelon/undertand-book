import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bookDir = resolve(
  repoRoot,
  ".understand-book/cardiac-splicing-as-a-diagnostic-and-therapeutic-target",
);
const serverBinary = resolve(repoRoot, "target/debug", process.platform === "win32" ? "server.exe" : "server");
const bookId = "cardiac-splicing-as-a-diagnostic-and-therapeutic-target";
const lid = "2.26.2";
const turnId = "turn_real_source_replay";
const sessionId = "chat_real_source_replay";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function historyFixture() {
  const answer = `The review identifies modifiable RNA-splicing mechanisms in cardiac disease. [LID: ${lid}]`;
  return {
    active_by_book: { [bookId]: sessionId },
    sessions: [{
      id: sessionId,
      book_id: bookId,
      title: "Real source replay",
      created_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:01Z",
      turns: [{
        turn_id: turnId,
        user_turn_ordinal: 1,
        user: "Where does the review support this claim?",
        status: "completed",
        outcome: {
          answer,
          incomplete: false,
          warning: null,
          turns: 1,
          tokens_spent: 1,
          effects: [],
          trace: [],
          profile_usage: {
            snapshot_revision: 0,
            injected_fact_ids: [],
            claimed_used_fact_ids: [],
            influences: [],
          },
          memory_updates: [],
        },
        question_anchor_lid: null,
        question_quote: null,
      }],
      messages: [
        { role: "System", content: "real source replay", tool_calls: [], tool_call_id: null },
        { role: "User", content: "Where does the review support this claim?", tool_calls: [], tool_call_id: null },
        { role: "Assistant", content: answer, tool_calls: [], tool_call_id: null },
      ],
    }],
  };
}

async function startServer(memoryDir) {
  assert(existsSync(serverBinary), `server binary is missing: ${serverBinary}`);
  const child = spawn(serverBinary, [bookDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      UNDERSTAND_BOOK_ADDR: "127.0.0.1:0",
      UNDERSTAND_BOOK_MEMORY_DIR: memoryDir,
      UNDERSTAND_BOOK_REVIEW_DRAIN_TIMEOUT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const url = await new Promise((resolveUrl, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${stderr}`)), 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/server listening at (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited during startup (${code}): ${stderr}`));
    });
  });
  return { child, url };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("server shutdown timed out")), 10_000)),
  ]);
}

async function jsonRequest(url, path, body) {
  const response = await fetch(`${url}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, `${path} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function main() {
  for (const file of ["base.json", "source.txt"]) {
    assert(existsSync(join(bookDir, file)), `real book artifact is missing: ${file}`);
  }
  const beforeBook = {
    base: digest(join(bookDir, "base.json")),
    source: digest(join(bookDir, "source.txt")),
  };
  const memoryDir = mkdtempSync(join(tmpdir(), "understand-book-agent-source-replay-"));
  const relativeToTemp = relative(resolve(tmpdir()), resolve(memoryDir));
  assert(relativeToTemp && !relativeToTemp.startsWith("..") && !isAbsolute(relativeToTemp), "unsafe replay temp path");
  const historyPath = join(memoryDir, "agent-history.json");
  writeFileSync(historyPath, `${JSON.stringify(historyFixture(), null, 2)}\n`, "utf8");
  const historyBefore = readFileSync(historyPath);
  let first;
  let second;
  try {
    first = await startServer(memoryDir);
    const history = await jsonRequest(first.url, "/agent/history");
    const turn = history.current.turns[0];
    assert(turn.turn_id === turnId, "real replay turn identity changed");
    assert(turn.outcome.answer_view.parts.some((part) => part.kind === "sources"), "legacy marker was not projected");
    assert(!JSON.stringify(turn).includes(lid), "public real-book turn leaked its internal LID");
    const source = turn.outcome.answer_view.sources[0];
    assert(source && !source.source_ref_id.includes(lid), "source ref is not opaque");
    const request = { turn_id: turnId, source_ref_id: source.source_ref_id };
    const popup = await jsonRequest(first.url, "/agent/source.resolve", request);
    assert(!JSON.stringify(popup).includes(lid), "source popup leaked its internal LID");
    assert(popup.highlighted_quote.includes("cardiomyopathy"), "real evidence quote was not replayed");
    const words = `${popup.context_before} ${popup.highlighted_quote} ${popup.context_after}`
      .trim()
      .split(/\s+/u)
      .filter(Boolean).length;
    assert(words >= 120 && words <= 500, `real context window is outside the English bounds: ${words}`);
    const opened = await jsonRequest(first.url, "/agent/source.open", request);
    assert(opened.opened === true, "real source did not open in the Reader");
    await stopServer(first.child);
    first = null;

    second = await startServer(memoryDir);
    const restarted = await jsonRequest(second.url, "/agent/source.resolve", request);
    assert(restarted.source_ref_id === source.source_ref_id, "source ref changed after restart");
    assert(restarted.highlighted_quote === popup.highlighted_quote, "source evidence changed after restart");
    assert(readFileSync(historyPath).equals(historyBefore), "real replay rewrote legacy history");
    assert(digest(join(bookDir, "base.json")) === beforeBook.base, "real replay changed base.json");
    assert(digest(join(bookDir, "source.txt")) === beforeBook.source, "real replay changed source.txt");
    process.stdout.write(JSON.stringify({
      book_id: bookId,
      turn_id: turnId,
      source_ref_id: source.source_ref_id,
      label: popup.label,
      context_words: words,
      restart_stable: true,
      history_unchanged: true,
      book_unchanged: true,
    }, null, 2));
    process.stdout.write("\n");
  } finally {
    if (first) await stopServer(first.child);
    if (second) await stopServer(second.child);
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

await main();
