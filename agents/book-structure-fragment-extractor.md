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
Observation output = {"version":"book_structure_fragment_observation.v1","parent_unit_lid":string,"summary_fragments":AnchoredText[],"candidate_key_stops":KeyStop[],"role_hints":Role[],"dependency_hints":string[],"evidence_lids":string[]}. All fields are required.
parent_unit_lid must match the input. dependency_hints must be empty for local observations; stitching decides dependencies. Retain only evidence in reference_scope.evidence_by_unit[parent_unit_lid]. Do not summarize other chapters.
Observation output example:
```json
{"version":"book_structure_fragment_observation.v1","parent_unit_lid":"1","summary_fragments":[{"text":"Defines the chapter concept.","evidence_lids":["1.1"]}],"candidate_key_stops":[{"id":"stop-1","lid":"1.1","type":"definition","reason":{"text":"Introduces the central definition.","evidence_lids":["1.1"]}}],"role_hints":["foundation"],"dependency_hints":[],"evidence_lids":["1.1"]}
```
