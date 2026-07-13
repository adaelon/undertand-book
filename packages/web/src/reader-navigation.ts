export function resolveReaderNavigationTarget(
  requestedLid: string,
  leafOrder: readonly string[],
): string | null {
  if (leafOrder.includes(requestedLid)) return requestedLid;
  const prefix = `${requestedLid}.`;
  return leafOrder.find((lid) => lid.startsWith(prefix)) ?? null;
}

interface ReaderNavigationTraceStep {
  tool: string;
  result_digest: string;
}

export function hasSuccessfulReaderNavigation(
  trace: readonly ReaderNavigationTraceStep[],
): boolean {
  return trace.some((step) => (
    step.tool === "reader.gotoLid" || step.tool === "reader.scroll"
  ) && /"ok"\s*:\s*true/.test(step.result_digest));
}

export function resolveReaderStateNavigationTarget(
  viewportTopLid: string,
  selectionLid: string | null,
  leafOrder: readonly string[],
): string {
  if (!selectionLid) return viewportTopLid;
  return resolveReaderNavigationTarget(selectionLid, leafOrder) ?? viewportTopLid;
}
