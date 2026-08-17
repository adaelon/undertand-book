import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectReaderSurfaceSettlement,
  readerEdgeLoadFailureMessage,
  uniqueCreatedAnnotation,
} from "./reader-performance-correctness.mjs";

const leafLids = Array.from({ length: 60 }, (_, index) => `lid-${index}`);

test("keeps goto correctness red until edge hydration commits the authoritative viewport", () => {
  const beforeCommit = inspectReaderSurfaceSettlement({
    mountedLids: leafLids.slice(0, 20),
    serverLids: leafLids.slice(20, 40),
    leafLids,
    edgeLoad: { started: 1, completed: 0, failed: 0 },
  });
  assert.equal(beforeCommit.passed, false);
  assert.equal(beforeCommit.active_edge_loads, 1);
  assert.equal(beforeCommit.viewport_contained, false);

  const committed = inspectReaderSurfaceSettlement({
    mountedLids: leafLids.slice(0, 40),
    serverLids: leafLids.slice(20, 40),
    leafLids,
    edgeLoad: { started: 1, completed: 1, failed: 0 },
  });
  assert.equal(committed.passed, true);
  assert.equal(committed.active_edge_loads, 0);
  assert.equal(committed.viewport_contained, true);
  assert.equal(committed.viewport_canonical, true);
});

test("never treats a non-canonical server viewport as settled", () => {
  const result = inspectReaderSurfaceSettlement({
    mountedLids: leafLids.slice(0, 40),
    serverLids: ["lid-20", "lid-22"],
    leafLids,
    edgeLoad: { started: 0, completed: 0, failed: 0 },
  });

  assert.equal(result.passed, false);
  assert.equal(result.viewport_canonical, false);
});

test("identifies this replay's Highlight without consuming pre-existing annotations", () => {
  const existing = { mem_id: "existing", type: "highlight", content: "old range" };
  const created = { mem_id: "created", type: "highlight", content: "new range" };

  assert.equal(
    uniqueCreatedAnnotation(new Set([existing.mem_id]), [existing, created], "highlight"),
    created,
  );
  assert.throws(
    () => uniqueCreatedAnnotation(new Set([existing.mem_id]), [existing], "highlight"),
    /created 0 highlight records instead of 1/,
  );
});

test("preserves edge counters and surface context in release failures", () => {
  const message = readerEdgeLoadFailureMessage({
    label: "load-through-2623",
    baseline: { started: 28, completed: 28, failed: 0 },
    completed: { started: 30, completed: 28, failed: 2 },
    context: {
      banner: "reader.scroll viewport did not match",
      mounted: { first: "lid-560", last: "lid-619", count: 60 },
      server: { top_lid: "lid-580", visible_lids: ["lid-580", "lid-581"] },
    },
  });

  assert.match(message, /load-through-2623 edge load failed/);
  assert.match(message, /reader\.scroll viewport did not match/);
  assert.match(message, /lid-580/);
  assert.match(message, /\"failed\":2/);
});
