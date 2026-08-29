---
name: book-structure-stitch-fragment-extractor
description: Produce one bounded partial BookStructure stitch candidate.
---

# BookStructure stitch fragment extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Emit only a partial {"spine":[],"throughlines":[],"key_stops":[]} JSON candidate.
Use only supplied unit cards and long-range edge evidence.
Preserve unit order and stable key-stop identities. Do not emit markdown or explanation.
