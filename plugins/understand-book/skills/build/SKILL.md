---
name: understand-book-build
description: Build or resume a book workspace, optionally from a confirmed natural-language reading goal shared with the Reader.
---

# $understand-book-build

Choose the request's planning route, obtain an explicitly confirmed `BuildPlan`, and then let the
deterministic Build Engine drive execution until it returns `DONE` or a real user boundary. The
root Codex owns semantic planning, user conversation, live agent-slot observation, and harness
lifecycle only. It does not interpret the internal build state machine.

## Authority and privacy boundary

- Reader/Core owns the current source, content profile, Blueprint validation, plan identity, and
  reader-private store.
- `build.step` owns protocol compatibility, preflight, budgets, dispatch state, leases, retries,
  stage close/publication, private artifact attempts, and completion.
- A dedicated executor owns one opaque semantic session. It sees semantic input and writes a
  candidate through the code-owned session sink.
- The root never reads, receives, summarizes, caches, or forwards semantic input or candidate JSON.
- The root must not call, probe, enumerate, or use `executor.open` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.input.next` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.generation.start` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.submit_candidate` to diagnose a handoff.
- Conversation memory is not build state. Re-enter through the same confirmed plan and invocation;
  code rereads durable state on every step.

## Choose the planning route first

Ordinary prebuild is the default. A request to build, prebuild, finish, or resume a book/paper
workspace uses the explicit `standard_deep` route unless the user also states a concrete reading
goal and asks the build to produce goal-specific results. A title, subject description, workspace
path, or request to “build this paper” is not by itself a natural-language reading goal.

- **Ordinary prebuild or resume:** use **Explicit standard deep build** below. When an existing
  confirmed `build_plan_path` or invocation can be recovered, resume it instead of creating a new
  plan. Do not call `planning.context`, launch `UnderstandBook.exe --codex-build-intent`, or open or
  inspect a Reader-private build plan for this route.
- **Explicit reading goal:** only when the user asks to plan the build around a stated reading goal,
  use **Natural-language reading goal** below. The goal route may call the Desktop controller and
  produce reader-private artifacts.

Do this classification before either plan-authoring surface is called. Never reinterpret an
ordinary prebuild request as a reading goal merely because the workspace contains a paper.

## Resolve the installed Reader and Build Engine

1. Resolve `understand-book-build.exe` in this order:
   - use `UNDERSTAND_BOOK_BUILD_EXE` when it names an existing file;
   - on Windows, read `InstallDir` from `HKCU\Software\UnderstandBook` and use the executable there;
   - otherwise tell the user to install or repair Understand Book.
2. Resolve `UnderstandBook.exe` from `UNDERSTAND_BOOK_DESKTOP_EXE` when set, otherwise from the same
   `InstallDir`. It is the only controller for reader-private intent planning.
3. Do not install Node, Bun, Cargo, or another runtime as an implicit fallback. Do not fall back to
   old build commands when the packaged entry reports an incompatible installation.

## Establish one confirmed plan

Execution requires one current, code-issued `build_plan_path`. Treat that path as an opaque output
of planning: do not parse, edit, duplicate, or replace the plan in chat.

### Explicit standard deep build

Before authoring a `standard_deep` plan, ask whether Pass2 long-range relation extraction is enabled
or disabled. Enabling Pass2 adds cross-section semantic links and model cost; disabling it still
builds BookStructure from Pass1 and profile sidecars. Record the answer exactly as
`pass2=enabled|disabled`; do not infer it from “full build,” old conversations, existing artifacts,
or the workspace profile. Also ask for any budget limit that changes authorization.

For a new standard plan, call the installed code-owned surface directly:

```text
<build-exe> legacy-plan <target> --root <root> --pass2 <enabled|disabled> [budget flags]
```

Consume only `explicit_legacy_build_plan.v1`. Show its exact stage closure,
reuse/create/excluded work, token and wall-clock estimate, budget, `plan_id`, and `plan_digest`.
Require explicit confirmation of that exact projection before accepting its `build_plan_path`.
Never infer Pass2, budget approval, or plan confirmation from “full build,” old conversations, or
existing artifacts. Keep the returned path opaque and reuse it for interruption recovery; never
create another standard plan merely to resume. If no unique confirmed plan path is available, stop as
`needs_user(plan_confirmation_required)`.

### Natural-language reading goal

A natural-language goal must be explicit and planned against an absolute workspace already trusted by Reader.
The Desktop controller response is the only authority for whether foundation is required. Stop as
`needs_user(foundation_required)` only when `UnderstandBook.exe --codex-build-intent` returns
`error_code=CODEX_BUILD_FOUNDATION_REQUIRED`. Do not inspect `.build/input/manifest.json`, source
manifests, PDFs, optional sidecars, or workspace names to invent a profile or foundation gate.

For every controller call, put only `--codex-build-intent` in argv and send exactly one JSON object
on stdin. Never place the raw goal or candidate in argv, environment variables, shell interpolation,
public files, stdout, stderr, logs, or the displayed plan.

1. Request current planning context:

   ```json
   {"version":"codex_build_intent_command.v2","operation":"planning.context","target":{"workspace_dir":"<absolute>"},"input":{}}
   ```

   Consume one `codex_build_intent_result.v2` whose response is
   `build_planning_context.v1`. Read only its bounded scope catalog, Blueprint Registry summaries,
   candidate contract, and `context_digest`. If v2 is unavailable, stop as
   `needs_user(CODEX_BUILD_INTENT_V2_REQUIRED)`. Never fall back to `codex_build_intent_command.v1`.

2. Create one strict `build_intent_planner_candidate.v2` from the explicit goal and current
   context. Select advertised Registry identities exactly or provide a complete bounded one-off
   `artifact_blueprint.v1`; never guess a truncated entry. Scope may use only shown LIDs/sections or
   `whole_book=true`. Every free-form string search field such as topic, title, question, or claim
   uses `analyzer=text`; bounded exact categories may use `analyzer=keyword`. Do not add code,
   recursion, remote schemas, raw goal text, plan identities, or Reader-private paths.

3. Send `codex_build_intent_command.v2` with `operation=draft.candidate` and
   `input={user_goal,planning_context_digest,candidate,budget?}` over protected stdin. On
   `BUILD_PLANNING_CONTEXT_DRIFT`, discard the old context and candidate, call `planning.context`
   again, and replan. Do not silently drop a requested artifact or invoke a second planner.

4. Require `codex_build_intent_response.v1` with a `codex_build_intent_plan.v2` projection. Show the
   goal kind, scope, artifact summaries, public stage closure, reuse/create/excluded work, estimates,
   budget, `plan_id`, and `plan_digest`, then stop as `needs_user(plan_confirmation_required)`.
   After approval, re-read status; if identity drifted, show the new projection and reconfirm.
   Otherwise confirm the exact identity with `confirmation_source=codex_conversation` and retain
   the returned private `build_plan_path` without displaying it.

## Start or recover the deterministic driver

Send exactly one bounded stdin object to `<build-exe> build.step`. For a new confirmed plan, create
the invocation:

```json
{
  "version": "automatic_build_invocation_create.v1",
  "target_input": "<target>",
  "root_dir": "<root>",
  "build_plan_path": "<confirmed opaque path>",
  "quality_profile": "full",
  "max_parallel": 1,
  "created_at": "<ISO-8601>",
  "budget": "<optional versioned budget>",
  "wall_budget": "<optional versioned wall budget>",
  "executor_provenance": "<optional proven provenance>"
}
```

Omit optional fields rather than sending placeholders. `max_parallel` is fixed in `1..3` for the
invocation. Consume only `automatic_build_invocation_ref.v1` and retain its `invocation_ref` in the
task checkpoint. Recreating the exact same request is idempotent; changing target, plan, quality,
budget, or requested parallelism starts a different invocation and may require new confirmation.

Before every step, count currently available dedicated subagent slots and send:

```json
{
  "version": "automatic_build_step_request.v1",
  "invocation_ref": "<opaque invocation ref>",
  "available_agent_slots": 0
}
```

`available_agent_slots` is live capacity in `0..3`; it is not remembered from a previous turn. A
fresh user choice is added only as
`decision={request_id:<returned id>,choice_id:<selected returned id>}`. Never send a digest,
receipt body, command, path inspection result, or reconstructed stage status.

## Four-action loop

Consume only `automatic_build_step.v1`. Handle its action exactly and call `build.step` again after
the external boundary is resolved:

- `SPAWN_EXECUTORS`: merge returned `opaque_handoff_ref` values into a local pending set after
  excluding every ref already present in `live_by_ref` or `completed_refs`. Launch at most one
  dedicated subagent per pending ref, filling only the currently available live slots. Choose each
  ref's bootstrap provider in this strict order:
  1. If the spawn tool advertises `agent_type=understand_book_executor`, select that custom agent
     explicitly and give it only this payload, with the returned ref substituted exactly:
     ```text
     Process exactly this code-issued opaque handoff ref and return only bounded lifecycle state:
     <opaque_handoff_ref>
     ```
  2. Otherwise, if `$understand-book-executor` is advertised, launch a default dedicated subagent
     and give it only this fallback payload, with the returned ref substituted exactly:
     ```text
     Use $understand-book-executor for exactly this opaque handoff ref:
     <opaque_handoff_ref>
     Return only the bounded lifecycle state defined by that skill.
     Do not use $understand-book-build inside this subagent.
     ```
  3. If neither provider is advertised, do not launch an unbound generic subagent and never emulate
     the executor in root. Treat the boundary as `interrupted/bootstrap_unavailable`, then call
     `build.step` again and trust its durable result.
  The ref is the only dynamic spawn data in either provider path. Do not add a target path, prompt,
  task input, hash, command list, receipt, or candidate. While `live_by_ref` is non-empty, wait only
  until the first owned child becomes terminal; record only that child's bounded lifecycle state,
  move only its ref to `completed_refs`, and immediately call `build.step`. Every other live ref
  remains owned and must not be duplicated, orphaned, or forgotten. Never wait for all children
  before rereading durable state, and never treat the first child final as global completion.
- `WAIT`: if an owned child is live, wait for its first terminal event as above. Otherwise wait only
  `retry_after_ms`, then recompute live slots and call `build.step` again. Do not duplicate an active
  executor or lease.
- `NEEDS_USER`: show the returned `reason`, `message`, optional `projection`, and choices exactly.
  Never invent or broaden choices. If choices are present, wait for the user and return the selected
  `request_id + choice_id` in the next step. If choices are empty, report the external blocker and
  do not manufacture a decision.
- `DONE`: require `live_by_ref` to be empty, report only the returned completion summary, and end.
  This covers both public stages and any declared reader-private artifacts; the root has no separate
  private-artifact loop.

Continue across ordinary executor completions, stage boundaries, retries, and internal recovery.
Stop only at `NEEDS_USER`, `DONE`, explicit user interruption, or a packaged-engine failure for
which no structured action exists. Never emulate a dedicated executor in the root.

## Dedicated executor contract

Each subagent receives one `opaque_handoff_ref` and follows the
`automatic_build_executor_session.v3` protocol in the dedicated executor instructions:

```text
executor.open(ref)
  -> DELIVER_INPUT: follow next_request through executor.input.next
  -> INPUT_BATCH: retain ordered chunks only in the dedicated child; send non-final `last_ordinal` as `ack_through_ordinal` to input.next, or send the final `last_ordinal` as `confirmed_through_ordinal` to generation.start
  -> GENERATE: produce one strict JSON value; send it through executor.submit_candidate; continue
  -> WAIT: wait retry_after_ms; reopen the same ref
  -> DONE: return only committed | retryable_failure | interrupted
```

The ref is not a filesystem path and must not be decoded or inspected. The session code performs
all path, length, hash, schema, identity, mailbox, lease, receipt, writer, quality, and retry gates.
The semantic extractor prompts remain byte-stable and use their ordinary strict-JSON output branch;
the session does not supply the old command envelope. Semantic chunks may appear only in the
dedicated child tool-result context, and candidate JSON may appear only in that child's structured
`executor.submit_candidate` request and the code-owned mailbox. No candidate source file, path
submit, shell fallback, child final, or root projection is allowed.

## Hard boundaries

- The root must not call, probe, enumerate, or use `executor.open` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.input.next` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.generation.start` to diagnose a handoff.
- The root must not call, probe, enumerate, or use `executor.submit_candidate` to diagnose a handoff.
- Dedicated subagents are mandatory for semantic generation; missing capacity is represented by a
  structured driver action, never permission to synthesize empty or generic artifacts in root.
- Paper foundation remains owned by Build Workbench and Reader. This skill cannot bypass source
  reconciliation or artifact gates.
- The engine's durable plan, invocation, dispatch/task session, mailbox, receipt, and artifact state
  are the only resume truth.
- Do not expose raw stderr, stack traces, internal commands, absolute private paths, prompt bodies,
  task input, raw goals, LID allowlists, candidate bodies, or accepted private bodies to root chat.
- Do not change extractor prompt bytes as part of this orchestration protocol.
