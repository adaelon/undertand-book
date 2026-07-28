export interface MarkdownNotePlacementTarget {
  lid: string;
}

function eventElement(event: PointerEvent): Element | null {
  const target = event.composedPath()[0] ?? event.target;
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isIgnoredPlacementTarget(element: Element): boolean {
  if (element.closest(".note-card, .hl-card, .block-actions, [data-note-placement-ignore]")) return true;
  const interactive = element.closest("button, a, input, textarea, select, [role=\"button\"]");
  return !!interactive && !interactive.matches(".formula-open");
}

export function resolveMarkdownNotePlacementTarget(
  event: PointerEvent,
  root: HTMLElement,
  validLids: ReadonlySet<string>,
): MarkdownNotePlacementTarget | null {
  const element = eventElement(event);
  if (!element || !root.contains(element) || isIgnoredPlacementTarget(element)) return null;
  const body = element.closest<HTMLElement>("[data-lid]");
  if (!body || !root.contains(body)) return null;
  const lid = body.dataset.lid?.trim() ?? "";
  return lid && validLids.has(lid) ? { lid } : null;
}
