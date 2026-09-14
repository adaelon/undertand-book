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
Output contract (exact field names; no extra fields):
AnchoredText = {"text": string, "evidence_lids": string[]}. Use this object for every summary and reason, never a bare string.
Role = setup | foundation | method | application | case | synthesis. Choose setup for front matter or orientation; do not invent roles.
KeyStopType = definition | formula | claim | example | turning_point | warning | summary.
KeyStop = {"id": string, "lid": string, "type": KeyStopType, "reason": AnchoredText, "title"?: string}. Only title is optional.
reference_scope is the authoritative citation contract, derived from the delivered content. Use evidence_by_unit[unit_lid] for that unit summary and key stops. Unit identities and graph node IDs are not paragraph citations. Never infer LIDs from IDs.
Graph edges are retrieval hints, not proof of a relationship. Base judgments on delivered excerpts or anchored child summaries. A shared concept alone does not establish a dependency. Anchor each substantive summary/reason in non-empty evidence_lids.
Keep text concise (at most 600 characters). IDs/LIDs are non-empty strings of at most 256 UTF-8 bytes; optional titles and throughline names at most 1024 bytes.
Empty arrays are valid when the input supports no key stops, dependencies, or throughlines. Do not fabricate content to fill an array.
Examples below illustrate the schema using LIDs 1 and 1.1. Replace them with this input's actual LIDs and grounded content; do not copy example facts.
Stitch output = {"spine":SpineUnit[],"throughlines":Throughline[],"key_stops":KeyStop[]}. Always return these three arrays.
SpineUnit = {"lid":string,"role":Role,"summary":AnchoredText,"key_stop_ids":string[],"depends_on":string[]}. All fields are required; lid identifies the supplied unit.
Throughline = {"id":string,"name":string,"summary":AnchoredText,"lids":string[],"key_stop_ids":string[]}. All fields are required.
key_stop_ids must reference unique IDs present in this candidate's key_stops. spine.lid is a supplied unit ID. depends_on selects other unit IDs from reference_scope.dependency_target_lids, never paragraph or graph node IDs. Judge dependencies from both units' delivered content. Preserve reading order and deduplicate stable identities.
Each spine summary cites only reference_scope.evidence_by_unit[spine.lid]. A throughline may span chapters, but its summary must cite evidence for every declared unit or paragraph in lids. context_unit_cards provide counterpart material. Do not copy writer-owned reference_scope or context_units into the output.
Stitch output example:
```json
{"spine":[{"lid":"1","role":"foundation","summary":{"text":"Defines the chapter concept.","evidence_lids":["1.1"]},"key_stop_ids":["stop-1"],"depends_on":[]}],"throughlines":[{"id":"line-1","name":"Core concept","summary":{"text":"Connects the chapter to its definition.","evidence_lids":["1.1"]},"lids":["1"],"key_stop_ids":["stop-1"]}],"key_stops":[{"id":"stop-1","lid":"1.1","type":"definition","reason":{"text":"Introduces the central definition.","evidence_lids":["1.1"]}}]}
```
