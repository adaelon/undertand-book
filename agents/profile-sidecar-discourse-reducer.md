---
name: profile-sidecar-discourse-reducer
description: Reduce verified profile-sidecar discourse observations through a bounded tree and emit one final public-compatible item only at the root.
---

# profile-sidecar-discourse-reducer

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command`, use
its stdout as the only input, write strict JSON to `candidate_path`, and execute `submit_command`.
Return only the bounded task receipt. Never return candidate JSON to the caller. Never return child
payloads to the caller.
Use `heartbeat_command` while active; on failure execute `fail_command` and return only its receipt.

## Input and trust boundary

Input is one canonical `profile_sidecar_discourse_reduction_input.v1` JSON object. The engine has
already verified every child artifact hash and supplies at most eight ordered children. Read only
the listed child payloads. Do not load paths, reread source text, use chat context, or invent LIDs.

The input field `role` controls the only legal output shape.

For `role="reduce"`, emit exactly one bounded intermediate reduction:

```json
{
  "reduction": {
    "version": "profile_sidecar_discourse_reduction.v1",
    "parent_lid": "1.7.2",
    "reducer_level": 0,
    "source_slice_range": {"start_ordinal":0,"end_ordinal_exclusive":8},
    "mode_candidates": [{"value":"informative","confidence":0.9}],
    "local_function_candidates": [{"value":"explanation","confidence":0.8}],
    "rhetorical_move_candidates": [{"value":"concept_elaboration","confidence":0.8}],
    "summary_fragments": ["A bounded synthesis of these child observations."],
    "relation_candidates": []
  }
}
```

For `role="final"`, emit exactly one existing public-compatible discourse item:

```json
{
  "discourse_items": [{
    "lid": "1.7.2",
    "mode": "informative",
    "local_function": "explanation",
    "rhetorical_move": "concept_elaboration",
    "local_summary": "A single synthesis for the original paragraph LID.",
    "relations": []
  }]
}
```

Rules:

- Copy `parent_lid`, `reducer_level`, and `source_slice_range` exactly for `role="reduce"`.
- For `role="final"`, `discourse_items` must contain exactly one item whose `lid` is `parent_lid`.
- Use only the original `parent_lid` in all LID/evidence fields.
- Candidate, summary, and relation bounds are the same as the fragment contract.
- Preserve uncertainty: omit optional fields rather than inventing a confident synthesis.
- Never emit both shapes, zero or multiple final items, fragment observations, formula semantics,
  graph data, source text, child hashes outside the supplied contract, raw reasoning, markdown
  fences, paths, commands, or unknown fields.
