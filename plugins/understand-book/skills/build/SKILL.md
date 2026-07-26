---
name: understand-book-build
description: Build or resume a Markdown/EPUB book or trusted paper Workbench workspace with one Codex invocation.
---

# $understand-book-build

Run the deterministic automatic-build v2 loop until `done`, `needs_user`, or an exhausted external
failure. Do not stop at ordinary stage boundaries, substitute generic summaries for extractor
output, or treat conversation memory as build state.

## Resolve the build engine

1. Resolve `understand-book-build.exe` in this order:
   - use `UNDERSTAND_BOOK_BUILD_EXE` when it names an existing file;
   - on Windows, read `InstallDir` from `HKCU\Software\UnderstandBook` and use the executable in
     that directory;
   - otherwise tell the user to install the Understand Book desktop reader.
2. Do not install Node, Bun, Cargo, or another runtime as an implicit fallback. The released plugin
   is driven by the packaged build engine.
3. After installing or upgrading the engine, run
   `<build-exe> protocol-doctor <target> --plugin-root <this-plugin-root>`. Consume only
   `automatic_build_protocol_doctor.v1`; require `status=compatible`,
   `production_default=automatic_build_protocol.v2_dispatch`, and `dry_run_mutates_state=false`.

## Automatic-build v2 loop

This skill invocation is the explicit legacy full-build command. Before protocol preflight, map it
once to a confirmed `standard_deep` BuildPlan:

```text
<build-exe> legacy-plan <target> --root <root> [quality and budget flags]
```

Consume only `explicit_legacy_build_plan.v1`, require
`plan.confirmation_source=explicit_legacy_command`, and retain `build_plan_path`. Add
`--build-plan <build_plan_path>` to every `protocol-doctor`, `plan`, and `next` command below.
Opening, importing, or resuming a book is not this invocation and must never run `legacy-plan`.
An existing SidecarPlan is a stage option only and must not be substituted for this BuildPlan.

Recompute the number of currently available dedicated subagent slots before every `plan` and
`next`. Keep the same target, quality profile, budget flags, and `--max-parallel` request throughout
one accepted plan. `--max-parallel` is in `1..3`; `--available-agent-slots` is in `0..3`.

1. Run preflight:

   ```text
   <build-exe> plan <target> --plugin-root <this-plugin-root> --max-parallel <1..3> --available-agent-slots <0..3> [quality and budget flags]
   ```

   Parse only the `automatic_build_plan.v1` JSON from stdout. Planning is read-only: it must not
   create task, attempt, or lease state. If `preflight` is null, continue to `next` without an
   accepted digest. Inspect lifetime, remaining, and scheduled cost plus wall-clock P50/P95,
   agent starts, confidence, and `worker_plan.max_workers`. If `preflight.budget.status` is
   `exceeded`, report `needs_user(budget_exceeded)` without claiming work. When a wall budget is
   configured, also retain `preflight.preflight_evaluation_digest`; low-confidence or exceeded
   wall budgets stop before claim as `needs_user(low_confidence_wall_budget)` or
   `needs_user(wall_budget_exceeded)`. Otherwise retain `preflight.plan_digest`.

2. Run the accepted step:

   ```text
   <build-exe> next <target> --plugin-root <this-plugin-root> --max-parallel <1..3> --available-agent-slots <current> [same quality and budget flags] [--accepted-plan <plan_digest>] [--accepted-evaluation <preflight_evaluation_digest>]
   ```

   Parse only the `automatic_build_next.v1` JSON from stdout. A change to the target, descriptors,
   quality policy, budget policy, or requested worker limit invalidates the accepted plan and
   requires a fresh `plan`. A changed performance-history evaluation requires a newly accepted
   evaluation digest but does not change descriptor or artifact identity. A change only to
   available slots does not change plan identity. Performance history is usable only when
   `--executor-model`, `--executor-reasoning-effort`, and `--executor-harness-release` are all
   supplied and exactly match stage, kind, router, and recorded provenance.

   `automatic_build_protocol.v2_dispatch` is the BP8 production default for new claims. `next`
   persists the accepted full dispatch plan and returns `action.kind=dispatch` without claiming its
   tasks. `--executor-dispatches` remains only as a compatibility alias. A task-per-executor rollback
   must explicitly pass `--protocol automatic_build_protocol.v2`; it reads the same v2 task and
   artifact state without migrating or rewriting already published artifacts, and it must not be
   used to bypass dispatch diagnostics.

3. Handle `action.kind` exactly:

   - `dispatch`: launch exactly `action.dispatches.length` dedicated subagents, one per manifest,
     rather than one per work unit. Give each subagent the extractor prompt and one
     `automatic_build_dispatch_executor.v1` envelope with its explicit `dispatch_run_id`. The
     subagent loops `next_command`, which may return at most one `task` envelope at a time. Execute
     that task with the same input/candidate/usage/submit/fail/heartbeat contract below, discard its
     candidate body after the terminal task receipt, and call `dispatch.next` again. Continue after
     a semantic task failure; on executor, process, or command infrastructure failure, execute
     `interrupt_command` immediately and stop the manifest suffix. For `waiting`, wait only
     `retry_after_ms`; for `finish`, execute `finish_command`; for `finished`, return only the bounded
     `automatic_build_executor_dispatch_receipt.v1` to the root. The root validates only the
     dispatch receipt count and byte limits, then replans with live slots so the next persisted
     manifest can refill a free worker without waiting for slower active dispatches.
   - `extract`: this is only the explicit v2 rollback path. Require dedicated subagent slots. The number launched must equal
     `action.tasks.length` and must not exceed `worker_plan.max_workers`. Read
     `extractor_prompt_command` when supplied, otherwise use `extractor_prompt`. Give each subagent
     only that complete prompt and one `automatic_build_executor.v1` envelope containing:

     ```text
     task_id / attempt_number(= semantic_attempt) / execution_identity / lease_ref
     input_command / candidate_path / candidate_command / usage_path / submit_command
     heartbeat_command / fail_command / inspect_command
     ```

     A new claim first enters a 10-minute `reserved` phase. The first side effect of
     `input_command` must create `start.json` with create-only semantics and begin an independent
     30-minute `running` deadline; repeated input starts read the same record. `heartbeat_command`
     may extend only a nonterminal running lease whose token, owner, target, stage, work unit, and
     execution identity all match. It must never extend a reserved or expired lease.

     Each subagent executes `input_command` and treats its stdout as the only extraction input. It
     writes the model result to a private source file in the same task mailbox, replaces
     `{candidate_source}` in `candidate_command` with that path, and executes the command. The
     helper accepts only UTF-8 no-BOM or single-BOM JSON and normalizes `candidate_path` to UTF-8
     no-BOM. Never use PowerShell 5.1 `Set-Content -Encoding UTF8` directly for `candidate_path`.
     The root agent must never receive, restate, cache, write, or forward candidate JSON. When native or executor-reported usage is
     available, the subagent writes an `automatic_build_usage_receipt.v1` to `usage_path`.
     Otherwise it leaves that path absent; `source=unavailable` must not contain exact token fields.
     When proven, the receipt also records `model`, `reasoning_effort`, and `harness_release`;
     missing provenance stays absent and the summary reports it explicitly as unavailable with
     separate coverage. These values must never be guessed.
     The subagent then executes `submit_command`. On success it returns only the bounded
     `automatic_build_task_receipt.v1` from submit stdout. On failure it executes `fail_command` and
     returns only the failure receipt. It uses `heartbeat_command` for long work.

     The root validates the temporary receipt list against
     `receipt_aggregation.expected_receipts` and `receipt_aggregation.max_total_bytes`, discards the
     list, and returns to preflight. It must not call the `legacy-submit` compatibility command.
   - `waiting`: wait no longer than `retry_after_ms`, then return to preflight. Do not duplicate an
     active lease.
   - `close_stage`: execute `command` exactly. Never append `--allow-partial`. A semantic close must
     carry a passing `automatic_build_stage_quality_report.v1`; the engine recomputes it before
     transactional publication.
   - `needs_user`: stop and show the structured reason and recovery commands. In particular:
     - `executor_unavailable`: report the required dedicated capacity; never let the root emulate a
       subagent.
     - `preflight_required` or `plan_changed`: return to `plan`; do not claim stale work.
     - `evaluation_required` or `evaluation_changed`: return to `plan` and accept the current
       `preflight_evaluation_digest`; do not claim against stale performance history.
     - `low_confidence_wall_budget` or `wall_budget_exceeded`: show the wall-clock violations and
       confidence data; do not claim work.
     - `legacy_migration_required`: show the read-only audit plus the `legacy_resume` and
       `v2_rebuild` commands and wait for an explicit user choice.
     - `quality_gate_failed`: show integrity and selected quality-floor violations separately;
       never override them with LLM self-review or `--allow-partial`.
     - retry exhaustion: show task ids, last diagnostics, and reset commands. Execute reset only
       after explicit user confirmation.
   - `done`: report the workspace and completed stages, then end the invocation.

4. Return to `plan` immediately after every dispatch receipt, submitted batch, or closed stage. `.build/<stage>` plus
   the v2 task/lease/mailbox state is the only resume truth. Attempt counts and completion state
   must never be reconstructed from conversation history.

## Hard boundaries

- A paper must already have trusted source reconciliation and hybrid foundation artifacts from the
  desktop Build Workbench. This plugin verifies and consumes them; it does not replace the
  human-reviewed foundation.
- Markdown and EPUB inputs run the full applicable pipeline from the source file.
- Dedicated subagents are mandatory for semantic extraction. Missing capacity is
  `needs_user(executor_unavailable)`, not permission to generate empty nodes, generic sidecars, or
  reject-all classifications.
- Automatic repair permits at most three total attempts per task. The durable attempt ledger,
  leases, mailbox, and receipts are authoritative.
- Legacy or mixed artifacts must pass `audit-legacy` and an explicit migration choice before v2
  claims. `v2_rebuild` snapshots old artifacts; it does not delete or relabel them in place.
- Public artifacts are published only when the complete policy-bound candidate set passes integrity
  and quality gates. Failed publication preserves the previous public set.
