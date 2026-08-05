---
name: profile-sidecar-discourse-fragment-extractor
description: Extract one bounded, engine-private discourse observation from the CORE of a profile-sidecar model input slice.
---

# profile-sidecar-discourse-fragment-extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command`, use
its stdout as the only source input, write strict JSON to `candidate_path`, and execute
`submit_command`. Return only the bounded task receipt. Never return candidate JSON, source text,
or prompt text to the caller. Use `heartbeat_command` while active and `fail_command` on failure.

## Boundary

This extractor observes exactly one slice of one existing paragraph LID. It does not emit a public
discourse item, formula semantics, graph data, or Pass2 edges. `CONTEXT_BEFORE` and
`CONTEXT_AFTER` may help interpretation, but every proposed signal must describe only `CORE`.

Input is the deterministic document:

```text
PROFILE_SIDECAR_DISCOURSE_FRAGMENT
content_profile_id: technical_learning
parent_lid: 1.7.2
source_slice_ordinal: 0
boundary_kind: sentence
core_span_utf16: {"start":5629,"end":7100}
context_span_utf16: {"start":5629,"end":7164}

CONTEXT_BEFORE
...

CORE
...

CONTEXT_AFTER
...
```

Output exactly one closed object:

```json
{
  "version": "profile_sidecar_discourse_observation.v1",
  "parent_lid": "1.7.2",
  "source_slice_ordinal": 0,
  "core_sha256": "<digest supplied by the task contract>",
  "mode_candidates": [{"value":"informative","confidence":0.9}],
  "local_function_candidates": [{"value":"explanation","confidence":0.8}],
  "rhetorical_move_candidates": [{"value":"concept_elaboration","confidence":0.8}],
  "summary_fragments": ["A bounded summary of what this CORE contributes."],
  "relation_candidates": []
}
```

Rules:

- Copy `parent_lid`, `source_slice_ordinal`, and the task-supplied `core_sha256` exactly.
- Each candidate list contains at most three entries; omit uncertain candidates.
- `summary_fragments` contains at most eight non-empty strings, each at most 200 characters.
- Relations are sparse and may cite only the original `parent_lid`; never invent another LID.
- Do not quote or reproduce `CORE`, `CONTEXT_BEFORE`, or `CONTEXT_AFTER` in the output.
- Do not emit `discourse_items`, `formula_semantics`, `reduction`, raw reasoning, markdown fences,
  source spans, paths, commands, prompt text, or unknown fields.

Closed enums are identical to the existing profile sidecar contract:

```text
mode: informative | argumentative | procedural | descriptive | meta
local_function: definition | description | classification | explanation | cause | effect |
  example | counterexample | comparison | contrast | procedure_step | application | warning |
  limitation | question | answer | summary | research_question | hypothesis | related_work |
  method_description | experiment_setup | evidence_report | result_interpretation | future_work |
  transition
rhetorical_move: chapter_setup | problem_framing | prerequisite | main_point |
  concept_elaboration | worked_example | case_analysis | argument_support | objection |
  resolution | recap | abstract_summary | related_work_positioning | method_setup |
  experiment_report | result_claim | limitation_acknowledgement | future_work_projection |
  bridge_to_next
```
