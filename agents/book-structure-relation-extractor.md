# BookStructure relationship delta

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Judge only the delivered related entries and their anchored evidence. Shared names do not prove identity or dependency.
Return exactly {"new_throughlines":[],"extend_throughlines":[],"merge_throughlines":[],"add_dependencies":[]}.
AnchoredText = {"text":string,"evidence_lids":string[]}; text at most 600 characters, evidence nonempty.
new_throughlines items = {"id":string,"name":string,"summary":AnchoredText,"lids":string[],"key_stop_ids":string[]}.
extend_throughlines items = {"throughline_id":string,"summary":AnchoredText,"lids":string[],"key_stop_ids":string[]}.
merge_throughlines items = {"source_ids":string[],"name":string,"summary":AnchoredText}.
add_dependencies items = {"unit_lid":string,"depends_on":string,"evidence_lids":string[]}.
Use only delivered throughline IDs, key-stop IDs, units and paragraph evidence. IDs are at most 256 UTF-8 bytes; names at most 1024 bytes.
Extensions preserve existing members. Merge at least two delivered themes; the program assigns the surviving identity.
Every theme summary must cite evidence covering all declared or retained members; each dependency cites evidence for both units.
Empty arrays mean no supported change. Never return spine or key_stops tables. No markdown or other fields.
