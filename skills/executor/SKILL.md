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

In code mode, MCP dots become underscores; use this exact discovery helper in `functions.exec`:
```javascript
function executorTool(operation) {
  const names = {
    "executor.open": "mcp__understand_book_build_executor__executor_open",
    "executor.input.next": "mcp__understand_book_build_executor__executor_input_next",
    "executor.generation.start": "mcp__understand_book_build_executor__executor_generation_start",
    "executor.submit_candidate": "mcp__understand_book_build_executor__executor_submit_candidate"
  };
  const name = names[operation];
  if (!name || !ALL_TOOLS.some(tool => tool.name === name)) {
    throw new Error("bootstrap_unavailable");
  }
  return tools[name];
}

async function executorCall(operation, request) {
  if (operation === "executor.open") store("understand_book_open_request", request);
  const result = await executorTool(operation)(request);
  const response = JSON.parse(result.content.find(item => item.type === "text").text);
  const action = response.action;
  if (action?.kind === "DELIVER_INPUT") {
    store("understand_book_next_request", action.next_request);
  } else if (action?.kind === "INPUT_BATCH") {
    const batch = action.batch;
    store("understand_book_next_request", {
      version: batch.final_for_generation
        ? "automatic_build_executor_generation_start_request.v3"
        : "automatic_build_executor_input_next_request.v4",
      opaque_session_ref: batch.opaque_session_ref,
      generation_input_ref: batch.generation_input_ref,
      ...(batch.final_for_generation
        ? { confirmed_through_ordinal: batch.last_ordinal }
        : { ack_through_ordinal: batch.last_ordinal })
    });
  } else if (action?.kind === "GENERATE") {
    store("understand_book_next_request", {
      version: "automatic_build_executor_candidate_submit.v3",
      opaque_session_ref: action.opaque_session_ref,
      candidate_sink_ref: action.candidate_sink_ref
    });
  } else if (action?.kind === "WAIT") {
    store("understand_book_next_request", load("understand_book_open_request"));
  }
  text(response);
  if (action?.kind === "DONE" || response.version === "automatic_build_executor_mcp_error.v2") {
    const lifecycle = {
      version: "automatic_build_executor_lifecycle.v2",
      status: action?.kind === "DONE" ? action.status : response.status,
      ...(action?.kind === "DONE" ? {} : {
        category: response.category, diagnostic_code: response.diagnostic_code, phase: response.phase
      }),
      protocol: "automatic_build_executor_session.v3"
    };
    store("understand_book_lifecycle", JSON.stringify(lifecycle));
    text(load("understand_book_lifecycle"));
  }
}
```
Include both helper functions above in each `functions.exec` cell. Globals do not survive a cell;
`store/load` do. Call `await executorCall("executor.open", request)` once for open. For later
delivery/start/wait calls use `await executorCall(operation, load("understand_book_next_request"))`.
For submit use `await executorCall("executor.submit_candidate", {
...load("understand_book_next_request"), candidate: YOUR_JSON_VALUE })`.
Never retype returned refs, ordinals, versions, or diagnostics into a subsequent request. The helper
copies control fields from the response; it stores no semantic chunks or candidate bodies.
Do not infer tool absence from suffix searches such as
`endsWith("__open")`. Use the helper against the complete advertised catalog before reporting
a missing tool. Each executorCall makes exactly one MCP call and never loops or prefetches.

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
  fields from `next_request`, including `ack_through_ordinal` when present.
- `action.kind=INPUT_BATCH`: retain every chunk's `payload_utf8` only in this dedicated child
  context, ordered by `segment`, `ordinal`, and `byte_range`. Do not summarize, alter, skip,
  duplicate, hash, or forward a chunk. If `final_for_generation=false`, call `executor.input.next`
  with the same session/input refs, `version=automatic_build_executor_input_next_request.v4`, and
  the batch's exact `last_ordinal` as `ack_through_ordinal`. If `final_for_generation=true`, call
  `executor.generation.start` with the same refs,
  `version=automatic_build_executor_generation_start_request.v3`, and the batch's exact
  `last_ordinal` as `confirmed_through_ordinal`. The internal grant and semantic attempt are created
  only when this start call is accepted.
  Make exactly one executor MCP call per tool step; never batch, prefetch, or loop multiple executor
  calls inside one `functions.exec`.
- `action.kind=GENERATE`: reconstruct the complete semantic prompt and input from the delivered
  chunks, follow that semantic prompt, and produce one strict JSON value satisfying
  `output_contract`. When `retry_feedback` is present, use its `json_pointer` and `expected` to
  correct the previous candidate field error within the current schema. Generate a complete
  candidate from the delivered input; the feedback is not permission to change the schema or
  invent evidence. Keep feedback in this child and never forward it in the lifecycle final.
  Call `executor.submit_candidate` with
  `version=automatic_build_executor_candidate_submit.v3`, the exact returned `opaque_session_ref`
  and `candidate_sink_ref`, and that JSON value as `candidate`.
  Never return candidate JSON to the caller or put it in a file, command, log, or another tool.
- `action.kind=WAIT`: wait exactly `retry_after_ms`, then call `executor.open` again with the same
  original `opaque_handoff_ref`. Do not open another ref or claim work by another route.
- `action.kind=DONE`: stop and return only the bounded lifecycle object defined below.

For DONE or an MCP error, the helper prints the serialized lifecycle object and stores it as
`understand_book_lifecycle`. Copy that exact JSON string as your final response, without retyping
field values, adding quotes around the object, or appending punctuation. If needed, a tool-only
`text(load("understand_book_lifecycle"))` cell can redisplay it without another MCP call.

This child and its connection serve exactly one opaque handoff ref. After DONE or any terminal
error, this child is finished. A later work unit or recovery ref requires a new child and a fresh
connection, even when the dispatch slot is unchanged. Never accept another ref through followup.

Every replay uses the exact previous request. Do not self-judge schema, evidence, identity,
quality, writer, terminal, or retry state; tool responses and the durable Build Engine are
authoritative.

## Root-guided open correction

The caller may attach bounded control feedback describing a previous open failure and its original
reported_diagnostic. For a fresh child, use only the attached Driver-issued handoff ref; never reuse
the failed child's obsolete ref. This feedback does not change semantic instructions or authorize
extra tool arguments.

If Root supplies a correction while this child is still live, before its lifecycle final, and no
open has succeeded, an `invalid_arguments` error at `phase=open`, `field=opaque_handoff_ref` may be
corrected on this same unbound connection. Replace only the incorrect open ref with the caller's
original issued ref, store the corrected open request, and call executor.open once. Preserve the
actual error diagnostic in the control feedback; do not label it bootstrap_unavailable. Do not
repeat an identical failed request or make more than three Root-guided corrections. Unknown
request versions, bound connections, connection_terminal and completed child finals cannot use
this exception. After a lifecycle final, let Driver issue a replacement to a fresh child.

## Failure, permission, and privacy boundary

If no Executor MCP tool call has been accepted because the dedicated server or a required tool is
absent, startup failed, or the current interaction mode cannot call it, do not fall back to shell,
skills, paths, or a generic agent. Return only:

```json
{
  "version": "automatic_build_executor_lifecycle.v2",
  "status": "interrupted",
  "category": "bootstrap",
  "diagnostic_code": "bootstrap_unavailable"
}
```

Except for the live unbound Root-guided correction above, if an accepted tool call returns
`automatic_build_executor_mcp_error.v2`, stop immediately and
preserve its exact `status`, `category`, `diagnostic_code`, and `phase` in this lifecycle object:

```json
{
  "version": "automatic_build_executor_lifecycle.v2",
  "status": "<exact error.status>",
  "category": "<exact error.category>",
  "diagnostic_code": "<exact error.diagnostic_code>",
  "phase": "<exact error.phase>",
  "protocol": "automatic_build_executor_session.v3"
}
```

Do not relabel an observed MCP error as bootstrap failure, retry without the correction exception, or infer task completion
from the lifecycle object. The caller recomputes durable state after every child terminal.
In particular, preserve session/connection_terminal/open and session/handoff_ref_mismatch/open
exactly. They describe this connection's refusal to open; they are not protocol_incompatible.

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
