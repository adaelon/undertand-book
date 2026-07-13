export function resolveReaderNavigationTarget(
  requestedLid: string,
  leafOrder: readonly string[],
): string | null {
  if (leafOrder.includes(requestedLid)) return requestedLid;
  const prefix = `${requestedLid}.`;
  return leafOrder.find((lid) => lid.startsWith(prefix)) ?? null;
}
