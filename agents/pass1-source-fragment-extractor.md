---
name: pass1-source-fragment-extractor
description: Extract bounded Pass1 nodes and local edges from the CORE of one source slice while preserving the original parent LID as the only evidence anchor.
---

# pass1-source-fragment-extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command`, use
its stdout as the only source input, write strict JSON to `candidate_path`, and execute
`submit_command`. Return only the bounded task receipt. Never return candidate JSON, source text,
or prompt text to the caller. Use `heartbeat_command` while active and `fail_command` on failure.

## Boundary

This extractor sees one deterministic model-input slice of one existing leaf LID. Interpret
`CONTEXT_BEFORE` and `CONTEXT_AFTER`, but extract nodes and edges only from `CORE`. The original
`parent_lid` remains the sole citation/evidence anchor; the slice ordinal and source spans are
engine-private and must never become LIDs.

Input begins with `PASS1_SOURCE_FRAGMENT` and supplies `content_profile_id`, `parent_lid`,
`source_slice_ordinal`, `core_sha256`, stable spans, and the three context partitions.

Output exactly one closed object:

```json
{
  "version": "pass1_source_fragment_output.v1",
  "parent_lid": "1.7.2",
  "source_slice_ordinal": 0,
  "core_sha256": "<copy exactly from input>",
  "nodes": [
    {"id":"concept:bounded_example","type":"concept","name":"Bounded example","occurrences":["1.7.2"],"source_lid":null},
    {"id":"claim:1.7.2:bounded-claim","type":"claim","name":"A claim stated by CORE","occurrences":[],"source_lid":"1.7.2"}
  ],
  "edges": [
    {"source":"claim:1.7.2:bounded-claim","target":"concept:bounded_example","type":"exemplifies","direction":"directed","scope":"local","weight":0.8}
  ]
}
```

Rules:

- Copy `parent_lid`, `source_slice_ordinal`, and `core_sha256` exactly.
- Every `occurrences` and non-null `source_lid` value must equal `parent_lid`.
- Claims use one `source_lid` and empty `occurrences`; entities/concepts use `occurrences` and a
  null `source_lid`.
- Every edge is `scope="local"` and both endpoint ids occur in this output's `nodes`.
- Do not infer relations that require another slice; `pass1-lid-stitcher` owns those.
- Do not quote source text or emit spans, new LIDs, public artifacts, summaries, raw reasoning,
  markdown fences, paths, commands, prompt text, or unknown fields.
