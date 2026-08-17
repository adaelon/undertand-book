function finiteCounter(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function inspectReaderSurfaceSettlement({
  mountedLids,
  serverLids,
  leafLids,
  edgeLoad,
}) {
  const indexes = serverLids.map((lid) => leafLids.indexOf(lid));
  const viewportCanonical = indexes.every((index, position) => (
    index >= 0 && (position === 0 || index === indexes[position - 1] + 1)
  ));
  const mounted = new Set(mountedLids);
  const viewportContained = serverLids.every((lid) => mounted.has(lid));
  const started = finiteCounter(edgeLoad?.started);
  const completed = finiteCounter(edgeLoad?.completed);
  const failed = finiteCounter(edgeLoad?.failed);
  const activeEdgeLoads = started === null || completed === null || failed === null
    ? null
    : Math.max(0, started - completed - failed);

  return {
    passed: activeEdgeLoads === 0 && viewportCanonical && viewportContained,
    active_edge_loads: activeEdgeLoads,
    viewport_canonical: viewportCanonical,
    viewport_contained: viewportContained,
    server_indexes: indexes,
  };
}

export function uniqueCreatedAnnotation(beforeIds, records, type) {
  const created = records.filter((record) => !beforeIds.has(record.mem_id) && record.type === type);
  if (created.length !== 1) {
    throw new Error(`native selection created ${created.length} ${type} records instead of 1`);
  }
  return created[0];
}

export function readerEdgeLoadFailureMessage({
  label,
  baseline,
  completed,
  context,
}) {
  return `${label} edge load failed: ${JSON.stringify({ baseline, completed, context })}`;
}
