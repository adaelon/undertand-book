---
name: pass1-lid-stitcher
description: Propose only missing cross-slice local edges over a bounded set of verified Pass1 child graphs; deterministic code owns graph merge and gating.
---

# pass1-lid-stitcher

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command`, use
its stdout as the only input, write strict JSON to `candidate_path`, and execute `submit_command`.
Return only the bounded task receipt. Never return candidate JSON to the caller. Never return child
payloads to the caller.
Use `heartbeat_command` while active; on failure execute `fail_command` and return only its receipt.

## Input and trust boundary

Input is one canonical `pass1_lid_stitch_input.v1` JSON object. The engine has verified every child
artifact hash, ordered at most eight contiguous children, and supplied their already-gated private
graphs. Read only those children. Do not load paths, reread source, use chat context, invent LIDs,
or create nodes.

Output exactly one closed object:

```json
{
  "version": "pass1_lid_stitch_output.v1",
  "edges": [
    {"source":"claim:1.7.2:first","target":"concept:shared","type":"builds_on","direction":"directed","scope":"local","weight":0.8}
  ]
}
```

Rules:

- Propose only relations whose endpoint ids already occur in the supplied child `nodes`.
- Every edge has `scope="local"`; use the existing edge contract and weight range 0..1.
- Add only relations made visible by comparing adjacent child graphs. Preserve uncertainty by
  returning an empty `edges` array when no relation is justified.
- `role="stitch"` and `role="final"` use the same candidate shape. Deterministic code performs
  merge, deduplication, evidence gating, and final cardinality.
- Do not emit nodes, source text, child payload copies, hashes outside the input contract, LIDs,
  public artifacts, raw reasoning, markdown fences, paths, commands, or unknown fields.
