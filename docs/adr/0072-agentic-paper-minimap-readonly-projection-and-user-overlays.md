# ADR-0072 Agentic paper minimap / read-only projection / user overlays

Status: Accepted, 2026-07-12.

The paper map remains an auxiliary global navigator: a stable PDF/section topology with current position and evidence-backed landmarks, collapsed by default and expanded only by the user. It must not become a summary panel, a second paper truth, or an independently running agent.

## Decision
- Derive `PaperMinimapBase` deterministically from trusted LID/PDF maps plus BookStructure, discourse, and graph/Pass2; do not persist a new paper artifact.
- Keep `skim / abstract / deep` minimap lenses separate from Reader layout presets; lenses change overlays, never coordinates.
- Reuse the resident reader agent and command surface. Scroll and navigation synchronize position deterministically; natural-language goals or feedback are the only LLM trigger.
- Let the agent select validated projections through typed actions; the reducer owns IDs, evidence, grammar, density, revision, effect/proposal, and undo gates.
- Keep paper truth immutable. Session changes are reversible overlays; confirmed long-term changes are provenance-bearing user overlays in a separate private structured store.
- Keep viewport position, user selection, and map focus independent. Agent focus never navigates unless the user explicitly requests navigation.

## Rejected
- A free-form LLM map or agent-authored relation graph: it can invent structure and cannot be deterministically validated.
- A background minimap agent reacting to scroll: it destroys spatial stability and adds cost and races.
- Storing UI overlays in the paper workspace or prose memory: either pollutes shared truth or gives structured reducer state the wrong owner.

## Consequences
The reader needs a deterministic minimap projection, a `reader.paper_minimap` state/reducer, a private saved-overlay store, and a collapsed/expanded frontend surface. Missing semantic artifacts degrade individual layers; stale PDF/LID topology makes the map unavailable.
