import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  readerPerformanceSnapshotMissingFields,
  READER_PERFORMANCE_GLOBAL,
  type BoundedSamples,
  type ReaderPerformanceSnapshotV1,
} from "../src/reader-performance";

const REPORT_VERSION = "reader-performance-phr4.v1" as const;
const FIXTURE_ID = "reader-2623-leaves-893-formulas.v1";
const LEAF_COUNT = 2_623;
const FORMULA_LEAF_COUNT = 893;
const OUTLINE_NODE_COUNT = 134;
const OUTLINE_SCALE_COUNTS = [40, 134, 292] as const;
const VIEWPORT_WIDTH = 20;
const CHECKPOINTS = [20, 500, 1_000, 2_623] as const;
const SCROLL_RATIO = 0.8;
const WARM_UP_RUNS = Number(process.env.READER_PERF_WARM_UP_RUNS ?? "2");
const MEASURED_RUNS = Number(process.env.READER_PERF_MEASURED_RUNS ?? "5");
const REQUEST_SAMPLE_LIMIT = 512;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

type NodeKind = "chapter" | "paragraph" | "formula";

interface FixtureNode {
  lid: string;
  display_title: string;
  children: string[];
  span: { start: number; end: number };
  kind: NodeKind;
}

interface ReaderFixture {
  tree: FixtureNode[];
  leafLids: string[];
  formulaLids: Set<string>;
  outlineLids: Set<string>;
  textByLid: Map<string, string>;
  source: string;
}

interface RequestEvent {
  started_at_epoch_ms: number;
  method: string;
  endpoint: string;
  category: string;
  lid: string | null;
  status: number;
  response_bytes: number;
}

interface RequestSnapshot {
  total: number;
  response_bytes: number;
  by_endpoint: Record<string, number>;
  by_category: Record<string, number>;
  samples: BoundedSamples<RequestEvent>;
  before_first_segment: null | {
    total: number;
    outline_text: number;
    by_endpoint: Record<string, number>;
    by_category: Record<string, number>;
  };
}

interface CheckpointReport {
  target_leaf: number;
  loaded_lids: number;
  first_lid: string | null;
  last_lid: string | null;
  formula_lids_loaded: number;
  scroll_ratio: number;
  canonical_order_ok: boolean;
  diagnostics: ReaderPerformanceSnapshotV1;
  requests: RequestSnapshot;
  summary: {
    frame_interval_p95_ms: number | null;
    probe_self_p95_ms: number | null;
    reader_long_tasks_over_50_ms: number;
  };
}

interface RunReport {
  phase: "warm-up" | "measured";
  iteration: number;
  started_at: string;
  finished_at: string;
  runtime: {
    name: "chromium";
    version: string;
    user_agent: string;
  };
  checkpoints: CheckpointReport[];
}

interface BaselineReport {
  schema_version: typeof REPORT_VERSION;
  generated_at: string;
  revision: string;
  working_tree_dirty: boolean;
  fixture: {
    fixture_id: string;
    nodes: number;
    leaves: number;
    formula_leaves: number;
    outline_nodes: number;
    viewport_width: number;
    checkpoints: number[];
    scroll_ratio: number;
  };
  sampling: {
    warm_up_runs: number;
    measured_runs: number;
    timing_unit: "ms";
    raw_samples_preserved: true;
  };
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpu_model: string;
    logical_cpus: number;
    total_memory_bytes: number;
  };
  runs: RunReport[];
  structure_signature: unknown;
}

function buildFixture(outlineNodeCount = OUTLINE_NODE_COUNT): ReaderFixture {
  const formulaIndexes = new Set(
    Array.from({ length: FORMULA_LEAF_COUNT }, (_, index) =>
      Math.floor((index * LEAF_COUNT) / FORMULA_LEAF_COUNT) + 1),
  );
  const tree: FixtureNode[] = [];
  const leafLids: string[] = [];
  const formulaLids = new Set<string>();
  const outlineLids = new Set<string>();
  const textByLid = new Map<string, string>();
  const leavesByChapter = new Map<number, FixtureNode[]>();
  let source = "";
  let offset = 0;

  for (let leafIndex = 1; leafIndex <= LEAF_COUNT; leafIndex += 1) {
    const chapterIndex = Math.floor(((leafIndex - 1) * outlineNodeCount) / LEAF_COUNT) + 1;
    const chapterLeaves = leavesByChapter.get(chapterIndex) ?? [];
    const lid = `${chapterIndex}.${chapterLeaves.length + 1}`;
    const formula = formulaIndexes.has(leafIndex);
    const text = formula
      ? `$x_{${leafIndex}} = ${leafIndex}^2 + \\sqrt{${leafIndex}}$`
      : `Leaf ${leafIndex}. ${"Deterministic reader performance fixture text keeps the initial twenty leaves taller than the preload boundary. ".repeat(5)}`;
    const node: FixtureNode = {
      lid,
      display_title: text.slice(0, 80),
      children: [],
      span: { start: offset, end: offset + text.length },
      kind: formula ? "formula" : "paragraph",
    };
    offset += text.length;
    chapterLeaves.push(node);
    leavesByChapter.set(chapterIndex, chapterLeaves);
    leafLids.push(lid);
    textByLid.set(lid, text);
    source += text;
    if (formula) formulaLids.add(lid);
  }

  for (let chapterIndex = 1; chapterIndex <= outlineNodeCount; chapterIndex += 1) {
    const leaves = leavesByChapter.get(chapterIndex) ?? [];
    const lid = String(chapterIndex);
    const title = `# Deterministic chapter ${chapterIndex}`;
    outlineLids.add(lid);
    textByLid.set(lid, title);
    tree.push({
      lid,
      display_title: `Deterministic chapter ${chapterIndex}`,
      children: leaves.map((leaf) => leaf.lid),
      span: {
        start: leaves[0]?.span.start ?? 0,
        end: leaves.at(-1)?.span.end ?? 0,
      },
      kind: "chapter",
    });
    tree.push(...leaves);
  }

  if (tree.length !== LEAF_COUNT + outlineNodeCount) {
    throw new Error(`fixture node count drifted: ${tree.length}`);
  }
  if (formulaLids.size !== FORMULA_LEAF_COUNT) {
    throw new Error(`fixture formula count drifted: ${formulaLids.size}`);
  }
  return { tree, leafLids, formulaLids, outlineLids, textByLid, source };
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

class RequestLedger {
  private events: RequestEvent[] = [];
  private fixture: ReaderFixture;

  constructor(fixture: ReaderFixture) {
    this.fixture = fixture;
  }

  record(route: Route, status: number, body: string | Buffer): void {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace(/^\/api/, "");
    const lid = url.searchParams.get("lid");
    const endLid = url.searchParams.get("end");
    let category = "other";
    if (endpoint === "/book/text") {
      category = lid && this.fixture.outlineLids.has(lid)
        ? "outline-text"
        : endLid ? "leaf-text-range" : "leaf-text-singular";
    } else if (endpoint === "/book/formula_semantics_range") category = "formula-semantics-range";
    else if (endpoint === "/book/formula_semantics") category = "formula-semantics-singular";
    else if (endpoint.startsWith("/reader/")) category = "reader";
    this.events.push({
      started_at_epoch_ms: Date.now(),
      method: request.method(),
      endpoint,
      category,
      lid,
      status,
      response_bytes: Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body, "utf8"),
    });
  }

  take(firstSegmentEpochMs: number | null): RequestSnapshot {
    const events = this.events;
    this.events = [];
    const byEndpoint: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let responseBytes = 0;
    for (const event of events) {
      increment(byEndpoint, event.endpoint);
      increment(byCategory, event.category);
      responseBytes += event.response_bytes;
    }
    const before = firstSegmentEpochMs === null
      ? null
      : events.filter((event) => event.started_at_epoch_ms <= firstSegmentEpochMs);
    const sampled = events.length <= REQUEST_SAMPLE_LIMIT
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
        values: sampled,
      },
      before_first_segment: before === null
        ? null
        : {
            total: before.length,
            outline_text: before.filter((event) => event.category === "outline-text").length,
            by_endpoint: before.reduce<Record<string, number>>((acc, event) => {
              increment(acc, event.endpoint);
              return acc;
            }, {}),
            by_category: before.reduce<Record<string, number>>((acc, event) => {
              increment(acc, event.category);
              return acc;
            }, {}),
          },
    };
  }
}

function profileMemory() {
  return {
    current_book_id: "reader-perf-fixture",
    status: {
      document_revision: 1,
      projection_revision: 1,
      profile_status: "current",
      pending_sensitive_confirmation: false,
      pending_review_jobs: 0,
      review_error: null,
    },
    snapshot: {
      source_revision: 1,
      profile_status: "current",
      global_core: [],
      applicable_global: [],
      book_state_core: [],
      profile_projection: [],
      pending_context: [],
    },
    facts: [],
    pending_candidates: [],
    evidence: [],
    collection_rules: [],
  };
}

async function installFixture(page: Page, fixture: ReaderFixture): Promise<RequestLedger> {
  const ledger = new RequestLedger(fixture);
  const sourceFingerprint = "f".repeat(64);
  const profile = {
    profile_id: "technical_learning",
    profile_version: "reader-perf-v1",
    ui_slots: [],
    layout_presets: [],
    allowed_layout_actions: [],
    agent_tools: [],
  };
  const viewportAt = (topIndex: number) => {
    const maximumTop = Math.max(0, fixture.leafLids.length - VIEWPORT_WIDTH);
    const clampedTop = Math.max(0, Math.min(topIndex, maximumTop));
    const visibleLids = fixture.leafLids.slice(clampedTop, clampedTop + VIEWPORT_WIDTH);
    return {
      anchor_lid: visibleLids[Math.floor(visibleLids.length / 2)] ?? visibleLids[0],
      top_lid: visibleLids[0],
      bottom_lid: visibleLids.at(-1),
      width: VIEWPORT_WIDTH,
      visible_lids: visibleLids,
    };
  };
  let readerTopIndex = 0;
  const readerState = {
    viewport: viewportAt(readerTopIndex),
    open_panels: [],
    selection: null,
    layout: {
      rev: 0,
      active_preset: null,
      open_slots: [],
      focused_slot: null,
      pinned_evidence: [],
      panel_sizes: {},
      slot_order: {},
    },
    profile,
  };
  const agentHistory = {
    active_session_id: "reader-perf-session",
    sessions: [{
      id: "reader-perf-session",
      title: "Reader performance fixture",
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z",
      turn_count: 0,
      turns: [],
    }],
    current: {
      id: "reader-perf-session",
      book_id: "reader-perf-fixture",
      title: "Reader performance fixture",
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z",
      turns: [],
    },
  };

  const fulfill = (route: Route, value: unknown, status = 200) => {
    const body = JSON.stringify(value);
    ledger.record(route, status, body);
    return route.fulfill({ status, contentType: "application/json", body });
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/desktop/status") {
      return fulfill(route, {
        desktop_host: false,
        active_book: true,
        book_dir: null,
        library_root: "",
        library_root_available: true,
      });
    }
    if (path === "/api/book/build_workbench") {
      return fulfill(route, {
        version: "build_workbench_snapshot.v1",
        book_id: "reader-perf-fixture",
        readiness: { route: "reader", status: "trusted_book", reasons: [], stages: {} },
        input: { manifest: null, fingerprint: null, ready: true },
        jobs: [],
        source_review: {
          report: null,
          unresolved: [],
          review_draft_markdown: null,
          decisions: null,
          ready_for_rerun: false,
        },
        operations: { warnings: [], permission_audit: [] },
      });
    }
    if (path === "/api/book/manifest") {
      return fulfill(route, { tree: fixture.tree, stats_by_lid: {} });
    }
    if (path === "/api/book/asset_manifest") {
      return fulfill(route, { version: "asset_manifest.v1", book_id: "reader-perf-fixture", images: [] });
    }
    if (path === "/api/book/source_fingerprint") {
      return fulfill(route, { book_id: "reader-perf-fixture", source_fingerprint: sourceFingerprint });
    }
    if (path === "/api/book/source_manifest") {
      return fulfill(route, {
        version: "source_manifest.v2",
        book_id: "reader-perf-fixture",
        canonical_source: {
          kind: "reconciled_markdown",
          path: "source.txt",
          citation_anchor: "lid",
          sha256: sourceFingerprint,
        },
        capabilities: {
          view_pdf: { status: "unavailable" },
          project_lid_to_pdf: { status: "unavailable" },
          resolve_pdf_selection: { status: "unavailable" },
          project_ranges_to_pdf: { status: "unavailable" },
        },
        alignment_quality: null,
      });
    }
    if (path === "/api/profile/manifest") {
      return fulfill(route, { ...profile, projections: [], guided_reading_policy: {}, defaults: {} });
    }
    if (path === "/api/profile/memory") return fulfill(route, profileMemory());
    if (path === "/api/profile/backfill") return fulfill(route, { sessions: [], jobs: [] });
    if (path === "/api/reader/state") return fulfill(route, readerState);
    if (path === "/api/reader/scroll") {
      const body = request.postDataJSON() as { delta?: number } | null;
      const delta = Number(body?.delta ?? 0);
      if (!Number.isInteger(delta)) {
        return fulfill(route, {
          error_code: "INVALID_DELTA",
          category: "validation",
          message: "delta must be an integer",
        }, 400);
      }
      readerTopIndex += delta;
      readerState.viewport = viewportAt(readerTopIndex);
      readerTopIndex = fixture.leafLids.indexOf(readerState.viewport.top_lid);
      return fulfill(route, { ok: true, viewport: readerState.viewport });
    }
    if (path === "/api/agent/history") return fulfill(route, agentHistory);
    if (path === "/api/build_intent/artifacts") return fulfill(route, { overlay: null });
    if (path === "/api/build_intent/usage.event") return fulfill(route, { accepted: true });
    if (path === "/api/memory/recall") return fulfill(route, []);
    if (path === "/api/book/text") {
      const lid = url.searchParams.get("lid") ?? "";
      const end = url.searchParams.get("end");
      if (end) {
        const first = fixture.tree.find((node) => node.lid === lid);
        const last = fixture.tree.find((node) => node.lid === end);
        const startIndex = fixture.leafLids.indexOf(lid);
        const endIndex = fixture.leafLids.indexOf(end);
        if (!first || !last || startIndex < 0 || endIndex < startIndex) {
          return fulfill(route, { error_code: "INVALID_LEAF_RANGE", category: "validation", message: `${lid}:${end}` }, 400);
        }
        return fulfill(route, {
          lid,
          end_lid: end,
          text: fixture.source.slice(first.span.start, last.span.end),
        });
      }
      const text = fixture.textByLid.get(lid);
      return text === undefined
        ? fulfill(route, { error_code: "NOT_FOUND", category: "not_found", message: lid }, 404)
        : fulfill(route, { lid, text });
    }
    if (path === "/api/book/formula_semantics") {
      const lid = url.searchParams.get("lid") ?? "";
      if (!fixture.formulaLids.has(lid)) {
        return fulfill(route, { error_code: "NOT_FOUND", category: "not_found", message: lid }, 404);
      }
      return fulfill(route, {
        formula_lid: lid,
        parameters: [],
        composition: { source_lid: lid, meaning: "deterministic formula", terms: [], evidence_lids: [lid] },
        context_links: [],
      });
    }
    if (path === "/api/book/formula_semantics_range") {
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? "";
      const startIndex = fixture.leafLids.indexOf(start);
      const endIndex = fixture.leafLids.indexOf(end);
      if (startIndex < 0 || endIndex < startIndex) {
        return fulfill(route, { error_code: "INVALID_LEAF_RANGE", category: "validation", message: `${start}:${end}` }, 400);
      }
      return fulfill(route, {
        start_lid: start,
        end_lid: end,
        items: fixture.leafLids.slice(startIndex, endIndex + 1)
          .filter((lid) => fixture.formulaLids.has(lid))
          .map((lid) => ({
            formula_lid: lid,
            parameters: [],
            composition: { source_lid: lid, meaning: "deterministic formula", terms: [], evidence_lids: [lid] },
            context_links: [],
          })),
      });
    }
    return fulfill(route, {
      error_code: "UNMOCKED",
      category: "internal",
      message: `Unmocked reader performance route: ${path}`,
    }, 500);
  });
  return ledger;
}

async function dataLidCount(page: Page): Promise<number> {
  return page.locator(".reader-pane [data-lid]").count();
}

interface MountedRange {
  count: number;
  first: string | null;
  last: string | null;
  firstIndex: number;
  lastIndex: number;
  lids: string[];
}

async function mountedRange(page: Page, fixture: ReaderFixture): Promise<MountedRange> {
  const lids = await page.locator(".reader-pane [data-lid]")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.lid ?? ""));
  const first = lids[0] || null;
  const last = lids.at(-1) || null;
  return {
    count: lids.length,
    first,
    last,
    firstIndex: first === null ? -1 : fixture.leafLids.indexOf(first),
    lastIndex: last === null ? -1 : fixture.leafLids.indexOf(last),
    lids,
  };
}

async function waitForStableMountedRange(page: Page, fixture: ReaderFixture): Promise<MountedRange> {
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(50);
    const current = await mountedRange(page, fixture);
    const identity = `${current.first ?? ""}:${current.last ?? ""}:${current.count}`;
    if (identity === previous) stable += 1;
    else stable = 0;
    if (stable >= 3) return current;
    previous = identity;
  }
  throw new Error("reader mounted LID range did not settle");
}

async function loadThrough(page: Page, fixture: ReaderFixture, targetLeaf: number): Promise<void> {
  const pane = page.locator(".reader-pane");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const before = await mountedRange(page, fixture);
    if (before.lastIndex + 1 >= targetLeaf) return;
    await pane.evaluate((element) => {
      const sentinel = element.querySelector<HTMLElement>(".reader-edge-sentinel-bottom");
      if (!sentinel) throw new Error("reader bottom sentinel is unavailable");
      const paneRect = element.getBoundingClientRect();
      const sentinelRect = sentinel.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: 1,
      }));
      element.scrollTop += sentinelRect.top - paneRect.top - element.clientHeight * 0.8;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(
      async () => (await mountedRange(page, fixture)).lastIndex,
      { timeout: 15_000 },
    ).toBeGreaterThan(before.lastIndex);
  }
  throw new Error(`reader did not reach leaf ${targetLeaf}`);
}

async function positionAtRatio(page: Page, fixture: ReaderFixture, ratio: number): Promise<void> {
  const pane = page.locator(".reader-pane");
  await pane.evaluate((element, nextRatio) => {
    const nodes = [...element.querySelectorAll<HTMLElement>("[data-lid]")];
    const target = nodes[Math.min(nodes.length - 1, Math.floor(nodes.length * nextRatio))];
    if (!target) return;
    const paneRect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    element.scrollTop += targetRect.top - paneRect.top - element.clientHeight * nextRatio;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, ratio);
  await waitForStableMountedRange(page, fixture);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function readerScrollLongTasks(snapshot: ReaderPerformanceSnapshotV1): number {
  const intervals = snapshot.edge_load.samples.values;
  return snapshot.long_tasks.samples.values.filter((sample) => (
    sample.duration_ms > 50
    && intervals.some((interval) => (
      sample.start_ms < interval.end_ms
      && sample.start_ms + sample.duration_ms > interval.start_ms
    ))
  )).length;
}

async function takeCheckpoint(
  page: Page,
  ledger: RequestLedger,
  fixture: ReaderFixture,
  targetLeaf: number,
): Promise<CheckpointReport> {
  const captured = await page.evaluate(({ globalName, label }) => {
    const control = (window as any)[globalName];
    if (!control) throw new Error("reader performance diagnostics are unavailable");
    return {
      time_origin_epoch_ms: performance.timeOrigin,
      snapshot: control.take(label),
    };
  }, { globalName: READER_PERFORMANCE_GLOBAL, label: `leaf-${targetLeaf}` }) as {
    time_origin_epoch_ms: number;
    snapshot: ReaderPerformanceSnapshotV1;
  };
  const missing = readerPerformanceSnapshotMissingFields(captured.snapshot);
  expect(missing, `leaf ${targetLeaf} diagnostic fields`).toEqual([]);
  const firstSegmentEpoch = captured.snapshot.first_segment.at_ms === null
    ? null
    : captured.time_origin_epoch_ms + captured.snapshot.first_segment.at_ms;
  const requests = ledger.take(firstSegmentEpoch);
  const lids = await mountedRange(page, fixture);
  const formulaLoaded = await page.locator(".reader-pane .formula-open, .reader-pane .formula-inline-source").count();
  const canonicalOrderOk = lids.lids.every((lid, index) => (
    index === 0
    || fixture.leafLids.indexOf(lid) === fixture.leafLids.indexOf(lids.lids[index - 1]!) + 1
  ));
  expect(canonicalOrderOk).toBe(true);
  expect(captured.snapshot.dom.data_lid_nodes).toBe(lids.count);
  expect(captured.snapshot.dom.mounted_lids).toBe(lids.count);
  expect(formulaLoaded).toBe(
    lids.lids.filter((lid) => fixture.formulaLids.has(lid)).length,
  );
  expect(lids.count).toBeLessThanOrEqual(3 * VIEWPORT_WIDTH);
  expect(captured.snapshot.dom.max_mounted_lids).toBeLessThanOrEqual(4 * VIEWPORT_WIDTH);
  expect(captured.snapshot.dom.max_data_lid_nodes).toBeLessThanOrEqual(4 * VIEWPORT_WIDTH);
  return {
    target_leaf: targetLeaf,
    loaded_lids: lids.count,
    first_lid: lids.first,
    last_lid: lids.last,
    formula_lids_loaded: formulaLoaded,
    scroll_ratio: SCROLL_RATIO,
    canonical_order_ok: canonicalOrderOk,
    diagnostics: captured.snapshot,
    requests,
    summary: {
      frame_interval_p95_ms: percentile(captured.snapshot.frames.interval_ms.values, 95),
      probe_self_p95_ms: percentile(captured.snapshot.probe.self_time_ms.values, 95),
      reader_long_tasks_over_50_ms: readerScrollLongTasks(captured.snapshot),
    },
  };
}

async function runBenchmark(
  browser: Browser,
  fixture: ReaderFixture,
  phase: RunReport["phase"],
  iteration: number,
): Promise<RunReport> {
  const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
  const page = await context.newPage();
  const ledger = await installFixture(page, fixture);
  const startedAt = new Date().toISOString();
  await page.goto("/?readerPerf=1");
  await expect(page.locator(".reader-pane")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => dataLidCount(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(VIEWPORT_WIDTH);
  await expect.poll(() => page.evaluate((name) => Boolean((window as any)[name]), READER_PERFORMANCE_GLOBAL))
    .toBe(true);

  const checkpoints: CheckpointReport[] = [];
  for (const targetLeaf of CHECKPOINTS) {
    await loadThrough(page, fixture, targetLeaf);
    await positionAtRatio(page, fixture, SCROLL_RATIO);
    checkpoints.push(await takeCheckpoint(page, ledger, fixture, targetLeaf));
  }
  expect(checkpoints.at(-1)?.loaded_lids).toBeLessThanOrEqual(3 * VIEWPORT_WIDTH);
  expect(checkpoints.at(-1)?.last_lid).toBe(fixture.leafLids.at(-1));
  const runtime = {
    name: "chromium" as const,
    version: browser.version(),
    user_agent: await page.evaluate(() => navigator.userAgent),
  };
  await context.close();
  return {
    phase,
    iteration,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runtime,
    checkpoints,
  };
}

function structureSignature(run: RunReport): unknown {
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

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: resolve(process.cwd(), "../.."),
    encoding: "utf8",
  }).trim();
}

for (const outlineNodeCount of OUTLINE_SCALE_COUNTS) {
  test(`projects ${outlineNodeCount} Manifest titles without title text requests`, async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = buildFixture(outlineNodeCount);
    const ledger = await installFixture(page, fixture);

    await page.goto("/?readerPerf=1");
    await expect(page.locator(".reader-pane")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => dataLidCount(page), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(VIEWPORT_WIDTH);
    await expect(page.locator(".outline-item")).toHaveCount(outlineNodeCount);
    await expect(page.locator(".outline-title").first()).toHaveText("Deterministic chapter 1");
    await expect(page.locator(".breadcrumb")).toHaveText("Deterministic chapter 1");
    await expect(page.locator('.reader-pane [data-lid="1.1"]')).toBeVisible();

    const captured = await page.evaluate((globalName) => {
      const control = (window as any)[globalName];
      if (!control) throw new Error("reader performance diagnostics are unavailable");
      return {
        time_origin_epoch_ms: performance.timeOrigin,
        snapshot: control.take(`outline-${document.querySelectorAll(".outline-item").length}`),
      };
    }, READER_PERFORMANCE_GLOBAL) as {
      time_origin_epoch_ms: number;
      snapshot: ReaderPerformanceSnapshotV1;
    };
    expect(captured.snapshot.first_segment.count).toBe(1);
    expect(captured.snapshot.first_segment.at_ms).not.toBeNull();
    const requests = ledger.take(
      captured.time_origin_epoch_ms + captured.snapshot.first_segment.at_ms!,
    );
    expect(requests.before_first_segment?.outline_text).toBe(0);
    expect(requests.by_category["outline-text"] ?? 0).toBe(0);
    expect(requests.before_first_segment?.by_category["leaf-text-range"]).toBe(1);
    expect(requests.before_first_segment?.by_category["formula-semantics-range"]).toBe(1);
    expect(requests.by_category["leaf-text-singular"] ?? 0).toBe(0);
  });
}

test("records the bounded PHR4 2,623-leaf reader gate", async ({ browser }, testInfo) => {
  test.setTimeout(12 * 60_000);
  const fixture = buildFixture();
  const runs: RunReport[] = [];
  for (let iteration = 1; iteration <= WARM_UP_RUNS; iteration += 1) {
    runs.push(await runBenchmark(browser, fixture, "warm-up", iteration));
  }
  for (let iteration = 1; iteration <= MEASURED_RUNS; iteration += 1) {
    runs.push(await runBenchmark(browser, fixture, "measured", iteration));
  }

  const measured = runs.filter((run) => run.phase === "measured");
  const signature = structureSignature(measured[0]);
  for (const run of measured.slice(1)) expect(structureSignature(run)).toEqual(signature);
  for (const run of runs) {
    expect(run.checkpoints[0].diagnostics.first_segment.count).toBe(1);
    expect(run.checkpoints[0].requests.before_first_segment?.outline_text)
      .toBe(0);
    expect(run.checkpoints[0].requests.before_first_segment?.by_category["leaf-text-range"]).toBe(1);
    expect(run.checkpoints[0].requests.before_first_segment?.by_category["formula-semantics-range"]).toBe(1);
    for (const checkpoint of run.checkpoints) {
      expect(checkpoint.requests.by_category["leaf-text-singular"] ?? 0).toBe(0);
      expect(checkpoint.requests.by_category["formula-semantics-singular"] ?? 0).toBe(0);
      expect(checkpoint.loaded_lids).toBeLessThanOrEqual(3 * VIEWPORT_WIDTH);
      expect(checkpoint.diagnostics.dom.max_mounted_lids).toBeLessThanOrEqual(4 * VIEWPORT_WIDTH);
      expect(checkpoint.diagnostics.probe.self_time_ms.values).toBeInstanceOf(Array);
      expect(checkpoint.diagnostics.frames.interval_ms.values).toBeInstanceOf(Array);
      expect(checkpoint.diagnostics.edge_load.samples.values).toBeInstanceOf(Array);
    }
  }

  const cpuList = cpus();
  const report: BaselineReport = {
    schema_version: REPORT_VERSION,
    generated_at: new Date().toISOString(),
    revision: git(["rev-parse", "--short=7", "HEAD"]),
    working_tree_dirty: git(["status", "--short"]).length > 0,
    fixture: {
      fixture_id: FIXTURE_ID,
      nodes: fixture.tree.length,
      leaves: fixture.leafLids.length,
      formula_leaves: fixture.formulaLids.size,
      outline_nodes: fixture.outlineLids.size,
      viewport_width: VIEWPORT_WIDTH,
      checkpoints: [...CHECKPOINTS],
      scroll_ratio: SCROLL_RATIO,
    },
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
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  await testInfo.attach("reader-performance-baseline.json", {
    body: json,
    contentType: "application/json",
  });
  const configuredPath = process.env.READER_PERF_REPORT_PATH;
  if (configuredPath) {
    const reportPath = resolve(process.cwd(), configuredPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, json, "utf8");
  }
});
