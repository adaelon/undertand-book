function defaultClock() {
  return {
    wallNow: () => new Date().toISOString(),
    monotonicNow: () => performance.now(),
  };
}

export async function runTimedProduct(operation, clock = defaultClock()) {
  const started_at = clock.wallNow();
  const started = clock.monotonicNow();
  try {
    const value = await operation();
    return {
      ok: true,
      value,
      timing: {
        started_at,
        finished_at: clock.wallNow(),
        elapsed_ms: Math.max(0, clock.monotonicNow() - started),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error,
      timing: {
        started_at,
        finished_at: clock.wallNow(),
        elapsed_ms: Math.max(0, clock.monotonicNow() - started),
      },
    };
  }
}

export function mergeProductTimings(timings) {
  if (!Array.isArray(timings) || !timings.length
    || timings.some(timing => !timing?.started_at || !timing?.finished_at
      || !Number.isFinite(timing.elapsed_ms) || timing.elapsed_ms < 0)) return null;
  const started = timings[0].started_at;
  const finished = timings.at(-1).finished_at;
  if (!Number.isFinite(Date.parse(started)) || !Number.isFinite(Date.parse(finished))
    || Date.parse(finished) < Date.parse(started)) return null;
  return {
    started_at: started,
    finished_at: finished,
    elapsed_ms: timings.reduce((sum, timing) => sum + timing.elapsed_ms, 0),
  };
}
