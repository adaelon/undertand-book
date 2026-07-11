# Separate reader trust from surface selection

Status: Superseded by ADR-0071, 2026-07-11.

Artifact readiness remains the only authority for whether a workspace may enter the reader, but it no longer forces the frontend to leave Build Workbench. Once reader trust is available, the user explicitly switches between Build Workbench and reader; the selection is stored per `book_id` in browser `sessionStorage`, so it survives refresh within the session without becoming backend or book truth.

## Boundaries

- An untrusted workspace always opens Build Workbench regardless of the stored selection.
- A trusted workspace with no stored selection opens reader by default.
- Completing a stage while Build Workbench is visible does not navigate automatically.
- Technical-learning books keep their existing direct-reader path.
