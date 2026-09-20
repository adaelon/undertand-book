import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileExportLedger, MemoryExportLedger } from "../src/export-ledger.js";
import type { LangSmithRunClient } from "../src/langsmith-client.js";
import { exportPrebuildObservations } from "../src/prebuild-export.js";
import {
  projectPrebuildReceipts,
  readPrebuildProjection,
  type PrebuildAttemptFact,
  type PrebuildObservationV1,
} from "../src/prebuild-projector.js";
import type { AutomaticBuildLifecycleEventV1 } from "../../core/src/automatic-build-metrics.js";
import { failAutomaticBuildTask } from "../../core/src/automatic-build-mailbox.js";
import { claimAutomaticBuildTask, startAutomaticBuildLease } from "../../core/src/automatic-build-lease.js";
import { resolveAutomaticBuildTarget } from "../../core/src/build-orchestrator.js";
import type { AutomaticBuildExecutionIdentity } from "../../core/src/automatic-build-task-store.js";

const provenance = {
  model: "unavailable",
  reasoning_effort: "unavailable",
  harness_release: "unavailable",
};

function identity(input: {
  work: string;
  semantic: number;
  lease: number;
  submit?: number;
  scope: string;
  source?: "native" | "legacy_inferred";
}): AutomaticBuildExecutionIdentity {
  return {
    version: "automatic_build_execution_identity.v2",
    work_unit_id: input.work,
    semantic_attempt: input.semantic,
    lease_epoch: input.lease,
    submit_revision: input.submit ?? 0,
    attempt_scope_digest: input.scope,
    identity_source: input.source ?? "native",
  };
}

function event(input: {
  kind: AutomaticBuildLifecycleEventV1["kind"];
  work: string;
  physical: number;
  at: string;
  execution?: AutomaticBuildExecutionIdentity;
  submit?: number;
  diagnostic?: string;
}): AutomaticBuildLifecycleEventV1 {
  return {
    version: "automatic_build_lifecycle_event.v1",
    kind: input.kind,
    task_ref: `pass1/${input.work}/${input.physical}`,
    stage: "pass1",
    work_unit_id: input.work,
    physical_attempt: input.physical,
    ...(input.execution ? { execution_identity: input.execution } : {}),
    observed_at: input.at,
    ...(input.submit ? { submit_revision: input.submit } : {}),
    ...(input.diagnostic ? { diagnostic_code: input.diagnostic } : {}),
    provenance,
  };
}

function attempt(input: {
  work: string;
  physical: number;
  execution?: AutomaticBuildExecutionIdentity;
  source?: "native" | "executor_reported" | "unavailable";
}): PrebuildAttemptFact {
  return {
    work_unit_id: input.work,
    physical_attempt: input.physical,
    ...(input.execution ? { execution_identity: input.execution } : {}),
    usage: {
      version: "automatic_build_usage_receipt.v1",
      source: input.source ?? "unavailable",
      ...(input.source === "native"
        ? { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 }
        : {}),
    },
  };
}

function project(input: {
  lifecycle: AutomaticBuildLifecycleEventV1[];
  attempts: PrebuildAttemptFact[];
}): PrebuildObservationV1[] {
  return projectPrebuildReceipts({
    target_ref: "build_target_ref.v2:book-fixture",
    source_revision_ref: "source-revision-7",
    stage: "pass1",
    ...input,
  });
}

function directorySnapshot(root: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (statSync(absolute).isDirectory()) visit(absolute);
      else entries.push([relative, readFileSync(absolute, "utf8")]);
    }
  };
  visit(root);
  return entries;
}

describe("prebuild receipt projection", () => {
  it("keeps work units, lease epochs, semantic retries, submits, and usage sources distinct", () => {
    const first = identity({ work: "unit-a", semantic: 1, lease: 1, submit: 2, scope: "scope-a" });
    const released = identity({ work: "unit-a", semantic: 1, lease: 2, scope: "scope-a" });
    const retry = identity({ work: "unit-a", semantic: 2, lease: 1, scope: "scope-a" });
    const parallel = identity({ work: "unit-b", semantic: 1, lease: 1, scope: "scope-b" });
    const observations = project({
      attempts: [
        attempt({ work: "unit-a", physical: 1, execution: first, source: "native" }),
        attempt({ work: "unit-a", physical: 2, execution: released }),
        attempt({ work: "unit-a", physical: 3, execution: retry, source: "executor_reported" }),
        attempt({ work: "unit-b", physical: 1, execution: parallel }),
      ],
      lifecycle: [
        event({ kind: "executor_started", work: "unit-a", physical: 1, at: "2026-09-20T00:00:00Z", execution: first }),
        event({ kind: "candidate_submitted", work: "unit-a", physical: 1, at: "2026-09-20T00:00:01Z", execution: first, submit: 1 }),
        event({ kind: "candidate_submitted", work: "unit-a", physical: 1, at: "2026-09-20T00:00:02Z", execution: first, submit: 2 }),
        event({ kind: "task_committed", work: "unit-a", physical: 1, at: "2026-09-20T00:00:03Z", execution: first }),
        event({ kind: "lease_expired", work: "unit-a", physical: 2, at: "2026-09-20T00:01:00Z", execution: released }),
        event({ kind: "executor_started", work: "unit-a", physical: 3, at: "2026-09-20T00:02:00Z", execution: retry }),
        event({ kind: "task_failed", work: "unit-a", physical: 3, at: "2026-09-20T00:02:03Z", execution: retry, diagnostic: "provider_failed" }),
        event({ kind: "executor_started", work: "unit-b", physical: 1, at: "2026-09-20T00:00:00Z", execution: parallel }),
        event({ kind: "task_committed", work: "unit-b", physical: 1, at: "2026-09-20T00:00:04Z", execution: parallel }),
      ],
    });

    expect(new Set(observations.map((item) => item.observation_identity)).size).toBe(4);
    expect(observations.map((item) => [
      item.work_unit_id,
      item.physical_attempt,
      item.semantic_attempt,
      item.lease_epoch,
      item.submit_revision,
      item.status,
    ])).toEqual([
      ["unit-a", 1, 1, 1, 2, "committed"],
      ["unit-a", 2, 1, 2, null, "lease_expired"],
      ["unit-a", 3, 2, 1, null, "failed"],
      ["unit-b", 1, 1, 1, null, "committed"],
    ]);
    expect(observations[0].usage).toMatchObject({
      source: "provider_reported",
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 4,
    });
    expect(observations[1].usage).toEqual({
      source: "unavailable",
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      estimate_input_tokens: null,
      estimate_output_tokens: null,
      estimate_method: null,
    });
  });

  it("marks invalid chronology and malformed timestamps unavailable", () => {
    const execution = identity({ work: "unit-a", semantic: 1, lease: 1, scope: "scope-a" });
    const observations = project({
      attempts: [
        attempt({ work: "unit-a", physical: 1, execution }),
        attempt({ work: "unit-a", physical: 2, execution }),
      ],
      lifecycle: [
        event({ kind: "executor_started", work: "unit-a", physical: 1, at: "2026-09-20T00:00:05Z", execution }),
        event({ kind: "task_failed", work: "unit-a", physical: 1, at: "2026-09-20T00:00:01Z", execution }),
        event({ kind: "executor_started", work: "unit-a", physical: 2, at: "not-a-time", execution }),
      ],
    });
    expect(observations.map((item) => item.timing)).toEqual([
      { source: "unavailable", started_at: null, finished_at: null },
      { source: "unavailable", started_at: null, finished_at: null },
    ]);
  });
});

describe("prebuild LangSmith export", () => {
  it("reuses run identity, only advances changed revisions, and never mutates source receipts", async () => {
    const source = mkdtempSync(path.join(tmpdir(), "ub-prebuild-source-"));
    const sourceFile = path.join(source, "fixture.md");
    writeFileSync(sourceFile, "# Fixture\n", "utf8");
    const target = resolveAutomaticBuildTarget(sourceFile, source);
    const lease = claimAutomaticBuildTask(target, "pass1", "unit-a", {
      owner: "observability-test",
      now: "2026-09-20T00:00:00Z",
      ttl_ms: 60_000,
    });
    if (lease.status !== "leased") throw new Error("expected fixture lease");
    startAutomaticBuildLease(target, lease.lease_ref, lease.lease.token, {
      now: "2026-09-20T00:00:01Z",
      run_ttl_ms: 60_000,
    });
    failAutomaticBuildTask(target, lease.lease_ref, lease.lease.token, {
      diagnostic_code: "provider_failed",
      now: "2026-09-20T00:00:03Z",
    });
    const before = directorySnapshot(source);
    const [observation] = readPrebuildProjection(
      target,
      "pass1",
      "source-revision-7",
      { now: "2026-09-20T00:00:04Z" },
    );
    const calls: Array<{ method: string; runId: string }> = [];
    const client: LangSmithRunClient = {
      createRun: async (value) => { calls.push({ method: "create", runId: value.id }); },
      updateRun: async (runId) => { calls.push({ method: "update", runId }); },
    };
    const ledger = new MemoryExportLedger();

    expect(await exportPrebuildObservations({ observations: [observation], project: "fixture", client, ledger }))
      .toMatchObject({ sent: [observation.observation_identity], skipped: [], failed: [] });
    const runId = calls[0].runId;
    expect(await exportPrebuildObservations({ observations: [observation], project: "fixture", client, ledger }))
      .toMatchObject({ sent: [], skipped: [observation.observation_identity], failed: [] });
    const changed = { ...observation, revision: observation.revision + 1 };
    await exportPrebuildObservations({ observations: [changed], project: "fixture", client, ledger });
    expect(calls).toEqual([
      { method: "create", runId },
      { method: "update", runId },
    ]);
    expect(directorySnapshot(source)).toEqual(before);
    rmSync(source, { recursive: true, force: true });
  });

  it("persists exporter identity separately from source receipts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ub-export-ledger-"));
    const file = path.join(root, "state", "ledger.json");
    const first = new FileExportLedger(file);
    const entry = first.ensure("observation-a");
    first.confirm("observation-a", 3);
    const reopened = new FileExportLedger(file);
    expect(reopened.ensure("observation-a")).toEqual({
      run_id: entry.run_id,
      last_revision: 3,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("does not confirm missing timing or failed SDK calls", async () => {
    const ledger = new MemoryExportLedger();
    const base: PrebuildObservationV1 = {
      schema_version: "ub_prebuild_observation.v1",
      projection_source: "durable_receipts",
      observation_identity: "missing-time",
      revision: 1,
      target_ref: "target",
      source_revision_ref: "source",
      stage: "pass1",
      work_unit_id: "unit",
      physical_attempt: 1,
      semantic_attempt: null,
      lease_epoch: null,
      submit_revision: null,
      attempt_scope: null,
      identity_source: "unavailable",
      status: "unknown",
      timing: { source: "unavailable", started_at: null, finished_at: null },
      usage: {
        source: "unavailable",
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        estimate_input_tokens: null,
        estimate_output_tokens: null,
        estimate_method: null,
      },
      lifecycle: [],
    };
    const client: LangSmithRunClient = {
      createRun: async () => { throw new Error("SDK_UNAVAILABLE"); },
      updateRun: async () => { throw new Error("unexpected update"); },
    };
    const missing = await exportPrebuildObservations({
      observations: [base], project: "fixture", client, ledger,
    });
    expect(missing.failed).toEqual([{ identity: "missing-time", error: "PREBUILD_TIMING_UNAVAILABLE" }]);
    expect(ledger.entries.get("missing-time")?.last_revision).toBe(0);

    const timed = {
      ...base,
      observation_identity: "sdk-failure",
      timing: {
        source: "recorded" as const,
        started_at: "2026-09-20T00:00:00Z",
        finished_at: "2026-09-20T00:00:01Z",
      },
    };
    const failed = await exportPrebuildObservations({
      observations: [timed], project: "fixture", client, ledger,
    });
    expect(failed.failed).toEqual([{ identity: "sdk-failure", error: "SDK_UNAVAILABLE" }]);
    expect(ledger.entries.get("sdk-failure")?.last_revision).toBe(0);
  });
});
