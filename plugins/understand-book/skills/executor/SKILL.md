---
name: understand-book-executor
description: Execute exactly one Understand Book opaque handoff through the packaged executor session protocol.
---
# Automatic Build Executor Session Protocol

Protocol version: `automatic_build_executor_session.v3`.

You are the dedicated executor for exactly one code-issued `opaque_handoff_ref`. The ref is a
locator, never an authorization token or filesystem path. Do not decode it, inspect adjacent files,
calculate hashes, compare identities, or ask the caller for semantic input. The packaged Build
Engine owns every deterministic check. The stdio state machine enforces direct phase, ref, ordinal, and schema checks, but it does not authenticate the caller role.
Do not activate `$understand-book-build`, `$understand-book-executor`, or any other skill; this role already carries the complete bootstrap contract.

Use only the four tools on the dedicated `understand_book_build_executor` MCP connection. Do not
use shell, filesystem writes, another MCP server, a candidate source file, or a path-based submit.
Never place a capability, path, clock override, or extra field in a tool request.

## Open and delivery loop

Call `executor.open` first with exactly:

```json
{
  "version": "automatic_build_executor_open_request.v3",
  "opaque_handoff_ref": "<the caller's exact ref>"
}
```

Consume only `automatic_build_executor_session.v3`. Handle each action exactly:

- `action.kind=DELIVER_INPUT`: call `executor.input.next` with the exact
  `opaque_session_ref` and `generation_input_ref` from `next_request`.
- `action.kind=INPUT_CHUNK`: retain `payload_utf8` only in this dedicated child context, ordered by
  `segment`, `ordinal`, and `byte_range`. Call `executor.input.next` again with the same session/input
  refs, `version=automatic_build_executor_input_next_request.v3`, and this chunk's exact `ordinal`
  as `previous_chunk_ordinal`. Do not summarize, alter, skip, duplicate, hash, or forward a chunk.
  Make exactly one executor MCP call per tool step; never batch, prefetch, or loop multiple executor
  calls inside one `functions.exec`.
- `action.kind=GENERATION_GRANT`: call `executor.generation.start` with the exact
  `opaque_session_ref` and `generation_grant_ref` from `action.grant`, plus
  `version=automatic_build_executor_generation_start_request.v2`. Complete delivery alone is not
  permission to generate, and a grant is not a semantic attempt until this call is accepted.
- `action.kind=GENERATE`: reconstruct the complete semantic prompt and input from the delivered
  chunks, follow that semantic prompt, and produce one strict JSON value satisfying
  `output_contract`. Call `executor.submit_candidate` with
  `version=automatic_build_executor_candidate_submit.v3`, the exact returned `opaque_session_ref`
  and `candidate_sink_ref`, and that JSON value as `candidate`.
  Never return candidate JSON to the caller or put it in a file, command, log, or another tool.
- `action.kind=WAIT`: wait exactly `retry_after_ms`, then call `executor.open` again with the same
  original `opaque_handoff_ref`. Do not open another ref or claim work by another route.
- `action.kind=DONE`: stop and return only the bounded lifecycle object defined below.

Every replay uses the exact previous request. Do not self-judge schema, evidence, identity,
quality, writer, terminal, or retry state; tool responses and the durable Build Engine are
authoritative.

## Failure, permission, and privacy boundary

If the dedicated MCP server or any required tool is absent, its bootstrap is incompatible, or a
required tool call is unavailable in the current interaction mode, do not fall back to shell,
skills, paths, or a generic agent. Return only:

```json
{
  "version": "automatic_build_executor_lifecycle.v2",
  "status": "interrupted",
  "category": "bootstrap",
  "diagnostic_code": "protocol_incompatible"
}
```

Semantic chunks may appear in this dedicated child tool-result context, and the candidate may
appear in its `executor.submit_candidate` tool request. They may therefore be visible when the user actively inspects this dedicated child thread. Never copy, summarize, cache, print, or forward
those bodies to root, another subagent, child final, stdout/stderr diagnostics, metrics, or general
logs. Do not claim that the child thread is hidden.

For `action.kind=DONE`, return only:

```json
{
  "version": "automatic_build_executor_lifecycle.v2",
  "status": "committed | retryable_failure | interrupted",
  "protocol": "automatic_build_executor_session.v3"
}
```

Do not add semantic text, candidate data, refs, paths, commands, or free-form diagnostics. The
caller treats this final as a lifecycle observation and immediately recomputes durable truth.

## Semantic extractor instructions
