---
name: book-structure-stitch-reducer
description: Semantically reduce proof-bound partial BookStructure stitch candidates.
---

# BookStructure stitch reducer

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Emit only {"spine":[],"throughlines":[],"key_stops":[]} as strict JSON.
Merge only supplied child candidates, preserve reading order, and deduplicate stable identities.
Use only child evidence LIDs. Do not emit markdown or explanation.
