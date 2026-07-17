import { expect, test, type Page, type Route } from "@playwright/test";

type ResolveStatus = "resolved" | "partial" | "unresolved";

function pdfFixture(content = "BT /F1 20 Tf 72 700 Td (Selectable PDF fixture text for explicit actions.) Tj ET"): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function boundaryPdfFixture(): Buffer {
  return pdfFixture([
    "BT /F1 16 Tf",
    "72 740 Td (Selectable PDF fixture text for explicit actions.) Tj",
    "0 -24 Td (Boundary paragraph target.) Tj",
    "0 -48 Td (Boundary line target.) Tj",
    "0 -24 Td (Same paragraph continuation.) Tj",
    "0 -24 Td (Boundary filler line.) Tj",
    "0 -48 Td (Following paragraph.) Tj",
    "ET",
  ].join("\n"));
}

const profile = {
  profile_id: "technical_learning",
  profile_version: "fixture-v1",
  ui_slots: [],
  layout_presets: [],
  allowed_layout_actions: [],
  agent_tools: [],
};

const readerState = {
  viewport: {
    anchor_lid: "1.1",
    top_lid: "1.1",
    bottom_lid: "1.1",
    width: 1,
    visible_lids: ["1.1"],
  },
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

const sourceMap = {
  version: "pdf_source_map.v1",
  book_id: "pdf-selection-actions",
  coordinate_system: {
    space: "pdf_user_space",
    origin: "bottom_left",
    unit: "pt",
    rotation_applied: false,
  },
  pages: [{ pageIndex: 0, page_label: "1", width: 612, height: 792, rotate: 0, view: [0, 0, 612, 792] }],
  entries: [],
  excluded_regions: [],
  page_region_index: {},
  page_excluded_index: {},
  config_hash: "fixture-v1",
};

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

async function installApiFixture(
  page: Page,
  resolveStatus: ResolveStatus,
  resolveDelayMs = 0,
  pdf = pdfFixture(),
) {
  const calls = {
    highlights: [] as Record<string, unknown>[],
    notes: [] as Record<string, unknown>[],
    agent: [] as Record<string, unknown>[],
    resolves: 0,
    resolveRequests: [] as Record<string, unknown>[],
  };
  const records: Record<string, unknown>[] = [];
  let nextId = 1;
  const history = {
    active_session_id: "chat-fixture",
    sessions: [{
      id: "chat-fixture",
      title: "Fixture",
      created_at: "2026-07-13T00:00:00Z",
      updated_at: "2026-07-13T00:00:00Z",
      turn_count: 0,
      turns: [],
    }],
    current: {
      id: "chat-fixture",
      book_id: "pdf-selection-actions",
      title: "Fixture",
      created_at: "2026-07-13T00:00:00Z",
      updated_at: "2026-07-13T00:00:00Z",
      turns: [],
    },
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    if (path === "/api/book/pdf/original") {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: pdf });
    }
    if (path === "/api/desktop/status") {
      return json(route, {
        desktop_host: false,
        active_book: true,
        book_dir: null,
        library_root: "",
        library_root_available: true,
      });
    }
    if (path === "/api/book/build_workbench") {
      return json(route, {
        version: "build_workbench_snapshot.v1",
        book_id: "pdf-selection-actions",
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
      return json(route, {
        tree: [{
          lid: "1.1",
          children: [],
          span: { start: 0, end: 52 },
          kind: "paragraph",
        }],
        stats_by_lid: {},
      });
    }
    if (path === "/api/book/asset_manifest") {
      return json(route, { version: "asset_manifest.v1", book_id: "pdf-selection-actions", images: [] });
    }
    if (path === "/api/book/source_manifest") {
      return json(route, {
        version: "source_manifest.v2",
        book_id: "PDF selection action fixture",
        canonical_source: {
          kind: "reconciled_markdown",
          path: "source.txt",
          citation_anchor: "lid",
          sha256: "source",
        },
        original_pdf: { path: "fixture.pdf", sha256: "pdf", citation_anchor: false },
        capabilities: {
          view_pdf: { status: "available" },
          project_lid_to_pdf: { status: "available" },
          resolve_pdf_selection: { status: "available" },
          project_ranges_to_pdf: { status: "available" },
        },
      });
    }
    if (path === "/api/book/pdf_source_map") return json(route, sourceMap);
    if (path === "/api/profile/manifest") {
      return json(route, {
        ...profile,
        projections: [],
        guided_reading_policy: {},
        defaults: {},
      });
    }
    if (path === "/api/book/text") {
      return json(route, { lid: new URL(request.url()).searchParams.get("lid") ?? "1.1", text: "Selectable PDF fixture text for explicit actions." });
    }
    if (path === "/api/reader/state") return json(route, readerState);
    if (path === "/api/memory/recall") return json(route, records);
    if (path === "/api/reader/pdf_selection.resolve") {
      calls.resolves += 1;
      calls.resolveRequests.push(body ?? {});
      if (resolveDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, resolveDelayMs));
      }
      if (resolveStatus === "unresolved") {
        return json(route, { status: "unresolved", ranges: [], quote_markdown: "" });
      }
      return json(route, {
        status: resolveStatus,
        ranges: [{
          lid: "1.1",
          range: { start: 0, end: 10 },
          source_span: { start: 0, end: 10 },
          quote_markdown: "Selectable",
        }],
        quote_markdown: "Selectable",
      });
    }
    if (path === "/api/reader/highlight") {
      calls.highlights.push(body ?? {});
      const memId = `highlight-${nextId++}`;
      records.push({
        mem_id: memId,
        type: "highlight",
        layer: "long_term",
        book_id: "pdf-selection-actions",
        anchor: { lid: body?.lid, concept: null },
        content: "Selectable",
        range: body?.range,
        source_session_id: body?.source_session_id ?? null,
      });
      return json(route, { ok: true, highlight_id: memId });
    }
    if (path === "/api/memory/save") {
      calls.notes.push(body ?? {});
      const memId = `note-${nextId++}`;
      records.push({
        mem_id: memId,
        type: "note",
        layer: body?.layer ?? "long_term",
        book_id: "pdf-selection-actions",
        anchor: { lid: body?.anchor_lid, concept: null },
        content: body?.content,
        selection_context: body?.selection_context,
      });
      return json(route, records.at(-1));
    }
    if (path === "/api/reader/pdf_ranges.project") {
      const ranges = (body?.ranges ?? []) as Array<{ lid: string; range: { start: number; end: number } }>;
      return json(route, {
        projections: ranges.map((selected) => ({
          ...selected,
          status: "exact",
          rects: [{
            pageIndex: 0,
            bbox: [72, 696, 164, 716],
            source_span: selected.range,
          }],
          covered_range: selected.range,
          terminal_rect: {
            pageIndex: 0,
            bbox: [156, 696, 164, 716],
            source_span: { start: selected.range.end - 1, end: selected.range.end },
          },
        })),
      });
    }
    if (path === "/api/agent/history") return json(route, history);
    if (path === "/api/agent/chat") {
      calls.agent.push(body ?? {});
      return json(route, {
        answer: "fixture answer",
        incomplete: false,
        warning: null,
        turns: 1,
        tokens_spent: 1,
        effects: [],
        trace: [],
      });
    }
    return json(route, {
      error_code: "UNMOCKED",
      category: "internal",
      message: `Unmocked fixture route: ${path}`,
    }, 500);
  });
  return calls;
}

async function selectFixtureText(page: Page, start: number, end: number) {
  const span = page.locator(".pdf-text-layer span").first();
  await expect(span).toHaveText(/Selectable PDF fixture/);
  await span.evaluate((element, offsets) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, offsets.start);
    range.setEnd(text, offsets.end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.closest(".pdf-page-list")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
}

async function dragPastTextEnd(page: Page, text: string) {
  const span = page.locator(".pdf-text-layer span").filter({ hasText: text }).first();
  await expect(span).toHaveText(text);
  await span.scrollIntoViewIfNeeded();
  const box = await span.boundingBox();
  if (!box) throw new Error(`PDF text span has no box: ${text}`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 2, y, { steps: 12 });
  await page.mouse.up();
}

async function dragBetweenTextOffsets(page: Page, text: string, start: number, end: number) {
  const span = page.locator(".pdf-text-layer span").filter({ hasText: text }).first();
  await expect(span).toHaveText(text);
  await span.scrollIntoViewIfNeeded();
  const points = await span.evaluate((element, offsets) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw new Error("PDF text span has no text node");
    const characterRect = (offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect();
    };
    const first = characterRect(offsets.start);
    const last = characterRect(offsets.end - 1);
    return {
      start: { x: first.left + 1, y: first.top + first.height / 2 },
      end: { x: last.right - 1, y: last.top + last.height / 2 },
    };
  }, { start, end });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
}

test("resolved real PDF selection performs three explicit actions and sends structured AskQuote", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = await installApiFixture(page, "resolved");
  await page.goto("/");
  await expect(page.locator(".pdf-text-layer span").first()).toHaveText(/Selectable PDF fixture/);

  await selectFixtureText(page, 0, 10);
  await page.locator(".pdf-selection-toolbar").getByTitle("高亮").click();
  await expect.poll(() => calls.highlights.length).toBe(1);
  expect(calls.highlights[0]).toMatchObject({ lid: "1.1", range: { start: 0, end: 10 } });
  await expect(page.locator(".pdf-user-highlight")).toHaveCount(1);

  await selectFixtureText(page, 0, 10);
  await page.locator(".pdf-selection-toolbar").getByTitle("笔记").click();
  await expect(page.locator(".note-dialog")).toBeVisible();
  await page.locator(".note-dialog .primary").click();
  await expect.poll(() => calls.notes.length).toBe(1);
  expect(calls.notes[0]).toMatchObject({
    anchor_lid: "1.1",
    selection_context: {
      status: "resolved",
      ranges: [{ lid: "1.1", range: { start: 0, end: 10 } }],
    },
  });
  await expect(page.locator(".pdf-note-marker")).toHaveCount(1);

  await selectFixtureText(page, 0, 10);
  await page.locator(".pdf-selection-toolbar").getByTitle("问 AI").click();
  await expect(page.locator(".ask-draft")).toContainText("Selectable");
  expect(calls.agent).toHaveLength(0);
  await page.locator(".agent-input textarea").fill("What does this mean?");
  await page.locator(".agent-input > button").click();
  await expect.poll(() => calls.agent.length).toBe(1);
  expect(calls.agent[0]).toMatchObject({
    message: "What does this mean?",
    display_user: "What does this mean?",
    question_anchor_lid: "1.1",
    question_quote: {
      lid: "1.1",
      status: "resolved",
      raw_quote: "Selectable",
      resolved_quote: "Selectable",
      ranges: [{ lid: "1.1", range: { start: 0, end: 10 } }],
    },
  });
});

test("partial mobile selection disables Highlight but keeps Note and Ask explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await installApiFixture(page, "partial");
  await page.goto("/");
  await selectFixtureText(page, 0, 10);
  const toolbar = page.locator(".pdf-selection-toolbar");
  await expect(toolbar).toContainText("部分定位");
  await expect(toolbar.getByTitle("高亮")).toBeDisabled();
  await expect(toolbar.getByTitle("笔记")).toBeEnabled();
  await expect(toolbar.getByTitle("问 AI")).toBeEnabled();
  await toolbar.getByTitle("问 AI").click();
  await expect(page.locator(".ask-draft")).toContainText("部分定位");
  expect(calls.highlights).toHaveLength(0);
  expect(calls.notes).toHaveLength(0);
  expect(calls.agent).toHaveLength(0);
});

test("pending and unresolved PDF selection never renders an action toolbar", async ({ page }) => {
  const calls = await installApiFixture(page, "unresolved", 1_000);
  await page.goto("/");
  await page.waitForTimeout(500);
  await selectFixtureText(page, 0, 10);

  await expect.poll(() => calls.resolves).toBe(1);
  await page.waitForTimeout(200);
  expect(await page.locator(".pdf-selection-toolbar").count()).toBe(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Selectable");

  await page.waitForTimeout(900);
  await expect(page.locator(".pdf-selection-toolbar")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Selectable");
});

test("unresolved real PDF selection remains native-copy only", async ({ page }) => {
  const calls = await installApiFixture(page, "unresolved");
  await page.goto("/");
  await selectFixtureText(page, 0, 10);
  await expect.poll(() => calls.resolves).toBe(1);
  await expect(page.locator(".pdf-selection-toolbar")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Selectable");
  expect(calls.highlights).toHaveLength(0);
  expect(calls.notes).toHaveLength(0);
  expect(calls.agent).toHaveLength(0);
});

test("physical selection can start in the middle of a PDF line", async ({ page }) => {
  const text = "Selectable PDF fixture text for explicit actions.";
  const calls = await installApiFixture(page, "resolved");
  await page.goto("/");
  await dragBetweenTextOffsets(page, text, 15, 27);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("fixture text");
  await expect.poll(() => calls.resolveRequests.length).toBe(1);
  expect(calls.resolveRequests[0]).toMatchObject({ raw_quote: "fixture text" });
});

for (const [boundary, text] of [
  ["line", "Boundary line target."],
  ["paragraph", "Boundary paragraph target."],
] as const) {
  test(`physical trailing whitespace keeps ${boundary} selection exact`, async ({ page }) => {
    const calls = await installApiFixture(page, "resolved", 0, boundaryPdfFixture());
    await page.goto("/");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await dragPastTextEnd(page, text);
    await expect.poll(() => calls.resolveRequests.length).toBe(1);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(text);
    expect(calls.resolveRequests[0]).toMatchObject({ raw_quote: text });
    expect((calls.resolveRequests[0].rects as unknown[])).toHaveLength(1);
  });
}
