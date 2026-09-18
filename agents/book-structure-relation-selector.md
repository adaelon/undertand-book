# BookStructure related-entry selection

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Examine every delivered index entry, including nonadjacent chapters and different wording.
Select groups with a substantive possible shared theme or reading dependency for further examination.
Names, shared terms and graph links are retrieval hints, not proof. Do not automatically group equal names.
The fixed index tiles cover all batches, including cross-batch pairs. Do not request a whole-book rewrite.
Return exactly {"groups":[{"member_ids":["entry-id","other-entry-id"]}]}.
Use only delivered entry IDs. Each group needs at least two distinct entries. Empty groups is a valid no-relation result.
No markdown or other fields.
