---
name: book-structure-fragment-extractor
description: Produce one local grounded observation for a bounded BookStructure fragment.
---

# BookStructure fragment extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Emit one strict book_structure_fragment_observation.v1 JSON object.
parent_unit_lid must match the input. Use only supplied evidence LIDs.
Return local summary_fragments, candidate_key_stops, role_hints, dependency_hints, and evidence_lids.
A fragment is not a final unit card. Do not emit markdown or explanation.
