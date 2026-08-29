---
name: book-structure-reducer
description: Reduce proof-bound BookStructure fragment observations.
---

# BookStructure unit reducer

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Consume only the supplied proof-bound child observations.
When role is reduce, emit one book_structure_fragment_observation.v1 JSON object.
When role is final, emit only {"unit_card":...} for parent_unit_lid.
Deduplicate stable key stops and dependencies; use only child evidence LIDs. No markdown.
