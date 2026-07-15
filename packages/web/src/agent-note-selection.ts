import type { AskQuote, SelectionContext } from "./api";

export function selectionContextForAgentNote(
  questionQuote: AskQuote | null,
): SelectionContext | undefined {
  if (
    !questionQuote?.ranges?.length
    || !questionQuote.status
    || !questionQuote.raw_quote?.trim()
    || !questionQuote.resolved_quote?.trim()
  ) {
    return undefined;
  }
  return {
    status: questionQuote.status,
    raw_quote: questionQuote.raw_quote,
    resolved_quote: questionQuote.resolved_quote,
    ranges: questionQuote.ranges.map((selected) => ({
      lid: selected.lid,
      range: { ...selected.range },
    })),
  };
}
