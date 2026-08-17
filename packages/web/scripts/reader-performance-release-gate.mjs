export const READER_RELEASE_REPORT_VERSION = "reader-performance-release.v1";
export const RELEASE_CHECKPOINTS = [20, 500, 1_000, 2_623];

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

function checkpointOf(run, target) {
  return run.checkpoints?.find((checkpoint) => checkpoint.target_leaf === target) ?? null;
}

function numberSamples(checkpoint, path) {
  let current = checkpoint;
  for (const key of path) current = current?.[key];
  return Array.isArray(current) ? current.filter(Number.isFinite) : [];
}

function categoryCount(checkpoint, category) {
  return Number(checkpoint?.requests?.by_category?.[category] ?? 0);
}

function gate(passed, details) {
  return { passed: Boolean(passed), details };
}

export function evaluateReaderRuntimeRelease(report) {
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const warmUps = runs.filter((run) => run.phase === "warm-up");
  const measured = runs.filter((run) => run.phase === "measured");
  const width = Number(report?.fixture?.viewport_width);
  const settledLimit = 3 * width;
  const transientLimit = 4 * width;
  const cacheLimit = 5 * width;
  const measuredCheckpoints = measured.flatMap((run) => run.checkpoints ?? []);

  const sampling = gate(
    warmUps.length >= 2 && measured.length >= 5,
    { warm_up_runs: warmUps.length, measured_runs: measured.length },
  );

  const checkpointShapeFailures = measured.flatMap((run) => RELEASE_CHECKPOINTS
    .filter((target) => !checkpointOf(run, target))
    .map((target) => ({ iteration: run.iteration, missing_target: target })));
  const structureFailures = measuredCheckpoints.flatMap((checkpoint) => {
    const failures = [];
    if (!checkpoint.canonical_order_ok) failures.push("canonical_order");
    if (checkpoint.loaded_lids > settledLimit) failures.push("settled_lids");
    if (checkpoint.diagnostics?.dom?.max_mounted_lids > transientLimit) failures.push("transient_lids");
    if (checkpoint.diagnostics?.dom?.max_data_lid_nodes > transientLimit) failures.push("transient_dom");
    if (checkpoint.diagnostics?.probe?.max_calls_per_frame > 1) failures.push("probe_per_frame");
    if (checkpoint.diagnostics?.scroll?.max_checks_per_frame > 1) failures.push("scroll_per_frame");
    if (checkpoint.diagnostics?.probe?.max_candidates > transientLimit) failures.push("probe_candidates");
    if (checkpoint.diagnostics?.edge_load?.failed !== 0) failures.push("edge_load_failed");
    return failures.map((reason) => ({ target: checkpoint.target_leaf, reason }));
  });
  const structure = gate(
    Number.isFinite(width)
      && width > 0
      && checkpointShapeFailures.length === 0
      && structureFailures.length === 0,
    { settled_limit: settledLimit, transient_limit: transientLimit, checkpointShapeFailures, structureFailures },
  );

  const requestFailures = measuredCheckpoints.flatMap((checkpoint) => {
    const failures = [];
    if (categoryCount(checkpoint, "outline-text") !== 0) failures.push("outline_text");
    if (categoryCount(checkpoint, "leaf-text-singular") !== 0) failures.push("leaf_text_singular");
    if (categoryCount(checkpoint, "formula-semantics-singular") !== 0) failures.push("formula_singular");
    if (categoryCount(checkpoint, "formula-semantics-range") > categoryCount(checkpoint, "leaf-text-range")) {
      failures.push("formula_range_exceeds_text_range");
    }
    if (checkpoint.target_leaf === 20) {
      if (checkpoint.requests?.before_first_segment?.outline_text !== 0) failures.push("first_segment_outline");
      if (checkpoint.requests?.before_first_segment?.by_category?.["leaf-text-range"] !== 1) {
        failures.push("first_segment_text_range");
      }
      if ((checkpoint.requests?.before_first_segment?.by_category?.["formula-semantics-range"] ?? 0) > 1) {
        failures.push("first_segment_formula_range");
      }
    }
    return failures.map((reason) => ({ target: checkpoint.target_leaf, reason }));
  });
  const requests = gate(requestFailures.length === 0, { failures: requestFailures });

  const cacheFailures = measuredCheckpoints.flatMap((checkpoint) => {
    const cache = checkpoint.diagnostics?.cache;
    const failures = [];
    if (!cache?.available) failures.push("unavailable");
    if (cache?.viewport_width !== width) failures.push("viewport_width");
    if (cache?.html_entries > cacheLimit || cache?.html_capacity > cacheLimit) failures.push("html_bound");
    if (cache?.text_entries > cacheLimit || cache?.formula_entries > cacheLimit) failures.push("hydration_entries");
    if (cache?.hydration_capacity > cacheLimit) failures.push("hydration_capacity");
    return failures.map((reason) => ({ target: checkpoint.target_leaf, reason }));
  });
  const caches = gate(cacheFailures.length === 0, { cache_limit: cacheLimit, failures: cacheFailures });

  const frameP95ByTarget = Object.fromEntries(RELEASE_CHECKPOINTS.slice(1).map((target) => [
    target,
    percentile(measured.flatMap((run) => numberSamples(
      checkpointOf(run, target),
      ["diagnostics", "frames", "interval_ms", "values"],
    )), 95),
  ]));
  const frames = gate(
    Object.values(frameP95ByTarget).every((value) => value !== null && value <= 32),
    { p95_ms_by_target: frameP95ByTarget, maximum_ms: 32 },
  );

  const probeP95ByTarget = Object.fromEntries(RELEASE_CHECKPOINTS.slice(1).map((target) => [
    target,
    percentile(measured.flatMap((run) => numberSamples(
      checkpointOf(run, target),
      ["diagnostics", "probe", "self_time_ms", "values"],
    )), 95),
  ]));
  const probeDepth = RELEASE_CHECKPOINTS.slice(1).map((target) => probeP95ByTarget[target]);
  const monotonicGrowth = probeDepth.every((value, index) => (
    index === 0 || (value !== null && probeDepth[index - 1] !== null && value > probeDepth[index - 1] + 0.05)
  ));
  const probe = gate(
    probeDepth.every((value) => value !== null && value <= 2) && !monotonicGrowth,
    { p95_ms_by_target: probeP95ByTarget, maximum_ms: 2, monotonic_growth: monotonicGrowth },
  );

  const readerLongTasks = measuredCheckpoints.reduce(
    (count, checkpoint) => count + Number(checkpoint.summary?.reader_long_tasks_over_50_ms ?? 0),
    0,
  );
  const longTasks = gate(readerLongTasks === 0, { reader_scroll_over_50_ms: readerLongTasks });

  const firstSegmentFailures = measured.flatMap((run) => {
    const checkpoint = checkpointOf(run, 20);
    return checkpoint?.diagnostics?.first_segment?.count === 1
      ? []
      : [{ iteration: run.iteration, count: checkpoint?.diagnostics?.first_segment?.count ?? null }];
  });
  const firstSegment = gate(firstSegmentFailures.length === 0, { failures: firstSegmentFailures });

  const correctness = gate(
    report?.correctness?.passed === true,
    report?.correctness ?? { passed: false, failures: ["missing correctness matrix"] },
  );

  const gates = {
    sampling,
    structure,
    requests,
    caches,
    frames,
    probe,
    long_tasks: longTasks,
    first_segment: firstSegment,
    correctness,
  };
  return {
    passed: Object.values(gates).every((result) => result.passed),
    gates,
  };
}

export function evaluateReaderReleaseReport(report) {
  const runtimes = Array.isArray(report?.runtimes) ? report.runtimes : [];
  const results = runtimes.map((runtime) => ({
    runtime: runtime.runtime,
    ...evaluateReaderRuntimeRelease(runtime),
  }));
  return {
    passed: report?.schema_version === READER_RELEASE_REPORT_VERSION
      && results.length === 2
      && new Set(results.map((result) => result.runtime)).size === 2
      && results.every((result) => result.passed),
    runtimes: results,
  };
}
