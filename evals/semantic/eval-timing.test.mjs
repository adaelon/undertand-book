import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeProductTimings, runTimedProduct } from './eval-timing.mjs';

function clock(walls, monotonic) {
  return {
    wallNow: () => walls.shift(),
    monotonicNow: () => monotonic.shift(),
  };
}

test('records the same deterministic boundary for successful and failed product calls', async () => {
  const success = await runTimedProduct(
    async () => 'ok',
    clock(['2026-09-20T00:00:00Z', '2026-09-20T00:00:01Z'], [10, 25]),
  );
  assert.deepEqual(success, {
    ok: true,
    value: 'ok',
    timing: {
      started_at: '2026-09-20T00:00:00Z',
      finished_at: '2026-09-20T00:00:01Z',
      elapsed_ms: 15,
    },
  });

  const failure = await runTimedProduct(
    async () => { throw new Error('product failed'); },
    clock(['2026-09-20T00:00:02Z', '2026-09-20T00:00:03Z'], [30, 42]),
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, 'product failed');
  assert.deepEqual(failure.timing, {
    started_at: '2026-09-20T00:00:02Z',
    finished_at: '2026-09-20T00:00:03Z',
    elapsed_ms: 12,
  });
});

test('merges restart product segments without replacing their monotonic elapsed time', () => {
  assert.deepEqual(mergeProductTimings([
    { started_at: '2026-09-20T00:00:00Z', finished_at: '2026-09-20T00:00:01Z', elapsed_ms: 100 },
    { started_at: '2026-09-20T00:01:00Z', finished_at: '2026-09-20T00:01:02Z', elapsed_ms: 200 },
  ]), {
    started_at: '2026-09-20T00:00:00Z',
    finished_at: '2026-09-20T00:01:02Z',
    elapsed_ms: 300,
  });
  assert.equal(mergeProductTimings([]), null);
  assert.equal(mergeProductTimings([{ elapsed_ms: 10 }]), null);
});
