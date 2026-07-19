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

## Automatic-build v2 loop

Recompute the number of currently available dedicated subagent slots before every `plan` and
`next`. Keep the same target, quality profile, budget flags, and `--max-parallel` request throughout
one accepted plan. `--max-parallel` is in `1..3`; `--available-agent-slots` is in `0..3`.

1. Run preflight:

   ```text
   <build-exe> plan <target> --plugin-root <this-plugin-root> --max-parallel <1..3> --available-agent-slots <0..3> [quality and budget flags]
   ```

   Parse only the `automatic_build_plan.v1` JSON from stdout. Planning is read-only: it must not
   create task, attempt, or lease state. If `preflight` is null, continue to `next` without an
   accepted digest. If `preflight.budget.status` is `exceeded`, report
   `needs_user(budget_exceeded)` without claiming work. Otherwise retain
   `preflight.plan_digest` and inspect `worker_plan.max_workers`.

2. Run the accepted step:

   ```text
   <build-exe> next <target> --plugin-root <this-plugin-root> --max-parallel <1..3> --available-agent-slots <current> [same quality and budget flags] [--accepted-plan <plan_digest>]
   ```

   Parse only the `automatic_build_next.v1` JSON from stdout. A change to the target, descriptors,
   quality policy, budget policy, or requested worker limit invalidates the accepted plan and
   requires a fresh `plan`. A change only to available slots does not change plan identity.

3. Handle `action.kind` exactly:

   - `extract`: require dedicated subagent slots. The number launched must equal
     `action.tasks.length` and must not exceed `worker_plan.max_workers`. Read
     `extractor_prompt_command` when supplied, otherwise use `extractor_prompt`. Give each subagent
     only that complete prompt and one `automatic_build_executor.v1` envelope containing:

     ```text
     task_id / attempt_number / lease_ref
     input_command / candidate_path / usage_path / submit_command
     heartbeat_command / fail_command / inspect_command
     ```

     Each subagent executes `input_command` and treats its stdout as the only extraction input. It
     writes the model result directly to `candidate_path`; the root agent must never receive,
     restate, cache, write, or forward candidate JSON. When native or executor-reported usage is
     available, the subagent writes an `automatic_build_usage_receipt.v1` to `usage_path`.
     Otherwise it leaves that path absent; `source=unavailable` must not contain exact token fields.
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
     - `legacy_migration_required`: show the read-only audit plus the `legacy_resume` and
       `v2_rebuild` commands and wait for an explicit user choice.
     - `quality_gate_failed`: show integrity and selected quality-floor violations separately;
       never override them with LLM self-review or `--allow-partial`.
     - retry exhaustion: show task ids, last diagnostics, and reset commands. Execute reset only
       after explicit user confirmation.
   - `done`: report the workspace and completed stages, then end the invocation.

4. Return to `plan` immediately after every submitted batch or closed stage. `.build/<stage>` plus
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
