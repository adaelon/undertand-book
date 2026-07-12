# ADR-0073 Paper minimap Chinese display cache

Status: Accepted, 2026-07-12.

The paper minimap must be understandable to a Chinese-speaking reader without changing the English paper evidence or making scroll depend on a model call.

## Decision
- Translate region titles and landmark descriptions in one bounded structured LLM request when a paper minimap is first loaded.
- Preserve paper-specific proper nouns, method/model/dataset/metric names, symbols, and acronyms in English.
- Cache only validated display labels, keyed by book id, book version, and `PaperMinimapBase.fingerprint`; never treat them as paper truth or citation evidence.
- Keep coordinates, LIDs, relation types, evidence, reducer state, scroll, and navigation deterministic and independent of translation availability.
- Fall back to deterministic Chinese type labels plus the original source label when the Provider is unavailable or its output is invalid.

## Rejected
- Translating on every scroll or mode change: it adds latency, cost, races, and unstable wording to deterministic navigation.
- Replacing English source text or evidence labels: translated prose cannot become citation truth.
- Requiring paper rebuilds: existing trusted papers must receive the display layer without regenerating their semantic artifacts.

## Consequences
The server owns a user-local, disposable minimap display cache and a bounded localization endpoint. The Web reader requests it once per map identity and renders Chinese display labels without mutating `PaperMinimapBase`.
