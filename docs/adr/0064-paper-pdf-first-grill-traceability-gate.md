# ADR-0064 Paper PDF-first Grill traceability gate
Status: Accepted, 2026-07-09.
Extends: ADR-0063.

The PDF-first paper design came from a long Grill sequence with duplicated question numbers, later corrections, and several deliberately deferred decisions. To prevent implementation from following an obsolete intermediate answer, the slice plan must carry a traceability ledger that maps every Grill item to `covered`, `superseded`, or `deferred`.

## Decision
Every implementation slice under the paper PDF-first / Build Workbench line must preserve the traceability ledger in `docs/切片方案-paper-pdf-first-hybrid.md`. A Grill decision is not considered ready for implementation unless the ledger points to a current section, a superseding decision, or a named deferred slice.

## Rules
1. Duplicated Grill numbers must be disambiguated by label, for example `G15a` and `G15b`.
2. Superseded Grill answers remain visible in the ledger with the newer decision that replaces them.
3. Deferred items must have an explicit future slice or non-goal; they cannot silently disappear.
4. The ledger is documentation truth for coverage only; the executable truth still comes from schemas, build artifacts, deterministic gates, and tests.
5. When a later Grill changes scope, update the ledger in the same documentation slice as the ADR or implementation plan.

## Consequences
- ADR-0063 remains the architectural decision; ADR-0064 adds the audit rule that keeps the Grill chain implementable.
- Implementation reviews can check the ledger before coding to avoid reopening already-settled design branches.
- Missing ledger entries are treated as documentation debt and block the relevant implementation slice.
