// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  installReaderPerformanceDiagnostics,
  readerPerformanceEnabled,
  readerPerformanceSnapshotMissingFields,
  recordReaderDom,
  recordReaderEdgeLoadFinished,
  recordReaderEdgeLoadStarted,
  recordReaderFirstSegment,
  recordReaderProbe,
  recordReaderRender,
  recordReaderScrollCheck,
  recordReaderScrollEvent,
  READER_PERFORMANCE_GLOBAL,
  setReaderPerformanceCacheSnapshotProvider,
} from "./reader-performance";

afterEach(() => {
  window[READER_PERFORMANCE_GLOBAL]?.stop();
  setReaderPerformanceCacheSnapshotProvider(null);
  window.history.replaceState({}, "", "/");
});

describe("reader performance diagnostics", () => {
  it("records every required section and bounds raw samples", () => {
    window.history.replaceState({}, "", "/?readerPerf=1");
    installReaderPerformanceDiagnostics();
    setReaderPerformanceCacheSnapshotProvider(() => ({
      available: true,
      viewport_width: 20,
      html_entries: 60,
      html_capacity: 100,
      text_entries: 80,
      formula_entries: 25,
      hydration_capacity: 100,
    }));
    const control = window[READER_PERFORMANCE_GLOBAL];
    expect(control?.schema_version).toBe("reader-performance-control.v1");
    expect(readerPerformanceEnabled()).toBe(true);

    recordReaderScrollEvent();
    recordReaderScrollCheck();
    for (let index = 0; index < 2_052; index += 1) {
      recordReaderProbe(index / 100, index);
    }
    recordReaderRender("1.1", "formula", "$x^2$", true);
    recordReaderDom(20, 20);
    recordReaderFirstSegment(20, 20);
    const edge = recordReaderEdgeLoadStarted("down", 20);
    recordReaderEdgeLoadFinished(edge, "completed");

    const snapshot = control!.take("leaf-20");
    expect(readerPerformanceSnapshotMissingFields(snapshot)).toEqual([]);
    expect(snapshot.scroll).toMatchObject({ events: 1, checks: 1 });
    expect(snapshot.probe.calls).toBe(2_052);
    expect(snapshot.probe.self_time_ms).toMatchObject({
      limit: 1_024,
      observed: 2_052,
      dropped: 1_028,
    });
    expect(snapshot.probe.self_time_ms.values).toHaveLength(1_024);
    expect(snapshot.render).toMatchObject({ calls: 1, markdown_calls: 1, katex_calls: 1 });
    expect(snapshot.edge_load).toMatchObject({
      started: 1,
      completed: 1,
      failed: 0,
      requested_lids: 20,
    });
    expect(snapshot.first_segment).toMatchObject({ count: 1, mounted_lids: 20, dom_lids: 20 });
    expect(snapshot.dom).toMatchObject({ mounted_lids: 20, data_lid_nodes: 20 });
    expect(snapshot.cache).toEqual({
      available: true,
      viewport_width: 20,
      html_entries: 60,
      html_capacity: 100,
      text_entries: 80,
      formula_entries: 25,
      hydration_capacity: 100,
    });

    expect(control!.snapshot("after-take").probe.calls).toBe(0);
  });

  it("fails closed when a snapshot omits required metric groups", () => {
    expect(readerPerformanceSnapshotMissingFields(null)).toEqual(["snapshot"]);
    expect(readerPerformanceSnapshotMissingFields({
      schema_version: "reader-performance-snapshot.v1",
      scroll: {},
    })).toEqual([
      "probe",
      "render",
      "edge_load",
      "first_segment",
      "dom",
      "frames",
      "long_tasks",
      "heap",
      "cache",
    ]);
  });
});
