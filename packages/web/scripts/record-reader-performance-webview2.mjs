import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import {
  inspectReaderSurfaceSettlement,
  readerEdgeLoadFailureMessage,
  uniqueCreatedAnnotation,
} from "./reader-performance-correctness.mjs";

const REPORT_VERSION = "reader-performance-release-runtime.v1";
const SNAPSHOT_VERSION = "reader-performance-snapshot.v1";
const PERFORMANCE_GLOBAL = "__UNDERSTAND_BOOK_READER_PERF__";
const CHECKPOINTS = [20, 500, 1_000, 2_623];
const SCROLL_RATIO = 0.8;
const WARM_UP_RUNS = Number(process.env.READER_PERF_WARM_UP_RUNS ?? "2");
const MEASURED_RUNS = Number(process.env.READER_PERF_MEASURED_RUNS ?? "5");
const REQUEST_SAMPLE_LIMIT = 512;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const READER_ASYNC_SETTLEMENT_TIMEOUT_MS = 60_000;
const REQUIRED_SNAPSHOT_SECTIONS = [
  "scroll",
  "probe",
  "render",
  "edge_load",
  "first_segment",
  "dom",
  "frames",
  "long_tasks",
  "heap",
  "cache",
];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = resolve(process.cwd(), "../..");
const runtimeMode = argument("runtime", "webview2");
const cdpEndpoint = argument("cdp", "http://127.0.0.1:9333");
const configuredBaseUrl = argument("url", null);
const navigationQuery = argument("query", "readerPerf=1");
const correctnessOnly = argument("correctness-only", "false") === "true";
const skipCorrectness = argument("skip-correctness", "false") === "true";
const bookDir = resolve(argument("book-dir", resolve(root, ".understand-book/quantification-essence")));
const output = resolve(argument(
  "output",
  resolve(root, `docs/performance/reader-performance-${runtimeMode}-quantification-essence-phr9.json`),
));
const traceDir = resolve(argument("trace-dir", `${output}.traces`));
if (!new URLSearchParams(navigationQuery).has("readerPerf")) {
  throw new Error("release replay query must explicitly enable readerPerf");
}
if (runtimeMode !== "webview2" && runtimeMode !== "chromium") {
  throw new Error(`unsupported reader runtime: ${runtimeMode}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function readBookShape() {
  const base = JSON.parse(readFileSync(resolve(bookDir, "base.json"), "utf8"));
  const lidNodes = base.lid_nodes ?? [];
  const leaves = lidNodes.filter((node) => node.children.length === 0);
  const formulaLeaves = leaves.filter((node) => node.kind === "formula");
  const outlineNodes = lidNodes.filter((node) =>
    node.children.length > 0 || node.kind === "chapter" || node.kind === "section");
  return {
    book_id: base.book_id,
    nodes: lidNodes.length,
    leaves: leaves.length,
    formula_leaves: formulaLeaves.length,
    outline_nodes: outlineNodes.length,
    outline_lids: new Set(outlineNodes.map((node) => node.lid)),
    first_lid: leaves[0]?.lid ?? null,
    last_lid: leaves.at(-1)?.lid ?? null,
    leaf_lids: leaves.map((node) => node.lid),
    formula_lids: new Set(formulaLeaves.map((node) => node.lid)),
  };
}

function missingSnapshotFields(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return ["snapshot"];
  const missing = [];
  if (snapshot.schema_version !== SNAPSHOT_VERSION) missing.push("schema_version");
  for (const section of REQUIRED_SNAPSHOT_SECTIONS) {
    if (!snapshot[section] || typeof snapshot[section] !== "object") missing.push(section);
  }
  return missing;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function readerScrollLongTasks(snapshot) {
  const intervals = snapshot.edge_load.samples.values;
  return snapshot.long_tasks.samples.values.filter((sample) => (
    sample.duration_ms > 50
    && intervals.some((interval) => (
      sample.start_ms < interval.end_ms
      && sample.start_ms + sample.duration_ms > interval.start_ms
    ))
  )).length;
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

class RequestLedger {
  constructor(page, outlineLids) {
    this.events = [];
    this.pending = new Set();
    this.outlineLids = outlineLids;
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/")) return;
      const pending = (async () => {
        let responseBytes = Number(response.headers()["content-length"] ?? 0);
        if (!Number.isFinite(responseBytes) || responseBytes <= 0) {
          try {
            responseBytes = (await response.body()).byteLength;
          } catch {
            responseBytes = 0;
          }
        }
        const endpoint = url.pathname.replace(/^\/api/, "");
        const lid = url.searchParams.get("lid");
        let category = "other";
        if (endpoint === "/book/text") {
          category = lid && this.outlineLids.has(lid)
            ? "outline-text"
            : url.searchParams.get("end") ? "leaf-text-range" : "leaf-text-singular";
        }
        else if (endpoint === "/book/formula_semantics_range") category = "formula-semantics-range";
        else if (endpoint === "/book/formula_semantics") category = "formula-semantics-singular";
        else if (endpoint.startsWith("/reader/")) category = "reader";
        this.events.push({
          started_at_epoch_ms: response.request().timing().startTime,
          method: response.request().method(),
          endpoint,
          category,
          lid,
          status: response.status(),
          response_bytes: responseBytes,
        });
      })();
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending));
    });
  }

  reset() {
    this.events = [];
  }

  async take(firstSegmentEpochMs) {
    await Promise.allSettled([...this.pending]);
    const events = this.events.sort((left, right) => left.started_at_epoch_ms - right.started_at_epoch_ms);
    this.events = [];
    const byEndpoint = {};
    const byCategory = {};
    let responseBytes = 0;
    for (const event of events) {
      increment(byEndpoint, event.endpoint);
      increment(byCategory, event.category);
      responseBytes += event.response_bytes;
    }
    const before = firstSegmentEpochMs === null
      ? null
      : events.filter((event) => event.started_at_epoch_ms <= firstSegmentEpochMs);
    const samples = events.length <= REQUEST_SAMPLE_LIMIT
      ? events
      : events.slice(events.length - REQUEST_SAMPLE_LIMIT);
    return {
      total: events.length,
      response_bytes: responseBytes,
      by_endpoint: byEndpoint,
      by_category: byCategory,
      samples: {
        limit: REQUEST_SAMPLE_LIMIT,
        observed: events.length,
        dropped: Math.max(0, events.length - REQUEST_SAMPLE_LIMIT),
        values: samples,
      },
      before_first_segment: before === null
        ? null
        : {
            total: before.length,
            outline_text: before.filter((event) => event.category === "outline-text").length,
            by_endpoint: before.reduce((acc, event) => {
              increment(acc, event.endpoint);
              return acc;
            }, {}),
            by_category: before.reduce((acc, event) => {
              increment(acc, event.category);
              return acc;
            }, {}),
          },
    };
  }
}

async function dataLidCount(page) {
  return page.locator(".reader-pane [data-lid]").count();
}

async function mountedRange(page, book) {
  const lids = await page.locator(".reader-pane [data-lid]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.lid ?? ""));
  const first = lids[0] || null;
  const last = lids.at(-1) || null;
  const indexes = lids.map((lid) => book.leaf_lids.indexOf(lid));
  const canonicalOrderOk = indexes.every((index, position) => (
    index >= 0 && (position === 0 || index === indexes[position - 1] + 1)
  ));
  return {
    count: lids.length,
    first,
    last,
    first_index: first === null ? -1 : book.leaf_lids.indexOf(first),
    last_index: last === null ? -1 : book.leaf_lids.indexOf(last),
    lids,
    canonical_order_ok: canonicalOrderOk,
  };
}

async function waitForStableMountedRange(page, book) {
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(50);
    const range = await mountedRange(page, book);
    const current = `${range.first ?? ""}:${range.last ?? ""}:${range.count}`;
    if (current === previous) stable += 1;
    else stable = 0;
    if (stable >= 3) return range;
    previous = current;
  }
  throw new Error("reader mounted LID range did not settle");
}

async function loadThrough(page, baseUrl, book, targetLeaf) {
  const pane = page.locator(".reader-pane");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const unsettled = await readerEdgeLoadCounters(page);
    const edgeBefore = await waitForReaderEdgeLoadQuiescence(
      page,
      unsettled,
      `before-load-through-${targetLeaf}`,
    );
    const before = await mountedRange(page, book);
    if (before.last_index + 1 >= targetLeaf) return;
    await pane.evaluate((element) => {
      const sentinel = element.querySelector(".reader-edge-sentinel-bottom");
      if (!sentinel) throw new Error("reader bottom sentinel is unavailable");
      const paneRect = element.getBoundingClientRect();
      const sentinelRect = sentinel.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
      element.scrollTop += sentinelRect.top - paneRect.top - element.clientHeight * 0.8;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitForReaderEdgeLoadCompletion(
      page,
      edgeBefore,
      `load-through-${targetLeaf}`,
    );
    const settled = await waitForSettledReaderSurface(
      page,
      baseUrl,
      book,
      `load-through-${targetLeaf}`,
    );
    if (settled.range.last_index <= before.last_index) {
      throw new Error(`edge load did not advance from ${before.last ?? "empty"}`);
    }
  }
  throw new Error(`reader did not reach leaf ${targetLeaf}`);
}

async function positionAtRatio(page, book, ratio) {
  const pane = page.locator(".reader-pane");
  await pane.evaluate((element, nextRatio) => {
    const nodes = [...element.querySelectorAll("[data-lid]")];
    const target = nodes[Math.min(nodes.length - 1, Math.floor(nodes.length * nextRatio))];
    if (!target) return;
    const paneRect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    element.scrollTop += targetRect.top - paneRect.top - element.clientHeight * nextRatio;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, ratio);
  await waitForStableMountedRange(page, book);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function readerState(page, baseUrl) {
  const response = await page.request.post(`${baseUrl}/api/reader/state`, { data: {} });
  if (!response.ok()) throw new Error(`reader.state failed: ${response.status()}`);
  return response.json();
}

async function readerEdgeLoadCounters(page) {
  const counters = await page.evaluate((name) => {
    const edgeLoad = window[name]?.snapshot("edge-load-counters")?.edge_load;
    if (!edgeLoad) return null;
    return {
      started: edgeLoad.started,
      completed: edgeLoad.completed,
      failed: edgeLoad.failed,
    };
  }, PERFORMANCE_GLOBAL);
  if (!counters) throw new Error("reader edge-load diagnostics are unavailable");
  return counters;
}

async function readerEdgeFailureContext(page) {
  try {
    return await page.evaluate(async (name) => {
      const mountedLids = [...document.querySelectorAll(".reader-pane [data-lid]")]
        .map((node) => node.dataset.lid)
        .filter(Boolean);
      const response = await fetch("/api/reader/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const state = response.ok ? await response.json() : null;
      return {
        page_url: location.href,
        banner: document.querySelector(".banner")?.textContent?.trim() ?? null,
        mounted: {
          first: mountedLids[0] ?? null,
          last: mountedLids.at(-1) ?? null,
          count: mountedLids.length,
        },
        server_status: response.status,
        server: state?.viewport ?? null,
        edge_load: window[name]?.snapshot("edge-failure-context")?.edge_load ?? null,
      };
    }, PERFORMANCE_GLOBAL);
  } catch (error) {
    return {
      capture_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function throwReaderEdgeLoadFailure(page, label, baseline, completed) {
  const context = await readerEdgeFailureContext(page);
  throw new Error(readerEdgeLoadFailureMessage({ label, baseline, completed, context }));
}

async function waitForReaderEdgeLoadQuiescence(page, baseline, label) {
  await page.waitForFunction(
    (name) => {
      const edgeLoad = window[name]?.snapshot("edge-load-quiescence")?.edge_load;
      return edgeLoad && edgeLoad.started === edgeLoad.completed + edgeLoad.failed;
    },
    PERFORMANCE_GLOBAL,
    { polling: 50, timeout: READER_ASYNC_SETTLEMENT_TIMEOUT_MS },
  );
  const completed = await readerEdgeLoadCounters(page);
  if (completed.failed > baseline.failed) {
    await throwReaderEdgeLoadFailure(page, label, baseline, completed);
  }
  return completed;
}

async function waitForReaderEdgeLoadCompletion(page, baseline, label) {
  await page.waitForFunction(
    ({ globalName, baselineStarted }) => {
      const edgeLoad = window[globalName]?.snapshot("edge-load-completion")?.edge_load;
      if (!edgeLoad) return false;
      return edgeLoad.started > baselineStarted
        && edgeLoad.started === edgeLoad.completed + edgeLoad.failed;
    },
    { globalName: PERFORMANCE_GLOBAL, baselineStarted: baseline.started },
    { polling: 50, timeout: READER_ASYNC_SETTLEMENT_TIMEOUT_MS },
  );
  const completed = await readerEdgeLoadCounters(page);
  if (completed.failed > baseline.failed) {
    await throwReaderEdgeLoadFailure(page, label, baseline, completed);
  }
  return completed;
}

async function readerSurfaceSample(page, baseUrl, book) {
  const range = await mountedRange(page, book);
  const state = await readerState(page, baseUrl);
  const edgeLoad = await page.evaluate((name) => (
    window[name]?.snapshot("correctness-settlement")?.edge_load ?? null
  ), PERFORMANCE_GLOBAL);
  const settlement = inspectReaderSurfaceSettlement({
    mountedLids: range.lids,
    serverLids: state.viewport.visible_lids,
    leafLids: book.leaf_lids,
    edgeLoad,
  });
  return { range, state, edge_load: edgeLoad, settlement };
}

async function waitForSettledReaderSurface(page, baseUrl, book, label) {
  const started = Date.now();
  let previousSignature = "";
  let stableSamples = 0;
  let sample = null;
  while (Date.now() - started <= READER_ASYNC_SETTLEMENT_TIMEOUT_MS) {
    sample = await readerSurfaceSample(page, baseUrl, book);
    const signature = JSON.stringify({
      mounted: sample.range.lids,
      server: sample.state.viewport.visible_lids,
      edge_load: sample.edge_load,
    });
    if (sample.settlement.passed && signature === previousSignature) stableSamples += 1;
    else stableSamples = sample.settlement.passed ? 1 : 0;
    if (stableSamples >= 3) return sample;
    previousSignature = signature;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} server viewport did not settle with mounted DOM: ${JSON.stringify({
    mounted: sample?.range.lids ?? [],
    server: sample?.state.viewport.visible_lids ?? [],
    server_indexes: sample?.settlement.server_indexes ?? [],
    edge_load: sample?.edge_load ?? null,
  })}`);
}

async function openReaderAtStart(page, baseUrl, book) {
  const reset = await page.request.post(`${baseUrl}/api/reader/goto`, {
    data: { lid: book.first_lid },
  });
  if (!reset.ok()) throw new Error(`reader.goto(first) failed: ${reset.status()}`);
  await page.goto(`${baseUrl}/?${navigationQuery}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.locator(".reader-pane").waitFor({ state: "visible", timeout: 60_000 });
  const initialStarted = Date.now();
  while ((await mountedRange(page, book)).last_index < 19) {
    if (Date.now() - initialStarted > 60_000) throw new Error("initial reader window did not render");
    await page.waitForTimeout(50);
  }
  if (!(await page.locator(".debug-panel").isVisible())) {
    await page.getByRole("button", { name: "调试", exact: true }).click();
  }
  await page.locator(".debug-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function triggerEdge(page, baseUrl, book, direction) {
  const before = await mountedRange(page, book);
  if (
    (direction === "down" && before.last_index === book.leaves - 1)
    || (direction === "up" && before.first_index === 0)
  ) return before;
  const edgeBefore = await readerEdgeLoadCounters(page);
  await page.locator(".reader-pane").evaluate((element, nextDirection) => {
    const selector = nextDirection === "down"
      ? ".reader-edge-sentinel-bottom"
      : ".reader-edge-sentinel-top";
    const sentinel = element.querySelector(selector);
    if (!sentinel) throw new Error(`reader ${nextDirection} sentinel is unavailable`);
    const paneRect = element.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const ratio = nextDirection === "down" ? 0.8 : 0.2;
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: nextDirection === "down" ? 1 : -1,
    }));
    element.scrollTop += sentinelRect.top - paneRect.top - element.clientHeight * ratio;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, direction);
  try {
    await waitForReaderEdgeLoadCompletion(
      page,
      edgeBefore,
      `correctness-${direction}`,
    );
  } catch (error) {
    const state = await readerState(page, new URL(page.url()).origin).catch(() => null);
    const diagnostics = await page.evaluate((name) => ({
      banner: document.querySelector(".banner")?.textContent ?? null,
      edge_load: window[name]?.snapshot("edge-stall")?.edge_load ?? null,
    }), PERFORMANCE_GLOBAL);
    throw new Error(`reader ${direction} edge stalled at ${before.first}:${before.last}: ${JSON.stringify({
      server: state?.viewport?.visible_lids ?? null,
      ...diagnostics,
      cause: String(error),
    })}`);
  }
  const settled = await waitForSettledReaderSurface(
    page,
    baseUrl,
    book,
    `correctness-${direction}`,
  );
  const advanced = direction === "down"
    ? settled.range.last_index > before.last_index
    : settled.range.first_index < before.first_index;
  if (!advanced) throw new Error(`reader ${direction} edge did not advance from ${before.first}:${before.last}`);
  return settled.range;
}

async function driveToBoundary(page, baseUrl, book, direction) {
  let range = await mountedRange(page, book);
  for (let transition = 0; transition < 200; transition += 1) {
    const done = direction === "down"
      ? range.last_index === book.leaves - 1
      : range.first_index === 0;
    if (done) return range;
    range = await triggerEdge(page, baseUrl, book, direction);
  }
  throw new Error(`reader did not reach the ${direction === "down" ? "end" : "start"}`);
}

async function selectNativeText(page, lid) {
  const target = page.locator(`.reader-pane [data-lid="${lid}"]`);
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && (text.textContent?.trim().length ?? 0) < 8) text = walker.nextNode();
    if (!text) throw new Error("selection text node missing");
    const length = text.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(text, Math.min(1, length));
    range.setEnd(text, Math.min(8, length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.closest(".prose")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator(".hl-popover").waitFor({ state: "visible", timeout: 10_000 });
}

function expectedOutline(book, lid) {
  return book.active_tree
    .filter((node) => (
      (node.children.length > 0 || node.kind === "chapter" || node.kind === "section")
      && (lid === node.lid || lid.startsWith(`${node.lid}.`))
    ))
    .sort((left, right) => right.lid.length - left.lid.length)[0] ?? null;
}

async function surfaceConsistency(page, baseUrl, book, label) {
  await page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  const settled = await waitForSettledReaderSurface(page, baseUrl, book, label);
  const { range, state } = settled;
  if (!range.canonical_order_ok || range.count > 60) {
    throw new Error(`${label} DOM range is not canonical and bounded: ${JSON.stringify(range)}`);
  }
  const serverLids = state.viewport.visible_lids;
  const currentLid = (await page.locator(".debug-panel code").first().textContent())?.trim() ?? "";
  const currentIndex = book.leaf_lids.indexOf(currentLid);
  if (currentIndex < range.first_index || currentIndex > range.last_index) {
    throw new Error(`${label} current LID is outside the mounted range: ${currentLid}`);
  }
  const progressText = (await page.locator(".topbar .progress").textContent())?.trim() ?? "";
  const expectedProgress = Math.round(((currentIndex + 1) / book.leaves) * 100);
  if (progressText !== `${expectedProgress}%`) {
    throw new Error(`${label} progress mismatch: ${progressText} != ${expectedProgress}%`);
  }
  const outline = expectedOutline(book, currentLid);
  if (outline) {
    const activeTitle = (await page.locator(".outline-item.active .outline-title").textContent())?.trim();
    const breadcrumb = (await page.locator(".breadcrumb").textContent())?.trim();
    if (activeTitle !== outline.display_title || breadcrumb !== outline.display_title) {
      throw new Error(`${label} outline/breadcrumb mismatch for ${currentLid}`);
    }
  }
  return {
    label,
    current_lid: currentLid,
    progress_pct: expectedProgress,
    mounted: { first_lid: range.first, last_lid: range.last, count: range.count },
    server_viewport: {
      top_lid: state.viewport.top_lid,
      bottom_lid: state.viewport.bottom_lid,
      count: serverLids.length,
    },
    outline_lid: outline?.lid ?? null,
  };
}

async function gotoThroughUi(page, book, targetIndex) {
  const target = book.leaf_lids[targetIndex];
  await page.locator(".debug-goto input").fill(target);
  await page.locator(".debug-goto button").click();
  await page.locator(`.reader-pane [data-lid="${target}"]`).waitFor({ state: "visible", timeout: 15_000 });
  let topError = Number.POSITIVE_INFINITY;
  const started = Date.now();
  while (topError > 2) {
    topError = Math.abs(await page.locator(".reader-pane").evaluate((pane, lid) => {
      const node = pane.querySelector(`[data-lid="${lid}"]`);
      if (!node) return Number.POSITIVE_INFINITY;
      return node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    }, target));
    if (Date.now() - started > 10_000) throw new Error(`goto ${target} top error is ${topError}`);
    await page.waitForTimeout(50);
  }
  return { target_lid: target, top_error_px: topError };
}

async function recallAnnotations(page, baseUrl) {
  const response = await page.request.post(`${baseUrl}/api/memory/recall`, { data: {} });
  if (!response.ok()) throw new Error(`memory.recall failed: ${response.status()}`);
  return response.json();
}

async function deleteAnnotation(page, baseUrl, memId) {
  const response = await page.request.post(`${baseUrl}/api/memory/delete`, {
    data: { mem_id: memId },
  });
  if (!response.ok()) throw new Error(`memory.delete(${memId}) failed: ${response.status()}`);
}

async function runCorrectnessMatrix(page, baseUrl, book) {
  const startedAt = new Date().toISOString();
  const createdIds = [];
  try {
    await openReaderAtStart(page, baseUrl, book);
    const initial = await surfaceConsistency(page, baseUrl, book, "initial");
    const before = await recallAnnotations(page, baseUrl);
    const beforeIds = new Set(before.map((record) => record.mem_id));

    const highlightLid = book.leaf_lids[2];
    const noteLid = book.leaf_lids[3];
    await selectNativeText(page, highlightLid);
    await page.locator(".hl-popover button", { hasText: "高亮" }).click();
    const afterHighlight = await recallAnnotations(page, baseUrl);
    const createdHighlight = uniqueCreatedAnnotation(beforeIds, afterHighlight, "highlight");
    createdIds.push(createdHighlight.mem_id);
    const createdHighlightMark = page.locator(
      `[data-lid="${highlightLid}"] mark.hl-mark`,
      { hasText: createdHighlight.content },
    );
    await createdHighlightMark
      .waitFor({ state: "visible", timeout: 10_000 });

    await selectNativeText(page, noteLid);
    await page.locator(".hl-popover button", { hasText: "笔记" }).click();
    await page.locator(".note-modal").waitFor({ state: "visible", timeout: 10_000 });
    const noteMarker = `PHR9 ${book.book_id} ${Date.now()} ${"recycled Note body ".repeat(24)}`;
    await page.locator(".note-modal textarea").fill(noteMarker);
    await page.locator(".note-modal button", { hasText: "保存" }).click();
    const afterCreate = await recallAnnotations(page, baseUrl);
    const createdNote = uniqueCreatedAnnotation(
      new Set([...beforeIds, createdHighlight.mem_id]),
      afterCreate,
      "note",
    );
    createdIds.push(createdNote.mem_id);
    const noteCard = page.locator(".reader-pane .note-card", { hasText: noteMarker });
    await noteCard.waitFor({ state: "visible", timeout: 10_000 });
    if ((await noteCard.getAttribute("open")) === null) {
      await noteCard.locator(".note-fold").click();
    }
    await noteCard.waitFor({ state: "visible" });
    if ((await noteCard.getAttribute("open")) === null) throw new Error("Note did not enter open state");

    await driveToBoundary(page, baseUrl, book, "down");
    const end = await surfaceConsistency(page, baseUrl, book, "end");
    if (end.mounted.last_lid !== book.last_lid) throw new Error("downward replay missed the final LID");
    await driveToBoundary(page, baseUrl, book, "up");
    const returned = await surfaceConsistency(page, baseUrl, book, "returned");
    if (returned.mounted.first_lid !== book.first_lid) throw new Error("upward replay missed the first LID");

    await createdHighlightMark
      .waitFor({ state: "visible", timeout: 10_000 });
    const returnedNote = page.locator(".reader-pane .note-card", { hasText: noteMarker });
    await returnedNote.waitFor({ state: "visible", timeout: 10_000 });
    if ((await returnedNote.getAttribute("open")) === null) {
      throw new Error("Note open state did not survive bidirectional recycling");
    }

    const sourcePreviewClose = page.getByRole("button", { name: "关闭来源预览" });
    if (await sourcePreviewClose.isVisible()) await sourcePreviewClose.click();
    const gotoMiddle = await gotoThroughUi(page, book, 1_499);
    const middle = await surfaceConsistency(page, baseUrl, book, "goto-middle");
    const gotoStart = await gotoThroughUi(page, book, 0);
    const final = await surfaceConsistency(page, baseUrl, book, "goto-start");
    return {
      passed: true,
      failures: [],
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      matrix: {
        native_selection: true,
        highlight_recycled: true,
        note_open_state_recycled: true,
        bidirectional_scroll: true,
        goto: [gotoMiddle, gotoStart],
        surfaces: [initial, end, returned, middle, final],
      },
    };
  } catch (error) {
    return {
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      matrix: null,
    };
  } finally {
    for (const memId of createdIds) {
      try {
        await deleteAnnotation(page, baseUrl, memId);
      } catch {
        // The failure remains visible through the isolated PHR9 memory directory.
      }
    }
  }
}

async function takeCheckpoint(page, ledger, book, targetLeaf) {
  const captured = await page.evaluate(({ globalName, label }) => {
    const control = window[globalName];
    if (!control) throw new Error("reader performance diagnostics are unavailable");
    return {
      time_origin_epoch_ms: performance.timeOrigin,
      snapshot: control.take(label),
    };
  }, { globalName: PERFORMANCE_GLOBAL, label: `leaf-${targetLeaf}` });
  const missing = missingSnapshotFields(captured.snapshot);
  if (missing.length) throw new Error(`leaf ${targetLeaf} missing diagnostics: ${missing.join(", ")}`);
  const firstSegmentEpoch = captured.snapshot.first_segment.at_ms === null
    ? null
    : captured.time_origin_epoch_ms + captured.snapshot.first_segment.at_ms;
  const requests = await ledger.take(firstSegmentEpoch);
  const lids = await mountedRange(page, book);
  if (captured.snapshot.dom.data_lid_nodes !== lids.count) {
    throw new Error(`app/DOM LID count mismatch: ${captured.snapshot.dom.data_lid_nodes} != ${lids.count}`);
  }
  return {
    target_leaf: targetLeaf,
    loaded_lids: lids.count,
    first_lid: lids.first,
    last_lid: lids.last,
    formula_lids_loaded: await page.locator(
      ".reader-pane .formula-open, .reader-pane .formula-inline-source",
    ).count(),
    scroll_ratio: SCROLL_RATIO,
    canonical_order_ok: lids.canonical_order_ok,
    diagnostics: captured.snapshot,
    requests,
    summary: {
      frame_interval_p95_ms: percentile(captured.snapshot.frames.interval_ms.values, 95),
      probe_self_p95_ms: percentile(captured.snapshot.probe.self_time_ms.values, 95),
      reader_long_tasks_over_50_ms: readerScrollLongTasks(captured.snapshot),
    },
  };
}

async function runBenchmark(page, ledger, baseUrl, book, runtime, phase, iteration) {
  const startedAt = new Date().toISOString();
  const tracePath = resolve(traceDir, `${runtime}-${phase}-${iteration}.zip`);
  mkdirSync(traceDir, { recursive: true });
  await page.context().tracing.start({ screenshots: false, snapshots: true, sources: false });
  let tracingActive = true;
  try {
    const gotoResponse = await page.request.post(`${baseUrl}/api/reader/goto`, {
      data: { lid: book.first_lid },
    });
    if (!gotoResponse.ok()) {
      throw new Error(`failed to reset real-book reader state: ${gotoResponse.status()}`);
    }
    ledger.reset();
    await page.goto(`${baseUrl}/?${navigationQuery}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".reader-pane").waitFor({ state: "visible", timeout: 60_000 });
    const initialStarted = Date.now();
    while (await dataLidCount(page) < 20) {
      if (Date.now() - initialStarted > 60_000) throw new Error("initial reader window did not render");
      await page.waitForTimeout(50);
    }
    const diagnosticsStarted = Date.now();
    while (!(await page.evaluate((name) => Boolean(window[name]), PERFORMANCE_GLOBAL))) {
      if (Date.now() - diagnosticsStarted > 10_000) throw new Error("diagnostics did not install");
      await page.waitForTimeout(50);
    }

    const checkpoints = [];
    for (const targetLeaf of CHECKPOINTS) {
      await loadThrough(page, baseUrl, book, targetLeaf);
      const beforePosition = await readerEdgeLoadCounters(page);
      await positionAtRatio(page, book, SCROLL_RATIO);
      await page.waitForTimeout(100);
      await waitForReaderEdgeLoadQuiescence(
        page,
        beforePosition,
        `position-at-${targetLeaf}`,
      );
      checkpoints.push(await takeCheckpoint(page, ledger, book, targetLeaf));
    }
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const version = runtime === "webview2"
      ? /Edg\/([\d.]+)/.exec(userAgent)?.[1] ?? "unknown"
      : /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "unknown";
    await page.context().tracing.stop({ path: tracePath });
    tracingActive = false;
    return {
      phase,
      iteration,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      runtime: { name: runtime, version, user_agent: userAgent },
      trace_file: relative(root, tracePath).replaceAll("\\", "/"),
      checkpoints,
    };
  } catch (error) {
    let traceFailure = null;
    if (tracingActive) {
      try {
        await page.context().tracing.stop({ path: tracePath });
        tracingActive = false;
      } catch (traceError) {
        traceFailure = traceError instanceof Error ? traceError.message : String(traceError);
      }
    }
    const cause = error instanceof Error ? error.message : String(error);
    const traceFile = relative(root, tracePath).replaceAll("\\", "/");
    throw new Error(`${cause}; failure_trace=${traceFile}${
      traceFailure ? `; trace_error=${traceFailure}` : ""
    }`);
  }
}

function structureSignature(run) {
  return run.checkpoints.map((checkpoint) => ({
    target_leaf: checkpoint.target_leaf,
    loaded_lids: checkpoint.loaded_lids,
    first_lid: checkpoint.first_lid,
    last_lid: checkpoint.last_lid,
    formula_lids_loaded: checkpoint.formula_lids_loaded,
    dom_lids: checkpoint.diagnostics.dom.data_lid_nodes,
    text_requests: checkpoint.requests.by_endpoint["/book/text"] ?? 0,
    formula_requests: checkpoint.requests.by_endpoint["/book/formula_semantics_range"] ?? 0,
  }));
}

const book = readBookShape();
if (
  book.nodes !== 2_757
  || book.leaves !== 2_623
  || book.formula_leaves !== 893
  || book.outline_nodes !== 134
) {
  throw new Error(`real-book shape drifted: ${JSON.stringify(book)}`);
}
if (!book.first_lid || !book.last_lid) throw new Error("real book has no terminal leaf LIDs");
const browser = runtimeMode === "webview2"
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({ headless: true });
const page = runtimeMode === "webview2"
  ? browser.contexts().flatMap((context) => context.pages())[0]
  : await browser.newPage({ viewport: { width: 1_440, height: 900 } });
if (!page) throw new Error(`no ${runtimeMode} page is available`);
const current = runtimeMode === "webview2" ? new URL(page.url()) : null;
const baseUrl = configuredBaseUrl ?? (current ? `${current.protocol}//${current.host}` : null);
if (!baseUrl) throw new Error("Chromium release replay requires --url <reader-origin>");
const activeManifestResponse = await page.request.get(`${baseUrl}/api/book/manifest`);
const activeSourceResponse = await page.request.get(`${baseUrl}/api/book/source_fingerprint`);
if (!activeManifestResponse.ok() || !activeSourceResponse.ok()) {
  throw new Error(`failed to verify the active ${runtimeMode} book`);
}
const activeManifest = await activeManifestResponse.json();
const activeSource = await activeSourceResponse.json();
const activeLeaves = activeManifest.tree.filter((node) => node.children.length === 0);
const activeFormulaLeaves = activeLeaves.filter((node) => node.kind === "formula");
const activeOutlineLids = new Set(activeManifest.tree
  .filter((node) =>
    node.children.length > 0 || node.kind === "chapter" || node.kind === "section")
  .map((node) => node.lid));
const missingActiveOutlineLids = [...book.outline_lids]
  .filter((lid) => !activeOutlineLids.has(lid));
const unexpectedActiveOutlineLids = [...activeOutlineLids]
  .filter((lid) => !book.outline_lids.has(lid));
if (
  activeSource.book_id !== book.book_id
  || activeManifest.tree.length !== book.nodes
  || activeLeaves.length !== book.leaves
  || activeFormulaLeaves.length !== book.formula_leaves
  || activeOutlineLids.size !== book.outline_nodes
  || missingActiveOutlineLids.length > 0
  || unexpectedActiveOutlineLids.length > 0
) {
  throw new Error(`${runtimeMode} active-book shape mismatch: ${JSON.stringify({
    book_id: activeSource.book_id,
    nodes: activeManifest.tree.length,
    leaves: activeLeaves.length,
    formula_leaves: activeFormulaLeaves.length,
    outline_nodes: activeOutlineLids.size,
    missing_outline_lids: missingActiveOutlineLids.slice(0, 10),
    unexpected_outline_lids: unexpectedActiveOutlineLids.slice(0, 10),
  })}`);
}
book.active_tree = activeManifest.tree;
const correctness = skipCorrectness
  ? { passed: true, failures: [], skipped: true, matrix: null }
  : await runCorrectnessMatrix(page, baseUrl, book);
const ledger = new RequestLedger(page, book.outline_lids);
const runs = [];
if (!correctnessOnly && correctness.passed) {
  for (let iteration = 1; iteration <= WARM_UP_RUNS; iteration += 1) {
    runs.push(await runBenchmark(page, ledger, baseUrl, book, runtimeMode, "warm-up", iteration));
    process.stdout.write(`${runtimeMode} warm-up ${iteration}/${WARM_UP_RUNS} complete\n`);
  }
  for (let iteration = 1; iteration <= MEASURED_RUNS; iteration += 1) {
    runs.push(await runBenchmark(page, ledger, baseUrl, book, runtimeMode, "measured", iteration));
    process.stdout.write(`${runtimeMode} measured ${iteration}/${MEASURED_RUNS} complete\n`);
  }
}
const measured = runs.filter((run) => run.phase === "measured");
const structureSignatures = measured.map(structureSignature);
const signature = structureSignatures[0] ?? null;
const structureConsistent = structureSignatures.every((candidate) =>
  JSON.stringify(candidate) === JSON.stringify(signature));
for (const run of runs) {
  const last = run.checkpoints.at(-1);
  if (
    last?.last_lid !== book.last_lid
    || last.loaded_lids > 60
    || !last.canonical_order_ok
  ) {
    throw new Error(
      `${runtimeMode} run did not reach the real-book terminal shape: ${JSON.stringify(last)}`,
    );
  }
}
for (const run of runs) {
  const first = run.checkpoints[0];
  if (first.diagnostics.first_segment.count !== 1) {
    throw new Error("first-segment diagnostic did not fire exactly once");
  }
  if (first.requests.before_first_segment?.outline_text !== 0) {
    throw new Error(`request ledger misclassified first-segment outline text: ${JSON.stringify({
      phase: run.phase,
      iteration: run.iteration,
      expected: 0,
      actual: first.requests.before_first_segment?.outline_text ?? null,
    })}`);
  }
}

const cpuList = cpus();
const report = {
  schema_version: REPORT_VERSION,
  generated_at: new Date().toISOString(),
  revision: git(["rev-parse", "--short=7", "HEAD"]),
  working_tree_dirty: git(["status", "--short"]).length > 0,
  fixture: {
    fixture_id: `real-book:${book.book_id}`,
    nodes: book.nodes,
    leaves: book.leaves,
    formula_leaves: book.formula_leaves,
    outline_nodes: book.outline_nodes,
    viewport_width: 20,
    checkpoints: CHECKPOINTS,
    scroll_ratio: SCROLL_RATIO,
  },
  runtime: runtimeMode,
  flags: Object.fromEntries(new URLSearchParams(navigationQuery)),
  correctness,
  sampling: {
    warm_up_runs: WARM_UP_RUNS,
    measured_runs: MEASURED_RUNS,
    timing_unit: "ms",
    raw_samples_preserved: true,
  },
  machine: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu_model: cpuList[0]?.model ?? "unknown",
    logical_cpus: cpuList.length,
    total_memory_bytes: totalmem(),
  },
  runs,
  structure_signature: signature,
  structure_consistent: structureConsistent,
  structure_signatures: structureSignatures,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (Buffer.byteLength(json, "utf8") > MAX_REPORT_BYTES) {
  throw new Error(`WebView2 report exceeded ${MAX_REPORT_BYTES} bytes`);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, json, "utf8");
await browser.close();
process.stdout.write(`${output}\n`);
if (!correctness.passed) process.exitCode = 1;
