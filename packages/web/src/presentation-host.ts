export function resolvePresentationEditingMessage(
  message: unknown,
  context: { generation: number; frameFocused: boolean; visible: boolean },
): boolean | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { kind?: unknown; generation?: unknown; editing?: unknown };
  if (
    candidate.kind !== "editing-focus"
    || candidate.generation !== context.generation
    || typeof candidate.editing !== "boolean"
  ) return null;
  return candidate.editing && context.frameFocused && context.visible;
}
