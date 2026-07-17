# Manual source override after one reviewed rerun

Status: Accepted, 2026-07-10. Revises ADR-0063's unconditional unresolved hard stop.
Revised by: ADR-0082 for hybrid-foundation geometry trust and downstream quality routing.

After every current source-review block has an evidence-usable persisted decision, source reconciliation runs exactly once against the reviewed draft. If deterministic reconciliation still reports residual unresolved blocks, the system preserves those diagnostics but accepts the reviewed draft with explicit `manual_override` provenance and continues the build. The user's completed review is the terminal source-text decision; the same residual blocks are not returned for another review or automatic rerun.

## Boundaries

- The override cannot bypass the first complete review round or consume an ephemeral LLM suggestion.
- Only the reviewed draft assembled from persisted decisions can be overridden into `source.txt`.
- The override does not waive LID, schema, hash, source-map integrity, or downstream artifact integrity gates. ADR-0082 classifies mapping coverage as quality; this override still cannot certify PDF geometry.

## Consequence

Books accepted this way are auditable but no longer deterministically source-equivalent to the PDF. Consumers must be able to distinguish `manual_override` from a reconciliation report with zero unresolved blocks.
