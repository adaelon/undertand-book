import { expect, test, type Page, type Route } from "@playwright/test";

const LEAF_COUNT = 2_623;
const VIEWPORT_WIDTH = 20;
const SETTLED_LIMIT = 3 * VIEWPORT_WIDTH;
const TRANSIENT_LIMIT = 4 * VIEWPORT_WIDTH;
const SOURCE_FINGERPRINT = "b".repeat(64);

type Scenario = "fixed" | "note" | "image" | "formula";
type NodeKind = "chapter" | "paragraph" | "image" | "formula";

interface FixtureNode {
  lid: string;
  display_title: string;
  children: string[];
  span: { start: number; end: number };
  kind: NodeKind;
}

interface Fixture {
  scenario: Scenario;
  tree: FixtureNode[];
  leafLids: string[];
  textByLid: Map<string, string>;
  source: string;
  formulaLids: Set<string>;
  imageLids: Set<string>;
  noteLid: string | null;
}

interface MountedRange {
  lids: string[];
  count: number;
  firstIndex: number;
  lastIndex: number;
}

function buildFixture(scenario: Scenario): Fixture {
  const leafLids: string[] = [];
  const textByLid = new Map<string, string>();
  const formulaLids = new Set<string>();
  const imageLids = new Set<string>();
  const leaves: FixtureNode[] = [];
  let source = "";
  let offset = 0;
  for (let index = 0; index < LEAF_COUNT; index += 1) {
    const lid = `1.${index + 1}`;
    let kind: NodeKind = "paragraph";
    if (scenario === "formula" && index % 7 === 3) kind = "formula";
    if (scenario === "image" && index % 17 === 8) kind = "image";
    const text = kind === "formula"
      ? `$x_{${index + 1}} = \\frac{${index + 1}}{1 + y^2} + \\sqrt{${index + 3}}$`
      : kind === "image"
        ? `![Delayed image ${index + 1}](/reader-fixture-assets/${index + 1}.svg)`
        : `Leaf ${index + 1}. ${"Stable reader content fixes enough block height for deterministic bidirectional scrolling. ".repeat(3)}`;
    leafLids.push(lid);
    textByLid.set(lid, text);
    if (kind === "formula") formulaLids.add(lid);
    if (kind === "image") imageLids.add(lid);
    leaves.push({
      lid,
      display_title: text.slice(0, 80),
      children: [],
      span: { start: offset, end: offset + text.length },
      kind,
    });
    source += text;
    offset += text.length;
  }
  const chapterText = "# Bounded reader fixture";
  textByLid.set("1", chapterText);
  return {
    scenario,
    tree: [{
      lid: "1",
      display_title: "Bounded reader fixture",
      children: [...leafLids],
      span: { start: 0, end: offset },
      kind: "chapter",
    }, ...leaves],
    leafLids,
    textByLid,
    source,
    formulaLids,
    imageLids,
    noteLid: scenario === "note" ? leafLids[44] : null,
  };
}

function noteRecord(lid: string) {
  return {
    mem_id: "note-variable-height",
    type: "note",
    layer: "long_term",
    book_id: "reader-bounded-fixture",
    anchor: { lid },
    content: `> source quote\n\n${"Variable-height Note body. ".repeat(28)}`,
    note_placement: {
      kind: "lid_block",
      source_fingerprint: SOURCE_FINGERPRINT,
      lid,
    },
  };
}

function profileMemory() {
  return {
    current_book_id: "reader-bounded-fixture",
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

async function installFixture(page: Page, fixture: Fixture) {
  const profile = {
    profile_id: "technical_learning",
    profile_version: "reader-bounded-v1",
    ui_slots: [],
    layout_presets: [],
    allowed_layout_actions: [],
    agent_tools: [],
  };
  const maximumTop = Math.max(0, fixture.leafLids.length - VIEWPORT_WIDTH);
  let readerTopIndex = 0;
  let memories: Array<Record<string, unknown>> = fixture.noteLid
    ? [noteRecord(fixture.noteLid)]
    : [];
  let nextMemoryId = 1;
  const viewportAt = (rawTop: number) => {
    const top = Math.max(0, Math.min(rawTop, maximumTop));
    const visible = fixture.leafLids.slice(top, top + VIEWPORT_WIDTH);
    return {
      anchor_lid: visible[Math.floor(visible.length / 2)] ?? visible[0],
      top_lid: visible[0],
      bottom_lid: visible.at(-1),
      width: VIEWPORT_WIDTH,
      visible_lids: visible,
    };
  };
  let viewport = viewportAt(readerTopIndex);
  const readerState = () => ({
    viewport,
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
  });
  const fulfill = (route: Route, value: unknown, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });

  if (fixture.scenario === "image") {
    await page.route("**/reader-fixture-assets/*.svg", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      const index = Number(/\/(\d+)\.svg$/.exec(new URL(route.request().url()).pathname)?.[1] ?? 1);
      const height = 280 + (index % 5) * 70;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}"><rect width="640" height="${height}" fill="#e7efe9"/><text x="24" y="48" font-size="28">Delayed ${index}</text></svg>`,
      });
    });
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.method() === "POST"
      ? (request.postDataJSON() as Record<string, unknown> | null) ?? {}
      : {};
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
        book_id: "reader-bounded-fixture",
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
    if (path === "/api/book/manifest") return fulfill(route, { tree: fixture.tree, stats_by_lid: {} });
    if (path === "/api/book/asset_manifest") {
      return fulfill(route, {
        version: "asset_manifest.v1",
        book_id: "reader-bounded-fixture",
        images: [...fixture.imageLids].map((lid) => {
          const index = fixture.leafLids.indexOf(lid) + 1;
          return {
            kind: "image",
            lid,
            alt: `Delayed image ${index}`,
            original_src: `/reader-fixture-assets/${index}.svg`,
            source: "markdown",
            status: "available",
            stored_path: `assets/${index}.svg`,
            url_path: `/reader-fixture-assets/${index}.svg`,
            mime: "image/svg+xml",
            sha256: String(index).padStart(64, "0"),
            size_bytes: 1024,
            warning: null,
          };
        }),
      });
    }
    if (path === "/api/book/source_fingerprint") {
      return fulfill(route, {
        book_id: "reader-bounded-fixture",
        source_fingerprint: SOURCE_FINGERPRINT,
      });
    }
    if (path === "/api/book/source_manifest") {
      return fulfill(route, {
        version: "source_manifest.v2",
        book_id: "reader-bounded-fixture",
        canonical_source: {
          kind: "reconciled_markdown",
          path: "source.txt",
          citation_anchor: "lid",
          sha256: SOURCE_FINGERPRINT,
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
    if (path === "/api/reader/state") return fulfill(route, readerState());
    if (path === "/api/reader/scroll") {
      const delta = Number(body.delta ?? 0);
      readerTopIndex = Math.max(0, Math.min(readerTopIndex + delta, maximumTop));
      viewport = viewportAt(readerTopIndex);
      return fulfill(route, { ok: true, viewport });
    }
    if (path === "/api/reader/goto") {
      const lid = String(body.lid ?? "");
      const index = fixture.leafLids.indexOf(lid);
      if (index < 0) {
        return fulfill(route, {
          error_code: "LID_NOT_FOUND",
          category: "not_found",
          message: lid,
        }, 404);
      }
      readerTopIndex = Math.min(index, maximumTop);
      viewport = viewportAt(readerTopIndex);
      return fulfill(route, { ok: true, viewport });
    }
    if (path === "/api/agent/history") {
      const current = {
        id: "reader-bounded-session",
        book_id: "reader-bounded-fixture",
        title: "Bounded reader",
        created_at: "2026-08-12T00:00:00Z",
        updated_at: "2026-08-12T00:00:00Z",
        turns: [],
      };
      return fulfill(route, {
        active_session_id: current.id,
        sessions: [{ ...current, turn_count: 0 }],
        current,
      });
    }
    if (path === "/api/build_intent/artifacts") return fulfill(route, { overlay: null });
    if (path === "/api/build_intent/usage.event") return fulfill(route, { accepted: true });
    if (path === "/api/memory/recall") return fulfill(route, memories);
    if (path === "/api/memory/delete") {
      const memId = String(body.mem_id ?? "");
      memories = memories.filter((record) => record.mem_id !== memId);
      return fulfill(route, { ok: true });
    }
    if (path === "/api/memory/replace") {
      const memId = String(body.mem_id ?? "");
      memories = memories.map((record) => record.mem_id === memId
        ? { ...record, content: String(body.content ?? "") }
        : record);
      return fulfill(route, memories.find((record) => record.mem_id === memId));
    }
    if (path === "/api/reader/highlight") {
      const lid = String(body.lid ?? "");
      const memId = `highlight-${nextMemoryId++}`;
      memories.push({
        mem_id: memId,
        type: "highlight",
        layer: "long_term",
        book_id: "reader-bounded-fixture",
        anchor: { lid },
        content: fixture.textByLid.get(lid) ?? "",
        range: body.range,
      });
      return fulfill(route, { ok: true, highlight_id: memId });
    }
    if (path === "/api/book/text") {
      const lid = url.searchParams.get("lid") ?? "";
      const end = url.searchParams.get("end");
      if (end) {
        const first = fixture.tree.find((node) => node.lid === lid);
        const last = fixture.tree.find((node) => node.lid === end);
        if (!first || !last || first.children.length || last.children.length || first.span.start > last.span.end) {
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
        composition: { source_lid: lid, meaning: "formula fixture", terms: [], evidence_lids: [lid] },
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
            composition: { source_lid: lid, meaning: "formula fixture", terms: [], evidence_lids: [lid] },
            context_links: [],
          })),
      });
    }
    return fulfill(route, {
      error_code: "UNMOCKED",
      category: "not_found",
      message: `Unmocked bounded-reader route: ${path}`,
    }, 404);
  });
}

async function mountedRange(page: Page, fixture: Fixture): Promise<MountedRange> {
  const lids = await page.locator(".reader-pane [data-lid]")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.lid ?? ""));
  return {
    lids,
    count: lids.length,
    firstIndex: fixture.leafLids.indexOf(lids[0]),
    lastIndex: fixture.leafLids.indexOf(lids.at(-1) ?? ""),
  };
}

async function settle(page: Page, scenario: Scenario) {
  if (scenario === "image") {
    await expect.poll(
      () => page.locator(".reader-pane").evaluate((pane) => {
        const paneRect = pane.getBoundingClientRect();
        return [...pane.querySelectorAll<HTMLImageElement>("img")].every((image) => {
          const rect = image.getBoundingClientRect();
          const intersectsViewport = rect.bottom >= paneRect.top && rect.top <= paneRect.bottom;
          return !intersectsViewport || image.complete;
        });
      }),
      { timeout: 10_000 },
    ).toBe(true);
  }
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(scenario === "image" ? 80 : 20);
}

async function lidTop(page: Page, lid: string): Promise<number> {
  return page.locator(".reader-pane").evaluate((pane, targetLid) => {
    const node = pane.querySelector<HTMLElement>(`[data-lid="${targetLid}"]`);
    if (!node) throw new Error(`mounted LID ${targetLid} missing`);
    return node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, lid);
}

async function currentLidIndex(page: Page, fixture: Fixture): Promise<number> {
  const value = await page.locator(".debug-panel code").first().textContent();
  return fixture.leafLids.indexOf(value?.trim() ?? "");
}

async function triggerTransition(
  page: Page,
  fixture: Fixture,
  direction: "up" | "down",
  mountedLimit = SETTLED_LIMIT,
): Promise<{ range: MountedRange; anchorError: number; currentIndex: number }> {
  const before = await mountedRange(page, fixture);
  const insertStart = direction === "down"
    ? before.lastIndex + 1
    : Math.max(0, before.firstIndex - VIEWPORT_WIDTH);
  const insertEnd = direction === "down"
    ? Math.min(fixture.leafLids.length, insertStart + VIEWPORT_WIDTH)
    : before.firstIndex;
  if (insertEnd <= insertStart) {
    return { range: before, anchorError: 0, currentIndex: await currentLidIndex(page, fixture) };
  }
  const settledStart = direction === "down"
    ? Math.max(before.firstIndex, insertEnd - SETTLED_LIMIT)
    : insertStart;
  const settledEnd = direction === "down"
    ? insertEnd
    : Math.min(before.lastIndex + 1, insertStart + SETTLED_LIMIT);
  const preserveIndex = direction === "down"
    ? settledStart < before.lastIndex + 1 ? settledStart : insertStart
    : before.firstIndex < settledEnd ? before.firstIndex : insertStart;
  const preserveLid = fixture.leafLids[preserveIndex];
  const beforeTop = await page.locator(".reader-pane").evaluate((pane, args) => {
    const element = pane as HTMLElement;
    const sentinel = element.querySelector<HTMLElement>(
      args.nextDirection === "down" ? ".reader-edge-sentinel-bottom" : ".reader-edge-sentinel-top",
    );
    if (!sentinel) throw new Error("reader edge sentinel missing");
    const paneRect = element.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const targetOffset = element.clientHeight * (args.nextDirection === "down" ? 0.8 : 0.2);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: args.nextDirection === "down" ? 1 : -1,
    }));
    element.scrollTop += sentinelRect.top - paneRect.top - targetOffset;
    const anchor = element.querySelector<HTMLElement>(`[data-lid="${args.preserveLid}"]`);
    if (!anchor) throw new Error(`preserved anchor ${args.preserveLid} is not mounted`);
    const top = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return top;
  }, { nextDirection: direction, preserveLid });
  await expect.poll(async () => {
    const range = await mountedRange(page, fixture);
    return direction === "down" ? range.lastIndex : -range.firstIndex;
  }, { timeout: 15_000 }).toBeGreaterThan(
    direction === "down" ? before.lastIndex : -before.firstIndex,
  );
  await settle(page, fixture.scenario);
  const after = await mountedRange(page, fixture);
  expect(after.count, `${fixture.scenario} ${direction} settled mounted LIDs`)
    .toBeLessThanOrEqual(mountedLimit);
  let anchorError = Number.POSITIVE_INFINITY;
  await expect.poll(async () => {
    anchorError = Math.abs(await lidTop(page, preserveLid) - beforeTop);
    return anchorError;
  }, {
    message: `${fixture.scenario} ${direction} preserved ${preserveLid}`,
    timeout: 10_000,
  }).toBeLessThanOrEqual(2);
  return {
    range: after,
    anchorError,
    currentIndex: await currentLidIndex(page, fixture),
  };
}

async function driveToEndAndBack(page: Page, fixture: Fixture) {
  let range = await mountedRange(page, fixture);
  let priorCurrent = await currentLidIndex(page, fixture);
  let maxAnchorError = 0;
  while (range.lastIndex < fixture.leafLids.length - 1) {
    const result = await triggerTransition(page, fixture, "down");
    range = result.range;
    maxAnchorError = Math.max(maxAnchorError, result.anchorError);
    if (priorCurrent >= 0 && result.currentIndex >= 0) {
      expect(result.currentIndex, `${fixture.scenario} current LID moves forward`).toBeGreaterThanOrEqual(priorCurrent);
    }
    priorCurrent = result.currentIndex;
  }
  expect(range.lastIndex).toBe(fixture.leafLids.length - 1);

  while (range.firstIndex > 0) {
    const result = await triggerTransition(page, fixture, "up");
    range = result.range;
    maxAnchorError = Math.max(maxAnchorError, result.anchorError);
    if (priorCurrent >= 0 && result.currentIndex >= 0) {
      expect(result.currentIndex, `${fixture.scenario} current LID moves backward`).toBeLessThanOrEqual(priorCurrent);
    }
    priorCurrent = result.currentIndex;
  }
  expect(range.firstIndex).toBe(0);
  return maxAnchorError;
}

async function selectText(page: Page, lid: string, start = 1, end = 12) {
  const target = page.locator(`[data-lid="${lid}"]`);
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element, offsets) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text) throw new Error("selection text node missing");
    const range = document.createRange();
    range.setStart(text, Math.min(offsets.start, text.textContent?.length ?? 0));
    range.setEnd(text, Math.min(offsets.end, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.closest(".prose")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
  await expect(page.locator(".hl-popover")).toBeVisible();
}

async function exerciseFixedInteractions(page: Page, fixture: Fixture) {
  while ((await mountedRange(page, fixture)).lastIndex < 59) {
    await triggerTransition(page, fixture, "down");
  }
  const highlightLid = fixture.leafLids[44];
  await selectText(page, highlightLid);
  await page.locator(".hl-popover button", { hasText: "高亮" }).click();
  await expect(page.locator(`[data-lid="${highlightLid}"] mark.hl-mark`)).toBeVisible();

  const pinnedLid = fixture.leafLids[55];
  await selectText(page, pinnedLid);
  const before = await mountedRange(page, fixture);
  const result = await triggerTransition(page, fixture, "down", TRANSIENT_LIMIT);
  expect(result.range.count).toBe(TRANSIENT_LIMIT);
  expect(result.range.firstIndex).toBe(before.firstIndex);
  await page.locator(".hl-popover button", { hasText: "笔记" }).click();
  await expect(page.locator(".note-modal")).toBeVisible();
  await expect.poll(() => page.locator(".reader-pane [data-lid]").count())
    .toBeLessThanOrEqual(SETTLED_LIMIT);
  await page.locator(".note-modal button", { hasText: "取消" }).click();
  return highlightLid;
}

async function gotoAndAssertPaneTop(page: Page, fixture: Fixture, targetIndex: number) {
  const target = fixture.leafLids[targetIndex];
  const input = page.locator(".debug-goto input");
  await input.fill(target);
  await page.locator(".debug-goto button", { hasText: "跳转" }).click();
  await expect(page.locator(`[data-lid="${target}"]`)).toBeVisible({ timeout: 15_000 });
  await settle(page, fixture.scenario);
  await expect.poll(
    async () => Math.abs(await lidTop(page, target)),
    { message: `${fixture.scenario} goto pane top`, timeout: 10_000 },
  ).toBeLessThanOrEqual(2);
}

for (const scenario of ["fixed", "note", "image", "formula"] as const) {
  test(`PHR4 keeps the 2,623-leaf ${scenario} fixture bounded and anchored`, async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const fixture = buildFixture(scenario);
    const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
    const page = await context.newPage();
    await installFixture(page, fixture);
    await page.goto("/?readerPerf=1");
    await expect(page.locator(".reader-pane")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.locator(".reader-pane [data-lid]").count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(VIEWPORT_WIDTH);
    await page.getByRole("button", { name: "调试" }).click();
    await settle(page, scenario);
    expect(await page.locator(".reader-pane [data-lid]").count(), `${scenario} initial settled mounted LIDs`)
      .toBeLessThanOrEqual(SETTLED_LIMIT);

    let highlightLid: string | null = null;
    if (scenario === "fixed") highlightLid = await exerciseFixedInteractions(page, fixture);
    if (scenario === "note") {
      while ((await mountedRange(page, fixture)).lastIndex < 59) {
        await triggerTransition(page, fixture, "down");
      }
      const card = page.locator(".note-card");
      await expect(card).toBeVisible();
      await card.locator("summary").click();
      await expect(card).toHaveAttribute("open", "");
      await expect.poll(() => page.locator(".reader-pane [data-lid]").count())
        .toBeLessThanOrEqual(SETTLED_LIMIT);
      await page.waitForTimeout(0);
    }

    const maxAnchorError = await driveToEndAndBack(page, fixture);
    expect(maxAnchorError, `${scenario} max anchor error`).toBeLessThanOrEqual(2);
    const perf = await page.evaluate(() => window.__UNDERSTAND_BOOK_READER_PERF__?.snapshot("phr4"));
    expect(perf?.dom.max_mounted_lids).toBeLessThanOrEqual(TRANSIENT_LIMIT);
    expect(perf?.dom.max_data_lid_nodes).toBeLessThanOrEqual(TRANSIENT_LIMIT);
    console.info("PHR4_RESULT", JSON.stringify({
      scenario,
      leafCount: fixture.leafLids.length,
      maxAnchorError,
      settledLimit: SETTLED_LIMIT,
      transientLimit: TRANSIENT_LIMIT,
      maxMountedLids: perf?.dom.max_mounted_lids,
      maxDataLidNodes: perf?.dom.max_data_lid_nodes,
    }));

    if (highlightLid) {
      await expect(page.locator(`[data-lid="${highlightLid}"] mark.hl-mark`)).toBeVisible();
    }
    if (scenario === "note") {
      const card = page.locator(".note-card");
      await expect(card).toHaveAttribute("open", "");
      await card.getByRole("button", { name: "引用来源" }).click();
      await expect(page.locator(".source-preview-dialog")).toBeVisible();
      await page.getByRole("button", { name: "关闭来源预览" }).click();
      await card.getByRole("button", { name: "编辑" }).click();
      await expect(page.locator(".note-modal")).toBeVisible();
      await page.locator(".note-modal button", { hasText: "取消" }).click();
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "删除" }).click();
      await expect(page.locator(".note-card")).toHaveCount(0);
    }

    await gotoAndAssertPaneTop(page, fixture, 1_499);
    await context.close();
  });
}
