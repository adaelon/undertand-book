export const READER_PERFORMANCE_GLOBAL = "__UNDERSTAND_BOOK_READER_PERF__" as const;
export const READER_PERFORMANCE_SNAPSHOT_VERSION = "reader-performance-snapshot.v1" as const;

const NUMBER_SAMPLE_LIMIT = 1_024;
const EVENT_SAMPLE_LIMIT = 256;
const PROBE_MEASURE_NAME = "reader:probe";
const FIRST_SEGMENT_MARK_NAME = "reader:first-segment";

export interface BoundedSamples<T> {
  limit: number;
  observed: number;
  dropped: number;
  values: T[];
}

interface BoundedSampler<T> {
  limit: number;
  observed: number;
  values: T[];
}

export interface ReaderPerformanceEdgeLoadSample {
  direction: "up" | "down";
  requested_lids: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  outcome: "completed" | "failed";
}

export interface ReaderPerformanceLongTaskSample {
  start_ms: number;
  duration_ms: number;
}

export interface ReaderPerformanceSnapshotV1 {
  schema_version: typeof READER_PERFORMANCE_SNAPSHOT_VERSION;
  label: string;
  started_at_ms: number;
  ended_at_ms: number;
  scroll: {
    events: number;
    checks: number;
    max_checks_per_frame: number;
  };
  probe: {
    calls: number;
    max_calls_per_frame: number;
    max_candidates: number;
    last_candidates: number;
    self_time_ms: BoundedSamples<number>;
    candidate_counts: BoundedSamples<number>;
  };
  render: {
    calls: number;
    markdown_calls: number;
    katex_calls: number;
    by_kind: Record<string, number>;
  };
  edge_load: {
    started: number;
    completed: number;
    failed: number;
    requested_lids: number;
    samples: BoundedSamples<ReaderPerformanceEdgeLoadSample>;
  };
  first_segment: {
    count: number;
    at_ms: number | null;
    duration_ms: number | null;
    mounted_lids: number | null;
    dom_lids: number | null;
  };
  dom: {
    observations: number;
    mounted_lids: number;
    max_mounted_lids: number;
    data_lid_nodes: number;
    max_data_lid_nodes: number;
  };
  frames: {
    observed: number;
    interval_ms: BoundedSamples<number>;
  };
  long_tasks: {
    count: number;
    total_duration_ms: number;
    samples: BoundedSamples<ReaderPerformanceLongTaskSample>;
  };
  heap: {
    supported: boolean;
    used_js_heap_size: number | null;
    total_js_heap_size: number | null;
    js_heap_size_limit: number | null;
  };
  cache: ReaderPerformanceCacheSnapshotV1;
}

export interface ReaderPerformanceCacheSnapshotV1 {
  available: boolean;
  viewport_width: number | null;
  html_entries: number;
  html_capacity: number;
  text_entries: number;
  formula_entries: number;
  hydration_capacity: number;
}

export interface ReaderPerformanceControlV1 {
  schema_version: "reader-performance-control.v1";
  snapshot: (label?: string) => ReaderPerformanceSnapshotV1;
  take: (label?: string) => ReaderPerformanceSnapshotV1;
  reset: (label?: string) => void;
  stop: () => void;
}

export interface ReaderPerformanceEdgeLoadToken {
  run_id: number;
  direction: "up" | "down";
  requested_lids: number;
  started_at_ms: number;
}

interface FrameCounter {
  frame_id: number;
  count: number;
  max: number;
}

interface MutableReaderPerformanceRun {
  run_id: number;
  label: string;
  started_at_ms: number;
  scroll_events: number;
  scroll_checks: number;
  scroll_checks_per_frame: FrameCounter;
  probe_calls: number;
  probe_calls_per_frame: FrameCounter;
  max_probe_candidates: number;
  last_probe_candidates: number;
  probe_self_time_ms: BoundedSampler<number>;
  probe_candidate_counts: BoundedSampler<number>;
  render_calls: number;
  markdown_calls: number;
  katex_calls: number;
  renders_by_kind: Record<string, number>;
  edge_load_started: number;
  edge_load_completed: number;
  edge_load_failed: number;
  edge_requested_lids: number;
  edge_load_samples: BoundedSampler<ReaderPerformanceEdgeLoadSample>;
  first_segment_count: number;
  first_segment_at_ms: number | null;
  first_segment_duration_ms: number | null;
  first_segment_mounted_lids: number | null;
  first_segment_dom_lids: number | null;
  dom_observations: number;
  mounted_lids: number;
  max_mounted_lids: number;
  data_lid_nodes: number;
  max_data_lid_nodes: number;
  frame_intervals_ms: BoundedSampler<number>;
  long_task_count: number;
  long_task_total_duration_ms: number;
  long_task_samples: BoundedSampler<ReaderPerformanceLongTaskSample>;
}

interface ChromiumPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

declare global {
  interface Window {
    __UNDERSTAND_BOOK_READER_PERF__?: ReaderPerformanceControlV1;
  }

  interface Performance {
    memory?: ChromiumPerformanceMemory;
  }
}

let activeRun: MutableReaderPerformanceRun | null = null;
let nextRunId = 1;
let frameId = 0;
let lastFrameTimestamp: number | null = null;
let animationFrameHandle: number | null = null;
let longTaskObserver: PerformanceObserver | null = null;
let firstSegmentRecorded = false;
let cacheSnapshotProvider: (() => ReaderPerformanceCacheSnapshotV1) | null = null;

const EMPTY_CACHE_SNAPSHOT: ReaderPerformanceCacheSnapshotV1 = {
  available: false,
  viewport_width: null,
  html_entries: 0,
  html_capacity: 0,
  text_entries: 0,
  formula_entries: 0,
  hydration_capacity: 0,
};

function createSampler<T>(limit: number): BoundedSampler<T> {
  return { limit, observed: 0, values: [] };
}

function pushSample<T>(sampler: BoundedSampler<T>, value: T): void {
  const index = sampler.observed % sampler.limit;
  if (sampler.values.length < sampler.limit) sampler.values.push(value);
  else sampler.values[index] = value;
  sampler.observed += 1;
}

function snapshotSamples<T>(sampler: BoundedSampler<T>): BoundedSamples<T> {
  const values = sampler.observed <= sampler.limit
    ? [...sampler.values]
    : [
        ...sampler.values.slice(sampler.observed % sampler.limit),
        ...sampler.values.slice(0, sampler.observed % sampler.limit),
      ];
  return {
    limit: sampler.limit,
    observed: sampler.observed,
    dropped: Math.max(0, sampler.observed - sampler.limit),
    values,
  };
}

function createFrameCounter(): FrameCounter {
  return { frame_id: -1, count: 0, max: 0 };
}

function incrementFrameCounter(counter: FrameCounter): void {
  if (counter.frame_id === frameId) counter.count += 1;
  else {
    counter.frame_id = frameId;
    counter.count = 1;
  }
  counter.max = Math.max(counter.max, counter.count);
}

function createRun(label: string): MutableReaderPerformanceRun {
  return {
    run_id: nextRunId++,
    label,
    started_at_ms: performance.now(),
    scroll_events: 0,
    scroll_checks: 0,
    scroll_checks_per_frame: createFrameCounter(),
    probe_calls: 0,
    probe_calls_per_frame: createFrameCounter(),
    max_probe_candidates: 0,
    last_probe_candidates: 0,
    probe_self_time_ms: createSampler(NUMBER_SAMPLE_LIMIT),
    probe_candidate_counts: createSampler(NUMBER_SAMPLE_LIMIT),
    render_calls: 0,
    markdown_calls: 0,
    katex_calls: 0,
    renders_by_kind: {},
    edge_load_started: 0,
    edge_load_completed: 0,
    edge_load_failed: 0,
    edge_requested_lids: 0,
    edge_load_samples: createSampler(EVENT_SAMPLE_LIMIT),
    first_segment_count: 0,
    first_segment_at_ms: null,
    first_segment_duration_ms: null,
    first_segment_mounted_lids: null,
    first_segment_dom_lids: null,
    dom_observations: 0,
    mounted_lids: 0,
    max_mounted_lids: 0,
    data_lid_nodes: 0,
    max_data_lid_nodes: 0,
    frame_intervals_ms: createSampler(NUMBER_SAMPLE_LIMIT),
    long_task_count: 0,
    long_task_total_duration_ms: 0,
    long_task_samples: createSampler(EVENT_SAMPLE_LIMIT),
  };
}

function heapSnapshot(): ReaderPerformanceSnapshotV1["heap"] {
  const memory = performance.memory;
  return memory
    ? {
        supported: true,
        used_js_heap_size: memory.usedJSHeapSize,
        total_js_heap_size: memory.totalJSHeapSize,
        js_heap_size_limit: memory.jsHeapSizeLimit,
      }
    : {
        supported: false,
        used_js_heap_size: null,
        total_js_heap_size: null,
        js_heap_size_limit: null,
      };
}

function snapshotRun(run: MutableReaderPerformanceRun, label = run.label): ReaderPerformanceSnapshotV1 {
  return {
    schema_version: READER_PERFORMANCE_SNAPSHOT_VERSION,
    label,
    started_at_ms: run.started_at_ms,
    ended_at_ms: performance.now(),
    scroll: {
      events: run.scroll_events,
      checks: run.scroll_checks,
      max_checks_per_frame: run.scroll_checks_per_frame.max,
    },
    probe: {
      calls: run.probe_calls,
      max_calls_per_frame: run.probe_calls_per_frame.max,
      max_candidates: run.max_probe_candidates,
      last_candidates: run.last_probe_candidates,
      self_time_ms: snapshotSamples(run.probe_self_time_ms),
      candidate_counts: snapshotSamples(run.probe_candidate_counts),
    },
    render: {
      calls: run.render_calls,
      markdown_calls: run.markdown_calls,
      katex_calls: run.katex_calls,
      by_kind: { ...run.renders_by_kind },
    },
    edge_load: {
      started: run.edge_load_started,
      completed: run.edge_load_completed,
      failed: run.edge_load_failed,
      requested_lids: run.edge_requested_lids,
      samples: snapshotSamples(run.edge_load_samples),
    },
    first_segment: {
      count: run.first_segment_count,
      at_ms: run.first_segment_at_ms,
      duration_ms: run.first_segment_duration_ms,
      mounted_lids: run.first_segment_mounted_lids,
      dom_lids: run.first_segment_dom_lids,
    },
    dom: {
      observations: run.dom_observations,
      mounted_lids: run.mounted_lids,
      max_mounted_lids: run.max_mounted_lids,
      data_lid_nodes: run.data_lid_nodes,
      max_data_lid_nodes: run.max_data_lid_nodes,
    },
    frames: {
      observed: run.frame_intervals_ms.observed,
      interval_ms: snapshotSamples(run.frame_intervals_ms),
    },
    long_tasks: {
      count: run.long_task_count,
      total_duration_ms: run.long_task_total_duration_ms,
      samples: snapshotSamples(run.long_task_samples),
    },
    heap: heapSnapshot(),
    cache: cacheSnapshotProvider?.() ?? { ...EMPTY_CACHE_SNAPSHOT },
  };
}

export function setReaderPerformanceCacheSnapshotProvider(
  provider: (() => ReaderPerformanceCacheSnapshotV1) | null,
): void {
  cacheSnapshotProvider = provider;
}

function resetRun(label: string): void {
  activeRun = createRun(label);
}

function onAnimationFrame(timestamp: number): void {
  frameId += 1;
  if (activeRun && lastFrameTimestamp !== null) {
    pushSample(activeRun.frame_intervals_ms, timestamp - lastFrameTimestamp);
  }
  lastFrameTimestamp = timestamp;
  animationFrameHandle = requestAnimationFrame(onAnimationFrame);
}

function startObservers(): void {
  if (animationFrameHandle === null) animationFrameHandle = requestAnimationFrame(onAnimationFrame);
  if (!("PerformanceObserver" in window)) return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const run = activeRun;
      if (!run) return;
      for (const entry of list.getEntries()) {
        run.long_task_count += 1;
        run.long_task_total_duration_ms += entry.duration;
        pushSample(run.long_task_samples, {
          start_ms: entry.startTime,
          duration_ms: entry.duration,
        });
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    longTaskObserver = null;
  }
}

function stopObservers(): void {
  if (animationFrameHandle !== null) cancelAnimationFrame(animationFrameHandle);
  animationFrameHandle = null;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}

export function installReaderPerformanceDiagnostics(): void {
  if (window[READER_PERFORMANCE_GLOBAL]) return;
  if (new URLSearchParams(window.location.search).get("readerPerf") !== "1") return;
  firstSegmentRecorded = false;
  lastFrameTimestamp = null;
  resetRun("navigation");
  startObservers();
  window[READER_PERFORMANCE_GLOBAL] = {
    schema_version: "reader-performance-control.v1",
    snapshot(label = activeRun?.label ?? "snapshot") {
      if (!activeRun) resetRun(label);
      return snapshotRun(activeRun!, label);
    },
    take(label = activeRun?.label ?? "snapshot") {
      if (!activeRun) resetRun(label);
      const snapshot = snapshotRun(activeRun!, label);
      resetRun(`${label}:next`);
      return snapshot;
    },
    reset(label = "reset") {
      resetRun(label);
    },
    stop() {
      stopObservers();
      activeRun = null;
      delete window[READER_PERFORMANCE_GLOBAL];
    },
  };
}

export function readerPerformanceEnabled(): boolean {
  return activeRun !== null;
}

export function recordReaderScrollEvent(): void {
  if (activeRun) activeRun.scroll_events += 1;
}

export function recordReaderScrollCheck(): void {
  if (!activeRun) return;
  activeRun.scroll_checks += 1;
  incrementFrameCounter(activeRun.scroll_checks_per_frame);
}

export function recordReaderProbe(durationMs: number, candidates: number): void {
  if (!activeRun) return;
  activeRun.probe_calls += 1;
  incrementFrameCounter(activeRun.probe_calls_per_frame);
  activeRun.last_probe_candidates = candidates;
  activeRun.max_probe_candidates = Math.max(activeRun.max_probe_candidates, candidates);
  pushSample(activeRun.probe_self_time_ms, durationMs);
  pushSample(activeRun.probe_candidate_counts, candidates);
  try {
    const end = performance.now();
    performance.measure(PROBE_MEASURE_NAME, { start: end - durationMs, end });
    performance.clearMeasures(PROBE_MEASURE_NAME);
  } catch {
    // User Timing support is optional; the bounded counter remains authoritative.
  }
}

export function recordReaderRender(
  lid: string | null | undefined,
  kind: string | null | undefined,
  text: string,
  markdown: boolean,
): void {
  if (!activeRun) return;
  const bucket = kind || "unknown";
  activeRun.render_calls += 1;
  activeRun.renders_by_kind[bucket] = (activeRun.renders_by_kind[bucket] ?? 0) + 1;
  if (markdown) activeRun.markdown_calls += 1;
  if (markdown && (bucket === "formula" || /\$|\\\(|\\\[/.test(text))) {
    activeRun.katex_calls += 1;
  }
  void lid;
}

export function recordReaderDom(mountedLids: number, dataLidNodes: number): void {
  if (!activeRun) return;
  activeRun.dom_observations += 1;
  activeRun.mounted_lids = mountedLids;
  activeRun.data_lid_nodes = dataLidNodes;
  activeRun.max_mounted_lids = Math.max(activeRun.max_mounted_lids, mountedLids);
  activeRun.max_data_lid_nodes = Math.max(activeRun.max_data_lid_nodes, dataLidNodes);
}

export function recordReaderFirstSegment(mountedLids: number, dataLidNodes: number): void {
  if (!activeRun || firstSegmentRecorded || mountedLids === 0) return;
  firstSegmentRecorded = true;
  const at = performance.now();
  activeRun.first_segment_count = 1;
  activeRun.first_segment_at_ms = at;
  activeRun.first_segment_duration_ms = at - activeRun.started_at_ms;
  activeRun.first_segment_mounted_lids = mountedLids;
  activeRun.first_segment_dom_lids = dataLidNodes;
  try {
    performance.mark(FIRST_SEGMENT_MARK_NAME);
  } catch {
    // The structured timestamp above is the fallback for runtimes without User Timing marks.
  }
}

export function recordReaderEdgeLoadStarted(
  direction: "up" | "down",
  requestedLids: number,
): ReaderPerformanceEdgeLoadToken | null {
  if (!activeRun) return null;
  activeRun.edge_load_started += 1;
  activeRun.edge_requested_lids += requestedLids;
  return {
    run_id: activeRun.run_id,
    direction,
    requested_lids: requestedLids,
    started_at_ms: performance.now(),
  };
}

export function recordReaderEdgeLoadFinished(
  token: ReaderPerformanceEdgeLoadToken | null,
  outcome: "completed" | "failed",
): void {
  if (!token || !activeRun || token.run_id !== activeRun.run_id) return;
  const endedAt = performance.now();
  if (outcome === "completed") activeRun.edge_load_completed += 1;
  else activeRun.edge_load_failed += 1;
  pushSample(activeRun.edge_load_samples, {
    direction: token.direction,
    requested_lids: token.requested_lids,
    start_ms: token.started_at_ms,
    end_ms: endedAt,
    duration_ms: endedAt - token.started_at_ms,
    outcome,
  });
}

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
] as const;

export function readerPerformanceSnapshotMissingFields(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["snapshot"];
  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  if (record.schema_version !== READER_PERFORMANCE_SNAPSHOT_VERSION) missing.push("schema_version");
  for (const section of REQUIRED_SNAPSHOT_SECTIONS) {
    if (!record[section] || typeof record[section] !== "object") missing.push(section);
  }
  return missing;
}
