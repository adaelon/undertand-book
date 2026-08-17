import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReaderReleaseReport,
  evaluateReaderRuntimeRelease,
  READER_RELEASE_REPORT_VERSION,
  RELEASE_CHECKPOINTS,
} from "./reader-performance-release-gate.mjs";

function samples(value) {
  return { limit: 1_024, observed: 3, dropped: 0, values: [value, value, value] };
}

function checkpoint(target) {
  return {
    target_leaf: target,
    loaded_lids: 60,
    canonical_order_ok: true,
    diagnostics: {
      scroll: { max_checks_per_frame: 1 },
      probe: { max_calls_per_frame: 1, max_candidates: 20, self_time_ms: samples(0.2) },
      edge_load: { failed: 0 },
      first_segment: { count: target === 20 ? 1 : 0 },
      dom: { max_mounted_lids: 80, max_data_lid_nodes: 80 },
      frames: { interval_ms: samples(16.7) },
      cache: {
        available: true,
        viewport_width: 20,
        html_entries: 100,
        html_capacity: 100,
        text_entries: 100,
        formula_entries: 40,
        hydration_capacity: 100,
      },
    },
    requests: {
      by_category: {
        "outline-text": 0,
        "leaf-text-range": 1,
        "leaf-text-singular": 0,
        "formula-semantics-range": 1,
        "formula-semantics-singular": 0,
      },
      before_first_segment: target === 20
        ? { outline_text: 0, by_category: { "leaf-text-range": 1, "formula-semantics-range": 1 } }
        : null,
    },
    summary: { reader_long_tasks_over_50_ms: 0 },
  };
}

function runtime(runtimeName) {
  const runs = [];
  for (let iteration = 1; iteration <= 2; iteration += 1) {
    runs.push({ phase: "warm-up", iteration, checkpoints: RELEASE_CHECKPOINTS.map(checkpoint) });
  }
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    runs.push({ phase: "measured", iteration, checkpoints: RELEASE_CHECKPOINTS.map(checkpoint) });
  }
  return {
    runtime: runtimeName,
    fixture: { viewport_width: 20 },
    runs,
    correctness: { passed: true, failures: [] },
  };
}

test("accepts two runtimes only when every frozen release gate passes", () => {
  const report = {
    schema_version: READER_RELEASE_REPORT_VERSION,
    runtimes: [runtime("chromium"), runtime("webview2")],
  };
  const result = evaluateReaderReleaseReport(report);
  assert.equal(result.passed, true);
  assert.equal(result.runtimes.every((item) => item.passed), true);
});
test("does not release from one best run or with singular requests", () => {
  const candidate = runtime("chromium");
  candidate.runs = candidate.runs.filter((run) => run.phase === "warm-up" || run.iteration === 1);
  candidate.runs.find((run) => run.phase === "measured").checkpoints[2]
    .requests.by_category["leaf-text-singular"] = 1;
  const result = evaluateReaderRuntimeRelease(candidate);
  assert.equal(result.passed, false);
  assert.equal(result.gates.sampling.passed, false);
  assert.equal(result.gates.requests.passed, false);
});

test("fails closed on cache overflow, scroll long tasks, and monotonic probe growth", () => {
  const candidate = runtime("webview2");
  const measured = candidate.runs.filter((run) => run.phase === "measured");
  for (const run of measured) {
    checkpointByTarget(run, 500).diagnostics.probe.self_time_ms = samples(0.2);
    checkpointByTarget(run, 1_000).diagnostics.probe.self_time_ms = samples(0.4);
    checkpointByTarget(run, 2_623).diagnostics.probe.self_time_ms = samples(0.6);
  }
  checkpointByTarget(measured[0], 500).diagnostics.cache.text_entries = 101;
  checkpointByTarget(measured[0], 1_000).summary.reader_long_tasks_over_50_ms = 1;
  const result = evaluateReaderRuntimeRelease(candidate);
  assert.equal(result.passed, false);
  assert.equal(result.gates.caches.passed, false);
  assert.equal(result.gates.long_tasks.passed, false);
  assert.equal(result.gates.probe.passed, false);
});

function checkpointByTarget(run, target) {
  return run.checkpoints.find((candidate) => candidate.target_leaf === target);
}
